import { analyser, fonctionsDe, type Noeud, type Ref } from "@/lib/artifact/sheets/formula";
import { idDe, plageDeNom, type Graphe, type IdCellule } from "@/lib/artifact/sheets/graph";
import { cleDe, type Plage } from "@/lib/artifact/sheets/refs";
import { type Cellule, type Classeur, type Feuille } from "@/lib/artifact/sheets/model";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR DE RECALCUL — les formules d'un classeur, recalculées par du code, sans Excel.
 *
 * ── POURQUOI ────────────────────────────────────────────────────────────────────────────
 *
 * Aucune bibliothèque du dépôt n'évalue une formule ; `missions/artifacts/verify.ts` le dit et
 * vérifie la FORME des totaux, jamais leur valeur. Or « le contrôle qualité est arithmétique et a
 * le dernier mot » (§118-10) : un classeur livré au dirigeant doit pouvoir être RECALCULÉ, et une
 * valeur affichée qui ne correspond pas à sa formule (classeur enregistré sans recalcul, calcul
 * manuel, liaison morte) doit être NOMMÉE. Ce moteur couvre les fonctions qui font l'essentiel
 * des classeurs de gestion ; ce qu'il ne connaît pas rend #NAME? et l'audit le dit — jamais une
 * valeur devinée.
 *
 * ── LES CONVENTIONS D'EXCEL QU'IL RESPECTE ───────────────────────────────────────────────
 *
 * Erreurs propagées ; cellule vide = 0 en arithmétique et "" en texte ; texte numérique coercé
 * par les opérateurs (« 3 »+1 = 4) mais IGNORÉ par SUM/AVERAGE dans une plage ; booléens = 1/0 ;
 * comparaisons de texte insensibles à la casse ; dates = numéros de série 1900 ; division par
 * zéro = #DIV/0! ; VLOOKUP approché sur une colonne triée ; critères de SUMIF/COUNTIF (« >10 »,
 * « <>x », jokers * et ?).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export class ErreurExcel {
  constructor(public readonly code: string) {}
  toString(): string { return this.code; }
}
export type Scalaire = number | string | boolean | ErreurExcel | null;
export interface Matrice { lignes: Scalaire[][]; feuille?: number; plage?: Plage }
export type Valeur = Scalaire | Matrice;

const ERR = (code: string) => new ErreurExcel(code);
const estErreur = (v: unknown): v is ErreurExcel => v instanceof ErreurExcel;
const estMatrice = (v: unknown): v is Matrice => typeof v === "object" && v !== null && "lignes" in (v as Record<string, unknown>);

export interface ContexteEvaluation {
  classeur: Classeur;
  /** Les valeurs déjà recalculées dans ce passage — elles priment sur les valeurs en cache. */
  calculees: Map<IdCellule, Scalaire>;
  /** « Maintenant », injecté : TODAY() et NOW() sont volatiles et un banc doit être reproductible. */
  maintenant: Date;
  feuilleCourante: number;
  origine: { row: number; col: number };
  /** Fonctions rencontrées que le moteur ne connaît pas (renvoient #NAME?). */
  inconnues: Set<string>;
}

// ── Coercions ─────────────────────────────────────────────────────────────────────────────

function enNombre(v: Scalaire, strict = false): number | ErreurExcel {
  if (estErreur(v)) return v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (strict) return ERR("#VALUE!");
  const t = v.trim();
  if (t === "") return 0;
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  if (Number.isFinite(n)) return n;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) {
    const [d, m, y] = t.split("/").map(Number);
    return serieDeDate(y, m, d);
  }
  return ERR("#VALUE!");
}

function enTexte(v: Scalaire): string | ErreurExcel {
  if (estErreur(v)) return v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formaterNombre(v);
  return v;
}

function enBooleen(v: Scalaire): boolean | ErreurExcel {
  if (estErreur(v)) return v;
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const t = v.trim().toUpperCase();
  if (t === "TRUE" || t === "VRAI") return true;
  if (t === "FALSE" || t === "FAUX") return false;
  return ERR("#VALUE!");
}

function formaterNombre(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toPrecision(15);
  return String(Number(s));
}

/** Numéro de série Excel (1900, UTC) d'une date civile. */
export function serieDeDate(y: number, m: number, d: number): number {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
export function dateDeSerie(serie: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + serie * 86_400_000);
}

// ── Lecture des cellules ──────────────────────────────────────────────────────────────────

function feuilleDe(ctx: ContexteEvaluation, nom: string | null): Feuille | null {
  if (nom === null) return ctx.classeur.feuilles.find((f) => f.index === ctx.feuilleCourante) ?? null;
  const cible = nom.toLowerCase();
  return ctx.classeur.feuilles.find((f) => f.nom.toLowerCase() === cible) ?? null;
}

function valeurCellule(ctx: ContexteEvaluation, feuille: Feuille, row: number, col: number): Scalaire {
  const calc = ctx.calculees.get(idDe(feuille.index, row, col));
  if (calc !== undefined) return calc;
  const c: Cellule | undefined = feuille.cellules.get(cleDe(row, col));
  if (!c) return null;
  if (c.t === "e") return ERR(typeof c.v === "string" ? c.v : "#VALUE!");
  return c.v;
}

function lireRef(ctx: ContexteEvaluation, r: Ref): Valeur {
  if (r.externe) return ERR("#REF!");
  const f = feuilleDe(ctx, r.feuille);
  if (!f) return ERR("#REF!");
  // Une cellule seule rend une matrice 1×1, PAS un scalaire : c'est ce qui distingue une
  // RÉFÉRENCE d'un LITTÉRAL. COUNT(B7) où B7 contient « 3 » (texte) vaut 0 dans Excel, alors que
  // COUNT("3") vaut 1 ; SUM(B7) vaut 0, alors que B7+1 vaut 4. `scalaire()` déballe la 1×1.
  if (r.type === "cell") return { lignes: [[valeurCellule(ctx, f, r.r1, r.c1)]], feuille: f.index, plage: { r1: r.r1, c1: r.c1, r2: r.r1, c2: r.c1 } };
  // Une plage : bornée par ce que la feuille contient réellement (A:A ne lit pas un million de vides).
  const r2 = Math.min(r.r2, Math.max(f.lignes, r.r1));
  const c2 = Math.min(r.c2, Math.max(f.colonnes, r.c1));
  const lignes: Scalaire[][] = [];
  for (let row = r.r1; row <= r2; row++) {
    const ligne: Scalaire[] = [];
    for (let col = r.c1; col <= c2; col++) ligne.push(valeurCellule(ctx, f, row, col));
    lignes.push(ligne);
  }
  return { lignes, feuille: f.index, plage: { r1: r.r1, c1: r.c1, r2, c2 } };
}

