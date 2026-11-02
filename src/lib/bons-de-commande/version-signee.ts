import type { BrouillonExcel } from "@/lib/bons-de-commande/brouillon";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VERSION SIGNÉE DU BON DE COMMANDE D'UN POSTE — les règles PURES (Direction, 11/2026).
 *
 * « La personne imprime le brouillon, le modifie ou le signe, puis le dépose : c'est cette version finale qui entre dans
 * Legal. La signature déposée suffit. » Le dépôt fait donc naître le BC au registre DÉJÀ SIGNÉ — il ne passe pas par la
 * file de signature des Finances. Ce qui ne change pas : le centre de validation Ad & Pro au-dessus du seuil des BC (le
 * dépôt attend son visa), et la lecture de la copie par Luna (signature repérée, bon numéro).
 *
 * Et les DEVIS NON RETENUS : quand le BC signé est déposé, chaque devis du poste sans ligne validée est marqué « non
 * retenu » — la trace de l'offre écartée reste au registre, avec qui a validé celle qui l'a emporté.
 *
 * Aucun import lourd : l'écran (client) lit les mêmes phrases que l'action (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que le dépôt de la version signée lit du poste et du devis. */
export interface EtatDepotVersionSignee {
  /** La marche du BC du poste (`AdProItemOrderStage`). */
  orderStage: string;
  /** Le paiement du poste est-il déjà demandé ? */
  expenseOrderId: string | null;
  /** Le brouillon Excel du devis, s'il existe. */
  excel: BrouillonExcel | null;
  /** Les lignes validées ont-elles changé depuis le brouillon ? */
  perime: boolean;
}

/** Pourquoi la version signée ne peut pas être déposée — `null` : elle le peut. */
export function refusDepotVersionSignee(e: EtatDepotVersionSignee): string | null {
  if (e.expenseOrderId || e.orderStage === "ISSUED") return "Le paiement de ce poste est déjà demandé : ses bons de commande ne changent plus.";
  if (!e.excel) return "Aucun brouillon de bon de commande n'existe pour ce devis : validez d'abord ses lignes.";
  if (e.perime) {
    return `Les lignes validées ont changé depuis le brouillon ${e.excel.numero} : téléchargez le brouillon mis à jour, faites-le signer, puis déposez-le.`;
  }
  if (e.orderStage === "REQUESTED") {
    return `Le bon de commande ${e.excel.numero} attend le visa du centre de validation Ad & Pro : la version signée se dépose une fois le visa donné.`;
  }
  if (e.orderStage === "REFUSED") return `Le centre de validation Ad & Pro a refusé le bon de commande de ce poste : la version signée ne se dépose pas.`;
  if (e.orderStage !== "DIRECTION_OK") return "Le bon de commande de ce poste n'est pas encore lancé : validez d'abord les lignes d'un devis.";
  return null;
}

/** Un devis du poste, tel que le marquage « non retenu » le lit. */
export interface DevisPourRetenue {
  pieceId: string;
  /** Lignes validées pour CE poste. */
  nbValidees: number;
  annule: boolean;
}

/**
 * LES DEVIS NON RETENUS d'un poste, au dépôt de son BC signé : ceux qui comptent (non annulés) et n'ont AUCUNE ligne validée
 * pour ce poste. Le devis retenu, et tout devis qui porte une ligne validée (un autre BC du même poste), n'y sont jamais.
 */
export function devisNonRetenus(devis: readonly DevisPourRetenue[]): string[] {
  return devis.filter((d) => !d.annule && d.nbValidees === 0).map((d) => d.pieceId);
}

/** La notification du brouillon prêt, adressée à qui a déposé le devis. */
export function notificationBrouillonPret(p: { numero: string; fournisseur: string | null; poste: string; ref: string; misAJour: boolean }): { title: string; body: string } {
  const qui = p.fournisseur ? ` (${p.fournisseur})` : "";
  return {
    title: p.misAJour ? "Brouillon du bon de commande mis à jour" : "Brouillon du bon de commande prêt",
    body: `${p.ref} — poste « ${p.poste} » : le brouillon du bon de commande ${p.numero}${qui} est prêt. Imprimez-le, complétez-le ou signez-le, puis déposez la version finale sur le poste.`,
  };
}

/** Le libellé « non retenu » d'un devis, dit sur le poste et dans Legal. */
export function libelleNonRetenu(le: Date | string, par: string | null): string {
  const d = typeof le === "string" ? new Date(le) : le;
  const date = Number.isNaN(d.getTime()) ? "" : ` le ${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" })}`;
  return `Non retenu${date}${par ? ` — offre retenue validée par ${par}` : ""}`;
}
