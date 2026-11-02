import { analyser, afficher, referencesDe, fonctionsDe, traduireFormulePartagee, FONCTIONS_VOLATILES, type Noeud } from "@/lib/artifact/sheets/formula";
import { a1DeCoord, cleDe, lettresDeColonne } from "@/lib/artifact/sheets/refs";
import type { Cellule, Classeur } from "@/lib/artifact/sheets/model";
import { celluleDeId, type Graphe } from "@/lib/artifact/sheets/graph";
import { ErreurExcel, FONCTIONS_CONNUES, nomCanonique, type Recalcul, type Scalaire } from "@/lib/artifact/sheets/evaluate";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'AUDIT D'UN CLASSEUR — ce qu'un contrôleur de gestion chevronné vérifie avant de signer.
 *
 * ── CE QU'ON CHERCHE, ET POURQUOI C'EST CELA ────────────────────────────────────────────
 *
 * Les modèles financiers ne se trompent presque jamais « dans la formule » : ils se trompent
 * AUTOUR. Une valeur tapée en dur au milieu d'une colonne de formules (le stagiaire a « corrigé »
 * le chiffre), une somme qui s'arrête à la ligne 40 alors qu'on a ajouté trois lignes en 41-43,
 * un taux de TVA écrit `*1.19` dans quatre-vingts cellules au lieu d'une référence, des nombres
 * stockés en texte que SOMME ignore en silence, un classeur enregistré sans recalcul dont les
 * valeurs affichées ne correspondent plus aux formules. Chaque constat ci-dessous est l'un de
 * ces défauts, nommé, localisé, avec sa PREUVE — jamais « le classeur semble incohérent ».
 *
 * ── CE QUI EST MESURÉ, ET CE QUI EST DÉDUIT ─────────────────────────────────────────────
 *
 * Un écart de recalcul est MESURÉ (la formule donne 100, la cellule affiche 999). Une formule
 * incohérente est DÉDUITE (elle diffère de ses voisines, ce qui est presque toujours une erreur,
 * et parfois voulu) : la gravité et le libellé le disent. L'audit n'invente pas de correction —
 * il dit où regarder, et propose quand la proposition est sûre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Gravite = "CRITIQUE" | "HAUTE" | "MOYENNE" | "BASSE";

export type CodeConstat =
  | "REFERENCE_CIRCULAIRE" | "FORMULE_ECRASEE" | "VALEUR_ERREUR" | "VALEUR_CACHEE_INCOHERENTE"
  | "PLAGE_TRONQUEE" | "FORMULE_INCOHERENTE" | "FEUILLE_INCONNUE" | "CONSTANTE_DANS_FORMULE"
  | "NOMBRE_EN_TEXTE" | "LIEN_EXTERNE" | "FONCTION_INCONNUE" | "FORMULE_ILLISIBLE"
  | "REFERENCE_VIDE" | "FONCTION_VOLATILE" | "FEUILLE_MASQUEE" | "NON_RECALCULE";

export const GRAVITE_DE: Record<CodeConstat, Gravite> = {
  REFERENCE_CIRCULAIRE: "CRITIQUE", FORMULE_ECRASEE: "CRITIQUE",
  VALEUR_ERREUR: "HAUTE", VALEUR_CACHEE_INCOHERENTE: "HAUTE", PLAGE_TRONQUEE: "HAUTE", FORMULE_INCOHERENTE: "HAUTE", FEUILLE_INCONNUE: "HAUTE",
  CONSTANTE_DANS_FORMULE: "MOYENNE", NOMBRE_EN_TEXTE: "MOYENNE", LIEN_EXTERNE: "MOYENNE", FONCTION_INCONNUE: "MOYENNE", FORMULE_ILLISIBLE: "MOYENNE", NON_RECALCULE: "MOYENNE",
  REFERENCE_VIDE: "BASSE", FONCTION_VOLATILE: "BASSE", FEUILLE_MASQUEE: "BASSE",
};

