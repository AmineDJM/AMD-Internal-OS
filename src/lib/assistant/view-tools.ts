/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `render_view` — LA REPRÉSENTATION À LA DEMANDE (mandat 5 §35).
 *
 * Un seul outil pour dix-sept formes et le mini-tableau de bord. Le modèle NOMME ce qu'il veut
 * montrer (une forme, ou « auto », des colonnes, une source) ; le CODE charge les lignes sous le
 * droit de leur source, agrège, choisit la forme quand on le lui demande, vérifie ce qui
 * tromperait, et compose le bloc — relu par le même lecteur que tout `_blocs` avant d'être rendu.
 *
 * Trois chemins, et pas un quatrième :
 *   • des LIGNES (lecture, fichier du Drive, SQL en vue globale, lignes déjà obtenues) → `construireViz` ;
 *   • des DONNÉES déjà structurées (un réseau, un arbre, des lieux, des indicateurs) → le lecteur, tel quel ;
 *   • des TUILES (chacune l'un des deux chemins) → un `dashboard`.
 *
 * Le modèle ne reçoit JAMAIS le bloc : `_blocsDecoratifs` le retire de ce qu'il lit, et un résumé
 * chiffré (les premières catégories, leurs valeurs, la forme, les alertes) lui permet de dire vrai
 * en une phrase. Il ne dessine pas, il ne recopie pas : il présente ce que l'écran montre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { blocTableau, chargerLignes } from "@/lib/assistant/sandbox-tools";
import { VIZ_TYPES, WORKSPACE_LIMITS, type VizDonnees, type VizType } from "@/platform/ia/workspace/protocol";
import { ATTENDU, FAMILLE, construireViz, isVizType, readVizBlock, type DemandeViz } from "@/platform/ia/workspace/viz-block";
import { recommanderGraphique, verifierGraphique, type SpecGraphique, type TypeGraphique } from "@/platform/in-process/sandbox";
import { declarerProvenance, faitCalcule } from "@/platform/in-process/fabric/provenance";

type Acteur = Parameters<PowerTool["run"]>[1];
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (input: Json, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const strOuNull = (input: Json, key: string): string | null => str(input, key) || null;

/** Ce que le conseiller du bac recommande, traduit dans les formes du protocole. */
const VERS_VIZ: Record<TypeGraphique, VizType | "tableau"> = {
  courbe: "courbe", barres: "barres", barres_empilees: "barres_empilees", secteurs: "secteurs",
  nuage: "nuage", histogramme: "histogramme", cascade: "cascade", tableau: "tableau",
};
/** Les formes que le vérificateur du bac sait juger (les autres ont leurs contrôles locaux). */
const VERS_SPEC: Partial<Record<VizType, TypeGraphique>> = {
  barres: "barres", barres_empilees: "barres_empilees", courbe: "courbe", aires: "courbe", secteurs: "secteurs",
  nuage: "nuage", histogramme: "histogramme", cascade: "cascade", entonnoir: "barres",
};

const AGREGATS = new Set(["somme", "moyenne", "compte", "min", "max"]);
const TRIS = new Set(["valeur", "libelle", "aucun"]);

/** Les contrôles que le bac ne fait pas : ce qui tromperait dans une forme qu'il ne connaît pas. */
export function alertesLocales(type: VizType, d: VizDonnees): string[] {
  const a: string[] = [];
  const n = d.categories?.length ?? 0;
  if (type === "secteurs") {
    if (n > 6) a.push(`TROMPEUR · ${n} parts dans un camembert : illisible — préférer des barres triées.`);
    if ((d.series ?? []).some((s) => s.valeurs.some((v) => v !== null && v < 0))) a.push("TROMPEUR · Une part négative n'existe pas : un camembert ne représente pas des écarts.");
  }
  if ((type === "courbe" || type === "aires") && n > 0 && n < 3) a.push("DOUTEUX · Une courbe à moins de trois points n'est pas une tendance.");
  if (type === "nuage" && (d.points?.length ?? 0) < 3) a.push("DOUTEUX · Moins de trois points : aucune relation ne se lit.");
  if (type === "entonnoir" && d.series?.[0]) {
    const v = d.series[0].valeurs.map((x) => x ?? 0);
    if (v.some((x, i) => i > 0 && x > (v[i - 1] ?? 0))) a.push("DOUTEUX · Une étape de l'entonnoir dépasse la précédente : ce n'est pas une conversion.");
  }
  if (type === "carte") a.push("DOUTEUX · Carte schématique : positions relatives par coordonnées, sans fond de carte — les distances sont indicatives.");
  return a;
}

/** Un aperçu chiffré pour le modèle : ce qu'il peut DIRE de ce que l'écran montre. */
function apercu(type: VizType, d: VizDonnees): Json {
  switch (FAMILLE[type]) {
    case "series": {
      const cats = d.categories ?? []; const series = d.series ?? [];
      return {
        categories: cats.length, series: series.map((s) => s.label),
        apercu: cats.slice(0, 6).map((c, i) => ({ categorie: c, ...Object.fromEntries(series.map((s) => [s.label, s.valeurs[i]])) })),
        ...(cats.length > 6 ? { apercuNote: `${cats.length - 6} catégorie(s) de plus à l'écran` } : {}),
      };
    }
    case "points": return { points: d.points?.length ?? 0 };
    case "grille": return { lignes: d.lignes?.length ?? 0, colonnes: d.colonnes?.length ?? 0 };
    case "cellules": return { lignes: d.lignes?.length ?? 0, colonnes: d.colonnes?.length ?? 0 };
    case "taches": return { taches: d.taches?.length ?? 0, de: d.taches?.[0]?.debut ?? null, a: d.taches?.reduce((m, t) => (t.fin > m ? t.fin : m), "") || null };
    case "reseau": return { noeuds: d.noeuds?.length ?? 0, arcs: d.arcs?.length ?? 0, principaux: (d.noeuds ?? []).slice(0, 5).map((x) => x.label) };
    case "arbre": { let n = 0; const visiter = (x: NonNullable<VizDonnees["racine"]>) => { n += 1; for (const e of x.enfants ?? []) visiter(e); }; if (d.racine) visiter(d.racine); return { noeuds: n, racine: d.racine?.label ?? null }; }
    case "lieux": return { lieux: d.lieux?.length ?? 0 };
    case "cartes": return { cartes: (d.cartes ?? []).map((c) => `${c.titre} : ${c.valeur}`) };
  }
}

interface Vue { bloc: unknown; resume: Json; provenance: string[] }

/** UNE vue — une tuile ou la représentation seule. `partage` : ce que le tableau de bord met en commun (source, question). */
async function composerVue(spec: Json, partage: Json | null, user: Acteur): Promise<Vue | { erreur: string }> {
  const titre = str(spec, "titre") || str(partage ?? {}, "titre") || "Représentation";
  const demandeType = (str(spec, "type") || "auto").toLowerCase().replace(/[\s-]+/g, "_");
  if (demandeType !== "auto" && !isVizType(demandeType)) return { erreur: `forme inconnue « ${demandeType} » — formes : auto, ${VIZ_TYPES.join(", ")}` };
  const unite = strOuNull(spec, "unite") ?? strOuNull(partage ?? {}, "unite");
  const note = strOuNull(spec, "note");
  const axeY = typeof spec.axeYdepartZero === "boolean" ? spec.axeYdepartZero : undefined;

  // ── 1. Des données déjà STRUCTURÉES : le lecteur les relit, rien d'autre ne les touche. ──
  if (isObj(spec.donnees) && demandeType !== "auto") {
    const type = demandeType as VizType;
    const candidat = readVizBlock({ kind: "viz", title: titre, type, donnees: spec.donnees, unite, note, axeYdepartZero: axeY, raison: strOuNull(spec, "raison"), source: "données fournies dans la conversation" }, titre);
    if (!candidat || candidat.kind !== "viz") return { erreur: `données invalides pour « ${type} » : attendu ${ATTENDU[FAMILLE[type]]}` };
    const alertes = alertesLocales(type, candidat.donnees);
    return {
      bloc: { ...candidat, alertes },
      resume: { type, titre, ...apercu(type, candidat.donnees), alertes, source: "données fournies dans la conversation (non relues à une source)" },
      provenance: ["données fournies par la conversation"],
    };
  }

  // ── 2. Des LIGNES : chargées sous le droit de leur source, puis agrégées par le code. ──
  const porteSource = (o: Json | null) => Boolean(o && (isObj(o.source) || Array.isArray(o.lignes) || typeof o.sql === "string" || typeof o.drive === "string" || typeof o.outil === "string"));
  const src = porteSource(spec) ? spec : porteSource(partage) ? (partage as Json) : spec;
  const charge = await chargerLignes(src, user);
  if ("erreur" in charge) return { erreur: charge.erreur };
  const lignes = charge.lignes;

  let type: VizType | "tableau";
  let raison = strOuNull(spec, "raison");
  let x = strOuNull(spec, "x");
  let y = Array.isArray(spec.y) ? spec.y.filter((v): v is string => typeof v === "string" && v.trim() !== "") : typeof spec.y === "string" && spec.y.trim() ? [spec.y.trim()] : [];
  let serie = strOuNull(spec, "serie");
  if (demandeType === "auto") {
    const reco = recommanderGraphique(lignes, str(spec, "question") || str(partage ?? {}, "question"), titre);
    type = VERS_VIZ[reco.type];
    raison = raison ?? reco.raison;
    x = x ?? reco.x; if (!y.length) y = reco.y; serie = serie ?? reco.serie ?? null;
  } else {
    type = demandeType as VizType;
  }
  if (type === "tableau") {
    const tableau = blocTableau(titre, lignes);
    if (!tableau) return { erreur: "aucune ligne à représenter" };
    return { bloc: tableau, resume: { type: "tableau", titre, raison, lignes: lignes.length, source: charge.origine }, provenance: charge.provenance };
  }

  const agregat = AGREGATS.has(str(spec, "agregat")) ? (str(spec, "agregat") as DemandeViz["agregat"]) : null;
  const tri = TRIS.has(str(spec, "tri")) ? (str(spec, "tri") as DemandeViz["tri"]) : null;
  const demande: DemandeViz = {
    type, x, y, serie, agregat, tri,
    label: strOuNull(spec, "label"), detail: strOuNull(spec, "detail"), taille: strOuNull(spec, "taille"),
    groupe: strOuNull(spec, "groupe"), progression: strOuNull(spec, "progression"),
    debut: strOuNull(spec, "debut"), fin: strOuNull(spec, "fin"),
    de: strOuNull(spec, "de"), a: strOuNull(spec, "a"), poids: strOuNull(spec, "poids"), parent: strOuNull(spec, "parent"),
    lat: strOuNull(spec, "lat"), lon: strOuNull(spec, "lon"),
  };
  const c = construireViz(demande, lignes);
  if ("erreur" in c) return c;

  // Ce qui TROMPERAIT : le vérificateur du bac pour les formes qu'il connaît, les contrôles locaux pour les autres.
  const alertes: string[] = [];
  const specType = VERS_SPEC[type];
  const axeZero = axeY ?? !(type === "courbe" || type === "aires" || type === "nuage");
  if (specType) {
    const yCols = Array.isArray(c.colonnes.y) ? [...c.colonnes.y] : [];
    const specG: SpecGraphique = { type: specType, titre, x: typeof c.colonnes.x === "string" ? c.colonnes.x : null, y: yCols, serie: typeof c.colonnes.serie === "string" ? c.colonnes.serie : null, axeYdepartZero: axeZero, raison: raison ?? "" };
    alertes.push(...verifierGraphique(specG, lignes).map((a) => `${a.gravite} · ${a.message}`));
  }
  for (const a of alertesLocales(type, c.donnees)) if (!alertes.includes(a)) alertes.push(a);

  const candidat = readVizBlock({
    kind: "viz", title: titre, type, donnees: c.donnees, unite, axeYdepartZero: axeZero,
    note: [note, ...c.notes].filter(Boolean).join(" · ") || null, raison, alertes, source: charge.origine,
  }, titre);
  if (!candidat || candidat.kind !== "viz") return { erreur: "représentation vide après relecture : les lignes ne portent pas ce que la forme exige" };
  return {
    bloc: candidat,
    resume: { type, titre, raison, colonnes: c.colonnes, ...apercu(type, candidat.donnees), alertes, notes: c.notes, lignesSource: lignes.length, source: charge.origine, ...(charge.note ? { avertissement: charge.note } : {}) },
    provenance: charge.provenance,
  };
}

const provenanceVue = (user: Acteur, titre: string, forme: string, entrees: readonly string[], formule: string) =>
  declarerProvenance([faitCalcule({ outil: "render_view", acteur: user.id, libelle: titre, valeur: forme, entrees, transformation: "agrégation et mise en forme par le code (render_view)", formule: formule.slice(0, 300) })]);

export const VIEW_TOOLS: PowerTool[] = [
  {
    def: {
      name: "render_view",
      description:
        "MONTRE une représentation à l'écran, sous la réponse — composée par le code, jamais dessinée en texte. Dès que la personne demande un graphique, une évolution, "
        + "une répartition, une comparaison, un tableau de bord, un Gantt, une carte, un réseau, un arbre, ou qu'une réponse chiffrée se lit mieux en image. "
        + "FORMES : auto (le code choisit selon la question et les données), barres, barres_empilees, courbe, aires, nuage, histogramme, secteurs (≤ 6 parts), cascade "
        + "(variations, total calculé), entonnoir, heatmap, matrice, gantt, graphe, flux (Sankey), arbre, carte (lat/lon, schématique), cartes (indicateurs). "
        + "DONNÉES : la même « source » que run_analysis ({ source | outil+args | drive(+feuille) | sql | lignes }) — le code AGRÈGE : x = colonne de catégorie/temps, y = mesure(s), "
        + "serie = colonne qui pivote en séries ou en colonnes, agregat = somme|moyenne|compte|min|max ; gantt : label, debut, fin ; graphe/flux : de, a, poids ; arbre : parent, label ; carte : lat, lon. "
        + "Ou « donnees » déjà structurées pour une forme précise (noeuds+arcs, racine, lieux, cartes, taches, categories+series). "
        + "TABLEAU DE BORD : « tuiles » = [{ type, titre, x, y, serie, source? }] (≤ 6, source partagée si absente) → une grille. "
        + "Rend un résumé chiffré (forme, premières catégories et valeurs, alertes « TROMPEUR/DOUTEUX ») : le décrire en une phrase, ne pas recopier les chiffres — la figure est déjà à l'écran.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", description: `auto | ${VIZ_TYPES.join(" | ")}` },
          titre: { type: "string" },
          source: { type: "object", description: "{ source | outil+args | drive(+feuille) | sql | lignes } — comme run_analysis." },
          lignes: { type: "array", items: { type: "object" }, description: "Lignes déjà obtenues (marquées comme non relues à une source)." },
          donnees: { type: "object", description: "Données déjà structurées pour la forme (réseau, arbre, lieux, cartes, tâches, séries)." },
          question: { type: "string", description: "La question posée — sert au choix « auto »." },
          x: { type: "string" }, y: { type: "array", items: { type: "string" } }, serie: { type: "string" },
          agregat: { type: "string", enum: ["somme", "moyenne", "compte", "min", "max"] },
          tri: { type: "string", enum: ["valeur", "libelle", "aucun"] },
          label: { type: "string" }, detail: { type: "string" }, taille: { type: "string" }, groupe: { type: "string" }, progression: { type: "string" },
          debut: { type: "string" }, fin: { type: "string" },
          de: { type: "string" }, a: { type: "string" }, poids: { type: "string" }, parent: { type: "string" },
          lat: { type: "string" }, lon: { type: "string" },
          unite: { type: "string" }, note: { type: "string" }, raison: { type: "string" },
          axeYdepartZero: { type: "boolean" },
          tuiles: { type: "array", items: { type: "object" }, description: "Un mini-tableau de bord : une entrée par tuile, mêmes champs qu'une représentation seule." },
          colonnes: { type: "number", description: "2 ou 3 colonnes pour le tableau de bord." },
        },
      },
    },
    // Aucun droit propre : la SOURCE porte le sien (lecture relancée par `executePowerTool`, fichier sous
    // `canViewDrive`, SQL sous la vue globale). Représenter n'est pas lire.
    allowed: () => true,
    label: "Représentation à l'écran",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Représentation";
      if (Array.isArray(input.tuiles) && input.tuiles.length > 0) {
        const tuiles = input.tuiles.filter(isObj).slice(0, WORKSPACE_LIMITS.tuiles);
        const vues: Vue[] = [];
        const refus: string[] = [];
        for (const t of tuiles) {
          const v = await composerVue(t, input, user);
          if ("erreur" in v) refus.push(`${str(t, "titre") || `tuile ${vues.length + refus.length + 1}`} : ${v.erreur}`);
          else vues.push(v);
        }
        if (!vues.length) return JSON.stringify({ ok: false, erreur: "aucune tuile valide", tuilesRefusees: refus, formes: ["auto", ...VIZ_TYPES] });
        const colonnes = input.colonnes === 3 ? 3 : input.colonnes === 2 ? 2 : undefined;
        return JSON.stringify({
          ok: true, forme: "dashboard", titre, tuiles: vues.map((v) => v.resume),
          ...(refus.length ? { tuilesRefusees: refus } : {}),
          affichage: "le tableau de bord est rendu à l'écran sous la réponse : le présenter en une phrase par tuile, sans recopier les chiffres",
          _blocs: [{ kind: "dashboard", title: titre, colonnes, tuiles: vues.map((v) => v.bloc), note: strOuNull(input, "note") }],
          _blocsDecoratifs: true,
          _provenance: provenanceVue(user, titre, `tableau de bord · ${vues.length} tuile(s)`, [...new Set(vues.flatMap((v) => v.provenance))], JSON.stringify(tuiles.map((t) => ({ type: t.type, x: t.x, y: t.y, serie: t.serie })))),
        });
      }
      const v = await composerVue(input, null, user);
      if ("erreur" in v) return JSON.stringify({ ok: false, erreur: v.erreur, formes: ["auto", ...VIZ_TYPES] });
      return JSON.stringify({
        ok: true, ...v.resume,
        affichage: "la représentation est rendue à l'écran sous la réponse : la décrire en une phrase (forme, ce qu'elle montre, l'alerte s'il y en a), sans recopier les chiffres",
        _blocs: [v.bloc], _blocsDecoratifs: true,
        _provenance: provenanceVue(user, titre, String(v.resume.type ?? "représentation"), v.provenance, JSON.stringify({ type: input.type, x: input.x, y: input.y, serie: input.serie, agregat: input.agregat })),
      });
    },
  },
];
