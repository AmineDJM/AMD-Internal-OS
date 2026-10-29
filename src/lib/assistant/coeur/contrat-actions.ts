/**
 * LE CONTRAT DES ACTIONS DE L'ASSISTANT — ce qu'une action proposée transporte
 * (`AssistantActionPayload`),
 * sa politique (externe ? quelle dureté de confirmation ?), la carte montrée (`ProposedAction`)
 * et le résultat d'un tour (`AssistantResult`). Types et registres purs : aucune lecture de données.
 */

import type { BroadcastAudience, Module, DeletableKind } from "@/lib/assistant/coeur/erp";
import type { FaitSource } from "@/platform/in-process/fabric/provenance";
import type { Calibration } from "@/lib/assistant/confidence/calibrate";
import type { TurnSummary } from "@/lib/models/telemetry";
import { DOMAIN_TOOLS } from "@/lib/assistant/ops";

/** Le refus de l'outil de création d'une demande de matériel — le même à la carte et à l'exécution. */
export const REFUS_MATERIEL_PAR_ADAM =
  "Une demande de matériel promotionnel se compose de lignes piochées dans le catalogue (article, quantité, actions attendues du fournisseur) : elle se crée depuis Ad & Pro › Nouvelle demande › Matériel promotionnel, où le formulaire propose le catalogue.";

// ───────────────────────────── Types publics ─────────────────────────────


