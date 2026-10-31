import {
  ANALYSE_COLONNES_MAX, ANALYSE_GRAPHIQUES_MAX, ANALYSE_LIGNES_MAX, FORMATS_COLONNE,
  type BlocAnalyseForme, type CelluleAnalyse, type FormatColonne, type GraphiqueAnalyse,
} from "@/platform/ia/workspace/analyse";
import { isVizType, lireDonnees } from "@/platform/ia/workspace/viz-block";

/**
 * RELIRE UN BLOC D'ANALYSE REÇU DE L'ÉCRAN (lot K1, décision 0031) — pour l'export Excel d'un clic.
 *
 * L'écran renvoie les lignes qu'il montre (filtrées) avec les colonnes, le journal et les graphiques. Rien de cela
 * n'est cru : chaque champ est borné et typé ici ; une cellule est un nombre fini, un texte borné ou rien. Les
 * TOTAUX ne sont pas relus — le classeur les recalcule par ses formules. Pur.
 */
type Lu = Pick<BlocAnalyseForme, "title" | "source" | "colonnes" | "lignes" | "totaux" | "graphiques" | "journal" | "total">;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const strs = (v: unknown, n: number, max = 400): string[] => (Array.isArray(v) ? v.slice(0, n).map((x) => str(x, max)).filter(Boolean) : []);
const cellule = (v: unknown): CelluleAnalyse => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? v.slice(0, 400) : null);

export function lireBlocAnalyse(v: unknown): Lu | null {
  if (!isObj(v)) return null;
  const colonnes = (Array.isArray(v.colonnes) ? v.colonnes : []).filter(isObj).slice(0, ANALYSE_COLONNES_MAX).map((c, j) => ({
    cle: str(c.cle, 80) || `c${j + 1}`, libelle: str(c.libelle, 80) || `Colonne ${j + 1}`,
    format: ((FORMATS_COLONNE as readonly string[]).includes(String(c.format)) ? c.format : "texte") as FormatColonne,
  }));
  if (!colonnes.length) return null;
  const lignes = (Array.isArray(v.lignes) ? v.lignes : []).slice(0, ANALYSE_LIGNES_MAX * 5).filter(Array.isArray).map((r) => colonnes.map((_, j) => cellule((r as unknown[])[j])));
  const graphiques: GraphiqueAnalyse[] = (Array.isArray(v.graphiques) ? v.graphiques : []).filter(isObj).slice(0, ANALYSE_GRAPHIQUES_MAX).flatMap((g) => {
    if (!isVizType(g.type)) return [];
    const donnees = lireDonnees(g.type, g.donnees as Parameters<typeof lireDonnees>[1]);
    return donnees ? [{ titre: str(g.titre, 120) || "Graphique", type: g.type, donnees, unite: str(g.unite, 10) || null, raison: str(g.raison, 300) || null, alertes: strs(g.alertes, 8) }] : [];
  });
  const j = isObj(v.journal) ? v.journal : {};
  const etapes = (Array.isArray(j.etapes) ? j.etapes : []).filter(isObj).slice(0, 25).map((e) => ({
    op: str(e.op, 40), formule: str(e.formule, 700), avant: typeof e.avant === "number" ? e.avant : 0, apres: typeof e.apres === "number" ? e.apres : 0, ...(str(e.note, 300) ? { note: str(e.note, 300) } : {}),
  }));
  return {
    title: str(v.title, 120) || "Analyse", source: str(v.source, 300), colonnes, lignes, totaux: Array.isArray(v.totaux) ? colonnes.map((c, k) => (typeof (v.totaux as unknown[])[k] === "number" && k > 0 && ["dzd", "nombre", "entier"].includes(c.format) ? 0 : null)) : null, graphiques,
    total: typeof v.total === "number" && v.total >= lignes.length ? Math.round(v.total) : lignes.length,
    journal: {
      sources: strs(j.sources, 8), etapes, resultats: (Array.isArray(j.resultats) ? j.resultats : []).filter(isObj).slice(0, 10).map((r) => ({ libelle: str(r.libelle, 120), valeur: str(r.valeur, 300) })),
      ignores: strs(j.ignores, 20), refusees: strs(j.refusees, 20), masquees: strs(j.masquees, 20, 80), moteur: str(j.moteur, 120) || "moteur d'analyse du socle", calculeLe: str(j.calculeLe, 40) || new Date().toISOString(),
    },
  };
}
