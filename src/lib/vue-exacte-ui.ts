/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * VUE EXACTE — LA PART PURE (aucun import : l'écran la lit, le serveur la réexporte).
 *
 * « Quand je vois l'écran de Leila, je dois voir vraiment SON interface, tout, et c'est seulement quand
 * je quitte cette vue que je reviens à mon profil — pas de chevauchement possible ! » (Direction, 06/10)
 *
 * Trois règles, une par cause de chevauchement mesurée :
 *   1. QUI EST À L'ÉCRAN — `vueHonoree` : tout ce qui S'AFFICHE (page, coque, rendu qui suit une action,
 *      lecture déclarée) est rendu pour la personne visualisée ; seul le CORPS d'une action qui écrit
 *      part au nom du Super Admin (§118.184).
 *   2. CE QUE L'ONGLET A EN MÉMOIRE — `MARQUE_VUE_COOKIE` : un témoin lisible par l'écran, posé et
 *      effacé avec la vue. Un onglet dont la coque a été rendue sous une autre vue se recharge en entier
 *      (autre onglet qui entre/sort, vue expirée, retour arrière) au lieu de mêler deux personnes.
 *   3. CE QUE LE NAVIGATEUR GARDE — `cleParPersonne` : brouillons, presse-papiers, épingles rangés par
 *      personne effective, jamais partagés entre l'administrateur et la personne visualisée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Témoin NON httpOnly de la vue : il ne donne aucun droit (le serveur ne lit que le cookie httpOnly). */
export const MARQUE_VUE_COOKIE = "amd_vue";

/** La valeur du témoin dans un en-tête `document.cookie` (chaîne vide : aucune vue). */
export function lireMarqueVue(cookieHeader: string | null | undefined): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== MARQUE_VUE_COOKIE) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
  }
  return "";
}

/**
 * La clé de stockage navigateur d'une donnée PERSONNELLE, rangée par personne effective. Sans personne
 * connue (hors coque), la clé d'origine — rien ne casse, rien ne se mélange de plus qu'avant.
 */
export function cleParPersonne(base: string, personneId: string | null | undefined): string {
  return personneId ? `${base}:${personneId}` : base;
}

export interface ContexteDeLecture {
  /** « Agir comme cet utilisateur » (16/11/2026) : la vue vaut pour TOUT calcul d'identité, écritures comprises. */
  agir?: boolean;
  /** L'identité RÉELLE demandée exprès (`getUtilisateurReel`) : ouvrir ou quitter la vue, abonner l'appareil. */
  reel?: boolean;
  /** La route d'API dit qu'elle écrit (`getCurrentUserPourEcrire`). */
  ecriture: boolean;
  /** Création d'une demande au nom de la personne visualisée (décision Direction, 06/10). */
  auNomDeLaVue: boolean;
  /** Action serveur qui ne fait que LIRE pour l'écran (`enLecture(requireUser)`, vue-lecture.ts). */
  lecture: boolean;
  /** Le corps d'une action serveur, ou le rendu qui la suit, est en cours (stockage de Next). */
  actionServeur: boolean;
  /** Un rendu de composants serveur est en cours (React l'expose : `cache` mémorise). */
  rendu: boolean;
}

/**
 * La vue d'un Super Admin est-elle honorée pour CE calcul d'identité ? (La condition « session réelle
 * Super Admin + cookie valide » est vérifiée à part, par `session.ts`.)
 *
 * Le piège mesuré (Next 14.2, `action-handler.js`) : le rendu de la page qui SUIT une action qui revalide
 * s'exécute DANS le stockage `isAction` — la coque et la page se rendaient alors pour l'administrateur
 * (son nom en haut, son menu, plus de bandeau) au milieu de l'écran de la personne visualisée. Ce rendu
 * LIT : il voit la vue.
 */
export function vueHonoree(c: ContexteDeLecture): boolean {
  if (c.reel) return false;
  // « AGIR COMME » (Direction, 16/11/2026) : le Super Admin agit au nom de la personne — chaque geste marqué et annulable.
  if (c.agir) return true;
  if (c.auNomDeLaVue || c.lecture) return true;
  if (c.ecriture) return false;
  if (c.actionServeur && !c.rendu) return false;
  return true;
}
