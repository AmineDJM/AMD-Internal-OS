import type { Ligne } from "@/platform/ia/analyse/analyse";
import { formatDe, libelleDe, mettreEnTable } from "@/platform/ia/analyse/bloc";
import { versCsv } from "@/platform/ia/analyse/affichage";
import { specClasseurAnalyse, nomDuClasseur } from "@/platform/ia/analyse/classeur";
import { construireClasseurOctets } from "@/platform/ia/artifact/sheets";
import { rendrePdfTableau } from "@/platform/ia/analyse/pdf";
import type { CelluleAnalyse, ColonneAnalyse } from "@/platform/ia/workspace/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXPORT D'UNE TABLE (lot K7, décision 0037 : « l'export de tout, quoi. Tout ce qu'on veut. »).
 *
 * Des lignes (un jeu de données du tour : ce qu'une lecture a rendu, ce qu'une analyse a calculé) → un FICHIER :
 *   • Excel — le classeur VÉRIFIÉ de K1 (`specClasseurAnalyse` : en-tête figé, filtres, formats DZD / % / dates,
 *     totaux en vraies formules recalculées avant livraison, feuille « Méthode ») ;
 *   • CSV — « ; » et BOM, lisible par Excel en français (`versCsv`, celui de l'écran) ;
 *   • PDF — un tableau mis en page (`rendrePdfTableau`).
 * Les lignes viennent du jeu, jamais du modèle ; les colonnes se choisissent par leur nom.
 *
 * Pur, sauf la vérification du classeur (le constructeur du socle) — ni base, ni droits : l'appelant a déjà jugé ce
 * que la personne peut voir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FORMATS_EXPORT = ["xlsx", "csv", "pdf"] as const;
export type FormatExport = (typeof FORMATS_EXPORT)[number];
export const COLONNES_EXPORT_MAX = 60;
export const LIGNES_EXPORT_MAX = 50_000;

const MIME: Record<FormatExport, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
};

export interface TableExport {
  titre: string;
  source: string;
  colonnes: ColonneAnalyse[];
  matrice: CelluleAnalyse[][];
  totaux: (number | null)[] | null;
  /** Les colonnes confidentielles dont une ou plusieurs valeurs n'ont pas été montrées. */
  masquees: string[];
}

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * LA TABLE D'UN JEU : les colonnes demandées (par leur nom ou leur libellé, accents et casse indifférents), sinon
 * toutes celles du jeu ; un nom qui ne désigne rien est refusé en le disant, jamais deviné.
 */
export function tableDuJeu(lignes: readonly Ligne[], d: { titre: string; source: string; colonnes?: readonly string[]; masquees?: readonly string[] }): { ok: true; table: TableExport } | { ok: false; erreur: string } {
  const disponibles = [...new Set(lignes.slice(0, 2_000).flatMap((l) => Object.keys(l)))];
  let cles = disponibles;
  if (d.colonnes?.length) {
    const inconnues: string[] = [];
    cles = [];
    for (const voulue of d.colonnes) {
      const p = plier(voulue);
      const c = disponibles.find((k) => k === voulue) ?? disponibles.find((k) => plier(k) === p || plier(libelleDe(k)) === p);
      if (c) { if (!cles.includes(c)) cles.push(c); } else inconnues.push(voulue);
    }
    if (inconnues.length) return { ok: false, erreur: `colonne(s) inconnue(s) : ${inconnues.join(", ")} — colonnes du jeu : ${disponibles.slice(0, 40).join(", ")}` };
  }
  if (!cles.length) return { ok: false, erreur: "le jeu n'a aucune colonne à exporter" };
  const garde = lignes.slice(0, LIGNES_EXPORT_MAX);
  const colonnes: ColonneAnalyse[] = cles.slice(0, COLONNES_EXPORT_MAX).map((cle) => ({ cle, libelle: libelleDe(cle), format: formatDe(cle, garde.slice(0, 2_000).map((l) => l[cle])) }));
  const { matrice, totaux } = mettreEnTable(garde, colonnes, 2_000);
  const masquees = (d.masquees ?? []).filter((m) => cles.includes(m));
  return { ok: true, table: { titre: d.titre, source: d.source, colonnes, matrice, totaux, masquees } };
}

/** Le FICHIER d'une table — octets, nom (titre + date), type. Un classeur dont la vérification échoue ne part pas. */
export async function fichierDeTable(t: TableExport, format: FormatExport, auteur: string, maintenant = new Date()): Promise<{ ok: true; octets: Buffer; nom: string; mime: string } | { ok: false; motif: string }> {
  const base = nomDuClasseur(t.titre, maintenant).replace(/\.xlsx$/, "");
  if (format === "csv") return { ok: true, octets: Buffer.from(versCsv(t.colonnes, t.matrice), "utf8"), nom: `${base}.csv`, mime: MIME.csv };
  if (format === "pdf") return { ok: true, octets: await rendrePdfTableau({ titre: t.titre, source: t.source, colonnes: t.colonnes, lignes: t.matrice, totaux: t.totaux, auteur, maintenant }), nom: `${base}.pdf`, mime: MIME.pdf };
  const spec = specClasseurAnalyse({
    title: t.titre, source: t.source, colonnes: t.colonnes, lignes: t.matrice, totaux: t.totaux, total: t.matrice.length, graphiques: [],
    journal: {
      sources: [t.source], etapes: [], resultats: [], ignores: [], refusees: [],
      masquees: t.masquees, moteur: "export des données lues dans la conversation (aucune valeur écrite par un modèle)", calculeLe: maintenant.toISOString(),
    },
  });
  const r = await construireClasseurOctets(spec, auteur);
  return r.ok ? { ok: true, octets: r.octets, nom: `${base}.xlsx`, mime: MIME.xlsx } : { ok: false, motif: r.motif };
}
