/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DOCUMENTS COMMERCIAUX — devis, bon de commande, facture : ce qu'ils portent, ce qu'ils
 * calculent, ce qui les rend valides.
 *
 * ── LES CHIFFRES SONT CALCULÉS PAR LE CODE, JAMAIS RECOPIÉS D'UN MODÈLE ─────────────────
 *
 * Un modèle de langage propose des lignes (désignation, quantité, prix). Le montant HT de la
 * ligne, la remise, la TVA par taux, le timbre, le TTC et le montant en lettres sont dérivés
 * ICI, avec des arrondis au centime définis une fois. Un total « tapé » par le modèle n'existe
 * pas dans la spécification : il n'y a pas de champ pour l'écrire.
 *
 * ── LES MENTIONS OBLIGATOIRES SONT VÉRIFIÉES, PAS ESPÉRÉES ──────────────────────────────
 *
 * Une facture algérienne sans NIF, sans RC ou sans article d'imposition de l'émetteur est une
 * facture qu'un comptable rejette. `verifierSpecCommerciale` refuse d'en produire une : le
 * bloquant nomme le champ manquant, et la personne le renseigne dans la carte d'identité de la
 * société (Legal) — une fois, pour toutes les factures suivantes. Un devis ou un bon de commande
 * sans ces mentions se produit, avec un avertissement.
 *
 * Module PUR : ni base, ni fichier, ni session — et aucun module Node : l'écran de composition
 * des Finances lit les mêmes constantes. L'EMPREINTE (qui hache) vit dans `empreinte.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { montantEnLettres } from "@/lib/artifact/factory/lettres";

/**
 * Les pièces que la fabrique émet. L'AVOIR (§118.195) corrige une FACTURE émise — qui, elle, ne se réécrit pas :
 * il naît de SA facture (`chainFromId`), sous son propre numéro, et ne peut pas dépasser ce qui reste à créditer.
 */
export const TYPES_DOCUMENT = ["DEVIS", "BON_DE_COMMANDE", "FACTURE", "AVOIR"] as const;
export type TypeDocumentCommercial = (typeof TYPES_DOCUMENT)[number];

export const LIBELLE_TYPE: Record<TypeDocumentCommercial, string> = {
  DEVIS: "Devis",
  BON_DE_COMMANDE: "Bon de commande",
  FACTURE: "Facture",
  AVOIR: "Avoir",
};

/** Le pluriel, écrit : « des bons de commande » — jamais « des bon de commandes », que le suffixe `s` collé au libellé produisait. */
export const PLURIEL_TYPE: Record<TypeDocumentCommercial, string> = { DEVIS: "devis", BON_DE_COMMANDE: "bons de commande", FACTURE: "factures", AVOIR: "avoirs" };

/** LE BLEU CANARD DE LA MAISON (R 8, V 112, B 132) — l'accent d'une pièce quand la marque de la société n'en règle pas un autre. */
export const ACCENT_MAISON = "087084";

/** Le préfixe de numérotation par défaut — le profil documentaire d'une société peut le changer. */
export const PREFIXE_DEFAUT: Record<TypeDocumentCommercial, string> = { DEVIS: "DEV", BON_DE_COMMANDE: "BC", FACTURE: "FA", AVOIR: "AV" };

/** La nature Legal correspondante : un document émis EST une pièce du registre (§17). */
export const NATURE_LEGALE: Record<TypeDocumentCommercial, "QUOTE" | "PURCHASE_ORDER" | "INVOICE" | "CREDIT_NOTE"> = {
  DEVIS: "QUOTE",
  BON_DE_COMMANDE: "PURCHASE_ORDER",
  FACTURE: "INVOICE",
  AVOIR: "CREDIT_NOTE",
};

/** Une pièce FISCALE — une facture, ou l'avoir qui la corrige : les mêmes mentions obligatoires. */
export const estPieceFiscale = (type: TypeDocumentCommercial): boolean => type === "FACTURE" || type === "AVOIR";

/** Les taux de TVA en vigueur en Algérie : exonéré, réduit, normal. Tout autre taux est refusé. */
export const TAUX_TVA_ADMIS = [0, 0.09, 0.19] as const;
export const TVA_NORMALE = 0.19;

/**
 * LE DROIT DE TIMBRE sur un règlement en espèces : 1 % du TTC, plancher 5 DZD, plafond 2 500 DZD
 * (code du timbre, art. 100). Appliqué seulement quand le mode de paiement est ESPECES ; un
 * virement ou un chèque n'en porte pas.
 */
