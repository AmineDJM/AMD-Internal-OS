import { redirect } from "next/navigation";

/**
 * FINANCES › DOUBLONS DE FACTURES — module SUPPRIMÉ (Super Admin, 25/11/2026). L'adresse reste valide (un favori, une
 * notification d'hier) : elle mène à la Comptabilité. La DÉTECTION des doublons reste en service — « doublon possible » au
 * centre de paiement, « ressemble à » dans la Comptabilité, le recensement `recenserDoublonsFactures` ; seul l'écran part.
 */
export default function DoublonsFacturesPage(): never {
  redirect("/finances/comptabilite");
}
