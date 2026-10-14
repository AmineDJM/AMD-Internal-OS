import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { verifierFacturesAvantDepot, marquerDoublonPossible } from "@/lib/factures/connues";
import type { FactureDejaConnue } from "@/lib/factures/blocage-vue";

/**
 * LA FACTURE JOINTE DANS LA FENÊTRE « TERMINER » (refonte du bureau, 10/2026) — « la facture et
 * l'imputation au budget sont demandées dans la même fenêtre ». Le fichier est rangé parmi les
 * pièces de la demande, dans la case « Facture » : c'est là que la règle de fin d'un achat
 * (`ficheAFacture`) la cherche déjà. Rend le refus, ou `null`.
 *
 * UNE FACTURE DÉJÀ CONNUE AILLEURS (Direction, 14/10/2026) — déjà dans une demande de paiement, un poste Ad & Pro, le
 * registre — n'est pas rangée une seconde fois : refus avec la relance comme seul geste. Un doublon seulement probable
 * est rangé, et marqué sur les ordres de dépense de la demande.
 */
export async function joindreFactureALaDemande(
  user: SessionUser, requestId: string, fichier: File,
): Promise<{ error: string; factureConnue?: FactureDejaConnue } | null> {
  const refus = await validateAttachments([fichier]);
  if (refus) return { error: refus };
  const garde = await verifierFacturesAvantDepot(user, [{ octets: Buffer.from(await fichier.arrayBuffer()), nom: fichier.name }], {
    instances: [`FICHE:ADMIN_REQUEST:${requestId}`],
  });
  if (!garde.ok) return { error: garde.error, factureConnue: garde.factureConnue };
  const depot = await persistUploadedDocument(user.id, { entityType: "ADMIN_REQUEST", entityId: requestId, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: fichier });
  if (!depot.ok) return { error: `La facture n'a pas pu être enregistrée (${depot.error ?? "erreur"}) : la demande n'est pas terminée.` };
  if (garde.probables.length > 0) {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: requestId, status: { not: "CANCELLED" } }, select: { id: true } });
    for (const p of garde.probables) await marquerDoublonPossible({ marque: p.marque, ordreIds: ordres.map((o) => o.id), acteurId: user.id });
  }
  return null;
}