export const TIMBRE_FISCAL = { taux: 0.01, min: 5, max: 2_500 } as const;

export const MODES_PAIEMENT = ["VIREMENT", "CHEQUE", "ESPECES", "AUTRE"] as const;
export type ModePaiement = (typeof MODES_PAIEMENT)[number];
export const LIBELLE_MODE: Record<ModePaiement, string> = { VIREMENT: "Virement bancaire", CHEQUE: "Chèque", ESPECES: "Espèces", AUTRE: "À convenir" };

/** L'émetteur ou le tiers — ce qui figure sur la pièce. */
export interface PartieCommerciale {
  nom: string;
  formeJuridique?: string | null;
  capital?: string | null;
  adresse?: string | null;
  rc?: string | null;
  nif?: string | null;
  /** Article d'imposition. */
  ai?: string | null;
  nis?: string | null;
  telephone?: string | null;
  email?: string | null;
  banque?: string | null;
  rib?: string | null;
}

export interface LigneCommerciale {
  designation: string;
  quantite: number;
  unite?: string | null;
  /** Prix unitaire HORS TAXES. */
  prixUnitaire: number;
  /** Remise de ligne, en fraction (0,1 = 10 %). */
  remise?: number | null;
  /** Taux de TVA de la ligne, en fraction. Absent = le taux par défaut du document. */
  tva?: number | null;
  reference?: string | null;
  /**
   * LES LIGNES DE DÉTAIL sous la désignation — « Format A4 », « Impression quadri recto verso sur
   * 300 g », « Forfait 10 exemplaires » : le bon de commande de référence de la société en porte
   * jusqu'à cinq par article. Elles se lisent, elles ne se chiffrent pas.
   */
  details?: string[] | null;
  /**
   * UNE LIGNE DE SECTION — « Campagne Raltégravir » : un titre dans le tableau, sans quantité ni
   * prix, qui regroupe les lignes qui suivent. Elle n'entre dans aucun total et n'est pas numérotée.
   */
  section?: boolean | null;
}

/** Une taxe ADDITIONNELLE au HT — « Taxe Pub 2 % » sur le BC de référence : hors base de TVA. */
export interface TaxeAdditionnelle {
  libelle: string;
  /** En fraction (0,02 = 2 %). */
  taux: number;
}

export interface SpecDocumentCommercial {
  type: TypeDocumentCommercial;
  /** Le numéro attribué par le registre : « FA-2026-0007 ». */
  numero: string;
  /** Date d'émission, ISO `AAAA-MM-JJ`. */
  date: string;
  emetteur: PartieCommerciale;
  tiers: PartieCommerciale;
  lignes: LigneCommerciale[];
  /** Le taux de TVA appliqué aux lignes qui n'en déclarent pas. Défaut : 19 %. */
  tvaDefaut?: number | null;
  /** Remise globale sur le total HT, en fraction. */
  remiseGlobale?: number | null;
  modePaiement?: ModePaiement | null;
  conditionsPaiement?: string | null;
  /** Échéance de règlement (facture), ISO. */
  echeance?: string | null;
  /** Durée de validité d'un devis, en jours. */
  validiteJours?: number | null;
  objet?: string | null;
  /** « Suivant devis n° DEV-2026-0012 » — la pièce amont, en clair. */
  referenceAmont?: string | null;
  /** La date de la pièce amont (« Du 20/07/2026 » sous le numéro du devis), ISO. */
  referenceAmontDate?: string | null;
  /** Le numéro que la société donne à ce client dans sa comptabilité (« 00003 »). */
  numeroClient?: string | null;
  /** L'interlocuteur nommé sur la pièce (« Mme ABDELAZIZ ASSIA — Tel 0770530674 »). */
  contact?: { nom?: string | null; telephone?: string | null } | null;
  /**
   * LES TAXES ADDITIONNELLES, calculées sur le total HT et HORS base de TVA — c'est ainsi que le
   * bon de commande de référence les porte : 794 500 HT, Taxe Pub 2 % = 15 890, TVA 19 % =
   * 150 955 (= 19 % de 794 500, pas de 810 390), TTC 961 345.
   */
  taxes?: TaxeAdditionnelle[] | null;
  /** `adresse` = le LIEU de livraison ; `date` = la date de livraison (ISO, imprimée en mention) ; `delai` = le délai en clair. */
  livraison?: { adresse?: string | null; delai?: string | null; date?: string | null } | null;
  notes?: string | null;
  signataire?: { nom: string; qualite?: string | null } | null;
  /** Mentions de pied de page (identité légale, banque) — composées par l'appelant. */
  piedDePage?: string[] | null;
  /** Couleur d'accent (hexadécimale, avec ou sans dièse). */
  couleur?: string | null;
  /** Vrai quand le document sera posé sur un papier en-tête : l'identité de l'émetteur y est déjà. */
  surPapierEnTete?: boolean;
  /**
   * LES COORDONNÉES DE L'ÉMETTEUR CHOISIES POUR CETTE PIÈCE (Direction, 10/2026 — « l'adresse mail dépend de la société,
   * elle doit pouvoir se modifier »). Absent = celles de la société émettrice (carte Legal, marque) ; une clé PRÉSENTE
   * gouverne le corps ET le pied de la pièce — `null` n'imprime rien. Jamais les coordonnées d'une autre société : il n'y a
   * pas de valeur par défaut ailleurs que dans la carte de la société qui émet. `emetteur` porte déjà le résultat ; ce
   * champ garde le CHOIX, pour qu'une révision le reprenne au lieu de revenir à la carte.
   */
  coordonneesEmetteur?: CoordonneesEmetteur | null;
  /**
   * LES MENTIONS PROPRES À CETTE PIÈCE (« Livraison franco », « Toute réclamation sous 8 jours ») — imprimées au pied,
   * après celles de la société. Gardées à part de `piedDePage` (qui en est le résultat) pour qu'une révision les reprenne.
   */
  mentionsPiece?: string[] | null;
}

