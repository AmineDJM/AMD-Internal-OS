import { prisma } from "@/lib/prisma";

/**
 * PRISE EN CHARGE — L'ENVOI AUX FINANCES LAISSE UNE TRACE QU'ON RELIT (Direction, 27/10).
 *
 * « Transmettre aux Finances » n'écrit aucun statut : il prévient les Finances et le journal d'audit le garde.
 * « Marquer réalisée » ne s'ouvre qu'APRÈS cet envoi : on relit donc le journal. L'entrée d'envoi porte
 * désormais le champ `ENVOI_FINANCES_CHAMP` ; les envois plus anciens ne portaient que leur phrase, relue
 * telle quelle (rien n'est réécrit dans le journal).
 */
export const ENVOI_FINANCES_CHAMP = "careSentToFinance";
export const ENVOI_FINANCES_RESUME = "Dossier complet transmis aux Finances.";

const MODULE = { NATIONAL: "CONGRESS_NATIONAL", INTERNATIONAL: "CONGRESS_INTERNATIONAL" } as const;

/** La date du PREMIER envoi aux Finances de cette prise en charge, ou `null` si elle n'est jamais partie. */
export async function envoiAuxFinances(scope: "NATIONAL" | "INTERNATIONAL", requestId: string): Promise<Date | null> {
  const e = await prisma.auditLog.findFirst({
    where: {
      entityType: MODULE[scope], entityId: requestId,
      OR: [{ field: ENVOI_FINANCES_CHAMP }, { summary: ENVOI_FINANCES_RESUME }],
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  return e?.createdAt ?? null;
}
