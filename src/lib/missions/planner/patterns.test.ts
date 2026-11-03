import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  formeDuPlan,
  signatureDeForme,
  profilDeComplexite,
  enregistrerFormeReussie,
  indicesDeFormes,
  SEUIL_VALIDATION,
} from "./patterns";
import { planifier, type ContextePlanification, composerContexte } from "./plan";
import type { CapabilityCatalog, MissionActor, Reasoner, ReasonResult } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FORMES DE PLANS (§64) ET LA SPÉCULATION (§65) — influence mesurée, jamais autorité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `patterns-${Date.now().toString(36)}`;

let dbOk = true;
/**
 * LE PROPRIÉTAIRE DES MISSIONS D'ESSAI EST LE NÔTRE — pas « le premier venu ».
 *
 * Ce banc empruntait `prisma.user.findFirst()` : n'importe quel compte de la base faisait
 * l'affaire. Tant que rien ne tournait en parallèle, cela passait. Depuis, d'autres bancs
 * créent ET SUPPRIMENT leurs propres comptes ; quand `findFirst` tombait sur l'un d'eux au
 * mauvais moment, la création de mission échouait sur la clé étrangère `Mission_ownerId_fkey`
 * — un échec qui n'apprend rien sur les formes de plans, et qui ne se reproduit pas seul.
 *
 * Un banc qui dépend de l'état laissé par les autres n'est pas un banc : il crée donc le sien.
 */
let ownerId = "";
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const u = await prisma.user.create({
      data: { name: `${TAG}-owner`, email: `${TAG}-owner@t.dz`, role: "VIEWER", passwordHash: "x" },
    });
    ownerId = u.id;
  } catch {
    dbOk = false;
  }
});

afterAll(async () => {
  if (!dbOk) return;
  await prisma.missionPlanPattern.deleteMany({ where: { dernierMissionId: { startsWith: TAG } } }).catch(() => undefined);
  await prisma.missionStep.deleteMany({ where: { mission: { title: { startsWith: TAG } } } }).catch(() => undefined);
  await prisma.mission.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
  await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
});

describe("la forme d'un plan — structurelle, jamais le contenu", () => {
  it("les clones d'éventail se replient : 33 envois et 300 envois sont LA MÊME forme", () => {
    const grand = formeDuPlan([
      { nodeType: "CAPABILITY", capability: "directory_lookup" },
      ...Array.from({ length: 300 }, () => ({ nodeType: "CAPABILITY", capability: "send_message", enEventail: true })),
      { nodeType: "QA" },
    ]);
    const petit = formeDuPlan([
      { nodeType: "CAPABILITY", capability: "directory_lookup" },
      ...Array.from({ length: 33 }, () => ({ nodeType: "CAPABILITY", capability: "send_message", enEventail: true })),
      { nodeType: "QA" },
    ]);
    expect(grand).toEqual(["CAPABILITY(directory_lookup)", "CAPABILITY(send_message)[éventail]", "QA"]);
    expect(signatureDeForme(grand)).toBe(signatureDeForme(petit));
  });

  it("A/B/C se traduisent dans le vocabulaire du triage", () => {
    expect(profilDeComplexite("A")).toBe("SIMPLE");
    expect(profilDeComplexite("B")).toBe("MOYEN");
    expect(profilDeComplexite("C")).toBe("COMPLEXE");
    expect(profilDeComplexite(null)).toBe("MOYEN");
  });
});

