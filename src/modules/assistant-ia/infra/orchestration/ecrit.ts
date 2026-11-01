import { prisma } from "@/lib/prisma";
import { affichageEcrit, etatInitial, transition } from "@/platform/ia/conversation/orchestrateur";
import { TRAVAIL_LONG_MS, voieDuMessage, type OrchestrationFil } from "../../domaine/conversation/agenda";
import { deposerMessage, ETAT, filDe, traiterFil, type PieceDuTour } from "../fil/service";
import { avancementDuTravail, ETAT_AGENDA, ouvrirAgenda, repondreElement, transmettreSiPret, transmissionsEnAttente, versElement } from "./agenda";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORCHESTRATEUR À L'ÉCRIT (lot O1, décision 0046) — la même machine que la voix, lue sur le fil.
 *
 * Direction : « pas que à l'oral, c'est aussi le cas pour l'écrit ». Pendant qu'un travail LONG tourne :
 *   • la conversation reste utilisable : une AUTRE demande part dans la voie parallèle (elle n'attend pas derrière lui) ;
 *   • l'assistant pose dans le fil la question utile de l'agenda (une à la fois, avec ses choix) ; la réponse écrite
 *     (ou le choix touché) est gardée et TRANSMISE au travail quand elle le change ;
 *   • un résultat arrivé pendant que SA question attend réponse est TENU (« résultat prêt — affiché après ta réponse »),
 *     jamais affiché par-dessus la question ; l'avancement réel (étapes, durée estimée) est dit sous la réponse qui
 *     s'écrit. La carte K3 reste la source de l'avancement des missions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un travail est « long » à l'écrit au-delà de ce temps : l'agenda s'ouvre (une réponse rapide n'a pas de question). */
export const AGENDA_ECRIT_APRES_MS = 4_000;

/** La question de l'agenda qui attend réponse dans ce fil (la plus récente). */
const questionDuFil = (userId: string, filId: string) => prisma.assistantIaAgenda.findFirst({
  where: { userId, filId, etat: ETAT_AGENDA.POSEE, nature: { not: "partiel" } }, orderBy: { poseeLe: "desc" },
});

/** La réponse qui s'écrit dans la file habituelle (pas la voie parallèle) — le travail long, s'il y en a un. */
async function travailEnCours(filId: string) {
  const r = await prisma.assistantIaTour.findFirst({ where: { filId, role: "assistant", etat: ETAT.COURS }, orderBy: { createdAt: "asc" }, select: { id: true, repondA: true, createdAt: true } });
  if (!r?.repondA) return null;
  const q = await prisma.assistantIaTour.findUnique({ where: { id: r.repondA }, select: { id: true, contenu: true, parallele: true } });
  return q && !q.parallele ? { reponse: r.id, tour: q.id, contenu: q.contenu, depuisMs: Date.now() - r.createdAt.getTime() } : null;
}

/**
 * ÉCRIRE PENDANT UN TRAVAIL — le message est (1) la réponse à la question de l'agenda, (2) une autre demande qui part
 * en parallèle d'un travail long, ou (3) la file habituelle. Toujours visible dans le fil, tel qu'il a été écrit.
 */
export async function deposerEcrit(userId: string, texte: string, pieces: PieceDuTour[], conversation?: string | null) {
  const fil = await filDe(userId, conversation);
  if (conversation && fil.id !== conversation) return { ok: false as const, erreur: "Conversation introuvable." };
  const [q, t] = await Promise.all([questionDuFil(userId, fil.id), travailEnCours(fil.id)]);
  const voie = voieDuMessage({ texte, questionEnAttente: !!q && !pieces.length && !!texte.trim(), travailEnCoursDepuisMs: t?.depuisMs ?? null });
  if (voie === "reponse" && q) {
    // Le message de la personne, tel qu'écrit, reste dans le fil (traité : la réponse est la suite du travail).
    const tour = await prisma.assistantIaTour.create({ data: { filId: fil.id, userId, role: "user", contenu: texte.trim().slice(0, 8_000), etat: ETAT.TRAITE } });
    await prisma.assistantIaFil.update({ where: { id: fil.id }, data: { dernierLe: new Date() } });
    const r = await repondreElement(userId, q, texte);
    return { ok: true as const, tour, conversation: fil.id, voie, valeur: r.valeur, change: r.change };
  }
  const d = await deposerMessage(userId, texte, pieces, null, fil.id, { parallele: voie === "parallele" });
  if (d.ok) void traiterFil(userId, d.conversation);
  return d.ok ? { ...d, voie } : d;
}

