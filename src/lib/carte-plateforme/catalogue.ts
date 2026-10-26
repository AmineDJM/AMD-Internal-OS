/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CARTE DE LA PLATEFORME — le catalogue qu'affiche `/admin/carte-plateforme` (Super Admin seul).
 *
 * Trois choses, et le lien entre elles :
 *   • les MODULES (une entité de l'ERP : ce qu'elle fait, ses gestes, qui les fait, ses règles) ;
 *   • les CIRCUITS (un fait métier de bout en bout, étape par étape, acteur par acteur) ;
 *   • les MÉCANISMES TRANSVERSES (les règles qui valent partout : droits, entités, corbeille…).
 *
 * Ce fichier DÉCRIT ; il ne décide rien. Les droits réels par rôle ne sont PAS recopiés ici : la
 * page les lit dans `PERMISSIONS` (`lib/rbac.ts`) au moment du rendu, et `rbac` ne fait que nommer
 * les clés de module à lire. Une description qui recopierait la matrice mentirait au premier réglage.
 *
 * Module PUR — ZÉRO import : il est lu par un composant `"use client"`. Les couleurs vivent dans
 * le composant (Tailwind ne lit pas `src/lib`), ici on ne nomme que la clé du domaine.
 * `catalogue.test.ts` tient la cohérence : chaque lien, chaque étape de circuit pointe vers un
 * module qui existe, chaque clé RBAC existe dans `MODULES`, chaque route a sa page.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type CleDomaine =
  | "pilotage" | "regulatory" | "marketing" | "operations" | "administration"
  | "argent" | "transverse" | "systeme" | "externe";

export interface Domaine {
  cle: CleDomaine;
  nom: string;
  resume: string;
}

/** Qui agit à une étape — décide la couleur de l'étape dans un circuit. */
export type TypeActeur = "demandeur" | "decideur" | "execution" | "argent" | "systeme" | "externe";

export interface Geste {
  /** Le libellé du bouton ou du geste, tel qu'on le voit à l'écran. */
  label: string;
  qui: string;
  effet: string;
}

export interface Lien {
  vers: string;
  pourquoi: string;
}

export interface ModulePlateforme {
  id: string;
  nom: string;
  /** L'adresse de l'écran ; `null` quand le module n'a pas d'écran propre. */
  route: string | null;
  domaine: CleDomaine;
  /** Les clés de module RBAC qui gouvernent l'écran (lues dans `PERMISSIONS` par la page). */
  rbac: readonly string[];
  resume: string;
  pourQui: string;
  gestes: readonly Geste[];
  regles: readonly string[];
  liens: readonly Lien[];
}

export interface EtapeCircuit {
  acteur: string;
  type: TypeActeur;
  /** L'id du module où l'étape se joue. */
  module: string;
  action: string;
  effet: string;
  /** Une étape qui peut dire non (approuver / refuser / renvoyer). */
  decision?: boolean;
}

export interface Circuit {
  id: string;
  titre: string;
  domaine: CleDomaine;
  resume: string;
  declencheur: string;
  etapes: readonly EtapeCircuit[];
  aRetenir: readonly string[];
}

export interface Mecanisme {
  titre: string;
  resume: string;
  details: readonly string[];
}