function aplatir(v: Valeur): Scalaire[] {
  if (estMatrice(v)) return v.lignes.flat();
  return [v];
}

/** Les nombres d'une liste d'arguments, avec la règle d'Excel : dans une PLAGE, le texte est ignoré ; en argument direct, il est coercé. */
function nombresDe(args: Valeur[]): number[] | ErreurExcel {
  const out: number[] = [];
  for (const a of args) {
    if (estMatrice(a)) {
      for (const v of a.lignes.flat()) {
        if (estErreur(v)) return v;
        if (typeof v === "number") out.push(v);
        else if (typeof v === "boolean") continue;
      }
    } else {
      if (estErreur(a)) return a;
      if (a === null) continue;
      const n = enNombre(a);
      if (estErreur(n)) return n;
      out.push(n);
    }
  }
  return out;
}

// ── Critères (SUMIF, COUNTIF…) ────────────────────────────────────────────────────────────

function critere(c: Scalaire): (v: Scalaire) => boolean {
  if (estErreur(c)) return () => false;
  if (c === null) return (v) => v === null || v === "";
  if (typeof c === "number" || typeof c === "boolean") return (v) => v === c || (typeof v === "string" && enNombre(v) === c);
  const m = /^(<>|>=|<=|=|>|<)(.*)$/.exec(c);
  const op = m ? m[1] : "=";
  const brut = m ? m[2] : c;
  const nombre = brut.trim() === "" ? null : Number(brut.replace(",", "."));
  if (nombre !== null && Number.isFinite(nombre)) {
    return (v) => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
      if (n === null) return op === "<>";
      switch (op) { case ">": return n > nombre; case "<": return n < nombre; case ">=": return n >= nombre; case "<=": return n <= nombre; case "<>": return n !== nombre; default: return n === nombre; }
    };
  }
  const motif = brut.toLowerCase();
  const regex = /[*?]/.test(motif) ? new RegExp(`^${motif.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : null;
  return (v) => {
    const t = (v === null ? "" : typeof v === "string" ? v : String(enTexte(v))).toLowerCase();
    const egal = regex ? regex.test(t) : t === motif;
    return op === "<>" ? !egal : egal;
  };
}

// ── Comparaison ───────────────────────────────────────────────────────────────────────────

function comparer(a: Scalaire, b: Scalaire): number | ErreurExcel {
  if (estErreur(a)) return a; if (estErreur(b)) return b;
  const rang = (v: Scalaire) => (v === null ? 0 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  const A = a === null ? (typeof b === "string" ? "" : 0) : a;
  const B = b === null ? (typeof a === "string" ? "" : 0) : b;
  if (rang(A) !== rang(B)) return rang(A) - rang(B);
  if (typeof A === "string" && typeof B === "string") { const x = A.toLowerCase(); const y = B.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  const x = Number(A); const y = Number(B);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── L'évaluation ──────────────────────────────────────────────────────────────────────────

function scalaire(v: Valeur, ctx: ContexteEvaluation): Scalaire {
  if (!estMatrice(v)) return v;
  // Une plage en contexte scalaire : l'intersection implicite avec la ligne/colonne courante, sinon #VALUE!.
  if (v.lignes.length === 1 && v.lignes[0].length === 1) return v.lignes[0][0];
  if (v.plage && v.feuille === ctx.feuilleCourante) {
    if (v.plage.c1 === v.plage.c2 && ctx.origine.row >= v.plage.r1 && ctx.origine.row <= v.plage.r2) return v.lignes[ctx.origine.row - v.plage.r1]?.[0] ?? null;
    if (v.plage.r1 === v.plage.r2 && ctx.origine.col >= v.plage.c1 && ctx.origine.col <= v.plage.c2) return v.lignes[0]?.[ctx.origine.col - v.plage.c1] ?? null;
  }
  return ERR("#VALUE!");
}

export function evaluer(n: Noeud, ctx: ContexteEvaluation): Valeur {
  switch (n.k) {
    case "num": return n.v;
    case "str": return n.v;
    case "bool": return n.v;
    case "err": return ERR(n.v);
    case "ref": return lireRef(ctx, n.ref);
    case "name": {
      if (n.nom === "") return null;
      const p = plageDeNom(ctx.classeur, n.nom, ctx.feuilleCourante);
      if (p) {
        const f = ctx.classeur.feuilles.find((x) => x.index === p.feuille)!;
        return lireRef(ctx, { feuille: f.nom, externe: false, ...p.plage, absR1: true, absC1: true, absR2: true, absC2: true, type: p.plage.r1 === p.plage.r2 && p.plage.c1 === p.plage.c2 ? "cell" : "range" });
      }
      // Un nom défini constant (=0.19) s'évalue comme une formule.
      const defini = ctx.classeur.noms.find((x) => x.nom.toLowerCase() === n.nom.toLowerCase());
      if (defini) { const a = analyser(defini.refersTo); if (a) return evaluer(a, ctx); }
      return ERR("#NAME?");
    }
    case "pct": { const a = enNombre(scalaire(evaluer(n.a, ctx), ctx)); return estErreur(a) ? a : a / 100; }
    case "un": { const a = enNombre(scalaire(evaluer(n.a, ctx), ctx)); return estErreur(a) ? a : -a; }
    case "bin": return binaire(n.op, scalaire(evaluer(n.g, ctx), ctx), scalaire(evaluer(n.d, ctx), ctx));
    case "array": return { lignes: n.lignes.map((l) => l.map((x) => scalaire(evaluer(x, ctx), ctx))) };
    case "call": return appeler(n.fn, n.args, ctx);
  }
}

function binaire(op: string, a: Scalaire, b: Scalaire): Scalaire {
  if (estErreur(a)) return a; if (estErreur(b)) return b;
  if (op === "&") { const x = enTexte(a); const y = enTexte(b); return estErreur(x) ? x : estErreur(y) ? y : x + y; }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const c = comparer(a, b);
    if (estErreur(c)) return c;
    switch (op) { case "=": return c === 0; case "<>": return c !== 0; case "<": return c < 0; case ">": return c > 0; case "<=": return c <= 0; default: return c >= 0; }
  }
  const x = enNombre(a); const y = enNombre(b);
  if (estErreur(x)) return x; if (estErreur(y)) return y;
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return y === 0 ? ERR("#DIV/0!") : x / y;
    case "^": { const r = Math.pow(x, y); return Number.isFinite(r) ? r : ERR("#NUM!"); }
    default: return ERR("#VALUE!");
  }
}

type Fn = (args: Valeur[], ctx: ContexteEvaluation, bruts: Noeud[]) => Valeur;

const nombre1 = (f: (x: number) => number): Fn => (args, ctx) => {
  const x = enNombre(scalaire(args[0] ?? null, ctx));
  if (estErreur(x)) return x;
  const r = f(x);
  return Number.isFinite(r) ? r : ERR("#NUM!");
};

const arrondir = (x: number, d: number, mode: "round" | "up" | "down"): number => {
  const p = Math.pow(10, Math.trunc(d));
  const v = x * p;
  const eps = 1e-9 * Math.sign(v);
  const r = mode === "round" ? Math.round(Math.abs(v) + 1e-9) * Math.sign(v) : mode === "up" ? Math.ceil(Math.abs(v) - 1e-9) * Math.sign(v) : Math.floor(Math.abs(v) + 1e-9) * Math.sign(v);
  void eps;
  return r / p;
};

function chercherIndex(valeur: Scalaire, liste: Scalaire[], type: number): number | ErreurExcel {
  if (type === 0) {
    const i = liste.findIndex((v) => comparer(v, valeur) === 0);
    return i < 0 ? ERR("#N/A") : i;
  }
  // Correspondance approchée : la plus grande valeur ≤ cherchée (type 1, liste croissante) ou la plus petite ≥ (type -1).
  let trouve = -1;
  for (let i = 0; i < liste.length; i++) {
    const c = comparer(liste[i], valeur);
    if (estErreur(c)) continue;
    if (type === 1 && c <= 0) trouve = i;
    if (type === 1 && c > 0) break;
    if (type === -1 && c >= 0) trouve = i;
    if (type === -1 && c < 0) break;
  }
  return trouve < 0 ? ERR("#N/A") : trouve;
}

const FONCTIONS: Record<string, Fn> = {
  SUM: (args) => { const n = nombresDe(args); return estErreur(n) ? n : n.reduce((a, b) => a + b, 0); },
  SOMME: (args) => FONCTIONS.SUM(args, undefined as never, []),
  AVERAGE: (args) => { const n = nombresDe(args); if (estErreur(n)) return n; return n.length === 0 ? ERR("#DIV/0!") : n.reduce((a, b) => a + b, 0) / n.length; },
  MOYENNE: (args) => FONCTIONS.AVERAGE(args, undefined as never, []),
  MIN: (args) => { const n = nombresDe(args); return estErreur(n) ? n : n.length === 0 ? 0 : Math.min(...n); },
  MAX: (args) => { const n = nombresDe(args); return estErreur(n) ? n : n.length === 0 ? 0 : Math.max(...n); },
  COUNT: (args) => { let c = 0; for (const a of args) for (const v of aplatir(a)) if (typeof v === "number" || (!estMatrice(a) && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) c++; return c; },
  NB: (args) => FONCTIONS.COUNT(args, undefined as never, []),
  COUNTA: (args) => { let c = 0; for (const a of args) for (const v of aplatir(a)) if (v !== null && v !== "") c++; return c; },
  NBVAL: (args) => FONCTIONS.COUNTA(args, undefined as never, []),
  COUNTBLANK: (args, _ctx, bruts) => {
    // La plage lue est BORNÉE par le contenu de la feuille (E1:E5 sur une feuille de 4 colonnes ne
    // rend rien) ; les vides au-delà comptent quand même : on part de la taille DEMANDÉE.
    let c = 0;
    args.forEach((a, i) => {
      const b = bruts[i];
      const nonVides = aplatir(a).filter((v) => v !== null && v !== "").length;
      if (b?.k === "ref") c += (b.ref.r2 - b.ref.r1 + 1) * (b.ref.c2 - b.ref.c1 + 1) - nonVides;
      else if (estMatrice(a)) c += a.lignes.flat().length - nonVides;
      else if (a === null || a === "") c += 1;
    });
    return c;
  },
  PRODUCT: (args) => { const n = nombresDe(args); return estErreur(n) ? n : n.reduce((a, b) => a * b, 1); },
  SUMPRODUCT: (args) => {
    const mats = args.map((a) => (estMatrice(a) ? a.lignes.flat() : [a]));
    const taille = mats[0]?.length ?? 0;
    if (mats.some((m) => m.length !== taille)) return ERR("#VALUE!");
    let total = 0;
    for (let i = 0; i < taille; i++) { let p = 1; for (const m of mats) { const v = m[i]; if (estErreur(v)) return v; p *= typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : 0; } total += p; }
    return total;
  },
  SUMIF: (args, ctx) => {
    const plage = args[0]; const crit = critere(scalaire(args[1] ?? null, ctx)); const somme = args[2] ?? plage;
    if (!estMatrice(plage)) return ERR("#VALUE!");
    const src = estMatrice(somme) ? somme.lignes : plage.lignes;
    let total = 0;
    plage.lignes.forEach((l, i) => l.forEach((v, j) => { if (crit(v)) { const s = src[i]?.[j]; if (typeof s === "number") total += s; } }));
    return total;
  },
  SUMIFS: (args, ctx) => {
    const somme = args[0];
    if (!estMatrice(somme)) return ERR("#VALUE!");
    const paires: { m: Matrice; c: (v: Scalaire) => boolean }[] = [];
    for (let i = 1; i + 1 < args.length; i += 2) { const m = args[i]; if (!estMatrice(m)) return ERR("#VALUE!"); paires.push({ m, c: critere(scalaire(args[i + 1], ctx)) }); }
    let total = 0;
    somme.lignes.forEach((l, i) => l.forEach((v, j) => { if (paires.every((p) => p.c(p.m.lignes[i]?.[j] ?? null)) && typeof v === "number") total += v; }));
    return total;
  },
  COUNTIF: (args, ctx) => { const plage = args[0]; if (!estMatrice(plage)) return ERR("#VALUE!"); const c = critere(scalaire(args[1] ?? null, ctx)); let n = 0; for (const v of plage.lignes.flat()) if (c(v)) n++; return n; },
  COUNTIFS: (args, ctx) => {
    const paires: { m: Matrice; c: (v: Scalaire) => boolean }[] = [];
    for (let i = 0; i + 1 < args.length; i += 2) { const m = args[i]; if (!estMatrice(m)) return ERR("#VALUE!"); paires.push({ m, c: critere(scalaire(args[i + 1], ctx)) }); }
    if (paires.length === 0) return ERR("#VALUE!");
    let n = 0;
    paires[0].m.lignes.forEach((l, i) => l.forEach((_, j) => { if (paires.every((p) => p.c(p.m.lignes[i]?.[j] ?? null))) n++; }));
    return n;
  },
  AVERAGEIF: (args, ctx) => {
    const plage = args[0]; const c = critere(scalaire(args[1] ?? null, ctx)); const src = args[2] ?? plage;
    if (!estMatrice(plage)) return ERR("#VALUE!");
    const s = estMatrice(src) ? src.lignes : plage.lignes; let total = 0; let n = 0;
    plage.lignes.forEach((l, i) => l.forEach((v, j) => { if (c(v)) { const x = s[i]?.[j]; if (typeof x === "number") { total += x; n++; } } }));
    return n === 0 ? ERR("#DIV/0!") : total / n;
  },
  IF: (args, ctx, bruts) => {
    const cond = enBooleen(scalaire(args[0] ?? null, ctx));
    if (estErreur(cond)) return cond;
    const branche = cond ? bruts[1] : bruts[2];
    if (!branche || (branche.k === "name" && branche.nom === "")) return cond ? true : false;
    return evaluer(branche, ctx);
  },
  SI: (args, ctx, bruts) => FONCTIONS.IF(args, ctx, bruts),
  IFS: (args, ctx, bruts) => {
    for (let i = 0; i + 1 < bruts.length; i += 2) {
      const cond = enBooleen(scalaire(evaluer(bruts[i], ctx), ctx));
      if (estErreur(cond)) return cond;
      if (cond) return evaluer(bruts[i + 1], ctx);
    }
    return ERR("#N/A");
  },
  IFERROR: (args, ctx, bruts) => { const v = scalaire(evaluer(bruts[0], ctx), ctx); return estErreur(v) ? (bruts[1] ? evaluer(bruts[1], ctx) : null) : v; },
  SIERREUR: (args, ctx, bruts) => FONCTIONS.IFERROR(args, ctx, bruts),
  IFNA: (args, ctx, bruts) => { const v = scalaire(evaluer(bruts[0], ctx), ctx); return estErreur(v) && v.code === "#N/A" ? (bruts[1] ? evaluer(bruts[1], ctx) : null) : v; },
  ISERROR: (args, ctx) => estErreur(scalaire(args[0] ?? null, ctx)),
  ISNUMBER: (args, ctx) => typeof scalaire(args[0] ?? null, ctx) === "number",
  ISTEXT: (args, ctx) => typeof scalaire(args[0] ?? null, ctx) === "string",
  ISBLANK: (args, ctx) => { const v = scalaire(args[0] ?? null, ctx); return v === null; },
  AND: (args, ctx) => { for (const a of args) for (const v of aplatir(a)) { if (v === null && estMatrice(a)) continue; const b = enBooleen(v); if (estErreur(b)) return b; if (!b) return false; } return true; },
  ET: (args, ctx) => FONCTIONS.AND(args, ctx, []),
  OR: (args, ctx) => { for (const a of args) for (const v of aplatir(a)) { if (v === null && estMatrice(a)) continue; const b = enBooleen(v); if (estErreur(b)) return b; if (b) return true; } return false; },
  OU: (args, ctx) => FONCTIONS.OR(args, ctx, []),
  NOT: (args, ctx) => { const b = enBooleen(scalaire(args[0] ?? null, ctx)); return estErreur(b) ? b : !b; },
  TRUE: () => true, FALSE: () => false,
  ABS: nombre1(Math.abs), INT: nombre1(Math.floor), SQRT: nombre1((x) => (x < 0 ? NaN : Math.sqrt(x))), EXP: nombre1(Math.exp), LN: nombre1((x) => (x <= 0 ? NaN : Math.log(x))), LOG10: nombre1((x) => (x <= 0 ? NaN : Math.log10(x))),
  LOG: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const b = args[1] === undefined ? 10 : enNombre(scalaire(args[1], ctx)); if (estErreur(x)) return x; if (estErreur(b)) return b; if (x <= 0 || b <= 0) return ERR("#NUM!"); const r = b === 10 ? Math.log10(x) : b === 2 ? Math.log2(x) : Math.log(x) / Math.log(b); return Number(r.toPrecision(15)); },
  ROUND: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const d = enNombre(scalaire(args[1] ?? 0, ctx)); return estErreur(x) ? x : estErreur(d) ? d : arrondir(x, d, "round"); },
  ARRONDI: (args, ctx) => FONCTIONS.ROUND(args, ctx, []),
  ROUNDUP: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const d = enNombre(scalaire(args[1] ?? 0, ctx)); return estErreur(x) ? x : estErreur(d) ? d : arrondir(x, d, "up"); },
  ROUNDDOWN: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const d = enNombre(scalaire(args[1] ?? 0, ctx)); return estErreur(x) ? x : estErreur(d) ? d : arrondir(x, d, "down"); },
  MOD: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const y = enNombre(scalaire(args[1] ?? null, ctx)); if (estErreur(x)) return x; if (estErreur(y)) return y; return y === 0 ? ERR("#DIV/0!") : x - y * Math.floor(x / y); },
  POWER: (args, ctx) => binaire("^", scalaire(args[0] ?? null, ctx), scalaire(args[1] ?? null, ctx)),
  MEDIAN: (args) => { const n = nombresDe(args); if (estErreur(n)) return n; if (n.length === 0) return ERR("#NUM!"); const s = [...n].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; },
  LARGE: (args, ctx) => { const n = nombresDe([args[0]]); const k = enNombre(scalaire(args[1] ?? null, ctx)); if (estErreur(n)) return n; if (estErreur(k)) return k; const s = [...n].sort((a, b) => b - a); return s[k - 1] ?? ERR("#NUM!"); },
  SMALL: (args, ctx) => { const n = nombresDe([args[0]]); const k = enNombre(scalaire(args[1] ?? null, ctx)); if (estErreur(n)) return n; if (estErreur(k)) return k; const s = [...n].sort((a, b) => a - b); return s[k - 1] ?? ERR("#NUM!"); },
  STDEV: (args) => { const n = nombresDe(args); if (estErreur(n)) return n; if (n.length < 2) return ERR("#DIV/0!"); const m = n.reduce((a, b) => a + b, 0) / n.length; return Math.sqrt(n.reduce((a, b) => a + (b - m) ** 2, 0) / (n.length - 1)); },
  "STDEV.S": (args) => FONCTIONS.STDEV(args, undefined as never, []),
  VAR: (args) => { const n = nombresDe(args); if (estErreur(n)) return n; if (n.length < 2) return ERR("#DIV/0!"); const m = n.reduce((a, b) => a + b, 0) / n.length; return n.reduce((a, b) => a + (b - m) ** 2, 0) / (n.length - 1); },
  RANK: (args, ctx) => { const x = enNombre(scalaire(args[0] ?? null, ctx)); const n = nombresDe([args[1]]); const ordre = enNombre(scalaire(args[2] ?? 0, ctx)); if (estErreur(x)) return x; if (estErreur(n)) return n; if (estErreur(ordre)) return ordre; const s = [...n].sort((a, b) => (ordre === 0 ? b - a : a - b)); const i = s.indexOf(x); return i < 0 ? ERR("#N/A") : i + 1; },
  // ── Texte ──
  CONCATENATE: (args, ctx) => { let s = ""; for (const a of args) { const t = enTexte(scalaire(a, ctx)); if (estErreur(t)) return t; s += t; } return s; },
  CONCAT: (args, ctx) => { let s = ""; for (const a of args) for (const v of aplatir(a)) { const t = enTexte(v); if (estErreur(t)) return t; s += t; } return s; },
  TEXTJOIN: (args, ctx) => { const sep = enTexte(scalaire(args[0] ?? "", ctx)); const ignorer = enBooleen(scalaire(args[1] ?? true, ctx)); if (estErreur(sep)) return sep; if (estErreur(ignorer)) return ignorer; const parts: string[] = []; for (const a of args.slice(2)) for (const v of aplatir(a)) { if (ignorer && (v === null || v === "")) continue; const t = enTexte(v); if (estErreur(t)) return t; parts.push(t); } return parts.join(sep); },
  LEFT: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); const n = enNombre(scalaire(args[1] ?? 1, ctx)); return estErreur(t) ? t : estErreur(n) ? n : t.slice(0, Math.max(0, n)); },
  GAUCHE: (args, ctx) => FONCTIONS.LEFT(args, ctx, []),
  RIGHT: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); const n = enNombre(scalaire(args[1] ?? 1, ctx)); return estErreur(t) ? t : estErreur(n) ? n : n <= 0 ? "" : t.slice(-n); },
  DROITE: (args, ctx) => FONCTIONS.RIGHT(args, ctx, []),
  MID: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); const d = enNombre(scalaire(args[1] ?? 1, ctx)); const n = enNombre(scalaire(args[2] ?? 0, ctx)); if (estErreur(t)) return t; if (estErreur(d)) return d; if (estErreur(n)) return n; return d < 1 ? ERR("#VALUE!") : t.slice(d - 1, d - 1 + Math.max(0, n)); },
  LEN: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); return estErreur(t) ? t : t.length; },
  NBCAR: (args, ctx) => FONCTIONS.LEN(args, ctx, []),
  TRIM: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); return estErreur(t) ? t : t.trim().replace(/\s+/g, " "); },
  UPPER: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); return estErreur(t) ? t : t.toUpperCase(); },
  LOWER: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); return estErreur(t) ? t : t.toLowerCase(); },
  PROPER: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); return estErreur(t) ? t : t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); },
  SUBSTITUTE: (args, ctx) => { const t = enTexte(scalaire(args[0] ?? "", ctx)); const a = enTexte(scalaire(args[1] ?? "", ctx)); const b = enTexte(scalaire(args[2] ?? "", ctx)); if (estErreur(t)) return t; if (estErreur(a)) return a; if (estErreur(b)) return b; return a === "" ? t : t.split(a).join(b); },
  FIND: (args, ctx) => { const a = enTexte(scalaire(args[0] ?? "", ctx)); const t = enTexte(scalaire(args[1] ?? "", ctx)); const d = enNombre(scalaire(args[2] ?? 1, ctx)); if (estErreur(a)) return a; if (estErreur(t)) return t; if (estErreur(d)) return d; const i = t.indexOf(a, d - 1); return i < 0 ? ERR("#VALUE!") : i + 1; },
  SEARCH: (args, ctx) => { const a = enTexte(scalaire(args[0] ?? "", ctx)); const t = enTexte(scalaire(args[1] ?? "", ctx)); const d = enNombre(scalaire(args[2] ?? 1, ctx)); if (estErreur(a)) return a; if (estErreur(t)) return t; if (estErreur(d)) return d; const i = t.toLowerCase().indexOf(a.toLowerCase(), d - 1); return i < 0 ? ERR("#VALUE!") : i + 1; },
  VALUE: (args, ctx) => enNombre(scalaire(args[0] ?? null, ctx)),
  CNUM: (args, ctx) => enNombre(scalaire(args[0] ?? null, ctx)),
  TEXT: (args, ctx) => { const v = scalaire(args[0] ?? null, ctx); const fmt = enTexte(scalaire(args[1] ?? "", ctx)); if (estErreur(v)) return v; if (estErreur(fmt)) return fmt; return formaterTexte(v, fmt); },
  // ── Recherche ──
  VLOOKUP: (args, ctx) => {
    const cherche = scalaire(args[0] ?? null, ctx); const table = args[1]; const col = enNombre(scalaire(args[2] ?? null, ctx)); const approx = args[3] === undefined ? true : enBooleen(scalaire(args[3], ctx));
    if (estErreur(cherche)) return cherche; if (!estMatrice(table)) return ERR("#VALUE!"); if (estErreur(col)) return col; if (estErreur(approx)) return approx;
    if (col < 1 || col > (table.lignes[0]?.length ?? 0)) return ERR("#REF!");
    const i = chercherIndex(cherche, table.lignes.map((l) => l[0]), approx ? 1 : 0);
    return estErreur(i) ? i : table.lignes[i][col - 1] ?? null;
  },
  RECHERCHEV: (args, ctx) => FONCTIONS.VLOOKUP(args, ctx, []),
  HLOOKUP: (args, ctx) => {
    const cherche = scalaire(args[0] ?? null, ctx); const table = args[1]; const row = enNombre(scalaire(args[2] ?? null, ctx)); const approx = args[3] === undefined ? true : enBooleen(scalaire(args[3], ctx));
    if (estErreur(cherche)) return cherche; if (!estMatrice(table)) return ERR("#VALUE!"); if (estErreur(row)) return row; if (estErreur(approx)) return approx;
    if (row < 1 || row > table.lignes.length) return ERR("#REF!");
    const i = chercherIndex(cherche, table.lignes[0] ?? [], approx ? 1 : 0);
    return estErreur(i) ? i : table.lignes[row - 1][i] ?? null;
  },
  MATCH: (args, ctx) => { const cherche = scalaire(args[0] ?? null, ctx); const plage = args[1]; const type = args[2] === undefined ? 1 : enNombre(scalaire(args[2], ctx)); if (estErreur(cherche)) return cherche; if (!estMatrice(plage)) return ERR("#VALUE!"); if (estErreur(type)) return type; const i = chercherIndex(cherche, plage.lignes.flat(), type); return estErreur(i) ? i : i + 1; },
  EQUIV: (args, ctx) => FONCTIONS.MATCH(args, ctx, []),
  INDEX: (args, ctx) => {
    const plage = args[0]; const r = enNombre(scalaire(args[1] ?? 0, ctx)); const c = args[2] === undefined ? 0 : enNombre(scalaire(args[2], ctx));
    if (!estMatrice(plage)) return r === 1 || r === 0 ? plage : ERR("#REF!");
    if (estErreur(r)) return r; if (estErreur(c)) return c;
    const uneLigne = plage.lignes.length === 1; const uneCol = plage.lignes[0]?.length === 1;
    const rr = uneLigne && c === 0 ? 1 : r; const cc = uneCol && c === 0 ? 1 : (uneLigne && c === 0 ? r : c);
    if (rr === 0 && cc === 0) return plage;
    if (rr === 0) return { lignes: plage.lignes.map((l) => [l[cc - 1] ?? null]) };
    if (cc === 0) return { lignes: [plage.lignes[rr - 1] ?? []] };
    const v = plage.lignes[rr - 1]?.[cc - 1];
    return v === undefined ? ERR("#REF!") : v;
  },
  XLOOKUP: (args, ctx) => {
    const cherche = scalaire(args[0] ?? null, ctx); const cles = args[1]; const retours = args[2];
    if (estErreur(cherche)) return cherche; if (!estMatrice(cles) || !estMatrice(retours)) return ERR("#VALUE!");
    const i = chercherIndex(cherche, cles.lignes.flat(), 0);
    if (estErreur(i)) return args[3] !== undefined ? scalaire(args[3], ctx) : ERR("#N/A");
    const plat = retours.lignes.flat();
    return plat[i] ?? null;
  },
  CHOOSE: (args, ctx, bruts) => { const i = enNombre(scalaire(args[0] ?? null, ctx)); if (estErreur(i)) return i; const b = bruts[i]; return b ? evaluer(b, ctx) : ERR("#VALUE!"); },
  ROW: (args, ctx, bruts) => (bruts[0] && bruts[0].k === "ref" ? bruts[0].ref.r1 : ctx.origine.row),
  COLUMN: (args, ctx, bruts) => (bruts[0] && bruts[0].k === "ref" ? bruts[0].ref.c1 : ctx.origine.col),
  ROWS: (args, _ctx, bruts) => (bruts[0]?.k === "ref" ? bruts[0].ref.r2 - bruts[0].ref.r1 + 1 : estMatrice(args[0]) ? args[0].lignes.length : 1),
  COLUMNS: (args, _ctx, bruts) => (bruts[0]?.k === "ref" ? bruts[0].ref.c2 - bruts[0].ref.c1 + 1 : estMatrice(args[0]) ? (args[0].lignes[0]?.length ?? 0) : 1),
  // ── Dates ──
  TODAY: (_a, ctx) => serieDeDate(ctx.maintenant.getUTCFullYear(), ctx.maintenant.getUTCMonth() + 1, ctx.maintenant.getUTCDate()),
  AUJOURDHUI: (_a, ctx) => FONCTIONS.TODAY([], ctx, []),
  NOW: (_a, ctx) => (ctx.maintenant.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000,
  DATE: (args, ctx) => { const y = enNombre(scalaire(args[0] ?? null, ctx)); const m = enNombre(scalaire(args[1] ?? null, ctx)); const d = enNombre(scalaire(args[2] ?? null, ctx)); if (estErreur(y)) return y; if (estErreur(m)) return m; if (estErreur(d)) return d; return serieDeDate(y, m, d); },
  YEAR: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); return estErreur(s) ? s : dateDeSerie(s).getUTCFullYear(); },
  ANNEE: (args, ctx) => FONCTIONS.YEAR(args, ctx, []),
  MONTH: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); return estErreur(s) ? s : dateDeSerie(s).getUTCMonth() + 1; },
  MOIS: (args, ctx) => FONCTIONS.MONTH(args, ctx, []),
  DAY: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); return estErreur(s) ? s : dateDeSerie(s).getUTCDate(); },
  JOUR: (args, ctx) => FONCTIONS.DAY(args, ctx, []),
  EOMONTH: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); const m = enNombre(scalaire(args[1] ?? 0, ctx)); if (estErreur(s)) return s; if (estErreur(m)) return m; const d = dateDeSerie(s); return serieDeDate(d.getUTCFullYear(), d.getUTCMonth() + 1 + m + 1, 0); },
  EDATE: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); const m = enNombre(scalaire(args[1] ?? 0, ctx)); if (estErreur(s)) return s; if (estErreur(m)) return m; const d = dateDeSerie(s); const cible = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1)); const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate(); return serieDeDate(cible.getUTCFullYear(), cible.getUTCMonth() + 1, Math.min(d.getUTCDate(), dernier)); },
  DAYS: (args, ctx) => { const a = enNombre(scalaire(args[0] ?? null, ctx)); const b = enNombre(scalaire(args[1] ?? null, ctx)); return estErreur(a) ? a : estErreur(b) ? b : a - b; },
  DATEDIF: (args, ctx) => { const a = enNombre(scalaire(args[0] ?? null, ctx)); const b = enNombre(scalaire(args[1] ?? null, ctx)); const u = enTexte(scalaire(args[2] ?? "D", ctx)); if (estErreur(a)) return a; if (estErreur(b)) return b; if (estErreur(u)) return u; const da = dateDeSerie(a); const db = dateDeSerie(b); const mois = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + db.getUTCMonth() - da.getUTCMonth() - (db.getUTCDate() < da.getUTCDate() ? 1 : 0); switch (u.toUpperCase()) { case "D": return b - a; case "M": return mois; case "Y": return Math.floor(mois / 12); default: return ERR("#NUM!"); } },
  NETWORKDAYS: (args, ctx) => { const a = enNombre(scalaire(args[0] ?? null, ctx)); const b = enNombre(scalaire(args[1] ?? null, ctx)); if (estErreur(a)) return a; if (estErreur(b)) return b; let n = 0; for (let s = Math.min(a, b); s <= Math.max(a, b); s++) { const j = dateDeSerie(s).getUTCDay(); if (j !== 0 && j !== 6) n++; } return a <= b ? n : -n; },
  WEEKDAY: (args, ctx) => { const s = enNombre(scalaire(args[0] ?? null, ctx)); if (estErreur(s)) return s; return dateDeSerie(s).getUTCDay() + 1; },
  // ── Finance ──
  NPV: (args, ctx) => { const taux = enNombre(scalaire(args[0] ?? null, ctx)); if (estErreur(taux)) return taux; const flux = nombresDe(args.slice(1)); if (estErreur(flux)) return flux; return flux.reduce((a, f, i) => a + f / Math.pow(1 + taux, i + 1), 0); },
  VAN: (args, ctx) => FONCTIONS.NPV(args, ctx, []),
  IRR: (args) => { const flux = nombresDe([args[0]]); if (estErreur(flux)) return flux; let r = 0.1; for (let i = 0; i < 100; i++) { let f = 0; let df = 0; flux.forEach((c, t) => { f += c / Math.pow(1 + r, t); df -= (t * c) / Math.pow(1 + r, t + 1); }); if (Math.abs(df) < 1e-12) break; const nr = r - f / df; if (!Number.isFinite(nr)) return ERR("#NUM!"); if (Math.abs(nr - r) < 1e-10) return nr; r = nr; } return Number.isFinite(r) ? r : ERR("#NUM!"); },
  PMT: (args, ctx) => { const r = enNombre(scalaire(args[0] ?? null, ctx)); const n = enNombre(scalaire(args[1] ?? null, ctx)); const pv = enNombre(scalaire(args[2] ?? null, ctx)); const fv = enNombre(scalaire(args[3] ?? 0, ctx)); const type = enNombre(scalaire(args[4] ?? 0, ctx)); for (const x of [r, n, pv, fv, type]) if (estErreur(x)) return x; const R = r as number, N = n as number, PV = pv as number, FV = fv as number, T = type as number; if (R === 0) return -(PV + FV) / N; const q = Math.pow(1 + R, N); return -(R * (PV * q + FV)) / ((1 + R * T) * (q - 1)); },
  PV: (args, ctx) => { const r = enNombre(scalaire(args[0] ?? null, ctx)); const n = enNombre(scalaire(args[1] ?? null, ctx)); const p = enNombre(scalaire(args[2] ?? null, ctx)); const fv = enNombre(scalaire(args[3] ?? 0, ctx)); for (const x of [r, n, p, fv]) if (estErreur(x)) return x; const R = r as number, N = n as number, P = p as number, FV = fv as number; if (R === 0) return -(P * N + FV); const q = Math.pow(1 + R, N); return -(P * (q - 1) / R + FV) / q; },
  FV: (args, ctx) => { const r = enNombre(scalaire(args[0] ?? null, ctx)); const n = enNombre(scalaire(args[1] ?? null, ctx)); const p = enNombre(scalaire(args[2] ?? null, ctx)); const pv = enNombre(scalaire(args[3] ?? 0, ctx)); for (const x of [r, n, p, pv]) if (estErreur(x)) return x; const R = r as number, N = n as number, P = p as number, PV = pv as number; if (R === 0) return -(PV + P * N); const q = Math.pow(1 + R, N); return -(PV * q + P * (q - 1) / R); },
  N: (args, ctx) => { const v = scalaire(args[0] ?? null, ctx); return typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : estErreur(v) ? v : 0; },
  NA: () => ERR("#N/A"),
};

/**
 * LES NOMS FRANÇAIS — un classeur enregistré par un Excel français porte les formules en anglais
 * dans le fichier, mais une personne qui DICTE une formule à Adam dit « SOMME.SI », et le
 * décodeur doit la comprendre. Chaque alias renvoie à la fonction canonique ; la table n'est
 * consultée qu'en second, un nom anglais reste prioritaire.
 */
export const ALIAS_FR: Readonly<Record<string, string>> = {
  "SOMME.SI": "SUMIF", "SOMME.SI.ENS": "SUMIFS", "NB.SI": "COUNTIF", "NB.SI.ENS": "COUNTIFS", "MOYENNE.SI": "AVERAGEIF",
  "NB.VIDE": "COUNTBLANK", SOMMEPROD: "SUMPRODUCT", PRODUIT: "PRODUCT", MEDIANE: "MEDIAN", "GRANDE.VALEUR": "LARGE",
  "PETITE.VALEUR": "SMALL", ECARTYPE: "STDEV", "ECARTYPE.STANDARD": "STDEV.S", RANG: "RANK", "RANG.EGAL": "RANK",
  "SI.CONDITIONS": "IFS", "SI.NON.DISP": "IFNA", ESTERREUR: "ISERROR", ESTNUM: "ISNUMBER", ESTTEXTE: "ISTEXT", ESTVIDE: "ISBLANK",
  VRAI: "TRUE", NON: "NOT", PUISSANCE: "POWER", RACINE: "SQRT", ENT: "INT", "ARRONDI.SUP": "ROUNDUP", "ARRONDI.INF": "ROUNDDOWN",
  CONCATENER: "CONCATENATE", "JOINDRE.TEXTE": "TEXTJOIN", STXT: "MID", SUPPRESPACE: "TRIM", MAJUSCULE: "UPPER", MINUSCULE: "LOWER",
  NOMPROPRE: "PROPER", SUBSTITUE: "SUBSTITUTE", TROUVE: "FIND", CHERCHE: "SEARCH", TEXTE: "TEXT",
  RECHERCHEH: "HLOOKUP", RECHERCHEX: "XLOOKUP", CHOISIR: "CHOOSE", LIGNE: "ROW", COLONNE: "COLUMN", LIGNES: "ROWS", COLONNES: "COLUMNS",
  MAINTENANT: "NOW", "FIN.MOIS": "EOMONTH", "MOIS.DECALER": "EDATE", JOURS: "DAYS", "NB.JOURS.OUVRES": "NETWORKDAYS", JOURSEM: "WEEKDAY",
  TRI: "IRR", VPM: "PMT", VA: "PV", VC: "FV", ABS: "ABS", MIN: "MIN", MAX: "MAX", INDEX: "INDEX", DATE: "DATE", "SOMME": "SUM",
};

/** Le nom canonique d'une fonction, alias français compris. */
export const nomCanonique = (fn: string): string => (FONCTIONS[fn] ? fn : ALIAS_FR[fn] ?? fn);

function appeler(nomDit: string, bruts: Noeud[], ctx: ContexteEvaluation): Valeur {
  const fn = nomCanonique(nomDit);
  const f = FONCTIONS[fn];
  if (!f) { ctx.inconnues.add(nomDit); return ERR("#NAME?"); }
  // Les fonctions à évaluation PARESSEUSE (IF, IFERROR, CHOOSE…) reçoivent les arbres ; les autres, les valeurs.
  const paresseuse = fn === "IF" || fn === "SI" || fn === "IFS" || fn === "IFERROR" || fn === "SIERREUR" || fn === "IFNA" || fn === "CHOOSE";
  const args = paresseuse ? [] : bruts.map((b) => evaluer(b, ctx));
  if (paresseuse && (fn === "IF" || fn === "SI")) args.push(evaluer(bruts[0], ctx));
  if (paresseuse && fn === "CHOOSE") args.push(evaluer(bruts[0], ctx));
  return f(args, ctx, bruts);
}

/** TEXT(), pour les formats les plus courants des classeurs de gestion. Le reste rend la valeur en texte. */
function formaterTexte(v: Scalaire, fmt: string): string {
  if (typeof v !== "number") return String(enTexte(v));
  const f = fmt.trim();
  if (/^0+$/.test(f)) return String(Math.round(v)).padStart(f.length, "0");
  const dec = /^(#,##0|0)(\.0+)?(\s*%)?$/.exec(f);
  if (dec) {
    const pct = Boolean(dec[3]); const n = pct ? v * 100 : v; const d = dec[2] ? dec[2].length - 1 : 0;
    const s = n.toFixed(d);
    const [ent, frac] = s.split(".");
    const groupe = dec[1] === "#,##0" ? ent.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : ent;
    return `${groupe}${frac ? `.${frac}` : ""}${pct ? "%" : ""}`;
  }
  if (/^(dd|d)\/(mm|m)\/(yyyy|yy)$/i.test(f) || /^yyyy-mm-dd$/i.test(f)) {
    const d = dateDeSerie(v); const jj = String(d.getUTCDate()).padStart(2, "0"); const mm = String(d.getUTCMonth() + 1).padStart(2, "0"); const yyyy = String(d.getUTCFullYear());
    return /^yyyy/i.test(f) ? `${yyyy}-${mm}-${jj}` : `${jj}/${mm}/${/yyyy/i.test(f) ? yyyy : yyyy.slice(2)}`;
  }
  return formaterNombre(v);
}

// ── Le recalcul d'un classeur ─────────────────────────────────────────────────────────────

export interface Ecart {
  id: IdCellule;
  formule: string;
  affichee: Scalaire;
  recalculee: Scalaire;
}

export interface Recalcul {
  valeurs: Map<IdCellule, Scalaire>;
  /** Les cellules dont la valeur AFFICHÉE ne correspond pas à la formule recalculée. */
  ecarts: Ecart[];
  /** Les formules qui contiennent un cycle : non recalculées, valeur affichée conservée. */
  circulaires: IdCellule[];
  /** Les fonctions inconnues du moteur — l'audit les nomme, jamais tues. */
  fonctionsInconnues: string[];
  /**
   * Les formules SANS valeur enregistrée (fichier produit par un programme, ou enregistré sans
   * calcul) : on ne peut pas mesurer d'écart, on le dit au lieu de compter un faux écart.
   */
  nonCalculees: IdCellule[];
  /**
   * Les formules que le moteur ne sait pas vérifier (fonction inconnue) : leur valeur AFFICHÉE
   * est conservée pour leurs dépendantes — sinon un #NAME? de notre fait cascaderait en faux
   * écarts sur tout ce qui en découle.
   */
  nonVerifiees: IdCellule[];
  metriques: { formules: number; ms: number; ecarts: number; nonCalculees: number; nonVerifiees: number };
}

const memesValeurs = (a: Scalaire, b: Scalaire): boolean => {
  if (estErreur(a) || estErreur(b)) return estErreur(a) && estErreur(b) && a.code === b.code;
  if (a === null && (b === 0 || b === "" || b === false)) return true;
  if (b === null && (a === 0 || a === "" || a === false)) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === "number" && typeof b === "string") { const n = Number(b); return Number.isFinite(n) && Math.abs(a - n) <= 1e-9 * Math.max(1, Math.abs(a)); }
  if (typeof b === "number" && typeof a === "string") return memesValeurs(b, a);
  return a === b;
};

/**
 * RECALCULE toutes les formules dans l'ordre du graphe. Les écarts avec les valeurs affichées
 * sont rendus — c'est la mesure que l'audit relit (« classeur enregistré sans recalcul »).
 */
export function recalculer(classeur: Classeur, graphe: Graphe, opts: { maintenant?: Date; maxEcarts?: number } = {}): Recalcul {
  const debut = Date.now();
  const maintenant = opts.maintenant ?? new Date();
  const calculees = new Map<IdCellule, Scalaire>();
  const inconnues = new Set<string>();
  const ecarts: Ecart[] = [];
  const nonCalculees: IdCellule[] = [];
  const nonVerifiees: IdCellule[] = [];
  const maxEcarts = opts.maxEcarts ?? 500;
  const cache = new Map<string, Noeud | null>();
  const verifiable = new Map<string, boolean>();
  const feuilles = new Map(classeur.feuilles.map((f) => [f.index, f]));

  for (const id of graphe.ordre) {
    const n = graphe.noeuds.get(id)!;
    let arbre = cache.get(n.formule);
    if (arbre === undefined) { arbre = analyser(n.formule); cache.set(n.formule, arbre); }
    const feuille = feuilles.get(n.feuille)!;
    const cellule = feuille.cellules.get(cleDe(n.row, n.col))!;
    const affichee: Scalaire = cellule.t === "e" ? ERR(String(cellule.v)) : cellule.v;
    let ok = verifiable.get(n.formule);
    if (ok === undefined) {
      ok = Boolean(arbre) && [...fonctionsDe(arbre!)].every((fn) => FONCTIONS[nomCanonique(fn)]);
      if (arbre) for (const fn of fonctionsDe(arbre)) if (!FONCTIONS[nomCanonique(fn)]) inconnues.add(fn);
      verifiable.set(n.formule, ok);
    }
    if (!ok) {
      // Non vérifiable : la valeur affichée fait foi pour la suite du calcul.
      nonVerifiees.push(id);
      calculees.set(id, affichee);
      continue;
    }
    const ctx: ContexteEvaluation = { classeur, calculees, maintenant, feuilleCourante: n.feuille, origine: { row: n.row, col: n.col }, inconnues };
    const valeur = scalaire(evaluer(arbre!, ctx), ctx);
    calculees.set(id, valeur);
    if (affichee === null && valeur !== null && valeur !== 0 && valeur !== "" && valeur !== false) { nonCalculees.push(id); continue; }
    if (!memesValeurs(affichee, valeur) && ecarts.length < maxEcarts) ecarts.push({ id, formule: n.formule, affichee, recalculee: valeur });
  }
  return {
    valeurs: calculees, ecarts, circulaires: graphe.cycles.flat(), fonctionsInconnues: [...inconnues].sort(), nonCalculees, nonVerifiees,
    metriques: { formules: graphe.ordre.length, ms: Date.now() - debut, ecarts: ecarts.length, nonCalculees: nonCalculees.length, nonVerifiees: nonVerifiees.length },
  };
}

/** Évalue UNE formule hors classeur (tests, garde de seuil) : `=1+2` → 3. */
export function evaluerFormule(formule: string, classeur?: Classeur, opts: { feuille?: number; origine?: { row: number; col: number }; maintenant?: Date } = {}): Scalaire {
  const arbre = analyser(formule);
  if (!arbre) return ERR("#NAME?");
  const ctx: ContexteEvaluation = {
    classeur: classeur ?? { feuilles: [], noms: [], limites: [] }, calculees: new Map(), maintenant: opts.maintenant ?? new Date(),
    feuilleCourante: opts.feuille ?? 1, origine: opts.origine ?? { row: 1, col: 1 }, inconnues: new Set(),
  };
  return scalaire(evaluer(arbre, ctx), ctx);
}

export const FONCTIONS_CONNUES: ReadonlySet<string> = new Set([...Object.keys(FONCTIONS), ...Object.keys(ALIAS_FR)]);
