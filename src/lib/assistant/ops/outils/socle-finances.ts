import { type DomainToolSpec, zipOps, opsSummary, opEnum } from "./assemblage";
import { CAPABILITY_OPS_IMPL } from "../impl-capabilite";
import { DRIVE_OPS_IMPL } from "../impl-drive";
import { TASK_OPS_IMPL } from "../impl-task";
import { FINANCE_OPS_IMPL } from "../impl-finance";
import { FINANCE_BUDGET_OPS_IMPL } from "../impl-finance-budget";
import { FINANCE_FLOWS_OPS_IMPL } from "../impl-finance-flows";
import { DOCREQ_OPS_IMPL } from "../impl-wave2b";
import { DRIVE3_OPS_IMPL } from "../impl-wave3";
import { REMINDER_OPS_IMPL } from "../impl-wave6";
import { WORKSPACE7_OPS_IMPL } from "../impl-wave7b";
import { WS7D_OPS_IMPL } from "../impl-wave7d";
import { FILE_WS_OPS_IMPL, FILE_FINANCE_OPS_IMPL } from "../impl-wave8-files";

/**
 * OUTILS DE DOMAINE — le rattrapage générique (`capability_operation`), le Drive, les tâches et les finances.
 *
 * Morceau de `DOMAIN_TOOLS` (`../index.ts`), recomposé dans l'ordre d'origine : l'ordre des outils
 * fait partie du prompt de l'IA. Chaque entrée zippe le catalogue avec ses implémentations.
 */
