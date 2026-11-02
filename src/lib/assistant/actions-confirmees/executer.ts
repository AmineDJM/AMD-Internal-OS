/**
 * EXÉCUTER UNE ACTION CONFIRMÉE — le seul point d'écriture du chatbot. `performAction` applique
 * l'arrêt d'urgence puis parcourt l'ancienne chaîne de `if`, dans son ordre.
 * LES BRANCHES QUI ÉCRIVENT RESTENT ICI : le contrat des actions (`actions/contrat.ts`) lit le CORPS
 * de `performAction` pour dire ce qu'écrit une action d'Adam. Les séries sans écriture directe vivent
 * à côté (`actions-confirmees/*.ts`) et sont appelées à leur rang.
 */

import {
  MailSendPolicy, type AdminRequestType, type CalendarEventKind, type HrRequestType, prisma, companyIdForNew,
  companyScopedWhere, createWithRetry, recordAudit, notifyUser, notifyRoles, broadcastNotification,
  createEventForUser, algiersInputToUtc, CALENDAR_KINDS, envoyerMessageDirect, userCan, hasGlobalView,
  scopeRegulatory, updateCalendarEvent, deleteCalendarEvent, setMailSendPolicy, POLICY_LABEL, updateInstitution,
  type CurrentUser, getAppSettings,
} from "@/lib/assistant/coeur/erp";
import { doubleEcrireCoffre } from "@/platform/in-process/capacites";
import { lienTache, lienConversation } from "@/lib/chemins/espace";
import { lienDemandeRhATraiter, lienMaDemandeRh } from "@/lib/chemins/rh";
import { toNumber, formatMontant } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/labels";
import { regFieldSpec, settingSpec } from "@/lib/assistant/admin-write";
import { sansBloquer } from "@/lib/journal";
import { type AssistantActionPayload, ACTION_POLICY } from "@/lib/assistant/coeur/contrat-actions";
import {
  HR_REQUEST_FR, HR_REQUEST_TYPES, HR_LEAVE_TYPES, HR_PERIOD_TYPES, YM_RE,
} from "@/lib/assistant/outils/catalogue-lecture";
import { productBulkWhere } from "@/lib/assistant/propositions/aides";
import {
  type ExecuteResult, activeUserId, nextRequestRef, priorityOf, dateValue, type ContexteExecution,
} from "@/lib/assistant/actions-confirmees/aides";
import { executerComposees } from "@/lib/assistant/actions-confirmees/composees";
import {
  executerChargeEtEtapeRegulatory, executerCorbeilleEtAdministration,
} from "@/lib/assistant/actions-confirmees/reglementaire-et-administration";
import {
  executerTacheEtDossier, executerCourrielPrepare, executerEnvoiCourriel, executerPriseEnCharge,
  executerDemandesEtPaiement,
} from "@/lib/assistant/actions-confirmees/espace-et-demandes";
import { executerDemandeEtJuridique, executerAjoutEtablissement } from "@/lib/assistant/actions-confirmees/suivi-et-referentiels";

/**
 * Exécute une action confirmée. **Toujours ré-autorisé** par rapport aux droits
 * réels (jamais sur la seule confiance du client) puis journalisé. Le wrapper
 * `executeAssistantAction` (« use server ») fournit l'utilisateur authentifié et
 * applique la revalidation. C'est le seul point d'écriture du chatbot.
 */
