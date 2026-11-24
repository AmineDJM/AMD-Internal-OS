/**
 * OÙ MÈNE UNE NOTIFICATION RH — les adresses du salarié (« Mon dossier RH ») et celles des RH
 * (« Demandes RH », « Congés », « Paie »), écrites une fois.
 *
 * LA RÈGLE : le salarié est envoyé chez LUI (son dossier, sa demande dépliée sous ses yeux), jamais
 * sur l'écran des RH qu'il n'a pas le droit d'ouvrir ; les RH sont envoyées DANS leur file, la
 * demande ouverte (`?demande=`), jamais sur la fiche de l'employé où il faudrait la chercher.
 *
 * Module PUR — aucune importation. Le navigateur et le serveur le lisent.
 */

export const CHEMIN_MON_DOSSIER = "/mon-dossier";

/** Les ancres de « Mon dossier RH » (posées sur la page, `scroll-mt` compris). */
export const ANCRE_MES_CONGES = "mes-conges";
export const ANCRE_MES_DEMANDES_RH = "mes-demandes-rh";
export function ancreDemandeRh(id: string): string {
  return `demande-rh-${id}`;
}

/** « Mes congés et absences » — la demande, son circuit, son intérimaire, sa discussion. */
export const LIEN_MES_CONGES = `${CHEMIN_MON_DOSSIER}#${ANCRE_MES_CONGES}`;

/** UNE demande RH du salarié, dans son dossier (document, note de frais, entrevue, ordre de mission). */
export function lienMaDemandeRh(id: string | null | undefined): string {
  return id ? `${CHEMIN_MON_DOSSIER}#${ancreDemandeRh(id)}` : `${CHEMIN_MON_DOSSIER}#${ANCRE_MES_DEMANDES_RH}`;
}

/** La file des RH. */
export const CHEMIN_DEMANDES_RH = "/rh/demandes";

/** UNE demande dans la file des RH, son panneau de traitement ouvert. */
export function lienDemandeRhATraiter(id: string): string {
  return `${CHEMIN_DEMANDES_RH}?demande=${encodeURIComponent(id)}`;
}

/** La table « Congés et absences à trancher » des RH (même page, sous la file). */
export const ANCRE_CONGES_A_TRANCHER = "conges-a-trancher";
export const LIEN_CONGES_A_TRANCHER_RH = `${CHEMIN_DEMANDES_RH}#${ANCRE_CONGES_A_TRANCHER}`;

/** Les intérimaires proposés, en attente des RH (« RH › Congés »). */
export const ANCRE_INTERIMAIRES = "interimaires-a-valider";
export const LIEN_INTERIMAIRES_A_VALIDER = `/rh/conges#${ANCRE_INTERIMAIRES}`;

/** La paie — où les avances sur salaire se tranchent (06/10). */
export const CHEMIN_PAIE_RH = "/rh/paie";

/**
 * LES CONGÉS À SIGNER — l'unique file de TOUS ceux qui tranchent un congé : le N+1 (ou son
 * intérimaire), les RH à leur marche, la direction générale (`getLeavesToDecide`). « Mon équipe »
 * ne signe rien et « /rh » redirige selon les droits : ce sont deux impasses pour un signataire.
 */
export const LIEN_CONGES_A_SIGNER = "/mon-espace#conges-a-signer";

/**
 * « Mes avances sur salaire » — l'historique, dans Mon dossier RH (il quittait « Aujourd'hui », écran simplifié du
 * 24/11/2026). Les notifications déjà écrites vers `/mon-espace#mes-avances` y sont renvoyées par la page.
 */
export const ANCRE_MES_AVANCES = "mes-avances";
export const LIEN_MES_AVANCES = `/mon-dossier#${ANCRE_MES_AVANCES}`;
