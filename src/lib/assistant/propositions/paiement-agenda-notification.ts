/**
 * PROPOSITIONS — Décision du centre de paiement, événement d'agenda, notification.
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import {
  prisma, type BroadcastAudience, userCan, sitsOnPaymentCentre, applyDecision, CENTRAL_STATUS_LABEL,
  CENTRAL_DECISION_LABEL, PAYMENT_CENTRE_REFUSAL, type CentralStatus,
} from "@/lib/assistant/coeur/erp";
import { toNumber, formatMontant } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/labels";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { asStr } from "@/platform/ia/outils/arguments";
import { isoDate, pastWarning, normalizeRole, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « paiement-agenda-notification » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerPaiementAgendaNotification(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings, resolve } = c;

  if (toolName === "decide_payment") {
    // Qui SIÈGE au centre — la même règle que l'écran. Le modèle ne décide jamais d'un droit.
    if (!sitsOnPaymentCentre(user)) return { error: PAYMENT_CENTRE_REFUSAL };
    const ref = asStr(input, "reference").trim();
    if (!ref) return { error: "Donnez la référence du paiement à trancher." };
    // DEUX DÉCISIONS AU CENTRE, comme à l'écran : autoriser ou refuser. « Réviser le montant » et
    // « demander une argumentation » ont été retirés — les laisser ici ouvrirait à l'assistant un
    // geste que l'écran ne propose plus, et §118-7 l'interdit.
    const decision = asStr(input, "decision") as "APPROVE" | "REFUSE";
    if (!["APPROVE", "REFUSE"].includes(decision)) return { error: "Décision inconnue : le centre autorise ou refuse." };
    const note = asStr(input, "note").trim();
    if (decision !== "APPROVE" && !note) return { error: "Dites pourquoi : sans motif, le demandeur ne peut que deviner." };

    const order = await prisma.expenseOrder.findFirst({
      where: { reference: { equals: ref, mode: "insensitive" } },
      select: { id: true, reference: true, label: true, amount: true, centralStatus: true, beneficiary: true },
    });
    if (!order) return { error: `Aucun ordre de dépense ne porte la référence « ${ref} ».` };
    if (!applyDecision(order.centralStatus as CentralStatus, decision)) {
      return { error: `Ce paiement est « ${CENTRAL_STATUS_LABEL[order.centralStatus as CentralStatus]} » — cette décision n'a plus de sens à ce stade.` };
    }
    const amountDzd = Math.round(toNumber(order.amount) * 100) / 100;
    // PLUS DE MONTANT PROPOSÉ : il n'accompagnait que « réviser le montant », qui n'existe plus.
    // Le centre autorise ce qui lui est présenté, ou le refuse ; corriger un montant appartient à
    // la demande, en amont.

    const fields = [
      { label: "Paiement", value: `${order.reference} — ${order.label}` },
      { label: "Montant", value: `${formatMontant(amountDzd)} DZD` },
      { label: "Décision", value: CENTRAL_DECISION_LABEL[decision] },
    ];
    if (order.beneficiary) fields.push({ label: "Bénéficiaire", value: order.beneficiary });
    if (note) fields.push({ label: "Motif", value: note });
    return {
      kind: "decide_payment", module: "PAYMENT_CENTRE", title: `Centre de paiement — ${CENTRAL_DECISION_LABEL[decision].toLowerCase()}`, fields, warnings,
      level: "SENSITIVE",
      payload: {
        kind: "decide_payment", orderId: order.id, reference: order.reference, label: order.label,
        amountDzd, decision, note: note || null, proposedAmount: null,
      },
    };
  }

  if (toolName === "create_calendar_event") {
    if (!userCan(user, "WORKSPACE", "CREATE")) return { error: "Vous n'avez pas accès au calendrier." };
    const title = asStr(input, "title");
    if (!title) return { error: "Intitulé du rendez-vous manquant." };
    // « QUAND » EN FRANÇAIS — le même décodeur temporel que les rappels : « jeudi prochain à
    // 10h » devient une date et une heure d'Alger, ou l'outil dit qu'il n'a pas compris. Une
    // date explicite l'emporte ; le décodeur ne devine jamais (doctrine Live Office §5).
    let date = isoDate(asStr(input, "date"));
    let heureDeduite: string | null = null;
    const quand = asStr(input, "quand");
    if (!date && quand) {
      const { interpreterExpressionTemporelle } = await import("@/lib/temporal");
      const lu = interpreterExpressionTemporelle(quand, new Date());
      if (!lu) return { error: `Expression temporelle « ${quand} » non comprise à coup sûr — donnez date (AAAA-MM-JJ) et time (HH:mm, heure d'Alger).` };
      // L'instant UTC rendu par le décodeur, relu à l'heure d'Alger par Intl — sans importer le
      // module calendrier de l'ERP (la frontière Adam ↔ ERP est tenue par un plafond, §boundary).
      const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Africa/Algiers", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(lu.echeance);
      const [d, h] = parts.split(" ");
      date = d;
      heureDeduite = h && h !== "00:00" ? h.slice(0, 5) : null;
    }
    if (!date) return { error: "Date du rendez-vous manquante ou invalide (AAAA-MM-JJ, ou « quand » en français)." };
    pastWarning("La date du rendez-vous", date, warnings);
    const allDay = input.allDay === true;
    const time = allDay ? null : (asStr(input, "time").match(/^\d{1,2}:\d{2}$/) ? asStr(input, "time") : (heureDeduite ?? "09:00"));
    const durRaw = input.durationMin;
    const durationMin = typeof durRaw === "number" && Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : null;
    const eventKind = (asStr(input, "kind") || "APPOINTMENT").toUpperCase();

    const inviteeIds: string[] = [];
    const inviteeResolved: string[] = [];
    const names = asStr(input, "inviteeNames").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const r = await resolve("Invité", n);
      if (r.id) { inviteeIds.push(r.id); inviteeResolved.push(r.name ?? n); }
    }

    const fields = [
      { label: "Rendez-vous", value: title },
      { label: "Quand", value: allDay ? `${date} (journée entière)` : `${date} à ${time} (heure d'Alger)` },
    ];
    if (durationMin) fields.push({ label: "Durée", value: `${durationMin} min` });
    if (asStr(input, "location")) fields.push({ label: "Lieu", value: asStr(input, "location") });
    if (inviteeResolved.length) fields.push({ label: "Invités", value: inviteeResolved.join(", ") });
    if (asStr(input, "description")) fields.push({ label: "Détails", value: asStr(input, "description") });
    return {
      kind: "create_calendar_event", module: "WORKSPACE", title: "Planifier un rendez-vous", fields, warnings,
      payload: {
        kind: "create_calendar_event", title, date, time, durationMin, allDay,
        eventKind, location: asStr(input, "location") || null, meetLink: asStr(input, "meetLink") || null,
        description: asStr(input, "description") || null, inviteeIds, inviteeNames: inviteeResolved.join(", ") || null,
      },
    };
  }

  if (toolName === "create_notification") {
    if (user.role !== "SUPER_ADMIN") return { error: "Seul le Super Admin peut diffuser des notifications." };
    const title = asStr(input, "title");
    if (!title) return { error: "Titre de la notification manquant." };
    const audience = asStr(input, "audience").toUpperCase();
    if (!["ALL", "ROLE", "USERS"].includes(audience)) return { error: "Audience invalide (ALL, ROLE ou USERS)." };
    const body = asStr(input, "body") || null;
    const link = asStr(input, "link") || null;
    const popup = input.popup === true || asStr(input, "popup").toLowerCase() === "true";

    const fields = [{ label: "Titre", value: title }];
    let role: string | null = null;
    const userIds: string[] = [];
    let recipientNames: string | null = null;

    if (audience === "ROLE") {
      role = normalizeRole(asStr(input, "role"));
      if (!role) return { error: "Rôle ciblé manquant ou inconnu — précisez le rôle (ex. « Délégué médical »)." };
      fields.push({ label: "Audience", value: `Rôle : ${ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role}` });
    } else if (audience === "USERS") {
      const names = asStr(input, "recipientNames").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) return { error: "Aucun destinataire précisé (audience=USERS)." };
      const resolvedNames: string[] = [];
      for (const n of names) {
        const r = await resolve("Destinataire", n);
        if (r.id) { userIds.push(r.id); resolvedNames.push(r.name ?? n); }
      }
      if (userIds.length === 0) return { error: "Aucun destinataire valide trouvé — précisez les noms (search_people)." };
      recipientNames = resolvedNames.join(", ");
      fields.push({ label: "Audience", value: `${userIds.length} personne(s) : ${recipientNames}` });
    } else {
      fields.push({ label: "Audience", value: "Tous les comptes actifs" });
    }
    if (body) fields.push({ label: "Message", value: body });
    if (link) fields.push({ label: "Lien", value: link });
    if (popup) fields.push({ label: "Format", value: "Pop-up plein écran (accusé de réception requis)" });

    return {
      kind: "create_notification", module: "ADMIN", title: popup ? "Diffuser une annonce (pop-up)" : "Diffuser une notification", fields, warnings,
      payload: { kind: "create_notification", audience: audience as BroadcastAudience, role, userIds, recipientNames, title, body, link, popup },
    };
  }

  return undefined;
}
