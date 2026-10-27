import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CENTRAL_STATUS_LABEL, visibleToFinance, type CentralStatus } from "@/lib/payments/authorization";

/**
 * LES ORDRES QUE VOIENT LES FINANCES — la file à régler, ENTIÈRE, et l'historique, borné.
 *
 * ── LE DÉFAUT QU'ON CORRIGE (audit argent 2026-10-27, ARGENT-03) ────────────────────────────
 *
 * L'écran lisait les 300 ordres les plus RÉCENTS, tous états confondus (en attente du centre, réglés,
 * annulés), puis gardait ceux que les Finances voient. Un ordre AUTORISÉ mais plus ancien que les 300
 * derniers sortait donc de « à régler » sans que personne le décide : ni ligne, ni total, ni bouton
 * « Régler » — alors que le « Montant à régler » de la trésorerie (`chargerTresorerie`, sans borne) le
 * comptait encore. Plus l'historique grossissait, plus la file perdait ses paiements les plus anciens,
 * c'est-à-dire les plus en retard.
 *
 * La file OUVERTE n'a donc pas de borne : un paiement dû ne disparaît jamais d'un écran parce que
 * d'autres ont été créés après lui. Seul l'historique (réglés, annulés) est borné.
 */
export const HISTORIQUE_MAX = 300;

/** Les autorisations que les Finances voient — le prédicat `visibleToFinance`, jamais une liste recopiée. */
export const STATUTS_CENTRE_VISIBLES_FINANCES = (Object.keys(CENTRAL_STATUS_LABEL) as CentralStatus[]).filter(visibleToFinance);

const AVEC_DEMANDEUR = { requestedBy: { select: { name: true } } } as const;

export async function chargerOrdresDesFinances(portee: Prisma.ExpenseOrderWhereInput) {
  const visibles = { centralStatus: { in: STATUTS_CENTRE_VISIBLES_FINANCES } };
  const [ouverts, historique] = await Promise.all([
    prisma.expenseOrder.findMany({
      where: { AND: [portee, visibles, { status: "PENDING" }] },
      orderBy: { createdAt: "desc" },
      include: AVEC_DEMANDEUR,
    }),
    prisma.expenseOrder.findMany({
      where: { AND: [portee, visibles, { status: { in: ["PAID", "CANCELLED"] } }] },
      orderBy: { createdAt: "desc" },
      include: AVEC_DEMANDEUR,
      take: HISTORIQUE_MAX,
    }),
  ]);
  return [...ouverts, ...historique];
}
