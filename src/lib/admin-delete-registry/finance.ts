/**
 * Registre des suppressions — les entrées : l'écriture de finance, l'ordre de dépense, la demande de paiement, le fournisseur.
 * Un morceau CONTIGU de `DELETE_REGISTRY`, dans l'ordre du registre (`registre.ts` les recompose
 * dans cet ordre : `DELETABLE_KINDS` en dépend).
 */

import { prisma } from "@/lib/prisma";
import { refusSuppressionDemandePaiement } from "@/modules/finances/api";
import type { DeletableKind, KindSpec } from "./types";

export const REGISTRE_FINANCE = {
  FINANCE_TRANSACTION: {
    label: "écriture comptable",
    module: "Finances",
    redirect: "/finances",
    model: "financeTransaction",
    entityType: "FINANCE_TRANSACTION",
    searchFields: ["reference", "label"],
    async describe(id) {
      const r = await prisma.financeTransaction.findUnique({ where: { id }, select: { reference: true, label: true } });
      return r ? `${r.reference} — ${r.label}` : null;
    },
    async remove(id) {
      await prisma.financeTransaction.delete({ where: { id } });
    },
    // UN LOT (§118.176) — « supprime carrément ça, une ou plusieurs » (Direction, 01/10, sur les
    // écritures « à imputer »). Supprimée seule, une écriture laissait derrière elle ce qui la
    // CITE : la facture qu'elle règle (clé mise à vide, jamais rétablie à la restauration), l'ordre
    // de dépense, la dotation de caisse ou le bulletin qui la nomment par un champ texte (qui
    // désignaient alors une écriture disparue). En lot, ces liens sont vidés ensemble, NOMMÉS
    // avant le clic (« ce qui reste mais perd son lien »), et rétablis si on la restaure.
    lot: true,
  },
  EXPENSE_ORDER: {
    label: "ordre de dépense",
    module: "Finances",
    redirect: "/finances/paiements-a-faire",
    model: "expenseOrder",
    entityType: "EXPENSE_ORDER",
    searchFields: ["reference", "label"],
    async describe(id) {
      const r = await prisma.expenseOrder.findUnique({ where: { id }, select: { reference: true, label: true } });
      return r ? `${r.reference} — ${r.label}` : null;
    },
    async remove(id) {
      await prisma.expenseOrder.delete({ where: { id } });
    },
  },
  /**
   * UNE DEMANDE DE PAIEMENT RETIRÉE (Direction, 19/10/2026) — elle part EN LOT : son ordre de dépense annulé (sinon une
   * ligne orpheline au registre des ordres), ses pièces et son fil, et tout revient ensemble à la restauration. Le
   * refus (`refusDeSuppression`) garde le dossier vivant, le compagnon et tout paiement déjà sorti.
   */
  PAYMENT_REQUEST: {
    label: "demande de paiement",
    module: "Demandes de paiement",
    redirect: "/validations/paiements",
    model: "paymentRequest",
    entityType: "PAYMENT_REQUEST",
    searchFields: ["reference", "title"],
    refuse: (id) => refusSuppressionDemandePaiement(id),
    async describe(id) {
      const r = await prisma.paymentRequest.findUnique({ where: { id }, select: { reference: true, title: true } });
      return r ? `${r.reference} — ${r.title}` : null;
    },
    async creatorOf(id) {
      const r = await prisma.paymentRequest.findUnique({ where: { id }, select: { requesterId: true } });
      return r?.requesterId ?? null;
    },
    async remove(id) {
      await prisma.paymentRequest.delete({ where: { id } });
    },
    lot: true,
  },
  SUPPLIER: {
    label: "fournisseur",
    module: "Administration",
    redirect: "/admin/suppliers",
    model: "supplier",
    entityType: "SUPPLIER",
    searchFields: ["name"],
    async describe(id) {
      const r = await prisma.supplier.findUnique({ where: { id }, select: { name: true } });
      return r ? r.name : null;
    },
    async remove(id) {
      await prisma.supplier.delete({ where: { id } });
    },
  },
} satisfies Partial<Record<DeletableKind, KindSpec>>;
