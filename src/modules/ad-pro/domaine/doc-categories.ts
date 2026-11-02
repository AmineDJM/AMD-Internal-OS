import { AD_PRO_ENTITY_TYPE, type AdProKind } from "./unified";
import { LEGAL_DOC_KIND, isInvoice } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CATÉGORIES DE PIÈCES D'UNE DEMANDE Ad & Pro — écrites UNE fois, pour TOUT le pôle.
 *
 * ── LE DÉFAUT MESURÉ, ET IL ÉTAIT À L'ÉCRAN ─────────────────────────────────────────────
 *
 * Sur la fiche d'un ÉVÉNEMENT, le menu de classement d'une pièce jointe proposait « CTD
 * complet », « Module 1 », « Certificat GMP », « CPP », « AMM pays d'origine »… — la
 * nomenclature d'un dossier d'enregistrement de médicament, sur l'écran où l'on dépose une
 * facture de traiteur. Cause : le téléverseur n'y recevait AUCUNE liste, et son repli est la
 * table `DOCUMENT_CATEGORY` entière, dont la première entrée est `CTD_FULL`.
 *
 * Recensé avant de corriger : SIX fiches Ad & Pro, et **trois ne passaient rien** (événement,
 * consulting, « autre demande »). Les deux congrès lisaient bien ce module ; le sponsoring en
 * portait une copie LOCALE, mot pour mot identique. C'est §118.71 à trois contre trois — des
 * portes gardées à côté de portes ouvertes — plus une seconde vérité qui n'attendait qu'une
 * catégorie ajoutée d'un seul côté pour diverger (§118.5).
 *
 * ── DEUX LISTES, ET ELLES NE SE CONFONDENT PAS ──────────────────────────────────────────
 *
 * Le pôle Ad & Pro dépose des pièces COMMERCIALES : la demande, la convention, le programme, le
 * devis, le bon de commande, la facture, le justificatif, les photos. Le MATÉRIEL PROMOTIONNEL
 * en dépose d'autres — un visa publicitaire, le fichier du matériel, un bordereau de paiement,
 * un bon de livraison — parce que c'est une chaîne d'ACHAT et non une prise en charge. Les
 * fondre en une seule liste ferait proposer un « visa publicitaire » sur un congrès et une
 * « convention » sur une brochure : un menu qui propose tout n'aide plus à classer.
 *
 * « BON DE COMMANDE » est NOMMÉ par la Direction (22/09/2026 : « c'est pas un CTD complet etc.
 * qui doit s'afficher, c'est facture, bon de commande, demandes, convention etc. ») et il
 * manquait des deux côtés de la prise en charge — il n'existait que sur le matériel
 * promotionnel. C'est aussi la pièce que la chaîne devis → BC → facture va produire.
 *
 * Module PUR : des données de formulaire et une lecture du registre canonique, rien d'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export const AD_PRO_DOC_CATEGORIES: readonly string[] = [
  "REQUEST_LETTER", "CONVENTION", "PROGRAM", "QUOTE", "PURCHASE_ORDER", "INVOICE",
  "SUPPORTING_DOC", "PHOTO", "PRESENTATION", "POST_EVENT_REPORT", "OTHER",
];

/**
 * LE MATÉRIEL PROMOTIONNEL — une chaîne d'ACHAT, donc d'autres pièces.
 *
 * Elle vivait en DOUBLE, recopiée à l'identique dans `promo-material/[id]` et dans
 * `demandes/[id]` (le secrétariat voit les demandes de matériel depuis son écran). Deux copies
 * d'une liste finissent par diverger, et le symptôme serait une pièce classable depuis un écran
 * et pas depuis l'autre — sur le même enregistrement.
 */
export const PROMO_MATERIAL_DOC_CATEGORIES: readonly string[] = [
  "QUOTE", "PURCHASE_ORDER", "PAYMENT_SLIP", "PAYMENT_RECEIPT", "PROMO_MATERIAL_FILE",
  "AD_VISA", "INVOICE", "DELIVERY_NOTE", "SUPPORTING_DOC", "OTHER",
];

/**
 * LA LISTE D'UNE NATURE — dérivée du registre canonique, jamais d'un `if` par écran.
 *
 * Le type d'entité est la clé : c'est lui que le téléverseur reçoit déjà, et une huitième nature
 * ajoutée à `AD_PRO_KINDS` obtient sa liste sans que personne y pense. Une table écrite à la
 * main serait fausse ce jour-là, en silence (§118.73).
 */
export function categoriesDePieces(kind: AdProKind): readonly string[] {
  return kind === "PROMO_MATERIAL" ? PROMO_MATERIAL_DOC_CATEGORIES : AD_PRO_DOC_CATEGORIES;
}

