/**
 * INFORMATION MÉDICALE — deux lectures du circuit : qui PORTE la dépense d'un événement déclaré (l'ordre global
 * ou ses postes), et la demande de validation adressée au(x) décideur(s) du PRIM.
 *
 * Sorti de `actions/medical-info-actions.ts` (lot V4). Aucune écriture en base directe : la demande de
 * validation passe par l'écrivain commun (`createDirectValidation`).
 */
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createDirectValidation } from "@/lib/validation";
import { postesPortantLaDepense } from "@/lib/workflow/engine";
import { noteDecideurs, OBJET_DECISION_INFO_MED, type DecideursInfoMed } from "@/lib/medical-info/decideur";
import { PATH } from "./acces";

/**
 * QUI PORTE LA DÉPENSE D'UN ÉVÉNEMENT DÉCLARÉ ? — l'ordre GLOBAL, ou ses POSTES (§118.151).
 *
 * La Direction émettait ici un ordre de dépense du montant de la déclaration, sans regarder les
 * postes. Or un poste émet sa PROPRE pièce (BC, puis facture, puis ordre) : une opération ventilée
 * payait donc deux fois la même dépense — une fois par l'ordre global, une fois par ses postes.
 * Le moteur de circuit s'en gardait déjà dans son autre branche (pas de pharmacien, `emitFinancials`) ;
 * celle-ci ne s'en gardait pas, et depuis que chaque sponsoring naît avec son poste, le défaut
 * serait devenu SYSTÉMATIQUE.
 *
 * Deux faits font dire « les postes » :
 *   · des postes non refusés existent — la lecture est celle du moteur (`postesPortantLaDepense`),
 *     pas un second comptage qui divergerait ;
 *   · le sponsoring suit la règle de la TENUE : pré-validé ou clôturé par sa validation finale. Là,
 *     le montant déclaré n'est qu'une ESTIMATION — l'argent se décide poste par poste —, et un ordre
 *     bâti dessus serait un ordre sur un montant que personne n'a accordé. Même si tous ses postes
 *     ont été refusés : c'est alors qu'il n'y a RIEN à payer, pas qu'il faut payer l'estimation.
 *
 * Aucune erreur n'est rattrapée : une lecture qui échoue fait échouer la validation, qui se refait
 * d'un clic. Se tromper dans l'autre sens émettrait un ordre de trop — de l'argent qui sort.
 */
export async function laDepenseEstPorteeParLesPostes(sourceType: EntityType, sourceId: string): Promise<boolean> {
  if (sourceType === "SPONSORING") {
    const s = await prisma.sponsoringRequest.findUnique({ where: { id: sourceId }, select: { status: true, closedAt: true } });
    if (s && (s.status === "PRE_VALIDATED" || s.closedAt != null)) return true;
  }
  return (await postesPortantLaDepense(sourceType, sourceId)).nombre > 0;
}

/**
 * LA DEMANDE DE VALIDATION D'UN GESTE DU PRIM — adressée au(x) Directeur(s) des Opérations.
 *
 * Tous les comptes saisis EN MÊME TEMPS (`PARALLEL`), et l'accord du premier qui tranche vaut pour
 * tous (`OBJET_DECISION_INFO_MED`, lu par le moteur commun) : une fonction tenue par deux personnes
 * ne devient pas une double signature.
 *
 * L'EXISTANT N'EST PAS RE-ROUTÉ : une demande déjà en cours sous l'ancienne chaîne (N+1, référent
 * Direction Marketing, centre — en série) finit son circuit tel qu'il a été annoncé à ses signataires ;
 * seules les demandes soumises (ou resoumises) à partir d'ici vont au Directeur des Opérations. Une
 * demande à revoir qui se resoumet passe donc, elle, chez lui (`clorePrecedente` clôt l'ancienne).
 *
 * Non exportée : une fonction qui reçoit un demandeur en
 * argument n'a pas sa place parmi les points d'entrée d'un fichier « use server » (§118.153).
 */
export async function demanderAuDecideur(
  decideurs: DecideursInfoMed,
  d: { requesterId: string; title: string; description: (string | null)[]; declarationId: string; amount?: number },
) {
  return createDirectValidation({
    requesterId: d.requesterId,
    title: d.title,
    description: [...d.description, noteDecideurs(decideurs)].filter(Boolean).join("\n\n") || null,
    link: `${PATH}/${d.declarationId}`,
    module: "Information médicale",
    priority: "HIGH",
    validatorIds: decideurs.validatorIds,
    mode: "PARALLEL",
    objectType: OBJET_DECISION_INFO_MED,
    entityType: "MEDICAL_INFO_DECLARATION",
    entityId: d.declarationId,
    amount: d.amount,
  });
}
