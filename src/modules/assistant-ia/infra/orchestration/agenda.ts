import type { AssistantIaAgenda } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { censurerTexte } from "../../domaine/filtre-confidentialite";
import {
  construireAgenda, estimerDureeMs, PREFIXE_PRECISION_ECRITE, lireReponseAgenda, phraseAvancement, precisionDeLaReponse, type CleAgenda,
} from "../../domaine/conversation/agenda";
import type { ElementAgenda } from "@/platform/ia/conversation/orchestrateur";
import { extraitDuLivrable } from "../../domaine/sous-missions";
import { deposerMessage, ETAT, traiterFil } from "../fil/service";
import { lireCarnet } from "../travaux";
import { PREFIXE_PRECISION, PREFIXE_VOCAL } from "../../domaine/terrain/oral";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AGENDA D'UN TRAVAIL, EN BASE (lot O1, décision 0046) — commun à la voix et au fil écrit.
 *
 * Un travail = le message de la personne (tour `user`) qui le porte. Son agenda est DÉRIVÉ de la demande
 * (`construireAgenda`, sans modèle), gardé en base (`AssistantIaAgenda`, unique par clé) : chaque question n'est posée
 * qu'une fois, sa réponse est gardée et TRANSMISE au travail quand elle le change (`transmettrePrecision` : ajoutée au
 * message s'il attend, relance ciblée s'il tourne ou a fini — jamais un nouveau départ). Les résultats PARTIELS
 * (sous-missions K3 finies) s'y ajoutent au fil du travail ; l'AVANCEMENT se lit sur les étapes réelles.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export { PREFIXE_PRECISION_ECRITE };

export const ETAT_AGENDA = { A_POSER: "A_POSER", POSEE: "POSEE", REPONDUE: "REPONDUE", SANS_OBJET: "SANS_OBJET", DIT: "DIT" } as const;

export function versElement(r: Pick<AssistantIaAgenda, "id" | "tourId" | "nature" | "question" | "choix">): ElementAgenda {
  const choix = Array.isArray(r.choix) ? (r.choix as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return { id: r.id, travail: r.tourId, nature: r.nature as ElementAgenda["nature"], texte: r.question, ...(choix.length ? { choix } : {}) };
}

/** OUVRIR l'agenda d'un travail (idempotent) — rend ses éléments encore à dire, dans l'ordre. */
export async function ouvrirAgenda(userId: string, filId: string, tourId: string, demande: string): Promise<AssistantIaAgenda[]> {
  const gabarits = construireAgenda(demande);
  if (gabarits.length) {
    await prisma.assistantIaAgenda.createMany({
      data: gabarits.map((g) => ({ userId, filId, tourId, cle: g.cle, nature: g.nature, question: g.question, choix: g.choix })),
      skipDuplicates: true,
    });
  }
  return prisma.assistantIaAgenda.findMany({ where: { tourId, userId, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } }, orderBy: { creeLe: "asc" } });
}

/** Un élément d'agenda de CETTE personne, encore ouvert (à poser ou posé). */
export async function elementOuvert(userId: string, id: unknown) {
  if (typeof id !== "string" || !id || id.length > 64) return null;
  return prisma.assistantIaAgenda.findFirst({ where: { id, userId, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } } });
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
    const n = await prisma.assistantIaTour.updateMany({ where: { id: tourId, etat: ETAT.ATTENTE }, data: { contenu: `${tour.contenu}\n${prefixe} ${ligne}`.slice(0, 8_000) } });
    if (n.count === 1) return { ok: true, mode: "ajoutee" };
  }
  const avant = tour.contenu.replace(/^\[[^\]]*\]\s*/, "").trim().slice(0, 300);
  const message = `${prefixe} ${ligne}\n(La personne précise sa demande précédente « ${avant} », dont la réponse est en cours ou vient d'arriver : pars de ce que tu as déjà trouvé, ne refais pas les recherches déjà faites, et réponds à la demande ainsi précisée. Si c'est en fait une autre demande, traite-la.)`;
  const d = await deposerMessage(userId, message.slice(0, 8_000), [], null, tour.filId);
  if (!d.ok) return d;
  void traiterFil(userId, d.conversation);
  return { ok: true, mode: "relance", tour: d.tour.id, conversation: d.conversation };
}

