import { validateAttachments } from "@/lib/attach-files";
import { persistUploadedDocument } from "@/lib/documents";

/**
 * LA FACTURE JOINTE DANS LA FENÊTRE « TERMINER » (refonte du bureau, 10/2026) — « la facture et
 * l'imputation au budget sont demandées dans la même fenêtre ». Le fichier est rangé parmi les
 * pièces de la demande, dans la case « Facture » : c'est là que la règle de fin d'un achat
 * (`ficheAFacture`) la cherche déjà. Rend le refus, ou `null`.
 */
export async function joindreFactureALaDemande(userId: string, requestId: string, fichier: File): Promise<string | null> {
  const refus = await validateAttachments([fichier]);
  if (refus) return refus;
  const depot = await persistUploadedDocument(userId, { entityType: "ADMIN_REQUEST", entityId: requestId, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: fichier });
  return depot.ok ? null : `La facture n'a pas pu être enregistrée (${depot.error ?? "erreur"}) : la demande n'est pas terminée.`;
}
