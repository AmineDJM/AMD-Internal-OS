import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CINQ BLOCS RICHES, DONNÉS À VOIR.
 *
 * ── POURQUOI ILS SONT ÉCRITS À LA MAIN ───────────────────────────────────────────────────
 *
 * Une story ne s'affiche qu'au bout d'un vrai tour : une question, un appel de modèle, une
 * lecture. La suite E2E de ce projet ne fait AUCUN appel IA — c'est délibéré et il n'est pas
 * question de le changer pour obtenir une capture d'écran. Sans planche, la revue visuelle
 * exigée par la mission (« regarde les captures, ne te contente pas des tests qui passent »)
 * ne porterait que sur un écran d'accueil vide.
 *
 * Ce qui est photographié ici EST le rendu de production : ces compositions traversent le même
 * `WorkspaceBlocks`, les mêmes composants, la même feuille de style. Seule la SOURCE des
 * valeurs diffère.
 *
 * ── « AUCUNE DONNÉE SIMULÉE », ET COMMENT LA RÈGLE EST TENUE ─────────────────────────────
 *
 * Elle interdit de présenter au PDG un chiffre inventé comme un fait. Ces valeurs ne
 * l'atteignent jamais : la planche n'est rendue que si `ADAM_BLOCK_PREVIEW=1`, variable posée
 * par la seule configuration Playwright. Et elles sont VOLONTAIREMENT reconnaissables — « Démo »,
 * références en `DEMO-…` — parce qu'une planche qui ressemble à de vraies données finit un jour
 * recopiée dans une réunion.
 *
 * ── CE QUE CHAQUE PLANCHE DOIT PROUVER ───────────────────────────────────────────────────
 *
 * Chaque composition est construite pour montrer le cas DIFFICILE, pas le cas heureux : une
 * story avec un jalon MANQUANT et un retard, une vue 360 dont la section anormale est celle
 * qui s'ouvre, une comparaison où le delta et l'insight ne disent pas la même chose, une
 * mission dont une étape a ÉCHOUÉ avec un message actionnable. Une planche qui ne montre que
 * ce qui va bien ne sert à rien : c'est précisément l'état dégradé qu'on doit juger.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'HISTOIRE D'UN MARCHÉ — trois niveaux, un trou, un retard, des fils. */
