import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { executerArtefact, type ArtifactSink } from "@/lib/missions/artifacts/build";
import { chargerEtat, type EtatMission } from "@/lib/missions/runtime/store";
import { controleComplet } from "@/lib/missions/goal/qa";
import { systemClock } from "@/lib/missions/ports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN LIVRABLE REPRIS SUR D'AUTRES DONNÉES N'EST PAS PRODUIT TANT QU'IL N'EST PAS REFABRIQUÉ
 * (vague « restes 2 »).
 *
 * La clé d'un livrable se reprend d'une version à l'autre (`identiteDuLivrable`, #88). Sa réservation ne
 * changeait que l'empreinte des données (`inputsHash`) : la ligne gardait le statut VERIFIED et les octets
 * de la version précédente. Que la recomposition échoue pour de bon — le modèle en panne —, et le contrôle
 * de fin (`goal/qa.ts`, qui compte un livrable par clé) déclarait PRODUIT un fichier bâti sur les données
 * d'AVANT. Deux cas, sur la même mission, par le VRAI gestionnaire de l'étape (`executerArtefact`) appliqué
 * à l'état réel de la mission (`chargerEtat`), puis le vrai contrôle (`controleComplet`) :
 *   • les MÊMES données, recomposition en panne : le livrable déjà vérifié reste le bon — rien ne change ;
 *   • des données CHANGÉES, recomposition en panne : la ligne repart à PENDING, et le contrôle la réclame.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__livchg${Date.now()}`;

class DepotMemoire implements ArtifactSink {
  readonly fichiers: { fileName: string }[] = [];
  async deposer(input: { fileName: string }) {
    this.fichiers.push({ fileName: input.fileName });
    return { nodeId: `mem-${this.fichiers.length}` };
  }
}

const specArtefact = {
  key: "classeur", title: "Consolidation", fileName: null, format: "XLSX",
  summary: [{ heading: "Ce que disent les chiffres", paragraphs: ["Le total s'établit à 300."], bullets: [] }],
  sheets: [{
    name: "Consolidation",
    columns: [
      { header: "Produit", key: "produit", type: "text" },
      { header: "Montant", key: "montant", type: "money" },
    ],
    rows: [{ values: ["Nivolex", "100"] }, { values: ["Trastuzex", "200"] }],
    computed: [], totals: [{ column: "montant", agregat: "SUM" }], note: null,
  }],
  charts: [], sources: ["ERP Adventum"],
};

const plan = () => planScripte({
  goal: "Consolider les montants et produire le classeur.",
  reasoningComplexity: "B",
  executionScale: "S",
  acceptanceCriteria: ["Le classeur existe et porte les chiffres."],
  workstreams: [{ id: "conso", title: "Consolidation", outcome: "Le livrable existe." }],
  steps: [
    {
      key: "liste", title: "Lister les salariés", workstream: "conso",
      nodeType: "CAPABILITY", capability: "directory_list",
      inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "5" }],
      dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
      waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
      outputFields: [], completionCondition: "La liste est chargée.",
      reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
    },
    {
      key: "classeur", title: "Classeur de consolidation", workstream: "conso",
      nodeType: "ARTIFACT", capability: null,
      inputs: [{ key: "format", kind: "TEXT", value: "XLSX" }],
      dependsOn: ["liste"], forEachFrom: null, forEachPath: null, forEachAs: null,
      waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
      outputFields: [], completionCondition: "Le classeur existe et s'ouvre.",
      reasoningRequirement: "LIGHT", approvalRequirement: "NONE", maxAttempts: null,
    },
  ],
  expectedArtifacts: [{ key: "classeur", format: "XLSX", title: "Classeur de consolidation", fromStep: "classeur" }],
  approvalStrategy: "BUNDLE",
  completionCriteria: "Le classeur existe et s'ouvre.",
  gaps: [],
  rationale: "Lire la liste une fois, puis en tirer le livrable.",
});

const verdictSatisfait = (req: { prompt: string }) => {
  const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return {
    satisfied: true, confidence: 0.9,
    criteria: [{ criterion: "Le classeur existe et porte les chiffres.", status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3) }],
    missing: [], contradictions: [], suggestedRecovery: null,
  };
};

suite("Un livrable repris sur d'autres données — le contrôle ne compte pas la version d'avant", () => {
  let pdg: CurrentUser;
  let companyId = "";
  let missionId = "";
  let empreinteInitiale: string | null = null;
  const depot = new DepotMemoire();
  /** La mise en forme du livrable en PANNE — à chaque appel : la recomposition échoue pour de bon. */
  const enPanne = new RaisonneurScripte([pour("mission.artifact", () => ({ ok: false, error: "fournisseur indisponible (banc)" }))]);

  const ligne = () => prisma.missionArtifact.findUniqueOrThrow({
    where: { missionId_key: { missionId, key: "classeur" } }, select: { status: true, byteSize: true, inputsHash: true },
  });
  const recomposer = async (etat: EtatMission) => {
    const step = etat.steps.find((s) => s.key === "classeur")!;
    return executerArtefact({ mission: etat, step, actor: { userId: pdg.id, label: pdg.name, isAgent: false }, clock: systemClock }, { reasoner: enPanne, sink: depot });
  };
  const artefacts = async (etat: EtatMission) => (await controleComplet(etat)).constats.find((c) => c.controle === "ARTEFACTS");

  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const compte = await prisma.user.create({
      data: { name: `${TAG} Delegue`, email: `${TAG}0@amd.dz`, passwordHash: "x", role: "SALES_USER" }, select: { id: true },
    });
    await prisma.employee.create({
      data: { fullName: `${TAG} Delegue`, email: `${TAG}0@amd.dz`, position: "Délégué", department: TAG, isActive: true, companyId, userId: compte.id },
    });

    // LA VERSION PRÉCÉDENTE : la mission produit son classeur, vérifié, sur les données du jour.
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan() })),
      pour("mission.artifact", () => ({ ok: true, data: specArtefact })),
      pour("mission.goal", (req) => ({ ok: true, data: verdictSatisfait(req as { prompt: string }) })),
    ]);
    const r = await lancerMission(pdg, "Consolide et produis le classeur.", { reasoner: cerveau, sink: depot });
    if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
    missionId = r.missionId;
    for (let i = 0; i < 6; i++) await avancerMission(pdg, missionId, { reasoner: cerveau, sink: depot });
    empreinteInitiale = (await ligne()).inputsHash;
  }, 180_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("PRÉMISSE : la version précédente est produite, vérifiée, sur une empreinte de données — et le contrôle la compte", async () => {
    const l = await ligne();
    expect(l.status).toBe("VERIFIED");
    expect(l.byteSize).toBeGreaterThan(0);
    expect(empreinteInitiale, "le livrable porte l'empreinte de ses données").toBeTruthy();
    expect((await artefacts((await chargerEtat(missionId))!))?.ok).toBe(true);
  });

  it("TÉMOIN — les MÊMES données, recomposition en panne : le livrable déjà vérifié reste le bon, et le contrôle le compte", async () => {
    const etat = (await chargerEtat(missionId))!;
    const r = await recomposer(etat);
    expect(r.status, "la recomposition devait échouer").toBe("FAILED");
    expect(enPanne.appelsPour("mission.artifact"), "prémisse : la mise en forme a bien été tentée").toBe(1);
    expect(await ligne()).toMatchObject({ status: "VERIFIED", inputsHash: empreinteInitiale });
    expect((await artefacts(etat))?.ok, "mêmes données, même livrable déjà vérifié").toBe(true);
  });

  it("DES DONNÉES CHANGÉES, recomposition en panne : la ligne repart à PENDING, et le contrôle ne compte pas la version d'avant", async () => {
    // LES DONNÉES AMONT CHANGENT — ce que fait une replanification qui relit la source, ou une réponse arrivée après.
    const avant = (await chargerEtat(missionId))!;
    const liste = avant.steps.find((s) => s.key === "liste")!;
    await prisma.missionStep.update({
      where: { id: liste.id },
      data: { result: { ...(liste.result as Record<string, unknown>), revuLe: "après une réponse arrivée tard" } as Prisma.InputJsonValue },
    });
    // PRÉMISSE : c'est exactement l'état que le défaut exploitait — une ligne VERIFIED, avec des octets.
    expect(await ligne()).toMatchObject({ status: "VERIFIED", inputsHash: empreinteInitiale });

    const etat = (await chargerEtat(missionId))!;
    const r = await recomposer(etat);
    expect(r.status).toBe("FAILED");
    const l = await ligne();
    expect(l.inputsHash, "prémisse : la réservation a bien lu d'autres données").not.toBe(empreinteInitiale);
    expect(l.status, "un fichier bâti sur les données d'AVANT ne reste pas « vérifié »").toBe("PENDING");
    const constat = await artefacts(etat);
    expect(constat?.ok, "le contrôle compte pour produit un livrable de la version précédente").toBe(false);
    expect(constat?.message).toContain("classeur");
  });

  it("UNE LIGNE SANS EMPREINTE — composée par le chemin direct, ou d'avant les empreintes — repart elle aussi à PENDING", async () => {
    // `inputsHash` est NULL pour un livrable dont la spec venait toute faite de l'étape (`spec.inputsHash ?? null`).
    // Pour Prisma, `{ not: x }` n'attrape PAS une valeur nulle : sans la branche explicite, cette ligne
    // garderait son statut VERIFIED sur des données qu'elle n'a jamais vues.
    await prisma.missionArtifact.update({
      where: { missionId_key: { missionId, key: "classeur" } }, data: { status: "VERIFIED", inputsHash: null },
    });
    const etat = (await chargerEtat(missionId))!;
    expect((await artefacts(etat))?.ok, "prémisse : la ligne sans empreinte, VERIFIED, était comptée").toBe(true);
    const r = await recomposer(etat);
    expect(r.status).toBe("FAILED");
    expect((await ligne()).status, "une ligne sans empreinte n'est pas « les mêmes données »").toBe("PENDING");
    expect((await artefacts(etat))?.ok).toBe(false);
  });
});
