/**
 * LE CATALOGUE DES OUTILS DE LECTURE — leurs schémas tels que le modèle les voit, l'export Excel
 * et les lectures réservées au Super Admin, avec les libellés (modules, demandes RH) qu'ils citent.
 */

import type { Module } from "@/lib/assistant/coeur/erp";
import type { ClaudeToolDef } from "@/lib/models/compat";
import { DEF_LIST_MY_TASKS, DEF_READ_WORKFLOW, DEF_SEARCH_PRODUCTS } from "@/platform/ia/outils/partages";

// ───────────────────────────── Libellés modules ─────────────────────────────

export const MODULE_FR: Partial<Record<Module, string>> = {
  WORKSPACE: "Mon espace / tâches", MESSAGING: "Messagerie",
  REGULATORY: "Regulatory (AMM/ANPP)", SPONSORING: "Sponsoring", BUDGETS: "Budgets",
  FINANCES: "Finances", RH: "Ressources humaines", CONGRESS_INTERNATIONAL: "Prises en charge Internationales",
  CONGRESS_NATIONAL: "Prises en charge Nationales", EVENTS: "Events (billetterie)", SALES: "Ventes",
  LOGISTICS: "Logistique PCH", PCH: "Marchés PCH", STOCKS: "Stocks PCH",
  MEDICAL: "Annuaire", BUSINESS_DEVELOPMENT: "Business Development", PROMO_MATERIAL: "Matériel promotionnel",
  VALIDATIONS: "Demandes de validations", DRIVE: "Drive", ADMIN_REQUESTS: "Bureau du secrétariat",
  PROCESS_INTELLIGENCE: "Process Intelligence", ADMIN: "Administration", DIRECTORIES: "Annuaires",
};

// Libellés FR des types de demande RH (self-service) — pour l'outil + la carte de confirmation.
export const HR_REQUEST_FR: Record<string, string> = {
  WORK_CERTIFICATE: "Attestation de travail", CNAS_CERTIFICATE: "Attestation CNAS",
  SALARY_STATEMENT: "Relevé des émoluments", DOMICILIATION: "Domiciliation de salaire",
  LEAVE_CERTIFICATE: "Attestation de congé", LEAVE_TITLE: "Titre de congé",
  MISSION_ORDER: "Ordre de mission", EXPENSE_REPORT: "Note de frais",
  EXCEPTIONAL_EXIT: "Sortie exceptionnelle", SICK_LEAVE: "Arrêt maladie",
  ANNUAL_LEAVE: "Congé annuel", UNPAID_LEAVE: "Congé sans solde",
  SPECIAL_LEAVE: "Congé exceptionnel", MATERNITY_LEAVE: "Congé de maternité",
  HR_INTERVIEW: "Entrevue RH", OTHER: "Autre demande RH",
};
export const HR_REQUEST_TYPES = Object.keys(HR_REQUEST_FR);
// Types exigeant une PÉRIODE (début requis) et, pour les congés, une fin.
export const HR_LEAVE_TYPES = new Set(["ANNUAL_LEAVE", "UNPAID_LEAVE", "SPECIAL_LEAVE", "MATERNITY_LEAVE", "SICK_LEAVE"]);
export const HR_PERIOD_TYPES = new Set([...HR_LEAVE_TYPES, "EXCEPTIONAL_EXIT"]);
export const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// ───────────────────────────── Définition des outils ─────────────────────────────

