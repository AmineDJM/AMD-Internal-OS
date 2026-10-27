import type { CurrentUser } from "@/lib/session";
import { buildIndex, resolve, type ResolverContext } from "./nl/resolver";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { canSetStructural } from "@/lib/regulatory/structural-fields";
import { OPS_CATALOG, catalogCoveredKeys } from "@/lib/assistant/ops/catalog";

/**
 * ERP ACTION REGISTRY — le Chief of Staff est le PLAN DE CONTRÔLE en langage naturel de l'ERP.
 *
 * Trois pièces, un principe (« pour chaque bouton métier auquel la personne a droit, le Chief
 * sait invoquer LA MÊME action serveur ») :
 *
 *   1. `ERP_ACTIONS` — les actions natives que le Chief sait déjà PROPOSER : id stable, libellé
 *      du bouton à l'écran, ALIAS en langage naturel, outil du Chief, risque, porte. C'est ce
 *      qui permet de résoudre « demande l'actualisation des soldes » vers le bouton Finances
 *      réel — au lieu de fabriquer une demande administrative générique plus faible.
 *   2. `matchNativeAction(question)` — la résolution intention → action native (repli des
 *      accents, singulier/pluriel, containment de TOUS les jetons d'un alias). Injectée dans le
 *      plan de la question : PRIORITÉ AU NATIF, les replis (tâche, demande générique, message)
 *      ne viennent qu'ensuite.
 *   3. `ACTION_CLASSIFICATION` — l'INVENTAIRE EXHAUSTIF : chaque `export async function` de
 *      `src/lib/actions/` est classée NATIVE (le Chief exécute cette action même), COVERED (le
 *      Chief obtient le même résultat métier par un outil équivalent), GAP (trou de capacité
 *      RECONNU, à combler), ou EXCLUDED (hors sujet pour un assistant, raison donnée).
 *      Le test `action-parity.test.ts` échoue dès qu'une action serveur existe sans
 *      classification — un bouton ajouté à l'ERP ne peut plus devenir un trou silencieux.
 *
 * Module PUR (pas de Prisma) : importable par le planner, testable sans base. Les portes ici
 * sont un PRÉ-FILTRE de découverte — chaque action canonique revérifie les droits à l'exécution.
 */

export type ActionRisk = "NORMAL" | "SENSITIVE" | "CRITICAL";

export interface NativeAction {
  /** Id stable de l'action ERP (indépendant du nom d'outil). */
  id: string;
  /** Module d'écran, en français (« Finances », « Regulatory »…). */
  module: string;
  /** Le libellé du bouton / geste tel qu'il s'affiche à l'écran. */
  uiLabel: string;
  /** L'outil du Chief qui PROPOSE cette action (confirmation obligatoire ensuite). */
  toolName: string;
  /** Outil de DOMAINE : la valeur du champ `op` à passer (ex. `drive_operation` op `move`). */
  toolOp?: string;
  /** Formulations naturelles (français) qui désignent cette action. */
  aliases: string[];
  risk: ActionRisk;
  /** Ce que l'action fait, qui est touché, réversibilité — la sémantique, pas le mécanisme. */
  summary: string;
  /** LA MÊME PORTE QUE L'ÉCRAN (pré-filtre synchrone ; l'exécution revérifie toujours). */
  gate: (user: CurrentUser) => boolean;
  /** Ouverture supplémentaire que le pré-filtre synchrone ne sait pas vérifier (réglages DB). */
  gateNote?: string;
}

const isSA = (u: CurrentUser) => u.role === "SUPER_ADMIN";

const CORE_ERP_ACTIONS: NativeAction[] = [
  {
    id: "FINANCE_REQUEST_BALANCE_REFRESH",
    module: "Finances",
    uiLabel: "Demander l'actualisation des soldes",
    toolName: "request_treasury_update",
    aliases: [
      "actualisation des soldes", "actualisation du solde", "actualiser les soldes",
      "rafraîchir les soldes", "soldes bancaires à jour", "solde du compte bancaire",
      "mise à jour du solde de trésorerie", "mise à jour des soldes", "demander les soldes",
      "actualise la trésorerie",
    ],
    risk: "NORMAL",
    summary: "Notifie les responsables Finances (et le Super Admin) qu'une mise à jour des soldes de trésorerie est attendue — relance traçable, les montants ne sont PAS modifiés.",
    gate: (u) => isSA(u) || hasGlobalView(u),
  },
  {
    id: "REGULATORY_UPDATE_FIELD",
    module: "Regulatory",
    uiLabel: "Modifier un champ du dossier (statut, priorité, dates, partenaire…)",
    toolName: "update_regulatory_product",
    aliases: [
      "modifier le dossier reglementaire", "changer le statut du dossier", "niveau de process",
      "changer la priorité du dossier", "date cible de soumission", "verrouiller le dossier",
    ],
    risk: "NORMAL",
    summary: "Change UN champ d'un dossier Regulatory (statut/niveau de process, priorité, dates cibles, partenaire, verrou…). Réversible en remodifiant le champ ; audité champ par champ.",
    gate: (u) => userCan(u, "REGULATORY", "UPDATE"),
  },
  {
    id: "REGULATORY_ASSIGN_RESPONSIBLE",
    module: "Regulatory",
    uiLabel: "Chargé du dossier (menu déroulant)",
    toolName: "assign_regulatory_responsible",
    aliases: ["confier le dossier", "chargé du dossier", "assigner le dossier à", "réassigner le dossier", "retirer le chargé du dossier"],
    risk: "NORMAL",
    summary: "Désigne (ou retire) la personne CHARGÉE d'un dossier — la personne est notifiée, c'est un engagement pris en son nom. Réversible en réassignant.",
    gate: (u) => canSetStructural(u),
  },
  {
    id: "REGULATORY_SET_STEP",
    module: "Regulatory",
    uiLabel: "Étapes ANPP (statut d'étape / avis de présoumission)",
    toolName: "set_regulatory_step",
    aliases: ["étape anpp", "avis de présoumission", "marquer l'étape", "présoumission favorable", "statut de l'étape"],
    risk: "NORMAL",
    summary: "Met à jour UNE étape du circuit ANPP (ou l'avis de présoumission, qui dérive le statut du dossier). Réversible étape par étape ; audité.",
    gate: (u) => userCan(u, "REGULATORY", "UPDATE"),
  },
  {
    id: "REGULATORY_REQUEST_STATUS_UPDATE",
    module: "Regulatory",
    uiLabel: "Demander une mise à jour de statut",
    toolName: "request_regulatory_status_update",
    aliases: ["mise à jour de statut", "relance le dossier", "demande une mise à jour du dossier", "relance de mise à jour"],
    risk: "NORMAL",
    summary: "Relance traçable : le responsable, l'assistant et les participants du dossier sont notifiés avec un lien vers la fiche — le statut n'est pas modifié.",
    gate: isSA,
    gateNote: "aussi ouvert aux rôles superviseurs Regulatory configurés en Administration",
  },
  {
    id: "RECORD_DELETE",
    module: "Administration (toutes fiches)",
    uiLabel: "Supprimer définitivement (bouton rouge des fiches)",
    toolName: "delete_record",
    aliases: ["supprimer définitivement", "supprime le dossier", "supprimer l'enregistrement", "supprime cet employé", "supprime ce courrier", "supprime l'événement"],
    risk: "CRITICAL",
    summary: "Retire l'élément (25 types), ses pièces jointes et ses commentaires de tous les écrans ; instantané déposé en corbeille, RESTAURABLE par le Super Admin. Cascade non restaurable.",
    gate: isSA,
  },
  {
    id: "RECORD_RESTORE",
    module: "Administration → Corbeille",
    uiLabel: "Restaurer",
    toolName: "restore_record",
    aliases: ["restaurer depuis la corbeille", "restaure le dossier supprimé", "récupérer l'élément supprimé", "annule la suppression"],
    risk: "NORMAL",
    summary: "Recrée l'élément supprimé à l'identique (mêmes id/référence) avec pièces et commentaires. Les enfants perdus en cascade ne reviennent pas.",
    gate: isSA,
  },
  {
    id: "RECORD_PURGE",
    module: "Administration → Corbeille",
    uiLabel: "Détruire",
    toolName: "purge_record",
    aliases: ["détruire définitivement", "vider de la corbeille", "destruction réelle", "purger la corbeille"],
    risk: "CRITICAL",
    summary: "Destruction RÉELLE d'une entrée de corbeille : les fichiers stockés sont effacés, AUCUN retour possible.",
    gate: isSA,
  },
  {
    id: "ACCOUNT_SET_ACTIVE",
    module: "Administration",
    uiLabel: "Activer / Désactiver le compte",
    toolName: "set_account_active",
    aliases: ["désactiver le compte", "réactiver le compte", "bloquer le compte de", "coupe l'accès de", "réactive l'accès de"],
    risk: "SENSITIVE",
    summary: "Un compte désactivé ne peut plus se connecter (réversible à tout moment). Jamais sur son propre compte.",
    gate: isSA,
  },
  {
    id: "ACCOUNT_SET_ROLE",
    module: "Administration",
    uiLabel: "Rôle du compte / Autre rôle",
    toolName: "set_account_role",
    aliases: ["changer le rôle de", "donne le rôle", "rôle secondaire", "autre rôle de", "promouvoir le compte"],
    risk: "SENSITIVE",
    summary: "Change le rôle principal (et/ou l'« autre rôle » cumulé) d'un compte — les droits changent immédiatement. Le secondaire ne peut jamais être Super Admin.",
    gate: isSA,
  },
  {
    id: "PLATFORM_SETTING_UPDATE",
    module: "Administration → Réglages",
    uiLabel: "Réglages de la plateforme",
    toolName: "update_platform_setting",
    aliases: ["réglage de la plateforme", "masquer le module", "modules masqués", "quota du drive", "arrêt d'urgence de l'ia", "rôles superviseurs"],
    risk: "SENSITIVE",
    summary: "Modifie un réglage global (limites d'upload, quotas Drive, budget, rôles d'accès, modules masqués, arrêt d'urgence IA…). Les listes REMPLACENT la valeur existante.",
    gate: isSA,
  },
  {
    id: "NOTIFICATION_BROADCAST",
    module: "Administration",
    uiLabel: "Diffuser une notification / annonce pop-up",
    toolName: "create_notification",
    aliases: ["diffuser une notification", "annonce à tous", "envoie une notification à tout le monde", "annonce pop-up", "préviens tout le monde"],
    risk: "NORMAL",
    summary: "Notification (cloche + push) à tous, à un rôle, ou à des personnes précises — ou annonce pop-up plein écran avec accusé « J'ai compris ».",
    gate: isSA,
  },
  {
    id: "PRODUCTS_SET_COMPANY",
    module: "Regulatory / Administration",
    uiLabel: "Rattacher les produits à une entité",
    toolName: "set_products_company",
    aliases: ["rattacher les produits à", "entité des produits", "rattache les dossiers à la société"],
    risk: "NORMAL",
    summary: "Rattache un LOT de produits Regulatory (décrit par un filtre relu à l'exécution) à une entité du groupe.",
    gate: (u) => userCan(u, "REGULATORY", "UPDATE"),
  },
  {
    id: "TASK_CREATE_OR_REQUEST",
    module: "Espace de travail",
    uiLabel: "Créer une tâche / Demander une tâche",
    toolName: "create_task",
    aliases: ["crée une tâche", "demande une tâche", "planifie une tâche", "tâche pour"],
    risk: "NORMAL",
    summary: "Pour soi : to-do. Pour un collègue : DEMANDE DE TÂCHE (pop-up, accepter/refuser, fil d'échange) — le même circuit que l'écran. Se planifie (échéance, priorité).",
    gate: (u) => userCan(u, "WORKSPACE", "CREATE"),
  },
  {
    id: "TASK_UPDATE",
    module: "Espace de travail",
    uiLabel: "Modifier une tâche (statut, échéance, réassignation)",
    toolName: "update_task",
    aliases: ["termine la tâche", "clôture la tâche", "repousse l'échéance de la tâche", "réassigne la tâche"],
    risk: "NORMAL",
    summary: "Change le statut, l'échéance, la priorité ou l'assignation d'une tâche existante.",
    gate: (u) => userCan(u, "WORKSPACE", "UPDATE"),
  },
  {
    id: "ADMIN_REQUEST_CREATE",
    module: "Demandes",
    uiLabel: "Nouvelle demande administrative",
    toolName: "create_admin_request",
    aliases: ["demande administrative", "demande de billet", "demande de signature", "demande d'achat"],
    risk: "NORMAL",
    summary: "Ouvre une demande administrative typée (déplacement, courrier, signature, achat, devis, paiement, visa…), adressée à l'assistante de direction — DERNIER RECOURS quand aucune action de module plus précise n'existe.",
    gate: (u) => userCan(u, "ADMIN_REQUESTS", "CREATE"),
  },
  {
    id: "ADMIN_REQUEST_UPDATE",
    module: "Demandes",
    uiLabel: "Statut / assignation / commentaire d'une demande",
    toolName: "update_request",
    aliases: ["assigne la demande", "statut de la demande", "commente la demande", "clôture la demande"],
    risk: "NORMAL",
    summary: "Fait avancer une demande administrative existante : statut, personne chargée, commentaire — par les actions canoniques de l'écran.",
    gate: (u) => userCan(u, "ADMIN_REQUESTS", "UPDATE"),
  },
  {
    id: "MESSAGE_SEND",
    module: "Messagerie",
    uiLabel: "Envoyer un message",
    toolName: "send_message",
    aliases: ["envoie un message à", "écris un message à", "préviens par message"],
    risk: "NORMAL",
    summary: "Message direct interne (la conversation est créée au besoin). Pour DEMANDER un travail, préférer la demande de tâche.",
    gate: () => true,
  },
  {
    id: "EMAIL_SEND",
    module: "Courrier (e-mail)",
    uiLabel: "Envoyer un e-mail",
    toolName: "send_email",
    aliases: ["envoie un e-mail", "envoie un mail à", "réponds au mail"],
    risk: "NORMAL",
    summary: "E-mail depuis la boîte connectée de l'utilisateur (jamais celle d'un autre).",
    gate: () => true,
  },
  {
    id: "CALENDAR_EVENT_CREATE",
    module: "Agenda",
    uiLabel: "Planifier un rendez-vous",
    toolName: "create_calendar_event",
    aliases: ["planifie un rendez-vous", "ajoute à l'agenda", "cale une réunion", "programme un rendez-vous"],
    risk: "NORMAL",
    summary: "Crée un événement d'agenda pour l'utilisateur (heure d'Alger), avec invités éventuels.",
    gate: () => true,
  },
  {
    id: "CALENDAR_EVENT_UPDATE",
    module: "Agenda",
    uiLabel: "Déplacer / annuler un rendez-vous",
    toolName: "update_calendar_event",
    aliases: ["déplace le rendez-vous", "annule le rendez-vous", "décale la réunion"],
    risk: "NORMAL",
    summary: "Déplace ou annule un événement d'agenda existant — par les actions canoniques (invités prévenus).",
    gate: () => true,
  },
  {
    id: "DOSSIER_CREATE",
    module: "Sujets",
    uiLabel: "Ouvrir un sujet",
    toolName: "create_dossier",
    aliases: ["ouvre un sujet", "nouveau sujet", "ouvre un projet", "crée un dossier projet", "nouveau projet"],
    risk: "NORMAL",
    summary: "Ouvre un sujet de Pilotage (référence, responsable, échéance) par le même cœur que l'écran.",
    gate: (u) => userCan(u, "DOSSIERS", "CREATE"),
  },
  {
    id: "HR_REQUEST_CREATE",
    module: "RH",
    uiLabel: "Demande RH (attestation, congé, note de frais…)",
    toolName: "create_hr_request",
    aliases: ["demande d'attestation", "demande de congé", "note de frais", "demande rh"],
    risk: "NORMAL",
    summary: "Ouvre une demande RH pour l'utilisateur — elle suit ensuite le circuit RH normal.",
    gate: () => true,
  },
  {
    id: "SPONSORING_CREATE",
    module: "Sponsoring",
    uiLabel: "Nouvelle demande de sponsoring / congrès",
    toolName: "create_sponsoring_request",
    aliases: ["demande de sponsoring", "sponsoriser", "prise en charge congrès"],
    risk: "NORMAL",
    summary: "Ouvre une demande de sponsoring par l'action canonique — le circuit de validation habituel s'applique.",
    gate: () => true,
  },
  {
    id: "EVENT_CREATE",
    module: "Événements",
    uiLabel: "Créer un événement",
    toolName: "create_event_request",
    aliases: ["crée un événement", "organise un événement", "nouvel événement"],
    risk: "NORMAL",
    summary: "Crée un événement par l'action canonique (circuit de validation selon l'origine).",
    gate: () => true,
  },
  {
    id: "PROMO_MATERIAL_CREATE",
    module: "Matériel promotionnel",
    uiLabel: "Nouveau dossier de matériel promotionnel",
    toolName: "create_promo_material_request",
    aliases: ["matériel promotionnel", "dossier promo", "brochure à produire"],
    risk: "NORMAL",
    summary: "N'ouvre plus de dossier : une demande de matériel promotionnel se compose de lignes du catalogue (article, quantité, actions attendues du fournisseur) et se saisit à l'écran, Ad & Pro › Nouvelle demande › Matériel promotionnel — l'outil le dit (§118.171).",
    gate: () => true,
  },
  {
    id: "CONGRESS_REQUEST_CREATE",
    module: "Prises en charge",
    uiLabel: "Nouvelle demande de congrès (national / international)",
    toolName: "create_congress_request",
    aliases: ["congrès international", "congrès national", "prise en charge de congrès"],
    risk: "NORMAL",
    summary: "Ouvre une demande de prise en charge de congrès — le circuit de décision habituel s'applique.",
    gate: () => true,
  },
  {
    id: "PAYMENT_DECIDE",
    module: "Centre de paiement",
    uiLabel: "Autoriser / refuser un paiement",
    toolName: "decide_payment",
    aliases: ["autorise le paiement", "refuse le paiement", "valide le règlement", "décide le paiement"],
    risk: "SENSITIVE",
    summary: "Décision du Centre de paiement sur un règlement en attente — par l'action canonique (audit, notifications).",
    gate: (u) => isSA(u) || hasGlobalView(u),
    gateNote: "selon le circuit d'autorisation du Centre de paiement",
  },
  {
    id: "LEGAL_CREATE",
    module: "Legal",
    uiLabel: "Nouveau document légal",
    toolName: "create_legal_document",
    aliases: ["document légal", "enregistre le contrat", "nouveau contrat légal"],
    risk: "NORMAL",
    summary: "Enregistre un document légal (échéances, renouvellement, lecteurs) par l'action canonique.",
    gate: (u) => userCan(u, "LEGAL", "CREATE"),
  },
  {
    id: "LEGAL_UPDATE",
    module: "Legal",
    uiLabel: "Modifier un document légal",
    toolName: "update_legal_document",
    aliases: ["modifie le document légal", "renouvelle le contrat", "annule le document légal"],
    risk: "NORMAL",
    summary: "Met à jour un document légal existant par l'action canonique.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
  },
  {
    id: "HOSPITAL_CREATE",
    module: "Médical",
    uiLabel: "Ajouter un établissement",
    toolName: "create_hospital",
    aliases: ["ajoute un hôpital", "nouvel établissement", "crée l'établissement"],
    risk: "NORMAL",
    summary: "Ajoute un établissement de santé à l'annuaire (action canonique).",
    gate: (u) => userCan(u, "MEDICAL", "CREATE"),
  },
  {
    id: "HOSPITAL_UPDATE",
    module: "Médical",
    uiLabel: "Modifier un établissement",
    toolName: "update_hospital",
    aliases: ["modifie l'hôpital", "corrige l'établissement", "désactive l'établissement"],
    risk: "NORMAL",
    summary: "Met à jour un établissement de santé (action canonique).",
    gate: (u) => userCan(u, "MEDICAL", "UPDATE"),
  },
  {
    id: "WORKFLOW_CONFIGURE",
    module: "Administration → Circuits",
    uiLabel: "Builder des circuits de validation Ad&Pro",
    toolName: "configure_workflow",
    aliases: [
      "circuit de validation", "modifie le circuit", "ajoute une étape au circuit",
      "retire une étape du circuit", "réordonne le circuit", "réinitialise le circuit",
      "change les validateurs du circuit",
    ],
    risk: "SENSITIVE",
    summary: "Reconfigure un circuit de validation Ad&Pro (Sponsoring, Prises en charge, Événements) : étapes, qui agit, pouvoirs, automatismes — remplacement intégral validé par l'action ; les demandes en cours gardent leur étape par slug. Les autres circuits de l'ERP sont codés en dur.",
    gate: isSA,
  },
  {
    id: "WORKFLOW_ADVANCE",
    module: "Circuits Ad&Pro",
    uiLabel: "Approuver / Refuser / Sauter l'étape courante",
    toolName: "advance_workflow",
    aliases: [
      "approuve la demande de sponsoring", "refuse la demande de sponsoring", "saute l'étape",
      "sauter l'étape de validation", "valide l'étape du circuit", "fais avancer le circuit",
    ],
    risk: "SENSITIVE",
    summary: "Décision sur l'étape courante d'une demande engagée dans un circuit : approuver (l'étape suivante s'ouvre), refuser (circuit clos, demandeur notifié) ou SAUTER une étape intermédiaire (raison obligatoire, tracée, notifiée). Le moteur revérifie l'autorité de l'acteur.",
    gate: () => true,
    gateNote: "l'autorité réelle est décidée par le moteur selon l'étape courante",
  },
  {
    id: "CUSTOM_FIELD_MANAGE",
    module: "Administration → Champs personnalisés",
    uiLabel: "Champs personnalisés des modules (+ « obligatoire »)",
    toolName: "manage_custom_field",
    aliases: [
      "champ personnalisé", "ajoute un champ", "rends le champ obligatoire", "champ obligatoire",
      "rends le champ optionnel", "supprime le champ personnalisé", "ajoute une colonne au module",
    ],
    risk: "SENSITIVE",
    summary: "Crée, modifie ou retire un champ personnalisé d'un module (texte, nombre, date, oui/non, liste) — y compris le rendre OBLIGATOIRE : la fiche ne s'enregistre plus sans lui (appliqué par le serveur). Retirer un champ n'efface pas les valeurs déjà saisies.",
    gate: isSA,
  },
  {
    id: "SALARY_UPDATE",
    module: "RH",
    uiLabel: "Modifier la rémunération (fiche employé)",
    toolName: "update_salary",
    aliases: ["modifie le salaire de", "augmente le salaire", "change la rémunération"],
    risk: "CRITICAL",
    summary: "Change la rémunération sur la fiche RH (base, net, brut, coût employeur) — confirmation FORTE : le montant est à ressaisir. La paie du mois se saisit dans RH → Paie.",
    gate: (u) => userCan(u, "RH", "UPDATE"),
  },
];

/**
 * Les OPS DE DOMAINE (`ops/catalog.ts`) entrent dans le MÊME registre : mêmes alias, même
 * matching, même découverte (`find_available_actions`) — une op ajoutée au catalogue devient
 * découvrable ici sans rien recopier. `toolOp` porte la valeur du champ `op` à passer.
 */
