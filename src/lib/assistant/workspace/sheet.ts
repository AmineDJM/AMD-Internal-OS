import ExcelJS from "exceljs";
import { WORKSPACE_LIMITS, type WorkspaceColumn } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE UN CLASSEUR POUR LE MONTRER — pas pour le comprendre.
 *
 * « Montre le moi ici », dit d'un export Excel. La réponse de production était « je ne peux pas
 * afficher un fichier Excel » ; elle était fausse. Ce module fait la seule chose qui manquait :
 * transformer les octets d'un tableur en LIGNES affichables.
 *
 * ── CE QU'IL N'EST PAS ────────────────────────────────────────────────────────────────────
 *
 * Ce n'est pas un moteur de tableur. Il ne calcule rien, ne suit aucune référence entre
 * feuilles, ne lit que la PREMIÈRE feuille, et s'arrête à quelques dizaines de lignes. Un
 * aperçu sert à RELIRE avant d'envoyer, pas à consulter : au-delà, on ouvre le fichier.
 *
 * ── AUCUNE DÉPENDANCE À L'ERP ─────────────────────────────────────────────────────────────
 *
 * Volontaire : ce module est appelé depuis le pont (`src/platform/in-process/`), qui sert les
 * documents. Le garder sans base, sans session et sans droits en fait une fonction, pas une
 * porte — et la porte reste où elle doit être, c'est-à-dire devant le fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SheetPreview {
  columns: WorkspaceColumn[];
  rows: Record<string, string>[];
  /** Le nombre de lignes DU FICHIER — pas de l'aperçu. « 69 lignes » se dit, on en montre 30. */
  total: number;
}

const extOf = (name: string): string => (name.split(".").pop() ?? "").toLowerCase();

/** Une cellule ExcelJS peut être une date, une formule, un texte riche. On rend du TEXTE. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text?: string }[]; hyperlink?: string };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? "").join("");
    if (o.result !== undefined) return cellText(o.result);
    if (typeof o.text === "string") return o.text;
    if (typeof o.hyperlink === "string") return o.hyperlink;
    return "";
  }
  return String(v);
}

/**
 * LA PREMIÈRE LIGNE FAIT LES EN-TÊTES — convention de tous les exports de cet ERP, et de la
 * quasi-totalité des classeurs reçus. Quand elle manque, on NUMÉROTE les colonnes plutôt que de
 * refuser : un aperçu approximatif vaut mieux qu'un « format non lisible » qui ferme la porte.
 */
export function toSheet(matrix: string[][], totalRows?: number): SheetPreview | null {
  const clean = matrix.filter((r) => r.some((c) => c.trim().length > 0));
  if (clean.length < 2) return null;
  const head = clean[0];
  const width = Math.min(Math.max(...clean.map((r) => r.length)), 8);
  if (width === 0) return null;

  const columns: WorkspaceColumn[] = [];
  for (let i = 0; i < width; i += 1) {
    columns.push({ key: `c${i}`, label: (head[i] ?? "").trim() || `Colonne ${i + 1}` });
  }
  const body = clean.slice(1);
  const rows = body.slice(0, WORKSPACE_LIMITS.sheetRows).map((r) => {
    const line: Record<string, string> = {};
    for (let i = 0; i < width; i += 1) line[`c${i}`] = (r[i] ?? "").trim() || "—";
    return line;
  });
  // Une colonne entièrement numérique s'aligne à droite — le seul raffinement qui compte ici.
  for (let i = 0; i < width; i += 1) {
    const key = `c${i}`;
    columns[i].numeric = rows.every((r) => r[key] === "—" || /^-?[\d\s .,]+$/.test(r[key]));
  }
  // LE TOTAL EST CELUI DU FICHIER, PAS DE CE QU'ON A LU.
  //
  // La lecture s'arrête volontairement après quelques dizaines de lignes — inutile de charger
  // deux cents lignes pour en montrer trente. Mais rendre alors `body.length` ferait annoncer
  // « 70 lignes » d'un classeur qui en compte 200 : le PDG relirait un extrait en croyant tenir
  // le fichier entier, puis l'enverrait. `totalRows` porte donc le compte RÉEL quand l'appelant
  // le connaît.
  return { columns, rows, total: Math.max(totalRows ?? body.length, body.length) };
}

/** Le point-virgule est le séparateur des exports francophones aussi souvent que la virgule. */
export function parseCsv(text: string): SheetPreview | null {
  const lines = text.split(/\r?\n/).slice(0, WORKSPACE_LIMITS.sheetRows + 40);
  const first = lines[0] ?? "";
  const sep = first.split(";").length > first.split(",").length ? ";" : ",";
  // Le compte RÉEL se fait sur le texte entier, avant la troncature de lecture ci-dessus.
  const totalRows = Math.max(0, text.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1);
  return toSheet(lines.map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, ""))), totalRows);
}

/** La PREMIÈRE feuille d'un classeur. `null` si le format résiste — et on le dira à l'écran. */
export async function sheetPreview(name: string, bytes: Buffer): Promise<SheetPreview | null> {
  const e = extOf(name);
  try {
    if (e === "csv") return parseCsv(bytes.toString("utf8"));
    if (!["xlsx", "xlsm"].includes(e)) return null;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return null;
    const matrix: string[][] = [];
    let seen = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      seen += 1;
      if (matrix.length > WORKSPACE_LIMITS.sheetRows + 40) return;
      // `row.values` est décalé d'un cran (l'index 0 est vide chez ExcelJS).
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      matrix.push(values.map(cellText));
    });
    // `seen` compte TOUTES les lignes non vides, en-tête comprise — d'où le −1.
    return toSheet(matrix, Math.max(0, seen - 1));
  } catch {
    // Classeur protégé, corrompu, ou format ancien (.xls) : on n'invente pas son contenu.
    return null;
  }
}
