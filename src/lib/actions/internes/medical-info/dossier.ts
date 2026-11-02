/**
 * INFORMATION MÉDICALE — ce que les actions disent ou composent d'une déclaration : les refus du circuit (dépôt
 * aux autorités, « aucun versement »), le formulaire rejoué de la demande de paiement d'une quittance, le résumé
 * versé à l'archive, et l'ordre de dépense reporté sur l'événement source.
 *
 * Sorti de `actions/medical-info-actions.ts` (lot V4). Les lectures du formulaire restent dans l'action (le
 * contrat des actions les lit dans son corps) ; elles arrivent ici en valeurs.
 */
import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { formatAlgiers } from "@/lib/calendar-tz";
import type { MedicalCircuitState } from "@/lib/medical-info/circuit-state";
import { declareStage, declareStageLabel } from "@/lib/medical-info/declare-decision";
import { slipSansPaiementVivant } from "@/lib/medical-info/slips";
import { DECIDEUR_INFO_MED_LABEL } from "@/lib/medical-info/decideur";
import { PATH } from "./acces";

/** Pourquoi le dépôt aux autorités n'est pas encore ouvert — l'étape qui manque, dite. */
export function refusDepotAutorites(etat: MedicalCircuitState): string {
  return etat.circuit === "EVENT"
    ? `La décision de déclarer n'est pas encore accordée : ${declareStageLabel(declareStage(etat.declare)).toLowerCase()}.`
    : `Les quittances ne sont pas toutes entre vos mains : ${etat.summary.delivered}/${etat.summary.count} remise(s).`;
}

/** Ce qui empêche de déclarer un dossier « sans versement » ; `null` = rien ne l'empêche. */
export function refusSansVersement(etat: MedicalCircuitState): string | null {
  // Un bon dont le paiement a été refusé ou annulé n'engage plus rien (audit 10/2026) : il ne doit
  // plus empêcher de dire que le dossier n'appelle aucun versement — il le bloquait à vie.
  if (etat.slips.some((sl) => !slipSansPaiementVivant(sl))) {
    return "Une quittance est engagée : elle doit être menée à son terme ou refusée.";
  }
  if (etat.lot !== "A_DEMANDER" && etat.lot !== "VALIDATION_REFUSEE" && etat.lot !== "QUITTANCE_A_DEMANDER") {
    return "Le dépôt des bons est engagé en validation : il doit être mené à son terme ou refusé.";
  }
  return null;
}

/**
 * LE FORMULAIRE DE LA DEMANDE DE PAIEMENT d'une quittance, rejoué tel que les Demandes de validations l'envoient :
 * la MÊME action canonique, donc les mêmes contrôles et le même circuit. Les champs saisis arrivent en valeurs.
 */
export function formulaireDeLaQuittance(
  slip: { label: string; amount: unknown },
  decl: { id: string; label: string; companyId: string | null },
  amount: number,
  saisi: { payee: string | null; note: string | null; dueDate: string | null; files: FormDataEntryValue[] },
): FormData {
  const fd = new FormData();
  fd.set("title", `Quittance de versement — ${slip.label} (${decl.label})`);
  fd.set("payee", saisi.payee || "Autorités sanitaires");
  fd.set("amount", String(amount));
  fd.set("description", [
    saisi.note,
    slip.amount ? `Bon annoncé pour ${toNumber(slip.amount).toLocaleString("fr-FR")} DZD.` : null,
  ].filter(Boolean).join("\n\n"));
  if (decl.companyId) fd.set("companyId", decl.companyId);
  const echeance = saisi.dueDate;
  if (echeance) fd.set("dueDate", echeance);
  // LE RATTACHEMENT EST POSÉ DÈS LA CRÉATION, et non par une mise à jour qui suivrait. C'est lui
  // qui identifie un BON DE VERSEMENT, et donc ce qui l'exempte de l'obligation de joindre un bon
  // de commande ou une facture (`finance/payment-dossier.ts`) : un BV n'en a ni n'en peut avoir,
  // et sa quittance n'existe qu'APRÈS le versement.
  fd.set("entityType", "MEDICAL_INFO_DECLARATION");
  fd.set("entityId", decl.id);
  fd.set("link", `${PATH}/${decl.id}`);
  for (const f of saisi.files) if (f instanceof File && f.size > 0) fd.append("files", f);
  return fd;
}

/** Le résumé versé à l'archive du PRIM quand le pharmacien transmet son instruction. */
export function resumeDArchive(
  decl: {
    reference: string; label: string; beneficiary: string | null; authorityRef: string | null;
    authorityNotes: string | null; createdAt: Date;
  },
  repli: boolean,
): string {
  return [
    `Déclaration d'information médicale — ${decl.reference}`,
    `Libellé : ${decl.label}`,
    decl.beneficiary ? `Bénéficiaire : ${decl.beneficiary}` : null,
    decl.authorityRef ? `Référence autorités : ${decl.authorityRef}` : null,
    decl.authorityNotes ? `Notes de déclaration : ${decl.authorityNotes}` : null,
    `Créée le : ${formatAlgiers(decl.createdAt, { day: "2-digit", month: "long", year: "numeric" })}`,
    `Validée par le pharmacien le : ${formatAlgiers(new Date(), { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    `Transmise ${repli ? "au Super Admin" : `au ${DECIDEUR_INFO_MED_LABEL}`} pour validation finale.`,
  ].filter(Boolean).join("\n");
}

/** Reporte l'ordre de dépense sur l'événement source (tout reste interconnecté). */
export async function reporterOrdreSurLaSource(decl: { sourceType: EntityType; sourceId: string }, orderId: string): Promise<void> {
  if (decl.sourceType === "SPONSORING") await prisma.sponsoringRequest.update({ where: { id: decl.sourceId }, data: { expenseOrderId: orderId } });
  else if (decl.sourceType === "CONGRESS_INTERNATIONAL") await prisma.congressInternational.update({ where: { id: decl.sourceId }, data: { expenseOrderId: orderId } });
  else if (decl.sourceType === "CONGRESS_NATIONAL") await prisma.congressNational.update({ where: { id: decl.sourceId }, data: { expenseOrderId: orderId } });
}
