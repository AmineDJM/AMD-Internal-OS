import ExcelJS from "exceljs";
import { decrire, versDate, versNombre, type Ligne } from "@/platform/ia/analyse/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UN TABLEUR EN LIGNES TYPÉES — XLSX (toutes les feuilles) et CSV (lot K1, décision 0031).
 *
 * Un Excel joint n'est pas du TEXTE : c'est des feuilles, des en-têtes, des nombres, des dates et des formules.
 * Lu comme du texte (ce que faisait la lecture des pièces), « 12 345,50 » devenait une chaîne et une formule son
 * libellé ; ici un nombre reste un nombre, une date devient un ISO, une FORMULE rend sa valeur calculée (le
 * résultat que le fichier porte) — et une formule sans valeur enregistrée est COMPTÉE et dite, jamais devinée.
 *
 * Les fonctions de base (`cellule`, `entetesDe`, `lireCsv`, `versLignes`) étaient dans le pont d'Adam
 * (`in-process/sandbox`) : elles vivent ici, au socle, et Adam les importe — une seule lecture des tableurs.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const LIGNES_TABLEUR_MAX = 50_000;
const COLONNES_MAX = 60;
const FEUILLES_MAX = 12;

/** Une cellule ExcelJS TYPÉE : un nombre reste un nombre, une date devient un ISO, une formule rend son résultat. */
export function cellule(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text?: string }[]; hyperlink?: string; error?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? "").join("");
    if (o.result !== undefined) return cellule(o.result);
    if (typeof o.text === "string") return o.text;
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function entetesDe(brutes: unknown[]): string[] {
  const vus = new Map<string, number>();
  return brutes.slice(0, COLONNES_MAX).map((h, i) => {
    let nom = (cellule(h) ?? "").toString().trim() || `colonne_${i + 1}`;
    const n = vus.get(nom) ?? 0;
    vus.set(nom, n + 1);
    if (n > 0) nom = `${nom}_${n + 1}`;
    return nom;
  });
}

function detecterSeparateur(ligne: string): string {
  const compte = (c: string) => (ligne.match(new RegExp(c === "\t" ? "\t" : `\\${c}`, "g")) ?? []).length;
  const candidats: [string, number][] = [[";", compte(";")], [",", compte(",")], ["\t", compte("\t")], ["|", compte("|")]];
  const meilleur = candidats.sort((a, b) => b[1] - a[1])[0];
  return meilleur[1] > 0 ? meilleur[0] : ";";
}

/** Un CSV lu pour de vrai : guillemets, séparateur détecté, BOM retiré. */
export function lireCsv(texte: string, max = LIGNES_TABLEUR_MAX): { entetes: string[]; lignes: unknown[][]; total: number } {
  const t = texte.replace(/^﻿/, "");
  const premiere = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = detecterSeparateur(premiere);
  const lignes: unknown[][] = [];
  let ligne: string[] = []; let champ = ""; let guillemets = false; let total = 0;
  const pousser = () => {
    ligne.push(champ); champ = "";
    if (ligne.some((c) => c.trim() !== "")) { total += 1; if (lignes.length <= max) lignes.push(ligne.map((c) => (c.trim() === "" ? null : c))); }
    ligne = [];
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (guillemets) {
      if (c === '"') { if (t[i + 1] === '"') { champ += '"'; i++; } else guillemets = false; }
      else champ += c;
    } else if (c === '"') guillemets = true;
    else if (c === sep) { ligne.push(champ); champ = ""; }
    else if (c === "\n") pousser();
    else if (c !== "\r") champ += c;
  }
  if (champ !== "" || ligne.length) pousser();
  const entetes = entetesDe(lignes[0] ?? []);
  return { entetes, lignes: lignes.slice(1), total: Math.max(0, total - 1) };
}

export function versLignes(entetes: string[], brutes: unknown[][], max: number): { lignes: Ligne[]; tronque: boolean } {
  const lignes: Ligne[] = [];
  for (const b of brutes) {
    if (lignes.length >= max) return { lignes, tronque: true };
    const o: Ligne = {};
    entetes.forEach((h, i) => { o[h] = b[i] === undefined ? null : b[i]; });
    lignes.push(o);
  }
  return { lignes, tronque: false };
}

/** Le TEXTE d'un CSV typé : « 12 345,50 » → 12345.5, « 03/02/2026 » → « 2026-02-03 » ; le reste reste texte. */
export function typerTexte(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t) return null;
  const d = /^\d{1,2}\/\d{1,2}\/\d{4}$|^\d{4}-\d{2}-\d{2}/.test(t) ? versDate(t) : null;
  if (d) return d.toISOString().slice(0, 10);
  // Un code (« 0012 », un téléphone) n'est pas un nombre : un zéro de tête le garde en texte (« 0,5 » reste un nombre).
  if (/^0\d/.test(t.replace(/\s/g, ""))) return t;
  const fr = t.replace(/\s/g, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(fr)) return Number(fr.replace(/\./g, "").replace(",", "."));
  const n = versNombre(t);
  if (n !== null && /\d/.test(t) && !/[/:]/.test(t)) return n;
  return t;
}