/**
 * RÉPONDRE à un élément d'agenda — gardée ; si elle change le travail, elle lui est TRANSMISE (`transmettreSiPret`) :
 * tout de suite si son message attend encore ou si sa réponse est déjà écrite ; s'il tourne, à sa fin, en UNE relance
 * qui porte toutes les réponses données entre-temps (pas une relance par réponse). Rend la valeur retenue (pour
 * l'accusé : « Noté, PDF ») et, s'il y a eu relance, le message qui la porte.
 */
export async function repondreElement(
  userId: string, el: AssistantIaAgenda, texte: string,
): Promise<{ valeur: string; change: boolean; relance: { tour: string; conversation: string } | null }> {
  const choix = Array.isArray(el.choix) ? (el.choix as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const lu = lireReponseAgenda({ cle: el.cle, choix }, texte);
  // Une seule réponse par question (deux onglets, deux délégations) : la première l'emporte.
  const pris = await prisma.assistantIaAgenda.updateMany({
    where: { id: el.id, etat: { in: [ETAT_AGENDA.A_POSER, ETAT_AGENDA.POSEE] } },
    data: { etat: ETAT_AGENDA.REPONDUE, reponse: lu.valeur, repondueLe: new Date(), poseeLe: el.poseeLe ?? new Date(), change: !lu.sansEffet },
  });
  if (!pris.count || lu.sansEffet) return { valeur: lu.valeur, change: false, relance: null };
  return { valeur: lu.valeur, change: true, relance: await transmettreSiPret(userId, el.tourId) };
}

/**
 * TRANSMETTRE les réponses qui changent un travail, si le moment est venu : son message attend (elles s'y ajoutent),
 * ou sa réponse est écrite (une relance ciblée). Il tourne : rien — elles partiront à sa fin, toutes ensemble. La prise
 * est atomique (deux lectures en même temps ne relancent pas deux fois).
 */
export async function transmettreSiPret(userId: string, tourId: string): Promise<{ tour: string; conversation: string } | null> {
  const [tour, rep] = await Promise.all([
    prisma.assistantIaTour.findFirst({ where: { id: tourId, userId }, select: { etat: true, contenu: true } }),
    reponseDu(tourId),
  ]);
  if (!tour || (tour.etat !== ETAT.ATTENTE && (!rep || rep.etat === ETAT.COURS))) return null;
  const marque = `transmission:${tourId}:${Date.now()}`;
  const n = await prisma.assistantIaAgenda.updateMany({ where: { tourId, userId, change: true, precisionTourId: null }, data: { precisionTourId: marque } });
  if (!n.count) return null;
  const lignes = (await prisma.assistantIaAgenda.findMany({ where: { precisionTourId: marque }, orderBy: { repondueLe: "asc" } }))
    .map((a) => precisionDeLaReponse(a.cle as CleAgenda, a.reponse ?? "")).join(" ");
  const t = await transmettrePrecision(userId, tourId, lignes, tour.contenu.startsWith(PREFIXE_VOCAL) ? PREFIXE_PRECISION : PREFIXE_PRECISION_ECRITE);
  if (!t.ok) {
    await prisma.assistantIaAgenda.updateMany({ where: { precisionTourId: marque }, data: { precisionTourId: null } });
    return null;
  }
  await prisma.assistantIaAgenda.updateMany({ where: { precisionTourId: marque }, data: { precisionTourId: t.mode === "relance" ? t.tour : tourId } });
  return t.mode === "relance" ? { tour: t.tour, conversation: t.conversation } : null;
}

/** Les travaux de ce fil qui ont des réponses à transmettre (leur réponse a pu finir depuis). */
export async function transmissionsEnAttente(userId: string, filId: string): Promise<string[]> {
  const xs = await prisma.assistantIaAgenda.findMany({ where: { userId, filId, change: true, precisionTourId: null }, select: { tourId: true }, distinct: ["tourId"], take: 5 });
  return xs.map((x) => x.tourId);
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
    const r = await prisma.assistantIaAgenda.create({ data: { userId, filId: tour.filId, tourId, cle: `partiel:${m.id}`, nature: "partiel", question: texte, etat: ETAT_AGENDA.DIT } }).catch(() => null);
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
