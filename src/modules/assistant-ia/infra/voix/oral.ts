import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { annulerEffetSortant, annulerGeste, effetsSortantsDe, gestesDeLAssistant, retablirGeste } from "@/platform/ia/hors-requete";
import { MASQUE_CONFIDENTIEL, retirerBornes, sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { DIT_A_L_ECRAN, NON_OUVERTE, pourLaVoix } from "../../domaine/terrain/voix";
import { lireCommandeOrale, phraseAnnulation, PREFIXE_VOCAL, resumeOralBlocs } from "../../domaine/terrain/oral";
import { piloterMission } from "../missions/pilotage";
import { lireReglagesAssistantIa } from "../consommation";
import { carteOraleEnAttente, direLaCarte, ouvrirCarteOrale, traiterParoleSurCarte } from "./carte-orale";
import { deposerMessage, ETAT, traiterFil } from "../fil/service";
import type { ElementAgenda, RetourOrchestre } from "@/platform/ia/conversation/orchestrateur";
import { accuseDeReponse } from "../../domaine/conversation/agenda";
import type { Classement } from "../../domaine/conversation/classement";
import {
  appliquerPrecisions, avancementDuTravail, elementOuvert, enregistrerPrecision, ouvrirAgenda, partielsDuTravail, questionDeLElement, racineDe,
  repondreElement, versElement,
} from "../orchestration/agenda";
import { classerEnonce } from "../orchestration/classement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX ENTIÈREMENT ORALE — le SERVEUR de la conversation vocale (lot K9, décision 0039).
 *
 * Direction : « je marche avec mes écouteurs, je ne vois pas mon écran — l'oral peut tout faire ». Trois choses :
 *
 *   1. LA DÉLÉGATION NE BLOQUE PLUS LA VOIX. Une demande dite est déposée dans le fil et rend AUSSITÔT un « travail » ;
 *      la voix dit « je regarde », engage la personne pour affiner, et le navigateur SUIT le travail (`suivreTravailVocal`)
 *      jusqu'au résultat, que la voix dit d'elle-même (session.commentary.append). Ce que la personne précise pendant ce
 *      temps est TRANSMIS (`preciser`) : ajouté au message s'il n'a pas commencé, sinon relance ciblée qui repart du
 *      résultat en cours — jamais de zéro. Session fermée avant la fin : la notification part (la voix ne « consulte »
 *      plus le fil) et le résultat est dit à la prochaine ouverture (`reprisesOrales`).
 *   2. UNE CARTE SE CONCLUT À L'ORAL — par la carte orale de K4 (`./carte-orale.ts` : manquants → facultatifs → récit →
 *      « tu confirmes ? », oui jugé par le serveur sur la transcription, garde du bouton). K9 la branche sur le travail
 *      asynchrone : la carte est dite quand le résultat arrive, et la parole qui lui répond est jugée AVANT tout travail.
 *   3. TOUT PAR LA VOIX : annuler la dernière action (J7), mettre en pause / reprendre / arrêter une mission (K3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, une session vocale n'est plus tenue pour ouverte (le fournisseur la ferme bien avant). */
const SESSION_VALIDE_MS = 2 * 60 * 60_000;
/** Ce qui n'a pas été dit à la voix se reprend à l'ouverture suivante — pendant un jour. */
const REPRISE_MS = 24 * 60 * 60_000;
/** « Annule » vise la dernière action de l'assistant — faite il y a moins d'une demi-heure. */
const ANNULATION_MS = 30 * 60_000;

/** O1 (décision 0046) : avec les champs que l'orchestrateur du navigateur lit (`RetourOrchestre`). */
export interface RetourOral extends RetourOrchestre {
  /** Ce que la voix dit (elle paraphrase) — jamais une valeur que la personne n'a pas le droit d'entendre. */
  pourVoix: string;
  /** Un travail lancé : le navigateur le suit et la voix annoncera son résultat. */
  travail?: string;
  carte?: Record<string, unknown> & { intentId: string };
  /** Une carte a été exécutée à l'oral (l'écran la met à jour). */
  etatCarte?: { intentId: string; status: "EXECUTED" };
  /** Une commande que le navigateur applique lui-même (« stop » : couper la parole ; « plus court »). */
  commande?: "stop" | "plus_court";
  ecran?: string | null;
}

export type SuiviOral =
  | { etat: "en_cours"; etapes: string[]; agenda?: ElementAgenda[]; avancement?: string | null }
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

/**
 * O1 (décision 0046) : plus de « pose une question pour affiner » laissée au hasard du modèle vocal — la question utile,
 * s'il y en a une, vient de l'AGENDA du travail (dérivé de la demande) et l'orchestrateur la colle à cet accusé.
 */
const LANCE = "Le travail est lancé, il n'y a pas encore de résultat. Dis en quelques mots que tu regardes et que tu préviens dès que c'est prêt. N'invente aucun résultat et ne pose pas de question de toi-même.";

/** Les éléments d'agenda d'un travail vocal — rattachés au TRAVAIL suivi par le navigateur (pas au message). */
const pourTravail = (travail: string, xs: ElementAgenda[]): ElementAgenda[] => xs.map((x) => ({ ...x, travail }));

async function lancerTravail(user: CurrentUser, session: { id: string; conversation: string | null }, demande: string, delegationId: string | null, carte: { titre: string } | null, parallele = false): Promise<RetourOral> {
  // K4 : une carte orale attend — la parole la complète ou la corrige (rien ne s'exécute dans ce tour).
  const entete = carte
    ? `${PREFIXE_VOCAL.slice(0, -1)} — carte en attente « ${carte.titre} » : la personne la complète ou la corrige (corriger_carte, ou l'outil preparer_* rappelé avec toutes les valeurs) ; rien ne s'exécute]`
    : PREFIXE_VOCAL;
  const d = await deposerMessage(user.id, `${entete} ${demande}`.slice(0, 8_000), [], null, session.conversation, { parallele });
  if (!d.ok) return { pourVoix: d.erreur };
  void traiterFil(user.id, d.conversation);
  const w = await prisma.assistantIaVoixTravail.create({ data: { userId: user.id, session: session.id, delegationId, conversation: d.conversation, tourId: d.tour.id } });
  const agenda = carte ? [] : (await ouvrirAgenda(user.id, d.conversation, d.tour.id, demande)).map(versElement);
  return {
    travail: w.id, lance: { id: w.id, agenda: pourTravail(w.id, agenda) },
    pourVoix: parallele ? `${LANCE} C'est une deuxième demande, menée en parallèle de la première : dis-le en trois mots.` : LANCE,
  };
}

/** La relance ciblée devient le travail suivi ; l'ancien est `remplacePar` (son résultat dépassé n'est pas dit). */
async function relancerTravail(user: CurrentUser, w: { id: string; session: string }, tourId: string, conversation: string, delegationId: string | null): Promise<string> {
  const nouveau = await prisma.assistantIaVoixTravail.create({ data: { userId: user.id, session: w.session, delegationId, conversation, tourId } });
  await prisma.assistantIaVoixTravail.update({ where: { id: w.id }, data: { remplacePar: nouveau.id } });
  return nouveau.id;
}

/** Le travail vocal SUIVI pour une racine : la dernière relance de sa chaîne (une précision a pu le remplacer). */
async function travailCourant(userId: string, sessionId: string, racine: string) {
  let w = await prisma.assistantIaVoixTravail.findFirst({ where: { tourId: racine, userId, session: sessionId } });
  for (let i = 0; w?.remplacePar && i < 10; i++) w = await prisma.assistantIaVoixTravail.findFirst({ where: { id: w.remplacePar, userId } });
  return w;
}

/**
 * APPLIQUER au travail vocal ce qui a été dit (O1, §2) : majeures RÉINJECTÉES (ajoutées au message qui attend, ou une
 * relance ciblée qui devient le travail suivi) ; mineures de TEXTE portées sur le rendu (le navigateur dit le résultat
 * tenu ainsi — aucune relance) ; mineures de FICHIER / d'ENVOI produites d'après le résultat prêt, un travail de plus.
 */
async function appliquerVocal(user: CurrentUser, w: { id: string; session: string } | null, racine: string, delegationId: string | null): Promise<Partial<RetourOral>> {
  const app = await appliquerPrecisions(user.id, racine);
  if (!w) return {};
  if (app.relance) {
    const nouveau = await relancerTravail(user, w, app.relance.tour, app.relance.conversation, delegationId);
    return { travail: nouveau, change: { travail: w.id, nouveau } };
  }
  if (delegationId) await prisma.assistantIaVoixTravail.update({ where: { id: w.id }, data: { delegationId } });
  const out: Partial<RetourOral> = {};
  if (app.texte.length) out.miseEnForme = { travail: w.id, consigne: app.texte.join(" ") };
  if (app.miseEnForme) {
    const m = await prisma.assistantIaVoixTravail.create({ data: { userId: user.id, session: w.session, delegationId, conversation: app.miseEnForme.conversation, tourId: app.miseEnForme.tour } });
    Object.assign(out, { travail: m.id, lance: { id: m.id, agenda: [] } });
  }
  return out;
}

/**
 * O1 — UNE PRÉCISION pendant le travail : la réponse à la question de l'agenda (« Excel ou PDF ? » → « PDF »), ou une
 * précision libre classée — gardée avec son IMPACT, appliquée (`appliquerVocal`), puis un accusé court. Le navigateur
 * colle à cet accusé ce qui suit (un résultat tenu, l'élément suivant de l'agenda) — jamais d'attente.
 */
async function preciserVocal(user: CurrentUser, s: { id: string }, c: Classement, el: Awaited<ReturnType<typeof elementOuvert>>, racine: string, parole: string, delegationId: string | null): Promise<RetourOral> {
  let valeur = c.consigne;
  let impact = c.impact;
  if (el && c.repondA === el.id) ({ valeur, impact } = await repondreElement(user.id, el, parole));
  else await enregistrerPrecision(user.id, racine, c);
  const w = await travailCourant(user.id, s.id, racine);
  const applique = await appliquerVocal(user, w, racine, delegationId);
  // Ni relance ni mise en forme maintenant (le travail tourne) : la précision part à sa fin — la voix le dit.
  const majeureEnAttente = impact === "majeur" && !applique.change;
  return {
    pourVoix: accuseDeReponse(valeur.slice(0, 120), impact),
    ...(el && c.repondA === el.id ? { repondA: el.id } : {}),
    ...(majeureEnAttente && w ? { change: { travail: w.id } } : {}),
    ...(w ? { travail: w.id } : {}),
    ...applique,
  };
}

/**
 * Ce que la voix dit d'une réponse prête : le texte (rédigé pour l'oreille), les blocs en une phrase, puis la CARTE ORALE
 * (K4) — une carte née de ce tour devient orale et remplace la précédente encore à signer ; la voix dit l'étape suivante.
 */
async function pourVoixDuTour(user: CurrentUser, rep: { contenu: string; blocs: Prisma.JsonValue; intent: Prisma.JsonValue }): Promise<RetourOral> {
  const enClair = (await lireReglagesAssistantIa()).valeursSensibles === "EN_CLAIR";
  const texte = reponsePourVoix(rep.contenu, enClair);
  const blocs = resumeOralBlocs(Array.isArray(rep.blocs) ? (rep.blocs as { kind: string }[]) : []);
  const intent = rep.intent as (Record<string, unknown> & { id?: string; fields?: { label: string; value: string }[] }) | null;
  const avant = await carteOraleEnAttente(user);
  if (intent?.id && intent.id !== avant?.id) {
    await ouvrirCarteOrale(intent.id, Array.isArray(intent.fields) ? intent.fields : [], avant?.facultatifsProposes === true, avant?.id ?? null);
  }
  const carte = await carteOraleEnAttente(user);
  const suite = carte && (carte.id === intent?.id || carte.id === avant?.id) ? await direLaCarte(carte) : "";
  return {
    pourVoix: [texte, blocs, suite].filter(Boolean).join(" — ").slice(0, 1_800),
    ...(intent?.id ? { carte: { ...intent, intentId: intent.id } } : {}),
    ecran: rep.contenu,
  };
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
  let miseEnForme: Partial<RetourOral> = {};
  if (rep?.etat === ETAT.TERMINE || rep?.etat === ETAT.ECHEC) {
    // O1 : des précisions attendaient sa fin. MAJEURES : une relance ciblée, que l'on suit ; ce résultat-ci, dépassé,
    // n'est pas dit. MINEURES : le résultat est dit tel quel, mis en forme comme demandé (aucune relance).
    const applique = await appliquerVocal(user, w, await racineDe(w.tourId), w.delegationId);
    if (applique.change?.nouveau) return { etat: "remplace", par: applique.change.nouveau };
    miseEnForme = applique;
  }
  if (rep?.etat === ETAT.TERMINE) {
    await prisma.assistantIaVoixTravail.updateMany({ where: { id: w.id, annonceLe: null }, data: { annonceLe: new Date() } });
    const dit = await pourVoixDuTour(user, rep);
    const consignes = [
      miseEnForme.miseEnForme ? `Dis-le en tenant compte de ce que la personne a demandé pour la forme : ${miseEnForme.miseEnForme.consigne}` : "",
      miseEnForme.lance ? "La version demandée (fichier, ou carte d'envoi) se prépare à partir de ce résultat, sans refaire la recherche : dis qu'elle suit." : "",
    ].filter(Boolean).join(" ");
    return { etat: "pret", ...dit, pourVoix: [dit.pourVoix, consignes].filter(Boolean).join(" — ").slice(0, 1_800), ...(miseEnForme.lance ? { lance: miseEnForme.lance, travail: miseEnForme.travail } : {}) };
  }
  if (rep?.etat === ETAT.ECHEC || q?.etat === ETAT.ECHEC) {
    await prisma.assistantIaVoixTravail.updateMany({ where: { id: w.id, annonceLe: null }, data: { annonceLe: new Date() } });
    return { etat: "echec", pourVoix: `L'assistant n'a pas pu répondre : ${(rep?.contenu || rep?.erreur || "erreur").slice(0, 200)}. Dis-le simplement et propose de réessayer.` };
  }
  // O1 : ce que l'orchestrateur peut dire pendant l'attente — les partiels neufs, l'avancement réel.
  const [partiels, avancement] = await Promise.all([partielsDuTravail(user.id, w.tourId), avancementDuTravail(user.id, w.tourId)]);
  return {
    etat: "en_cours", etapes: Array.isArray(rep?.etapes) ? (rep!.etapes as string[]).slice(-3) : [],
    ...(partiels.length ? { agenda: pourTravail(w.id, partiels) } : {}), avancement,
  };
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
    dits.push((await pourVoixDuTour(user, rep)).pourVoix);
  }
  return dits;
}