const CATALOG_ERP_ACTIONS: NativeAction[] = OPS_CATALOG.map((m) => ({
  id: `OP_${m.tool.toUpperCase()}_${m.op.toUpperCase()}`,
  module: m.module,
  uiLabel: m.uiLabel,
  toolName: m.tool,
  toolOp: m.op,
  aliases: m.aliases,
  risk: m.risk,
  summary: m.summary,
  gate: m.gate,
  ...(m.gateNote ? { gateNote: m.gateNote } : {}),
}));

export const ERP_ACTIONS: NativeAction[] = [...CORE_ERP_ACTIONS, ...CATALOG_ERP_ACTIONS];

// ───────────────────────── Résolution intention → action native ─────────────────────────

/** Mots-outils français écartés du matching (sinon « demande rh » se réduirait à « demande »). */
const STOP = new Set([
  "de", "du", "des", "le", "la", "les", "un", "une", "en", "et", "ou", "au", "aux",
  "ce", "ces", "cette", "se", "sa", "son", "ses", "ne", "pas", "par", "sur", "pour",
  "dans", "que", "qui", "est", "il", "elle", "je", "tu", "on", "nous", "vous", "ils",
  "me", "te", "mon", "ton", "ma", "ta", "mes", "tes", "avec", "plus", "faut",
  // Démonstratifs et pronoms manquants — mesuré : leur absence rapprochait « supprime CET
  // employé » de « modifie le département de CET employé ». Deux phrases n'ont rien en commun
  // parce qu'elles partagent un démonstratif ; proposer une suppression définitive à qui
  // demande une modification est le pire faux positif possible.
  "cet", "celui", "celle", "ceux", "celles", "leur", "leurs", "lui", "eux", "y",
  "ete", "etre", "soit", "tout", "tous", "toute", "toutes", "meme", "memes",
  "comme", "quand", "dont", "donc", "alors", "aussi", "tres", "bien",
  "vers", "chez", "sans", "sous", "entre", "apres", "avant", "depuis", "encore", "deja",
  "ont", "ai", "as", "ont", "oui", "non", "merci", "stp", "svp",
]);

