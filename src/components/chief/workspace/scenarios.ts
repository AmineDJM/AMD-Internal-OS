import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";
import type { TurnProposal } from "@/lib/assistant/workspace/turn";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CINQ SCÉNARIOS D'ACCEPTATION (§22) — la seule preuve recevable.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * La mission dit : « PASS uniquement si les scénarios ci-dessous sont visuellement ET
 * fonctionnellement différents d'un simple chatbot ». Une affirmation ne vaut rien ici ; il faut
 * pouvoir REGARDER les cinq écrans et les faire vérifier par un test. Or ces écrans n'existent
 * qu'au bout d'un vrai tour de modèle, que la suite E2E ne fait jamais — et c'est très bien ainsi.
 *
 * D'où ces cinq compositions, écrites à la main, qui traversent exactement le même code de
 * rangement et de rendu que la production : `composeTurn` → `TurnWorkspaceView` → les blocs. Ce
 * qu'on photographie est donc le VRAI rendu, pas une maquette qui lui ressemblerait.
 *
 * ── LA RÈGLE « AUCUNE DONNÉE SIMULÉE », ET COMMENT ELLE EST TENUE ────────────────────────
 *
 * Elle interdit de présenter au PDG un chiffre inventé comme un fait. Ces valeurs ne l'atteignent
 * jamais : la planche n'est rendue que si `ADAM_BLOCK_PREVIEW=1`, variable posée par la seule
 * configuration Playwright. Et elles sont VOLONTAIREMENT reconnaissables — noms en « Démo »,
 * références en `DEMO-…` — parce qu'une planche qui ressemble à de vraies données finit un jour
 * recopiée dans une réunion.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Scenario {
  /** La question du PDG, mot pour mot. C'est le titre de la planche. */
  question: string;
  /** Ce que la mission exige de voir. Affiché à côté, pour que la revue visuelle soit dirigée. */
  attendu: string;
  compositions: WorkspaceComposition[];
  proposals?: TurnProposal[];
  trace?: string[];
  reply?: string;
}

