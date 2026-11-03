// EN PREMIER, comme le worker (`scripts/worker.ts`) : le contexte asynchrone de Next, réel hors de son serveur.
import "@/lib/async-local-storage-global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import { demarrerLesSousMissions, outilsSousMissionsDuTour, outilTravailPour, PERSONA_ASSISTANT_IA } from "./travaux";
import { lireDemandeRecherche, ORIGINE_RECHERCHE, planRecherche } from "../domaine/recherche-approfondie";
import { conclureSousMissions, tableauDesMissions, travauxDOfficePour } from "./sous-missions";
import { cleDeTitre, extraitDuLivrable, phraseIndicateur, phraseSynthese, reglageDOffice } from "../domaine/sous-missions";
import { planSansGeste } from "@/lib/missions/travaux/regles";
import { travauxEnParallele } from "@/lib/missions/travaux/balayage";

/**
 * LES SOUS-MISSIONS (K3, décision 0033) — plusieurs travaux lancés d'un même tour, démarrés d'office quand ils n'ont
 * aucun geste (selon le réglage), rassemblés sur le tour, suivis par le tableau de bord, et conclus par UNE synthèse
 * dans la conversation quand le dernier finit.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__smi__${Date.now()}`;
let chef: CurrentUser;
let agent: CurrentUser;
let lecture = "";
let filId = "";

const plan = (titre: string) => ({
  titre, objectif: `Objectif de ${titre}.`,
  etapes: [
    { cle: "lire", titre: "Lire", type: "LECTURE", outil: lecture, entree: {} },
    { cle: "rapport", titre: "Rapport", type: "LIVRABLE", consigne: "Rédige le rapport.", apres: ["lire"], format: "md" },
  ],
});

describe("les règles pures des sous-missions", () => {
  it("deux reformulations du même plan ont la même clé ; deux plans différents, non", () => {
    expect(cleDeTitre("Synthèse des achats")).toBe(cleDeTitre("synthese des ACHATS !"));
    expect(cleDeTitre("Lecture du dossier")).not.toBe(cleDeTitre("Analyse des chiffres"));
  });
  it("démarrer d'office : préférence > console (personne, rôle) > oui pour le Super Admin, non sinon", () => {
    expect(reglageDOffice({ preference: null, personne: null, role: null, superAdmin: true })).toBe(true);
    expect(reglageDOffice({ preference: null, personne: null, role: null, superAdmin: false })).toBe(false);
    expect(reglageDOffice({ preference: null, personne: null, role: true, superAdmin: false })).toBe(true);
    expect(reglageDOffice({ preference: null, personne: false, role: true, superAdmin: false })).toBe(false);
    expect(reglageDOffice({ preference: true, personne: false, role: false, superAdmin: false })).toBe(true);
  });
  it("un plan SANS GESTE : lecture, lots, analyse, livrable — un geste, une demande ou une attente le fait approuver", () => {
    expect(planSansGeste({ etapes: [{ type: "LECTURE" }, { type: "ANALYSE" }, { type: "LIVRABLE" }] }, [])).toBe(true);
    expect(planSansGeste({ etapes: [{ type: "LECTURE" }, { type: "GESTE" }] }, [{ nom: "x" }])).toBe(false);
    expect(planSansGeste({ etapes: [{ type: "LECTURE" }, { type: "DEMANDE" }] }, [])).toBe(false);
    expect(planSansGeste({ etapes: [{ type: "ATTENTE" }, { type: "LIVRABLE" }] }, [])).toBe(false);
    expect(planSansGeste({ etapes: [] }, [])).toBe(false);
  });
  it("l'indicateur de l'en-tête et la synthèse se disent en clair", () => {
    expect(phraseIndicateur(3, 0)).toBe("3 missions en cours");
    expect(phraseIndicateur(1, 2)).toBe("1 mission en cours · 2 à approuver");
    expect(phraseIndicateur(0, 0)).toBeNull();
    const t = phraseSynthese([
      { titre: "Lecture", statut: "COMPLETED", coutUsd: 0.02, extrait: "12 pièces lues.", document: { nom: "Lecture.docx", lien: "/drive/cabcdefghijklmnopqrstuv" }, dureeMs: 65_000 },
      { titre: "Analyse", statut: "FAILED", coutUsd: 0.01, extrait: "", document: null, dureeMs: 5_000 },
    ], "Tout est lu.");
    expect(t).toContain("1/2 terminée");
    expect(t).toContain("En bref : Tout est lu.");
    expect(t).toContain("[Lecture.docx](/api/drive/cabcdefghijklmnopqrstuv/raw)");
    expect(extraitDuLivrable("# Titre\n\n## Partie\nDouze **pièces** lues.\n| a | b |\n|---|---|\nDeux manquent.")).toBe("Douze pièces lues. Deux manquent.");
    expect(t).toContain("**2. Analyse** — en échec");
  });
  it("les travaux d'un passage avancent ENSEMBLE, sous une borne réglable", () => {
    expect(travauxEnParallele({})).toBe(4);
    expect(travauxEnParallele({ TRAVAUX_EN_PARALLELE: "2" })).toBe(2);
    expect(travauxEnParallele({ TRAVAUX_EN_PARALLELE: "999" })).toBe(12);
    expect(travauxEnParallele({ TRAVAUX_EN_PARALLELE: "zéro" })).toBe(4);
  });
});

describe("la recherche approfondie — les règles", () => {
  it("un sujet et 2 à 6 angles distincts ; trop peu d'angles → trois angles par défaut ; sans sujet, refus", () => {
    expect(lireDemandeRecherche({ angles: ["a", "b"] }).ok).toBe(false);
    const peu = lireDemandeRecherche({ sujet: "Marché algérien des biosimilaires", angles: ["prix"] });
    expect(peu.ok && peu.demande.angles).toHaveLength(3);
    const trop = lireDemandeRecherche({ sujet: "Marché algérien des biosimilaires", angles: ["a", "b", "A", "c", "d", "e", "f", "g"] });
    expect(trop.ok && trop.demande.angles).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("le plan : une LECTURE web_research par angle, sans dépendance (en parallèle), puis le rapport en PDF après toutes", () => {
    const l = lireDemandeRecherche({ sujet: "Biosimilaires en Algérie", angles: ["marché", "acteurs", "réglementation"] });
    if (!l.ok) throw new Error("demande refusée");
    const p = planRecherche(l.demande) as { etapes: { cle: string; type: string; outil?: string; apres?: string[]; format?: string; entree?: { query: string } }[] };
    const lectures = p.etapes.filter((e) => e.type === "LECTURE");
    expect(lectures.map((e) => e.outil)).toEqual(["web_research", "web_research", "web_research"]);
    expect(lectures.every((e) => !e.apres?.length)).toBe(true);
    expect(lectures[1]!.entree!.query).toBe("Biosimilaires en Algérie — acteurs");
    const rapport = p.etapes.at(-1)!;
    expect(rapport).toMatchObject({ type: "LIVRABLE", format: "pdf", apres: ["recherche-1", "recherche-2", "recherche-3"] });
    expect(planSansGeste(p as never, [])).toBe(true);
  });
});

suite("les sous-missions — plusieurs par tour, d'office, conclues dans la conversation", () => {
  beforeAll(async () => {
    const a = await prisma.user.create({ data: { name: `${TAG}Directrice`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    const b = await prisma.user.create({ data: { name: `${TAG}Agent`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    chef = { id: a.id, name: a.name, email: a.email, role: "SUPER_ADMIN" } as CurrentUser;
    agent = { id: b.id, name: b.name, email: b.email, role: "SUPER_ADMIN" } as CurrentUser;
    lecture = (await PERSONA_ASSISTANT_IA.catalogue(chef.id)).lectures[0]?.nom ?? "";
    filId = (await prisma.assistantIaFil.create({ data: { userId: chef.id, titre: "Bilan du trimestre" } })).id;
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { principalId: { in: [chef.id, agent.id] } } }).catch(() => undefined);
    await prisma.assistantIaPreference.deleteMany({ where: { userId: { in: [chef.id, agent.id] } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("PRÉMISSE : une lecture à mettre au plan", () => expect(lecture).not.toBe(""));

  it("trois plans DIFFÉRENTS dans un même tour : trois sous-missions, toutes gardées, démarrées d'office (Super Admin, sans geste)", async () => {
    const lances: string[] = [];
    const outil = outilTravailPour(chef, lances);
    const r = await Promise.all(["Lecture du dossier", "Analyse des chiffres", "Note de synthèse"].map(async (t) => JSON.parse(await outil.run(plan(t), chef)) as { statut: string; travailId: string }));
    expect(r.map((x) => x.statut)).toEqual(["DEMARRE", "DEMARRE", "DEMARRE"]);
    expect(lances).toHaveLength(3);
    const ms = await prisma.mission.findMany({ where: { id: { in: lances } }, select: { status: true, planApprouveLe: true, reveilDemandeLe: true } });
    expect(ms.every((m) => m.status === "READY" && m.planApprouveLe && m.reveilDemandeLe)).toBe(true);
    const journal = await prisma.missionEvent.count({ where: { missionId: { in: lances }, kind: "TRAVAIL_DOFFICE" } });
    expect(journal).toBe(3);
  });

  it("dans la CONVERSATION, le démarrage d'office attend la FIN du tour : une reformulation est annulée avant d'avoir coûté", async () => {
    const lances: string[] = [];
    const outil = outilTravailPour(chef, lances, "fin-du-tour");
    const a = JSON.parse(await outil.run(plan("Revue des contrats"), chef)) as { statut: string; travailId: string };
    expect(a.statut).toBe("DEMARRE");
    expect((await prisma.mission.findUnique({ where: { id: a.travailId }, select: { status: true } }))?.status).toBe("AWAITING_APPROVAL");
    const b = JSON.parse(await outil.run(plan("Revue des contrats."), chef)) as { travailId: string; remplace: string };
    expect(b.remplace).toBe(a.travailId);
    expect(await demarrerLesSousMissions(chef, lances)).toBe(1);
    const ms = await prisma.mission.findMany({ where: { id: { in: [a.travailId, b.travailId] } }, select: { id: true, status: true, planApprouveLe: true } });
    expect(ms.find((m) => m.id === a.travailId)?.planApprouveLe).toBeNull();
    expect(ms.find((m) => m.id === b.travailId)?.status).toBe("READY");
  });

  it("RECHERCHE APPROFONDIE : l'outil du tour ouvre une mission de sous-recherches en parallèle, démarrée d'office, marquée « recherche »", async () => {
    const lances: string[] = [];
    const [, recherche] = outilsSousMissionsDuTour(chef, lances, "immediat");
    expect(recherche!.def.name).toBe("recherche_approfondie");
    const r = JSON.parse(await recherche!.run({ sujet: "Biosimilaires de l'insuline en Afrique du Nord", angles: ["marché", "acteurs", "prix", "réglementation"] }, chef)) as { statut: string; travailId: string; sousRecherches: number };
    expect(r.statut).toBe("DEMARRE");
    expect(r.sousRecherches).toBe(4);
    const m = await prisma.mission.findUnique({ where: { id: r.travailId }, select: { context: true, status: true, steps: { select: { key: true, capability: true } } } });
    expect(m?.context).toBe(ORIGINE_RECHERCHE);
    expect(m?.steps.filter((x) => x.capability?.endsWith("web_research"))).toHaveLength(4);
    expect(lances).toEqual([r.travailId]);
    await prisma.mission.update({
      where: { id: r.travailId },
      data: { status: "COMPLETED", carnet: { objectif: "x", plan: null, notes: [], trouvailles: [], livrables: [{ etape: "rapport", titre: "Rapport de recherche", contenu: "# Biosimilaires\n\n## Sommaire\n- Marché\n\n## Marché\nLe marché pèse 12 M$ en 2025 [1].\n\n## Sources\n[1] Rapport — https://exemple.org/rapport", at: new Date().toISOString() }] } },
    });
    const tour = await prisma.assistantIaTour.create({ data: { filId, userId: chef.id, role: "assistant", etat: "TERMINE", contenu: "Recherche lancée.", travaux: lances } });
    expect(await conclureSousMissions(r.travailId)).toBe("ecrite");
    const s = await prisma.assistantIaTour.findFirst({ where: { syntheseDe: tour.id }, select: { contenu: true } });
    expect(s?.contenu).toContain("## Sources");
    expect(s?.contenu).toContain("[1] Rapport — https://exemple.org/rapport");
  });

  it("la personne a réglé « non » : le plan sans geste ATTEND son accord", async () => {
    await prisma.assistantIaPreference.create({ data: { userId: agent.id, travauxDOffice: false } });
    expect(await travauxDOfficePour(agent)).toBe(false);
    const r = JSON.parse(await outilTravailPour(agent).run(plan("Attend l'accord"), agent)) as { statut: string };
    expect(r.statut).toBe("EN_ATTENTE_D_APPROBATION");
  });

  it("`parent` range une sous-mission sous un travail de la personne — jamais sous celui d'un autre", async () => {
    const lances: string[] = [];
    const outil = outilTravailPour(chef, lances);
    const parent = JSON.parse(await outil.run(plan("Mission mère"), chef)) as { travailId: string };
    const enfant = JSON.parse(await outil.run({ ...plan("Mission fille"), parent: parent.travailId }, chef)) as { travailId: string };
    expect((await prisma.mission.findUnique({ where: { id: enfant.travailId }, select: { parentMissionId: true } }))?.parentMissionId).toBe(parent.travailId);
    const vole = JSON.parse(await outilTravailPour(agent).run({ ...plan("Intrus"), parent: parent.travailId }, agent)) as { statut: string; fautes: string[] };
    expect(vole.statut).toBe("PLAN_REFUSE");
    expect(vole.fautes[0]).toContain("Travail parent introuvable");
  });

  it("le tableau de bord : chaque mission, ses étapes, et la conversation qui l'a lancée ; cloisonné", async () => {
    const lances: string[] = [];
    const outil = outilTravailPour(chef, lances);
    for (const t of ["Tableau A", "Tableau B"]) await outil.run(plan(t), chef);
    await prisma.assistantIaTour.create({ data: { filId, userId: chef.id, role: "assistant", etat: "TERMINE", contenu: "Lancées.", travaux: lances } });
    const t = await tableauDesMissions(chef.id);
    const a = t.missions.find((m) => m.id === lances[0])!;
    expect(a.etapes.map((e) => e.cle)).toEqual(["lire", "rapport"]);
    expect(a.etapes.every((e) => e.etat === "FILE")).toBe(true);
    expect(a.conversation?.id).toBe(filId);
    expect(a.conversation?.titre).toBe("Bilan du trimestre");
    expect(t.enCours).toBeGreaterThanOrEqual(2);
    expect((await tableauDesMissions(agent.id)).missions.some((m) => lances.includes(m.id))).toBe(false);
  });

  it("la SYNTHÈSE : rien tant qu'une sous-mission tourne ; puis UNE réponse dans la conversation, une seule fois", async () => {
    const lances: string[] = [];
    const outil = outilTravailPour(chef, lances);
    for (const t of ["Synthèse A", "Synthèse B"]) await outil.run(plan(t), chef);
    const tour = await prisma.assistantIaTour.create({ data: { filId, userId: chef.id, role: "assistant", etat: "TERMINE", contenu: "Deux sous-missions lancées.", travaux: lances } });
    expect(await conclureSousMissions(lances[0]!)).toBe("attente");
    await prisma.mission.update({
      where: { id: lances[0]! },
      data: { status: "COMPLETED", carnet: { objectif: "x", plan: null, notes: [], trouvailles: [], livrables: [{ etape: "rapport", titre: "Rapport A", contenu: "Douze pièces lues, deux manquent.", at: new Date().toISOString() }] } },
    });
    await prisma.mission.update({ where: { id: lances[1]! }, data: { status: "CANCELLED" } });
    expect(await conclureSousMissions(lances[1]!)).toBe("ecrite");
    expect(await conclureSousMissions(lances[0]!)).toBe("rien");
    const s = await prisma.assistantIaTour.findMany({ where: { syntheseDe: tour.id } });
    expect(s).toHaveLength(1);
    expect(s[0]!.filId).toBe(filId);
    expect(s[0]!.contenu).toContain("1/2 terminée");
    expect(s[0]!.contenu).toContain("Douze pièces lues, deux manquent.");
  });
});
