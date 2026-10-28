import type { EtapeBC } from "@/lib/bons-de-commande/regle";
import { arrondirAuCentime } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS « NATIFS » D'UNE DEMANDE AU SECRÉTARIAT — « comme dans Ad & Pro » (Direction, 10/2026).
 *
 * « Quand l'assistante met ou upload des devis, le demandeur peut valider les références de chaque
 * devis, donc les devis doivent être transformés en natif, tout en ayant une interface extrêmement
 * simple. Ensuite le demandeur peut générer le bon de commande, ou le télécharger ; dans tous les
 * cas il est visible par l'assistante de direction. Ensuite ce bon de commande doit être validé : il
 * va dans le centre de validation ; une fois validé, il doit être signé : il va dans le module Bons
 * de commande ; il est signé, puis il revient ici, signé et validé. »
 *
 * ── OÙ VIT UN DEVIS, ET SES LIGNES ──────────────────────────────────────────────────────────
 *
 * Le devis est une pièce du REGISTRE Legal (`LegalDocument`, nature `QUOTE`, source la demande) :
 * c'est le registre unique des pièces d'achat (§17) — la fiche Legal, la chaîne devis → BC →
 * facture (`chainFromId`), les fichiers et les droits y vivent déjà. Le fichier du fournisseur reste
 * attaché à la pièce. Les LIGNES retranscrites vivent sous `custom.devisNatif`, à côté de
 * `custom.fabrique` (la spécification des pièces émises) et `custom.intelligence` : la même forme
 * que la ligne commerciale de la fabrique (désignation, référence, quantité, PU HT, TVA), plus ce
 * que le demandeur a RETENU et le BC qui porte chaque ligne. Aucune table de plus : le modèle de
 * lignes d'Ad & Pro (`AdProDevisLigne`) est attaché au POSTE (une ligne validée « pour un poste »),
 * et celui du matériel promotionnel au dossier ; les généraliser aurait tordu deux circuits vivants.
 *
 * ── QUI FAIT QUOI ───────────────────────────────────────────────────────────────────────────
 *
 *   • l'ASSISTANTE (qui gère la demande) dépose le devis et le retranscrit ;
 *   • le DEMANDEUR retient les lignes qu'il veut, sur un ou plusieurs devis, et génère UN BC PAR
 *     FOURNISSEUR — ou dépose un BC déjà fait ; le Super Admin peut le faire à sa place. Pas
 *     l'assistante : c'est la même règle que l'aperçu du BC d'un poste Ad & Pro
 *     (`peutValiderLeBrouillon`) — celui qui prépare ne choisit pas pour celui qui commande ;
 *   • le BC part à son centre (`aiguillerBC`), puis à la signature (module « Bons de commande ») ;
 *     son étape se LIT, jamais recopiée (`etatsDesBC`).
 *
 * Ce module est PUR : il lit, valide, regroupe et calcule. Les écritures (verrou de version,
 * fabrique) vivent dans `devis-natif-serveur.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les taux de TVA admis en Algérie, EN POUR CENT — ceux que la fabrique accepte (0, 0,09, 0,19). */
export const TAUX_TVA_DEVIS: readonly number[] = [0, 9, 19];

export interface LigneDevisNatif {
  id: string;
  designation: string;
  reference: string | null;
  quantite: number;
  /** Prix unitaire HORS TAXES, en DZD. */
  prixUnitaire: number;
  /** TVA de la ligne, en pour cent (0, 9 ou 19). */
  tva: number;
  /** Retenue par le demandeur : c'est ce qui entre au bon de commande. */
  retenue: boolean;
  retenueLe: string | null;
  retenuePar: string | null;
  /** Le BC qui porte cette ligne — `null` : pas encore commandée (ou BC annulé). */
  bcId: string | null;
}

export interface DevisNatif {
  v: 1;
  /** Le verrou : chaque écriture l'incrémente, et n'écrit que sur la version relue. */
  version: number;
  fournisseurId: string | null;
  fournisseur: string;
  /** La date imprimée sur le devis, `AAAA-MM-JJ`. */
  date: string | null;
  lignes: LigneDevisNatif[];
  saisiPar: string | null;
  saisiLe: string | null;
}

const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Lit `custom.devisNatif` — `null` quand la pièce n'en porte pas (devis déposé, pas encore retranscrit). */
export function lireDevisNatif(custom: unknown): DevisNatif | null {
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const d = (custom as Record<string, unknown>).devisNatif;
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const o = d as Record<string, unknown>;
  const lignes: LigneDevisNatif[] = [];
  for (const brut of Array.isArray(o.lignes) ? o.lignes : []) {
    if (!brut || typeof brut !== "object") continue;
    const l = brut as Record<string, unknown>;
    const id = texte(l.id); const designation = texte(l.designation);
    const quantite = nombre(l.quantite); const prixUnitaire = nombre(l.prixUnitaire); const tva = nombre(l.tva);
    if (!id || !designation || quantite === null || prixUnitaire === null || tva === null) continue;
    lignes.push({
      id, designation, reference: texte(l.reference), quantite, prixUnitaire, tva,
      retenue: l.retenue === true, retenueLe: texte(l.retenueLe), retenuePar: texte(l.retenuePar), bcId: texte(l.bcId),
    });
  }
  return {
    v: 1, version: nombre(o.version) ?? 0, fournisseurId: texte(o.fournisseurId), fournisseur: texte(o.fournisseur) ?? "",
    date: texte(o.date), lignes, saisiPar: texte(o.saisiPar), saisiLe: texte(o.saisiLe),
  };
}

// ─────────────────────────── La saisie ───────────────────────────

export interface LigneSaisie { id?: string | null; designation: string; reference?: string | null; quantite: string | number; prixUnitaire: string | number; tva: string | number }

/** « 4 800,50 » → 4800.5 ; vide → `null` ; illisible → `NaN`. */
export function nombreSaisi(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const t = String(v ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  return t === "" ? null : Number(t);
}

/**
 * VALIDER LA RETRANSCRIPTION. Une rangée entièrement vide est ignorée (l'éditeur en garde une
 * d'avance) ; une rangée commencée doit être complète : la désignation, une quantité > 0, un prix
 * ≥ 0 et un taux de TVA admis. Le refus nomme la ligne et ce qui manque.
 */
export function validerSaisie(brutes: readonly LigneSaisie[]): { ok: true; lignes: { id: string | null; designation: string; reference: string | null; quantite: number; prixUnitaire: number; tva: number }[] } | { ok: false; error: string } {
  const lignes: { id: string | null; designation: string; reference: string | null; quantite: number; prixUnitaire: number; tva: number }[] = [];
  for (const [i, l] of brutes.entries()) {
    const designation = (l.designation ?? "").trim();
    const reference = (l.reference ?? "")?.toString().trim() || null;
    const q = nombreSaisi(l.quantite); const p = nombreSaisi(l.prixUnitaire); const t = nombreSaisi(l.tva);
    if (!designation && !reference && q === null && p === null) continue;
    const n = `Ligne ${i + 1}`;
    if (!designation) return { ok: false, error: `${n} : la désignation est obligatoire.` };
    if (q === null || !(q > 0)) return { ok: false, error: `${n} (« ${designation.slice(0, 40)} ») : la quantité doit être un nombre supérieur à zéro.` };
    if (p === null || !(p >= 0)) return { ok: false, error: `${n} (« ${designation.slice(0, 40)} ») : le prix unitaire HT doit être un nombre positif.` };
    const tva = t === null ? 19 : t;
    if (!TAUX_TVA_DEVIS.includes(tva)) return { ok: false, error: `${n} (« ${designation.slice(0, 40)} ») : TVA ${t} % inconnue — taux admis : 0, 9 ou 19 %.` };
    lignes.push({ id: (l.id ?? "").toString().trim() || null, designation: designation.slice(0, 300), reference: reference?.slice(0, 120) ?? null, quantite: q, prixUnitaire: p, tva });
  }
  if (lignes.length === 0) return { ok: false, error: "Retranscrivez au moins une ligne du devis (désignation, quantité, prix unitaire HT)." };
  return { ok: true, lignes };
}

/**
 * APPLIQUER UNE RETRANSCRIPTION à un devis : une ligne qui garde son identifiant est modifiée en
 * place ; si son CONTENU change, elle perd sa retenue (le demandeur avait retenu l'ancien prix) ;
 * une ligne absente est retirée ; une nouvelle reçoit son identifiant (`nouvelId`).
 */
export function appliquerSaisie(
  avant: DevisNatif | null,
  saisie: { fournisseurId: string | null; fournisseur: string; date: string | null; lignes: { id: string | null; designation: string; reference: string | null; quantite: number; prixUnitaire: number; tva: number }[] },
  meta: { par: string; le: string; nouvelId: () => string },
): { devis: DevisNatif; retenuesPerdues: number } {
  const parId = new Map((avant?.lignes ?? []).map((l) => [l.id, l]));
  let retenuesPerdues = 0;
  const lignes: LigneDevisNatif[] = saisie.lignes.map((s) => {
    const a = s.id ? parId.get(s.id) : undefined;
    if (!a) return { ...s, id: meta.nouvelId(), retenue: false, retenueLe: null, retenuePar: null, bcId: null };
    const change = a.designation !== s.designation || a.reference !== s.reference || a.quantite !== s.quantite || a.prixUnitaire !== s.prixUnitaire || a.tva !== s.tva;
    if (change && a.retenue) retenuesPerdues += 1;
    return { ...a, ...s, id: a.id, ...(change ? { retenue: false, retenueLe: null, retenuePar: null } : {}) };
  });
  return {
    devis: { v: 1, version: (avant?.version ?? 0) + 1, fournisseurId: saisie.fournisseurId, fournisseur: saisie.fournisseur, date: saisie.date, lignes, saisiPar: meta.par, saisiLe: meta.le },
    retenuesPerdues,
  };
}

/** Une ligne portée par un BC EN VIE ne se modifie plus, ne se retire plus : le BC l'a commandée. */
export function lignesFigees(d: DevisNatif, bcsActifs: ReadonlySet<string>): LigneDevisNatif[] {
  return d.lignes.filter((l) => l.bcId !== null && bcsActifs.has(l.bcId));
}

export function refusEditionDevis(d: DevisNatif | null, bcsActifs: ReadonlySet<string>, bcs: ReadonlyMap<string, string | null> = new Map()): string | null {
  if (!d) return null;
  const figees = lignesFigees(d, bcsActifs);
  if (figees.length === 0) return null;
  const refs = [...new Set(figees.map((l) => bcs.get(l.bcId!) ?? "un bon de commande"))].join(", ");
  return `Ce devis a déjà des lignes commandées (${refs}) : il ne se retranscrit plus. Annulez le bon de commande dans Legal pour le corriger.`;
}

// ─────────────────────────── Les totaux ───────────────────────────

export function totauxDesLignes(lignes: readonly Pick<LigneDevisNatif, "quantite" | "prixUnitaire" | "tva">[]): { ht: number; tva: number; ttc: number } {
  let ht = 0; let tva = 0;
  for (const l of lignes) { const h = l.quantite * l.prixUnitaire; ht += h; tva += h * (l.tva / 100); }
  return { ht: arrondirAuCentime(ht), tva: arrondirAuCentime(tva), ttc: arrondirAuCentime(ht + tva) };
}

// ─────────────────────────── La retenue par le demandeur ───────────────────────────

/**
 * RETENIR DES LIGNES. L'ensemble envoyé REMPLACE le précédent pour ce devis : les lignes cochées
 * sont retenues, les autres ne le sont plus. Une ligne déjà COMMANDÉE (BC en vie) garde son état :
 * la décocher ou la cocher changerait un BC émis — le refus le dit.
 */
export function appliquerRetenue(
  d: DevisNatif, retenues: ReadonlySet<string>, bcsActifs: ReadonlySet<string>, meta: { par: string; le: string },
): { ok: true; devis: DevisNatif; changees: number } | { ok: false; error: string } {
  const inconnues = [...retenues].filter((id) => !d.lignes.some((l) => l.id === id));
  if (inconnues.length > 0) return { ok: false, error: "Une des lignes n'appartient plus à ce devis : rechargez la fiche." };
  let changees = 0;
  for (const l of d.lignes) {
    const voulu = retenues.has(l.id);
    if (voulu === l.retenue) continue;
    if (l.bcId && bcsActifs.has(l.bcId)) return { ok: false, error: `« ${l.designation.slice(0, 60)} » est déjà commandée par un bon de commande : elle ne se ${voulu ? "retient" : "retire"} plus d'ici.` };
    changees += 1;
  }
  if (changees === 0) return { ok: true, devis: d, changees: 0 };
  return {
    ok: true, changees,
    devis: {
      ...d, version: d.version + 1,
      lignes: d.lignes.map((l) => {
        const voulu = retenues.has(l.id);
        if (voulu === l.retenue) return l;
        return voulu ? { ...l, retenue: true, retenueLe: meta.le, retenuePar: meta.par } : { ...l, retenue: false, retenueLe: null, retenuePar: null };
      }),
    },
  };
}