/** Les coordonnées de l'émetteur qu'une pièce peut imprimer autrement que sa carte (voir `coordonneesEmetteur`). */
export interface CoordonneesEmetteur {
  adresse?: string | null;
  telephone?: string | null;
  email?: string | null;
}

export interface LigneCalculee extends LigneCommerciale {
  /** Le rang parmi les lignes CHIFFRÉES ; 0 pour une ligne de section. */
  n: number;
  section: boolean;
  taux: number;
  /** Quantité × prix unitaire, avant remise. */
  brut: number;
  remiseMontant: number;
  /** Le montant HT net de la ligne. */
  ht: number;
}

export interface TotauxCommerciaux {
  lignes: LigneCalculee[];
  totalHtBrut: number;
  /** Remises de ligne cumulées. */
  remisesLignes: number;
  /** Remise globale, en montant. */
  remiseGlobale: number;
  /** Le total HT après toutes les remises — la base de la TVA. */
  totalHt: number;
  tva: { taux: number; base: number; montant: number }[];
  totalTva: number;
  /** Les taxes additionnelles, chacune avec sa base (le HT) et son montant. */
  taxes: { libelle: string; taux: number; base: number; montant: number }[];
  totalTaxes: number;
  timbre: number;
  totalTtc: number;
  enLettres: string;
}

// ─────────────────────────── L'arithmétique ───────────────────────────

/** Arrondi au centime, demi-centime vers le haut, stable aux flottants (2,675 → 2,68). */
export function arrondirCentimes(x: number): number {
  const signe = x < 0 ? -1 : 1;
  const c = Math.round(Number((Math.abs(x) * 100).toFixed(6)));
  return (signe * c) / 100;
}

const fraction = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Ce que le calcul LIT d'une pièce — et rien d'autre. Une spécification complète s'y passe telle
 * quelle ; le contrôle d'une pièce LUE (`pieces-lues/controle.ts`) n'a que ses lignes, ses taux et
 * son mode de paiement, et passe par la MÊME arithmétique au lieu d'en écrire une seconde (§118.5).
 */
export type BaseDeCalcul = Pick<SpecDocumentCommercial, "lignes" | "tvaDefaut" | "remiseGlobale" | "taxes" | "modePaiement">;

