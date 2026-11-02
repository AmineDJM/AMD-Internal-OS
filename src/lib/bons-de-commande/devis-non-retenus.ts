/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS NON RETENUS D'UN POSTE — les règles PURES (Direction, 11/2026).
 *
 * Quand le BC d'un poste est SIGNÉ (page Bons de commande), chaque devis du poste sans ligne validée est marqué « non
 * retenu » : la trace de l'offre écartée reste au registre, avec qui a validé celle qui l'a emporté. L'écriture et la
 * lecture vivent dans `bons-de-commande/non-retenus.ts`.
 *
 * Aucun import lourd : l'écran (client) lit les mêmes phrases que l'action (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

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

/** Le libellé « non retenu » d'un devis, dit sur le poste et dans Legal. */
export function libelleNonRetenu(le: Date | string, par: string | null): string {
  const d = typeof le === "string" ? new Date(le) : le;
  const date = Number.isNaN(d.getTime()) ? "" : ` le ${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Algiers" })}`;
  return `Non retenu${date}${par ? ` — offre retenue validée par ${par}` : ""}`;
}
