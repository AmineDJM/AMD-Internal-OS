/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRAN « COMPTABILITÉ » — SES RÈGLES PURES (maquette validée par le Super Admin, 24/11/2026).
 *
 * Trois onglets (Dépenses, Recettes, Résultat), une ligne par écriture, une seule recherche (écritures ET factures
 * du registre Legal), un panneau par écriture ou par facture. Ce module dit, sans base ni fichier :
 *   • comment nommer l'autre partie (« Payé à » / « Reçu de » — le mot « bénéficiaire » quitte cet écran) ;
 *   • l'ORIGINE d'une écriture, déduite de ses liens réels (l'ordre qu'elle règle et sa source, la compensation,
 *     la facture réglée, l'import d'un relevé) — jamais saisie ;
 *   • l'ÉTAT d'une facture du registre (non payée, demandée, payée, encaissée…) et si l'on peut en demander le paiement ;
 *   • la règle de la saisie : une DÉPENSE ne s'enregistre pas sans justificatif ;
 *   • la période d'une liste, la recherche d'un montant, les motifs de contre-passation.
 *
 * Importé par le serveur (`infra/requetes/comptabilite.ts`, `actions-comptabilite.ts`) ET par l'écran, via `partage.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Les onglets et la période ───────────────────────────────

export type VueCompta = "dep" | "rec" | "res";

export function lireVueCompta(v: string | null | undefined): VueCompta {
  return v === "rec" || v === "res" ? v : "dep";
}

/** Le sens des écritures d'un onglet de liste — le Résultat n'en a pas. */
export const SENS_DE_LA_VUE: Record<Exclude<VueCompta, "res">, "OUT" | "IN"> = { dep: "OUT", rec: "IN" };

const MOIS_COURTS = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];
const MOIS_LONGS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

export interface PeriodeListe {
  /** `AAAA-MM` (un mois) ou `AAAA` (l'année). */
  cle: string;
  /** Premier et dernier mois couverts, `AAAA-MM`. */
  debut: string;
  fin: string;
  libelle: string;
}

const moisPrecedent = (m: string): string => {
  const [a, mm] = m.split("-").map(Number) as [number, number];
  return mm === 1 ? `${a - 1}-12` : `${a}-${String(mm - 1).padStart(2, "0")}`;
};

/** « Nov. 2026 » */
export function libelleMoisCourt(m: string): string {
  const [a, mm] = m.split("-").map(Number) as [number, number];
  return `${MOIS_COURTS[mm - 1]} ${a}`;
}

/** « Novembre 2026 » */
export function libelleMoisLong(m: string): string {
  const [a, mm] = m.split("-").map(Number) as [number, number];
  return `${MOIS_LONGS[mm - 1]} ${a}`;
}

/** Les trois choix de la maquette : le mois en cours, le précédent, l'année en cours. */
export function choixDePeriode(moisCourant: string): PeriodeListe[] {
  const annee = moisCourant.slice(0, 4);
  const prec = moisPrecedent(moisCourant);
  return [
    { cle: moisCourant, debut: moisCourant, fin: moisCourant, libelle: libelleMoisCourt(moisCourant) },
    { cle: prec, debut: prec, fin: prec, libelle: libelleMoisCourt(prec) },
    { cle: annee, debut: `${annee}-01`, fin: `${annee}-12`, libelle: `Année ${annee}` },
  ];
}

/**
 * LA PÉRIODE D'UNE LISTE, lue dans l'adresse : `AAAA-MM` ou `AAAA`. Illisible ou absente : le mois en cours — un lien
 * « Voir les dépenses du mois » du Résultat peut viser n'importe quel mois, il est donc lu tel quel s'il est valide.
 */
export function lirePeriodeListe(brut: string | null | undefined, moisCourant: string): PeriodeListe {
  const v = (brut ?? "").trim();
  const mois = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(v);
  if (mois) return { cle: v, debut: v, fin: v, libelle: libelleMoisCourt(v) };
  if (/^\d{4}$/.test(v)) return { cle: v, debut: `${v}-01`, fin: `${v}-12`, libelle: `Année ${v}` };
  return choixDePeriode(moisCourant)[0]!;
}

// ─────────────────────────────── L'autre partie ───────────────────────────────