export const TYPES_ACTEUR: Record<TypeActeur, string> = {
  demandeur: "Demandeur",
  decideur: "Décideur",
  execution: "Exécution",
  argent: "Argent",
  systeme: "Automatique",
  externe: "Externe",
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES DOMAINES — l'ordre est celui du menu (Pilotage, Pôles, Transverse, Système).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DOMAINES: readonly Domaine[] = [
  { cle: "pilotage", nom: "Pilotage & espace personnel", resume: "Ce que chaque personne ouvre le matin : son espace, ses tâches, ses messages, son équipe." },
  { cle: "regulatory", nom: "Regulatory", resume: "Les dossiers d'enregistrement (AMM / ANPP), du CTD reçu à la décision." },
  { cle: "marketing", nom: "Marketing", resume: "Les produits, la segmentation des médecins, et toutes les dépenses de promotion (Ad & Pro)." },
  { cle: "operations", nom: "Operations & Sales", resume: "Le terrain (KAM, visites, rapports), la PCH (marchés, ventes, stocks)." },
  { cle: "administration", nom: "Administration & RH", resume: "Le secrétariat, les RH, le juridique, les courriers, les annuaires." },
  { cle: "argent", nom: "Argent : centres, finances, budgets", resume: "Qui autorise, qui signe, qui paie, et sur quel budget la dépense tombe." },
  { cle: "transverse", nom: "Transverse", resume: "Les outils communs à tous les modules : validations, Drive, recherche." },
  { cle: "systeme", nom: "Système & IA", resume: "Le pilotage de la plateforme : administration, Brain, Adam (en pause)." },
  { cle: "externe", nom: "Externe", resume: "Ce que voient les personnes hors de la société." },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES MODULES
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MODULES_PLATEFORME: readonly ModulePlateforme[] = [
  // ── PILOTAGE ──────────────────────────────────────────────────────────────────────────────
  {
    id: "mon-espace", nom: "Mon espace", route: "/mon-espace", domaine: "pilotage", rbac: ["WORKSPACE"],
    resume: "Le poste de travail de chacun : tout ce qui attend une décision ou une action de la personne, au même endroit.",
    pourQui: "Tout le monde (accordé à tous les rôles).",
    gestes: [
      { label: "Bloc « À valider »", qui: "Tout validateur", effet: "Liste les validations à SON tour seulement, et ses congés à signer ; chaque ligne dit depuis quand elle attend." },
      { label: "Lignes « À corriger »", qui: "Tout demandeur", effet: "Ce qu'un circuit lui a renvoyé (Ad & Pro, consulting, paiement, recrutement, plan de tournée) : il corrige et resoumet." },
      { label: "Ajouter une note de frais", qui: "Tout employé", effet: "Crée la demande RH « note de frais » (mois, montant, justificatif exigés) — même circuit que depuis Mon dossier RH." },
      { label: "Demande de formation", qui: "Tout employé", effet: "Ouvre une demande de formation validée N+1 → RH → DG." },
      { label: "Onglet Mes missions", qui: "Personne invitée sur une demande Ad & Pro", effet: "Confirmer ou décliner l'invitation ; l'ordre de mission passe par le N+1 puis les RH." },
    ],
    regles: [
      "Onglets : Aujourd'hui · Mon espace · Tâches · Mes missions · Mon dossier RH · Mon bilan.",
      "« À valider » compte exactement les lignes des deux blocs de décision — rien de plus.",
      "Les achats ne se demandent plus ici : ils passent par le Bureau du secrétariat.",
    ],
    liens: [
      { vers: "taches", pourquoi: "L'onglet Tâches" },
      { vers: "validations", pourquoi: "Les validations à son tour remontent ici" },
      { vers: "mon-dossier-rh", pourquoi: "Note de frais, congés, attestations" },
      { vers: "pieces", pourquoi: "Les pièces qu'on lui demande" },
      { vers: "formations", pourquoi: "Demande de formation" },
    ],
  },
  {
    id: "taches", nom: "Tâches", route: "/mon-espace/taches", domaine: "pilotage", rbac: ["WORKSPACE"],
    resume: "Les tâches qu'on reçoit, qu'on demande à d'autres et qu'on partage.",
    pourQui: "Tout le monde.",
    gestes: [
      { label: "Nouvelle tâche", qui: "Tout le monde", effet: "Crée une tâche pour soi ou la DEMANDE à quelqu'un (elle arrive dans « À accepter » chez lui)." },
      { label: "Accepter / Refuser", qui: "La personne à qui on la demande", effet: "Acceptée, elle passe dans « À faire »." },
      { label: "Réattribuer", qui: "Le créateur", effet: "Une demande refusée ou sans réponse se réattribue au lieu d'être recréée." },
      { label: "Supprimer", qui: "Le créateur ou le Super Admin", effet: "Supprime la tâche avec ses pièces et son fil." },
    ],
    regles: ["Vues : À accepter · À faire · Demandées · Partagées · Terminées.", "Un message de la messagerie peut devenir une tâche demandée."],
    liens: [{ vers: "messagerie", pourquoi: "Un message devient une tâche" }, { vers: "sujets", pourquoi: "Une tâche peut ouvrir un sujet" }],
  },
  {
    id: "messagerie", nom: "Messagerie", route: "/messages", domaine: "pilotage", rbac: ["MESSAGING"],
    resume: "La messagerie interne en temps réel : messages directs, groupes, canaux.",
    pourQui: "Tout le monde ; un administrateur peut la retirer à un compte.",
    gestes: [
      { label: "Écrire / joindre", qui: "Membre de la conversation", effet: "Message envoyé en direct, badge et son de non-lu chez les autres." },
      { label: "Modifier / supprimer son message", qui: "L'auteur", effet: "Le message est modifié ou retiré pour tous." },
    ],
    regles: ["L'accès à une conversation dépend de l'appartenance, pas du module.", "En Vue exacte, les brouillons sont rangés par personne."],
    liens: [{ vers: "taches", pourquoi: "Transformer un message en tâche" }],
  },
  {
    id: "directives", nom: "Directives", route: "/directives", domaine: "pilotage", rbac: ["DIRECTIVES"],
    resume: "Notes de service et instructions priorisées vers des personnes, un rôle, une entité ou tout le monde.",
    pourQui: "Tout le monde les lit ; la Direction les rédige ; seuls le DG et le Super Admin les publient.",
    gestes: [
      { label: "Rédiger puis soumettre", qui: "Direction", effet: "La directive part en brouillon puis en attente de publication." },
      { label: "Publier / Refuser", qui: "Directeur Général, Super Admin", effet: "Publiée, elle apparaît chez son audience ; refusée, avec motif." },
      { label: "Accuser réception / répondre", qui: "Destinataires", effet: "Statut et fil d'échange suivis par l'auteur." },
    ],
    regles: ["Plus un onglet de Mon espace : on les lit dans Aujourd'hui, la recherche et les notifications."],
    liens: [{ vers: "mon-espace", pourquoi: "Elles s'affichent dans « Aujourd'hui »" }],
  },
  {
    id: "agenda", nom: "Agenda & réunions", route: "/calendar", domaine: "pilotage", rbac: ["WORKSPACE"],
    resume: "Le calendrier de l'entreprise (heure d'Alger) et les réunions : lien Meet ou présentiel, fil, enregistrement, compte rendu IA.",
    pourQui: "Tout le monde.",
    gestes: [
      { label: "Nouveau rendez-vous / réunion", qui: "Tout le monde", effet: "Invitations envoyées ; rappel 30 min avant." },
      { label: "Répondre Oui / Peut-être / Non", qui: "Invités", effet: "La réponse s'affiche chez l'organisateur." },
      { label: "Enregistrer / transcrire", qui: "Organisateur", effet: "Transcription Whisper + compte rendu IA." },
    ],
    regles: ["Les événements Ad & Pro (congrès, symposiums) y sont projetés pour qui voit la demande.", "Une entrevue RH acceptée crée le rendez-vous chez les deux."],
    liens: [{ vers: "ad-pro", pourquoi: "Événements Ad & Pro projetés" }, { vers: "rh", pourquoi: "Entrevues RH" }],
  },
  {
    id: "sujets", nom: "Sujets", route: "/dossiers", domaine: "pilotage", rbac: ["DOSSIERS"],
    resume: "Un sujet de suivi ad hoc : description, responsable, participants, fichiers et fil de discussion.",
    pourQui: "Tout le monde crée ; on ne voit que les sujets qu'on a créés, qu'on porte ou où l'on participe.",
    gestes: [
      { label: "Nouveau sujet", qui: "Tout le monde", effet: "Crée le sujet dans une entité que la personne voit." },
      { label: "Ajouter participants / fichiers / messages", qui: "Membres", effet: "Le fil et les pièces sont partagés aux membres." },
      { label: "Archiver", qui: "Responsable / créateur", effet: "Le sujet sort de la liste active (pas de réouverture à l'écran)." },
    ],
    regles: ["Créé automatiquement quand on « implique une tierce personne » sur un événement : il dit l'événement SANS budget.", "Ex-« Projets » : ce nom désigne désormais le registre de Business Development."],
    liens: [{ vers: "ad-pro", pourquoi: "Tierce personne impliquée → sujet automatique" }, { vers: "secretariat", pourquoi: "Demande de réservation de billets → sujet pour l'assistante" }],
  },
  {
    id: "mon-equipe", nom: "Mon équipe", route: "/mon-equipe", domaine: "pilotage", rbac: ["MY_TEAM"],
    resume: "L'écran du manager : tout l'arbre sous soi (N-1, N-2…), ce qui attend sa décision, qui est absent.",
    pourQui: "Ouvert à tous, mais n'apparaît qu'à qui a réellement des N-1 dans l'organigramme.",
    gestes: [
      { label: "« À décider »", qui: "Le manager", effet: "Congés, achats, formations (son 1er rang), marches de recrutement, plans de tournée à trancher." },
      { label: "Clic sur une personne", qui: "Le manager", effet: "KPI selon le métier (terrain, réglementaire, info médicale, coordination)." },
      { label: "Onglet KPI", qui: "Qui a le module KPI", effet: "Tableau des KPI de l'arbre, revues à signer." },
    ],
    regles: ["La porte n'est pas le module : c'est la HIÉRARCHIE, revérifiée côté serveur.", "Ni salaire, ni évaluation, ni dossier RH ici."],
    liens: [{ vers: "rh", pourquoi: "L'organigramme vient des départements RH" }, { vers: "kpi", pourquoi: "Onglet KPI" }, { vers: "conges-rh", pourquoi: "Congés à signer" }],
  },
  {
    id: "mon-dossier-rh", nom: "Mon dossier RH", route: "/mon-dossier", domaine: "pilotage", rbac: [],
    resume: "Les documents RH personnels (contrats, bulletins) et les demandes RH de la personne.",
    pourQui: "Chaque employé, sur SES propres documents uniquement.",
    gestes: [
      { label: "Demande RH", qui: "L'employé", effet: "Attestation, congé, arrêt maladie, note de frais, entrevue RH… avec pièces et fil." },
      { label: "Corriger sa note de frais", qui: "L'employé", effet: "15 minutes après l'envoi (ou si les RH rouvrent la correction)." },
      { label: "Carte « Ma rémunération »", qui: "L'employé", effet: "Base, retenues, net — jamais le brut, la Ret SS 35 % ni la TFP." },
    ],
    regles: ["Pas de module RBAC : c'est l'espace personnel de chacun.", "« Salaire versé » n'est notifié qu'une fois le virement réglé, au plus tôt 24 h après la saisie."],
    liens: [{ vers: "rh", pourquoi: "Les RH traitent les demandes" }, { vers: "secretariat", pourquoi: "Originaux des notes de frais" }],
  },
  {
    id: "kpi", nom: "KPI & bilans", route: "/mon-espace/bilan", domaine: "pilotage", rbac: ["KPI"],
    resume: "Des KPI sans code : chacun voit son bilan, le manager celui de son arbre.",
    pourQui: "Selon le module KPI ; le périmètre suit l'organigramme, jamais le rôle.",
    gestes: [
      { label: "Déclarer / proposer un KPI", qui: "Collaborateur", effet: "La déclaration attend la validation du manager." },
      { label: "Noter / valider / signer la revue", qui: "Manager", effet: "Le score pondéré est mis à jour." },
    ],
    regles: ["Le catalogue et les modèles par rôle se règlent dans Administration › KPI & modèles (Super Admin)."],
    liens: [{ vers: "mon-equipe", pourquoi: "Onglet KPI de l'équipe" }],
  },

  // ── REGULATORY ────────────────────────────────────────────────────────────────────────────
  {
    id: "regulatory", nom: "Regulatory — suivi des dossiers", route: "/regulatory", domaine: "regulatory", rbac: ["REGULATORY"],
    resume: "Les dossiers d'enregistrement AMM / ANPP : un dossier = un produit (DCI, dosage, forme, conditionnement), son CTD, ses étapes, ses BV et ses réserves.",
    pourQui: "L'équipe Regulatory (Responsable, Assistante), la Direction ; lecture pour d'autres rôles.",
    gestes: [
      { label: "Nouveau dossier", qui: "Responsable / Assistante Réglementaire", effet: "Crée le dossier avec son CTD initial (zip ou dossier) déposé à l'étape 1 ; la DCI déjà suivie est signalée." },
      { label: "Chargé du dossier (menu du tableau)", qui: "Responsable Réglementaire", effet: "Désigne la personne qui porte le dossier." },
      { label: "Cocher les étapes", qui: "Équipe Regulatory", effet: "Fait avancer le workflow 17 étapes et le niveau de process." },
      { label: "Demande de BV", qui: "Équipe Regulatory", effet: "Émet un ordre de dépense (avec échéance) vers le centre de paiement." },
      { label: "Priorité / cadenas", qui: "Super Admin (ou rôles délégués dans Réglages)", effet: "Priorise ; verrouille ou déverrouille un dossier." },
      { label: "Relance de mise à jour", qui: "Super Admin, Directeur Général", effet: "Relance une personne ou tous sur les dossiers en sommeil (30 j)." },
    ],
    regles: [
      "Onglets : À traiter (déverrouillés) · Traitement terminé (décision obtenue ou clôturé).",
      "Un dossier verrouillé est invisible pour toute l'équipe — Direction et IA comprises.",
      "Chaque dossier non verrouillé EST un produit de Produits 360, créé et tenu à jour automatiquement.",
      "Une variation en fabrication locale exige le fabricant (bloqué côté serveur).",
    ],
    liens: [
      { vers: "pipeline", pourquoi: "Les dossiers verrouillés vivent au pipeline" },
      { vers: "produits", pourquoi: "Un dossier = un produit" },
      { vers: "centre-paiement", pourquoi: "Demande de BV → ordre de dépense" },
      { vers: "budget-regulatory", pourquoi: "BV 25 % / 75 % par dossier" },
      { vers: "analyse-ctd", pourquoi: "Analyse IA du CTD" },
      { vers: "stocks", pourquoi: "Les stocks sont rattachés aux produits Regulatory" },
      { vers: "portail", pourquoi: "Le fournisseur voit un statut simplifié" },
    ],
  },
  {
    id: "pipeline", nom: "Pipeline réglementaire", route: "/regulatory/pipeline", domaine: "regulatory", rbac: ["REGULATORY_PIPELINE"],
    resume: "Les dossiers VERROUILLÉS : des produits qu'on étudie, pas encore ouverts à l'équipe.",
    pourQui: "Le Super Admin, et ceux à qui il ouvre le pipeline (Administration › Réglages : consulter ou tenir le cadenas).",
    gestes: [
      { label: "Ouvrir le cadenas", qui: "Qui tient le cadenas", effet: "Le dossier passe dans « À traiter » : l'équipe peut s'en saisir, et son produit est créé." },
      { label: "Mettre au pipeline", qui: "Super Admin", effet: "Reverrouille ; un dossier abouti reste dans « Terminé »." },
      { label: "Demander l'accès", qui: "Personne qui voit le compteur", effet: "Prévient la supervision Regulatory (le dossier est compté, jamais nommé)." },
    ],
    regles: ["Deux clés : le module ET la confidence nommée dans les Réglages.", "Déverrouiller EST l'acte qui met un dossier au travail."],
    liens: [{ vers: "regulatory", pourquoi: "Déverrouillé, il rejoint le suivi" }, { vers: "bd-projets", pourquoi: "Un dossier se classe dans un projet BD" }],
  },
  {
    id: "analyse-ctd", nom: "Analyse CTD", route: "/regulatory/enregistrement", domaine: "regulatory", rbac: [],
    resume: "Le référentiel ANPP intégré et l'analyse IA des dossiers CTD (OCR, lecture visuelle des pages, réserves).",
    pourQui: "Masqué tant que le Super Admin ne l'a pas débloqué, puis ouvert à des rôles choisis.",
    gestes: [
      { label: "Lancer une analyse", qui: "Rôles autorisés", effet: "Luna lit les pages (images comprises), Terra arbitre et rédige les constats." },
      { label: "Bibliothèque des réserves", qui: "Rôles autorisés", effet: "Retrouver des réserves ANPP passées pour préparer la réponse." },
    ],
    regles: ["L'entité analysée est choisie parmi celles ouvertes à la personne, jamais le cookie tel quel.", "Le coût IA se suit dans Administration › Coût IA & audit Regulatory."],
    liens: [{ vers: "regulatory", pourquoi: "Analyse le CTD d'un dossier" }, { vers: "admin", pourquoi: "Déblocage et coût" }],
  },
  {
    id: "budget-regulatory", nom: "Budget Regulatory", route: "/budget-regulatory", domaine: "regulatory", rbac: ["BUDGET_REGULATORY"],
    resume: "Les enveloppes du pôle Regulatory, surtout les BV par dossier (25 % en préparation, 75 % avant le dépôt).",
    pourQui: "Par défaut : Responsable Réglementaire, Direction, DG gèrent ; Finances et Assistante lisent.",
    gestes: [
      { label: "Saisir un BV payé hors circuit", qui: "Gestionnaire de l'enveloppe", effet: "Le BV compte dans l'enveloppe." },
      { label: "Ranger un BV dans l'enveloppe", qui: "Gestionnaire", effet: "Impute un BV demandé ou payé." },
    ],
    regles: ["Les mêmes lignes que Budgets : Budgets les lit sans pouvoir les régler."],
    liens: [{ vers: "regulatory", pourquoi: "BV des dossiers" }, { vers: "budgets", pourquoi: "Enveloppes partagées" }],
  },
  {
    id: "pharmacovigilance", nom: "Pharmacovigilance", route: "/regulatory/pharmacovigilance", domaine: "regulatory", rbac: ["PHARMACOVIGILANCE"],
    resume: "La boîte de réception des cas signalés par les KAM depuis leurs rapports terrain.",
    pourQui: "Regulatory voit tout ; un KAM voit ses propres signalements et les cas où on l'a ajouté.",
    gestes: [
      { label: "Signaler un cas", qui: "KAM (depuis son planning)", effet: "Crée le cas, reçu par Regulatory." },
      { label: "Instruire", qui: "Regulatory", effet: "Statut, enquête, participants." },
    ],
    regles: ["Le signalement se fait depuis Promotion médicale › Rapports."],
    liens: [{ vers: "promotion-medicale", pourquoi: "Le KAM signale depuis le terrain" }],
  },
  {
    id: "bd-projets", nom: "Projets (Business Development)", route: "/business-development/projets", domaine: "regulatory", rbac: ["BD_PROJECTS"],
    resume: "Le registre des projets stratégiques par lesquels on classe les dossiers réglementaires.",
    pourQui: "Par défaut : chaque rôle qui voit Regulatory le lit, le Super Admin le gère.",
    gestes: [
      { label: "Nouveau projet", qui: "Gestionnaire", effet: "Projet rattaché obligatoirement à une entité." },
      { label: "Supprimer", qui: "Gestionnaire", effet: "Passe par la corbeille ; ses dossiers sont déclassés, tout revient à la restauration." },
    ],
    regles: ["Market Intelligence (l'ancien Business Development) est retiré ; ce registre survit."],
    liens: [{ vers: "regulatory", pourquoi: "Colonne « Projet » des dossiers" }],
  },

  // ── MARKETING ─────────────────────────────────────────────────────────────────────────────
  {
    id: "ad-pro", nom: "Ad & Pro", route: "/ad-pro", domaine: "marketing", rbac: ["SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS", "PROMO_MATERIAL", "CONSULTING", "AD_PRO_OTHER"],
    resume: "Toutes les dépenses de promotion, en 7 natures : sponsoring, prises en charge internationales et nationales, événements, matériel promotionnel, consulting, autres.",
    pourQui: "Les KAM et managers demandent ; National Sales, Direction des opérations, Direction Marketing, DG tranchent selon le parcours.",
    gestes: [
      { label: "Nouvelle demande", qui: "Tout rôle qui peut CRÉER la nature", effet: "Le formulaire de la nature choisie s'ouvre ; la BU est déduite de l'auteur." },
      { label: "Approuver / Refuser / Renvoyer pour correction", qui: "L'étape courante du circuit", effet: "Fait avancer, arrête, ou rend la demande au demandeur (motif exigé)." },
      { label: "Fixer le montant + sous-catégorie", qui: "Direction Marketing (l'étape qui tranche)", effet: "Le budget accordé est visible du demandeur." },
      { label: "Postes (stand, hôtellerie, billetterie…)", qui: "Demandeur, Direction Marketing", effet: "Chaque poste : devis → décision → BC → facture → paiement." },
      { label: "Impliquer une tierce personne", qui: "Acteur du circuit", effet: "Validation dans l'espace de la personne + sujet automatique sans budget." },
      { label: "Supprimer la demande", qui: "Super Admin, Directeur des Opérations, Direction Marketing", effet: "Jamais l'auteur ; réversible depuis la corbeille." },
    ],
    regles: [
      "QUI demande décide PAR OÙ ça passe (5 parcours) — voir le circuit « Demande Ad & Pro ».",
      "La porte du DG s'applique au-dessus du seuil réglé, pour tout demandeur sauf le rang le plus haut.",
      "On ne tranche jamais sa propre demande.",
      "Sponsoring : la Direction Marketing pré-valide la TENUE ; l'argent se fixe poste par poste, puis à la clôture.",
    ],
    liens: [
      { vers: "centre-ad-pro", pourquoi: "Toute demande au-dessus du seuil y passe" },
      { vers: "information-medicale", pourquoi: "Déclaration PRIM si applicable" },
      { vers: "centre-paiement", pourquoi: "Chaque ordre de dépense y attend" },
      { vers: "budget-marketing", pourquoi: "Les postes accordés s'imputent ici" },
      { vers: "sujets", pourquoi: "Tierce personne → sujet" },
      { vers: "secretariat", pourquoi: "Devis, BC et réservations par l'assistante" },
      { vers: "stock-promo", pourquoi: "Poste « Matériel du stock »" },
      { vers: "agenda", pourquoi: "Événements projetés au calendrier" },
    ],
  },
  {
    id: "information-medicale", nom: "Information médicale (PRIM)", route: "/information-medicale", domaine: "marketing", rbac: ["MEDICAL_INFO"],
    resume: "Le module du pharmacien responsable de l'information médicale : déclarations au ministère et bons de versement du matériel promotionnel.",
    pourQui: "Le PRIM instruit ; le Directeur des Opérations valide ; le Super Admin à défaut.",
    gestes: [
      { label: "Soumettre sa lecture", qui: "PRIM", effet: "« À déclarer au ministère » ou « sans déclaration » (motif exigé) → validation du Directeur des Opérations." },
      { label: "Réclamer / relancer une pièce", qui: "PRIM", effet: "Notification à la personne sollicitée ; relance au plus une toutes les 4 h." },
      { label: "Séparer en matériels (bons de versement)", qui: "PRIM", effet: "Un bon par matériel ; une validation pour le lot ; un paiement par quittance." },
      { label: "Valider / Refuser", qui: "Directeur des Opérations", effet: "Validé : l'ordre de dépense naît. Refusé (motif) : retour au PRIM." },
      { label: "Ouvrir un dossier", qui: "PRIM", effet: "Deux natures seulement : déclaration MIP ou demande de visa publicitaire." },
    ],
    regles: ["Deux circuits : ÉVÉNEMENT (sans bon de versement) et MATÉRIEL PROMOTIONNEL — la nature du dossier décide.", "La fiche montre la frise puis LA seule action à faire maintenant."],
    liens: [{ vers: "ad-pro", pourquoi: "Reçoit les dossiers après la décision" }, { vers: "centre-paiement", pourquoi: "Ordres et quittances" }],
  },
  {
    id: "marketing-cockpit", nom: "Marketing cockpit", route: "/marketing-cockpit", domaine: "marketing", rbac: ["MARKETING_COCKPIT"],
    resume: "Le tableau de la Direction Marketing par produit : ciblés → segmentés → vus, leaders d'opinion, messages, marché, investissements.",
    pourQui: "Direction Marketing et ceux à qui le Super Admin l'ouvre.",
    gestes: [
      { label: "Écrire / archiver un message", qui: "Direction Marketing", effet: "Le message est proposé aux KAM dans leurs rapports ; un message porté s'archive, jamais supprimé." },
    ],
    regles: ["Rien ne s'y saisit sauf les messages.", "Les vues Marché et Investissements n'apparaissent qu'à qui lit déjà ces données."],
    liens: [{ vers: "segmentation", pourquoi: "Ciblés → segmentés" }, { vers: "promotion-medicale", pourquoi: "Messages portés en visite" }, { vers: "ad-pro", pourquoi: "Investissements" }],
  },
  {
    id: "segmentation", nom: "Segmentation", route: "/segmentation", domaine: "marketing", rbac: ["SEGMENTATION", "SEGMENTATION_POTENTIEL"],
    resume: "Le Segmentation Studio par BU : chaque praticien reçoit une LETTRE (H, A–D, NA) qui décide combien de fois le KAM doit le voir.",
    pourQui: "Direction Marketing, superviseurs ; le KAM est borné à son panel.",
    gestes: [
      { label: "Saisir Q1 / Q2 / statut", qui: "Terrain (Modifier)", effet: "Potentiel et affinité → la lettre se recalcule." },
      { label: "Publier une version de règles", qui: "Droit Valider", effet: "Nouvelles règles après aperçu de leur impact." },
      { label: "Importer le classeur de la Direction", qui: "Droit Valider", effet: "Aperçu avant écriture ; la lettre du fichier fait foi." },
      { label: "Forcer une lettre", qui: "Qui a SEGMENTATION_POTENTIEL (aucun rôle par défaut)", effet: "Dérogation motivée, gardée à côté de la valeur calculée." },
    ],
    regles: ["Le seul « requis » de visite d'un praticien = lettre × In/Out × fréquence du secteur.", "La wilaya pivot du territoire décide In / Out."],
    liens: [{ vers: "promotion-medicale", pourquoi: "La lettre pilote la tournée" }, { vers: "business-units", pourquoi: "Secteurs et wilaya pivot" }, { vers: "annuaires", pourquoi: "Praticiens de l'annuaire" }],
  },
  {
    id: "produits", nom: "Produits 360", route: "/produits", domaine: "marketing", rbac: ["PRODUCTS"],
    resume: "LE catalogue : un produit = son dossier réglementaire. Fiche 360° : ventes, terrain, réglementaire, stock, coûts, documents.",
    pourQui: "Selon le module ; chaque onglet de la fiche reste gardé par SON module.",
    gestes: [
      { label: "Prix manuel", qui: "Produits 360 ou Regulatory « Modifier »", effet: "L'emporte sur le prix observé à partir de sa date d'effet ; historisé." },
      { label: "Vérifier le catalogue", qui: "Super Admin", effet: "Bilan : produits créés, mis à jour, à compléter." },
      { label: "Comparer", qui: "Lecteurs", effet: "2 à 4 produits côte à côte (note de santé /100)." },
    ],
    regles: ["Chaque dossier non verrouillé reçoit SON produit automatiquement."],
    liens: [{ vers: "regulatory", pourquoi: "Le produit EST le dossier" }, { vers: "ventes-pch", pourquoi: "Onglet Ventes & marchés" }, { vers: "stocks", pourquoi: "Onglet Stock" }],
  },
  {
    id: "stock-promo", nom: "Stock promotionnel", route: "/stock-promotionnel", domaine: "marketing", rbac: ["PROMO_STOCK", "PROMO_CATALOG"],
    resume: "Le magasin central du matériel promotionnel, ce que chaque délégué a en main, ce qui est en route, et le catalogue (CAT-0001…).",
    pourQui: "Direction Marketing tient le magasin ; le Directeur des Opérations a la vue globale ; chaque délégué son stock.",
    gestes: [
      { label: "Entrée par facture", qui: "Magasin", effet: "Ce qui est reçu (et lui seul) entre au stock et est payé." },
      { label: "Doter un délégué", qui: "Magasin / Directeur des Opérations", effet: "N'entre dans son stock qu'à SA confirmation." },
      { label: "Remettre en visite", qui: "KAM", effet: "Sort de son stock ; au-delà de son solde la visite est bloquée." },
      { label: "Demander un comptage", qui: "Directeur des Opérations", effet: "Ponctuel ou régulier." },
    ],
    regles: ["Quantités calculées par mouvements et par lot (le plus tôt périmé sort d'abord).", "Le catalogue est tenu par le Super Admin et s'ouvre personne par personne."],
    liens: [{ vers: "ad-pro", pourquoi: "Poste « Matériel du stock » d'une demande" }, { vers: "promotion-medicale", pourquoi: "Matériel remis en visite" }],
  },
  {
    id: "budget-marketing", nom: "Budget Marketing", route: "/budget-marketing", domaine: "marketing", rbac: ["BUDGET_MARKETING"],
    resume: "Les enveloppes Ad & Pro et de la Direction Marketing, avec l'imputation de chaque poste accordé.",
    pourQui: "Par défaut : Direction Marketing, Direction, DG gèrent ; Finances lisent.",
    gestes: [
      { label: "Créer / régler une enveloppe", qui: "Créer / Modifier", effet: "Catégories, lignes, imputation." },
      { label: "Réallouer entre catégories", qui: "Gestionnaire", effet: "Montant déplacé, motif gardé dans l'historique." },
    ],
    regles: ["Les listes d'accès par enveloppe restent au Super Admin."],
    liens: [{ vers: "ad-pro", pourquoi: "Onglet Demandes Ad & Pro" }, { vers: "budgets", pourquoi: "Mêmes lignes que Budgets" }],
  },
  {
    id: "site-web", nom: "Site web", route: "/site-web", domaine: "marketing", rbac: ["SITE_WEB"],
    resume: "L'ERP publie les offres d'emploi et les articles du site public adventumdz.com, et reçoit les candidatures.",
    pourQui: "Direction, DG, Direction Marketing écrivent ; les RH publient les offres.",
    gestes: [
      { label: "Écrire un article", qui: "Rédacteurs", effet: "Envoyé au site par une file qui réessaie." },
      { label: "Publier une offre", qui: "RH", effet: "Préparée depuis une demande de recrutement, sans rémunération." },
      { label: "Rédiger avec l'IA", qui: "Rédacteurs", effet: "Brouillon proposé (interrupteur dans Contrôle IA)." },
    ],
    regles: ["La liaison (clé, mise en service) vit dans Administration › Site web (connexion), Super Admin seul."],
    liens: [{ vers: "recrutement", pourquoi: "Offres et candidatures du site" }],
  },

  // ── OPERATIONS & SALES ────────────────────────────────────────────────────────────────────
  {
    id: "cockpit-operations", nom: "Cockpit Opérations", route: "/operations", domaine: "operations", rbac: ["COCKPIT_OPERATIONS"],
    resume: "L'écran de tête du Directeur des Opérations : livré à la PCH, marchés, non servi, ruptures, couverture terrain, « À traiter ».",
    pourQui: "Directeur des Opérations, Direction, DG.",
    gestes: [{ label: "Ouvrir une ligne « À traiter »", qui: "Lecteur", effet: "Mène à l'écran du geste ; ici rien ne s'écrit." }],
    regles: ["Lecture seule ; une donnée absente s'affiche « — » avec sa raison, jamais 0."],
    liens: [{ vers: "ventes-pch", pourquoi: "Livré, non servi" }, { vers: "pch", pourquoi: "Exécution des marchés" }, { vers: "force-de-vente", pourquoi: "Couverture terrain" }, { vers: "stocks", pourquoi: "Ruptures" }],
  },
  {
    id: "promotion-medicale", nom: "Promotion médicale", route: "/medical/ma-journee", domaine: "operations", rbac: ["MEDICAL", "FIELD_REPORTS"],
    resume: "Le terrain du KAM : Ma journée, plan de tournée, visites, rapports (vocaux ou écrits), coaching.",
    pourQui: "KAM (Délégués médicaux), superviseurs, Manager Promotion médicale.",
    gestes: [
      { label: "Soumettre le plan de tournée", qui: "KAM", effet: "Son N+1 valide (ou escalade au N+2) ; rejet motivé = 48 h pour resoumettre." },
      { label: "Saisir une visite (3 gestes)", qui: "KAM", effet: "Praticien + produits de sa mallette + un mot ; refusée hors panel ou future." },
      { label: "Faire le rapport", qui: "KAM", effet: "Dans les 48 h : produits de sa BU + messages de la Direction Marketing ; vocal → Whisper → IA → relecture." },
      { label: "N'a pas eu lieu", qui: "KAM", effet: "Visite reportée ou annulée, motif exigé, même fenêtre de 48 h." },
      { label: "Fiche de coaching", qui: "Superviseur / Directeur des Opérations", effet: "Grille 4 niveaux × 5 axes, finalisée et partagée au collaborateur." },
    ],
    regles: ["La lettre de segmentation remplace le potentiel dans la tournée.", "L'IA ne valide jamais seule un rapport."],
    liens: [
      { vers: "segmentation", pourquoi: "Le requis vient de la lettre" },
      { vers: "force-de-vente", pourquoi: "Pilotage du réalisé" },
      { vers: "pharmacovigilance", pourquoi: "Signalement depuis le terrain" },
      { vers: "stock-promo", pourquoi: "Matériel remis en visite" },
      { vers: "annuaires", pourquoi: "Praticiens et établissements" },
    ],
  },
  {
    id: "force-de-vente", nom: "Force de vente", route: "/planning", domaine: "operations", rbac: ["SALES_PLANNING"],
    resume: "L'outil du superviseur et de la Direction : délégués triés par retard sur le requis, territoires, affectation des produits P1/P2/P3.",
    pourQui: "Superviseurs, Directeur des Opérations (gère), Direction Marketing (lecture seule).",
    gestes: [
      { label: "Affecter une cible hors panel", qui: "Configuration", effet: "Rattache en un clic une cible H ou A au délégué du secteur." },
      { label: "Matrice délégué × produit", qui: "Configuration", effet: "P1/P2/P3 ; « Reprendre le mois précédent »." },
    ],
    regles: ["Alertes au superviseur : silence 5 j, retard à mi-mois, couverture < 50 % après le 25."],
    liens: [{ vers: "promotion-medicale", pourquoi: "Le réalisé du terrain" }, { vers: "business-units", pourquoi: "Le montage des secteurs" }],
  },
  {
    id: "business-units", nom: "Business Units", route: "/business-units", domaine: "operations", rbac: ["BUSINESS_UNITS"],
    resume: "Le montage de la force de vente : BU, superviseur, spécialités, produits, KAM, secteurs et paramètres.",
    pourQui: "Ceux qui configuraient la Force de vente ; la maille des plans au Super Admin.",
    gestes: [
      { label: "Monter une BU (4 étapes)", qui: "Configuration", effet: "BU et superviseur → spécialités et produits → KAM → secteurs." },
      { label: "Wilaya pivot", qui: "Configuration", effet: "Décide In / Out de la segmentation." },
    ],
    regles: ["La BU d'une demande Ad & Pro se déduit de l'auteur grâce à ce montage."],
    liens: [{ vers: "force-de-vente", pourquoi: "Territoires" }, { vers: "segmentation", pourquoi: "In / Out" }, { vers: "ad-pro", pourquoi: "BU déduite" }],
  },
  {
    id: "pch", nom: "PCH — Marchés", route: "/pch", domaine: "operations", rbac: ["PCH"],
    resume: "Market 360° : appel d'offres → soumission versionnée → attribution par lot → contrat & avenants → BC → livraisons → factures.",
    pourQui: "Opérations, Direction.",
    gestes: [
      { label: "Lire l'AO (IA)", qui: "PCH Modifier", effet: "Les lignes produits sont extraites du PDF ; chaque lecture est tracée." },
      { label: "Déposer la soumission", qui: "PCH Modifier", effet: "Verrouille la version (plus de retouche côté serveur)." },
      { label: "Contrat depuis l'attribution", qui: "PCH Modifier + Legal Créer", effet: "Crée la pièce Legal et ses lignes." },
      { label: "BC à lignes", qui: "PCH", effet: "Contrôle du restant contractuel ; dépassement = refus chiffré." },
    ],
    regles: ["Le cycle de vie est DÉRIVÉ des faits (seuls annulé / suspendu / perdu / clôturé se décident).", "Rappels d'échéance de dépôt à J-7, J-2 et dépassement."],
    liens: [{ vers: "legal", pourquoi: "Contrat = un objet Legal" }, { vers: "stocks", pourquoi: "Livraisons" }, { vers: "ventes-pch", pourquoi: "Chaîne AO → BC" }],
  },
  {
    id: "ventes-pch", nom: "Ventes PCH", route: "/sales", domaine: "operations", rbac: ["PCH_VENTES"],
    resume: "Les fichiers de la PCH importés : ventes des DR aux hôpitaux, réceptions de la PCH centrale, non servi, part de marché.",
    pourQui: "Directeur des Opérations, Direction, DG gèrent ; National Sales, Head of Sales, Direction Marketing lisent.",
    gestes: [
      { label: "Importer", qui: "Téléverser", effet: "Même fichier = rien ; un plus récent remplace sa DR × mois." },
      { label: "Rattacher", qui: "Modifier", effet: "Client → établissement, poste PCH → produit, fournisseur « à nous »." },
    ],
    regles: ["Remplace l'ancienne saisie manuelle des Ventes (retirée, lisible en historique)."],
    liens: [{ vers: "produits", pourquoi: "Ventes & marchés" }, { vers: "stocks", pourquoi: "Consommation mensuelle → couverture" }, { vers: "cockpit-operations", pourquoi: "Tuiles du cockpit" }],
  },
  {
    id: "stocks", nom: "Stocks", route: "/stocks", domaine: "operations", rbac: ["STOCKS"],
    resume: "Des états datés (« à cette date, il reste X ») : stock PCH, hôpitaux, annexes, et la chaîne avec sa couverture en mois.",
    pourQui: "La chaîne d'approvisionnement voit tout ; un KAM les hôpitaux de son secteur.",
    gestes: [
      { label: "Saisir un état", qui: "Stocks Créer / Modifier", effet: "Un état par jour (ressaisir = corriger)." },
      { label: "Demander un état de stock", qui: "Chaîne d'approvisionnement", effet: "Tâche assignée à une personne ; possible en récurrence." },
      { label: "Coller le tableau PCH central", qui: "Chaîne d'approvisionnement", effet: "Saisie depuis le mail de la PCH." },
    ],
    regles: ["Couverture = stock ÷ consommation mensuelle (moyenne des 3 derniers mois de Ventes PCH)."],
    liens: [{ vers: "regulatory", pourquoi: "Produits Regulatory" }, { vers: "ventes-pch", pourquoi: "Consommation" }],
  },
  {
    id: "budget-operations", nom: "Budget Operations & Sales", route: "/budget-operations", domaine: "operations", rbac: ["BUDGET_OPERATIONS"],
    resume: "Les enveloppes du pôle : masse salariale par BU face à la paie réelle, dépenses hors Ad & Pro.",
    pourQui: "Directeur des Opérations, Direction, DG gèrent ; Finances lisent.",
    gestes: [{ label: "Régler une enveloppe", qui: "Gestionnaire", effet: "Budget de l'année par BU." }],
    regles: ["Le détail par personne n'est visible que de qui voit les salaires."],
    liens: [{ vers: "rh", pourquoi: "Paie réelle" }, { vers: "budgets", pourquoi: "Mêmes lignes" }],
  },
  {
    id: "explorateur", nom: "Explorateur produits", route: "/explorateur-produits", domaine: "operations", rbac: ["PRODUCT_EXPLORER"],
    resume: "Chercher un produit, une molécule ou un laboratoire dans les données de marché ; comparer volume, prix, valeur.",
    pourQui: "Selon le module.",
    gestes: [{ label: "Rechercher / comparer", qui: "Lecteurs", effet: "Recherche en temps réel, multi-sélection." }],
    regles: ["Survit au retrait de Market Intelligence."],
    liens: [{ vers: "produits", pourquoi: "Prix observé de repli" }],
  },
  {
    id: "consommation", nom: "Consommation", route: "/consommation", domaine: "operations", rbac: ["CONSUMPTION"],
    resume: "Les fichiers de consommation hospitalière rendus fiables, et l'affinité par établissement qu'on en tire.",
    pourQui: "Selon le module (plus d'entrée de menu).",
    gestes: [{ label: "Importer / trancher / valider", qui: "Téléverser / Valider", effet: "Les lignes ne comptent qu'une fois l'import validé." }],
    regles: ["Nourrit l'affinité de la segmentation et Produits 360."],
    liens: [{ vers: "segmentation", pourquoi: "Affinité" }, { vers: "produits", pourquoi: "Fiche produit" }],
  },

  // ── ADMINISTRATION & RH ───────────────────────────────────────────────────────────────────
  {
    id: "secretariat", nom: "Bureau du secrétariat", route: "/demandes", domaine: "administration", rbac: ["ADMIN_REQUESTS"],
    resume: "Le bureau de l'assistante de direction : déplacements, courriers, signatures, achats, devis, paiements, visas d'invités…",
    pourQui: "Tout le monde demande ; les Assistantes de direction traitent ; DRH et Finances voient tout en lecture.",
    gestes: [
      { label: "Nouvelle demande", qui: "Tout le monde", effet: "Les assistantes sont prévenues ; 30 min pour modifier ou supprimer en silence." },
      { label: "Commencer le traitement", qui: "Assistante de direction", effet: "Le demandeur lit « En cours — chez l'assistante de direction »." },
      { label: "Fin du traitement", qui: "Assistante de direction", effet: "Un achat exige sa facture et son imputation ; la demande est archivée dans le Drive." },
      { label: "Retenir des lignes de devis → générer le BC", qui: "Demandeur (ou Super Admin)", effet: "Un BC par fournisseur → centre de validations (au-dessus du seuil) → signature." },
      { label: "Accuser réception des originaux", qui: "Assistante", effet: "Débloque le traitement RH d'une note de frais." },
      { label: "Rouvrir… / Annuler la demande…", qui: "Assistante", effet: "Motif exigé ; une annulée ne se rouvre pas." },
    ],
    regles: ["Plus aucun statut posé à la main : deux gestes (Commencer, Fin).", "L'approbation N+1 d'un achat reste en amont (« Attente validation »)."],
    liens: [
      { vers: "validations", pourquoi: "Approbations et validations" },
      { vers: "bons-de-commande", pourquoi: "BC à signer" },
      { vers: "centre-paiement", pourquoi: "Paiements" },
      { vers: "moyens-generaux", pourquoi: "Imputation d'un achat" },
      { vers: "drive", pourquoi: "Archive « Dossier traité »" },
      { vers: "rh", pourquoi: "Originaux des notes de frais" },
    ],
  },
  {
    id: "rh", nom: "RH (employés, demandes, paie)", route: "/rh", domaine: "administration", rbac: ["RH", "EMPLOYEES", "HR_REQUESTS"],
    resume: "Les employés, contrats, périodes d'essai, la file des demandes RH, les notes de frais, la paie et les départements.",
    pourQui: "Qui tient les RH (Direction, DG par défaut — il n'y a pas de rôle « RH »).",
    gestes: [
      { label: "Traiter une demande RH", qui: "RH", effet: "Attestations, congés, arrêts, entrevues (date négociée → rendez-vous)." },
      { label: "Valider une note de frais", qui: "RH", effet: "Mois demandé / mois suivant / refuser — verrouillé tant que le secrétariat n'a pas les originaux." },
      { label: "Saisir la paie (matrice)", qui: "RH Modifier", effet: "Saisi → Envoyé → Viré." },
      { label: "Envoyer la paie au centre", qui: "RH Modifier", effet: "Un virement par entité et par mois, somme déclarée à la main." },
      { label: "Valider un intérim", qui: "RH", effet: "L'intérimaire reçoit les modules prêtés pendant le congé." },
      { label: "Départements", qui: "DRH", effet: "La structure de l'entreprise (N niveaux) : elle décide les N+1." },
    ],
    regles: ["Le salarié ne voit JAMAIS le brut, la Ret SS 35 % ni la TFP.", "L'organigramme est la seule source de la hiérarchie."],
    liens: [
      { vers: "conges-rh", pourquoi: "Congés et intérims" },
      { vers: "centre-paiement", pourquoi: "Paie virée par le centre" },
      { vers: "recrutement", pourquoi: "Intégration de la recrue" },
      { vers: "mon-dossier-rh", pourquoi: "Demandes des employés" },
      { vers: "budget-operations", pourquoi: "Masse salariale" },
    ],
  },
  {
    id: "conges-rh", nom: "Congés & intérim", route: "/rh", domaine: "administration", rbac: ["HR_REQUESTS"],
    resume: "Le congé d'un employé et l'intérimaire qui tient sa place pendant l'absence.",
    pourQui: "L'employé demande ; son N+1 puis les RH signent ; la direction peut signer à toute marche.",
    gestes: [
      { label: "Demander un congé", qui: "Employé (Mon dossier RH)", effet: "Arrive chez son N+1." },
      { label: "Signer", qui: "N+1 puis RH", effet: "Deux marches (l'étape DG a été supprimée le 06/10) ; un refus arrête tout." },
      { label: "Désigner un intérimaire", qui: "L'absent", effet: "Choisit les modules prêtés ; les RH valident." },
    ],
    regles: ["L'intérim ne s'ouvre que les jours du congé et s'éteint seul.", "Jamais prêtés : administration, Drive, messagerie, sièges des centres ; et jamais le droit de supprimer."],
    liens: [{ vers: "mon-equipe", pourquoi: "Congés à signer" }, { vers: "rh", pourquoi: "Validation RH" }],
  },
  {
    id: "recrutement", nom: "Recrutement", route: "/recrutement", domaine: "administration", rbac: ["RECRUITMENT"],
    resume: "Le poste demandé, de l'idée à l'intégration : validation hiérarchique jusqu'au DG, diffusion, CV, entretiens, embauche.",
    pourQui: "N'importe qui peut demander ; les RH instruisent ; la hiérarchie valide marche par marche.",
    gestes: [
      { label: "Demander un poste", qui: "Tout le monde", effet: "Chaîne figée à la soumission, jusqu'au DG." },
      { label: "Valider / Renvoyer / Refuser", qui: "Chaque marche", effet: "Motif exigé pour renvoyer ou refuser." },
      { label: "Désigner le N+1 et le suivi", qui: "DG (dernière marche)", effet: "Obligatoire pour conclure." },
      { label: "Diffuser", qui: "RH", effet: "Site, LinkedIn (post préparé par Luna), Emploitic." },
      { label: "Intégrer", qui: "RH", effet: "Fiche employé pré-remplie (sauf consulting)." },
    ],
    regles: ["Une embauche s'annule tant que la fiche employé n'existe pas."],
    liens: [{ vers: "site-web", pourquoi: "Offres et candidatures" }, { vers: "rh", pourquoi: "Intégration" }],
  },
  {
    id: "formations", nom: "Formations", route: "/formations", domaine: "administration", rbac: ["TRAINING"],
    resume: "Demandes individuelles et formations organisées par les RH, avec participants et postes.",
    pourQui: "Tout le monde demande ; N+1 → RH → DG valident.",
    gestes: [
      { label: "Demande individuelle", qui: "Employé", effet: "Montant, organisme, dates, devis → N+1 → RH → DG." },
      { label: "Organiser une formation", qui: "RH", effet: "Part directement au DG ; convoqués ou volontaires." },
    ],
    regles: ["Budget FORMATION parmi les budgets départementaux."],
    liens: [{ vers: "mon-espace", pourquoi: "Bouton « Demande de formation »" }, { vers: "centre-paiement", pourquoi: "Paiement de la formation" }],
  },
  {
    id: "moyens-generaux", nom: "Moyens généraux", route: "/moyens-generaux", domaine: "administration", rbac: ["GENERAL_MEANS"],
    resume: "Le budget, les achats et la caisse d'avance du service des moyens généraux de la société.",
    pourQui: "Super Admin, Direction, DG, Directeur des Opérations, Finances (gèrent) ; Assistante de direction (utilisatrice).",
    gestes: [
      { label: "Saisir une dépense", qui: "Utilisateur du module", effet: "Montant + scan de la facture obligatoires ; déduite du budget." },
      { label: "Remettre une caisse", qui: "Qui modifie les RH", effet: "La remise passe par le centre de paiement avant le versement." },
      { label: "Confirmer la réception", qui: "Détenteur de la caisse", effet: "Rien n'est disponible avant." },
      { label: "Demander une rallonge", qui: "Détenteur", effet: "Seul chemin d'argent hors centre de paiement." },
      { label: "Changer de service…", qui: "Super Admin", effet: "Désigne le département qui tient la caisse de la société." },
    ],
    regles: ["Un seul service pour tous, Super Admin compris.", "L'accès se règle dans la console, nulle part ailleurs.", "Sans le module : on est renvoyé vers le Bureau du secrétariat."],
    liens: [{ vers: "secretariat", pourquoi: "Achats imputés à la clôture" }, { vers: "centre-paiement", pourquoi: "Remises de caisse" }, { vers: "budgets", pourquoi: "Imputation par département" }],
  },
  {
    id: "legal", nom: "Legal", route: "/legal", domaine: "administration", rbac: ["LEGAL"],
    resume: "Le registre des documents légaux et la chaîne d'achat devis → BC → facture → avoir, avec la fabrique de pièces.",
    pourQui: "Juridique, Direction ; les Finances ne voient que la chaîne d'achat.",
    gestes: [
      { label: "Composer une pièce", qui: "Legal / Finances", effet: "Devis, BC, facture au papier en-tête de l'entité." },
      { label: "Lecteurs désignés", qui: "Auteur", effet: "Un document restreint n'existe que pour eux." },
    ],
    regles: ["Les factures sont des documents Legal de nature « facture »."],
    liens: [{ vers: "bons-de-commande", pourquoi: "BC à signer" }, { vers: "pch", pourquoi: "Contrats de marché" }, { vers: "direction-artistique", pourquoi: "Modèles de pièces" }],
  },
  {
    id: "courriers", nom: "Courriers", route: "/courriers", domaine: "administration", rbac: ["MAIL_REGISTER"],
    resume: "Le registre des plis entrants et sortants : chrono, expéditeur, destinataire, dossiers de classement, pièces.",
    pourQui: "Assistante de direction ; le Super Admin l'ouvre à qui il veut.",
    gestes: [{ label: "Enregistrer un courrier", qui: "Assistante", effet: "N° de chrono, pièces, classement depuis le Drive sans copie." }],
    regles: ["Ce n'est pas une messagerie : c'est la trace des plis."],
    liens: [{ vers: "annuaires", pourquoi: "Expéditeurs et destinataires" }, { vers: "drive", pourquoi: "Classement" }],
  },
  {
    id: "annuaires", nom: "Annuaires", route: "/annuaires", domaine: "administration", rbac: ["DIRECTORIES"],
    resume: "Tous les annuaires au même endroit : médecins, pharmaciens, établissements, spécialités, partenaires, personnes.",
    pourQui: "La porte est ouverte à tous ; chaque onglet est gardé par le module de SON référentiel.",
    gestes: [
      { label: "Feuille tableur", qui: "Qui modifie le référentiel", effet: "Édition en place, couleurs, colonnes sur mesure." },
      { label: "Accès par annuaire", qui: "Super Admin (console)", effet: "Ouvre un annuaire précis sans donner tout le module." },
    ],
    regles: ["La wilaya est le seul découpage géographique (58, liste fermée)."],
    liens: [{ vers: "promotion-medicale", pourquoi: "Praticiens" }, { vers: "segmentation", pourquoi: "Panel" }],
  },
  {
    id: "direction-artistique", nom: "Direction artistique", route: "/direction-artistique", domaine: "administration", rbac: ["ART_DIRECTION"],
    resume: "La papeterie de chaque entité : papiers en-tête, modèles de BC / devis / facture, PowerPoint, Excel, logo et charte.",
    pourQui: "Assistante de direction ; le Super Admin l'ouvre à d'autres.",
    gestes: [{ label: "Déposer un modèle / choisir le défaut", qui: "Téléverser / Modifier", effet: "La fabrique de pièces lit ce modèle." }],
    regles: ["Jamais le papier d'une autre entité."],
    liens: [{ vers: "legal", pourquoi: "Fabrique de pièces" }],
  },
  {
    id: "budget-campagne", nom: "Campagne budgétaire", route: "/budget-campagne", domaine: "administration", rbac: ["BUDGET_CAMPAIGN"],
    resume: "Budgets de l'année suivante : chaque pôle prépare sa proposition pré-remplie, les valideurs examinent, on arbitre, on valide.",
    pourQui: "Direction et DG pilotent ; chaque responsable de département prépare son pôle ; Finances lisent.",
    gestes: [
      { label: "Préparer et soumettre", qui: "Responsable de département", effet: "Justification exigée au-delà de ±5 %." },
      { label: "À revoir / valider", qui: "Comité nommé", effet: "« À revoir » renvoie (v2…) ; validé, l'enveloppe de l'année s'ouvre seule." },
    ],
    regles: ["Le cadrage du DG est privé.", "Pas de révision après validation sauf rectificatif autorisé par le Super Admin."],
    liens: [{ vers: "budgets", pourquoi: "Crée les enveloppes" }],
  },

  // ── ARGENT ────────────────────────────────────────────────────────────────────────────────
  {
    id: "centre-paiement", nom: "Centre de paiement", route: "/centre-de-paiement", domaine: "argent", rbac: ["PAYMENT_CENTRE"],
    resume: "Le guichet unique : AUCUN paiement de la société n'atteint les Finances sans y être autorisé, quel que soit le montant.",
    pourQui: "Y siègent le PDG (rôle Direction), le Super Admin, et les sièges nommés par lui. Cocher le module ne suffit pas.",
    gestes: [
      { label: "Autoriser", qui: "Siège", effet: "L'ordre de dépense part aux Finances pour règlement." },
      { label: "Refuser", qui: "Siège", effet: "Motif ; l'ordre se ferme." },
    ],
    regles: [
      "Seule exception : la rallonge de caisse d'avance.",
      "Rangé par entité puis en trois sections : Regulatory · Sales & Marketing · Autres.",
      "Celui qui autorise n'est jamais dans l'écran de celui qui décaisse.",
    ],
    liens: [{ vers: "finances", pourquoi: "Ce qui est autorisé y est réglé" }],
  },
  {
    id: "finances", nom: "Finances", route: "/finances/paiements-a-faire", domaine: "argent", rbac: ["FINANCES"],
    resume: "Deux sous-modules : Banque & paiements (solde, file de décaissement) et Comptabilité (livre, comptes ancrés).",
    pourQui: "Responsable Finance / Budget (le comptable), Direction.",
    gestes: [
      { label: "Régler un ordre", qui: "Comptable", effet: "Facture obligatoire ; crée la sortie de trésorerie et l'impute à la catégorie budgétaire du module d'origine." },
      { label: "Demander l'actualisation des soldes", qui: "Super Admin", effet: "Relance tracée des responsables Finances." },
    ],
    regles: ["Solde trésorerie = somme des comptes − paiements autorisés à régler.", "La file n'est alimentée QUE par le centre de paiement."],
    liens: [{ vers: "centre-paiement", pourquoi: "Source unique de la file" }, { vers: "budgets", pourquoi: "Imputation automatique" }, { vers: "legal", pourquoi: "Factures" }],
  },
  {
    id: "budgets", nom: "Budgets & enveloppes", route: "/budgets", domaine: "argent", rbac: ["BUDGETS"],
    resume: "Les enveloppes budgétaires : période, modules rattachés, catégories et sous-catégories, consommation et santé.",
    pourQui: "Super Admin (délégable) ; accès par rôle ET par personne.",
    gestes: [
      { label: "Créer une enveloppe", qui: "Gestionnaire", effet: "Total fixe ou flexible ; catégories." },
      { label: "Allouer une dépense validée", qui: "Gestionnaire", effet: "La consommation se recalcule." },
    ],
    regles: ["Une enveloppe de pôle (Marketing, Regulatory, Operations) se LIT ici mais se règle dans son pôle."],
    liens: [{ vers: "budget-marketing", pourquoi: "Pôle Marketing" }, { vers: "budget-regulatory", pourquoi: "Pôle Regulatory" }, { vers: "budget-operations", pourquoi: "Pôle Operations" }],
  },
  {
    id: "centre-validations", nom: "Centre de validations", route: "/centre-de-validations", domaine: "argent", rbac: ["VALIDATION_CENTRE"],
    resume: "Le pendant décisionnel du centre de paiement : ce qu'on attend du DG, avec pièces et contexte (dont les BC hors Ad & Pro au-dessus du seuil).",
    pourQui: "Le Directeur Général et le Super Admin. Cocher le module ne suffit pas.",
    gestes: [{ label: "Valider / Refuser", qui: "DG, Super Admin", effet: "La demande source reprend son circuit." }],
    regles: ["On demande et suit ses validations dans « Demandes de validations » ; ici on décide."],
    liens: [{ vers: "bons-de-commande", pourquoi: "BC validés → à signer" }, { vers: "validations", pourquoi: "Les demandes viennent de là" }],
  },
  {
    id: "centre-ad-pro", nom: "Centre de validation Ad & Pro", route: "/centre-ad-pro", domaine: "argent", rbac: ["AD_PRO_CENTRE"],
    resume: "Toute demande Ad & Pro au-dessus du seuil y passe ; le seuil des demandes et celui des BC s'y règlent.",
    pourQui: "Directeur Général et Super Admin, personne d'autre.",
    gestes: [
      { label: "Viser", qui: "DG, Super Admin", effet: "Pour un visa : décidé ici. Pour une étape de circuit : renvoie au dossier." },
      { label: "Régler le seuil", qui: "DG, Super Admin", effet: "Le même chiffre qu'Administration › Réglages ; il réaiguille ce qui est en vol." },
    ],
    regles: ["Une LENTILLE, pas une seconde autorisation.", "La Direction Marketing n'y siège pas : elle s'autoriserait le dépassement qu'elle a proposé."],
    liens: [{ vers: "ad-pro", pourquoi: "Demandes au-dessus du seuil" }, { vers: "bons-de-commande", pourquoi: "Seuil des BC" }],
  },
  {
    id: "bons-de-commande", nom: "Bons de commande", route: "/bons-de-commande", domaine: "argent", rbac: ["PURCHASE_ORDERS"],
    resume: "La file des BC à SIGNER : validés par leur centre, ou sous le seuil.",
    pourQui: "Par défaut Direction, DG et Finances signent ; le Directeur des Opérations lit.",
    gestes: [
      { label: "Signer", qui: "Droit « Modifier »", effet: "Attestation humaine (jamais Adam) ; modifier ensuite le montant retire la signature." },
      { label: "Renvoyer à l'émetteur", qui: "Signataire", effet: "Motif exigé ; toute modification le rend à la signature." },
    ],
    regles: ["Seuil 0 (défaut) = tout BC passe par un centre."],
    liens: [{ vers: "centre-validations", pourquoi: "BC hors Ad & Pro au-dessus du seuil" }, { vers: "centre-ad-pro", pourquoi: "BC Ad & Pro au-dessus du seuil" }, { vers: "legal", pourquoi: "Le BC est une pièce Legal" }],
  },

  // ── TRANSVERSE ────────────────────────────────────────────────────────────────────────────
  {
    id: "validations", nom: "Demandes de validations", route: "/validations", domaine: "transverse", rbac: ["VALIDATIONS"],
    resume: "Le bureau central : toutes les validations en attente, quel que soit le module, avec des règles configurables.",
    pourQui: "Chacun demande et suit les siennes ; les validateurs décident ; Direction et Super Admin supervisent.",
    gestes: [
      { label: "Valider / Renvoyer pour correction / Refuser", qui: "Validateur assigné (ou son intérimaire)", effet: "Motif obligatoire pour renvoyer et refuser ; fait avancer le circuit." },
      { label: "Resoumettre", qui: "Demandeur", effet: "Reprend à l'étape qui l'a renvoyée (tout repart si le montant monte)." },
      { label: "Règles de validation", qui: "Super Admin (Administration)", effet: "Module, montant, rôle… → 1 ou 2 validateurs, séquentiel ou parallèle." },
    ],
    regles: ["Personne ne valide sa propre demande.", "Le 2ᵉ validateur d'un circuit séquentiel voit la demande avant son tour."],
    liens: [{ vers: "mon-espace", pourquoi: "« À valider »" }, { vers: "centre-validations", pourquoi: "Ce qui attend le DG" }, { vers: "admin", pourquoi: "Règles" }],
  },
  {
    id: "pieces", nom: "Pièces demandées", route: "/pieces", domaine: "transverse", rbac: [],
    resume: "Réclamer une pièce précise à quelqu'un (facture, devis, attestation), avec échéance et fil.",
    pourQui: "Tout le monde ; l'accès vient du FIL, pas du module.",
    gestes: [
      { label: "Demander une pièce", qui: "Tout acteur d'un objet", effet: "La personne est prévenue et dépose." },
      { label: "Accepter / refuser en disant ce qui manque", qui: "Demandeur", effet: "On n'accepte jamais sa propre pièce." },
    ],
    regles: ["Mécanisme générique : il marche depuis n'importe quel objet de l'ERP."],
    liens: [{ vers: "mon-espace", pourquoi: "Section Pièces demandées" }, { vers: "ad-pro", pourquoi: "Depuis un poste" }],
  },
  {
    id: "drive", nom: "Drive", route: "/drive", domaine: "transverse", rbac: ["DRIVE"],
    resume: "Le stockage chiffré : visionneuses, édition Office, versions, catégories partagées, archive automatique des demandes traitées.",
    pourQui: "Tout le monde gère son Drive ; les catégories partagées ont leurs accès.",
    gestes: [
      { label: "Importer / déplacer / partager", qui: "Propriétaire", effet: "Accès par personne (voir / modifier)." },
      { label: "Éditer dans Office", qui: "Qui peut modifier", effet: "OnlyOffice, nouvelle version." },
    ],
    regles: ["Les demandes terminées (secrétariat, RH, PRIM) y sont archivées dans « Dossier traité »."],
    liens: [{ vers: "secretariat", pourquoi: "Archives" }, { vers: "courriers", pourquoi: "Classement sans copie" }],
  },
  {
    id: "recherche", nom: "Recherche globale", route: "/search", domaine: "transverse", rbac: [],
    resume: "La recherche ⌘K : elle cherche exactement dans ce que chaque écran de liste montre à la personne, et nulle part ailleurs.",
    pourQui: "Tout le monde.",
    gestes: [{ label: "⌘K", qui: "Tout le monde", effet: "Résultats filtrés par entité, portée, lecteurs, publication." }],
    regles: ["Chaque famille lit la clause de SA liste : pas de fuite par la recherche."],
    liens: [],
  },
  {
    id: "support", nom: "Support & feedback", route: "/feedback", domaine: "transverse", rbac: ["SUPPORT", "FEEDBACK"],
    resume: "Retour libre vers l'administration (avec réponse), et demandes de support vers le directeur médical ou la Direction Marketing.",
    pourQui: "Tout le monde.",
    gestes: [{ label: "Envoyer un feedback", qui: "Tout le monde", effet: "L'administration répond ; la réponse s'affiche à l'utilisateur." }],
    regles: ["Les feedbacks se traitent dans Administration › Feedbacks."],
    liens: [{ vers: "admin", pourquoi: "Boîte des feedbacks" }],
  },

  // ── SYSTÈME & IA ──────────────────────────────────────────────────────────────────────────
  {
    id: "admin", nom: "Administration", route: "/admin", domaine: "systeme", rbac: ["ADMIN"],
    resume: "La console : comptes, matrice d'accès, sessions, audit, réglages, règles de validation, circuits, entités, IA, corbeille, Vue exacte.",
    pourQui: "Super Admin, souverain et seul.",
    gestes: [
      { label: "Créer / modifier un compte", qui: "Super Admin", effet: "Rôle principal, rôle secondaire, entités." },
      { label: "Accès (onglet × action × ligne)", qui: "Super Admin", effet: "Ouvre, ferme ou bloque un module pour une personne ; le blocage prime." },
      { label: "Vue exacte", qui: "Super Admin", effet: "Voir l'ERP comme une personne 4 h ; les écritures restent à SON nom (sauf création Ad & Pro)." },
      { label: "Circuits de validation", qui: "Super Admin", effet: "Remodeler étape par étape les circuits Ad & Pro." },
      { label: "Corbeille", qui: "Super Admin", effet: "Restaurer une suppression définitive." },
      { label: "Contrôle IA", qui: "Super Admin", effet: "Interrupteurs, état des clés, usage." },
    ],
    regles: ["Le cookie d'entité est une demande, jamais une autorisation.", "Rejeu de session : la suite des actions d'une personne, sans aucune valeur de champ."],
    liens: [{ vers: "validations", pourquoi: "Règles de validation" }, { vers: "carte", pourquoi: "Cette carte" }],
  },
  {
    id: "carte", nom: "Carte de la plateforme", route: "/admin/carte-plateforme", domaine: "systeme", rbac: [],
    resume: "Cette page : les modules, leurs gestes, les circuits et les droits par rôle, lus en direct.",
    pourQui: "Super Admin uniquement.",
    gestes: [{ label: "Cliquer un module ou un circuit", qui: "Super Admin", effet: "Le détail s'ouvre ; les droits par rôle sont lus dans la matrice réelle." }],
    regles: ["Les droits affichés sont les DÉFAUTS par rôle : les réglages de la console et les accès implicites s'y ajoutent."],
    liens: [{ vers: "admin", pourquoi: "Lien depuis la console" }],
  },
  {
    id: "brain", nom: "Adventum Brain", route: "/adventum-brain", domaine: "systeme", rbac: ["ADVENTUM_BRAIN", "PROCESS_INTELLIGENCE"],
    resume: "Le cockpit qui voit ce que les autres ne voient pas : briefing de 7 h, risques, question libre, et Process Intelligence (temps réel par étape).",
    pourQui: "Super Admin ; ouvrable au Directeur des Opérations, borné aux opérations.",
    gestes: [
      { label: "Risques", qui: "Super Admin", effet: "Nouveau → pris en charge → résolu, ou ignoré jusqu'à une date." },
      { label: "Demander", qui: "Super Admin", effet: "Réponse ancrée et sourcée." },
    ],
    regles: ["Seuils des détecteurs réglables (RiskSetting)."],
    liens: [{ vers: "admin", pourquoi: "Réglages" }],
  },
  {
    id: "adam", nom: "Adam (chief of staff)", route: "/chief-of-staff", domaine: "systeme", rbac: ["CHIEF_OF_STAFF"],
    resume: "« My Chief of Staff » : lire, proposer des actions, rédiger. EN PAUSE de développement.",
    pourQui: "Le SEUL Super Admin (rôle principal). Ni la Direction, ni un Super Admin en rôle secondaire.",
    gestes: [
      { label: "Poser une question", qui: "Super Admin", effet: "Réponse limitée à ce que la personne peut lire." },
      { label: "Carte de confirmation", qui: "Super Admin", effet: "Aucune écriture sans confirmation ; plus de 100 actions lui sont interdites." },
    ],
    regles: ["Désactivé en Vue exacte.", "Aucun mail ne part sans approbation du contenu exact (politique par défaut)."],
    liens: [{ vers: "admin", pourquoi: "Contrôle IA" }],
  },
  {
    id: "assistant-ia", nom: "Assistant IA", route: "/assistant", domaine: "systeme", rbac: ["ASSISTANT_IA"],
    resume: "L'assistant de conversation (Mastra + MiMo) : lire ce que la personne peut lire, préparer une tâche ou un message.",
    pourQui: "Le Super Admin, et chaque personne à qui il ouvre le module dans Administration › Accès.",
    gestes: [
      { label: "Poser une question", qui: "Toute personne qui a le module", effet: "Ses outils sont ceux de SON rôle et de SES accès ; rémunérations, coordonnées bancaires et pièces d'identité sont masquées avant le modèle." },
      { label: "Carte de confirmation", qui: "Toute personne qui a le module", effet: "Rien ne s'écrit avant la confirmation ; le droit est revérifié à l'exécution." },
    ],
    regles: ["Jamais prêté par un intérim : l'assistant agit au nom de son utilisateur."],
    liens: [{ vers: "admin", pourquoi: "Accès" }],
  },

  // ── EXTERNE ───────────────────────────────────────────────────────────────────────────────
  {
    id: "portail", nom: "Portail fournisseur", route: "/portail", domaine: "externe", rbac: [],
    resume: "Le portail des laboratoires partenaires : authentification séparée, ils ne voient QUE leurs produits et leurs champs externes.",
    pourQui: "Comptes fournisseurs créés dans Administration.",
    gestes: [{ label: "Consulter ses dossiers", qui: "Fournisseur", effet: "Statut simplifié : en préparation, déposé, en examen, compléments, enregistré." }],
    regles: ["Isolation stricte : cookie séparé, aucune donnée interne."],
    liens: [{ vers: "regulatory", pourquoi: "Statut externe des dossiers" }],
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES CIRCUITS — un fait métier de bout en bout.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CIRCUITS: readonly Circuit[] = [
  {
    id: "ad-pro-kam", titre: "Demande Ad & Pro d'un KAM (sponsoring)", domaine: "marketing",
    resume: "Le circuit le plus long de la plateforme : de la demande du délégué jusqu'au paiement et à l'imputation budgétaire.",
    declencheur: "Un délégué médical (KAM) dépose une demande de sponsoring pour un médecin ou une association.",
    etapes: [
      { acteur: "KAM (Délégué médical)", type: "demandeur", module: "ad-pro", action: "Nouvelle demande › Sponsoring", effet: "Pièce scannée de la demande du médecin, médecins, produits, wilaya, montant demandé par le médecin + suggéré par le délégué, nature directe / indirecte. Le POSTE naît avec la demande." },
      { acteur: "National Sales", type: "decideur", module: "ad-pro", action: "Approuver / Refuser / Renvoyer", effet: "Le superviseur du KAM filtre en premier.", decision: true },
      { acteur: "Directeur Général (porte du DG)", type: "decideur", module: "centre-ad-pro", action: "Viser", effet: "Seulement au-dessus du seuil réglé ; en dessous, franchie automatiquement et tracée.", decision: true },
      { acteur: "Direction des opérations", type: "decideur", module: "ad-pro", action: "Accord", effet: "Pour un sponsoring de KAM uniquement ; elle ne chiffre pas.", decision: true },
      { acteur: "Direction Marketing", type: "decideur", module: "ad-pro", action: "Pré-valider la tenue", effet: "L'étape qui TRANCHE. Pour un sponsoring : la tenue est pré-validée, sans montant global.", decision: true },
      { acteur: "PRIM", type: "execution", module: "information-medicale", action: "Lecture « à déclarer ? »", effet: "Si un pharmacien responsable est configuré : déclaration au ministère, validée par le Directeur des Opérations." },
      { acteur: "Demandeur + Assistante", type: "execution", module: "ad-pro", action: "Postes : devis → décision → BC", effet: "Chaque poste se chiffre, se décide, puis génère son bon de commande." },
      { acteur: "Signataire BC", type: "decideur", module: "bons-de-commande", action: "Signer", effet: "Après le centre Ad & Pro si le BC dépasse le seuil des BC.", decision: true },
      { acteur: "Siège du centre de paiement", type: "argent", module: "centre-paiement", action: "Autoriser", effet: "Un ordre de dépense par poste.", decision: true },
      { acteur: "Comptable", type: "argent", module: "finances", action: "Régler", effet: "Facture obligatoire ; sortie de trésorerie." },
      { acteur: "Plateforme", type: "systeme", module: "budget-marketing", action: "Imputation automatique", effet: "La dépense tombe dans la catégorie budgétaire du module ; l'enveloppe se recalcule." },
      { acteur: "Direction Marketing", type: "decideur", module: "ad-pro", action: "Validation finale et clôture", effet: "Chaque poste accordé rangé dans un budget ; la somme devient le montant accordé." },
    ],
    aRetenir: [
      "Le parcours dépend de QUI demande : un KAM passe par le National Sales ; un « autre demandeur » va directement à la Direction Marketing ; la Direction Marketing elle-même est tranchée par la Direction des opérations ; Direction / DG / Directeur des Opérations / Super Admin vont directement à la Direction Marketing, sans porte du DG.",
      "À chaque étape : approuver, refuser, ou RENVOYER pour correction (motif exigé) ; resoumise, la demande revient à cette étape.",
      "Le sponsoring a un APPEL : après un refus, le demandeur fait appel, motif exigé.",
      "Clôturée, la demande est arrêtée, pas l'exécution : un BC accordé s'émet encore, une facture se paie encore.",
    ],
  },
  {
    id: "paiement", titre: "De l'ordre de dépense au budget", domaine: "argent",
    resume: "Comment l'argent sort, quel que soit le module qui l'a demandé.",
    declencheur: "Un module produit un ordre de dépense : poste Ad & Pro, BV Regulatory, demande de paiement, formation, paie, remise de caisse…",
    etapes: [
      { acteur: "Module d'origine", type: "systeme", module: "ad-pro", action: "Émettre l'ordre de dépense", effet: "L'ordre naît EN ATTENTE du centre de paiement, avec son entité et sa section (Regulatory · Sales & Marketing · Autres)." },
      { acteur: "Siège (PDG, Super Admin, sièges nommés)", type: "argent", module: "centre-paiement", action: "Autoriser / Refuser", effet: "Deux issues seulement ; pas de révision du montant ici.", decision: true },
      { acteur: "Comptable (Finances)", type: "argent", module: "finances", action: "Régler", effet: "Facture obligatoire ; FinanceTransaction de sortie ; solde de trésorerie mis à jour." },
      { acteur: "Plateforme", type: "systeme", module: "budgets", action: "Imputation automatique", effet: "Catégorie budgétaire du module d'origine ; barres de santé de l'enveloppe recalculées." },
    ],
    aRetenir: [
      "AUCUN paiement sans le centre, quel que soit le montant — le seul chemin hors centre est la rallonge de caisse d'avance.",
      "Un ordre non réglé dont la source est retirée, refusée ou annulée est annulé avec elle.",
      "Une demande de paiement entre au centre DÈS sa soumission, avant l'instruction des Finances.",
    ],
  },
  {
    id: "secretariat", titre: "Une demande au Bureau du secrétariat", domaine: "administration",
    resume: "La demande la plus simple : un employé demande, une assistante traite.",
    declencheur: "Un employé a besoin d'un billet, d'une signature, d'un courrier, d'un achat…",
    etapes: [
      { acteur: "Employé", type: "demandeur", module: "secretariat", action: "Nouvelle demande", effet: "Type, titre, pièces, participants ; les assistantes sont notifiées." },
      { acteur: "Employé", type: "demandeur", module: "secretariat", action: "Modifier / supprimer (30 min)", effet: "Fenêtre discrète : on corrige sans déranger personne." },
      { acteur: "Assistante de direction", type: "execution", module: "secretariat", action: "Commencer le traitement", effet: "Le demandeur lit « En cours — chez l'assistante de direction »." },
      { acteur: "Assistante de direction", type: "execution", module: "secretariat", action: "Fin du traitement", effet: "Achat : facture finale + imputation exigées ; la demande est archivée dans le Drive." },
      { acteur: "Plateforme", type: "systeme", module: "drive", action: "Archive « Dossier traité »", effet: "Récapitulatif et copie des pièces dans le Drive du traitant." },
    ],
    aRetenir: ["« Rouvrir… » et « Annuler la demande… » exigent un motif ; une annulée ne se rouvre pas.", "Le demandeur voit ses demandes et celles où il est participant ; DRH et Finances voient tout en lecture."],
  },
  {
    id: "achat-bc", titre: "Achat : devis → BC → facture → paiement", domaine: "argent",
    resume: "La chaîne d'achat telle qu'elle passe par le secrétariat (le même schéma vaut pour un poste Ad & Pro).",
    declencheur: "Une demande d'achat ou de devis au Bureau du secrétariat.",
    etapes: [
      { acteur: "N+1 du demandeur", type: "decideur", module: "validations", action: "Approuver l'achat", effet: "Approbation en amont (« Attente validation »), motif exigé pour refuser.", decision: true },
      { acteur: "Assistante de direction", type: "execution", module: "secretariat", action: "Déposer et retranscrire les devis", effet: "Chaque devis est saisi ligne à ligne (registre Legal)." },
      { acteur: "Demandeur", type: "demandeur", module: "secretariat", action: "Retenir des lignes → générer le BC", effet: "Un BC par fournisseur, au papier en-tête de l'entité." },
      { acteur: "DG / Super Admin", type: "decideur", module: "centre-validations", action: "Valider le BC", effet: "Seulement au-dessus du seuil des BC (0 par défaut = tous).", decision: true },
      { acteur: "Signataire (Direction, DG, Finances)", type: "decideur", module: "bons-de-commande", action: "Signer / Renvoyer à l'émetteur", effet: "« Signé et validé » ; l'assistante est prévenue.", decision: true },
      { acteur: "Assistante", type: "execution", module: "secretariat", action: "Déposer la facture", effet: "La facture suit le BC dans la liste des pièces." },
      { acteur: "Centre + Finances", type: "argent", module: "centre-paiement", action: "Autoriser puis régler", effet: "Voir le circuit « De l'ordre de dépense au budget ».", decision: true },
    ],
    aRetenir: ["Modifier le montant ou le fournisseur d'un BC signé RETIRE la signature.", "La signature est une attestation humaine : jamais par Adam."],
  },
  {
    id: "regulatory", titre: "Un dossier d'enregistrement (Regulatory)", domaine: "regulatory",
    resume: "Du CTD reçu du laboratoire à la décision d'enregistrement, et au produit dans le catalogue.",
    declencheur: "Un laboratoire partenaire envoie le CTD d'un produit à enregistrer en Algérie.",
    etapes: [
      { acteur: "Responsable / Assistante Réglementaire", type: "demandeur", module: "regulatory", action: "Nouveau dossier + CTD initial", effet: "DCI, dosage, forme, conditionnement, fournisseur ; le CTD (zip ou dossier) est déposé à l'étape 1 ; « Dossier reçu » passe à Oui." },
      { acteur: "Super Admin", type: "decideur", module: "pipeline", action: "Garder au pipeline ou ouvrir le cadenas", effet: "Verrouillé : invisible de l'équipe. Ouvert : passe dans « À traiter » et devient un produit de Produits 360.", decision: true },
      { acteur: "Responsable Réglementaire", type: "execution", module: "regulatory", action: "Chargé du dossier", effet: "Désigne la personne qui porte le dossier." },
      { acteur: "Chargé du dossier", type: "execution", module: "analyse-ctd", action: "Analyser le CTD (facultatif)", effet: "L'IA repère les manques avant le dépôt." },
      { acteur: "Chargé du dossier", type: "execution", module: "regulatory", action: "Demande de BV (25 %)", effet: "Ordre de dépense avec échéance → centre de paiement → Finances." },
      { acteur: "Chargé du dossier", type: "execution", module: "regulatory", action: "Pré-soumission puis dépôt (BV 75 %)", effet: "Les étapes cochées font avancer le niveau de process." },
      { acteur: "ANPP", type: "externe", module: "regulatory", action: "Réserves", effet: "Ajoutées à la frise (« Réserves ANPP »), suivies d'une « Réponse aux réserves » et d'une nouvelle version du CTD." },
      { acteur: "ANPP", type: "externe", module: "regulatory", action: "Décision d'enregistrement", effet: "Statut « Décision obtenue » : le dossier passe dans « Traitement terminé »." },
      { acteur: "Plateforme", type: "systeme", module: "produits", action: "Produit commercialisable", effet: "Le produit peut porter des stocks, des ventes PCH et du matériel promotionnel." },
    ],
    aRetenir: [
      "Workflow interne en 17 étapes : pré-soumission → préparation CTD → vérification → dépôt → BV 1/2/3 → réserves → compléments → commission → décision → AMM → clôture.",
      "Reverrouiller un dossier abouti ne le renvoie pas au pipeline.",
      "Les BV d'un dossier se lisent dans Budget Regulatory (25 % en préparation, 75 % avant le dépôt).",
    ],
  },
  {
    id: "info-med", titre: "Information médicale — circuit événement", domaine: "marketing",
    resume: "La déclaration au ministère d'un événement ou d'une prise en charge financée.",
    declencheur: "La décision de l'étape qui tranche une demande Ad & Pro (événement, congrès, sponsoring), si un PRIM est configuré.",
    etapes: [
      { acteur: "Plateforme", type: "systeme", module: "information-medicale", action: "Dossier DIM-AAAA-NNN", effet: "Notifié au pharmacien responsable." },
      { acteur: "PRIM", type: "execution", module: "information-medicale", action: "Soumettre sa lecture", effet: "« À déclarer au ministère » ou « sans déclaration », motif exigé." },
      { acteur: "Directeur des Opérations", type: "decideur", module: "validations", action: "Valider la lecture", effet: "Le premier qui tranche décide ; aucun actif → le Super Admin.", decision: true },
      { acteur: "PRIM", type: "execution", module: "information-medicale", action: "Réclamer les pièces, déposer au ministère", effet: "Enregistre la référence du dépôt." },
      { acteur: "Directeur des Opérations", type: "decideur", module: "information-medicale", action: "Validation finale", effet: "Validé : l'ordre de dépense naît (un seul) vers le centre de paiement. Refusé : retour au PRIM.", decision: true },
    ],
    aRetenir: ["Le circuit MATÉRIEL PROMOTIONNEL est différent : un bon de versement par matériel, une validation pour le lot, un paiement par quittance.", "On fait valider la LECTURE, pas la question : un refus ne veut jamais dire « ne déclarez pas »."],
  },
  {
    id: "promo-materiel", titre: "Matériel promotionnel (circuit 2)", domaine: "marketing",
    resume: "Un achat de matériel promotionnel : devis retranscrits, lignes retenues, BC générés par la plateforme.",
    declencheur: "Une demande de matériel promotionnel dans Ad & Pro.",
    etapes: [
      { acteur: "Demandeur", type: "demandeur", module: "ad-pro", action: "Nouvelle demande › Matériel promotionnel", effet: "Le matériel est choisi dans le catalogue." },
      { acteur: "Directrice Marketing ou N+1", type: "decideur", module: "ad-pro", action: "Valider la demande", effet: "N+1 plafonné au Directeur des Opérations ; personne pour la directrice ni le directeur des opérations.", decision: true },
      { acteur: "Assistante de direction", type: "execution", module: "secretariat", action: "Retranscrire les devis ligne à ligne", effet: "Plusieurs fournisseurs possibles." },
      { acteur: "Demandeur", type: "demandeur", module: "ad-pro", action: "Retenir des lignes", effet: "Peut panacher plusieurs devis." },
      { acteur: "Direction Marketing → DG", type: "decideur", module: "centre-ad-pro", action: "Décider", effet: "Le DG seulement au-dessus du seuil.", decision: true },
      { acteur: "Plateforme + signataire", type: "decideur", module: "bons-de-commande", action: "BC générés puis signés", effet: "Un BC par fournisseur ; facture obligatoire par BC.", decision: true },
      { acteur: "PRIM + centre de paiement", type: "argent", module: "information-medicale", action: "Visa / déclaration et paiement", effet: "Bons de versement, quittances payées une à une." },
      { acteur: "Magasin", type: "execution", module: "stock-promo", action: "Entrée par facture", effet: "Ce qui est reçu entre au stock, par lot." },
    ],
    aRetenir: ["Les dossiers d'avant gardent leur circuit court."],
  },
  {
    id: "conge", titre: "Congé et intérim", domaine: "administration",
    resume: "Un employé part en congé et désigne quelqu'un pour tenir sa place.",
    declencheur: "Un employé demande un congé depuis Mon dossier RH.",
    etapes: [
      { acteur: "Employé", type: "demandeur", module: "mon-dossier-rh", action: "Demande de congé", effet: "Annuel, sans solde, exceptionnel, maternité…" },
      { acteur: "N+1 (ou son intérimaire)", type: "decideur", module: "mon-equipe", action: "Signer", effet: "Voit les absences de l'équipe qui chevauchent.", decision: true },
      { acteur: "RH", type: "decideur", module: "conges-rh", action: "Signer", effet: "Dernière marche : le congé est accordé (l'étape DG est supprimée depuis le 06/10).", decision: true },
      { acteur: "Employé", type: "demandeur", module: "conges-rh", action: "Désigner un intérimaire + modules", effet: "Seuls les modules qu'il DÉTIENT réellement se prêtent." },
      { acteur: "RH", type: "decideur", module: "conges-rh", action: "Valider l'intérim", effet: "Refus motivé ; l'intérimaire est prévenu de la date d'ouverture.", decision: true },
      { acteur: "Plateforme", type: "systeme", module: "admin", action: "Ouverture automatique", effet: "Pendant les jours du congé : bandeau d'intérim, modules prêtés sans le droit de supprimer ; s'éteint seul." },
    ],
    aRetenir: ["La direction peut signer à n'importe quelle marche.", "Un refus arrête tout, à n'importe quelle marche."],
  },
  {
    id: "note-de-frais", titre: "Note de frais", domaine: "administration",
    resume: "Un remboursement : la pièce, les originaux au secrétariat, la décision RH.",
    declencheur: "Un employé a avancé une dépense professionnelle.",
    etapes: [
      { acteur: "Employé", type: "demandeur", module: "mon-espace", action: "Ajouter une note de frais", effet: "Mois, montant, justificatif (exigés côté serveur) ; 15 min pour corriger." },
      { acteur: "Employé", type: "demandeur", module: "secretariat", action: "Déposer les originaux", effet: "Physiquement au bureau du secrétariat." },
      { acteur: "Assistante de direction", type: "execution", module: "secretariat", action: "Accuser réception", effet: "Tracé ; débloque le traitement RH." },
      { acteur: "RH", type: "decideur", module: "rh", action: "Valider (mois demandé / suivant) / Refuser", effet: "Ou « Demander un justificatif », ou « Autoriser la modification ».", decision: true },
    ],
    aRetenir: ["Tant que les originaux ne sont pas reçus, les boutons RH sont désactivés et le serveur refuse."],
  },
  {
    id: "paie", titre: "Paie du mois", domaine: "administration",
    resume: "La paie part au centre de paiement, un virement par entité et par mois.",
    declencheur: "Fin de mois.",
    etapes: [
      { acteur: "RH", type: "execution", module: "rh", action: "Saisir chaque salaire", effet: "Coût employeur + net ; fiche de paie facultative → dossier RH du salarié. Cellule « Saisi »." },
      { acteur: "RH", type: "execution", module: "rh", action: "Envoyer au centre (par entité)", effet: "Somme à virer déclarée à la main ; ordre en attente du centre ; cellules « Envoyé »." },
      { acteur: "Siège du centre", type: "argent", module: "centre-paiement", action: "Autoriser", effet: "Un refus libère les salaires.", decision: true },
      { acteur: "Comptable", type: "argent", module: "finances", action: "Régler", effet: "UNE écriture SALAIRE de la somme déclarée ; cellules « Viré »." },
      { acteur: "Plateforme", type: "systeme", module: "mon-dossier-rh", action: "« Votre salaire a été versé »", effet: "Au plus tôt 24 h après la saisie et une fois le virement réglé." },
    ],
    aRetenir: ["Un seul envoi en cours par entité et par mois ; un salaire saisi après part en complément."],
  },
  {
    id: "recrutement", titre: "Recrutement", domaine: "administration",
    resume: "Du poste demandé à la recrue intégrée.",
    declencheur: "Un manager (ou n'importe qui) a besoin d'un poste.",
    etapes: [
      { acteur: "Demandeur", type: "demandeur", module: "recrutement", action: "Demander un poste", effet: "Missions, compétences, contrat, fourchette ; chaîne hiérarchique figée." },
      { acteur: "Hiérarchie, marche par marche", type: "decideur", module: "recrutement", action: "Valider / Renvoyer / Refuser", effet: "Jusqu'au DG ; la direction peut trancher à toute marche.", decision: true },
      { acteur: "Directeur Général", type: "decideur", module: "recrutement", action: "Conclure", effet: "Désigne le N+1 de la recrue et au moins une personne de suivi.", decision: true },
      { acteur: "RH", type: "execution", module: "site-web", action: "Diffuser", effet: "Site, LinkedIn, Emploitic ; les candidatures du site arrivent dans le recrutement." },
      { acteur: "RH → demandeur → direction", type: "execution", module: "recrutement", action: "CV → présélection → choix", effet: "Entretiens puis recrutement." },
      { acteur: "RH", type: "execution", module: "rh", action: "Intégrer", effet: "Fiche employé pré-remplie ; le N+1 devient son manager." },
    ],
    aRetenir: ["Pas d'intégration pour un consulting (hors effectif et hors paie)."],
  },
  {
    id: "terrain", titre: "La boucle terrain du KAM", domaine: "operations",
    resume: "Du plan de tournée au rapport de visite, et au pilotage du superviseur.",
    declencheur: "Avant le mois (échéance réglable dans Force de vente › Paramètres).",
    etapes: [
      { acteur: "KAM", type: "demandeur", module: "promotion-medicale", action: "Pré-sélectionner et soumettre le plan", effet: "Praticiens de son panel jour par jour, selon leur lettre de segmentation." },
      { acteur: "N+1 (superviseur)", type: "decideur", module: "promotion-medicale", action: "Valider / Escalader au N+2 / Rejeter", effet: "Rejet motivé : 48 h pour resoumettre.", decision: true },
      { acteur: "KAM", type: "execution", module: "promotion-medicale", action: "Visite + rapport (48 h)", effet: "Produits de sa BU, messages de la Direction Marketing, matériel remis ; vocal possible." },
      { acteur: "Plateforme", type: "systeme", module: "force-de-vente", action: "Calcul du réalisé et alertes", effet: "Réalisé plafonné au requis ; alertes silence / retard / couverture au superviseur." },
      { acteur: "Superviseur", type: "decideur", module: "promotion-medicale", action: "Fiche de coaching", effet: "Tournée en double, finalisée et partagée au KAM." },
    ],
    aRetenir: ["Le seul « requis » = lettre × In/Out × fréquence du secteur.", "Une visite imprévue ou commandée compte au nombre de visites, jamais au dénominateur des planifiées."],
  },
  {
    id: "validation-generique", titre: "Une validation configurable", domaine: "transverse",
    resume: "Le moteur commun de validation, utilisé par de nombreux modules.",
    declencheur: "Un module (ou une personne) demande une validation.",
    etapes: [
      { acteur: "Demandeur", type: "demandeur", module: "validations", action: "Demander une validation", effet: "Les règles du Super Admin choisissent 1 ou 2 validateurs, en séquentiel ou parallèle." },
      { acteur: "Validateur (ou intérimaire)", type: "decideur", module: "validations", action: "Valider / Renvoyer / Refuser", effet: "Motif exigé pour renvoyer ou refuser ; message et chaque pièce peuvent être jugés séparément.", decision: true },
      { acteur: "Demandeur", type: "demandeur", module: "validations", action: "Corriger et resoumettre", effet: "Reprend à l'étape qui a renvoyé ; si le montant monte, tout repart." },
      { acteur: "Plateforme", type: "systeme", module: "validations", action: "Clôture du circuit", effet: "Séquentiel : validateur suivant ; parallèle : validée quand toutes les étapes le sont." },
    ],
    aRetenir: ["Un double clic ne décide pas deux fois (verrou de la demande).", "Abandonner une demande renvoyée la clôt (« Annulée ») sans effacer l'historique."],
  },
  {
    id: "caisse", titre: "Caisse d'avance des moyens généraux", domaine: "administration",
    resume: "De l'argent EN MAIN pour les petits achats, distinct du budget.",
    declencheur: "Les RH dotent la caisse du service.",
    etapes: [
      { acteur: "RH", type: "execution", module: "moyens-generaux", action: "Remettre une somme", effet: "La remise naît en attente du centre de paiement." },
      { acteur: "Siège du centre", type: "argent", module: "centre-paiement", action: "Autoriser", effet: "Refusée : fermée avec son motif.", decision: true },
      { acteur: "Finances", type: "argent", module: "finances", action: "Verser", effet: "Sans catégorie budgétaire : c'est un changement de tiroir." },
      { acteur: "Détenteur (Assistante)", type: "execution", module: "moyens-generaux", action: "Confirmer la réception", effet: "Rien n'est disponible avant." },
      { acteur: "Détenteur", type: "execution", module: "moyens-generaux", action: "Dépenses avec facture scannée", effet: "Déduites de la caisse et imputées au budget ; alerte à 20 % restants." },
    ],
    aRetenir: ["La caisse est CONTINUE : chaque remise s'ajoute au fond.", "La rallonge est le seul argent qui ne passe pas par le centre."],
  },
  {
    id: "pch-marche", titre: "Un marché PCH (appel d'offres)", domaine: "operations",
    resume: "Market 360° : de l'appel d'offres de la PCH à la facture.",
    declencheur: "La PCH publie un appel d'offres.",
    etapes: [
      { acteur: "Opérations", type: "execution", module: "pch", action: "Créer le marché + lire l'AO", effet: "Les lignes produits sont extraites et enrichies (prix de référence, nomenclature, notre produit)." },
      { acteur: "Opérations", type: "execution", module: "pch", action: "Déposer la soumission", effet: "Version verrouillée et photographiée." },
      { acteur: "PCH", type: "externe", module: "pch", action: "Attribution par lot", effet: "Gagné / perdu / infructueux ; attribution partielle possible." },
      { acteur: "Opérations + Legal", type: "execution", module: "legal", action: "Contrat depuis l'attribution", effet: "Une pièce Legal + ses lignes contractuelles ; avenants en ±." },
      { acteur: "Opérations", type: "execution", module: "pch", action: "BC → livraisons → factures", effet: "Contrôle du restant contractuel ; lot et péremption à la livraison." },
    ],
    aRetenir: ["Le niveau du marché est calculé à partir des faits, jamais saisi."],
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// LES MÉCANISMES TRANSVERSES — ce qui vaut partout.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const MECANISMES: readonly Mecanisme[] = [
  {
    titre: "Les droits : rôle, console, accès implicites",
    resume: "Ce qu'une personne peut faire = les défauts de son rôle, corrigés par la console, plus quelques accès implicites.",
    details: [
      "Sept actions par module : Voir, Créer, Modifier, Supprimer, Valider, Exporter, Téléverser.",
      "Couche 1 : la matrice du rôle (PERMISSIONS dans lib/rbac.ts) — c'est elle que montre l'onglet « Rôles ».",
      "Couche 2 : la console (Administration › Accès) ouvre, restreint ou BLOQUE un module pour une personne ; le blocage prime toujours.",
      "Accès implicites : Mon équipe et Annuaires pour tous, Campagne budgétaire pour qui dirige un département, Recrutement pour tous, un dossier Regulatory porté, un siège au centre de paiement, un intérim en cours.",
      "Portée : TOUT (vue globale : Super Admin et Direction) ou « ses lignes » (ce qu'on a créé, porte ou suit).",
      "Un rôle secondaire ajoute ses droits au rôle principal ; il ne donne jamais Adam.",
    ],
  },
  {
    titre: "Les entités (sociétés du groupe)",
    resume: "Adventum Pharma, Pharmagène, et toute entité créée ensuite : presque chaque enregistrement porte son entité.",
    details: [
      "Le sélecteur de la barre du haut est une DEMANDE, jamais une autorisation : il est revalidé contre les droits réels.",
      "« Toutes les entités » = toutes celles auxquelles on a droit, jamais toutes celles qui existent.",
      "Les RH n'ont pas de colonne d'entité : congés et paie pendent de l'employé, qui porte la sienne.",
    ],
  },
  {
    titre: "Les trois centres et la séparation des rôles",
    resume: "Celui qui demande, celui qui autorise et celui qui paie ne sont jamais dans le même écran.",
    details: [
      "Centre de paiement : l'argent (PDG, Super Admin, sièges nommés).",
      "Centre de validations : les décisions du DG (DG, Super Admin).",
      "Centre Ad & Pro : les demandes de promotion au-dessus du seuil, et les seuils (DG, Super Admin).",
      "Cocher le module dans la console ne fait pas siéger : le siège vient du rôle ou d'une désignation nominative.",
    ],
  },
  {
    titre: "Renvoyer pour correction, motif exigé",
    resume: "Presque partout, une décision a trois issues : approuver, refuser, renvoyer.",
    details: [
      "Refuser ou renvoyer exige un motif.",
      "Une demande renvoyée apparaît dans « À corriger » chez le demandeur ; resoumise, elle revient à l'étape qui l'a renvoyée.",
      "On ne tranche jamais sa propre demande (sauf au sommet).",
    ],
  },
  {
    titre: "Corbeille, audit et rejeu",
    resume: "Rien ne se détruit sans trace.",
    details: [
      "Toute suppression définitive est un instantané restaurable dans Administration › Corbeille.",
      "Le journal d'audit trace les gestes ; le rejeu de session montre la suite des actions d'une personne, sans valeurs de champ.",
      "Les demandes d'achat sont copiées entièrement dans un journal à part (Administration › Journal des demandes d'achat).",
    ],
  },
  {
    titre: "Vue exacte",
    resume: "Le Super Admin voit l'ERP exactement comme une personne, pendant 4 heures.",
    details: [
      "Une vue, pas une usurpation : toute écriture part au nom du Super Admin réel.",
      "Exception voulue : créer une demande Ad & Pro se fait au nom de la personne visualisée.",
      "Adam est désactivé en Vue exacte ; cette carte aussi (elle est réservée au Super Admin).",
    ],
  },
  {
    titre: "Notifications et « À faire »",
    resume: "Le lien d'une notification mène à l'action exacte, et chaque file se lit avec la règle que son action applique.",
    details: [
      "Mon espace ne montre une validation qu'à SON tour.",
      "Chaque ligne dit depuis quand elle attend (jours civils d'Alger).",
      "Tâches planifiées (rappels, balayages) sans cron : lancées par l'application elle-même.",
    ],
  },
  {
    titre: "Modules retirés",
    resume: "Ventes (saisie manuelle), Commandes & logistique et Market Intelligence sont retirés pour TOUT LE MONDE, Super Admin compris.",
    details: [
      "Ni menu, ni adresse, ni action serveur, ni outil d'assistant ; les données restent en base.",
      "Retours & réclamations est également retiré (données gardées).",
    ],
  },
];

/** Les circuits qui passent par un module — calculés, jamais recopiés. */
export function circuitsDuModule(moduleId: string): Circuit[] {
  return CIRCUITS.filter((c) => c.etapes.some((e) => e.module === moduleId));
}

/** Les modules reliés dans les deux sens (un lien déclaré d'un côté suffit). */
export function voisinsDuModule(moduleId: string): string[] {
  const out = new Set<string>();
  for (const m of MODULES_PLATEFORME) {
    if (m.id === moduleId) m.liens.forEach((l) => out.add(l.vers));
    else if (m.liens.some((l) => l.vers === moduleId)) out.add(m.id);
  }
  out.delete(moduleId);
  return [...out];
}