export interface ColonneLue { nom: string; type: "nombre" | "date" | "texte" | "booleen" | "vide"; remplis: number }
export interface FeuilleLue {
  nom: string;
  /** La ligne (1-indexée) où l'en-tête a été trouvé — un titre au-dessus du tableau est sauté, et dit. */
  ligneEntete: number;
  colonnes: ColonneLue[];
  lignes: Ligne[];
  total: number;
  tronque: boolean;
  /** Formules lues (leur VALEUR est prise), dont celles que le fichier n'a pas calculées (valeur absente). */
  formules: number;
  formulesSansValeur: number;
}
export type TableurLu = { ok: true; format: "xlsx" | "csv"; feuilles: FeuilleLue[] } | { ok: false; erreur: string };

/** L'en-tête : la première des dix premières lignes assez remplie et faite de libellés (un titre de rapport n'en est pas un). */
function ligneEntete(brutes: unknown[][]): number {
  const largeur = Math.max(0, ...brutes.slice(0, 30).map((r) => r.filter((c) => c !== null && c !== undefined && c !== "").length));
  for (let i = 0; i < Math.min(10, brutes.length); i++) {
    const pleines = brutes[i].filter((c) => c !== null && c !== undefined && c !== "");
    if (pleines.length >= Math.max(2, Math.ceil(largeur * 0.6)) && pleines.filter((c) => typeof c === "string").length >= pleines.length * 0.7) return i;
  }
  return 0;
}

function feuilleDe(nom: string, brutes: unknown[][], total: number, max: number, formules = 0, sansValeur = 0): FeuilleLue {
  const i = ligneEntete(brutes);
  const entetes = entetesDe(brutes[i] ?? []);
  const { lignes, tronque } = versLignes(entetes, brutes.slice(i + 1), max);
  const profil = decrire(lignes.slice(0, 5_000));
  return {
    nom, ligneEntete: i + 1, lignes, tronque: tronque || total - i - 1 > lignes.length, total: Math.max(0, total - i - 1), formules, formulesSansValeur: sansValeur,
    colonnes: entetes.map((h) => { const c = profil.colonnes.find((x) => x.nom === h); return { nom: h, type: c?.type ?? "vide", remplis: c?.remplis ?? 0 }; }),
  };
}

const extDe = (nom: string): string => (nom.split(".").pop() ?? "").toLowerCase();

/** LIRE un tableur (octets + nom de fichier) : chaque feuille non vide, typée. */
export async function lireTableur(octets: Buffer, nom: string, opts: { max?: number } = {}): Promise<TableurLu> {
  const max = Math.min(Math.max(opts.max ?? LIGNES_TABLEUR_MAX, 1), LIGNES_TABLEUR_MAX);
  const ext = extDe(nom);
  if (["csv", "tsv", "txt"].includes(ext)) {
    const { entetes, lignes, total } = lireCsv(octets.toString("utf8"), max);
    return { ok: true, format: "csv", feuilles: [feuilleDe(nom.replace(/\.[^.]+$/, ""), [entetes, ...lignes.map((l) => l.map(typerTexte))], total + 1, max)] };
  }
  if (!["xlsx", "xlsm"].includes(ext)) return { ok: false, erreur: `format non lisible en tableau : .${ext || "?"} (CSV, TSV, XLSX, XLSM — un ancien .xls s'enregistre d'abord en .xlsx)` };
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(octets as unknown as ArrayBuffer); } catch { return { ok: false, erreur: "classeur illisible (protégé, corrompu ou format ancien .xls)" }; }
  const feuilles: FeuilleLue[] = [];
  for (const ws of wb.worksheets.slice(0, FEUILLES_MAX)) {
    if (ws.state && ws.state !== "visible") continue;
    const brutes: unknown[][] = [];
    let total = 0; let formules = 0; let sansValeur = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      total += 1;
      if (brutes.length > max + 10) return;
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      brutes.push(values.map((v) => {
        if (v && typeof v === "object" && ("formula" in v || "sharedFormula" in v)) {
          formules += 1;
          if ((v as { result?: unknown }).result === undefined) sansValeur += 1;
        }
        const c = cellule(v);
        return typeof c === "string" ? typerTexte(c) : c;
      }));
    });
    if (total > 0) feuilles.push(feuilleDe(ws.name, brutes, total, max, formules, sansValeur));
  }
  if (!feuilles.length) return { ok: false, erreur: "classeur sans feuille remplie" };
  return { ok: true, format: "xlsx", feuilles };
}