/**
 * RACINISATION LÉGÈRE DU FRANÇAIS — parce que le PDG ne parle pas à l'infinitif.
 *
 * L'alias du registre dit « assigner le dossier », le PDG dit « assigne le dossier ». Sans cette
 * étape, ces deux mots sont étrangers l'un à l'autre et l'action native n'est jamais reconnue :
 * mesuré sur 110 formulations réelles, c'était la première cause de silence du résolveur.
 *
 * On coupe les terminaisons verbales et le pluriel, en gardant un radical d'au moins 4 lettres —
 * en dessous on rabote des mots courts et on fabrique des collisions. La même fonction s'applique
 * AUX DEUX CÔTÉS : ce qui compte n'est pas la justesse linguistique du radical, c'est que
 * « assigner » et « assigne » tombent sur le MÊME.
 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  // Du plus long au plus court : « ations » avant « ons », sinon on coupe trop court.
  const cut = word.replace(/(ations|ation|ements|ement|erait|eront|ions|iez|ons|ent|ez|er|es|ee|e|s|x)$/, "");
  return cut.length >= 4 ? cut : word.replace(/[sx]$/, "");
}

/** Repli : accents, apostrophes, ponctuation — jetons ≥ 2 lettres hors mots-outils, racinisés. */
function foldTokens(text: string): Set<string> {
  const folded = text
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[''`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ");
  const out = new Set<string>();
  for (const raw of folded.split(" ")) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * L'INDEX DE RÉSOLUTION — construit une fois, à partir du registre lui-même.
 *
 * La logique vit dans `nl/resolver.ts` : le registre déclare des actions, il ne sait pas
 * comprendre le français. Séparer les deux permet de mesurer le résolveur sur un corpus fixe
 * sans rien savoir de l'ERP, et d'améliorer la compréhension sans toucher aux 529 actions.
 */
const NL_INDEX = buildIndex(ERP_ACTIONS, (a) => ({
  id: a.id,
  module: a.module,
  aliases: a.aliases,
  risk: a.risk,
  uiLabel: a.uiLabel,
}));

/**
 * « Y a-t-il DÉJÀ une action native de l'ERP qui correspond à cette intention ? »
 *
 * Un alias correspond quand TOUS ses jetons (dé-accentués, dé-pluralisés) sont présents dans la
 * question — l'alias le plus SPÉCIFIQUE (le plus de jetons) l'emporte. On rend au plus deux
 * candidats distincts : c'est un INDICE injecté dans le plan, le modèle garde le jugement
 * (et la confirmation humaine garde le dernier mot).
 */
export function matchNativeAction(question: string, ctx: ResolverContext = {}): NativeAction[] {
  return resolve(NL_INDEX, question, ctx).candidates.map((c) => c.action);
}

/**
 * La résolution COMPLÈTE — score, confiance, ambiguïté, motif de refus.
 *
 * `matchNativeAction` n'en garde que la liste, pour les appelants qui n'ont besoin que d'un
 * indice. Ici on rend de quoi DÉCIDER : proposer, demander de préciser, ou se taire.
 */
export function resolveNativeAction(question: string, ctx: ResolverContext = {}) {
  return resolve(NL_INDEX, question, ctx);
}

/** Le bloc de plan injecté quand une action native correspond — PRIORITÉ AU NATIF. */
export function nativeActionHint(question: string): string | null {
  const matches = matchNativeAction(question);
  if (matches.length === 0) return null;
  const lines = matches.map((a) =>
    `• « ${a.uiLabel} » (${a.module}) → outil ${a.toolName}${a.toolOp ? ` (op « ${a.toolOp} »)` : ""}${a.risk !== "NORMAL" ? ` [${a.risk}]` : ""}`,
  );
  return `ACTION NATIVE DE L'ERP DÉTECTÉE pour cette demande :\n${lines.join("\n")}\n`
    + "RÈGLE : utiliser CET outil natif — jamais une demande administrative générique, une tâche ou un "
    + "message à la place d'un bouton métier qui existe. (Si l'intention réelle est différente, ignorer l'indice.)";
}

/**
 * LES ACTIONS DISPONIBLES SUR L'ÉCRAN d'où la conversation démarre (« Appeler » depuis une
 * fiche, entrée contextuelle) : le contexte d'écran (route + référence) se plie en tokens et
 * matche les modules du registre — l'assistant sait D'EMBLÉE quels boutons natifs existent LÀ,
 * au lieu de le découvrir (ou pas) par find_available_actions. Null sans correspondance :
 * jamais de bruit. Borné (12) : le budget d'instructions vocales se paie en latence.
 */
export function screenActionsContext(user: CurrentUser, screen: string): string | null {
  const matched = actionsForUser(user, screen);
  if (matched.length === 0) return null;
  const lines = matched.slice(0, 12).map((a) =>
    `• ${a.uiLabel} → ${a.toolName}${a.toolOp ? ` (op « ${a.toolOp} »)` : ""}${a.risk !== "NORMAL" ? ` [${a.risk}]` : ""}`,
  );
  const more = matched.length > 12 ? `\n(+${matched.length - 12} autres — find_available_actions pour la liste complète)` : "";
  return `ACTIONS NATIVES DISPONIBLES SUR CET ÉCRAN (priorité au natif — jamais une demande générique à la place d'un bouton qui existe ici) :\n${lines.join("\n")}${more}`;
}

/** Les actions natives OUVERTES à cette personne (pré-filtre écran ; l'exécution revérifie). */
export function actionsForUser(user: CurrentUser, moduleQuery?: string): NativeAction[] {
  const all = ERP_ACTIONS.filter((a) => {
    try { return a.gate(user) || Boolean(a.gateNote); } catch { return false; }
  });
  if (!moduleQuery?.trim()) return all;
  const q = foldTokens(moduleQuery);
  return all.filter((a) => {
    const m = foldTokens(a.module);
    return [...q].some((t) => m.has(t));
  });
}

// ───────────────────────── Inventaire exhaustif & classification ─────────────────────────

export type ParityStatus = "NATIVE" | "COVERED" | "GAP" | "EXCLUDED";

export interface ActionClassification {
  status: ParityStatus;
  /** NATIVE/COVERED : l'outil du Chief (ou l'id ERP_ACTIONS) qui rend ce service. */
  via?: string;
  /** GAP : ce qui manque ; EXCLUDED : pourquoi ce n'est pas un travail d'assistant. */
  note?: string;
}

const CLASSIFICATION: Record<string, ActionClassification> = {};
function classify(status: ParityStatus, viaOrNote: string, keys: string[]): void {
  for (const k of keys) {
    CLASSIFICATION[k] = status === "NATIVE" || status === "COVERED"
      ? { status, via: viaOrNote }
      : { status, note: viaOrNote };
  }
}

// ── NATIVE : le Chief exécute CETTE action serveur (via l'outil indiqué). ──
classify("NATIVE", "request_treasury_update", ["finance-actions:requestTreasuryUpdate"]);
classify("NATIVE", "assign_regulatory_responsible", ["regulatory-actions:setRegulatoryResponsible"]);
classify("NATIVE", "set_regulatory_step", ["regulatory-actions:setRegulatoryStepState", "regulatory-actions:setRegulatoryPresubOutcome"]);
classify("NATIVE", "request_regulatory_status_update", ["regulatory-actions:requestRegulatoryStatusUpdate"]);
classify("NATIVE", "delete_record", ["admin-delete-actions:superAdminDelete"]);
classify("NATIVE", "restore_record", ["admin-delete-actions:restoreDeletedRecord"]);
classify("NATIVE", "purge_record", ["admin-delete-actions:destroyDeletedRecord"]);
classify("NATIVE", "set_account_active", ["admin-actions:toggleUserActive"]);
classify("NATIVE", "set_account_role", ["admin-actions:updateUserRole", "admin-actions:setSecondaryRole"]);
classify("NATIVE", "create_task", ["task-actions:createTask"]);
classify("NATIVE", "update_request", ["admin-request-actions:updateRequestStatus", "admin-request-actions:assignRequest", "admin-request-actions:addRequestComment"]);
classify("NATIVE", "create_sponsoring_request", ["sponsoring-actions:createSponsoring"]);
classify("NATIVE", "create_event_request", ["event-actions:createEvent"]);
classify("NATIVE", "create_legal_document", ["legal-actions:createLegalDocument"]);
classify("NATIVE", "update_legal_document", ["legal-actions:updateLegalDocument"]);
classify("NATIVE", "update_calendar_event", ["calendar-actions:updateCalendarEvent", "calendar-actions:deleteCalendarEvent"]);
classify("NATIVE", "create_hospital", ["medical-actions:createInstitution"]);
classify("NATIVE", "update_hospital", ["medical-actions:updateInstitution"]);
classify("NATIVE", "decide_payment", ["payment-centre-actions:decidePayment"]);
// « Adam, remets l'approbation obligatoire pour les mails. » — le Chief écrit la MÊME politique
// que l'écran de réglages, derrière la même ressaisie pour armer l'envoi autonome.
classify("NATIVE", "set_mail_policy", ["adam-settings-actions:setAdamMailPolicy"]);

// ── COVERED : le même résultat métier, par un outil équivalent du Chief. ──
classify("COVERED", "update_regulatory_product", [
  "regulatory-actions:updateRegulatoryProduct", "regulatory-actions:updateRegulatoryStatus",
  "regulatory-actions:setRegulatoryPriority", "regulatory-actions:setRegulatoryTargetDates",
  "regulatory-actions:setRegulatoryLock",
]);
classify("COVERED", "create_admin_request", ["admin-request-actions:createRequest"]);
// LE REGISTRE DE MARQUE (§26) : la charte (couleurs, polices, coordonnées, mentions, signataires) se règle en
// parlant — `document_profile` (geste definir, champ `marque`), même validation, même audit que l'écran.
classify("COVERED", "document_profile (geste definir, champ marque)", ["brand-actions:enregistrerMarque"]);
// LE BOUTON DES FINANCES (§118.135) : composer une facture ou un bon de commande au format de la
// société, sur son papier en-tête — c'est EXACTEMENT ce que `document_build` fait en conversation
// (« fais-moi une facture Pharmagène pour Biogalenic… »), par la MÊME fabrique et le même registre ;
// l'aperçu est la lecture à blanc de la même composition, et le motif de numérotation se règle par
// `document_profile` (champ `numerotation`).
classify("COVERED", "document_build", ["fabrique-actions:emettrePieceCommerciale", "fabrique-actions:previsualiserPieceCommerciale"]);
classify("COVERED", "document_profile (geste definir, champ numerotation)", ["fabrique-actions:reglerNumerotationPieces"]);
// L'APERÇU D'UNE SUPPRESSION (§118.162) — la fenêtre de l'écran le lit avant le clic ; en
// conversation, c'est la carte de `delete_record` qui le montre (« Part aussi »), par la même
// fonction du registre : une seule lecture de « ce qui part avec » pour les deux portes.
classify("COVERED", "delete_record (carte : « Part aussi »)", ["admin-delete-actions:apercuDeSuppression"]);
classify("COVERED", "create_task (planifiée, circuit demande)", ["task-actions:requestTask"]);
classify("COVERED", "update_task", ["task-actions:updateTaskStatus", "task-actions:startTask"]);
classify("COVERED", "create_dossier", ["dossier-actions:createDossier"]);
classify("COVERED", "create_calendar_event", ["calendar-actions:createCalendarEvent"]);
classify("COVERED", "create_hr_request", ["hr-document-actions:requestHrDocument"]);
classify("COVERED", "create_congress_request", ["congress-request-actions:createCongressRequest"]);
classify("COVERED", "send_message", ["messaging-actions:sendMessage", "messaging-actions:createDirect"]);
// PARTAGER UN ÉLÉMENT PAR LA MESSAGERIE : l'action prépare la conversation puis appelle
// `sendMessage`, l'écrivain unique. Ce qu'elle produit — un message portant une référence et,
// le cas échéant, des pièces du Drive — `send_message` le produit déjà en conversation, où l'on
// dit simplement « envoie le dossier REG-2026-041 à Amel ». Le geste d'écran ajoute le
// confort du bouton, pas une capacité de plus.
classify("COVERED", "send_message", ["partage-actions:partagerParMessagerie"]);
classify("COVERED", "send_email", ["mail-actions:sendMailAction", "microsoft-mail-actions:sendMessage", "smart-mail-actions:sendMail"]);
classify("COVERED", "create_notification", ["notification-actions:sendBroadcast"]);
classify("COVERED", "update_platform_setting", [
  "settings-actions:saveAppSettings", "settings-actions:setRegEnrollmentEnabled",
  "settings-actions:setRegulatorySupervisorRoles", "settings-actions:setRegulatoryTherapeuticSegments",
  "settings-actions:setDriveSpaceCreatorRoles", "settings-actions:setFieldReportsOverviewRoles",
  "settings-actions:setDirectiveAccess", "settings-actions:setOrgChartViewers", "settings-actions:saveDriveStorageSettings",
  "settings-actions:setHiddenModules",
  // « Dans Regulatory, supprime la colonne classe thérapeutique » : MÊME réglage et MÊME
  // catalogue (`vues/colonnes-regulatory`) que la console d'administration — un autre chemin
  // vers le même levier, jamais un levier caché.
  "settings-actions:setRegulatoryHiddenColumns",
  // QUI ÉCRIT LES MESSAGES PRÉ-DÉFINIS de la promotion médicale — une LISTE DE RÔLES sur
  // `AppSetting`, exactement la forme de `setRegulatorySupervisorRoles` et de
  // `setFieldReportsOverviewRoles` juste au-dessus. La décision de permission reste au Super
  // Admin (§118.108) ; l'outil de réglage de plateforme est le chemin, pas un levier de plus.
  "settings-actions:setPromoMessageAuthorRoles",
  // LE SEUIL Ad & Pro DU DIRECTEUR GÉNÉRAL n'est PLUS ici (§118.149). Il y était déclaré couvert
  // alors que `update_platform_setting` ne le connaissait pas (absent de ses réglages
  // modifiables : la carte aurait répondu « réglage inconnu »). Il a désormais son op —
  // `adpro_operation:set_request_threshold`, comme le seuil des bons de commande — qui appelle
  // l'action de l'écran, avec son siège (Direction Générale ET Super Admin).
]);
classify("COVERED", "find_documents / inspect_drive_folder (lecture)", ["drive-browse-actions:browseDrive"]);
classify("COVERED", "update_salary", ["payroll-hr-actions:updatePayrollEntry"]);
// La double implémentation d'écran (admin/users) du MÊME geste métier : l'outil de compte
// existant produit l'effet identique (activation + sessions révoquées à la désactivation).
classify("COVERED", "set_account_active", ["access-actions:setUserActive"]);
// Révoquer UNE session précise exige la liste d'écran (empreinte appareil/date) ; le geste de
// sécurité demandé en conversation — « déconnecte X de partout » — est couvert intégralement.
classify("COVERED", "org_operation:revoke_sessions", ["access-actions:revokeSession"]);
// Wrapper d'écran du MÊME geste : editLegalDocument rejoue updateLegalDocument (couvert).
classify("COVERED", "update_legal_document", ["legal-actions:editLegalDocument"]);
// « Adam, suspends les envois » : la politique « brouillons seulement » produit EXACTEMENT le
// même résultat métier que le coupe-circuit sortant — plus rien ne quitte l'entreprise, même
// approuvé. Le Chief atteint donc le service par un autre chemin, déjà confirmé et audité.
classify("COVERED", "set_mail_policy", ["adam-settings-actions:setAdamOutboundPaused"]);

// ── GAP : action d'écran RECONNUE, pas encore proposable par le Chief. ──
const G = (note: string, keys: string[]) => classify("GAP", note, keys);
G("écritures Drive (créer/renommer/déplacer/partager/corbeille) — prochain lot, mêmes actions canoniques", [
  "drive-actions:createFolder", "drive-actions:ensureDriveFolders", "drive-actions:getDriveNodeShares",
  "drive-actions:renameNode", "drive-actions:moveNode", "drive-actions:trashNode", "drive-actions:restoreNode",
  "drive-actions:deleteNode", "drive-actions:shareNode", "drive-actions:shareNodeWithMany", "drive-actions:unshareNode",
  "drive-actions:createOfficeNode", "drive-actions:convertNodeToPdf", "drive-actions:trashNodes",
  "drive-actions:shareNodesWithMany", "drive-actions:copyNodes", "drive-actions:moveNodes",
  "drive-space-actions:createDriveSpace", "drive-space-actions:updateDriveSpace",
  "drive-space-actions:archiveDriveSpace", "drive-space-actions:deleteDriveSpace",
  "drive-comment-actions:postDriveComment", "drive-comment-actions:deleteDriveComment",
]);
G("création de dossier Regulatory (formulaire riche : référence, DCI, entité, segments…)", ["regulatory-actions:createRegulatoryProduct"]);
G("participants / accès du dossier Regulatory", ["regulatory-actions:setRegulatoryParticipants"]);
G("détail d'étape (dates planifiée/réelle, pièces manquantes, note) au-delà du statut", ["regulatory-actions:updateRegulatoryStep", "regulatory-actions:setRegulatoryStepNote"]);
G("commentaires de dossier Regulatory", ["regulatory-actions:addRegulatoryComment"]);
G("déverrouillage global, BV, checklist, variations, classification, fournisseur Regulatory", [
  "regulatory-actions:unlockAllRegulatory", "regulatory-actions:requestBV",
  "regulatory-actions:setRegulatoryChecklistItem", "regulatory-actions:createVariation",
  "regulatory-actions:setVariationStatus", "regulatory-actions:deleteVariation",
  "regulatory-actions:setRegulatoryClassification", "regulatory-actions:createRegulatorySupplier",
  "regulatory-reminder-actions:sendRegulatoryUpdateReminder",
]);
G("écritures comptables & trésorerie (créer/modifier/importer/soldes d'ouverture)", [
  "finance-actions:createTransaction", "finance-actions:updateTransactionStatus", "finance-actions:updateTransaction",
  "finance-actions:deleteTransaction", "finance-actions:importTransactions", "finance-actions:setTreasuryOpeningBalance",
  "finance-actions:deleteTreasuryAccount", "finance-actions:createQuickIncome",
  "finance-actions:createEmployee", "finance-actions:createPayroll",
]);
G("factures (créer/payer/supprimer)", ["invoice-actions:createInvoice", "invoice-actions:updateInvoice", "invoice-actions:setInvoicePaid", "invoice-actions:deleteInvoice"]);
G("budgets & enveloppes (créer/attribuer/dépenser)", [
  "budget-actions:createBudget", "budget-envelope-actions:setBudgetTotal", "budget-envelope-actions:createEnvelope",
  "budget-envelope-actions:updateEnvelope", "budget-envelope-actions:deleteEnvelope",
  "budget-envelope-actions:createBudgetCategory", "budget-envelope-actions:updateBudgetCategory",
  "budget-envelope-actions:deleteBudgetCategory", "budget-envelope-actions:attributeTransaction",
  "budget-envelope-actions:addBudgetExpense", "budget-envelope-actions:updateBudgetExpense",
  "budget-envelope-actions:deleteBudgetExpense",
  "department-budget-actions:setDepartmentBudgetAccess", "department-budget-actions:setDepartmentBudget",
  "department-budget-actions:requestDepartmentBudget", "department-budget-actions:decideDepartmentBudgetRequest",
  "department-budget-actions:addDepartmentExpense", "department-budget-actions:updateDepartmentExpense",
  "department-budget-actions:deleteDepartmentExpense",
]);
G("caisse d'avance (allouer/dépenser/recharger)", [
  "petty-cash-actions:allotPettyCash", "petty-cash-actions:confirmPettyCashReceipt", "petty-cash-actions:closePettyCash",
  "petty-cash-actions:spendFromPettyCash", "petty-cash-actions:requestPettyCashTopUp",
  "petty-cash-actions:decidePettyCashTopUp", "petty-cash-actions:setPettyCashPlan",
]);
G("ordres de dépense (règlement, report de paiement, facture)", [
  "expense-actions:settleExpenseOrder", "expense-actions:requestInvoice",
  "expense-actions:deferExpenseOrder", "expense-actions:resumeExpenseOrder",
]);
G("demandes de paiement (création/pièces/décisions du circuit)", [
  "payment-request-actions:createPaymentRequest", "payment-request-actions:addPaymentPiece",
  "payment-request-actions:commentPaymentPiece", "payment-request-actions:reviewPaymentPiece",
  "payment-request-actions:addPaymentComment", "payment-request-actions:submitPaymentRequest",
  "payment-request-actions:decidePaymentRequest", "payment-request-actions:cancelPaymentRequest",
  "payment-request-actions:updatePaymentRequestDetails",
  "payment-centre-actions:respondToPaymentCentre",
]);
G("paie RH (saisir un salaire, annuler une saisie)", ["payroll-hr-actions:markSalaryPaid", "payroll-hr-actions:unmarkSalaryPaid"]);
G("RH : fiche employé, congés/avances (décisions), documents employé", [
  "hr-actions:createEmployee", "hr-actions:updateEmployee",
  "hr-actions:setEmployeeActive", "hr-actions:requestLeave", "hr-actions:decideLeave", "hr-actions:cancelLeave",
  "hr-actions:updateLeaveRequest", "hr-actions:requestAdvance", "hr-actions:decideAdvance", "hr-actions:cancelAdvance",
  "hr-document-actions:addHrRequestComment", "hr-document-actions:processHrRequest",
  "hr-document-actions:decideExpenseReport", "hr-document-actions:decideHrLeave",
  "hr-document-actions:ackExpenseOriginals", "hr-document-actions:proposeHrMeeting",
  "hr-document-actions:confirmHrMeeting", "hr-document-actions:deleteHrRequest",
  "hr-document-actions:deleteEmployeeDocument", "hr-document-actions:setEmployeeDocumentVisibility",
]);
G("recrutement (circuit complet)", [
  "recruitment-actions:createRecruitmentRequest", "recruitment-actions:decideRecruitmentStep",
  "recruitment-actions:cancelRecruitmentRequest", "recruitment-actions:askRecruitmentInfo",
  "recruitment-actions:answerRecruitmentInfo", "recruitment-actions:openRecruitmentSourcing",
  "recruitment-actions:closeRecruitmentRequest", "recruitment-actions:addRecruitmentCandidate",
  "recruitment-actions:moveRecruitmentCandidate", "recruitment-actions:onboardRecruitment",
]);
G("formations (demande, décision, invitations)", [
  "training-actions:requestTraining", "training-actions:createHrTraining", "training-actions:decideTraining",
  "training-actions:updateTraining", "training-actions:inviteTrainingParticipants",
  "training-actions:respondToTrainingInvitation",
]);
G("réunions (créer/inviter/répondre/compte rendu)", [
  "meeting-actions:setMeetingLink", "meeting-actions:createMeeting", "meeting-actions:updateMeeting",
  "meeting-actions:respondToMeetingInvite", "meeting-actions:setMeetingLive", "meeting-actions:endMeeting",
  "meeting-actions:startCall", "meeting-actions:addMeetingParticipants", "meeting-actions:removeMeetingParticipant",
  "meeting-actions:saveMeetingTranscript", "meeting-actions:summarizeMeeting", "meeting-actions:acceptMeetingProposal",
  "meeting-actions:dismissMeetingProposal", "meeting-actions:deleteMeeting", "meeting-actions:postMeetingMessage",
  "meeting-actions:deleteMeetingMessage",
]);
G("messagerie avancée (groupes, canaux, épingles, réactions, membres)", [
  "messaging-actions:createGroup", "messaging-actions:createChannel", "messaging-actions:editMessage",
  "messaging-actions:deleteMessage", "messaging-actions:toggleReaction", "messaging-actions:togglePinMessage",
  "messaging-actions:bookmarkMessage", "messaging-actions:togglePinConversation", "messaging-actions:toggleMute",
  "messaging-actions:setNotifyLevel", "messaging-actions:updateConversation", "messaging-actions:addMembers",
  "messaging-actions:removeMember", "messaging-actions:setMemberRole", "messaging-actions:leaveConversation",
  "messaging-actions:archiveConversation", "messaging-actions:joinChannel", "messaging-actions:setMessagingStatus",
]);
G("boîte e-mail avancée (signature — le reste est EXCLU plus bas)", [
  "microsoft-mail-actions:saveMailSignature", "mail-actions:updateMailSignature",
]);
G("registre des courriers (créer/classer/pièces/partenaires)", [
  "mail-register-actions:createMailEntry", "mail-register-actions:editMailEntry", "mail-register-actions:setMailDate",
  "mail-register-actions:deleteMailEntry", "mail-register-actions:attachDriveNodeToMail",
  "mail-folder-actions:createMailFolder", "mail-folder-actions:updateMailFolder", "mail-folder-actions:deleteMailFolder",
  "mail-folder-actions:moveMailEntries", "mail-partner-actions:createMailPartner",
  "mail-partner-actions:updateMailPartner", "mail-partner-actions:deleteMailPartner",
  "mail-piece-actions:addMailPiece", "mail-piece-actions:updateMailPiece", "mail-piece-actions:deleteMailPiece",
]);
// NB : editLegalDocument est classé COVERED plus haut — le mettre ici l'écraserait en GAP
// (les blocs s'exécutent dans l'ordre du fichier ; seul le override catalogue est final).
G("Legal avancé (édition, dossiers, rattachements Drive, règlement de facture, lecteurs)", [
  "legal-actions:attachDriveNodeToLegal", "legal-actions:renewLegalDocument",
  "legal-actions:cancelLegalDocument", "legal-actions:deleteLegalDocument", "legal-actions:setLegalReaders",
  "legal-actions:sendLegalInvoiceToSettlement", "legal-folder-actions:createLegalFolder",
  "legal-folder-actions:updateLegalFolder", "legal-folder-actions:deleteLegalFolder",
  "legal-folder-actions:moveLegalDocuments",
]);
// Le rattachement d'une pièce Legal existante (`ad-pro-rattacher-legal`) n'est PAS ici : il est
// couvert par `legal_operation/link_record` et `unlink_record`, donc reclassé NATIVE par le
// catalogue. Le mettre dans ce bloc l'écraserait en GAP le temps de la lecture, pour rien.
G("Ad&Pro (postes, décisions, transferts, consulting)", [
  "ad-pro-edit-actions:updateAdProRequest", "ad-pro-item-actions:addAdProItem", "ad-pro-item-actions:updateAdProItem",
  "ad-pro-item-actions:deleteAdProItem",
  "ad-pro-item-actions:linkPromoMaterial",
  "ad-pro-item-actions:submitAdProItem", "ad-pro-item-actions:decideAdProItem", "ad-pro-item-actions:setAdProItemBudget",
  "ad-pro-item-actions:demanderPieceSecretariat", "ad-pro-item-actions:requestAdProItemOrder",
  "ad-pro-item-actions:approveAdProItemOrder", "ad-pro-other-actions:createAdProOtherRequest",
  "ad-pro-other-actions:decideAdProOtherRequest", "ad-pro-other-actions:closeAdProOtherRequest",
  "ad-pro-transfer-actions:transferAdProRequest", "consulting-actions:createConsultingContract",
  "consulting-actions:requestConsultingValidation", "consulting-actions:decideConsultingContract",
  "consulting-actions:closeConsultingContract", "consulting-actions:addConsultingTask",
  "consulting-actions:toggleConsultingTask", "consulting-actions:deleteConsultingTask",
]);
G("circuit matériel promo (devis→BAT→paiement, étapes après création)", [
  "promo-material-actions:submitQuotes", "promo-material-actions:chooseAgency",
  "promo-material-actions:submitBcForFinance", "promo-material-actions:remindFinance",
  "promo-material-actions:validateBc", "promo-material-actions:confirmBcSent",
  "promo-material-actions:initiatePayment", "promo-material-actions:confirmPayment",
  "promo-material-actions:submitMaterial", "promo-material-actions:directionReview",
  "promo-material-actions:confirmConformity", "promo-material-actions:startBat",
  "promo-material-actions:submitFinalMaterial", "promo-material-actions:recordInvoice",
  "promo-material-actions:settle", "promo-material-actions:addPromoComment",
  "promo-material-actions:cancelPromoMaterial", "promo-circuit-actions:startPromoCircuit",
  "promo-circuit-actions:markQuoteReceived", "promo-circuit-actions:validatePromoStep",
  "promo-circuit-actions:refusePromoStep", "promo-circuit-actions:completePromoTrack",
]);
G("sponsoring / congrès / prises en charge (décisions et étapes après création)", [
  "sponsoring-actions:requestThirdPartyInput", "sponsoring-actions:sponsoringAppeal",
  "sponsoring-actions:cloturerSponsoring", "sponsoring-actions:rouvrirSponsoring",
  "congress-request-actions:requestThirdPartyInput", "congress-request-actions:cancelCongressRequest",
  "congress-beneficiary-actions:addCongressBeneficiary",
  "congress-beneficiary-actions:removeCongressBeneficiary", "congress-beneficiary-actions:requestBeneficiaryIds",
  "care-actions:addCareBeneficiary", "care-actions:setCareOpinion", "care-actions:decideCareBeneficiary",
  "care-actions:removeCareBeneficiary", "care-actions:addCareCell", "care-actions:setCareCellStatus",
  "care-actions:removeCareCell", "care-actions:createCareQuote", "care-actions:decideCareQuote",
  "care-actions:requestCareQuotes", "care-actions:sendCareToFinance",
  "care-actions:linkCareCellPromoMaterial",
]);
G("événements (inscriptions, validation) après création", [
  "event-actions:updateEvent", "event-actions:deleteEvent", "event-actions:submitEventForApproval",
  "event-actions:addRegistration", "event-actions:setRegistrationStatus", "event-actions:deleteRegistration",
]);
G("projets (statut, assignation, messages, archives, liens)", [
  "dossier-actions:updateDossierStatus", "dossier-actions:assignDossier", "dossier-actions:postDossierMessage",
  "dossier-actions:linkEmailToDossier", "dossier-actions:createDossierFromTask",
  "dossier-actions:archiveDossier", "dossier-actions:deleteDossierMessage", "dossier-actions:editDossierMessage",
]);
G("tâches : répondre/faire/valider POUR SOI (accepter la tâche, déposer le travail)", [
  "task-actions:respondTaskRequest", "task-actions:submitTaskWork", "task-actions:reopenTaskWork",
  "task-actions:addTaskComment",
]);
G("demandes administratives avancées (approbations, missions, lots, corbeille propre, validations)", [
  "admin-request-actions:requestApproval", "admin-request-actions:decideApproval",
  "admin-request-actions:toggleMissionStop", "admin-request-actions:updateMission",
  "admin-request-actions:editOwnRequest",
  "admin-request-actions:deleteOwnRequest", "admin-request-actions:deleteRequests",
  "admin-request-actions:restoreRequest", "admin-request-actions:startRequestProcessing",
  "admin-request-actions:requestFinanceValidation", "admin-request-actions:requestInternalValidation",
  "admin-request-actions:finishRequest", "admin-request-actions:submitAttachmentValidation",
  "admin-request-actions:cancelAttachmentValidation", "mission-actions:assignMission", "mission-actions:removeMission",
  "mission-actions:requestMissionOrder", "mission-actions:issueMissionOrder", "mission-actions:addMissionComment",
  "purchase-request-actions:createPurchaseRequest", "purchase-request-actions:withdrawPurchaseRequest",
  "document-request-actions:requestDocument", "document-request-actions:submitDocumentRequest",
  "document-request-actions:decideDocumentRequest", "document-request-actions:cancelDocumentRequest",
  "stand-in-actions:proposeStandIn", "stand-in-actions:decideStandIn",
]);
G("médical & annuaires (médecins, visites, spécialités, annuaires praticiens, import)", [
  "medical-actions:deleteInstitution", "medical-actions:createSpecialty", "medical-actions:updateSpecialty",
  "medical-actions:deleteSpecialty", "medical-actions:deleteDoctor", "medical-actions:deleteVisit",
  "medical-actions:createDoctor", "medical-actions:updateDoctor", "medical-actions:createVisit",
  "medical-actions:updateVisit", "medical-directory-actions:importDirectorySheet",
  "medical-directory-actions:saveDirectoryCell", "medical-directory-actions:addDirectoryDoctor",
  "medical-directory-actions:deleteDirectoryDoctors", "medical-directory-crud-actions:createMedicalDirectory",
  // La feuille comme un tableur (§118.133) : les colonnes sur mesure s'éditent enfin, et les
  // cellules se colorent — deux gestes d'écran, le second sur une sélection rectangulaire que
  // la conversation n'a pas encore de façon naturelle de désigner.
  "medical-directory-actions:saveDirectoryCustomCell", "annuaire-couleurs-actions:colorerCellulesAnnuaire",
  "medical-directory-crud-actions:updateMedicalDirectory", "medical-directory-crud-actions:deleteMedicalDirectory",
  "medical-directory-crud-actions:moveDoctorsToDirectory", "medical-directory-crud-actions:setDirectoryAccess",
  // Les colonnes propres à un annuaire : Adam ne les pilote pas encore, comme le reste du groupe.
  "medical-directory-crud-actions:createDirectoryColumn", "medical-directory-crud-actions:updateDirectoryColumn",
  "medical-directory-crud-actions:deleteDirectoryColumn",
  "medical-info-actions:requestDocument", "medical-info-actions:cancelDocRequest",
  "medical-info-actions:fulfillDocRequest", "medical-info-actions:recordAuthorityDeclaration",
  "medical-info-actions:validateDeclaration", "medical-info-actions:validateDeclarationByDirection",
  "medical-info-actions:addMedicalInfoComment",
  "field-report-actions:createFieldReport",
  "field-report-actions:updateFieldReport", "field-report-actions:analyzeFieldReportAction",
  "field-report-actions:submitFieldReport", "field-report-actions:validateFieldReport",
  "field-report-actions:reopenFieldReport", "field-report-actions:deleteFieldReport",
  "field-report-actions:deleteFieldReportAttachment",
]);
G("BD / marché / PCH / ventes & prévisions (CRUD des modules commerciaux)", [
  "bd-actions:createBD", "bd-actions:updateBDStatus", "bd-project-actions:createBdProject",
  "bd-project-actions:updateBdProject", "bd-project-actions:deleteBdProject", "bd-project-actions:createBdRange",
  "bd-project-actions:updateBdRange", "bd-project-actions:deleteBdRange", "bd-project-actions:createBdProduct",
  "bd-project-actions:updateBdProduct", "bd-project-actions:deleteBdProduct", "bd-project-actions:updateBdCell",
  "bd-project-actions:addBdProjectComment",
  "market-presentation-actions:generatePresentation", "market-presentation-actions:regeneratePresentation",
  "market-presentation-actions:renamePresentation", "market-presentation-actions:deletePresentation",
  "market-research-actions:createMarketResearch", "market-research-actions:updateMarketResearch",
  "market-research-actions:setMarketResearchParticipants", "market-research-actions:deleteMarketResearch",
  "market-research-actions:addResearchRow", "market-research-actions:updateResearchRow",
  "market-research-actions:deleteResearchRow", "market-research-actions:addResearchPlayer",
  "market-research-actions:updateResearchPlayer", "market-research-actions:deleteResearchPlayer",
  "market-research-actions:prefillResearchRow", "pch-actions:createTender", "pch-actions:updateTender",
  "pch-actions:deleteTender", "pch-actions:createOrder", "pch-actions:updateOrder", "pch-actions:deleteOrder",
  "pch-tender-line-actions:addTenderLine", "pch-tender-line-actions:updateTenderLine",
  "pch-tender-line-actions:deleteTenderLine", "pch-tender-line-actions:analyzeTenderText",
  "pch-tender-line-actions:analyzeTenderDocument", "pch-tender-line-actions:createOrderFromLine",
  "pch-tender-line-actions:enrichTenderLine", "pch-tender-line-actions:enrichAllTenderLines",
  "pch-tender-line-actions:setOrderArrival", "sales-actions:createSale", "sales-actions:importSales",
  "sales-planning-actions:createBusinessUnit",
  "sales-planning-actions:updateBusinessUnit", "sales-planning-actions:deleteBusinessUnit",
  "sales-planning-actions:createPromoProduct", "sales-planning-actions:updatePromoProduct",
  "sales-planning-actions:deletePromoProduct", "sales-planning-actions:saveForecast",
  "sales-planning-actions:saveSfeSettings", "sales-planning-actions:saveTourPlanningSettings",
  "sales-planning-actions:saveRepProfile", "sales-planning-actions:deleteRepProfile",
  "sales-planning-actions:saveAssignment", "sales-planning-actions:deleteAssignment",
  "sales-planning-actions:carryForwardAssignments", "logistics-actions:createLogistics",
  "logistics-actions:updateLogisticsStatus", "delegate-plan-actions:createDelegatePlan",
  "delegate-plan-actions:updateDelegatePlan", "delegate-plan-actions:deleteDelegatePlan",
  "delegate-plan-actions:duplicateDelegatePlan", "product-catalog-actions:linkProductToDossier",
  "product-catalog-actions:unlinkProductFromDossier",
]);
G("stocks hôpitaux (états, instantanés, demandes)", [
  "stock-snapshot-actions:createStockHospital", "stock-snapshot-actions:deleteStockHospital",
  "stock-snapshot-actions:createStockAnnex", "stock-snapshot-actions:deleteStockAnnex",
  "stock-snapshot-actions:requestStockState", "stock-snapshot-actions:recordStockSnapshot",
  "stock-snapshot-actions:deleteStockSnapshot",
]);
G("administration structurelle (entités, gammes, départements, organigramme, contacts, identité)", [
  "company-actions:setCompanyScope", "company-actions:createCompany", "company-actions:updateCompany",
  "company-actions:toggleCompany", "company-access-actions:setCompanyAccess",
  "company-contact-actions:createCompanyContact", "company-contact-actions:updateCompanyContact",
  "company-contact-actions:deleteCompanyContact", "company-identity-actions:saveCompanyIdentity",
  "product-range-actions:createProductRange", "product-range-actions:updateProductRange",
  "product-range-actions:deleteProductRange", "product-range-actions:setProductsRange",
  "product-range-actions:setUserRanges", "product-range-actions:removeProductFromRange",
  "department-actions:createDepartment", "department-actions:updateDepartment", "department-actions:deleteDepartment",
  "department-actions:assignEmployeeDepartment", "department-actions:assignEmployeeManager",
  "org-actions:saveOrgNode", "entity-attach-actions:attachOrphansToCompany",
  "supplier-actions:createSupplier", "supplier-actions:toggleSupplier",
  "supplier-actions:toggleSupplierUser", "settings-actions:setPipelineAccess",
]);
G("matrice d'accès fine & profils (droits par module, périmètres de lignes, profil)", [
  "access-actions:saveAccessMatrix", "access-actions:saveModuleAccess", "access-actions:setRowGrants",
  "access-actions:updateUserProfile",
  "access-actions:requestOnboarding", "access-actions:revokeAllSessions",
]);
// Le rollback rejoue un instantané PAR saveWorkflowDefinition : le Chief couvre le besoin en
// refournissant les étapes via configure_workflow — le bouton natif est le raccourci d'écran.
classify("NATIVE", "configure_workflow", ["workflow-actions:saveWorkflowDefinition", "workflow-actions:resetWorkflowDefinition", "workflow-actions:rollbackWorkflowDefinition"]);
classify("NATIVE", "advance_workflow", ["workflow-actions:advanceWorkflow"]);
classify("NATIVE", "manage_custom_field", ["custom-field-actions:upsertCustomFieldDef", "custom-field-actions:deleteCustomFieldDef"]);
G("saisie des VALEURS de champs personnalisés sur une fiche (l'écran de la fiche le fait déjà)", [
  "custom-field-actions:saveCustomValues",
]);
G("règles et demandes de VALIDATION (module Validations)", [
  "validation-actions:createValidationRule", "validation-actions:updateValidationRule",
  "validation-actions:toggleValidationRule", "validation-actions:deleteValidationRule",
  "validation-actions:createValidationRequest", "validation-actions:decideValidation",
  "validation-actions:reviewValidationItem", "validation-actions:clearValidationItem",
  "validation-actions:remindValidator",
]);
G("pièces jointes & documents polymorphes (upload/renommage), papiers en-tête, fournitures", [
  "document-actions:uploadDocument", "document-actions:renameDocument", "document-actions:deleteDocument",
  "letterhead-actions:uploadLetterhead", "letterhead-actions:updateLetterhead", "letterhead-actions:deleteLetterhead",
  "office-supply-actions:createSupplyArticle", "office-supply-actions:updateSupplyArticle",
  "office-supply-actions:toggleSupplyArticle", "office-supply-actions:previewCatalogNormalization",
  "office-supply-actions:applyCatalogNormalization",
]);
G("directives, support, feedback, commentaires génériques, rappels d'écran", [
  "directive-actions:createDirective", "directive-actions:updateDirectiveStatus", "directive-actions:archiveDirective",
  "directive-actions:postDirectiveMessage",
 "support-actions:createSupportRequest", "support-actions:takeSupportRequest",
  "support-actions:answerSupportRequest", "support-actions:updateSupportStatus", "feedback-actions:submitFeedback",
  "feedback-actions:updateFeedbackStatus", "comment-actions:updateComment", "comment-actions:deleteComment",
  "reminder-actions:createReminder", "reminder-actions:completeReminder", "reminder-actions:cancelReminder",
  "reminder-actions:snoozeReminder", "calendar-actions:respondToInvite",
]);
G("cockpit Adventum (seuils de risque) & maintenance profonde de la base", [
  "adventum-actions:updateRiskThresholds",
  "database-admin-actions:purgeOrphanStorage", "database-admin-actions:permanentlyDeleteDriveNode",
  "database-admin-actions:permanentlyDeleteDocument",
  "ai-settings-actions:updateAiSettings", "feature-actions:setFeatureStage",
]);

// ── LA MAIN HUMAINE SUR UNE MISSION D'EXÉCUTION (§33-40) ─────────────────────────────────
//
// Trois gestes RÉDUISENT ce qu'une mission va faire — suspendre, reprendre, arrêter — et le
// refus d'une autorisation en fait autant. Adam les propose par `mission_control`, donc COVERED.
classify("COVERED", "mission_control (pause / reprise / arrêt / refus d'autorisation / replanification)", [
  "mission-runtime-actions:mettreMissionEnPause",
  "mission-runtime-actions:reprendreMission",
  "mission-runtime-actions:arreterMission",
  // La replanification est COUVERTE et non exclue : elle n'AJOUTE rien de sortant sans accord.
  // Tout ce que le nouveau plan apporte repasse par `reouvrirSiChange` (§8), donc par la
  // personne. Au pire, une injection qui la déclencherait produit une demande d'accord de plus.
  "mission-runtime-actions:replanifierMissionAction",
  /**
   * LA PRIORITÉ est un ORDRE DE PASSAGE, pas une autorisation. Le battement sert les priorités
   * hautes d'abord et l'ancienneté ensuite : relever une mission n'en condamne aucune autre, et
   * une injection qui la déclencherait ferait au pire passer un dossier devant un autre — ce
   * qui se voit sur l'écran du centre, et se remet à zéro d'un clic.
   */
  "mission-runtime-actions:changerPrioriteMission",
  /**
   * MODIFIER UNE MISSION — l'aperçu ne fait que LIRE (`prevoirModification` n'écrit rien), et
   * l'application ne peut RIEN faire sortir : elle invalide des étapes et rouvre des jalons,
   * dont tout ce qui sortirait repasserait par `reouvrirSiChange` (§8), donc par un accord
   * humain. C'est un geste qui RÉDUIT ou RÉORIENTE, jamais un geste qui engage — et il porte
   * la même empreinte bornée que la conversation (§118.48) : une cible reconnue nulle part ne
   * touche à rien.
   */
  "mission-runtime-actions:prevoirModificationMission",
  "mission-runtime-actions:appliquerModificationMission",
  /**
   * LES GESTES DE MASSE (§118.132) — « suspendre toutes mes missions », « arrêter les bloquées » :
   * le confort du bouton, pas une capacité de plus. Chacun rejoue `pause` / `arreter` sur chaque
   * mission de la personne, que `mission_control` propose déjà une par une.
   */
  "mission-runtime-actions:suspendreToutesMesMissions",
  "mission-runtime-actions:arreterMesMissionsBloquees",
]);
/**
 * L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — couvert dans le SEUL sens qu'une conversation
 * a le droit de prendre : POSER (`mission_control` → `suspendre_tout`, direction seulement).
 * LEVER rouvre un moteur et n'existe que par un clic dans les réglages d'Adam (§118.15) — c'est
 * la même asymétrie que `set_mail_policy` face au coupe-circuit sortant, et elle est voulue.
 */
classify("COVERED", "mission_control (suspendre_tout — sens réducteur seul ; la levée exige l'écran)", [
  "adam-settings-actions:setAdamMissionsPaused",
]);
// La LECTURE de ses accords en attente est la même information que `mission_status` rend déjà.
classify("COVERED", "mission_status (l'écran d'une mission dit ce qu'elle attend de vous)", [
  "mission-runtime-actions:listerAccordsMission",
]);

// ── EXCLUDED : pas un travail d'assistant — raison donnée, pas un oubli. ──
const X = (note: string, keys: string[]) => classify("EXCLUDED", note, keys);
X("SEGMENTATION STUDIO (Direction, 06/10) : stratégie, classement des produits, règles VERSIONNÉES publiées après l'aperçu "
  + "de leur impact, import d'un classeur relu ligne à ligne, potentiel terrain, statut, dérogations MOTIVÉES. Chaque geste "
  + "demande de VOIR ce qu'il change (impact, aperçu d'import, valeur calculée à côté de la dérogation) : c'est l'écran "
  + "`/segmentation` qui le montre. Adam est en pause de développement (Super Admin seul) ; ses outils viendront avec la "
  + "phase « interrogation assistée » du cahier des charges.", [
  "segmentation-actions:creerStrategie", "segmentation-actions:classerProduits", "segmentation-actions:apercuRegles",
  "segmentation-actions:publierRegles", "segmentation-actions:apercuImportSegmentation", "segmentation-actions:importerSegmentation",
  "segmentation-actions:enregistrerPotentiel", "segmentation-actions:changerStatut", "segmentation-actions:ajouterAuPanel",
  "segmentation-actions:retirerDuPanel", "segmentation-actions:poserDerogation", "segmentation-actions:leverDerogation",
  "segmentation-actions:ciblerSpecialitesProduit", "segmentation-actions:ouvrirCycleSegmentation",
  "segmentation-actions:cloreCycleSegmentation",
  // La lettre forcée (droit accordé par le Super Admin), le secteur d'une fiche, la recherche pour ajouter au panel.
  "segmentation-actions:forcerLettre", "segmentation-actions:rendreLettreCalculee", "segmentation-actions:changerSecteur",
  "segmentation-actions:chercherPraticiensHorsPanel",
  // Le classeur de la Direction importé « en une fois » : un fichier, une BU, un aperçu lu à l'écran avant d'importer.
  "segmentation-actions:apercuImportClasseurDirection", "segmentation-actions:importerClasseurDirection",
]);
X("CONGRÈS / ÉVÉNEMENT — ANCIENNES DÉCISIONS HORS CIRCUIT (Direction, 27/10) : préliminaire, analyse Direction Marketing, "
  + "validation définitive et budget accordé global écrivaient `requestStatus` et le montant SANS le moteur de circuit. "
  + "Aucun écran ne les propose plus ; Adam passe par les mêmes gestes que l'écran (`advance_workflow`, puis les postes). "
  + "Elles ne sont pas un geste d'assistant.", [
  "congress-request-actions:preliminaryDecision", "congress-request-actions:submitProductAnalysis",
  "congress-request-actions:finalDecision", "congress-request-actions:updateGrantedBudget",
]);
X("L'ANCIENNE RÉSERVATION EN BLOC, FERMÉE (Direction, 27/10) : demander / retirer la réservation de tous les voyageurs "
  + "d'un poste, ou de toutes les fiches d'une prise en charge, en un sujet. La Direction garde la RÉSERVATION PAR FICHE "
  + "(`reservation-fiche-actions`) : ces gestes refusent et n'écrivent plus rien, leurs envois passés ont été repris en "
  + "fiches. Aucun geste à offrir.", [
  "ad-pro-item-actions:demanderReservation", "ad-pro-item-actions:retirerReservation",
  "care-actions:demanderReservationPriseEnCharge",
]);
X("PIÈCES DEMANDÉES › CONFIER LE BC D'UN POSTE À UNE AUTRE ASSISTANTE (audit Assistante de direction, 10/2026) : le geste se "
  + "décide en REGARDANT le fil de la pièce (`/pieces/[id]`) — qui la tient, depuis quand, si elle est déposée — et ne vise "
  + "qu'une assistante de direction ACTIVE, proposée par l'écran. Adam est en pause de développement (Super Admin seul).", [
  "document-request-actions:reaffecterDemandeBC",
]);
X("FORCE DE VENTE › TERRITOIRES (Direction, 07/10) : rattacher en un clic une cible H ou A hors panel au délégué de son "
  + "secteur. Le geste se décide en REGARDANT la liste du secteur (lettre, statut, établissement) que l'écran "
  + "`/planning/territoires` montre ; il ne réaffecte jamais un praticien déjà suivi.", [
  "force-de-vente-actions:affecterAuDelegue",
]);
X("INTELLIGENCE TERRAIN (console d'administration, Direction 10/2026 : « visible uniquement par le Super Administrateur ») : "
  + "relancer l'analyse d'influence (Luna lit les nouveaux rapports) et confirmer / rejeter un lien proposé, preuve citée sous "
  + "les yeux. Réservé au SUPER ADMIN, non délégable — chaque action relit le rôle ; aucune ouverture conversationnelle.", [
  "intelligence-terrain-actions:relancerAnalyseInfluence", "intelligence-terrain-actions:deciderLienInfluence",
]);
X("TESTER L'ÉDITEUR OFFICE (Administration, Super Admin) : diagnostic de configuration — variables, adresses, réponse du "
  + "Document Server. Une moitié du test se joue DANS LE NAVIGATEUR de l'administrateur (chargement d'api.js) : une "
  + "conversation ne peut pas la faire. C'est un écran de dépannage, pas un geste métier.", [
  "onlyoffice-diagnostic-actions:testerEditeurOffice",
]);
X("FINANCES › RÉPONDRE À UNE DEMANDE D'ACTUALISATION DES SOLDES (Direction, 10/2026) : le responsable Finance saisit, "
  + "compte par compte, le solde du relevé bancaire qu'il a SOUS LES YEUX et sa date — ou « pas encore reçu ». C'est une "
  + "attestation de ce que dit la banque, qui réancre le compte : elle se donne devant l'écran de la demande "
  + "(`/finances/actualisation-soldes/[id]`), ouvert par sa notification. Adam est en pause de développement (Super Admin seul).", [
  "actualisation-soldes-actions:repondreActualisationSoldes",
]);
X("INFORMATION MÉDICALE › RELANCER UNE PIÈCE (Direction, 07/10) : une notification à la personne sollicitée, limitée à une "
  + "toutes les quatre heures. Le geste se décide en REGARDANT la fiche du dossier (depuis quand la pièce est attendue, "
  + "dernière relance) ; Adam est en pause de développement (Super Admin seul).", [
  "medical-info-actions:relancerPieceInfoMed",
]);
X("CONSUMPTION INTELLIGENCE : importer un fichier de consommation, trancher ce qui n'est pas sûr (une correspondance "
  + "confirmée s'apprend), écarter une ligne, VALIDER pour que les lignes comptent, annuler, régler l'affinité d'un "
  + "produit. Chaque geste se décide en REGARDANT la revue (colonnes lues, confiance, impact sur la segmentation) : "
  + "c'est l'écran `/consommation`. Adam est en pause de développement (Super Admin seul).", [
  "consommation-actions:importerFichierConsommation", "consommation-actions:confirmerCorrespondanceConso",
  "consommation-actions:ignorerLigneConso", "consommation-actions:validerImportConso", "consommation-actions:annulerImportConso",
  "consommation-actions:enregistrerAffiniteConfig",
]);
X("VENTES PCH (Direction, 08/10) : importer les fichiers de la PCH (ventes des DR, réceptions de la PCH centrale) se "
  + "décide en REGARDANT l'aperçu (nature, période, établissements et produits reconnus, mois remplacés) ; rattacher un "
  + "client, un poste PCH, un fournisseur « à nous » ou nommer une DR se fait en lisant les listes « à rattacher » de "
  + "l'écran `/sales/importer`. Adam est en pause de développement (Super Admin seul).", [
  "ventes-pch-actions:apercuFichiersVentesPch", "ventes-pch-actions:appliquerFichiersVentesPch",
  "ventes-pch-actions:rattacherEtablissementVentesPch", "ventes-pch-actions:rattacherPosteVentesPch",
  "ventes-pch-actions:reglerFournisseurVentesPch", "ventes-pch-actions:enregistrerDrVentesPch",
]);
X("RATTACHEMENT AUTOMATIQUE DES PRATICIENS À LEUR ÉTABLISSEMENT (Direction, 06/10) : un geste en lot de la feuille de "
  + "l'annuaire, sur les fiches de la vue, après confirmation — la même règle s'applique d'elle-même à chaque écriture "
  + "(cellule, ajout, import). Adam est en pause de développement (Super Admin seul).", [
  "medical-directory-actions:rattacherAutomatiquement",
]);
X("ANNUAIRES (Direction, 06/10) : l'annuaire des FOURNISSEURS REGULATORY (ajouter, corriger, retirer — désactivé "
  + "quand il porte des dossiers) et la MODIFICATION d'une coordonnée d'une personne. Des gestes d'écran, faits en "
  + "regardant la fiche. Adam est en pause de développement (Super Admin seul).", [
  "fournisseurs-annuaire-actions:creerFournisseurAnnuaire", "fournisseurs-annuaire-actions:modifierFournisseurAnnuaire",
  "fournisseurs-annuaire-actions:retirerFournisseurAnnuaire", "directory-actions:updateDirectoryEndpoint",
]);
X("METTRE AU PIPELINE TOUS LES DOSSIERS NON ENTAMÉS (Direction, 06/10) : un geste du Super Admin, sur l'écran du "
  + "suivi, qui compte puis confirme avant de verrouiller un portefeuille entier. Pas un travail d'assistant.", [
  "regulatory-actions:mettreAuPipelineNonEntames", "regulatory-actions:compterDossiersNonEntames",
]);
X("RÉPARTITION DES COÛTS PARTAGÉS D'UNE BU (cahier des charges §15, §85) : un geste des Finances qui décide quelle part "
  + "des dépenses de la BU revient à chaque produit pour l'année. Il se décide en regardant la vue 360° du produit "
  + "(direct, alloué, non alloué). Adam est en pause de développement (Super Admin seul).", [
  "repartition-couts-actions:enregistrerRepartitionBu",
]);
X("LES PRIX D'UN PRODUIT, À LA MAIN (Produits 360, Direction 07/10) : une saisie l'emporte sur le prix observé dans "
  + "l'Explorateur produits, à partir de sa date d'effet, et l'historique garde chaque ligne. Le geste se décide devant la "
  + "fiche du produit, à côté de la valeur de l'Explorateur. Adam est en pause de développement (Super Admin seul).", [
  "prix-produit-actions:enregistrerPrixProduit",
  "prix-produit-actions:revenirAuPrixExplorateur",
]);
X("BUDGETS DES PÔLES — Budget Marketing, Budget Regulatory, Budget Operations & Sales (Direction, 08/10) : créer, régler "
  + "et retirer une enveloppe de son pôle ; compléter ses catégories d'office (BV 25 % / 75 %, masse salariale par BU) ; "
  + "saisir un BV payé hors circuit ; ranger un BV demandé ou payé dans l'enveloppe. Des gestes d'écran neufs, sur les "
  + "Réglages, l'onglet « BV par dossier » et l'onglet « Masse salariale » de chaque module, décidés devant les chiffres "
  + "de l'enveloppe ; le contenu ordinaire (catégories, lignes, imputation) passe par les actions de Budgets, déjà "
  + "classées. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "budget-pole-actions:createPoleEnvelope",
  "budget-pole-actions:updatePoleEnvelope",
  "budget-pole-actions:deletePoleEnvelope",
  "budget-pole-actions:completerCategoriesPole",
  "budget-pole-actions:saisirBvManuel",
  "budget-pole-actions:imputerBv",
  // RÉALLOUER entre deux catégories (Budget Marketing, 10/2026) : un montant déplacé, motif obligatoire gardé dans
  // l'historique — décidé devant le tableau « Par catégorie » de la vue d'ensemble, pas par un appel d'Adam.
  "budget-pole-actions:reallouerCategorie",
]);
X("RESOUMETTRE ET RETIRER UNE DEMANDE AD & PRO (§118.186, audit R02/R24) : deux gestes du DEMANDEUR sur SA "
  + "demande, ajoutés avec le renvoi pour correction. Resoumettre suppose qu'une personne a corrigé ce que le "
  + "validateur demandait — la fiche est l'endroit où elle le fait ; retirer clôt un circuit, motif à l'appui. "
  + "Adam est en pause de développement (Super Admin seul) : un clic sur la fiche de la demande, panneau du circuit.", [
  "workflow-actions:resoumettreDemande", "workflow-actions:retirerDemandeAdPro",
]);
X("CIRCUIT AD & PRO DU 27/10/2026 — la VALIDATION DU TOTAL par le Directeur Général (au-dessus du seuil, sur la "
  + "somme des postes de toute la demande) et l'APPEL d'une prise en charge ou d'un événement refusé. L'un ouvre la "
  + "porte de l'argent engagé (bons de commande, paiements), l'autre relance un circuit clos, motif à l'appui : deux "
  + "décisions qu'une personne prend devant la fiche. Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert. Un clic sur la fiche de la demande (carte « Validation du Directeur Général », panneau du circuit).", [
  "porte-dg-actions:statuerTotalDg", "workflow-actions:faireAppelAdPro",
]);
X("RÉVISER UN POSTE AD & PRO APRÈS COUP (§118.187, audit R05/R06/R12) — RETIRER ou MODIFIER la demande de bon de "
  + "commande tant qu'aucun ordre n'est parti, ANNULER un ordre émis non réglé pour le réémettre, DEMANDER une révision "
  + "d'un poste accordé. Chacun touche à de l'argent engagé (le visa du centre, l'ordre transmis aux Finances) et exige un "
  + "motif qu'une personne écrit devant la carte du poste ; « Revoir la décision » passe, lui, par `decideAdProItem`, déjà "
  + "couvert. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la demande, "
  + "menu « ⋯ » de la carte du poste.", [
  "ad-pro-item-actions:retirerDemandeBC", "ad-pro-item-actions:modifierDemandeBC",
  "ad-pro-item-actions:annulerOrdrePoste", "ad-pro-item-actions:demanderRevisionPoste",
]);
X("ANNULER SA DEMANDE TANT QU'ELLE N'EST PAS EXÉCUTÉE (audit du 04/10, constats 35 et 37) — retirer la demande de "
  + "devis d'un dossier de matériel promotionnel (le dossier recule à l'étape d'avant), retirer la demande de réservation "
  + "des billets d'un poste (son sujet se clôt). Deux gestes du DEMANDEUR, motif à l'appui, qu'une assistante lira. Adam est "
  + "en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche du dossier, ou sur la carte du poste.", [
  "promo-devis-actions:retirerDemandeDevisPromo",
]);
X("LES PIÈCES D'ACHAT D'UN POSTE (§118.204) — déposer un devis ou une facture pro forma (commun à plusieurs postes), "
  + "le retirer d'un poste où il a été mal placé, et déposer la FACTURE qui demande le paiement. Chacun dépose un "
  + "FICHIER que la personne a sous la main (une carte de confirmation ne transporte pas un fichier), et le dernier "
  + "ouvre un ordre de dépense au centre de paiement. Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert. Un clic sur la carte du poste, fiche de la demande.", [
  "ad-pro-item-actions:ajouterDevisPoste", "ad-pro-item-actions:retirerDevisDuPoste", "ad-pro-item-actions:demanderPaiementPoste",
  // Les voyageurs d'une billetterie (§118.205) : le devis d'un voyageur est un FICHIER, le choix d'une
  // proposition et la demande de BC qui en découle se font devant la carte du poste.
  "ad-pro-item-actions:ajouterDevisVoyageur", "ad-pro-item-actions:validerDevisVoyageur", "ad-pro-item-actions:demanderBCBilletterie",
]);
X("LES LIGNES DES DEVIS D'UN POSTE ET LES BC QU'ELLES FONT GÉNÉRER (§118.206) — lire un devis, saisir ou corriger ses "
  + "lignes, VALIDER celles qu'on commande, GÉNÉRER (ou régénérer) le bon de commande de chaque devis. Une ligne "
  + "validée est un PRIX que la société commande, et la validation atteste qu'une personne l'a comparée au papier "
  + "(§118.15, §118.152 i) : un document lu par Adam est une DONNÉE, jamais la main qui écrit ce qui sera commandé "
  + "(§118.7). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la carte du poste, "
  + "case « Bon de commande » et panneau « Lignes » du devis.", [
  "ad-pro-item-actions:validerLignesDuDevis", "ad-pro-item-actions:enregistrerLignesDuDevis",
  "ad-pro-item-actions:lireLesLignesDuDevis", "ad-pro-item-actions:genererBonDeCommandePoste",
  // L'APERÇU DU BC À VALIDER PAR LE DEMANDEUR (Direction, 10/2026) : « Générer le BC » dépose un brouillon (aucun numéro) ; le demandeur le
  // relit (`apercuBcPoste`), le corrige (`modifierApercuBcPoste`), le retire (`annulerApercuBcPoste`) ou le valide — et seule la validation
  // attribue le numéro NNN/DG/AAAA et envoie aux Finances (`validerEtEnvoyerBcPoste`). Des gestes d'écran, jamais des appels d'Adam.
  "ad-pro-item-actions:apercuBcPoste", "ad-pro-item-actions:modifierApercuBcPoste", "ad-pro-item-actions:annulerApercuBcPoste",
  "ad-pro-item-actions:validerEtEnvoyerBcPoste",
  // L'APERÇU OBLIGATOIRE ET ULTRA COMPLET (Direction, 14/10/2026) : l'aperçu se corrige dans le composeur de pièces, qui en lit les
  // totaux (`previsualiserApercuBcPoste`) et le PDF (`imprimerApercuBcPoste`) à blanc — des lectures d'écran, pas des gestes d'Adam.
  // Le geste « en un clic » qui émettait sans aperçu est retiré : un seul chemin, Générer → aperçu → Valider et envoyer.
  "ad-pro-item-actions:previsualiserApercuBcPoste", "ad-pro-item-actions:imprimerApercuBcPoste",
  // LE BC MODIFIÉ EN NATIF ET LA FACTURE CONTRÔLÉE PAR LUNA (Direction, 06/10) : une révision du Word et du PDF, et un
  // fichier de facture lu puis comparé au(x) BC signé(s) — des gestes devant la carte du poste, pas des appels d'Adam.
  "ad-pro-item-actions:modifierBcDuPoste", "ad-pro-item-actions:deposerFacturePoste",
  // L'APERÇU DU BC MODIFIÉ DE A À Z (Direction, 10/2026) : le composeur montre les totaux de la version à venir, à blanc,
  // sous la porte du poste — une lecture d'écran qui n'écrit rien, pas un geste d'Adam.
  "ad-pro-item-actions:previsualiserBcDuPoste",
  // LA LETTRE DE DEMANDE DE DEVIS (Direction, 07/10) : rédigée par Luna, posée sur le poste — un bouton de l'étape.
  "ad-pro-item-actions:genererDemandeDevisPoste", "promo-devis-actions:regenererDemandeDevisPromo",
  // LE CHAMP « RÉFÉRENCE » DES FORMULAIRES DE GÉNÉRATION (registre commun NNN/DG/AAAA, Direction 10/2026) : lire le prochain numéro
  // de la société (prévu, jamais réservé) et vérifier en direct un numéro saisi — des lectures d'écran, pas des gestes d'Adam.
  "ad-pro-item-actions:referenceDemandeDevisPoste", "promo-devis-actions:referenceDemandeDevisPromo",
  "hr-document-actions:referenceOrdreDeMission", "registre-references-actions:verifierReferenceRegistre",
  // LE « N° DE RÉFÉRENCE » D'UN BC MODIFIABLE (Direction, 14/10/2026) : la vérification en direct du champ du composeur
  // (révision, BC à régénérer, composition hors registre) — une lecture d'écran qui ne réserve rien.
  "fabrique-actions:verifierNumeroPiece",
]);
X("DEMANDER À SON N+1 UN AVIS SUR UN CONGÉ (Direction, 06/10) : le responsable remonte la marche du N+1 à son propre N+1, "
  + "qui la redescend validée ou refusée. Un geste de la ligne « Mon équipe », devant la demande — pas un appel d'Adam.", [
  "hr-actions:demanderAvisN1Conge",
  // LA DISCUSSION D'UN CONGÉ (Direction, 07/10) : le salarié, son N+1 et les RH s'écrivent sous la ligne du congé.
  "conge-discussion-actions:commenterConge",
  // L'ORDRE DE MISSION GÉNÉRÉ par les RH sur le document de la Direction : un formulaire devant la demande du salarié.
  "hr-document-actions:genererOrdreDeMission",
  // LA DISCUSSION ET LES PARTICIPANTS D'UNE DEMANDE DE VALIDATION : des gestes de la fiche de la demande.
  "validation-actions:commenterValidation", "validation-actions:ajouterParticipantsValidation", "validation-actions:retirerParticipantValidation",
  // DÉPLACER UNE DÉPENSE « À IMPUTER » VERS SA SOCIÉTÉ : un geste de l'écran Budgets › Dépenses.
  "budget-envelope-actions:changerSocieteEcriture",
  // PRÉPARER LE DOSSIER D'UN ENVOI DE LA MESSAGERIE : le composeur dépose ensuite les fichiers par la file du Drive.
  "messaging-actions:preparerDepotMessagerie",
  // LES FICHES HÔTELLERIE D'UN POSTE (une par personne) : des gestes de la carte du poste, comme les voyageurs.
  "ad-pro-item-actions:ajouterHebergement", "ad-pro-item-actions:modifierHebergement", "ad-pro-item-actions:retirerHebergement",
  // RANGER LES DOSSIERS REGULATORY DANS LE DRIVE : le rattrapage du Super Admin, un bouton de la page Regulatory.
  "regulatory-drive-actions:synchroniserDriveRegulatory",
  // LA PHARMACOVIGILANCE : le signalement du KAM, l'échange, le statut, l'enquête, les participants — des gestes de la
  // fiche du cas, devant le cas, pas des appels d'Adam (un signalement de sécurité ne se fait pas par délégation).
  "pharmacovigilance-actions:signalerCasPv", "pharmacovigilance-actions:commenterCasPv", "pharmacovigilance-actions:changerStatutCasPv",
  "pharmacovigilance-actions:ouvrirEnquetePv", "pharmacovigilance-actions:ajouterParticipantsPv", "pharmacovigilance-actions:retirerParticipantPv",
  // LES DEMANDES DE STOCKS DO → KAM : créer, saisir par hôpital, relancer, clore, supprimer — des gestes des écrans Stocks.
  "demande-stocks-actions:creerDemandeStocks", "demande-stocks-actions:saisirStocksDemande", "demande-stocks-actions:relancerDemandeStocks",
  "demande-stocks-actions:cloreDemandeStocks", "demande-stocks-actions:supprimerDemandeStocks",
]);
X("OPERATIONS & SALES (Direction, 08/10) — le STOCK PCH CENTRAL saisi depuis le mail de la PCH (quantités par produit, "
  + "collage confirmé à l'écran, mail joint). Un geste d'écran, devant le relevé : Adam est en pause de développement, "
  + "aucun geste neuf ne lui est ouvert.", [
  "stock-pch-actions:enregistrerStockPch",
  // LE RELEVÉ EN FICHIER (Excel / CSV de la PCH) : une LECTURE du fichier déposé à l'écran (rien n'est écrit) — la vérification
  // et l'enregistrement sont le geste d'écran ci-dessus.
  "stock-pch-actions:lireReleveStockPch",
]);
X("COMPLÉMENTS (Direction, 10/2026) — le produit d'une déclaration d'information médicale (corrigé par le pharmacien dans la "
  + "déclaration) et la date de besoin d'une demande de matériel promotionnel (modifiée par le demandeur sur sa demande). "
  + "Des champs d'une fiche, corrigés devant elle : Adam est en pause de développement, aucun geste neuf ne lui est ouvert.", [
  "medical-info-actions:changerProduitDeclaration", "promo-material-actions:modifierDateBesoinPromo",
]);
X("PRISES EN CHARGE — PROFESSIONNELS PROPOSÉS ET LEURS PIÈCES (§118.205) : créer le profil d'un professionnel, "
  + "demander ses pièces (passeport, visa, informations de voyage) et les déposer. Chacun touche à une identité ou "
  + "dépose un FICHIER devant la fiche de la demande. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "care-actions:creerProfilProfessionnel", "care-actions:demanderPiecesPriseEnCharge", "care-actions:deposerPiecePriseEnCharge",
]);
X("PRISES EN CHARGE — PLUSIEURS FICHIERS PAR PIÈCE (Direction, 10/2026) : retirer UN fichier d'une pièce (la page en trop, "
  + "le scan illisible) ; le dernier retiré, la pièce redevient attendue. Un geste fait DEVANT l'aperçu du fichier, sur une "
  + "pièce d'identité. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "care-actions:retirerFichierPiecePriseEnCharge",
]);
X("PRISES EN CHARGE — FICHES VOYAGEUR (Direction, 10/2026) : enregistrer un poste de la fiche (billet, hôtel, autre poste, "
  + "montant en dollars à l'international), déposer le billet émis ou la confirmation d'hôtel, retenir un devis, demander "
  + "la réservation et le BC à l'assistante de direction, gérer les postes de groupe. Des gestes faits DEVANT la fiche "
  + "(fichiers, horaires, choix d'une proposition), ou qui ouvrent un sujet chez l'assistante. Adam est en pause de "
  + "développement : aucun geste neuf ne lui est ouvert.", [
  "care-actions:modifierPosteFiche", "care-actions:enregistrerBilletEmis", "care-actions:retenirDevisPriseEnCharge",
  "care-actions:demanderBCPriseEnCharge",
  "care-actions:ajouterPosteGroupe", "care-actions:modifierPosteGroupe", "care-actions:retirerPosteGroupe",
]);
X("LES FICHES DE VOYAGE CHEZ L'ASSISTANTE DE DIRECTION (Direction, 14/10/2026) — côté demandeur : envoyer UNE fiche "
  + "(billet ou hôtel) ou « les fiches prêtes » (chacune séparément), relancer (une fois par 24 h), retirer ; côté "
  + "assistante, dans l'onglet « Ad & Pro » du Bureau du secrétariat : prendre la fiche, signaler un manque, joindre "
  + "le devis de l'agence (par le circuit devis existant du poste) et déposer le billet ou la confirmation d'hôtel "
  + "(des FICHIERS, après l'accord du poste). Des gestes faits DEVANT la fiche, qui engagent le travail d'une personne "
  + "ou portent une pièce. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "reservation-fiche-actions:envoyerFiche", "reservation-fiche-actions:envoyerFichesPretes",
  "reservation-fiche-actions:relancerFiche", "reservation-fiche-actions:retirerFiche",
  "reservation-fiche-actions:prendreFiche", "reservation-fiche-actions:signalerManque",
  "reservation-fiche-actions:joindreDevisAgence", "reservation-fiche-actions:deposerBillet",
]);
X("ANNULER SA DEMANDE TANT QU'ELLE N'EST PAS EXÉCUTÉE (décision du 04/10) — rallonges de budget et de caisse, "
  + "document RH, ordre de mission, tâche demandée, formation. Des gestes qui RÉDUISENT, mais Adam est en pause de "
  + "développement : aucun geste neuf ne lui est ouvert. Un clic du demandeur sur sa demande.", [
  "department-budget-actions:annulerDemandeBudgetDepartement", "hr-document-actions:annulerDemandeRh",
  "mission-actions:retirerDemandeOrdreMission", "petty-cash-actions:annulerRallongeCaisse",
  "task-actions:annulerDemandeTache", "training-actions:annulerFormation",
]);
X("RENVOYER, RÉEXAMINER, RESOUMETTRE DANS LES CENTRES (§118.188, audit R07/R08/R10) — resoumettre une demande de "
  + "validation renvoyée pour correction (sur elle-même, elle reprend à l'étape qui l'a renvoyée), resoumettre au centre "
  + "Ad & Pro une demande qu'il a renvoyée, et réexaminer un refus du centre. Les deux premiers sont des gestes du "
  + "DEMANDEUR qui dit ce qu'il a corrigé ; le troisième rouvre une décision d'arbitrage, motif à l'appui, par un siège "
  + "du centre. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la "
  + "demande (validations, consulting, autre demande) ou sur le centre de validation Ad & Pro.", [
  "validation-actions:resoumettreValidation",
  "ad-pro-centre-actions:resoumettreAuCentreAdPro", "ad-pro-centre-actions:reexaminerVisaCentreAdPro",
]);
X("BUDGET MARKETING — LA DÉPENSE D'UN POSTE AD & PRO (onglet « Dépenses », maquette validée 10/2026) : imputer un poste "
  + "aux BC signés (il devient engagé), changer son budget à tout moment (le poste, ses ordres et ses écritures suivent), "
  + "le consommer (montant ≤ l'engagé, facture facultative : un ordre de dépense naît au centre de paiement) ou l'annuler. "
  + "Chaque geste engage le budget et passe par une seconde confirmation à l'écran, qui dit ce qui va se passer. Adam est "
  + "en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "budget-depense-poste-actions:imputerDepensePoste",
  "budget-depense-poste-actions:changerBudgetDepensePoste",
  "budget-depense-poste-actions:consommerDepensePoste",
  "budget-depense-poste-actions:annulerDepensePoste",
]);
X("BUDGET MARKETING — IMPUTER UN MATÉRIEL PROMOTIONNEL (Direction, 27/10 — point 21) : la Direction Marketing choisit la "
  + "catégorie du Budget Marketing qui porte le dossier ; ses BC signés y comptent en engagé, ses ordres fournisseur en "
  + "consommé, et les ordres déjà nés suivent. Le geste engage le budget et passe par une seconde confirmation à l'écran. "
  + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "promo-budget-actions:imputerBudgetMaterielPromo",
]);
X("DEMANDER LA VALIDATION FINALE D'UN BON DE COMMANDE PRÉ-VALIDÉ (Demandes de validations, 10/2026) — le geste du "
  + "DEMANDEUR une fois que tous ses validateurs ont accepté : la retenue du BC tombe et l'aiguillage ordinaire l'adresse "
  + "à son centre de validation, puis à la signature. Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert. Un clic, confirmé, sur la carte de la demande.", [
  "validation-actions:demanderValidationFinaleBC",
]);
X("REFUSER LA VALIDATION FINALE D'UNE DÉCLARATION D'INFORMATION MÉDICALE (Direction, 10/2026) — le geste du Directeur "
  + "des Opérations (à défaut, du Super Admin), motif EXIGÉ : le dossier revient au pharmacien avec le motif. Adam est en "
  + "pause de développement : aucun geste neuf ne lui est ouvert. Un formulaire sur la fiche de la déclaration.", [
  "medical-info-actions:refuseDeclarationByDirection",
]);
X("BUDGET MARKETING — L'INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 (maquette validée, 10/2026) : lire le fichier "
  + "« Dépenses AP » et proposer les demandes existantes, calculer le budget avant → après, VALIDER (écriture d'un bloc de "
  + "30 demandes, double confirmation : case cochée et mot « INTÉGRER »), ANNULER d'un bloc (motif, mot « ANNULER »), "
  + "garder ou sortir du budget un élément « absent du fichier », joindre des pièces (plusieurs fichiers, lus par Luna) ou "
  + "rattacher une pièce déjà dans la plateforme, relier (en lecture seule) l'écriture de trésorerie qui a payé la dépense. Des gestes d'écran : ils portent un FICHIER que le navigateur envoie, "
  + "et les plus lourds réécrivent le budget d'une enveloppe devant l'aperçu qui en montre l'effet — gestionnaire de "
  + "l'enveloppe ou Super Admin. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "integration-adpro-actions:lireFichierIntegrationAdPro", "integration-adpro-actions:apercuIntegrationAdPro",
  "integration-adpro-actions:validerIntegrationAdPro", "integration-adpro-actions:annulerIntegrationAdPro",
  "integration-adpro-actions:deciderAbsenteIntegration", "integration-adpro-actions:joindrePiecesIntegration",
  "integration-adpro-actions:rattacherPieceIntegration", "integration-adpro-actions:relierEcritureIntegration",
  // LIRE la fiche « Historique 2026 » d'une demande pour le panneau latéral des onglets Demandes Ad & Pro et
  // Intégration 2026 (maquette « onglets », 10/2026) : une lecture d'écran, gardée par l'enveloppe du lot.
  "integration-adpro-actions:ficheHistoriqueIntegration",
]);
X("BUDGET MARKETING — LE RAPPROCHEMENT AD & PRO ASSISTÉ PAR LUNA (Direction, 14/10/2026) : lire par tranches les pièces "
  + "de la plateforme (Luna, une fois par empreinte), accepter / refuser une proposition de rattachement d'une dépense hors "
  + "poste ou d'une pièce à une demande intégrée, choisir une autre demande, signaler « pas Ad & Pro », accepter toutes "
  + "les propositions certaines (confirmation exigée), annuler une décision. Des gestes d'écran qui changent ce que compte "
  + "le budget d'une enveloppe et les pièces d'une demande, devant les propositions et leurs justifications — gestionnaire "
  + "de l'enveloppe ou Super Admin. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "rapprochement-adpro-actions:lireTranchePiecesRapprochement", "rapprochement-adpro-actions:deciderRapprochement",
  "rapprochement-adpro-actions:accepterRapprochementsCertains", "rapprochement-adpro-actions:annulerDecisionRapprochement",
]);
X("DEVIS NATIFS → BON DE COMMANDE AU BUREAU DU SECRÉTARIAT (Direction, 10/2026, « comme dans Ad & Pro ») — l'assistante "
  + "dépose et RETRANSCRIT le devis ligne à ligne devant le papier ; le DEMANDEUR coche les lignes qu'il retient, puis génère "
  + "(fabrique, sous délégation de la demande) ou dépose le BC, qui part au centre de validations puis à la signature. Des "
  + "gestes d'écran qui attestent un papier ou engagent la société ; Adam est en pause de développement : aucun geste neuf "
  + "ne lui est ouvert. « Relancer » est un clic sur la fiche, une fois par jour.", [
  "secretariat-devis-actions:deposerDevisDemande", "secretariat-devis-actions:enregistrerLignesDevisDemande",
  "secretariat-devis-actions:retenirLignesDevisDemande", "secretariat-devis-actions:genererBonDeCommandeDemande",
  "secretariat-devis-actions:deposerBonDeCommandeDemande", "secretariat-devis-actions:relancerDemande",
  // L'APERÇU OBLIGATOIRE DU BC (Direction, 14/10/2026) : le composeur s'ouvre pré-rempli (`ouvrirApercuBcDemande`), en lit les
  // totaux et le PDF à blanc — rien n'est écrit avant « Valider et envoyer » (`genererBonDeCommandeDemande`). Lectures d'écran.
  "secretariat-devis-actions:ouvrirApercuBcDemande", "secretariat-devis-actions:previsualiserApercuBcDemande",
  "secretariat-devis-actions:imprimerApercuBcDemande",
]);
X("DIRECTION ARTISTIQUE (Transverse, 10/2026) — déposer un modèle Word/Excel/PowerPoint POUR UNE ENTITÉ, désigner son "
  + "papier en-tête par défaut et le modèle de chaque nature de pièce (bon de commande, devis, facture, avoir) que la "
  + "fabrique applique. Geste de l'assistante de direction (ou de qui tient le module), sur un FICHIER choisi à l'écran. "
  + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "direction-artistique-actions:televerserModele",
  "direction-artistique-actions:definirPapierParDefaut",
  "direction-artistique-actions:definirModeleDePiece",
  "direction-artistique-actions:televerserModeleDePiece",
]);
X("GÉNÉRER L'ATTESTATION DE TRAVAIL D'UNE DEMANDE RH (Direction, 10/2026) — comme l'ordre de mission : le formulaire des "
  + "RH s'ouvre prérempli (fiche RH, puis le contrat de travail lu par Luna — ou, IA fermée, par la lecture déterministe), "
  + "les RH relisent chaque champ et choisissent le signataire en fin de formulaire ; la plateforme remplit le modèle sur "
  + "papier à en-tête, attribue la référence au registre NNN/DG/AAAA et remet le PDF au salarié (régénérer = une nouvelle "
  + "version). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un formulaire devant la demande.", [
  "hr-document-actions:preparerAttestationDeTravail", "hr-document-actions:genererAttestationDeTravail",
]);
X("RÉGLER LE SEUIL DES BONS DE COMMANDE HORS AD & PRO (Direction, 10/2026) — depuis le centre de validations, par ses "
  + "sièges (DG, Super Admin) ; le centre Ad & Pro garde le sien. Le changement réaiguille les BC en vol de ce centre. "
  + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un formulaire sur l'écran du centre.", [
  "settings-actions:setBcValidationThresholdCentre",
]);
X("RESOUMETTRE UNE « AUTRE DEMANDE » REFUSÉE ET PROLONGER UN CONTRAT DE CONSULTING (audit 360°, lot C4a) — la "
  + "resoumission est le geste du DEMANDEUR qui dit ce qui a changé depuis le refus (elle peut corriger la description "
  + "et le montant, que le centre Ad & Pro relit) ; la prolongation engage la société sur un terme plus long et "
  + "revient à qui peut valider le contrat, avec ce qui la fonde (l'avenant). Adam est en pause de développement : "
  + "aucun geste neuf ne lui est ouvert. Un clic sur la fiche de la demande ou du contrat.", [
  "ad-pro-other-actions:resoumettreAdProOtherRequest",
  "consulting-actions:prolongerConsultingContract",
]);
X("RENVOYER, RESOUMETTRE, REDEMANDER — LE MATÉRIEL PROMOTIONNEL SE CORRIGE (audit 360°, lot C4b, §118.190). RENVOYER un "
  + "dossier pour correction est une issue de VALIDATION, au même titre que valider et refuser : elle se tranche par la "
  + "personne que l'étape désigne, devant le dossier ; RESOUMETTRE la demande corrigée et REDEMANDER des devis sont des "
  + "gestes du DEMANDEUR qui disent ce qui a changé ou ce qu'il cherche ; CORRIGER UN COMPTAGE est l'attestation de celui "
  + "qui a compté, comme sa saisie (§118.15). Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
  + "Un clic sur /promo-material/<id> ou sur Sales & Marketing › Stock promotionnel, onglet « Comptages ».", [
  "promo-circuit-actions:renvoyerPromoStep", "promo-circuit-actions:resoumettrePromoDemande",
  "promo-devis-actions:redemanderDevisPromo", "promo-comptage-actions:corrigerComptage",
]);
X("RANGER UN DEVIS DÉPOSÉ COMME DEVIS D'UNE AGENCE (§118.204) — un fichier « devis » posé sur une demande de matériel "
  + "promotionnel devient un devis du circuit, rattaché à l'agence que la personne choisit dans l'annuaire. C'est un geste "
  + "de RETRANSCRIPTION (l'assistante de direction, ou la Direction), devant le fichier : dire à qui appartient un devis "
  + "engage le bon de commande qui en sortira. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
  + "Un clic sur /promo-material/<id> › carte « Devis » › « Ranger comme devis de cette agence ».", [
  "promo-devis-actions:rangerDevisPromo",
]);
X("CORRIGER SA DEMANDE DE PAIEMENT (audit 360°, lot C4c, §118.191) — l'objet, le bénéficiaire, le montant, le "
  + "contexte et l'échéance, tant que le dossier est chez le demandeur (brouillon, ou renvoyé par les Finances). C'est le "
  + "geste du DEMANDEUR, qui dit après transmission ce qui a changé ; il fait suivre l'ordre de dépense et peut rouvrir "
  + "l'autorisation du centre de paiement. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un "
  + "clic sur /validations/paiements/<id> › « Corriger la demande ».", [
  "payment-request-actions:corrigerDemandePaiement",
]);
X("SUPPRIMER DÉFINITIVEMENT SA DEMANDE DE PAIEMENT (Direction, 19/10/2026) — retirée ou restée brouillon, elle part en "
  + "lot avec son ordre de dépense annulé, ses pièces et son fil, restaurable depuis la corbeille. Le geste du DEMANDEUR (ou "
  + "du Super Admin), décidé devant la fenêtre qui montre ce qui part avec. Adam est en pause de développement : aucun "
  + "geste neuf ne lui est ouvert.", [
  "payment-request-actions:supprimerDemandePaiement",
]);
X("ROUVRIR ET ANNULER UNE DEMANDE AU SECRÉTARIAT (audit 360°, lot C4c, §118.191) — les gestes nommés qui remplacent le "
  + "menu de statut libre : rouvrir une demande TERMINÉE avec son motif, annuler une demande par l'annulation commune (qui "
  + "retire aussi la validation, l'approbation et le paiement en attente). Ce sont des gestes du SECRÉTARIAT qui disent "
  + "pourquoi au demandeur. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
  + "/demandes/<id> › « Rouvrir… » ou « Annuler la demande… ».", [
  "admin-request-actions:rouvrirDemande", "admin-request-actions:annulerDemandeAuSecretariat",
]);
X("RENVOYER, CORRIGER, ROUVRIR UN RECRUTEMENT, ANNULER UNE EMBAUCHE (audit 360°, lot C4d1, §118.192) — renvoyer une "
  + "demande pour correction (qui peut trancher la marche, ou les RH), la corriger et la renvoyer (son demandeur, qui dit "
  + "ce qui a changé ; une correction matérielle fait repartir la chaîne), rouvrir une demande refusée ou close sans "
  + "recrutement (les RH ou le sommet, motif à l'appui), annuler une embauche avant sa fiche employé. Ce sont des "
  + "DÉCISIONS sur un engagement pluriannuel et des données personnelles, prises par une personne qui dit pourquoi. Adam "
  + "est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur /recrutement/<id>.", [
  "recruitment-actions:renvoyerDemandeRecrutement", "recruitment-actions:resoumettreDemandeRecrutement",
  "recruitment-actions:rouvrirDemandeRecrutement", "recruitment-actions:annulerEmbaucheRecrutement",
]);
X("LA DIFFUSION D'UNE OFFRE ET LE FIL D'UN RECRUTEMENT (Direction, 07/10) — préparer le post LinkedIn (Luna, selon "
  + "l'entité), en modifier le texte, le marquer publié ou retiré, publier ou retirer l'offre du site depuis la fiche, "
  + "l'envoyer à Emploitic (quand l'API sera configurée), écrire au fil de la demande. Publier une offre engage "
  + "l'entreprise auprès de candidats : c'est un clic des RH, devant la carte « Diffusion » ; un message au fil est "
  + "écrit par une personne. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
  + "/recrutement/<id>.", [
  "recrutement-diffusion-actions:preparerPostLinkedIn", "recrutement-diffusion-actions:enregistrerTexteCanal",
  "recrutement-diffusion-actions:marquerCanalPublie", "recrutement-diffusion-actions:retirerCanal",
  "recrutement-diffusion-actions:publierOffreSiteDuRecrutement", "recrutement-diffusion-actions:envoyerOffreEmploitic",
  "recruitment-actions:commenterDemandeRecrutement",
]);
X("RÉTABLIR UN DOCUMENT LEGAL ANNULÉ (§118.184, audit L04) : le retour d'une annulation, ajouté parce que "
  + "l'annulation n'en avait aucun. C'est un geste de correction qu'une personne fait devant la ligne qu'elle "
  + "vient d'annuler par erreur ; Adam est en pause de développement (Super Admin seul) et l'annulation qu'il "
  + "couvre reste celle de l'écran. Un clic sur Legal › la ligne annulée › Rétablir.", [
  "legal-actions:restoreLegalDocument",
]);
X("LE STOCK PROMOTIONNEL (§118.164) : chaque geste ATTESTE un fait physique — « je l'ai reçu » (confirmer "
  + "une réception), « je l'ai remis » (doter, transférer, rendre), « je l'ai perdu », « je l'ai compté » "
  + "(inventaire d'ouverture, correction), « il est entré au magasin ». Un modèle ne voit ni le magasin ni la "
  + "voiture d'un délégué : lui confier ces gestes ferait porter au nom d'une personne un stock qu'elle n'a "
  + "jamais vu, et une confirmation de réception est précisément ce qu'un document injecté demanderait (§118.15). "
  + "Adam est de plus en pause de développement. Un clic sur Sales & Marketing › Stock promotionnel.", [
  "promo-stock-actions:entrerEnStock", "promo-stock-actions:poserInventaireOuverture",
  "promo-stock-actions:declarerSupportNumerique", "promo-stock-actions:modifierArticleStock",
  "promo-stock-actions:modifierLot", "promo-stock-actions:doter", "promo-stock-actions:transferer",
  "promo-stock-actions:confirmerReception", "promo-stock-actions:refuserReception",
  "promo-stock-actions:annulerTransfert", "promo-stock-actions:declarerPerte",
  "promo-stock-actions:corrigerInventaire", "promo-stock-actions:annulerMouvement",
  "promo-stock-actions:demanderMateriel", "promo-stock-actions:servirDemande",
  "promo-stock-actions:refuserDemande", "promo-stock-actions:annulerDemande",
]);
X("LES MISSIONS AD & PRO RELIÉES AU PROFIL (Direction, 10/2026) — confirmer ou décliner une invitation, ajouter ses "
  + "étapes, demander son transport, son hébergement, son matériel ou déposer sa note de frais depuis « Mes missions », "
  + "valider comme N+1 l'ordre de mission d'un membre de son équipe, relancer, remplacer, modifier les dates, intégrer "
  + "À LA MAIN les frais de l'équipe au budget de la demande. Chacun de ces gestes engage une PERSONNE (sa présence, sa "
  + "signature de N+1, un montant exact qu'elle a lu sur une facture) : un modèle ne les pose pas à sa place, et Adam est "
  + "en pause de développement. Un clic sur Mon espace › Mes missions, ou sur la carte « Équipe Adventum » de la demande.", [
  "mission-actions:repondreMission", "mission-actions:relancerMission", "mission-actions:remplacerMission",
  "mission-actions:modifierMission", "mission-actions:ajouterEtapeMission", "mission-actions:retirerEtapeMission",
  "mission-actions:deciderOrdreMissionN1", "mission-actions:demanderLogistiqueMission",
  "mission-actions:demanderMaterielMission", "mission-actions:deposerNoteFraisMission",
  "mission-actions:integrerFraisEquipe",
]);
X("LA DEMANDE DE PARTICIPATION ET LA MISSION D'UN MEMBRE DE L'ÉQUIPE ADVENTUM (Direction, 10/2026) — envoyer sa fiche, "
  + "contre-proposer, accepter ou refuser une version, déposer le billet émis ou la confirmation d'hôtel, choisir "
  + "l'imputation des frais (Direction Marketing), saisir ses dépenses et leurs justificatifs, rédiger le rapport, clôturer "
  + "la mission. Chacun engage une PERSONNE — sa présence et ses dates, la parole d'Adventum dans une négociation, un "
  + "billet réellement émis, une ligne budgétaire, une dépense et son justificatif lus sur un reçu — et la clôture fait "
  + "partir une note de frais au N+1 puis aux RH : un modèle ne les pose pas à sa place, et Adam est en pause de "
  + "développement. Un clic sur Mon espace › Missions › la mission, ou sur la carte « Équipe Adventum » de la demande.", [
  "mission-actions:proposerParticipation", "mission-actions:deciderParticipation",
  "mission-actions:enregistrerBilletMission", "mission-actions:enregistrerHotelMission",
  "mission-actions:choisirBudgetMission", "mission-actions:ajouterFraisMission",
  "mission-actions:joindreJustificatifFrais", "mission-actions:retirerFraisMission",
  "mission-actions:enregistrerRapportMission", "mission-actions:cloturerMission",
]);
X("LE CATALOGUE PROMOTIONNEL (§118.164) : la liste de RÉFÉRENCE que citent les stocks et les demandes "
  + "d'achat — ses références CAT-NNNN sont fixes, et le Super Admin choisit nommément qui la lit et qui l'écrit "
  + "(Administration › Accès). La tenir est une décision d'organisation, pas une demande de conversation ; et Adam "
  + "est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur Sales & Marketing › Stock promotionnel › Catalogue.", [
  "promo-catalogue-actions:creerArticleCatalogue", "promo-catalogue-actions:modifierArticleCatalogue",
  "promo-catalogue-actions:archiverArticleCatalogue",
]);
X("LES ACHATS DU MATÉRIEL PROMOTIONNEL (§118.165) — la RÉCEPTION d'une ligne de facture, son annulation, et "
  + "l'annulation d'une facture. Cocher « reçu » est une ATTESTATION : c'est elle qui fait entrer des unités au "
  + "magasin central et qui ouvre le paiement, et l'audit porte le nom du demandeur. Un modèle ne voit pas le carton "
  + "arriver ; une facture ou un mail lu par une étape peut contenir « tout est arrivé », et rien ne distinguerait plus "
  + "la réception forgée de la vraie — le stock compterait ce que personne n'a vu, et le paiement partirait (§118.15). "
  + "Annuler une facture ou une réception défait ce qu'une personne a attesté : même raison. Un clic du demandeur sur "
  + "/promo-material/<id>, facture en tableau sous les yeux.", [
  "promo-execution-actions:receptionnerLigneFacturePromo", "promo-execution-actions:annulerReceptionLigneFacturePromo",
  "promo-execution-actions:annulerFacturePromo",
]);
X("LA DEMANDE D'ACHAT DU MATÉRIEL PROMOTIONNEL (§118.165) se compose en PIOCHANT dans le catalogue : l'article, ses "
  + "produits, la quantité, ce qu'on attend du fournisseur. C'est ce que l'assistante fera chiffrer, mot pour mot. "
  + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic du demandeur sur "
  + "/promo-material/<id>, carte « Articles demandés ».", [
  "promo-demande-actions:enregistrerArticleDemandePromo", "promo-demande-actions:retirerArticleDemandePromo",
  // « AUTRE ARTICLE » PROPOSÉ AU CATALOGUE (Direction, 10/2026) : ajouté d'un clic par qui tient le catalogue, sinon ses
  // gestionnaires sont prévenus — un geste du demandeur devant sa demande, jamais un appel d'Adam.
  "promo-demande-actions:proposerArticleAuCataloguePromo",
]);
X("L'APERÇU DU BC D'UN DOSSIER DE MATÉRIEL PROMOTIONNEL, À VALIDER PAR LE DEMANDEUR (Direction, 10/2026) : la génération "
  + "(automatique à la dernière validation, ou le geste de repli) dépose un aperçu SANS numéro ; on le relit "
  + "(`apercuBcPromo`), on le corrige (`modifierApercuBcPromo`), on le retire (`annulerApercuBcPromo`) — et seule la "
  + "validation du demandeur (ou du Super Admin) attribue le numéro NNN/DG/AAAA et envoie le BC aux Finances "
  + "(`validerEtEnvoyerBcPromo`). Engager la société se décide devant le PDF, pas dans une conversation. RELANCER "
  + "(`relancerPromo`) prévient la personne attendue, une fois par jour : un geste de la fiche, pas d'Adam. "
  + "Un clic sur /promo-material/<id>.", [
  "promo-execution-actions:apercuBcPromo", "promo-execution-actions:modifierApercuBcPromo",
  "promo-execution-actions:annulerApercuBcPromo", "promo-execution-actions:validerEtEnvoyerBcPromo",
  "promo-circuit-actions:relancerPromo",
]);
X("LE MATÉRIEL DU STOCK D'UN POSTE AD & PRO (§118.167) — lister les articles du magasin qu'un événement emporte, et "
  + "CONFIRMER après l'événement ce qui a été remis, rendu, abîmé ou perdu. La confirmation est une ATTESTATION : elle fait "
  + "rentrer le reste au magasin, sort définitivement le remis du registre, et l'audit porte le nom de qui l'a dite. Un "
  + "modèle n'était pas sur le stand ; un compte rendu lu par une étape peut écrire « tout a été distribué », et rien ne "
  + "distinguerait plus la confirmation forgée de la vraie — le magasin perdrait des kakémonos qui sont rentrés (§118.15). "
  + "Lister reste une décision du demandeur, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. "
  + "Un clic sur la fiche de la demande, bloc « Matériel pris au magasin ».", [
  "ad-pro-item-actions:ajouterArticleStockAuPoste", "ad-pro-item-actions:confirmerMaterielStock",
]);
X("LES POSTES D'UNE DEMANDE AD & PRO, SIMPLIFIÉS (§118.175) — RÉPARTIR un sponsoring indirect par nature (« 400 000 en "
  + "imprimerie, 600 000 en hôtellerie ») et tenir les VOYAGEURS d'un poste de billetterie (nom, trajet, dates, passeport), "
  + "puis en DEMANDER la réservation à l'assistante de direction, qui reçoit un sujet. Répartir est la décision du demandeur "
  + "sur sa propre dépense ; un voyageur porte des données personnelles et une pièce d'identité qui se dépose en FICHIER ; "
  + "la réservation engage le travail d'une personne. Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert. Un clic sur la fiche de la demande, carte du poste (« Répartir par nature », bloc « Voyageurs »).", [
  "ad-pro-item-actions:repartirPoste", "ad-pro-item-actions:ajouterVoyageur", "ad-pro-item-actions:modifierVoyageur",
  "ad-pro-item-actions:retirerVoyageur",
]);
X("SUPPRIMER UNE SÉLECTION D'ÉCRITURES « À IMPUTER » (§118.176) — le geste du Super Admin sur la liste des Budgets, "
  + "« une ou plusieurs ». Adam supprime déjà une écriture par `delete_record`, qui passe par le même cœur réversible ; une "
  + "SÉLECTION se fait devant la liste, avec l'aperçu de ce que chaque écriture laisse sans lien (la facture qu'elle règle, "
  + "l'ordre de dépense, la dotation de caisse, §118.53). Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert. Un clic sur Budgets › Dépenses, « Supprimer la sélection ».", [
  "admin-delete-actions:superAdminDeleteMany", "admin-delete-actions:apercuSuppressionGroupee",
]);
X("SUPPRIMER UNE DEMANDE AD & PRO depuis sa fiche — la porte ouverte au directeur des opérations et à la directrice "
  + "marketing (§118.175), à côté de celle du Super Admin. Adam n'est visible que du Super Admin (§118.153), qui supprime "
  + "déjà par `delete_record` ; offrir cette seconde porte à Adam ne servirait personne. Et le geste se fait devant son "
  + "APERÇU — ce qui part avec la demande, ce qui perd son lien (§118.53, §118.162). Un clic sur la fiche, « Supprimer la "
  + "demande ».", [
  "admin-delete-actions:supprimerDemandeAdPro",
]);
X("SUPPRIMER UNE PIÈCE LEGAL, OU L'UN DE SES FICHIERS, depuis la fiche de la demande Ad & Pro (§118.209) — « on doit pouvoir "
  + "supprimer les documents dans les demandes ». Adam n'est visible que du Super Admin (§118.153), qui supprime déjà une pièce "
  + "par `delete_record` (même cœur réversible, même refus de ce qui engage la pièce) ; offrir une seconde porte à Adam ne "
  + "servirait personne. Et le geste se fait devant l'APERÇU de ce qui part (fichiers, commentaires, lecteurs) et sous un "
  + "double geste — retirer un devis, un bon de commande ou une facture du registre n'est pas un rangement qu'un modèle décide "
  + "d'après un document lu (§118.7). Un clic sur la fiche de la demande, bloc « Pièces Legal de la demande » ou « Pièces liées ».", [
  "ad-pro-pieces-actions:supprimerPieceDeLaDemande", "ad-pro-pieces-actions:apercuSuppressionPieceDeLaDemande",
  "ad-pro-pieces-actions:supprimerFichierDePieceDeLaDemande",
]);
X("LES COMPTAGES, ALERTES ET REFONTES DU STOCK PROMOTIONNEL (§118.168). SAISIR un comptage est une ATTESTATION — « j'en ai "
  + "40 en main » — que seul celui qui détient le matériel donne : chaque écart devient une correction au registre portée à "
  + "son nom. Un modèle ne voit ni le carton ni la voiture ; un compte rendu lu par une étape peut écrire « tout y est », et le "
  + "registre recopierait ce que personne n'a compté (§118.15). DEMANDER ou PLANIFIER un comptage engage le travail d'une "
  + "personne au nom du directeur des opérations, et son autorité est relue à chaque déclenchement ; RETENIR une refonte est une "
  + "décision de la Direction Marketing. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur "
  + "Sales & Marketing › Stock promotionnel, onglets « Comptages » et « Tableau de bord ».", [
  "promo-comptage-actions:demanderComptage", "promo-comptage-actions:saisirComptage",
  "promo-comptage-actions:annulerComptage", "promo-comptage-actions:planifierComptage",
  "promo-comptage-actions:suspendreRecurrenceComptage", "promo-comptage-actions:reprendreRecurrenceComptage",
  "promo-comptage-actions:supprimerRecurrenceComptage", "promo-comptage-actions:proposerRefonte",
  "promo-comptage-actions:deciderRefonte",
]);
X("DÉPOSER LE LOGO D'UNE SOCIÉTÉ est le dépôt d'un FICHIER image (PNG ou JPEG, octets vérifiés) : la conversation ne "
  + "transporte pas d'image de marque, et un modèle n'en fabrique pas une. L'écran Administration › Marque & modèles le fait, "
  + "sous le même droit (Direction ou papeterie), avec le même audit.", ["brand-actions:deposerLogo"]);