const STORY: WorkspaceComposition = {
  source: "business_story",
  blocks: [{
    kind: "story",
    title: "Marché DEMO-AO-2024 — Démo Pharma",
    subtitle: "Publication mars 2024 · 8 lots · 3 produits",
    blockId: "story:PCH_TENDER:demo",
    entityRef: { type: "PCH_TENDER", id: "demo", label: "DEMO-AO-2024" },
    state: "complete",
    certitude: "fait",
    kpis: [
      { valeur: "1,24 Md", label: "Attribué" },
      { valeur: "890 M", label: "Commandé" },
      { valeur: "612 M", label: "Encaissé", ton: "succes" },
      { valeur: "278 M", label: "Reste dû", ton: "attention" },
      { valeur: "94 j", label: "Délai moyen", ton: "attention" },
      { valeur: "2", label: "Jalons manquants", ton: "alerte" },
    ],
    threads: [
      { id: "produit:a", label: "Molécule A", count: 4, genre: "produit" },
      { id: "produit:b", label: "Molécule B", count: 3, genre: "produit" },
      { id: "famille:gagnes", label: "Lots gagnés", count: 5, genre: "famille" },
      { id: "famille:perdus", label: "Lots perdus", count: 3, genre: "famille" },
      { id: "famille:paiements", label: "Paiements", count: 3, genre: "famille" },
      { id: "famille:retards", label: "Retards", count: 2, genre: "risque" },
    ],
    events: [
      {
        id: "publication", date: "2024-03-04", kind: "publication",
        titre: "Appel d'offres publié", etat: "fait",
        detail: "Consultation nationale — 8 lots, remise sous 30 jours.",
        provenance: "PchTender", certitude: "fait",
      },
      {
        id: "soumission", date: "2024-04-02", kind: "soumission",
        titre: "Offre déposée", etat: "fait",
        detail: "Date déduite de la publication : la date de dépôt n'est pas enregistrée.",
        certitude: "deduit", provenance: "déduit de la publication",
      },
      {
        id: "attribution", date: "2024-05-16", kind: "attribution",
        titre: "Marché attribué — 5 lots sur 8", etat: "fait",
        metriques: [{ valeur: "5 / 8", label: "lots" }, { valeur: "1,24 Md", label: "attribué" }],
        participants: [{ nom: "Démo Benkaci", role: "Responsable PCH" }],
        provenance: "PchTender", certitude: "fait",
      },
      {
        id: "lot:1", date: "2024-05-16", kind: "attribution", parent: "attribution",
        titre: "Lot 1 — Molécule A 100 mg", etat: "fait",
        detail: "DEMO-PRD-A — Molécule A",
        metriques: [{ valeur: "42 000", label: "unités" }, { valeur: "520 M", label: "attribué" }],
        fils: ["produit:a", "famille:gagnes"], provenance: "PchTenderLine", certitude: "fait",
        actions: [{ libelle: "Économie", phrase: "Économie du produit DEMO-PRD-A", icone: "voir" }],
      },
      {
        id: "lot:2", date: "2024-05-16", kind: "attribution", parent: "attribution",
        titre: "Lot 2 — Molécule B 40 mg", etat: "echec",
        detail: "Perdu — offre concurrente inférieure de 6 %.",
        metriques: [{ valeur: "18 000", label: "unités" }],
        fils: ["produit:b", "famille:perdus"], provenance: "PchTenderLine", certitude: "fait",
      },
      {
        id: "contrat", date: "2024-06-11", kind: "contrat",
        titre: "Contrat signé", etat: "fait",
        detail: "Convention annuelle, reconduction tacite.",
        docs: [{ nom: "Contrat DEMO-AO-2024.pdf", href: "/api/drive/file/demo", type: "pdf", taille: "1,2 Mo" }],
        provenance: "LegalDocument", certitude: "fait",
      },
      {
        id: "avenant:1", date: "2024-11-03", kind: "avenant", parent: "contrat",
        titre: "Avenant n° 1 — volumes révisés", etat: "fait",
        provenance: "LegalDocument", certitude: "fait",
      },
      {
        id: "bc:1", date: "2024-07-02", kind: "commande",
        titre: "Bon de commande n° 1", etat: "fait",
        metriques: [{ valeur: "480 M", label: "commandé" }],
        fils: ["produit:a"], provenance: "PchOrder", certitude: "fait",
      },
      {
        id: "livraison:1", date: "2024-08-19", kind: "livraison", parent: "bc:1",
        titre: "Livraison du BC n° 1", etat: "fait",
        provenance: "PchOrder", certitude: "fait",
      },
      {
        id: "paiement:1", date: "2024-11-21", kind: "paiement", parent: "bc:1",
        titre: "Paiement du BC n° 1", etat: "fait", retardJours: 94,
        metriques: [{ valeur: "480 M", label: "encaissé" }],
        fils: ["famille:paiements", "famille:retards"], provenance: "PchOrder", certitude: "fait",
      },
      {
        id: "bc:2", date: "2024-10-08", kind: "commande",
        titre: "Bon de commande n° 2", etat: "fait",
        metriques: [{ valeur: "410 M", label: "commandé" }],
        fils: ["produit:a"], provenance: "PchOrder", certitude: "fait",
      },
      {
        id: "livraison:2", date: "2024-12-02", kind: "livraison", parent: "bc:2",
        titre: "Livraison du BC n° 2", etat: "fait",
        provenance: "PchOrder", certitude: "fait",
      },
      {
        id: "facture:2", date: null, kind: "facture", parent: "bc:2",
        titre: "Facture du BC n° 2", etat: "manque",
        detail: "Aucune facture rattachée à ce bon de commande. C'est ce qui bloque l'encaissement.",
        fils: ["famille:retards"], certitude: "attente",
        actions: [{ libelle: "Relancer", phrase: "Prépare une relance de facturation sur le BC n° 2", icone: "relancer", ton: "primaire" }],
      },
      {
        id: "paiement:2", date: null, kind: "paiement", parent: "bc:2",
        titre: "Paiement du BC n° 2", etat: "manque", retardJours: 168,
        detail: "278 M DZD attendus, jamais reçus.",
        metriques: [{ valeur: "278 M", label: "attendu", ton: "alerte" }],
        fils: ["famille:paiements", "famille:retards"], certitude: "attente",
      },
      {
        id: "courrier:1", date: "2025-02-14", kind: "courrier",
        titre: "Relance envoyée au client", etat: "fait",
        detail: "Courrier recommandé — accusé reçu le 20/02.",
        provenance: "MailEntry", certitude: "fait",
      },
    ],
    limites: [
      "La date de soumission est DÉDUITE de la date de publication : elle n'est pas enregistrée.",
      "Les livraisons partielles ne sont pas tracées ligne par ligne — seul le bon fait foi.",
    ],
    actions: [
      { libelle: "Le marché en 360", phrase: "État du marché DEMO-AO-2024", icone: "voir", ton: "primaire" },
      { libelle: "Exporter", phrase: "Exporte l'historique du marché DEMO-AO-2024 en Excel", icone: "apercu" },
    ],
  }],
};

