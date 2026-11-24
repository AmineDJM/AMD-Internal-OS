import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { toNumber, formatCurrency } from "@/lib/utils";
import { posteDeLOrdre } from "@/lib/labels";
import {
  CENTRAL_STATUS_LABEL, dossierHrefByOrder, regleDeJustificatif, titreJoindreJustificatif, visibleToFinance, type CentralStatus,
} from "@/modules/finances/api";
import type { ActionItem } from "./action-center";

/**
 * « MON ESPACE » — JOINDRE LE JUSTIFICATIF (Super Admin, 24/11/2026). Sorti du centre d'actions (plafond de taille).
 *
 * Un ordre sans justificatif ne va ni au centre de paiement ni aux Finances : il attend chez celui qui l'a émis — le
 * demandeur, les RH pour la paie, les Moyens généraux pour la caisse. Sans cette ligne, l'ordre attendait EN SILENCE :
 * la notification se perd, et personne d'autre ne le voit. La ligne ouvre le dossier de paiement, où la pièce se joint ;
 * jointe, l'ordre entre seul au centre (`libererLesOrdresJustifies`).
 */

/** Les autorisations que les Finances voient — le prédicat `visibleToFinance`, jamais une liste recopiée. */
export const STATUTS_VUS_DES_FINANCES = (Object.keys(CENTRAL_STATUS_LABEL) as CentralStatus[]).filter(visibleToFinance);

const PLAFOND = 30;

export async function lignesJustificatifsAJoindre(user: SessionUser): Promise<ActionItem[]> {
  // L'achat du secrétariat : l'ordre est émis au nom du valideur qui l'accorde, mais la pièce est chez l'assistante qui
  // tient la demande (et chez son demandeur) — la ligne leur revient aussi.
  const demandes = (await prisma.administrativeRequest.findMany({
    where: { OR: [{ assignedToId: user.id }, { requesterId: user.id }], status: { notIn: ["DONE", "CANCELLED"] } },
    select: { id: true }, take: 200,
  })).map((d) => d.id);
  const ordres = await prisma.expenseOrder.findMany({
    where: {
      centralStatus: "AWAITING_PROOF", status: "PENDING",
      OR: [{ requestedById: user.id }, ...(demandes.length ? [{ sourceType: "ADMIN_REQUEST" as const, sourceId: { in: demandes } }] : [])],
    },
    orderBy: { createdAt: "asc" }, take: PLAFOND,
    select: { id: true, reference: true, label: true, amount: true, beneficiary: true, createdAt: true, category: true, sourceType: true, sourceId: true },
  });
  if (ordres.length === 0) return [];
  const dossiers = await dossierHrefByOrder(ordres.map((o) => o.id));
  return ordres.map((o) => ({
    key: `justif-${o.id}`, objet: `EXPENSE_ORDER:${o.id}`,
    title: titreJoindreJustificatif(o),
    subtitle: `${formatCurrency(toNumber(o.amount))} · ${regleDeJustificatif(o.sourceType).service} — sans justificatif, il n'entre pas au centre de paiement`,
    // L'achat du secrétariat se justifie sur SA fiche (devis, proforma, facture) ; les autres, au dossier de paiement.
    module: "Paiements", href: o.sourceType === "ADMIN_REQUEST" && o.sourceId ? `/demandes/${o.sourceId}` : dossiers.get(o.id) ?? "/validations/paiements", kind: "request" as const, priority: "HIGH",
    deadline: null, depuis: o.createdAt.toISOString(), owner: o.beneficiary ?? "",
    statusLabel: "Justificatif à joindre", statusTone: "warning" as const,
    montant: toNumber(o.amount), famille: posteDeLOrdre(o.category, o.sourceType),
  }));
}
