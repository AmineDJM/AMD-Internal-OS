/**
 * LE CATALOGUE DES OUTILS D'ÉCRITURE — leurs schémas, les ensembles de noms qui gouvernent
 * l'interception (`WRITE_TOOL_NAMES`, `RESOLVER_WRITE_NAMES`) et la liste complète des outils
 * d'une personne (`assistantToolsFor`), bornée par ses droits.
 */

import { sitsOnPaymentCentre, type CurrentUser } from "@/lib/assistant/coeur/erp";
import type { ClaudeToolDef } from "@/lib/models/compat";
import { DOMAIN_TOOL_DEFS } from "@/lib/assistant/ops";
import { powerToolsFor } from "@/lib/assistant/power-tools";
import { HR_REQUEST_TYPES, READ_TOOLS, EXPORT_TOOL, SUPERADMIN_TOOLS } from "@/lib/assistant/outils/catalogue-lecture";
import { SUPERADMIN_WRITE_TOOLS } from "@/lib/assistant/outils/catalogue-superadmin";

const WRITE_TOOLS: ClaudeToolDef[] = [
  {
    name: "update_regulatory_product",
    description:
      "PROPOSE la modification d'UN champ d'UN dossier Regulatory, identifié par sa RÉFÉRENCE (REG-AAAA-NNN). "
      + "N'exécute rien : confirmation requise. Utiliser search_products AVANT pour retrouver la référence exacte. "
      + "Champs modifiables : status, priority, category, channel, brandName, dosage, dosageUnit, "
      + "pharmaceuticalForm, packaging, therapeuticClass, therapeuticSegments, partnerLab, countryOfOrigin, "
      + "deHolder, manufacturer, targetSubmissionDate, targetDate, comments, isLocked. "
      + "Une date se donne en AAAA-MM-JJ (vide pour l'effacer) ; les segments en liste séparée par des virgules ; "
      + "isLocked en oui/non — ATTENTION, un dossier verrouillé devient invisible pour toute l'équipe. "
      + "Pour rattacher des produits à une ENTITÉ, utiliser set_products_company (qui traite un lot).",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence du dossier (ex. REG-2026-014)." },
        field: { type: "string", description: "Nom exact du champ à modifier." },
        value: { type: "string", description: "Nouvelle valeur." },
      },
      required: ["reference", "field", "value"],
    },
  },
  {
    name: "assign_regulatory_responsible",
    description:
      "PROPOSE de CONFIER un dossier Regulatory à une personne (colonne « Chargé du dossier ») — ou de le retirer. "
      + "N'exécute rien : confirmation requise, et la MÊME règle que l'écran s'applique (champ structurel réservé au Super Admin). "
      + "Identifier le dossier par sa RÉFÉRENCE (search_products avant si besoin) et la personne par son NOM (search_people avant si ambigu). "
      + "Donner personName vide pour RETIRER le responsable actuel.",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence du dossier (ex. REG-2026-014)." },
        personName: { type: "string", description: "Nom de la personne à qui confier le dossier — vide pour retirer." },
      },
      required: ["reference"],
    },
  },
  {
    name: "set_regulatory_step",
    description:
      "PROPOSE la mise à jour d'UNE étape du processus ANPP (19 étapes) d'un dossier Regulatory : statut TODO/DOING/DONE/BLOCKED, "
      + "ou — pour l'étape « presub_ans » (réponse de présoumission) — l'AVIS (FAVORABLE / DEFAVORABLE / EN_ATTENTE, qui dérive le statut). "
      + "N'exécute rien : confirmation requise. Étapes (clé) : ctd, presub_checklist, sample, bv25_req, bv25_pay, presub_req, presub_ans, "
      + "modules345, bv75_req, module1, docs_check, bv75_pay, rdv, depot, recevabilite, evaluation, reponses_depot, commission, decision. "
      + "Le cycle des réserves (réception, analyse, transmission, réponses) n'a PLUS d'étapes : il vit dans la FRISE du dossier (allers-retours).",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence du dossier (ex. REG-2026-014)." },
        stepKey: { type: "string", description: "Clé de l'étape (ex. depot, presub_ans)." },
        status: { type: "string", enum: ["TODO", "DOING", "DONE", "BLOCKED"], description: "Nouveau statut (hors avis de présoumission)." },
        outcome: { type: "string", enum: ["FAVORABLE", "DEFAVORABLE", "EN_ATTENTE"], description: "AVIS de présoumission — uniquement pour presub_ans." },
        note: { type: "string", description: "Commentaire d'étape (facultatif)." },
        date: { type: "string", description: "Date de l'étape AAAA-MM-JJ (facultatif)." },
      },
      required: ["reference", "stepKey"],
    },
  },
  {
    name: "set_products_company",
    description:
      "PROPOSE de rattacher des produits Regulatory à une ENTITÉ (société du groupe), en une fois. " +
      "N'exécute rien : l'utilisateur confirme après avoir vu la liste exacte. " +
      "Utiliser search_products AVANT, pour vérifier que le filtre remonte bien les produits voulus. " +
      "Le filtre (`query`, `category`, `onlyWithoutCompany`) est relu à l'exécution : il doit désigner EXACTEMENT le lot voulu.",
    input_schema: {
      type: "object",
      properties: {
        companyName: { type: "string", description: "Nom ou nom court de l'entité de destination (ex. « Adventum », « Pharmagène »)." },
        query: { type: "string", description: "Même terme que search_products : DCI, classe thérapeutique (« oncologie », « biosimilaire »), laboratoire…" },
        category: { type: "string", enum: ["MEDICINE", "MEDICAL_DEVICE"], description: "Restreindre aux médicaments ou dispositifs." },
        onlyWithoutCompany: { type: "boolean", description: "Vrai pour ne rattacher que les produits qui n'ont PAS encore d'entité." },
      },
      required: ["companyName"],
    },
  },
  {
    name: "create_task",
    description:
      "PROPOSE la création d'une tâche — LE MÊME CIRCUIT QUE L'ÉCRAN : pour soi c'est une to-do ; "
      + "pour un COLLÈGUE c'est une DEMANDE DE TÂCHE (il la reçoit en pop-up et l'ACCEPTE ou la REFUSE, "
      + "avec fil d'échange et dépôt du travail). Se PLANIFIE avec dueDate (échéance AAAA-MM-JJ) et une "
      + "priorité. N'exécute rien : confirmation requise. Résoudre d'abord le collègue avec search_people si besoin.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Intitulé clair de la tâche." },
        description: { type: "string", description: "Détails utiles." },
        assigneeName: { type: "string", description: "Nom du collègue à qui la demander (sinon soi-même)." },
        dueDate: { type: "string", description: "Échéance au format AAAA-MM-JJ (planification)." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      },
      required: ["title"],
    },
  },
  {
    name: "request_treasury_update",
    description:
      "PROPOSE de déclencher l'action NATIVE Finances « Demander l'actualisation des soldes » — le même "
      + "bouton que l'écran Finances : les responsables Finances (et le Super Admin) sont notifiés qu'une "
      + "mise à jour des soldes de trésorerie est attendue, avec une précision optionnelle. Relance traçable "
      + "(audit) — les montants ne sont PAS modifiés. Réservé à l'administration (Super Admin / vision "
      + "globale). N'exécute rien : confirmation requise. À UTILISER pour « actualise les soldes », "
      + "« demande les soldes bancaires », « mise à jour de la trésorerie » — JAMAIS une demande "
      + "administrative générique à la place.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Précision jointe (ex. « avant le conseil de lundi — relevés au 10/08 »). Optionnel." },
      },
    },
  },
  {
    name: "advance_workflow",
    description:
      "PROPOSE une DÉCISION sur l'étape courante du circuit d'une demande Ad&Pro (Sponsoring / Prises en "
      + "charge / Événements) : APPROVE (approuver, l'étape suivante s'ouvre), REJECT (refuser — motif "
      + "recommandé), ou SKIP (SAUTER une étape intermédiaire — RAISON OBLIGATOIRE, tracée et notifiée à "
      + "l'étape suivante ; interdit sur la dernière étape). Le MOTEUR revérifie qui a le droit d'agir à "
      + "l'étape courante. Désigner la demande par sa référence (sponsoring) ou son nom (congrès, événement). "
      + "N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "SPONSORING, CONGRESS_INTERNATIONAL, CONGRESS_NATIONAL ou EVENTS (ou libellé français)." },
        reference: { type: "string", description: "Référence ou nom de la demande." },
        action: { type: "string", enum: ["APPROVE", "REJECT", "SKIP"], description: "La décision." },
        note: { type: "string", description: "Motif / note. OBLIGATOIRE pour SKIP." },
        amount: { type: "number", description: "Montant DZD, si l'étape courante l'exige." },
      },
      required: ["category", "reference", "action"],
    },
  },
  {
    name: "request_regulatory_status_update",
    description:
      "PROPOSE d'envoyer une RELANCE « mise à jour de statut demandée » sur UN dossier Regulatory "
      + "(même bouton que la fiche, réservé à la supervision Regulatory : Super Admin + rôles configurés). "
      + "Le responsable, l'assistant et les participants du dossier sont NOTIFIÉS avec un lien vers la fiche "
      + "— c'est une relance traçable, le statut n'est PAS modifié. N'exécute rien : confirmation requise.",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence du dossier (REG-AAAA-NNN)." },
        note: { type: "string", description: "Précision jointe à la relance (optionnel)." },
      },
      required: ["reference"],
    },
  },
  {
    name: "create_admin_request",
    description:
      "PROPOSE la création d'une demande administrative (déplacement/billet, courrier, signature, achat, devis, paiement, visa/invité, autre) — elle va directement à l'assistante de direction ; le demandeur peut y associer des participants à l'écran. N'exécute rien : confirmation requise. Pour un billet d'avion pour un invité, utiliser type=TRAVEL, détailler passager et trajet dans la description, et renseigner startDate/endDate.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["TRAVEL", "MAIL", "SIGNATURE", "PURCHASE", "QUOTE", "PAYMENT", "GUEST_VISA", "OTHER"],
        },
        title: { type: "string", description: "Titre court de la demande." },
        description: { type: "string", description: "Tous les détails (passager, trajet, montant estimé…)." },
        startDate: { type: "string", description: "Date de début / départ au format AAAA-MM-JJ." },
        endDate: { type: "string", description: "Date de fin / retour au format AAAA-MM-JJ." },
        deadline: { type: "string", description: "Échéance au format AAAA-MM-JJ." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      },
      required: ["type", "title"],
    },
  },
  {
    name: "create_dossier",
    description:
      "PROPOSE l'ouverture d'un PROJET pour un sujet à déléguer et suivre dans le temps (ex. « rechercher des prix d'hôtels », « propositions d'hôtels », « analyse IQVIA », « comparer des billets »). À privilégier quand on confie à quelqu'un une recherche / analyse / veille que l'on veut suivre avec des fichiers et une discussion. N'exécute rien : confirmation requise. Résoudre le responsable avec search_people si un nom est cité.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Sujet du dossier, clair et court." },
        description: { type: "string", description: "Le brief : ce qui est attendu, le contexte, l'échéance souhaitée." },
        category: { type: "string", description: "Catégorie libre (Recherche, Hôtels, Billets, Analyse IQVIA, Veille…)." },
        assigneeName: { type: "string", description: "Nom du responsable à qui confier le dossier (sinon laissé à assigner)." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
        dueDate: { type: "string", description: "Échéance au format AAAA-MM-JJ." },
      },
      required: ["title"],
    },
  },
  {
    name: "send_message",
    description:
      "PROPOSE l'envoi d'un message interne (messagerie) à un collègue. N'exécute rien : confirmation requise. Résoudre le destinataire avec search_people d'abord. Réservé aux utilisateurs ayant la messagerie.",
    input_schema: {
      type: "object",
      properties: {
        recipientName: { type: "string", description: "Nom d'UN collègue (une personne, jamais une équipe ni un service : pour écrire à une équipe, lister ses membres avec directory_list et écrire à chacun)." },
        body: { type: "string", description: "Texte du message à envoyer." },
      },
      required: ["recipientName", "body"],
    },
  },
  {
    name: "send_email",
    description:
      "PRÉPARE un e-mail depuis TON adresse et affiche la carte d'approbation — UN SEUL appel suffit, il n'y a rien à préparer ensuite. "
      + "`to` accepte une ADRESSE (nom@domaine.dz) ou un NOM : l'annuaire interne le résout, et rend l'adresse professionnelle vérifiée. "
      + "`subject` et `body` sont FACULTATIFS : sans eux, un objet et un corps sensés sont écrits pour toi (« Prise de nouvelles »). "
      + "Ne demande donc JAMAIS « quel objet ? » ni « quel contenu ? » avant d'appeler cet outil — appelle-le, la carte montre le texte et il se corrige d'un geste. "
      + "`addressHint` sert quand la personne a plusieurs adresses et que le PDG a précisé laquelle (« de Pharmagene », « sa Gmail »). "
      + "Pour écrire à un collègue dans la messagerie INTERNE, préférer send_message.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Adresse e-mail OU nom de la personne (résolu par l'annuaire)." },
        addressHint: { type: "string", description: "Laquelle de ses adresses, si le PDG l'a précisé (« Pharmagene », « Gmail »)." },
        cc: { type: "string", description: "Adresse(s) en copie, séparées par des virgules (optionnel)." },
        subject: { type: "string", description: "Objet du mail. Facultatif — déduit si absent." },
        body: { type: "string", description: "Corps du mail (texte). Facultatif — rédigé si absent." },
      },
      required: ["to"],
    },
  },
  {
    name: "create_congress_request",
    description:
      "PROPOSE une demande de prise en charge de congrès (scope NATIONAL ou INTL), au stade préliminaire (validation Direction ensuite). N'exécute rien : confirmation requise. Réservé aux utilisateurs ayant le module congrès correspondant. Pour un médecin invité, le retrouver avec search_doctors (jamais d'invention).",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["NATIONAL", "INTL"], description: "National ou international." },
        name: { type: "string", description: "Nom de l'événement / congrès." },
        specialty: { type: "string", description: "Spécialité concernée." },
        city: { type: "string", description: "Ville." },
        country: { type: "string", description: "Pays (international)." },
        startDate: { type: "string", description: "Date de début AAAA-MM-JJ." },
        endDate: { type: "string", description: "Date de fin AAAA-MM-JJ." },
        estimatedBudget: { type: "number", description: "Budget estimé en DZD." },
        doctorName: { type: "string", description: "Médecin invité (optionnel), tel que retrouvé via search_doctors." },
        note: { type: "string", description: "Précisions / motif." },
      },
      required: ["scope", "name"],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "PROPOSE la création d'un rendez-vous / réunion / rappel dans le CALENDRIER (fuseau d'Alger), avec invitations de collègues. N'exécute rien : confirmation requise. La date/heure est interprétée à l'heure d'Alger. Pour inviter des collègues, donner leurs noms dans inviteeNames (séparés par des virgules) ; les retrouver avec search_people en cas de doute.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Intitulé du rendez-vous." },
        date: { type: "string", description: "Date AAAA-MM-JJ (heure d'Alger) — ou donner « quand » en français." },
        time: { type: "string", description: "Heure HH:mm (heure d'Alger). Défaut 09:00 si absent." },
        quand: { type: "string", description: "L'échéance EN FRANÇAIS, telle que dite (« jeudi prochain à 10h », « demain 14h30 ») : le moteur calcule date et heure (heure d'Alger). Si l'expression n'est pas comprise à coup sûr, l'outil le dit et il faut alors donner date/time." },
        durationMin: { type: "number", description: "Durée en minutes (optionnel)." },
        allDay: { type: "boolean", description: "Journée entière (sans heure)." },
        kind: { type: "string", enum: ["APPOINTMENT", "MEETING", "REMINDER", "DEADLINE", "INFO", "OTHER"], description: "Type d'événement." },
        location: { type: "string", description: "Lieu (optionnel)." },
        meetLink: { type: "string", description: "Lien visio (optionnel)." },
        description: { type: "string", description: "Détails / ordre du jour (optionnel)." },
        inviteeNames: { type: "string", description: "Noms des collègues à inviter, séparés par des virgules (optionnel)." },
      },
      required: ["title"],
    },
  },
  {
    name: "create_hr_request",
    description:
      "PROPOSE une DEMANDE RH en libre-service POUR LE COMPTE DE L'UTILISATEUR (son propre dossier RH) : note de frais, ordre de mission, titre/attestation de congé, congé annuel/sans solde/exceptionnel/maternité, arrêt maladie, sortie exceptionnelle, attestation de travail/CNAS, relevé des émoluments, domiciliation, entrevue RH. N'exécute rien : confirmation requise. Choisir le `type` exact. Pour une NOTE DE FRAIS, `expenseMonth` (AAAA-MM) est obligatoire. Pour un CONGÉ/absence, indiquer `periodStart` (et `periodEnd` pour les congés). Ne rien inventer : demander les dates/mois manquants à l'utilisateur.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: HR_REQUEST_TYPES, description: "Type de demande RH. Ex. EXPENSE_REPORT = note de frais, MISSION_ORDER = ordre de mission, ANNUAL_LEAVE = congé annuel." },
        details: { type: "string", description: "Précisions / motif / objet de la demande." },
        expenseMonth: { type: "string", description: "Mois concerné par la note de frais, AAAA-MM (obligatoire pour EXPENSE_REPORT)." },
        periodStart: { type: "string", description: "Début du congé / de l'absence, AAAA-MM-JJ (congés & absences)." },
        periodEnd: { type: "string", description: "Fin du congé, AAAA-MM-JJ (congés à jours entiers)." },
      },
      required: ["type"],
    },
  },
  {
    name: "create_sponsoring_request",
    description:
      "PROPOSE une demande de prise en charge de SPONSORING (institution / association / service), au stade préliminaire (validation Direction ensuite). N'exécute rien : confirmation requise. Réservé aux utilisateurs ayant le module Sponsoring. Pour un médecin lié, le retrouver via search_doctors (jamais d'invention).",
    input_schema: {
      type: "object",
      properties: {
        institution: { type: "string", description: "Institution / association / service bénéficiaire (obligatoire)." },
        type: { type: "string", description: "Type de sponsoring (ex. congrès, formation, association…)." },
        specialty: { type: "string", description: "Spécialité concernée." },
        city: { type: "string", description: "Ville." },
        amountRequested: { type: "number", description: "Montant demandé en DZD." },
        product: { type: "string", description: "Produit concerné." },
        doctorName: { type: "string", description: "Médecin lié (optionnel), tel que retrouvé via search_doctors." },
        description: { type: "string", description: "Objet / motif de la demande." },
      },
      required: ["institution"],
    },
  },
  {
    name: "create_event_request",
    description:
      "PROPOSE la création d'un ÉVÉNEMENT EXTERNE (staff, webinaire, congrès, journée — organisé par un tiers, pas par l'entreprise). N'exécute rien : confirmation requise. Réservé aux utilisateurs ayant le module Events.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom de l'événement (obligatoire)." },
        specialty: { type: "string", description: "Spécialité concernée." },
        city: { type: "string", description: "Ville." },
        country: { type: "string", description: "Pays." },
        startDate: { type: "string", description: "Date de début AAAA-MM-JJ." },
        endDate: { type: "string", description: "Date de fin AAAA-MM-JJ." },
        estimatedBudget: { type: "number", description: "Budget estimé en DZD." },
        description: { type: "string", description: "Détails / objet." },
      },
      required: ["name"],
    },
  },
  {
    name: "create_promo_material_request",
    description:
      "Ne crée PLUS de demande de MATÉRIEL PROMOTIONNEL : une demande se compose de lignes piochées dans le catalogue (article, quantité, actions attendues du fournisseur) et se saisit à l'écran, Ad & Pro › Nouvelle demande › Matériel promotionnel. Appeler cet outil rend cette indication, rien d'autre.",
    input_schema: {
      type: "object",
      properties: {
        // Aucun champ n'est exigé : l'outil ne crée rien, il nomme l'écran. Le budget estimé a
        // quitté la demande (décision du 01/10) — le décrire ici le ferait réclamer.
        title: { type: "string", description: "Intitulé du matériel évoqué (facultatif)." },
      },
      required: [],
    },
  },
  {
    name: "decide_payment",
    description:
      "PROPOSE de trancher un PAIEMENT au CENTRE DE PAIEMENT : autoriser (APPROVE) ou refuser (REFUSE) — les deux seules décisions du centre, " +
      "comme à l'écran. Pour demander une révision ou des pièces, écrire au demandeur (send_message) plutôt que trancher. Réservé à qui SIÈGE au centre (PDG, Super Admin). " +
      "N'exécute rien : la carte de confirmation montre le paiement, le montant et la décision avant tout. " +
      "`reference` = la référence de l'ordre (visible au centre de paiement ou via inspect_record).",
    // LE SCHÉMA DIT LA VÉRITÉ DU GESTIONNAIRE : il annonçait REQUEST_CHANGES / REQUEST_INFO et un
    // montant proposé que le centre a retirés (§118-7). Le banc de missions l'a payé : un plan
    // « demander une révision » compilait, puis échouait à l'exécution après l'accord du dirigeant.
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence de l'ordre de dépense à trancher." },
        decision: { type: "string", enum: ["APPROVE", "REFUSE"], description: "La décision : autoriser ou refuser." },
        note: { type: "string", description: "Le motif — OBLIGATOIRE pour REFUSE : le demandeur le lira." },
      },
      required: ["reference", "decision"],
    },
  },
  {
    name: "update_task",
    description:
      "PROPOSE la MODIFICATION d'une tâche existante : réassigner à quelqu'un, changer l'échéance, la priorité ou le statut, ajouter un commentaire. " +
      "N'exécute rien : confirmation requise. `task` = fragment du titre (la tâche la plus récente qui correspond est retenue — vérifier avec inspect_record en cas de doute). " +
      "Ne donner QUE les champs à changer. Statuts : TODO, IN_PROGRESS, DONE (clore), CANCELLED (annuler), TODO pour rouvrir.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Fragment du titre de la tâche à modifier." },
        assigneeName: { type: "string", description: "Nouveau responsable (résoudre via search_people)." },
        dueDate: { type: "string", description: "Nouvelle échéance AAAA-MM-JJ." },
        clearDueDate: { type: "boolean", description: "true pour RETIRER l'échéance." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
        status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"], description: "Nouveau statut (DONE = clore, TODO = rouvrir)." },
        comment: { type: "string", description: "Commentaire à ajouter au fil de la tâche." },
      },
      required: ["task"],
    },
  },
  {
    name: "update_request",
    description:
      "PROPOSE la MODIFICATION d'une demande du secrétariat (REQ-…) : responsable, commentaire. N'exécute rien : confirmation requise. " +
      "Le statut ne se change pas d'ici : le traitement n'a que deux gestes, « Commencer le traitement » et « Fin du traitement », à l'écran de la demande (annuler et rouvrir aussi, avec leur motif).",
    input_schema: {
      type: "object",
      properties: {
        reference: { type: "string", description: "Référence de la demande (REQ-AAAA-NNN) ou fragment du titre." },
        assigneeName: { type: "string", description: "Nouveau responsable (résoudre via search_people)." },
        comment: { type: "string", description: "Commentaire à ajouter au fil de la demande." },
      },
      required: ["reference"],
    },
  },
  {
    name: "create_legal_document",
    description:
      "PROPOSE de DÉCLARER une pièce au module Legal : devis (QUOTE), bon de commande (PURCHASE_ORDER), facture (INVOICE), contrat (CONTRACT), " +
      "accord (AGREEMENT), NDA, assurance (INSURANCE), licence (LICENSE), bail (LEASE), autre (OTHER). N'exécute rien : confirmation requise. " +
      "`chain_from` (référence ou titre de la pièce AMONT) CHAÎNE la pièce : le BC à son devis, la facture à son BC — c'est ce qui rend la chaîne d'achat lisible.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["QUOTE", "PURCHASE_ORDER", "INVOICE", "CONTRACT", "AGREEMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "OTHER"], description: "Nature de la pièce." },
        title: { type: "string", description: "Titre exact de la pièce (obligatoire)." },
        reference: { type: "string", description: "Référence / numéro de la pièce (ex. n° du BC)." },
        counterparty: { type: "string", description: "La partie / le fournisseur." },
        amount: { type: "number", description: "Montant en DZD." },
        startDate: { type: "string", description: "Date de début / d'émission AAAA-MM-JJ." },
        endDate: { type: "string", description: "Date de fin / d'échéance AAAA-MM-JJ." },
        notes: { type: "string", description: "Notes." },
        chain_from: { type: "string", description: "Référence ou titre de la pièce AMONT (devis pour un BC, BC pour une facture)." },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "update_legal_document",
    description:
      "PROPOSE la MODIFICATION d'une pièce Legal existante (titre, référence, partie, montant, dates, notes, chaînage). " +
      "N'exécute rien : confirmation requise. Ne donner QUE les champs à changer — les autres restent tels quels.",
    input_schema: {
      type: "object",
      properties: {
        document: { type: "string", description: "Référence ou fragment de titre de la pièce à modifier." },
        title: { type: "string", description: "Nouveau titre." },
        reference: { type: "string", description: "Nouvelle référence." },
        counterparty: { type: "string", description: "Nouvelle partie." },
        amount: { type: "number", description: "Nouveau montant en DZD." },
        startDate: { type: "string", description: "Nouvelle date de début AAAA-MM-JJ." },
        endDate: { type: "string", description: "Nouvelle date de fin AAAA-MM-JJ." },
        notes: { type: "string", description: "Nouvelles notes." },
        chain_from: { type: "string", description: "Référence / titre de la pièce amont à chaîner." },
      },
      required: ["document"],
    },
  },
  {
    name: "update_calendar_event",
    description:
      "PROPOSE de DÉPLACER ou d'ANNULER un rendez-vous du calendrier (le sien, ou n'importe lequel pour une vue globale). " +
      "N'exécute rien : confirmation requise. `event` = fragment du titre. Pour déplacer : date et/ou time. `cancel`=true pour annuler.",
    input_schema: {
      type: "object",
      properties: {
        event: { type: "string", description: "Fragment du titre du rendez-vous." },
        cancel: { type: "boolean", description: "true = ANNULER le rendez-vous." },
        date: { type: "string", description: "Nouvelle date AAAA-MM-JJ (heure d'Alger)." },
        time: { type: "string", description: "Nouvelle heure HH:MM (heure d'Alger)." },
        durationMin: { type: "number", description: "Nouvelle durée en minutes." },
        location: { type: "string", description: "Nouveau lieu." },
      },
      required: ["event"],
    },
  },
  {
    name: "create_hospital",
    description:
      "PROPOSE d'AJOUTER un hôpital : `registre`=STOCKS pour la liste des lieux de stock (un hôpital de stock DOIT déjà exister dans l'annuaire des établissements ; les annexes PCH sont des noms libres), " +
      "`registre`=ANNUAIRE pour l'annuaire médical (établissements : CHU, EPH, clinique…). N'exécute rien : confirmation requise. " +
      "Vérifier d'abord avec search_hospitals qu'il n'existe pas déjà.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom de l'hôpital / établissement (obligatoire)." },
        registre: { type: "string", enum: ["STOCKS", "ANNUAIRE"], description: "STOCKS = lieux de stock ; ANNUAIRE = annuaire médical." },
        kind: { type: "string", enum: ["HOSPITAL", "ANNEX"], description: "STOCKS uniquement : hôpital ou annexe PCH (défaut HOSPITAL)." },
        type: { type: "string", enum: ["CHU", "EPH", "EHS", "CLINIQUE_PRIVEE", "POLYCLINIQUE", "CABINET", "CENTRE_SANTE", "PHARMACIE", "GROSSISTE", "AUTRE"], description: "ANNUAIRE uniquement : type d'établissement." },
        sector: { type: "string", enum: ["PUBLIC", "PRIVE"], description: "ANNUAIRE uniquement : secteur." },
        wilaya: { type: "string", description: "ANNUAIRE uniquement : wilaya." },
        city: { type: "string", description: "ANNUAIRE uniquement : ville." },
      },
      required: ["name", "registre"],
    },
  },
  {
    name: "update_hospital",
    description:
      "PROPOSE la MODIFICATION d'un établissement de l'ANNUAIRE MÉDICAL (nom, type, secteur, wilaya, ville, téléphone, e-mail, notes, actif). " +
      "N'exécute rien : confirmation requise. Ne donner QUE les champs à changer.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nom actuel (fragment) de l'établissement." },
        newName: { type: "string", description: "Nouveau nom." },
        type: { type: "string", enum: ["CHU", "EPH", "EHS", "CLINIQUE_PRIVEE", "POLYCLINIQUE", "CABINET", "CENTRE_SANTE", "PHARMACIE", "GROSSISTE", "AUTRE"] },
        sector: { type: "string", enum: ["PUBLIC", "PRIVE"] },
        wilaya: { type: "string" },
        city: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        notes: { type: "string" },
        active: { type: "boolean", description: "false pour désactiver l'établissement." },
      },
      required: ["name"],
    },
  },
  {
    name: "update_salary",
    description:
      "PROPOSE une MODIFICATION DE SALAIRE sur la fiche RH d'un employé — NIVEAU CRITIQUE : la carte de confirmation montre l'AVANT, " +
      "l'APRÈS et l'ÉCART, et exige une confirmation renforcée. N'exécute rien. " +
      "TOUJOURS appeler read_payroll AVANT pour connaître les montants actuels et calculer le nouveau montant exact (ex. +10 %). " +
      "Donner UNIQUEMENT les montants à changer, en DZD.",
    input_schema: {
      type: "object",
      properties: {
        employee_name: { type: "string", description: "Nom de l'employé (registre RH)." },
        base_salary: { type: "number", description: "Nouveau salaire de base en DZD." },
        net_to_pay: { type: "number", description: "Nouveau net à payer en DZD." },
        gross_salary: { type: "number", description: "Nouveau brut en DZD." },
        employer_cost: { type: "number", description: "Nouveau coût employeur en DZD." },
        note: { type: "string", description: "Motif / date d'effet (libre) — journalisé." },
      },
      required: ["employee_name"],
    },
  },
  // OUTILS DE DOMAINE (drive_operation, task_operation…) : définitions GÉNÉRÉES du catalogue
  // d'ops (`assistant/ops`) — ajouter une op au catalogue suffit, rien à recopier ici.
  ...DOMAIN_TOOL_DEFS,
  {
    name: "bulk_action",
    description:
      "LOT : la MÊME action d'écriture répétée sur PLUSIEURS cibles, en UNE carte de confirmation (reçus par cible à l'exécution). " +
      "À utiliser dès que la demande porte sur 2+ cibles du même geste (« supprime ces trois dossiers », « demande une tâche à Ali et Sara »). " +
      "tool = l'outil d'écriture à répéter (delete_record, update_regulatory_product, set_regulatory_step, assign_regulatory_responsible, " +
      "request_regulatory_status_update, create_task, drive_operation, task_operation) ; targets = les cibles (le champ qui varie : références, " +
      "noms d'éléments Drive, intitulés, destinataires selon l'outil) ; params = les AUTRES champs de l'outil, communs à toutes les cibles.",
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "L'outil d'écriture à répéter." },
        targets: { type: "array", items: { type: "string" }, description: "Les cibles (2 à 20)." },
        params: { type: "object", description: "Champs communs passés à chaque cible (ex. { kind: \"REGULATORY_PRODUCT\" }, { title: \"…\" }, { op: \"trash\" })." },
      },
      required: ["tool", "targets"],
    },
  },
  {
    name: "action_plan",
    description:
      "PLAN D'ACTIONS ENCHAÎNÉES — une séquence d'écritures DÉPENDANTES en UNE carte de confirmation " +
      "(ex. « crée le dossier Rapports 2026, mets-y le fichier Bilan, partage-le avec Lina »). " +
      "steps = [{tool, input}] dans l'ordre. Un champ d'un step peut valoir « $prev.<champ> » (la valeur de ce champ au step précédent : $prev.name, $prev.title, $prev.reference…) " +
      "ou « $prev.id » (l'id créé) — ce step est alors RÉSOLU À L'EXÉCUTION, après le précédent. La 1re étape ne peut pas dépendre. " +
      "Un maillon refusé ARRÊTE la chaîne (reçu par étape). Pour la MÊME action sur des cibles indépendantes : bulk_action.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Le plan en une phrase (affiché sur la carte)." },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Outil d'écriture de l'étape (drive_operation, create_task, regulatory_operation…)." },
              input: { type: "object", description: "Les champs de l'outil (valeurs « $prev.x » autorisées dès la 2e étape)." },
            },
            required: ["tool", "input"],
          },
          description: "Les étapes, dans l'ordre (2 à 8).",
        },
      },
      required: ["steps"],
    },
  },
];

