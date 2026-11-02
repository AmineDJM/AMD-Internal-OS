import type { AssistantIaAgenda } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import { censurerTexte } from "../../domaine/filtre-confidentialite";
import {
  construireAgenda, estimerDureeMs, lireReponseAgenda, phraseAvancement, precisionDeLaReponse, PREFIXE_MISE_EN_FORME, PREFIXE_PRECISION_ECRITE,
  type Forme, type Impact,
} from "../../domaine/conversation/agenda";
import type { Classement } from "../../domaine/conversation/classement";
import type { ElementAgenda } from "@/platform/ia/conversation/orchestrateur";
import { extraitDuLivrable } from "../../domaine/sous-missions";
import { deposerMessage, ETAT, traiterFil } from "../fil/service";
import { lireCarnet } from "../travaux";
import { PREFIXE_PRECISION, PREFIXE_VOCAL } from "../../domaine/terrain/oral";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AGENDA D'UN TRAVAIL ET SES PRÉCISIONS, EN BASE (lot O1, décision 0046) — commun à la voix et au fil écrit.
 *
 * Un travail = le message de la personne (tour `user`, la RACINE) qui le porte. Son agenda est DÉRIVÉ de la demande
 * (`construireAgenda`, sans modèle), gardé en base (`AssistantIaAgenda`, unique par clé, rangé) : chaque élément n'est dit
 * qu'une fois. Une réponse — ou une précision libre — est gardée avec son IMPACT, puis APPLIQUÉE (`appliquerPrecisions`) :
 *   • le message attend encore : tout s'y AJOUTE (un seul tour, rien de perdu, aucun coût) ;
 *   • il tourne : rien encore — tout partira à sa fin, ensemble ;
 *   • sa réponse est écrite : les MAJEURES partent en UNE relance ciblée (« pars de ce que tu as trouvé », les mineures
 *     portées avec) — elles sont réinjectées dans le raisonnement ; les MINEURES seules ne relancent RIEN : la mise en
 *     forme de texte (ton, longueur, présentation) est portée sur le rendu (la voix la dit ainsi ; l'écrit reformule
 *     par le modèle rapide), un fichier ou une carte d'envoi est produit d'après le résultat prêt, sans recherche.
 * Les relances s'enchaînent sur la racine (`precisionTourId`) : le travail COURANT est la dernière relance.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { PREFIXE_PRECISION_ECRITE };

export const ETAT_AGENDA = { A_POSER: "A_POSER", POSEE: "POSEE", REPONDUE: "REPONDUE", SANS_OBJET: "SANS_OBJET", DIT: "DIT" } as const;

export function versElement(r: Pick<AssistantIaAgenda, "id" | "tourId" | "nature" | "question" | "choix">): ElementAgenda {
  const choix = Array.isArray(r.choix) ? (r.choix as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { id: r.id, travail: r.tourId, nature: r.nature as ElementAgenda["nature"], texte: r.question, ...(choix.length ? { choix } : {}) };
}

/** Ce que le classement lit d'un élément posé (le choix proposé, son impact). */
export function questionDeLElement(r: AssistantIaAgenda) {
  const choix = Array.isArray(r.choix) ? (r.choix as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { id: r.id, cle: r.cle, choix, impact: (r.impact === "mineur" ? "mineur" : "majeur") as Impact, forme: (r.forme as Forme | null) ?? null };
}

/** OUVRIR l'agenda d'un travail (idempotent) — rend ses éléments encore à dire, dans l'ordre. */
export async function ouvrirAgenda(userId: string, filId: string, tourId: string, demande: string): Promise<AssistantIaAgenda[]> {
  const gabarits = construireAgenda(demande);
  if (gabarits.length) {
    await prisma.assistantIaAgenda.createMany({
      data: gabarits.map((g, rang) => ({ userId, filId, tourId, cle: g.cle, nature: g.nature, question: g.question, choix: g.choix, impact: g.impact, forme: g.forme, rang })),
      skipDuplicates: true,
    });
  }
  return prisma.assistantIaAgenda.findMany({ where: { tourId, userId, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } }, orderBy: [{ rang: "asc" }, { creeLe: "asc" }] });
}

/** Un élément d'agenda de CETTE personne, encore ouvert (à poser ou posé). */
export async function elementOuvert(userId: string, id: unknown) {
  if (typeof id !== "string" || !id || id.length > 64) return null;
  return prisma.assistantIaAgenda.findFirst({ where: { id, userId, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } } });
}