export async function performAction(user: CurrentUser, payload: AssistantActionPayload): Promise<ExecuteResult> {
  // ARRÊT D'URGENCE : quand le Super Admin l'a levé, AUCUNE action externe ne passe — même
  // confirmée, même la sienne. Le refus est dit tel quel : prétendre exécuter serait pire.
  if (payload?.kind && ACTION_POLICY[payload.kind]?.external) {
    const settings = await getAppSettings().catch(sansBloquer("assistant.performAction.getAppSettings", null));
    if (settings?.aiExternalActionsDisabled) {
      return {
        ok: false,
        error: "Les actions externes de l'assistant sont DÉSACTIVÉES (arrêt d'urgence, réglé par le Super Admin). Les lectures et analyses restent disponibles.",
      };
    }
  }

  const ctx: ContexteExecution = { user, payload, performAction };

  const rComposees = await executerComposees(ctx);
  if (rComposees !== undefined) return rComposees;

  if (payload?.kind === "update_regulatory_product") {
    if (!userCan(user, "REGULATORY", "UPDATE")) return { ok: false, error: "Vous n'avez pas le droit de modifier les dossiers Regulatory." };
    const spec = regFieldSpec(payload.field);
    if (!spec) return { ok: false, error: "Champ non modifiable." };

    // On REVÉRIFIE le périmètre à l'exécution : entre l'aperçu et le clic, le dossier a pu
    // changer d'entité — ou la personne, de portée.
    const target = await prisma.regulatoryProduct.findFirst({
      where: await companyScopedWhere(user.id, { AND: [{ id: payload.productId }, scopeRegulatory(user)] }),
      select: { id: true, reference: true },
    });
    if (!target) return { ok: false, error: "Ce dossier n'est plus dans votre périmètre." };

    await prisma.regulatoryProduct.update({
      where: { id: target.id },
      data: { [payload.field]: payload.value, updatedById: user.id } as Record<string, unknown>,
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA",
      entityType: "REGULATORY_PRODUCT", entityId: target.id,
      field: payload.fieldLabel, oldValue: payload.before, newValue: payload.after,
      summary: `${target.reference} — ${payload.fieldLabel} : ${payload.before || "(vide)"} → ${payload.after || "(vide)"} (via l'assistant)`,
    });
    return {
      ok: true,
      message: `${target.reference} — ${payload.fieldLabel} : ${payload.after || "(vide)"}.`,
      link: `/regulatory/${target.id}`,
      revalidate: ["/regulatory", `/regulatory/${target.id}`],
    };
  }

  const rChargeEtEtapeRegulatory = await executerChargeEtEtapeRegulatory(ctx);
  if (rChargeEtEtapeRegulatory !== undefined) return rChargeEtEtapeRegulatory;

  if (payload?.kind === "update_platform_setting") {
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Les réglages de la plateforme sont réservés au Super Admin." };
    if (!settingSpec(payload.settingKey)) return { ok: false, error: "Réglage non modifiable." };

    // La ligne « global » est créée si elle n'existe pas encore : une plateforme neuve tourne
    // sur les valeurs par défaut, sans enregistrement en base.
    await prisma.appSetting.upsert({
      where: { id: "global" },
      update: { [payload.settingKey]: payload.value } as Record<string, unknown>,
      create: { id: "global", [payload.settingKey]: payload.value } as Record<string, unknown> & { id: string },
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA",
      field: payload.settingLabel, oldValue: payload.before, newValue: payload.after,
      summary: `Réglage « ${payload.settingLabel} » : ${payload.before} → ${payload.after} (via l'assistant)`,
    });
    return {
      ok: true,
      message: `« ${payload.settingLabel} » : ${payload.after}.`,
      link: "/admin/settings",
      // Un réglage touche la plateforme entière (menu compris quand il s'agit des modules
      // masqués) : on rafraîchit la mise en page, pas une page.
      revalidate: ["/", "/admin/settings"],
    };
  }

  const rCorbeilleEtAdministration = await executerCorbeilleEtAdministration(ctx);
  if (rCorbeilleEtAdministration !== undefined) return rCorbeilleEtAdministration;

  if (payload?.kind === "set_products_company") {
    if (!userCan(user, "REGULATORY", "UPDATE")) return { ok: false, error: "Vous n'avez pas le droit de modifier les dossiers Regulatory." };
    const company = await prisma.company.findFirst({
      where: { id: payload.companyId, isActive: true },
      select: { id: true, name: true, shortName: true },
    });
    if (!company) return { ok: false, error: "Entité introuvable ou désactivée." };

    // On REJOUE le filtre montré à la confirmation, puis on l'INTERSECTE avec les références
    // affichées : le filtre garantit qu'on reste dans le périmètre de la personne, la liste
    // garantit qu'on ne touche pas un produit créé entre l'aperçu et le clic.
    const where = productBulkWhere(user, {
      query: payload.query, category: payload.category,
      onlyWithoutCompany: payload.onlyWithoutCompany, excludeCompanyId: company.id,
    });
    const refs = Array.isArray(payload.references) ? payload.references.filter((r) => typeof r === "string") : [];
    if (refs.length === 0) return { ok: false, error: "Aucun produit à rattacher." };

    const targets = await prisma.regulatoryProduct.findMany({
      where: { AND: [where, { reference: { in: refs } }] },
      select: { id: true, reference: true },
    });
    if (targets.length === 0) return { ok: false, error: "Ces produits ne sont plus concernés (déjà rattachés, ou hors de votre périmètre)." };

    await prisma.regulatoryProduct.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { companyId: company.id },
    });
    const label = company.shortName || company.name;
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA", entityType: "REGULATORY_PRODUCT",
      entityId: targets[0].id,
      summary: `${targets.length} produit(s) rattaché(s) à l'entité ${label} via l'assistant : ${targets.map((t) => t.reference).join(", ")}`,
    });
    return {
      ok: true,
      message: `${targets.length} produit(s) rattaché(s) à ${label}.`,
      link: "/regulatory",
      revalidate: ["/regulatory", "/regulatory/produits"],
    };
  }

  const rTacheEtDossier = await executerTacheEtDossier(ctx);
  if (rTacheEtDossier !== undefined) return rTacheEtDossier;

  if (payload?.kind === "create_admin_request") {
    if (!userCan(user, "ADMIN_REQUESTS", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit de créer une demande administrative." };
    // Plus de `HR_SIMPLE` : une demande RH se pose dans le module RH (§118.138).
    // Plus de `DRIVER` non plus : les missions chauffeur ne se créent plus (Direction, 10/2026).
    const validTypes: AdminRequestType[] = ["TRAVEL", "MAIL", "SIGNATURE", "PURCHASE", "QUOTE", "PAYMENT", "GUEST_VISA", "OTHER"];
    const type = (payload.type ?? "").toUpperCase() as AdminRequestType;
    const title = (payload.title ?? "").trim();
    if (!validTypes.includes(type)) return { ok: false, error: "Type de demande invalide." };
    if (!title) return { ok: false, error: "Titre de demande manquant." };

    // LA DEMANDE VA DIRECTEMENT À L'ASSISTANTE DE DIRECTION (Direction, 10/2026) : ni responsable ni personne
    // concernée — une ancienne carte qui en porte encore n'est pas suivie sur ce point.
    const extraFields: Record<string, string> = {};
    if (payload.startDate) extraFields.dateDebut = payload.startDate;
    if (payload.endDate) extraFields.dateFin = payload.endDate;
    // Référence recalculée à CHAQUE tentative (robuste à une collision concurrente / post-suppression).
    const created = await createWithRetry(async () => {
      const reference = await nextRequestRef();
      return prisma.administrativeRequest.create({
        data: {
          reference, title, type,
          description: payload.description?.trim() || null,
          priority: priorityOf(payload.priority),
          deadline: dateValue(payload.deadline) ?? dateValue(payload.startDate),
          fields: Object.keys(extraFields).length ? extraFields : undefined,
          requesterId: user.id, createdById: user.id,
          // Entité : même règle que par formulaire — la portée en cours, sinon la société
          // d'appartenance. Une demande créée par l'assistant n'échappe pas au cloisonnement.
          companyId: await companyIdForNew(user.id),
        },
        select: { id: true, reference: true },
      });
    });
    // Effets de bord NON bloquants : une notification/un audit en échec ne doit pas faire croire
    // que la demande n'a pas été créée (elle l'est).
    await notifyRoles(["DIRECTION_ASSISTANT"], { type: "ASSIGNMENT", title: "Nouvelle demande au secrétariat", body: `${created.reference} — ${title}`, link: `/demandes/${created.id}` }).catch(sansBloquer("assistant.performAction.notifyRoles"));
    await recordAudit({
      actorId: user.id, action: "CREATE", module: "Assistant IA", entityType: "ADMIN_REQUEST",
      entityId: created.id, summary: `Demande ${created.reference} — ${title} créée via l'assistant`,
    }).catch(sansBloquer("assistant.performAction.recordAudit"));
    return { ok: true, message: `Demande ${created.reference} — « ${title} » créée.`, link: `/demandes/${created.id}`, revalidate: ["/demandes", "/demandes/assistant"] };
  }

  if (payload?.kind === "send_message") {
    if (!userCan(user, "MESSAGING", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit d'envoyer un message." };
    const body = (payload.body ?? "").trim().slice(0, 8000);
    if (!body) return { ok: false, error: "Message vide." };
    const recipientId = await activeUserId(payload.recipientId);
    /**
     * UN REFUS QUI NE DIT PAS LEQUEL NE SERT À PERSONNE (§118.9).
     *
     * MESURÉ live : une mission a fini PARTIAL sur « Destinataire invalide. » — quatre mots qui
     * ne disent ni QUI, ni POURQUOI, ni QUOI FAIRE. Le planificateur, qui reçoit ce texte pour
     * replanifier, n'en tire rien ; l'échelle de recours n'a aucun barreau à saisir. Les deux
     * causes sont pourtant distinctes et appellent des suites opposées : un destinataire
     * introuvable ou désactivé se cherche autrement (annuaire, responsable du dossier), tandis
     * que s'écrire à soi-même est une faute de plan qu'aucune recherche ne réparera.
     */
    if (!recipientId) {
      return {
        ok: false,
        error: `Destinataire « ${String(payload.recipientId ?? "").slice(0, 60) || "(vide)"} » introuvable ou désactivé : `
          + `aucun compte actif ne correspond. Résous la personne d'abord (resolve_person) et écris à `
          + `l'identifiant qu'il rend — ou, si elle n'existe pas dans l'ERP, dis-le plutôt que de choisir quelqu'un d'autre.`,
      };
    }
    if (recipientId === user.id) {
      return { ok: false, error: "Le destinataire est l'auteur du message : on ne s'écrit pas à soi-même. Vise la personne concernée." };
    }

    // UN SEUL CHEMIN D'ÉCRITURE (`envoyerMessageDirect`) : conversation, message, et LE FAIT
    // `MESSAGE_RECEIVED` — le message d'une mission à un collègue, et sa réponse plus tard, sont
    // des événements que d'autres missions peuvent attendre.
    const { conversationId: convId } = await envoyerMessageDirect({
      senderId: user.id, senderName: user.name, senderEmail: user.email, recipientId, body,
    });
    await notifyUser({ userId: recipientId, type: "GENERIC", title: "Nouveau message", body: body.slice(0, 80), link: lienConversation(convId) });
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", entityId: convId, summary: `Message envoyé via l'assistant à ${payload.recipientName ?? "un collègue"}` });
    return { ok: true, message: `Message envoyé à ${payload.recipientName ?? "votre collègue"}.`, link: "/messages", revalidate: ["/messages"] };
  }

  const rCourrielPrepare = await executerCourrielPrepare(ctx);
  if (rCourrielPrepare !== undefined) return rCourrielPrepare;

  if (payload?.kind === "set_mail_policy") {
    if (!hasGlobalView(user)) return { ok: false, error: "Seul le PDG (ou le Super Admin) règle la politique d'envoi." };
    await setMailSendPolicy(payload.policy as MailSendPolicy, user.id);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Chief of Staff",
      field: "mailSendPolicy", newValue: payload.policy,
      summary: `Politique d'envoi de courriel : ${payload.before} → ${POLICY_LABEL[payload.policy as MailSendPolicy]}`,
    });
    return {
      ok: true,
      message: `Politique d'envoi : ${POLICY_LABEL[payload.policy as MailSendPolicy]}.`,
      link: "/chief-of-staff/reglages",
    };
  }

  const rEnvoiCourriel = await executerEnvoiCourriel(ctx);
  if (rEnvoiCourriel !== undefined) return rEnvoiCourriel;

  if (payload?.kind === "create_calendar_event") {
    if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Vous n'avez pas accès au calendrier." };
    const title = (payload.title ?? "").trim();
    if (!title) return { ok: false, error: "Intitulé du rendez-vous manquant." };
    const allDay = payload.allDay === true;
    const startAt = algiersInputToUtc(`${payload.date}T${allDay ? "00:00" : (payload.time || "09:00")}`);
    if (!startAt) return { ok: false, error: "Date de rendez-vous invalide." };
    const endAt = payload.durationMin && payload.durationMin > 0 ? new Date(startAt.getTime() + payload.durationMin * 60000) : null;
    const kind = ((CALENDAR_KINDS as string[]).includes((payload.eventKind ?? "").toUpperCase()) ? (payload.eventKind as string).toUpperCase() : "APPOINTMENT") as CalendarEventKind;
    const inviteeIds = (payload.inviteeIds ?? []).filter(Boolean);
    await createEventForUser(user.id, {
      title, description: payload.description?.trim() || null, location: payload.location?.trim() || null,
      kind, startAt, endAt, allDay, meetLink: payload.meetLink?.trim() || null, inviteeIds,
    });
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Rendez-vous « ${title} » planifié via l'assistant` });
    return { ok: true, message: `Rendez-vous « ${title} » ajouté au calendrier.`, link: "/calendar", revalidate: ["/calendar"] };
  }

  const rPriseEnCharge = await executerPriseEnCharge(ctx);
  if (rPriseEnCharge !== undefined) return rPriseEnCharge;

  if (payload?.kind === "create_hr_request") {
    const type = (payload.type ?? "").toUpperCase();
    if (!HR_REQUEST_TYPES.includes(type)) return { ok: false, error: "Type de demande RH inconnu." };
    // Libre-service : la demande est créée pour le dossier RH de l'utilisateur (jamais pour un autre).
    const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { id: true, fullName: true } });
    if (!employee) return { ok: false, error: "Aucun dossier RH n'est lié à votre compte. Contactez les RH." };
    const expenseMonth = type === "EXPENSE_REPORT" ? (payload.expenseMonth ?? "").trim() : "";
    if (type === "EXPENSE_REPORT" && !YM_RE.test(expenseMonth)) return { ok: false, error: "Mois de la note de frais manquant ou invalide (AAAA-MM)." };
    const periodStart = dateValue(payload.periodStart);
    const periodEnd = dateValue(payload.periodEnd);
    if (HR_PERIOD_TYPES.has(type) && !periodStart) return { ok: false, error: "Date de début du congé / de l'absence manquante." };
    if (HR_LEAVE_TYPES.has(type) && !periodEnd) return { ok: false, error: "Date de fin du congé manquante." };
    if (periodStart && periodEnd && periodEnd < periodStart) return { ok: false, error: "La date de fin précède la date de début." };
    const periodDays = periodStart && periodEnd ? Math.floor((periodEnd.getTime() - periodStart.getTime()) / 86400000) + 1 : null;
    const demandeRh = await prisma.hrDocumentRequest.create({
      data: {
        employeeId: employee.id, type: type as HrRequestType, details: payload.details?.trim() || null,
        expenseMonth: type === "EXPENSE_REPORT" ? expenseMonth : null,
        periodStart, periodEnd, periodDays,
      },
      select: { id: true },
    });
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", entityType: "EMPLOYEE", entityId: employee.id, summary: `Demande RH « ${HR_REQUEST_FR[type]} » créée via l'assistant` });
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "GENERIC", title: "Nouvelle demande RH", body: `${employee.fullName} — ${HR_REQUEST_FR[type]}`, link: lienDemandeRhATraiter(demandeRh.id) });
    return { ok: true, message: `Demande RH « ${HR_REQUEST_FR[type]} » créée (en attente de traitement RH).`, link: lienMaDemandeRh(demandeRh.id), revalidate: ["/mon-dossier", "/rh"] };
  }

  const rDemandesEtPaiement = await executerDemandesEtPaiement(ctx);
  if (rDemandesEtPaiement !== undefined) return rDemandesEtPaiement;

  if (payload?.kind === "create_notification") {
    // Diffusion réservée au Super Admin (revérifiée ici, jamais sur la confiance du client).
    if (user.role !== "SUPER_ADMIN") return { ok: false, error: "Seul le Super Admin peut diffuser des notifications." };
    const title = (payload.title ?? "").trim();
    if (!title) return { ok: false, error: "Titre de la notification manquant." };
    const count = await broadcastNotification({
      audience: payload.audience,
      role: payload.role ?? undefined,
      userIds: payload.userIds ?? undefined,
      title,
      body: payload.body?.trim() || undefined,
      link: payload.link?.trim() || undefined,
      popup: payload.popup === true,
    });
    if (count === 0) return { ok: false, error: "Aucun destinataire correspondant — rien n'a été envoyé." };
    const who = payload.audience === "ALL" ? "tous les comptes"
      : payload.audience === "ROLE" ? `le rôle ${ROLE_LABELS[(payload.role ?? "") as keyof typeof ROLE_LABELS] ?? payload.role}`
      : (payload.recipientNames ?? "les destinataires choisis");
    const fmt = payload.popup === true ? " en pop-up plein écran" : "";
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Assistant IA", summary: `Notification « ${title} »${fmt} diffusée via l'assistant à ${count} destinataire(s) (${who})` });
    return { ok: true, message: `Notification envoyée${fmt} à ${count} destinataire(s) — ${who}.`, link: "/notifications", revalidate: ["/notifications"] };
  }

  if (payload?.kind === "update_task") {
    // Même frontière qu'à la proposition, REVÉRIFIÉE : la tâche a pu changer de main entre-temps.
    const task = await prisma.task.findFirst({
      where: {
        AND: [
          { id: payload.taskId },
          hasGlobalView(user) ? {} : { OR: [{ assignedToId: user.id }, { createdById: user.id }] },
        ],
      },
      select: { id: true, title: true, assignedToId: true, status: true },
    });
    if (!task) return { ok: false, error: "Cette tâche n'est plus dans votre périmètre." };

    const data: Record<string, unknown> = {};
    const summary: string[] = [];
    if (payload.assigneeId) {
      const a = await activeUserId(payload.assigneeId);
      if (!a) return { ok: false, error: "Le nouveau responsable n'est plus actif." };
      data.assignedToId = a;
      summary.push(`réassignée à ${payload.assigneeName ?? "un collègue"}`);
    }
    if (payload.clearDueDate) { data.dueDate = null; summary.push("échéance retirée"); }
    else if (payload.dueDate) { data.dueDate = dateValue(payload.dueDate); summary.push(`échéance ${payload.dueDate}`); }
    if (payload.priority) { data.priority = priorityOf(payload.priority); summary.push(`priorité ${payload.priority}`); }
    if (payload.status && ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"].includes(payload.status)) {
      data.status = payload.status;
      if (payload.status === "DONE") data.completedAt = new Date();
      summary.push(`statut ${payload.status}`);
    }
    if (Object.keys(data).length > 0) await prisma.task.update({ where: { id: task.id }, data });
    if (payload.comment?.trim()) {
      await prisma.taskComment.create({ data: { taskId: task.id, authorId: user.id, body: payload.comment.trim().slice(0, 4000) } });
      summary.push("commentaire ajouté");
    }
    // Prévenir qui porte la tâche — l'ancien assigné n'apprend pas un retrait par hasard,
    // le nouveau apprend son arrivée tout de suite.
    const notifyTargets = new Set<string>();
    if (data.assignedToId && data.assignedToId !== user.id) notifyTargets.add(data.assignedToId as string);
    if (task.assignedToId && task.assignedToId !== user.id) notifyTargets.add(task.assignedToId);
    await Promise.all([...notifyTargets].map((uid) =>
      notifyUser({ userId: uid, type: "GENERIC", title: "Tâche mise à jour", body: `${task.title} — ${summary.join(", ")}`, link: lienTache(task.id) }).catch(sansBloquer("assistant.performAction.notifyUser")),
    ));
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA", entityType: "TASK", entityId: task.id,
      summary: `Tâche « ${task.title} » — ${summary.join(", ")} (via l'assistant)`,
    }).catch(sansBloquer("assistant.performAction.recordAudit"));
    return { ok: true, message: `Tâche « ${task.title} » : ${summary.join(", ")}.`, link: "/mon-espace", revalidate: ["/mon-espace", "/mon-travail"] };
  }

  const rDemandeEtJuridique = await executerDemandeEtJuridique(ctx);
  if (rDemandeEtJuridique !== undefined) return rDemandeEtJuridique;

  if (payload?.kind === "update_calendar_event") {
    const event = await prisma.calendarEvent.findUnique({
      where: { id: payload.eventId },
      select: {
        id: true, title: true, description: true, location: true, kind: true, startAt: true, endAt: true,
        allDay: true, color: true, meetLink: true, organizerId: true,
        invitees: { select: { userId: true } },
      },
    });
    if (!event) return { ok: false, error: "Ce rendez-vous n'existe plus." };
    if (event.organizerId !== user.id && !hasGlobalView(user)) {
      return { ok: false, error: "Seul l'organisateur (ou une vue globale) peut modifier ce rendez-vous." };
    }
    if (payload.cancel) {
      const fd = new FormData();
      fd.set("id", event.id);
      const r = await deleteCalendarEvent(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'annulation a été refusée." };
      await recordAudit({ actorId: user.id, action: "DELETE", module: "Assistant IA", summary: `Rendez-vous « ${event.title} » annulé via l'assistant` }).catch(sansBloquer("assistant.performAction.recordAudit"));
      return { ok: true, message: `Rendez-vous « ${event.title} » annulé.`, link: "/calendar", revalidate: ["/calendar"] };
    }
    // `updateCalendarEvent` remplace tout : on reconstruit l'état complet, overrides compris.
    const currentStartAlgiers = new Date(event.startAt.getTime() + 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    const curDate = `${currentStartAlgiers.getUTCFullYear()}-${p(currentStartAlgiers.getUTCMonth() + 1)}-${p(currentStartAlgiers.getUTCDate())}`;
    const curTime = `${p(currentStartAlgiers.getUTCHours())}:${p(currentStartAlgiers.getUTCMinutes())}`;
    const newDate = payload.date ?? curDate;
    const newTime = event.allDay ? "00:00" : (payload.time ?? curTime);
    const durMs = payload.durationMin != null
      ? payload.durationMin * 60_000
      : event.endAt ? event.endAt.getTime() - event.startAt.getTime() : null;
    const startAt = algiersInputToUtc(`${newDate}T${newTime}`);
    if (!startAt) return { ok: false, error: "Nouvelle date invalide." };
    const fd = new FormData();
    fd.set("id", event.id);
    fd.set("title", event.title);
    fd.set("description", event.description ?? "");
    fd.set("location", payload.location ?? event.location ?? "");
    fd.set("kind", event.kind);
    fd.set("allDay", event.allDay ? "true" : "");
    fd.set("start", event.allDay ? newDate : `${newDate}T${newTime}`);
    if (durMs != null && !event.allDay) {
      const end = new Date(startAt.getTime() + durMs);
      const endAlg = new Date(end.getTime() + 3_600_000);
      fd.set("end", `${endAlg.getUTCFullYear()}-${p(endAlg.getUTCMonth() + 1)}-${p(endAlg.getUTCDate())}T${p(endAlg.getUTCHours())}:${p(endAlg.getUTCMinutes())}`);
    }
    fd.set("color", event.color ?? "");
    fd.set("meetLink", event.meetLink ?? "");
    for (const inv of event.invitees) fd.append("inviteeIds", inv.userId);
    const r = await updateCalendarEvent(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La modification a été refusée." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Rendez-vous « ${event.title} » déplacé via l'assistant (${payload.changes.join(", ")})` }).catch(sansBloquer("assistant.performAction.recordAudit"));
    return { ok: true, message: `Rendez-vous « ${event.title} » mis à jour (${payload.changes.join(", ")}).`, link: "/calendar", revalidate: ["/calendar"] };
  }

  const rAjoutEtablissement = await executerAjoutEtablissement(ctx);
  if (rAjoutEtablissement !== undefined) return rAjoutEtablissement;

  if (payload?.kind === "update_hospital") {
    const current = await prisma.medicalInstitution.findUnique({
      where: { id: payload.institutionId },
      select: { id: true, name: true, type: true, sector: true, wilaya: true, region: true, address: true, phone: true, email: true, notes: true, isActive: true },
    });
    if (!current) return { ok: false, error: "Cet établissement n'existe plus." };
    const u = payload.updates;
    // `updateInstitution` remplace tout : l'état complet, overrides compris.
    const fd = new FormData();
    fd.set("id", current.id);
    fd.set("name", u.newName ?? current.name);
    fd.set("type", u.type ?? current.type);
    fd.set("sector", u.sector ?? current.sector);
    fd.set("wilaya", u.wilaya ?? u.city ?? current.wilaya ?? "");
    fd.set("region", current.region ?? "");
    fd.set("address", current.address ?? "");
    fd.set("phone", u.phone ?? current.phone ?? "");
    fd.set("email", u.email ?? current.email ?? "");
    fd.set("notes", u.notes ?? current.notes ?? "");
    if (u.isActive != null) fd.set("isActive", u.isActive ? "on" : "off");
    const r = await updateInstitution(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La modification a été refusée." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Assistant IA", summary: `Établissement « ${current.name} » modifié via l'assistant (${payload.changes.join(", ")})` }).catch(sansBloquer("assistant.performAction.recordAudit"));
    return { ok: true, message: `Établissement « ${u.newName ?? current.name} » modifié (${payload.changes.join(", ")}).`, link: "/medical", revalidate: ["/medical"] };
  }

  if (payload?.kind === "update_salary") {
    // NIVEAU CRITIQUE. Trois verrous, dans l'ordre : le DROIT (paie RH), la FRAÎCHEUR (les
    // montants « avant » montrés sur la carte doivent être ENCORE vrais — sinon on signerait
    // sur une photo périmée), puis l'écriture, champ par champ confirmé, avec audit détaillé.
    if (!userCan(user, "RH", "UPDATE")) return { ok: false, error: "La modification des salaires est réservée aux détenteurs du droit RH (modification)." };
    if (!Array.isArray(payload.fields) || payload.fields.length === 0) return { ok: false, error: "Aucun montant à modifier." };
    const emp = await prisma.employee.findFirst({
      where: { id: payload.employeeId, isActive: true },
      select: { id: true, fullName: true, baseSalary: true, netToPay: true, grossSalary: true, employerCost: true },
    });
    if (!emp) return { ok: false, error: "Cet employé n'est plus actif au registre RH." };

    const currentOf: Record<string, number | null> = {
      baseSalary: toNumber(emp.baseSalary),
      netToPay: emp.netToPay != null ? toNumber(emp.netToPay) : null,
      grossSalary: emp.grossSalary != null ? toNumber(emp.grossSalary) : null,
      employerCost: emp.employerCost != null ? toNumber(emp.employerCost) : null,
    };
    const data: Record<string, number> = {};
    const summary: string[] = [];
    for (const f of payload.fields) {
      if (!(f.field in currentOf)) return { ok: false, error: "Champ de salaire inconnu." };
      const now = currentOf[f.field] != null ? Math.round((currentOf[f.field] as number) * 100) / 100 : null;
      if (now !== f.before) {
        return { ok: false, error: `${f.label} a changé depuis la proposition (${now != null ? formatMontant(now) : "vide"} DZD désormais). Relire read_payroll et reproposer.` };
      }
      if (typeof f.after !== "number" || !Number.isFinite(f.after) || f.after <= 0) return { ok: false, error: `${f.label} : montant invalide.` };
      data[f.field] = Math.round(f.after * 100) / 100;
      summary.push(`${f.label} : ${f.before != null ? formatMontant(f.before) : "(vide)"} → ${formatMontant(f.after)} DZD`);
    }
    await prisma.employee.update({ where: { id: emp.id }, data });
    // LE COFFRE (refonte V2-E) : la copie chiffrée suit — chemin d'ÉCRITURE seulement, l'assistant ne lit pas le coffre.
    await doubleEcrireCoffre("Employee", emp.id, data, user.id);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Assistant IA", entityType: "EMPLOYEE", entityId: emp.id,
      oldValue: payload.fields.map((f) => `${f.label}=${f.before ?? "∅"}`).join(" · "),
      newValue: payload.fields.map((f) => `${f.label}=${f.after}`).join(" · "),
      summary: `SALAIRE de ${emp.fullName} modifié via l'assistant — ${summary.join(" ; ")}${payload.note ? ` (${payload.note})` : ""}`,
    });
    return {
      ok: true,
      message: `Salaire de ${emp.fullName} mis à jour — ${summary.join(" ; ")}. La paie mensuelle se saisit toujours dans RH → Paie.`,
      link: "/rh",
      revalidate: ["/rh"],
    };
  }

  return { ok: false, error: "Action non reconnue." };
}