export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type AssistantActionPayload =
  | {
      /**
       * MODIFIER UN DOSSIER RÉGULATORY, champ par champ.
       *
       * Le champ et la valeur sont RELUS par `parseRegFieldValue` avant d'atteindre la base : la
       * confirmation de l'utilisateur ne remplace pas la validation, personne ne relit une
       * énumération dans une carte de confirmation.
       */
      kind: "update_regulatory_product";
      productId: string;
      reference: string;
      field: string;
      fieldLabel: string;
      /** Valeur déjà validée et convertie, prête à écrire. */
      value: string | string[] | boolean | Date | null;
      /** Valeur actuelle, pour le journal et pour la carte de confirmation. */
      before: string;
      after: string;
    }
  | {
      /**
       * ENVOYER un message DÉJÀ PRÉPARÉ (Adam) — approuve le contenu EXACT, puis expédie.
       *
       * Le corps du message ne voyage PAS dans ce payload : il vit dans l'intention canonique
       * (`OutboundMailIntent`), et c'est elle que le serveur relit. Confirmer une carte ne peut
       * donc pas expédier autre chose que ce qui a été montré — l'empreinte du contenu est
       * revérifiée au moment de l'envoi.
       */
      kind: "send_prepared_mail";
      intentId: string;
      subject: string;
      recipients: string[];
      missionId: string | null;
    }
  | {
      /**
       * BASCULER LA POLITIQUE D'ENVOI — le réglage qui décide si Adam peut expédier seul.
       *
       * Passer en envoi autonome retire l'approbation du PDG sur TOUT ce qui sortira ensuite :
       * c'est un changement de sécurité, il se ressaisit (confirmation renforcée). Revenir à
       * l'approbation est immédiat — on ne freine jamais un retour à la prudence.
       */
      kind: "set_mail_policy";
      policy: "REQUIRE_APPROVAL" | "AUTO_SEND" | "DRAFT_ONLY";
      before: string;
    }
  | {
      /** CONFIER un dossier (« Chargé du dossier ») — exécuté par l'ACTION CANONIQUE de
       *  l'écran (`setRegulatoryResponsible`) : même règle (Super Admin), même audit, même
       *  notification. Jamais une deuxième logique métier. */
      kind: "assign_regulatory_responsible";
      productId: string;
      reference: string;
      dci: string;
      responsibleId: string | null;
      responsibleName: string | null;
      before: string;
    }
  | {
      /** UNE étape ANPP (statut ou avis de présoumission) — exécutée par les actions
       *  canoniques `setRegulatoryStepState` / `setRegulatoryPresubOutcome`. */
      kind: "set_regulatory_step";
      productId: string;
      reference: string;
      stepKey: string;
      stepLabel: string;
      status: string | null;
      outcome: string | null;
      note: string | null;
      date: string | null;
    }
  | {
      /**
       * MODIFIER UN RÉGLAGE DE LA PLATEFORME (Super Admin).
       *
       * Même principe : seule la liste blanche de `WRITABLE_SETTINGS` est atteignable, et la
       * valeur est bornée avant d'être proposée.
       */
      kind: "update_platform_setting";
      settingKey: string;
      settingLabel: string;
      value: string | number | boolean | string[];
      before: string;
      after: string;
    }
  | {
      /**
       * SUPPRESSION DÉFINITIVE d'un enregistrement (Super Admin) — exécutée par l'ACTION
       * CANONIQUE du bouton rouge des fiches (`superAdminDelete`) : même porte (rôle revérifié
       * côté action), même instantané déposé en corbeille (restaurable), même audit. Jamais un
       * `prisma.delete` improvisé.
       */
      kind: "delete_record";
      deleteKind: DeletableKind;
      targetId: string;
      /** Nom affiché de l'élément (le `describe` du registre), pour la carte et le reçu. */
      name: string;
      /** Libellé du type (« dossier réglementaire ») + liste de retour, copiés du registre. */
      label: string;
      redirect: string;
    }
  | {
      /** RESTAURER un élément de la corbeille — action canonique `restoreDeletedRecord`
       *  (recréation à l'identique + pièces + commentaires, mêmes id/référence). */
      kind: "restore_record";
      recordId: string;
      name: string;
      label: string;
    }
  | {
      /** DÉTRUIRE RÉELLEMENT une entrée de la corbeille (fichiers effacés) — action canonique
       *  `destroyDeletedRecord`. Contrairement à `delete_record`, il n'y a AUCUN retour. */
      kind: "purge_record";
      recordId: string;
      name: string;
      label: string;
    }
  | {
      /** RELANCE Regulatory : demander une mise à jour de statut au responsable/assistant/
       *  participants — action canonique `requestRegulatoryStatusUpdate` (notifications). */
      kind: "request_regulatory_status_update";
      productId: string;
      reference: string;
      dci: string;
      note: string | null;
      recipients: string[];
    }
  | {
      /** ACTION NATIVE Finances « Demander l'actualisation des soldes » — exécutée par l'action
       *  canonique `requestTreasuryUpdate` (notification des responsables Finances + audit). */
      kind: "request_treasury_update";
      note: string | null;
    }
  | {
      /** RECONFIGURER (ou réinitialiser) un CIRCUIT DE VALIDATION Ad&Pro — exécuté par le
       *  builder canonique `saveWorkflowDefinition` / `resetWorkflowDefinition` (Super Admin,
       *  remplacement intégral validé côté action). `payloadJson` = le JSON exact du builder. */
      kind: "configure_workflow";
      category: string;
      categoryLabel: string;
      payloadJson: string | null;
      reset: boolean;
      stepTitles: string[];
    }
  | {
      /** DÉCIDER une étape de circuit (approuver / refuser / SAUTER avec raison) — exécuté par
       *  l'action canonique `advanceWorkflow` : le MOTEUR re-vérifie qui a le droit d'agir. */
      kind: "advance_workflow";
      category: string;
      entityType: string;
      entityId: string;
      display: string;
      action: "APPROVE" | "REJECT" | "SKIP";
      note: string | null;
      amount: number | null;
    }
  | {
      /** CHAMP PERSONNALISÉ d'un module (créer / modifier — dont OBLIGATOIRE — / supprimer) —
       *  exécuté par les actions canoniques `upsertCustomFieldDef` / `deleteCustomFieldDef`. */
      kind: "manage_custom_field";
      op: "CREATE" | "UPDATE" | "DELETE";
      defId: string | null;
      entityType: string;
      entityTypeLabel: string;
      label: string;
      type: string;
      options: string | null;
      required: boolean;
      order: number | null;
    }
  | {
      /** ACTIVER / DÉSACTIVER un compte — action canonique `toggleUserActive`. L'état CIBLE est
       *  mémorisé pour rendre l'exécution idempotente (le toggle brut ne l'est pas). */
      kind: "set_account_active";
      userId: string;
      userName: string;
      active: boolean;
    }
  | {
      /** RÔLE (et rôle secondaire) d'un compte — actions canoniques `updateUserRole` /
       *  `setSecondaryRole`. Un champ absent (null) = inchangé ; secondaryRole "" = retirer. */
      kind: "set_account_role";
      userId: string;
      userName: string;
      role: string | null;
      roleBefore: string;
      secondaryRole: string | null;
      secondaryBefore: string;
    }
  | {
      /**
       * Rattacher des produits Regulatory à une entité — éventuellement PLUSIEURS d'un coup.
       * L'assistant décrit le lot par un FILTRE, jamais par une liste devinée : on relit le
       * filtre au moment d'exécuter, donc ce qui est modifié est exactement ce qui a été montré.
       */
      kind: "set_products_company";
      companyId: string;
      companyName: string;
      /** Filtre du lot, tel qu'il a servi à compter et à lister l'aperçu. */
      query?: string | null;
      category?: string | null;
      onlyWithoutCompany?: boolean;
      /** Références concernées, pour que la confirmation montre ce qui va changer. */
      references: string[];
    }
  | {
      kind: "create_task";
      title: string;
      description?: string | null;
      assigneeId?: string | null;
      assigneeName?: string | null;
      dueDate?: string | null;
      priority?: string | null;
    }
  | {
      kind: "create_admin_request";
      type: string;
      title: string;
      description?: string | null;
      /** Ignorés depuis 10/2026 (la demande va à l'assistante de direction) — lus sur d'anciennes cartes. */
      assigneeId?: string | null;
      assigneeName?: string | null;
      concernedId?: string | null;
      concernedName?: string | null;
      deadline?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      priority?: string | null;
    }
  | {
      kind: "send_message";
      recipientId?: string | null;
      recipientName?: string | null;
      body: string;
    }
  | {
      kind: "send_email";
      to: string;
      cc?: string | null;
      subject: string;
      body: string;
    }
  | {
      kind: "create_congress_request";
      scope: "INTL" | "NATIONAL";
      name: string;
      specialty?: string | null;
      city?: string | null;
      country?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      estimatedBudget?: number | null;
      doctorId?: string | null;
      doctorName?: string | null;
      note?: string | null;
    }
  | {
      kind: "create_dossier";
      title: string;
      description?: string | null;
      category?: string | null;
      assigneeId?: string | null;
      assigneeName?: string | null;
      priority?: string | null;
      dueDate?: string | null;
    }
  | {
      kind: "create_notification";
      audience: BroadcastAudience;
      role?: string | null;
      userIds?: string[];
      recipientNames?: string | null;
      title: string;
      body?: string | null;
      link?: string | null;
      popup?: boolean;
    }
  | {
      kind: "create_calendar_event";
      title: string;
      date: string;
      time?: string | null;
      durationMin?: number | null;
      allDay?: boolean;
      eventKind?: string | null;
      location?: string | null;
      meetLink?: string | null;
      description?: string | null;
      inviteeIds?: string[];
      inviteeNames?: string | null;
    }
  | {
      kind: "create_hr_request";
      type: string; // HrRequestType
      details?: string | null;
      expenseMonth?: string | null; // YYYY-MM (note de frais)
      periodStart?: string | null;
      periodEnd?: string | null;
    }
  | {
      kind: "create_sponsoring_request";
      institution: string;
      type?: string | null;
      specialty?: string | null;
      city?: string | null;
      amountRequested?: number | null;
      product?: string | null;
      description?: string | null;
      doctorName?: string | null;
    }
  | {
      kind: "create_event_request";
      name: string;
      specialty?: string | null;
      city?: string | null;
      country?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      estimatedBudget?: number | null;
      description?: string | null;
    }
  | {
      kind: "create_promo_material_request";
      title: string;
      materialType?: string | null;
      amount?: number | null;
      description?: string | null;
    }
  | {
      /**
       * TRANCHER UN PAIEMENT AU CENTRE — autoriser ou refuser, les deux seules décisions du centre
       * depuis le 02/09/2026 (le schéma de l'outil le dit ; le type garde les deux autres pour les
       * cartes d'avant, que l'action refuse). Toujours confirmé par la carte ; l'exécution repasse par
       * l'action du centre (`decidePayment`), qui revérifie QUI siège et si la décision a encore un sens.
       */
      kind: "decide_payment";
      orderId: string;
      reference: string;
      label: string;
      amountDzd: number;
      decision: "APPROVE" | "REFUSE" | "REQUEST_CHANGES" | "REQUEST_INFO";
      note?: string | null;
      proposedAmount?: number | null;
    }
  | {
      /**
       * MODIFIER UNE TÂCHE — réassigner, changer l'échéance / la priorité / le statut, commenter.
       * La cible est résolue à la proposition (identifiant stocké) et le droit revérifié à
       * l'exécution : sa propre tâche, ou n'importe laquelle pour une vue globale.
       */
      kind: "update_task";
      taskId: string;
      taskTitle: string;
      assigneeId?: string | null;
      assigneeName?: string | null;
      dueDate?: string | null;
      clearDueDate?: boolean;
      priority?: string | null;
      status?: string | null;
      comment?: string | null;
    }
  | {
      /**
       * MODIFIER UNE DEMANDE DU SECRÉTARIAT — statut, responsable, commentaire. L'exécution
       * repasse par les actions du module (`updateRequestStatus`, `assignRequest`,
       * `addRequestComment`) : mêmes gardes, mêmes notifications, même archivage.
       */
      kind: "update_request";
      requestId: string;
      reference: string;
      status?: string | null;
      assigneeId?: string | null;
      assigneeName?: string | null;
      comment?: string | null;
    }
  | {
      /**
       * DÉCLARER UNE PIÈCE LEGAL (devis, BC, facture, contrat…) — éventuellement CHAÎNÉE à sa
       * pièce amont (le BC de son devis, la facture de son BC). Exécution via
       * `createLegalDocument` : mêmes contrôles que le formulaire.
       */
      kind: "create_legal_document";
      docKind: string;
      title: string;
      reference?: string | null;
      counterparty?: string | null;
      amount?: number | null;
      startDate?: string | null;
      endDate?: string | null;
      notes?: string | null;
      chainFromId?: string | null;
      chainFromLabel?: string | null;
    }
  | {
      /**
       * MODIFIER UNE PIÈCE LEGAL. `updateLegalDocument` REMPLACE tous les champs : l'exécution
       * relit donc la fiche et n'écrase que ce qui a été demandé — jamais un champ par omission.
       */
      kind: "update_legal_document";
      documentId: string;
      currentTitle: string;
      updates: {
        title?: string | null;
        reference?: string | null;
        counterparty?: string | null;
        amount?: number | null;
        startDate?: string | null;
        endDate?: string | null;
        notes?: string | null;
        chainFromId?: string | null;
      };
      changes: string[];
    }
  | {
      /**
       * DÉPLACER / ANNULER UN RENDEZ-VOUS du calendrier. Même règle que l'écran : seul
       * l'organisateur (ou une vue globale) modifie. L'exécution relit l'événement et
       * n'écrase que ce qui change.
       */
      kind: "update_calendar_event";
      eventId: string;
      eventTitle: string;
      cancel?: boolean;
      date?: string | null;
      time?: string | null;
      durationMin?: number | null;
      location?: string | null;
      changes: string[];
    }
  | {
      /** AJOUTER UN HÔPITAL — à la liste des lieux de stock (STOCKS) ou à l'annuaire médical. */
      kind: "create_hospital";
      registre: "STOCKS" | "ANNUAIRE";
      name: string;
      annexKind?: "HOSPITAL" | "ANNEX";
    /** STOCKS : l'établissement de l'annuaire que le lieu désigne (§118.134) — jamais un nom libre. */
    institutionId?: string | null;
      institutionType?: string | null;
      sector?: string | null;
      wilaya?: string | null;
      city?: string | null;
    }
  | {
      /** MODIFIER UN ÉTABLISSEMENT de l'annuaire médical (l'exécution relit puis fusionne). */
      kind: "update_hospital";
      institutionId: string;
      name: string;
      updates: {
        newName?: string | null;
        type?: string | null;
        sector?: string | null;
        wilaya?: string | null;
        city?: string | null;
        phone?: string | null;
        email?: string | null;
        notes?: string | null;
        isActive?: boolean | null;
      };
      changes: string[];
    }
  | {
      /**
       * MODIFIER UN SALAIRE — NIVEAU CRITIQUE. Chaque champ porte son AVANT (relu au moment de
       * la proposition) et son APRÈS ; l'exécution revérifie que la fiche n'a pas bougé entre
       * les deux (sinon elle refuse : on ne signe pas un montant sur une photo périmée).
       */
      kind: "update_salary";
      employeeId: string;
      employeeName: string;
      fields: {
        field: "baseSalary" | "netToPay" | "grossSalary" | "employerCost";
        label: string;
        before: number | null;
        after: number;
      }[];
      note?: string | null;
    }
  | {
      /**
       * OP DE DOMAINE générique (drive_operation, task_operation…) — le mécanisme SYSTÉMIQUE :
       * la proposition a résolu les entrées humaines (noms → ids) via l'implémentation du
       * catalogue (`assistant/ops`), l'exécution rejoue les `args` sur l'ACTION CANONIQUE de
       * l'écran, qui revalide tout (droits, existence, invariants).
       */
      kind: "domain_op";
      tool: string;
      op: string;
      opLabel: string;
      args: Record<string, string | null>;
      successMessage: string;
      link?: string;
      revalidate?: string[];
    }
  | {
      /**
       * LOT — la même action native répétée sur PLUSIEURS cibles : UNE carte de confirmation,
       * exécution séquentielle best-effort avec REÇU PAR CIBLE (un refus n'annule pas le reste).
       * Chaque item porte le payload COMPLET déjà résolu par `buildProposal` (récursif).
       */
      kind: "bulk_action";
      innerTool: string;
      summary: string;
      items: { payload: AssistantActionPayload; display: string }[];
    }
  | {
      /**
       * PLAN D'ACTIONS ENCHAÎNÉES — une séquence d'écritures DÉPENDANTES en UNE carte.
       * Les étapes sans dépendance sont RÉSOLUES à la proposition (payload complet) ; une
       * étape qui référence « $prev.<champ> » est DIFFÉRÉE : à l'exécution, la valeur du champ
       * de l'étape précédente (ou son id créé) est substituée, puis l'étape repasse par
       * `buildProposal` (mêmes portes, même résolution) avant d'être exécutée. Un maillon qui
       * casse ARRÊTE la chaîne — le reçu dit où.
       */
      kind: "action_plan";
      summary: string;
      steps: (
        | { kind: "resolved"; payload: AssistantActionPayload; display: string }
        | { kind: "deferred"; tool: string; input: Record<string, string>; display: string }
      )[];
    };