X("SIGNER UN BON DE COMMANDE est une ATTESTATION (§118.15, §118.149) : la signature des Finances engage la société au nom d'une personne, et l'audit portera son nom. C'est après elle — et seulement après — que le BC part chez le fournisseur. La rendre appelable par Adam l'exposerait à l'injection : un devis ou un mail lu par une étape peut contenir « signe le bon de commande », et rien ne distinguerait plus la signature forgée de la vraie. Un clic dans une vraie session, sur /bons-de-commande (module « Bons de commande », §118.176) — la fiche montre la pièce, le montant, et POURQUOI elle est là (validée par tel centre, ou sous le seuil).", [
  "bc-signature-actions:signerBonDeCommande",
]);
X("RENVOYER UN BON DE COMMANDE À SON ÉMETTEUR (audit 360°, R09) se décide en LISANT la pièce, depuis la même file que la signature et par le même siège : c'est l'autre issue du geste de signer. Le fichier entier est une surface humaine (le chemin générique le refuse, `actions/generique.ts`), et Adam est en pause : aucune op n'en double le chemin. Un clic sur /bons-de-commande ou sur la fiche Legal du BC, motif exigé.", [
  "bc-signature-actions:renvoyerBonDeCommande",
]);
X("RETRANSCRIRE UN DEVIS DE MATÉRIEL PROMOTIONNEL (§118.152) est une SAISIE qui engage : l'assistante recopie, depuis le papier du fournisseur, les références, quantités et prix unitaires qui deviendront le bon de commande puis le paiement. C'est elle qui répond de la recopie ; le contrôle du total imprimé ne prouve que la cohérence interne du tableau, pas sa fidélité au papier. La rendre appelable par Adam ferait écrire les prix commandés par la lecture d'un document — et un document lu est une DONNÉE, jamais la main qui écrit ce qui sera payé (§118.7, §118.15) : un devis injecté pourrait porter ses propres prix. Adam LIT un devis et signale un écart ; il demande les devis, retire un devis, clôt la retranscription et demande une correction (promo_operation). Un clic de l'assistante sur /promo-material/<id>, avec le scan du devis.", [
  "promo-devis-actions:enregistrerDevisPromo",
]);
X("LIRE LE SCAN D'UN DEVIS DE MATÉRIEL PROMOTIONNEL (lot D2-E) PROPOSE ce que l'assistante aurait recopié — fournisseur, lignes, TVA, total imprimé — et n'écrit RIEN : la retranscription reste un geste d'écran (§118.152 i), et la proposition ne devient un devis qu'à travers `enregistrerDevisPromo`, ligne par ligne cochée devant le papier. La lecture sert cette saisie et n'a pas d'autre objet ; Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic de l'assistante sur /promo-material/<id>, en choisissant le scan dans l'éditeur du devis.", [
  "promo-devis-actions:lireScanDevisPromo",
]);
X("LIRE LA FACTURE D'UN BON DE COMMANDE PROMOTIONNEL (lot D2-F) PROPOSE les lignes facturées rapprochées des lignes du BC, la référence et le total imprimé, et n'écrit RIEN : le dépôt reste un geste d'écran (`deposerFacturePromo`), chaque ligne lue cochée « vérifiée » devant le papier avant d'être enregistrée. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur /promo-material/<id>, dans « Déposer la facture ».", [
  "promo-execution-actions:lireFacturePromo",
]);
X("LIRE LA PIÈCE D'UN NOUVEAU DOCUMENT LEGAL (ou d'une nouvelle facture) PROPOSE ce que le formulaire « Nouveau document » / « Nouvelle facture » montrera, et n'écrit RIEN : la déclaration reste un geste d'écran, champ par champ vérifié devant la pièce. La lecture sert cette saisie et n'a pas d'autre objet ; Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic sur /legal, dans « Nouveau document » ou « Nouvelle facture ».", [
  "legal-lecture-actions:lireDocumentLegalPourSaisie",
]);
X("LUNA CONSEILLE OÙ RANGER UNE PIÈCE déposée sur une demande Ad & Pro : un avis CONSULTATIF, qui n'écrit rien et ne déplace aucune pièce — la carte de confirmation d'Adam n'aurait aucun objet à confirmer. Le conseil se lit à l'écran, sous la pièce qu'on vient de déposer ; c'est la personne qui range. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "ad-pro-conseil-actions:conseillerPiece",
]);
X("LUNA PROPOSE LES POSTES D'UNE DEMANDE à partir de sa description (salle, repas, hôtellerie, billetterie et leurs fiches) : une PROPOSITION qui n'écrit rien — la personne la reprend à l'écran, et les postes se créent par l'action ordinaire d'ajout (`addAdProItem`). La carte de confirmation d'Adam n'aurait aucun objet à confirmer. Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "ad-pro-postes-luna-actions:proposerPostesDepuisDescription",
]);
X("MOYENS GÉNÉRAUX › NATURE DES DÉPENSES (Direction, 10/2026) : l'IA PROPOSE la catégorie de chaque article pendant la saisie "
  + "(rien ne s'écrit — la personne la voit et la change dans le formulaire), et le Super Admin range d'un clic l'existant "
  + "resté « Non classé » depuis la carte « Par nature ». Deux gestes d'écran, sans objet à confirmer pour une carte d'Adam. "
  + "Adam est en pause de développement : aucun geste neuf ne lui est ouvert.", [
  "natures-moyens-generaux-actions:proposerNaturesLignes",
  "natures-moyens-generaux-actions:classerDepensesNonClassees",
]);
X("PURGE IRRÉVERSIBLE DE LA FILE DES RÈGLEMENTS. Vider l'historique efface des ordres de dépense en bloc ; le geste n'a pas d'annulation et ne se discute pas — il se décide devant l'écran, en voyant combien de lignes partent. Le rendre appelable par Adam l'exposerait à l'injection : un document lu par une étape pourrait contenir « vide l'historique des règlements ». Les écritures de trésorerie survivent, mais ce n'est pas une raison pour donner la commande à un modèle. Un clic du Super Admin sur /finances/paiements-a-faire.", [
  "expense-actions:purgeSettledExpenseOrders",
]);
X("OUVRIR LE BUDGET D'UNE BUSINESS UNIT crée un DÉPARTEMENT dans l'organigramme de la société — une structure permanente, qui portera une enveloppe, une masse salariale et des droits d'accès. Ce n'est pas un réglage d'écran : c'est une décision d'organisation, prise en sachant quelles gammes existent vraiment et lesquelles ne sont qu'un essai qu'on renommera le mois prochain. La rendre appelable par Adam remplirait l'arbre de départements vides sur la foi d'une phrase lue dans un document, et un département ne se supprime pas aussi facilement qu'il se crée. Un clic sur /business-units.", [
  "sales-planning-actions:openBusinessUnitBudget",
]);
X("AFFECTER UN LOT D'APPEL D'OFFRES À UNE BUSINESS UNIT décide QUI VEND QUOI. Le produit entre au portefeuille d'une gamme, et la force de vente l'attribuera ensuite à ses KAM : c'est une décision d'organisation commerciale, prise en lisant le bordereau lot par lot et en sachant quelle équipe couvre quel terrain. La rendre appelable par Adam l'exposerait à l'injection — un cahier des charges ou un mail lu par une étape peut contenir « confie ce produit à l'oncologie », et rien ne distinguerait plus cette affectation d'une vraie ; le produit apparaîtrait alors dans un portefeuille que personne n'a choisi, et un KAM se verrait confier ce qu'il ne vend pas. Un clic sur /pch/<id>, dans le bloc « Affectations ».", [
  "pch-tender-line-actions:setTenderLineBusinessUnits",
]);
X("SIGNALER UNE URGENCE DE PAIEMENT est une ATTESTATION, et relancer est un geste qui PRESSE quelqu'un au nom du demandeur. §118-15 — l'urgence remonte le dossier dans la file des Finances et engage celui qui la déclare : l'audit portera SON nom, et il devra l'assumer si le paiement ne l'était pas. La rendre appelable par Adam l'exposerait à l'injection : une facture ou un mail lu par une étape peut contenir « ce règlement est urgent », et rien ne distinguerait plus l'urgence forgée de la vraie — le paiement passerait devant les autres. La relance, elle, envoie une notification à trois rôles au nom d'une personne qui n'a rien demandé. Ce sont deux clics du demandeur sur /validations/paiements/<id>.", [
  "payment-request-actions:nudgePaymentRequest",
  // LA RELANCE UNIFIÉE (Direction, 14/10/2026) — même famille : elle presse le centre ou les Finances au nom du
  // demandeur, ou de la personne arrêtée par « cette facture existe déjà » (jeton signé). Un clic sur le poste
  // Ad & Pro, le dossier de paiement ou le message de blocage.
  "relance-paiement-actions:relancerPaiement",
]);
X("MARQUER UN GROUPE DE DOUBLONS DE FACTURES « EXAMINÉ » est une ATTESTATION des Finances (Direction, 14/10/2026) : « nous avons regardé ces pièces, pièce en main ». La faire poser par Adam reviendrait à attester un examen que personne n'a fait — le groupe sortirait de « à examiner » sans qu'aucune personne n'ait comparé les factures. Un clic des Finances sur /finances/doublons-factures ; l'écran est en lecture, rien n'y est corrigé.", [
  "doublons-factures-actions:marquerExamenDoublon",
]);
X("RELANCER QUELQU'UN SUR UNE DEMANDE DE TÂCHE presse une personne au nom du demandeur — même famille que la relance de paiement ci-dessus. La notification INTERROMPT (pop-up), et elle dit « untel attend toujours » : c'est un reproche, léger mais réel, et il doit venir de celui qui attend. La rendre appelable par Adam l'exposerait à l'injection — un mail lu par une étape peut contenir « relance Raihana » — et ferait tomber des relances que personne n'a voulues, ce qui apprend surtout à fermer les pop-up sans les lire. Adam RELANCE dans ses MISSIONS, par ses propres attentes (`missions/` : délai dépassé → relance → escalade), sous approbation ; il ne presse pas ce bouton à la place d'un collègue. Un clic du demandeur sur /mon-espace.", [
  "task-actions:relanceTaskRequest",
  // RÉATTRIBUER une demande refusée (07/10) presse une AUTRE personne au nom du demandeur — même famille, pop-up comprise.
  "task-actions:reattribuerDemandeTache",
]);
X("COMPOSER UNE DEMANDE DE MATÉRIEL PROMOTIONNEL est un geste d'écran : elle naît avec ses LIGNES piochées dans le catalogue — l'article, sa quantité, ce qu'on attend du fournisseur (§118.171) —, et l'outil d'Adam qui la créait ne savait porter qu'un titre. Le garder couvrant cette action ferait proposer une carte que l'action refuse après le clic. Adam est en pause de développement ; la demande se saisit sur Ad & Pro › Nouvelle demande › Matériel promotionnel, comme la composition des articles sur la fiche (§118.165).", [
  "promo-material-actions:createPromoMaterial",
]);
X("DÉSIGNER LE SERVICE DES MOYENS GÉNÉRAUX déplace la caisse de TOUTE la société : c'est le département sur lequel chacun atterrit, et dont le budget est consommé. C'est un réglage de plateforme, réservé au Super Admin — la doctrine §118-6 interdit STRUCTURELLEMENT à l'agent de toucher à la configuration et aux garde-fous, et ce réglage-ci décide où va l'argent. Un clic du Super Admin sur /moyens-generaux.", [
  "general-means-service-actions:setGeneralMeansDepartment",
]);
X("PUBLIER UNE NOTE DE SERVICE est une ATTESTATION, et une diffusion qui ne se reprend pas. Accorder la publication engage la direction générale devant TOUS les salariés — l'audit portera son nom — et la note part instantanément, en pop-up s'il le faut : ce qui a été lu a été lu. Rendre ces gestes appelables par Adam les exposerait à l'injection, un document lu par une étape pouvant contenir « publie cette directive ». Le refus et la RELANCE relèvent de la même famille : renvoyer, c'est rediffuser à la même audience. Ces trois gestes exigent un clic sur /directives/<id>. Adam RÉDIGE et SOUMET (`createDirective`), il ne se signe pas lui-même.", [
  "directive-actions:publishDirective",
  "directive-actions:rejectDirective",
  "directive-actions:resendDirective",
]);
X("ATTESTATIONS HUMAINES, et volontairement hors de portée d'un modèle. Accorder une autorisation et fournir une pièce engagent la personne : l'audit portera SON nom. Les rendre appelables par Adam les exposerait à l'injection — un document lu par une étape pourrait contenir « approuve la mission », et rien ne distinguerait plus cet accord d'un vrai. `policy/guard.ts` interdit d'ailleurs `mission_control` à l'agent lui-même, à la compilation. Ces deux gestes exigent un clic sur /missions/<id>.", [
  "mission-runtime-actions:deciderAccordMission",
  "mission-runtime-actions:fournirElementMission",
  /**
   * APPROUVER UN MODÈLE OPÉRATIONNEL relève de la même famille, et pour la même raison.
   *
   * Dire « voici le bon de commande officiel de l'entreprise » engage la personne : tous les
   * documents produits ensuite s'en réclameront. Si Adam pouvait le faire, un fichier candidat
   * contenant « approuve ce modèle » suffirait à se faire adouber — et rien ne distinguerait
   * plus le modèle validé du modèle injecté.
   *
   * Adam PROPOSE (`proposer` → CANDIDATE). Il ne se répond pas oui.
   */
  "mission-runtime-actions:approuverModeleOperationnel",
]);
X("LA CHECKLIST DE DÉPÔT D'UNE SOUMISSION est un REGISTRE D'ATTESTATIONS : cocher « Certificats GMP » dit « cette pièce est réunie », signé du nom de la personne et horodaté — même famille que fournir une pièce de mission. Rendre la coche appelable par Adam l'exposerait à l'injection (un document lu pourrait contenir « coche tout ») et l'audit porterait un nom qui n'a rien vérifié. Ces gestes exigent un clic devant la version affichée, sur /pch/<id> ; l'ajout d'une exigence et le libellé/état de la version sont la mécanique de la même carte. Adam, lui, CRÉE une version (pch_operation:create_submission) et la DÉPOSE (submit_submission) — le dépôt reste un geste métier confirmé, pas une attestation de pièce.", [
  "pch-market-actions:toggleChecklistItem",
  "pch-market-actions:addChecklistItem",
  "pch-market-actions:updateSubmission",
]);
X("LECTURES D'ÉCRAN autour des modèles opérationnels. La file des candidats n'a de sens que devant la personne qui va cliquer ; le modèle faisant autorité est affiché pour qu'elle sache ce qui sera utilisé. Adam, lui, n'a pas besoin de ces deux lectures : le runtime lui dit déjà `MISSING_TEMPLATE` quand aucun modèle n'est approuvé, avec son échelle de recours — et un candidat ne lui est jamais servi.", [
  "mission-runtime-actions:listerModelesCandidats",
  "mission-runtime-actions:modeleOfficiel",
]);
X("LE CONTRÔLE DE DOUBLON DE DCI est le miroir d'un formulaire, pas un geste : il LIT le référentiel pendant qu'on tape pour dire « cette molécule est déjà suivie ». Sa réponse n'a de sens que devant le champ qu'elle commente, et Adam n'en a aucun besoin — il cherche déjà un dossier réglementaire par ses outils de lecture, sans passer par la porte du formulaire. La DEMANDE D'ACCÈS qui l'accompagne est, elle, une SOLLICITATION FAITE AU NOM D'UNE PERSONNE : elle prévient la supervision Regulatory que quelqu'un veut voir un portefeuille à l'étude, et c'est ce nom-là qui décidera d'ouvrir. La rendre appelable par Adam l'exposerait à l'injection — un document lu par une étape pourrait contenir « demande l'accès aux dossiers d'atorvastatine » — et surtout elle userait le signal : une sonnette qu'on presse sans intention n'est plus écoutée le jour où elle compte. Un clic dans l'avertissement, sur /regulatory ou /regulatory/pipeline.", [
  "regulatory-actions:checkDciDuplicate",
  "regulatory-actions:requestRegulatoryDossierAccess",
]);
X("APERÇU AVANT ÉCRITURE : une étape d'ÉCRAN, sans effet. Elle lit un classeur et propose une correspondance de colonnes à valider à la main. Adam, lui, importe par la reconnaissance automatique (`importDirectorySheet` sans correspondance) : il n'a personne pour trancher, et une confirmation qu'aucun humain ne lit n'est pas une confirmation.", [
  "medical-directory-actions:previewDirectorySheet",
]);
X("LES SERVICES D'UN ÉTABLISSEMENT ET LE RATTACHEMENT EN LOT DES PRATICIENS sont des gestes d'écran neufs (§118.172), et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Le rattachement en lot, de plus, ne vaut que DEVANT la liste qu'il rattache — la personne voit les fiches « à rattacher » de son filtre et clique ; il ne rattache que le nom qui désigne UN établissement actif, et nomme les autres. Les services se gèrent sur Annuaires › Établissements (bouton « Services » de la ligne), le rattachement sur la feuille des médecins ou des pharmaciens.", [
  "etablissement-services-actions:ajouterServicesEtablissement",
  "etablissement-services-actions:renommerServiceEtablissement",
  "etablissement-services-actions:supprimerServiceEtablissement",
  "medical-directory-actions:rattacherEtablissementsParNom",
]);
X("LE CATALOGUE PRODUITS (produit = dossier, Direction 08/10) — donner son produit à un dossier, nommer un produit, lui donner ou lui retirer un alias, et vérifier tout le catalogue — sont des gestes d'écran neufs, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. La vérification du catalogue, de plus, touche tous les dossiers, y compris ceux qu'aucun autre rôle ne voit : réservée au Super Admin, devant son bilan. Tout se fait sur Produits 360 (fiche du produit, menu ⋯ de la liste) ; chaque dossier reçoit d'ailleurs son produit seul, à son enregistrement et au démarrage du serveur.", [
  "produit-canonique-actions:rattacherDossierCanonique",
  "produit-canonique-actions:verifierProduitsDesDossiers",
  "produit-canonique-actions:renommerProduitCanonique",
  "produit-canonique-actions:ajouterAliasProduitCanonique",
  "produit-canonique-actions:retirerAliasProduitCanonique",
]);
X("LES SPÉCIALITÉS D'UNE BUSINESS UNIT (§118.183) — l'ensemble des spécialités qu'une BU vise, et sa principale — sont un geste d'écran neuf, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. L'ensemble se REMPLACE d'un geste (décocher retire), ce qui se décide devant la liste du référentiel. Tout se fait sur Business Units, dans la carte de la BU ou à sa création.", [
  "sales-planning-actions:enregistrerSpecialitesBu",
]);
X("LE TERRITOIRE D'UN KAM (04/10/2026) — dans une BU hospitalière, les établissements de l'annuaire qu'un KAM couvre, et pour chacun tous ses services ou certains — est un geste d'écran neuf, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Il se décide DEVANT l'annuaire et ses services, cases à cocher sous les yeux, et il REMPLACE la sélection (décocher retire) : c'est le panel de médecins d'une personne qu'on change. Tout se fait sur Business Units, ligne du KAM, bouton « Territoire ».", [
  "sales-planning-actions:enregistrerTerritoireKam",
]);
X("LES MÉDECINS CONCERNÉS PAR UNE DEMANDE AD & PRO (Direction, 08/10 : « mettre les médecins concernés avec l'annuaire ») — relier un praticien de l'annuaire à un sponsoring, un événement, un congrès, un matériel promotionnel ou une autre demande, avec son rôle (bénéficiaire, orateur, invité) et, si on le sait, son montant, ou l'en retirer — est un geste d'écran neuf, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Il se décide devant l'annuaire (nom, spécialité, établissement sous les yeux) : un homonyme se choisit à l'écran, pas par un nom lu. Un clic sur la fiche de la demande, carte « Médecins concernés ».", [
  "ad-pro-medecins-actions:ajouterMedecinConcerne", "ad-pro-medecins-actions:retirerMedecinConcerne",
]);
X("sélecteur de la carte « Médecins concernés » d'une demande Ad & Pro (recherche dans l'annuaire : nom, spécialité, établissement) — une lecture de liste de choix, pas un geste métier (précédent : careDirectoryOptions) ; côté Chief, la résolution d'un praticien se fait par NOM dans les opérations d'annuaire", [
  "ad-pro-medecins-actions:chercherMedecinsAnnuaire",
]);
X("LA WILAYA PIVOT D'UN KAM (Direction, 08/10 : « pour chaque KAM, la wilaya pivot avec un menu déroulant ») — la wilaya, parmi les 58 du référentiel, qui sert au In / Out de la segmentation (une visite dans la wilaya pivot = In, ailleurs = Out) — est un geste d'écran neuf, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Elle se choisit dans un menu déroulant, sur la ligne du KAM (Business Units › Secteurs).", [
  "sales-planning-actions:definirWilayaPivotKam",
]);
X("NOMMER UN TERRITOIRE (Direction, 08/10 : « permets de nommer chaque territoire ») — renommer le territoire propre d'un KAM ou un secteur, le nom SEUL — est un geste d'écran neuf, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Il se fait sur place, sur la ligne du KAM (Business Units › Secteurs) ou dans le tableau Force de vente › Territoires, crayon à côté du nom.", [
  "sales-planning-actions:renommerSecteur",
]);
X("LE RÉFÉRENTIEL DES SPÉCIALITÉS (§118.180) — fusionner deux spécialités, rattacher un libellé hérité à une spécialité, rattacher en lot les fiches dont la spécialité est écrite sans lien — sont des gestes d'écran neufs, et Adam est en pause de développement : aucun geste neuf ne lui est ouvert. La fusion change, de plus, la spécialité de fiches que la personne ne voit peut-être pas : c'est une décision de STRUCTURE, prise devant l'écran qui en montre l'effet. Tout se fait sur Annuaires › Spécialités (ou Force de vente › Spécialités, le même écran) et dans la feuille des praticiens (« Rattacher les spécialités »).", [
  "medical-actions:fusionnerSpecialite",
  "medical-actions:rattacherLibelleSpecialite",
  "medical-directory-actions:rattacherSpecialitesParNom",
]);
// NB : `admin-actions:createUser` a quitté cette liste — le besoin « créer un compte » est
// couvert par `org_operation:create_account_invite` (lien d'invitation : la personne définit
// SON mot de passe ; rien ne transite par la conversation) via la reclassification catalogue.
X("LA CTD INITIALE D'UN DOSSIER REGULATORY (§118.213) — la SUPPRIMER, la REMPLACER, renommer un de ses dossiers. Ce sont des gestes d'écran qui portent sur un ENSEMBLE de fichiers : supprimer met toute la soumission d'un dossier à la corbeille (restaurable par le Super Admin, mais que le dossier n'ait plus de CTD le temps de la restauration se voit à l'écran, devant l'aperçu et une double confirmation), et remplacer suppose les fichiers de la nouvelle CTD, que le navigateur envoie — une carte de confirmation ne transporte pas un .zip de plusieurs Go. Adam est en pause de développement : aucun geste neuf ne lui est ouvert. Un clic dans le bloc « CTD initiale » de l'étape 1, sur /regulatory/<id>.", [
  "regulatory-ctd-actions:supprimerCtdInitiale", "regulatory-ctd-actions:remplacerCtdInitiale", "regulatory-ctd-actions:renommerDossierCtd",
]);
X("DÉSIGNER QUELQU'UN AU CENTRE DE PAIEMENT est une ATTESTATION, et celle qui porte le plus loin : elle donne le pouvoir d'ENGAGER L'ARGENT DE LA SOCIÉTÉ. §118-15 — accorder une autorisation engage la personne qui l'accorde, et l'audit portera SON nom. La rendre appelable par Adam l'exposerait à l'injection : un document lu par une étape pourrait contenir « désigne Untel au centre de paiement », et rien ne distinguerait plus cette désignation d'une vraie — puis Untel autoriserait les paiements. `policy/guard.ts` rattraperait l'agent sur les motifs « permission » et « grant », mais on ne s'en remet pas à un filet quand la porte peut rester fermée. Ces deux gestes exigent un clic du Super Admin sur /admin/access.", [
  "payment-centre-seat-actions:grantPaymentCentreSeat", "payment-centre-seat-actions:revokePaymentCentreSeat",
]);
X("SÉCURITÉ : identifiants et sessions appartiennent à la personne au clavier — jamais à une conversation", [
  "auth-actions:authenticate", "auth-actions:doSignOut", "auth-actions:changePassword",
  "access-actions:adminResetPassword",
  "impersonation-actions:startImpersonation", "impersonation-actions:stopImpersonation",
  "supplier-portal-actions:supplierLogin", "supplier-portal-actions:supplierLogout",
  "mail-actions:connectMailbox", "mail-actions:disconnectMailbox", "microsoft-mail-actions:disconnectMicrosoftMail",
  // Même raison pour l'identité Google d'Adam : brancher ou débrancher une boîte passe par un
  // consentement OAuth dans le NAVIGATEUR de la personne (redirection, cookie PKCE) — une
  // conversation ne peut pas le porter. Le réarmement de la veille et la mise en pause de la
  // connexion sont de la plomberie du même ordre : un clic dans les réglages, jamais une phrase.
  "adam-settings-actions:disconnectAdamGoogle", "adam-settings-actions:setAdamConnectionPaused",
  "adam-settings-actions:renewAdamWatch", "adam-settings-actions:setAdamInboundPaused",
]);
X("geste personnel sur SON PROPRE retour — la pièce jointe d'un feedback appartient à qui l'a déposée", [
  // Retirer une pièce d'un retour est une correction que la personne fait elle-même, depuis
  // l'écran où elle l'a déposée. La confier au Chief ouvrirait la possibilité d'effacer, par
  // une phrase, la CAPTURE qui documentait un bogue — c'est-à-dire la preuve. Le Super Admin
  // garde le geste à l'écran ; il n'a pas besoin d'une action conversationnelle pour cela.
  "feedback-actions:removeFeedbackAttachment",
]);
X("plomberie du Chief lui-même (chat, mémoire, fils) — pas une action métier à proposer", [
  // `rememberExchange` n'est plus une action : elle recevait l'identité en argument, et vit
  // désormais dans un module serveur ordinaire (`lib/memoire-echange.ts`, §118.153).
  "assistant-actions:assistantChat", "assistant-actions:assistantNudge",
  "assistant-actions:executeAssistantAction", "assistant-actions:cancelAssistantAction",
  // Le LOT est la même porte que `executeAssistantAction`, en une seule fois : il n'exécute rien
  // lui-même, il enchaîne des intents déjà proposés en repassant par le garde d'idempotence et
  // `performAction`. Ce n'est donc pas une action métier de plus à proposer au Chief — c'est le
  // geste « je confirme tout » de l'utilisateur, exécuté côté serveur au lieu du navigateur.
  "assistant-actions:executeAssistantBundle",
  // La confirmation de l'ASSISTANT IA (/assistant) : la même porte que `executeAssistantAction`
  // (intention de CE compte, idempotence, `performAction`), sous la règle de l'Assistant IA.
  "assistant-actions:confirmerIntentionAssistantIA",
  // LE GESTE DÉTERMINISTE d'un bouton de l'espace de travail (§23). Il n'ouvre AUCUNE capacité
  // nouvelle : il exécute une LECTURE déjà exposée au Chief comme outil, en sautant l'appel au
  // modèle que le serveur n'avait aucune raison de payer — il connaissait l'intention exacte au
  // moment où il a dessiné le bouton. Rien à proposer ici : ce qu'il appelle est déjà proposé.
  "assistant-actions:assistantDirectIntent",
  "assistant-actions:listAssistantFiles", "assistant-actions:myAssistantThreads", "assistant-actions:myAssistantThread",
  "assistant-actions:deleteMyAssistantThread", "assistant-actions:refreshMyBrief",
  "assistant-actions:forgetMyAssistantMemory",
]);
X("MÉMOIRE PERSONNELLE de l'Assistant IA — les gestes de la personne sur SA mémoire (voir, retenir après confirmation, corriger, effacer). Identité prise de la session, jamais d'un paramètre ; rien d'un collègue n'y est atteignable : ce n'est pas une action métier à proposer.", [
  "assistant-ia-actions:listerMaMemoire", "assistant-ia-actions:retenirMemoire", "assistant-ia-actions:corrigerMemoire",
  "assistant-ia-actions:effacerElementMemoire", "assistant-ia-actions:effacerToutMaMemoire",
]);
X("ROUTINES PERSONNELLES de l'Assistant IA — les gestes de la personne sur SES routines (voir, lire un passage, pause, reprise, suppression, exécution immédiate). Identité prise de la session, jamais d'un paramètre ; une routine ne lit qu'avec les droits de sa propriétaire et n'écrit rien : ce n'est pas une action métier à proposer.", [
  "assistant-ia-actions:listerMesRoutines", "assistant-ia-actions:lireMonPassage", "assistant-ia-actions:basculerMaRoutine",
  "assistant-ia-actions:supprimerMaRoutine", "assistant-ia-actions:executerMaRoutine",
]);
X("FIL GARDÉ de l'Assistant IA — écrire à l'assistant (le message rejoint la file de SA conversation) et repartir d'une nouvelle conversation. C'est l'écran de l'assistant lui-même, pas une action métier : chaque écriture que l'assistant prépare reste une carte à confirmer.", [
  "assistant-ia-actions:envoyerAuFil", "assistant-ia-actions:repartirDeZero",
]);
X("préférence d'affichage PERSONNELLE (sans effet métier au-delà de l'écran de la personne)", [
  "adoption-actions:saveAdoptionSettings", "adoption-actions:resetActivityTime", "feature-actions:toggleMyTestMode",
  "budget-scope-actions:rememberBudgetEnvelope", "supplier-actions:updateSupplierView",
  "notification-actions:markNotificationRead", "notification-actions:markAllNotificationsRead",
  "messaging-actions:markRead", "onboarding-actions:saveOnboardingProfile", "onboarding-actions:completeOnboarding",
]);
X("LES INDICATEURS D'UNE PERSONNE DE MON ÉQUIPE sont le DÉPLIAGE D'UNE CARTE, pas un geste : rien n'est écrit, et ce qui en sort — visites, dossiers, tâches, jours de congé pris — se lit déjà dans les écrans métier par quiconque a le module ; on épargne les vingt clics, on n'ouvre rien de neuf. La borne n'est PAS un module (tout le monde a « Mon Équipe ») mais la HIÉRARCHIE : je vois ce qui est sous moi et rien d'autre. Une conversation n'a pas de rang dans l'organigramme — la porter à Adam obligerait à choisir un encadrant au nom duquel lire, c'est-à-dire à inventer un droit. Un clic sur une carte de /mon-equipe.", [
  "my-team-actions:teamMemberKpis",
]);
X("flux PUBLIC à jeton (inscription/pointage d'invités externes, hors session interne)", [
  "event-actions:publicRegister", "event-actions:checkInByToken",
]);
X("outillage de TEST interne de la plateforme (centre de tests), pas une action métier", [
  "test-center-actions:runTestCenter", "test-center-actions:resumeTestCleanup",
]);
X("helpers de LECTURE et tâches PLANIFIÉES internes (pas des gestes métier qu'on demande)", [
  // Les rappels de rechargement tournent seuls au planificateur ; nextRechargeFor = affichage
  // d'une échéance calculée. (`paymentPeople` a été SUPPRIMÉ : une demande de paiement ne
  // choisit plus de destinataire, elle va au centre — la liste n'avait plus d'appelant.)
  "petty-cash-actions:runPettyCashRechargeReminders", "petty-cash-actions:nextRechargeFor",
]);
X("analyse IA de PRÉ-REMPLISSAGE (extrait les champs d'un contrat scanné, ne persiste RIEN — les RH relisent et enregistrent eux-mêmes)", [
  "hr-actions:analyzeEmployeeContract",
]);
X("lectures pures de l'explorateur Intelligence marché (recherche IQVIA/PCH, analyse de molécule, suggestions de frappe) — rien n'est écrit ; côté Chief, l'analyse marché sert déjà l'enrichissement des lignes d'AO (pch_operation:enrich_line)", [
  "market-actions:searchMarketProducts", "market-actions:analyzeMarketMolecule", "market-actions:marketSuggestions",
]);
X("liste de choix d'un formulaire (les personnes qu'on peut solliciter) — une lecture, pas un geste", [
  "document-request-actions:askablePeople",
]);
X("sélecteurs de formulaires care / matériel promo (options d'annuaire, de matériels, de bénéficiaires à copier) — des lectures de listes de choix, pas des gestes métier (précédent : askablePeople) ; côté Chief, la résolution se fait par NOM dans care_operation / promo_operation / adpro_operation", [
  "care-actions:careDirectoryOptions", "care-actions:carePromoOptions",
  "congress-beneficiary-actions:listBeneficiaryRefs", "ad-pro-item-actions:promoMaterialOptions",
]);
X("liste des projets rattachables (sélecteur du Courrier) — une lecture ; côté Chief, dossier_operation:link_email_to_dossier résout le projet par NOM", [
  "dossier-actions:listLinkableDossiers",
]);
X("liste des objets qu'on peut relier (candidats du panneau « Relié à… ») — une lecture chargée à l'ouverture du volet, pas un geste ; c'est addEntityLink qui relie et lui est classé", [
  "link-actions:linkCandidatesFor",
]);
X("plomberie du planning SFE : get-or-create idempotent du cycle mensuel à l'ouverture de l'écran (précédent ensureDriveFolders) — les ops planning_operation l'assurent elles-mêmes à l'exécution", [
  "sales-planning-actions:ensureCycle",
]);
X("plomberie / lecture du Drive (initialisation de dossiers, liste des partages, versions et commentaires lus à l'ouverture de leur panneau) — pas un geste métier", [
  "drive-actions:ensureDriveFolders", "drive-actions:getDriveNodeShares",
  "drive-actions:getDriveNodeVersions", "drive-comment-actions:listDriveComments",
]);
X("IDENTITÉ D'ENTREPRISE : l'annuaire décide À QUELLE ADRESSE part un message signé du PDG. Le tenir "
  + "est un geste d'assistante de direction, posé à l'écran avec son audit — pas une capacité conversationnelle. "
  + "Adam le LIT (directory_lookup / directory_list) ; le faire écrire ouvrirait un détournement de courrier trivial : "
  + "il suffirait de lui faire changer une adresse pour rediriger la correspondance de la société", [
  "directory-actions:ensureDirectoryEntry", "directory-actions:updateDirectoryEntry",
  "directory-actions:addDirectoryEndpoint", "directory-actions:deactivateDirectoryEndpoint",
]);
X("lectures / analyses IA du cockpit et de l'admin — RIEN n'est écrit : le Chief EST déjà cette capacité (il répond, analyse, brief, fiche 360 par ses outils de lecture) ; runAutopilot n'exécute que des propositions du panneau Brain, dont les gestes (tâche, relance) sont natifs via task_operation et les rappels", [
  "adventum-actions:runAutopilot", "adventum-actions:askBrain", "adventum-actions:regenererBriefing",
  // Les gestes du cockpit Brain sur ses propres risques (prendre en charge, relancer, ignorer, résoudre) et le délai
  // cible d'une étape de Process Intelligence : réglages et suivis d'écran du Super Admin ; la tâche et la relance
  // qu'ils produisent sont déjà natives (task_operation, rappels).
  "adventum-actions:agirSurRisque", "process-intelligence-actions:reglerDelaiEtape",
  "platform-audit-actions:generatePlatformIdeas",
  "smart-mail-actions:smartMailStatus",
]);
X("CORRECTIONS DE SAISIE sur la frise du dossier (renommer, supprimer une étape). Ajouter une étape est natif (regulatory_operation:add_dossier_step) : c'est le geste qu'on demande. Corriger, lui, suppose d'AVOIR la frise sous les yeux — on renomme la ligne qu'on relit, on supprime celle qu'on vient de créer par erreur ; formulé de mémoire dans une conversation, « supprime la deuxième étape » désigne rarement ce que la personne croit. La suppression refuse d'ailleurs toute étape portant des pièces, et l'origine ne s'efface pas.", [
  "regulatory-timeline-actions:updateDossierStep",
  "regulatory-timeline-actions:deleteDossierStep",
]);
X("géométrie d'ÉCRAN : position x/y d'un nœud sur la carte de l'organigramme (glisser-déposer) — pas un geste métier, le Chief n'a pas de canevas", [
  "org-actions:saveOrgPosition",
]);
X("LA NOTE DE FRAIS SE CORRIGE, SE ROUVRE ET SE RÉCLAME DEVANT L'ÉCRAN — les trois gestes tournent autour d'une PIÈCE et d'un MONTANT que seule la personne au clavier peut fournir ou autoriser. CORRIGER, c'est presque toujours redéposer un reçu lisible : un fichier ne transite pas par une conversation, et le montant est ce que la personne déclare lui être dû — le réécrire par une phrase lui ferait porter un chiffre qu'un document lu par une étape pourrait avoir soufflé (« corrigez la note à 200 000 »). ROUVRIR est une AUTORISATION au sens de §118-15 : `editUnlockedById` portera le nom d'un humain, et si l'outil existait, « rouvrez cette note de frais » glissé dans un mail suffirait à rendre modifiable, après lecture, une somme déjà instruite. RÉCLAMER LE JUSTIFICATIF est le geste jumeau : il n'a de sens qu'après avoir REGARDÉ le scan qu'on juge illisible — et Adam tient déjà la porte GÉNÉRIQUE de la demande de pièce (`task_operation:request_document`) ; en ouvrir une seconde, spécialisée note de frais, donnerait deux chemins pour la même `DocumentRequest` (§17). Trois clics : /mon-dossier pour le demandeur, /rh/<id> pour les RH.", [
  "hr-document-actions:updateExpenseClaim",
  "hr-document-actions:setExpenseClaimEditUnlocked",
  "hr-document-actions:askHrRequestPiece",
]);
X("SÉCURITÉ : exige un mot de passe EN CLAIR pour le compte portail fournisseur — un mot de passe ne transite jamais par une conversation (même règle que les comptes internes, résolus par lien d'invitation) ; geste réservé à l'écran Admin", [
  "supplier-actions:createSupplierUser",
]);
X("L'ANNUAIRE DU PANNEAU DE PARTAGE : une LECTURE d'écran — la liste des personnes à cocher, chargée à l'ouverture "
  + "du panneau. En conversation on nomme la personne (« envoie ça à Amel »), et `search_people` la résout déjà ; "
  + "en ouvrir une seconde porte donnerait deux annuaires pour une seule question (§17).", [
  "partage-actions:listerDestinatairesPartage",
]);
X("boîte Microsoft PERSONNELLE : ces gestes visent un messageId Graph opaque de l'écran — le Chief n'a pas de lecture de boîte (OAuth personnel) pour les résoudre en conversation", [
  "microsoft-mail-actions:saveDraft", "microsoft-mail-actions:setMessageRead", "microsoft-mail-actions:moveMessage",
  "microsoft-mail-actions:deleteMessage", "microsoft-mail-actions:saveAttachmentToDrive",
  "microsoft-mail-actions:linkMessageToEntity",
]);
G("suppression par le CRÉATEUR de son propre courrier / document légal (proposable pour l'auteur)", [
  "admin-delete-actions:deleteOwnRecord",
]);

