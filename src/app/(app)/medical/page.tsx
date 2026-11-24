import { redirect } from "next/navigation";
import { requireModule } from "@/lib/session";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";

/**
 * `/medical` N'EST PAS UN ÉCRAN — c'est l'AIGUILLAGE de « Visite médicale », et l'entrée du menu y mène (11/2026).
 *
 * Il dépend de qui pousse la porte (`sfe/aiguillage-visite.ts`) : le délégué vers « Ma journée », son superviseur vers
 * l'écran de son équipe (Force de vente › Pilotage, sur sa BU), la Direction vers le Cockpit Opérations, tous les autres
 * vers le plan de tournée. La route vit aussi dans des favoris, des notifications et des liens collés en conversation.
 *
 * ⚠ AUCUNE DONNÉE N'A JAMAIS ÉTÉ SUPPRIMÉE : les visites (`MedicalVisit`) et l'historique sont intacts.
 */
export default async function MedicalEntryPage() {
  const user = await requireModule("MEDICAL");
  redirect((await aiguillerVisite(user)).chemin);
}
