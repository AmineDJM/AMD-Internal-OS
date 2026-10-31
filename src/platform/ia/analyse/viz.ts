/**
 * LA VISUALISATION EXPERTE — le bon graphique pour la question, et ce qui tromperait (§25).
 *
 * Le choix suit la FORME des données et l'INTENTION de la question, pas le goût : une série dans
 * le temps se lit en courbe, une comparaison de catégories en barres, une part d'un tout en
 * secteurs — six parts au plus —, deux mesures en nuage, une distribution en histogramme. Et le
 * module DIT ce qui tromperait : un axe qui ne part pas de zéro sur des barres, un camembert à
 * quinze parts ou dont les parts ne font pas un tout, deux axes verticaux, la 3D, une échelle
 * logarithmique non dite, un cumul présenté comme une période, dix séries sur une courbe.
 * Pur : ni rendu, ni réseau.
 */

import { decrire, type Ligne } from "@/platform/ia/analyse/analyse";

/** K1 (décision 0031) : `aires` et `heatmap` rejoignent les formes jugées — une aire ment comme une barre si son axe ne part pas de zéro. */
export type TypeGraphique = "courbe" | "barres" | "barres_empilees" | "secteurs" | "nuage" | "histogramme" | "tableau" | "cascade" | "aires" | "heatmap";

export interface SpecGraphique {
  type: TypeGraphique;
  titre: string;
  x: string | null;
  y: string[];
  serie?: string | null;
  axeYdepartZero: boolean;
  echelle?: "lineaire" | "log";
  cumul?: boolean;
  doubleAxe?: boolean;
  troisD?: boolean;
  /** Pourquoi ce graphique — lisible par la personne. */
  raison: string;
}

export interface Alerte { code: string; gravite: "TROMPEUR" | "DOUTEUX"; message: string }

const INTENTIONS: [RegExp, TypeGraphique][] = [
  [/\b(evolution|evolue|tendance|dans le temps|par mois|mensuel|mensuelle|par an|annuel|annuelle|depuis|croissance|courbe|historique)\b/, "courbe"],
  [/\b(repartition|part|parts|proportion|pourcentage|composition|poids de|camembert)\b/, "secteurs"],
  [/\b(compare|comparaison|classement|top|les plus|les moins|par (departement|societe|fournisseur|produit|pays|categorie|region|wilaya|personne))\b/, "barres"],
  [/\b(correlation|relation entre|en fonction de|nuage)\b/, "nuage"],
  [/\b(distribution|histogramme|dispersion|ecart type)\b/, "histogramme"],
  [/\b(pont|cascade|waterfall|decomposition de l ecart)\b/, "cascade"],
];

const plier = (s: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " ");
const PERIODE_RE = /^\d{4}(-\d{2})?(-\d{2})?$|^\d{4}-T[1-4]$/;

/** RECOMMANDER un graphique depuis les lignes et la question. */
export function recommanderGraphique(lignes: readonly Ligne[], question = "", titre = "Résultat"): SpecGraphique {
  const profil = decrire(lignes);
  const dates = profil.colonnes.filter((c) => c.type === "date");
  const nombres = profil.colonnes.filter((c) => c.type === "nombre");
  const textes = profil.colonnes.filter((c) => c.type === "texte");
  const q = plier(question);
  const intention = INTENTIONS.find(([re]) => re.test(q))?.[1] ?? null;
  const periodeTexte = textes.find((c) => lignes.every((l) => PERIODE_RE.test(String(l[c.nom] ?? ""))));
  const axeTemps = dates[0]?.nom ?? periodeTexte?.nom ?? null;
  const categorie = textes.find((c) => c.nom !== periodeTexte?.nom) ?? null;
  const mesure = nombres[0]?.nom ?? null;

  if (!lignes.length || !mesure) return { type: "tableau", titre, x: categorie?.nom ?? null, y: [], axeYdepartZero: true, raison: "aucune mesure numérique : un tableau dit ce qu'il y a sans prétendre le comparer." };
  if ((intention === "courbe" || (!intention && axeTemps)) && axeTemps && lignes.length >= 3) {
    return { type: "courbe", titre, x: axeTemps, y: nombres.slice(0, 4).map((c) => c.nom), serie: categorie && categorie.distincts <= 6 ? categorie.nom : null, axeYdepartZero: false, raison: "une évolution dans le temps se lit en courbe : la pente est l'information." };
  }
  if (intention === "secteurs" && categorie && categorie.distincts <= 6 && lignes.length <= 6) {
    return { type: "secteurs", titre, x: categorie.nom, y: [mesure], axeYdepartZero: true, raison: "une répartition en six parts au plus se lit en secteurs — au-delà, les parts deviennent illisibles." };
  }
  if (intention === "secteurs" && categorie) {
    return { type: "barres", titre, x: categorie.nom, y: [mesure], axeYdepartZero: true, raison: `${categorie.distincts} catégories : des barres triées valent mieux qu'un camembert illisible.` };
  }
  if (intention === "nuage" && nombres.length >= 2) return { type: "nuage", titre, x: nombres[0].nom, y: [nombres[1].nom], axeYdepartZero: false, raison: "deux mesures par ligne : le nuage montre la relation, pas une hiérarchie." };
  if (intention === "histogramme" && nombres.length >= 1) return { type: "histogramme", titre, x: mesure, y: ["effectif"], axeYdepartZero: true, raison: "une distribution se lit en classes d'effectif." };
  if (intention === "cascade" && categorie) return { type: "cascade", titre, x: categorie.nom, y: [mesure], axeYdepartZero: true, raison: "le passage d'un total à un autre se décompose en cascade." };
  if (categorie && categorie.distincts <= 40) {
    const empile = textes.length >= 2 && textes[1].distincts <= 6;
    return { type: empile ? "barres_empilees" : "barres", titre, x: categorie.nom, y: [mesure], serie: empile ? textes[1].nom : null, axeYdepartZero: true, raison: `une comparaison entre ${categorie.distincts} catégories se lit en barres, axe à zéro — la hauteur EST la valeur.` };
  }
  if (nombres.length >= 2) return { type: "nuage", titre, x: nombres[0].nom, y: [nombres[1].nom], axeYdepartZero: false, raison: "deux mesures numériques sans catégorie : la relation se voit en nuage." };
  return { type: "tableau", titre, x: categorie?.nom ?? null, y: nombres.map((c) => c.nom), axeYdepartZero: true, raison: "trop de catégories pour un graphique lisible : le tableau, trié, reste honnête." };
}