/** « Payé à » pour une dépense, « Reçu de » pour une recette. */
export function libelleTiers(direction: string): "Payé à" | "Reçu de" {
  return direction === "IN" ? "Reçu de" : "Payé à";
}

// ─────────────────────────────── L'origine d'une écriture ───────────────────────────────

/**
 * LA FAMILLE D'UNE SOURCE D'ORDRE — ce que les Finances lisent en petit sous l'objet. Une source absente de la table
 * garde le libellé de son type, jamais « Autre » : un nouveau circuit se voit sous son nom.
 */
const FAMILLE_DE_SOURCE: Record<string, string> = {
  AD_PRO_ITEM: "Ad & Pro",
  AD_PRO_OTHER: "Ad & Pro",
  SPONSORING: "Ad & Pro",
  CONGRESS_NATIONAL: "Ad & Pro",
  CONGRESS_INTERNATIONAL: "Ad & Pro",
  EVENT: "Ad & Pro",
  PROMO_MATERIAL: "Matériel promotionnel",
  CONSULTING_CONTRACT: "Consulting",
  PAYROLL: "Paie",
  SALARY_ADVANCE: "Paie",
  REGULATORY_PRODUCT: "BV",
  MEDICAL_INFO_DECLARATION: "Information médicale",
  PAYMENT_REQUEST: "Demande de paiement",
  ADMIN_REQUEST: "Secrétariat",
  LEGAL_DOCUMENT: "Facture",
  PCH_TENDER: "PCH",
  PCH_ORDER: "PCH",
  DOCUMENT_REQUEST: "Secrétariat",
};

/** Une note posée par l'import d'un relevé — c'est par elle qu'une écriture importée se reconnaît. */
export const NOTE_IMPORT_RELEVE = "Importée d'un relevé bancaire.";

export interface IndicesOrigine {
  /** La catégorie comptable de l'écriture (`FinanceCategory`). */
  category: string;
  /** L'ordre de dépense que l'écriture règle, s'il y en a un. */
  ordre?: { reference: string; sourceType: string | null; category: string; caisse: boolean } | null;
  /** `CONTRE_PASSATION` / `A_RECUPERER` — l'écriture compense une autre. */
  compensation?: string | null;
  /** La référence (ou le titre) de la facture du registre que cette écriture a réglée directement. */
  factureReglee?: string | null;
  /** La virement de paie dont l'écriture est le règlement (sans ordre — l'ancien circuit). */
  paie?: boolean;
  notes?: string | null;
}

/**
 * L'ORIGINE, en petit sous l'objet : « Ad & Pro · OD-2026-412 », « Paie », « Caisse · OD-… », « Impôts & cotisations »,
 * « Import relevé », « Écriture manuelle ». Dérivée des LIENS de l'écriture, dans l'ordre où ils sont sûrs : une
 * compensation se dit d'abord (elle n'a pas d'autre source), puis l'ordre réglé et sa source, la paie, la facture
 * réglée directement, l'import, la catégorie qui suffit à dire l'origine (impôts, frais bancaires), et enfin la saisie.
 */
export function origineDeLEcriture(i: IndicesOrigine): string {
  if (i.compensation === "CONTRE_PASSATION") return "Contre-passation";
  if (i.compensation === "A_RECUPERER") return "À récupérer";
  if (i.ordre) {
    const famille = i.ordre.caisse
      ? "Caisse"
      : i.ordre.sourceType
        ? FAMILLE_DE_SOURCE[i.ordre.sourceType] ?? i.ordre.sourceType
        : familleDeCategorie(i.ordre.category) ?? "Ordre de dépense";
    return `${famille} · ${i.ordre.reference}`;
  }
  if (i.paie) return "Paie";
  if (i.factureReglee) return `Facture · ${i.factureReglee}`;
  if (i.notes?.startsWith(NOTE_IMPORT_RELEVE)) return "Import relevé";
  return familleDeCategorie(i.category) ?? "Écriture manuelle";
}

function familleDeCategorie(category: string): string | null {
  if (category === "IMPOT") return "Impôts & cotisations";
  if (category === "SALAIRE" || category === "AVANCE") return "Paie";
  if (category === "BANQUE") return "Frais bancaires";
  return null;
}

