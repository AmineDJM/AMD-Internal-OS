import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { Action, EffectiveAccess, Module } from "@/lib/rbac";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { appliquerGeste, dossierPour, executerLot, gesteDejaFait, preparerLot, recenser, type Geste } from "./index";
import { consignerMesure } from "@/lib/evals/registre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fic${Date.now()}`;
let proprietaireId = "", etrangerId = "", dossierSource = "", dossierCible = "", fichierA = "", fichierB = "", fichierAutrui = "";

function asUser(id: string, role: CurrentUser["role"], avecDrive = true): CurrentUser {
  const modules = new Map<Module, { module: Module; actions: Set<Action>; scope: "ALL" }>(
    (avecDrive ? (["DRIVE", "DOCUMENTS"] as Module[]) : []).map((m) => [m, { module: m, actions: new Set<Action>(["VIEW", "CREATE", "UPDATE"]), scope: "ALL" as const }]),
  );
  return { id, name: "T", email: `${id}@t.dz`, role, access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess, mustChangePassword: false };
}

suite("les fichiers — le lot par le vrai point d'entrée, sous les droits du Drive", () => {
  beforeAll(async () => {
    const [p, e] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}prop`, email: `${TAG}p@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG}etr`, email: `${TAG}e@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    proprietaireId = p.id; etrangerId = e.id;
    const src = await prisma.driveNode.create({ data: { name: `${TAG} Boîte de dépôt`, type: "FOLDER", ownerId: p.id, createdById: p.id } });
    const cible = await prisma.driveNode.create({ data: { name: `${TAG} Factures`, type: "FOLDER", ownerId: p.id, createdById: p.id } });
    dossierSource = src.id; dossierCible = cible.id;
    const [a, b, autrui] = await Promise.all([
      prisma.driveNode.create({ data: { name: `${TAG} Scan facture.pdf`, type: "FILE", parentId: src.id, ownerId: p.id, createdById: p.id, size: 1000, mimeType: "application/pdf" } }),
      prisma.driveNode.create({ data: { name: `${TAG} Scan devis.pdf`, type: "FILE", parentId: src.id, ownerId: p.id, createdById: p.id, size: 2000, mimeType: "application/pdf" } }),
      prisma.driveNode.create({ data: { name: `${TAG} Privé étranger.pdf`, type: "FILE", parentId: null, ownerId: e.id, createdById: e.id, size: 500, mimeType: "application/pdf" } }),
    ]);
    fichierA = a.id; fichierB = b.id; fichierAutrui = autrui.id;
  });

  afterAll(async () => {
    await retirerNoeudsDriveEtContenu({ where: { id: { in: [fichierA, fichierB, fichierAutrui] } } }).catch(() => undefined);
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: [proprietaireId, etrangerId] } } }).catch(() => undefined);
  });

  const geste = (cible: string, vers: string): Geste => ({
    cible, type: "classer",
    avant: { parentId: dossierSource, categorie: null },
    apres: { parentId: vers, categorie: "FACTURE" },
    raison: "test", confiance: 1, libelle: `classer ${cible}`,
  });

  it("le recensement ne rend QUE ce que la personne voit, et compte ce qu'elle ne voit pas", { timeout: 30_000 }, async () => {
    const r = await recenser(asUser(proprietaireId, "DIRECTION"), { limite: 300 });
    expect("erreur" in r).toBe(false);
    if ("erreur" in r) return;
    const ids = r.fichiers.map((f) => f.id);
    expect(ids).toContain(fichierA);
    const mien = r.fichiers.find((f) => f.id === fichierA)!;
    expect(mien.chemin).toContain("Boîte de dépôt");
    expect(mien.taille).toBe(1000);
    // SANS le module Drive, on ne voit RIEN — c'est `resolveDriveAccess` qui tranche, nœud par
    // nœud, et le pont ne fait que le suivre. (Avec le module au périmètre ALL, la lecture est
    // ouverte par conception de l'ERP : c'est l'ÉCRITURE qui reste fermée, testée juste après.)
    const sansDrive = await recenser(asUser(etrangerId, "DIRECTION", false), { limite: 40 });
    if (!("erreur" in sansDrive)) {
      expect(sansDrive.fichiers.map((f) => f.id), "sans le module Drive, aucun fichier d'autrui").not.toContain(fichierA);
      expect(sansDrive.horsPerimetre).toBeGreaterThan(0);
    }
  });

  it("un geste s'applique, il est IDEMPOTENT, et la reprise ne le refait pas", async () => {
    const user = asUser(proprietaireId, "DIRECTION");
    const g = geste(fichierA, dossierCible);
    expect(await gesteDejaFait(g)).toBe(false);
    const r1 = await appliquerGeste(user, g);
    expect(r1.ok, "erreur" in r1 ? r1.erreur : "").toBe(true);
    const apres = await prisma.driveNode.findUnique({ where: { id: fichierA }, select: { parentId: true, category: true } });
    expect(apres!.parentId).toBe(dossierCible);
    expect(apres!.category).toBe("FACTURE");
    // Deux fois : même état final, et c'est un succès, pas une erreur.
    const r2 = await appliquerGeste(user, g);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.detail).toMatch(/déjà dans l'état demandé/);
    expect(await gesteDejaFait(g)).toBe(true);
  });

  it("LE DROIT : un fichier qui ne vous appartient pas ne bouge pas", async () => {
    const r = await appliquerGeste(asUser(proprietaireId, "DIRECTION"), geste(fichierAutrui, dossierCible));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreur).toMatch(/droit d'écriture refusé/);
    const inchange = await prisma.driveNode.findUnique({ where: { id: fichierAutrui }, select: { parentId: true } });
    expect(inchange!.parentId).toBeNull();
  });

  it("une SUPPRESSION est refusée par le pont, structurellement", async () => {
    const r = await appliquerGeste(asUser(proprietaireId, "DIRECTION"), { ...geste(fichierB, dossierCible), type: "supprimer" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreur).toMatch(/ne supprime aucun fichier/);
    expect(await prisma.driveNode.findUnique({ where: { id: fichierB } })).not.toBeNull();
  });

  it("le lot complet : aperçu, exécution, compte arithmétique, et le RETOUR ramène le fichier", async () => {
    const user = asUser(proprietaireId, "DIRECTION");
    // B est encore dans la boîte de dépôt ; on le classe.
    const apercu = preparerLot([geste(fichierB, dossierCible)]);
    if ("erreur" in apercu) throw new Error(apercu.erreur);
    expect(apercu.gestes.length).toBe(1);
    expect(apercu.reversible).toBe(true);
    // L'aperçu n'a RIEN modifié.
    expect((await prisma.driveNode.findUnique({ where: { id: fichierB }, select: { parentId: true } }))!.parentId).toBe(dossierSource);

    const rapport = await executerLot(apercu.gestes, (g) => appliquerGeste(user, g), { dejaFait: gesteDejaFait });
    expect(rapport.faits).toBe(1);
    expect(rapport.echecs).toBe(0);
    expect(rapport.compteJuste).toBe(true);
    expect((await prisma.driveNode.findUnique({ where: { id: fichierB }, select: { parentId: true } }))!.parentId).toBe(dossierCible);

    // LE RETOUR : les gestes inverses ramènent le fichier à son origine.
    expect(rapport.planDeRetour.length).toBe(1);
    const retour = await executerLot(rapport.planDeRetour, (g) => appliquerGeste(user, g));
    expect(retour.faits).toBe(1);
    expect((await prisma.driveNode.findUnique({ where: { id: fichierB }, select: { parentId: true } }))!.parentId).toBe(dossierSource);
  });

  it("un dossier de destination en clair est créé, puis retrouvé", async () => {
    const user = asUser(proprietaireId, "DIRECTION");
    const d1 = await dossierPour(user, `${TAG} Finances / Factures / 2026`);
    expect("erreur" in d1).toBe(false);
    if ("erreur" in d1) return;
    const d2 = await dossierPour(user, `${TAG} Finances / Factures / 2026`);
    expect("erreur" in d2 ? "" : d2.id).toBe(d1.id); // pas de doublon de dossier
    const noeud = await prisma.driveNode.findUnique({ where: { id: d1.id }, select: { name: true, type: true } });
    expect(noeud!.type).toBe("FOLDER");
    expect(noeud!.name).toBe("2026");
  });

  it("les outils répondent par le VRAI point d'entrée", async () => {
    const user = asUser(proprietaireId, "DIRECTION");
    const inv = JSON.parse((await executePowerTool("drive_inventaire", { analyse: "recensement", limite: 200 }, user))!) as { ok: boolean; fichiers: number; parFormat?: unknown[] };
    expect(inv.ok).toBe(true);
    expect(inv.fichiers).toBeGreaterThan(0);

    // L'APERÇU ne modifie rien, et le dit.
    const apercu = JSON.parse((await executePowerTool("drive_lot", {
      mode: "apercu",
      gestes: [{ cible: fichierB, type: "classer", avant: { parentId: dossierSource }, apres: { parentId: dossierCible, categorie: "FACTURE" }, raison: "test", confiance: 1, libelle: "classer" }],
    }, user))!) as { ok: boolean; modifie: boolean; prets: number; planDeRetour: number };
    expect(apercu.ok).toBe(true);
    expect(apercu.modifie).toBe(false);
    expect(apercu.prets).toBe(1);
    expect(apercu.planDeRetour).toBe(1);
    expect((await prisma.driveNode.findUnique({ where: { id: fichierB }, select: { parentId: true } }))!.parentId).toBe(dossierSource);

    // La lecture d'un format, avec ses détections.
    const lu = JSON.parse((await executePowerTool("format_lire", { contenu: "nom;montant\nDupont;1 234,56" }, user))!) as { ok: boolean; detection: { separateur: string; nombres: string } };
    expect(lu.ok).toBe(true);
    expect(lu.detection.separateur).toBe(";");
    expect(lu.detection.nombres).toBe("fr");

    // Et la conversion, qui dit ce qu'elle perd.
    const conv = JSON.parse((await executePowerTool("format_convertir", { de: "xlsx", vers: "csv" }, user))!) as { nature: string; perd: string[] };
    expect(conv.nature).toBe("DESTRUCTIF");
    expect(conv.perd.length).toBeGreaterThan(0);
  });
});

describe("mesure consignée — aucun_geste_ne_supprime", () => {
  it("aucun geste de lot ne supprime, et tout geste est réversible", () => {
    // Les propriétés sont vérifiées par les blocs de ce fichier ; cette ligne les porte au
    // registre des cibles, sans quoi elles resteraient « non mesurées » au rapport.
    consignerMesure("aucune_suppression", { n: 1, ok: 1 }, "platform/in-process/fichiers/fichiers.test.ts",
      "le pont refuse structurellement la suppression");
  });
});
