/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE DEMANDE DE PAIEMENT — CHOISIES DANS LEGAL, OU DÉPOSÉES ET LUES (Direction, 04/11/2026).
 *
 * « Toute demande de paiement repose sur un document. » Le formulaire se remplit depuis lui :
 *   • une pièce CHOISIE DANS LEGAL apporte ce que le registre sait déjà (objet, partie, montant,
 *     référence, échéance) ; son fichier est RÉFÉRENCÉ, jamais recopié ;
 *   • une pièce DÉPOSÉE est lue comme dans « Nouveau document » ; une facture ou un devis entre au
 *     registre Legal (`natureAInscrireAuLegal`) — la prochaine fois, on la choisit au lieu de la redéposer.
 *
 * Plusieurs pièces : celle qui REMPLIT est la facture, sinon le BC, sinon le devis, sinon le contrat
 * (`pieceQuiRemplit`) ; les autres sont jointes. Un champ que la personne a touché n'est jamais réécrit.
 *
 * UNE FACTURE NE SE DEMANDE QU'UNE FOIS : déjà dans une demande vivante, déjà envoyée au règlement, ou
 * déjà réglée — elle est montrée, avec la raison, et refusée (`refusReutilisation`). Les autres natures
 * (un BC, un devis, un contrat justifient plusieurs paiements) sont seulement signalées.
 *
 * Module PUR : le formulaire (navigateur) et l'action (serveur) lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La nature d'une pièce de demande (`PaymentPieceKind`). */
export type NaturePieceDemande = "INVOICE" | "PURCHASE_ORDER" | "QUOTE" | "DELIVERY_NOTE" | "CONTRACT" | "PROOF" | "OTHER";

/** Les natures du registre Legal qui justifient un paiement — celles que « Choisir dans Legal » propose. */
export const NATURES_LEGAL_PAYABLES = ["INVOICE", "PURCHASE_ORDER", "QUOTE", "CONTRACT"] as const;

/** La nature de pièce d'un document Legal. */
export function natureDePieceDuLegal(kind: string): NaturePieceDemande {
  return (NATURES_LEGAL_PAYABLES as readonly string[]).includes(kind) ? (kind as NaturePieceDemande) : "OTHER";
}

/** La nature lue sur une pièce déposée (`LegalDocKind` de la lecture) → la nature de la pièce de demande. */
export function natureDePieceLue(kindLu: string | null | undefined): NaturePieceDemande | null {
  if (!kindLu) return null;
  if (kindLu === "DELIVERY_NOTE") return "DELIVERY_NOTE";
  const n = natureDePieceDuLegal(kindLu);
  return n === "OTHER" ? null : n;
}

const RANG: Partial<Record<NaturePieceDemande, number>> = { INVOICE: 0, PURCHASE_ORDER: 1, QUOTE: 2, CONTRACT: 3 };

/** LA PIÈCE QUI REMPLIT le formulaire : la facture, sinon le BC, sinon le devis, sinon le contrat ; à égalité, la première. */
export function pieceQuiRemplit<T extends { nature: string }>(pieces: readonly T[]): T | null {
  let meilleure: T | null = null;
  let rang = Infinity;
  for (const p of pieces) {
    const r = RANG[p.nature as NaturePieceDemande] ?? Infinity;
    if (r < rang) { meilleure = p; rang = r; }
  }
  return meilleure;
}

/** Une pièce déposée de ces natures entre au registre Legal. Le BC, lui, n'y entre pas par ce chemin : y naître
 *  l'enverrait à un centre de validation (tout BC du registre passe par un centre) — il reste joint à la demande. */
export function natureAInscrireAuLegal(nature: string): "INVOICE" | "QUOTE" | null {
  return nature === "INVOICE" || nature === "QUOTE" ? nature : null;
}

/** Les demandes « vivantes » : tout sauf refusée ou annulée (un brouillon garde déjà sa facture). */
export const STATUTS_DEMANDE_VIVANTE = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED", "APPROVED"] as const;

/** Ce que le registre sait de l'usage d'un document Legal en paiement. */
export interface UsageDocumentLegal {
  /** Les demandes vivantes qui le portent déjà en pièce. */
  demandes: readonly string[];
  /** La facture a été envoyée au règlement depuis Legal (`expenseOrderId`). */
  envoyeAuReglement: boolean;
  /** La facture est réglée (`paidDate`). */
  regle: boolean;
}

/** L'AVERTISSEMENT de la liste « Choisir dans Legal » — `null` si rien à dire. */
export function avertissementUsage(u: UsageDocumentLegal): string | null {
  if (u.regle) return "Déjà réglée.";
  if (u.envoyeAuReglement) return "Déjà envoyée au règlement depuis Legal.";
  if (u.demandes.length > 0) return `Déjà dans la demande ${u.demandes.join(", ")}.`;
  return null;
}

/** LE REFUS : une facture ne repart pas au paiement. Les autres natures passent (signalées par `avertissementUsage`). */
export function refusReutilisation(nature: string, titre: string, u: UsageDocumentLegal): string | null {
  if (nature !== "INVOICE") return null;
  const raison = avertissementUsage(u);
  return raison ? `La facture « ${titre} » ne peut pas être demandée une seconde fois : ${raison.charAt(0).toLowerCase()}${raison.slice(1)}` : null;
}