/** Une écriture sans dossier d'origine est sa propre source : le lien « origine ↗ » ne s'affiche pas. */
export function origineSansDossier(origine: string): boolean {
  return !origine.includes(" · ") || origine.startsWith("Facture · ");
}

// ─────────────────────────────── Le justificatif ───────────────────────────────

/** « ✓ Facture F-0912.pdf » / « ✕ manquant » — la colonne de la liste. */
export function libelleJustificatif(pieces: readonly { nom: string }[], demandee = false): { present: boolean; libelle: string } {
  const premiere = pieces[0];
  if (premiere) return { present: true, libelle: `✓ ${premiere.nom}` };
  return { present: false, libelle: demandee ? "✕ manquant · demandé" : "✕ manquant" };
}

/**
 * LA RÈGLE DE LA SAISIE (Super Admin, 24/11/2026 — « tout paiement porte une pièce ») : une DÉPENSE ne s'enregistre pas
 * sans justificatif. Une recette, oui (la pièce y est « conseillée ») : refuser un encaissement faute de papier
 * ferait disparaître de l'argent reçu. Le message dit le remède.
 */
export const REFUS_DEPENSE_SANS_JUSTIFICATIF =
  "Joignez le justificatif : une dépense ne s'enregistre pas sans pièce (facture, proforma, état de paie, bordereau, quittance…).";

export function refusDepenseSansJustificatif(direction: string, nbPieces: number): string | null {
  return direction === "OUT" && nbPieces === 0 ? REFUS_DEPENSE_SANS_JUSTIFICATIF : null;
}

/** Les types de pièce proposés à la saisie, et la catégorie de document sous laquelle le fichier est rangé. */
export const TYPES_PIECE: Record<"OUT" | "IN", readonly { libelle: string; categorie: string }[]> = {
  OUT: [
    { libelle: "Facture", categorie: "INVOICE" },
    { libelle: "Proforma", categorie: "PROFORMA" },
    { libelle: "Lettre de demande", categorie: "REQUEST_LETTER" },
    { libelle: "État de paie", categorie: "SUPPORTING_DOC" },
    { libelle: "Bordereau", categorie: "PAYMENT_SLIP" },
    { libelle: "Quittance", categorie: "PAYMENT_RECEIPT" },
    { libelle: "Bon de remise", categorie: "SUPPORTING_DOC" },
  ],
  IN: [
    { libelle: "Facture de vente", categorie: "INVOICE" },
    { libelle: "Avis de crédit", categorie: "SUPPORTING_DOC" },
    { libelle: "Bon de versement", categorie: "PAYMENT_SLIP" },
  ],
};

/** La catégorie de document d'un type de pièce choisi — `OTHER` pour un libellé inconnu (jamais un refus). */
export function categorieDuTypePiece(libelle: string | null | undefined): string {
  for (const liste of Object.values(TYPES_PIECE)) {
    const t = liste.find((x) => x.libelle === libelle);
    if (t) return t.categorie;
  }
  return "OTHER";
}

/** Les catégories comptables proposées à la saisie, selon le sens (les valeurs de `FinanceCategory`). */
export const CATEGORIES_SAISIE: Record<"OUT" | "IN", readonly string[]> = {
  OUT: ["FOURNISSEUR", "EVENEMENT", "SALAIRE", "AVANCE", "IMPOT", "LOYER", "CHARGES", "VOYAGE", "BUREAUTIQUE", "BANQUE", "REMBOURSEMENT", "AUTRE"],
  IN: ["RECETTE", "CCA", "PRET", "AUTRE"],
};

// ─────────────────────────────── Les factures du registre ───────────────────────────────

export type EtatFacture = "NON_PAYEE" | "DEMANDEE" | "PAYEE" | "NON_ENCAISSEE" | "ENCAISSEE";

