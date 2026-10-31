import ExcelJS from "exceljs";
import { lireClasseur } from "@/lib/artifact/sheets/reader";
import { construireGraphe, idDe } from "@/lib/artifact/sheets/graph";
import { recalculer, ErreurExcel, type Scalaire } from "@/lib/artifact/sheets/evaluate";
import { auditerClasseur, type Constat } from "@/lib/artifact/sheets/audit";
import { a1DeCoord, lettresDeColonne } from "@/lib/artifact/sheets/refs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONSTRUCTEUR DE CLASSEURS VÉRIFIÉS — un modèle livré est un modèle RECALCULÉ ET AUDITÉ.
 *
 * ── LE PROBLÈME QU'IL RÈGLE ─────────────────────────────────────────────────────────────
 *
 * Un classeur généré par un programme porte des formules SANS valeur : ExcelJS les écrit, et
 * c'est Excel qui les calculera à l'ouverture. Trois conséquences : un aperçu (Drive, mobile,
 * navigateur) montre des zéros ; personne n'a vérifié que les formules donnent le résultat
 * attendu ; et une erreur de plage (`SUM(D2:D40)` pour 45 lignes) part telle quelle chez le
 * client. Ici, on construit, on RELIT ce qu'on a construit avec le lecteur, on RECALCULE avec
 * notre moteur, on ÉCRIT les valeurs recalculées dans le fichier, et on AUDITE. Si l'audit
 * relève un constat critique ou haut, ou si une formule donne une erreur, `ok` est faux — et
 * un appelant honnête ne livre pas.
 *
 * ── LA SPÉCIFICATION, DÉCLARATIVE ───────────────────────────────────────────────────────
 *
 * Des colonnes avec une clé, des lignes de données, des formules écrites en termes de COLONNES
 * (`[qte]*[pu]`) et de PARAMÈTRES (`{TVA}`), des totaux. Le constructeur traduit en A1, pose les
 * noms définis, les formats, les largeurs. Le modèle ne manipule jamais d'adresse de cellule :
 * il ne peut donc pas se tromper d'une ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SpecColonne {
  cle: string;
  titre: string;
  /** Formule par ligne : `[qte]*[pu]`, `[ht]*(1+{TVA})`, `SI([qte]>10,[pu]*0.9,[pu])`. */
  formule?: string;
  /** Format Excel : `#,##0.00 "DZD"`, `0%`, `dd/mm/yyyy`. */
  format?: string;
  largeur?: number;
}

export interface SpecFeuille {
  nom: string;
  colonnes: SpecColonne[];
  lignes: Record<string, number | string | boolean | Date | null | undefined>[];
  /** Une ligne de totaux : clé de colonne → agrégat. */
  totaux?: Record<string, "SUM" | "AVERAGE" | "COUNT" | "MIN" | "MAX">;
  /** Libellé de la ligne de totaux, posé dans la première colonne (défaut : « Total »). */
  libelleTotal?: string;
  /** Figer la ligne d'en-tête (défaut : oui). */
  figerEntete?: boolean;
  /** K1 (décision 0031) : poser le filtre automatique d'Excel sur l'en-tête et les lignes (défaut : non). */
  filtre?: boolean;
}

export interface SpecParametre { nom: string; valeur: number | string; libelle?: string; format?: string }

export interface SpecClasseur {
  feuilles: SpecFeuille[];
  /** Les paramètres nommés — posés dans une feuille « Paramètres », référencés par `{Nom}`. */
  parametres?: SpecParametre[];
  /** Cellules libres supplémentaires : `{ feuille, ref, valeur | formule }` (synthèses, titres). */
  cellules?: { feuille: string; ref: string; valeur?: number | string; formule?: string; format?: string; gras?: boolean }[];
  auteur?: string;
}

export interface Verification {
  formules: number;
  ecarts: number;
  erreurs: { ref: string; formule: string; erreur: string }[];
  constats: Constat[];
  /** Vrai si on peut livrer : aucune erreur de formule, aucun constat critique ou haut. */
  ok: boolean;
}

export interface ClasseurConstruit {
  octets: Buffer;
  verification: Verification;
  /** Les valeurs recalculées, par `Feuille!A1` — pour le contrôle qualité d'une mission. */
  valeurs: Map<string, Scalaire>;
  ms: number;
}

