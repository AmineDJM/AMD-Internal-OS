import type { LigneProposee } from "@/lib/pieces-lues/confirmation";
import type { EntetesReperes } from "@/lib/pieces-lues/entetes";
import type { LigneLue, PieceLue } from "@/lib/pieces-lues/structure";
import { arrondirAuCentime } from "@/lib/utils";
import { articleKey, normalizeArticleName } from "./catalog-normalize";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉPENSE DES MOYENS GÉNÉRAUX COMMENCE PAR LA PIÈCE (Direction, 09/11/2026).
 *
 * « Les moyens généraux doivent aussi commencer par l'ajout d'un fichier, et à partir de ce fichier créer les
 * articles, les nommer et tout remplir automatiquement avec l'IA ; l'utilisateur valide ou modifie avant
 * d'envoyer. » La facture ou le ticket est lu (`proposerLecture`, le lecteur commun : texte d'un PDF, Luna pour un
 * scan) ; ce module traduit la lecture en LIGNES DE DÉPENSE : chaque ligne lue devient un article, rattaché au
 * CATALOGUE quand son nom y est reconnu, sinon nommé comme sur le papier et proposé à l'ajout au catalogue. Quand le
 * total imprimé dépasse les articles du montant de leurs taxes, une ligne « TVA et taxes » dit ce qui a été payé.
 *
 * Module PUR — sans base ni session : le serveur (lecture, confirmation) et le formulaire le lisent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ArticleDuCatalogue { id: string; name: string }

export interface LigneFactureLue {
  /** Le rang de la ligne lue (1-indexé) — `null` : ligne composée par nous (les taxes), pas lue sur le papier. */
  rang: number | null;
  /** Le nom de l'article : celui du catalogue s'il est reconnu, sinon la désignation du papier, mise au propre. */
  label: string;
  quantity: number;
  /** Le montant de la ligne (DZD) ; 0 quand il est illisible — à saisir depuis le papier (les `notes` le disent). */
  amount: number;
  articleId: string | null;
  /** Article absent du catalogue : proposé à l'ajout (case cochée d'office). */
  ajouterAuCatalogue: boolean;
  /** Ce qu'il faut vérifier sur cette ligne. */
  notes: string[];
}

export interface LectureFactureDepense {
  lectureId: string;
  nomFichier: string;
  fournisseur: string | null;
  numero: string | null;
  /** ISO `AAAA-MM-JJ`. */
  date: string | null;
  /** Le net à payer ou le total TTC REPÉRÉ sur le papier — jamais un total du modèle. */
  totalImprime: number | null;
  lignes: LigneFactureLue[];
  /** « Objet de l'achat » proposé. */
  objet: string;
  /** « Précisions » proposées : fournisseur, numéro, date. */
  precisions: string | null;
  /** L'écart entre les articles et le total imprimé, dit — `null` quand ils tombent juste. */
  ecart: string | null;
  /** Pourquoi aucune ligne n'a été lue — `null` quand il y en a. */
  sansLignes: string | null;
  /** D'où vient le texte (PDF, lecture d'image) — composée par notre code. */
  noteMethode: string;
}

/** L'attestation unique que la dépense exige dès qu'une ligne vient de la lecture. */
export const CASE_COMPAREES_DEPENSE = "J'ai comparé les articles à la facture";
export const LIBELLE_TAXES = "TVA et taxes (facture)";

/** Un nom de catalogue plus court que cela ne se reconnaît pas à l'intérieur d'une désignation (« Pc », « Bic »). */
const CLE_MIN = 4;
/** Au-delà de cette part du total des articles, un reste n'est plus des taxes : c'est une ligne mal lue. */
const PART_MAX_TAXES = 0.35;

const fmt = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });

/**
 * L'ARTICLE DU CATALOGUE QU'UNE DÉSIGNATION NOMME — le même nom (casse, accents, ponctuation ignorés), sinon le nom
 * d'un article contenu EN MOTS ENTIERS dans la désignation (« Ramette papier A4 80g » ⊃ « Ramette papier A4 »), le
 * plus long l'emportant. Deux articles à égalité : aucun — on ne choisit pas au hasard.
 */
