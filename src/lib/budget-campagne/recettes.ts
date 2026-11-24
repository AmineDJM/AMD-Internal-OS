/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE BUDGÉTAIRE — LES RECETTES PRÉVUES (Super Admin, 24/11/2026).
 *
 * « Pour la campagne budgétaire, il faut prévoir les recettes et les dépenses. Les recettes, c'est le Super Admin et la
 * Direction générale qui les mettent ; les Opérations, etc., font les dépenses. »
 *
 *   • une recette prévue = une société, un mois, un produit et/ou une BU, un client (« PCH » : on ne vend qu'à elle
 *     aujourd'hui), et un montant — quantité × prix unitaire quand le prix existe, montant direct sinon ;
 *   • la SAISIE est au Super Admin et à la DG seuls ; une direction qui a accès à la campagne les LIT ; les autres, rien ;
 *   • à la clôture de la campagne (lancement de l'exercice), les recettes se FIGENT : elles deviennent la référence que
 *     le réalisé viendra rejoindre par la même clé de rapprochement (`cleRapprochementRecette`).
 *
 * Module PUR, sans aucun import : lu par les écrans clients (client-bundle-guard), les requêtes, les actions et testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Le client par défaut d'une vente prévue : on ne vend aujourd'hui qu'à un seul client (Super Admin, 24/11/2026) ;
 * d'autres viendront plus tard. Valeur rangée en base et dans la clé de rapprochement — l'écran ne l'affiche pas.
 */
export const CLIENT_PAR_DEFAUT = "PCH";

export const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] as const;

/** D'où vient le prix unitaire d'une ligne : le prix hôpital saisi du produit, ou un prix tapé dans la campagne. */
export type SourcePrix = "PRIX_HOPITAL" | "SAISIE";

type Verdict = { ok: true } | { ok: false; raison: string };

const arrondi2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────── Les droits ───────────────────────────────

export interface EntreeDroitsRecettes {
  estSuperAdmin: boolean;
  /** Directeur Général (rôle principal ou « autre rôle »). */
  estDG: boolean;
  /** La personne reçoit une vue de la campagne (Direction, valideur, Finances, ou responsable d'un de ses pôles). */
  accedeALaCampagne: boolean;
}

export interface DroitsRecettes {
  /** Lire les recettes (dans les sociétés qui lui sont ouvertes). */
  voit: boolean;
  /** Saisir, modifier, retirer une recette — et régler le volet Impôts & taxes. */
  saisit: boolean;
  /** L'écran de synthèse (résultat prévisionnel, impôts) : Super Admin et DG. */
  voitSynthese: boolean;
}

export function droitsRecettes(e: EntreeDroitsRecettes): DroitsRecettes {
  const saisit = e.estSuperAdmin || e.estDG;
  return { voit: saisit || e.accedeALaCampagne, saisit, voitSynthese: saisit };
}

/** Peut-on écrire une recette (ou un montant du volet impôts) maintenant ? Le refus dit le remède. */
export function verdictSaisieRecettes(c: { droits: DroitsRecettes; figeesLe: Date | string | null }): Verdict {
  if (!c.droits.saisit) return { ok: false, raison: "Seuls le Super Admin et la Direction générale saisissent les recettes et les impôts prévus. Les directions saisissent leurs dépenses dans leur pôle." };
  if (c.figeesLe) return { ok: false, raison: "La campagne est close : les recettes et impôts prévus sont la référence de l'exercice et ne se modifient plus." };
  return { ok: true };
}

// ─────────────────────────────── La ligne ───────────────────────────────

/** Le client tel qu'on le range : vide → « PCH ». */
export function normaliserClient(client: string | null | undefined): string {
  const c = (client ?? "").replace(/\s+/g, " ").trim();
  return c || CLIENT_PAR_DEFAUT;
}

/** Minuscules, sans accents, espaces resserrés — la forme comparée d'un libellé (sans import : module pur). */
function plierSimple(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface IdentiteRecette {
  companyId: string; annee: number; mois: number;
  productId?: string | null; businessUnitId?: string | null; label?: string | null; client?: string | null;
}

/**
 * LA CLÉ DE RAPPROCHEMENT — société | année-mois | produit (sinon BU, sinon libellé) | client.
 *
 * Une ligne par clé dans la campagne (ressaisir la même recette la remplace), et c'est la même clé que le réalisé
 * portera quand les ventes PCH seront ouvertes : une vente de la PCH a une société (celle du produit), un mois et un
 * produit — de quoi la retrouver sans traduction. Rien n'est branché côté ventes aujourd'hui (modules masqués).
 */
export function cleRapprochementRecette(r: IdentiteRecette): string {
  const mm = String(r.mois).padStart(2, "0");
  const objet = r.productId ? `P:${r.productId}` : r.businessUnitId ? `BU:${r.businessUnitId}` : `L:${plierSimple(r.label ?? "")}`;
  return `${r.companyId}|${r.annee}-${mm}|${objet}|${plierSimple(normaliserClient(r.client))}`;
}

export type MontantRecette =
  | { ok: true; montant: number; quantite: number | null; prixUnitaire: number | null }
  | { ok: false; raison: string };

/**
 * LE MONTANT D'UNE RECETTE : quantité × prix unitaire quand les deux sont là (le prix du produit, ou tapé) ; sinon le
 * montant direct. Rien de négatif ; rien de vide.
 */
export function calculerMontantRecette(e: { quantite: number | null; prixUnitaire: number | null; montant: number | null }): MontantRecette {
  for (const [nom, v] of [["quantité", e.quantite], ["prix unitaire", e.prixUnitaire], ["montant", e.montant]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) return { ok: false, raison: `Le ${nom} doit être un nombre positif.` };
  }
  const q = e.quantite !== null && e.quantite > 0 ? e.quantite : null;
  const p = e.prixUnitaire !== null && e.prixUnitaire > 0 ? e.prixUnitaire : null;
  if (q !== null && p !== null) return { ok: true, montant: arrondi2(q * p), quantite: q, prixUnitaire: p };
  if (e.montant !== null && e.montant > 0) return { ok: true, montant: arrondi2(e.montant), quantite: q, prixUnitaire: p };
  if (q !== null) return { ok: false, raison: "Ce produit n'a pas de prix hôpital saisi : tapez le prix unitaire, ou le montant." };
  return { ok: false, raison: "Indiquez une quantité et un prix, ou un montant." };
}

/**
 * RÉPARTIR UN TOTAL SUR LES DOUZE MOIS — parts égales arrondies au centime, le reste sur décembre : la somme des douze
 * vaut exactement le total (jamais un centime perdu ni créé).
 */
export function repartirSurDouzeMois(total: number): number[] {
  const centimes = Math.round(total * 100);
  const part = Math.trunc(centimes / 12);
  const mois = Array.from({ length: 12 }, () => part / 100);
  mois[11] = (centimes - part * 11) / 100;
  return mois;
}

// ─────────────────────────────── Les agrégats ───────────────────────────────

export interface RecetteAgregable {
  companyId: string; mois: number; montant: number;
  productId?: string | null; businessUnitId?: string | null; label: string;
}

const douzeZeros = () => Array.from({ length: 12 }, () => 0);

export interface TotauxRecettes {
  total: number;
  /** Par société : les douze mois et le total. */
  parSociete: Record<string, { mois: number[]; total: number }>;
  /** Par objet (produit, sinon BU, sinon libellé) et société : le total de l'année. */
  parObjet: { companyId: string; objet: string; label: string; productId: string | null; businessUnitId: string | null; mois: number[]; total: number }[];
}

export function totauxRecettes(lignes: readonly RecetteAgregable[]): TotauxRecettes {
  const parSociete: TotauxRecettes["parSociete"] = {};
  const objets = new Map<string, TotauxRecettes["parObjet"][number]>();
  let total = 0;
  for (const l of lignes) {
    if (!(l.mois >= 1 && l.mois <= 12)) continue;
    const s = (parSociete[l.companyId] ??= { mois: douzeZeros(), total: 0 });
    s.mois[l.mois - 1] = arrondi2(s.mois[l.mois - 1]! + l.montant);
    s.total = arrondi2(s.total + l.montant);
    total = arrondi2(total + l.montant);
    const objet = l.productId ? `P:${l.productId}` : l.businessUnitId ? `BU:${l.businessUnitId}` : `L:${plierSimple(l.label)}`;
    const k = `${l.companyId}|${objet}`;
    const o = objets.get(k) ?? { companyId: l.companyId, objet, label: l.label, productId: l.productId ?? null, businessUnitId: l.businessUnitId ?? null, mois: douzeZeros(), total: 0 };
    o.mois[l.mois - 1] = arrondi2(o.mois[l.mois - 1]! + l.montant);
    o.total = arrondi2(o.total + l.montant);
    objets.set(k, o);
  }
  return { total, parSociete, parObjet: [...objets.values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.label.localeCompare(b.label, "fr")) };
}

// ─────────────────────────────── Le rapprochement avec le réalisé ───────────────────────────────

export interface Rapprochement { cle: string; prevu: number; realise: number; ecart: number }

/**
 * PRÉVU CONTRE RÉALISÉ, clé par clé — prêt pour le jour où les ventes PCH s'ouvriront (rien ne l'appelle encore côté
 * ventes). Une clé présente d'un seul côté garde 0 de l'autre : une vente non prévue se voit, une prévision non vendue aussi.
 */
export function rapprocherAuRealise(prevues: readonly { cle: string; montant: number }[], realisees: readonly { cle: string; montant: number }[]): Rapprochement[] {
  const m = new Map<string, Rapprochement>();
  for (const p of prevues) { const r = m.get(p.cle) ?? { cle: p.cle, prevu: 0, realise: 0, ecart: 0 }; r.prevu = arrondi2(r.prevu + p.montant); m.set(p.cle, r); }
  for (const p of realisees) { const r = m.get(p.cle) ?? { cle: p.cle, prevu: 0, realise: 0, ecart: 0 }; r.realise = arrondi2(r.realise + p.montant); m.set(p.cle, r); }
  return [...m.values()].map((r) => ({ ...r, ecart: arrondi2(r.realise - r.prevu) })).sort((a, b) => a.cle.localeCompare(b.cle));
}