/** VÉRIFIER un graphique — le sien ou celui d'un autre : ce qui trompe, ce qui est douteux. */
export function verifierGraphique(spec: SpecGraphique, lignes: readonly Ligne[] = []): Alerte[] {
  const a: Alerte[] = [];
  const profil = decrire(lignes);
  const cat = spec.x ? profil.colonnes.find((c) => c.nom === spec.x) : null;
  if ((spec.type === "barres" || spec.type === "barres_empilees" || spec.type === "histogramme" || spec.type === "cascade") && !spec.axeYdepartZero) a.push({ code: "axe_tronque", gravite: "TROMPEUR", message: "Des barres dont l'axe ne part pas de zéro exagèrent les écarts : la hauteur ne vaut plus la valeur." });
  if (spec.type === "aires" && !spec.axeYdepartZero) a.push({ code: "aire_tronquee", gravite: "TROMPEUR", message: "Une aire dont l'axe ne part pas de zéro exagère les écarts : la surface ne vaut plus la valeur." });
  if (spec.type === "aires" && spec.x && lignes.length && !lignes.every((l) => PERIODE_RE.test(String(l[spec.x!] ?? ""))) && profil.colonnes.find((x) => x.nom === spec.x)?.type !== "date") a.push({ code: "aire_sans_temps", gravite: "TROMPEUR", message: "Une aire relie des catégories qui ne se suivent pas dans le temps : la surface suggère une continuité qui n'existe pas." });
  if (spec.type === "secteurs") {
    if ((cat?.distincts ?? lignes.length) > 6) a.push({ code: "secteurs_trop_de_parts", gravite: "TROMPEUR", message: `${cat?.distincts ?? lignes.length} parts dans un camembert : illisible — préférer des barres triées.` });
    const y = spec.y[0];
    if (y && lignes.length) {
      const vals = lignes.map((l) => Number(l[y])).filter((n) => Number.isFinite(n));
      if (vals.some((v) => v < 0)) a.push({ code: "secteurs_negatif", gravite: "TROMPEUR", message: "Une part négative n'existe pas : un camembert ne représente pas des écarts." });
      const somme = vals.reduce((s, v) => s + v, 0);
      if (vals.length > 1 && vals.some((v) => v > somme * 0.999)) a.push({ code: "secteurs_pas_un_tout", gravite: "DOUTEUX", message: "Les parts ne semblent pas former un tout (une valeur vaut presque la somme) : vérifier qu'il s'agit bien d'une répartition." });
    }
  }
  if (spec.doubleAxe) a.push({ code: "double_axe", gravite: "TROMPEUR", message: "Deux axes verticaux laissent choisir l'échelle qui fait croiser les courbes : à éviter, ou à séparer en deux graphiques." });
  if (spec.troisD) a.push({ code: "trois_d", gravite: "TROMPEUR", message: "La perspective 3D déforme les proportions : les parts de devant paraissent plus grandes." });
  if (spec.echelle === "log" && !/log/i.test(spec.titre)) a.push({ code: "log_non_dit", gravite: "TROMPEUR", message: "Échelle logarithmique sans le dire dans le titre : un doublement paraît un petit pas." });
  if (spec.cumul && !/cumul/i.test(spec.titre)) a.push({ code: "cumul_non_dit", gravite: "TROMPEUR", message: "Un cumul monte toujours : présenté sans le mot « cumulé », il fait croire à une croissance de période." });
  if (spec.type === "courbe" && spec.serie) { const s = profil.colonnes.find((c) => c.nom === spec.serie); if ((s?.distincts ?? 0) > 6) a.push({ code: "trop_de_series", gravite: "DOUTEUX", message: `${s?.distincts} séries sur une courbe : un plat de spaghettis — garder les 4 à 6 qui comptent.` }); }
  if (spec.type === "courbe" && lignes.length > 0 && lignes.length < 3) a.push({ code: "courbe_trop_courte", gravite: "DOUTEUX", message: "Une courbe à moins de trois points n'est pas une tendance." });
  if (spec.type === "courbe" && spec.x && lignes.length) {
    const c = profil.colonnes.find((x) => x.nom === spec.x);
    if (c && c.type !== "date" && !lignes.every((l) => PERIODE_RE.test(String(l[spec.x!] ?? "")))) a.push({ code: "courbe_sans_temps", gravite: "TROMPEUR", message: "Une courbe relie des points qui ne se suivent pas dans le temps : la ligne suggère une continuité qui n'existe pas." });
  }
  return a;
}
