import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { missionsEnCours, vueMission } from "./workspace";
import { avancer } from "@/lib/missions/runtime/engine";
import { materialiser } from "@/lib/missions/runtime/store";
import { compile } from "@/lib/missions/compiler/compile";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * §43-47 — L'ÉCRAN D'UNE MISSION DIT LA VÉRITÉ, ET LA DIT AU BON GRAIN.
 *
 * Le piège de cet écran est le comptage. Une mission de trente-trois envois dont deux échouent
 * peut s'afficher « 2/2 étapes » si l'on compte les étapes du PLAN au lieu des étapes RÉELLES.
 * Le tableau de bord dirait alors que tout est fait, et deux personnes n'auraient rien reçu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mvue__${Date.now()}`;
let ownerId = "";
let autreId = "";
let actor: MissionActor;

const CONNUES = ["directory_list", "inspect_record", "send_message"];
const catalogue: CapabilityCatalog = {
  has: (n) => CONNUES.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

function traceur(echouerSur: string[] = []) {
  return {
    runner: {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        if (echouerSur.includes(String(call.input.to))) {
          return { ok: false, output: null, error: { kind: "CAPABILITY_FAILURE", message: "adresse invalide", retryable: false } };
        }
        const gens = Array.from({ length: 33 }, (_, i) => ({ id: `g-${i}` }));
        return { ok: true, output: call.stepKey === "liste" ? { gens } : { ok: true } };
      },
    },
  };
}

async function creer(steps: PlannedStep[], titre: string, proprietaire = ownerId, parentId?: string) {
  const plan: MissionPlan = { objective: titre, acceptance: ["fait"], complexity: "B", scale: "M", steps };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join(" | "));
  return materialiser(r.mission, {
    ownerId: proprietaire, title: titre, goalRaw: titre, parentMissionId: parentId ?? null,
  });
}

