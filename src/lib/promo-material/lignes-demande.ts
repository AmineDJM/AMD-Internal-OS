/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES LIGNES D'UNE DEMANDE DE MATÉRIEL PROMOTIONNEL, SAISIES À LA CRÉATION (§118.171).
 *
 * « C'est directement ici que le demandeur ajoute les différentes lignes de matériel qu'il cherche
 * (selon les trois familles), la quantité et les actions. » La demande naissait VIDE : on
 * composait ses articles sur la fiche, après coup — donc le validateur, prévenu à la création,
 * tranchait une demande qui ne disait pas encore ce qu'elle demandait.
 *
 * Ce module ne fait que LIRE la saisie : le formulaire envoie ses lignes en un seul champ JSON,
 * `lignes`, parce qu'une liste de longueur variable ne s'écrit pas en clés littérales — et une
 * clé dynamique rendrait l'action illisible à la dérivation des contrats (§118.73). La RÈGLE
 * d'une ligne (article actif, produit exigé, au moins une action, quantité) reste
 * `validerArticleDemande`, la même que celle de la fiche : deux règles pour la même ligne
 * finiraient par ne plus accepter la même chose selon l'écran (§118.5).
 *
 * PUR : zéro import — le formulaire (navigateur) et l'action (serveur) en ont besoin tous deux.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une ligne telle que le formulaire l'envoie — brute, avant la règle. */
export interface LigneDemandeSaisie {
  catalogueId: string;
  quantite: string;
  actions: string[];
  /** Les CODES des produits promus (§118.204) : « societe », « gamme:… », « bu:… » — ou un produit canonique (ligne d'avant). */
  produitIds: string[];
  /** « Autre » — un produit promu écrit en clair, quand il n'est dans aucune liste. */
  autre: string;
  commentaire: string;
  /** F2 : « AUTRE ARTICLE » (`catalogueId: "AUTRE"`) — l'article absent du catalogue, saisi librement. */
  autreNom?: string;
  autreFamille?: string;
  autreDescription?: string;
}

/** Une limite OPÉRATIONNELLE (§118.2) : au-delà, la demande se scinde — et le refus le dit. */
export const LIGNES_MAX = 60;

const texte = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : "");
const textes = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && y.trim() !== "").map((y) => y.trim()) : []);

/**
 * LIRE LE CHAMP `lignes`. Ce qui ne se lit pas à coup sûr est REFUSÉ en le disant, jamais
 * deviné : une ligne à moitié comprise serait chiffrée par l'assistante pour autre chose que ce
 * qui a été demandé (§118.16).
 */
export function lireLignesDemande(brut: string | null | undefined): { ok: true; lignes: LigneDemandeSaisie[] } | { ok: false; error: string } {
  if (!brut || !brut.trim()) return { ok: true, lignes: [] };
  let valeur: unknown;
  try {
    valeur = JSON.parse(brut);
  } catch {
    return { ok: false, error: "Les lignes de la demande sont illisibles : rechargez le formulaire et ressaisissez-les." };
  }
  if (!Array.isArray(valeur)) return { ok: false, error: "Les lignes de la demande sont illisibles : rechargez le formulaire et ressaisissez-les." };
  if (valeur.length > LIGNES_MAX) {
    return { ok: false, error: `Une demande compte au plus ${LIGNES_MAX} lignes (${valeur.length} saisies) : scindez-la en plusieurs demandes.` };
  }
  return {
    ok: true,
    lignes: valeur.map((l) => {
      const o = l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : {};
      return {
        catalogueId: texte(o.catalogueId).trim(),
        quantite: texte(o.quantite).trim(),
        actions: textes(o.actions),
        produitIds: textes(o.produitIds),
        autre: texte(o.autre).trim(),
        commentaire: texte(o.commentaire),
        // « Autre article » : seulement quand la ligne le porte (une ligne du catalogue reste ce qu'elle était).
        ...(texte(o.autreNom).trim() ? { autreNom: texte(o.autreNom).trim() } : {}),
        ...(texte(o.autreFamille).trim() ? { autreFamille: texte(o.autreFamille).trim() } : {}),
        ...(texte(o.autreDescription).trim() ? { autreDescription: texte(o.autreDescription).trim() } : {}),
      };
    }),
  };
}

/**
 * UNE LIGNE ENTIÈREMENT VIDE est un reste de formulaire (« Ajouter une ligne » cliqué une fois de
 * trop) : on l'écarte au lieu de la refuser. Le moindre champ rempli en fait une vraie ligne,
 * jugée par la règle — une ligne qui porte des actions sans article est une ligne INCOMPLÈTE, pas
 * une ligne vide, et le refus le dira.
 */
export function ligneVide(l: LigneDemandeSaisie): boolean {
  return !l.catalogueId && !l.quantite && l.actions.length === 0 && l.produitIds.length === 0 && !l.autre && !l.commentaire.trim() && !l.autreNom;
}

/** Le refus quand il ne reste aucune ligne — il dit à quoi sert une ligne, pas seulement qu'il en manque. */
export const REFUS_SANS_LIGNE =
  "Ajoutez au moins une ligne : l'article du catalogue, la quantité et ce qu'on attend du fournisseur (conception, impression…) — c'est ce que l'assistante de direction fera chiffrer.";
