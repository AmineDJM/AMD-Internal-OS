import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { cancelActionIntent } from "@/platform/ia/intentions/action-intents";
import { annulerGeste, gestesDeLAssistant } from "@/platform/ia/hors-requete";
import { MASQUE_CONFIDENTIEL, retirerBornes, sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { DIT_A_L_ECRAN, NON_OUVERTE, pourLaVoix } from "../../domaine/terrain/voix";
import {
  champSuivant, designesParNom, empreinteIntention, estAffirmatif, facultatifsUtiles, lireCommandeOrale, PREFIXE_PRECISION, PREFIXE_VOCAL,
  questionDuChamp, resumeOralBlocs, resumeOralCarte, valeurDite, type ChampOral,
} from "../../domaine/terrain/oral";
import { lireReglagesAssistantIa } from "../consommation";
import { chercherReferenceDeCarte, corrigerCarteCapacite } from "../capacites";
import { accesAssistantIa } from "../role-config";
import { confirmerIntentionDe } from "../confirmation-carte";
import { annulerMissionEtSousMissions } from "../sous-missions";
import { listerTravaux, pauserTravail, PERSONA_ASSISTANT_IA, reprendreMonTravail } from "../travaux";
import { deposerMessage, ETAT, traiterFil } from "../fil/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE — le SERVEUR de la conversation vocale (lot K9, décision 0038).
 *
 * Direction : « je marche avec mes écouteurs, je ne vois pas mon écran — l'oral peut tout faire ». Trois choses :
 *
 *   1. LA DÉLÉGATION NE BLOQUE PLUS LA VOIX. Une demande dite est déposée dans le fil et rend AUSSITÔT un « travail » ;
 *      la voix dit « je regarde », engage la personne pour affiner, et le navigateur SUIT le travail (`suivreTravailVocal`)
 *      jusqu'au résultat, que la voix dit d'elle-même (session.commentary.append). Ce que la personne précise pendant ce
 *      temps est TRANSMIS (`preciser`) : ajouté au message s'il n'a pas commencé, sinon relance ciblée qui repart du
 *      résultat en cours — jamais de zéro. Session fermée avant la fin : la notification part (la voix ne « consulte »
 *      plus le fil) et le résultat est dit à la prochaine ouverture (`reprisesOrales`).
 *   2. UNE CARTE SE CONCLUT À L'ORAL. Résumée en une phrase par le serveur, ses champs obligatoires demandés un par un
 *      (formulaire J11), puis un « vas-y » exécute — par la MÊME porte que le bouton (`confirmerIntentionDe`), sous des
 *      garde-fous SERVEUR : la carte est à la personne ET à cette session vocale ; son résumé a été DIT (accusé du
 *      fournisseur) ; l'énoncé transcrit est jugé affirmatif (règle, pas le modèle) ; l'intention n'a pas changé depuis
 *      le résumé (empreinte). La ressaisie R3/R4 de l'écran devient la RELECTURE de la valeur par la voix.
 *   3. TOUT PAR LA VOIX : annuler la dernière action (J7), mettre en pause / reprendre / arrêter une mission (K3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, une session vocale n'est plus tenue pour ouverte (le fournisseur la ferme bien avant). */
const SESSION_VALIDE_MS = 2 * 60 * 60_000;
/** Ce qui n'a pas été dit à la voix se reprend à l'ouverture suivante — pendant un jour. */
const REPRISE_MS = 24 * 60 * 60_000;
/** « Annule » vise la dernière action de l'assistant — faite il y a moins d'une demi-heure. */
const ANNULATION_MS = 30 * 60_000;

export interface RetourOral {
  /** Ce que la voix dit (elle paraphrase) — jamais une valeur que la personne n'a pas le droit d'entendre. */
  pourVoix: string;
  /** Un travail lancé : le navigateur le suit et la voix annoncera son résultat. */
  travail?: string;
  /** La carte résumée : le navigateur signale quand ce résumé a été DIT (accusé du fournisseur). */
  resumeDe?: { intentId: string; empreinte: string };
  carte?: Record<string, unknown> & { intentId: string };
  /** Une carte a changé d'état à l'oral (l'écran la met à jour). */
  etatCarte?: { intentId: string; status: "EXECUTED" | "CANCELLED" };
  /** Une commande que le navigateur applique lui-même (« stop » : couper la parole ; « plus court »). */
  commande?: "stop" | "plus_court";
  ecran?: string | null;
}

export type SuiviOral =
  | { etat: "en_cours"; etapes: string[] }
  | ({ etat: "pret" } & RetourOral)
  | { etat: "echec"; pourVoix: string }
  | { etat: "remplace"; par: string }
  | { etat: "inconnu" };

const NETTOYER_MD = (t: string) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#>|]+/g, " ").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();

/**
 * Ce que la voix peut dire d'une réponse écrite : sans Markdown, borné. Masquées (décision 0012) : sans valeur sensible.
 * EN CLAIR (décision 0034) : avec celles que l'assistant a rendues à la personne — elle avait le droit de les voir.
 */
export function reponsePourVoix(contenu: string, enClair = false): string {
  if (enClair) return pourLaVoix(NETTOYER_MD(retirerBornes(contenu)).split(MASQUE_CONFIDENTIEL).join(NON_OUVERTE), 1_600);
  return pourLaVoix(NETTOYER_MD(sansValeursRevelees(contenu)).split(MASQUE_CONFIDENTIEL).join(DIT_A_L_ECRAN), 1_600);
}

// ─── LES SESSIONS ──────────────────────────────────────────────────────────────────────────

export async function enregistrerSessionVoix(userId: string, id: string, conversation: string | null): Promise<void> {
  await prisma.assistantIaVoixSession.upsert({ where: { id }, create: { id, userId, conversation }, update: {} });
}

/** La session vocale, si elle est à CETTE personne et encore ouverte — sinon `null` (aucun geste oral n'y vaut). */
async function sessionDe(userId: string, id: unknown) {
  if (typeof id !== "string" || !id || id.length > 120) return null;
  return prisma.assistantIaVoixSession.findFirst({ where: { id, userId, fermeeLe: null, ouverteLe: { gte: new Date(Date.now() - SESSION_VALIDE_MS) } } });
}

export async function fermerSessionVoix(userId: string, id: unknown): Promise<void> {
  if (typeof id !== "string" || !id) return;
  await prisma.assistantIaVoixSession.updateMany({ where: { id, userId, fermeeLe: null }, data: { fermeeLe: new Date() } });
}

const HORS_SESSION: RetourOral = { pourVoix: "La session vocale n'est plus reconnue par le serveur : dis-le et propose de raccrocher puis de rappeler." };

// ─── LE TRAVAIL DÉLÉGUÉ, ASYNCHRONE ────────────────────────────────────────────────────────

const LANCE = "Le travail est lancé, il n'y a pas encore de résultat. Dis en quelques mots que tu regardes et que tu préviens dès que c'est prêt, puis pose UNE question courte pour affiner (la période, le but, le périmètre). N'invente aucun résultat.";

async function lancerTravail(user: CurrentUser, session: { id: string; conversation: string | null }, demande: string, delegationId: string | null): Promise<RetourOral> {
  const d = await deposerMessage(user.id, `${PREFIXE_VOCAL} ${demande}`.slice(0, 8_000), [], null, session.conversation);
  if (!d.ok) return { pourVoix: d.erreur };
  void traiterFil(user.id, d.conversation);
  const w = await prisma.assistantIaVoixTravail.create({ data: { userId: user.id, session: session.id, delegationId, conversation: d.conversation, tourId: d.tour.id } });
  return { travail: w.id, pourVoix: LANCE };
}

/**
 * UNE PRÉCISION PENDANT QUE L'ASSISTANT TRAVAILLE — transmise, jamais un nouveau départ :
 *   • le message n'a pas encore été pris : la précision S'AJOUTE au message lui-même (un seul tour, rien de perdu) ;
 *   • il est en cours : RELANCE CIBLÉE — un message de précision, joué juste après dans le même fil, qui voit la
 *     réponse en cours dans son historique et en repart ; le premier résultat, dépassé, n'est pas dit.
 * (Injecter la précision DANS la boucle d'outils en cours n'est pas offert par le moteur d'agent ; la relance ciblée
 * garde ce qui a été trouvé, et la voix n'annonce que la réponse à jour.)
 */
async function preciser(user: CurrentUser, w: { id: string; tourId: string; conversation: string; session: string }, texte: string, delegationId: string | null): Promise<RetourOral> {
  const tour = await prisma.assistantIaTour.findUnique({ where: { id: w.tourId }, select: { contenu: true, etat: true } });
  if (tour?.etat === ETAT.ATTENTE) {
    const n = await prisma.assistantIaTour.updateMany({ where: { id: w.tourId, etat: ETAT.ATTENTE }, data: { contenu: `${tour.contenu}\n${PREFIXE_PRECISION} ${texte}`.slice(0, 8_000) } });
    if (n.count === 1) {
      await prisma.assistantIaVoixTravail.update({ where: { id: w.id }, data: { delegationId } });
      return { travail: w.id, pourVoix: "La précision est ajoutée à la demande, qui n'avait pas encore commencé. Dis-le en trois mots, sans résultat inventé." };
    }
  }
  const avant = (tour?.contenu ?? "").replace(PREFIXE_VOCAL, "").trim().slice(0, 300);
  const message = `${PREFIXE_PRECISION} ${texte}\n(La personne précise sa demande précédente « ${avant} », dont la réponse est en cours ou vient d'arriver : pars de ce que tu as déjà trouvé, ne refais pas les recherches déjà faites, et réponds à la demande ainsi précisée. Si c'est en fait une autre demande, traite-la.)`;
  const d = await deposerMessage(user.id, message.slice(0, 8_000), [], null, w.conversation);
  if (!d.ok) return { pourVoix: d.erreur };
  void traiterFil(user.id, d.conversation);
  const nouveau = await prisma.assistantIaVoixTravail.create({ data: { userId: user.id, session: w.session, delegationId, conversation: d.conversation, tourId: d.tour.id } });
  await prisma.assistantIaVoixTravail.update({ where: { id: w.id }, data: { remplacePar: nouveau.id } });
  return { travail: nouveau.id, pourVoix: "La précision est transmise au travail en cours, qui en tient compte sans recommencer. Dis-le en quelques mots ; le résultat arrivera tout seul." };
}

/** Ce que la voix dit d'une réponse prête : le texte (rédigé pour l'oreille), les blocs en une phrase, la carte résumée. */
async function pourVoixDuTour(user: CurrentUser, session: string, rep: { contenu: string; blocs: Prisma.JsonValue; intent: Prisma.JsonValue }): Promise<RetourOral> {
  const enClair = (await lireReglagesAssistantIa()).valeursSensibles === "EN_CLAIR";
  const texte = reponsePourVoix(rep.contenu, enClair);
  const blocs = resumeOralBlocs(Array.isArray(rep.blocs) ? (rep.blocs as { kind: string }[]) : []);
  const intent = rep.intent as (Record<string, unknown> & { id?: string }) | null;
  if (!intent?.id) return { pourVoix: [texte, blocs].filter(Boolean).join(" "), ecran: rep.contenu };
  const c = await presenterCarte(user, session, intent.id);
  return { ...c, pourVoix: [texte, blocs, c.pourVoix].filter(Boolean).join(" ").slice(0, 1_800), carte: { ...intent, intentId: intent.id }, ecran: rep.contenu };
}

/** SUIVRE un travail délégué. Tant que la voix le suit, la personne est « là » : pas de notification en double. */
export async function suivreTravailVocal(user: CurrentUser, sessionId: unknown, travailId: unknown): Promise<SuiviOral> {
  if (typeof travailId !== "string" || !travailId) return { etat: "inconnu" };
  const session = await sessionDe(user.id, sessionId);
  const w = await prisma.assistantIaVoixTravail.findFirst({ where: { id: travailId, userId: user.id } });
  if (!w || !session || w.session !== session.id) return { etat: "inconnu" };
  if (w.remplacePar) return { etat: "remplace", par: w.remplacePar };
  await prisma.assistantIaFil.updateMany({ where: { id: w.conversation, userId: user.id }, data: { consulteLe: new Date() } });
  const [rep, q] = await Promise.all([
    prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant" }, orderBy: { createdAt: "desc" }, select: { contenu: true, intent: true, blocs: true, etat: true, etapes: true, erreur: true } }),
    prisma.assistantIaTour.findUnique({ where: { id: w.tourId }, select: { etat: true } }),
  ]);
  if (rep?.etat === ETAT.TERMINE) {
    await prisma.assistantIaVoixTravail.updateMany({ where: { id: w.id, annonceLe: null }, data: { annonceLe: new Date() } });
    return { etat: "pret", ...(await pourVoixDuTour(user, session.id, rep)) };
  }
  if (rep?.etat === ETAT.ECHEC || q?.etat === ETAT.ECHEC) {
    await prisma.assistantIaVoixTravail.updateMany({ where: { id: w.id, annonceLe: null }, data: { annonceLe: new Date() } });
    return { etat: "echec", pourVoix: `L'assistant n'a pas pu répondre : ${(rep?.contenu || rep?.erreur || "erreur").slice(0, 200)}. Dis-le simplement et propose de réessayer.` };
  }
  return { etat: "en_cours", etapes: Array.isArray(rep?.etapes) ? (rep!.etapes as string[]).slice(-3) : [] };
}

/**
 * LA REPRISE ORALE : les résultats arrivés après la fin d'une session vocale (ou jamais dits) sont dits à l'ouverture
 * suivante — une phrase chacun, au plus trois — puis marqués annoncés. Les cartes reviennent résumées dans CETTE session.
 */
export async function reprisesOrales(user: CurrentUser, sessionId: string): Promise<string[]> {
  const travaux = await prisma.assistantIaVoixTravail.findMany({
    where: { userId: user.id, annonceLe: null, remplacePar: null, creeLe: { gte: new Date(Date.now() - REPRISE_MS) } },
    orderBy: { creeLe: "asc" }, take: 6,
  });
  const dits: string[] = [];
  for (const w of travaux) {
    const rep = await prisma.assistantIaTour.findFirst({ where: { repondA: w.tourId, role: "assistant", etat: ETAT.TERMINE }, orderBy: { createdAt: "desc" }, select: { contenu: true, intent: true, blocs: true } });
    if (!rep) continue;
    const n = await prisma.assistantIaVoixTravail.updateMany({ where: { id: w.id, annonceLe: null }, data: { annonceLe: new Date(), session: sessionId } });
    if (n.count !== 1 || dits.length >= 3) continue;
    dits.push((await pourVoixDuTour(user, sessionId, rep)).pourVoix);
  }
  return dits;
}

// ─── LES CARTES, À L'ORAL ──────────────────────────────────────────────────────────────────

interface FormulaireOral { champs: ChampOral[]; etiquettes: Record<string, string> }

const entreeDe = (payload: Prisma.JsonValue): Record<string, unknown> => ((payload as { entree?: Record<string, unknown> } | null)?.entree ?? {});
const empreinteDe = (i: { payload: Prisma.JsonValue; title: string; confirmText: string | null; status: string }) => empreinteIntention([i.payload, i.title, i.confirmText, i.status]);

/** La carte telle que le tour l'a proposée : ses lignes, et ses champs (formulaire J11) en ce que la voix doit savoir. */
async function carteDuTour(userId: string, intentId: string): Promise<{ formulaire: FormulaireOral | null; fields: { label: string; value: string }[] }> {
  const t = await prisma.assistantIaTour.findFirst({ where: { userId, intent: { path: ["id"], equals: intentId } }, select: { intent: true } });
  const i = t?.intent as { fields?: { label: string; value: string }[]; formulaire?: { champs?: (ChampOral & { etiquettes?: Record<string, string> })[] } } | null;
  const champs = i?.formulaire?.champs ?? [];
  return {
    fields: Array.isArray(i?.fields) ? i!.fields! : [],
    formulaire: champs.length ? {
      champs: champs.map((c) => ({ nom: c.nom, libelle: c.libelle, widget: c.widget, obligatoire: c.obligatoire, valeurs: c.valeurs ?? null })),
      etiquettes: Object.assign({}, ...champs.map((c) => c.etiquettes ?? {})),
    } : null,
  };
}

/**
 * RÉSUMER UNE CARTE pour la voix, et l'inscrire à CETTE session : l'empreinte du moment, le champ à demander. Le résumé
 * doit être DIT (accusé) avant qu'un « vas-y » ne vaille.
 */
async function presenterCarte(user: CurrentUser, session: string, intentId: string, avant = ""): Promise<RetourOral> {
  const i = await prisma.assistantActionIntent.findFirst({ where: { id: intentId, userId: user.id }, select: { status: true, payload: true, title: true, confirmText: true } });
  if (!i || i.status !== "PROPOSED") return { pourVoix: "" };
  const deja = await prisma.assistantIaVoixCarte.findUnique({ where: { intentId } });
  const tour = await carteDuTour(user.id, intentId);
  const f = (deja?.formulaire as FormulaireOral | null) ?? tour.formulaire;
  const entree = entreeDe(i.payload);
  const champs = f?.champs ?? [];
  const valeurLue = (c: ChampOral) => { const v = entree[c.nom]; const l = Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]; return l.map((x) => f?.etiquettes[x] ?? x).join(", "); };
  // Les valeurs À JOUR (une valeur dite a pu corriger la carte) ; sans formulaire, les lignes de la carte proposée.
  const fields = champs.length ? champs.filter((c) => valeurLue(c)).map((c) => ({ label: c.libelle, value: valeurLue(c) })) : tour.fields;
  const resume = resumeOralCarte({ title: i.title, fields, confirmText: i.confirmText });
  const manque = champSuivant(champs, entree);
  const facultatifs = manque ? [] : facultatifsUtiles(champs, entree);
  const empreinte = empreinteDe(i);
  const donnees = { userId: user.id, session, empreinte, resume, resumeLe: new Date(), resumeDitLe: null, champ: manque?.nom ?? null, formulaire: (f ?? undefined) as unknown as Prisma.InputJsonValue, etat: "A_DIRE" };
  await prisma.assistantIaVoixCarte.upsert({ where: { intentId }, create: { intentId, ...donnees }, update: donnees });
  const suite = manque
    ? `${questionDuChamp(manque)} Demande-le, une seule question.`
    : `${facultatifs.length ? `Tu peux proposer, sans insister : ${facultatifs.map((c) => c.libelle.toLowerCase()).join(" ou ")}. ` : ""}Puis demande si c'est bon pour lancer.`;
  return { pourVoix: `${avant}Carte préparée : ${resume} ${suite} Rien n'est fait tant que la personne n'a pas dit oui.`.trim(), resumeDe: { intentId, empreinte } };
}

/** Le navigateur signale que le résumé a été DIT (accusé `session.commentary.appended`) — sous la même empreinte. */
export async function resumeCarteDit(user: CurrentUser, sessionId: unknown, intentId: unknown, empreinte: unknown): Promise<boolean> {
  const s = await sessionDe(user.id, sessionId);
  if (!s || typeof intentId !== "string" || typeof empreinte !== "string") return false;
  const n = await prisma.assistantIaVoixCarte.updateMany({ where: { intentId, userId: user.id, session: s.id, empreinte, etat: "A_DIRE" }, data: { resumeDitLe: new Date(), etat: "DIT" } });
  return n.count === 1;
}

async function carteEnAttente(userId: string, session: string) {
  const c = await prisma.assistantIaVoixCarte.findFirst({ where: { userId, session, etat: { in: ["A_DIRE", "DIT"] } }, orderBy: { resumeLe: "desc" } });
  if (!c) return null;
  const i = await prisma.assistantActionIntent.findFirst({ where: { id: c.intentId, userId }, select: { status: true } });
  return i?.status === "PROPOSED" ? c : null;
}
type CarteVocale = NonNullable<Awaited<ReturnType<typeof carteEnAttente>>>;

/**
 * LE « VAS-Y » ORAL — les garde-fous sont ICI, pas dans le modèle : carte de la personne et de cette session, résumé
 * dit, énoncé affirmatif, aucun champ manquant, intention inchangée. Puis la MÊME porte que le bouton ; la valeur à
 * ressaisir (R3/R4) a été relue par la voix dans le résumé.
 */
export async function confirmerAOral(user: CurrentUser, session: string, carte: CarteVocale, enonce: string): Promise<RetourOral> {
  if (carte.userId !== user.id || carte.session !== session) return { pourVoix: "Cette carte n'appartient pas à cette conversation vocale : rien n'est fait." };
  if (!estAffirmatif(enonce)) return { pourVoix: "Je n'ai pas entendu un accord net : rien n'est fait. Redemande si c'est bon pour lancer." };
  if (!carte.resumeDitLe || carte.etat !== "DIT") return { pourVoix: `Rien n'est fait : le résumé n'a pas encore été dit. Redis-le : ${carte.resume} Puis attends son accord.` };
  if (carte.champ) {
    const c = (carte.formulaire as FormulaireOral | null)?.champs.find((x) => x.nom === carte.champ);
    return { pourVoix: `Rien n'est fait : ${c ? questionDuChamp(c) : "il manque un champ."} Demande-le.` };
  }
  const i = await prisma.assistantActionIntent.findFirst({ where: { id: carte.intentId, userId: user.id }, select: { status: true, payload: true, title: true, confirmText: true } });
  if (!i || i.status !== "PROPOSED") return { pourVoix: "Cette carte n'est plus à confirmer : rien n'est fait." };
  if (empreinteDe(i) !== carte.empreinte) return presenterCarte(user, session, carte.intentId, "La carte a changé depuis son résumé : rien n'est fait. Relis-la. ");
  const r = await confirmerIntentionDe(user, carte.intentId, i.confirmText ?? undefined);
  await prisma.assistantIaVoixCarte.update({ where: { intentId: carte.intentId }, data: { etat: r.ok ? "EXECUTEE" : "ECHEC" } });
  console.info("[assistant-ia] carte confirmée à l'oral", { userId: user.id, intentId: carte.intentId, ok: r.ok, enonce: enonce.slice(0, 80) });
  if (!r.ok) return { pourVoix: `Ça n'a pas pu se faire : ${(r.error ?? "erreur").slice(0, 240)}` };
  return {
    pourVoix: `C'est fait${r.message ? ` : ${r.message.slice(0, 200)}` : ""}. Dis-le en une phrase, et qu'elle peut dire « annule » si elle change d'avis.`,
    etatCarte: { intentId: carte.intentId, status: "EXECUTED" },
  };
}

async function refuserAOral(user: CurrentUser, carte: CarteVocale): Promise<RetourOral> {
  const ok = await cancelActionIntent(user.id, carte.intentId);
  await prisma.assistantIaVoixCarte.update({ where: { intentId: carte.intentId }, data: { etat: "REFUSEE" } });
  return ok
    ? { pourVoix: "D'accord, la carte est abandonnée : rien n'a été fait. Dis-le en trois mots.", etatCarte: { intentId: carte.intentId, status: "CANCELLED" } }
    : { pourVoix: "Cette carte n'était plus à confirmer." };
}

/** UNE VALEUR DITE pour le champ demandé : lue, résolue par nom sous les droits de la personne, puis la carte corrigée. */
async function remplirChamp(user: CurrentUser, session: string, carte: CarteVocale, texte: string): Promise<RetourOral> {
  const f = carte.formulaire as FormulaireOral | null;
  const champ = f?.champs.find((c) => c.nom === carte.champ);
  if (!f || !champ) return presenterCarte(user, session, carte.intentId);
  const lu = valeurDite(champ, texte);
  if ("ok" in lu && !lu.ok) return { pourVoix: `${lu.raison} Redemande ${champ.libelle.toLowerCase()}.` };
  let valeur: unknown = "ok" in lu ? lu.valeur : null;
  const etiquettes = { ...f.etiquettes };
  if ("reference" in lu) {
    const r = await chercherReferenceDeCarte(user, carte.intentId, champ.nom, lu.reference);
    if (!r.ok) return { pourVoix: `${r.error} Redemande ${champ.libelle.toLowerCase()}.` };
    if (!r.options.length) return { pourVoix: `Je ne trouve personne ni aucune fiche « ${lu.reference} » parmi ce que la personne voit. Redemande ${champ.libelle.toLowerCase()}.` };
    if (r.options.length > 1) return { pourVoix: `Il y en a plusieurs : ${r.options.slice(0, 3).map((o) => o.titre).join(", ")}${r.options.length > 3 ? ", et d'autres" : ""}. Demande lequel.` };
    valeur = champ.widget === "references" ? [r.options[0].id] : r.options[0].id;
    etiquettes[r.options[0].id] = r.options[0].titre;
  }
  const i = await prisma.assistantActionIntent.findFirst({ where: { id: carte.intentId, userId: user.id }, select: { payload: true } });
  const c = await corrigerCarteCapacite(user, carte.intentId, { ...entreeDe(i?.payload ?? null), [champ.nom]: valeur }, await accesAssistantIa(user));
  if (!c.ok) return { pourVoix: `${c.error.replace(/ Rien n'a été exécuté\.?/, "")} Redemande ${champ.libelle.toLowerCase()}.` };
  await prisma.assistantIaVoixCarte.update({ where: { intentId: carte.intentId }, data: { formulaire: { ...f, etiquettes } as unknown as Prisma.InputJsonValue } });
  return presenterCarte(user, session, carte.intentId, "C'est noté. ");
}

// ─── LES COMMANDES ORALES ──────────────────────────────────────────────────────────────────

async function annulerDerniere(user: CurrentUser): Promise<RetourOral> {
  const g = (await gestesDeLAssistant(user, { limite: 5 })).find((x) => !x.annuleLe && Date.now() - new Date(x.quand).getTime() < ANNULATION_MS);
  if (!g) return { pourVoix: "Il n'y a pas d'action récente de l'assistant à annuler." };
  const r = await annulerGeste(g.id, user);
  if ("refus" in r) return { pourVoix: r.refus };
  return { pourVoix: `Annulation de « ${g.libelle} » : ${r.resume}. Dis-le en une phrase${r.complet ? "" : ", en précisant ce qui n'a pas pu être défait"}.` };
}

async function commandeMission(user: CurrentUser, nature: "pause_mission" | "reprendre_mission" | "arreter_mission", texte: string): Promise<RetourOral> {
  const vivants = nature === "reprendre_mission" ? ["EN_PAUSE", "BLOQUE", "BUDGET_HOLD"] : nature === "pause_mission" ? ["EN_COURS", "EN_ATTENTE"] : ["EN_COURS", "EN_ATTENTE", "EN_PAUSE", "A_APPROUVER", "BLOQUE", "BUDGET_HOLD"];
  const candidats = (await listerTravaux(user.id, 15)).filter((t) => vivants.includes(t.etat));
  const quoi = nature === "reprendre_mission" ? "à reprendre" : nature === "pause_mission" ? "en cours" : "à arrêter";
  if (!candidats.length) return { pourVoix: `Aucune mission ${quoi}.` };
  const vises = designesParNom(candidats, texte);
  if (vises.length > 1) return { pourVoix: `Il y a ${vises.length} missions ${quoi} : ${vises.slice(0, 3).map((t) => t.titre).join(", ")}. Demande laquelle.` };
  const t = vises[0];
  const r = nature === "pause_mission" ? await pauserTravail(t.id, user.id)
    : nature === "reprendre_mission" ? await reprendreMonTravail(t.id, user.id, PERSONA_ASSISTANT_IA)
      : await annulerMissionEtSousMissions(t.id, user.id);
  if (!r.ok) return { pourVoix: r.erreur };
  return { pourVoix: `${nature === "pause_mission" ? "Mise en pause" : nature === "reprendre_mission" ? "Reprise" : "Arrêtée"} : la mission « ${t.titre} ». Dis-le en une phrase.` };
}

// ─── L'AIGUILLAGE D'UN ÉNONCÉ ──────────────────────────────────────────────────────────────

/**
 * CE QUE LA PERSONNE A DIT (transcription d'entrée de la session, depuis la délégation précédente) — jugé par le
 * serveur : réponse à une carte, commande, valeur d'un champ, précision du travail en cours, ou nouvelle demande.
 */
export async function traiterEnonceVocal(user: CurrentUser, d: { session: unknown; demande: string; delegationId?: string | null; enCours?: string | null }): Promise<RetourOral> {
  const s = await sessionDe(user.id, d.session);
  if (!s) return HORS_SESSION;
  const texte = d.demande.trim();
  const delegationId = typeof d.delegationId === "string" ? d.delegationId.slice(0, 120) : null;
  const carte = await carteEnAttente(user.id, s.id);
  const commande = lireCommandeOrale(texte, { carteEnAttente: !!carte });
  if (commande === "confirmer" && carte) return confirmerAOral(user, s.id, carte, texte);
  if (commande === "refuser" && carte) return refuserAOral(user, carte);
  if (commande === "attendre" && carte) return { pourVoix: "Rien n'est fait : la carte attend. Dis en trois mots que tu attends son feu vert." };
  if (commande === "annuler_derniere") return annulerDerniere(user);
  if (commande === "pause_mission" || commande === "reprendre_mission" || commande === "arreter_mission") return commandeMission(user, commande, texte);
  if (commande === "stop") return { pourVoix: "La personne a dit stop : tais-toi et attends qu'elle reparle.", commande };
  if (commande === "plus_court") return { pourVoix: "La personne veut plus court : désormais, une phrase par réponse.", commande };
  // Un champ est demandé : ce qui est dit (court) en est la valeur.
  if (carte?.champ && texte.split(/\s+/).length <= 12) return remplirChamp(user, s.id, carte, texte);
  if (typeof d.enCours === "string" && d.enCours) {
    const w = await prisma.assistantIaVoixTravail.findFirst({ where: { id: d.enCours, userId: user.id, session: s.id, remplacePar: null, annonceLe: null } });
    if (w) return preciser(user, w, texte, delegationId);
  }
  return lancerTravail(user, s, texte, delegationId);
}
