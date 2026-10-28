"use server";

import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { BUDGET_COOKIE } from "@/lib/budget-scope";

const MAX_AGE = 60 * 60 * 24 * 180;

/**
 * Retient l'enveloppe budgétaire choisie, pour la retrouver au prochain passage.
 *
 * On vérifie que l'enveloppe existe avant de la mémoriser : un cookie forgé ne doit pas faire
 * afficher une enveloppe inexistante à chaque ouverture. Le contrôle de DROIT reste fait par
 * `getBudgetOverview`, qui borne déjà aux enveloppes ouvertes à la personne — ce cookie n'est
 * qu'une préférence d'affichage, il n'ouvre aucun accès.
 */
export async function rememberBudgetEnvelope(envelopeId: string): Promise<void> {
  await requireUser();
  if (!envelopeId) return;
  const exists = await prisma.budgetEnvelope.count({ where: { id: envelopeId } }).catch(() => 0);
  if (!exists) return;
  (await cookies()).set(BUDGET_COOKIE, envelopeId, { path: "/", maxAge: MAX_AGE, sameSite: "lax", httpOnly: true });
}
