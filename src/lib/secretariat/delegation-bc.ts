import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { commandeLaDemande, gereLaDemande } from "@/lib/secretariat/droits";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODIFIER LE BC D'UNE DEMANDE AU SECRÉTARIAT DEPUIS LA DEMANDE (Direction, 14/10/2026).
 *
 * « Modification et révision possibles du BC ultra complètes. » Le BC qu'un demandeur génère au Bureau du secrétariat se
 * révise depuis la fiche de SA demande, avec le composeur de la fiche Legal (`ReviserPieceButton` → `reviserPieceCommerciale`)
 * — sans droit d'écriture Legal : c'est la DEMANDE qui délègue, comme le poste délègue pour un BC Ad & Pro. Hors d'ici, il
 * fallait l'annuler dans Legal et recommencer.
 *
 * La délégation n'existe que pour : un bon de commande dont la SOURCE est une demande au secrétariat, NON SIGNÉ (signé, il ne
 * se modifie plus que par Legal, qui le remplace avec les Finances), d'une demande OUVERTE, et pour son demandeur (ou le Super
 * Admin) ou qui gère la demande. `null` : pas de délégation — les droits Legal ordinaires s'appliquent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function delegationDuBcDeLaDemande(
  user: SessionUser, legalDocumentId: string | null,
  /** SIGNÉ, la délégation ne couvre plus qu'un changement de NUMÉRO SEUL (Direction, 14/10/2026) — jugé au serveur par l'appelant. */
  opts: { numeroSeul?: () => Promise<boolean> } = {},
): Promise<string | null> {
  if (!legalDocumentId) return null;
  const doc = await prisma.legalDocument.findUnique({
    where: { id: legalDocumentId },
    select: { kind: true, sourceType: true, sourceId: true, signedAt: true, status: true },
  });
  if (!doc || doc.kind !== "PURCHASE_ORDER" || doc.sourceType !== "ADMIN_REQUEST" || !doc.sourceId || doc.status !== "ACTIVE") return null;
  if (doc.signedAt && !(opts.numeroSeul && (await opts.numeroSeul()))) return null;
  const req = await prisma.administrativeRequest.findFirst({
    where: { id: doc.sourceId, deletedAt: null },
    select: { reference: true, status: true, requesterId: true, assignedToId: true },
  });
  if (!req || req.status === "DONE" || req.status === "CANCELLED") return null;
  const demandeur = commandeLaDemande(user, req);
  if (!demandeur && !gereLaDemande(user, req)) return null;
  return `${req.reference} — bon de commande de la demande au secrétariat, modifié depuis la demande par ${demandeur ? "son demandeur" : "qui la gère"}`;
}