export type AssistantActionKind = AssistantActionPayload["kind"];

/**
 * LA POLITIQUE D'ACTION — un registre, pas des if épars.
 *
 * Chaque action confirmée déclare :
 *   • `external` — touche-t-elle le MONDE RÉEL (quelqu'un est prévenu, une donnée métier change) ?
 *     C'est ce que coupe l'ARRÊT D'URGENCE (`aiExternalActionsDisabled`) : quand il est levé,
 *     AUCUNE action externe ne s'exécute, même confirmée. Les lectures et analyses continuent.
 *   • `level` — la dureté de la confirmation (voir `ProposedAction.level`).
 *
 * Principe (Executive AI OS) : l'IA est très autonome dans la RECHERCHE et le RAISONNEMENT,
 * conservatrice dans l'EXÉCUTION — et l'exécution reste toujours sous autorité humaine.
 */
export const ACTION_POLICY: Record<AssistantActionKind, { external: boolean; level?: "SENSITIVE" | "CRITICAL" }> = {
  update_regulatory_product: { external: true },
  assign_regulatory_responsible: { external: true },
  set_regulatory_step: { external: true },
  update_platform_setting: { external: true, level: "SENSITIVE" },
  delete_record: { external: true, level: "CRITICAL" },
  restore_record: { external: true },
  purge_record: { external: true, level: "CRITICAL" },
  request_regulatory_status_update: { external: true },
  request_treasury_update: { external: true },
  configure_workflow: { external: true, level: "SENSITIVE" },
  advance_workflow: { external: true, level: "SENSITIVE" },
  manage_custom_field: { external: true, level: "SENSITIVE" },
  set_account_active: { external: true, level: "SENSITIVE" },
  set_account_role: { external: true, level: "SENSITIVE" },
  set_products_company: { external: true },
  create_task: { external: true },
  create_admin_request: { external: true },
  send_message: { external: true },
  send_email: { external: true },
  create_congress_request: { external: true },
  create_dossier: { external: true },
  create_notification: { external: true },
  create_calendar_event: { external: true },
  create_hr_request: { external: true },
  create_sponsoring_request: { external: true },
  create_event_request: { external: true },
  create_promo_material_request: { external: true },
  decide_payment: { external: true, level: "SENSITIVE" },
  update_task: { external: true },
  update_request: { external: true },
  create_legal_document: { external: true },
  update_legal_document: { external: true },
  update_calendar_event: { external: true },
  create_hospital: { external: true },
  update_hospital: { external: true },
  update_salary: { external: true, level: "CRITICAL" },
  // Le niveau réel d'une op de domaine vient de son entrée au CATALOGUE (risk) — porté par la
  // carte ; idem pour un lot (niveau = max des items). `external` suffit ici (kill-switch).
  send_prepared_mail: { external: true, level: "SENSITIVE" },
  set_mail_policy: { external: true, level: "SENSITIVE" },
  domain_op: { external: true },
  bulk_action: { external: true },
  action_plan: { external: true },
};

