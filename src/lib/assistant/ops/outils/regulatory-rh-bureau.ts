import { type DomainToolSpec, zipOps, opsSummary, opEnum } from "./assemblage";
import { REGULATORY_OPS_IMPL } from "../impl-regulatory";
import { HR_OPS_IMPL } from "../impl-hr";
import { HR2_OPS_IMPL, ACCESS_OPS_IMPL } from "../impl-hr2";
import { RECRUIT_TRAINING_OPS_IMPL } from "../impl-wave2b";
import { LEGAL3_OPS_IMPL, MAIL3_OPS_IMPL } from "../impl-wave3";
import { MEETING_OPS_IMPL } from "../impl-meeting";
import { MAIL_OPS_IMPL } from "../impl-mail";
import { LEGAL_OPS_IMPL } from "../impl-legal";
import { ORG_OPS_IMPL } from "../impl-org";
import { REG4_OPS_IMPL } from "../impl-wave4";
import { RANGE_OPS_IMPL } from "../impl-wave4b";
import { MEETING7_OPS_IMPL } from "../impl-wave7b";
import { MESSAGING7_OPS_IMPL, REGREMINDER_OPS_IMPL } from "../impl-wave7c";
import { ORG7D_OPS_IMPL, LEGAL7D_OPS_IMPL } from "../impl-wave7d";
import { FILE_ORG_OPS_IMPL } from "../impl-wave8-files";

/**
 * OUTILS DE DOMAINE — Regulatory, RH, messagerie, réunions, courriers, Legal et organisation.
 *
 * Morceau de `DOMAIN_TOOLS` (`../index.ts`), recomposé dans l'ordre d'origine : l'ordre des outils
 * fait partie du prompt de l'IA. Chaque entrée zippe le catalogue avec ses implémentations.
 */