/** LA VUE 360 D'UN PRODUIT — la section anormale est celle qui s'ouvre. */
const PRODUIT_360: WorkspaceComposition = {
  source: "product_economics",
  blocks: [{
    kind: "entity360",
    title: "Molécule A",
    subtitle: "Démo DCI · 100 mg · Comprimé pelliculé",
    blockId: "e360:PRODUCT:demo",
    entityRef: { type: "PRODUCT", id: "demo", label: "DEMO-PRD-A" },
    state: "complete", certitude: "fait", freshness: "lu il y a 2 min",
    badges: [
      { label: "DEMO-PRD-A", ton: "neutre" },
      { label: "Actif", ton: "succes" },
      { label: "Démo Pharma", ton: "neutre" },
    ],
    kpis: [
      { valeur: "612 M", label: "Encaissé (12 m)", ton: "succes" },
      { valeur: "278 M", label: "Créance ouverte", ton: "attention" },
      { valeur: "1,24 Md", label: "Attribué sur marchés" },
      { valeur: "− 41 M", label: "Contribution", ton: "alerte" },
    ],
    sections: [
      {
        id: "finance", label: "Finance", ouvert: true,
        fields: [
          { label: "Ventes enregistrées", value: "38" },
          { label: "Chiffre d'affaires", value: "890 M DZD" },
          { label: "Créance ouverte", value: "278 M DZD", ton: "attention" },
          { label: "Première vente", value: "02/07/2024" },
          { label: "Dernière vente", value: "18/06/2026" },
        ],
        table: {
          columns: [
            { key: "statut", label: "Règlement" },
            { key: "nombre", label: "Ventes", numeric: true },
            { key: "montant", label: "Montant DZD", numeric: true },
          ],
          rows: [
            { cells: { statut: "Payé", nombre: "24", montant: "612 M" }, tons: { statut: "succes" } },
            { cells: { statut: "Partiel", nombre: "9", montant: "196 M" }, tons: { statut: "attention" } },
            { cells: { statut: "En retard", nombre: "5", montant: "82 M" }, tons: { statut: "alerte" } },
          ],
        },
      },
      {
        id: "reglementaire", label: "Réglementaire — 3 dossiers", ouvert: true,
        items: [
          { titre: "DEMO-2026-015", detail: "Molécule A 100 mg · Démo Benkaci", statut: "En évaluation", echeance: "22/08/2026" },
          { titre: "DEMO-2025-104", detail: "Extension de gamme", statut: "Décision obtenue", echeance: "—" },
          { titre: "DEMO-2026-031", detail: "Renouvellement quinquennal", statut: "Dossier reçu", echeance: "14/11/2026" },
        ],
        note: "Retard réglementaire moyen : 26 jour(s).",
      },
      {
        id: "marches", label: "Marchés PCH — 4 lignes",
        table: {
          columns: [
            { key: "marche", label: "Marché" },
            { key: "designation", label: "Désignation" },
            { key: "statut", label: "Statut" },
            { key: "valeur", label: "Attribué DZD", numeric: true },
          ],
          rows: [
            { cells: { marche: "DEMO-AO-2024", designation: "Lot 1 — 100 mg", statut: "Gagnée", valeur: "520 M" }, tons: { statut: "succes" }, actions: [{ libelle: "Le marché", phrase: "État du marché DEMO-AO-2024", icone: "voir" }] },
            { cells: { marche: "DEMO-AO-2023", designation: "Lot 3 — 100 mg", statut: "Gagnée", valeur: "410 M" }, tons: { statut: "succes" }, actions: [{ libelle: "Le marché", phrase: "État du marché DEMO-AO-2023", icone: "voir" }] },
            { cells: { marche: "DEMO-AO-2025", designation: "Lot 2 — 100 mg", statut: "Perdue", valeur: "—" }, tons: { statut: "alerte" } },
            { cells: { marche: "DEMO-AO-2026", designation: "Lot 5 — 100 mg", statut: "Soumise", valeur: "310 M" } },
          ],
          total: 4,
        },
      },
      {
        id: "portefeuille", label: "Portefeuille — 2 personnes",
        people: [
          { nom: "Démo Benkaci", poste: "Responsable PCH · National", coordonnees: [] },
          { nom: "Démo Haddad", poste: "Délégué · Alger-Centre", coordonnees: [] },
        ],
      },
      {
        id: "promotion", label: "Promotion & terrain",
        fields: [
          { label: "Investissement imputé", value: "63 M DZD" },
          { label: "Postes Ad&Pro", value: "11" },
          { label: "Visites", value: "148" },
          { label: "Dernière visite", value: "12/08/2026" },
        ],
        note: "4 poste(s) sans part saisie : leur montant n'est imputé à aucun produit.",
      },
    ],
    limites: [
      "Le coût humain est SOUS-ESTIMÉ : 2 affectations sur 7 n'ont pas de coût employeur renseigné.",
      "L'investissement promotionnel exclut 4 postes sans part de répartition.",
    ],
    href: "/business-development/explorateur",
    actions: [{ libelle: "Retracer", phrase: "Retracer DEMO-PRD-A", icone: "voir", ton: "primaire" }],
  }],
};