/** Une relance pas encore déposée (sa prise est en cours) : elle ne compte pas comme un tour. */
const vraiTour = (x: string | null): x is string => !!x && !x.startsWith("transmission:");

/** La RACINE d'un travail : le message de la personne dont une relance descend (ou lui-même). */
export async function racineDe(tourId: string): Promise<string> {
  const r = await prisma.assistantIaAgenda.findFirst({ where: { precisionTourId: tourId }, select: { tourId: true } });
  return r && r.tourId !== tourId ? r.tourId : tourId;
}

/** La chaîne d'un travail : la racine, puis ses relances dans l'ordre. Le dernier est le travail COURANT. */
async function chaineDe(racine: string): Promise<string[]> {
  const rs = await prisma.assistantIaAgenda.findMany({ where: { tourId: racine, precisionTourId: { not: null } }, select: { precisionTourId: true }, orderBy: { repondueLe: "asc" } });
  const relances = [...new Set(rs.map((r) => r.precisionTourId).filter(vraiTour))].filter((t) => t !== racine);
  if (!relances.length) return [racine];
  const dates = await prisma.assistantIaTour.findMany({ where: { id: { in: relances } }, select: { id: true, createdAt: true } });
  return [racine, ...dates.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((t) => t.id)];
}

/**
 * TRANSMETTRE UNE PRÉCISION à un travail — jamais un nouveau départ :
 *   • son message n'a pas encore été pris : la précision S'AJOUTE au message (un seul tour, rien de perdu) ;
 *   • il tourne ou a fini : RELANCE CIBLÉE — un message de précision joué juste après dans le même fil, qui voit la
 *     réponse en cours dans son historique et en repart sans refaire les recherches.
 */
export async function transmettrePrecision(
  userId: string, tourId: string, ligne: string, prefixe: string,
): Promise<{ ok: true; mode: "ajoutee" } | { ok: true; mode: "relance"; tour: string; conversation: string } | { ok: false; erreur: string }> {
  const tour = await prisma.assistantIaTour.findFirst({ where: { id: tourId, userId }, select: { contenu: true, etat: true, filId: true } });
  if (!tour) return { ok: false, erreur: "Le travail n'existe plus." };
  if (tour.etat === ETAT.ATTENTE) {
    const n = await prisma.assistantIaTour.updateMany({ where: { id: tourId, etat: ETAT.ATTENTE }, data: { contenu: `${tour.contenu}\n${prefixe} ${ligne}` } });
    if (n.count === 1) return { ok: true, mode: "ajoutee" };
  }
  const avant = tour.contenu.replace(/^\[[^\]]*\]\s*/, "").trim().slice(0, 300);
  const message = `${prefixe} ${ligne}\n(La personne précise sa demande précédente « ${avant} », dont la réponse est en cours ou vient d'arriver : pars de ce que tu as déjà trouvé, ne refais pas les recherches déjà faites, et réponds à la demande ainsi précisée. Si c'est en fait une autre demande, traite-la.)`;
  const d = await deposerMessage(userId, message, [], null, tour.filId);
  if (!d.ok) return d;
  void traiterFil(userId, d.conversation);
  return { ok: true, mode: "relance", tour: d.tour.id, conversation: d.conversation };
}

/**
 * RÉPONDRE à un élément d'agenda — gardée avec l'impact de l'élément (« peu importe », « non » : sans effet). Une seule
 * réponse par question (deux onglets, deux délégations) : la première l'emporte. L'application suit (`appliquerPrecisions`).
 */
