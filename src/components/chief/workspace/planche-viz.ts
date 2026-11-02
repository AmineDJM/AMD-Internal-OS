import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";

/**
 * LA PLANCHE DES REPRÉSENTATIONS (§35) — les dix-sept formes et un mini-tableau de bord, avec des
 * données de DÉMONSTRATION (sociétés et chiffres fictifs). Elle sert la revue visuelle
 * (`/chief-of-staff?apercu=blocs`, capturée par Playwright aux cinq largeurs) et le banc de rendu :
 * chaque forme y est rendue au moins une fois, sans modèle et sans base.
 */
const MOIS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

const viz = (titre: string, composition: WorkspaceComposition["blocks"][number]): { titre: string; composition: WorkspaceComposition } => ({
  titre, composition: { source: "render_view", blocks: [composition] },
});

export const PLANCHE_VIZ: { titre: string; composition: WorkspaceComposition }[] = [
  viz("Barres — « Les tâches par statut »", {
    kind: "viz", title: "Tâches par statut", type: "barres", source: "lecture list_tasks · 142 lignes",
    donnees: { categories: ["À faire", "En cours", "En attente", "Terminées", "Annulées"], series: [{ label: "Tâches", valeurs: [38, 27, 12, 61, 4] }] },
    raison: "une comparaison entre 5 catégories se lit en barres, axe à zéro — la hauteur EST la valeur.",
  }),
  viz("Barres empilées — « Les dépenses par société et par catégorie »", {
    kind: "viz", title: "Dépenses par société", type: "barres_empilees", unite: "kDZD", source: "lecture finance_transactions · 318 lignes",
    donnees: {
      categories: ["Démo Pharma", "Démo Distribution", "Démo Labo", "Démo Services", "Démo Med", "Démo Export", "Démo Nord", "Démo Sud", "Démo Est"],
      series: [
        { label: "Marketing", valeurs: [420, 180, 90, 60, 210, 75, 40, 55, 30] },
        { label: "IT", valeurs: [120, 60, 140, 80, 35, 20, 25, 15, 10] },
        { label: "Formation", valeurs: [80, 40, 30, 20, 45, 10, 15, 12, 8] },
      ],
    },
    note: "9 sociétés : barres horizontales, les libellés restent lisibles.",
  }),
  viz("Courbe — « Le chiffre d'affaires mensuel des deux sociétés »", {
    kind: "viz", title: "Chiffre d'affaires mensuel", type: "courbe", unite: "MDZD", source: "lecture sales · 2026",
    donnees: { categories: MOIS, series: [{ label: "Démo Pharma", valeurs: [12.4, 13.1, 11.8, 14.6, 15.2, 16.0] }, { label: "Démo Distribution", valeurs: [8.2, 8.9, 9.4, 9.1, 10.3, 10.8] }] },
    raison: "une évolution dans le temps se lit en courbe : la pente est l'information.",
  }),
  viz("Aires — « Le cumul des encaissements »", {
    kind: "viz", title: "Encaissements cumulés 2026", type: "aires", unite: "MDZD", source: "lecture finance_totals",
    donnees: { categories: MOIS, series: [{ label: "Cumulé", valeurs: [12.4, 25.5, 37.3, 51.9, 67.1, 83.1], ton: "succes" }] },
    note: "cumul dit dans le titre : une aire qui monte toujours n'est pas une croissance de période.",
  }),
  viz("Nuage — « Délai de paiement contre montant, par fournisseur »", {
    kind: "viz", title: "Délai de paiement × montant facturé", type: "nuage", source: "lecture read_suppliers · 24 lignes",
    donnees: {
      points: [
        { x: 18, y: 1.2, label: "Kwality", groupe: "Emballage" }, { x: 34, y: 4.8, label: "Sanofar", groupe: "Matière" }, { x: 61, y: 2.1, label: "Logistix", groupe: "Transport" },
        { x: 22, y: 0.6, label: "Imprimerie du Sud", groupe: "Emballage" }, { x: 47, y: 3.4, label: "ChemiPro", groupe: "Matière" }, { x: 90, y: 6.9, label: "Global API", groupe: "Matière" },
        { x: 12, y: 0.4, label: "NetPharm", groupe: "IT" }, { x: 55, y: 1.9, label: "TransMed", groupe: "Transport" }, { x: 40, y: 2.6, label: "PackAlger", groupe: "Emballage" },
      ],
    },
    raison: "deux mesures par ligne : le nuage montre la relation, pas une hiérarchie.",
  }),
  viz("Histogramme — « La distribution des montants des bons de commande »", {
    kind: "viz", title: "Montants des bons de commande (classes)", type: "histogramme", unite: "BC", source: "lecture list_expense_orders · 212 lignes",
    donnees: { categories: ["0 – 200 k", "200 k – 400 k", "400 k – 600 k", "600 k – 800 k", "800 k – 1 M", "1 M – 1,2 M", "1,2 M – 1,4 M", "1,4 M – 1,6 M"], series: [{ label: "Effectif", valeurs: [64, 58, 39, 22, 14, 8, 5, 2] }] },
  }),
  viz("Secteurs — « La répartition du budget par enveloppe »", {
    kind: "viz", title: "Budget 2026 par enveloppe", type: "secteurs", unite: "MDZD", source: "lecture read_budget",
    donnees: { categories: ["Marketing", "Regulatory", "IT", "Formation", "Frais généraux"], series: [{ label: "Budget", valeurs: [42, 18, 12, 6, 22] }] },
    raison: "une répartition en cinq parts se lit en secteurs — au-delà de six, les parts deviennent illisibles.",
  }),
  viz("Cascade — « Du budget au reste à engager »", {
    kind: "viz", title: "Budget marketing : du voté au disponible", type: "cascade", unite: "kDZD", source: "lecture read_budget",
    donnees: { categories: ["Budget voté", "Engagé T1", "Engagé T2", "Réaffectation", "Engagé T3"], series: [{ label: "Variation", valeurs: [3000, -820, -940, 250, -610] }] },
    note: "les valeurs sont des variations ; le total est calculé par le rendu.",
  }),
  viz("Entonnoir — « Des appels d'offres aux lots gagnés »", {
    kind: "viz", title: "Appels d'offres PCH 2026", type: "entonnoir", source: "lecture pch_tenders",
    donnees: { categories: ["Appels publiés", "Éligibles", "Dossiers déposés", "Recevables", "Lots attribués"], series: [{ label: "Appels", valeurs: [64, 41, 29, 24, 11] }] },
  }),
  viz("Carte de chaleur — « Les retards par service et par mois »", {
    kind: "viz", title: "Tâches en retard par service", type: "heatmap", source: "lecture list_tasks",
    donnees: {
      lignes: ["Regulatory", "Legal", "Finance", "Marketing", "Logistique"], colonnes: MOIS,
      valeurs: [[3, 5, 8, 6, 4, 2], [1, 0, 2, 1, 3, 1], [4, 6, 3, 2, 5, 7], [2, 2, 1, 4, 3, 2], [0, 1, 1, 0, 2, 1]],
    },
  }),
  viz("Gantt — « Le calendrier des dossiers d'enregistrement »", {
    kind: "viz", title: "Dossiers d'enregistrement 2026", type: "gantt", source: "lecture regulatory_dossiers",
    donnees: {
      taches: [
        { label: "Molécule A 10 mg — dépôt", debut: "2026-01-12", fin: "2026-03-20", groupe: "Regulatory", progression: 100 },
        { label: "Molécule A 10 mg — questions ANPP", debut: "2026-03-21", fin: "2026-06-30", groupe: "Regulatory", progression: 55 },
        { label: "Molécule B 40 mg — dépôt", debut: "2026-02-02", fin: "2026-04-15", groupe: "Regulatory", progression: 100 },
        { label: "Molécule B 40 mg — packaging", debut: "2026-04-16", fin: "2026-08-31", groupe: "Production", progression: 20 },
        { label: "Contrat Consulting — renouvellement", debut: "2026-05-01", fin: "2026-07-15", groupe: "Legal", progression: 0 },
      ],
    },
  }),
  viz("Matrice — « Qui porte quoi »", {
    kind: "viz", title: "Responsabilités par dossier", type: "matrice", source: "lecture directory_list",
    donnees: {
      lignes: ["Molécule A", "Molécule B", "AO PCH 2026", "Audit qualité"], colonnes: ["Regulatory", "Legal", "Finance", "Direction"],
      cellules: [["D. Benkaci", "—", "S. Rahmani", "valide"], ["D. Benkaci", "M. Ould", "—", "informée"], ["—", "M. Ould", "S. Rahmani", "arbitre"], ["K. Ziani", "—", "—", "valide"]],
      tons: [[null, null, null, "succes"], ["attention", null, null, null], [null, null, "alerte", "attention"], [null, null, null, "succes"]],
    },
  }),
  viz("Réseau — « Qui travaille avec qui sur les dossiers »", {
    kind: "viz", title: "Collaborations sur les dossiers ouverts", type: "graphe", source: "lecture list_tasks · 90 jours",
    donnees: {
      noeuds: [
        { id: "p1", label: "D. Benkaci", type: "Regulatory", poids: 14 }, { id: "p2", label: "M. Ould", type: "Legal", poids: 9 }, { id: "p3", label: "S. Rahmani", type: "Finance", poids: 11 },
        { id: "p4", label: "K. Ziani", type: "Qualité", poids: 6 }, { id: "p5", label: "N. Haddad", type: "Direction", poids: 12 }, { id: "p6", label: "L. Cherif", type: "Regulatory", poids: 5 },
      ],
      arcs: [{ de: "p1", a: "p2", poids: 4 }, { de: "p1", a: "p3", poids: 6 }, { de: "p1", a: "p5", poids: 7 }, { de: "p2", a: "p5", poids: 3 }, { de: "p3", a: "p5", poids: 5 }, { de: "p4", a: "p1", poids: 2 }, { de: "p6", a: "p1", poids: 3 }],
    },
  }),
  viz("Arbre — « La structure du budget »", {
    kind: "viz", title: "Budget 2026 — arborescence", type: "arbre", unite: "MDZD", source: "lecture read_budget",
    donnees: {
      racine: {
        label: "Budget 2026", valeur: 100,
        enfants: [
          { label: "Marketing", valeur: 42, enfants: [{ label: "Congrès", valeur: 18 }, { label: "Visite médicale", valeur: 16 }, { label: "Digital", valeur: 8, ton: "attention" }] },
          { label: "Regulatory", valeur: 18, enfants: [{ label: "Dépôts", valeur: 11 }, { label: "Études", valeur: 7 }] },
          { label: "IT", valeur: 12 }, { label: "Formation", valeur: 6 }, { label: "Frais généraux", valeur: 22 },
        ],
      },
    },
  }),
  viz("Flux — « D'où vient l'argent, où il va »", {
    kind: "viz", title: "Flux financiers 2026", type: "flux", unite: "MDZD", source: "lecture finance_totals",
    donnees: {
      noeuds: [
        { id: "v1", label: "Ventes hôpitaux" }, { id: "v2", label: "Ventes officines" }, { id: "t", label: "Trésorerie" },
        { id: "d1", label: "Achats matière" }, { id: "d2", label: "Salaires" }, { id: "d3", label: "Marketing" }, { id: "d4", label: "Résultat" },
      ],
      arcs: [{ de: "v1", a: "t", poids: 58 }, { de: "v2", a: "t", poids: 34 }, { de: "t", a: "d1", poids: 41 }, { de: "t", a: "d2", poids: 22 }, { de: "t", a: "d3", poids: 14 }, { de: "t", a: "d4", poids: 15 }],
    },
  }),
  viz("Carte — « Les hôpitaux livrés, par volume »", {
    kind: "viz", title: "Hôpitaux livrés au T2", type: "carte", unite: "colis", source: "lecture medical_institutions",
    donnees: {
      lieux: [
        { label: "CHU Mustapha (Alger)", lat: 36.76, lon: 3.05, valeur: 420 }, { label: "CHU Oran", lat: 35.7, lon: -0.63, valeur: 260 }, { label: "CHU Constantine", lat: 36.36, lon: 6.61, valeur: 190 },
        { label: "EPH Blida", lat: 36.47, lon: 2.83, valeur: 90 }, { label: "CHU Annaba", lat: 36.9, lon: 7.77, valeur: 120 }, { label: "EPH Ouargla", lat: 31.95, lon: 5.33, valeur: 40, ton: "attention" },
      ],
    },
    alertes: ["DOUTEUX · Carte schématique : positions relatives par coordonnées, sans fond de carte — les distances sont indicatives."],
  }),
  viz("Indicateurs — « Les chiffres du matin »", {
    kind: "viz", title: "Ce matin", type: "cartes", source: "composé par le code",
    donnees: {
      cartes: [
        { titre: "Décisions en attente", valeur: "7", detail: "dont 2 urgentes", ton: "attention" }, { titre: "Encaissé cette semaine", valeur: "18,4 MDZD", detail: "+12 % vs semaine dernière", ton: "succes" },
        { titre: "Dossiers en retard", valeur: "3", detail: "Regulatory", ton: "alerte" }, { titre: "Réunions aujourd'hui", valeur: "4", detail: "2 h 30 au total" },
      ],
    },
  }),
  {
    titre: "Mini-tableau de bord — « Fais-moi un tableau de bord des ventes »",
    composition: {
      source: "render_view",
      blocks: [{
        kind: "dashboard", title: "Ventes 2026 — tableau de bord", colonnes: 2,
        tuiles: [
          { kind: "viz", title: "Ventes par mois", type: "courbe", unite: "MDZD", donnees: { categories: MOIS, series: [{ label: "Ventes", valeurs: [20.6, 22.0, 21.2, 23.7, 25.5, 26.8] }] } },
          { kind: "viz", title: "Par canal", type: "secteurs", unite: "MDZD", donnees: { categories: ["Hôpitaux", "Officines", "Grossistes"], series: [{ label: "Ventes", valeurs: [58, 34, 8] }] } },
          { kind: "viz", title: "Top 5 produits", type: "barres", unite: "MDZD", donnees: { categories: ["Molécule A 10 mg", "Molécule B 40 mg", "Sirop C", "Molécule D 5 mg", "Crème E"], series: [{ label: "Ventes", valeurs: [31, 24, 17, 12, 9] }] } },
          { kind: "progress", title: "Objectif annuel", gauges: [{ label: "Réalisé", valeur: 139.8, total: 300, unite: "MDZD" }, { label: "Pipeline PCH", valeur: 62, total: 100, unite: "MDZD", ton: "attention" }] },
        ],
        note: "chaque tuile est un bloc ordinaire, relu par le même lecteur que les autres.",
      }],
    },
  },
];