/**
 * Niveau d'une étape DIFFÉRÉE d'un plan, déterminé AVANT résolution : l'outil (et l'op, pour un
 * outil de domaine) suffisent — le niveau ne dépend jamais des valeurs, seulement du geste.
 * C'est ce qui permet à une étape « delete sur $prev.name » de rendre le plan CRITIQUE dès la carte.
 */
export function deferredStepLevel(tool: string, op: string | undefined): "SENSITIVE" | "CRITICAL" | undefined {
  const policy = (ACTION_POLICY as Record<string, { external: boolean; level?: "SENSITIVE" | "CRITICAL" }>)[tool];
  if (policy?.level) return policy.level;
  const risk = op ? DOMAIN_TOOLS[tool]?.ops[op]?.meta.risk : undefined;
  return risk === "CRITICAL" ? "CRITICAL" : risk === "SENSITIVE" ? "SENSITIVE" : undefined;
}

/**
 * Ce payload exige-t-il la CONFIRMATION FORTE (ressaisie) ? Utilisé par le SERVEUR pour refuser
 * d'exécuter une action CRITIQUE qui arriverait sans son intent (carte périmée, appel forgé) :
 * le niveau se recalcule depuis le payload lui-même — jamais depuis ce que le client prétend.
 * Pour une op de domaine, le niveau vit au CATALOGUE (risk) ; un lot ou un plan est critique
 * dès qu'UN de ses éléments l'est (même règle que le niveau affiché sur la carte).
 */