export function calculerTotaux(spec: BaseDeCalcul): TotauxCommerciaux {
  const tauxDefaut = spec.tvaDefaut === null || spec.tvaDefaut === undefined ? TVA_NORMALE : spec.tvaDefaut;
  let rang = 0;
  const lignes: LigneCalculee[] = spec.lignes.map((l) => {
    // UNE SECTION NE COMPTE PAS : ni dans les totaux, ni dans la numérotation. Lui donner un rang
    // décalerait « ligne 3 » entre l'écran et le tiers qui relit la pièce.
    if (l.section) return { ...l, n: 0, section: true, taux: tauxDefaut, brut: 0, remiseMontant: 0, ht: 0 };
    const brut = arrondirCentimes(l.quantite * l.prixUnitaire);
    const remiseMontant = arrondirCentimes(brut * fraction(l.remise));
    const ht = arrondirCentimes(brut - remiseMontant);
    const taux = l.tva === null || l.tva === undefined ? tauxDefaut : l.tva;
    rang += 1;
    return { ...l, n: rang, section: false, taux, brut, remiseMontant, ht };
  });
  const totalHtBrut = arrondirCentimes(lignes.reduce((s, l) => s + l.brut, 0));
  const remisesLignes = arrondirCentimes(lignes.reduce((s, l) => s + l.remiseMontant, 0));
  const htApresLignes = arrondirCentimes(totalHtBrut - remisesLignes);
  const tauxGlobal = fraction(spec.remiseGlobale);
  const remiseGlobale = arrondirCentimes(htApresLignes * tauxGlobal);
  const totalHt = arrondirCentimes(htApresLignes - remiseGlobale);

  // LA TVA PAR TAUX : la base de chaque taux est la somme des lignes de ce taux, la remise
  // globale répartie au prorata — c'est ainsi qu'un vérificateur la recalcule.
  const bases = new Map<number, number>();
  for (const l of lignes) if (!l.section) bases.set(l.taux, arrondirCentimes((bases.get(l.taux) ?? 0) + l.ht));
  const tva = [...bases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([taux, baseBrute]) => {
      const base = arrondirCentimes(baseBrute * (1 - tauxGlobal));
      return { taux, base, montant: arrondirCentimes(base * taux) };
    });
  const totalTva = arrondirCentimes(tva.reduce((s, t) => s + t.montant, 0));
  // LES TAXES ADDITIONNELLES : sur le HT, hors base de TVA (voir `SpecDocumentCommercial.taxes`).
  const taxes = (spec.taxes ?? [])
    .filter((x) => x && typeof x.taux === "number" && Number.isFinite(x.taux) && x.taux > 0)
    .map((x) => ({ libelle: String(x.libelle ?? "").trim(), taux: x.taux, base: totalHt, montant: arrondirCentimes(totalHt * x.taux) }));
  const totalTaxes = arrondirCentimes(taxes.reduce((s, x) => s + x.montant, 0));
  const ttcAvantTimbre = arrondirCentimes(totalHt + totalTaxes + totalTva);
  const timbre = spec.modePaiement === "ESPECES" && ttcAvantTimbre > 0
    ? Math.min(TIMBRE_FISCAL.max, Math.max(TIMBRE_FISCAL.min, arrondirCentimes(ttcAvantTimbre * TIMBRE_FISCAL.taux)))
    : 0;
  const totalTtc = arrondirCentimes(ttcAvantTimbre + timbre);
  return { lignes, totalHtBrut, remisesLignes, remiseGlobale, totalHt, tva, totalTva, taxes, totalTaxes, timbre, totalTtc, enLettres: montantEnLettres(totalTtc) };
}

// ─────────────────────────── Les formats ───────────────────────────

/** Espace insécable ordinaire (U+00A0) : présente dans toutes les polices, y compris celles des PDF. */
const NBSP = "\u00a0";