const FEUILLE_PARAMS = "Paramètres";
const RE_COL = /\[([A-Za-z0-9_À-ſ]+)\]/g;
const RE_PARAM = /\{([A-Za-z0-9_À-ſ]+)\}/g;

function nomDefiniSur(nom: string): string {
  // Un nom défini Excel : lettres, chiffres, souligné ; pas de début par un chiffre ; jamais une adresse A1.
  const n = nom.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  return /^[A-Z]{1,3}\d+$/i.test(n) ? `P_${n}` : n;
}

/** Traduit `[cle]` en A1 de la ligne courante et `{Param}` en nom défini. Refuse une clé inconnue. */
export function traduireFormule(modele: string, colonnes: SpecColonne[], row: number, parametres: Set<string>): string {
  const index = new Map(colonnes.map((c, i) => [c.cle, i + 1]));
  let f = modele.trim().replace(/^=/, "");
  f = f.replace(RE_COL, (_, cle: string) => {
    const col = index.get(cle);
    if (!col) throw new Error(`formule « ${modele} » : colonne [${cle}] inconnue (colonnes : ${[...index.keys()].join(", ")})`);
    return a1DeCoord(row, col);
  });
  f = f.replace(RE_PARAM, (_, nom: string) => {
    if (!parametres.has(nom)) throw new Error(`formule « ${modele} » : paramètre {${nom}} inconnu`);
    return nomDefiniSur(nom);
  });
  return f;
}

/**
 * CONSTRUIT le classeur, le RELIT, le RECALCULE, y ÉCRIT les valeurs, l'AUDITE.
 * Deux sérialisations : la première pour lire ce qu'on a produit, la seconde avec les valeurs.
 */
