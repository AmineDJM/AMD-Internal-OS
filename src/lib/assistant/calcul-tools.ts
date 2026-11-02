/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DE CALCUL (mandat 5 §39) — le chiffre est produit par le CODE, jamais par le modèle.
 *
 * Quatre outils, une frontière : RIEN ICI N'ÉCRIT, et aucun moteur ne lit la base — les données
 * arrivent par le bac à sable, qui porte le droit de leur source.
 *
 *   · `calcul_montecarlo`     100 000 tirages hors modèle : percentiles, probabilité de perte,
 *                             sensibilité (quel levier fait bouger le résultat), convergence.
 *   · `calcul_optimisation`   programmation linéaire et en nombres entiers (allocation, mélange,
 *                             affectation, sac à dos) avec PRIX MARGINAUX et goulots ; ou
 *                             satisfaction de contraintes logiques (plannings, répartitions).
 *   · `calcul_ordonnancement` chemin critique, marges, ressources, échéance tenue ou non.
 *   · `calcul_statistiques`   régressions, tests, corrélations, segmentation, ACP, anomalies,
 *                             séries temporelles et prévision validée hors échantillon.
 *
 * Chaque réponse porte sa RIGUEUR — hypothèses, limites, avertissements — parce qu'un P90 sans le
 * nombre de tirages, un optimum sans dire qu'il est entier, une régression sans « association,
 * pas cause » sont des chiffres qui ont l'air sûrs. Le modèle ne peut pas retirer ces phrases :
 * elles sont produites par les moteurs, à côté du résultat.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PowerTool } from "@/platform/ia/outil";
import { blocTableau, chargerLignes } from "@/lib/assistant/sandbox-tools";
import { construireViz } from "@/platform/ia/workspace/viz-block";
import { declarerProvenance, faitCalcule } from "@/platform/in-process/fabric/provenance";
import {
  type ContrainteCsp, type Loi, type ModeleMonteCarlo, type Programme, type ProblemeCsp, type Projet, type Rigueur,
  LOIS, TIRAGES_DEFAUT, TIRAGES_MAX,
  acp, analyserSerie, arrondi, correlations, decrireColonnes, detecterAnomalies, optimiser, ordonnancer, regresser,
  regresserLogistique, resoudreContraintes, resumerOptimum, resumerOrdonnancement, resumerSegmentation, resumerSerie,
  resumerSimulation, segmenter, simuler, testApparie, testIndependance, testMoyennes, testRangs,
} from "@/platform/in-process/calcul";

type Acteur = Parameters<PowerTool["run"]>[1];
type Ligne = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const num = (input: Record<string, unknown>, key: string): number | undefined => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** La rigueur est RENDUE, jamais résumée : c'est le seul endroit où elle est mise en forme. */
const rendreRigueur = (r: Rigueur) => ({
  hypotheses: r.hypotheses,
  limites: r.limites,
  ...(r.avertissements.length ? { avertissements: r.avertissements } : {}),
  consigne: "Reprendre les avertissements dans la réponse : un chiffre donné sans eux se lit comme une certitude qu'il n'est pas.",
});

/**
 * `estimation` distingue ce que les données CONTIENNENT de ce qu'elles SUGGÈRENT. Une somme,
 * une régression sur des points observés, un chemin critique décrivent ce qui EST ; un tirage
 * de Monte-Carlo et une prévision décrivent ce qui n'a pas encore eu lieu. Sans ce drapeau, la
 * calibration lisait un P90 comme une lecture de l'ERP et l'annonçait « FAIT VÉRIFIÉ ».
 */
const provenance = (user: Acteur, outil: string, libelle: string, valeur: number | string, entrees: readonly string[], transformation: string, formule: string, estimation = false) =>
  declarerProvenance([faitCalcule({ outil, acteur: user.id, libelle, valeur, entrees, transformation, formule: formule.slice(0, 300), estimation })]);

/** Un histogramme rendu à l'écran : le code compose la figure depuis les classes calculées. */
function blocHistogramme(titre: string, classes: readonly { de: number; a: number; n: number }[]): Record<string, unknown> | null {
  if (classes.length < 2) return null;
  const lignes = classes.map((c) => ({ classe: `${arrondi(c.de, 1)} → ${arrondi(c.a, 1)}`, effectif: c.n }));
  const c = construireViz({ type: "barres", x: "classe", y: ["effectif"] }, lignes);
  if ("erreur" in c) return null;
  return { kind: "viz", title: titre, type: "barres", donnees: c.donnees, axeYdepartZero: true, raison: "distribution simulée : la hauteur d'une classe est un effectif, l'axe part de zéro", alertes: [], note: null };
}

/** Un diagramme de Gantt depuis les tâches planifiées. */
function blocGantt(titre: string, taches: readonly { id: string; nom: string; debutPlanifie: number; finPlanifiee: number; critique: boolean }[]): Record<string, unknown> | null {
  if (!taches.length) return null;
  const lignes = taches.map((t) => ({ tache: t.nom, debut: t.debutPlanifie, fin: t.finPlanifiee, critique: t.critique ? "critique" : "avec marge" }));
  const c = construireViz({ type: "gantt", label: "tache", debut: "debut", fin: "fin", groupe: "critique" }, lignes);
  if ("erreur" in c) return null;
  return { kind: "viz", title: titre, type: "gantt", donnees: c.donnees, axeYdepartZero: false, raison: "un calendrier se lit en barres de durée", alertes: [], note: null };
}

const LOIS_TEXTE = LOIS.join(" | ");