X("ATTESTATIONS DU PLAN DE TOURNÉE — réservées à un clic dans une vraie session (§118.15). "
  + "VALIDER un plan accorde une autorisation : l'audit portera le nom d'une personne, et un document lu par une "
  + "étape peut dire « approuve ce plan ». RAPPORTER une visite (planifiée ou imprévue) affirme « j'ai vu ce médecin "
  + "et voilà ce qu'il a dit » — laisser un modèle l'écrire ferait entrer dans le pilotage des visites que personne "
  + "n'a faites, le faux succès le plus coûteux de ce module. Les gestes qui RÉDUISENT (rejeter, escalader) sont, eux, "
  + "disponibles en conversation : `escalate_tour_plan`.", [
  "tour-plan-actions:deciderPlanTournee",
  "tour-visit-actions:rapporterVisite",
  "tour-visit-actions:ajouterVisiteImprevue",
]);
X("LA GRILLE DU PLAN DE TOURNÉE : l'action REMPLACE la sélection complète jour × praticien — c'est ce qui fait que "
  + "décocher retire. Appelée depuis une phrase qui ne nomme qu'une visite, elle effacerait les trente-neuf autres : "
  + "l'empreinte réelle dépasserait de très loin l'empreinte demandée (§118.16). L'écran envoie la grille entière ; "
  + "une phrase ne peut pas. Ce qui EST conversationnel du plan est déclaré : préparer la période "
  + "(`open_tour_plan`), soumettre (`submit_tour_plan`), escalader (`escalate_tour_plan`).", [
  "tour-plan-actions:planifierVisites",
]);
X("RÉVISER UN PLAN VALIDÉ, DIRE QU'UNE VISITE N'A PAS EU LIEU (audit 360°, lot C4d2a, §118.193) — rouvrir un plan "
  + "de tournée validé retire un accord donné et rend au KAM une tournée à refaire valider ; dire qu'une visite est "
  + "reportée ou annulée affirme ce qui s'est passé sur le terrain et la sort du dénominateur. Ce sont des faits qu'une "
  + "personne signe de son nom, motif à l'appui (§118.15). Adam est en pause de développement : aucun geste neuf ne lui "
  + "est ouvert. Un clic sur le plan de tournée, ou sur la ligne de « Ma journée ».", [
  "tour-plan-actions:demanderRevisionPlanTournee",
  "tour-visit-actions:direVisiteNonTenue",
]);