// ─────────────────────────── Un BC par fournisseur ───────────────────────────

/** La clé d'un fournisseur : sa fiche d'annuaire, sinon son nom (sans casse ni accents). */
export function cleFournisseur(d: Pick<DevisNatif, "fournisseurId" | "fournisseur">): string {
  if (d.fournisseurId) return `id:${d.fournisseurId}`;
  return `nom:${d.fournisseur.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export interface DevisDeLaDemande {
  id: string;
  reference: string | null;
  titre: string;
  natif: DevisNatif;
  /** Un devis ANNULÉ au registre ne se commande plus. */
  annule: boolean;
}

export interface BcAGenerer {
  cle: string;
  fournisseurId: string | null;
  fournisseur: string;
  /** Les devis dont viennent les lignes — le premier devient la pièce amont du BC (`chainFromId`). */
  devis: { id: string; reference: string | null; date: string | null }[];
  lignes: (LigneDevisNatif & { devisId: string })[];
  totaux: { ht: number; tva: number; ttc: number };
}

/**
 * LES BONS DE COMMANDE À GÉNÉRER — les lignes RETENUES, pas encore portées par un BC en vie,
 * regroupées par FOURNISSEUR : deux devis du même fournisseur font un seul BC ; un devis par
 * fournisseur sinon. Un devis annulé ne compte pas.
 */
export function bcsAGenerer(devis: readonly DevisDeLaDemande[], bcsActifs: ReadonlySet<string>): BcAGenerer[] {
  const parCle = new Map<string, BcAGenerer>();
  for (const d of devis) {
    if (d.annule) continue;
    const lignes = d.natif.lignes.filter((l) => l.retenue && !(l.bcId && bcsActifs.has(l.bcId)));
    if (lignes.length === 0) continue;
    const cle = cleFournisseur(d.natif);
    const g = parCle.get(cle) ?? { cle, fournisseurId: d.natif.fournisseurId, fournisseur: d.natif.fournisseur, devis: [], lignes: [], totaux: { ht: 0, tva: 0, ttc: 0 } };
    g.devis.push({ id: d.id, reference: d.reference, date: d.natif.date });
    g.lignes.push(...lignes.map((l) => ({ ...l, devisId: d.id })));
    parCle.set(cle, g);
  }
  return [...parCle.values()].map((g) => ({ ...g, totaux: totauxDesLignes(g.lignes) }));
}

/** Le taux de TVA le plus fréquent des lignes (fraction) — le « taux par défaut » du BC ; chaque ligne garde le sien. */
export function tvaParDefaut(lignes: readonly Pick<LigneDevisNatif, "tva" | "quantite" | "prixUnitaire">[]): number {
  const poids = new Map<number, number>();
  for (const l of lignes) poids.set(l.tva, (poids.get(l.tva) ?? 0) + l.quantite * l.prixUnitaire + 1e-9);
  let meilleur = 19; let max = -1;
  for (const [t, p] of poids) if (p > max) { max = p; meilleur = t; }
  return meilleur / 100;
}

/** Les lignes dans la forme de la fabrique (`LigneCommerciale`) : TVA en fraction. */
export function enLignesCommerciales(lignes: readonly LigneDevisNatif[]): { designation: string; reference: string | null; quantite: number; prixUnitaire: number; tva: number }[] {
  return lignes.map((l) => ({ designation: l.designation, reference: l.reference, quantite: l.quantite, prixUnitaire: l.prixUnitaire, tva: l.tva / 100 }));
}

// ─────────────────────────── L'étape du BC, lue sur la demande ───────────────────────────

/** Ce que la fiche de la demande dit d'un BC — « Signé et validé » quand il revient signé. */
export const LIBELLE_BC_DEMANDE: Record<EtapeBC, string> = {
  HORS_CIRCUIT: "Hors circuit (pièce ancienne)",
  SANS_PORTE: "À adresser au centre de validations",
  A_VALIDER: "À valider au centre de validations",
  A_REVOIR: "À revoir — demandé par le centre",
  REFUSE: "Refusé par le centre",
  A_SIGNER: "À signer — module Bons de commande",
  A_CORRIGER: "Renvoyé pour correction par le signataire",
  SIGNE: "Signé et validé",
};

export const TON_BC_DEMANDE: Record<EtapeBC, "neutral" | "info" | "success" | "warning" | "danger" | "purple"> = {
  HORS_CIRCUIT: "neutral", SANS_PORTE: "warning", A_VALIDER: "info", A_REVOIR: "warning", REFUSE: "danger", A_SIGNER: "purple", A_CORRIGER: "warning", SIGNE: "success",
};

/** Les étapes d'un BC « en route » : ni signé, ni refusé, ni d'avant le circuit. */
export const ETAPES_EN_ROUTE: readonly EtapeBC[] = ["SANS_PORTE", "A_VALIDER", "A_REVOIR", "A_SIGNER", "A_CORRIGER"];

/** L'étape la plus en retard parmi les BC en route d'une demande (celle qu'on attend) — `null` : aucun. */
export function etapeBCAttendue(bcs: readonly { etape: EtapeBC; annule: boolean }[]): Exclude<EtapeBC, "HORS_CIRCUIT" | "REFUSE" | "SIGNE"> | null {
  const ordre: EtapeBC[] = ["A_REVOIR", "A_CORRIGER", "SANS_PORTE", "A_VALIDER", "A_SIGNER"];
  for (const e of ordre) if (bcs.some((b) => !b.annule && b.etape === e)) return e as Exclude<EtapeBC, "HORS_CIRCUIT" | "REFUSE" | "SIGNE">;
  return null;
}

/**
 * « TERMINER » ATTEND LA SIGNATURE (Direction, 10/2026) : une demande dont un bon de commande est
 * encore en route (au centre, à signer, renvoyé) ne se termine pas — le BC n'engage la société
 * qu'une fois signé, et c'est alors seulement que la commande part et que la facture arrive. Un BC
 * refusé ou annulé ne retient rien ; un BC d'avant le circuit non plus (on ne gèle pas l'historique).
 */
export function refusFinBCEnRoute(bcs: readonly { reference: string | null; etape: EtapeBC; annule: boolean }[]): string | null {
  const enRoute = bcs.filter((b) => !b.annule && ETAPES_EN_ROUTE.includes(b.etape));
  if (enRoute.length === 0) return null;
  const detail = enRoute.map((b) => `${b.reference?.trim() || "BC sans numéro"} (${LIBELLE_BC_DEMANDE[b.etape].toLowerCase()})`).join(", ");
  return `Le bon de commande n'est pas encore signé et validé : ${detail}. La demande se termine une fois le BC signé (module Bons de commande).`;
}
