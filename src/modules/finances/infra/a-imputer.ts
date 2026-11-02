import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « À IMPUTER » — les dépenses qui n'ont pas encore trouvé leur catégorie, et elles seules (§118.176).
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * La liste comptait toute écriture de sortie sans catégorie. Elle comptait donc les REMISES et les
 * RALLONGES de caisse d'avance — la Direction les y a trouvées, au milieu des factures : « Caisse
 * d'avance — Administration (octobre 2026) », FIN-2026-121, 24 000 DZD, « Imputer à… ». Or ces
 * écritures ne sont pas des dépenses : l'argent change de tiroir, de la banque vers la caisse, et
 * chaque achat fait ensuite sur la caisse s'impute à SON budget, ticket par ticket. Imputer la
 * remise aussi compterait le même dinar deux fois — l'erreur que le registre des chemins de
 * paiement nomme (`petty-cash-expense`). Elles restaient donc « à imputer » pour toujours, et la
 * liste qui devait dire « voici ce qu'il reste à ranger » mentait de leur montant.
 *
 * ── CE QUI RESTE AU LIVRE ───────────────────────────────────────────────────────────────────
 *
 * Tout. On ne retire rien de la trésorerie : ces sorties sont réelles, et les comptes de trésorerie
 * les comptent. On les retire seulement d'une liste de TRAVAIL qui n'avait rien à leur demander.
 *
 * ── LE LIEN, PAS LE LIBELLÉ ─────────────────────────────────────────────────────────────────
 *
 * Une écriture est une remise parce qu'une remise la NOMME (`PettyCashAllotment.transactionId`,
 * `PettyCashTopUpRequest.transactionId`) — jamais parce que son libellé commence par « Caisse
 * d'avance » : un libellé se tape, et une facture de caissier ainsi nommée disparaîtrait de la liste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les écritures qui alimentent une caisse d'avance — remises et rallonges, par leur lien. */
export async function versementsDeCaisse(): Promise<string[]> {
  const [remises, rallonges] = await Promise.all([
    prisma.pettyCashAllotment.findMany({ where: { transactionId: { not: null } }, select: { transactionId: true } }),
    prisma.pettyCashTopUpRequest.findMany({ where: { transactionId: { not: null } }, select: { transactionId: true } }),
  ]);
  return [...remises, ...rallonges].map((r) => r.transactionId).filter((id): id is string => Boolean(id));
}

/**
 * LA CLAUSE DE LA LISTE « À IMPUTER » — une sortie, sans catégorie, dans la période, qui n'alimente
 * pas une caisse. Lue par le TOTAL et par la LISTE : deux clauses écrites à la main finiraient par
 * ne plus compter la même chose, et le total ne correspondrait plus aux lignes affichées.
 *
 * `notIn: []` ne filtre rien (un `NOT IN` vide est vrai partout — mesuré, §118.116) : sans aucune
 * caisse, la liste est exactement celle d'avant.
 */
export async function clauseAImputer(from: Date, to: Date, opts: { societeId?: string | null } = {}): Promise<Prisma.FinanceTransactionWhereInput> {
  return {
    direction: "OUT",
    budgetCategoryId: null,
    date: { gte: from, lte: to },
    id: { notIn: await versementsDeCaisse() },
    // L'ENVELOPPE D'UNE SOCIÉTÉ ne montre que les dépenses de CETTE société, et celles qui n'en ont encore aucune
    // (Direction, 06/10 : « il se peut que cette dépense concerne une autre société ») — la changer de société la
    // retire de cette liste.
    ...(opts.societeId ? { OR: [{ companyId: opts.societeId }, { companyId: null }] } : {}),
  };
}
