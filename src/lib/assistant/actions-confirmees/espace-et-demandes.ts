/**
 * EXÉCUTION APRÈS CONFIRMATION — Espace de travail, courrier et demandes métier : tâche, dossier,
 * courriels, prise en charge, sponsoring, événement, paiement.
 * Des séries de branches de l'ancienne chaîne de `performAction` qui n'écrivent pas elles-mêmes en
 * base, recopiées telles quelles ; `actions-confirmees/executer.ts` appelle chacune à son rang, et
 * elle rend `undefined` quand l'action n'est pas la sienne.
 */

import {
  prisma, createDossierRecord, userCan, type Module, scopeMedicalDoctors, createTaskRecord,
  approveAndExecuteIntent, gmailTransport, sitsOnPaymentCentre, CENTRAL_DECISION_LABEL, PAYMENT_CENTRE_REFUSAL,
  decidePayment,
} from "@/lib/assistant/coeur/erp";
// Les demandes Ad & Pro, le secrétariat et les circuits : par le pont (frontière Adam ↔ ERP).
import { createSponsoring, createEvent, createCongressRequest } from "@/platform/in-process/demandes";
import { formatMontant } from "@/lib/utils";
import { REFUS_MATERIEL_PAR_ADAM } from "@/lib/assistant/coeur/contrat-actions";
import {
  type ExecuteResult, activeUserId, priorityOf, dateValue, type ContexteExecution,
} from "@/lib/assistant/actions-confirmees/aides";