// ─── LES PIÈCES REÇUES EN PLEIN APPEL (K6) ─────────────────────────────────────────────────

const LIBELLE_CANAL: Record<string, string> = { WHATSAPP: "WhatsApp", MAIL: "mail", GMAIL: "ta boîte mail" };

/**
 * UNE PIÈCE ARRIVE PENDANT L'APPEL (WhatsApp, mail — lot K6) : la voix l'annonce d'elle-même, avec ce que l'assistant en
 * a dit dans la conversation et, s'il propose de la ranger, la carte orale (« je l'ajoute à SP-… ? » → « vas-y »). Chaque
 * pièce n'est annoncée qu'une fois par session ; seules les pièces REÇUES de la personne comptent.
 */
export async function annoncesEnAppel(user: CurrentUser, sessionId: unknown): Promise<string[]> {
  const s = await sessionDe(user.id, sessionId);
  if (!s) return [];
  const depuis = s.annonceJusquA ?? s.ouverteLe;
  const recues = await prisma.assistantIaReception.findMany({
    where: { userId: user.id, issue: "RECUE", createdAt: { gt: depuis } }, orderBy: { createdAt: "asc" }, take: 5,
    select: { canal: true, nom: true, tourId: true, createdAt: true },
  });
  if (!recues.length) return [];
  // Une seule veille les annonce (deux onglets, deux battements) : la date avance d'un coup, sous condition.
  const n = await prisma.assistantIaVoixSession.updateMany({ where: { id: s.id, annonceJusquA: s.annonceJusquA }, data: { annonceJusquA: recues.at(-1)!.createdAt } });
  if (n.count !== 1) return [];
  const dits: string[] = [];
  for (const tour of new Set(recues.map((r) => r.tourId))) {
    const lot = recues.filter((r) => r.tourId === tour);
    const quoi = lot.map((r) => `« ${(r.nom ?? "une pièce").slice(0, 60)} »`).join(", ");
    const rep = tour ? await prisma.assistantIaTour.findFirst({ where: { id: tour, userId: user.id }, select: { contenu: true, blocs: true, intent: true } }) : null;
    const suite = rep ? (await pourVoixDuTour(user, rep)).pourVoix : "";
    dits.push(`Interromps-toi poliment : une pièce vient d'arriver par ${LIBELLE_CANAL[lot[0].canal] ?? lot[0].canal} — ${quoi}. ${suite}`.trim().slice(0, 1_800));
  }
  return dits;
}