export async function repondreElement(userId: string, el: AssistantIaAgenda, texte: string): Promise<{ valeur: string; impact: Impact | null }> {
  const choix = Array.isArray(el.choix) ? (el.choix as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const lu = lireReponseAgenda({ cle: el.cle, choix }, texte);
  const impact: Impact | null = lu.sansEffet ? null : el.impact === "mineur" ? "mineur" : "majeur";
  const pris = await prisma.assistantIaAgenda.updateMany({
    where: { id: el.id, userId, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } },
    data: { etat: ETAT_AGENDA.REPONDUE, reponse: lu.valeur, repondueLe: new Date(), poseeLe: el.poseeLe ?? new Date(), impact, change: impact === "majeur" },
  });
  return { valeur: lu.valeur, impact: pris.count ? impact : null };
}

/** Une PRÉCISION LIBRE (pas une réponse à une question) : gardée sur la racine du travail, avec son impact classé. */
export async function enregistrerPrecision(userId: string, tourId: string, c: Pick<Classement, "impact" | "forme" | "consigne">): Promise<void> {
  const racine = await racineDe(tourId);
  const t = await prisma.assistantIaTour.findFirst({ where: { id: racine, userId }, select: { filId: true } });
  if (!t) return;
  await prisma.assistantIaAgenda.create({
    data: {
      userId, filId: t.filId, tourId: racine, cle: `libre:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, nature: "precision",
      question: c.consigne.slice(0, 300), etat: ETAT_AGENDA.REPONDUE, reponse: c.consigne.slice(0, 300), repondueLe: new Date(),
      impact: c.impact, forme: c.impact === "mineur" ? c.forme : null, change: c.impact === "majeur", rang: 1_000,
    },
  });
}

export interface Application {
  /** Ajoutées au message qui attendait (un seul tour). */
  ajoutees: boolean;
  /** Les majeures réinjectées : la relance ciblée (le nouveau travail courant). */
  relance: { tour: string; conversation: string } | null;
  /** Les mineures de TEXTE, à porter sur le rendu (la voix les dit ainsi ; l'écrit reformule). */
  texte: string[];
  /** Les mineures de FICHIER ou d'ENVOI : le tour qui les produit d'après le résultat prêt (sans recherche). */
  miseEnForme: { tour: string; conversation: string } | null;
  /** Le travail courant (la dernière relance, sinon la racine) et l'état de sa réponse. */
  courant: string;
}

const ligneDe = (a: Pick<AssistantIaAgenda, "cle" | "reponse">) => precisionDeLaReponse(a.cle, a.reponse ?? "");

/**
 * APPLIQUER ce qui a été dit à un travail, si le moment est venu (idempotent, prise atomique — deux lectures en même
 * temps n'appliquent rien deux fois). Voir l'en-tête : ajoutées / rien (il tourne) / relance (majeures) / rendu (mineures).
 */
export async function appliquerPrecisions(userId: string, tourId: string): Promise<Application> {
  const racine = await racineDe(tourId);
  const chaine = await chaineDe(racine);
  const courant = chaine.at(-1)!;
  const vide: Application = { ajoutees: false, relance: null, texte: [], miseEnForme: null, courant };
  const [tour, rep] = await Promise.all([
    prisma.assistantIaTour.findFirst({ where: { id: courant, userId }, select: { etat: true, contenu: true, filId: true } }),
    reponseDu(courant),
  ]);
  if (!tour) return vide;
  const enAttente = tour.etat === ETAT.ATTENTE;
  if (!enAttente && (!rep || rep.etat === ETAT.COURS)) return vide;
  const marque = `transmission:${racine}:${Date.now()}`;
  const prendreMajeures = await prisma.assistantIaAgenda.updateMany({ where: { tourId: racine, userId, etat: ETAT_AGENDA.REPONDUE, impact: "majeur", precisionTourId: null }, data: { precisionTourId: marque } });
  const prefixe = (await prisma.assistantIaTour.findUnique({ where: { id: racine }, select: { contenu: true } }))?.contenu.startsWith(PREFIXE_VOCAL) ? PREFIXE_PRECISION : PREFIXE_PRECISION_ECRITE;
  // Ajoutées au message qui attend, ou portées par une relance : les mineures en attente partent avec (une fois).
  if (enAttente || prendreMajeures.count) {
    const maintenant = new Date();
    await prisma.assistantIaAgenda.updateMany({ where: { tourId: racine, userId, etat: ETAT_AGENDA.REPONDUE, impact: "mineur", appliqueLe: null }, data: { appliqueLe: maintenant, precisionTourId: marque } });
    const lignes = (await prisma.assistantIaAgenda.findMany({ where: { precisionTourId: marque }, orderBy: [{ repondueLe: "asc" }] })).map(ligneDe);
    if (!lignes.length) return vide;
    const t = await transmettrePrecision(userId, courant, lignes.join(" "), prefixe);
    if (!t.ok) {
      await prisma.assistantIaAgenda.updateMany({ where: { precisionTourId: marque }, data: { precisionTourId: null, appliqueLe: null } });
      return vide;
    }
    await prisma.assistantIaAgenda.updateMany({ where: { precisionTourId: marque }, data: { precisionTourId: t.mode === "relance" ? t.tour : courant } });
    return t.mode === "relance" ? { ...vide, relance: { tour: t.tour, conversation: t.conversation }, courant: t.tour } : { ...vide, ajoutees: true };
  }
  // MINEURES SEULES, sur une réponse écrite : rien n'est relancé. (Un échec n'a rien à mettre en forme.)
  if (rep?.etat !== ETAT.TERMINE) return vide;
  const mineures = await prisma.assistantIaAgenda.findMany({ where: { tourId: racine, userId, etat: ETAT_AGENDA.REPONDUE, impact: "mineur", appliqueLe: null }, orderBy: [{ repondueLe: "asc" }] });
  if (!mineures.length) return vide;
  const prises = await prisma.assistantIaAgenda.updateMany({ where: { id: { in: mineures.map((m) => m.id) }, appliqueLe: null }, data: { appliqueLe: new Date() } });
  if (prises.count !== mineures.length) return vide;
  const texte = mineures.filter((m) => m.forme !== "fichier" && m.forme !== "destinataire").map(ligneDe);
  const aProduire = mineures.filter((m) => m.forme === "fichier" || m.forme === "destinataire").map(ligneDe);
  let miseEnForme: Application["miseEnForme"] = null;
  if (aProduire.length) {
    const message = `${PREFIXE_MISE_EN_FORME} ${aProduire.join(" ")}\n(Reprends TA RÉPONSE PRÉCÉDENTE telle quelle — ne refais aucune recherche, ne relis aucune donnée — et produis seulement ce qui est demandé : le fichier, ou la carte d'envoi à confirmer.)`;
    const d = await deposerMessage(userId, message, [], null, tour.filId, { parallele: true });
    if (d.ok) {
      void traiterFil(userId, d.conversation);
      miseEnForme = { tour: d.tour.id, conversation: d.conversation };
    }
  }
  return { ...vide, texte, miseEnForme };
}

/** Les travaux de ce fil qui ont des précisions à appliquer (leur réponse a pu finir depuis). */
export async function precisionsEnAttente(userId: string, filId: string): Promise<string[]> {
  const xs = await prisma.assistantIaAgenda.findMany({
    where: { userId, filId, OR: [{ etat: ETAT_AGENDA.REPONDUE, impact: "majeur", precisionTourId: null }, { etat: ETAT_AGENDA.REPONDUE, impact: "mineur", appliqueLe: null }] },
    select: { tourId: true }, distinct: ["tourId"], take: 5,
  });
  return xs.map((x) => x.tourId);
}

/** Les réponses d'un fil écrites AVANT une précision majeure — chacune avec ce qui l'a rendue « version d'avant ». */
export async function versionsDAvant(userId: string, filId: string): Promise<{ reponseId: string; valeur: string }[]> {
  const rs = await prisma.assistantIaAgenda.findMany({ where: { userId, filId, etat: ETAT_AGENDA.REPONDUE, impact: "majeur", precisionTourId: { not: null } }, select: { tourId: true, reponse: true, precisionTourId: true }, take: 40 });
  const out: { reponseId: string; valeur: string }[] = [];
  for (const racine of [...new Set(rs.map((r) => r.tourId))]) {
    const chaine = await chaineDe(racine);
    for (let i = 0; i < chaine.length - 1; i++) {
      const valeur = rs.filter((r) => r.tourId === racine && r.precisionTourId === chaine[i + 1]).map((r) => r.reponse ?? "").filter(Boolean).join(", ");
      if (!valeur) continue;
      const reps = await prisma.assistantIaTour.findMany({ where: { repondA: chaine[i], role: "assistant", etat: ETAT.TERMINE }, select: { id: true } });
      out.push(...reps.map((r) => ({ reponseId: r.id, valeur })));
    }
  }
  return out;
}

/** La réponse de l'assistant à un message (la dernière). */
const reponseDu = (tourId: string) => prisma.assistantIaTour.findFirst({
  where: { repondA: tourId, role: "assistant" }, orderBy: { createdAt: "desc" },
  select: { id: true, etat: true, etapes: true, travaux: true, createdAt: true },
});

/**
 * LES RÉSULTATS PARTIELS d'un travail : ses sous-missions (K3) finies depuis la dernière lecture — une phrase chacune,
 * dites UNE fois (gardées `DIT` dans l'agenda). Rien de neuf : liste vide.
 */
export async function partielsDuTravail(userId: string, tourId: string): Promise<ElementAgenda[]> {
  const rep = await reponseDu(tourId);
  const ids = Array.isArray(rep?.travaux) ? (rep!.travaux as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return [];
  const finies = await prisma.mission.findMany({ where: { id: { in: ids }, principalId: userId, kind: "TRAVAIL", status: "COMPLETED" }, select: { id: true, title: true, carnet: true } });
  if (!finies.length) return [];
  const tour = await prisma.assistantIaTour.findUniqueOrThrow({ where: { id: tourId }, select: { filId: true } });
  const deja = new Set((await prisma.assistantIaAgenda.findMany({ where: { tourId, cle: { in: finies.map((m) => `partiel:${m.id}`) } }, select: { cle: true } })).map((x) => x.cle));
  const out: ElementAgenda[] = [];
  for (const m of finies) {
    if (deja.has(`partiel:${m.id}`)) continue;
    // Jamais une valeur sensible dans ce qui est dit (filtre de confidentialité).
    const c = lireCarnet(m.carnet);
    const extrait = censurerTexte(extraitDuLivrable(c.livrables.at(-1)?.contenu ?? c.trouvailles.slice(-2).map((t) => t.texte).join("\n"), 240)).texte;
    const texte = `la sous-mission « ${m.title.slice(0, 80)} » est finie${extrait ? ` : ${extrait}` : "."}`;
    const r = await prisma.assistantIaAgenda.create({ data: { userId, filId: tour.filId, tourId, cle: `partiel:${m.id}`, nature: "partiel", question: texte, etat: ETAT_AGENDA.DIT } }).catch(attendu("partiel déjà gardé par une lecture concurrente (clé unique) : il est dit par elle", null));
    if (r) out.push(versElement(r));
  }
  return out;
}

/** OÙ EN EST un travail — étapes réelles, sous-missions, durée estimée d'après les 30 derniers travaux de la personne. */
export async function avancementDuTravail(userId: string, tourId: string, maintenant = new Date()): Promise<string | null> {
  const rep = await reponseDu(tourId);
  if (!rep || rep.etat !== ETAT.COURS) return null;
  const passes = await prisma.assistantIaTour.findMany({
    where: { userId, role: "assistant", etat: ETAT.TERMINE, ms: { not: null }, NOT: { outils: { isEmpty: true } } },
    orderBy: { createdAt: "desc" }, take: 30, select: { ms: true },
  });
  return phraseAvancement({
    etapes: rep.etapes, ecouleMs: maintenant.getTime() - rep.createdAt.getTime(),
    estimeMs: estimerDureeMs(passes.map((p) => p.ms ?? 0)),
  });
}