export function articleDuCatalogue(designation: string, catalogue: readonly ArticleDuCatalogue[]): ArticleDuCatalogue | null {
  const cle = articleKey(designation);
  if (!cle) return null;
  const exact = catalogue.filter((a) => articleKey(a.name) === cle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const entoure = ` ${cle} `;
  const contenus = catalogue
    .map((a) => ({ a, k: articleKey(a.name) }))
    .filter((x) => x.k.length >= CLE_MIN && entoure.includes(` ${x.k} `))
    .sort((x, y) => y.k.length - x.k.length);
  if (contenus.length === 0) return null;
  if (contenus.length > 1 && contenus[1].k.length === contenus[0].k.length) return null;
  return contenus[0].a;
}

/** Le montant d'une ligne lue : celui imprimé, sinon quantité × prix (remise déduite) ; `null` : illisible. */
function montantDeLaLigne(l: LigneLue): number | null {
  if (l.montantHt !== null) return arrondirAuCentime(l.montantHt);
  if (l.quantite !== null && l.prixUnitaire !== null) return arrondirAuCentime(l.quantite * l.prixUnitaire * (1 - (l.remise ?? 0)));
  return null;
}

/** Le prix unitaire d'une ligne de dépense — la même division partout (lecture, confirmation). */
export function prixUnitaireDe(amount: number, quantity: number): number {
  return arrondirAuCentime(amount / (quantity > 0 ? quantity : 1));
}

/** LES ARTICLES DE LA FACTURE — une ligne de dépense par ligne lue (les titres de section écartés). */
export function lignesDeLaFacture(piece: PieceLue | null, catalogue: readonly ArticleDuCatalogue[]): LigneFactureLue[] {
  if (!piece) return [];
  return piece.lignes.filter((l) => !l.section).map((l) => {
    const notes = l.illisibles.map((i) => i.raison);
    const montant = montantDeLaLigne(l);
    if (montant === null) notes.push("montant illisible : saisissez-le depuis la facture");
    const quantite = l.quantite !== null && l.quantite > 0 ? l.quantite : 1;
    const article = articleDuCatalogue(l.designation, catalogue);
    const label = article ? article.name : normalizeArticleName(l.designation);
    return {
      rang: l.rang, label, quantity: quantite, amount: montant ?? 0,
      articleId: article?.id ?? null, ajouterAuCatalogue: !article && label.length > 0, notes,
    };
  });
}

/** Le total REPÉRÉ sur le papier : le net à payer, sinon le TTC. Jamais un total proposé par le modèle (P4). */
export function totalImprime(entetes: Pick<EntetesReperes, "netAPayer" | "totalTtc"> | null): number | null {
  return entetes?.netAPayer?.valeur ?? entetes?.totalTtc?.valeur ?? null;
}

const sommeDes = (lignes: readonly LigneFactureLue[]): number => arrondirAuCentime(lignes.reduce((a, l) => a + l.amount, 0));

/**
 * LA LIGNE DES TAXES — quand le total imprimé dépasse les articles (lus hors taxes) d'un reste PLAUSIBLE comme TVA et
 * taxes (au plus 35 % des articles). Au-delà, ce n'est plus des taxes : c'est une ligne mal lue, et l'écart se dit
 * (`ecartDeLaFacture`) au lieu d'être comblé.
 */
export function ligneDesTaxes(total: number | null, lignes: readonly LigneFactureLue[]): LigneFactureLue | null {
  if (total === null) return null;
  const somme = sommeDes(lignes);
  const reste = arrondirAuCentime(total - somme);
  if (somme <= 0 || reste < 1 || reste > somme * PART_MAX_TAXES) return null;
  return {
    rang: null, label: LIBELLE_TAXES, quantity: 1, amount: reste, articleId: null, ajouterAuCatalogue: false,
    notes: ["la différence entre le total imprimé et les articles : TVA et taxes de la facture — vérifiez-la"],
  };
}

/** L'écart entre les articles et le total imprimé, dit — `null` quand ils tombent juste (à un dinar près). */
export function ecartDeLaFacture(total: number | null, lignes: readonly LigneFactureLue[]): string | null {
  if (total === null) return null;
  const somme = sommeDes(lignes);
  const d = arrondirAuCentime(total - somme);
  if (Math.abs(d) < 1) return null;
  return `Les articles font ${fmt(somme)} DZD, le total imprimé est ${fmt(total)} DZD (écart de ${fmt(d)} DZD) : vérifiez les lignes avant d'enregistrer.`;
}

/** LES LIGNES PROPOSÉES, pour la confirmation — la MÊME traduction que le préremplissage (lignes lues seulement). */
export function lignesProposeesDepense(piece: PieceLue | null, catalogue: readonly ArticleDuCatalogue[]): LigneProposee[] {
  return lignesDeLaFacture(piece, catalogue)
    .filter((l): l is LigneFactureLue & { rang: number } => l.rang !== null)
    .map((l) => ({ rang: l.rang, designation: l.label, quantite: l.quantity, prixUnitaire: prixUnitaireDe(l.amount, l.quantity) }));
}

/** L'objet de l'achat, composé depuis l'en-tête : « Achat — Librairie El Nour, facture n° 245 ». */
export function objetDeLaFacture(fournisseur: string | null, numero: string | null): string {
  if (!fournisseur && !numero) return "";
  return `Achat${fournisseur ? ` — ${fournisseur}` : ""}${numero ? `, facture n° ${numero}` : ""}`;
}

/** LA LECTURE, TRADUITE POUR LE FORMULAIRE DE DÉPENSE. */
export function lectureFactureDepense(
  p: {
    lectureId: string; nomFichier: string; noteMethode: string; sansLignes: string | null;
    entetes: Pick<EntetesReperes, "netAPayer" | "totalTtc" | "numero" | "date"> | null;
    piece: PieceLue | null; fournisseurNom: string | null;
  },
  catalogue: readonly ArticleDuCatalogue[],
): LectureFactureDepense {
  const lues = lignesDeLaFacture(p.piece, catalogue);
  const total = totalImprime(p.entetes);
  const taxes = ligneDesTaxes(total, lues);
  const lignes = taxes ? [...lues, taxes] : lues;
  const fournisseur = p.fournisseurNom?.trim() || null;
  const numero = p.entetes?.numero?.valeur ?? p.piece?.numero ?? null;
  const date = p.entetes?.date?.valeur ?? p.piece?.date ?? null;
  const precisions = [fournisseur, numero ? `facture n° ${numero}` : null, date ? `du ${date.split("-").reverse().join("/")}` : null]
    .filter(Boolean).join(", ") || null;
  return {
    lectureId: p.lectureId, nomFichier: p.nomFichier, fournisseur, numero, date,
    totalImprime: total, lignes,
    objet: objetDeLaFacture(fournisseur, numero),
    precisions,
    ecart: ecartDeLaFacture(total, lignes),
    sansLignes: lues.length === 0 ? (p.sansLignes ?? "Aucun article n'a pu être lu : saisissez-les depuis la facture.") : null,
    noteMethode: p.noteMethode,
  };
}