/** Les types d'entité du pôle — ce sur quoi le cliquet d'écran s'arme (§118.17). */
export const AD_PRO_ENTITY_TYPES: readonly string[] = Object.values(AD_PRO_ENTITY_TYPE);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI A SA PLACE DANS LA CHAÎNE — et ne se dépose donc plus à côté (§118.161).
 *
 * Décision de la Direction (30/09/2026) : sur une fiche Ad & Pro, le bloc « Documents (devis, BC,
 * quittance, matériel, visa, facture…) » disparaît au profit des pièces LIÉES, structurées en
 * Devis → Bon de commande → Facture (chacun avec sa fiche au registre ET son PDF), puis une partie
 * « Engagements » (conventions d'orateurs, contrats, tout le reste). Un devis déposé comme simple
 * fichier sur la demande ET enregistré au registre, c'est la même dépense deux fois — un fichier
 * que rien ne rapproche du montant qu'il justifie (§118.109). Ces quatre catégories sortent donc
 * du dépôt de la demande : elles ont désormais une fiche.
 *
 * La CONVENTION est une nature d'ENGAGEMENT (`AGREEMENT`, « Convention / accord-cadre ») : une
 * convention d'orateur est un engagement de la société, exactement ce que la partie « Engagements »
 * reçoit.
 *
 * Les fichiers DÉJÀ déposés sous ces catégories ne disparaissent pas : ils sont montés dans la
 * section de leur nature, et « Créer sa fiche » les y range sans les téléverser une seconde fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type NatureDeChaine = "QUOTE" | "PURCHASE_ORDER" | "INVOICE" | "AGREEMENT";

export const NATURE_DE_LA_CATEGORIE: Readonly<Record<string, NatureDeChaine>> = {
  QUOTE: "QUOTE",
  PURCHASE_ORDER: "PURCHASE_ORDER",
  INVOICE: "INVOICE",
  CONVENTION: "AGREEMENT",
};

/** La nature de chaîne d'une catégorie de pièce — `null` : la pièce reste une pièce de la demande. */
export function natureDeLaCategorie(categorie: string | null | undefined): NatureDeChaine | null {
  return categorie ? NATURE_DE_LA_CATEGORIE[categorie] ?? null : null;
}

/**
 * LES CATÉGORIES QU'ON DÉPOSE ENCORE SUR LA DEMANDE ELLE-MÊME — la liste de la nature, moins ce
 * qui a sa place dans la chaîne. Dérivée, jamais recopiée : une catégorie ajoutée à la chaîne sort
 * du dépôt sans que personne y pense.
 */
export function categoriesDuDepotDeLaDemande(categories: readonly string[]): string[] {
  return categories.filter((c) => natureDeLaCategorie(c) === null);
}

/**
 * LA SECTION D'UNE PIÈCE LIÉE — la chaîne a ses trois maillons, tout le reste est un ENGAGEMENT.
 *
 * « Enlève les BC des engagements » (30/09/2026) : c'est ICI que le bon de commande quitte la
 * liste d'où la Direction l'a retiré. La règle a DEUX lecteurs qui n'ont pas le droit de se
 * parler — le chargeur de la fiche (serveur) qui range chaque pièce dans sa section, et le
 * formulaire de création (navigateur) qui propose les natures d'engagement. Écrite des deux
 * côtés, elle divergerait à la première nature ajoutée : le formulaire offrirait une « nature
 * d'engagement » que la fiche rangerait ailleurs, et la personne ne retrouverait pas sa pièce où
 * elle l'a créée (§118.5). Ce module est PUR (`labels` n'importe que des types) : les deux le lisent.
 */
export type SectionPieces = "QUOTE" | "PURCHASE_ORDER" | "INVOICE" | "ENGAGEMENT";

export function sectionDeLaNature(kind: string): SectionPieces {
  if (kind === "QUOTE") return "QUOTE";
  if (kind === "PURCHASE_ORDER") return "PURCHASE_ORDER";
  if (isInvoice(kind)) return "INVOICE";
  return "ENGAGEMENT";
}

/** Les natures qu'on crée depuis « Engagements » : tout Legal, moins les trois maillons de la chaîne. */
export function naturesDEngagement(): string[] {
  return Object.keys(LEGAL_DOC_KIND).filter((k) => sectionDeLaNature(k) === "ENGAGEMENT");
}

/** La catégorie d'un PDF déposé sur une pièce — celle de sa nature, pour qu'il se classe seul. */
export function categorieDuPdf(kind: string): string {
  if (kind === "QUOTE") return "QUOTE";
  if (kind === "PURCHASE_ORDER") return "PURCHASE_ORDER";
  if (isInvoice(kind)) return "INVOICE";
  if (kind === "AGREEMENT") return "CONVENTION";
  return "OTHER";
}
