/**
 * LES AIDES DE L'EXÉCUTION — le résultat d'une action confirmée, le contexte passé à chaque
 * famille, et les petites normalisations (compte actif, référence, priorité, date).
 */

import { type Priority, prisma, buildRef, type CurrentUser } from "@/lib/assistant/coeur/erp";
import type { AssistantActionPayload } from "@/lib/assistant/coeur/contrat-actions";

// ───────────────────────────── Exécution (après confirmation) ─────────────────────────────

export interface ExecuteResult {
  ok: boolean;
  message?: string;
  link?: string;
  error?: string;
  /** Chemins à revalider — appliqués par le wrapper « use server ». */
  revalidate?: string[];
  /** Id de l'entité créée — le maillon du chaînage `$prev.id` des plans d'action. */
  createdId?: string;
}

export async function activeUserId(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } });
  return u && u.isActive ? u.id : null;
}

/** Référence ROBUSTE (dérivée du maximum réel, jamais `count()+1` qui entre en collision après une
 *  suppression → violation d'unicité → « L'action n'a pas pu être exécutée »). */
export async function nextRequestRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.administrativeRequest.findMany({
    where: { reference: { startsWith: `REQ-${year}-` } },
    select: { reference: true },
  });
  return buildRef("REQ", year, refs.map((r) => r.reference));
}

export function priorityOf(p: string | null | undefined): Priority {
  const up = (p ?? "").toUpperCase();
  return (["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).includes(up as Priority) ? (up as Priority) : "MEDIUM";
}

export function dateValue(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * CE QUE `performAction` PASSE À CHAQUE FAMILLE — la personne, la charge confirmée, et
 * `performAction` lui-même : un lot ou un plan rejoue chacun de ses éléments par la même porte.
 */
export interface ContexteExecution {
  user: CurrentUser;
  payload: AssistantActionPayload;
  performAction: (user: CurrentUser, payload: AssistantActionPayload) => Promise<ExecuteResult>;
}