export function payloadRequiresStrongConfirm(p: AssistantActionPayload): boolean {
  if (ACTION_POLICY[p.kind]?.level === "CRITICAL") return true;
  // Passer en ENVOI AUTONOME retire l'approbation du PDG sur tout ce qui sortira ensuite : c'est
  // le seul changement de réglage qui exige une RESSAISIE, dans les deux chemins d'exécution.
  if (p.kind === "set_mail_policy") return p.policy === "AUTO_SEND";
  if (p.kind === "domain_op") return DOMAIN_TOOLS[p.tool]?.ops[p.op]?.meta.risk === "CRITICAL";
  if (p.kind === "bulk_action") return p.items.some((it) => payloadRequiresStrongConfirm(it.payload));
  if (p.kind === "action_plan") {
    return p.steps.some((s) =>
      s.kind === "resolved"
        ? payloadRequiresStrongConfirm(s.payload)
        : deferredStepLevel(s.tool, s.input.op) === "CRITICAL",
    );
  }
  return false;
}

export interface ProposedAction {
  kind: AssistantActionKind;
  /** Module RBAC qui garde l'exécution (affiché + revérifié). */
  module: Module;
  /** Titre court de la carte de confirmation. */
  title: string;
  /** Champs résolus à afficher (libellé → valeur). */
  fields: { label: string; value: string }[];
  /** Avertissements (ex. destinataire introuvable). */
  warnings: string[];
  /**
   * Niveau de gravité de l'action, pour l'UI de confirmation. `CRITICAL` (paie, salaires)
   * exige une CONFIRMATION FORTE : la carte fait RESSAISIR le montant avant d'armer le bouton.
   * `SENSITIVE` (paiements, réglages plateforme) est marqué visuellement. Absent = confirmation
   * standard. Ce niveau n'accorde AUCUN droit — il ne fait que durcir l'UI.
   */
  level?: "SENSITIVE" | "CRITICAL";
  /** CRITICAL uniquement : la valeur exacte que l'utilisateur doit RESSAISIR pour confirmer. */
  confirmText?: string;
  /** Charge utile revérifiée et exécutée côté serveur après confirmation. */
  payload: AssistantActionPayload;
  /**
   * L'INTENT persistant (AssistantActionIntent) créé à la proposition — l'état CANONIQUE
   * serveur de cette action (PROPOSED → … → EXECUTED). L'UI le renvoie à la confirmation :
   * exécution idempotente + reçu. Absent seulement si la persistance a échoué (l'action
   * reste exécutable, sans reçu canonique).
   */
  intentId?: string;
}