export const SCENARIOS: Scenario[] = [
  // ── §22 SCÉNARIO 1 ───────────────────────────────────────────────────────────────────
  {
    question: "Qu'est-ce que j'ai raté aujourd'hui ?",
    attendu: "Un plan de travail de décisions, lisible immédiatement — pas un paragraphe.",
    trace: ["list_pending_decisions", "read_finance", "read_regulatory"],
    reply: "Trois points demandent votre décision aujourd'hui ; le devis Biopharm est le plus ancien.",
    compositions: [
      {
        source: "list_pending_decisions",
        blocks: [
          {
            kind: "queue",
            title: "En attente de votre décision",
            total: 3,
            items: [
              { titre: "Devis Biopharm — Démo", detail: "18,4 M DZD", statut: "En attente de votre validation", echeance: "depuis 3 jours" },
              { titre: "Paiement fournisseur — Démo Logistique", detail: "4,2 M DZD", statut: "À approuver" },
              { titre: "Congés — Démo Nesrine", detail: "5 jours en septembre", statut: "À valider" },
            ],
          },
          {
            kind: "dossier",
            title: "Nivolumab — Démo",
            subtitle: "DEMO-2026-018",
            badge: { label: "Bloqué", ton: "alerte" },
            alerte: { label: "Complément ANPP en attente depuis 2 jours", ton: "alerte" },
            fields: [
              { label: "Statut", value: "En attente ANPP" },
              { label: "Responsable", value: "Démo Benkaci" },
            ],
          },
        ],
      },
    ],
  },

  // ── §22 SCÉNARIO 2 ───────────────────────────────────────────────────────────────────
  {
    question: "Envoie Regulatory à Amine.",
    attendu: "Le message complet, sa pièce jointe, et UNE confirmation — sous le message.",
    trace: ["directory_lookup", "export_regulatory_xlsx", "prepare_email"],
    reply: "Le fichier est à jour au 27/08 et contient 72 dossiers.",
    proposals: [{ kind: "send_email", title: "Envoyer le point Regulatory à Démo Amine", state: "pending" }],
    compositions: [
      {
        source: "directory_lookup",
        blocks: [
          {
            kind: "people",
            title: "Destinataire",
            people: [{
              nom: "Démo Amine Djouamai",
              poste: "Directeur Regulatory",
              statut: { label: "Actif", ton: "succes" },
              metriques: [
                { valeur: "12", label: "Dossiers assignés" },
                { valeur: "3", label: "En retard", ton: "alerte" },
                { valeur: "98 %", label: "Taux à jour", ton: "succes" },
              ],
              coordonnees: [
                { canal: "e-mail", valeur: "demo.amine@exemple.test", fiabilite: "vérifiée en interne", principale: true },
                { canal: "téléphone", valeur: "+213 555 00 00 00" },
              ],
            }],
            actions: [
              { libelle: "Voir le profil complet", phrase: "Ouvre la fiche de Démo Amine", icone: "voir" },
              { libelle: "Envoyer un email", phrase: "Écris un mail à Démo Amine", icone: "email" },
              { libelle: "Assigner une tâche", phrase: "Assigne une tâche à Démo Amine", icone: "tache" },
            ],
          },
        ],
      },
      {
        source: "prepare_email",
        blocks: [
          {
            kind: "email",
            title: "Message prêt",
            a: ["demo.amine@exemple.test"],
            objet: "Situation Regulatory — 27/08/2026",
            corps:
              "Bonjour Amine,\n\nTu trouveras ci-joint le point Regulatory à date : 72 dossiers, dont 6 bloqués.\n\nBien à toi.",
            piecesJointes: ["Regulatory_27-08-2026.xlsx"],
            statut: "brouillon",
            actions: [
              { libelle: "Modifier le brouillon", phrase: "Modifie le brouillon du point Regulatory", icone: "modifier" },
              { libelle: "Aperçu", phrase: "Montre l'aperçu du fichier Regulatory", icone: "apercu" },
              { libelle: "Envoyer le mail", phrase: "Envoie le point Regulatory à Démo Amine", icone: "envoyer", ton: "primaire" },
            ],
          },
        ],
      },
    ],
  },

  // ── §22 SCÉNARIO 3 ───────────────────────────────────────────────────────────────────
  {
    question: "Pourquoi Nivolumab est bloqué ?",
    attendu: "Statut, cause, preuves et gestes possibles — dans cet ordre.",
    trace: ["inspect_record", "search_documents", "gmail_search"],
    reply: "Le blocage vient du complément demandé le 25/08, sans réponse à ce jour.",
    compositions: [
      {
        source: "inspect_record",
        blocks: [
          {
            kind: "dossier",
            title: "Nivolumab — Démo",
            subtitle: "DEMO-2026-018 · Nivolumab",
            badge: { label: "Bloqué depuis 2 jours", ton: "alerte" },
            alerte: { label: "L'ANPP demande un complément de stabilité — aucune réponse envoyée", ton: "alerte" },
            fields: [
              {
                label: "Responsable", value: "Démo Benkaci", avatar: { nom: "Démo Benkaci" },
                editable: { phrase: "Réassigne le dossier DEMO-2026-018 à %s", type: "texte" },
              },
              {
                label: "Étape courante", value: "Réponse aux questions",
                editable: {
                  phrase: "Passe le dossier DEMO-2026-018 à l'étape « %s »",
                  type: "choix",
                  options: ["Dépôt", "Recevabilité", "Réponse aux questions", "Décision", "Enregistrement"],
                },
              },
              { label: "Retard", value: "4 jours", ton: "alerte" },
              { label: "Dernière évolution", value: "25/08/2026" },
              {
                label: "Prochaine échéance", value: "10/09/2026",
                editable: { phrase: "Change l'échéance de DEMO-2026-018 au %s", type: "date", aide: "la date visée" },
              },
            ],
            steps: [
              { label: "Dépôt", etat: "fait" },
              { label: "Recevabilité", etat: "fait" },
              { label: "Questions ANPP", etat: "courant" },
              { label: "Décision", etat: "a-venir" },
            ],
            activite: [
              { date: "25/08", label: "Courrier ANPP reçu — complément de stabilité demandé" },
              { date: "26/08", label: "Dossier repassé en « Réponse aux questions »" },
            ],
            href: "#demo-dossier",
            participants: [
              { nom: "Démo Benkaci", poste: "Responsable", coordonnees: [] },
              { nom: "Démo Amrani", poste: "Affaires réglementaires", coordonnees: [] },
              { nom: "Démo Djouamai", poste: "Validation", coordonnees: [] },
              { nom: "ANPP", poste: "Organisme", coordonnees: [] },
            ],
            actions: [
              { libelle: "Voir le dossier complet", phrase: "Ouvre le dossier DEMO-2026-018", icone: "voir" },
              { libelle: "Assigner une tâche", phrase: "Assigne une tâche sur DEMO-2026-018", icone: "tache" },
              { libelle: "Envoyer un email à l'ANPP", phrase: "Prépare un mail à l'ANPP pour DEMO-2026-018", icone: "email" },
              { libelle: "Escalader le dossier", phrase: "Escalade le dossier DEMO-2026-018", icone: "escalade", ton: "danger" },
            ],
          },
        ],
      },
      {
        source: "search_documents",
        blocks: [
          {
            kind: "document",
            title: "La preuve",
            docs: [
              { nom: "Courrier ANPP — 25/08/2026 (Démo).pdf", href: "#demo", type: "pdf", soustitre: "Complément de stabilité à 24 mois demandé", taille: "1,2 Mo", date: "25/08/2026", pages: 2 },
              { nom: "Donnees_stabilite (Démo).xlsx", href: "#demo2", type: "feuille", taille: "320 ko", date: "18/08/2026" },
              { nom: "Lettre_accompagnement (Démo).docx", href: "#demo3", type: "texte", taille: "245 ko", date: "18/08/2026" },
            ],
          },
        ],
      },
    ],
  },

  // ── §22 SCÉNARIO 4 ───────────────────────────────────────────────────────────────────
  {
    question: "Chaque lundi, relance Regulatory.",
    attendu: "Une planification RÉELLE : cadence, prochaine exécution, état — pas une promesse.",
    trace: ["create_scheduled_workflow"],
    reply: "C'est en place. Vous pouvez la mettre en pause ou la modifier à tout moment.",
    compositions: [
      {
        source: "create_scheduled_workflow",
        blocks: [
          {
            kind: "planification",
            title: "Point Regulatory du lundi — Démo",
            cadence: "Tous les lundis à 07 h",
            prochaine: "lundi 31/08/2026 à 07 h",
            etat: "active",
            traitement: "Compte les dossiers par statut et signale ceux qui n'ont pas bougé depuis 30 jours",
            passages: [],
            actions: [
              { libelle: "Mettre en pause", phrase: "Mets en pause la planification du point Regulatory" },
              { libelle: "Modifier la cadence", phrase: "Change la cadence du point Regulatory" },
            ],
          },
        ],
      },
    ],
  },

  // ── §22 SCÉNARIO 5 ───────────────────────────────────────────────────────────────────
  {
    question: "Prépare la clôture Regulatory de la semaine.",
    attendu: "Cinq gestes préparés, montrés en entier, UNE seule confirmation.",
    trace: ["read_regulatory", "directory_lookup", "export_regulatory_xlsx", "prepare_email", "schedule_task"],
    reply: "Tout est prêt : rien ne partira tant que vous n'avez pas confirmé.",
    proposals: [
      { kind: "send_email", title: "Envoyer le point Regulatory à Démo Amine", state: "pending" },
      { kind: "create_task", title: "Relancer Démo Benkaci sur DEMO-2026-018", state: "pending" },
      { kind: "create_task", title: "Relancer Démo Hamdi sur DEMO-2026-023", state: "pending" },
      { kind: "set_regulatory_step", title: "Passer DEMO-2026-031 en « Décision »", state: "pending" },
      { kind: "create_calendar_event", title: "Bloquer 30 min vendredi pour la revue", state: "pending" },
    ],
    compositions: [
      {
        source: "prepare_email",
        blocks: [
          {
            kind: "email",
            title: "Message prêt",
            a: ["demo.amine@exemple.test"],
            objet: "Clôture Regulatory — semaine du 24/08",
            corps: "Bonjour Amine,\n\nCi-joint la clôture de la semaine. Trois dossiers demandent une relance.\n\nBien à toi.",
            piecesJointes: ["Cloture_Regulatory_S35.xlsx"],
            statut: "brouillon",
          },
        ],
      },
      {
        source: "read_regulatory",
        blocks: [
          {
            kind: "table",
            title: "Ce qui sera relancé",
            columns: [
              { key: "ref", label: "Référence" },
              { key: "produit", label: "Produit" },
              { key: "resp", label: "Responsable" },
              { key: "retard", label: "Retard" },
            ],
            rows: [
              { cells: { ref: "DEMO-2026-018", produit: "Nivolumab", resp: "Démo Benkaci", retard: "2 j" }, tons: { retard: "alerte" } },
              { cells: { ref: "DEMO-2026-023", produit: "Pembrolizumab", resp: "Démo Hamdi", retard: "5 j" }, tons: { retard: "alerte" } },
              { cells: { ref: "DEMO-2026-031", produit: "Trastuzumab", resp: "Démo Benkaci", retard: "—" } },
            ],
            total: 3,
          },
        ],
      },
    ],
  },
];