// ─── LES COMMANDES ORALES ──────────────────────────────────────────────────────────────────

/**
 * « ANNULE » — la DERNIÈRE chose faite au nom de la personne, de moins de 30 minutes (K10b) : un ENVOI encore dans sa
 * fenêtre (rien ne part : `annulerEffetSortant`) s'il est plus récent, sinon le dernier GESTE de l'assistant
 * (`annulerGeste`, effet par effet : un courriel déjà parti est compensé par un rectificatif, et la voix le DIT).
 */
async function annulerDerniere(user: CurrentUser): Promise<RetourOral> {
  const recent = (iso: string) => Date.now() - new Date(iso).getTime() < ANNULATION_MS;
  const [gestes, envois] = await Promise.all([gestesDeLAssistant(user, { limite: 5 }), effetsSortantsDe(user, { depuisMinutes: 30 })]);
  const g = gestes.find((x) => !x.annuleLe && recent(x.quand));
  // Un envoi encore en fenêtre, hors geste de l'assistant (son geste l'annule avec lui).
  const e = envois.find((x) => x.statut === "EN_ATTENTE" && recent(x.creeLe) && (!g || !x.gesteId || x.gesteId !== g.id));
  if (e && (!g || new Date(e.creeLe) > new Date(g.quand))) {
    const r = await annulerEffetSortant(e.id, user);
    return { pourVoix: `${r.message} Dis-le en une phrase.` };
  }
  if (!g) return { pourVoix: "Il n'y a pas d'action récente de l'assistant à annuler. Dis-le simplement." };
  const r = await annulerGeste(g.id, user);
  if ("refus" in r) return { pourVoix: r.refus };
  return { pourVoix: `${phraseAnnulation(g.libelle, r.details)} Dis-le tel quel, sans enjoliver ; elle peut dire « rétablis » si elle change d'avis.` };
}