export const LIBELLE_CONSTAT: Record<CodeConstat, string> = {
  REFERENCE_CIRCULAIRE: "référence circulaire",
  FORMULE_ECRASEE: "formule écrasée par une valeur en dur",
  VALEUR_ERREUR: "cellule en erreur",
  VALEUR_CACHEE_INCOHERENTE: "valeur affichée différente du recalcul",
  PLAGE_TRONQUEE: "plage d'agrégat qui oublie des lignes",
  FORMULE_INCOHERENTE: "formule différente de ses voisines",
  FEUILLE_INCONNUE: "référence à une feuille absente",
  CONSTANTE_DANS_FORMULE: "constante codée en dur dans une formule",
  NOMBRE_EN_TEXTE: "nombre stocké en texte",
  LIEN_EXTERNE: "lien vers un classeur externe",
  FONCTION_INCONNUE: "fonction que le moteur ne sait pas vérifier",
  FORMULE_ILLISIBLE: "formule non analysable",
  REFERENCE_VIDE: "référence directe à une cellule vide",
  FONCTION_VOLATILE: "fonction volatile",
  FEUILLE_MASQUEE: "feuille masquée",
  NON_RECALCULE: "formules sans valeur enregistrée",
};

export interface Constat {
  code: CodeConstat;
  gravite: Gravite;
  feuille: string;
  /** A1 d'une cellule, ou une plage, ou « — » pour un constat de feuille. */
  cellule: string;
  message: string;
  /** Ce qu'on a VU : la formule, la valeur, les voisines. */
  preuve: string;
  suggestion?: string;
}

export interface Audit {
  /** Les constats, triés par gravité puis par position ; plafonnés PAR CODE (`maxParCode`). */
  constats: Constat[];
  /** Le nombre RÉEL par code, avant plafonnement. */
  parCode: Partial<Record<CodeConstat, number>>;
  parGravite: Record<Gravite, number>;
  total: number;
  metriques: { feuilles: number; cellules: number; formules: number; ms: number };
  limites: string[];
}

const ORDRE_GRAVITE: Record<Gravite, number> = { CRITIQUE: 0, HAUTE: 1, MOYENNE: 2, BASSE: 3 };
const AGREGATS = new Set(["SUM", "AVERAGE", "COUNT", "COUNTA", "MIN", "MAX", "MEDIAN", "PRODUCT", "SUMPRODUCT", "STDEV", "STDEV.S", "VAR", "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGEIF"]);
const RE_NOMBRE_TEXTE = /^\s*[-+]?\d{1,3}(?:[  ]?\d{3})*(?:[.,]\d+)?\s*%?\s*$|^\s*[-+]?\d+(?:[.,]\d+)?\s*%?\s*$/;

const texteDe = (v: Scalaire | Cellule["v"]): string => {
  if (v instanceof ErreurExcel) return v.code;
  if (v === null || v === undefined) return "(vide)";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  return typeof v === "string" ? `« ${v.length > 40 ? `${v.slice(0, 40)}…` : v} »` : String(v);
};

class Collecteur {
  readonly constats: Constat[] = [];
  readonly parCode: Partial<Record<CodeConstat, number>> = {};
  private readonly vus = new Set<string>();
  constructor(private readonly maxParCode: number) {}
  ajouter(c: Omit<Constat, "gravite">): void {
    const cle = `${c.code}|${c.feuille}|${c.cellule}`;
    if (this.vus.has(cle)) return;
    this.vus.add(cle);
    const n = (this.parCode[c.code] ?? 0) + 1;
    this.parCode[c.code] = n;
    if (n <= this.maxParCode) this.constats.push({ ...c, gravite: GRAVITE_DE[c.code] });
  }
}

/** Les littéraux « métier » d'une formule : un taux, un montant — pas un rang d'INDEX ni un nombre de décimales. */
function constantesSuspectes(n: Noeud, out: number[] = [], dansArithmetique = false): number[] {
  switch (n.k) {
    case "num":
      if (dansArithmetique && (!Number.isInteger(n.v) || Math.abs(n.v) >= 1000) && n.v !== 0) out.push(n.v);
      break;
    case "pct": if (n.a.k === "num") out.push(n.a.v / 100); else constantesSuspectes(n.a, out, true); break;
    case "bin": {
      const arith = n.op === "*" || n.op === "/" || n.op === "+" || n.op === "-" || n.op === "^";
      constantesSuspectes(n.g, out, arith); constantesSuspectes(n.d, out, arith); break;
    }
    case "un": constantesSuspectes(n.a, out, dansArithmetique); break;
    case "call": for (const a of n.args) constantesSuspectes(a, out, false); break;
    case "array": for (const l of n.lignes) for (const x of l) constantesSuspectes(x, out, false); break;
    default: break;
  }
  return out;
}

