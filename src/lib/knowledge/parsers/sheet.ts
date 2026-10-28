import type { KnowledgeChunkDraft } from "../contract";
import { chunkTable, renumber } from "../chunk";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FEUILLES — §6 : un tableau se lit comme un TABLEAU, pas comme du texte à plat.
 *
 * ── CE QUE LE TEXTE À PLAT DÉTRUIT ───────────────────────────────────────────────────────
 *
 * `heavyText` rend déjà le contenu d'un xlsx sous forme de CSV concaténé. C'est suffisant pour
 * chercher un mot, et parfaitement inutile pour répondre à « quel est le prix du produit X ? » :
 * une fois aplati, « 4 500 » n'est plus le prix de rien — c'est un nombre au milieu d'autres.
 *
 * Ici, chaque ligne redevient une association `colonne: valeur`. La ligne 42 devient citable, et
 * un extrait de recherche porte enfin son sens : « Produit : Keytruda · Prix : 4 500 DZD ».
 *
 * ── L'EN-TÊTE N'EST PAS TOUJOURS LA PREMIÈRE LIGNE ───────────────────────────────────────
 *
 * Les feuilles réelles commencent souvent par un titre, une date, une ligne vide. On cherche donc
 * la première ligne qui RESSEMBLE à un en-tête — plusieurs cellules non vides, courtes, et
 * distinctes — au lieu de prendre la ligne 1 par convention et de baptiser les colonnes
 * « Rapport mensuel », « (vide) », « (vide) ».
 *
 * ── AUCUN MODÈLE ICI ─────────────────────────────────────────────────────────────────────
 *
 * Une grille de cellules est une donnée structurée : le code la comprend parfaitement. Demander
 * à un modèle « quelles sont les colonnes ? » serait payer pour lire une première ligne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, on n'indexe plus les lignes : le tableau est un export, pas un document. */
export const MAX_SHEET_ROWS = 2_000;

/** Lignes réellement ANALYSÉES par feuille : celles qu'on garde, la zone où l'on cherche l'en-tête, une marge de lignes vides. */
const LIGNES_ANALYSEES = MAX_SHEET_ROWS + 100;

/** Une feuille lue : son nom, ses colonnes, ses lignes. */
export interface SheetTable {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  /** Lignes réellement présentes, avant la borne — pour dire honnêtement ce qui n'est pas indexé. */
  totalRows: number;
}

/**
 * DÉCOUPE UNE LIGNE CSV. Écrite à la main plutôt qu'avec une expression régulière, parce que les
 * guillemets échappés (`""`) et les séparateurs À L'INTÉRIEUR d'un champ cité sont exactement ce
 * qu'une expression régulière rate — et un fichier d'adresses algériennes en est plein.
 */
export function parseCsvLine(line: string, sep = ";"): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } // guillemet échappé
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * LE SÉPARATEUR, DEVINÉ SUR LES PREMIÈRES LIGNES.
 *
 * Le point-virgule d'abord : c'est celui des tableurs francophones, où la virgule est le
 * séparateur DÉCIMAL. Deviner la virgule sur un fichier français couperait « 4,50 » en deux
 * colonnes, ce qui est pire que de ne rien lire — un prix faux se lit comme un prix.
 */
export function detectSeparator(sample: string): string {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (!lines.length) return ";";
  const score = (sep: string) => {
    const counts = lines.map((l) => parseCsvLine(l, sep).length);
    const first = counts[0];
    // Un bon séparateur donne le MÊME nombre de colonnes sur toutes les lignes. C'est un signal
    // bien plus fiable que « lequel apparaît le plus » — un texte plein de virgules le tromperait.
    const stable = counts.every((c) => c === first);
    return first > 1 && stable ? first : 0;
  };
  for (const sep of [";", "\t", ",", "|"]) if (score(sep) > 1) return sep;
  return ";";
}

/** Une cellule qui n'apporte rien — vide, ou marqueur de tableur. */
const emptyCell = (v: string): boolean => !v || v === "-" || v === "#N/A" || v === "null";

/**
 * LA LIGNE D'EN-TÊTE, cherchée et non supposée.
 *
 * Critères : au moins deux cellules non vides, toutes distinctes, et aucune trop longue (un
 * en-tête nomme une colonne, il ne raconte pas une phrase). On ne regarde que les premières
 * lignes : si l'en-tête est à la vingtième, le fichier n'est pas un tableau.
 */
export function findHeaderRow(grid: string[][], scan = 8): number {
  for (let i = 0; i < Math.min(scan, grid.length); i += 1) {
    const cells = grid[i].map((c) => (c ?? "").trim());
    const filled = cells.filter((c) => !emptyCell(c));
    if (filled.length < 2) continue;
    if (filled.some((c) => c.length > 80)) continue;
    if (new Set(filled.map((c) => c.toLowerCase())).size !== filled.length) continue;
    // Une ligne de DONNÉES majoritairement numérique n'est pas un en-tête, même si elle est nette.
    const numeric = filled.filter((c) => /^-?[\d  .,%]+$/.test(c)).length;
    if (numeric > filled.length / 2) continue;
    return i;
  }
  return -1;
}

/**
 * TRANSFORME UNE GRILLE EN TABLEAU NOMMÉ. Rend `null` quand rien ne ressemble à un tableau —
 * ce qui est une réponse, pas un échec : l'appelant se rabat alors sur le texte à plat.
 */