/** Mesures de la boucle agent — pour le journal `AiUsageLog`, jamais montrées telles quelles. */
export interface AssistantMetrics {
  /** Délai avant le PREMIER mot affiché (le ressenti), en ms. */
  ttftMs: number | null;
  /** Tours modèle ↔ outils consommés. */
  turns: number;
  toolCalls: number;
  toolErrors: number;
  /** Temps TOTAL passé dans les outils (ms) — ce qui distingue un modèle lent d'un SQL lent. */
  toolLatencyMs: number;
}

export interface AssistantResult {
  configured: boolean;
  ok: boolean;
  reply: string;
  /** Étapes de lecture effectuées (transparence dans l'UI). */
  trace: string[];
  /** Action à confirmer avant exécution, le cas échéant. */
  proposal?: ProposedAction;
  /**
   * TOUTES les actions proposées dans CE tour — « crée les trois tâches » rend TROIS cartes et
   * un « Tout confirmer », pas trois allers-retours. `proposal` reste la première (compatibilité).
   * Chacune s'exécute (ou s'annule) individuellement ; la confirmation groupée les enchaîne.
   */
  proposals?: ProposedAction[];
  /**
   * LES CARTES DES TOURS PRÉCÉDENTS QUE CE TOUR REND CADUQUES — leurs identifiants d'intention.
   *
   * Le banc live a montré la scène : une tâche proposée pour Raihana, puis « non, finalement
   * Amel ». Le serveur retire bien la première (`CANCELLED`, et `executeIntentGuarded` la
   * refuse), mais l'écran continuait de PEINDRE son bouton — un geste offert que le serveur
   * refusera. Ces identifiants voyagent donc jusqu'au client, qui éteint les boutons devenus
   * sans objet. La sécurité vivait déjà côté serveur ; ce qui manquait, c'était de le DIRE.
   */
  perimees?: string[];
  /** Fil de conversation dans lequel l'échange a été mémorisé (mémoire personnelle). */
  threadId?: string | null;
  /** Mesures de la boucle (flux uniquement) — journalisées par la route, pas affichées. */
  metrics?: AssistantMetrics;
  /** Le TOUR mesuré : appels par rôle, jetons, cache, coût (null si un tarif manque) — pour la persistance. */
  turn?: TurnSummary;
  /**
   * LES FAITS SERVIS dans ce tour, avec leur provenance (F8) — consignés par l'entrée pour
   * « d'où tu tiens ça ? ». `[]` = un tour qui n'a rien lu (consigné tel quel) ; `null`/absent =
   * rien à consigner (réponse déterministe, accord parlé).
   */
  provenance?: FaitSource[] | null;
  /** LA CALIBRATION du tour (§29) : certitude (certain … contradiction) et conduite (agir … arbitrer), décidées par le code. */
  calibration?: Calibration | null;
  error?: string;
}