export const WRITE_TOOL_NAMES = new Set([...WRITE_TOOLS, ...SUPERADMIN_WRITE_TOOLS].map((t) => t.name));

/**
 * CE QUI ÉCRIT, DU POINT DE VUE DU RÉSOLVEUR D'OUTILS.
 *
 * Plus large que `WRITE_TOOL_NAMES` d'UNE chose : les 30 schémas d'opérations par domaine
 * (`drive_operation`, `regulatory_operation`…). Ils écrivent — leur nom le dit et leur
 * `buildProposal` les traite comme tels — mais ils ne figurent pas dans `WRITE_TOOL_NAMES`.
 *
 * DEUX ENSEMBLES PLUTÔT QU'UN, ET C'EST DÉLIBÉRÉ. `WRITE_TOOL_NAMES` gouverne l'interception
 * des écritures et la validation des étapes d'un plan : l'élargir changerait ces deux
 * comportements en même temps que le choix des outils, sans que rien ne le mesure. Le résolveur
 * n'a besoin que de savoir quoi NE PAS DÉCRIRE à une simple question ; il obtient son propre
 * ensemble, et la question de savoir si les outils de domaine devraient rejoindre l'autre est
 * laissée ouverte plutôt que tranchée par effet de bord.
 */
export const RESOLVER_WRITE_NAMES: ReadonlySet<string> = new Set([
  ...WRITE_TOOL_NAMES,
  ...DOMAIN_TOOL_DEFS.map((t) => t.name),
]);