/** « RÉTABLIS » — la dernière annulation (< 30 min) s'annule : ce qui a bougé depuis est dit, jamais écrasé (K10b). */
async function retablirDerniere(user: CurrentUser): Promise<RetourOral> {
  const g = (await gestesDeLAssistant(user, { limite: 10 })).find((x) => x.annuleLe && Date.now() - new Date(x.annuleLe).getTime() < ANNULATION_MS);
  if (!g) return { pourVoix: "Il n'y a pas d'annulation récente à rétablir. Dis-le simplement." };
  const r = await retablirGeste(g.id, user);
  if ("refus" in r) return { pourVoix: r.refus };
  return { pourVoix: `${phraseAnnulation(g.libelle, r.details, true)} Dis-le tel quel.` };
}

async function commandeMission(user: CurrentUser, nature: "pause_mission" | "reprendre_mission" | "arreter_mission", texte: string): Promise<RetourOral> {
  // P1 (décision 0047) : la MÊME porte que l'écrit (`piloter_mission`) — désignation par le nom, arrêt réversible.
  const action = nature === "pause_mission" ? "pause" : nature === "reprendre_mission" ? "reprendre" : "arreter";
  const r = await piloterMission(user, { action, mission: texte });
  if (r.ok) return { pourVoix: `${r.message} Dis-le en une phrase.` };
  if (r.ambigu && r.candidates?.length) return { pourVoix: `${r.erreur} Demande laquelle, en citant leurs titres.`, questionPosee: true };
  return { pourVoix: r.erreur };
}