export const OUTILS_REGULATORY_RH_BUREAU: Record<string, DomainToolSpec> = {
  regulatory_operation: {
    module: "REGULATORY",
    ops: zipOps("regulatory_operation", { ...REGULATORY_OPS_IMPL, ...REG4_OPS_IMPL, ...REGREMINDER_OPS_IMPL }),
    def: {
      name: "regulatory_operation",
      description:
        "DOSSIERS REGULATORY au-delà des champs simples — création de dossier, participants, commentaires, détail des étapes de la chronologie, checklist de présoumission, variations de fabrication, BV, classement (entité/segments/projet BD), par les actions canoniques (verrous Super Admin inclus). "
        + `Champ « op » : ${opsSummary("regulatory_operation")}. `
        + "Le dossier se donne par référence REG-AAAA-NNN ou DCI. (Les champs simples — statut, priorité, dates, chargé du dossier, étapes ANPP — ont leurs outils dédiés : update_regulatory_product, assign_regulatory_responsible, set_regulatory_step.)",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("regulatory_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Référence (REG-AAAA-NNN) ou DCI du dossier visé." },
          dci: { type: "string", description: "create_product : la DCI (obligatoire)." },
          entity: { type: "string", description: "Nom de l'entité (create_product : obligatoire ; set_classification : changement, Super Admin)." },
          people: { type: "string", description: "set_participants : noms séparés par des virgules (liste REMPLACÉE)." },
          comment: { type: "string", description: "add_comment : le commentaire." },
          step: { type: "string", description: "update_step_details / set_step_note : libellé OU numéro (1–22) de l'étape (ex. « Dépôt du dossier », « 5 »)." },
          status: { type: "string", description: "Statut visé (étape : fait/en cours/bloqué/en retard ; variation : obtenue/en attente/annulée)." },
          item: { type: "string", description: "set_checklist_item : libellé du document de la checklist." },
          checked: { type: "string", description: "set_checklist_item : « décocher » pour retirer (défaut : cocher)." },
          target: { type: "string", description: "create_variation : cible (secondary/primary packaging, full process)." },
          manufacturer: { type: "string", description: "create_variation : fabricant (obligatoire pour une fabrication locale)." },
          amount: { type: "string", description: "request_bv : montant ATTENDU du bon (DZD) ; request_quittance : montant RÉEL de la quittance (DZD)." },
          bvType: { type: "string", description: "request_bv : BV, BV1, BV2… (défaut BV)." },
          segments: { type: "string", description: "set_classification : segments thérapeutiques séparés par des virgules (liste REMPLACÉE)." },
          project: { type: "string", description: "set_classification : PROJET BD du dossier — le nom d'un projet de Business Development › Projets. « aucun » retire le classement. Un nom qui correspond à plusieurs projets est refusé, pas deviné." },
          brandName: { type: "string", description: "create_product : nom de marque." },
          form: { type: "string", description: "create_product : forme pharmaceutique." },
          dosage: { type: "string", description: "create_product : dosage." },
          partnerLab: { type: "string", description: "create_product : laboratoire partenaire." },
          responsibleName: { type: "string", description: "create_product : chargé du dossier (nom)." },
          targetSubmissionDate: { type: "string", description: "create_product : date cible de dépôt (AAAA-MM-JJ)." },
          plannedDate: { type: "string", description: "update_step_details : date planifiée (AAAA-MM-JJ)." },
          actualDate: { type: "string", description: "update_step_details : date réelle (AAAA-MM-JJ)." },
          missingDocs: { type: "string", description: "update_step_details : pièces manquantes." },
          responsible: { type: "string", description: "update_step_details : responsable de l'étape (texte)." },
          date: { type: "string", description: "Date libre (dépôt de variation, décision…) AAAA-MM-JJ." },
          dueDate: { type: "string", description: "request_quittance : échéance demandée (AAAA-MM-JJ)." },
          note: { type: "string", description: "Note libre (set_step_note : « aucune » pour l'effacer)." },
          notes: { type: "string", description: "create_product / create_supplier : commentaires." },
          name: { type: "string", description: "create_supplier : nom du fournisseur ; link/unlink_catalog_product : produit du catalogue (DCI BD ou nom promo)." },
          country: { type: "string", description: "create_supplier : pays." },
          contact: { type: "string", description: "create_supplier : e-mail de contact." },
          kind: { type: "string", description: "link/unlink_catalog_product : catalogue visé (BD ou promotion) si le nom est ambigu." },
        },
        required: ["op"],
      },
    },
  },
  hr_operation: {
    module: "RH",
    ops: zipOps("hr_operation", { ...HR_OPS_IMPL, ...HR2_OPS_IMPL, ...RECRUIT_TRAINING_OPS_IMPL }),
    def: {
      name: "hr_operation",
      description:
        "RH COMPLET — fiche employé (créer, PATCH hors salaire, rémunération dédiée), congés (déposer/corriger/décider, intérimaire), avances, notes de frais, demandes RH du dossier personnel (attestations, absences, entrevues, documents), formations, recrutement — par les actions canoniques (les CHAÎNES de validateurs restent le moteur : si ce n'est pas votre tour, l'exécution refuse en le disant). "
        + `Champ « op » : ${opsSummary("hr_operation")}. `
        + "La cible se donne par NOM D'EMPLOYÉ (« employee »). Les MODIFICATIONS de fiche sont des PATCH : seuls les champs cités changent, le reste est rejoué à l'identique (garde de fraîcheur).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("hr_operation"), description: "Le geste à faire." },
          employee: { type: "string", description: "Nom de l'employé concerné (registre RH)." },
          decision: { type: "string", description: "Décisions : approuver/accorder ou refuser (note de frais : « mois suivant » possible)." },
          status: { type: "string", description: "process_hr_request : en préparation, prête, remise, accordée, refusée ; set_employee_active : actif/inactif." },
          label: { type: "string", description: "decide_training / decide_recruitment_step : intitulé ; documents du dossier : nom du fichier." },
          reference: { type: "string", description: "decide_recruitment_step : référence exacte de la demande." },
          note: { type: "string", description: "Note / motif de la décision." },
          name: { type: "string", description: "create_employee : nom complet ; documents du dossier : nom du fichier." },
          newName: { type: "string", description: "update_employee : nouveau nom complet." },
          position: { type: "string", description: "Poste / fonction." },
          email: { type: "string", description: "E-mail de l'employé." },
          phone: { type: "string", description: "Téléphone." },
          iban: { type: "string", description: "RIB / IBAN." },
          address: { type: "string", description: "Adresse." },
          nationalId: { type: "string", description: "N° pièce d'identité." },
          cnasNumber: { type: "string", description: "N° CNAS." },
          hireDate: { type: "string", description: "Date d'embauche (AAAA-MM-JJ)." },
          birthDate: { type: "string", description: "Date de naissance (AAAA-MM-JJ)." },
          contractType: { type: "string", description: "Contrat : CDI, CDD, intérim, stage, freelance, consulting." },
          contractStart: { type: "string", description: "Début de contrat (AAAA-MM-JJ)." },
          contractEnd: { type: "string", description: "Fin de contrat (AAAA-MM-JJ)." },
          trialStart: { type: "string", description: "Début de période d'essai (AAAA-MM-JJ)." },
          trialEnd: { type: "string", description: "Fin de période d'essai (AAAA-MM-JJ)." },
          leaveBalance: { type: "string", description: "update_employee : solde de congés (jours)." },
          baseSalary: { type: "string", description: "Salaire de base DZD (création ; modification par update_employee_salary)." },
          gross: { type: "string", description: "update_employee_salary : brut DZD." },
          net: { type: "string", description: "update_employee_salary : net à payer DZD." },
          employerCost: { type: "string", description: "update_employee_salary : coût employeur DZD." },
          amount: { type: "string", description: "request_advance : montant DZD." },
          startDate: { type: "string", description: "Congé : début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "Congé : fin (AAAA-MM-JJ)." },
          days: { type: "string", description: "Congé : nombre de jours (défaut : calculé)." },
          type: { type: "string", description: "Congé : annuel, maladie, sans solde, maternité, exceptionnel, récupération ; demandes RH : type (attestation, note de frais, entrevue…)." },
          reason: { type: "string", description: "Motif (congé, avance)." },
          message: { type: "string", description: "comment_hr_request : le message." },
          date: { type: "string", description: "propose_hr_meeting : date proposée (AAAA-MM-JJ)." },
          time: { type: "string", description: "propose_hr_meeting : heure d'Alger (HH:MM, défaut 09:00)." },
          standIn: { type: "string", description: "propose_stand_in : l'intérimaire (nom) — « aucun » pour retirer." },
          mode: { type: "string", description: "set_employee_document_visibility : « masquer » ; invite_training_participants : « convoquer » (présence requise)." },
          headcount: { type: "string", description: "create_recruitment : nombre de postes (défaut 1)." },
          salaryMin: { type: "string", description: "create_recruitment : bas de fourchette DZD." },
          salaryMax: { type: "string", description: "create_recruitment : haut de fourchette DZD." },
          missions: { type: "string", description: "create_recruitment : missions du poste." },
          skills: { type: "string", description: "create_recruitment : compétences attendues." },
          candidate: { type: "string", description: "Candidat visé (nom) — move_recruitment_candidate." },
          question: { type: "string", description: "ask_recruitment_info : la question au demandeur." },
          answer: { type: "string", description: "answer_recruitment_info : la réponse." },
          provider: { type: "string", description: "Formations : organisme / formateur." },
          location: { type: "string", description: "Formations : lieu." },
          description: { type: "string", description: "Formations : descriptif." },
          people: { type: "string", description: "invite_training_participants : noms séparés par des virgules." },
          newLabel: { type: "string", description: "update_training : nouvel intitulé." },
        },
        required: ["op"],
      },
    },
  },
  messaging_operation: {
    module: "MESSAGING",
    ops: zipOps("messaging_operation", MESSAGING7_OPS_IMPL),
    def: {
      name: "messaging_operation",
      description:
        "MESSAGERIE interne — groupes et canaux (création, fiche en FUSION, membres, rôles, quitter, archiver, rejoindre), messages (modifier LE SIEN, supprimer / modérer, réactions, épingles visibles de tous, signets personnels — désignés par EXTRAIT, « dernier » accepté), réglages PERSONNELS par conversation (épingler dans MA liste, sourdine, niveau de notification), statut de présence façon Teams — par les actions canoniques. Pour ENVOYER un message : send_message. "
        + `Champ « op » : ${opsSummary("messaging_operation")}. `
        + "La conversation se donne par NOM de groupe / canal, ou par la personne (« target »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("messaging_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La conversation visée (nom du groupe / canal, ou la personne du direct)." },
          name: { type: "string", description: "create_group / create_channel : le nom ; join_channel : le canal." },
          newName: { type: "string", description: "update_conversation : nouveau nom." },
          people: { type: "string", description: "Membres (noms, virgules) — création, ajout." },
          person: { type: "string", description: "remove_member / set_member_role : la personne visée." },
          role: { type: "string", description: "set_member_role : admin ou membre." },
          comment: { type: "string", description: "Messages : l'EXTRAIT qui désigne le message (« dernier » accepté)." },
          note: { type: "string", description: "edit_message : le nouveau texte ; set_messaging_status : le message personnel." },
          emoji: { type: "string", description: "toggle_reaction : l'émoji (défaut 👍)." },
          mode: { type: "string", description: "set_notify_level : tout / mentions / rien ; archive_conversation : « désarchiver » pour rouvrir." },
          status: { type: "string", description: "set_messaging_status : disponible, occupé, ne pas déranger, de retour bientôt, absent, hors ligne, ou « automatique »." },
          notes: { type: "string", description: "create_channel / update_conversation : le sujet." },
        },
        required: ["op"],
      },
    },
  },
  meeting_operation: {
    module: "MESSAGING",
    ops: zipOps("meeting_operation", { ...MEETING_OPS_IMPL, ...MEETING7_OPS_IMPL }),
    def: {
      name: "meeting_operation",
      description:
        "RÉUNIONS — planifier (visio ou présentiel, heure d'Alger), répondre à une invitation, inviter / retirer des participants, écrire dans le fil (message supprimable par extrait), MODIFIER la fiche (FUSION, horaire d'Alger rejoué), poser le lien, démarrer, terminer, supprimer, lancer un APPEL depuis une conversation, coller la transcription puis générer le COMPTE RENDU IA et trancher ses tâches proposées une à une — par les actions canoniques (les gestes de gestion sont réservés à l'ORGANISATEUR). "
        + `Champ « op » : ${opsSummary("meeting_operation")}. `
        + "La réunion se donne par TITRE. Pour un simple rendez-vous d'agenda personnel : create_calendar_event.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("meeting_operation"), description: "Le geste à faire." },
          title: { type: "string", description: "Titre de la réunion (création ou cible)." },
          date: { type: "string", description: "create : date (AAAA-MM-JJ)." },
          time: { type: "string", description: "create : heure d'Alger (HH:MM, défaut 09:00)." },
          people: { type: "string", description: "create / add_participants : noms séparés par des virgules." },
          mode: { type: "string", description: "create : « visio » (défaut) ou « présentiel »." },
          location: { type: "string", description: "create : lieu (présentiel)." },
          description: { type: "string", description: "create : ordre du jour." },
          response: { type: "string", description: "respond_invite : accepter, décliner ou peut-être." },
          comment: { type: "string", description: "post_message : le message à poster ; delete_meeting_message : l'EXTRAIT qui le désigne." },
          newName: { type: "string", description: "update_meeting : nouveau titre." },
          link: { type: "string", description: "Lien de réunion (set_meeting_link, update_meeting)." },
          transcript: { type: "string", description: "save_meeting_transcript : la transcription collée." },
          label: { type: "string", description: "accept/dismiss_meeting_proposal : la tâche proposée visée (intitulé)." },
          person: { type: "string", description: "remove_meeting_participant : le participant (nom)." },
          target: { type: "string", description: "start_call : la conversation (nom du groupe / canal, ou la personne)." },
        },
        required: ["op"],
      },
    },
  },
  mail_operation: {
    module: "MAIL_REGISTER",
    ops: zipOps("mail_operation", { ...MAIL_OPS_IMPL, ...MAIL3_OPS_IMPL }),
    def: {
      name: "mail_operation",
      description:
        "REGISTRE DES COURRIERS — enregistrer un pli (entrant/sortant), corriger, classer dans un dossier, déclarer un fichier Drive en courrier (référence SANS copie), RELIER un pli aux affaires qu'il concerne (marché PCH, BC, contrat, dossier Regulatory), par les actions canoniques (cloisonnement par entité et anti-doublon inclus). "
        + `Champ « op » : ${opsSummary("mail_operation")}. `
        + "La cible se donne par n° de chrono ou par objet.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("mail_operation"), description: "Le geste à faire." },
          label: { type: "string", description: "Objet du courrier (création) ou objet de la cible." },
          reference: { type: "string", description: "N° de chrono de la cible (move_entries : plusieurs, séparés par des virgules)." },
          direction: { type: "string", description: "entrant/arrivée ou sortant/départ." },
          sender: { type: "string", description: "Expéditeur." },
          recipient: { type: "string", description: "Destinataire." },
          folder: { type: "string", description: "move_entries : nom du dossier de classement (« Non classés » pour sortir)." },
          name: { type: "string", description: "attach_drive : nom du fichier Drive à déclarer." },
          newLabel: { type: "string", description: "edit_entry : nouvel objet." },
          newReference: { type: "string", description: "edit_entry : nouveau n° de chrono." },
          notes: { type: "string", description: "Notes." },
          kind: { type: "string", description: "set_date : « reçu le » ou « accusé de réception » ; partenaires : nature ; link_record : type de cible (marché PCH, bon de commande, facture, document légal, dossier Regulatory)." },
          target: { type: "string", description: "link_record / unlink_record : la cible du lien (référence AO, n° de BC, titre du contrat, référence ou DCI du dossier)." },
          date: { type: "string", description: "set_date : la date (AAAA-MM-JJ) — « aucune » pour l'effacer." },
          parent: { type: "string", description: "create_folder : dossier parent (sous-dossier)." },
          piece: { type: "string", description: "Pièces : libellé de la pièce visée (update/delete_piece)." },
          contact: { type: "string", description: "Partenaires : personne à demander / contact." },
          message: { type: "string", description: "set_signature : la signature (« mode » = retirer pour l'effacer)." },
          mode: { type: "string", description: "update_partner : activer/désactiver ; set_signature : « retirer »." },
        },
        required: ["op"],
      },
    },
  },
  legal_operation: {
    module: "LEGAL",
    ops: zipOps("legal_operation", { ...LEGAL_OPS_IMPL, ...LEGAL3_OPS_IMPL, ...LEGAL7D_OPS_IMPL }),
    def: {
      name: "legal_operation",
      description:
        "DOCUMENTS LÉGAUX — renouveler (chaîne), annuler, régler les LECTEURS (le déposant choisit, nul autre ne voit), envoyer une facture au règlement, BRANCHER une pièce existante sur une fiche Ad & Pro (jamais la recréer) ou l'en détacher, par les actions canoniques. "
        + `Champ « op » : ${opsSummary("legal_operation")}. `
        + "Le document se donne par titre ou référence. (Créer/modifier un document : create_legal_document / update_legal_document.)",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("legal_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Titre ou référence du document visé." },
          label: { type: "string", description: "Alias de reference (titre du document)." },
          startDate: { type: "string", description: "renew : début de la nouvelle période (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "renew : fin de la nouvelle période (AAAA-MM-JJ)." },
          people: { type: "string", description: "set_readers : lecteurs, noms séparés par des virgules (liste REMPLACÉE)." },
          note: { type: "string", description: "cancel : motif de l'annulation." },
          notes: { type: "string", description: "renew : notes du nouveau document." },
          name: { type: "string", description: "attach_drive : nom du fichier Drive à déclarer." },
          kind: { type: "string", description: "attach_drive : type (contrat, bon de commande, assurance…)." },
          counterparty: { type: "string", description: "attach_drive : contrepartie." },
          target: { type: "string", description: "link_record : la FICHE Ad & Pro qui recevra la pièce — sa référence (SP-2026-014) ou son intitulé." },
          nature: { type: "string", description: "link_record : nature de la fiche si le nom est ambigu — sponsoring, congrès international, prise en charge nationale, événement, autre, consulting." },
          folder: { type: "string", description: "Dossiers Legal : le dossier visé (« aucun » pour déclasser)." },
          newName: { type: "string", description: "rename_folder : nouveau nom." },
          parent: { type: "string", description: "create_folder : dossier parent." },
          company: { type: "string", description: "save_company_identity : l'entité (votre périmètre)." },
          field: { type: "string", description: "save_company_identity : le champ de la carte (RC, NIF, NIS, RIB, siège social…)." },
          value: { type: "string", description: "save_company_identity : la nouvelle valeur (« aucun » pour vider) — vérifier au caractère près." },
        },
        required: ["op"],
      },
    },
  },
  org_operation: {
    module: "ADMIN",
    ops: zipOps("org_operation", { ...ORG_OPS_IMPL, ...ACCESS_OPS_IMPL, ...RANGE_OPS_IMPL, ...ORG7D_OPS_IMPL, ...FILE_ORG_OPS_IMPL }),
    def: {
      name: "org_operation",
      description:
        "ADMINISTRATION STRUCTURELLE & COMPTES — entités du groupe, départements & organigramme, fournisseurs, annuaire d'entreprise, invitation de compte, matrice d'ACCÈS par module (Super Admin), profil de compte (nom / e-mail de connexion), sessions, setup guidé — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("org_operation")}. `
        + "Les cibles se donnent par NOM (entité, département, employé du registre RH, fournisseur, personne).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("org_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "Nom de l'entité / du département / du fournisseur / du contact / de la personne (création ou cible)." },
          employee: { type: "string", description: "assign_department / assign_manager : nom de l'employé (registre RH)." },
          department: { type: "string", description: "assign_department : département de destination (« aucun » pour détacher) ; update/delete_department : le département visé." },
          manager: { type: "string", description: "assign_manager : nom du N+1 (« aucun » pour retirer)." },
          parent: { type: "string", description: "create_department : département parent (sous-département)." },
          entity: { type: "string", description: "create_department : entité de rattachement (département de tête)." },
          shortName: { type: "string", description: "create_company : nom court." },
          country: { type: "string", description: "create_supplier : pays." },
          email: { type: "string", description: "create_supplier / create_contact : e-mail ; update_user_profile : NOUVEL e-mail de connexion." },
          kind: { type: "string", description: "create_contact : nature (agence, livreur, imprimeur…) ; set_pipeline_access : « consultation » ou « cadenas »." },
          contactName: { type: "string", description: "create_contact : la personne qu'on demande." },
          phone: { type: "string", description: "create_contact : téléphone." },
          address: { type: "string", description: "create_contact : adresse." },
          notes: { type: "string", description: "Notes." },
          person: { type: "string", description: "Comptes & accès : la personne visée (nom du compte)." },
          module: { type: "string", description: "set_module_access : le module (« Finances », « Drive »…)." },
          mode: { type: "string", description: "set_module_access : « défaut » (du rôle) | « bloqué » | personnalisé (via give/take)." },
          give: { type: "string", description: "set_module_access : droits à DONNER (CREATE, UPDATE, DELETE, VALIDATE, EXPORT, UPLOAD — séparés par des virgules)." },
          take: { type: "string", description: "set_module_access : droits à RETIRER (mêmes valeurs)." },
          scope: { type: "string", description: "set_module_access : portée « tout » ou « assigné »." },
          newName: { type: "string", description: "update_user_profile / update_range : nouveau nom." },
          title: { type: "string", description: "update_user_profile : fonction affichée." },
          region: { type: "string", description: "update_user_profile : région." },
          range: { type: "string", description: "Gammes : la gamme visée (create/update/delete_range, set_products_range, set_user_ranges — plusieurs séparées par des virgules ; « aucune » détache/sort)." },
          products: { type: "string", description: "set_products_range / remove_product_from_range : produits (références REG-… ou DCI, virgules)." },
          color: { type: "string", description: "Gammes : couleur." },
          company: { type: "string", description: "Entité visée (accès, orphelins, portée) — nom." },
          head: { type: "string", description: "update_department : responsable (employé, « aucun » pour retirer)." },
          deputy: { type: "string", description: "update_department : adjoint (employé, « aucun » pour retirer)." },
          position: { type: "string", description: "save_org_node : poste affiché." },
          active: { type: "string", description: "update_company / update_company_contact : « actif » ou « inactif »." },
          contact: { type: "string", description: "Champs libres du contact d'entreprise (update_company_contact) : voir aussi kind/contactName/phone/email/address." },
          city: { type: "string", description: "update_company_contact : ville." },
          wilaya: { type: "string", description: "update_company_contact : wilaya." },
          website: { type: "string", description: "update_company_contact : site web." },
          status: { type: "string", description: "update_feedback_status : vu | en cours | traité." },
          target: { type: "string", description: "update_feedback_status : extrait du feedback (« dernier » accepté) ; suppressions définitives : cible." },
          note: { type: "string", description: "update_feedback_status : note de l'admin (notifiée à l'auteur si nouvelle)." },
          type: { type: "string", description: "attach_orphans_to_company / set_row_grants : le TYPE d'enregistrement (libellé écran)." },
          record: { type: "string", description: "set_row_grants : la ligne visée (référence, nom, ou id interne)." },
          role: { type: "string", description: "set_pipeline_access : un rôle (au lieu d'une personne)." },
          feature: { type: "string", description: "update_ai_settings : la fonction IA ; set_feature_stage : la nouveauté." },
          field: { type: "string", description: "update_risk_thresholds : le seuil visé (libellé)." },
          value: { type: "string", description: "Valeur : seuil (nombre), stade de nouveauté (production/test/coupée), bascule IA (activer/couper), portée d'entité." },
          file: { type: "string", description: "upload_letterhead : Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
        },
        required: ["op"],
      },
    },
  },
};
