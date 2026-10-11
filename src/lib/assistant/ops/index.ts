import type { Module } from "@/lib/rbac";
import type { ClaudeToolDef } from "@/lib/ai";
import { OPS_BY_TOOL, type OpMeta } from "./catalog";
import type { OpImpl } from "./types";
import { CAPABILITY_OPS_IMPL } from "./impl-capabilite";
import { DRIVE_OPS_IMPL } from "./impl-drive";
import { TASK_OPS_IMPL } from "./impl-task";
import { FINANCE_OPS_IMPL } from "./impl-finance";
import { FINANCE_BUDGET_OPS_IMPL } from "./impl-finance-budget";
import { FINANCE_FLOWS_OPS_IMPL } from "./impl-finance-flows";
import { REGULATORY_OPS_IMPL } from "./impl-regulatory";
import { HR_OPS_IMPL } from "./impl-hr";
import { HR2_OPS_IMPL, ACCESS_OPS_IMPL } from "./impl-hr2";
import { RECRUIT_TRAINING_OPS_IMPL, MISSION_OPS_IMPL, DOCREQ_OPS_IMPL, MEDINFO_OPS_IMPL } from "./impl-wave2b";
import { DRIVE3_OPS_IMPL, LEGAL3_OPS_IMPL, MAIL3_OPS_IMPL } from "./impl-wave3";
import { MEETING_OPS_IMPL } from "./impl-meeting";
import { MAIL_OPS_IMPL } from "./impl-mail";
import { LEGAL_OPS_IMPL } from "./impl-legal";
import { ORG_OPS_IMPL } from "./impl-org";
import { ADPRO_OPS_IMPL, BD_OPS_IMPL, STOCK_OPS_IMPL } from "./impl-commercial";
import { REG4_OPS_IMPL, PCH_OPS_IMPL, STOCK4_OPS_IMPL, SALES_OPS_IMPL, LOGISTICS_OPS_IMPL } from "./impl-wave4";
import { STOCK_RECURRENCE_OPS_IMPL } from "./impl-stock-recurrence";
import { MEDICAL_OPS_IMPL, RANGE_OPS_IMPL, BD4_OPS_IMPL } from "./impl-wave4b";
import { EVENT_OPS_IMPL, ADPRO5_OPS_IMPL, CONSULTING_OPS_IMPL } from "./impl-wave5";
import { CARE_OPS_IMPL, PROMO_OPS_IMPL } from "./impl-wave5b";
import { PROMO2_OPS_IMPL } from "./impl-promo-circuit2";
import { BD6_OPS_IMPL, DOSSIER_OPS_IMPL, DIRECTIVE_OPS_IMPL, SUPPORT_OPS_IMPL, REMINDER_OPS_IMPL } from "./impl-wave6";
import { VALIDATION_OPS_IMPL, FIELD_REPORT_OPS_IMPL, SUPPLY_OPS_IMPL } from "./impl-wave6b";
import { PLANNING_OPS_IMPL } from "./impl-wave6c";
import { TOUR_PLAN_OPS_IMPL, TOUR_VISIT_OPS_IMPL, PROMO_MESSAGE_OPS_IMPL } from "./impl-tournee";
import { ADMIN_REQUEST_OPS_IMPL } from "./impl-wave7";
import { MEETING7_OPS_IMPL, WORKSPACE7_OPS_IMPL } from "./impl-wave7b";
import { MESSAGING7_OPS_IMPL, REGREMINDER_OPS_IMPL } from "./impl-wave7c";
import { ORG7D_OPS_IMPL, LEGAL7D_OPS_IMPL, WS7D_OPS_IMPL } from "./impl-wave7d";
import { FILE_WS_OPS_IMPL, FILE_FINANCE_OPS_IMPL, FILE_MEDICAL_OPS_IMPL, FILE_MEDINFO_OPS_IMPL, FILE_PCH_OPS_IMPL, FILE_ORG_OPS_IMPL } from "./impl-wave8-files";
import { MARKET360_OPS_IMPL } from "./impl-market360";

/**
 * ASSEMBLAGE des outils de domaine : le CATALOGUE (métadonnées pures) est zippé avec les
 * IMPLÉMENTATIONS (résolution + exécution) — une op déclarée sans implémentation fait
 * échouer le chargement (donc les tests) : le catalogue ne peut pas promettre dans le vide.
 *
 * Les DÉFINITIONS d'outils Claude sont GÉNÉRÉES d'ici : ajouter une op au catalogue met à
 * jour l'énumération `op` et la description de l'outil sans toucher l'orchestrateur.
 */

export interface DomainToolSpec {
  /** Module RBAC affiché sur la carte de confirmation. */
  module: Module;
  ops: Record<string, { meta: OpMeta; impl: OpImpl }>;
  def: ClaudeToolDef;
}

function zipOps(tool: string, impls: Record<string, OpImpl>): Record<string, { meta: OpMeta; impl: OpImpl }> {
  const metas = OPS_BY_TOOL[tool] ?? {};
  const out: Record<string, { meta: OpMeta; impl: OpImpl }> = {};
  for (const [op, meta] of Object.entries(metas)) {
    const impl = impls[op];
    if (!impl) throw new Error(`Op « ${tool}/${op} » déclarée au catalogue sans implémentation.`);
    out[op] = { meta, impl };
  }
  for (const op of Object.keys(impls)) {
    if (!metas[op]) throw new Error(`Implémentation « ${tool}/${op} » absente du catalogue (découverte/classification cassées).`);
  }
  return out;
}

function opsSummary(tool: string): string {
  return Object.values(OPS_BY_TOOL[tool] ?? {})
    .map((o) => `${o.op} = ${o.uiLabel}${o.risk === "CRITICAL" ? " [CRITIQUE]" : ""}`)
    .join(" ; ");
}

const opEnum = (tool: string): string[] => Object.keys(OPS_BY_TOOL[tool] ?? {});

