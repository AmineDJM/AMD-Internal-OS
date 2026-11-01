import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));
// L'action métier relit la session de la requête : hors requête (banc), c'est la personne du scénario.
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { outilsV1, type PropositionPreparee } from "../outils-v1";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { ETAT, filDe, traiterFil } from "../fil/service";
import { annoncesEnAppel, enregistrerSessionVoix, fermerSessionVoix, reprisesOrales, suivreTravailVocal, traiterEnonceVocal, type SuiviOral } from "./oral";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE, CONTRE LA VRAIE BASE (lot K9, décision 0039) — scénarios oraux scriptés : les énoncés
 * sont ce que la transcription d'entrée de la session aurait rendu (le crédit du fournisseur est épuisé ; le flux
 * d'événements du navigateur est rejoué par `platform/ia/voix/voix.test.ts`).
 *
 *   • la carte (orale, K4) arrive avec le résultat du travail et se conclut à l'oral : « ok fais-le » → exécutée par la
 *     garde du bouton ; « annule » la défait ; une carte renforcée : la voix relit, un « vas-y » suffit ;
 *   • garde-fous SERVEUR : autre personne, session inconnue, rien de neuf entendu, « oui mais attends » → rien n'est fait ;
 *   • la délégation asynchrone : une précision dite pendant le travail est TRANSMISE (ajoutée au message s'il attend,
 *     relance ciblée qui repart du résultat s'il est en cours) ; le résultat dépassé n'est pas dit ; après la session,
 *     le résultat est dit à l'ouverture suivante.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iaoral_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let samia: CurrentUser;
let autre: CurrentUser;
const cleAvant = process.env.OPENAI_API_KEY;
const S = `live_${TAG}sa`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });

async function compte(nom: string, role: "SUPER_ADMIN" | "VIEWER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ALL" } }).catch(() => {});
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

/** Une carte « créer une tâche » préparée par l'outil réel, déposée dans le fil comme le ferait un tour. */
async function carteTache(entree: Record<string, unknown>): Promise<string> {
  const props: PropositionPreparee[] = [];
  const o = outilsV1(sa, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === "task__createTask")!;
  await o.run(entree, sa);
  const p = props[0]!;
  const fil = await filDe(sa.id);
  const q = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "user", contenu: "[Conversation vocale] crée la tâche", etat: ETAT.TRAITE } });
  await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: sa.id, role: "assistant", contenu: "Je prépare la tâche.", etat: ETAT.TERMINE, repondA: q.id,
      intent: { id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields, formulaire: p.proposition.formulaire, status: "PROPOSED" } as never,
    },
  });
  await prisma.assistantIaVoixTravail.create({ data: { userId: sa.id, session: S, conversation: fil.id, tourId: q.id } });
  return p.intentId;
}