export const READ_TOOLS: ClaudeToolDef[] = [
  {
    name: "search_people",
    description:
      "Recherche un collègue dans l'annuaire interne par son nom (ou prénom). À utiliser pour résoudre une personne avant de lui assigner une tâche ou une demande (ex. « Radia »). Renvoie id, nom, fonction, département.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Nom ou prénom recherché." } },
      required: ["query"],
    },
  },
  {
    name: "find_available_actions",
    description:
      "Liste les ACTIONS NATIVES de l'ERP que CETTE personne peut déclencher via l'assistant — le registre "
      + "réel filtré par ses droits, PAS une liste inventée. À utiliser pour « qu'est-ce que je peux faire "
      + "ici / sur ce module ? », ou AVANT de fabriquer une demande générique : si un bouton métier existe, "
      + "c'est LUI qu'on propose. Renvoie par action : libellé du bouton, module, outil à appeler, risque, "
      + "et sa sémantique (effet, réversibilité).",
    input_schema: {
      type: "object",
      properties: {
        module: { type: "string", description: "Filtre par module (ex. « Finances », « Regulatory », « Administration », « paiement »). Vide = toutes." },
      },
    },
  },
  DEF_READ_WORKFLOW,
  {
    name: "my_overview",
    description:
      "Aperçu de l'espace de travail de l'utilisateur courant : modules accessibles, nombre de tâches ouvertes, de demandes en cours, de notifications non lues. À utiliser pour répondre à « où en suis-je ? ».",
    input_schema: { type: "object", properties: {} },
  },
  DEF_LIST_MY_TASKS,
  {
    name: "list_my_requests",
    description: "Liste les demandes administratives visibles par l'utilisateur (les siennes, celles qui le concernent ou qu'il traite).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_doctors",
    description:
      "Recherche des médecins dans l'annuaire de la promotion médicale (uniquement ceux que l'utilisateur a le droit de voir). Ne jamais inventer un médecin : s'il est introuvable, le dire. Renvoie grade, spécialité, secteur, établissement, influence.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Nom du médecin, spécialité ou établissement." } },
    },
  },
  DEF_SEARCH_PRODUCTS,
  {
    name: "search_events",
    description: "Recherche des événements (congrès, séminaires, webinars) et leur statut / nombre d'inscrits.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Nom ou ville de l'événement." } },
    },
  },
  {
    name: "list_emails",
    description:
      "Liste les e-mails récents de la **boîte mail de l'utilisateur** (sa propre boîte connectée dans Courrier). À utiliser pour « résume mes mails », « ai-je reçu un mail de X ? ». Renvoie pour chaque message : uid, expéditeur, adresse, objet, date, lu/non lu. Si aucune boîte n'est connectée, le signaler.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Nombre de messages récents (défaut 15, max 30)." } },
    },
  },
  {
    name: "read_email",
    description:
      "Lit le contenu complet d'un e-mail de la boîte de l'utilisateur, identifié par son `uid` (obtenu via list_emails). Renvoie expéditeur, adresse, destinataires, objet, date, corps texte et noms des pièces jointes.",
    input_schema: {
      type: "object",
      properties: { uid: { type: "number", description: "Identifiant uid du message (depuis list_emails)." } },
      required: ["uid"],
    },
  },
];

/**
 * EXPORTER EN EXCEL — disponible à tout le monde, borné par les DROITS DE LECTURE.
 *
 * Ce n'est pas un outil de Super Admin : c'est une lecture de plus, et `canExport` refuse tout
 * jeu de données que la personne ne pourrait pas ouvrir à l'écran. Le classeur atterrit dans son
 * Drive personnel — un export contient souvent des coordonnées, il doit vivre là où les
 * autorisations existent déjà plutôt que dans un lien qui traîne.
 */
export const EXPORT_TOOL: ClaudeToolDef = {
  name: "export_excel",
  description:
    "Génère un vrai fichier EXCEL (.xlsx) et le dépose dans le Drive personnel de l'utilisateur, "
    + "dossier « Exports IA ». À utiliser dès qu'on demande « exporte », « sors-moi un Excel », "
    + "« mets ça dans un tableur ». Jeux de données : regulatory (dossiers réglementaires), "
    + "annuaire (médecins), courriers (registre), recrutement (demandes), employes (effectif, SANS "
    + "aucune rémunération), comptes (comptes de la plateforme — direction seulement). "
    + "Le contenu ne dépasse jamais ce que l'utilisateur a le droit de lire. Après l'appel, DONNER "
    + "le nom du fichier et le nombre de lignes, et dire qu'il est dans le Drive (dossier « Exports IA »).",
  input_schema: {
    type: "object",
    properties: {
      dataset: {
        type: "string",
        enum: ["regulatory", "annuaire", "courriers", "recrutement", "employes", "comptes"],
        description: "Le jeu de données à exporter.",
      },
      limit: { type: "number", description: "Nombre maximum de lignes (défaut 2000, maximum 5000)." },
    },
    required: ["dataset"],
  },
};

/** Outils EXCLUSIFS au Super Admin — vision globale, tous comptes confondus. */
export const SUPERADMIN_TOOLS: ClaudeToolDef[] = [
  {
    name: "list_accounts",
    description:
      "RÉSERVÉ AU SUPER ADMIN : liste TOUS les comptes de l'entreprise (nom, fonction, rôle, actif/inactif) avec leur charge réelle (tâches ouvertes, demandes administratives à traiter). À utiliser pour « montre-moi tous les comptes », « qui est surchargé ? », « qui pilote quoi ? ». Le Super Admin peut ensuite relancer n'importe qui (créer une tâche, envoyer un message).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Filtre optionnel par nom ou fonction." } },
    },
  },
  {
    name: "read_platform_settings",
    description:
      "RÉSERVÉ AU SUPER ADMIN : lit les RÉGLAGES ACTUELS de la plateforme (limites de téléversement, "
      + "capacité et quota du Drive, mode et total du budget, analyse CTD, rôles superviseurs Regulatory, "
      + "segments thérapeutiques, rôles d'accès divers, modules masqués). "
      + "À APPELER AVANT toute modification d'une LISTE (rôles, segments, modules) : update_platform_setting "
      + "REMPLACE la valeur, donc pour AJOUTER quelqu'un il faut d'abord connaître la liste existante.",
    input_schema: { type: "object", properties: {} },
  },
];