export type { OrchestrationFil };

/**
 * L'ÉTAT D'ORCHESTRATION D'UN FIL, à chaque lecture de l'écran. Ouvre l'agenda d'un travail devenu long et pose sa
 * première question (une seule à la fois, `A_POSER` → `POSEE`, atomique) ; dit quelles réponses sont tenues.
 */
export async function orchestrationDuFil(userId: string, filId: string): Promise<OrchestrationFil> {
  // Des réponses attendaient la fin de leur travail pour lui être transmises : il a fini, elles partent (une relance).
  for (const tourId of await transmissionsEnAttente(userId, filId)) await transmettreSiPret(userId, tourId);
  let q = await questionDuFil(userId, filId);
  const t = await travailEnCours(filId);
  let avancement: OrchestrationFil["avancement"] = null;
  if (t && t.depuisMs >= AGENDA_ECRIT_APRES_MS) {
    if (!q) {
      const a = (await ouvrirAgenda(userId, filId, t.tour, t.contenu)).find((x) => x.etat === ETAT_AGENDA.A_POSER && x.nature !== "partiel");
      if (a) {
        const n = await prisma.assistantIaAgenda.updateMany({ where: { id: a.id, etat: ETAT_AGENDA.A_POSER }, data: { etat: ETAT_AGENDA.POSEE, poseeLe: new Date() } });
        if (n.count) q = await questionDuFil(userId, filId);
      }
    }
    const texte = await avancementDuTravail(userId, t.tour);
    if (texte && t.depuisMs >= TRAVAIL_LONG_MS) avancement = { reponseId: t.reponse, texte };
  }
  // LA MÊME MACHINE QUE LA VOIX : le travail, sa question posée, son résultat s'il est là → ce qui est tenu.
  let e = etatInitial();
  if (q) {
    const el = versElement(q);
    e = transition(e, { type: "reponse_prise_en_compte", ms: 0, accuse: "", silencieux: true, lance: { id: q.tourId, agenda: [el] } });
    e = transition(e, { type: "dit", ms: 0, action: { type: "dire", contenu: el.texte, delegationId: null, accuse: false, annonce: null, element: el, avancement: null, travail: q.tourId } });
    const reponses = await prisma.assistantIaTour.findMany({ where: { repondA: q.tourId, role: "assistant", etat: { in: [ETAT.TERMINE, ETAT.ECHEC] } }, select: { id: true, etat: true } });
    for (const r of reponses) e = transition(e, { type: "resultat", ms: 1, travail: r.id, contenu: "", echec: r.etat === ETAT.ECHEC });
  }
  // Une réponse transmise par RELANCE (pas ajoutée au message qui attendait) : la réponse d'avant est « version d'avant ».
  const ajustes = (await prisma.assistantIaAgenda.findMany({ where: { userId, filId, change: true, precisionTourId: { not: null } }, select: { tourId: true, reponse: true, precisionTourId: true }, take: 20, orderBy: { repondueLe: "desc" } }))
    .filter((a) => a.precisionTourId !== a.tourId && !a.precisionTourId!.startsWith("transmission:"));
  const avant = ajustes.length
    ? await prisma.assistantIaTour.findMany({ where: { repondA: { in: ajustes.map((a) => a.tourId) }, role: "assistant", etat: ETAT.TERMINE }, select: { id: true, repondA: true } })
    : [];
  return {
    question: q ? { id: q.id, tourId: q.tourId, texte: q.question, choix: versElement(q).choix ?? [] } : null,
    tenus: affichageEcrit(e).tenus,
    avancement,
    ajustes: avant.map((r) => ({ reponseId: r.id, valeur: ajustes.find((a) => a.tourId === r.repondA)?.reponse ?? "" })),
  };
}