describe("le registre — OBSERVED, puis VALIDATED à trois réussites DISTINCTES", () => {
  async function missionReussie(suffixe: string): Promise<string> {
    const m = await prisma.mission.create({
      data: {
        kind: "RUNTIME", status: "COMPLETED", title: `${TAG}-${suffixe}`,
        objective: "objectif d'essai", goalRaw: "objectif d'essai", complexity: "B", scale: "S",
        ownerId,
        steps: {
          create: [
            // La capacité porte le TAG du run : la signature de forme est UNIQUE en base, et
            // deux exécutions du banc (ou un run précédent interrompu) ne se marchent pas dessus.
            { key: "lire", title: "Lire", nodeType: "CAPABILITY", capability: `lecture_${TAG}`, status: "DONE" },
            { key: "controle", title: "Contrôler", nodeType: "QA", status: "DONE" },
          ],
        },
      },
      select: { id: true },
    });
    return m.id;
  }

  it("trois missions distinctes promeuvent la forme ; le REJEU d'une même mission ne compte pas", async () => {
    if (!dbOk) return;
    const m1 = await missionReussie("a");
    await enregistrerFormeReussie(m1);
    // Marquage pour le nettoyage : la signature est celle de la forme, on la retrouve par m1.
    let ligne = await prisma.missionPlanPattern.findFirst({ where: { dernierMissionId: m1 } });
    expect(ligne).not.toBeNull();
    expect(ligne!.statut).toBe("OBSERVED");
    expect(ligne!.succes).toBe(1);

    // §42 : le REJEU de la conclusion (redémarrage) ne compte pas deux fois.
    await enregistrerFormeReussie(m1);
    ligne = await prisma.missionPlanPattern.findUnique({ where: { signature: ligne!.signature } });
    expect(ligne!.succes).toBe(1);

    const m2 = await missionReussie("b");
    await enregistrerFormeReussie(m2);
    const m3 = await missionReussie("c");
    await enregistrerFormeReussie(m3);

    ligne = await prisma.missionPlanPattern.findUnique({ where: { signature: ligne!.signature } });
    expect(ligne!.succes).toBe(SEUIL_VALIDATION);
    expect(ligne!.statut).toBe("VALIDATED");

    // Et l'indication devient lisible pour le planner — une phrase, pas un contenu. Le registre
    // partagé du banc contient d'AUTRES formes validées (le moteur enregistre chaque mission
    // réussie, bancs compris) : on pousse la nôtre en tête pour rendre l'assertion déterministe —
    // c'est le RENDU qu'on éprouve ici, le classement par succès est trivial (orderBy).
    await prisma.missionPlanPattern.update({ where: { signature: ligne!.signature }, data: { succes: 999_999 } });
    const indices = await indicesDeFormes();
    expect(indices.some((i) => i.includes(`CAPABILITY(lecture_${TAG})`) && i.includes("999999 fois"))).toBe(true);

    // Nettoyage ciblé de la forme créée (elle est partagée par les trois missions).
    await prisma.missionPlanPattern.delete({ where: { signature: ligne!.signature } }).catch(() => undefined);
  });

  it("le composeur ENCADRE l'indication — elle n'oblige à rien, et c'est écrit", () => {
    const ctx: ContextePlanification = { formesValidees: ["CAPABILITY(x) → QA (a réussi 4 fois)"] };
    const texte = composerContexte("objectif", "aucune", ctx);
    expect(texte).toContain("indication SEULEMENT");
    expect(texte).toContain("CAPABILITY(x) → QA");
  });
});

describe("la spéculation (§65) — parallèle au modèle, jamais bloquante", () => {
  const acteur: MissionActor = { userId: "u-spec", label: "Essai", isAgent: false };
  const catalogue: CapabilityCatalog = {
    plafondEffet: null,
    has: () => true,
    allowed: () => true,
    meta: (n) => capabilityMeta(n),
    brief: () => [
      { id: "directory_lookup", domain: "directory", effect: "READ", batchable: true, summary: "Annuaire" },
    ],
  };
  const PLAN_BRUT = {
    goal: "lister", reasoningComplexity: "B", executionScale: "S",
    acceptanceCriteria: ["la liste existe"], workstreams: [],
    steps: [{
      key: "lire", title: "Lire l'annuaire", workstream: null, nodeType: "CAPABILITY",
      dependsOn: [], completionCondition: "liste rendue", capability: "directory_lookup", inputs: [],
    }],
    expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: "", gaps: [], rationale: "",
  };
  const cerveau = (delaiMs: number): Reasoner => ({
    configured: () => true,
    reason: async <T,>(): Promise<ReasonResult<T>> => {
      await new Promise((r) => setTimeout(r, delaiMs));
      return { ok: true, data: PLAN_BRUT as T, usage: null, latencyMs: delaiMs };
    },
  });

  it("une spéculation rapide est TERMINÉE et comptée quand le plan sort", async () => {
    const lectures: string[] = [];
    const r = await planifier("mission qui force le modèle sans chemin direct", catalogue, acteur, cerveau(60), {
      sansCheminDirect: true,
      speculation: async () => {
        lectures.push("annuaire");
        return [{ libelle: "annuaire:Sarah", ms: 2 }];
      },
    });
    expect(r.ok).toBe(true);
    expect(lectures).toEqual(["annuaire"]);
    expect(r.metriques.speculation).toEqual({ terminee: true, lectures: 1, ms: expect.any(Number) });
  });

  it("une spéculation LENTE ne retient jamais le plan — course, pas jointure", async () => {
    const debut = Date.now();
    const r = await planifier("mission qui force le modèle sans chemin direct", catalogue, acteur, cerveau(30), {
      sansCheminDirect: true,
      speculation: () => new Promise((resolve) => setTimeout(() => resolve([{ libelle: "lent", ms: 5_000 }]), 5_000)),
    });
    expect(r.ok).toBe(true);
    expect(Date.now() - debut).toBeLessThan(2_000); // le plan n'a PAS attendu les 5 s
    expect(r.metriques.speculation).toEqual({ terminee: false, lectures: 0, ms: null });
  });

  it("une spéculation qui PLANTE est invisible — le plan sort pareil", async () => {
    const r = await planifier("mission qui force le modèle sans chemin direct", catalogue, acteur, cerveau(20), {
      sansCheminDirect: true,
      speculation: async () => { throw new Error("base injoignable"); },
    });
    expect(r.ok).toBe(true);
  });
});