/** « 41 300,50 » — séparateur de milliers insécable, virgule décimale, toujours deux décimales. */
export function formaterMontant(n: number, decimales = 2): string {
  const v = arrondirCentimes(n);
  const [entier, dec = ""] = Math.abs(v).toFixed(decimales).split(".");
  const groupes = entier.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${v < 0 ? "-" : ""}${groupes}${decimales > 0 ? `,${dec}` : ""}`;
}

export const formaterDzd = (n: number): string => `${formaterMontant(n)}${NBSP}DZD`;

/** « 2,5 » pour une quantité fractionnaire, « 12 » pour une quantité entière. */
export function formaterQuantite(q: number): string {
  if (Number.isInteger(q)) return formaterMontant(q, 0);
  return formaterMontant(q, 3).replace(/0+$/, "").replace(/,$/, "");
}

export function formaterTaux(t: number): string {
  const p = t * 100;
  return `${Number.isInteger(p) ? p : p.toFixed(1).replace(".", ",")}${NBSP}%`;
}

/** « 05/09/2026 » depuis une date ISO ; une date illisible est rendue telle quelle. */
export function formaterDateFr(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function ajouterJours(iso: string, jours: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + jours);
  return d.toISOString().slice(0, 10);
}

/**
 * LE MOTIF DE NUMÉROTATION — parce que les pièces réelles de la société ne s'écrivent pas
 * « FA-2026-0007 » : sa facture de référence porte « 001/FS/26 » et son bon de commande
 * « 012/DG/2026 ». Un motif se lit avec cinq jetons, et rien d'autre :
 *
 *   {n}       la séquence, sans zéro devant        {n:3}   la séquence sur 3 chiffres (au moins)
 *   {aaaa}    l'année sur quatre chiffres           {aa}    l'année sur deux chiffres
 *   {prefixe} le préfixe de la nature (FA / BC / DEV, ou celui du profil)
 *
 * Le défaut reste `{prefixe}-{aaaa}-{n:4}` : ce que toutes les pièces émises jusqu'ici portent.
 * Le motif vit dans le profil documentaire de la société (`settings.numerotation`), par nature.
 */
export const MOTIF_NUMERO_DEFAUT = "{prefixe}-{aaaa}-{n:4}";

const JETON = /\{(n(?::(\d{1,2}))?|aaaa|aa|prefixe)\}/g;

/** Ce qui rend un motif inacceptable, en clair — ou `null` s'il est valide. */
export function validerMotifNumero(motif: string): string | null {
  const m = (motif ?? "").trim();
  if (!m) return "Le motif de numérotation est vide.";
  if (m.length > 40) return "Le motif de numérotation dépasse 40 caractères.";
  if (!/\{n(?::\d{1,2})?\}/.test(m)) return "Le motif doit porter la séquence : {n} ou {n:3}.";
  const inconnus = [...m.matchAll(/\{[^}]*\}/g)].map((x) => x[0]).filter((j) => !/^\{(n(?::\d{1,2})?|aaaa|aa|prefixe)\}$/.test(j));
  if (inconnus.length) return `Jeton inconnu dans le motif : ${inconnus.join(", ")} (admis : {n}, {n:3}, {aaaa}, {aa}, {prefixe}).`;
  if (/[\\<>|"*?]/.test(m)) return "Le motif porte un caractère interdit dans un numéro (\\ < > | \" * ?).";
  return null;
}

/** « FA-2026-0007 » par défaut ; « 001/FS/26 » ou « 012/DG/2026 » avec le motif de la société. */
export function formaterNumero(prefixe: string, annee: number, sequence: number, motif?: string | null): string {
  const m = motif && !validerMotifNumero(motif) ? motif.trim() : MOTIF_NUMERO_DEFAUT;
  return m.replace(JETON, (_tout, jeton: string, largeur?: string) => {
    if (jeton === "aaaa") return String(annee);
    if (jeton === "aa") return String(annee).slice(-2);
    if (jeton === "prefixe") return prefixe.trim().toUpperCase();
    return String(sequence).padStart(largeur ? Number(largeur) : 0, "0");
  });
}

/**
 * LE PREMIER NUMÉRO D'UNE SÉRIE — « commencer le référencement à partir du BC N° 032/DG/2026 » (Direction, 10/2026).
 *
 * Le compteur est par société, nature et ANNÉE ; le départ l'est aussi (`settings.numerotationDepart`, par nature
 * puis par année : 032 en 2026 ne dit rien de 2027, qui repart à 001). C'est un PLANCHER, pas un réglage du compteur :
 * le numéro attribué est `max(dernier + 1, départ)` — un départ plus bas que le compteur ne recule jamais, et un
 * numéro déjà attribué ne l'est jamais deux fois (§118.195 : la numérotation est continue par construction).
 */
export type DepartsNumerotation = Partial<Record<TypeDocumentCommercial, Record<string, number>>>;

export const DEPART_MAX = 99_999;

/** Le départ de la série (nature, année) : 1 quand rien n'est réglé. */
export function departDe(departs: DepartsNumerotation | null | undefined, type: TypeDocumentCommercial, annee: number): number {
  const v = departs?.[type]?.[String(annee)];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= DEPART_MAX ? v : 1;
}

/** Le numéro d'ordre que le compteur attribuera après `dernier` : jamais en dessous du départ. */
export const prochaineSequence = (dernier: number, depart: number): number => Math.max(dernier + 1, depart);

/** Ce qui rend un départ inacceptable, en clair — ou `null`. */
export function validerDepart(annee: number, numero: number): string | null {
  if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) return "L'année du départ de numérotation va de 2000 à 2100.";
  if (!Number.isInteger(numero) || numero < 1 || numero > DEPART_MAX) return `Le premier numéro est un entier de 1 à ${DEPART_MAX}.`;
  return null;
}

// ─────────────────────────── La validité ───────────────────────────

export interface VerificationSpec { bloquants: string[]; avertissements: string[] }

/** Les mentions d'identité que porte l'émetteur d'une FACTURE, et le nom humain de chacune. */
const MENTIONS_EMETTEUR: { cle: keyof PartieCommerciale; libelle: string }[] = [
  { cle: "adresse", libelle: "l'adresse du siège" },
  { cle: "rc", libelle: "le numéro de registre de commerce (RC)" },
  { cle: "nif", libelle: "le NIF" },
  { cle: "ai", libelle: "l'article d'imposition" },
  { cle: "nis", libelle: "le NIS" },
];

const vide = (v: string | null | undefined): boolean => !v || v.trim() === "";
const dateIso = (v: string | null | undefined): boolean => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

/**
 * CE QUI EMPÊCHE DE PRODUIRE LA PIÈCE, et ce qui mérite seulement d'être dit.
 *
 * Bloquant : pas de ligne, une quantité nulle ou négative, un prix négatif, un taux de TVA
 * inconnu en Algérie, un tiers sans nom, une date illisible — et, pour une FACTURE, une mention
 * d'identité manquante chez l'émetteur ou le NIF du client absent.
 */
export function verifierSpecCommerciale(spec: SpecDocumentCommercial): VerificationSpec {
  const bloquants: string[] = [];
  const avertissements: string[] = [];
  const quoi = LIBELLE_TYPE[spec.type] ?? "Document";
  if (!TYPES_DOCUMENT.includes(spec.type)) bloquants.push(`Type de document inconnu : « ${String(spec.type)} » (attendu : ${TYPES_DOCUMENT.join(", ")}).`);
  if (vide(spec.numero)) bloquants.push("Le document n'a pas de numéro.");
  if (!dateIso(spec.date)) bloquants.push(`La date d'émission « ${spec.date ?? ""} » n'est pas une date AAAA-MM-JJ.`);
  if (spec.echeance && !dateIso(spec.echeance)) bloquants.push(`L'échéance « ${spec.echeance} » n'est pas une date AAAA-MM-JJ.`);
  if (spec.echeance && dateIso(spec.echeance) && dateIso(spec.date) && spec.echeance < spec.date) bloquants.push("L'échéance précède la date d'émission.");
  if (vide(spec.emetteur?.nom)) bloquants.push("L'émetteur n'a pas de dénomination.");
  if (vide(spec.tiers?.nom)) bloquants.push(`${quoi} sans destinataire : le nom du ${spec.type === "BON_DE_COMMANDE" ? "fournisseur" : "client"} manque.`);
  // UN AVOIR DIT CE QU'IL CORRIGE : sans la facture d'origine, la pièce crédite on ne sait quoi.
  if (spec.type === "AVOIR" && vide(spec.referenceAmont)) bloquants.push("Avoir sans facture d'origine : il doit porter le numéro de la facture qu'il corrige.");
  if (spec.type === "AVOIR" && vide(spec.objet)) bloquants.push("Avoir sans motif : dites pourquoi la facture est créditée — c'est ce que l'avoir imprime.");

  if (!Array.isArray(spec.lignes) || spec.lignes.length === 0) bloquants.push(`${quoi} sans aucune ligne.`);
  else {
    if (spec.lignes.length > 400) bloquants.push(`${spec.lignes.length} lignes : au-delà de 400, ce n'est plus une pièce commerciale mais une annexe — la joindre en Excel.`);
    if (spec.lignes.every((l) => l.section)) bloquants.push(`${quoi} sans aucune ligne chiffrée : il n'y a que des titres de section.`);
    spec.lignes.forEach((l, i) => {
      const n = i + 1;
      if (vide(l.designation)) bloquants.push(`Ligne ${n} : désignation vide.`);
      // Une SECTION n'a ni quantité ni prix : on ne lui reproche pas de ne pas en avoir.
      if (l.section) return;
      if (typeof l.quantite !== "number" || !Number.isFinite(l.quantite) || l.quantite <= 0) bloquants.push(`Ligne ${n} : quantité invalide (${String(l.quantite)}).`);
      if (typeof l.prixUnitaire !== "number" || !Number.isFinite(l.prixUnitaire) || l.prixUnitaire < 0) bloquants.push(`Ligne ${n} : prix unitaire invalide (${String(l.prixUnitaire)}).`);
      if (l.remise !== null && l.remise !== undefined && (l.remise < 0 || l.remise >= 1)) bloquants.push(`Ligne ${n} : remise ${l.remise} hors de [0 ; 1[ — une remise s'écrit en fraction (0,1 = 10 %).`);
      const taux = l.tva === null || l.tva === undefined ? (spec.tvaDefaut ?? TVA_NORMALE) : l.tva;
      if (!TAUX_TVA_ADMIS.some((t) => Math.abs(t - taux) < 1e-9)) bloquants.push(`Ligne ${n} : taux de TVA ${taux} inconnu en Algérie (admis : 0, 0,09, 0,19).`);
      if (l.prixUnitaire === 0) avertissements.push(`Ligne ${n} « ${l.designation} » : prix unitaire à zéro — offert ?`);
    });
  }
  if (spec.remiseGlobale !== null && spec.remiseGlobale !== undefined && (spec.remiseGlobale < 0 || spec.remiseGlobale >= 1)) bloquants.push(`Remise globale ${spec.remiseGlobale} hors de [0 ; 1[.`);
  if (spec.tvaDefaut !== null && spec.tvaDefaut !== undefined && !TAUX_TVA_ADMIS.some((t) => Math.abs(t - spec.tvaDefaut!) < 1e-9)) bloquants.push(`Taux de TVA par défaut ${spec.tvaDefaut} inconnu en Algérie.`);
  if (spec.modePaiement && !MODES_PAIEMENT.includes(spec.modePaiement)) bloquants.push(`Mode de paiement « ${spec.modePaiement} » inconnu (${MODES_PAIEMENT.join(", ")}).`);
  if (spec.referenceAmontDate && !dateIso(spec.referenceAmontDate)) bloquants.push(`La date de la pièce amont « ${spec.referenceAmontDate} » n'est pas une date AAAA-MM-JJ.`);
  (spec.taxes ?? []).forEach((x, i) => {
    if (vide(x?.libelle)) bloquants.push(`Taxe additionnelle ${i + 1} : libellé vide.`);
    if (typeof x?.taux !== "number" || !Number.isFinite(x.taux) || x.taux <= 0 || x.taux >= 1) bloquants.push(`Taxe additionnelle ${i + 1} « ${x?.libelle ?? ""} » : taux ${String(x?.taux)} hors de ]0 ; 1[ — un taux s'écrit en fraction (0,02 = 2 %).`);
  });

  // Les mentions d'identité : exigées sur une pièce fiscale (facture, avoir), souhaitées ailleurs.
  const manquantes = MENTIONS_EMETTEUR.filter((m) => vide(spec.emetteur?.[m.cle] as string | null | undefined)).map((m) => m.libelle);
  if (manquantes.length > 0) {
    const phrase = `Identité de l'émetteur incomplète : ${manquantes.join(", ")} — à renseigner dans la carte d'identité légale de la société.`;
    if (estPieceFiscale(spec.type)) bloquants.push(phrase);
    else avertissements.push(phrase);
  }
  if (estPieceFiscale(spec.type) && vide(spec.tiers?.nif) && vide(spec.tiers?.rc)) {
    avertissements.push(`Le client n'a ni NIF ni RC sur ${spec.type === "AVOIR" ? "l'avoir" : "la facture"} : une pièce fiscale entre professionnels les porte.`);
  }
  if (spec.type === "DEVIS" && (spec.validiteJours === null || spec.validiteJours === undefined)) avertissements.push("Devis sans durée de validité : 30 jours seront indiqués.");
  if (spec.type === "FACTURE" && vide(spec.modePaiement)) avertissements.push("Facture sans mode de paiement.");
  return { bloquants, avertissements };
}

/** Le titre de la pièce au registre Legal : « Facture n° FA-2026-0007 — Pharmacie Centrale ». */
export function titreDocument(spec: Pick<SpecDocumentCommercial, "type" | "numero" | "tiers">): string {
  return `${LIBELLE_TYPE[spec.type]} n° ${spec.numero} — ${spec.tiers.nom.trim()}`;
}
