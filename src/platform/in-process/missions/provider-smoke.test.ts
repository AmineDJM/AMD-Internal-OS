import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { catalogueDe, acteurDe } from "@/platform/in-process/missions/catalog";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { MAILLONS, MAILLONS_FOURNISSEUR, MAILLONS_MISSION, type Chaine, type Maillon } from "@/platform/in-process/missions/provider-smoke";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI GARDE LE DIAGNOSTIC FOURNISSEUR HONNÊTE.
 *
 * Deux questions, et elles ne se ressemblent pas :
 *
 *   1. LE VERDICT PEUT-IL MENTIR ? `verdictDe` est pure — pas de réseau, pas de base. Un banc
 *      unitaire suffit, et il porte l'invariant qui compte : PROVIDER_PROVEN exige un appel
 *      réel. C'est la ligne que l'audit Frontier a demandé de ne jamais pouvoir contourner.
 *
 *   2. LA LECTURE SEULE EST-ELLE STRUCTURELLE OU PROMISE ? Là, un banc unitaire ne suffit pas :
 *      il faut partir de `lancerMission`, avec le vrai compilateur, et vérifier qu'un plan qui
 *      DEMANDE une écriture est REFUSÉ. C'est le seul test qui tombe si l'on retire le plafond
 *      du catalogue — donc le seul qui prouve qu'il porte quelque chose.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const chaine = (o: Partial<Chaine> = {}): Chaine => ({
  PROVIDER_CALL: "PASS", PLANNER_REAL_MODEL: "PASS", MISSION_PLAN_SCHEMA: "PASS",
  COMPILER: "PASS", MISSION_PERSISTED: "PASS",
  READ_ONLY_EXECUTION: "PASS", TERMINAL_STATE: "PASS", QA_GOAL_SATISFACTION: "PASS", ...o,
});

/**
 * LES DEUX VERDICTS, calculés comme le noyau les calcule. La duplication de ces deux lignes
 * est délibérée : si le noyau change sa règle, ce banc doit tomber au lieu de suivre.
 */
const providerProven = (c: Chaine) => MAILLONS_FOURNISSEUR.every((m) => c[m] === "PASS");
const missionProven = (c: Chaine) => providerProven(c) && MAILLONS_MISSION.every((m) => c[m] === "PASS");