export interface FactureLue {
  /** `IN` = facture ÉMISE (la société encaisse) ; tout autre valeur = facture reçue (la société paie). */
  direction: string | null;
  paidDate: Date | string | null;
  /** L'écriture qui l'a réglée directement. */
  settlementTxId: string | null;
  /** L'ordre de dépense envoyé au règlement depuis Legal. */
  expenseOrderId: string | null;
  /** L'état de cet ordre, s'il existe (`PAID` = réglé). */
  statutOrdre?: string | null;
  /** Les demandes de paiement VIVANTES qui la portent en pièce. */
  demandes: readonly string[];
  /** Rattachée comme justificatif d'un paiement déjà fait (`FinanceTransaction.justificatifFactureId`). */
  justifiePaiement?: boolean;
}

export const LIBELLE_ETAT_FACTURE: Record<EtatFacture, string> = {
  NON_PAYEE: "Facture non payée",
  DEMANDEE: "Paiement demandé",
  PAYEE: "Payée",
  NON_ENCAISSEE: "Non encaissée",
  ENCAISSEE: "Encaissée",
};

/**
 * OÙ EN EST UNE FACTURE — lue dans ses liens. Une facture ÉMISE s'encaisse (réglée = date ou écriture). Une facture
 * REÇUE est payée quand elle porte une date de règlement, une écriture, un ordre RÉGLÉ, ou qu'elle justifie un paiement ; « demandée » quand un ordre
 * vivant ou une demande de paiement vivante la porte ; sinon elle n'est pas payée — c'est elle que la recherche ramène
 * avec le geste « Créer sa demande de paiement ».
 */
export function etatDeLaFacture(f: FactureLue): EtatFacture {
  const reglee = Boolean(f.paidDate) || Boolean(f.settlementTxId);
  if (f.direction === "IN") return reglee ? "ENCAISSEE" : "NON_ENCAISSEE";
  if (reglee || f.statutOrdre === "PAID" || f.justifiePaiement) return "PAYEE";
  const ordreVivant = Boolean(f.expenseOrderId) && f.statutOrdre !== "CANCELLED";
  if (ordreVivant || f.demandes.length > 0) return "DEMANDEE";
  return "NON_PAYEE";
}

/** Le geste « Créer sa demande de paiement » : une facture REÇUE, que rien ne paie ni ne demande encore. */
export function peutDemanderLePaiement(etat: EtatFacture): boolean {
  return etat === "NON_PAYEE";
}

/** Le geste « Rattacher à un paiement fait » : la même facture — un paiement déjà parti la justifie. */
export function peutRattacherAUnPaiement(etat: EtatFacture): boolean {
  return etat === "NON_PAYEE";
}

// ─────────────────────────────── La recherche ───────────────────────────────

/** Le texte cherché, ramené à l'essentiel (espaces de début et de fin), borné. */
export function texteRecherche(q: string | null | undefined): string {
  return (q ?? "").trim().slice(0, 80);
}

/**
 * UN MONTANT DANS LA RECHERCHE — « 450 000 », « 450000 », « 450 000,00 DZD » : le nombre, ou `null` si le texte n'est
 * pas un montant. Moins de trois chiffres n'est pas un montant (« F-12 » ne doit pas chercher 12 DZD).
 */
export function montantRecherche(q: string): number | null {
  const sansDevise = q.replace(/\s*(dzd|da)\s*$/i, "").replace(/[\s  ]/g, "");
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(sansDevise)) return null;
  const n = Number(sansDevise.replace(",", "."));
  return Number.isFinite(n) && Math.trunc(n).toString().length >= 3 ? n : null;
}

// ─────────────────────────────── La contre-passation ───────────────────────────────

export const MOTIFS_CONTRE_PASSATION = ["Saisie en double", "Erreur de montant", "Mauvais compte", "Paiement rejeté par la banque"] as const;

/**
 * LE MOTIF D'UNE CONTRE-PASSATION — obligatoire : une écriture inverse sans raison ne se relit pas. Un motif de la
 * liste, ou une précision libre ; les deux se joignent. `null` = refus (aucun motif).
 */
export function motifDeContrePassation(motif: string | null | undefined, precision: string | null | undefined): string | null {
  const m = (motif ?? "").trim().slice(0, 120);
  const p = (precision ?? "").trim().slice(0, 300);
  if (!m && !p) return null;
  return m && p ? `${m} — ${p}` : m || p;
}

export const REFUS_CONTRE_PASSATION_SANS_MOTIF = "Choisissez un motif : une contre-passation sans raison ne se relit pas.";
