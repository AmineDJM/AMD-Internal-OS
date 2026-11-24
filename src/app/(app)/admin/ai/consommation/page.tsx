import { redirect } from "next/navigation";

/**
 * L'ANCIENNE ADRESSE DE « CONSOMMATION IA » — l'écran est rattaché au pôle Informatique (24/11/2026). Les liens déjà
 * envoyés (avis de plafond atteint, favoris) mènent au nouvel écran ; ses droits s'y appliquent.
 */
export default function AncienneConsommationIa() {
  redirect("/informatique/consommation-ia");
}