describe("les deux verdicts — et pourquoi ils ne se confondent pas", () => {
  it("chaîne complète : les deux au vert", () => {
    expect(providerProven(chaine())).toBe(true);
    expect(missionProven(chaine())).toBe(true);
  });

  /**
   * LA LEÇON DU PREMIER RUN RÉEL SUR RENDER.
   *
   * Le fournisseur, le planner, le schéma, le compilateur et la persistance étaient tous verts.
   * Le juge d'objectif a refusé de conclure — à raison, l'énoncé n'était pas satisfiable. Un
   * verdict unique aurait déclaré la chaîne fournisseur en échec pour une raison qui ne la
   * concernait pas, et le prochain lecteur du rapport aurait cherché un problème de clé.
   */
  it("le juge peut refuser sans que la preuve fournisseur s'effondre", () => {
    const c = chaine({ QA_GOAL_SATISFACTION: "FAIL" });
    expect(providerProven(c), "le fournisseur reste prouvé").toBe(true);
    expect(missionProven(c), "la mission, elle, ne l'est pas").toBe(false);
  });

  it("une mission immobilisée sans état terminal ne prouve pas le bout en bout", () => {
    const c = chaine({ TERMINAL_STATE: "FAIL" });
    expect(providerProven(c)).toBe(true);
    expect(missionProven(c)).toBe(false);
  });

  /**
   * LA LIGNE QUI EMPÊCHE UN MOCK DE PASSER POUR UNE PREUVE. Tout le reste peut être vert :
   * sans appel facturé au fournisseur, il n'y a pas eu d'appel, donc pas de preuve.
   *
   * L'exhaustivité vaut mieux qu'un exemple : on énumère les 2^7 combinaisons du reste de la
   * chaîne avec `PROVIDER_CALL: FAIL`, et l'on exige qu'AUCUNE ne franchisse la barre.
   */
  it("aucune combinaison sans appel fournisseur ne prouve quoi que ce soit", () => {
    const autres = MAILLONS.filter((m) => m !== "PROVIDER_CALL");
    for (let masque = 0; masque < 1 << autres.length; masque++) {
      const c = chaine({ PROVIDER_CALL: "FAIL" });
      autres.forEach((m, i) => { c[m as Maillon] = masque & (1 << i) ? "PASS" : "FAIL"; });
      expect(providerProven(c), `masque ${masque}`).toBe(false);
      expect(missionProven(c), `masque ${masque}`).toBe(false);
    }
  });

  it("chaque maillon rompu, isolément, empêche le bout en bout", () => {
    for (const m of MAILLONS) {
      expect(missionProven(chaine({ [m]: "FAIL" } as Partial<Chaine>)), `${m} rompu`).toBe(false);
    }
  });

  it("l'ordre des maillons suit l'ordre de la chaîne réelle", () => {
    expect([...MAILLONS_FOURNISSEUR]).toEqual([
      "PROVIDER_CALL", "PLANNER_REAL_MODEL", "MISSION_PLAN_SCHEMA", "COMPILER", "MISSION_PERSISTED",
    ]);
    expect([...MAILLONS_MISSION]).toEqual([
      "READ_ONLY_EXECUTION", "TERMINAL_STATE", "QA_GOAL_SATISFACTION",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LA LECTURE SEULE — vérifiée depuis la base, avec le vrai compilateur.
// ═══════════════════════════════════════════════════════════════════════════════════════════

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__smoke${Date.now()}`;

suite("lecture seule — une absence d'outil, pas une consigne", () => {
  let pdg: CurrentUser;

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = {
      id: u.id, name: u.name, email: u.email, role: u.role,
      access: (await getAccess(u.id, u.role)) as EffectiveAccess,
      mustChangePassword: false,
    };
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg?.id } });
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  });

  it("le plafond RETIRE des capacités, et n'en ajoute jamais", () => {
    const complet = catalogueDe(pdg);
    const plafonne = catalogueDe(pdg, { effetMax: "ANALYZE" });
    expect(complet.taille).toBeGreaterThan(0);
    expect(plafonne.taille).toBeGreaterThan(0);
    expect(plafonne.taille).toBeLessThan(complet.taille);

    // Le sous-ensemble est STRICT : tout ce que le plafond laisse passer existait déjà.
    const acteur = acteurDe(pdg);
    const idsComplets = new Set(complet.brief(acteur).map((b) => b.id));
    for (const b of plafonne.brief(acteur)) expect(idsComplets.has(b.id)).toBe(true);
  });

  it("aucune capacité au-dessus d'ANALYZE ne survit au plafond — les trois réponses concordent", () => {
    const plafonne = catalogueDe(pdg, { effetMax: "ANALYZE" });
    const acteur = acteurDe(pdg);
    for (const b of plafonne.brief(acteur)) {
      expect(EFFECT_RANK[b.effect], `${b.id} (${b.effect})`).toBeLessThanOrEqual(EFFECT_RANK.ANALYZE);
    }
    // `has` et `allowed` disent la même chose que `brief` : un catalogue qui montrerait moins
    // qu'il n'autorise laisserait passer une capacité que le modèle peut deviner.
    expect(plafonne.has("send_message")).toBe(false);
    expect(plafonne.allowed("send_message", acteur)).toBe(false);
    expect(catalogueDe(pdg).has("send_message")).toBe(true);
  });

  /**
   * LE BANC QUI PORTE LE LOT.
   *
   * Un modèle propose d'envoyer un message. Sous plafond, le compilateur doit REFUSER — pas
   * l'exécuter en l'entourant de précautions, pas l'accepter en la marquant « à confirmer ».
   * Refuser, à la compilation.
   *
   * Retirer `opts.lectureSeule ? { effetMax: "ANALYZE" } : {}` de `lancerMission` fait tomber
   * ce test, et lui seul le fait tomber. C'est ce qui distingue une garde branchée d'une garde
   * écrite.
   */
  it("un plan qui demande une ÉCRITURE est refusé à la compilation sous lecture seule", async () => {
    const planAvecEcriture = planScripte({
      goal: "Prévenir les salariés du point d'étape.",
      reasoningComplexity: "B",
      executionScale: "S",
      acceptanceCriteria: ["Le message est parti."],
      workstreams: [{ id: "w", title: "Envoi", outcome: "Message envoyé." }],
      steps: [{
        key: "envoi", title: "Envoyer le message", workstream: "w",
        nodeType: "CAPABILITY", capability: "send_message",
        inputs: [
          { key: "recipientName", kind: "TEXT", value: `${TAG} PDG` },
          { key: "body", kind: "TEXT", value: "Point d'étape." },
        ],
        dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [],
        completionCondition: "Le message est envoyé.",
        reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      }],
      expectedArtifacts: [],
      approvalStrategy: "BUNDLE",
      completionCriteria: "Le message est parti.",
      gaps: [],
      rationale: "Un seul envoi, un seul accord.",
    });

    const cerveau = new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: planAvecEcriture })),
    ]);

    const refuse = await lancerMission(pdg, "Préviens les salariés.", {
      reasoner: cerveau, lectureSeule: true, demarrer: false,
    });

    expect(refuse.ok, "une écriture ne doit pas compiler sous plafond de lecture").toBe(false);
    if (refuse.ok) return;
    const codes = (refuse.refus ?? []).map((i) => i.code);
    expect(codes.join(","), "le refus doit nommer la capacité, pas une règle de forme")
      .toMatch(/UNKNOWN_CAPABILITY|FORBIDDEN_CAPABILITY/);

    // ── LE CONTRE-EXEMPLE, et il est indispensable ─────────────────────────────────────
    //
    // Sans lui, le test passerait aussi si le plan était refusé pour une TOUTE AUTRE raison —
    // un champ mal formé, une dépendance absente. Le même plan, sans plafond, doit compiler :
    // c'est ce qui prouve que le refus vient bien du plafond.
    const accepte = await lancerMission(pdg, "Préviens les salariés.", {
      reasoner: new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planAvecEcriture }))]),
      demarrer: false,
    });
    expect(accepte.ok, "le même plan sans plafond doit compiler — sinon le test ne prouve rien").toBe(true);
  }, 60_000);
});