/**
 * LA LISTE COMPLÈTE DES OUTILS D'UNE PERSONNE — une seule définition, trois consommateurs.
 *
 * Les deux boucles (texte diffusé et non diffusé) la construisaient chacune de leur côté, à
 * l'identique. Une divergence entre les deux aurait produit un Adam plus capable à l'écrit qu'à
 * l'oral sans que rien ne le signale. Le script de mesure la lit désormais aussi : le chiffre
 * publié porte sur ce qui est RÉELLEMENT envoyé, pas sur une reconstitution approchée.
 *
 * Les DROITS décident, pas le rôle : `powerToolsFor` et `EXPORT_TOOL` sont bornés par les accès
 * effectifs, et chaque outil revérifie de toute façon à l'exécution.
 */
/**
 * LES ÉCRITURES SOUS CONDITION — montrées seulement à qui a le droit de les exécuter.
 *
 * L'exécution revérifie toujours (l'action du centre refuse qui ne siège pas). Mais MONTRER une
 * capacité à quelqu'un qui ne peut pas s'en servir a un coût mesuré par la matrice
 * permissions × capacités : le planificateur d'une mission la propose, le compilateur l'accepte
 * (« ouverte au catalogue »), et l'étape échoue à l'exécution — un délégué médical voyait
 * `decide_payment`. Une capacité interdite à l'acteur doit être un refus de COMPILATION (§3),
 * donc absente de son catalogue. Le prédicat est LE MÊME que celui de l'exécution.
 */
const ECRITURES_SOUS_CONDITION: Record<string, (user: CurrentUser) => boolean> = {
  decide_payment: (user) => sitsOnPaymentCentre(user),
};

export function assistantToolsFor(user: CurrentUser): ClaudeToolDef[] {
  return [
    ...READ_TOOLS,
    ...powerToolsFor(user),
    EXPORT_TOOL,
    ...(user.role === "SUPER_ADMIN" ? [...SUPERADMIN_TOOLS, ...SUPERADMIN_WRITE_TOOLS] : []),
    ...WRITE_TOOLS.filter((t) => ECRITURES_SOUS_CONDITION[t.name]?.(user) ?? true),
  ];
}
