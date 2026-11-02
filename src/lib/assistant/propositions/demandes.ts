/**
 * PROPOSITIONS — Demandes métier : prise en charge (congrès), demande RH, sponsoring, événement,
 * matériel promotionnel (refusé ici).
 * Une famille de l'ancienne chaîne de `buildProposal`, recopiée telle quelle et appelée à son rang
 * (voir `propositions/construire.ts`) ; elle rend `undefined` quand l'outil n'est pas le sien.
 */

import { userCan, type Module } from "@/lib/assistant/coeur/erp";
import { REFUS_MATERIEL_PAR_ADAM, type ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import {
  HR_REQUEST_FR, HR_REQUEST_TYPES, HR_LEAVE_TYPES, HR_PERIOD_TYPES, YM_RE,
} from "@/lib/assistant/outils/catalogue-lecture";
import { asStr } from "@/platform/ia/outils/arguments";
import { isoDate, pastWarning, findDoctor, type ContexteProposition } from "@/lib/assistant/propositions/aides";

/** La famille « demandes » de `buildProposal` : rend `undefined` quand l'outil n'est pas le sien. */
export async function proposerDemandes(c: ContexteProposition): Promise<ProposedAction | { error: string } | undefined> {
  const { toolName, input, user, warnings } = c;

  if (toolName === "create_congress_request") {
    const scope = asStr(input, "scope").toUpperCase() === "INTL" ? "INTL" : "NATIONAL";
    const mod: Module = scope === "INTL" ? "CONGRESS_INTERNATIONAL" : "CONGRESS_NATIONAL";
    if (!userCan(user, mod, "CREATE")) return { error: `Vous n'avez pas accès aux demandes de congrès ${scope === "INTL" ? "internationaux" : "nationaux"}.` };
    const name = asStr(input, "name");
    if (!name) return { error: "Nom de l'événement manquant." };
    const startDate = asStr(input, "startDate") ? isoDate(asStr(input, "startDate")) : null;
    const endDate = asStr(input, "endDate") ? isoDate(asStr(input, "endDate")) : null;
    pastWarning("La date de début", startDate, warnings);
    pastWarning("La date de fin", endDate, warnings);
    const budgetRaw = input.estimatedBudget;
    const estimatedBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : null;
    let doctorId: string | null = null, doctorName: string | null = null;
    const doctorQuery = asStr(input, "doctorName");
    if (doctorQuery) {
      const d = await findDoctor(doctorQuery, user);
      if (d) { doctorId = d.id; doctorName = d.name; }
      else warnings.push(`Médecin « ${doctorQuery} » introuvable dans votre périmètre — la demande sera créée sans médecin lié.`);
    }
    const fields = [
      { label: "Type", value: scope === "INTL" ? "Prise en charge Internationale" : "Congrès / événement national" },
      { label: "Événement", value: name },
    ];
    if (asStr(input, "specialty")) fields.push({ label: "Spécialité", value: asStr(input, "specialty") });
    const place = [asStr(input, "city"), scope === "INTL" ? asStr(input, "country") : ""].filter(Boolean).join(", ");
    if (place) fields.push({ label: "Lieu", value: place });
    if (startDate || endDate) fields.push({ label: "Dates", value: [startDate, endDate].filter(Boolean).join(" → ") });
    if (doctorName) fields.push({ label: "Médecin", value: doctorName });
    if (estimatedBudget !== null) fields.push({ label: "Budget estimé", value: `${estimatedBudget.toLocaleString("fr-FR")} DZD` });
    if (asStr(input, "note")) fields.push({ label: "Note", value: asStr(input, "note") });
    return {
      kind: "create_congress_request", module: mod, title: "Créer une demande de congrès", fields, warnings,
      payload: {
        kind: "create_congress_request", scope, name,
        specialty: asStr(input, "specialty") || null, city: asStr(input, "city") || null,
        country: scope === "INTL" ? (asStr(input, "country") || null) : null,
        startDate, endDate, estimatedBudget, doctorId, doctorName, note: asStr(input, "note") || null,
      },
    };
  }

  if (toolName === "create_hr_request") {
    // Libre-service RH : tout employé peut faire une demande pour SON dossier (vérif. du dossier à l'exécution).
    if (!userCan(user, "WORKSPACE", "VIEW")) return { error: "Vous n'avez pas accès aux demandes RH." };
    const type = asStr(input, "type").toUpperCase();
    if (!HR_REQUEST_TYPES.includes(type)) return { error: "Type de demande RH inconnu." };
    const expenseMonth = asStr(input, "expenseMonth").trim() || null;
    if (type === "EXPENSE_REPORT" && !(expenseMonth && YM_RE.test(expenseMonth))) {
      return { error: "Pour une note de frais, précisez le mois concerné (AAAA-MM)." };
    }
    const periodStart = asStr(input, "periodStart") ? isoDate(asStr(input, "periodStart")) : null;
    const periodEnd = asStr(input, "periodEnd") ? isoDate(asStr(input, "periodEnd")) : null;
    if (HR_PERIOD_TYPES.has(type) && !periodStart) return { error: "Indiquez la date de début du congé / de l'absence (AAAA-MM-JJ)." };
    if (HR_LEAVE_TYPES.has(type) && !periodEnd) return { error: "Indiquez la date de fin du congé (AAAA-MM-JJ)." };
    if (periodStart && periodEnd && periodEnd < periodStart) return { error: "La date de fin précède la date de début." };
    pastWarning("Le début de la période", periodStart, warnings);
    const details = asStr(input, "details").trim() || null;
    const fields = [{ label: "Demande RH", value: HR_REQUEST_FR[type] }];
    if (type === "EXPENSE_REPORT" && expenseMonth) fields.push({ label: "Mois", value: expenseMonth });
    if (periodStart || periodEnd) fields.push({ label: "Période", value: [periodStart, periodEnd].filter(Boolean).join(" → ") });
    if (details) fields.push({ label: "Précisions", value: details });
    return {
      kind: "create_hr_request", module: "RH", title: "Créer une demande RH", fields, warnings,
      payload: { kind: "create_hr_request", type, details, expenseMonth: type === "EXPENSE_REPORT" ? expenseMonth : null, periodStart, periodEnd },
    };
  }

  if (toolName === "create_sponsoring_request") {
    if (!userCan(user, "SPONSORING", "CREATE")) return { error: "Vous n'avez pas accès aux demandes de sponsoring." };
    const institution = asStr(input, "institution").trim();
    if (!institution) return { error: "L'institution / bénéficiaire est obligatoire." };
    let doctorName: string | null = null;
    const doctorQuery = asStr(input, "doctorName");
    if (doctorQuery) {
      const d = await findDoctor(doctorQuery, user);
      if (d) doctorName = d.name;
      else warnings.push(`Médecin « ${doctorQuery} » introuvable dans votre périmètre — la demande sera créée sans médecin lié.`);
    }
    const amountRaw = input.amountRequested;
    const amountRequested = typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : null;
    const fields = [{ label: "Bénéficiaire", value: institution }];
    if (asStr(input, "type")) fields.push({ label: "Type", value: asStr(input, "type") });
    if (asStr(input, "specialty")) fields.push({ label: "Spécialité", value: asStr(input, "specialty") });
    if (asStr(input, "city")) fields.push({ label: "Ville", value: asStr(input, "city") });
    if (asStr(input, "product")) fields.push({ label: "Produit", value: asStr(input, "product") });
    if (doctorName) fields.push({ label: "Médecin", value: doctorName });
    if (amountRequested !== null) fields.push({ label: "Montant demandé", value: `${amountRequested.toLocaleString("fr-FR")} DZD` });
    if (asStr(input, "description")) fields.push({ label: "Objet", value: asStr(input, "description") });
    return {
      kind: "create_sponsoring_request", module: "SPONSORING", title: "Créer une demande de sponsoring", fields, warnings,
      payload: {
        kind: "create_sponsoring_request", institution,
        type: asStr(input, "type") || null, specialty: asStr(input, "specialty") || null, city: asStr(input, "city") || null,
        amountRequested, product: asStr(input, "product") || null, description: asStr(input, "description") || null, doctorName,
      },
    };
  }

  if (toolName === "create_event_request") {
    if (!userCan(user, "EVENTS", "CREATE")) return { error: "Vous n'avez pas accès aux événements." };
    const name = asStr(input, "name").trim();
    if (!name) return { error: "Le nom de l'événement est obligatoire." };
    const startDate = asStr(input, "startDate") ? isoDate(asStr(input, "startDate")) : null;
    const endDate = asStr(input, "endDate") ? isoDate(asStr(input, "endDate")) : null;
    pastWarning("La date de début", startDate, warnings);
    if (startDate && endDate && endDate < startDate) warnings.push("La date de fin précède la date de début.");
    const budgetRaw = input.estimatedBudget;
    const estimatedBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : null;
    const fields = [{ label: "Événement", value: name }];
    if (asStr(input, "specialty")) fields.push({ label: "Spécialité", value: asStr(input, "specialty") });
    const place = [asStr(input, "city"), asStr(input, "country")].filter(Boolean).join(", ");
    if (place) fields.push({ label: "Lieu", value: place });
    if (startDate || endDate) fields.push({ label: "Dates", value: [startDate, endDate].filter(Boolean).join(" → ") });
    if (estimatedBudget !== null) fields.push({ label: "Budget estimé", value: `${estimatedBudget.toLocaleString("fr-FR")} DZD` });
    if (asStr(input, "description")) fields.push({ label: "Détails", value: asStr(input, "description") });
    return {
      kind: "create_event_request", module: "EVENTS", title: "Créer un événement", fields, warnings,
      payload: {
        kind: "create_event_request", name,
        specialty: asStr(input, "specialty") || null, city: asStr(input, "city") || null, country: asStr(input, "country") || null,
        startDate, endDate, estimatedBudget, description: asStr(input, "description") || null,
      },
    };
  }

  if (toolName === "create_promo_material_request") {
    // LA DEMANDE SE COMPOSE DE LIGNES DU CATALOGUE (§118.171) — article, quantité, actions
    // attendues du fournisseur —, et cet outil ne sait pas les porter. Proposer une carte que
    // l'action refuserait APRÈS le clic serait un geste offert puis retiré (§118.83) : la garde
    // est ici, avant, et elle nomme l'écran qui sait. Adam est en pause de développement.
    return { error: REFUS_MATERIEL_PAR_ADAM };
  }

  return undefined;
}
