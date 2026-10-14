/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE DEMANDE — UNE liste, rangée Devis → Bon de commande → Facture → Justificatifs.
 *
 * La fiche montrait les mêmes pièces dans trois blocs : « Documents » (les fichiers déposés sur la
 * demande, rangés par catégorie), « Pièces liées » (le registre Legal : devis, BC, factures et leurs
 * fichiers) et « Matériel promotionnel » (les fichiers du dossier lié). Un devis pouvait être dans
 * les trois, et personne ne savait lequel faisait foi. Ce module FUSIONNE les trois sources dans
 * les quatre cases de la maquette, sans rien recopier : chaque élément garde sa source (une pièce
 * du registre, ou un fichier de la demande / du dossier) — c'est elle que l'écran ouvre.
 *
 *   • Une pièce du REGISTRE va dans la case de sa nature (devis, BC, facture) ; un engagement
 *     (convention, contrat) va aux justificatifs.
 *   • Un FICHIER de la demande ou du dossier va dans la case de sa catégorie (« Devis »,
 *     « Bon de commande », « Facture » ; « Convention » aux justificatifs) ; tout le reste aux
 *     justificatifs.
 *
 * Générique et PUR (aucun import) : la page serveur le lit avec les types du chargeur, le banc
 * avec des objets simples.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type CleGroupe = "DEVIS" | "BC" | "FACTURE" | "JUSTIFICATIFS";

export const TITRE_GROUPE: Record<CleGroupe, string> = {
  DEVIS: "Devis", BC: "Bon de commande", FACTURE: "Facture", JUSTIFICATIFS: "Justificatifs",
};

/** Ce que la case vide dit — la facture « sera demandée pour terminer » un achat. */
export const VIDE_GROUPE: Record<CleGroupe, string> = {
  DEVIS: "Aucun devis pour l'instant.",
  BC: "Aucun bon de commande pour l'instant.",
  FACTURE: "Aucune facture pour l'instant — elle sera demandée pour terminer un achat.",
  JUSTIFICATIFS: "Aucun justificatif.",
};

export type ElementPiece<L, D> =
  | { source: "REGISTRE"; piece: L }
  | { source: "FICHIER"; origine: "DEMANDE" | "DOSSIER"; fichier: D };

export interface GroupePieces<L, D> { cle: CleGroupe; titre: string; elements: ElementPiece<L, D>[] }

const GROUPE_DE_SECTION: Record<string, CleGroupe> = { QUOTE: "DEVIS", PURCHASE_ORDER: "BC", INVOICE: "FACTURE", ENGAGEMENT: "JUSTIFICATIFS" };
const GROUPE_DE_CATEGORIE: Record<string, CleGroupe> = { QUOTE: "DEVIS", PURCHASE_ORDER: "BC", INVOICE: "FACTURE" };

/** La case d'un fichier, selon sa catégorie de document. */
export function groupeDuFichier(categorie: string | null | undefined): CleGroupe {
  return (categorie && GROUPE_DE_CATEGORIE[categorie]) || "JUSTIFICATIFS";
}

export function grouperLesPieces<L, D extends { category: string }>(e: {
  /** Les pièces du registre, par section (`chargerPiecesLiees().sections`). */
  registre: Partial<Record<"QUOTE" | "PURCHASE_ORDER" | "INVOICE" | "ENGAGEMENT", readonly L[]>>;
  /** Les fichiers déposés sur la demande. */
  fichiersDemande: readonly D[];
  /** Les fichiers du dossier lié (matériel promotionnel). */
  fichiersDossier?: readonly D[];
}): GroupePieces<L, D>[] {
  const groupes: Record<CleGroupe, ElementPiece<L, D>[]> = { DEVIS: [], BC: [], FACTURE: [], JUSTIFICATIFS: [] };
  for (const [section, liste] of Object.entries(e.registre)) {
    const g = GROUPE_DE_SECTION[section] ?? "JUSTIFICATIFS";
    for (const piece of liste ?? []) groupes[g].push({ source: "REGISTRE", piece });
  }
  for (const fichier of e.fichiersDemande) groupes[groupeDuFichier(fichier.category)].push({ source: "FICHIER", origine: "DEMANDE", fichier });
  for (const fichier of e.fichiersDossier ?? []) groupes[groupeDuFichier(fichier.category)].push({ source: "FICHIER", origine: "DOSSIER", fichier });
  return (["DEVIS", "BC", "FACTURE", "JUSTIFICATIFS"] as const).map((cle) => ({ cle, titre: TITRE_GROUPE[cle], elements: groupes[cle] }));
}

/** Le nombre de pièces d'une demande, tel que le tableau l'affiche : pièces du registre + fichiers déposés. */
export function nombreDePieces(n: { registre: number; fichiers: number }): number {
  return Math.max(0, n.registre) + Math.max(0, n.fichiers);
}

/**
 * LA NATURE CHOISIE dans « + Ajouter une pièce » — un seul bouton, qui demande ce qu'on dépose et
 * le range dans sa case. Devis et bon de commande ont leur formulaire (ils entrent au registre) ;
 * facture et justificatif sont des fichiers de la demande, dans la catégorie de leur case.
 */
export type NatureAjout = "DEVIS" | "BC" | "FACTURE" | "JUSTIFICATIF";
export const CATEGORIES_AJOUT: Record<"FACTURE" | "JUSTIFICATIF", string[]> = {
  FACTURE: ["INVOICE"],
  JUSTIFICATIF: ["SUPPORTING_DOC", "REQUEST_LETTER", "CONVENTION", "PHOTO", "OTHER"],
};
