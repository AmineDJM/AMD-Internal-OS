import * as XLSX from "xlsx";
import type { Feuille } from "../domaine/commun";

/** Un classeur Excel → ses feuilles de lignes brutes (dates en objets Date). Serveur uniquement. */
export function lireClasseur(buffer: Buffer): Feuille[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  return wb.SheetNames.map((nom) => ({
    nom,
    lignes: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[nom]!, { header: 1, raw: true, defval: null, blankrows: false }),
  }));
}