export const CALCUL_TOOLS: PowerTool[] = [
  {
    def: {
      name: "calcul_montecarlo",
      description:
        "SIMULATION DE MONTE-CARLO hors modèle (jusqu'à " + TIRAGES_MAX.toLocaleString("fr-FR") + " tirages, " + TIRAGES_DEFAUT.toLocaleString("fr-FR") + " par défaut) : "
        + "quand une décision dépend de quantités INCERTAINES (volume, prix, délai, taux de change, taux de réussite), ne pas raisonner sur des moyennes — simuler. "
        + "Déclarer les ENTRÉES (chacune une loi : " + LOIS_TEXTE + "), les CONSTANTES, les FORMULES (une par ligne de calcul, elles peuvent se référencer entre elles), "
        + "les CORRÉLATIONS entre entrées et les SEUILS dont on veut la probabilité. "
        + "Rend : moyenne, médiane, écart-type, P1…P99, probabilité de perte et de chaque seuil, SENSIBILITÉ (quelle entrée fait bouger le résultat), "
        + "convergence (à quelle précision la moyenne est connue), et le PIÈGE DES MOYENNES quand le modèle n'est pas linéaire. Même graine → mêmes chiffres.",
      input_schema: {
        type: "object",
        properties: {
          entrees: { type: "object", description: `Les quantités incertaines : { nom: { loi: "${LOIS_TEXTE}", … } }. normale{moyenne,ecartType} · lognormale{moyenne,ecartType} (positive, asymétrique) · uniforme{min,max} · triangulaire{min,mode,max} · pert{min,mode,max} (avis d'expert) · discrete{valeurs:[{valeur,p}]} · bernoulli{p,siVrai,siFaux} · poisson{lambda} · constante{valeur}.` },
          constantes: { type: "object", description: "Les valeurs certaines : { nom: nombre }." },
          formules: { type: "object", description: "{ nom: \"expression\" } — opérateurs + - * / ^ %, comparaisons, et/ou/non, fonctions min max somme moyenne abs sqrt exp ln round floor ceil si(cond,a,b) borner. Une formule peut utiliser une autre formule." },
          sortie: { type: "string", description: "La formule principale (sensibilité et seuils). La dernière par défaut." },
          correlations: { type: "array", items: { type: "object" }, description: "[{a, b, rho}] — rho strictement entre -1 et 1. Sans elles, les entrées sont supposées INDÉPENDANTES et le risque est sous-estimé." },
          seuils: { type: "array", items: { type: "object" }, description: "[{sens: 'inferieur'|'superieur', valeur, sortie?, libelle?}] — la probabilité de chacun est calculée." },
          tirages: { type: "number", description: `Défaut ${TIRAGES_DEFAUT}, plafond ${TIRAGES_MAX}.` },
          graine: { description: "Pour rejouer exactement la même simulation." },
          titre: { type: "string" },
        },
        required: ["entrees", "formules"],
      },
    },
    // Aucun droit propre : les moteurs ne lisent rien, ils calculent sur des nombres déclarés.
    allowed: () => true,
    label: "Simulation de Monte-Carlo",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Simulation";
      const modele: ModeleMonteCarlo = {
        entrees: (isObj(input.entrees) ? input.entrees : {}) as Record<string, Loi>,
        constantes: isObj(input.constantes) ? (input.constantes as Record<string, number>) : undefined,
        formules: (isObj(input.formules) ? input.formules : {}) as Record<string, string>,
        sortie: str(input, "sortie") || undefined,
        correlations: Array.isArray(input.correlations) ? (input.correlations.filter(isObj) as unknown as ModeleMonteCarlo["correlations"]) : undefined,
        seuils: Array.isArray(input.seuils) ? (input.seuils.filter(isObj) as unknown as ModeleMonteCarlo["seuils"]) : undefined,
      };
      const r = simuler(modele, { tirages: num(input, "tirages"), graine: (input.graine as string | number) ?? 42 });
      if (!r.ok) return JSON.stringify({ ok: false, erreur: r.erreur, details: r.details });
      const s = r.sorties[r.sortie]!;
      const blocs = [
        blocTableau(`${titre} — distribution`, Object.entries(r.sorties).map(([nom, d]) => ({
          sortie: nom, moyenne: arrondi(d.moyenne, 2), mediane: arrondi(d.mediane, 2), ecartType: arrondi(d.ecartType, 2),
          P10: arrondi(d.percentiles.P10 ?? d.min, 2), P50: arrondi(d.percentiles.P50 ?? d.mediane, 2), P90: arrondi(d.percentiles.P90 ?? d.max, 2),
          min: arrondi(d.min, 2), max: arrondi(d.max, 2),
        }))),
        blocHistogramme(`${titre} — ${r.sortie}`, s.histogramme),
        r.sensibilite.length ? blocTableau(`${titre} — leviers`, r.sensibilite.map((x) => ({ entree: x.entree, "part de la variance %": arrondi(x.contributionVariancePourcent, 1), correlation: arrondi(x.spearman, 3), "sortie décile bas": arrondi(x.sortieBasDecile, 2), "sortie décile haut": arrondi(x.sortieHautDecile, 2) }))) : null,
      ].filter((b): b is Record<string, unknown> => Boolean(b));
      return JSON.stringify({
        ok: true, titre, tirages: r.tirages, graine: r.graine, sortie: r.sortie, ms: r.ms,
        rendu: "à l'écran sous la réponse : le tableau des distributions, l'histogramme et les leviers — ne pas les recopier",
        resume: resumerSimulation(r),
        distributions: Object.fromEntries(Object.entries(r.sorties).map(([nom, d]) => [nom, {
          moyenne: arrondi(d.moyenne, 4), mediane: arrondi(d.mediane, 4), ecartType: arrondi(d.ecartType, 4),
          min: arrondi(d.min, 4), max: arrondi(d.max, 4),
          percentiles: Object.fromEntries(Object.entries(d.percentiles).map(([k, v]) => [k, arrondi(v, 4)])),
          valeurSurLesMoyennes: d.valeurDeterministe === null ? null : arrondi(d.valeurDeterministe, 4),
          probabiliteNegatif: arrondi(d.pNegatif, 4),
          coefficientVariationPourcent: d.cvPourcent === null ? null : arrondi(d.cvPourcent, 1),
        }])),
        probabilites: r.probabilites.map((p) => ({ libelle: p.libelle, probabilite: arrondi(p.p, 4), pourcent: `${arrondi(p.p * 100, 2)} %`, tirages: p.n })),
        sensibilite: r.sensibilite.map((x) => ({ entree: x.entree, partVariancePourcent: arrondi(x.contributionVariancePourcent, 1), correlationRang: arrondi(x.spearman, 3), amplitude: arrondi(x.amplitude, 4) })),
        convergence: { moyenneA95: [arrondi(r.convergence.intervalle95Moyenne[0], 4), arrondi(r.convergence.intervalle95Moyenne[1], 4)], p90A95: [arrondi(r.convergence.intervalle95P90[0], 4), arrondi(r.convergence.intervalle95P90[1], 4)] },
        entrees: r.entrees.map((e) => ({ nom: e.nom, loi: e.loi, esperance: e.esperance === null ? null : arrondi(e.esperance, 4), moyenneSimulee: arrondi(e.moyenneSimulee, 4) })),
        ...(r.tiragesInvalides ? { tiragesEcartes: r.tiragesInvalides } : {}),
        rigueur: rendreRigueur(r.rigueur),
        _blocs: blocs, _blocsDecoratifs: true,
        _provenance: provenance(user, "calcul_montecarlo", `${titre} — ${r.sortie}`, `moyenne ${arrondi(s.moyenne, 2)}, P10 ${arrondi(s.percentiles.P10 ?? s.min, 2)}, P90 ${arrondi(s.percentiles.P90 ?? s.max, 2)}`,
          r.entrees.map((e) => `${e.nom} ~ ${e.loi}`), `simulation de Monte-Carlo, ${r.tirages} tirages, graine ${r.graine}`, JSON.stringify(modele.formules), true),
      });
    },
  },

  {
    def: {
      name: "calcul_optimisation",
      description:
        "OPTIMISATION SOUS CONTRAINTES — deux moteurs selon la nature de la décision. "
        + "(1) mode « lineaire » (défaut) : maximiser ou minimiser une combinaison de QUANTITÉS sous des contraintes de capacité, de budget, de composition "
        + "(production, mélange au moindre coût, allocation de budget, sac à dos, affectation). Les variables peuvent être continues, entières ou binaires (0/1). "
        + "Rend l'optimum, les PRIX MARGINAUX (« une heure de plus sur la ligne A rapporte X »), les contraintes saturées et le jeu restant. "
        + "INFAISABLE et NON BORNÉ sont des réponses argumentées, pas des pannes. "
        + "(2) mode « contraintes » : affecter des CHOIX sous des règles logiques (qui prend quelle garde, quel dossier à qui, quel créneau) — "
        + "règles : toutesDifferentes, egales, differentes, interdit, impose, auPlus, auMoins, pairesInterdites, siAlors. "
        + "Sans solution, le code NOMME les règles dont dépend l'impossibilité.",
      input_schema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["lineaire", "contraintes"], description: "lineaire (quantités, défaut) ou contraintes (choix logiques)." },
          sens: { type: "string", enum: ["max", "min"], description: "Mode linéaire : maximiser ou minimiser." },
          variables: { type: "array", items: { type: "object" }, description: "Mode linéaire : [{nom, objectif, min?, max?, type?: 'continue'|'entiere'|'binaire'}]. Mode contraintes : [{nom, domaine: [valeurs], preferees?: [valeurs]}]." },
          contraintes: { type: "array", items: { type: "object" }, description: "Mode linéaire : [{nom?, coefficients: {variable: coef}, comparateur: '<='|'>='|'=', valeur}]. Mode contraintes : [{type: 'toutesDifferentes'|'egales'|'differentes'|'interdit'|'impose'|'auPlus'|'auMoins'|'pairesInterdites'|'siAlors', …, nom?}]." },
          titre: { type: "string" },
        },
        required: ["variables"],
      },
    },
    allowed: () => true,
    label: "Optimisation sous contraintes",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Optimisation";
      const mode = str(input, "mode").toLowerCase() === "contraintes" ? "contraintes" : "lineaire";
      const variables = Array.isArray(input.variables) ? input.variables.filter(isObj) : [];
      const contraintes = Array.isArray(input.contraintes) ? input.contraintes.filter(isObj) : [];

      if (mode === "contraintes") {
        const p: ProblemeCsp = {
          variables: variables as unknown as ProblemeCsp["variables"],
          contraintes: contraintes as unknown as ContrainteCsp[],
        };
        const r = resoudreContraintes(p);
        if (!r.ok) {
          return JSON.stringify({
            ok: false, mode, titre, statut: r.statut, erreur: r.erreur,
            reglesEnCause: r.contraintesEnCause,
            affectationPartielle: r.meilleurePartielle, variablesBloquees: r.variablesBloquees,
            essais: r.noeuds, rigueur: rendreRigueur(r.rigueur),
            consigne: r.statut === "IMPOSSIBLE" ? "L'impossibilité est DÉMONTRÉE : dire quelle règle relâcher, ne pas proposer une affectation qui viole une règle." : undefined,
          });
        }
        const lignes = Object.entries(r.affectation).map(([variable, valeur]) => ({ variable, valeur: String(valeur), forcee: r.forcees.includes(variable) ? "imposée par les règles" : "" }));
        return JSON.stringify({
          ok: true, mode, titre, ms: r.ms, essais: r.noeuds,
          rendu: "à l'écran sous la réponse : le tableau des affectations — ne pas le recopier",
          affectation: r.affectation,
          valeursForcees: r.forcees,
          domainesReduits: r.domainesReduits,
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [blocTableau(titre, lignes)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_optimisation", titre, `${Object.keys(r.affectation).length} affectation(s)`, variables.map((v) => String(v.nom)), `satisfaction de contraintes (${contraintes.length} règles)`, JSON.stringify(contraintes).slice(0, 300)),
        });
      }

      const programme: Programme = {
        sens: str(input, "sens").toLowerCase() === "min" ? "min" : "max",
        variables: variables as unknown as Programme["variables"],
        contraintes: contraintes as unknown as Programme["contraintes"],
      };
      const r = optimiser(programme);
      if (!r.ok) {
        return JSON.stringify({
          ok: false, mode, titre, statut: r.statut, erreur: r.erreur, details: r.details,
          consigne: r.statut === "INFAISABLE"
            ? "Dire QUELLE contrainte relâcher et de combien ; ne jamais proposer une solution qui en viole une."
            : r.statut === "NON_BORNE" ? "Il manque une capacité ou une borne : la demander plutôt que d'inventer un chiffre." : undefined,
        });
      }
      const lignes = Object.entries(r.valeurs).map(([variable, valeur]) => ({ variable, valeur: arrondi(valeur, 4) }));
      const blocsContraintes = r.contraintes.map((c) => ({
        contrainte: c.nom, limite: arrondi(c.valeur, 3), atteint: arrondi(c.atteinte, 3), jeu: arrondi(c.jeu, 3),
        etat: c.saturee ? "SATURÉE" : "marge", "prix marginal": c.prixMarginal === null ? "—" : arrondi(c.prixMarginal, 4),
      }));
      return JSON.stringify({
        ok: true, mode, titre, statut: r.statut, sens: r.sens, ms: r.ms,
        rendu: "à l'écran sous la réponse : les décisions et l'état des contraintes — ne pas les recopier",
        resume: resumerOptimum(r),
        objectif: arrondi(r.objectif, 4),
        valeurs: Object.fromEntries(Object.entries(r.valeurs).map(([k, v]) => [k, arrondi(v, 6)])),
        contraintes: blocsContraintes,
        goulots: r.goulots.map((g) => ({ contrainte: g.nom, prixMarginal: arrondi(g.prixMarginal, 4), lecture: g.interpretation })),
        entier: r.entier,
        ...(r.ecartOptimalite !== null ? { ecartOptimalitePourcent: arrondi(r.ecartOptimalite * 100, 4) } : {}),
        rigueur: rendreRigueur(r.rigueur),
        _blocs: [blocTableau(`${titre} — décisions`, lignes), blocTableau(`${titre} — contraintes`, blocsContraintes)].filter((b): b is Record<string, unknown> => Boolean(b)),
        _blocsDecoratifs: true,
        _provenance: provenance(user, "calcul_optimisation", titre, `objectif ${arrondi(r.objectif, 2)}`, variables.map((v) => String(v.nom)), `programmation linéaire${r.entier ? " en nombres entiers" : ""} (${r.contraintes.length} contraintes)`, JSON.stringify(programme.contraintes).slice(0, 300)),
      });
    },
  },

  {
    def: {
      name: "calcul_ordonnancement",
      description:
        "ORDONNANCEMENT DE PROJET : à partir des tâches, de leurs durées, de leurs dépendances et des personnes qui les portent, calcule le CHEMIN CRITIQUE "
        + "(la séquence sans marge, où un jour de retard est un jour de retard sur la fin), les dates au plus tôt et au plus tard, la marge de chaque tâche, "
        + "et le calendrier réel une fois les RESSOURCES prises en compte (une personne ne fait qu'une chose à la fois). "
        + "Dit explicitement quand c'est une ressource, et non la logique du projet, qui allonge le délai, et si une échéance tient. "
        + "Une dépendance circulaire est une réponse argumentée, pas une panne.",
      input_schema: {
        type: "object",
        properties: {
          taches: { type: "array", items: { type: "object" }, description: "[{id, nom?, duree, apres?: [ids], ressources?: [noms], priorite?, auPlusTot?}] — la durée dans l'unité de votre choix, la même partout (jours en général)." },
          capacites: { type: "object", description: "{ ressource: nombre de tâches simultanées } — 1 par défaut." },
          echeance: { type: "number", description: "L'horizon à tenir, dans la même unité. Le dépassement est chiffré." },
          titre: { type: "string" },
        },
        required: ["taches"],
      },
    },
    allowed: () => true,
    label: "Ordonnancement de projet",
    run: async (input, user) => {
      const titre = str(input, "titre") || "Planning";
      const projet: Projet = {
        taches: (Array.isArray(input.taches) ? input.taches.filter(isObj) : []) as unknown as Projet["taches"],
        capacites: isObj(input.capacites) ? (input.capacites as Record<string, number>) : undefined,
        echeance: num(input, "echeance"),
      };
      const r = ordonnancer(projet);
      if (!r.ok) return JSON.stringify({ ok: false, titre, erreur: r.erreur, details: r.details });
      const lignes = r.taches.map((t) => ({
        tache: t.nom, duree: t.duree, "début": arrondi(t.debutPlanifie, 2), fin: arrondi(t.finPlanifiee, 2),
        marge: arrondi(t.margeTotale, 2), etat: t.critique ? "CRITIQUE" : "marge", ressources: t.ressources.join(", ") || "—",
        ...(t.attenteRessource > 1e-9 ? { "attente ressource": arrondi(t.attenteRessource, 2) } : {}),
      }));
      return JSON.stringify({
        ok: true, titre, ms: r.ms,
        rendu: "à l'écran sous la réponse : le calendrier et le diagramme — ne pas les recopier",
        resume: resumerOrdonnancement(r),
        dureeLogique: arrondi(r.dureeChemin, 3),
        dureeReelle: arrondi(r.dureeAvecRessources, 3),
        retardDuAuxRessources: arrondi(r.retardRessources, 3),
        cheminCritique: r.cheminCritique,
        taches: r.taches.map((t) => ({
          id: t.id, nom: t.nom, duree: t.duree,
          auPlusTot: [arrondi(t.debutAuPlusTot, 3), arrondi(t.finAuPlusTot, 3)],
          auPlusTard: [arrondi(t.debutAuPlusTard, 3), arrondi(t.finAuPlusTard, 3)],
          margeTotale: arrondi(t.margeTotale, 3), margeLibre: arrondi(t.margeLibre, 3), critique: t.critique,
          planifie: [arrondi(t.debutPlanifie, 3), arrondi(t.finPlanifiee, 3)],
        })),
        chargeRessources: r.chargeRessources.map((c) => ({ ressource: c.ressource, occupation: arrondi(c.occupation, 2), tauxPourcent: arrondi(c.tauxPourcent, 1), taches: c.taches })),
        goulots: r.goulots,
        echeance: r.echeance ? { valeur: r.echeance.valeur, tenue: r.echeance.tenue, retard: arrondi(r.echeance.retard, 3) } : null,
        rigueur: rendreRigueur(r.rigueur),
        _blocs: [blocTableau(`${titre} — tâches`, lignes), blocGantt(titre, r.taches)].filter((b): b is Record<string, unknown> => Boolean(b)),
        _blocsDecoratifs: true,
        _provenance: provenance(user, "calcul_ordonnancement", titre, `${arrondi(r.dureeAvecRessources, 2)} (${r.taches.length} tâches)`, r.taches.map((t) => t.nom).slice(0, 40), `chemin critique et ordonnancement sous ressources`, r.cheminCritique.join(" → ")),
      });
    },
  },

  {
    def: {
      name: "calcul_statistiques",
      description:
        "BANC STATISTIQUE ET D'APPRENTISSAGE sur des données LUES (mêmes sources que run_analysis : « source », « outil »+args, « drive », « sql », « lignes »). "
        + "analyses : « decrire » (quartiles, asymétrie, manquantes, aberrantes) · « correlations » (Pearson + Spearman, significativité, mise en garde sur la pêche aux corrélations) · "
        + "« regression » (moindres carrés multiples : coefficients, intervalles, p-values, R², R² en validation croisée, VIF de colinéarité, hétéroscédasticité, autocorrélation) · "
        + "« regression_logistique » (cible 0/1 : rapports de cotes, AUC, matrice de confusion) · « test » (comparaison de deux groupes : Welch, apparié, rangs de Mann-Whitney, χ² d'indépendance) · "
        + "« segmentation » (k-moyennes, k choisi par la silhouette, groupes caractérisés en écarts-types) · « acp » (composantes principales, redondance des variables) · "
        + "« anomalies » (écart robuste, profil multivarié, isolement local) · « serie » (tendance, saisonnalité détectée, ruptures, PRÉVISION avec intervalle validée hors échantillon). "
        + "Chaque résultat porte ses hypothèses, ses limites et ses avertissements : les REPRENDRE dans la réponse.",
      input_schema: {
        type: "object",
        properties: {
          analyse: { type: "string", enum: ["decrire", "correlations", "regression", "regression_logistique", "test", "segmentation", "acp", "anomalies", "serie"] },
          source: { type: "object", description: "{ source | outil+args | drive(+feuille) | sql | lignes } — d'où viennent les données." },
          colonnes: { type: "array", items: { type: "string" }, description: "Les colonnes à utiliser (toutes les numériques par défaut)." },
          cible: { type: "string", description: "regression / regression_logistique : la variable à expliquer." },
          predicteurs: { type: "array", items: { type: "string" }, description: "regression : les variables explicatives." },
          test: { type: "string", enum: ["moyennes", "apparie", "rangs", "independance"], description: "analyse « test » : lequel." },
          groupe: { type: "string", description: "analyse « test » : la colonne qui sépare les deux groupes (ou donner « a » et « b »)." },
          mesure: { type: "string", description: "analyse « test » : la colonne mesurée." },
          a: { type: "array", description: "analyse « test » : le premier échantillon (nombres), si pas de colonnes." },
          b: { type: "array", description: "analyse « test » : le second échantillon." },
          table: { type: "array", description: "test d'indépendance : le tableau de contingence [[a,b],[c,d]] (des COMPTAGES)." },
          k: { type: "number", description: "segmentation : le nombre de groupes imposé (sinon choisi par la silhouette)." },
          valeur: { type: "string", description: "serie : la colonne des valeurs." },
          instant: { type: "string", description: "serie : la colonne des dates ou périodes." },
          periode: { description: "serie : la période saisonnière (12 = mensuel annuel, 4 = trimestriel, 7 = hebdomadaire). Absente = cherchée ; null = aucune." },
          horizon: { type: "number", description: "serie : combien de pas à prévoir." },
          sensibilite: { type: "string", enum: ["prudente", "normale", "large"], description: "anomalies : le seuil de signalement." },
          titre: { type: "string" },
        },
        required: ["analyse"],
      },
    },
    allowed: () => true,
    label: "Statistiques et apprentissage",
    run: async (input, user) => {
      const analyse = str(input, "analyse").toLowerCase();
      const titre = str(input, "titre") || "Analyse statistique";
      const colonnes = Array.isArray(input.colonnes) ? input.colonnes.filter((c): c is string => typeof c === "string") : undefined;
      const nombresDe = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : []);

      // Le test d'indépendance et les tests sur échantillons donnés en clair n'ont pas besoin de source.
      if (analyse === "test") {
        const quel = str(input, "test").toLowerCase() || "moyennes";
        if (quel === "independance") {
          const table = Array.isArray(input.table) ? input.table.map((r) => nombresDe(r)) : [];
          const t = testIndependance(table);
          if ("erreur" in t) return JSON.stringify({ ok: false, erreur: t.erreur });
          return JSON.stringify({ ok: true, titre, test: t.nom, statistique: arrondi(t.statistique, 4), ddl: t.ddl, pValeur: arrondi(t.pValeur, 6), significatif: t.significatif, tailleEffet: t.tailleEffet, conclusion: t.conclusion, rigueur: rendreRigueur(t.rigueur), _provenance: provenance(user, "calcul_statistiques", titre, t.conclusion, ["tableau de contingence fourni"], "test du χ² d'indépendance", JSON.stringify(table)) });
        }
        let a = nombresDe(input.a), b = nombresDe(input.b);
        let origine = "échantillons fournis dans la conversation";
        let entrees = ["valeurs fournies par la conversation"];
        if ((!a.length || !b.length) && (isObj(input.source) || Array.isArray(input.lignes))) {
          const charge = await chargerLignes(input, user);
          if ("erreur" in charge) return JSON.stringify({ ok: false, erreur: charge.erreur });
          const mesure = str(input, "mesure"), groupe = str(input, "groupe");
          if (!mesure || !groupe) return JSON.stringify({ ok: false, erreur: "Donner « mesure » (la colonne mesurée) et « groupe » (la colonne qui sépare les deux groupes), ou les échantillons « a » et « b »." });
          const valeursParGroupe = new Map<string, number[]>();
          for (const l of charge.lignes) {
            const g = String(l[groupe] ?? "");
            const v = Number(l[mesure]);
            if (!g || !Number.isFinite(v)) continue;
            if (!valeursParGroupe.has(g)) valeursParGroupe.set(g, []);
            valeursParGroupe.get(g)!.push(v);
          }
          const groupes = [...valeursParGroupe.entries()].sort((x, y) => y[1].length - x[1].length);
          if (groupes.length < 2) return JSON.stringify({ ok: false, erreur: `La colonne « ${groupe} » ne sépare pas deux groupes exploitables (${groupes.length} trouvé(s)).` });
          if (groupes.length > 2) return JSON.stringify({ ok: false, erreur: `« ${groupe} » a ${groupes.length} valeurs distinctes : un test à deux groupes en attend deux. Filtrer d'abord, ou utiliser une régression.` });
          a = groupes[0]![1]; b = groupes[1]![1];
          origine = `${charge.origine} — ${groupes[0]![0]} (${a.length}) vs ${groupes[1]![0]} (${b.length})`;
          entrees = charge.provenance;
        }
        const t = quel === "apparie" ? testApparie(a, b) : quel === "rangs" ? testRangs(a, b) : testMoyennes(a, b);
        if ("erreur" in t) return JSON.stringify({ ok: false, erreur: t.erreur });
        return JSON.stringify({
          ok: true, titre, source: origine, test: t.nom,
          statistique: arrondi(t.statistique, 4), ddl: t.ddl === null ? null : arrondi(t.ddl, 2),
          pValeur: arrondi(t.pValeur, 6), significatif: t.significatif,
          tailleEffet: t.tailleEffet ? { ...t.tailleEffet, valeur: arrondi(t.tailleEffet.valeur, 4) } : null,
          intervalle95: t.intervalle95 ? [arrondi(t.intervalle95[0], 4), arrondi(t.intervalle95[1], 4)] : null,
          conclusion: t.conclusion, rigueur: rendreRigueur(t.rigueur),
          _provenance: provenance(user, "calcul_statistiques", titre, t.conclusion, entrees, t.nom, `p = ${arrondi(t.pValeur, 6)}`),
        });
      }

      const charge = await chargerLignes(input, user);
      if ("erreur" in charge) return JSON.stringify({ ok: false, erreur: charge.erreur });
      const lignes = charge.lignes as Ligne[];
      const base = { titre, source: charge.origine, lignesLues: lignes.length, ...(charge.note ? { avertissement: charge.note } : {}) };

      if (analyse === "decrire") {
        const d = decrireColonnes(lignes, colonnes);
        if (!d.length) return JSON.stringify({ ok: false, ...base, erreur: "Aucune colonne numérique exploitable." });
        const tab = d.map((c) => ({ colonne: c.colonne, n: c.n, manquantes: c.manquantes, moyenne: arrondi(c.moyenne, 3), "écart-type": arrondi(c.ecartType, 3), min: arrondi(c.min, 3), Q1: arrondi(c.q1, 3), "médiane": arrondi(c.mediane, 3), Q3: arrondi(c.q3, 3), max: arrondi(c.max, 3), aberrantes: c.aberrantes }));
        return JSON.stringify({
          ok: true, ...base, colonnes: tab,
          note: d.some((c) => Math.abs(c.asymetrie) > 1) ? "Distribution(s) fortement asymétrique(s) : la moyenne y est trompeuse, citer la médiane." : undefined,
          asymetries: d.map((c) => ({ colonne: c.colonne, asymetrie: arrondi(c.asymetrie, 3) })),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, `${d.length} colonne(s) décrite(s)`, charge.provenance, "statistiques descriptives", "quartiles, asymétrie, aberrantes"),
        });
      }

      if (analyse === "correlations") {
        const { liaisons, rigueur } = correlations(lignes, colonnes);
        if (!liaisons.length) return JSON.stringify({ ok: false, ...base, erreur: "Pas assez de colonnes numériques appariées pour une corrélation." });
        const tab = liaisons.slice(0, 40).map((l) => ({ "variable A": l.a, "variable B": l.b, pearson: arrondi(l.pearson, 3), spearman: arrondi(l.spearman, 3), n: l.n, "p-value": arrondi(l.pValeur, 5), significatif: l.significatif ? "oui" : "non" }));
        return JSON.stringify({
          ok: true, ...base, liaisons: tab, rigueur: rendreRigueur(rigueur),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, `${liaisons.length} paire(s), plus forte ${liaisons[0]!.a}↔${liaisons[0]!.b} r=${arrondi(liaisons[0]!.pearson, 3)}`, charge.provenance, "corrélations de Pearson et Spearman", "r, ρ, p-value"),
        });
      }

      if (analyse === "regression" || analyse === "regression_logistique") {
        const cible = str(input, "cible");
        if (!cible) return JSON.stringify({ ok: false, ...base, erreur: "Donner « cible » : la variable à expliquer." });
        const predicteurs = Array.isArray(input.predicteurs) ? input.predicteurs.filter((p): p is string => typeof p === "string") : (colonnes ?? [...new Set(lignes.flatMap((l) => Object.keys(l)))]).filter((c) => c !== cible);
        if (analyse === "regression_logistique") {
          const r = regresserLogistique(lignes, cible, predicteurs);
          if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
          const tab = r.coefficients.map((c) => ({ variable: c.nom, coefficient: arrondi(c.valeur, 4), "rapport de cotes": arrondi(c.rapportDeCotes, 3), "erreur type": arrondi(c.erreurType, 4), z: arrondi(c.t, 3), "p-value": arrondi(c.pValeur, 5), significatif: c.significatif ? "oui" : "non" }));
          return JSON.stringify({
            ok: true, ...base, type: "logistique", cible, n: r.n, positifs: r.positifs,
            coefficients: tab, constante: r.constante ? arrondi(r.constante.valeur, 4) : null,
            auc: arrondi(r.auc, 4), pseudoR2: arrondi(r.pseudoR2, 4), exactitude: arrondi(r.exactitude, 4),
            matriceConfusion: r.matriceConfusion, convergence: r.convergence,
            lignesEcartees: r.nettoyage.lignesIncompletes,
            rigueur: rendreRigueur(r.rigueur),
            _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
            _provenance: provenance(user, "calcul_statistiques", `${titre} — ${cible}`, `AUC ${arrondi(r.auc, 3)} sur ${r.n} observations`, charge.provenance, "régression logistique (Newton-Raphson)", `${cible} ~ ${predicteurs.join(" + ")}`),
          });
        }
        const r = regresser(lignes, cible, predicteurs);
        if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur, details: r.details });
        const tab = r.coefficients.map((c) => ({ variable: c.nom, coefficient: arrondi(c.valeur, 4), "IC 95 % bas": arrondi(c.intervalle95[0], 4), "IC 95 % haut": arrondi(c.intervalle95[1], 4), t: arrondi(c.t, 3), "p-value": arrondi(c.pValeur, 5), significatif: c.significatif ? "oui" : "non", VIF: c.vif === null ? "—" : c.vif === Infinity ? "∞" : arrondi(c.vif, 2) }));
        return JSON.stringify({
          ok: true, ...base, type: "lineaire", cible, n: r.n,
          coefficients: tab, constante: r.constante ? { valeur: arrondi(r.constante.valeur, 4), "p-value": arrondi(r.constante.pValeur, 5) } : null,
          r2: arrondi(r.r2, 4), r2Ajuste: arrondi(r.r2Ajuste, 4),
          r2ValidationCroisee: r.r2ValidationCroisee === null ? null : arrondi(r.r2ValidationCroisee, 4),
          erreurStandardResidu: arrondi(r.erreurStandardResidu, 4),
          f: arrondi(r.f, 3), pValeurGlobale: arrondi(r.pValeurGlobale, 6),
          durbinWatson: arrondi(r.durbinWatson, 3), breuschPaganP: r.breuschPaganP === null ? null : arrondi(r.breuschPaganP, 5),
          nettoyage: r.nettoyage,
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", `${titre} — ${cible}`, `R² ${arrondi(r.r2, 3)} sur ${r.n} observations`, charge.provenance, "régression linéaire (moindres carrés)", `${cible} ~ ${predicteurs.join(" + ")}`),
        });
      }

      if (analyse === "segmentation") {
        const r = segmenter(lignes, { colonnes, k: num(input, "k") });
        if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const tab = r.groupes.map((g) => ({
          groupe: g.numero, taille: g.taille,
          caracteristiques: g.signature.filter((s) => Math.abs(s.ecartsTypes) > 0.3).map((s) => `${s.colonne} ${s.ecartsTypes > 0 ? "+" : ""}${arrondi(s.ecartsTypes, 2)} σ`).join(", ") || "proche de la moyenne",
          ...Object.fromEntries(Object.entries(g.centre).slice(0, 4).map(([k, v]) => [k, arrondi(v, 2)])),
        }));
        return JSON.stringify({
          ok: true, ...base, k: r.k, silhouette: arrondi(r.silhouette, 4), colonnesUtilisees: r.colonnes,
          resume: resumerSegmentation(r),
          groupes: r.groupes.map((g) => ({ numero: g.numero, taille: g.taille, centre: Object.fromEntries(Object.entries(g.centre).map(([k, v]) => [k, arrondi(v, 3)])), signature: g.signature.map((s) => ({ colonne: s.colonne, ecartsTypes: arrondi(s.ecartsTypes, 2) })), exemples: g.membres.slice(0, 5) })),
          kTeste: r.kTeste.map((x) => ({ k: x.k, silhouette: arrondi(x.silhouette, 3) })),
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, `${r.k} groupes (silhouette ${arrondi(r.silhouette, 3)})`, charge.provenance, "k-moyennes sur variables centrées-réduites", r.colonnes.join(", ")),
        });
      }

      if (analyse === "acp") {
        const r = acp(lignes, colonnes);
        if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const tab = r.composantes.map((c) => ({
          composante: `C${c.numero}`, "variance %": arrondi(c.varianceExpliqueePourcent, 1), "cumul %": arrondi(c.cumulPourcent, 1),
          "portée par": c.poids.slice(0, 3).map((p) => `${p.colonne} ${arrondi(p.poids, 2)}`).join(", "),
        }));
        return JSON.stringify({
          ok: true, ...base, composantes: r.composantes.map((c) => ({ numero: c.numero, variancePourcent: arrondi(c.varianceExpliqueePourcent, 2), cumulPourcent: arrondi(c.cumulPourcent, 2), poids: c.poids.map((p) => ({ colonne: p.colonne, poids: arrondi(p.poids, 3) })) })),
          composantesPour90: r.composantesPour90, colonnesUtilisees: r.colonnes,
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, `${r.composantesPour90} composante(s) pour 90 % de l'information`, charge.provenance, "analyse en composantes principales (matrice de corrélation)", r.colonnes.join(", ")),
        });
      }

      if (analyse === "anomalies") {
        const sens = str(input, "sensibilite").toLowerCase();
        const r = detecterAnomalies(lignes, { colonnes, sensibilite: sens === "prudente" || sens === "large" ? sens : "normale" });
        if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const tab = r.anomalies.slice(0, 40).map((a) => ({ ligne: a.index + 1, score: arrondi(a.score, 2), methodes: a.methodes.join(" + "), raison: a.raisons[0] ?? "", ...Object.fromEntries(Object.entries(a.valeurs).slice(0, 3).map(([k, v]) => [k, arrondi(v, 2)])) }));
        return JSON.stringify({
          ok: true, ...base, observations: r.n, signalees: r.anomalies.length, colonnesUtilisees: r.colonnes, seuils: r.seuils,
          anomalies: r.anomalies.slice(0, 50).map((a) => ({ ligne: a.index + 1, score: arrondi(a.score, 3), methodes: a.methodes, raisons: a.raisons, valeurs: Object.fromEntries(Object.entries(a.valeurs).map(([k, v]) => [k, arrondi(v, 3)])) })),
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [blocTableau(titre, tab)].filter(Boolean), _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, `${r.anomalies.length} signalement(s) sur ${r.n}`, charge.provenance, "écart robuste, distance de Mahalanobis, isolement local", `seuil z ${r.seuils.zModifie}`),
        });
      }

      if (analyse === "serie") {
        const colValeur = str(input, "valeur"), colInstant = str(input, "instant");
        const points = lignes.map((l) => ({
          valeur: colValeur ? l[colValeur] : (l.valeur ?? l.montant ?? l.value ?? l.total),
          instant: colInstant ? l[colInstant] : (l.instant ?? l.date ?? l.periode ?? l.mois),
        })).filter((p) => p.valeur !== undefined);
        if (!points.length) return JSON.stringify({ ok: false, ...base, erreur: "Aucune valeur : donner « valeur » (la colonne des montants) et « instant » (celle des dates)." });
        const periodeBrute = input.periode;
        const r = analyserSerie(points as Ligne[], {
          ...(periodeBrute === undefined ? {} : { periode: periodeBrute === null ? null : Number(periodeBrute) }),
          horizon: num(input, "horizon"),
        });
        if (!r.ok) return JSON.stringify({ ok: false, ...base, erreur: r.erreur });
        const tab = r.previsions.map((p) => ({ pas: p.pas, prevision: arrondi(p.valeur, 2), "borne basse": arrondi(p.bas, 2), "borne haute": arrondi(p.haut, 2) }));
        const historique = points.slice(-36).map((p, i) => ({ instant: String(p.instant ?? i), valeur: Number(p.valeur) })).filter((p) => Number.isFinite(p.valeur));
        const courbe = historique.length >= 3 ? construireViz({ type: "courbe", x: "instant", y: ["valeur"] }, historique) : { erreur: "trop court" };
        return JSON.stringify({
          ok: true, ...base, points: r.n, modele: r.modele, periode: r.periode, periodeDetectee: r.periodeDetectee, saisonnalite: r.saisonnalite,
          resume: resumerSerie(r),
          previsions: r.previsions.map((p) => ({ pas: p.pas, valeur: arrondi(p.valeur, 3), intervalle95: [arrondi(p.bas, 3), arrondi(p.haut, 3)] })),
          validation: r.validation ? {
            pointsHorsEchantillon: r.validation.points,
            erreurMoyenneAbsolue: arrondi(r.validation.erreurMoyenneAbsolue, 3),
            erreurPourcent: Number.isFinite(r.validation.erreurPourcentMoyenne) ? arrondi(r.validation.erreurPourcentMoyenne, 2) : null,
            rapportALaPrevisionNaive: arrondi(r.validation.contreNaif, 3),
            rapportALaSaisonNaive: r.validation.contreSaisonNaif === null ? null : arrondi(r.validation.contreSaisonNaif, 3),
          } : null,
          ruptures: r.ruptures.map((x) => ({ position: x.position, instant: x.instant, avant: arrondi(x.avant, 2), apres: arrondi(x.apres, 2), ecartPourcent: arrondi(x.ecartRelatif * 100, 1) })),
          croissanceMoyennePourcent: r.croissanceMoyennePourcent === null ? null : arrondi(r.croissanceMoyennePourcent, 3),
          rigueur: rendreRigueur(r.rigueur),
          _blocs: [
            ...(("erreur" in courbe) ? [] : [{ kind: "viz", title: `${titre} — historique`, type: "courbe", donnees: courbe.donnees, axeYdepartZero: false, raison: "une série dans le temps se lit en courbe", alertes: [], note: null }]),
            blocTableau(`${titre} — prévision`, tab),
          ].filter((b): b is Record<string, unknown> => Boolean(b)),
          _blocsDecoratifs: true,
          _provenance: provenance(user, "calcul_statistiques", titre, r.previsions.length ? `prochain pas ${arrondi(r.previsions[0]!.valeur, 2)}` : `${r.n} points`, charge.provenance, `lissage exponentiel${r.periode ? ` saisonnier (période ${r.periode})` : ""}, validation hors échantillon`, `modèle ${r.modele}`, true),
        });
      }

      return JSON.stringify({ ok: false, erreur: `Analyse « ${analyse} » inconnue : decrire, correlations, regression, regression_logistique, test, segmentation, acp, anomalies, serie.` });
    },
  },
];
