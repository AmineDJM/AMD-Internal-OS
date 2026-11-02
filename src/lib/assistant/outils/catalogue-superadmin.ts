/**
 * LE CATALOGUE DES OUTILS D'ÉCRITURE DU SUPER ADMIN — interceptés et confirmés comme les autres,
 * montrés seulement au Super Admin (`assistantToolsFor`).
 */

import { DELETE_REGISTRY, DELETABLE_KINDS } from "@/lib/assistant/coeur/erp";
import type { ClaudeToolDef } from "@/lib/models/compat";

// Outils d'ÉCRITURE réservés au Super Admin (interceptés + confirmés, comme les autres).
export const SUPERADMIN_WRITE_TOOLS: ClaudeToolDef[] = [
  {
    name: "create_notification",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE l'envoi d'une NOTIFICATION (diffusion) — à TOUS les comptes actifs, à un RÔLE précis, ou à des PERSONNES précises. N'exécute rien : confirmation requise. Pour des personnes précises, donner leurs noms séparés par des virgules (les résoudre via search_people si besoin). Pour un rôle, donner le libellé du rôle (ex. « Délégué médical », « Coordination », « Comptable »). La notification arrive dans la cloche + en push sur le téléphone des destinataires. Mettre popup=true pour une ANNONCE IMPORTANTE affichée en POP-UP PLEIN ÉCRAN (grande fenêtre centrée, accusé de réception « J'ai compris ») — à réserver aux messages vraiment importants.",
    input_schema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["ALL", "ROLE", "USERS"], description: "ALL = tous les comptes actifs ; ROLE = un rôle ; USERS = des personnes précises." },
        role: { type: "string", description: "Si audience=ROLE : libellé ou code du rôle ciblé." },
        recipientNames: { type: "string", description: "Si audience=USERS : noms des destinataires, séparés par des virgules." },
        title: { type: "string", description: "Titre de la notification." },
        body: { type: "string", description: "Texte du message (optionnel)." },
        link: { type: "string", description: "Lien interne optionnel (ex. /mon-espace, /notifications)." },
        popup: { type: "boolean", description: "true = pop-up plein écran (annonce importante) ; false/absent = cloche + push seulement." },
      },
      required: ["audience", "title"],
    },
  },
  {
    name: "update_platform_setting",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la modification d'un RÉGLAGE de la plateforme. N'exécute rien : "
      + "confirmation requise. Réglages modifiables : aiExternalActionsDisabled (oui/non — ARRÊT D'URGENCE des actions "
      + "externes de l'IA), maxUploadMb, maxDriveUploadMb, driveCapacityGb, "
      + "driveUserQuotaGb, budgetTotalMode (FIXED/FLEXIBLE), budgetFixedTotal, regEnrollmentEnabled (oui/non), "
      + "regulatorySupervisorRoles, regulatoryTherapeuticSegments, regulatoryHiddenColumns, regEnrollmentRoles, driveSpaceCreatorRoles, "
      + "fieldReportsOverviewRoles, orgChartViewerRoles, hiddenModules. "
      + "regulatoryHiddenColumns retire des COLONNES du tableau Regulatory (Suivi de dossiers ET Pipeline) "
      + "pour tout le monde — elles se donnent par leur en-tête (« Classe thérapeutique », « Fournisseur »…), "
      + "et une liste vide les remet toutes. C'est un réglage de la MAISON, pas un masquage d'écran. "
      + "Les listes de rôles et de modules se donnent par leur NOM FRANÇAIS, séparés par des virgules "
      + "(ex. « Direction, Responsable Réglementaire »). Une liste vide retire tout le monde. "
      + "Ces réglages REMPLACENT la valeur existante : lire d'abord la valeur actuelle avec "
      + "read_platform_settings si l'utilisateur veut AJOUTER quelqu'un plutôt que tout remplacer.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Clé exacte du réglage." },
        value: { type: "string", description: "Nouvelle valeur (nombre, oui/non, ou liste séparée par des virgules)." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "delete_record",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la SUPPRESSION DÉFINITIVE d'un enregistrement — LA MÊME "
      + "suppression que le bouton rouge « Supprimer définitivement » des fiches : l'élément, ses pièces "
      + "jointes et ses commentaires disparaissent de tous les écrans, un instantané est déposé dans la "
      + "corbeille (Administration → Corbeille) d'où le Super Admin peut restaurer. Une demande Ad & Pro "
      + "(sponsoring, événement, congrès, matériel promotionnel, consulting, autre demande) et une déclaration "
      + "d'information médicale partent AVEC leurs branches (déclaration, demandes au secrétariat, circuit, "
      + "postes, pièces liées) et reviennent avec elles ; la suppression est refusée si une branche porte un "
      + "règlement, une signature, un dépôt aux autorités ou un courrier inscrit. N'exécute rien : "
      + "confirmation FORTE requise (la référence est à ressaisir). Désigner l'élément par sa référence "
      + "(ex. REG-2026-041), son nom/titre, ou son id interne (visible dans les liens). "
      + "Types supprimables (kind) : "
      + DELETABLE_KINDS.map((k) => `${k} = ${DELETE_REGISTRY[k].label}`).join(" ; ")
      + ". Les types sans référence humaine (ex. HR_REQUEST) se donnent par id interne.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...DELETABLE_KINDS], description: "Type d'enregistrement à supprimer." },
        reference: { type: "string", description: "Référence, nom/titre, ou id interne de l'élément." },
      },
      required: ["kind", "reference"],
    },
  },
  {
    name: "restore_record",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la RESTAURATION d'un élément de la corbeille (Administration → "
      + "Corbeille) — recréé à l'identique (mêmes id/référence) avec ses pièces jointes et commentaires. "
      + "Une demande Ad & Pro revient avec tout ce qui était parti avec elle ; pour les autres types, les "
      + "enfants perdus en cascade ne reviennent pas. N'exécute rien : confirmation requise. "
      + "Désigner l'élément par son nom/référence tel qu'affiché dans la corbeille (et préciser kind si ambigu).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom/référence de l'élément supprimé, tel qu'affiché dans la corbeille." },
        kind: { type: "string", enum: [...DELETABLE_KINDS], description: "Type, pour lever une ambiguïté (optionnel)." },
      },
      required: ["name"],
    },
  },
  {
    name: "purge_record",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la DESTRUCTION RÉELLE d'une entrée de la corbeille — les fichiers "
      + "stockés sont EFFACÉS, il n'y a AUCUN retour possible (contrairement à delete_record qui reste "
      + "restaurable). Confirmation FORTE requise (ressaisie). N'exécute rien. "
      + "Désigner l'entrée par son nom/référence tel qu'affiché dans la corbeille (kind si ambigu).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom/référence de l'entrée de corbeille à détruire." },
        kind: { type: "string", enum: [...DELETABLE_KINDS], description: "Type, pour lever une ambiguïté (optionnel)." },
      },
      required: ["name"],
    },
  },
  {
    name: "set_account_active",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE l'ACTIVATION ou la DÉSACTIVATION d'un compte utilisateur — même "
      + "interrupteur que l'écran Administration. Un compte désactivé ne peut plus se connecter (réversible "
      + "à tout moment). Impossible sur son propre compte. N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        personName: { type: "string", description: "Nom du compte (les comptes INACTIFS sont aussi cherchés — pour réactiver)." },
        active: { type: "boolean", description: "true = activer ; false = désactiver." },
      },
      required: ["personName", "active"],
    },
  },
  {
    name: "configure_workflow",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la RECONFIGURATION d'un CIRCUIT DE VALIDATION Ad&Pro — le même "
      + "builder no-code que l'écran Administration → Circuits. Catégories configurables : SPONSORING, "
      + "CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL, EVENTS (les autres circuits de l'ERP sont codés en dur). "
      + "TOUJOURS appeler read_workflow d'abord, puis renvoyer la LISTE COMPLÈTE des étapes recomposée "
      + "(remplacement intégral) dans `steps` : JSON d'un tableau d'étapes "
      + "{title, slug? (garder les slugs existants pour les étapes conservées), actorScope, actorRoles (CODES "
      + "exacts), powers (CODES : APPROVE/REJECT/ASSIGN/SET_AMOUNT/SET_CATEGORY/COMMENT), notifyRoles?, "
      + "requireAmount?, requireNote?, optional?, autoSkipMaxAmount?, autoApproveIfRequester?}. "
      + "Pour SUPPRIMER une étape : l'omettre. Pour SAUTER une personne durablement : retirer son étape ou son "
      + "rôle. reset=true réinitialise la catégorie au circuit par défaut. N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL ou EVENTS (ou libellé français)." },
        name: { type: "string", description: "Nom du circuit (repris de l'existant si omis)." },
        steps: { type: "string", description: "JSON du tableau COMPLET des étapes (voir description). Ignoré si reset=true." },
        reset: { type: "boolean", description: "true = réinitialiser la catégorie au circuit par défaut." },
      },
      required: ["category"],
    },
  },
  {
    name: "manage_custom_field",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE la gestion d'un CHAMP PERSONNALISÉ d'un module (Administration → "
      + "Champs personnalisés) : CREATE (créer), UPDATE (modifier — dont rendre OBLIGATOIRE ou optionnel, "
      + "renommer, changer les choix), DELETE (retirer — les valeurs déjà saisies restent dans les fiches mais "
      + "ne s'affichent plus). Un champ OBLIGATOIRE doit être rempli pour enregistrer la fiche (appliqué par le "
      + "serveur). Types : TEXT, NUMBER, DATE, BOOLEAN, SELECT (avec options). Modules : Regulatory, "
      + "Sponsoring, Prises en charge, Ventes, Médecins, Visites, Finances, Employés, Congés, Tâches, "
      + "Ordres de dépense, Drive, Demandes administratives… N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["CREATE", "UPDATE", "DELETE"], description: "L'opération." },
        module: { type: "string", description: "Module concerné (libellé français, ex. « Regulatory », « Demandes administratives »)." },
        label: { type: "string", description: "Libellé du champ (existant pour UPDATE/DELETE ; nouveau pour CREATE)." },
        newLabel: { type: "string", description: "UPDATE : nouveau libellé (renommage), optionnel." },
        type: { type: "string", enum: ["TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT"], description: "Type du champ (CREATE ; UPDATE si changement)." },
        options: { type: "string", description: "Choix séparés par des virgules (type SELECT)." },
        required: { type: "boolean", description: "true = champ OBLIGATOIRE ; false = optionnel." },
        order: { type: "number", description: "Ordre d'affichage (optionnel)." },
      },
      required: ["op", "module", "label"],
    },
  },
  {
    name: "set_account_role",
    description:
      "RÉSERVÉ AU SUPER ADMIN : PROPOSE le changement de RÔLE d'un compte (et/ou de son AUTRE RÔLE "
      + "secondaire cumulé) — mêmes règles que l'écran Administration : les droits changent immédiatement, "
      + "le rôle secondaire ne peut jamais être Super Admin (anti-escalade). Donner le rôle par son libellé "
      + "français (ex. « Délégué médical ») ou son code. secondaryRole vide = retirer l'autre rôle. "
      + "N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        personName: { type: "string", description: "Nom du compte." },
        role: { type: "string", description: "Nouveau rôle principal (libellé FR ou code) — omettre pour ne pas changer." },
        secondaryRole: { type: "string", description: "Nouvel « autre rôle » (libellé FR ou code) ; chaîne vide pour le retirer ; omettre pour ne pas changer." },
      },
      required: ["personName"],
    },
  },
];