export function tableFromGrid(name: string, grid: string[][]): SheetTable | null {
  const headerAt = findHeaderRow(grid);
  if (headerAt < 0) return null;

  const raw = grid[headerAt].map((c) => (c ?? "").trim());
  // Les colonnes sans nom gardent une place : les retirer décalerait toutes les valeurs d'une
  // ligne, et associerait chaque donnée à la mauvaise colonne — l'erreur la plus coûteuse ici.
  const headers = raw.map((h, i) => (emptyCell(h) ? `col${i + 1}` : h));

  const rows: Record<string, string>[] = [];
  let total = 0;
  for (let i = headerAt + 1; i < grid.length; i += 1) {
    const cells = grid[i] ?? [];
    if (cells.every((c) => emptyCell((c ?? "").trim()))) continue;
    total += 1;
    if (rows.length >= MAX_SHEET_ROWS) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      const v = (cells[j] ?? "").trim();
      if (!emptyCell(v)) row[h] = v;
    });
    if (Object.keys(row).length) rows.push(row);
  }

  if (!rows.length) return null;
  return { name, headers, rows, totalRows: total };
}

/** Lit un CSV complet (déjà décodé) en un tableau nommé. */
export function parseCsv(text: string, name = "Feuille"): SheetTable | null {
  const sep = detectSeparator(text);
  const grid = text.split(/\r?\n/).filter((l) => l.length > 0).map((l) => parseCsvLine(l, sep));
  return tableFromGrid(name, grid);
}

/**
 * LIT UN CLASSEUR XLSX, FEUILLE PAR FEUILLE.
 *
 * L'import est PARESSEUX : `xlsx` est une grosse dépendance, et la charger au démarrage du
 * serveur pour un module que la plupart des requêtes n'utilisent jamais serait payer à chaque
 * démarrage pour une minorité de fichiers.
 */
export async function parseWorkbook(buffer: Buffer): Promise<SheetTable[]> {
  try {
    const XLSX = await import("xlsx");
    // On n'analyse que les lignes qui serviront (`MAX_SHEET_ROWS`, plus la marge où l'on cherche l'en-tête
    // et quelques lignes vides) : `XLSX.read` est SYNCHRONE et fige tout le processus web le temps de
    // l'analyse. Mesuré sur 100 000 lignes / 20 Mo : 2,7 s de gel sans borne, 0,16 s avec (audit
    // performance PERF-07). `!fullref` garde l'étendue réelle de la feuille pour compter ce qui est omis.
    const wb = XLSX.read(buffer, { type: "buffer", sheetRows: LIGNES_ANALYSEES });
    const out: SheetTable[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      // Lignes vides gardées ICI pour savoir à quelle ligne de la feuille correspond chacune ; on les retire
      // ensuite, comme le faisait `blankrows: false`.
      const brute = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true, raw: false, defval: "" });
      const premiere = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
      const lues = brute
        .map((r, i) => ({ ligne: premiere + i, cellules: Array.isArray(r) ? r.map((c) => String(c ?? "")) : [] }))
        .filter((r) => r.cellules.some((c) => c !== ""));
      const grid = lues.map((r) => r.cellules);
      const table = tableFromGrid(name, grid);
      if (!table) continue;
      // Feuille tronquée par la lecture : le total vient de l'étendue réelle (un MAJORANT — les lignes
      // vides au-delà de la fenêtre lue y comptent), à partir de la ligne qui suit l'en-tête.
      const etendue = typeof ws["!fullref"] === "string" ? XLSX.utils.decode_range(ws["!fullref"]) : null;
      if (etendue && etendue.e.r - etendue.s.r + 1 > LIGNES_ANALYSEES) {
        const enTete = lues[findHeaderRow(grid)]?.ligne ?? etendue.s.r;
        out.push({ ...table, totalRows: Math.max(table.totalRows, etendue.e.r - enTete) });
      } else out.push(table);
    }
    return out;
  } catch (err) {
    console.error("[knowledge] parseWorkbook failed", err);
    return [];
  }
}

/**
 * LES MORCEAUX D'UN CLASSEUR. Une feuille = un ou plusieurs morceaux, étiquetés par son NOM :
 * « Feuille Tarifs 2026 » est citable, « morceau 3 » ne l'est pas.
 */
export function chunksFromTables(tables: SheetTable[]): KnowledgeChunkDraft[] {
  const all: KnowledgeChunkDraft[] = [];
  for (const t of tables) {
    all.push(...chunkTable(t.rows, { label: `Feuille ${t.name}`, locator: t.name, maxRows: MAX_SHEET_ROWS }));
  }
  return renumber(all);
}

/**
 * LE TEXTE D'UN CLASSEUR — pour l'index lexical et l'aperçu.
 *
 * Il annonce ses colonnes en tête de feuille : c'est ce qui permet à une recherche sur « wilaya »
 * de trouver un fichier dont aucune CELLULE ne contient ce mot, mais dont une colonne s'appelle
 * ainsi. Le nom des colonnes est de l'information, pas de la présentation.
 */
export function tablesToText(tables: SheetTable[]): string {
  return tables
    .map((t) => {
      const head = `[Feuille ${t.name}] colonnes : ${t.headers.join(", ")}`;
      const body = t.rows
        .slice(0, MAX_SHEET_ROWS)
        .map((r) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(" · "))
        .join("\n");
      const omitted = t.totalRows > t.rows.length ? `\n(+${t.totalRows - t.rows.length} lignes non indexées)` : "";
      return `${head}\n${body}${omitted}`;
    })
    .join("\n\n");
}
