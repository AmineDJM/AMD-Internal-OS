import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import { indexDriveNodeText } from "./document-discovery";

/**
 * GOLDEN RÉGRESSION — deux pannes réelles :
 *
 *   E. « Quand est la grande journée nationale de la SAI ? » → « aucune trace » après UNE
 *      table. → `investigate_event` fouille 8 sources, résout le SIGLE contre les
 *      organisations réellement présentes, rend sa COUVERTURE.
 *
 *   D. « Qui a uploadé le dossier Direction Générale ? Combien de BC dedans ? » → réponse
 *      partielle + « veux-tu que j'explore ? ». → `inspect_drive_folder` explore
 *      RÉCURSIVEMENT en un appel : déposants réels, BC STRICTS ≠ assimilés, ACL respectée.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "PDG", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__inv__${Date.now()}`;
let ceoId = "";
let folderId = "";

const investigate = POWER_TOOLS.find((t) => t.def.name === "investigate_event")!;
const inspect = POWER_TOOLS.find((t) => t.def.name === "inspect_drive_folder")!;

suite("investigate_event — l'événement reconstitué depuis toutes ses traces", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
    // L'événement N'EST PAS dans la table Events — ses traces sont AILLEURS (le cas réel).
    await Promise.all([
      prisma.sponsoringRequest.create({
        data: {
          reference: `${TAG}-SPO-1`, institution: "Société Algérienne d'Infectiologie",
          type: "Sponsoring", description: `${TAG} grande journée nationale d'infectiologie — stand et symposium`,
          requesterId: ceoId,
        },
      }),
      prisma.calendarEvent.create({
        data: {
          title: `${TAG} Journée nationale SAI — Alger`,
          startAt: new Date("2026-10-15T08:00:00Z"),
          organizerId: ceoId,
          createdById: ceoId,
        } as never,
      }),
    ]);
  });

  afterAll(async () => {
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.calendarEvent.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("GOLDEN E — le SIGLE retrouve l'organisation réelle et les traces hors table Events", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    expect(investigate.allowed(exec)).toBe(true);
    const out = JSON.parse(await investigate.run({ entity: "SAI", description: "grande journée nationale" }, exec));
    // Le sigle est résolu contre les organisations réellement rencontrées.
    const orgs = JSON.stringify(out.recherche.resolutionOrganisation);
    expect(orgs).toContain("Infectiologie");
    // Les traces remontent du sponsoring ET du calendrier — pas seulement des Events.
    expect(JSON.stringify(out.traces.sponsoring)).toContain("journée nationale");
    expect(JSON.stringify(out.traces.calendrier)).toContain("2026-10-15");
    // La couverture est rendue — la condition du droit de dire « aucune trace ».
    expect(out.couverture.sourcesInterrogees.length).toBeGreaterThanOrEqual(8);
    expect(out.couverture.totalTraces).toBeGreaterThanOrEqual(2);
  });

  it("entité inconnue → couverture complète + consigne, jamais un « aucune trace » sec", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const out = JSON.parse(await investigate.run({ entity: "Zeppelin Quantique" }, exec));
    expect(out.couverture.totalTraces).toBe(0);
    expect(out.reponse).toMatch(/8 sources|sources interrogées/i);
    expect(out.couverture.sourcesNonInterrogees.length).toBeGreaterThan(0);
  });

  it("réservé au siège exécutif (CHIEF_OF_STAFF) — pas un outil de tout le monde", async () => {
    const bare = userWith({}, "DIRECTION", ceoId);
    expect(investigate.allowed(bare)).toBe(false);
  });
});

suite("inspect_drive_folder — l'exploration récursive en un tour", () => {
  let uploaderId = "";
  let ownerId = "";
  beforeAll(async () => {
    // Suite AUTONOME : son propre propriétaire (celui de la 1re suite est nettoyé avant).
    const [uploader, owner] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Redouane`, email: `${TAG}u@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG} Proprio`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    uploaderId = uploader.id;
    ownerId = owner.id;
    // Arborescence : Direction Générale / (BC_scan.pdf, proforma.pdf, notes/) — propriétaire : le PDG du test.
    const root = await prisma.driveNode.create({ data: { name: `${TAG} Direction Générale`, type: "FOLDER", ownerId: ownerId } });
    folderId = root.id;
    const sub = await prisma.driveNode.create({ data: { name: "notes", type: "FOLDER", parentId: root.id, ownerId: ownerId } });
    const f1 = await prisma.driveNode.create({ data: { name: "scan_bc.pdf", type: "FILE", parentId: root.id, ownerId: ownerId, size: 1000 } });
    const f2 = await prisma.driveNode.create({ data: { name: "document2.pdf", type: "FILE", parentId: sub.id, ownerId: ownerId, size: 2000 } });
    // Le DÉPOSANT réel est porté par la version (createdById) — pas par le propriétaire du nœud.
    const blob = await prisma.fileBlob.create({ data: { sha256: `${TAG}-b1`, size: 10, iv: Buffer.from("0123456789ab"), storageKey: `${TAG}/b1` } });
    await prisma.fileVersion.createMany({
      data: [
        { nodeId: f1.id, blobId: blob.id, version: 1, size: 1000, createdById: uploaderId },
        { nodeId: f2.id, blobId: blob.id, version: 1, size: 2000, createdById: uploaderId },
      ],
    });
    // Classification par CONTENU : un BC STRICT et une proforma (assimilée) — noms trompeurs.
    await indexDriveNodeText(f1.id, "v1", "BON DE COMMANDE BC N 2026-77 — Nous vous passons commande de dix ordinateurs.", null, "scan_bc.pdf");
    await indexDriveNodeText(f2.id, "v1", "PROFORMA — Devis pour la fourniture de mobilier. Validité de l'offre : 30 jours.", null, "document2.pdf");
  });

  afterAll(async () => {
    await prisma.driveTextIndex.deleteMany({ where: { node: { name: { in: ["scan_bc.pdf", "document2.pdf"] }, owner: { email: { startsWith: TAG } } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { OR: [{ name: { startsWith: TAG } }, { owner: { email: { startsWith: TAG } } }] } }).catch(() => {});
    await prisma.fileBlob.deleteMany({ where: { sha256: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("GOLDEN D — déposants réels + BC stricts ≠ assimilés + récursif, EN UN SEUL APPEL", async () => {
    const exec = userWith({ DRIVE: ["VIEW"] }, "DIRECTION", ownerId);
    expect(inspect.allowed(exec)).toBe(true);
    const out = JSON.parse(await inspect.run({ folder: `${TAG} Direction Générale` }, exec));
    // Récursion : les DEUX fichiers (dont celui du sous-dossier) sont comptés.
    expect(out.contenu.fichiers).toBe(2);
    expect(out.contenu.sousDossiers).toBe(1);
    // Le DÉPOSANT réel (version) est nommé — la question « qui a uploadé ? » a sa réponse.
    expect(Object.keys(out.deposants).join(" ")).toContain("Redouane");
    // « Combien de BC ? » a TROIS réponses honnêtes : stricts / assimilés / total fonctionnel.
    expect(out.bonsDeCommande.stricts).toBe(1);
    expect(out.bonsDeCommande.assimiles.total).toBe(1);
    expect(out.bonsDeCommande.totalFonctionnel).toBe(2);
    // Et la consigne anti « veux-tu que j'explore ? ».
    expect(out.couverture.consigne).toMatch(/ne pas la proposer/);
  });

  it("ACL : un compte SANS accès au dossier ne l'explore pas", async () => {
    const stranger = await prisma.user.create({ data: { name: `${TAG}x`, email: `${TAG}x@t.dz`, passwordHash: "x", role: "VIEWER" } });
    const bare = userWith({ DRIVE: ["VIEW"] }, "VIEWER" as CurrentUser["role"], stranger.id);
    // Scope VIEW simple (pas ALL) : l'accès vient de la propriété ou d'un partage — il n'a ni l'un ni l'autre.
    (bare.access.modules.get("DRIVE") as { scope: string }).scope = "OWN";
    const out = await inspect.run({ folder: `${TAG} Direction Générale` }, bare);
    expect(out).toMatch(/Aucun dossier .* accessible/);
  });
});