suite("l'écran d'une mission", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}a`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    const b = await prisma.user.create({
      data: { name: `${TAG}b`, email: `${TAG}b@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    ownerId = u.id;
    autreId = b.id;
    actor = { userId: u.id, label: "le PDG", isAgent: false };
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un éventail de 33 dont 2 échouent compte 33 étapes, jamais 1", async () => {
    const id = await creer([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Message", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "g" }, input: { to: "{{g.id}}" },
      },
    ], "éventail affiché");
    await avancer(id, actor, traceur(["g-7", "g-19"]));

    const v = (await vueMission(id, ownerId))!;
    // 1 lecture + 33 envois = 34 étapes RÉELLES ; 32 abouties (la lecture + 31 envois).
    // Le point du test : les 33 itérations comptent chacune, et le MODÈLE ne compte pas.
    // Un comptage par étapes de PLAN dirait « 2/2 » et laisserait croire que tout est parti.
    expect(v.avancement).toEqual({ faites: 32, total: 34, echouees: 2 });
    expect(v.subtitle).toMatch(/32\/34/);
    expect(v.subtitle).toMatch(/2 en échec/);

    // LES 33 FILLES NE FONT PAS 33 LIGNES : elles sont repliées sous leur modèle avec un compte.
    expect(v.etapes).toHaveLength(2);
    const modele = v.etapes.find((e) => e.id === "msg")!;
    expect(modele.detail).toBe("31/33 effectuées");
    expect(modele.etat).toBe("echec");
  }, 60_000);

  it("l'identité du bloc est celle de la MISSION — la carte se met à jour sur place (§43)", async () => {
    const id = await creer([{ key: "a", title: "A", capability: "directory_list" }], "identité stable");
    const un = (await vueMission(id, ownerId))!;
    await avancer(id, actor, traceur());
    const deux = (await vueMission(id, ownerId))!;
    expect(un.blockId).toBe(`mission:${id}`);
    expect(deux.blockId).toBe(un.blockId);
    // Le contenu change, l'identité non : c'est ce qui remplace la carte au lieu d'en empiler une.
    expect(deux.avancement.faites).toBeGreaterThan(un.avancement.faites);
  }, 30_000);

  it("UNE ÉTAPE SAUTÉE N'EST JAMAIS AFFICHÉE COMME FAITE", async () => {
    const id = await creer([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "vide", title: "Vide", capability: "send_message",
        forEach: { from: "liste", path: "inexistant", as: "g" }, input: { to: "{{g.id}}" },
      },
    ], "étape sautée");
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "vide" }, data: { status: "SKIPPED" },
    });
    const v = (await vueMission(id, ownerId))!;
    expect(v.etapes.find((e) => e.id === "vide")!.etat).toBe("a-faire");
  }, 30_000);

  it("§47 — le REÇU d'une étape est montré : c'est ce qui rend « c'est parti » vérifiable", async () => {
    const id = await creer([
      { key: "a", title: "Envoi", capability: "send_message", input: { to: "x" } },
    ], "reçu visible");
    await avancer(id, actor, traceur());
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "a" }, data: { receipt: "MSG-4242" },
    });
    const v = (await vueMission(id, ownerId))!;
    expect(v.etapes[0].detail).toBe("reçu MSG-4242");
  }, 30_000);

  it("une étape en attente DIT ce qu'elle attend, sans jargon de moteur", async () => {
    // La porte GARDE une écriture : une porte d'accord sans écriture sous accord est convertie en
    // jonction par le compilateur (un accord sur rien coûte l'attention du dirigeant pour rien).
    const id = await creer([
      { key: "porte", title: "Accord", nodeType: "APPROVAL" },
      { key: "envoi", title: "Message", capability: "send_message", dependsOn: ["porte"], input: { recipientName: "Nadia", body: "Bonjour" } },
      { key: "humain", title: "Le contrat", nodeType: "WAIT_INPUT", waitFor: { ask: "le contrat signé" } },
    ], "attentes lisibles");
    await avancer(id, actor, traceur());

    const v = (await vueMission(id, ownerId))!;
    expect(v.etapes.find((e) => e.id === "porte")!.detail).toBe("attend votre accord");
    expect(v.etapes.find((e) => e.id === "humain")!.detail).toBe("attend un élément de votre part");
    // Et l'écran remonte UNE ligne d'appel à l'action, pas deux paragraphes d'état.
    expect(v.enAttenteDeVous).toMatch(/attend votre accord|attend un élément/);
  }, 30_000);

  it("les sous-missions sont résumées, pas dépliées (§45)", async () => {
    const parent = await creer([{ key: "a", title: "A", capability: "directory_list" }], "parente");
    const enfant = await creer([
      { key: "x", title: "X", capability: "inspect_record" },
      { key: "y", title: "Y", capability: "directory_list" },
    ], "sous-mission", ownerId, parent);
    await avancer(enfant, actor, traceur());

    const v = (await vueMission(parent, ownerId))!;
    expect(v.sousMissions).toHaveLength(1);
    expect(v.sousMissions[0].id).toBe(enfant);
    expect(v.sousMissions[0].avancement).toBe("2/2");
  }, 30_000);

  it("un livrable DIT ce qu'il contient, et s'OUVRE au lieu de se télécharger", async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * CE QUE CE TEST EXISTE POUR ATTRAPER.
     *
     * Le rapport de contrôle était écrit à la fabrication, rangé dans `qaReport`, et lu par
     * PERSONNE : l'écran affichait « vérifié », un mot que rien ne distingue d'un fichier qui
     * s'ouvre et ne contient rien (§118.50 — une donnée que rien n'affiche est du code mort).
     *
     * Et le lien menait au DRIVE, c'est-à-dire à la fiche du fichier. Un livrable qu'on ne peut
     * que TÉLÉCHARGER n'est pas inspecté : on le range dans un coin et on le croit. Les quatre
     * formats que le Live Office dessine s'ouvrent donc dans le workspace, où l'on VOIT les
     * pages, les diapositives et les images.
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    const id = await creer(
      [{ key: "liste", title: "Lister", capability: "directory_list" }],
      "Mission avec livrable",
    );
    await prisma.missionArtifact.create({
      data: {
        missionId: id, key: "rapport", title: "Rapport trimestriel", format: "DOCX",
        fileName: "Rapport.docx", byteSize: 41_000, status: "VERIFIED", driveNodeId: "node-42",
        sha256: "x", spec: {},
        qaReport: {
          ok: true,
          points: [
            { nom: "livrable", ok: true, detail: "rien qui bloque l'envoi" },
            { nom: "contenu", ok: true, detail: "12 paragraphe(s) non vides, 2 tableau(x), 1 image(s), 4 page(s) — {\"x\":1}" },
          ],
          avertissements: ["La numérotation des articles saute de 1 à 3 (¶7)."],
          nonVerifie: [],
        },
      },
    });
    // Un second livrable dans un format que le workspace ne dessine pas.
    await prisma.missionArtifact.create({
      data: {
        missionId: id, key: "archive", title: "Pièces", format: "ZIP", fileName: "Pieces.zip",
        byteSize: 900, status: "VERIFIED", driveNodeId: "node-43", sha256: "y", spec: {},
        qaReport: { ok: true, points: [], nonVerifie: ["Le format ZIP n'est pas ouvert."] },
      },
    });

    const vue = await vueMission(id, ownerId);
    const doc = vue!.livrables.find((l) => l.key === "rapport")!;
    expect(doc.contenu, "le rapport de contrôle n'atteint pas l'écran").toBe(
      "12 paragraphe(s) non vides, 2 tableau(x), 1 image(s), 4 page(s)",
    );
    expect(doc.avertissements).toEqual(["La numérotation des articles saute de 1 à 3 (¶7)."]);
    expect(doc.ouvrable, "un Word doit s'OUVRIR dans le workspace, pas se télécharger").toBe(true);

    const zip = vue!.livrables.find((l) => l.key === "archive")!;
    expect(zip.ouvrable, "un ZIP n'est pas dessinable : il reste au Drive").toBe(false);
    expect(zip.nonVerifie.join(" ")).toContain("n'est pas ouvert");
  });

  it("un rapport de contrôle illisible ne casse pas l'écran — il rend moins", async () => {
    // Un artefact d'une ancienne forme, ou un JSON qu'on ne sait pas lire. L'écran doit
    // continuer de montrer le livrable : refuser d'afficher serait pire que rendre moins.
    const id = await creer(
      [{ key: "liste", title: "Lister", capability: "directory_list" }],
      "Mission au rapport illisible",
    );
    await prisma.missionArtifact.create({
      data: {
        missionId: id, key: "vieux", title: "Ancien", format: "XLSX", fileName: "a.xlsx",
        byteSize: 100, status: "VERIFIED", driveNodeId: null, sha256: "z", spec: {},
        qaReport: ["une forme inattendue"],
      },
    });
    const vue = await vueMission(id, ownerId);
    const l = vue!.livrables[0];
    expect(l.fichier).toBe("a.xlsx");
    expect(l.contenu).toBeNull();
    expect(l.avertissements).toEqual([]);
  });

  it("PERSONNE NE LIT LA MISSION D'UN AUTRE, même en connaissant son identifiant", async () => {
    const id = await creer([{ key: "a", title: "A", capability: "directory_list" }], "cloisonnée");
    expect(await vueMission(id, ownerId)).not.toBeNull();
    expect(await vueMission(id, autreId)).toBeNull();
  }, 30_000);

  it("« où tu en es ? » rend les missions EN COURS, et pas les terminées", async () => {
    const encours = await creer([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", nodeType: "APPROVAL", dependsOn: ["a"] },
    ], "en cours");
    await avancer(encours, actor, traceur());

    const finie = await creer([{ key: "a", title: "A", capability: "directory_list" }], "finie");
    await prisma.mission.update({ where: { id: finie }, data: { status: "COMPLETED" } });

    const liste = await missionsEnCours(ownerId, 50);
    expect(liste.map((m) => m.id)).toContain(encours);
    expect(liste.map((m) => m.id)).not.toContain(finie);
  }, 30_000);

  it("le compte de « où tu en es ? » exclut lui aussi les modèles d'éventail", async () => {
    const id = await creer([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Message", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "g" }, input: { to: "{{g.id}}" },
      },
      { key: "fin", title: "Fin", nodeType: "APPROVAL", dependsOn: ["msg"] },
    ], "compte éventail");
    await avancer(id, actor, traceur());

    const m = (await missionsEnCours(ownerId, 50)).find((x) => x.id === id)!;
    // 1 lecture + 33 envois + 1 porte = 35 étapes réelles, jamais 3.
    expect(m.total).toBe(35);
    expect(m.faites).toBe(34);
  }, 90_000);
});