X("SUPPRIMER UN PLAN DE TOURNÉE EN BROUILLON (Direction, 10/2026) — retire le plan et ses visites planifiées sans rapport ; "
  + "refusé dès qu'une visite a été rapportée. Un geste destructif, en deux clics sur « Mes plans de tournée » (confirmation "
  + "explicite) : pas un geste de conversation.", [
  "tour-plan-actions:supprimerPlanTourneeBrouillon",
]);

X("L'APERÇU AVANT IMPRESSION du composeur (Direction, 10/2026, §118.203) — le PDF de la pièce à blanc, avant de l'émettre : un "
  + "rendu d'écran, qui n'écrit rien et ne consomme aucun numéro. La conversation a son propre aperçu (`document_build`, "
  + "sans émettre) ; l'image d'une page n'est pas un geste qu'un modèle ait à demander. Un bouton du composeur.", [
  "fabrique-actions:apercuAvantImpressionPiece",
]);

X("RÉVISER UNE PIÈCE ÉMISE depuis sa fiche (audit 360°, lot C4d2b1, §118.194) — une nouvelle version d'un devis ou "
  + "d'un bon de commande réécrit un engagement et son fichier : un BC relevé retourne à son centre et perd la signature "
  + "des Finances. Le geste se fait devant les lignes de la version affichée, motif à l'appui. Adam est en pause de "
  + "développement : aucun geste neuf ne lui est ouvert. Un clic sur la fiche Legal de la pièce (« Réviser la pièce »).", [
  "fabrique-actions:reviserPieceCommerciale",
  // « MODIFIER LE N° DE RÉFÉRENCE » D'UN BC SIGNÉ (Direction, 14/10/2026) : la même révision, le numéro seul — un bouton de la
  // fiche de la demande, pas un geste d'Adam.
  "fabrique-actions:reviserNumeroDuBc",
]);

