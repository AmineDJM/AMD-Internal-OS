import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VÉRIFICATION ET L'APPRENTISSAGE PAR LE VRAI CHEMIN (mandat 6 §49).
 *
 * Les échecs ne sont pas injectés dans une table à eux : ils sont écrits dans `MissionEvent`
 * sous la forme que le moteur produit depuis §44 (`STEP_FAILED` avec `detail.manque`). Si ce
 * format changeait, ce test tomberait — ce qui est exactement l'intérêt : l'apprentissage n'a
 * pas de source à lui, il vit de celle-là.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `VER${Date.now().toString(36).toUpperCase()}`;
let pdg: CurrentUser;
let autre: CurrentUser;

const appel = async (u: CurrentUser, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const brut = await executePowerTool("verifier_avant_de_dire", input, u);
  expect(brut, `outil non branché : ${JSON.stringify(input)}`).not.toBeNull();
  return JSON.parse(brut!) as Record<string, unknown>;
};

const creerUser = async (nom: string): Promise<CurrentUser> => {
  const x = await prisma.user.create({
    data: { name: `${TAG} ${nom}`, email: `${TAG.toLowerCase()}${nom.toLowerCase()}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    select: { id: true, name: true, email: true, role: true },
  });
  return { id: x.id, name: x.name, email: x.email, role: x.role, access: (await getAccess(x.id, x.role)) as EffectiveAccess, mustChangePassword: false };
};

/** Un échec écrit DANS LE FORMAT que le moteur produit — §44, `detail.manque`. */
const echouer = async (missionId: string, nature: string, capacite: string, quand: Date) => {
  await prisma.missionEvent.create({
    data: {
      missionId, kind: "STEP_FAILED", summary: `échec sur ${capacite}`,
      detail: { manque: { nature, quoi: `${capacite} n'a rien rendu` }, capability: capacite, model: "terra" },
      at: quand,
    },
  });
};

const creerMission = async (owner: CurrentUser, objectif: string): Promise<string> => {
  const m = await prisma.mission.create({
    data: { title: `${TAG} ${objectif.slice(0, 40)}`, objective: objectif, ownerId: owner.id, status: "FAILED" },
    select: { id: true },
  });
  return m.id;
};

