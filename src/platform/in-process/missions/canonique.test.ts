import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import type { ArtifactSink } from "@/lib/missions/artifacts/build";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE BASE CANONIQUE PAR MISSION (#88) — le classeur et le deck disent le MÊME chiffre.
 *
 * ── LE DÉFAUT, MESURÉ PAR CE BANC AVANT LA CORRECTION ───────────────────────────────────
 *
 * Deux étapes ARTIFACT d'un même plan — le classeur et le deck — descendent des MÊMES étapes
 * amont, et chacune appelait le modèle de son côté. Deux appels, deux specs : l'un pouvait
 * retenir douze lignes et l'autre dix, l'un arrondir et l'autre non, les synthèses se
 * contredire. Rien ne les comparait, puisque chaque livrable est contrôlé SEUL — c'est
 * littéralement « quatre fichiers qui divergent », à l'intérieur d'une seule mission.
 *
 * ── COMMENT CE BANC LE PROUVE ───────────────────────────────────────────────────────────
 *
 * Le raisonneur scripté rend, au DEUXIÈME appel de mise en forme, des chiffres DIFFÉRENTS. Si
 * le deck rappelle le modèle, il portera 999 ; s'il re-rend le contenu du classeur, il portera
 * 100. Les deux fichiers sont ROUVERTS avec l'adaptateur de production et lus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__canon${Date.now()}`;
let pdg: CurrentUser;
let companyId = "";

class DepotMemoire implements ArtifactSink {
  readonly fichiers: { fileName: string; data: Buffer; mime: string }[] = [];
  async deposer(input: { fileName: string; mime: string; data: Buffer }) {
    this.fichiers.push({ fileName: input.fileName, data: input.data, mime: input.mime });
    return { nodeId: `mem-${this.fichiers.length}` };
  }
}

/** Une spec de livrable conforme au schéma strict, avec le chiffre qu'on veut y lire. */
const specArtefact = (montant: number) => ({
  key: "recap", title: "Consolidation", fileName: null, format: "XLSX",
  summary: [{ heading: "Ce que disent les chiffres", paragraphs: [`Le total s'établit à ${montant}.`], bullets: [] }],
  sheets: [{
    name: "Consolidation",
    columns: [
      { header: "Produit", key: "produit", type: "text" },
      { header: "Montant", key: "montant", type: "money" },
    ],
    rows: [{ values: ["Nivolex", String(montant)] }, { values: ["Trastuzex", String(montant * 2)] }],
    computed: [], totals: [{ column: "montant", agregat: "SUM" }], note: null,
  }],
  charts: [], sources: ["ERP Adventum"],
});

const plan = () => planScripte({
  goal: "Consolider les montants et produire le classeur ET le deck.",
  reasoningComplexity: "B",
  executionScale: "S",
  acceptanceCriteria: ["Le classeur et le deck existent et portent les mêmes chiffres."],
  workstreams: [{ id: "conso", title: "Consolidation", outcome: "Les livrables existent." }],
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
    {
      key: "deck", title: "Deck de consolidation", workstream: "conso",
      nodeType: "ARTIFACT", capability: null,
      inputs: [{ key: "format", kind: "TEXT", value: "PPTX" }],
      dependsOn: ["liste"], forEachFrom: null, forEachPath: null, forEachAs: null,
      waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
      outputFields: [], completionCondition: "Le deck existe et s'ouvre.",
      reasoningRequirement: "LIGHT", approvalRequirement: "NONE", maxAttempts: null,
    },
  ],
  expectedArtifacts: [
    { key: "classeur", format: "XLSX", title: "Classeur de consolidation", fromStep: "classeur" },
    { key: "deck", format: "PPTX", title: "Deck de consolidation", fromStep: "deck" },
  ],
  approvalStrategy: "BUNDLE",
  completionCriteria: "Le classeur et le deck existent, s'ouvrent, et portent les mêmes chiffres.",
  gaps: [],
  rationale: "Lire la liste une fois, puis en tirer les deux livrables.",
});

/** Le juge d'objectif — il cite ce qu'il a réellement VU dans le compte rendu. */
const verdictSatisfait = (criteres: string[]) => (req: { prompt: string }) => {
  const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return {
    satisfied: true, confidence: 0.9,
    criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3) })),
    missing: [], contradictions: [], suggestedRecovery: null,
  };
};

