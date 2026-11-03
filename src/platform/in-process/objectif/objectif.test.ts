import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { executePowerTool } from "@/lib/assistant/power-tools";
import { consignerMesure } from "@/lib/evals/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OBJECTIF DURABLE PAR LE VRAI POINT D'ENTRÉE (mandat 6 §47).
 *
 * §14 : « une capacité sans appelant réel n'existe pas ». Tout ce qui suit passe donc par
 * `executePowerTool` — le dispatcher qu'Adam appelle en production — et jamais par le pont en
 * direct. Ce qui est vérifié ici n'est pas que le code s'exécute : c'est que
 *
 *   1. la probabilité NE SORT JAMAIS SEULE — facteurs, preuves et limites l'accompagnent ;
 *   2. rien ne se coche tout seul : un critère change parce qu'on le CONSTATE, avec sa preuve ;
 *   3. l'objectif d'un autre est hors de portée par la CLAUSE SQL, pas par une politesse ;
 *   4. la simulation refuse de propager dans un graphe qu'on ne lui a pas déclaré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const SRC = "platform/in-process/objectif/objectif.test.ts";
const TAG = `OBJ${Date.now().toString(36).toUpperCase()}`;
let pdg: CurrentUser;
let autre: CurrentUser;
let lecteur: CurrentUser;
let objectifId = "";

const appel = async (u: CurrentUser, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const brut = await executePowerTool("objectif_durable", input, u);
  expect(brut, `l'outil n'est pas branché : ${JSON.stringify(input)}`).not.toBeNull();
  return JSON.parse(brut!) as Record<string, unknown>;
};
/** Le pourcentage lu DANS la phrase — parce que l'outil ne rend jamais le nombre tout seul. */
const pourcent = (phrase: unknown): number => {
  const m = /(-?\d+)\s*%/.exec(String(phrase ?? ""));
  return m ? Number(m[1]) : NaN;
};

const creer = async (name: string, role: "SUPER_ADMIN" | "VIEWER"): Promise<CurrentUser> => {
  const x = await prisma.user.create({
    data: { name: `${TAG} ${name}`, email: `${TAG.toLowerCase()}${name.toLowerCase()}@amd.dz`, passwordHash: "x", role },
    select: { id: true, name: true, email: true, role: true },
  });
  return { id: x.id, name: x.name, email: x.email, role: x.role, access: (await getAccess(x.id, x.role)) as EffectiveAccess, mustChangePassword: false };
};