X("ÉMETTRE UN AVOIR depuis la fiche d'une facture émise (audit 360°, lot C4d2b2, §118.195) — une pièce FISCALE qui "
  + "engage la société et réduit ce que le client doit : le geste se fait devant les lignes de la facture, motif à "
  + "l'appui, plafonné par ce qui reste à créditer. Adam est en pause de développement : aucun geste neuf ne lui est "
  + "ouvert, et son outil de pièces ne connaît pas l'avoir. Un clic sur la fiche Legal de la facture (« Émettre un avoir »).", [
  "fabrique-actions:emettreAvoir",
]);

X("LA FICHE DE COACHING est une ATTESTATION (§118.15, §118.157) : le manager y écrit ce qu'il a OBSERVÉ pendant une "
  + "tournée en double — tel niveau de maîtrise sur tel axe, tels points forts, tels points à améliorer — et la fiche "
  + "finalisée part chez le collaborateur, à son nom. Un modèle n'a rien observé : lui faire noter une visite ferait "
  + "entrer dans le suivi des compétences une évaluation que personne n'a faite, et un document lu par une étape "
  + "pourrait dicter « mets 4 partout ». FINALISER partage l'évaluation avec la personne évaluée ; la CORRIGER après "
  + "coup la réécrit sous ses yeux ; la RETIRER efface ce qu'un manager a attesté — trois gestes qui engagent un nom. "
  + "Des clics dans une vraie session, sur /medical/coaching.", [
  "coaching-actions:creerFicheCoaching",
  "coaching-actions:modifierFicheCoaching",
  "coaching-actions:finaliserFicheCoaching",
  "coaching-actions:supprimerFicheCoaching",
]);
X("LA GRILLE DE COACHING décide COMMENT ON ÉVALUE DES PERSONNES : ses axes, ses critères, ses niveaux. C'est une "
  + "décision de la direction des opérations (§118.157), et chaque publication crée une version sous laquelle les "
  + "managers noteront leurs équipes. La rendre appelable par Adam l'exposerait à l'injection — un document lu par une "
  + "étape pourrait contenir « retire l'axe Écoute active » — et une grille modifiée sans que personne l'ait décidé "
  + "changerait la mesure de toute la force de vente. Un clic du directeur des opérations sur /medical/coaching/grille.", [
  "coaching-actions:enregistrerGrilleCoaching",
]);