/** Les plages d'agrégat (SUM(D2:D40)…) d'une formule, avec la fonction qui les lit. */
function plagesAgregees(n: Noeud, out: { fn: string; ref: Noeud & { k: "ref" } }[] = []): typeof out {
  if (n.k === "call") {
    const fn = nomCanonique(n.fn);
    for (const a of n.args) {
      if (a.k === "ref" && a.ref.type === "range" && AGREGATS.has(fn)) out.push({ fn, ref: a });
      else plagesAgregees(a, out);
    }
  } else if (n.k === "bin") { plagesAgregees(n.g, out); plagesAgregees(n.d, out); }
  else if (n.k === "un") plagesAgregees(n.a, out);
  else if (n.k === "pct") plagesAgregees(n.a, out);
  return out;
}

const estNombreConstant = (c: Cellule | undefined): boolean => Boolean(c && !c.f && c.t === "n" && typeof c.v === "number");
const estFormule = (c: Cellule | undefined): boolean => Boolean(c && c.f);

/**
 * AUDITE un classeur lu par `lireClasseur`, avec son graphe et — si on l'a — son recalcul.
 * Pur et synchrone : cent mille cellules en quelques centaines de millisecondes.
 */
export function auditerClasseur(classeur: Classeur, graphe: Graphe, recalcul?: Recalcul | null, opts: { maxParCode?: number } = {}): Audit {
  const debut = Date.now();
  const col = new Collecteur(opts.maxParCode ?? 50);
  const limites: string[] = [...classeur.limites];
  const feuilles = new Map(classeur.feuilles.map((f) => [f.index, f]));
  const arbres = new Map<string, Noeud | null>();
  const arbreDe = (f: string): Noeud | null => {
    let a = arbres.get(f);
    if (a === undefined) { a = analyser(f); arbres.set(f, a); }
    return a;
  };
  let cellules = 0;
  let formules = 0;

  // ── Les constats transverses : cycles, écarts de recalcul, fonctions inconnues ─────────
  for (const cycle of graphe.cycles) {
    const noms = cycle.map((id) => { const { feuille, row, col: c } = celluleDeId(id); return `${feuilles.get(feuille)?.nom ?? feuille}!${a1DeCoord(row, c)}`; });
    const premiere = celluleDeId(cycle[0]);
    col.ajouter({
      code: "REFERENCE_CIRCULAIRE", feuille: feuilles.get(premiere.feuille)?.nom ?? String(premiere.feuille), cellule: a1DeCoord(premiere.row, premiere.col),
      message: `${cycle.length} cellule(s) se calculent l'une à partir de l'autre`,
      preuve: noms.slice(0, 8).join(" → ") + (noms.length > 8 ? " → …" : ""),
      suggestion: "Casser la boucle : l'une des cellules doit lire une valeur, pas une formule qui dépend d'elle.",
    });
  }
  if (recalcul) {
    for (const e of recalcul.ecarts) {
      const { feuille, row, col: c } = celluleDeId(e.id);
      col.ajouter({
        code: "VALEUR_CACHEE_INCOHERENTE", feuille: feuilles.get(feuille)?.nom ?? String(feuille), cellule: a1DeCoord(row, c),
        message: `affiche ${texteDe(e.affichee)}, la formule donne ${texteDe(e.recalculee)}`,
        preuve: `=${e.formule}`,
        suggestion: "Classeur enregistré sans recalcul, ou valeur collée par-dessus : rouvrir, recalculer (F9), ré-enregistrer.",
      });
    }
    for (const fn of recalcul.fonctionsInconnues) {
      col.ajouter({ code: "FONCTION_INCONNUE", feuille: "—", cellule: "—", message: `${fn}() n'est pas vérifiée par le recalcul : ses résultats sont pris tels qu'affichés (${recalcul.nonVerifiees.length} formule(s))`, preuve: fn });
    }
    if (recalcul.nonCalculees.length > 0) {
      const { feuille, row, col: c } = celluleDeId(recalcul.nonCalculees[0]);
      col.ajouter({
        code: "NON_RECALCULE", feuille: feuilles.get(feuille)?.nom ?? String(feuille), cellule: a1DeCoord(row, c),
        message: `${recalcul.nonCalculees.length} formule(s) sans valeur enregistrée : le fichier a été produit par un programme ou enregistré sans calcul — Excel les calculera à l'ouverture, l'audit ne peut pas comparer`,
        preuve: `première : ${a1DeCoord(row, c)}`,
      });
    }
  }
  for (const n of graphe.noeuds.values()) {
    const feuille = feuilles.get(n.feuille);
    if (!feuille) continue;
    if (n.illisible) col.ajouter({ code: "FORMULE_ILLISIBLE", feuille: feuille.nom, cellule: a1DeCoord(n.row, n.col), message: "formule non analysée : ni précédents, ni recalcul", preuve: `=${n.formule}` });
    for (const inconnue of n.feuillesInconnues) {
      col.ajouter({ code: "FEUILLE_INCONNUE", feuille: feuille.nom, cellule: a1DeCoord(n.row, n.col), message: `lit la feuille « ${inconnue} », qui n'existe pas dans le classeur`, preuve: `=${n.formule}`, suggestion: "Feuille renommée ou supprimée : la formule affiche #REF!." });
    }
  }

  // ── Les passes par feuille ────────────────────────────────────────────────────────────
  for (const feuille of classeur.feuilles) {
    cellules += feuille.cellules.size;
    if (feuille.masquee && feuille.cellules.size > 0) {
      col.ajouter({ code: "FEUILLE_MASQUEE", feuille: feuille.nom, cellule: "—", message: `feuille masquée, ${feuille.cellules.size} cellule(s) — des hypothèses peuvent s'y cacher`, preuve: feuille.nom });
    }
    const parColonne = new Map<number, Cellule[]>();
    const parLigne = new Map<number, Cellule[]>();
    const r1c1De = (c: Cellule): string | null => {
      if (!c.f) return null;
      const a = arbreDe(c.f);
      return a ? afficher(a, { row: c.row, col: c.col }) : null;
    };
    const estAgregat = (c: Cellule): boolean => {
      const a = c.f ? arbreDe(c.f) : null;
      return Boolean(a) && [...fonctionsDe(a!)].some((fn) => AGREGATS.has(nomCanonique(fn)));
    };
    const nombresParColonne = new Map<number, number>();
    const volatiles: string[] = [];
    let externes = 0;

    for (const c of feuille.cellules.values()) {
      (parColonne.get(c.col) ?? parColonne.set(c.col, []).get(c.col)!).push(c);
      (parLigne.get(c.row) ?? parLigne.set(c.row, []).get(c.row)!).push(c);
      if (c.t === "n" && !c.f) nombresParColonne.set(c.col, (nombresParColonne.get(c.col) ?? 0) + 1);
      if (c.t === "e") {
        col.ajouter({ code: "VALEUR_ERREUR", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col), message: `affiche ${String(c.v)}`, preuve: c.f ? `=${c.f}` : String(c.v) });
      }
      if (!c.f) continue;
      formules += 1;
      const arbre = arbreDe(c.f);
      if (!arbre) continue;
      const constantes = constantesSuspectes(arbre);
      if (constantes.length > 0) {
        col.ajouter({
          code: "CONSTANTE_DANS_FORMULE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col),
          message: `constante(s) ${constantes.slice(0, 3).map((x) => texteDe(x)).join(", ")} codée(s) dans la formule`, preuve: `=${c.f}`,
          suggestion: "Mettre la valeur dans une cellule de paramètres nommée, et la référencer : un taux modifié en un seul endroit.",
        });
      }
      for (const fn of fonctionsDe(arbre)) {
        const canon = nomCanonique(fn);
        if (FONCTIONS_VOLATILES.has(canon)) volatiles.push(a1DeCoord(c.row, c.col));
        if (!FONCTIONS_CONNUES.has(canon) && !recalcul) col.ajouter({ code: "FONCTION_INCONNUE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col), message: `${fn}() n'est pas vérifiée par le moteur`, preuve: `=${c.f}` });
      }
      for (const r of referencesDe(arbre)) {
        if (r.externe) { externes += 1; col.ajouter({ code: "LIEN_EXTERNE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col), message: "lit un autre classeur : valeur figée si le lien est rompu", preuve: `=${c.f}` }); continue; }
        if (r.type !== "cell") continue;
        const cible = r.feuille === null ? feuille : classeur.feuilles.find((x) => x.nom.toLowerCase() === r.feuille!.toLowerCase());
        if (!cible) continue;
        const cc = cible.cellules.get(cleDe(r.r1, r.c1));
        // Une formule sans valeur enregistrée n'est pas une cellule vide : elle sera calculée.
        if (!cc || (cc.t === "vide" && !cc.f)) {
          col.ajouter({ code: "REFERENCE_VIDE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col), message: `lit ${r.feuille ? `${r.feuille}!` : ""}${a1DeCoord(r.r1, r.c1)}, qui est vide`, preuve: `=${c.f}` });
        }
      }
      // PLAGE_TRONQUEE : SUM(D2:D40) alors que D41 porte un nombre saisi.
      for (const { fn, ref } of plagesAgregees(arbre)) {
        const cible = ref.ref.feuille === null ? feuille : classeur.feuilles.find((x) => x.nom.toLowerCase() === ref.ref.feuille!.toLowerCase());
        if (!cible) continue;
        const { r1, c1, r2, c2 } = ref.ref;
        if (r2 >= cible.lignes && c2 >= cible.colonnes) continue;
        const oublies: string[] = [];
        // La cellule juste après la plage CONTINUE-t-elle la série ? Oui si c'est un nombre saisi,
        // ou une formule du MÊME motif que la dernière cellule de la plage (la ligne ajoutée a été
        // recopiée). Non si c'est une formule d'un autre motif : une ligne de total, pas une donnée.
        const continueLaSerie = (suivante: Cellule | undefined, derniere: Cellule | undefined): boolean => {
          if (!suivante || !derniere || derniere.t === "vide") return false;
          if (estNombreConstant(suivante)) return true;
          if (!suivante.f || suivante.t !== "n") return false;
          return Boolean(derniere.f) && r1c1De(suivante) === r1c1De(derniere);
        };
        // Sous la plage : la ligne r2+1, colonnes c1..c2, hors la cellule de la formule elle-même.
        if (r2 < cible.lignes && r2 - r1 >= 1) {
          for (let cc = c1; cc <= Math.min(c2, c1 + 50); cc++) {
            const estLaFormule = cible === feuille && r2 + 1 === c.row && cc === c.col;
            if (!estLaFormule && continueLaSerie(cible.cellules.get(cleDe(r2 + 1, cc)), cible.cellules.get(cleDe(r2, cc)))) oublies.push(a1DeCoord(r2 + 1, cc));
          }
        }
        // À droite de la plage : la colonne c2+1, lignes r1..r2 (séries en ligne).
        if (oublies.length === 0 && c2 < cible.colonnes && c2 - c1 >= 1 && r2 - r1 <= 1) {
          for (let rr = r1; rr <= Math.min(r2, r1 + 50); rr++) {
            const estLaFormule = cible === feuille && rr === c.row && c2 + 1 === c.col;
            if (!estLaFormule && continueLaSerie(cible.cellules.get(cleDe(rr, c2 + 1)), cible.cellules.get(cleDe(rr, c2)))) oublies.push(a1DeCoord(rr, c2 + 1));
          }
        }
        if (oublies.length > 0) {
          col.ajouter({
            code: "PLAGE_TRONQUEE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col),
            message: `${fn}(${ref.ref.feuille ? `${ref.ref.feuille}!` : ""}${a1DeCoord(r1, c1)}:${a1DeCoord(r2, c2)}) s'arrête juste avant ${oublies.slice(0, 3).join(", ")}, qui contien${oublies.length > 1 ? "nent" : "t"} un nombre saisi`,
            preuve: `=${c.f}`,
            suggestion: `Étendre la plage jusqu'à la dernière ligne saisie, ou la définir comme un tableau structuré qui grandit tout seul.`,
          });
        }
      }
    }
    if (volatiles.length > 0) {
      col.ajouter({ code: "FONCTION_VOLATILE", feuille: feuille.nom, cellule: volatiles.length === 1 ? volatiles[0] : `${volatiles[0]} (+${volatiles.length - 1})`, message: `${volatiles.length} formule(s) volatile(s) (AUJOURDHUI, MAINTENANT, ALEA, DECALER, INDIRECT) : le classeur change à chaque ouverture`, preuve: volatiles.slice(0, 5).join(", ") });
    }
    void externes;

    // NOMBRE_EN_TEXTE : « 3 » dans une colonne de nombres.
    for (const [cc, cells] of parColonne) {
      if ((nombresParColonne.get(cc) ?? 0) < 2) continue;
      for (const c of cells) {
        if (c.f || c.t !== "s" || typeof c.v !== "string" || !RE_NOMBRE_TEXTE.test(c.v)) continue;
        col.ajouter({ code: "NOMBRE_EN_TEXTE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col), message: `${texteDe(c.v)} est du texte : SOMME, MOYENNE et NB l'ignorent`, preuve: `colonne ${lettresDeColonne(cc)} : ${nombresParColonne.get(cc)} nombre(s)`, suggestion: "Convertir en nombre (Données → Convertir), ou corriger la source." });
      }
    }

    // FORMULE_INCOHERENTE / FORMULE_ECRASEE : les séries, en colonne puis en ligne.
    //
    // UNE CELLULE N'EST INCOHÉRENTE QUE SI ELLE L'EST DANS LES DEUX SENS. La colonne « Marge % »
    // d'une ligne de totaux diffère de ses voisines HORIZONTALES (des SOMMES) : c'est normal, elle
    // suit sa COLONNE (des ratios). On ne la signale que si elle ne suit ni sa ligne, ni sa
    // colonne. Le même motif jugé sur un seul axe produisait un faux positif par feuille.
    interface Deviation { cellule: Cellule; axe: "colonne" | "ligne"; n: number; attendue: string }
    const coherentes = { colonne: new Set<number>(), ligne: new Set<number>() };
    const deviations: Deviation[] = [];
    const examinerSerie = (cells: Cellule[], axe: "colonne" | "ligne") => {
      const pos = (c: Cellule) => (axe === "colonne" ? c.row : c.col);
      cells.sort((a, b) => pos(a) - pos(b));
      // Découpage en tronçons CONTIGUS de formules et nombres.
      let troncon: Cellule[] = [];
      const troncons: Cellule[][] = [];
      for (const c of cells) {
        const ok = estFormule(c) || estNombreConstant(c);
        if (ok && (troncon.length === 0 || pos(c) === pos(troncon[troncon.length - 1]) + 1)) troncon.push(c);
        else { if (troncon.length >= 3) troncons.push(troncon); troncon = ok ? [c] : []; }
      }
      if (troncon.length >= 3) troncons.push(troncon);
      for (const t of troncons) {
        const motifs = t.map((c) => (estFormule(c) ? r1c1De(c) : null));
        const compte = new Map<string, number>();
        for (const m of motifs) if (m) compte.set(m, (compte.get(m) ?? 0) + 1);
        if (compte.size === 0) continue;
        const [dominant, n] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0];
        const nbFormules = motifs.filter(Boolean).length;
        if (n < 2 || n / nbFormules < 0.6) continue; // pas de motif dominant : rien à comparer
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          const prec = motifs[i - 1]; const suiv = motifs[i + 1];
          if (estNombreConstant(c)) {
            // Une valeur en dur ENTRE deux formules d'une série qui a un motif : le cas le plus grave.
            if (prec && suiv && (prec === dominant || suiv === dominant)) {
              col.ajouter({
                code: "FORMULE_ECRASEE", feuille: feuille.nom, cellule: a1DeCoord(c.row, c.col),
                message: `${texteDe(c.v)} est saisi en dur au milieu d'une ${axe} de formules`,
                preuve: `${a1DeCoord(t[i - 1].row, t[i - 1].col)} et ${a1DeCoord(t[i + 1].row, t[i + 1].col)} : =${t[i - 1].f}`,
                suggestion: `Remettre la formule des voisines (=${formuleAttendue(t, motifs, dominant, c)}) et vérifier pourquoi la valeur a été forcée.`,
              });
            }
          } else if (motifs[i] === dominant) {
            coherentes[axe].add(cleDe(c.row, c.col));
          } else if (motifs[i] && nbFormules >= 3 && !((i === 0 || i === t.length - 1) && estAgregat(c))) {
            // Un agrégat en BORD de série (la ligne de total sous la colonne) est normal : on ne le
            // compare pas aux formules qu'il additionne.
            deviations.push({ cellule: c, axe, n, attendue: formuleAttendue(t, motifs, dominant, c) });
          }
        }
      }
    };
    for (const cells of parColonne.values()) examinerSerie(cells, "colonne");
    for (const cells of parLigne.values()) examinerSerie(cells, "ligne");
    for (const d of deviations) {
      const autreAxe = d.axe === "colonne" ? "ligne" : "colonne";
      if (coherentes[autreAxe].has(cleDe(d.cellule.row, d.cellule.col))) continue; // elle suit l'autre axe
      col.ajouter({
        code: "FORMULE_INCOHERENTE", feuille: feuille.nom, cellule: a1DeCoord(d.cellule.row, d.cellule.col),
        message: `diffère des ${d.n} formules voisines de la ${d.axe}`,
        preuve: `ici =${d.cellule.f} ; voisines =${d.attendue}`,
        suggestion: "Vérifier si l'exception est voulue ; sinon recopier la formule voisine.",
      });
    }
  }

  const constats = col.constats.sort((a, b) => ORDRE_GRAVITE[a.gravite] - ORDRE_GRAVITE[b.gravite] || a.feuille.localeCompare(b.feuille) || a.cellule.localeCompare(b.cellule, undefined, { numeric: true }));
  const parGravite: Record<Gravite, number> = { CRITIQUE: 0, HAUTE: 0, MOYENNE: 0, BASSE: 0 };
  let total = 0;
  for (const [code, n] of Object.entries(col.parCode) as [CodeConstat, number][]) { parGravite[GRAVITE_DE[code]] += n; total += n; }
  return {
    constats, parCode: col.parCode, parGravite, total,
    metriques: { feuilles: classeur.feuilles.length, cellules, formules, ms: Date.now() - debut }, limites,
  };
}

/** La formule qu'aurait la cellule si elle suivait le motif dominant : celle d'une voisine, décalée. */
function formuleAttendue(troncon: Cellule[], motifs: (string | null)[], dominant: string, c: Cellule): string {
  const j = motifs.findIndex((m) => m === dominant);
  if (j < 0 || !troncon[j].f) return dominant;
  return traduireFormulePartagee(troncon[j].f!, { row: troncon[j].row, col: troncon[j].col }, { row: c.row, col: c.col }) ?? dominant;
}

/** Un résumé exécutif en une phrase — ce qu'Adam dit d'abord. */
export function resumerAudit(a: Audit): string {
  if (a.total === 0) return `Aucun défaut relevé sur ${a.metriques.formules} formule(s) et ${a.metriques.cellules} cellule(s).`;
  const parts: string[] = [];
  for (const g of ["CRITIQUE", "HAUTE", "MOYENNE", "BASSE"] as Gravite[]) if (a.parGravite[g] > 0) parts.push(`${a.parGravite[g]} ${g.toLowerCase()}${a.parGravite[g] > 1 && g !== "BASSE" ? "s" : ""}`);
  const codes = (Object.entries(a.parCode) as [CodeConstat, number][]).sort((x, y) => ORDRE_GRAVITE[GRAVITE_DE[x[0]]] - ORDRE_GRAVITE[GRAVITE_DE[y[0]]] || y[1] - x[1]).slice(0, 4)
    .map(([code, n]) => `${n} ${LIBELLE_CONSTAT[code]}${n > 1 ? "s" : ""}`);
  return `${a.total} constat(s) — ${parts.join(", ")} : ${codes.join(" ; ")}.`;
}