/** LA COMPARAISON — le delta est arithmétique, l'insight est une lecture. */
const COMPARAISON: WorkspaceComposition = {
  source: "pch_market_status",
  blocks: [{
    kind: "comparison",
    title: "DEMO-AO-2023 vs DEMO-AO-2024",
    subtitle: "Même client, même famille de produits",
    sujets: [
      { id: "a", label: "DEMO-AO-2023", sousTitre: "clos" },
      { id: "b", label: "DEMO-AO-2024", sousTitre: "en cours" },
    ],
    lignes: [
      { dimension: "Lots attribués", valeurs: ["6 / 8", "5 / 8"], delta: "− 1", deltaTon: "attention" },
      { dimension: "Attribué", valeurs: ["980 M DZD", "1,24 Md DZD"], delta: "+ 26 %", deltaTon: "succes", insight: "La hausse vient du prix unitaire, pas du volume : 12 % d'unités en moins." },
      { dimension: "Encaissé", valeurs: ["960 M DZD", "612 M DZD"], delta: "− 36 %", deltaTon: "alerte", insight: "Une facture jamais émise explique 278 M à elle seule." },
      { dimension: "Délai moyen de paiement", valeurs: ["41 j", "94 j"], delta: "+ 53 j", deltaTon: "alerte" },
      { dimension: "Caution", valeurs: ["Restituée", "Échéance dans 22 j"], delta: "—", deltaTon: "attention", insight: "À renouveler avant le 18/09 sous peine de pénalité." },
    ],
    note: "Les deux marchés sont comparables : même client, même famille thérapeutique, durée équivalente.",
  }],
};

/** LA MISSION — plusieurs gestes, une confirmation, une étape en échec. */
const MISSION: WorkspaceComposition = {
  source: "mission_bundle",
  blocks: [{
    kind: "mission",
    title: "Débloquer l'encaissement du BC n° 2",
    subtitle: "3 gestes préparés — une seule confirmation",
    blockId: "mission:demo",
    state: "awaiting_confirmation",
    etapes: [
      { id: "1", label: "Écrire au service facturation", detail: "Objet : facture manquante sur DEMO-AO-2024 / BC n° 2", etat: "a-faire" },
      { id: "2", label: "Créer une tâche de suivi pour Démo Benkaci", detail: "Échéance : dans 5 jours", etat: "a-faire" },
      { id: "3", label: "Planifier un rappel", detail: "Le 12/09 si la facture n'est pas émise", etat: "a-faire" },
    ],
    confirmation: { libelle: "Tout exécuter", phrase: "Exécute la mission de déblocage du BC n° 2", ton: "primaire", icone: "valider" },
  }],
};

/** LA MÊME MISSION, APRÈS — la carte a changé d'état, elle ne s'est pas dupliquée. */
const MISSION_APRES: WorkspaceComposition = {
  source: "mission_bundle",
  blocks: [{
    kind: "mission",
    title: "Débloquer l'encaissement du BC n° 2",
    subtitle: "Exécutée le 27/08 à 14 h 32",
    blockId: "mission:demo",
    state: "failed", version: 2,
    etapes: [
      { id: "1", label: "Écrire au service facturation", detail: "Envoyé à 14 h 32", etat: "fait" },
      { id: "2", label: "Créer une tâche de suivi pour Démo Benkaci", detail: "Tâche DEMO-T-118", etat: "fait" },
      {
        id: "3", label: "Planifier un rappel", etat: "echec",
        erreur: "Le 12/09 est un jour férié — choisir une autre date pour que le rappel parte.",
        actions: [
          { libelle: "Le 15/09", phrase: "Planifie le rappel du BC n° 2 au 15/09", icone: "planifier", ton: "primaire" },
          { libelle: "Sans rappel", phrase: "Abandonne le rappel du BC n° 2" },
        ],
      },
    ],
  }],
};