export const OUTILS_SOCLE_FINANCES: Record<string, DomainToolSpec> = {
  // LE RATTRAPAGE GÉNÉRIQUE. Toutes les autres entrées de cette table décrivent un domaine ;
  // celle-ci décrit un MÉCANISME — et c'est ce qui la rend capable d'atteindre ce que personne
  // n'a écrit. Voir `impl-capabilite.ts`.
  capability_operation: {
    module: "ADMIN",
    ops: zipOps("capability_operation", CAPABILITY_OPS_IMPL),
    def: {
      name: "capability_operation",
      description:
        "RATTRAPAGE — exécute une action serveur QUELCONQUE de l'ERP quand aucun outil dédié ne couvre le geste. "
        + "N'exécute rien : propose une carte de confirmation. Utiliser SEULEMENT après avoir cherché un outil dédié, "
        + "qui donnera une meilleure carte. « action » accepte l'identifiant « fichier:fonction » OU, si tu ne le "
        + "connais pas, une description du geste EN FRANÇAIS — le refus te rendra alors les actions candidates avec "
        + "leurs champs exacts, et tu rappelleras l'outil avec le bon identifiant. « champs » est un objet JSON dont "
        + "les clés sont EXACTEMENT celles que le refus ou la fiche annoncent : un champ inventé fait échouer la "
        + "proposition, jamais une écriture silencieuse. Les gestes touchant aux comptes, aux droits, aux sessions "
        + "ou aux réglages sont refusés par conception — ils se font depuis l'écran d'administration.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("capability_operation"), description: "Toujours « run »." },
          action: {
            type: "string",
            description: "L'identifiant « fichier:fonction » de l'action, ou une description du geste en français.",
          },
          champs: {
            type: "string",
            description: 'Les entrées de l\'action, en JSON : {"title":"Achat toner","type":"PURCHASE"}. Vide si elle n\'en prend pas.',
          },
        },
        required: ["op", "action"],
      },
    },
  },
  drive_operation: {
    module: "DRIVE",
    ops: zipOps("drive_operation", { ...DRIVE_OPS_IMPL, ...DRIVE3_OPS_IMPL }),
    def: {
      name: "drive_operation",
      description:
        "ÉCRITURES DRIVE — les gestes de l'écran Drive, par leurs actions canoniques (ACL réelle par élément, cascades, notifications, audit). "
        + `Champ « op » : ${opsSummary("drive_operation")}. `
        + "La cible se donne par NOM (« name ») — la résolution confirme l'élément exact avant toute proposition. "
        + "Les pièces jointes déposées dans ce chat SONT des fichiers Drive : « range ce fichier… » passe par ici.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("drive_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "Nom de l'élément visé — ou nom du nouveau dossier/document pour create_folder/create_office." },
          folder: { type: "string", description: "Dossier parent ou de destination, par nom (« racine » = Drive personnel ; un nom de catégorie vise sa racine)." },
          newName: { type: "string", description: "rename : le nouveau nom." },
          people: { type: "string", description: "share/unshare : noms des personnes, séparés par des virgules." },
          access: { type: "string", description: "share : « lecture » (défaut) ou « modification »." },
          kind: { type: "string", description: "create_office : word, excel ou powerpoint." },
          person: { type: "string", description: "update_space : la personne à qui donner/retirer la lecture." },
          mode: { type: "string", description: "update_space : « retirer » (accès) ; archive_space : « désarchiver » ; update_letterhead : activer/désactiver." },
          icon: { type: "string", description: "Catégories : icône (emoji)." },
          comment: { type: "string", description: "comment/delete_comment : le commentaire (ou un extrait pour le retrouver)." },
        },
        required: ["op", "name"],
      },
    },
  },
  task_operation: {
    module: "WORKSPACE",
    ops: zipOps("task_operation", { ...TASK_OPS_IMPL, ...DOCREQ_OPS_IMPL, ...REMINDER_OPS_IMPL, ...WORKSPACE7_OPS_IMPL, ...WS7D_OPS_IMPL, ...FILE_WS_OPS_IMPL }),
    def: {
      name: "task_operation",
      description:
        "MES TÂCHES & MES RAPPELS — répondre à une demande de tâche et faire avancer les siennes, et les RAPPELS personnels de Mon espace (poser un rappel daté, le terminer, le reporter — défaut +1 jour —, l'annuler), par les actions canoniques de l'écran (notifications au demandeur, audit). "
        + `Champ « op » : ${opsSummary("task_operation")}. `
        + "La tâche se donne par INTITULÉ (« title ») — seules les tâches où le geste est réellement possible sont proposées. Le rappel se donne par son objet (« label »). "
        + "Pour CRÉER ou demander une tâche : create_task.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("task_operation"), description: "Le geste à faire." },
          title: { type: "string", description: "Intitulé (ou morceau d'intitulé) de la tâche visée." },
          reason: { type: "string", description: "refuse : motif du refus (facultatif)." },
          note: { type: "string", description: "submit_work : compte rendu du travail (facultatif)." },
          comment: { type: "string", description: "comment : le message à poster dans le fil." },
          person: { type: "string", description: "request_document : à qui demander la pièce (nom)." },
          label: { type: "string", description: "Demandes de pièces : la pièce visée (« Devis signé »…) ; rappels : l'objet du rappel." },
          target: { type: "string", description: "request_document : l'entité de rattachement (nom d'événement / congrès / sponsoring) — OBLIGATOIRE." },
          kind: { type: "string", description: "request_document : type de l'entité (événement | sponsoring | congrès international | congrès national)." },
          dueDate: { type: "string", description: "request_document : échéance (AAAA-MM-JJ)." },
          date: { type: "string", description: "Rappels : la date du rappel (AAAA-MM-JJ, ou AAAA-MM-JJTHH:MM) — snooze : défaut +1 jour." },
          decision: { type: "string", description: "decide_document_request : accepter ou refuser ; respond_to_calendar_invite : accepter / refuser / peut-être." },
          message: { type: "string", description: "update_comment : le nouveau texte (synonyme de « note »)." },
          module: { type: "string", description: "submit_feedback : module concerné (facultatif)." },
          field: { type: "string", description: "set_custom_field : le champ personnalisé (libellé)." },
          value: { type: "string", description: "set_custom_field : la valeur (« aucun » pour vider ; oui/non pour une case)." },
          record: { type: "string", description: "set_custom_field : la fiche visée (référence, nom, ou id interne) — synonyme de target." },
          reference: { type: "string", description: "delete_own_record : référence du courrier / document légal (synonyme de target)." },
          file: { type: "string", description: "upload_document : Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          category: { type: "string", description: "upload_document : catégorie de la pièce (facultatif, « Autre » par défaut)." },
        },
        required: ["op"],
      },
    },
  },
  finance_operation: {
    module: "FINANCES",
    ops: zipOps("finance_operation", { ...FINANCE_OPS_IMPL, ...FINANCE_BUDGET_OPS_IMPL, ...FINANCE_FLOWS_OPS_IMPL, ...FILE_FINANCE_OPS_IMPL }),
    def: {
      name: "finance_operation",
      description:
        "ÉCRITURES FINANCES & BUDGETS — livre comptable (créer/modifier/supprimer), ordres de dépense (régler, facture, révision), factures, DEMANDES DE PAIEMENT (dossier + pièces + décisions), caisses d'avance, enveloppes/catégories/imputations budgétaires, budgets de département et leurs accès, paie (bulletins, paie RH, transfert budget), Centre de paiement — par les actions canoniques (verrou du Centre de paiement, facture obligatoire et chaînes de validation INCLUS). "
        + `Champ « op » : ${opsSummary("finance_operation")}. `
        + "Montants en DZD. Les cibles se donnent par référence (FIN-…, OD-…, PAY-…, n° de facture) ou libellé ; caisses et budgets par nom de département ; enveloppes/catégories/dépenses par nom ; la paie par nom d'employé + mois. Les UPDATES sont des FUSIONS : seuls les champs cités changent.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("finance_operation"), description: "Le geste à faire." },
          label: { type: "string", description: "Libellé (création) ou libellé/titre de la cible (résolution)." },
          file: { type: "string", description: "Ops a fichier (import_transactions, spend_from_petty_cash, add_payment_piece) : Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          target: { type: "string", description: "add_payment_piece : la demande de paiement (référence PAY-… ou titre)." },
          reference: { type: "string", description: "Référence exacte de la cible (FIN-…, OD-…, PAY-…, n° de facture)." },
          order: { type: "string", description: "create_invoice : bon de commande PCH auquel rattacher la facture (n° de BC, produits ou réf. du marché) — elle apparaîtra alors sur la fiche marché." },
          amount: { type: "string", description: "Montant en DZD (ex. « 1500000 » ou « 1 500 000,50 »)." },
          direction: { type: "string", description: "create_transaction/create_invoice : encaissement/décaissement, reçue/émise." },
          category: { type: "string", description: "Catégorie : de l'écriture (loyer, salaires…) ou budgétaire par NOM (imputations, transfert de paie)." },
          status: { type: "string", description: "Statut visé (prévu / réalisé / annulé ; payée / impayée)." },
          method: { type: "string", description: "create_transaction : espèces, virement, chèque, carte." },
          counterparty: { type: "string", description: "Contrepartie / client / destinataire." },
          date: { type: "string", description: "Date (AAAA-MM-JJ)." },
          dueDate: { type: "string", description: "Échéance (AAAA-MM-JJ)." },
          department: { type: "string", description: "Nom du département (caisse, budget départemental, accès ; « tous » = règle générale)." },
          decision: { type: "string", description: "Décisions : accorder/approuver/ajuster ou refuser ; decide_payment_request : instruire | attente | reprendre | renvoyer | bon à payer | refuser." },
          account: { type: "string", description: "Nom du compte de trésorerie (set_opening_balance, delete_treasury_account)." },
          note: { type: "string", description: "Note / motif de décision (obligatoire pour attente, refus, pièces mises en cause)." },
          notes: { type: "string", description: "Notes libres." },
          name: { type: "string", description: "Nom de la cible budgétaire (enveloppe, catégorie) — création ou résolution." },
          newName: { type: "string", description: "update_envelope / update_budget_category : nouveau nom." },
          newLabel: { type: "string", description: "update_* : nouveau libellé/objet." },
          newReference: { type: "string", description: "update_budget_expense : nouvelle référence." },
          envelope: { type: "string", description: "Nom de l'enveloppe budgétaire visée." },
          expense: { type: "string", description: "Dépense visée (référence imputée ou libellé départemental)." },
          parent: { type: "string", description: "create_budget_category : catégorie parente (sous-catégorie)." },
          transaction: { type: "string", description: "attribute_transaction / update_transaction : libellé ou référence de l'écriture." },
          person: { type: "string", description: "set_department_budget_access : la personne à ajouter/retirer." },
          nature: { type: "string", description: "set_department_budget_access : accès | moyens généraux | masse salariale | activité." },
          mode: { type: "string", description: "set_department_budget_access : « retirer » pour enlever (défaut : ajouter)." },
          kind: { type: "string", description: "Nature du budget départemental : moyens généraux (OPERATING) | masse salariale (HR) | activité (ACTIVITY)." },
          reason: { type: "string", description: "Motif (demande de budget, rallonge de caisse ; defer_payment : obligatoire si l'échéance a été déclarée fixe non négociable)." },
          holder: { type: "string", description: "Caisse d'avance : la personne détentrice (nom)." },
          period: { type: "string", description: "Caisse d'avance : la période (« 2026-08 », « août 2026 » ; défaut mois courant)." },
          day: { type: "string", description: "set_petty_cash_plan : jour de rechargement (1–28)." },
          active: { type: "string", description: "set_petty_cash_plan : « inactif » pour désactiver le rechargement." },
          payee: { type: "string", description: "create_payment_request : bénéficiaire du paiement (à qui l'argent va)." },
          urgency: { type: "string", description: "create_payment_request : urgent | cette semaine | ce mois | quand possible." },
          deadlineNature: { type: "string", description: "create_payment_request : ce que pèse l'échéance — fixe non négociable | importante | moyenne (défaut)." },
          until: { type: "string", description: "defer_payment : la date à laquelle le paiement est reporté (AAAA-MM-JJ, à venir)." },
          contactName: { type: "string", description: "Contact facultatif chez le bénéficiaire (nom) — création ou update_payment_contact." },
          contactPhone: { type: "string", description: "Contact facultatif chez le bénéficiaire (téléphone)." },
          contactEmail: { type: "string", description: "Contact facultatif chez le bénéficiaire (e-mail)." },
          description: { type: "string", description: "create_payment_request : description du dossier." },
          message: { type: "string", description: "Message (fil du dossier de paiement, réponse au Centre de paiement)." },
          validator: { type: "string", description: "ask_payment_validation : le validateur (nom)." },
          validator2: { type: "string", description: "ask_payment_validation : second validateur (facultatif)." },
          pieces: { type: "string", description: "ask_payment_validation : pièces visées par NOM, séparées par des virgules (défaut : dossier complet)." },
          piece: { type: "string", description: "comment/review/ask_piece_validation : la pièce visée (nom du fichier)." },
          verdict: { type: "string", description: "review_payment_piece : accepter | à revoir | refuser." },
          employee: { type: "string", description: "Paie : nom de l'employé (registre de paie)." },
          month: { type: "string", description: "Paie : mois (« août », « 8 »)." },
          year: { type: "string", description: "Année (défaut : en cours)." },
          gross: { type: "string", description: "Paie : salaire brut DZD." },
          bonuses: { type: "string", description: "create_payroll : primes DZD." },
          deductions: { type: "string", description: "create_payroll : retenues DZD." },
          employerCost: { type: "string", description: "mark_salary_paid : coût employeur DZD (brut + charges patronales — c'est lui qui pèse sur le budget)." },
          net: { type: "string", description: "mark_salary_paid : salaire net DZD (affiché au salarié)." },
          invoiceRef: { type: "string", description: "update_transaction : référence de facture liée." },
          number: { type: "string", description: "update_invoice : numéro de la facture." },
          total: { type: "string", description: "set_budget_total : total annuel DZD (mode fixe)." },
          module: { type: "string", description: "create_budget_category : module rattaché (facultatif)." },
        },
        required: ["op"],
      },
    },
  },
};