/** LE TITRE d'une pièce déposée qui entre au registre : « Facture FA-2026-12 — Atlas », à défaut le nom du fichier. */
export function titrePourLeRegistre(i: { nature: "INVOICE" | "QUOTE"; reference: string | null; beneficiaire: string | null; nomFichier: string }): string {
  const nature = i.nature === "INVOICE" ? "Facture" : "Devis";
  const tete = i.reference ? `${nature} ${i.reference}` : `${nature} — ${i.nomFichier.replace(/\.[a-z0-9]+$/i, "")}`;
  return (i.beneficiaire ? `${tete} — ${i.beneficiaire}` : tete).slice(0, 200);
}

/** Une ligne de « Choisir dans Legal ». */
export interface DocumentLegalPropose {
  id: string;
  titre: string;
  nature: NaturePieceDemande;
  kind: string;
  partie: string | null;
  reference: string | null;
  montant: number | null;
  date: string | null;
  fichiers: number;
  avertissement: string | null;
  /** Une facture déjà demandée, envoyée ou réglée ne se choisit pas. */
  refus: string | null;
}

// ─────────────────────────────── Le remplissage du formulaire ───────────────────────────────

/** Les champs du formulaire que les pièces remplissent. */
export type ChampRempli = "title" | "payee" | "amount" | "dueDate" | "contactPhone" | "contactEmail";

/** Ce qu'une pièce propose — des chaînes prêtes pour les champs (montant en chiffres, date AAAA-MM-JJ). */
export type Proposition = Partial<Record<ChampRempli, string>>;

/**
 * CE QUI S'ÉCRIT : chaque champ proposé et non vide, SAUF ceux que la personne a touchés. Rend les valeurs à poser.
 * Un champ rempli par une pièce reste « non touché » : une meilleure pièce (une facture après un devis) le réécrit.
 */
/** Ce qu'une pièce propose au formulaire — ou pourquoi elle n'a pas pu être lue. */
/** Un contact de l'annuaire, tel que le formulaire l'affiche et le reprend (mêmes champs que l'annuaire visible). */
export interface ContactDeLAnnuaire {
  id: string; name: string; kind: string | null; contactName: string | null; email: string | null;
  phone: string | null; phoneAlt: string | null; city: string | null; companyLabel: string | null;
}

/**
 * CE QUE LA PIÈCE DIT DE SON BÉNÉFICIAIRE, RAPPROCHÉ DE L'ANNUAIRE (Direction, 08/11/2026).
 *
 * `retenu` seulement quand c'est CERTAIN : même NIF ou RC qu'une fiche, la fiche liée au document du registre Legal,
 * ou UNE SEULE fiche portant exactement le nom lu. Le formulaire le choisit alors de lui-même (et le dit, `preuve`).
 * Sinon des `candidats` proches, que la personne départage ; ou, absent de l'annuaire, ce qu'il faudrait y créer.
 */
export interface AnnuaireDeLaPiece {
  retenu: ContactDeLAnnuaire | null;
  preuve: string | null;
  candidats: { id: string; nom: string }[];
  aCreer: { nom: string | null; nif: string | null; rc: string | null; adresse: string | null } | null;
}

export type LecturePourDemande =
  | { ok: true; nature: NaturePieceDemande | null; proposition: Proposition; ribLu: boolean; phrase: string; annuaire: AnnuaireDeLaPiece }
  | { ok: false; error: string };

export function aRemplir(proposition: Proposition, touches: ReadonlySet<string>): Proposition {
  const out: Proposition = {};
  for (const [champ, valeur] of Object.entries(proposition) as [ChampRempli, string | undefined][]) {
    if (valeur && valeur.trim() && !touches.has(champ)) out[champ] = valeur.trim();
  }
  return out;
}

/**
 * UNE DEMANDE EN COURS DE LA PERSONNE, telle que « Demander un paiement » la rappelle (Direction, 09/11/2026 : « il voit
 * ses demandes précédentes et peut les modifier ») — pour ajouter un fichier à la demande qui existe déjà au lieu d'en
 * ouvrir une seconde pour le même paiement.
 */
export interface DemandeEnCours {
  id: string;
  reference: string;
  title: string;
  payee: string;
  amount: number;
  status: string;
  /** Pièces en vigueur (les remplacées ne comptent plus). */
  pieces: number;
  /** ISO. */
  majLe: string;
  /** Les fichiers en vigueur — pour les CHANGER depuis « Demander un paiement » (Direction, 09/11/2026 : « changer le
   *  fichier, pas seulement en ajouter »). `remplacable` = ce que l'action accepterait (`refusDeRemplacement`). */
  fichiers: FichierEnCours[];
}

export interface FichierEnCours {
  id: string;
  documentId: string;
  nom: string;
  kind: string;
  status: string;
  remplacable: boolean;
  /** Pourquoi il ne se remplace pas (le message de l'action) — null s'il se remplace. */
  refus: string | null;
}