export async function construireClasseurVerifie(spec: SpecClasseur, opts: { maintenant?: Date } = {}): Promise<ClasseurConstruit> {
  const debut = Date.now();
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.auteur ?? "Adam";
  wb.calcProperties.fullCalcOnLoad = true; // Excel recalcule à l'ouverture, quoi qu'il arrive.
  const parametres = new Set((spec.parametres ?? []).map((p) => p.nom));

  // Les paramètres d'abord : une feuille, un nom défini par ligne.
  if (spec.parametres && spec.parametres.length > 0) {
    const ws = wb.addWorksheet(FEUILLE_PARAMS);
    ws.columns = [{ header: "Paramètre", key: "libelle", width: 32 }, { header: "Valeur", key: "valeur", width: 18 }, { header: "Nom", key: "nom", width: 24 }];
    ws.getRow(1).font = { bold: true };
    spec.parametres.forEach((p, i) => {
      const row = ws.addRow([p.libelle ?? p.nom, p.valeur, nomDefiniSur(p.nom)]);
      if (p.format) row.getCell(2).numFmt = p.format;
      wb.definedNames.add(`'${FEUILLE_PARAMS}'!$B$${i + 2}`, nomDefiniSur(p.nom));
    });
  }

  const formulesPosees: { feuille: string; ref: string; formule: string }[] = [];
  for (const sf of spec.feuilles) {
    const ws = wb.addWorksheet(sf.nom);
    ws.columns = sf.colonnes.map((c) => ({ header: c.titre, key: c.cle, width: c.largeur ?? Math.max(12, Math.min(40, c.titre.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    if (sf.figerEntete !== false) ws.views = [{ state: "frozen", ySplit: 1 }];
    sf.lignes.forEach((ligne, i) => {
      const row = i + 2;
      const valeurs = sf.colonnes.map((c) => {
        if (c.formule) {
          const f = traduireFormule(c.formule, sf.colonnes, row, parametres);
          formulesPosees.push({ feuille: sf.nom, ref: a1DeCoord(row, sf.colonnes.indexOf(c) + 1), formule: f });
          return { formula: f } as ExcelJS.CellFormulaValue;
        }
        const v = ligne[c.cle];
        return v === undefined ? null : v;
      });
      const r = ws.addRow(valeurs);
      sf.colonnes.forEach((c, j) => { if (c.format) r.getCell(j + 1).numFmt = c.format; });
    });
    if (sf.filtre && sf.colonnes.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sf.lignes.length + 1), column: sf.colonnes.length } };
    if (sf.totaux && Object.keys(sf.totaux).length > 0) {
      const rowTotal = sf.lignes.length + 2;
      const r = ws.getRow(rowTotal);
      r.getCell(1).value = sf.libelleTotal ?? "Total";
      r.font = { bold: true };
      for (const [cle, agg] of Object.entries(sf.totaux)) {
        const j = sf.colonnes.findIndex((c) => c.cle === cle);
        if (j < 0) throw new Error(`totaux : colonne [${cle}] inconnue`);
        const lettre = lettresDeColonne(j + 1);
        const f = sf.lignes.length > 0 ? `${agg}(${lettre}2:${lettre}${rowTotal - 1})` : "0";
        r.getCell(j + 1).value = { formula: f } as ExcelJS.CellFormulaValue;
        if (sf.colonnes[j].format) r.getCell(j + 1).numFmt = sf.colonnes[j].format!;
        formulesPosees.push({ feuille: sf.nom, ref: a1DeCoord(rowTotal, j + 1), formule: f });
      }
    }
  }
  for (const c of spec.cellules ?? []) {
    const ws = wb.getWorksheet(c.feuille) ?? wb.addWorksheet(c.feuille);
    const cell = ws.getCell(c.ref);
    if (c.formule) {
      const f = c.formule.trim().replace(/^=/, "").replace(RE_PARAM, (_, nom: string) => nomDefiniSur(nom));
      cell.value = { formula: f } as ExcelJS.CellFormulaValue;
      formulesPosees.push({ feuille: c.feuille, ref: c.ref, formule: f });
    } else cell.value = c.valeur ?? null;
    if (c.format) cell.numFmt = c.format;
    if (c.gras) cell.font = { bold: true };
  }

  return figerEtVerifierClasseur(wb, formulesPosees.length, { maintenant: opts.maintenant, debut });
}

/**
 * RELIRE, RECALCULER, ÉCRIRE LES VALEURS, AUDITER — la seconde moitié du constructeur, partagée avec les pièces
 * qui posent leur mise en page elles-mêmes (le bon de commande sur Excel, `artifact/factory/xlsx.ts`) : un classeur
 * dont on a écrit les formules à la main passe par la MÊME relecture que celui qu'on a déclaré, sinon il partirait
 * avec des formules sans valeur et sans audit (§118.5, §118.59).
 */
export async function figerEtVerifierClasseur(
  wb: ExcelJS.Workbook, nbFormules: number, opts: { maintenant?: Date; debut?: number } = {},
): Promise<ClasseurConstruit> {
  const debut = opts.debut ?? Date.now();
  const premier = Buffer.from(await wb.xlsx.writeBuffer());
  const classeur = await lireClasseur(premier);
  const graphe = construireGraphe(classeur);
  const recalcul = recalculer(classeur, graphe, { maintenant: opts.maintenant });
  const valeurs = new Map<string, Scalaire>();
  const erreurs: Verification["erreurs"] = [];
  for (const [id, v] of recalcul.valeurs) {
    const n = graphe.noeuds.get(id);
    if (!n) continue;
    const feuille = classeur.feuilles.find((f) => f.index === n.feuille)!;
    const ref = `${feuille.nom}!${a1DeCoord(n.row, n.col)}`;
    valeurs.set(ref, v);
    if (v instanceof ErreurExcel) erreurs.push({ ref, formule: n.formule, erreur: v.code });
    const cell = wb.getWorksheet(feuille.nom)?.getCell(a1DeCoord(n.row, n.col));
    if (cell && cell.value && typeof cell.value === "object" && "formula" in (cell.value as object)) {
      const result = v instanceof ErreurExcel ? ({ error: v.code } as ExcelJS.CellErrorValue) : v === null ? undefined : v;
      cell.value = { formula: (cell.value as ExcelJS.CellFormulaValue).formula, result } as ExcelJS.CellFormulaValue;
    }
  }
  const octets = Buffer.from(await wb.xlsx.writeBuffer());
  // L'audit porte sur le fichier FINAL, celui qui part.
  const relu = await lireClasseur(octets);
  const grapheRelu = construireGraphe(relu);
  const recalculRelu = recalculer(relu, grapheRelu, { maintenant: opts.maintenant });
  const audit = auditerClasseur(relu, grapheRelu, recalculRelu);
  const constats = audit.constats.filter((c) => c.gravite === "CRITIQUE" || c.gravite === "HAUTE");
  void idDe;
  return {
    octets, valeurs, ms: Date.now() - debut,
    verification: { formules: nbFormules, ecarts: recalculRelu.ecarts.length, erreurs, constats, ok: erreurs.length === 0 && constats.length === 0 && recalculRelu.ecarts.length === 0 },
  };
}
