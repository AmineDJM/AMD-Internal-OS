/**
 * PROPOSITIONS — Suivi : mise à jour d'une tâche ou d'une demande ; documents juridiques ;
 * modification d'un événement d'agenda.
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import { prisma, userCan, hasGlobalView, scopeAdminRequests } from "@/lib/assistant/coeur/erp";
import { toNumber, formatMontant } from "@/lib/utils";
import { TASK_STATUS, PRIORITY, ADMIN_REQUEST_STATUS } from "@/lib/labels";
import { direCeQuiEstArrive } from "@/lib/personnes/designation";
import type { AssistantActionPayload, ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/lib/assistant/outils/arguments";
import { normPriority, isoDate, pastWarning, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « suivi-et-juridique » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerSuiviEtJuridique(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings, resolve } = c;

  if (toolName === "update_task") {
    const needle = asStr(input, "task");
    if (needle.length < 2) return { error: "Donnez un fragment du titre de la tâche." };
    // Sa propre tâche, ou n'importe laquelle pour une vue globale — la même frontière que
    // l'écran « Mon espace » : personne ne modifie la tâche d'un autre sans vue globale.
    const scope = hasGlobalView(user) ? {} : { OR: [{ assignedToId: user.id }, { createdById: user.id }] };
    const task = await prisma.task.findFirst({
      where: { AND: [scope, { title: { contains: needle, mode: "insensitive" as const } }] },
      select: { id: true, title: true, status: true, priority: true, dueDate: true, assignedTo: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (!task) return { error: `Aucune tâche « ${needle} » dans votre périmètre.` };

    const fields: { label: string; value: string }[] = [{ label: "Tâche", value: task.title }];
    const payload: Extract<AssistantActionPayload, { kind: "update_task" }> = { kind: "update_task", taskId: task.id, taskTitle: task.title };

    const assigneeFourni = input.assigneeName !== undefined && input.assigneeName !== null
      && !(typeof input.assigneeName === "string" && !input.assigneeName.trim());
    if (assigneeFourni) {
      const a = await resolve("Nouveau responsable", input.assigneeName);
      if (!a.id) return { error: `Responsable « ${direCeQuiEstArrive(input.assigneeName)} » introuvable ou ambigu (search_people).` };
      payload.assigneeId = a.id; payload.assigneeName = a.name;
      fields.push({ label: "Assignée à", value: `${task.assignedTo?.name ?? "personne"} → ${a.name}` });
    }
    if (input.clearDueDate === true) {
      payload.clearDueDate = true;
      fields.push({ label: "Échéance", value: `${task.dueDate?.toISOString().slice(0, 10) ?? "(aucune)"} → (retirée)` });
    } else if (asStr(input, "dueDate")) {
      const due = isoDate(asStr(input, "dueDate"));
      if (!due) return { error: "Échéance illisible (AAAA-MM-JJ)." };
      pastWarning("La nouvelle échéance", due, warnings);
      payload.dueDate = due;
      fields.push({ label: "Échéance", value: `${task.dueDate?.toISOString().slice(0, 10) ?? "(aucune)"} → ${due}` });
    }
    const prio = asStr(input, "priority") ? normPriority(asStr(input, "priority")) : null;
    if (prio) {
      payload.priority = prio;
      fields.push({ label: "Priorité", value: `${PRIORITY[task.priority]?.label ?? task.priority} → ${PRIORITY[prio]?.label ?? prio}` });
    }
    const status = asStr(input, "status").toUpperCase();
    if (status) {
      if (!["TODO", "IN_PROGRESS", "DONE", "CANCELLED"].includes(status)) return { error: "Statut de tâche inconnu." };
      payload.status = status;
      fields.push({ label: "Statut", value: `${TASK_STATUS[task.status]?.label ?? task.status} → ${TASK_STATUS[status as keyof typeof TASK_STATUS]?.label ?? status}` });
    }
    const comment = asStr(input, "comment");
    if (comment) { payload.comment = comment; fields.push({ label: "Commentaire", value: comment }); }

    if (fields.length === 1) return { error: "Aucun changement demandé — précisez quoi modifier (responsable, échéance, priorité, statut, commentaire)." };
    return { kind: "update_task", module: "WORKSPACE", title: `Modifier la tâche « ${task.title.slice(0, 60)} »`, fields, warnings, payload };
  }

  if (toolName === "update_request") {
    if (!userCan(user, "ADMIN_REQUESTS", "VIEW")) return { error: "Vous n'avez pas accès aux demandes du secrétariat." };
    const ref = asStr(input, "reference");
    if (ref.length < 2) return { error: "Donnez la référence (REQ-…) ou un fragment du titre." };
    const req = await prisma.administrativeRequest.findFirst({
      where: { AND: [scopeAdminRequests(user), { deletedAt: null }, { OR: [{ reference: { equals: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] }] },
      select: { id: true, reference: true, title: true, status: true, assignedTo: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (!req) return { error: `Aucune demande « ${ref} » dans votre périmètre.` };

    const fields: { label: string; value: string }[] = [{ label: "Demande", value: `${req.reference} — ${req.title}` }];
    const payload: Extract<AssistantActionPayload, { kind: "update_request" }> = { kind: "update_request", requestId: req.id, reference: req.reference };

    const status = asStr(input, "status").toUpperCase();
    if (status) {
      // AUCUN statut ne se pose plus à la main (Direction, 10/2026) : l'assistante n'a que deux gestes,
      // « Commencer le traitement » et « Fin du traitement », sur la fiche de la demande.
      const valid: string[] = [];
      if (!valid.includes(status)) return { error: "Le statut ne se change pas d'ici : le traitement n'a que deux gestes, « Commencer le traitement » et « Fin du traitement », sur la fiche de la demande." };
      payload.status = status;
      fields.push({ label: "Statut", value: `${ADMIN_REQUEST_STATUS[req.status]?.label ?? req.status} → ${ADMIN_REQUEST_STATUS[status as keyof typeof ADMIN_REQUEST_STATUS]?.label ?? status}` });
    }
    const assigneeFourni = input.assigneeName !== undefined && input.assigneeName !== null
      && !(typeof input.assigneeName === "string" && !input.assigneeName.trim());
    if (assigneeFourni) {
      const a = await resolve("Nouveau responsable", input.assigneeName);
      if (!a.id) return { error: `Responsable « ${direCeQuiEstArrive(input.assigneeName)} » introuvable ou ambigu (search_people).` };
      payload.assigneeId = a.id; payload.assigneeName = a.name;
      fields.push({ label: "Responsable", value: `${req.assignedTo?.name ?? "personne"} → ${a.name}` });
    }
    const comment = asStr(input, "comment");
    if (comment) { payload.comment = comment; fields.push({ label: "Commentaire", value: comment }); }

    if (fields.length === 1) return { error: "Aucun changement demandé — précisez quoi modifier (statut, responsable, commentaire)." };
    warnings.push("L'exécution repasse par les règles du secrétariat : si vous n'êtes pas gestionnaire de cette demande, elle sera refusée.");
    return { kind: "update_request", module: "ADMIN_REQUESTS", title: `Modifier la demande ${req.reference}`, fields, warnings, payload };
  }

  if (toolName === "create_legal_document") {
    if (!userCan(user, "LEGAL", "CREATE")) return { error: "Vous n'avez pas le droit de déclarer une pièce Legal." };
    const KINDS_FR: Record<string, string> = {
      QUOTE: "Devis", PURCHASE_ORDER: "Bon de commande", INVOICE: "Facture", CONTRACT: "Contrat",
      AGREEMENT: "Accord", NDA: "NDA", INSURANCE: "Assurance", LICENSE: "Licence", LEASE: "Bail", OTHER: "Autre",
    };
    const docKind = asStr(input, "kind").toUpperCase();
    if (!(docKind in KINDS_FR)) return { error: "Nature de pièce inconnue." };
    const title = asStr(input, "title");
    if (!title) return { error: "Le titre de la pièce est obligatoire." };
    const startDate = asStr(input, "startDate") ? isoDate(asStr(input, "startDate")) : null;
    const endDate = asStr(input, "endDate") ? isoDate(asStr(input, "endDate")) : null;
    if (startDate && endDate && endDate < startDate) return { error: "La date de fin précède la date de début." };
    const amountRaw = input.amount;
    const amount = typeof amountRaw === "number" && Number.isFinite(amountRaw) && amountRaw >= 0 ? amountRaw : null;

    // La pièce AMONT se résout MAINTENANT — jamais un identifiant deviné au moment d'exécuter.
    let chainFromId: string | null = null;
    let chainFromLabel: string | null = null;
    const chainRaw = asStr(input, "chain_from");
    if (chainRaw) {
      const prev = await prisma.legalDocument.findFirst({
        where: { OR: [{ reference: { equals: chainRaw, mode: "insensitive" } }, { title: { contains: chainRaw, mode: "insensitive" } }] },
        select: { id: true, title: true, reference: true, kind: true },
        orderBy: { createdAt: "desc" },
      });
      if (!prev) return { error: `Pièce amont « ${chainRaw} » introuvable au Legal — vérifier avec search_everything ou inspect_record.` };
      chainFromId = prev.id;
      chainFromLabel = `${KINDS_FR[prev.kind] ?? prev.kind} ${prev.reference ?? ""} — ${prev.title}`.trim();
    }

    const fields = [
      { label: "Nature", value: KINDS_FR[docKind] },
      { label: "Titre", value: title },
    ];
    if (asStr(input, "reference")) fields.push({ label: "Référence", value: asStr(input, "reference") });
    if (asStr(input, "counterparty")) fields.push({ label: "Partie", value: asStr(input, "counterparty") });
    if (amount != null) fields.push({ label: "Montant", value: `${amount.toLocaleString("fr-FR")} DZD` });
    if (startDate || endDate) fields.push({ label: "Dates", value: [startDate, endDate].filter(Boolean).join(" → ") });
    if (chainFromLabel) fields.push({ label: "Chaînée à", value: chainFromLabel });
    // LA PARTIE VIENT DE L'ANNUAIRE (§118.148) : la carte le DIT avant le clic — introuvable ou
    // ambiguë, la déclaration est refusée en le disant, jamais écrite en texte libre.
    if (!asStr(input, "counterparty")) {
      return { error: "Précisez la partie (fournisseur, client, prestataire) : un document Legal exige une partie de l'annuaire de l'entreprise." };
    }
    warnings.push(`La partie « ${asStr(input, "counterparty")} » sera cherchée dans l'annuaire de l'entreprise : absente ou ambiguë, la déclaration sera refusée en le disant.`);
    if (docKind === "PURCHASE_ORDER") {
      warnings.push("Tout bon de commande passe par un centre de validation — celui d'Ad & Pro s'il vient d'une demande Ad & Pro, le centre de validations sinon — avant d'engager la société.");
    }

    return {
      kind: "create_legal_document", module: "LEGAL", title: `Déclarer ${KINDS_FR[docKind].toLowerCase()} au Legal`, fields, warnings,
      payload: {
        kind: "create_legal_document", docKind, title,
        reference: asStr(input, "reference") || null, counterparty: asStr(input, "counterparty") || null,
        amount, startDate, endDate, notes: asStr(input, "notes") || null,
        chainFromId, chainFromLabel,
      },
    };
  }

  if (toolName === "update_legal_document") {
    if (!userCan(user, "LEGAL", "UPDATE")) return { error: "Vous n'avez pas le droit de modifier une pièce Legal." };
    const needle = asStr(input, "document");
    if (needle.length < 2) return { error: "Donnez la référence ou un fragment du titre de la pièce." };
    // La restriction par LECTEURS s'applique aussi ici : on ne modifie pas un document qu'on
    // n'a pas le droit d'ouvrir.
    const doc = await prisma.legalDocument.findFirst({
      where: {
        AND: [
          { OR: [{ reference: { equals: needle, mode: "insensitive" } }, { title: { contains: needle, mode: "insensitive" } }] },
          ...(user.role === "SUPER_ADMIN" ? [] : [{
            OR: [{ readers: { none: {} } }, { readers: { some: { userId: user.id } } }, { createdById: user.id }],
          }]),
        ],
      },
      select: { id: true, title: true, reference: true, kind: true, counterparty: true, amount: true, startDate: true, endDate: true },
      orderBy: { createdAt: "desc" },
    });
    if (!doc) return { error: `Aucune pièce Legal « ${needle} » qui vous soit ouverte.` };

    const updates: Extract<AssistantActionPayload, { kind: "update_legal_document" }>["updates"] = {};
    const changes: string[] = [];
    const fields: { label: string; value: string }[] = [{ label: "Pièce", value: `${doc.reference ?? doc.kind} — ${doc.title}` }];
    const push = (label: string, before: string, after: string) => {
      fields.push({ label, value: `${before || "(vide)"} → ${after || "(vide)"}` });
      changes.push(label);
    };

    if (asStr(input, "title")) { updates.title = asStr(input, "title"); push("Titre", doc.title, updates.title); }
    if (asStr(input, "reference")) { updates.reference = asStr(input, "reference"); push("Référence", doc.reference ?? "", updates.reference); }
    if (asStr(input, "counterparty")) { updates.counterparty = asStr(input, "counterparty"); push("Partie", doc.counterparty ?? "", updates.counterparty); }
    if (typeof input.amount === "number" && Number.isFinite(input.amount)) {
      updates.amount = input.amount;
      push("Montant", doc.amount != null ? `${formatMontant(toNumber(doc.amount))} DZD` : "", `${formatMontant(input.amount)} DZD`);
    }
    if (asStr(input, "startDate")) {
      const d = isoDate(asStr(input, "startDate"));
      if (!d) return { error: "Date de début illisible (AAAA-MM-JJ)." };
      updates.startDate = d; push("Début", doc.startDate?.toISOString().slice(0, 10) ?? "", d);
    }
    if (asStr(input, "endDate")) {
      const d = isoDate(asStr(input, "endDate"));
      if (!d) return { error: "Date de fin illisible (AAAA-MM-JJ)." };
      updates.endDate = d; push("Fin", doc.endDate?.toISOString().slice(0, 10) ?? "", d);
    }
    if (asStr(input, "notes")) { updates.notes = asStr(input, "notes"); changes.push("Notes"); fields.push({ label: "Notes", value: updates.notes }); }
    const chainRaw = asStr(input, "chain_from");
    if (chainRaw) {
      const prev = await prisma.legalDocument.findFirst({
        where: { id: { not: doc.id }, OR: [{ reference: { equals: chainRaw, mode: "insensitive" } }, { title: { contains: chainRaw, mode: "insensitive" } }] },
        select: { id: true, title: true, reference: true },
        orderBy: { createdAt: "desc" },
      });
      if (!prev) return { error: `Pièce amont « ${chainRaw} » introuvable au Legal.` };
      updates.chainFromId = prev.id;
      push("Chaînée à", "", `${prev.reference ?? ""} ${prev.title}`.trim());
    }
    if (changes.length === 0) return { error: "Aucun changement demandé — précisez quoi modifier." };

    return {
      kind: "update_legal_document", module: "LEGAL", title: `Modifier « ${doc.title.slice(0, 60)} »`, fields, warnings,
      payload: { kind: "update_legal_document", documentId: doc.id, currentTitle: doc.title, updates, changes },
    };
  }

  if (toolName === "update_calendar_event") {
    if (!userCan(user, "WORKSPACE", "VIEW")) return { error: "Vous n'avez pas accès au calendrier." };
    const needle = asStr(input, "event");
    if (needle.length < 2) return { error: "Donnez un fragment du titre du rendez-vous." };
    // Même frontière que l'écran : l'organisateur, ou une vue globale.
    const scope = hasGlobalView(user) ? {} : { organizerId: user.id };
    const event = await prisma.calendarEvent.findFirst({
      where: { AND: [scope, { title: { contains: needle, mode: "insensitive" as const } }, { startAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }] },
      select: { id: true, title: true, startAt: true, allDay: true, location: true, organizer: { select: { name: true } } },
      orderBy: { startAt: "asc" },
    });
    if (!event) return { error: `Aucun rendez-vous à venir « ${needle} » que vous puissiez modifier.` };

    const cancel = input.cancel === true;
    const changes: string[] = [];
    const fields: { label: string; value: string }[] = [
      { label: "Rendez-vous", value: event.title },
      { label: "Actuellement", value: `${event.startAt.toISOString().slice(0, 10)}${event.allDay ? " (journée entière)" : ""} — organisé par ${event.organizer.name}` },
    ];
    const payload: Extract<AssistantActionPayload, { kind: "update_calendar_event" }> = {
      kind: "update_calendar_event", eventId: event.id, eventTitle: event.title, changes,
    };
    if (cancel) {
      payload.cancel = true;
      changes.push("Annulation");
      fields.push({ label: "Action", value: "ANNULER le rendez-vous (les invités seront prévenus par la disparition de l'événement)" });
    } else {
      const date = asStr(input, "date") ? isoDate(asStr(input, "date")) : null;
      const time = asStr(input, "time").match(/^\d{1,2}:\d{2}$/) ? asStr(input, "time") : null;
      if (date) { payload.date = date; changes.push("Date"); }
      if (time) { payload.time = time; changes.push("Heure"); }
      if (date || time) fields.push({ label: "Déplacé à", value: `${date ?? "même jour"} ${time ?? "même heure"} (heure d'Alger)` });
      if (typeof input.durationMin === "number" && input.durationMin > 0) {
        payload.durationMin = Math.round(input.durationMin); changes.push("Durée");
        fields.push({ label: "Durée", value: `${payload.durationMin} min` });
      }
      if (asStr(input, "location")) { payload.location = asStr(input, "location"); changes.push("Lieu"); fields.push({ label: "Lieu", value: payload.location }); }
      if (changes.length === 0) return { error: "Aucun changement demandé — donnez une nouvelle date/heure, une durée, un lieu, ou cancel=true." };
      pastWarning("La nouvelle date", date, warnings);
    }
    return {
      kind: "update_calendar_event", module: "WORKSPACE",
      title: cancel ? `Annuler « ${event.title.slice(0, 50)} »` : `Déplacer « ${event.title.slice(0, 50)} »`,
      fields, warnings, payload,
    };
  }

  return undefined;
}
