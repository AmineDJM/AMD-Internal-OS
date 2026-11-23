import { prisma } from "@/lib/prisma";
import { OBJET_DECISION_INFO_MED } from "@/lib/medical-info/decideur";

/**
 * APRÈS LA DÉCISION DU DIRECTEUR DES OPÉRATIONS, LE PHARMACIEN SAIT QUOI FAIRE (Direction, 23/11/2026).
 *
 * « Validation acceptée », vers la demande de validation, sans un mot de la suite : le pharmacien devait deviner qu'il
 * fallait maintenant déposer à l'ANPP, et retrouver le dossier. La notification mène au DOSSIER, et dit le geste suivant
 * (le pendant de la pré-validation d'un BC, `OBJET_PREVALIDATION_BC`). `null` hors de l'information médicale.
 */
export async function suiteDecisionInfoMed(
  req: { id: string; objectType: string | null; entityId: string | null },
  statut: string,
): Promise<{ suite: string; lien: string } | null> {
  if (req.objectType !== OBJET_DECISION_INFO_MED || !req.entityId) return null;
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { id: req.entityId }, select: { id: true, declareValidationId: true, declareIntent: true, bvValidationId: true },
  });
  if (!decl) return null;
  const lien = `/information-medicale/${decl.id}`;
  if (statut !== "APPROVED") return { suite: " Reprenez-la depuis le dossier (ou « À faire — Information médicale »).", lien };
  if (decl.declareValidationId === req.id) {
    return {
      suite: decl.declareIntent === "SKIP"
        ? " Sans déclaration : validez le dossier — il part chez le Directeur des Opérations pour la validation finale."
        : " Déposez la déclaration à l'ANPP, enregistrez la référence, puis validez.",
      lien,
    };
  }
  if (decl.bvValidationId === req.id) return { suite: " Dépôt des bons accordé : demandez le paiement de chaque quittance depuis le dossier.", lien };
  return { suite: "", lien };
}