suite("#88 — le classeur et le deck d'une mission portent les MÊMES chiffres", () => {
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
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("le second livrable RE-REND le premier au lieu de rappeler le modèle", async () => {
    const depot = new DepotMemoire();
    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan() })),
      // LE PIÈGE : au deuxième appel de mise en forme, le modèle « change d'avis ».
      pour("mission.artifact", (_r, n) => ({ ok: true, data: specArtefact(n === 1 ? 100 : 999) })),
      pour("mission.goal", (req) => ({
        ok: true,
        data: verdictSatisfait(["Le classeur et le deck existent et portent les mêmes chiffres."])(req as { prompt: string }),
      })),
    ]);

    const r = await lancerMission(pdg, "Consolide et produis le classeur et le deck.", { reasoner: cerveau, sink: depot });
    if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
    for (let i = 0; i < 6; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau, sink: depot });

    const artefacts = await prisma.missionArtifact.findMany({
      where: { missionId: r.missionId }, select: { format: true, status: true, inputsHash: true, fileName: true },
      orderBy: { createdAt: "asc" },
    });
    expect(artefacts.map((a) => a.format).sort(), "les deux livrables n'ont pas été produits").toEqual(["PPTX", "XLSX"]);
    expect(artefacts.every((a) => a.status === "VERIFIED")).toBe(true);
    expect(new Set(artefacts.map((a) => a.inputsHash)).size, "deux empreintes pour les mêmes données amont").toBe(1);

    // UN SEUL APPEL DE MISE EN FORME, même quand les deux étapes courent au même battement :
    // la réservation précède la composition, donc le second sait qu'il doit attendre la base.
    expect(cerveau.appelsPour("mission.artifact"), "le modèle a été rappelé pour le second livrable").toBe(1);

    // ON ROUVRE LES DEUX FICHIERS, ET ON COMPARE LEURS CHIFFRES.
    //
    // L'invariant N'EST PAS « le premier appel gagne » : quand les deux étapes courent au même
    // battement, laquelle publie d'abord dépend de l'ordonnancement, et prétendre le contraire
    // serait une assertion sur du hasard. L'invariant est celui de #88 : les deux fichiers
    // disent LA MÊME CHOSE. Avant la règle, l'un portait 100 et l'autre 999 — deux livrables
    // d'une même mission, deux chiffres, et personne pour les comparer.
    expect(depot.fichiers).toHaveLength(2);
    const chiffres = new Map<string, string>();
    for (const f of depot.fichiers) {
      const format = f.fileName.endsWith(".xlsx") ? "XLSX" as const : "PPTX" as const;
      const m = (await adaptateurPour(format).ouvrir(f.data)).modele();
      const texte = m.kind === "XLSX"
        ? m.sheets.flatMap((s) => s.cells.map((c) => c.value)).join(" ")
        : m.kind === "PPTX" ? m.slides.flatMap((d) => [d.title, ...d.shapes.map((s) => s.text)]).join(" ") : "";
      // Les nombres du jeu d'essai : 100/200 d'un côté, 999/1998 de l'autre. On lit ceux qui
      // sont VRAIMENT dans le fichier, on ne suppose pas lequel a gagné.
      const vus = ["100", "200", "999", "1998"].filter((n) => new RegExp(`\\b${n}\\b`).test(texte));
      expect(vus.length, `${f.fileName} ne porte aucun chiffre du jeu d'essai`).toBeGreaterThan(0);
      chiffres.set(f.fileName, vus.join(","));
    }
    const distincts = new Set(chiffres.values());
    expect(
      distincts.size,
      `les deux livrables annoncent des chiffres DIFFÉRENTS : ${[...chiffres].map(([n, v]) => `${n} → ${v}`).join(" | ")}`,
    ).toBe(1);

    // LA RÉUTILISATION EST DITE au journal : une économie silencieuse est indistinguable d'un
    // bug le jour où les deux fichiers devaient différer.
    const journal = await prisma.missionEvent.count({ where: { missionId: r.missionId, kind: "ARTIFACT_CANONIQUE" } });
    expect(journal, "la reprise du contenu n'est consignée nulle part").toBe(1);
  }, 300_000);
});