/** Branches de `performAction` : demande de tâche et dossier. */
export async function executerTacheEtDossier(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload } = c;

  if (payload?.kind === "create_task") {
    if (!userCan(user, "WORKSPACE", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit de créer une tâche." };
    const title = (payload.title ?? "").trim();
    if (!title) return { ok: false, error: "Intitulé de tâche manquant." };

    // LE MÊME CIRCUIT QUE L'ÉCRAN, par le CŒUR canonique (`lib/tasks/create-core.ts`) : pour un
    // collègue c'est une DEMANDE (REQUESTED + pop-up + accepter/refuser), pour soi une to-do —
    // plus jamais une tâche déposée en douce dans la liste de quelqu'un.
    const assignedToId = (await activeUserId(payload.assigneeId)) ?? user.id;
    const created = await createTaskRecord(user.id, {
      title, description: payload.description?.trim() || null,
      assignedToId,
      dueDate: dateValue(payload.dueDate), priority: priorityOf(payload.priority),
    }, { module: "Assistant IA", suffix: " (via l'assistant)" });
    return {
      ok: true,
      message: created.mode === "request"
        ? `Demande de tâche envoyée à ${payload.assigneeName ?? "la personne"} — elle l'acceptera ou la refusera.`
        : `Tâche « ${title} » créée.`,
      link: `/mon-espace/taches/${created.id}`,
      revalidate: ["/mon-espace", "/mon-travail"],
      createdId: created.id,
    };
  }

  if (payload?.kind === "create_dossier") {
    if (!userCan(user, "DOSSIERS", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit d'ouvrir un dossier." };
    const title = (payload.title ?? "").trim();
    if (!title) return { ok: false, error: "Sujet du dossier manquant." };
    const assignedToId = await activeUserId(payload.assigneeId);
    const { id, reference } = await createDossierRecord(
      {
        title,
        description: payload.description?.trim() || null,
        category: payload.category?.trim() || null,
        priority: priorityOf(payload.priority),
        assignedToId,
        dueDate: dateValue(payload.dueDate),
      },
      user.id,
    );
    return { ok: true, message: `Dossier ${reference} ouvert.`, link: `/dossiers/${id}`, revalidate: ["/dossiers", "/mon-travail"] };
  }

  return undefined;
}

/** Branches de `performAction` : envoi d'un courriel préparé (intention approuvée). */
export async function executerCourrielPrepare(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload } = c;

  if (payload?.kind === "send_prepared_mail") {
    // LE CLIC SUR « ENVOYER » — l'une des DEUX interfaces de la même autorité. L'autre est la
    // parole (« vas-y, envoie »). Toutes deux appellent cette fonction-là, pas une logique
    // jumelle : c'est ce qui garantit qu'un durcissement profite aux deux sans qu'on y pense.
    return approveAndExecuteIntent(user, payload.intentId, gmailTransport);
  }

  return undefined;
}

/** Branches de `performAction` : envoi d'un e-mail. */
export async function executerEnvoiCourriel(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { payload } = c;

  if (payload?.kind === "send_email") {
    // LA PORTE DÉROBÉE, CONDAMNÉE.
    //
    // Cette carte expédiait autrefois par SMTP, hors de l'intention canonique : ni empreinte de
    // contenu approuvé, ni approbateur enregistré, ni transition atomique, ni relecture de
    // `MAIL_SEND_POLICY`. Une carte laissée ouverte dans un navigateur pouvait donc encore faire
    // partir un message qu'aucun garde-fou n'aurait vu passer.
    //
    // On ne la supprime pas — un onglet resté ouvert doit obtenir une explication, pas une
    // erreur muette — mais elle n'envoie plus rien : elle renvoie vers le seul chemin d'envoi.
    return {
      ok: false,
      error: "Cette carte vient d'une version antérieure de l'assistant et n'expédie plus rien. "
        + "Redemandez-moi l'envoi : je prépare le message depuis l'adresse d'Adam et vous le présente à approuver.",
    };
  }

  return undefined;
}

/** Branches de `performAction` : demande de prise en charge (congrès). */
export async function executerPriseEnCharge(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload } = c;

  if (payload?.kind === "create_congress_request") {
    // L'ACTION DE L'ÉCRAN, et elle seule (audit du 27/10/2026, ADPRO-04) — comme le sponsoring et l'événement plus bas.
    // Ce chemin écrivait la prise en charge à la main : statut d'entrée figé (« préliminaire » quel que soit le
    // créateur), ni gamme ni société payeuse, sans date de fin, et SANS circuit — personne de sa route n'était
    // prévenu (décision #1), seule « la Direction » l'était, pour une étape qui n'existe plus.
    const scope = payload.scope === "INTL" ? "INTL" : "NATIONAL";
    const mod: Module = scope === "INTL" ? "CONGRESS_INTERNATIONAL" : "CONGRESS_NATIONAL";
    if (!userCan(user, mod, "CREATE")) return { ok: false, error: "Vous n'avez pas le droit de créer cette demande de congrès." };
    const name = (payload.name ?? "").trim();
    if (!name) return { ok: false, error: "Nom de l'événement manquant." };
    const fd = new FormData();
    fd.set("type", scope);
    fd.set("name", name);
    if (payload.startDate) fd.set(scope === "INTL" ? "startDate" : "date", payload.startDate);
    if (payload.endDate) fd.set("endDate", payload.endDate);
    if (payload.city) fd.set("city", payload.city);
    if (scope === "INTL" && payload.country) fd.set("country", payload.country);
    if (payload.estimatedBudget != null) fd.set("estimatedBudget", String(payload.estimatedBudget));
    // Le médecin retrouvé dans le périmètre de la personne devient un professionnel PROPOSÉ (sa fiche est ouverte).
    if (payload.doctorId) {
      const d = await prisma.medicalDoctor.findFirst({ where: { AND: [scopeMedicalDoctors(user), { id: payload.doctorId }] }, select: { id: true } });
      if (d) fd.append("invitedDoctorIds", d.id);
    }
    const r = await createCongressRequest(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande de prise en charge n'a pas pu être créée." };
    const path = scope === "INTL" ? "/congress-international" : "/congress-national";
    return {
      ok: true,
      message: `Demande de prise en charge « ${name} » créée — elle suit son circuit de validation.${r.message ? ` ${r.message}` : ""}`,
      link: `${path}/${r.id}`, revalidate: [path],
    };
  }

  return undefined;
}

/** Branches de `performAction` : sponsoring, événement, matériel promotionnel (refusé ici), décision du centre de paiement. */
export async function executerDemandesEtPaiement(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { user, payload } = c;

  if (payload?.kind === "create_sponsoring_request") {
    if (!userCan(user, "SPONSORING", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit de créer une demande de sponsoring." };
    const institution = (payload.institution ?? "").trim();
    if (!institution) return { ok: false, error: "L'institution / bénéficiaire est obligatoire." };
    const fd = new FormData();
    fd.set("institution", institution);
    if (payload.type) fd.set("type", payload.type);
    if (payload.specialty) fd.set("specialty", payload.specialty);
    if (payload.city) fd.set("city", payload.city);
    if (payload.product) fd.set("product", payload.product);
    if (payload.doctorName) fd.set("doctor", payload.doctorName);
    if (payload.description) fd.set("description", payload.description);
    if (payload.amountRequested != null) fd.set("amountRequested", String(payload.amountRequested));
    const r = await createSponsoring(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La demande de sponsoring n'a pas pu être créée." };
    return { ok: true, message: `Demande de sponsoring « ${institution} » créée (en attente de validation).`, link: "/sponsoring", revalidate: ["/sponsoring"] };
  }

  if (payload?.kind === "create_event_request") {
    if (!userCan(user, "EVENTS", "CREATE")) return { ok: false, error: "Vous n'avez pas le droit de créer un événement." };
    const name = (payload.name ?? "").trim();
    if (!name) return { ok: false, error: "Le nom de l'événement est obligatoire." };
    const fd = new FormData();
    fd.set("name", name);
    if (payload.specialty) fd.set("specialty", payload.specialty);
    if (payload.city) fd.set("city", payload.city);
    if (payload.country) fd.set("country", payload.country);
    if (payload.startDate) fd.set("startDate", payload.startDate);
    if (payload.endDate) fd.set("endDate", payload.endDate);
    if (payload.description) fd.set("description", payload.description);
    if (payload.estimatedBudget != null) fd.set("estimatedBudget", String(payload.estimatedBudget));
    const r = await createEvent(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "L'événement n'a pas pu être créé." };
    return { ok: true, message: `Événement « ${name} » créé.`, link: "/events", revalidate: ["/events"] };
  }

  if (payload?.kind === "create_promo_material_request") {
    // Une carte d'avant le §118.171 peut encore être confirmée : elle ne porte aucune ligne,
    // l'action la refuserait — on le dit ici, dans la même phrase que la proposition.
    return { ok: false, error: REFUS_MATERIEL_PAR_ADAM };
  }

  if (payload?.kind === "decide_payment") {
    // L'exécution repasse par L'ACTION DU CENTRE — la même que l'écran : elle revérifie qui
    // siège, si la décision a encore un sens (transition), écrit le fil et prévient qui attend.
    // Ne pas dupliquer cette logique ici : deux implémentations divergeraient un jour de paie.
    if (!sitsOnPaymentCentre(user)) return { ok: false, error: PAYMENT_CENTRE_REFUSAL };
    const fd = new FormData();
    fd.set("id", payload.orderId);
    fd.set("decision", payload.decision);
    if (payload.note) fd.set("body", payload.note);
    if (payload.proposedAmount != null) fd.set("proposedAmount", String(payload.proposedAmount));
    const r = await decidePayment(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La décision n'a pas pu être enregistrée." };
    return {
      ok: true,
      message: `${CENTRAL_DECISION_LABEL[payload.decision]} — ${payload.reference} (${formatMontant(payload.amountDzd)} DZD).`,
      link: "/centre-de-paiement",
      revalidate: ["/centre-de-paiement", "/finances/paiements-a-faire"],
    };
  }

  return undefined;
}
