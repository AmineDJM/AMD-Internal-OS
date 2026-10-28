/**
 * LIEUX — QUELLE WILAYA POUR UNE FICHE (refonte des données, vague 2, lot V2-D).
 *
 * Cinq fiches portent un lieu saisi à la main et, depuis la migration `20270131170000_lieux_wilaya_code`, une colonne
 * `wilayaCode` à côté. Ce module dit, pour chacune, QUELS champs texte lire et QUEL code en déduire — la même règle
 * pour la reprise (« lieux-wilaya », tout l'existant par lots) et pour la double écriture (chaque saisie) : deux
 * chemins, une seule lecture, sinon la reprise et le formulaire finiraient par ne pas rattacher pareil.
 *
 * La règle tient en trois lignes :
 *   1. la colonne wilaya prime, la ville (puis la région) ne parle que si elle est vide ou illisible
 *      (`normaliserLieu`) ;
 *   2. un texte ambigu (deux wilayas, numéro qui contredit le nom) rend `null` AVEC sa raison — jamais un pari ;
 *   3. une fiche dont le pays n'est pas l'Algérie (fournisseur étranger) n'a pas de wilaya, même si sa ville
 *      ressemble à un nom algérien.
 *
 * Le code rendu est celui du découpage EN VIGUEUR (69 wilayas, loi n° 26-06) : « Bou Saâda » → 68. Une lecture
 * qui veut l'ancien découpage ramène à la wilaya mère au moment de compter (`WILAYAS_69[].mere`), pas en écrivant.
 *
 * Module PUR : n'importe que `normaliser.ts` (pur) — testable sans base, importable des deux côtés.
 */

import { normaliserLieu, type CodeWilaya, type RaisonRejet } from "./normaliser";

/** Les fiches qui portent une colonne `wilayaCode` (nom du modèle Prisma = nom de la table). */
export const MODELES_LIEU = ["MedicalDoctor", "MedicalInstitution", "CompanyContact", "Supplier", "SalesSector"] as const;
export type ModeleLieu = (typeof MODELES_LIEU)[number];

export interface ColonnesLieu {
  /** Libellé lisible, pour les journaux et l'écran. */
  libelle: string;
  /** Colonne qui porte la wilaya (prime). */
  wilaya?: string;
  /** Colonne qui porte la ville (parle si la wilaya est vide ou illisible). */
  ville?: string;
  /** Colonne région (dernier recours : « Oran » y est parfois écrit). */
  region?: string;
  /** Colonne pays : une valeur qui n'est pas l'Algérie retire toute wilaya. */
  pays?: string;
}

/**
 * LES COLONNES LUES, modèle par modèle — identifiants CONSTANTS : ce sont les seuls noms de table et de colonne
 * interpolés dans le SQL de la reprise (`rattachement-prisma.ts`), jamais une saisie.
 */
export const COLONNES_LIEU: Readonly<Record<ModeleLieu, ColonnesLieu>> = {
  MedicalDoctor: { libelle: "Praticien", wilaya: "wilaya", ville: "city", region: "region" },
  MedicalInstitution: { libelle: "Établissement", wilaya: "wilaya", ville: "city", region: "region" },
  CompanyContact: { libelle: "Partenaire", wilaya: "wilaya", ville: "city" },
  Supplier: { libelle: "Fournisseur", ville: "city", pays: "country" },
  SalesSector: { libelle: "Secteur de vente", wilaya: "wilayaPivot", ville: "city" },
};

function plierPays(v: string): string {
  // Toutes les marques combinantes tombent — accents latins ET hamza arabe (« ئ » se décompose en NFD).
  return v.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Les valeurs de pays qui désignent l'Algérie (repliées : minuscules, sans accents ni ponctuation). */
const ALGERIE = new Set(["", "dz", "dza", "algerie", "algeria", "al djazair", "el djazair", "الجزائر"].map(plierPays));

/** Vrai si la fiche est (ou peut être) en Algérie — un pays vide ne dit rien, il ne retire rien. */
export function estEnAlgerie(pays: string | null | undefined): boolean {
  return ALGERIE.has(plierPays(pays ?? ""));
}

/** Les valeurs texte d'une fiche, par colonne (ce que le SQL a lu). */
export type ValeursLieu = Readonly<Record<string, string | null | undefined>>;

export type RaisonSansWilaya = RaisonRejet | "hors_algerie";

export type Rattachement =
  | { code: CodeWilaya; prudence?: string }
  | { code: null; raison: RaisonSansWilaya; detail: string };

/**
 * LE CODE DE WILAYA D'UNE FICHE, ou `null` et la raison. `vide` = rien n'était écrit (ce n'est pas une anomalie) ;
 * toute autre raison est un cas À LISTER : le texte existe, on n'a pas osé le lire.
 */
export function rattacherFiche(modele: ModeleLieu, valeurs: ValeursLieu): Rattachement {
  const c = COLONNES_LIEU[modele];
  if (c.pays && !estEnAlgerie(valeurs[c.pays])) {
    return { code: null, raison: "hors_algerie", detail: `Pays « ${String(valeurs[c.pays]).trim()} » : pas de wilaya.` };
  }
  const { wilaya } = normaliserLieu({
    wilaya: c.wilaya ? valeurs[c.wilaya] : undefined,
    ville: c.ville ? valeurs[c.ville] : undefined,
    region: c.region ? valeurs[c.region] : undefined,
  });
  if (wilaya.code === null) return { code: null, raison: wilaya.raison, detail: wilaya.detail };
  return wilaya.prudence ? { code: wilaya.code, prudence: wilaya.prudence } : { code: wilaya.code };
}

/** Vrai si l'absence de wilaya mérite d'être LISTÉE (un texte existait) — faux pour une fiche vide. */
export function estAmbigu(r: Rattachement): boolean {
  return r.code === null && r.raison !== "vide" && r.raison !== "hors_algerie";
}

/**
 * Les valeurs d'une saisie de formulaire, sous les noms de colonne du modèle — pour la double écriture : l'action
 * connaît ses champs (`wilaya`, `city`…), elle les passe tels quels ; un champ ABSENT de la saisie (`undefined`)
 * signifie « inchangé » et oblige à relire la fiche (`toucheLeLieu`).
 */
export function toucheLeLieu(modele: ModeleLieu, saisie: Readonly<Record<string, unknown>>): boolean {
  const c = COLONNES_LIEU[modele];
  return [c.wilaya, c.ville, c.region, c.pays].some((col) => col !== undefined && saisie[col] !== undefined);
}