// ─── L'AIGUILLAGE D'UN ÉNONCÉ ──────────────────────────────────────────────────────────────

/**
 * CE QUE LA PERSONNE A DIT (transcription d'entrée de la session, depuis la délégation précédente) — jugé par le
 * serveur : commande orale, réponse à la carte orale (K4 : oui / non / rien à ajouter), précision du travail en cours,
 * ou nouvelle demande. `parole` : SES mots neufs (vide si la demande n'est qu'une répétition) — seul juge d'un oui.
 */
export async function traiterEnonceVocal(user: CurrentUser, d: { session: unknown; demande: string; delegationId?: string | null; enCours?: string | null; parole?: string | null; question?: string | null }): Promise<RetourOral> {
  const s = await sessionDe(user.id, d.session);
  if (!s) return HORS_SESSION;
  const texte = d.demande.trim();
  const parole = (d.parole ?? texte).trim();
  const delegationId = typeof d.delegationId === "string" ? d.delegationId.slice(0, 120) : null;
  const carte = await carteOraleEnAttente(user);
  const commande = lireCommandeOrale(parole, { carteEnAttente: !!carte });
  if (commande === "annuler_derniere") return annulerDerniere(user);
  if (commande === "retablir_derniere") return retablirDerniere(user);
  if (commande === "pause_mission" || commande === "reprendre_mission" || commande === "arreter_mission") return commandeMission(user, commande, parole);
  if (commande === "stop") return { pourVoix: "La personne a dit stop : tais-toi et attends qu'elle reparle.", commande };
  if (commande === "plus_court") return { pourVoix: "La personne veut plus court : désormais, une phrase par réponse.", commande };
  if (carte) {
    // K9 : la question « tu confirmes ? » est posée et RIEN de neuf n'a été entendu — on ne relance pas la demande précédente.
    if (carte.questionPosee && !parole) return { pourVoix: "Je n'ai pas entendu sa réponse : redemande-lui simplement si c'est bon. Rien n'est fait." };
    if (commande === "attendre") return { pourVoix: "Rien n'est fait : la carte attend. Dis en trois mots que tu attends son feu vert." };
    const issue = await traiterParoleSurCarte(user, carte, parole);
    if (issue.suite === "repondu") {
      return {
        pourVoix: issue.pourVoix.slice(0, 1_800),
        ...(issue.execute ? { etatCarte: { intentId: carte.id, status: "EXECUTED" as const } } : {}),
        // O1 : la carte attend encore (un champ, « tu confirmes ? ») — la voix pose une question, rien ne s'y colle.
        ...(!issue.execute && (await carteOraleEnAttente(user)) ? { questionPosee: true } : {}),
      };
    }
  }
  // O1 (décision 0046) : pendant un travail (une question de l'agenda posée, ou un travail suivi), l'énoncé est CLASSÉ —
  // précision (majeure / mineure), autre demande (en parallèle), ou simple conversation. Évident : sans modèle ; sinon
  // le classifieur rapide tranche (jamais « précision par défaut »).
  const el = await elementOuvert(user.id, d.question);
  const w = typeof d.enCours === "string" && d.enCours
    ? await prisma.assistantIaVoixTravail.findFirst({ where: { id: d.enCours, userId: user.id, session: s.id, remplacePar: null, annonceLe: null } })
    : null;
  if (!el && !w) return lancerTravail(user, s, texte, delegationId, carte ? { titre: carte.carte.titre } : null);
  const racine = el ? el.tourId : await racineDe(w!.tourId);
  const demandeEnCours = ((await prisma.assistantIaTour.findUnique({ where: { id: racine }, select: { contenu: true } }))?.contenu ?? "").replace(/^\[[^\]]*\]\s*/, "");
  const c = await classerEnonce(user.id, s.conversation, { enonce: parole || texte, demandeEnCours, question: el ? { ...questionDeLElement(el), texte: el.question } : null });
  if (c.nature === "precision") return preciserVocal(user, s, c, el, racine, parole || texte, delegationId);
  if (c.nature === "autre_demande") return lancerTravail(user, s, texte, delegationId, null, true);
  const ou = await avancementDuTravail(user.id, (w ? w.tourId : racine));
  return { pourVoix: `C'est de la conversation pendant que le travail tourne, pas une demande : réponds-y naturellement, en une ou deux phrases, sans rien lancer.${ou ? ` Si elle demande où ça en est : ${ou}` : ""}` };
}