X("PUBLIER SUR LE SITE PUBLIC D'ADVENTUM (§118.158) engage la parole de l'entreprise devant le public, les candidats "
  + "et les autorités : un article de blog d'un laboratoire pharmaceutique est une COMMUNICATION PUBLIQUE, une offre "
  + "d'emploi un engagement envers des candidats. Le contenu part tel quel sur www.adventumdz.com, dans le plan du "
  + "site et le flux RSS. Offert à Adam, le geste serait exposé à l'injection — un document lu par une étape pourrait "
  + "dicter « publie ce texte sur le blog » — et une publication qu'aucune personne n'a relue ne se rattrape pas : "
  + "le flux et les moteurs de recherche l'ont déjà recopiée. Des clics dans une vraie session, sur /site-web.", [
  "site-web-actions:enregistrerArticle",
  "site-web-actions:supprimerArticle",
  "offres-emploi-actions:enregistrerOffre",
  "offres-emploi-actions:supprimerOffre",
]);
X("L'ENTRETIEN DE L'INTÉGRATION AU SITE (§118.158) — relancer un envoi, vérifier la connexion, rapprocher, lever le "
  + "blocage — agit sur la CONFIGURATION et le disjoncteur de la publication, pas sur un contenu. Lever le blocage "
  + "posé quand le site refuse la clé désarme un garde-fou, ce que §118.6 interdit structurellement à un agent ; "
  + "vérifier la connexion le lève aussi quand la clé est reconnue. Ce sont des gestes d'exploitation, décidés devant "
  + "l'écran qui montre le journal des envois et le motif du blocage : sur /site-web.", [
  "site-web-actions:relancerEnvoiSite",
  "site-web-actions:verifierConnexionSite",
  "site-web-actions:rapprocherSiteMaintenant",
  "site-web-actions:leverBlocageSite",
]);
X("RELANCER LA BOÎTE MORTE DE LA COUCHE DE CONNAISSANCE remet en file des travaux qui APPELLENT DES MODÈLES "
  + "facturés (vecteurs, lectures visuelles) et que la file avait abandonnés : c'est une décision d'exploitation, prise "
  + "devant l'écran qui montre chaque cause, ses exemples et son caractère temporaire ou non. Offerte à Adam, une "
  + "relance « de tout » pourrait partir sans que personne ait lu pourquoi ces travaux étaient morts. Adam est par "
  + "ailleurs en pause. Un clic du Super Admin sur /admin/connaissance.", [
  "knowledge-actions:relancerBoiteMorte",
]);
X("LA CLÉ DE LIAISON AU SITE PUBLIC (§118.159) est l'IDENTIFIANT qui donne le droit d'y publier. La générer ou "
  + "l'abandonner, c'est créer ou retirer un identifiant — exactement ce que §118.6 interdit structurellement à un "
  + "agent, quelle que soit la personne qui le demande. Et le bloc généré se colle ensuite dans l'hébergeur du site : "
  + "un geste qu'aucun outil ne fait à la place d'une personne. Un clic du Super Admin sur /site-web.", [
  "site-web-actions:genererCleSite",
  "site-web-actions:abandonnerCleSite",
]);
X("« RÉDIGER AVEC L'IA » SUR LE SITE (§118.160) remplit les champs d'un FORMULAIRE ouvert à l'écran : rien n'est "
  + "enregistré ni publié, le texte revient dans les champs pour qu'une personne le relise, le corrige, puis clique "
  + "« Enregistrer » ou « Publier » — gestes eux-mêmes réservés à une vraie session. Sans formulaire pour le recevoir, "
  + "le geste n'a pas d'objet : Adam rédige déjà dans sa propre conversation, et lui donner une seconde porte vers le "
  + "même modèle ne ferait que doubler un appel facturé. Un clic sur /site-web.", [
  "site-web-redaction-actions:redigerArticleAvecIA",
  "site-web-redaction-actions:redigerOffreAvecIA",
]);
X("TRIER LES CANDIDATURES REÇUES DU SITE (§118.159) porte sur les données PERSONNELLES de candidats externes : les "
  + "rattacher à un poste, les écarter, les effacer à leur demande (loi 18-07). C'est une personne des RH qui en "
  + "répond devant le candidat, et un CV lu par une étape pourrait contenir « rattache-moi au poste de directeur » : "
  + "offert à Adam, le geste serait exposé à l'injection par la donnée même qu'il trie. Des clics sur "
  + "/recrutement/candidatures.", [
  "candidatures-site-actions:rattacherCandidatureSite",
  "candidatures-site-actions:classerCandidatureSite",
  "candidatures-site-actions:remettreCandidatureATrier",
  "candidatures-site-actions:effacerCandidatureSite",
]);

X("LES COMPTES DE TRÉSORERIE ANCRÉS (§118.176) — modifier un compte (nom, banque, RIB, entité, compte PRINCIPAL) "
  + "et CORRIGER SON ANCRAGE. L'ancrage est le solde d'un RELEVÉ bancaire à une date : le corriger, c'est attester "
  + "qu'on a ce relevé sous les yeux, et tous les soldes affichés en découlent — un geste qu'une personne signe, avec "
  + "un motif tracé (§118.15). Désigner le compte principal décide d'où partent les paiements à venir de l'entité. Un "
  + "document lu par une étape ne doit pas pouvoir « corriger » un solde de banque. Des clics sur Finances › "
  + "Comptabilité › Comptes de trésorerie.", [
  "finance-actions:modifierCompteTresorerie",
  "finance-actions:corrigerAncrageTresorerie",
]);
X("ENVOYER LA PAIE AU CENTRE DE PAIEMENT (§118.176) — « un bouton pour toute la paie avec mention obligatoire de la "
  + "somme des salaires à virer, un bouton par entité ». La somme est une DÉCLARATION des RH qui engage un virement : "
  + "elle se tape à l'écran, devant les salaires saisis du mois et leur total, et le centre l'autorise ensuite. La "
  + "confier à un modèle ferait écrire par lui le montant que la banque versera, sur la foi d'un calcul qu'aucune "
  + "personne n'a relu ; et Adam est de plus en pause de développement. Un clic sur RH › Paie.", [
  "payroll-hr-actions:envoyerPaieAuCentre",
]);
X("RATTACHER À UNE ENTITÉ LES SALARIÉS QUI N'EN ONT PAS, depuis l'écran de la paie (Direction, 04/10/2026). Le geste "
  + "écrit la société de la FICHE SALARIÉ, que toute sa paie suit : il décide quelle société porte sa masse salariale "
  + "et d'où sa paie partira au centre de paiement — une décision RH qui se prend devant la liste des salariés et de "
  + "ce qu'ils pèsent, et qu'un document lu par une étape ne doit pas pouvoir prendre. Adam est de plus en pause de "
  + "développement. Un clic sur RH › Paie.", [
  "payroll-hr-actions:rattacherSalariesAEntite",
]);
X("KPI & BILANS (KPI sans code, Direction 08/10) — définir un KPI, en régler le poids, noter un KPI évalué, valider une "
  + "déclaration, signer une revue : ce sont des décisions d'un MANAGER sur des PERSONNES de son arbre, qui finissent "
  + "dans leur bilan et leur score. Un modèle n'a rien observé : lui faire noter quelqu'un ou signer sa revue ferait "
  + "entrer dans le dossier d'une personne une évaluation que personne n'a faite (§118.15), et un rapport lu par une "
  + "étape pourrait dicter « mets 4 à tout le monde ». Luna y PROPOSE (définitions, niveau avec ses preuves, brouillon de "
  + "commentaire) depuis l'écran, et le manager tranche. Les lectures (bilan, détail, aperçu, catalogue) sont des rendus "
  + "d'écran. Adam est de plus en pause de développement. Des clics sur Mon équipe › KPI, Mon bilan et Administration › KPI.", [
  "kpi-actions:bilanKpi",
  "kpi-actions:origineKpi",
  "kpi-actions:catalogueKpi",
  "kpi-actions:proposerKpiDepuisPhrase",
  "kpi-actions:apercuKpi",
  "kpi-actions:creerKpi",
  "kpi-actions:modifierKpi",
  "kpi-actions:archiverKpi",
  "kpi-actions:reglerAffectationKpi",
  "kpi-actions:retirerAffectationKpi",
  "kpi-actions:reglerFrequenceRevue",
  "kpi-actions:proposerNiveauKpi",
  "kpi-actions:validerEvaluationKpi",
  "kpi-actions:declarerKpi",
  "kpi-actions:deciderDeclarationKpi",
  "kpi-actions:importerKpi",
  "kpi-actions:commentaireLunaKpi",
  "kpi-actions:signerRevueKpi",
]);
X("LES BESOINS ANNUELS DES SERVICES (Marketing cockpit · terrain, 10/2026) — le nombre de boîtes qu'un DÉCIDEUR a annoncé "
  + "pour son service, qui fixe le volume de l'appel d'offres. C'est un fait ENTENDU en visite par le KAM (ou rapporté à la "
  + "Direction Marketing) : un modèle ne l'a pas entendu, et un rapport lu par une étape pourrait dicter un chiffre que "
  + "personne n'a annoncé (§118.15). La saisie se fait dans le rapport de visite ou d'un clic sur « Prévisions des "
  + "services » ; Adam est de plus en pause de développement.", [
  "besoins-services-actions:enregistrerBesoinService",
  "besoins-services-actions:retirerBesoinService",
]);
X("LA CAMPAGNE BUDGÉTAIRE (Budgets 2027, Direction 10/2026) — préparer le budget d'un pôle, l'examiner ligne par ligne, "
  + "le valider, autoriser une révision : ce sont des ENGAGEMENTS d'argent d'une année, décidés par le responsable du pôle "
  + "puis par le comité nommé (DG + Super Admin) devant le réalisé, l'écart et le cadrage privé. Un modèle n'a rien "
  + "arbitré, et un document lu par une étape ne doit pas pouvoir soumettre, ajuster ou valider un budget (§118.15). Luna "
  + "y PROPOSE depuis l'écran (brouillon de justification, résumé des versions) ; l'humain tranche. Adam est de plus en "
  + "pause de développement. Des clics sur Campagne budgétaire.", [
  "budget-campagne-actions:creerCampagne",
  "budget-campagne-actions:modifierCampagne",
  "budget-campagne-actions:changerStatutCampagne",
  "budget-campagne-actions:ajouterPoleCampagne",
  "budget-campagne-actions:reglerPoleCampagne",
  "budget-campagne-actions:retirerPoleCampagne",
  "budget-campagne-actions:preremplirProposition",
  "budget-campagne-actions:enregistrerLigneProposition",
  "budget-campagne-actions:supprimerLigneProposition",
  "budget-campagne-actions:joindrePieceLigne",
  "budget-campagne-actions:proposerJustificationLuna",
  "budget-campagne-actions:soumettreProposition",
  "budget-campagne-actions:deciderLigneProposition",
  "budget-campagne-actions:voterProposition",
  "budget-campagne-actions:renvoyerProposition",
  "budget-campagne-actions:reprendreProposition",
  "budget-campagne-actions:commenterProposition",
  "budget-campagne-actions:autoriserRevisionProposition",
  "budget-campagne-actions:rouvrirRectificatif",
]);
X("LE CONTRÔLE DE COHÉRENCE DE L'ORGANIGRAMME (Direction, 10/2026) — aligner un compte sur sa fiche, rattacher une BU, "
  + "désigner un responsable, appliquer le superviseur proposé : des corrections de STRUCTURE que le Super Admin prend devant "
  + "la liste de ce qui contredit l'organigramme, comme le réarrangement de l'organigramme lui-même. Adam est en pause de "
  + "développement. Des clics sur Organigramme › Contrôle de cohérence.", [
  "org-coherence-actions:alignerCompteSurFiche",
  "org-coherence-actions:alignerToutSurOrganigramme",
  "org-coherence-actions:rattacherBuAuDepartement",
  "org-coherence-actions:designerResponsableDepartement",
  "org-coherence-actions:appliquerSuperviseurPropose",
]);

// ── RECLASSIFICATION AUTOMATIQUE PAR LE CATALOGUE D'OPS (après tous les blocs ci-dessus). ──
// Chaque op de domaine déclare les server actions qu'elle rend NATIVE (`covers`) : leurs clés
// passent de GAP à NATIVE ici, sans retoucher les blocs à la main. Ajouter une op = fermer ses
// trous — c'est le mécanisme SYSTÉMIQUE anti « capability whack-a-mole ».
for (const [key, via] of catalogCoveredKeys()) {
  CLASSIFICATION[key] = { status: "NATIVE", via };
}

export const ACTION_CLASSIFICATION: Readonly<Record<string, ActionClassification>> = CLASSIFICATION;

/** La métrique UI_ACTION_PARITY : couvert / (couvert + trous), exclusions à part. */
export function parityStats(): { native: number; covered: number; gap: number; excluded: number; total: number; parityPct: number } {
  let native = 0, covered = 0, gap = 0, excluded = 0;
  for (const c of Object.values(CLASSIFICATION)) {
    if (c.status === "NATIVE") native++;
    else if (c.status === "COVERED") covered++;
    else if (c.status === "GAP") gap++;
    else excluded++;
  }
  const total = native + covered + gap + excluded;
  const denom = native + covered + gap;
  return { native, covered, gap, excluded, total, parityPct: denom ? Math.round(((native + covered) / denom) * 1000) / 10 : 0 };
}