/** L'ALERTE PROACTIVE — Adam parle sans qu'on lui demande, dans le même fil. */
const ALERTE: WorkspaceComposition = {
  source: "proactive",
  blocks: [{
    kind: "alerte",
    title: "Message non délivré",
    ton: "alerte",
    message: "Le courriel envoyé au service facturation est revenu en erreur.",
    detail: "L'adresse facturation@demo.test est refusée par le serveur destinataire (550, boîte inconnue).",
    origine: "Rapport de non-remise reçu il y a 4 min",
    blockId: "alerte:demo",
    state: "complete",
    actions: [
      { libelle: "Corriger l'adresse", phrase: "Corrige l'adresse du message au service facturation", icone: "modifier", ton: "primaire" },
      { libelle: "Voir le message", phrase: "Montre le message envoyé au service facturation", icone: "voir" },
    ],
  }],
};

/** LE MARCHÉ EN 360 — les cinq montants, présentés en ENTONNOIR pour ne pas s'additionner. */
const MARCHE_360: WorkspaceComposition = {
  source: "pch_market_status",
  blocks: [{
    kind: "entity360",
    title: "DEMO-AO-2024",
    subtitle: "Démo Pharma — consultation nationale",
    blockId: "e360:PCH_TENDER:demo",
    entityRef: { type: "PCH_TENDER", id: "demo", label: "DEMO-AO-2024" },
    state: "complete", certitude: "fait",
    badges: [{ label: "En cours", ton: "neutre" }, { label: "Caution", ton: "alerte" }],
    kpis: [
      { valeur: "1,24 Md", label: "Attribué" },
      { valeur: "890 M", label: "Commandé" },
      { valeur: "612 M", label: "Encaissé", ton: "succes" },
      { valeur: "278 M", label: "Reste à encaisser", ton: "attention" },
    ],
    sections: [
      {
        id: "execution", label: "Exécution", ouvert: true,
        gauges: [
          { label: "Commandé sur attribué", valeur: 890, total: 1240, detail: "890 M / 1,24 Md DZD" },
          { label: "Livré sur commandé", valeur: 890, total: 890, detail: "890 M / 890 M DZD", ton: "succes" },
          { label: "Encaissé sur livré", valeur: 612, total: 890, detail: "612 M / 890 M DZD", ton: "attention" },
        ],
        fields: [
          { label: "Bons de commande", value: "2" },
          { label: "En attente", value: "0" },
          { label: "Livrés", value: "2" },
          { label: "Payés", value: "1" },
        ],
        note: "1 bon en retard d'arrivée.",
      },
      {
        id: "caution", label: "Caution", ouvert: true,
        fields: [
          { label: "Montant", value: "62 M DZD" },
          { label: "Déposée", value: "Oui", ton: "succes" },
          { label: "Fin", value: "18/09/2026" },
          { label: "Avant échéance", value: "22 jour(s)", ton: "alerte" },
        ],
        note: "La caution expire dans moins de 30 jours : à renouveler ou à faire restituer.",
      },
      {
        id: "ventes", label: "Ventes enregistrées (à part)",
        fields: [
          { label: "Nombre", value: "38" },
          { label: "Chiffre d'affaires", value: "890 M DZD" },
          { label: "Écart avec les bons", value: "0 DZD", ton: "attention" },
        ],
        note: "Ces ventes ne s'additionnent PAS aux bons de commande : les cumuler doublerait le chiffre d'affaires du marché.",
      },
    ],
    limites: ["Les livraisons partielles ne sont pas tracées ligne par ligne."],
    href: "/pch",
    actions: [{ libelle: "Retracer", phrase: "Retracer DEMO-AO-2024", icone: "voir", ton: "primaire" }],
  }],
};

export const PLANCHE_GODMODE: { titre: string; composition: WorkspaceComposition }[] = [
  { titre: "Business Story — « Retrace-moi le marché DEMO-AO-2024 »", composition: STORY },
  { titre: "Produit 360 — « Le produit Molécule A est-il rentable ? »", composition: PRODUIT_360 },
  { titre: "Marché 360 — « Où en est DEMO-AO-2024 ? »", composition: MARCHE_360 },
  { titre: "Comparaison — « Compare 2023 et 2024 »", composition: COMPARAISON },
  { titre: "Mission — avant : trois gestes, une confirmation", composition: MISSION },
  { titre: "Mission — après : la MÊME carte, en échec partiel", composition: MISSION_APRES },
  { titre: "Alerte proactive — Adam parle le premier", composition: ALERTE },
];
