/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ VIVENT LES RAPPORTS TERRAIN — une adresse, écrite une fois.
 *
 * Décision de la Direction (07/10) : les Rapports terrain ne sont plus une entrée de menu à part. Le
 * KAM fait son rapport depuis son PLANNING (Promotion médicale › Plan de tournée : il touche le
 * praticien, la feuille de la visite s'ouvre) ou par « Faire un rapport » au-dessus ; la
 * pharmacovigilance part du même endroit. La Direction lit la LISTE des rapports dans un onglet
 * « Rapports » du même module. Le droit reste le module `FIELD_REPORTS` : la console règle toujours
 * qui voit cet onglet.
 *
 * Les ANCIENNES adresses (`/field-reports`, `/field-reports/<id>`, `/field-reports/overview`,
 * `/field-reports/pharmacovigilance…`) ne meurent pas : des notifications déjà envoyées les portent,
 * en base. Une page d'escale à chacune les REDIRIGE ici (le patron de §118.173).
 *
 * Module PUR — aucune importation. Le navigateur et le serveur le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'onglet « Rapports » de la Promotion médicale — la liste. */
export const CHEMIN_RAPPORTS_TERRAIN = "/medical/rapports";

/**
 * La liste des rapports d'UN délégué (`?delegue=<id du compte>`) — « Voir ses rapports » de Mon Équipe et de la Force de
 * vente. Le filtre n'existe que pour qui voit les rapports de tous (`viewsAllReports`) : pour les autres, la liste reste la leur.
 */
export function lienRapportsDeDelegue(delegueId: string): string {
  return `${CHEMIN_RAPPORTS_TERRAIN}?delegue=${encodeURIComponent(delegueId)}`;
}

/** La fiche d'un compte rendu vocal (`FieldReport`) : relecture, validation, pièces, suppression. */
export function lienRapportTerrain(id: string): string {
  return `${CHEMIN_RAPPORTS_TERRAIN}/${encodeURIComponent(id)}`;
}

/** L'analyse des rapports (graphes) — réservée aux rôles cochés dans Administration. */
export const CHEMIN_APERCU_RAPPORTS = `${CHEMIN_RAPPORTS_TERRAIN}/overview`;

/** Les signalements de pharmacovigilance du KAM (« Mes signalements »). */
export const CHEMIN_PV_KAM = `${CHEMIN_RAPPORTS_TERRAIN}/pharmacovigilance`;

/** La fiche d'un cas, côté KAM. */
export function lienCasPvKam(id: string): string {
  return `${CHEMIN_PV_KAM}/${encodeURIComponent(id)}`;
}

/**
 * Le formulaire de signalement — prérempli avec le praticien quand on vient de SA cellule du planning
 * (le serveur relit la fiche dans le périmètre de la personne : l'adresse ne porte qu'un identifiant).
 */
export function lienSignalerPv(praticienId?: string | null): string {
  return praticienId ? `${CHEMIN_PV_KAM}/nouveau?praticien=${encodeURIComponent(praticienId)}` : `${CHEMIN_PV_KAM}/nouveau`;
}