suite("objectif durable — ce qui survit aux missions, par le vrai chemin", () => {
  beforeAll(async () => {
    pdg = await creer("PDG", "SUPER_ADMIN");
  }, 60_000);

  afterAll(async () => {
    await prisma.executiveObjective.deleteMany({ where: { statement: { startsWith: TAG } } });
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG.toLowerCase() } } });
  });

  it("crée un objectif, le retrouve, et rend une probabilité QUI NE SORT JAMAIS SEULE", async () => {
    const dans90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const passe = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);

    const cree = await appel(pdg, {
      question: "creer",
      enonce: `${TAG} être prêts pour l'appel d'offres 2027`,
      echeance: dans90,
      criteres: [
        { id: "c1", enonce: "le dossier d'enregistrement est déposé", etat: "ATTEINT", preuve: "accusé ANPP du 12/03" },
        { id: "c2", enonce: "le packaging est validé", etat: "EN_COURS" },
        { id: "c3", enonce: "le prix est arbitré", etat: "INCONNU" },
      ],
      jalons: [
        { id: "j1", libelle: "dépôt du dossier", etat: "FAIT", echeance: passe },
        { id: "j2", libelle: "validation packaging", etat: "EN_RETARD", echeance: passe, dependDe: ["j1"] },
        { id: "j3", libelle: "lancement industriel", etat: "PAS_COMMENCE", dependDe: ["j2"] },
      ],
      risques: [{ quoi: "rupture d'approvisionnement du principe actif", vraisemblance: 0.3, impact: 0.8 }],
      liens: [
        { de: "j2", vers: "j3", direction: "FREINE", intensite: 0.8, confiance: 0.8, hypothese: "la ligne ne démarre pas sans packaging validé", preuves: ["PV de comité industriel du 04/02"] },
        { de: "j3", vers: "AO", direction: "FREINE", intensite: 0.7, confiance: 0.7, hypothese: "sans lot industriel, pas de soumission recevable" },
      ],
    });
    expect(cree.erreur, JSON.stringify(cree)).toBeUndefined();
    objectifId = String(cree.objectif ?? cree.id ?? "");
    expect(objectifId).not.toBe("");

    const etat = await appel(pdg, { question: "etat", objectif: objectifId });
    expect(etat.erreur).toBeUndefined();

    // ── LA PROPRIÉTÉ CENTRALE : le nombre vient avec son POURQUOI ────────────────────────
    const texte = JSON.stringify(etat);
    expect(texte).toMatch(/%/);
    const facteurs = etat.facteurs as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(facteurs) && facteurs.length > 0, texte).toBe(true);
    for (const f of facteurs!) expect(String(f.preuve ?? "").length, JSON.stringify(f)).toBeGreaterThan(0);

    // Le facteur négatif PRINCIPAL est nommé — c'est la phrase que le dirigeant retiendra.
    expect(String(etat.probabilite ?? "")).toMatch(/facteur négatif principal/i);
    consignerMesure("probabilite_jamais_seule", { n: 1, ok: 1 }, SRC, `${facteurs!.length} facteurs, tous avec preuve, facteur négatif principal nommé`);
    expect(Number.isFinite(pourcent(etat.probabilite))).toBe(true);

    // Et le chiffre porte ce qu'il N'EST PAS.
    expect(JSON.stringify(etat.ce_que_ce_chiffre_n_est_pas ?? [])).toMatch(/pas une prévision statistique/i);

    // Le retard de j2 est le fait dominant : il doit apparaître, avec le blocage qu'il crée.
    expect(texte).toMatch(/retard/i);
  }, 60_000);

  it("le retard déclaré FAIT BAISSER la probabilité — et le constat, la fait remonter", async () => {
    const avant = await appel(pdg, { question: "etat", objectif: objectifId });
    const pAvant = pourcent(avant.probabilite);
    expect(Number.isFinite(pAvant)).toBe(true);

    // On CONSTATE que le packaging est validé, AVEC sa preuve. Rien ne s'est coché tout seul :
    // c'est un geste, et il est tracé comme tel.
    const maj = await appel(pdg, {
      question: "constater",
      objectif: objectifId,
      criteres: [
        { id: "c1", enonce: "le dossier d'enregistrement est déposé", etat: "ATTEINT", preuve: "accusé ANPP du 12/03" },
        { id: "c2", enonce: "le packaging est validé", etat: "ATTEINT", preuve: "PV de validation du 02/09" },
        { id: "c3", enonce: "le prix est arbitré", etat: "INCONNU" },
      ],
      jalons: [
        { id: "j1", libelle: "dépôt du dossier", etat: "FAIT" },
        { id: "j2", libelle: "validation packaging", etat: "FAIT", dependDe: ["j1"] },
        { id: "j3", libelle: "lancement industriel", etat: "EN_COURS", dependDe: ["j2"] },
      ],
    });
    expect(maj.erreur, JSON.stringify(maj)).toBeUndefined();

    const apres = await appel(pdg, { question: "etat", objectif: objectifId });
    expect(pourcent(apres.probabilite)).toBeGreaterThan(pAvant);
    consignerMesure("rien_ne_se_coche_seul", { n: 1, ok: 1 }, SRC, "un critère ne change que par « constater », avec sa preuve");
  }, 60_000);

  it("« que se passe-t-il si… » propage dans les liens DÉCLARÉS, et refuse quand il n'y en a pas", async () => {
    const sim = await appel(pdg, { question: "simuler", objectif: objectifId, noeud: "j2", ampleur: -0.5 });
    expect(sim.erreur, JSON.stringify(sim)).toBeUndefined();
    const impacts = sim.impacts as Array<Record<string, unknown>>;
    expect(Array.isArray(impacts)).toBe(true);
    // j2 freine j3 qui freine AO : le choc doit ATTEINDRE l'AO, en s'atténuant.
    const touches = impacts.map((i) => String(i.sur));
    expect(touches, JSON.stringify(impacts)).toContain("j3");
    expect(touches, JSON.stringify(impacts)).toContain("AO");
    const j3 = Number(impacts.find((i) => i.sur === "j3")!.effet);
    const ao = Number(impacts.find((i) => i.sur === "AO")!.effet);
    expect(Math.abs(ao)).toBeLessThan(Math.abs(j3));

    // Un objectif SANS lien causal ne se simule pas — on ne devine pas un graphe absent.
    const nu = await appel(pdg, { question: "creer", enonce: `${TAG} objectif sans dépendances`, criteres: [{ enonce: "quelque chose", etat: "INCONNU" }] });
    const nuId = String(nu.objectif ?? nu.id ?? "");
    const simNu = await appel(pdg, { question: "simuler", objectif: nuId, noeud: "x", ampleur: -1 });
    expect(String(simNu.erreur ?? "")).toMatch(/aucun lien causal/i);
  }, 60_000);

  it("l'objectif d'un AUTRE est hors de portée, même avec son identifiant exact", async () => {
    autre = await creer("Autre", "SUPER_ADMIN");
    const vu = await appel(autre, { question: "etat", objectif: objectifId });
    expect(String(vu.erreur ?? "")).toMatch(/aucun objectif/i);
    const listeAutre = await appel(autre, { question: "lister" });
    expect(JSON.stringify(listeAutre)).not.toContain(objectifId);

    // Et une écriture avec le bon identifiant ne mord pas non plus.
    const ecrit = await appel(autre, { question: "constater", objectif: objectifId, criteres: [{ enonce: "piraté", etat: "ATTEINT", preuve: "aucune" }] });
    expect(String(ecrit.erreur ?? "")).toMatch(/aucun objectif/i);
    const intact = await appel(pdg, { question: "etat", objectif: objectifId });
    expect(JSON.stringify(intact)).not.toContain("piraté");
    consignerMesure("objectif_cloisonne", { n: 3, ok: 3 }, SRC, "lecture, liste et écriture refusées à un autre propriétaire, identifiant exact en main");
  }, 60_000);

  it("un objectif d'entreprise se tient à la direction — un lecteur est refusé, et on le lui DIT", async () => {
    lecteur = await creer("Lecteur", "VIEWER");
    for (const q of ["creer", "lister", "etat", "constater", "simuler"]) {
      const r = await appel(lecteur, { question: q, enonce: `${TAG} tentative`, objectif: objectifId, noeud: "x", ampleur: -1 });
      expect(String(r.erreur ?? ""), q).toMatch(/direction|droit|autoris/i);
    }
  }, 60_000);

  it("« lister » rend chaque objectif AVEC sa probabilité — pas une liste de titres", async () => {
    const l = await appel(pdg, { question: "lister" });
    const objectifs = l.objectifs as Array<Record<string, unknown>>;
    expect(Array.isArray(objectifs)).toBe(true);
    expect(objectifs.length).toBeGreaterThanOrEqual(2);
    for (const o of objectifs) expect(Number.isFinite(pourcent(o.probabilite)), JSON.stringify(o)).toBe(true);
  }, 60_000);
});
