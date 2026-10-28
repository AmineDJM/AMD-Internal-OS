/**
 * LA PROVENANCE PERSISTÉE — une ligne par tour, relue en une requête indexée (F8).
 *
 * La lecture est bornée (six tours au plus) et cloisonnée par personne : `userId` n'est pas un
 * filtre de commodité, c'est la clé de droits. Le fil, quand il est connu, resserre encore ;
 * s'il ne rend rien (premier tour d'un fil, mémoire coupée), on retombe sur la personne seule.
 *
 * L'écriture n'est JAMAIS bloquante : perdre la provenance d'un tour coûte une réponse « je n'ai
 * rien lu » ; faire échouer le tour pour la consigner coûterait la réponse elle-même.
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  ancresNominales, ancresNumeriques, repondreProvenance, LIMITE_FAITS_PAR_TOUR, type FaitSource, type TourProvenance,
} from "@/lib/fabric/provenance";
import { sansBloquer } from "@/lib/journal";

const RETENTION_MS = 30 * 86_400_000;

export async function consignerProvenance(args: {
  userId: string; threadId?: string | null; turnId?: string | null; question?: string | null; faits: readonly FaitSource[];
}): Promise<{ id: string | null; nombre: number }> {
  const faits = args.faits.slice(0, LIMITE_FAITS_PAR_TOUR);
  try {
    const row = await prisma.assistantProvenance.create({
      data: {
        userId: args.userId, threadId: args.threadId ?? null, turnId: args.turnId ?? null,
        question: args.question ? args.question.slice(0, 200) : null,
        faits: faits as unknown as Prisma.InputJsonValue, nombre: faits.length,
      },
      select: { id: true },
    });
    // Hygiène : au-delà de trente jours, la provenance d'un tour n'a plus de lecteur.
    void prisma.assistantProvenance
      .deleteMany({ where: { userId: args.userId, createdAt: { lt: new Date(Date.now() - RETENTION_MS) } } })
      .catch(sansBloquer("provenance-store.consignerProvenance.assistantProvenance"));
    return { id: row.id, nombre: faits.length };
  } catch (e) {
    console.error("[provenance] consignation impossible (non bloquant)", e);
    return { id: null, nombre: faits.length };
  }
}

export async function relireProvenance(
  userId: string,
  opts: { threadId?: string | null; tours?: number } = {},
): Promise<TourProvenance[]> {
  const take = Math.min(Math.max(opts.tours ?? 6, 1), 20);
  const lire = (threadId: string | null) => prisma.assistantProvenance.findMany({
    where: { userId, ...(threadId ? { threadId } : {}) },
    orderBy: { createdAt: "desc" }, take,
    select: { faits: true, question: true, createdAt: true },
  });
  let rows = await lire(opts.threadId ?? null);
  if (rows.length === 0 && opts.threadId) rows = await lire(null);
  return rows.map((r) => ({
    faits: Array.isArray(r.faits) ? (r.faits as unknown as FaitSource[]) : [],
    question: r.question, createdAt: r.createdAt,
  }));
}

/**
 * « D'OÙ TU TIENS ÇA ? », de bout en bout : une lecture indexée, puis la composition pure.
 *
 * Sans ancre (nombre, nom) dans la question, seul le DERNIER tour compte — même s'il n'a rien
 * lu : citer un tour plus ancien à la place du dernier, ce serait mentir sur la source de la
 * dernière réponse. Avec une ancre, on remonte sur les tours récents jusqu'à la trouver.
 */
export async function repondreDouTuTiensCa(
  userId: string,
  question: string,
  opts: { threadId?: string | null } = {},
): Promise<{ texte: string; faits: FaitSource[]; trouve: boolean; cible: "ancre" | "dernier_tour" | "aucun"; ms: number; toursLus: number }> {
  const t0 = Date.now();
  const tours = await relireProvenance(userId, { threadId: opts.threadId, tours: 6 });
  const ancre = ancresNumeriques(question).length + ancresNominales(question).length > 0;
  const r = repondreProvenance({ question, tours: ancre ? tours : tours.slice(0, 1) });
  return { ...r, ms: Date.now() - t0, toursLus: tours.length };
}