async function suivreJusquAuBout(u: CurrentUser, session: string, travail: string): Promise<SuiviOral> {
  for (let i = 0; i < 200; i++) {
    const s = await suivreTravailVocal(u, session, travail);
    if (s.etat !== "en_cours") return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("travail jamais terminé");
}

suite("Assistant IA — la voix entièrement orale (K9)", () => {
  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "cle-de-banc";
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    sa = await compte("Admin", "SUPER_ADMIN");
    ACTEUR = sa;
    samia = await compte("Samia", "VIEWER");
    autre = await compte("Autre", "SUPER_ADMIN");
    await enregistrerSessionVoix(sa.id, S, null);
    await enregistrerSessionVoix(autre.id, `live_${TAG}autre`, null);
  });
  afterEach(() => remplacerModelesPourTests(null));
  afterAll(async () => {
    if (cleAvant === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = cleAvant;
    remplacerLecteurInterrupteurIaPourTests(null);
    const ids = [sa?.id, samia?.id, autre?.id].filter(Boolean) as string[];
    await effacerJournalDe(ids);
    await prisma.task.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
        await prisma.assistantIaVoixTravail.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantIaVoixSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** La carte arrive avec le résultat du travail ; « non c'est tout » aux facultatifs mène au récit et à la question. */
  async function jusquALaQuestion(intentId: string): Promise<string> {
    const w = await prisma.assistantIaVoixTravail.findFirstOrThrow({ where: { userId: sa.id, session: S }, orderBy: { creeLe: "desc" } });
    const pret = await suivreTravailVocal(sa, S, w.id);
    expect(pret.etat).toBe("pret");
    let dit = (pret as Extract<SuiviOral, { etat: "pret" }>).pourVoix;
    expect((pret as Extract<SuiviOral, { etat: "pret" }>).carte?.intentId).toBe(intentId);
    if (/Ne demande PAS encore/.test(dit)) dit = (await traiterEnonceVocal(sa, { session: S, demande: "non c'est tout", parole: "non c'est tout" })).pourVoix;
    expect(dit).toContain("Tu confirmes ?");
    return dit;
  }

  it("la carte arrive avec le résultat, se conclut à l'oral : « ok fais-le » → exécutée par la garde du bouton ; « annule » la défait", async () => {
    const intentId = await carteTache({ title: `Stand ${TAG}` });
    const question = await jusquALaQuestion(intentId);
    expect(question).toContain(`Stand ${TAG}`);
    expect(question).not.toMatch(/écran/);

    // GARDE-FOU : une autre personne, ou une session qui n'est pas la sienne, ne confirme rien.
    expect((await traiterEnonceVocal(autre, { session: S, demande: "ok fais-le", parole: "ok fais-le" })).pourVoix).toContain("n'est plus reconnue");
    expect((await traiterEnonceVocal(sa, { session: `live_${TAG}inconnue`, demande: "ok fais-le", parole: "ok fais-le" })).pourVoix).toContain("n'est plus reconnue");
    // GARDE-FOU : rien de NEUF entendu (la transcription du oui n'est pas arrivée) → on redemande, rien n'est fait.
    expect((await traiterEnonceVocal(sa, { session: S, demande: "non c'est tout", parole: "" })).pourVoix).toContain("Je n'ai pas entendu sa réponse");
    // « oui mais attends » : la carte attend.
    expect((await traiterEnonceVocal(sa, { session: S, demande: "oui mais attends", parole: "oui mais attends" })).pourVoix).toContain("la carte attend");
    expect(await prisma.task.count({ where: { title: { contains: TAG } } })).toBe(0);

    // « ok fais-le » : exécutée — aucun mot imposé.
    const fait = await traiterEnonceVocal(sa, { session: S, demande: "ok fais-le", parole: "ok fais-le" });
    expect(fait.etatCarte, fait.pourVoix).toEqual({ intentId, status: "EXECUTED" });
    expect(fait.pourVoix).toContain("C'est fait");
    expect(fait.pourVoix).toContain("annule");
    const t = await prisma.task.findFirstOrThrow({ where: { title: { contains: TAG } }, select: { id: true } });

    // « annule » : la dernière action de l'assistant est défaite (journal des effets J7).
    const annule = await traiterEnonceVocal(sa, { session: S, demande: "annule", parole: "annule" });
    expect(annule.pourVoix).toContain("est annulé");
    expect(await prisma.task.count({ where: { id: t.id } })).toBe(0);
    // « rétablis » : l'annulation s'annule (K10b) — la tâche revient, même identifiant.
    const retabli = await traiterEnonceVocal(sa, { session: S, demande: "rétablis", parole: "rétablis" });
    expect(retabli.pourVoix).toContain("rétabli");
    expect(await prisma.task.count({ where: { id: t.id } })).toBe(1);
  });

  it("une carte RENFORCÉE : la voix relit le montant, puis un simple « vas-y » suffit (la ressaisie est fournie par le serveur)", async () => {
    const intentId = await carteTache({ title: `Relance ${TAG}` });
    // La carte devient CRITIQUE (comme une capacité R3/R4) : l'élément clé est le titre.
    await prisma.assistantActionIntent.update({ where: { id: intentId }, data: { level: "CRITICAL", confirmText: `Relance ${TAG}` } });
    const question = await jusquALaQuestion(intentId);
    expect(question).toContain(`RELIS clairement « Relance ${TAG} »`);
    const r = await traiterEnonceVocal(sa, { session: S, demande: "vas-y", parole: "vas-y" });
    expect(r.etatCarte, r.pourVoix).toEqual({ intentId, status: "EXECUTED" });
    expect(await prisma.task.count({ where: { title: { contains: `Relance ${TAG}` } } })).toBe(1);
  });

  it("« non, laisse tomber » à la question : rien n'est fait", async () => {
    const intentId = await carteTache({ title: `Abandon ${TAG}` });
    await jusquALaQuestion(intentId);
    const non = await traiterEnonceVocal(sa, { session: S, demande: "non laisse tomber", parole: "non, laisse tomber" });
    expect(non.pourVoix).toContain("rien n'est envoyé");
    expect(non.etatCarte).toBeUndefined();
    expect(await prisma.task.count({ where: { title: { contains: `Abandon ${TAG}` } } })).toBe(0);
  });

  it("l'attente vivante : la précision dite pendant le travail est TRANSMISE ; seul le résultat à jour est dit", async () => {
    const fil = await filDe(sa.id);
    // Le classifieur rapide (O1) : ces précisions sont MAJEURES (elles changent le périmètre, la période).
    const classifieur = (prompt: string) => (prompt.includes("Tu classes UN énoncé") ? { texte: '{"nature":"precision","impact":"majeur","forme":null,"consigne":"' + (prompt.includes("Oran") ? "Seulement Oran." : "Pour le troisième trimestre.") + '"}' } : null);
    remplacerModelesPourTests([modeleFactice([(prompt) => classifieur(prompt) ?? reponse("(sans objet)")]).modele as never]);
    // Le fil est tenu (un autre passage joue) : la demande attend.
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: new Date() } });
    const lance = await traiterEnonceVocal(sa, { session: S, demande: "le chiffre d'affaires des ventes", delegationId: "d1" });
    expect(lance.travail).toBeTruthy();
    // 1) Pas encore commencé : la précision s'AJOUTE au message (un seul tour).
    const p1 = await traiterEnonceVocal(sa, { session: S, demande: "pour le troisième trimestre", delegationId: "d2", enCours: lance.travail });
    expect(p1.travail).toBe(lance.travail);
    const w1 = await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: lance.travail! } });
    const t1 = await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: w1.tourId } });
    expect(t1.contenu).toContain("Pour le troisième trimestre");
    expect(w1.delegationId).toBe("d2");
    // 2) En cours : la précision MAJEURE est gardée (O1 : pas une relance par réponse) — le travail en tient compte.
    await prisma.assistantIaTour.update({ where: { id: w1.tourId }, data: { etat: ETAT.COURS } });
    const p2 = await traiterEnonceVocal(sa, { session: S, demande: "seulement Oran", delegationId: "d3", enCours: lance.travail });
    expect(p2.pourVoix).toContain("le travail en tient compte");
    expect(p2.change).toEqual({ travail: lance.travail });
    expect(await suivreTravailVocal(sa, S, lance.travail)).toMatchObject({ etat: "en_cours" });
    // Le premier tour aboutit : son résultat, dépassé, n'est PAS dit — la relance ciblée part, avec lui en historique.
    await prisma.assistantIaTour.update({ where: { id: w1.tourId }, data: { etat: ETAT.TRAITE } });
    await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "assistant", contenu: "Le CA du T3 est de 12 millions, dont Oran 3,1 millions.", etat: ETAT.TERMINE, repondA: w1.tourId } });
    const remplace = await suivreTravailVocal(sa, S, lance.travail);
    expect(remplace).toMatchObject({ etat: "remplace" });
    const relance = (remplace as Extract<SuiviOral, { etat: "remplace" }>).par;
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { traitementLe: null } });
    let vuHistorique = false;
    let vuConsigne = false;
    let vuPrecision = false;
    remplacerModelesPourTests([modeleFactice([(prompt) => {
      // Le faux modèle sert aussi le titre de la conversation : on cumule ce que le tour principal a reçu.
      vuHistorique ||= prompt.includes("dont Oran 3,1 millions");
      vuConsigne ||= prompt.includes("RÉPONSE POUR L'OREILLE");
      vuPrecision ||= prompt.includes("Seulement Oran.");
      return reponse("À Oran, le chiffre d'affaires du troisième trimestre est d'environ 3,1 millions de dinars. Je te détaille par produit ?");
    }]).modele as never]);
    await traiterFil(sa.id, fil.id);
    const fin = await suivreJusquAuBout(sa, S, relance);
    expect(fin).toMatchObject({ etat: "pret", pourVoix: expect.stringContaining("À Oran") });
    expect(vuHistorique).toBe(true);
    expect(vuConsigne).toBe(true);
    expect(vuPrecision).toBe(true);
  });

  it("au-delà de la session : le résultat est dit à l'ouverture suivante (une fois)", async () => {
    remplacerModelesPourTests([modeleFactice([reponse("Ton rendez-vous de jeudi est confirmé.")]).modele as never]);
    const S2 = `live_${TAG}sa2`;
    await enregistrerSessionVoix(sa.id, S2, null);
    const r = await traiterEnonceVocal(sa, { session: S2, demande: "est-ce que jeudi est confirmé ?" });
    await fermerSessionVoix(sa.id, S2);
    // Le travail se termine après la fin de la session : plus personne ne le suit.
    const w = await prisma.assistantIaVoixTravail.findUniqueOrThrow({ where: { id: r.travail! } });
    for (let i = 0; i < 200; i++) {
      const rep = await prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant", etat: ETAT.TERMINE } });
      if (rep) break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(await suivreTravailVocal(sa, S2, r.travail)).toEqual({ etat: "inconnu" });
    const S3 = `live_${TAG}sa3`;
    await enregistrerSessionVoix(sa.id, S3, null);
    const dits = await reprisesOrales(sa, S3);
    expect(dits.some((d) => d.includes("Ton rendez-vous de jeudi est confirmé."))).toBe(true);
    expect(await reprisesOrales(sa, S3)).toEqual([]);
  });

  it("une pièce reçue par WhatsApp EN PLEIN APPEL (K6) est annoncée d'elle-même, une seule fois ; une pièce refusée, jamais", async () => {
    const S4 = `live_${TAG}sa4`;
    await enregistrerSessionVoix(sa.id, S4, null);
    expect(await annoncesEnAppel(sa, S4)).toEqual([]);
    const fil = await filDe(sa.id);
    const q = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "user", contenu: "[Reçu par WhatsApp] lettre", etat: ETAT.TRAITE } });
    const rep = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId: sa.id, role: "assistant", contenu: "J'ai reçu la lettre du Dr Mansouri par WhatsApp. Où dois-je la ranger ?", etat: ETAT.TERMINE, repondA: q.id } });
    await prisma.assistantIaReception.create({ data: { canal: "WHATSAPP", idExterne: `${TAG}wamid1`, userId: sa.id, expediteur: "+213•••", issue: "RECUE", nom: "lettre-mansouri.pdf", tourId: rep.id } });
    await prisma.assistantIaReception.create({ data: { canal: "WHATSAPP", idExterne: `${TAG}wamid2`, userId: sa.id, expediteur: "+213•••", issue: "REFUS_FORMAT", nom: "virus.exe" } });
    const dites = await annoncesEnAppel(sa, S4);
    expect(dites).toHaveLength(1);
    expect(dites[0]).toContain("WhatsApp");
    expect(dites[0]).toContain("lettre-mansouri.pdf");
    expect(dites[0]).toContain("Où dois-je la ranger");
    expect(dites[0]).not.toContain("virus");
    expect(await annoncesEnAppel(sa, S4)).toEqual([]);
    // Hors de SA session : rien.
    expect(await annoncesEnAppel(autre, S4)).toEqual([]);
    await prisma.assistantIaReception.deleteMany({ where: { idExterne: { startsWith: TAG } } });
  });

  it("les commandes : stop et plus court reviennent au navigateur ; une mission absente se dit", async () => {
    expect(await traiterEnonceVocal(sa, { session: S, demande: "stop" })).toMatchObject({ commande: "stop" });
    expect(await traiterEnonceVocal(sa, { session: S, demande: "plus court" })).toMatchObject({ commande: "plus_court" });
    expect((await traiterEnonceVocal(sa, { session: S, demande: "reprends la mission" })).pourVoix).toContain("Aucune mission à reprendre");
  });
});
