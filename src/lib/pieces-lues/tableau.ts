import { analyserNombre, analyserQuantite } from "@/lib/pieces-lues/montants";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU D'UN DEVIS, LU PAR SES POSITIONS — sans modèle (lot B1, décision 0049). Pur.
 *
 * Mesuré le 02/11 sur le devis INSIGNE de la Direction : le texte « à plat » d'un PDF met chaque
 * CELLULE sur sa propre ligne (« 2 / Conception ADV / 1 / 145 000,00 / 145 000,00 »), l'en-tête
 * des colonnes et le pied de page de l'émetteur se répètent à chaque page, et le modèle qui
 * recopiait ce texte a rendu des lignes manquantes (4-8, 11-13…) et des blocs DUPLIQUÉS — 893 500
 * HT au lieu des 794 500 imprimés. Ici, on lit le tableau comme un humain : par RANGÉES (même
 * hauteur sur la page) et par COLONNES (sous l'en-tête « Qté / P.U. / Montant »).
 *
 *   • une ligne de commande = une rangée qui commence par son NUMÉRO et porte ses chiffres ;
 *     une rangée de texte seul juste sous elle est la SUITE de sa désignation ; plus loin, c'est
 *     un titre de section (hors de tout total) ;
 *   • l'en-tête de colonnes répété, les reports (« À reporter », « Report »), les sous-totaux et
 *     les totaux ne sont JAMAIS des lignes ;
 *   • une ligne imprimée deux fois à l'identique (bloc répété) n'en fait qu'une — et c'est dit ;
 *     un même numéro avec deux contenus différents reste douteux, nommé ;
 *   • la NUMÉROTATION se suit : un numéro manquant est une ligne non lue, nommée ;
 *   • chaque ligne se recoupe (quantité × prix = montant), puis la somme des lignes contre le
 *     total HT imprimé (`reconcilier`).
 *
 * Ce module ne lit pas de fichier : il reçoit des rangées de cellules (`Rangee`) — rendues par
 * `positions.ts` depuis un PDF à couche texte, ou par la vision depuis une image.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Cellule {
  texte: string;
  x0: number;
  x1: number;
}

export interface Rangee {
  page: number;
  /** Ligne de base sur la page (points, du haut vers le bas). */
  y: number;
  /** Hauteur de la police — l'échelle des tolérances. */
  taille: number;
  /** Triées de gauche à droite. */
  cellules: Cellule[];
}

export interface LigneTableau {
  numero: number;
  designation: string;
  /** La référence article imprimée dans sa propre colonne, s'il y en a une. */
  reference: string | null;
  quantite: number | null;
  prixUnitaire: number | null;
  montant: number | null;
  page: number;
  /** Ce qui rend la ligne douteuse — vide quand elle se recoupe. */
  doutes: string[];
}

export interface LectureTableau {
  lignes: LigneTableau[];
  /** Le total HT lu sur une rangée « Total HT » du tableau — complète le repérage des en-têtes. */
  totalHt: number | null;
  /** Les numéros absents entre le premier et le dernier lu. */
  trous: number[];
  /** Lignes imprimées deux fois à l'identique, retirées. */
  doublonsRetires: number;
  /** Rangées écartées parce qu'elles ne sont pas des lignes (en-têtes répétés, reports, sous-totaux). */
  ecartees: number;
  /** Un en-tête de colonnes a-t-il été reconnu ? Sans lui, la lecture repose sur la forme des rangées seule. */
  enTete: boolean;
}

const plier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const RE_DESIGNATION = /^(designation|libelle|description|article|prestation|objet|produit)s?\b/;
const RE_QTE = /^(qte|qt|quantite|qty|nbre|nombre|quant)\b/;
const RE_PU = /^(p\.?\s?u|prix\s*(unit|u\b|ht)|pu\b|prix$|tarif)/;
const RE_MONTANT = /^(montant|total|prix\s*total|mt|valeur)\b/;
const RE_NUMERO = /^(n[°o.]?|no|num|#|item|ligne|rang)$/;
/** Une rangée qui n'est jamais une ligne : reports, sous-totaux, totaux, arrêté. */
const RE_HORS_LIGNE = /\b(a reporter|report|sous[- ]total|total|net a payer|arrete|montant en lettres|tva|taxe|timbre|remise globale)\b/;

/**
 * Un nombre de TABLEAU. « 5.000 » est ambigu pour `analyserNombre` (milliers ou décimale ?) ; dans une
 * colonne de devis en dinars, un point suivi de groupes de trois chiffres est un séparateur de milliers
 * (on n'imprime pas 5 unités avec trois décimales, ni un prix au millième de dinar).
 */
function nombre(t: string): number | null {
  const n = analyserNombre(t);
  if (n.valeur !== null) return n.valeur;
  const s = t.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  if (/^\d{1,3}(,\d{3})+$/.test(s)) return Number(s.replace(/,/g, ""));
  return null;
}

function quantite(t: string): number | null {
  const q = analyserQuantite(t).valeur;
  return q !== null ? q : nombre(t.replace(/^[x×]\s*/i, ""));
}

const estNumeroDeLigne = (t: string): number | null => {
  const m = /^(\d{1,3})[.)]?$/.exec(t.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 999 ? n : null;
};

interface Colonnes {
  numero: { x0: number; x1: number } | null;
  designation: { x0: number; x1: number };
  /** Le début de la colonne qui suit la désignation (Unité, Qté…) : la désignation s'arrête avant. */
  finDesignation: number;
  quantite: { x0: number; x1: number } | null;
  pu: { x0: number; x1: number } | null;
  montant: { x0: number; x1: number } | null;
}

/** L'en-tête de colonnes : une rangée qui nomme la désignation ET au moins deux colonnes chiffrées. */
function enTeteDe(r: Rangee): Colonnes | null {
  let designation: Cellule | null = null;
  let quantite: Cellule | null = null;
  let pu: Cellule | null = null;
  let montant: Cellule | null = null;
  let numero: Cellule | null = null;
  for (const c of r.cellules) {
    const p = plier(c.texte);
    if (!designation && RE_DESIGNATION.test(p)) designation = c;
    else if (!quantite && RE_QTE.test(p)) quantite = c;
    else if (!pu && RE_PU.test(p)) pu = c;
    else if (RE_MONTANT.test(p)) montant = c; // le DERNIER « montant / total » de la rangée : la colonne HT de droite
    else if (!numero && RE_NUMERO.test(p)) numero = c;
  }
  const chiffrees = [quantite, pu, montant].filter(Boolean).length;
  if (!designation || chiffrees < 2) return null;
  const b = (c: Cellule | null) => (c ? { x0: c.x0, x1: c.x1 } : null);
  const suivante = r.cellules.filter((c) => c.x0 > designation!.x1).reduce((m, c) => Math.min(m, c.x0), Infinity);
  return { numero: b(numero), designation: b(designation)!, finDesignation: suivante, quantite: b(quantite), pu: b(pu), montant: b(montant) };
}

/** La colonne chiffrée dont la cellule est la plus proche (alignement à droite : on compare les bords droits et les centres). */
function colonneDe(c: Cellule, cols: Colonnes): "quantite" | "pu" | "montant" | null {
  let meilleure: "quantite" | "pu" | "montant" | null = null;
  let d = Infinity;
  for (const k of ["quantite", "pu", "montant"] as const) {
    const col = cols[k];
    if (!col) continue;
    const dist = Math.min(Math.abs(c.x1 - col.x1), Math.abs((c.x0 + c.x1) / 2 - (col.x0 + col.x1) / 2), Math.abs(c.x0 - col.x0));
    if (dist < d) { d = dist; meilleure = k; }
  }
  return meilleure;
}

const egal = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.005;
const c2 = (n: number) => Math.round(n * 100) / 100;
/** Quantité × prix = montant, à l'arrondi d'impression près (1 DZD ou 0,05 %). */
export const recoupe = (q: number, pu: number, m: number) => Math.abs(c2(q * pu) - m) <= Math.max(1, Math.abs(m) * 0.0005);

/**
 * Sans colonnes reconnues : les chiffres de FIN de rangée. On cherche, parmi les deux à quatre derniers,
 * le trio (quantité, prix, montant) qui se recoupe ; à défaut, les trois derniers dans cet ordre.
 */
function chiffresDeFin(nums: number[]): { quantite: number | null; prixUnitaire: number | null; montant: number | null } {
  if (nums.length >= 3) {
    const [q, pu, m] = nums.slice(-3);
    if (recoupe(q, pu, m)) return { quantite: q, prixUnitaire: pu, montant: m };
    if (nums.length >= 4) {
      const [q2, , pu2, m2] = nums.slice(-4);
      if (recoupe(q2, pu2, m2)) return { quantite: q2, prixUnitaire: pu2, montant: m2 };
    }
    return { quantite: q, prixUnitaire: pu, montant: m };
  }
  if (nums.length === 2) {
    const [a, b] = nums;
    return { quantite: null, prixUnitaire: a, montant: b };
  }
  return { quantite: null, prixUnitaire: null, montant: nums[0] ?? null };
}

/** Ce que la rangée porte de chiffres hors du numéro, dans l'ordre. */
function cellulesChiffrees(r: Rangee, apresX: number): Cellule[] {
  return r.cellules.filter((c) => c.x0 >= apresX && nombre(c.texte) !== null && /\d/.test(c.texte));
}

export function lireTableau(rangees: readonly Rangee[]): LectureTableau {
  const triees = [...rangees].sort((a, b) => a.page - b.page || a.y - b.y);
  let cols: Colonnes | null = null;
  let enTete = false;
  let totalHt: number | null = null;
  let ecartees = 0;
  const brutes: LigneTableau[] = [];
  let derniere: { ligne: LigneTableau; y: number; page: number; taille: number } | null = null;
  let dansTableau = false;

  for (const r of triees) {
    if (!r.cellules.length) continue;
    const texteRangee = plier(r.cellules.map((c) => c.texte).join(" "));
    const h = enTeteDe(r);
    if (h) {
      cols = h; enTete = true; dansTableau = true; derniere = null;
      ecartees++;
      continue;
    }
    const premiere = r.cellules[0];
    const numero = estNumeroDeLigne(premiere.texte);
    // LES TOTAUX ET REPORTS : jamais des lignes. Le « Total HT » se garde pour la réconciliation.
    if (numero === null && RE_HORS_LIGNE.test(texteRangee)) {
      if (/\btotal\s*(general\s*)?h\.?\s?t\b|\bmontant\s*(total\s*)?h\.?\s?t\b|\btotal\s*hors\s*taxes?\b/.test(texteRangee) && !/sous[- ]total/.test(texteRangee)) {
        const nums = r.cellules.map((c) => nombre(c.texte)).filter((n): n is number => n !== null);
        if (nums.length) totalHt = nums[nums.length - 1];
      }
      if (/\b(a reporter|report|sous[- ]total)\b/.test(texteRangee)) ecartees++;
      else if (/\btotal\b/.test(texteRangee)) dansTableau = false;
      derniere = null;
      continue;
    }
    if (numero !== null) {
      const xDes = cols ? cols.designation.x0 : (r.cellules[1]?.x0 ?? premiere.x1);
      // Une colonne « Réf. » entre le numéro et la désignation : la référence, pas la désignation.
      const reference = cols ? r.cellules.filter((c) => c !== premiere && c.x1 < cols!.designation.x0 - 1).map((c) => c.texte).join(" ").trim() || null : null;
      // Les chiffres de la ligne : sous les colonnes chiffrées (avec un en-tête), sinon après la désignation.
      const debutChiffres = cols
        ? Math.min(...[cols.quantite, cols.pu, cols.montant].filter((x): x is { x0: number; x1: number } => x !== null).map((x) => x.x0)) - 45
        : (r.cellules[1]?.x1 ?? premiere.x1) + 0.1;
      const chiffrees = cellulesChiffrees(r, Math.max(premiere.x1 + 0.1, debutChiffres));
      // La désignation : le texte entre le numéro et la première colonne chiffrée.
      const premierChiffre = chiffrees.length ? chiffrees[0].x0 : Infinity;
      const finDes = cols ? Math.min(premierChiffre, cols.finDesignation) : premierChiffre;
      const designation = r.cellules.filter((c) => c !== premiere && c.x0 >= xDes - 3 && c.x0 < finDes - 1 && !chiffrees.includes(c))
        .map((c) => c.texte).join(" ").replace(/\s+/g, " ").trim();
      if (!chiffrees.length) {
        // Un numéro sans chiffres : « 3 » d'une liste de conditions, ou une ligne illisible — elle ne compte que dans le tableau.
        if (dansTableau || enTete) {
          const l: LigneTableau = { numero, designation, reference, quantite: null, prixUnitaire: null, montant: null, page: r.page, doutes: ["aucun chiffre lu sur la ligne"] };
          brutes.push(l);
          derniere = { ligne: l, y: r.y, page: r.page, taille: r.taille };
        }
        continue;
      }
      let q: number | null = null; let pu: number | null = null; let m: number | null = null;
      if (cols) {
        for (const c of chiffrees) {
          const k = colonneDe(c, cols);
          if (k === "quantite") q = quantite(c.texte);
          else if (k === "pu") pu = nombre(c.texte);
          else if (k === "montant") m = nombre(c.texte);
        }
        // Une colonne que l'en-tête ne nomme pas (TVA par ligne, remise) a pu capter un chiffre : la forme de fin tranche.
        if ((q === null || pu === null || m === null || !recoupe(q, pu, m)) && chiffrees.length >= 3) {
          const f = chiffresDeFin(chiffrees.map((c) => nombre(c.texte)!));
          if (f.quantite !== null && f.prixUnitaire !== null && f.montant !== null && recoupe(f.quantite, f.prixUnitaire, f.montant)) ({ quantite: q, prixUnitaire: pu, montant: m } = f);
        }
      } else {
        ({ quantite: q, prixUnitaire: pu, montant: m } = chiffresDeFin(chiffrees.map((c) => nombre(c.texte)!)));
      }
      const doutes: string[] = [];
      if (q === null && pu === null && m !== null) { q = 1; pu = m; }
      if (q !== null && pu !== null && m === null) m = c2(q * pu);
      if (q === null && pu !== null && m !== null && pu > 0) {
        const d = m / pu;
        if (Math.abs(d - Math.round(d)) < 1e-6) q = Math.round(d); else doutes.push("quantité non lue");
      }
      if (q !== null && pu !== null && m !== null && !recoupe(q, pu, m)) {
        doutes.push(`quantité × prix (${c2(q * pu)}) ne fait pas le montant imprimé (${m})`);
      }
      const l: LigneTableau = { numero, designation, reference, quantite: q, prixUnitaire: pu, montant: m, page: r.page, doutes };
      if (!designation) l.doutes.push("désignation non lue");
      brutes.push(l);
      derniere = { ligne: l, y: r.y, page: r.page, taille: r.taille };
      dansTableau = true;
      continue;
    }
    // Une rangée de TEXTE SEUL : la suite de la désignation précédente si elle la touche, sinon un titre de section.
    const chiffres = r.cellules.some((c) => /\d/.test(c.texte) && nombre(c.texte) !== null && c.x0 > (cols?.designation.x1 ?? 1e9));
    if (derniere && derniere.page === r.page && !chiffres && r.y - derniere.y <= derniere.taille * 1.6
      && (!cols || r.cellules.every((c) => c.x0 >= cols!.designation.x0 - 3 && c.x0 < cols!.finDesignation - 1))) {
      derniere.ligne.designation = `${derniere.ligne.designation} ${r.cellules.map((c) => c.texte).join(" ")}`.replace(/\s+/g, " ").trim();
      derniere.y = r.y;
      continue;
    }
    derniere = null;
  }

  const { lignes, trous, doublonsRetires } = consolider(brutes);
  return { lignes, totalHt, trous, doublonsRetires, ecartees, enTete };
}


/**
 * LE DÉDOUBLONNAGE ET LA NUMÉROTATION — pour les lignes lues par les positions comme pour celles de la
 * vision. Un même numéro imprimé deux fois À L'IDENTIQUE (bloc répété, page dupliquée, en-tête et pied
 * relus) n'en fait qu'un ; deux contenus différents sous un même numéro restent, douteux et nommés.
 */
export function consolider(brutes: readonly LigneTableau[]): { lignes: LigneTableau[]; trous: number[]; doublonsRetires: number } {
  // LE DÉDOUBLONNAGE : un même numéro imprimé deux fois à l'identique (bloc répété, page dupliquée) n'en fait qu'un.
  const parNumero = new Map<number, LigneTableau[]>();
  for (const l of brutes) parNumero.set(l.numero, [...(parNumero.get(l.numero) ?? []), l]);
  let doublonsRetires = 0;
  const lignes: LigneTableau[] = [];
  const memeLigne = (a: LigneTableau, b: LigneTableau) =>
    plier(a.designation) === plier(b.designation) && egalOuNul(a.quantite, b.quantite) && egalOuNul(a.prixUnitaire, b.prixUnitaire) && egalOuNul(a.montant, b.montant);
  for (const l of brutes) {
    const meme = parNumero.get(l.numero)!;
    if (meme.length === 1) { lignes.push(l); continue; }
    if (meme[0] !== l) {
      if (memeLigne(meme[0], l)) { doublonsRetires++; continue; }
      l.doutes.push(`le numéro ${l.numero} est imprimé deux fois avec des contenus différents`);
      lignes.push(l);
      continue;
    }
    lignes.push(l);
  }

  // LA NUMÉROTATION SE SUIT : les numéros absents entre 1 (ou le premier) et le dernier.
  const nums = [...new Set(lignes.map((l) => l.numero))].sort((a, b) => a - b);
  const trous: number[] = [];
  if (nums.length) {
    const debut = nums[0] <= 3 ? 1 : nums[0];
    for (let n = debut; n <= nums[nums.length - 1]; n++) if (!parNumero.has(n)) trous.push(n);
  }
  return { lignes, trous, doublonsRetires };
}

const egalOuNul = (a: number | null, b: number | null) => (a === null && b === null) || egal(a, b);

// ─────────────────────────────── La réconciliation ───────────────────────────────

export interface Reconciliation {
  /** La somme des montants des lignes chiffrées. */
  sommeLignes: number;
  /** Le total HT imprimé (null : non lu). */
  htImprime: number | null;
  /** Écart = imprimé − lignes (null sans total imprimé). */
  ecart: number | null;
  /** Les lignes se recoupent, la numérotation se suit, la somme fait le total imprimé. */
  juste: boolean;
  /** Les lignes douteuses NOMMÉES — numéro et raison — pour la carte. */
  douteuses: { numero: number; designation: string; raison: string }[];
  /** Les numéros de lignes absents. */
  manquantes: number[];
}

/**
 * LA SOMME DES LIGNES DOIT FAIRE LE HT IMPRIMÉ. Quand elle ne le fait pas, on cherche QUELLES lignes
 * l'expliquent : une ligne dont le montant égale l'écart (une ligne en trop ou mal lue), une ligne qui
 * ne se recoupe pas, un numéro absent. La carte dit ces lignes — jamais « une ligne est mal lue ».
 */
export function reconcilier(l: Pick<LectureTableau, "lignes" | "trous">, htImprime: number | null): Reconciliation {
  const somme = c2(l.lignes.reduce((s, x) => s + (x.montant ?? 0), 0));
  const ecart = htImprime === null ? null : c2(htImprime - somme);
  const douteuses: Reconciliation["douteuses"] = [];
  for (const x of l.lignes) for (const d of x.doutes) douteuses.push({ numero: x.numero, designation: x.designation, raison: d });
  if (ecart !== null && Math.abs(ecart) >= 0.5) {
    // Une ligne de TROP (écart négatif) dont le montant est exactement l'écart : nommée.
    for (const x of l.lignes) {
      if (x.montant !== null && Math.abs(x.montant + ecart) < 0.5) douteuses.push({ numero: x.numero, designation: x.designation, raison: `son montant (${x.montant}) est exactement l'écart avec le total imprimé : ligne en trop ou mal lue` });
    }
  }
  const juste = ecart !== null && Math.abs(ecart) < 0.5 && l.trous.length === 0 && l.lignes.every((x) => x.doutes.length === 0) && l.lignes.length > 0;
  return { sommeLignes: somme, htImprime, ecart, juste, douteuses, manquantes: [...l.trous] };
}

/** UNE phrase pour la carte — l'écart et ce qui l'explique, ou rien quand tout se tient. */
export function phraseReconciliation(r: Reconciliation, fmt: (n: number) => string): string | null {
  if (r.juste) return null;
  const parts: string[] = [];
  if (r.ecart !== null && Math.abs(r.ecart) >= 0.5) parts.push(`les lignes font ${fmt(r.sommeLignes)} HT, le devis imprime ${fmt(r.htImprime!)} (écart ${fmt(Math.abs(r.ecart))})`);
  else if (r.htImprime === null) parts.push(`le total HT imprimé n'a pas été lu (les lignes font ${fmt(r.sommeLignes)})`);
  if (r.manquantes.length) parts.push(`ligne${r.manquantes.length > 1 ? "s" : ""} ${listeNumeros(r.manquantes)} non lue${r.manquantes.length > 1 ? "s" : ""}`);
  const nommees = [...new Map(r.douteuses.map((d) => [d.numero, d])).values()];
  if (nommees.length) parts.push(`à vérifier : ${nommees.slice(0, 4).map((d) => `ligne ${d.numero} (${d.raison})`).join(" ; ")}${nommees.length > 4 ? ` et ${nommees.length - 4} autre(s)` : ""}`);
  if (!parts.length) return null;
  const t = parts.join(" — ");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

/** « 4 à 8, 11 et 13 » — des numéros en plages. */
export function listeNumeros(ns: readonly number[]): string {
  const t = [...new Set(ns)].sort((a, b) => a - b);
  const plages: string[] = [];
  for (let i = 0; i < t.length; ) {
    let j = i;
    while (j + 1 < t.length && t[j + 1] === t[j] + 1) j++;
    plages.push(j - i >= 2 ? `${t[i]} à ${t[j]}` : j === i ? `${t[i]}` : `${t[i]}, ${t[j]}`);
    i = j + 1;
  }
  return plages.length <= 1 ? (plages[0] ?? "") : `${plages.slice(0, -1).join(", ")} et ${plages[plages.length - 1]}`;
}
