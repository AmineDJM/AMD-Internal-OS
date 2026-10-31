import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { readVizBlock } from "@/platform/ia/workspace/viz-block";
import { recommanderGraphique, verifierGraphique, type SpecGraphique, type TypeGraphique } from "@/platform/ia/analyse/viz";
import { FORME_PROTOCOLE, GRAPHIQUES_ANALYSE, type GraphiqueDemande } from "@/platform/ia/workspace/analyse";

/**
 * LE COMPOSANT « chart » DU MODÈLE, ÉTENDU (lot K1, décision 0031) — onze formes au lieu de trois, un choix
 * automatique quand le modèle n'en donne pas, et la garde anti-graphique trompeur.
 *
 * Les NOMBRES restent jugés par `composants.ts` (chacun doit venir d'un outil du tour) ; ici, la FORME : celle que le
 * modèle demande si elle ne trompe pas (`verifierGraphique`), sinon celle que les données appellent
 * (`recommanderGraphique`) — et la note du graphique dit le remplacement. Barres groupées = barres à plusieurs
 * séries ; anneau = secteurs (dessinés en anneau) ; heatmap = séries en lignes × libellés en colonnes ; nuage = points.
 *
 * Pur.
 */

export const CONSIGNE_CHART = `- {"type":"chart","title":"…","chartType":"${GRAPHIQUES_ANALYSE.join("|")}","labels":["…"],"series":[{"name":"…","values":[1]}]} — seulement des nombres rendus par tes outils (nuage : "points":[{"x":1,"y":2,"label":"…"}]). Sans chartType : choisi pour toi. Après analyser_donnees, AUCUN chart : le graphique calculé est déjà affiché.`;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const tab = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[\s-]+/g, "_");

const ALIAS: Record<string, GraphiqueDemande> = {
  line: "courbe", ligne: "courbe", bar: "barres", bars: "barres", pie: "secteurs", donut: "anneau", camembert: "secteurs",
  area: "aires", scatter: "nuage", waterfall: "cascade", stacked: "barres_empilees", grouped: "barres_groupees", empilees: "barres_empilees", groupees: "barres_groupees",
};
const formeDe = (v: unknown): GraphiqueDemande | null => {
  const p = plier(str(v, 30));
  return (GRAPHIQUES_ANALYSE as readonly string[]).includes(p) ? (p as GraphiqueDemande) : ALIAS[p] ?? null;
};
const VERS_SPEC: Record<GraphiqueDemande, TypeGraphique> = {
  barres: "barres", barres_groupees: "barres", barres_empilees: "barres_empilees", courbe: "courbe", aires: "aires", secteurs: "secteurs",
  anneau: "secteurs", nuage: "nuage", heatmap: "heatmap", cascade: "cascade", histogramme: "histogramme",
};

export interface ChartLu {
  libelles: string[];
  series: { nom: string; valeurs: unknown[] }[];
  points: { x: number; y: number; label?: string }[];
  /** Les nombres du composant — ceux que `composants.ts` doit retrouver dans les outils du tour. */
  valeurs: number[];
}

export function lireChart(c: Record<string, unknown>): ChartLu {
  const libelles = tab(c.labels).map((x) => str(x, 40)).filter(Boolean).slice(0, 24);
  const series = tab(c.series)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({ nom: str(s.name ?? s.label, 40), valeurs: tab(s.values ?? s.valeurs) }))
    .slice(0, 6);
  const points = tab(c.points)
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).x === "number" && typeof (p as Record<string, unknown>).y === "number")
    .map((p) => ({ x: p.x as number, y: p.y as number, ...(str(p.label, 40) ? { label: str(p.label, 40) } : {}) }))
    .slice(0, 400);
  const valeurs = [...series.flatMap((s) => s.valeurs.filter((v): v is number => typeof v === "number")), ...points.flatMap((p) => [p.x, p.y])];
  return { libelles, series, points, valeurs };
}

/** LE BLOC : la forme jugée, ou `null` (vide). Les nombres ont déjà été prouvés par l'appelant. */
export function chartEnBloc(c: Record<string, unknown>, lu: ChartLu, titre: string): WorkspaceBlock | null {
  const voulu = formeDe(c.chartType ?? c.type_graphique);
  if (voulu === "nuage" || (!voulu && lu.points.length && !lu.libelles.length)) {
    return lu.points.length >= 2 ? readVizBlock({ type: "nuage", donnees: { points: lu.points } }, titre) : null;
  }
  if (!lu.libelles.length || !lu.series.length) return null;
  // Les lignes que la vérification et la recommandation lisent : une par libellé, une colonne par série.
  const lignes = lu.libelles.map((l, i) => ({ categorie: l, ...Object.fromEntries(lu.series.map((s, j) => [s.nom || `serie_${j + 1}`, typeof s.valeurs[i] === "number" ? s.valeurs[i] : null])) }));
  const ys = lu.series.map((s, j) => s.nom || `serie_${j + 1}`);
  const reco = recommanderGraphique(lignes, titre, titre);
  let forme: GraphiqueDemande = voulu ?? (reco.type === "tableau" || reco.type === "histogramme" ? "barres" : (reco.type as GraphiqueDemande));
  let note: string | null = null;
  if (voulu) {
    const spec: SpecGraphique = { type: VERS_SPEC[voulu], titre, x: "categorie", y: ys, axeYdepartZero: voulu !== "courbe", raison: "forme demandée" };
    const trompe = verifierGraphique(spec, lignes).filter((a) => a.gravite === "TROMPEUR");
    if (trompe.length) {
      forme = lu.series.length > 1 ? "barres_groupees" : "barres";
      note = `Forme « ${voulu.replace(/_/g, " ")} » remplacée : ${trompe.map((a) => a.message).join(" ")}`;
    }
  }
  if (forme === "heatmap") {
    return readVizBlock({ type: "heatmap", donnees: { lignes: ys, colonnes: lu.libelles, valeurs: lu.series.map((s) => lu.libelles.map((_, i) => (typeof s.valeurs[i] === "number" ? s.valeurs[i] : null))) } }, titre);
  }
  const type = FORME_PROTOCOLE[forme];
  const b = readVizBlock({ type, donnees: { categories: lu.libelles, series: lu.series.map((s) => ({ label: s.nom, valeurs: s.valeurs })) } }, titre);
  if (!b || b.kind !== "viz") return b;
  const alertes = verifierGraphique({ type: VERS_SPEC[forme], titre, x: "categorie", y: ys, axeYdepartZero: forme !== "courbe", raison: "" }, lignes).map((a) => `${a.gravite} · ${a.message}`);
  return { ...b, ...(alertes.length ? { alertes } : {}), ...(note ? { note } : {}) };
}