export const DOMAIN_TOOLS: Record<string, DomainToolSpec> = {
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
  adpro_operation: {
    module: "SPONSORING",
    ops: zipOps("adpro_operation", { ...ADPRO_OPS_IMPL, ...MISSION_OPS_IMPL, ...ADPRO5_OPS_IMPL }),
    def: {
      name: "adpro_operation",
      description:
        "AD & PRO — LES CIRCUITS COMPLETS : sponsoring (préliminaire National Sales → analyse Direction Marketing → décision Direction → appel), congrès / événements (mêmes marches + budget accordé modifiable + personnes prises en charge), POSTES de dépense (ajout, soumission, décision, imputation budgétaire, BC visé puis émis), demandes « autres », correction de fiche par liste blanche, missions, matériel promo (étapes), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("adpro_operation")}. `
        + "Le sponsoring se donne par SPO-… ou institution ; le congrès / événement par « target » (+ « kind » si ambigu) ; le poste par « label » dans son opération.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("adpro_operation"), description: "Le geste à faire." },
          label: { type: "string", description: "Postes / circuit promo : libellé du poste ou titre du dossier ; demandes « autres » : l'objet." },
          reference: { type: "string", description: "Référence exacte (SPO-…, AUT-…, dossier promo) — ou alias de « target »." },
          decision: { type: "string", description: "Décisions : approuver / accorder / valider, refuser, budget à revoir (decide_item)." },
          amount: { type: "string", description: "Montants DZD : budget proposé (analyse), budget accordé (décision finale), estimation (add_item), montant demandé (correct_request)." },
          grantedAmount: { type: "string", description: "update_item : montant AFFECTÉ par la Direction." },
          to: { type: "string", description: "transfer : module de destination (sponsoring / prise en charge nationale / internationale)." },
          note: { type: "string", description: "Motif / note (obligatoire pour les refus)." },
          target: { type: "string", description: "La cible : événement / congrès / sponsoring (nom ou référence)." },
          kind: { type: "string", description: "Type de la cible (événement | sponsoring | congrès international | congrès national) — tranche l'ambiguïté." },
          person: { type: "string", description: "La personne : référent Direction Marketing désigné, tierce personne, personne prise en charge, bénéficiaire d'une demande « autre »." },
          role: { type: "string", description: "Missions : accompagnant / délégué de référence ; personnes prises en charge : rôle libre." },
          message: { type: "string", description: "comment_mission : le message ; create_other_request : alias de notes." },
          mode: { type: "string", description: "add_item : « rallonge » si le poste est EN PLUS du budget accordé ; close_other_request : « annuler »." },
          category: { type: "string", description: "set_item_budget : la (sous-)catégorie budgétaire (nom ; « aucune » retire)." },
          material: { type: "string", description: "link_item_promo_material : le matériel promo (MP-… ou titre ; « aucun » détache)." },
          supplier: { type: "string", description: "add_item / update_item : le prestataire pressenti." },
          notes: { type: "string", description: "Notes / description (create_other_request : OBLIGATOIRE ; correct_request : description)." },
          city: { type: "string", description: "correct_request : ville." },
          specialty: { type: "string", description: "correct_request : spécialité." },
          products: { type: "string", description: "correct_request : produits." },
          startDate: { type: "string", description: "correct_request : date de début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "correct_request : date de fin (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  event_operation: {
    module: "EVENTS",
    ops: zipOps("event_operation", EVENT_OPS_IMPL),
    def: {
      name: "event_operation",
      description:
        "EVENTS — la fiche d'un événement (modification en rejouant TOUT l'existant, suppression), sa soumission au circuit de prise en charge, et ses INSCRIPTIONS (ajout, statut présent/confirmé/annulé, retrait), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("event_operation")}. `
        + "L'événement se donne par NOM (« target »), le participant par son nom (« person »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("event_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "L'événement visé (nom)." },
          newName: { type: "string", description: "update_event : nouveau nom." },
          eventType: { type: "string", description: "update_event : congrès, séminaire, table ronde, staff hospitalier, symposium, webinaire, formation, journée scientifique, autre." },
          scope: { type: "string", description: "update_event : national / international." },
          format: { type: "string", description: "update_event : présentiel / webinaire / hybride." },
          status: { type: "string", description: "Événement : brouillon, en attente de validation, validé, en préparation, inscriptions ouvertes, complet, terminé, annulé. Participant : inscrit, confirmé, liste d'attente, refusé, présent, absent, annulé." },
          startDate: { type: "string", description: "update_event : date de début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "update_event : date de fin (AAAA-MM-JJ)." },
          location: { type: "string", description: "update_event : lieu." },
          city: { type: "string", description: "Ville." },
          country: { type: "string", description: "Pays." },
          specialty: { type: "string", description: "Spécialité (événement ou participant)." },
          institution: { type: "string", description: "add_registration : établissement du participant." },
          products: { type: "string", description: "update_event : produits présentés." },
          quantity: { type: "string", description: "update_event : capacité (places)." },
          amount: { type: "string", description: "update_event : budget estimé (DZD)." },
          person: { type: "string", description: "Participant (prénom + nom) — ou Direction Marketing pour submit_event_for_approval." },
          role: { type: "string", description: "add_registration : médecin, professeur, chef de service, pharmacien, autre." },
          email: { type: "string", description: "add_registration : e-mail." },
          phone: { type: "string", description: "add_registration : téléphone." },
          notes: { type: "string", description: "Description / commentaire." },
        },
        required: ["op", "target"],
      },
    },
  },
  consulting_operation: {
    module: "CONSULTING",
    ops: zipOps("consulting_operation", CONSULTING_OPS_IMPL),
    def: {
      name: "consulting_operation",
      description:
        "CONSULTING — le contrat entre deux parties : création (tâches attendues comprises), soumission au validateur désigné, validation (contrat ACTIF) ou refus, clôture / rupture, et les tâches attendues du prestataire (ajout, livrée, retrait), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("consulting_operation")}. `
        + "Le contrat se donne par référence CONS-…, intitulé ou consultant.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("consulting_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Le contrat visé (CONS-…, intitulé ou consultant)." },
          label: { type: "string", description: "create_contract : intitulé ; tâches : la tâche visée / à créer." },
          counterparty: { type: "string", description: "create_contract : le consultant ou cabinet (OBLIGATOIRE)." },
          person: { type: "string", description: "submit_contract : le validateur désigné (nom)." },
          decision: { type: "string", description: "decide_contract : valider ou refuser ; close_contract : « rompre » pour une rupture en cours de contrat." },
          amount: { type: "string", description: "create_contract : montant (DZD)." },
          startDate: { type: "string", description: "create_contract : début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "create_contract : fin (AAAA-MM-JJ)." },
          dueDate: { type: "string", description: "add_contract_task : échéance de la tâche (AAAA-MM-JJ)." },
          tasks: { type: "string", description: "create_contract : tâches attendues, séparées par des virgules." },
          paymentTerms: { type: "string", description: "create_contract : modalités de paiement." },
          note: { type: "string", description: "Décision / clôture : note ou motif." },
          notes: { type: "string", description: "create_contract : périmètre de la mission." },
        },
        required: ["op"],
      },
    },
  },
  care_operation: {
    module: "CONGRESS_NATIONAL",
    ops: zipOps("care_operation", CARE_OPS_IMPL),
    def: {
      name: "care_operation",
      description:
        "PRISES EN CHARGE d'un congrès (national ou international) — personnes (annuaire ou profil libre), avis du demandeur, DÉCISION PAR PERSONNE (Direction), besoins par personne (pièces / prestations et leurs états), devis qui couvrent N cases (garde anti double paiement), sollicitation des devis, envoi aux Finances bloqué tant qu'il manque quelque chose, rattachement d'une case au matériel promo — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("care_operation")}. `
        + "Le congrès se donne par NOM (« target », « kind » national / international si ambigu), la personne par son nom (« person »), l'élément par son libellé (« label »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("care_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le congrès visé (nom)." },
          kind: { type: "string", description: "Congrès national / congrès international (si le nom seul est ambigu)." },
          person: { type: "string", description: "La personne prise en charge (praticien de l'annuaire ou nom libre)." },
          label: { type: "string", description: "L'élément visé (pièce / prestation) — create_care_quote : les libellés couverts (virgules)." },
          cells: { type: "string", description: "create_care_quote : synonyme de « label » (libellés couverts, virgules)." },
          decision: { type: "string", description: "Avis : favorable / défavorable / pas d'avis. Personne : accorder / écarter. Devis : accepter / refuser." },
          supplier: { type: "string", description: "Devis : le fournisseur." },
          amount: { type: "string", description: "create_care_quote : montant du devis (DZD)." },
          reference: { type: "string", description: "create_care_quote : référence du devis." },
          status: { type: "string", description: "set_care_cell_status : demandée / reçue / réglée / sans objet." },
          serviceKind: { type: "string", description: "add_care_cell : hôtel, transport, billet, restauration, inscription, matériel promotionnel, autre." },
          mode: { type: "string", description: "add_care_cell : « prestation » force une prestation (sinon : pièce à fournir)." },
          role: { type: "string", description: "add_care_person : fonction (« Professeur », « Chef de service »…)." },
          institution: { type: "string", description: "add_care_person : établissement." },
          material: { type: "string", description: "link_care_promo : le matériel promotionnel (MP-… ou titre ; « aucun » détache)." },
          note: { type: "string", description: "Note / justification." },
          notes: { type: "string", description: "add_care_cell : précisions sur l'élément." },
        },
        required: ["op", "target"],
      },
    },
  },
  promo_operation: {
    module: "PROMO_MATERIAL",
    ops: zipOps("promo_operation", { ...PROMO_OPS_IMPL, ...PROMO2_OPS_IMPL }),
    def: {
      name: "promo_operation",
      description:
        "MATÉRIEL PROMOTIONNEL — le CIRCUIT 2 (devis demandés au secrétariat et retranscrits ligne à ligne, lignes retenues par le demandeur, bons de commande GÉNÉRÉS par la plateforme, factures par BC, paiement au centre de paiement avec la demande de visa ou de déclaration), la bascule d'un dossier d'avant sur ce circuit, le CIRCUIT COURT d'avant (devis reçu sur pièce exigée, chantiers parallèles BC / paiement / visa), les marches du circuit long (devis déposés, agence retenue, BC aux Finances puis validé puis envoyé, bordereau de paiement, paiement, matériel réalisé, examen Direction, conformité + visa, BAT, livraison, facture, règlement-clôture), commentaires, annulation — par les actions canoniques. Le STOCK promotionnel n'est PAS ici : dotations, réceptions, pertes et inventaires attestent des faits physiques et se font à l'écran (Sales & Marketing › Stock promotionnel). "
        + `Champ « op » : ${opsSummary("promo_operation")}. `
        + "Le dossier se donne par référence MP-… ou titre (« reference »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("promo_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Le dossier visé (MP-… ou titre)." },
          label: { type: "string", description: "Synonyme de « reference »." },
          supplier: { type: "string", description: "choose_promo_agency : l'agence retenue. Circuit 2 : le FOURNISSEUR qui désigne un devis (et son BC) — choose_promo_lines : un ou plusieurs (virgules), chacun retient tout son devis." },
          name: { type: "string", description: "Synonyme de « supplier » (l'agence ou le fournisseur visé)." },
          amount: { type: "string", description: "Montant (DZD) — agence retenue, règlement final, facture déposée (deposit_promo_invoice)." },
                    person: { type: "string", description: "update_promo_bc : l'interlocuteur du BC." },
          date: { type: "string", description: "Facture déposée : date (AAAA-MM-JJ)." },
          mode: { type: "string", description: "choose_promo_lines : « valider » soumet le choix ; paiement / information médicale : « visa » (demande de visa publicitaire) ou « déclaration » (au ministère)." },
          track: { type: "string", description: "complete_promo_track : bon de commande / demande de paiement / visa publicitaire." },
          lines: { type: "string", description: "choose_promo_lines : les LIGNES retenues, séparées par « ; » — « Fournisseur : ligne » quand deux devis portent la même référence." },
          invoiceRef: { type: "string", description: "Circuit 2 : la référence de la facture (dépôt, paiement, information médicale)." },
          file: { type: "string", description: "deposit_promo_invoice : le fichier de la facture — nom d'un fichier de votre Drive (glissé dans la conversation ou déposé)." },
          address: { type: "string", description: "generate_promo_bcs / update_promo_bc : adresse de livraison." },
          delay: { type: "string", description: "generate_promo_bcs / update_promo_bc : délai de livraison." },
          phone: { type: "string", description: "update_promo_bc : téléphone de l'interlocuteur." },
          message: { type: "string", description: "comment_promo : le commentaire ; confirm_promo_conformity : référence de l'autorité." },
          note: { type: "string", description: "Commentaire d'étape / n° de BC / référence du visa ; circuit 2 : message au secrétariat, ce qui est à corriger, motif d'annulation ou de modification d'un BC." },
          notes: { type: "string", description: "BC du circuit 2 : notes imprimées sur le bon de commande." },
        },
        required: ["op"],
      },
    },
  },
  medical_info_operation: {
    module: "MEDICAL_INFO",
    ops: zipOps("medical_info_operation", { ...MEDINFO_OPS_IMPL, ...FILE_MEDINFO_OPS_IMPL }),
    def: {
      name: "medical_info_operation",
      description:
        "INFORMATION MÉDICALE — déclarations aux autorités de santé : demander/annuler une pièce, DEMANDER LE BON DE VERSEMENT (l'étape qui précède la déclaration : centre de paiement → Finances → remise au bureau du PRIM), consigner la référence de l'autorité, valider (pharmacien puis Direction), messages — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("medical_info_operation")}. `
        + "La déclaration se donne par référence ou libellé.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("medical_info_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "fulfill_doc_request : Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          reference: { type: "string", description: "Référence ou libellé de la déclaration visée." },
          label: { type: "string", description: "Alias de reference." },
          piece: { type: "string", description: "La pièce demandée (libellé)." },
          person: { type: "string", description: "request_declaration_document : à qui demander (nom) ; request_bv : le bénéficiaire du versement." },
          authorityRef: { type: "string", description: "record_authority_declaration : la référence donnée par l'autorité." },
          message: { type: "string", description: "comment_declaration : le message." },
          note: { type: "string", description: "Note / commentaire (validation Direction) ; request_bv : ce que couvre le versement ; deliver_bv : note de remise ; skip_bv : le MOTIF, exigé." },
          notes: { type: "string", description: "record_authority_declaration : notes de l'autorité." },
          amount: { type: "string", description: "request_bv : le MONTANT du bon de versement (DZD)." },
          date: { type: "string", description: "request_bv : l'échéance DEMANDÉE (le centre de paiement arbitre ensuite)." },
        },
        required: ["op"],
      },
    },
  },
  bd_operation: {
    module: "BUSINESS_DEVELOPMENT",
    ops: zipOps("bd_operation", { ...BD_OPS_IMPL, ...BD4_OPS_IMPL, ...BD6_OPS_IMPL }),
    def: {
      name: "bd_operation",
      description:
        "BUSINESS DEVELOPMENT — pipeline d'opportunités (stades idée → validée / abandonnée), études de marché (lignes-molécules, acteurs, pré-remplissage, présentations IA), ET le TABLEAU STRATÉGIQUE projets → gammes → produits (fiches en FUSION, cellule par liste blanche via set_bd_cell, suppressions en cascade comptées, commentaires) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("bd_operation")}. `
        + "L'étude se donne par TITRE (« research »), la ligne par sa molécule (« row »), l'acteur par son nom (« player ») ; le projet du tableau par NOM (« target »), la gamme par « range », le produit par « product » (DCI ou marque).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("bd_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "Pipeline : nom de l'opportunité (création ou cible)." },
          status: { type: "string", description: "update_status : le stade ; update_research : brouillon / finale." },
          dci: { type: "string", description: "create : DCI du produit." },
          therapeuticClass: { type: "string", description: "create / update_research_row : classe thérapeutique." },
          research: { type: "string", description: "Études : le TITRE de l'étude visée (ou à créer)." },
          row: { type: "string", description: "Études : la ligne visée (molécule / produit)." },
          player: { type: "string", description: "Études : l'acteur visé (laboratoire)." },
          molecules: { type: "string", description: "create_research : molécules initiales, séparées par des virgules." },
          people: { type: "string", description: "set_research_participants : noms, virgules (liste REMPLACÉE ; « aucun » vide)." },
          newName: { type: "string", description: "Nouveau titre / nom (étude, ligne, acteur, présentation)." },
          quantity: { type: "string", description: "update_research_row : volume marché (unités)." },
          amount: { type: "string", description: "update_research_row : valeur marché USD ; update_research_player : part de marché." },
          price: { type: "string", description: "update_research_row : prix moyen par boîte (USD)." },
          mode: { type: "string", description: "update_research_player / produit BD (sourcing) : importation, fabrication locale, à étudier." },
          presentation: { type: "string", description: "Présentations : le titre visé (ou à donner à la nouvelle)." },
          notes: { type: "string", description: "Notes / consigne IA (generate/regenerate_presentation : l'instruction) ; tableau : description du projet." },
          sources: { type: "string", description: "update_research : sources de l'étude." },
          target: { type: "string", description: "Tableau stratégique : le PROJET visé (nom)." },
          range: { type: "string", description: "Tableau : la gamme visée (nom)." },
          product: { type: "string", description: "Tableau : le produit visé (DCI ou nom de marque)." },
          field: { type: "string", description: "set_bd_cell : la cellule (Nom, Statut, DCI, Dosage, Taille de marché DZD, Prix unitaire, Concurrents, Investissement A1…)." },
          value: { type: "string", description: "set_bd_cell : la nouvelle valeur (vide pour effacer)." },
          kind: { type: "string", description: "set_bd_cell : projet ou produit." },
          dosage: { type: "string", description: "Produit BD : dosage." },
          form: { type: "string", description: "Produit BD : forme galénique." },
          label: { type: "string", description: "Produit BD : nom de marque." },
          note: { type: "string", description: "Commentaire (projet, gamme, produit)." },
          message: { type: "string", description: "comment_bd_project : le commentaire à poser." },
        },
        required: ["op"],
      },
    },
  },
  dossier_operation: {
    module: "DOSSIERS",
    ops: zipOps("dossier_operation", DOSSIER_OPS_IMPL),
    def: {
      name: "dossier_operation",
      description:
        "SUJETS DE PILOTAGE (anciennement « projets de suivi ») — statut (ouvert → terminé / archivé), équipe (responsable + participants REJOUÉS en FUSION, « aucun » vide), fil « Suivi & discussion » (messages, mentions de MEMBRES, modification / suppression par extrait), e-mail journalisé dans le fil (sujet existant ou créé à la volée), ouverture d'un sujet depuis une tâche — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("dossier_operation")}. `
        + "Le projet se donne par référence ou intitulé (« target ») ; un message du fil par un extrait (« message », ou « dernier »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("dossier_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le projet visé (référence ou intitulé)." },
          status: { type: "string", description: "set_dossier_status : ouvert, en cours, en attente, terminé, archivé." },
          person: { type: "string", description: "assign_dossier : le responsable (nom ; « aucun » retire)." },
          people: { type: "string", description: "assign_dossier : participants (noms, virgules — liste REMPLACÉE, absents rejoués, « aucun » vide) ; post_dossier_message : mentions." },
          message: { type: "string", description: "Le message à poster — ou l'EXTRAIT qui désigne un message existant (edit/delete ; « dernier » accepté)." },
          note: { type: "string", description: "edit_dossier_message : le NOUVEAU texte." },
          name: { type: "string", description: "link_email_to_dossier : intitulé du projet à CRÉER (si « target » absent)." },
          label: { type: "string", description: "link_email_to_dossier : l'OBJET de l'e-mail ; create_dossier_from_task : le titre de la tâche." },
          date: { type: "string", description: "link_email_to_dossier : date de réception (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  directive_operation: {
    module: "DIRECTIVES",
    ops: zipOps("directive_operation", DIRECTIVE_OPS_IMPL),
    def: {
      name: "directive_operation",
      description:
        "DIRECTIVES de la Direction — émission référencée DIR- vers UNE personne ou UN rôle (priorité, échéance), avancement (prise en compte horodatée, terminée, ARCHIVAGE réservé à la Direction), fil émetteur ↔ destinataire — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("directive_operation")}. `
        + "La directive se donne par référence DIR-… ou titre (« target »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("directive_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La directive visée (DIR-… ou titre)." },
          label: { type: "string", description: "create_directive : le titre." },
          message: { type: "string", description: "Le contenu de la directive, ou le message à poster sur le fil." },
          person: { type: "string", description: "create_directive : destinataire nommé (prime sur le rôle)." },
          role: { type: "string", description: "create_directive : rôle destinataire (« Délégués médicaux », « National Sales »…)." },
          status: { type: "string", description: "set_directive_status : ouverte, prise en compte, en cours, terminée, archivée." },
          priority: { type: "string", description: "create_directive : basse, moyenne, haute, critique." },
          date: { type: "string", description: "create_directive : échéance (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  support_operation: {
    module: "SUPPORT",
    ops: zipOps("support_operation", SUPPORT_OPS_IMPL),
    def: {
      name: "support_operation",
      description:
        "SUPPORT interne — demandes SUP- (question, support promotionnel, brochure, document) vers UNE personne ou UN rôle, prise en charge par le destinataire, fil de réponse (la réponse d'un destinataire passe la demande « répondue »), statut avec clôture ouverte au demandeur — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("support_operation")}. `
        + "La demande se donne par référence SUP-… ou objet (« target »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("support_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande visée (SUP-… ou objet)." },
          label: { type: "string", description: "create_support_request : l'objet." },
          message: { type: "string", description: "Le message / la réponse." },
          person: { type: "string", description: "create_support_request : destinataire nommé (prime sur le rôle)." },
          role: { type: "string", description: "create_support_request : rôle destinataire." },
          kind: { type: "string", description: "create_support_request : question, support promotionnel, brochure, document, autre." },
          product: { type: "string", description: "create_support_request : produit concerné." },
          status: { type: "string", description: "set_support_status : ouverte, en cours, répondue, clôturée." },
        },
        required: ["op"],
      },
    },
  },
  validation_operation: {
    module: "VALIDATIONS",
    ops: zipOps("validation_operation", VALIDATION_OPS_IMPL),
    def: {
      name: "validation_operation",
      description:
        "VALIDATIONS — les règles de routage (Super Admin : 1-2 validateurs, séquentiel / parallèle, critères module / montants / rôle, FUSION à la modification), les demandes VAL- (validateurs désignés OU routage automatique), la DÉCISION d'étape (approuver / refuser / demander une modification — intérim de congé respecté, chacun son tour en séquentiel), le verdict PIÈCE PAR PIÈCE retirable, et la relance tracée du validateur qui bloque — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("validation_operation")}. `
        + "La demande se donne par référence VAL-… ou objet (« target ») ; la règle par son nom ; l'élément revu par son nom de pièce (« label », ou « message »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("validation_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande (VAL-… ou objet) ou la règle visée (nom)." },
          name: { type: "string", description: "create_validation_rule : le nom de la règle." },
          newName: { type: "string", description: "update_validation_rule : nouveau nom." },
          label: { type: "string", description: "create_validation_request : l'objet à valider ; review_validation_item : la pièce visée (« message » pour le message)." },
          person: { type: "string", description: "Validateur 1 (règle / demande directe) ; decide/remind : le validateur de l'étape visée (si plusieurs en attente)." },
          person2: { type: "string", description: "Validateur 2 (« aucun » le retire à la modification)." },
          decision: { type: "string", description: "Décision : approuver / refuser / demander une modification — review : aussi « retirer le verdict »." },
          mode: { type: "string", description: "Règle : séquentiel (défaut) ou parallèle." },
          module: { type: "string", description: "Module ciblé (règle) ou module de routage (demande sans validateur désigné)." },
          priority: { type: "string", description: "Basse, moyenne, haute, critique." },
          role: { type: "string", description: "create_validation_rule : rôle du demandeur ciblé." },
          amount: { type: "string", description: "Montant (DZD) — règle : seuil minimum ; demande : montant de l'objet." },
          maxAmount: { type: "string", description: "create/update_validation_rule : seuil maximum (DZD)." },
          department: { type: "string", description: "Département ciblé / concerné." },
          category: { type: "string", description: "Catégorie (règle / demande)." },
          date: { type: "string", description: "create_validation_request : échéance (AAAA-MM-JJ)." },
          note: { type: "string", description: "Commentaire de décision / mot de relance." },
          notes: { type: "string", description: "Description (règle / demande)." },
          message: { type: "string", description: "create_validation_request : description de l'objet." },
        },
        required: ["op"],
      },
    },
  },
  field_report_operation: {
    module: "FIELD_REPORTS",
    ops: zipOps("field_report_operation", FIELD_REPORT_OPS_IMPL),
    def: {
      name: "field_report_operation",
      description:
        "RAPPORTS TERRAIN — brouillon dicté qui appartient à son auteur, mise à jour de la fiche en FUSION (synthèse, médecins de l'annuaire, établissement, spécialité, date), analyse IA qui STRUCTURE et persiste sans jamais valider, envoi (VALIDÉ horodaté), validation, réouverture en brouillon, suppressions (rapport avec pièces comptées, ou une pièce par son nom) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("field_report_operation")}. `
        + "Le rapport se donne par « target » : médecin, extrait de synthèse, nom du délégué, ou « mon dernier ».",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("field_report_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le rapport visé (médecin, extrait, délégué, ou « mon dernier »)." },
          message: { type: "string", description: "La synthèse / le compte rendu (update, submit)." },
          doctor: { type: "string", description: "update : médecin(s) de l'annuaire (noms, virgules)." },
          institution: { type: "string", description: "update : établissement." },
          specialty: { type: "string", description: "update : spécialité." },
          date: { type: "string", description: "Date de la visite (AAAA-MM-JJ)." },
          label: { type: "string", description: "delete_field_report_attachment : la pièce visée (nom)." },
        },
        required: ["op"],
      },
    },
  },
  supply_operation: {
    module: "GENERAL_MEANS",
    ops: zipOps("supply_operation", SUPPLY_OPS_IMPL),
    def: {
      name: "supply_operation",
      description:
        "CATALOGUE D'ARTICLES (Bureau du secrétariat + Moyens généraux — le MÊME catalogue) — ajout à écriture uniformisée (doublon refusé sur la clé), modification en FUSION (renommage sur libellé pris refusé), activation / désactivation, et l'uniformisation de TOUT le catalogue montrée avant d'être appliquée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("supply_operation")}. `
        + "L'article se donne par son nom (« name »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("supply_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "L'article visé / à créer." },
          newName: { type: "string", description: "update_supply_article : nouveau libellé." },
          category: { type: "string", description: "Catégorie (papeterie, informatique…)." },
          unit: { type: "string", description: "Unité de compte (pièce, boîte, lot de 50…)." },
          reference: { type: "string", description: "Référence interne / fournisseur." },
          amount: { type: "string", description: "Prix estimé (DZD)." },
          supplier: { type: "string", description: "Fournisseur indicatif." },
          notes: { type: "string", description: "Notes de la fiche." },
        },
        required: ["op"],
      },
    },
  },
  planning_operation: {
    module: "SALES_PLANNING",
    ops: zipOps("planning_operation", { ...PLANNING_OPS_IMPL, ...TOUR_PLAN_OPS_IMPL, ...PROMO_MESSAGE_OPS_IMPL }),
    def: {
      name: "planning_operation",
      description:
        "PLANNING FORCE DE VENTE (SFE) — business units, produits promus (canal ville / hôpital / les deux), équipes, profils KAM, prévisions produit × CYCLE MENSUEL, matrice d'affectations KAM × produit (0 visite sans note = retrait), report d'un cycle vers un autre, paramètres SFE globaux. Les « save » de l'écran écrasent avec des DÉFAUTS-PIÈGES : chaque op relit l'existant et le REJOUE (FUSION) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("planning_operation")}. `
        + "Le cycle se donne en français (« septembre 2026 » ou 2026-09, champ « date ») ; BU / équipe par « target », produit par « product », KAM par « person ». "
        + "SECTEURS (territoires nommés d'une BU : « Est », « Oranais ») — c'est le secteur qui donne au KAM son panel de médecins : nom par « name », BU par « target », établissements par « institutions » et KAM par « person » (noms séparés par des virgules). "
        + "PLAN DE TOURNÉE — préparer la période (« open_tour_plan », KAM par « person », maille par « mode », période par « date » ; sans date, la période À VENIR ; sans maille, celle du réglage en vigueur), le soumettre à son validateur, ou demander une validation au N+2. Le RÉGLAGE global (« set_tour_planning », Super Admin) : la maille par « mode » et l'échéance de soumission en jours par « days ». Les VISITES elles-mêmes se posent à l'écran : l'action remplace la grille entière, donc une phrase qui n'en nomme qu'une effacerait les autres. VALIDER un plan et RAPPORTER une visite sont des attestations réservées à un clic humain. "
        + "MESSAGES DE LA DIRECTION MARKETING (ce que le KAM doit dire au médecin, exigé sur chaque rapport terrain) : intitulé par « name », texte par « note », gamme par « target » (vide = toutes).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("planning_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "BU visée (nom) — produits : la BU de rattachement." },
          name: { type: "string", description: "Nom (création) ou cible (produit / BU / équipe)." },
          newName: { type: "string", description: "Nouveau nom (BU, produit, équipe)." },
          product: { type: "string", description: "Le produit promu visé (nom)." },
          person: { type: "string", description: "Responsable de BU / superviseur / référent Direction Marketing / KAM (nom ; « aucun » retire) — SECTEUR : les KAM affectés, noms séparés par des virgules." },
          label: { type: "string", description: "save_rep_profile : la BU du KAM (« aucune » détache) ; create/update_business_unit : le chef de BU ; carry_forward : cycle cible." },
          date: { type: "string", description: "Le cycle mensuel (« septembre 2026 » ou 2026-09) — carry_forward : cycle SOURCE." },
          endDate: { type: "string", description: "carry_forward_assignments : cycle CIBLE." },
          mode: { type: "string", description: "BU et produit : terrain / canal (ville / hôpital / les deux) ; affectation : position 1-3 ; profil KAM : séniorité ; PLAN DE TOURNÉE : la maille (WEEK / MONTH / QUARTER / HALF_YEAR)." },
          quantity: { type: "string", description: "Prévision : FTE cible ; profil KAM : FTE budget ; affectation : visites prévues." },
          visits: { type: "string", description: "Visites (prévision produit, capacité/jour, affectation)." },
          days: { type: "string", description: "Jours terrain par mois (paramètres / profil KAM) ; set_tour_planning : jours avant l'échéance de soumission." },
          threshold: { type: "string", description: "Pourcentage : couverture cible (prévision), % terrain (paramètres / profil)." },
          amount: { type: "string", description: "save_forecast : budget (DZD)." },
          location: { type: "string", description: "save_rep_profile : région ; secteur : sa ville pivot." },
          institutions: { type: "string", description: "SECTEUR : les établissements, par leurs NOMS séparés par des virgules (« CHU de Constantine, EPH d'Annaba »). Non cité en modification = liste inchangée." },
          reference: { type: "string", description: "Code (BU, produit, équipe)." },
          note: { type: "string", description: "Note (prévision, profil, affectation)." },
          p1: { type: "string", description: "save_sfe_settings : poids position 1." },
          p2: { type: "string", description: "save_sfe_settings : poids position 2." },
          p3: { type: "string", description: "save_sfe_settings : poids position 3." },
          freqVeryHigh: { type: "string", description: "save_sfe_settings : fréquence potentiel très haut." },
          freqHigh: { type: "string", description: "save_sfe_settings : fréquence potentiel haut." },
          freqMedium: { type: "string", description: "save_sfe_settings : fréquence potentiel moyen." },
          freqLow: { type: "string", description: "save_sfe_settings : fréquence potentiel bas." },
          freqVeryLow: { type: "string", description: "save_sfe_settings : fréquence potentiel très bas." },
        },
        required: ["op"],
      },
    },
  },
  request_operation: {
    module: "ADMIN_REQUESTS",
    ops: zipOps("request_operation", ADMIN_REQUEST_OPS_IMPL),
    def: {
      name: "request_operation",
      description:
        "DEMANDES ADMINISTRATIVES (bureau du secrétariat) de bout en bout — validation hiérarchique (demande + décision : l'approbation avec montant ÉMET l'ordre de dépense), courses chauffeur DÉJÀ posées (points de passage, statuts, preuve — on n'en crée plus, ni de lot de demandes), fenêtre demandeur 30 min (modifier en FUSION / retirer), suppression TRAÇABLE à motif + restauration, flux assistante (traitement, validation Finances / interne, FIN avec facture exigée et imputation moyens généraux), pièces soumises à validation UNE PAR UNE (retirables) — et l'ACHAT depuis les Moyens généraux (validateur = N+1 d'organigramme, retrait avant décision). Par les actions canoniques. "
        + `Champ « op » : ${opsSummary("request_operation")}. `
        + "La demande se donne par référence REQ-… ou objet (« target ») ; la course par son titre ; la pièce par son nom (« label »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("request_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande visée (REQ-… ou objet) — delete_requests : plusieurs références (virgules) ; missions : la course (titre)." },
          person: { type: "string", description: "Validateur / chauffeur / traitant (nom)." },
          person2: { type: "string", description: "Second validateur (nom)." },
          people: { type: "string", description: "submit_attachment_validation : les validateurs (noms, virgules)." },
          decision: { type: "string", description: "decide_approval : approuver / refuser / demander une modification." },
          label: { type: "string", description: "Pièces : la pièce visée (nom)." },
          name: { type: "string", description: "create_purchase_request : l'objet de la demande d'achat ; toggle_mission_stop : le point visé." },
          newName: { type: "string", description: "edit_own_request : nouveau titre." },
          status: { type: "string", description: "update_mission : nouvelle, acceptée, en route, terminée, problème, annulée." },
          cells: { type: "string", description: "Achat : les lignes (« une par ligne » ou points-virgules, « article xN ») ; suppression : les références." },
          amount: { type: "string", description: "Montant (DZD) — validation hiérarchique, pièce, estimation Finances, imputation de clôture." },
          department: { type: "string", description: "finish_request : département dont les moyens généraux sont débités." },
          location: { type: "string", description: "toggle_mission_stop : le point visé." },
          date: { type: "string", description: "Échéance (AAAA-MM-JJ)." },
          note: { type: "string", description: "Commentaire / motif (suppression : OBLIGATOIRE) / preuve de course / note d'imputation." },
          notes: { type: "string", description: "Description (édition de demande, consignes de course)." },
          message: { type: "string", description: "create_purchase_request : description du besoin." },
        },
        required: ["op"],
      },
    },
  },
  medical_operation: {
    module: "MEDICAL",
    ops: zipOps("medical_operation", { ...MEDICAL_OPS_IMPL, ...FILE_MEDICAL_OPS_IMPL, ...TOUR_VISIT_OPS_IMPL }),
    def: {
      name: "medical_operation",
      description:
        "ANNUAIRE MÉDICAL — praticiens (fiche complète ou cellule de la feuille, suppressions bornées par la portée), visites (planification et compte rendu champ-par-champ), établissements, spécialités, annuaires nommés (rangement + accès désignés), plans de tournée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("medical_operation")}. `
        + "Le praticien se donne par NOM (« doctor »), la visite par praticien + date, le plan par délégué + date de début. "
        + "log_visit : la visite QUI A EU LIEU — « products » liste les produits présentés (noms exacts, résolus au catalogue), « followUp » ce qu'il reste à faire. "
        + "order_visit : « demain va voir Achour » — la Direction COMMANDE une visite à un KAM (« person »), chez un praticien (« doctor »), un jour donné (« date ») : elle arrive dans son emploi du temps comme une visite À FAIRE, hors de son plan validé, et le compte rendu reste à sa charge.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("medical_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "import_directory_sheet : classeur Excel / CSV — Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          doctor: { type: "string", description: "Le praticien visé (nom) — plusieurs noms séparés par des virgules pour les gestes en lot." },
          newName: { type: "string", description: "update_doctor / update_directory : nouveau nom." },
          title: { type: "string", description: "Grade : professeur, maître de conférences, maître assistant, praticien spécialiste, assistant, résident, généraliste, pharmacien, autre." },
          specialty: { type: "string", description: "Spécialité (texte, ou cible des ops de spécialité)." },
          sector: { type: "string", description: "Secteur : hospitalier, libéral, les deux." },
          institution: { type: "string", description: "Établissement (texte, ou cible de delete_institution)." },
          city: { type: "string", description: "Ville." },
          region: { type: "string", description: "Wilaya / région (fiche, plan de tournée)." },
          phone: { type: "string", description: "Téléphone." },
          email: { type: "string", description: "E-mail." },
          influence: { type: "string", description: "Influence : très élevé / élevé / moyen / faible / très faible." },
          potential: { type: "string", description: "Potentiel (mêmes niveaux)." },
          affinity: { type: "string", description: "Affinité (mêmes niveaux)." },
          person: { type: "string", description: "Le délégué (visite, fiche, plan de tournée)." },
          people: { type: "string", description: "set_directory_access : noms, virgules (« tous » = ouvrir)." },
          field: { type: "string", description: "set_doctor_cell / color_directory_cells : la colonne (lastName, firstName, address, wilaya, postalCode, phone, email, title, sector, specialty, potential, ou la clé « c_… » d'une colonne propre à l'annuaire ; établissements : name, type, sector, wilaya)." },
          value: { type: "string", description: "set_doctor_cell : la valeur (vide = effacer)." },
          lastName: { type: "string", description: "add_doctor_row : nom." },
          firstName: { type: "string", description: "add_doctor_row : prénom." },
          date: { type: "string", description: "Visites / plans : la date (AAAA-MM-JJ)." },
          newDate: { type: "string", description: "duplicate_plan : début de la nouvelle période (défaut : mois suivant)." },
          objective: { type: "string", description: "order_visit : la raison de la visite commandée (« point sur le Nivolex »)." },
          status: { type: "string", description: "update_visit : planifiée seulement — réalisée passe par log_visit, reportée ou annulée se dit depuis « Ma journée »." },
          report: { type: "string", description: "update_visit : compte rendu." },
          feedback: { type: "string", description: "update_visit : retour du médecin." },
          followUp: { type: "string", description: "Actions de suivi : update_visit (compte rendu) ou log_visit (ce qu'il reste à faire après la visite)." },
          products: { type: "string", description: "Produits (cibles de la fiche, présentés en visite, cible du plan)." },
          quantity: { type: "string", description: "create/update_plan : visites cibles." },
          keyTargets: { type: "string", description: "create/update_plan : médecins clés cibles." },
          achieved: { type: "string", description: "update_plan : visites réalisées." },
          directory: { type: "string", description: "Annuaires nommés : l'annuaire visé (« général » pour en sortir)." },
          color: { type: "string", description: "Spécialités : couleur (hex). color_directory_cells : jaune, vert, bleu, orange, rose, violet, rouge, gris — ou « aucune » pour effacer." },
          notes: { type: "string", description: "Notes / objectif / description / commentaire manager." },
        },
        required: ["op"],
      },
    },
  },
  stock_operation: {
    module: "STOCKS",
    ops: zipOps("stock_operation", { ...STOCK_OPS_IMPL, ...STOCK4_OPS_IMPL, ...STOCK_RECURRENCE_OPS_IMPL }),
    def: {
      name: "stock_operation",
      description:
        "STOCKS PCH — demander un état de stock à une personne, une fois ou en RÉCURRENCE (« le 1er de chaque mois, demande à ce KAM l'état de ces hôpitaux » : poser, modifier, suspendre, reprendre, retirer), gérer les LIEUX (hôpitaux / annexes PCH, Super Admin) et enregistrer les ÉTATS DATÉS (« à cette date il reste X unités »), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("stock_operation")}.`,
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("stock_operation"), description: "Le geste à faire." },
          assigneeName: { type: "string", description: "request_state / récurrences : à qui demander l'état de stock (son nom)." },
          hospitals: { type: "string", description: "request_state / récurrences : hôpitaux ciblés, séparés par des virgules. Facultatif — sans aucun, la demande porte sur l'état de stock en général." },
          note: { type: "string", description: "Précision de la demande." },
          location: { type: "string", description: "Nom de l'hôpital / annexe visé(e) (création, suppression, état)." },
          product: { type: "string", description: "États : le produit (DCI ou nom commercial)." },
          kind: { type: "string", description: "record_snapshot : lieu de l'état — PCH (défaut), hôpital, ou annexe." },
          date: { type: "string", description: "États : la date de la mesure (AAAA-MM-JJ)." },
          quantity: { type: "string", description: "record_snapshot : quantité restante (unités, ≥ 0)." },
          // ── LES RÉCURRENCES ────────────────────────────────────────────────────────────
          // Une récurrence réutilise `assigneeName`, `hospitals` et `note` : c'est LA MÊME
          // demande, répétée. Deux jeux de champs pour la même chose feraient écrire
          // « assigneeName » au geste ponctuel et « person » au récurrent, et le modèle
          // choisirait mal la moitié du temps.
          recurrenceName: { type: "string", description: "Récurrences : son NOM — à donner en création, à citer pour modifier / suspendre / retirer." },
          newName: { type: "string", description: "update_stock_recurrence : nouveau nom (renommage)." },
          cadence: { type: "string", description: "Récurrences : DAILY, WEEKLY ou MONTHLY (défaut MONTHLY). Pas d'HOURLY — un relevé de stock est un comptage physique qu'une personne va faire." },
          hourLocal: { type: "string", description: "Récurrences : heure d'Alger, 0 à 23 (défaut 8)." },
          day: { type: "string", description: "Récurrences : jour de la SEMAINE (0 = dimanche … 6 = jeudi) si WEEKLY, jour du MOIS (1 à 31) si MONTHLY." },
          status: { type: "string", description: "set_stock_recurrence_status : ACTIVE ou PAUSED. Sans précision, l'état est basculé." },
        },
        required: ["op"],
      },
    },
  },
  pch_operation: {
    module: "PCH",
    ops: zipOps("pch_operation", { ...PCH_OPS_IMPL, ...FILE_PCH_OPS_IMPL, ...MARKET360_OPS_IMPL }),
    def: {
      name: "pch_operation",
      description:
        "PCH — MARCHÉS 360° : appels d'offres (fiche, caution rejouée), SOUMISSIONS versionnées (créer, déposer-verrouiller), RÉSULTATS par lot (gagné/perdu/infructueux/annulé, attribution partielle), CONTRAT depuis l'attribution + avenants à delta + lignes contractuelles, bons de commande et leurs LIGNES contrôlées contre le restant contractuel, LIVRAISONS (BL, lot, péremption, stock optionnel), analyse IA d'un TEXTE d'AO collé, enrichissement marché, suivi d'arrivée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("pch_operation")}. `
        + "Le marché se donne par référence AO-AAAA-NNN, titre ou produits ; la ligne par sa désignation ; le bon de commande par son n°.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("pch_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "analyze_tender_document : PDF / image de l'appel d'offres — Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          reference: { type: "string", description: "L'appel d'offres visé (AO-AAAA-NNN, titre ou produits)." },
          newReference: { type: "string", description: "update_tender : CORRIGER la référence du marché (elle reste unique — refus nommant le marché qui la porte déjà)." },
          name: { type: "string", description: "create_tender : titre du marché." },
          products: { type: "string", description: "Produits concernés (texte)." },
          supplier: { type: "string", description: "Fournisseur." },
          country: { type: "string", description: "Pays du fournisseur." },
          quantity: { type: "string", description: "Quantité (marché / bon / ligne / vente depuis ligne)." },
          amount: { type: "string", description: "Valeur en DZD (marché, bon) ou prix unitaire (ligne)." },
          status: { type: "string", description: "Statut : marché (non commencé/en cours/terminé/annulé), bon (en attente/validé/livré/payé/annulé), ligne (en attente/chiffré/soumis/gagné/perdu)." },
          date: { type: "string", description: "Date (attribution du marché, réception du bon, arrivée prévue) AAAA-MM-JJ." },
          order: { type: "string", description: "Le bon de commande visé (n° ou produits) — ou le n° à donner à un nouveau bon." },
          line: { type: "string", description: "La ligne visée, par désignation (ligne-produit de l'AO, ligne contractuelle, ligne de BC) — ou la désignation d'une ligne à créer." },
          contract: { type: "string", description: "Le contrat ou l'avenant visé (titre ou référence de la pièce Legal)." },
          delta: { type: "string", description: "create_amendment : impact en DZD sur la valeur du contrat (négatif permis)." },
          force: { type: "string", description: "add_order_line : « oui » pour passer OUTRE un dépassement contractuel refusé — le passage en force est tracé dans l'audit avec son excès." },
          bl: { type: "string", description: "Livraisons : n° du bon de livraison." },
          batch: { type: "string", description: "create_delivery : n° de lot pharmaceutique." },
          expiry: { type: "string", description: "create_delivery : date de péremption (AAAA-MM-JJ)." },
          stock: { type: "string", description: "create_delivery : « oui » pour créer les mouvements de stock (sortie) — uniquement pour un produit résolu sans ambiguïté." },
          newName: { type: "string", description: "update_order / update_line : nouveau n° / nouvelle désignation." },
          dci: { type: "string", description: "update_line : DCI." },
          dosage: { type: "string", description: "update_line : dosage." },
          form: { type: "string", description: "update_line : forme galénique." },
          awardedPrice: { type: "string", description: "update_line : prix unitaire ATTRIBUÉ (DZD)." },
          paymentDate: { type: "string", description: "update_order : date de paiement (AAAA-MM-JJ)." },
          arrivedDate: { type: "string", description: "set_order_arrival : date d'arrivée RÉELLE (AAAA-MM-JJ)." },
          text: { type: "string", description: "analyze_tender_text : le texte du document d'AO, collé." },
          notes: { type: "string", description: "Notes libres." },
        },
        required: ["op"],
      },
    },
  },
  sales_operation: {
    module: "SALES",
    ops: zipOps("sales_operation", SALES_OPS_IMPL),
    def: {
      name: "sales_operation",
      description:
        "VENTES — enregistrer une vente réelle (produit ou service, quantité × prix DZD) ou importer un CSV COLLÉ de ventes, par les actions canoniques. "
        + `Champ « op » : ${opsSummary("sales_operation")}.`,
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("sales_operation"), description: "Le geste à faire." },
          product: { type: "string", description: "create_sale : le produit (ou l'intitulé du service)." },
          client: { type: "string", description: "create_sale : le client (obligatoire)." },
          quantity: { type: "string", description: "create_sale : quantité vendue." },
          amount: { type: "string", description: "create_sale : prix unitaire en DZD." },
          date: { type: "string", description: "create_sale : date de la vente (AAAA-MM-JJ, défaut aujourd'hui)." },
          kind: { type: "string", description: "create_sale : « service » si ce n'est pas un produit." },
          dci: { type: "string", description: "create_sale : DCI du produit." },
          dosage: { type: "string", description: "create_sale : dosage." },
          institution: { type: "string", description: "create_sale : établissement du client." },
          isPch: { type: "string", description: "create_sale : « oui » si vente PCH." },
          csv: { type: "string", description: "import_sales : le CSV collé (en-tête : date,produit,dci,dosage,forme,client,institution,pch,quantité,prix unitaire)." },
        },
        required: ["op"],
      },
    },
  },
  logistics_operation: {
    module: "LOGISTICS",
    ops: zipOps("logistics_operation", LOGISTICS_OPS_IMPL),
    def: {
      name: "logistics_operation",
      description:
        "LOGISTIQUE — créer une commande d'acheminement (fournisseur → PCH) et faire avancer son suivi (expédié, terminal, dédouanement, livré) en datant les jalons, par les actions canoniques. "
        + `Champ « op » : ${opsSummary("logistics_operation")}. `
        + "La commande se donne par référence CMD-AAAA-NNN ou produit.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("logistics_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "update_shipment_status : la commande (CMD-AAAA-NNN ou produit)." },
          product: { type: "string", description: "create_shipment : le produit commandé (obligatoire)." },
          dci: { type: "string", description: "create_shipment : DCI." },
          dosage: { type: "string", description: "create_shipment : dosage." },
          supplier: { type: "string", description: "create_shipment : fournisseur." },
          country: { type: "string", description: "create_shipment : pays d'origine." },
          quantity: { type: "string", description: "Quantité commandée / reçue." },
          amount: { type: "string", description: "create_shipment : valeur de la commande." },
          currency: { type: "string", description: "create_shipment : devise (défaut EUR)." },
          status: { type: "string", description: "Statut : commandé, production, expédié, arrivé au terminal, dédouanement, livré, bloqué." },
          date: { type: "string", description: "create_shipment : date de commande (AAAA-MM-JJ)." },
          departureDate: { type: "string", description: "Départ (estimé à la création ; réel au suivi) AAAA-MM-JJ." },
          arrivalDate: { type: "string", description: "Arrivée (estimée à la création ; réelle au suivi) AAAA-MM-JJ." },
          customsDate: { type: "string", description: "update_shipment_status : date de dédouanement." },
          deliveryDate: { type: "string", description: "update_shipment_status : date de livraison à la PCH." },
          carrier: { type: "string", description: "create_shipment : transporteur." },
          incoterm: { type: "string", description: "create_shipment : incoterm (CIF, FOB…)." },
        },
        required: ["op"],
      },
    },
  },
};

export const DOMAIN_TOOL_DEFS: ClaudeToolDef[] = Object.values(DOMAIN_TOOLS).map((t) => t.def);
