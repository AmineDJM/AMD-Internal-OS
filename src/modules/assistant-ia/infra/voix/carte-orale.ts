import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import { estChargeCapacite } from "../../domaine/capacites";
import { estChargeOperationIA } from "../../domaine/operations/types";
import {
  estNonExplicite, estOuiExplicite, estRienAAjouter, etapeOrale, recitDeCarte, texteOral, type CarteOrale, type ChampOral,
} from "../../domaine/terrain/voix-orale";
import { facultatifsDeCapacite } from "../capacites";
import { facultatifsDOperation } from "../operations";
import { confirmerCarte } from "../confirmation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE À L'ORAL (lot K4, décision 0035) — l'état d'une carte préparée pendant une conversation vocale, et sa
 * CONFIRMATION ORALE.
 *
 * L'état vit dans le JOURNAL de l'intention (`events`, en ajout seulement — une correction réécrit la charge, pas le
 * journal) : `VOIX` + `etape` (CARTE : la carte est née à l'oral, ses champs ; FACULTATIFS : proposés ; QUESTION : la
 * demande a été RÉCITÉE et « tu confirmes ? » posé ; REFUS : la personne a dit non). Une correction (`CORRECTED`) après la
 * question l'annule : il faudra récapituler de nouveau.
 *
 * LA CONFIRMATION ORALE n'est entendue que si : la carte est la dernière carte orale de CETTE personne, encore à signer,
 * de moins de 30 minutes ; la question de confirmation a été posée APRÈS la dernière correction ; les MOTS DE LA PERSONNE
 * (sa transcription — jamais la reformulation du modèle vocal) disent un « oui » explicite. Pour une carte renforcée, la
 * voix a RELU l'élément clé dans le récit qui précède la question (K9, décision 0039 : pas de mot imposé). Puis la MÊME garde que le bouton
 * (`confirmerCarte` → `executerIntention` : idempotence, arrêt d'urgence, porte, famille). Au journal : « confirmé à
 * l'oral », avec la transcription.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const DUREE_CARTE_ORALE_MS = 30 * 60_000;

interface EvenementOral { status?: string; at?: string; etape?: string; fields?: unknown; recit?: string; transcription?: string }

const evenements = (v: unknown): EvenementOral[] => (Array.isArray(v) ? (v as EvenementOral[]) : []);
const estVoix = (e: EvenementOral, etape?: string) => e.status === "VOIX" && (!etape || e.etape === etape);

async function ajouterEvenement(intentId: string, e: EvenementOral): Promise<void> {
  const i = await prisma.assistantActionIntent.findUnique({ where: { id: intentId }, select: { events: true } });
  await prisma.assistantActionIntent.update({ where: { id: intentId }, data: { events: [...evenements(i?.events), { ...e, at: new Date().toISOString() }] as object[] } });
}

/**
 * Une carte rendue par la délégation vocale devient une carte ORALE (ses champs, tels que l'écran les montre). Elle
 * REMPLACE la carte orale précédente encore à signer (une demande Ad & Pro corrigée se repropose en entier) : la
 * précédente est retirée, comme une carte caduque.
 */
export async function ouvrirCarteOrale(intentId: string, fields: ChampOral[], facultatifsDejaProposes = false, remplace: string | null = null): Promise<void> {
  if (remplace && remplace !== intentId) {
    const i = await prisma.assistantActionIntent.findUnique({ where: { id: remplace }, select: { events: true } });
    await prisma.assistantActionIntent.updateMany({
      where: { id: remplace, status: "PROPOSED" },
      data: { status: "CANCELLED", decidedAt: new Date(), events: [...evenements(i?.events), { status: "CANCELLED_SUPERSEDED", at: new Date().toISOString() }] as object[] },
    });
  }
  await ajouterEvenement(intentId, { status: "VOIX", etape: "CARTE", fields });
  if (facultatifsDejaProposes) await ajouterEvenement(intentId, { status: "VOIX", etape: "FACULTATIFS" });
}

interface CarteOraleLue { id: string; carte: CarteOrale; facultatifsProposes: boolean; questionPosee: boolean }

/** La carte orale en attente de CETTE personne — la dernière, encore à signer, de moins de 30 minutes. */
export async function carteOraleEnAttente(user: CurrentUser): Promise<CarteOraleLue | null> {
  const i = await prisma.assistantActionIntent.findFirst({
    where: { userId: user.id, status: "PROPOSED", proposedAt: { gte: new Date(Date.now() - DUREE_CARTE_ORALE_MS) } },
    orderBy: { proposedAt: "desc" },
    select: { id: true, title: true, level: true, confirmText: true, payload: true, events: true },
  });
  const evts = evenements(i?.events);
  if (!i || !evts.some((e) => estVoix(e, "CARTE")) || evts.some((e) => estVoix(e, "REFUS"))) return null;
  const champs = [...evts].reverse().find((e) => Array.isArray(e.fields))?.fields as ChampOral[] | undefined;
  const dernier = (pred: (e: EvenementOral) => boolean) => evts.reduce((n, e, k) => (pred(e) ? k : n), -1);
  const question = dernier((e) => estVoix(e, "QUESTION"));
  const correction = dernier((e) => e.status === "CORRECTED");
  const facultatifs = estChargeCapacite(i.payload) ? facultatifsDeCapacite(i.payload) : estChargeOperationIA(i.payload) ? facultatifsDOperation(i.payload) : [];
  return {
    id: i.id,
    carte: { titre: i.title, champs: champs ?? [], facultatifs, manquants: [], elementCle: i.level === "CRITICAL" ? i.confirmText : null },
    facultatifsProposes: evts.some((e) => estVoix(e, "FACULTATIFS")),
    questionPosee: question > correction,
  };
}

/** Ce que la voix dit MAINTENANT de la carte orale — et l'étape notée au journal de l'intention. */
export async function direLaCarte(c: CarteOraleLue): Promise<string> {
  const etape = etapeOrale(c.carte, c.facultatifsProposes);
  if (etape === "FACULTATIFS") await ajouterEvenement(c.id, { status: "VOIX", etape: "FACULTATIFS" });
  if (etape === "QUESTION") await ajouterEvenement(c.id, { status: "VOIX", etape: "QUESTION", recit: recitDeCarte(c.carte) });
  return texteOral(c.carte, etape);
}

export type IssueOrale =
  | { suite: "repondu"; pourVoix: string; execute?: boolean }
  /** La parole n'est ni un oui, ni un non, ni « rien à ajouter » : c'est une réponse ou une correction, pour l'assistant. */
  | { suite: "assistant" };

/**
 * LA PAROLE DE LA PERSONNE face à sa carte orale — avant tout appel de modèle : confirmer, refuser, ou passer au récit.
 * `parole` = SES mots transcrits depuis la question (vide : rien n'est confirmé).
 */
export async function traiterParoleSurCarte(user: CurrentUser, c: CarteOraleLue, parole: string): Promise<IssueOrale> {
  const dit = (parole ?? "").trim();
  if (c.questionPosee && dit) {
    if (estNonExplicite(dit)) {
      await ajouterEvenement(c.id, { status: "VOIX", etape: "REFUS", transcription: dit.slice(0, 500) });
      return { suite: "repondu", pourVoix: "La personne ne confirme pas : dis-lui simplement que rien n'est envoyé ; elle peut redemander la même chose plus tard." };
    }
    // K9 (décision 0039) : pas de mot imposé — l'élément clé d'une carte renforcée a été RELU par la voix dans le récit
    // (`texteOral`, étape QUESTION) ; un oui sans réserve suffit, la ressaisie stockée est fournie par le serveur.
    if (estOuiExplicite(dit)) return confirmerALOral(user, c, dit);
  }
  if (!c.questionPosee && c.facultatifsProposes && estRienAAjouter(dit)) return { suite: "repondu", pourVoix: await direLaCarte(c) };
  return { suite: "assistant" };
}

/** LA CONFIRMATION ORALE — la garde du bouton, puis le journal « confirmé à l'oral » avec la transcription. */
async function confirmerALOral(user: CurrentUser, c: CarteOraleLue, transcription: string): Promise<IssueOrale> {
  const r = await confirmerCarte(user, c.id, c.carte.elementCle ?? undefined);
  await ajouterEvenement(c.id, { status: "VOIX", etape: r.ok ? "CONFIRMEE" : "ECHEC", transcription: transcription.slice(0, 500) }).catch(sansBloquer("carte-orale.confirmation.journal"));
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Assistant IA",
    summary: `Carte « ${c.carte.titre} » confirmée à l'oral${r.ok ? "" : " — non exécutée"} · transcription : « ${transcription.slice(0, 300)} »`,
  });
  return r.ok
    ? { suite: "repondu", execute: true, pourVoix: `C'est fait : ${r.message ?? c.carte.titre}. Annonce-le simplement, en une phrase, et dis qu'elle peut dire « annule » si elle change d'avis.` }
    : { suite: "repondu", pourVoix: `L'action n'a pas été exécutée : ${r.error ?? "raison inconnue"}. Dis-le simplement.` };
}