suite("vérification proportionnée & apprentissage — par le vrai chemin", () => {
  beforeAll(async () => {
    pdg = await creerUser("PDG");
    autre = await creerUser("Autre");
  }, 60_000);

  afterAll(async () => {
    const ms = await prisma.mission.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    await prisma.missionEvent.deleteMany({ where: { missionId: { in: ms.map((m) => m.id) } } });
    await prisma.mission.deleteMany({ where: { title: { startsWith: TAG } } });
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG.toLowerCase() } } });
  });

  it("« programme » calcule le niveau et dit ce que les méthodes NE VERRONT PAS", async () => {
    const r = await appel(pdg, {
      question: "programme", affirmation: "le total à régler à Hetero Labs est de 8 200 000 DZD",
      obtention: "AGREGATION", exposition: "PARTENAIRE", reversible: false,
      montant_dzd: 8_200_000, echeance_engagee: true, cardinalite: 34,
    });
    expect(r.erreur, JSON.stringify(r)).toBeUndefined();
    expect(r.niveau).toBe("ADVERSARIAL");
    const methodes = r.methodes as Array<Record<string, unknown>>;
    expect(methodes.length).toBeGreaterThanOrEqual(3);
    // Le recalcul d'abord — gratuit, et le seul qui prouve.
    expect(String(methodes[0]!.methode)).toBe("RECALCUL");
    expect(methodes[0]!.un_echec_prouve).toBe(true);
    // Chaque méthode dit son angle mort.
    for (const m of methodes) expect((m.ne_voit_pas as unknown[]).length, JSON.stringify(m)).toBeGreaterThan(0);
    expect(JSON.stringify(r.ce_que_ce_ne_sera_pas)).toMatch(/ne prouve pas que le résultat est VRAI/i);
  }, 60_000);

  it("une lecture directe pour soi ne déclenche RIEN, et le dit comme une décision", async () => {
    const r = await appel(pdg, {
      question: "programme", affirmation: "le statut du dossier",
      obtention: "LECTURE_DIRECTE", exposition: "MOI", reversible: true,
    });
    expect(r.niveau).toBe("AUCUN");
    expect((r.methodes as unknown[])).toHaveLength(0);
    expect(String(r.justification)).toMatch(/dévalue les vérifications qui comptent/i);
  }, 60_000);

  it("« conclure » refuse de dire « c'est vrai », et un recalcul contredit l'emporte", async () => {
    const base = {
      question: "conclure", affirmation: "43,1 M DZD", obtention: "AGREGATION",
      exposition: "PARTENAIRE", reversible: false, montant_dzd: 43_100_000, cardinalite: 34,
    };
    const tout = await appel(pdg, {
      ...base,
      resultats: [
        { methode: "RECALCUL", accord: true, constat: "identique" },
        { methode: "RECONCILIATION", accord: true, constat: "le détail somme au total" },
        { methode: "SCHEMA", accord: true, constat: "forme correcte" },
        { methode: "SOURCE_ALTERNATIVE", accord: true, constat: "même valeur en compta" },
        { methode: "ADVERSARIAL", accord: true, constat: "aucune faille trouvée" },
      ],
    });
    expect(tout.issue).toBe("CONFIRME");
    expect(String(tout.a_dire)).toMatch(/pas que c'est vrai/i);

    const faux = await appel(pdg, {
      ...base,
      resultats: [
        { methode: "RECALCUL", accord: false, constat: "le total recalculé vaut 41 300 000", trouve: "41 300 000" },
        { methode: "RECONCILIATION", accord: true, constat: "cohérent" },
        { methode: "SCHEMA", accord: true, constat: "forme correcte" },
        { methode: "SOURCE_ALTERNATIVE", accord: true, constat: "même valeur" },
      ],
    });
    expect(faux.issue).toBe("CONTREDIT");
    expect(JSON.stringify(faux.desaccords)).toContain("41 300 000");
    consignerMesure("negatif_l_emporte", { n: 2, ok: (tout.issue === "CONFIRME" ? 1 : 0) + (faux.issue === "CONTREDIT" ? 1 : 0) },
      "platform/in-process/verification/verification.test.ts",
      "un recalcul qui contredit l'emporte sur quatre confirmations");
  }, 60_000);

  it("une méthode NON EXÉCUTÉE ne confirme rien — la vérification est dite incomplète", async () => {
    const r = await appel(pdg, {
      question: "conclure", affirmation: "43,1 M DZD", obtention: "AGREGATION",
      exposition: "PARTENAIRE", reversible: false, montant_dzd: 43_100_000, cardinalite: 34,
      resultats: [
        { methode: "RECALCUL", non_executee: true, constat: "le moteur de calcul n'a pas répondu" },
        { methode: "RECONCILIATION", accord: true, constat: "cohérent" },
        { methode: "SCHEMA", accord: true, constat: "forme correcte" },
        { methode: "SOURCE_ALTERNATIVE", accord: true, constat: "même valeur" },
      ],
    });
    expect(r.issue).toBe("NON_VERIFIE");
    expect(String(r.a_dire)).toMatch(/INCOMPLÈTE/i);
  }, 60_000);

  it("« lecons » lit les VRAIS échecs du journal et ne propose qu'au-delà du seuil", async () => {
    // Un seul échec d'un type : du bruit. Trois d'un autre : un défaut.
    const m1 = await creerMission(pdg, "compare les délais ANPP de nos dossiers");
    const m2 = await creerMission(pdg, "quels dossiers traînent à l'ANPP ?");
    const m3 = await creerMission(pdg, "sors les délais moyens par dossier");
    const m4 = await creerMission(pdg, "envoie une relance DocuSign");
    const j = (n: number) => new Date(Date.now() - n * 86_400_000);

    await echouer(m1, "CAPACITE_ABSENTE", "regulatory_timeline", j(5));
    await echouer(m2, "CAPACITE_ABSENTE", "regulatory_timeline", j(4));
    await echouer(m3, "CAPACITE_ABSENTE", "regulatory_timeline", j(3));
    await echouer(m4, "RENDU", "show_chart", j(2));

    const r = await appel(pdg, { question: "lecons", jours: 30 });
    expect(r.erreur, JSON.stringify(r)).toBeUndefined();
    expect(String(r.assiette)).toMatch(/4 échec/);

    const aDecider = r.a_decider as Array<Record<string, unknown>>;
    expect(aDecider, JSON.stringify(r)).toHaveLength(1);
    expect(aDecider[0]!.occurrences).toBe(3);
    expect(aDecider[0]!.action).toBe("AJOUTER_UNE_PRIMITIVE");
    // Trois FORMULATIONS différentes comptent ensemble : c'est le même défaut.
    expect((aDecider[0]!.exemples as unknown[])).toHaveLength(3);

    // Le motif à une occurrence est observé, pas proposé.
    expect((r.observe_sans_conclure as unknown[]).length).toBe(1);

    // L'eval proposé attend le MANQUE NOMMÉ, pas la réussite : la primitive n'existe pas encore.
    const evals = r.evals_a_ecrire as Array<Record<string, unknown>>;
    expect(evals).toHaveLength(1);
    expect(String(evals[0]!.attendu)).toMatch(/NOMME précisément ce qui manque/i);

    // ET LA PHRASE QUI COMPTE : rien ne s'applique tout seul.
    expect(String(r.rappel)).toMatch(/PROPOSITIONS/);
    expect(String(r.rappel)).toMatch(/aucune leçon ne peut ouvrir un droit/i);
    consignerMesure("aucun_apprentissage_silencieux", { n: 2, ok: (aDecider.length === 1 ? 1 : 0) + (/PROPOSITIONS/.test(String(r.rappel)) ? 1 : 0) },
      "platform/in-process/verification/verification.test.ts",
      "3 occurrences → une proposition qui attend un accord ; 1 occurrence reste observée");
  }, 90_000);

  it("les échecs des missions d'AUTRUI ne sortent jamais — cloisonnement par requête", async () => {
    const r = await appel(autre, { question: "lecons", jours: 30 });
    expect(String(r.assiette)).toMatch(/0 échec/);
    expect((r.a_decider as unknown[])).toHaveLength(0);
    // Et surtout : aucun libellé de demande d'autrui n'a fuité.
    expect(JSON.stringify(r)).not.toContain("ANPP");
  }, 60_000);

  it("une panne de fournisseur n'enseigne rien — elle ne produit aucune leçon", async () => {
    const m = await creerMission(pdg, "lis le budget de septembre");
    const j = (n: number) => new Date(Date.now() - n * 86_400_000);
    for (let i = 0; i < 6; i += 1) await echouer(m, "SOURCE_INACCESSIBLE", "read_budget", j(i + 1));

    const r = await appel(pdg, { question: "lecons", jours: 30 });
    const causes = JSON.stringify(r.a_decider);
    // EXECUTION n'est pas dans la table des leçons : un service qui hoquette n'est pas un défaut.
    expect(causes).not.toContain("read_budget");
    expect(JSON.stringify(r.observe_sans_conclure)).not.toContain("read_budget");
  }, 60_000);
});
