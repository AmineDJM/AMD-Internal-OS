import { versDate, versNombre, type Ligne } from "@/platform/ia/analyse/analyse";
import { recommanderGraphique, verifierGraphique, type SpecGraphique, type TypeGraphique } from "@/platform/ia/analyse/viz";
import type { JournalEtape } from "@/platform/ia/analyse/pipeline";
import { etapesLisibles } from "@/platform/ia/analyse/journal";
import { enClair } from "@/platform/ia/analyse/affichage";
import { construireViz } from "@/platform/ia/workspace/viz-block";
import {
  ANALYSE_COLONNES_MAX, ANALYSE_GRAPHIQUES_MAX, ANALYSE_LIGNES_MAX, FORME_PROTOCOLE, FORMATS_COLONNE, GRAPHIQUES_ANALYSE,
  type BlocAnalyseForme, type CelluleAnalyse, type ColonneAnalyse, type FormatColonne, type GraphiqueAnalyse, type GraphiqueDemande, type ResultatCalcul,
} from "@/platform/ia/workspace/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPOSEUR D'ANALYSE (lot K1, décision 0031) — des lignes CALCULÉES au bloc affiché et au résumé du modèle.
 *
 * Tout chiffre de ce qui sort d'ici vient du moteur : les cellules sont les valeurs calculées (typées), les
 * totaux sont des sommes faites par le code sur TOUTES les lignes du résultat, les graphiques sont construits
 * depuis les lignes (`construireViz`) et jugés (`verifierGraphique` : un graphique TROMPEUR demandé par le modèle
 * est remplacé par la forme honnête, et l'écran dit pourquoi). Le modèle reçoit les mêmes chiffres, DÉJÀ
 * FORMATÉS en français (« 12 345 678 DZD ») : il les cite, il ne les calcule pas.
 *
 * Pur : ni base, ni droits, ni réseau — partagé par l'Assistant IA et, demain, par Adam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const plier = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const RE_ENTIER = /^(count|distinct)_|(^|_)(n|nb|nombre|effectif|effectifs|quantite|qte|rang|taille|lignes?|jours?|annee)$/;
const RE_POURCENT = /(taux|pourcent|pct|(^|_)part(s)?($|_)|croissance|evolution|retention|^p\+\d+$|%|marge_pct)/;
const RE_DZD = /(montant|budget|total|prix|cout|depense|engage|consomm|solde|reste|restant|alloue|accorde|chiffre|(^|_)ca($|_)|valeur|ttc|(^|_)ht($|_)|dzd|somme|recette|paiement|factur|disponible|enveloppe|(^|_)da($|_)|achat|vente)/;
/** Ce qui ne s'additionne pas : une moyenne, un extrême, un rang, un taux. */
const RE_NON_ADDITIF = /^(avg|median|min|max|p90|distinct)_|moyenne|mediane|rang|(^|_)z$|tendance|annee/;

/** Le format d'une colonne d'après son NOM (indice), quand ses valeurs sont numériques. */
export function formatParNom(cle: string): FormatColonne {
  const n = plier(cle);
  if (RE_POURCENT.test(n)) return "pourcent";
  if (RE_ENTIER.test(n)) return "entier";
  if (RE_DZD.test(n)) return "dzd";
  return "nombre";
}

/** Le format d'une colonne d'après ses VALEURS, l'indice du pipeline, puis son nom. */
export function formatDe(cle: string, valeurs: readonly unknown[], indice?: FormatColonne): FormatColonne {
  const pleines = valeurs.filter((v) => v !== null && v !== undefined && v !== "");
  if (!pleines.length) return indice ?? "texte";
  const nums = pleines.map(versNombre);
  if (nums.every((n) => n !== null)) {
    if (indice && indice !== "texte" && indice !== "date") return indice;
    const parNom = formatParNom(cle);
    return parNom === "nombre" && (nums as number[]).every((n) => Number.isInteger(n)) ? "entier" : parNom;
  }
  if (pleines.every((v) => versDate(v) !== null)) return "date";
  return "texte";
}

/**
 * LES FORMATS QUE LE PIPELINE IMPLIQUE : une colonne créée par `regrouper`, `serie`, `croiser`, `croissance`… hérite
 * du format de la colonne mesurée (« somme(montant) » est en DZD ; « nombre de lignes » est un entier ; une croissance
 * est en %). Sans cela, `valeur` — la colonne d'une série — serait devinée sur son seul nom.
 */
export function formatsDuPipeline(etapes: readonly unknown[], formatsEntree: Readonly<Record<string, FormatColonne>>): Record<string, FormatColonne> {
  const f: Record<string, FormatColonne> = { ...formatsEntree };
  const deMesure = (m: unknown): { alias: string; format: FormatColonne } | null => {
    if (typeof m === "string") return { alias: `sum_${m}`, format: f[m] ?? formatParNom(m) };
    if (!isObj(m)) return null;
    const agg = (s(m.agregat) || s(m.agg) || s(m.fonction) || "sum").toLowerCase();
    const col = s(m.colonne) || s(m.column);
    const alias = s(m.alias) || `${agg}_${col || "*"}`;
    return { alias, format: agg === "count" || agg === "distinct" ? "entier" : (f[col] ?? formatParNom(col)) };
  };
  for (const e of etapes) {
    if (!isObj(e)) continue;
    const op = (s(e.op) || s(e.operation)).toLowerCase();
    if (op === "regrouper") for (const m of Array.isArray(e.mesures) ? e.mesures : [e.mesures ?? e.mesure]) { const x = deMesure(m); if (x) f[x.alias] = x.format; }
    if (op === "serie") { const x = deMesure(e.mesure); f.valeur = x?.format ?? "nombre"; f.n = "entier"; }
    if (op === "croiser") { const x = deMesure(e.mesure); if (x) f["*croise"] = x.format; }
    if (op === "croissance") f[s(e.alias) || `croissance_${s(e.colonne) || "valeur"}`] = "pourcent";
    if (op === "moyenne_mobile" || op === "cumul") { const c = s(e.colonne) || "valeur"; f[s(e.alias) || `${op}_${c}`] = f[c] ?? formatParNom(c); }
    if (op === "rang") f[s(e.alias) || "rang"] = "entier";
    if (op === "cohortes") f.taille = "entier";
  }
  return f;
}

const NF2 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

const LIBELLES_AGG: [RegExp, string][] = [
  [/^sum_/, "Somme "], [/^avg_/, "Moyenne "], [/^count_/, "Nombre "], [/^median_/, "Médiane "], [/^min_/, "Minimum "], [/^max_/, "Maximum "],
  [/^p90_/, "90e centile "], [/^distinct_/, "Distincts "], [/^croissance_/, "Croissance "], [/^cumul_/, "Cumul "], [/^moyenne_mobile_/, "Moyenne mobile "],
];
export function libelleDe(cle: string): string {
  let t = cle;
  for (const [re, l] of LIBELLES_AGG) if (re.test(t)) { t = t.replace(re, l); break; }
  t = t.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : cle;
}

export interface DemandeGraphique { type?: string | null; x?: string | null; y?: string[] | null; serie?: string | null; titre?: string | null }

export interface DemandeAnalyse {
  titre: string;
  question?: string;
  /** La source en une ligne (méta) et le détail (journal). */
  source: string;
  sources: string[];
  /** Les lignes CALCULÉES (résultat du pipeline ou du code). */
  lignes: readonly Ligne[];
  /** Les lignes d'ENTRÉE — pour hériter de leurs formats. */
  entree?: readonly Ligne[];
  pipeline?: { etapes: readonly unknown[]; journal: readonly JournalEtape[]; erreurs: readonly string[]; ignores: readonly { colonne: string; ignorees: number; raison: string }[]; resultats: Record<string, unknown> };
  moteur: string;
  graphiques?: readonly DemandeGraphique[];
  /** Formats et libellés imposés par le modèle — des MOTS, jamais des chiffres. */
  formats?: Readonly<Record<string, string>>;
  libelles?: Readonly<Record<string, string>>;
  masquees?: readonly string[];
  maintenant?: Date;
}

export interface ResumeAnalyse {
  titre: string;
  colonnes: { cle: string; libelle: string; format: FormatColonne }[];
  lignesTotal: number;
  /** Les premières lignes, chiffres déjà formatés : à citer tels quels. */
  apercu: Record<string, string>[];
  totaux?: Record<string, string>;
  resultats?: ResultatCalcul[];
  graphiques: { type: string; raison: string | null; alertes: string[] }[];
  /** Toutes les colonnes du résultat, quand le bloc n'en montre qu'une partie. */
  colonnesDuResultat?: string[];
}

const APERCU_MODELE = 40;

function grandeurDuResultat(cle: string, v: unknown): ResultatCalcul[] {
  if (cle.startsWith("tendance_") && isObj(v)) {
    const t = v as { pente?: number; r2?: number; n?: number };
    if (typeof t.pente === "number") return [{ libelle: `Tendance de ${cle.slice(9)}`, valeur: `pente ${t.pente >= 0 ? "+" : ""}${NF2.format(t.pente)} par période · R² ${NF2.format(t.r2 ?? 0)} · ${t.n ?? 0} points` }];
  }
  if (cle.startsWith("tendance_") && typeof v === "string") return [{ libelle: `Tendance de ${cle.slice(9)}`, valeur: v }];
  if (cle === "scenario" && isObj(v)) {
    const sc = v as { base?: number | null; scenario?: number | null; ecart?: number | null; hypotheses?: string[] };
    const f = (x: number | null | undefined) => (typeof x === "number" ? NF2.format(x) : "—");
    return [{ libelle: `Scénario (${(sc.hypotheses ?? []).join(", ")})`, valeur: `base ${f(sc.base)} → scénario ${f(sc.scenario)} (écart ${f(sc.ecart)})` }];
  }
  if (cle.startsWith("anomalies_") && isObj(v)) {
    const a = v as { mediane?: number | null; mad?: number | null; n?: number; note?: string };
    return [{ libelle: `Anomalies sur ${cle.slice(10)}`, valeur: a.note ?? `${a.n ?? 0} valeur(s) hors norme · médiane ${typeof a.mediane === "number" ? NF2.format(a.mediane) : "—"} · MAD ${typeof a.mad === "number" ? NF2.format(a.mad) : "—"}` }];
  }
  return [];
}

/** Une forme demandée par le modèle, lue sans confiance. */
const formeDemandee = (t: unknown): GraphiqueDemande | null => {
  const v = plier(s(t)).replace(/[\s-]+/g, "_");
  const alias: Record<string, GraphiqueDemande> = { ligne: "courbe", line: "courbe", bar: "barres", pie: "secteurs", donut: "anneau", camembert: "secteurs", scatter: "nuage", area: "aires", waterfall: "cascade", groupees: "barres_groupees", empilees: "barres_empilees" };
  if ((GRAPHIQUES_ANALYSE as readonly string[]).includes(v)) return v as GraphiqueDemande;
  return alias[v] ?? null;
};

const VERS_SPEC: Partial<Record<GraphiqueDemande, TypeGraphique>> = {
  barres: "barres", barres_groupees: "barres", barres_empilees: "barres_empilees", courbe: "courbe", aires: "aires", secteurs: "secteurs",
  anneau: "secteurs", nuage: "nuage", heatmap: "heatmap", cascade: "cascade", histogramme: "histogramme",
};

function unite(format: FormatColonne | undefined): string | null {
  return format === "dzd" ? "DZD" : format === "pourcent" ? "%" : null;
}

/** UN graphique : la forme demandée si elle ne trompe pas, sinon la forme recommandée — et pourquoi. */
function graphique(lignes: readonly Ligne[], d: DemandeGraphique | null, question: string, titre: string, formats: Record<string, FormatColonne>): GraphiqueAnalyse | null {
  const reco = recommanderGraphique(lignes, question, titre);
  const voulu = formeDemandee(d?.type);
  let spec: SpecGraphique = reco;
  let forme: GraphiqueDemande | null = reco.type === "tableau" ? null : (reco.type as GraphiqueDemande);
  const notes: string[] = [];
  if (voulu) {
    const candidate: SpecGraphique = {
      ...reco, type: VERS_SPEC[voulu] ?? reco.type, titre: d?.titre || titre,
      x: d?.x ?? reco.x, y: d?.y?.length ? d.y : reco.y, serie: d?.serie ?? (voulu === "barres_groupees" || voulu === "barres_empilees" || voulu === "heatmap" ? reco.serie ?? null : null),
      axeYdepartZero: voulu === "courbe" || voulu === "nuage" ? reco.axeYdepartZero : true,
      raison: `forme demandée : ${voulu.replace(/_/g, " ")}`,
    };
    const trompe = verifierGraphique(candidate, lignes).filter((a) => a.gravite === "TROMPEUR");
    if (trompe.length) notes.push(`La forme « ${voulu.replace(/_/g, " ")} » tromperait (${trompe.map((a) => a.message).join(" ")}) : ${reco.type === "tableau" ? "le tableau suffit" : `remplacée par « ${reco.type.replace(/_/g, " ")} »`}.`);
    else { spec = candidate; forme = voulu; }
  }
  if (!forme) return null;
  const type = FORME_PROTOCOLE[forme];
  const c = construireViz({ type, x: spec.x, y: spec.y, serie: spec.serie ?? null }, lignes);
  if ("erreur" in c) return null;
  const alertes = verifierGraphique({ ...spec, type: VERS_SPEC[forme] ?? spec.type }, lignes).map((a) => `${a.gravite} · ${a.message}`);
  const y0 = (c.colonnes.y as readonly string[] | undefined)?.[0];
  return {
    titre: d?.titre || titre, type, donnees: c.donnees, unite: unite(y0 ? formats[y0] : undefined), axeYdepartZero: spec.axeYdepartZero,
    raison: spec.raison, alertes, note: [...notes, ...c.notes].join(" · ") || null,
  };
}

/** COMPOSER : des lignes calculées au bloc et au résumé. */
export function composerAnalyse(d: DemandeAnalyse): { bloc: BlocAnalyseForme; resume: ResumeAnalyse } {
  const lignes = d.lignes.filter(isObj);
  const compte = new Map<string, number>();
  for (const l of lignes) for (const k of Object.keys(l)) compte.set(k, (compte.get(k) ?? 0) + 1);
  const cles = [...compte.keys()].slice(0, ANALYSE_COLONNES_MAX);

  // LES FORMATS : imposés (mots), sinon hérités du pipeline et de l'entrée, sinon lus sur les valeurs.
  const entree = (d.entree ?? []).filter(isObj).slice(0, 2_000);
  const formatsEntree: Record<string, FormatColonne> = {};
  for (const k of new Set(entree.flatMap((l) => Object.keys(l)))) formatsEntree[k] = formatDe(k, entree.map((l) => l[k]));
  const indices = formatsDuPipeline(d.pipeline?.etapes ?? [], formatsEntree);
  const colonnes: ColonneAnalyse[] = cles.map((cle) => {
    const impose = d.formats?.[cle];
    const croisee = indices["*croise"] && !(cle in formatsEntree) && !(cle in indices) ? indices["*croise"] : undefined;
    const format = impose && (FORMATS_COLONNE as readonly string[]).includes(impose) ? (impose as FormatColonne) : formatDe(cle, lignes.map((l) => l[cle]), indices[cle] ?? croisee);
    const libelle = (d.libelles?.[cle] ?? "").trim().slice(0, 60) || libelleDe(cle);
    return { cle, libelle, format };
  });
  const formats = Object.fromEntries(colonnes.map((c) => [c.cle, c.format]));

  // LES CELLULES : un nombre reste un nombre (« 12 345 DZD » lu par le moteur devient 12345) — l'écran trie et additionne.
  const cellule = (v: unknown, f: FormatColonne): CelluleAnalyse => {
    if (v === null || v === undefined || v === "") return null;
    if (f !== "texte" && f !== "date") { const n = versNombre(v); if (n !== null) return n; }
    if (f === "date") { const dt = versDate(v); if (dt) return dt.toISOString().slice(0, 10); }
    return typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
  };
  const matrice = lignes.map((l) => colonnes.map((c) => cellule(l[c.cle], c.format)));
  const additive = (c: ColonneAnalyse) => (c.format === "dzd" || c.format === "nombre" || c.format === "entier") && !RE_NON_ADDITIF.test(plier(c.cle));
  const totaux = colonnes.some(additive) && matrice.length > 1
    ? colonnes.map((c, j) => (additive(c) && j > 0 ? matrice.reduce((acc, r) => acc + (typeof r[j] === "number" ? (r[j] as number) : 0), 0) : null))
    : null;

  const demandes = (d.graphiques?.length ? d.graphiques : [null]).slice(0, ANALYSE_GRAPHIQUES_MAX);
  const graphiques = lignes.length >= 2
    ? demandes.map((g) => graphique(lignes, g, d.question ?? "", d.titre, formats)).filter((g): g is GraphiqueAnalyse => g !== null)
    : [];

  const resultats = Object.entries(d.pipeline?.resultats ?? {}).flatMap(([k, v]) => grandeurDuResultat(k, v));
  const bloc: BlocAnalyseForme = {
    kind: "analyse", title: d.titre, source: d.source, colonnes,
    lignes: matrice.slice(0, ANALYSE_LIGNES_MAX), total: matrice.length, totaux, graphiques,
    journal: {
      sources: [...d.sources],
      etapes: d.pipeline ? etapesLisibles(d.pipeline.etapes, d.pipeline.journal) : [],
      resultats,
      ignores: (d.pipeline?.ignores ?? []).map((i) => `${i.colonne} : ${i.ignorees} valeur(s) non comptée(s) — ${i.raison}`),
      refusees: [...(d.pipeline?.erreurs ?? [])],
      masquees: [...(d.masquees ?? [])],
      moteur: d.moteur,
      calculeLe: (d.maintenant ?? new Date()).toISOString(),
    },
  };
  const resume: ResumeAnalyse = {
    titre: d.titre,
    colonnes: colonnes.map((c) => ({ cle: c.cle, libelle: c.libelle, format: c.format })),
    lignesTotal: matrice.length,
    apercu: matrice.slice(0, APERCU_MODELE).map((r) => Object.fromEntries(colonnes.map((c, j) => [c.cle, enClair(r[j] ?? null, c.format)]))),
    ...(totaux ? { totaux: Object.fromEntries(colonnes.flatMap((c, j) => (totaux[j] === null ? [] : [[c.cle, enClair(totaux[j], c.format)]]))) } : {}),
    ...(resultats.length ? { resultats } : {}),
    graphiques: graphiques.map((g) => ({ type: g.type, raison: g.raison ?? null, alertes: g.alertes ?? [] })),
  };
  return { bloc, resume };
}
