import { prisma } from "@/lib/prisma";
import {
  addCareBeneficiary, setCareOpinion, decideCareBeneficiary, removeCareBeneficiary,
  addCareCell, setCareCellStatus, removeCareCell, createCareQuote, decideCareQuote,
  requestCareQuotes, sendCareToFinance, linkCareCellPromoMaterial, marquerPriseEnChargeRealisee,
} from "@/lib/actions/care-actions";
import {
  submitQuotes, chooseAgency, submitBcForFinance, remindFinance, validateBc, confirmBcSent,
  initiatePayment, confirmPayment, submitMaterial, directionReview, confirmConformity,
  startBat, submitFinalMaterial, recordInvoice, settle, addPromoComment, cancelPromoMaterial,
} from "@/lib/actions/promo-material-actions";
import { startPromoCircuit, markQuoteReceived, completePromoTrack } from "@/lib/actions/promo-circuit-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, runFd2, fieldsOf, dzd } from "./helpers";
import { matchLabel, fold } from "./impl-regulatory";
import { designerDossierPromo } from "@/platform/in-process/promo";

/**
 * OPS VAGUE 5b — PRISES EN CHARGE (décision PAR PERSONNE, besoins par personne, devis qui
 * couvrent N cases avec le garde-fou anti double paiement, envoi aux Finances bloqué tant
 * qu'il manque une pièce), MATÉRIEL PROMOTIONNEL (les 15 marches du circuit long, le circuit
 * court à chantiers parallèles). Le STOCK n'a plus d'ops ici : ses gestes attestent des faits
 * physiques et sont réservés à l'écran (§118.164).
 * Toujours par les ACTIONS CANONIQUES.
 */

// ─────────────────────────── PRISES EN CHARGE ───────────────────────────

interface CareRequest { scope: "NATIONAL" | "INTERNATIONAL"; requestId: string; label: string }

async function resolveCareRequest(kindRaw: string, labelRaw: string): Promise<CareRequest | { error: string }> {
  const q = labelRaw.trim();
  if (!q) return { error: "Précisez le congrès (champ « target » — son nom)." };
  const k = fold(kindRaw);
  const wantIntl = /international/.test(k);
  const wantNat = /national/.test(k) && !wantIntl;
  const hits: CareRequest[] = [];
  if (!wantIntl) {
    for (const c of await prisma.congressNational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ scope: "NATIONAL", requestId: c.id, label: `${c.name} (congrès national)` });
    }
  }
  if (!wantNat) {
    for (const c of await prisma.congressInternational.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 4 })) {
      hits.push({ scope: "INTERNATIONAL", requestId: c.id, label: `${c.name} (congrès international)` });
    }
  }
  if (hits.length === 0) return { error: `Aucun congrès « ${q} ».` };
  if (hits.length > 1) return { error: `Plusieurs congrès correspondent : ${hits.map((h) => h.label).join(" ; ")} — préciser (champ « kind » : congrès national | congrès international).` };
  return hits[0];
}

const benefWhere = (req: CareRequest) =>
  req.scope === "NATIONAL" ? { congressNationalId: req.requestId } : { congressInternationalId: req.requestId };

async function doctorNameMap(doctorIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = doctorIds.filter((x): x is string => Boolean(x));
  if (ids.length === 0) return new Map();
  const docs = await prisma.medicalDoctor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(docs.map((d) => [d.id, d.name]));
}

interface BeneficiaryHit { id: string; name: string }

async function resolveBeneficiary(req: CareRequest, raw: string): Promise<BeneficiaryHit | { error: string }> {
  const rows = await prisma.careBeneficiary.findMany({
    where: benefWhere(req),
    // doctorId est un scalaire SANS relation Prisma (profil libre possible) : les noms
    // des praticiens de l'annuaire se résolvent par une seconde requête.
    select: { id: true, firstName: true, lastName: true, doctorId: true },
    orderBy: { position: "asc" }, take: 40,
  });
  if (rows.length === 0) return { error: `${req.label} n'a aucune personne prise en charge.` };
  const doctorNames = await doctorNameMap(rows.map((b) => b.doctorId));
  const label = (b: (typeof rows)[number]) =>
    (b.doctorId ? doctorNames.get(b.doctorId) : null) ?? ([b.firstName, b.lastName].filter(Boolean).join(" ") || "—");
  const q = fold(raw);
  if (!q) {
    if (rows.length === 1) return { id: rows[0].id, name: label(rows[0]) };
    return { error: `Précisez la personne (champ « person ») parmi : ${rows.map(label).join(", ")}.` };
  }
  const hits = rows.filter((b) => fold(label(b)).includes(q));
  if (hits.length === 1) return { id: hits[0].id, name: label(hits[0]) };
  if (hits.length === 0) return { error: `Aucune personne « ${raw} » sur ${req.label} — présentes : ${rows.map(label).join(", ")}.` };
  return { error: `Plusieurs personnes correspondent : ${hits.map(label).join(", ")} — préciser.` };
}

interface CellHit { id: string; label: string }

async function resolveCell(beneficiaryId: string, personName: string, raw: string): Promise<CellHit | { error: string }> {
  const rows = await prisma.careCell.findMany({
    where: { beneficiaryId }, select: { id: true, label: true, status: true }, orderBy: { position: "asc" }, take: 30,
  });
  if (rows.length === 0) return { error: `${personName} n'a aucun élément (pièce / prestation).` };
  const q = fold(raw);
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Précisez l'élément (champ « label ») parmi : ${rows.map((c) => c.label).join(" ; ")}.` };
  }
  const hits = rows.filter((c) => fold(c.label).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucun élément « ${raw} » chez ${personName} — éléments : ${rows.map((c) => c.label).join(" ; ")}.` };
  return { error: `Plusieurs éléments correspondent : ${hits.map((c) => c.label).join(" ; ")} — préciser.` };
}

const SERVICE_KIND_FR: [string, string][] = [
  ["HOTEL", "Hôtel"], ["TRANSPORT", "Transport"], ["TICKET", "Billet"],
  ["CATERING", "Restauration"], ["REGISTRATION", "Inscription"], ["PROMO_MATERIAL", "Matériel promotionnel"], ["OTHER", "Autre"],
];
const CELL_STATUS_FR: [string, string][] = [
  ["REQUESTED", "Demandée"], ["PROVIDED", "Reçue"], ["SETTLED", "Réglée"], ["WAIVED", "Sans objet"],
];

export const CARE_OPS_IMPL: Record<string, OpImpl> = {
  add_care_person: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const raw = opStr(input, "person");
      if (!raw) return { error: "Précisez la personne (champ « person » — praticien de l'annuaire, ou nom libre)." };
      const doctors = await prisma.medicalDoctor.findMany({
        where: { name: { contains: raw, mode: "insensitive" } }, select: { id: true, name: true }, take: 4,
      });
      if (doctors.length > 1) return { error: `Plusieurs praticiens correspondent : ${doctors.map((d) => d.name).join(", ")} — préciser (ou donner un nom libre plus complet).` };
      const doctor = doctors.length === 1 ? doctors[0] : null;
      return {
        title: `Ajouter ${doctor?.name ?? raw} à la prise en charge — ${req.label}`,
        fields: fieldsOf([
          ["Congrès", req.label],
          ["Personne", doctor ? `${doctor.name} (annuaire)` : `${raw} (profil libre)`],
          ["Fonction", opStr(input, "role") || null],
          ["Établissement", opStr(input, "institution") || null],
        ]),
        args: {
          scope: req.scope, requestId: req.requestId,
          doctorId: doctor?.id ?? null, lastName: doctor ? null : raw,
          jobTitle: opStr(input, "role") || null, institution: opStr(input, "institution") || null,
        },
        successMessage: `${doctor?.name ?? raw} ajouté·e à la prise en charge (${req.label}).`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(addCareBeneficiary, args, "L'ajout de la personne a été refusé.", { revalidate: ["/congress-national"] }),
  },

  set_care_opinion: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const raw = fold(opStr(input, "decision") || opStr(input, "mode"));
      const opinion = /d[ée]favorable|contre/.test(raw) ? "UNFAVORABLE" : /favorable|pour/.test(raw) ? "FAVORABLE" : /sans avis|aucun|pas d avis|neutre/.test(raw) ? "NONE" : null;
      if (!opinion) return { error: "Précisez l'avis (champ « decision ») : favorable, défavorable, ou pas d'avis." };
      return {
        title: `Avis « ${opinion === "FAVORABLE" ? "Favorable" : opinion === "UNFAVORABLE" ? "Défavorable" : "Pas d'avis"} » sur ${person.name}`,
        fields: fieldsOf([
          ["Personne", `${person.name} — ${req.label}`],
          ["Avis", opinion === "FAVORABLE" ? "Favorable" : opinion === "UNFAVORABLE" ? "Défavorable" : "Pas d'avis"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: person.id, opinion, note: opStr(input, "note") || null },
        successMessage: `Avis porté sur ${person.name}.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(setCareOpinion, args, "L'avis a été refusé.", { revalidate: ["/congress-national"] }),
  },

  decide_care_person: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const raw = fold(opStr(input, "decision"));
      const decision = /refus|[ée]cart|rejet/.test(raw) ? "REJECTED" : /accord|approuv|valid/.test(raw) ? "APPROVED" : null;
      if (!decision) return { error: "Précisez la décision (champ « decision ») : accorder ou écarter." };
      return {
        title: `${decision === "APPROVED" ? "ACCORDER" : "ÉCARTER"} la prise en charge de ${person.name}`,
        fields: fieldsOf([
          ["Personne", `${person.name} — ${req.label}`],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: decision === "APPROVED"
          ? ["Décision PAR PERSONNE (Direction) — l'accord crée d'office sa pièce d'identité à fournir."]
          : ["Décision par personne, tracée — les autres personnes de la demande ne bougent pas."],
        args: { id: person.id, decision, note: opStr(input, "note") || null },
        successMessage: `${person.name} : prise en charge ${decision === "APPROVED" ? "ACCORDÉE" : "écartée"}.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(decideCareBeneficiary, args, "La décision a été refusée.", { revalidate: ["/congress-national"] }),
  },

  remove_care_person: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      return {
        title: `Retirer ${person.name} de la prise en charge`,
        fields: [{ label: "Personne", value: `${person.name} — ${req.label}` }],
        warnings: ["Une personne dont une prestation est déjà ENGAGÉE ne se retire pas (l'action refuse) : on l'ÉCARTE plutôt (decide_care_person)."],
        args: { id: person.id },
        successMessage: `${person.name} retiré·e de la prise en charge.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(removeCareBeneficiary, args, "Le retrait a été refusé.", { revalidate: ["/congress-national"] }),
  },

  add_care_cell: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const label = opStr(input, "label");
      if (!label) return { error: "Précisez l'élément (champ « label » — pièce à fournir ou prestation à acheter)." };
      const isService = /prestation|service|achat|h[oô]tel|transport|billet|restauration|inscription/i.test(opStr(input, "mode") + " " + label);
      let serviceKind: string | null = null;
      if (isService) {
        const m = matchLabel(opStr(input, "serviceKind") || label, SERVICE_KIND_FR);
        serviceKind = typeof m === "string" ? m : "OTHER";
      }
      return {
        title: `Ajouter « ${label} » chez ${person.name}`,
        fields: fieldsOf([
          ["Personne", `${person.name} — ${req.label}`],
          ["Élément", label],
          ["Nature", isService ? `Prestation (${SERVICE_KIND_FR.find(([c]) => c === serviceKind)?.[1] ?? "Autre"})` : "Pièce à fournir"],
        ]),
        args: { beneficiaryId: person.id, label, kind: isService ? "SERVICE" : "DOCUMENT", serviceKind, notes: opStr(input, "notes") || null },
        successMessage: `Élément « ${label} » ajouté chez ${person.name}.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(addCareCell, args, "L'ajout de l'élément a été refusé.", { revalidate: ["/congress-national"] }),
  },

  set_care_cell_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const cell = await resolveCell(person.id, person.name, opStr(input, "label"));
      if ("error" in cell) return cell;
      const m = matchLabel(opStr(input, "status"), CELL_STATUS_FR);
      if (typeof m === "object") return m;
      return {
        title: `« ${cell.label} » de ${person.name} → ${CELL_STATUS_FR.find(([c]) => c === m)?.[1]}`,
        fields: [
          { label: "Élément", value: `${cell.label} — ${person.name}` },
          { label: "État", value: CELL_STATUS_FR.find(([c]) => c === m)?.[1] ?? m },
        ],
        warnings: m === "WAIVED" ? ["« Sans objet » n'est PAS une suppression : la trace reste — refusé si une dépense est engagée."] : [],
        args: { id: cell.id, status: m },
        successMessage: `« ${cell.label} » de ${person.name} : ${CELL_STATUS_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(setCareCellStatus, args, "Le changement d'état a été refusé.", { revalidate: ["/congress-national"] }),
  },

  remove_care_cell: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const cell = await resolveCell(person.id, person.name, opStr(input, "label"));
      if ("error" in cell) return cell;
      return {
        title: `Retirer « ${cell.label} » chez ${person.name}`,
        fields: [{ label: "Élément", value: `${cell.label} — ${person.name}` }],
        warnings: ["Refusé si une dépense est engagée sur cet élément — préférez « sans objet » pour garder la trace."],
        args: { id: cell.id },
        successMessage: `Élément « ${cell.label} » retiré.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(removeCareCell, args, "Le retrait a été refusé.", { revalidate: ["/congress-national"] }),
  },

  create_care_quote: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const supplier = opStr(input, "supplier");
      if (!supplier) return { error: "Précisez le fournisseur du devis (champ « supplier »)." };
      const amount = opStr(input, "amount");
      if (!amount || Number(amount) <= 0) return { error: "Précisez le montant du devis (champ « amount », DZD)." };
      const wanted = (opStr(input, "label") || opStr(input, "cells")).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      if (wanted.length === 0) return { error: "Précisez ce que le devis COUVRE (champ « label » — libellés d'éléments, virgules)." };
      const cells = await prisma.careCell.findMany({
        where: { beneficiary: benefWhere(req) },
        select: { id: true, label: true, beneficiary: { select: { firstName: true, lastName: true, doctorId: true } } },
        take: 100,
      });
      const quoteDoctors = await doctorNameMap(cells.map((c) => c.beneficiary.doctorId));
      const cellLabel = (c: (typeof cells)[number]) =>
        `${c.label} (${(c.beneficiary.doctorId ? quoteDoctors.get(c.beneficiary.doctorId) : null) ?? [c.beneficiary.firstName, c.beneficiary.lastName].filter(Boolean).join(" ")})`;
      const ids: string[] = []; const covered: string[] = [];
      for (const w of wanted) {
        const q = fold(w);
        const hits = cells.filter((c) => fold(c.label).includes(q) || fold(cellLabel(c)).includes(q));
        if (hits.length === 0) return { error: `Aucun élément « ${w} » sur ${req.label} — éléments : ${cells.slice(0, 10).map(cellLabel).join(" ; ")}.` };
        for (const h of hits) { if (!ids.includes(h.id)) { ids.push(h.id); covered.push(cellLabel(h)); } }
      }
      return {
        title: `Devis ${supplier} — ${dzd(Number(amount))} (${req.label})`,
        fields: [
          { label: "Congrès", value: req.label },
          { label: "Fournisseur", value: supplier },
          { label: "Montant", value: dzd(Number(amount)) },
          { label: "Couvre", value: covered.join(" ; ") },
        ],
        warnings: ["Un devis couvre ce qu'il couvre réellement (N cases) — les cases couvertes passent « reçues »."],
        args: { scope: req.scope, requestId: req.requestId, supplier, amountDzd: amount, cellIds: ids.join(","), reference: opStr(input, "reference") || null, note: opStr(input, "note") || null },
        successMessage: `Devis ${supplier} (${dzd(Number(amount))}) enregistré — couvre ${ids.length} élément(s).`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(args)) {
        if (v == null || k === "cellIds") continue;
        fd.set(k, v);
      }
      for (const id of (args.cellIds ?? "").split(",").filter(Boolean)) fd.append("cellIds", id);
      const r = await createCareQuote(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'enregistrement du devis a été refusé." };
      return { ok: true, revalidate: ["/congress-national", "/congress-international"] };
    },
  },

  decide_care_quote: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const supplierRaw = fold(opStr(input, "supplier"));
      const quotes = await prisma.careQuote.findMany({
        where: benefWhere(req), select: { id: true, supplier: true, amountDzd: true, status: true },
        orderBy: { createdAt: "desc" }, take: 12,
      });
      if (quotes.length === 0) return { error: `Aucun devis sur ${req.label}.` };
      const hits = supplierRaw ? quotes.filter((q) => fold(q.supplier).includes(supplierRaw)) : quotes;
      const pick = hits.length === 1 ? hits[0] : quotes.length === 1 ? quotes[0] : null;
      if (!pick) return { error: `Plusieurs devis : ${quotes.map((q) => `${q.supplier} (${dzd(Number(q.amountDzd))})`).join(" ; ")} — préciser le fournisseur (champ « supplier »).` };
      const raw = fold(opStr(input, "decision"));
      const decision = /refus|rejet/.test(raw) ? "REJECTED" : /accept|accord|valid/.test(raw) ? "ACCEPTED" : null;
      if (!decision) return { error: "Précisez la décision (champ « decision ») : accepter ou refuser." };
      return {
        title: `${decision === "ACCEPTED" ? "ACCEPTER" : "REFUSER"} le devis ${pick.supplier} (${dzd(Number(pick.amountDzd))})`,
        fields: [
          { label: "Devis", value: `${pick.supplier} — ${dzd(Number(pick.amountDzd))} (${req.label})` },
        ],
        warnings: decision === "ACCEPTED"
          ? ["D'UN BLOC (le fournisseur a chiffré un ensemble) — crée l'ORDRE DE DÉPENSE ; une case déjà couverte par un devis accepté fait REFUSER (anti double paiement)."]
          : ["Les cases couvertes repassent « demandées » : il faut un autre devis."],
        args: { id: pick.id, decision, note: opStr(input, "note") || null },
        successMessage: `Devis ${pick.supplier} ${decision === "ACCEPTED" ? "ACCEPTÉ (ordre de dépense émis)" : "refusé"}.`,
        revalidate: ["/congress-national", "/congress-international", "/finances/paiements-a-faire"],
      };
    },
    execute: (args) => runFd2(decideCareQuote, args, "La décision sur le devis a été refusée.", { revalidate: ["/congress-national"] }),
  },

  request_care_quotes: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      return {
        title: `Solliciter le secrétariat pour les devis — ${req.label}`,
        fields: [{ label: "Congrès", value: req.label }],
        warnings: ["Le secrétariat est notifié des prestations des personnes ACCORDÉES qui attendent un devis — refuse si la Direction n'a pas validé l'événement."],
        args: { scope: req.scope, requestId: req.requestId },
        successMessage: `Secrétariat sollicité pour les devis (${req.label}).`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(requestCareQuotes, args, "La sollicitation a été refusée.", { revalidate: ["/congress-national"] }),
  },

  send_care_to_finance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      return {
        title: `Envoyer la prise en charge aux Finances — ${req.label}`,
        fields: [{ label: "Congrès", value: req.label }],
        warnings: ["REFUSE tant que quelque chose manque, en DISANT quoi (pièce manquante d'une personne accordée, devis sans décision) — un dossier incomplet produirait un montant faux."],
        args: { scope: req.scope, requestId: req.requestId },
        successMessage: `Dossier complet transmis aux Finances (${req.label}).`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(sendCareToFinance, args, "L'envoi aux Finances a été refusé.", { revalidate: ["/congress-national"] }),
  },

  mark_care_completed: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      return {
        title: `Marquer la prise en charge réalisée — ${req.label}`,
        fields: [{ label: "Congrès", value: req.label }],
        warnings: ["REFUSÉ tant que la prise en charge n'est pas validée ET transmise aux Finances ; réservé au demandeur ou à la Direction Marketing."],
        args: { scope: req.scope, requestId: req.requestId },
        successMessage: `Prise en charge marquée réalisée (${req.label}).`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(marquerPriseEnChargeRealisee, args, "Le marquage « réalisée » a été refusé.", { revalidate: ["/congress-national"] }),
  },

  link_care_promo: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveCareRequest(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in req) return req;
      const person = await resolveBeneficiary(req, opStr(input, "person"));
      if ("error" in person) return person;
      const cell = await resolveCell(person.id, person.name, opStr(input, "label"));
      if ("error" in cell) return cell;
      const pmRaw = opStr(input, "material");
      const clearing = /^(aucun|retire|d[ée]tache)/i.test(pmRaw);
      let pmId: string | null = null; let pmLabel = "— (détaché)";
      if (!clearing) {
        if (!pmRaw) return { error: "Précisez le matériel promotionnel (champ « material » — MP-… ou titre ; « aucun » pour détacher)." };
        const mats = await prisma.promoMaterial.findMany({
          where: { OR: [{ reference: { contains: pmRaw, mode: "insensitive" } }, { title: { contains: pmRaw, mode: "insensitive" } }], status: { not: "CANCELLED" } },
          select: { id: true, reference: true, title: true }, take: 6,
        });
        if (mats.length === 0) return { error: `Aucun matériel promotionnel « ${pmRaw} ».` };
        if (mats.length > 1) return { error: `Plusieurs matériels correspondent : ${mats.map((m) => `${m.reference} — ${m.title}`).join(" ; ")} — préciser.` };
        pmId = mats[0].id; pmLabel = `${mats[0].reference} — ${mats[0].title}`;
      }
      return {
        title: clearing ? `Détacher « ${cell.label} » de son matériel` : `Rattacher « ${cell.label} » (${person.name}) au matériel ${pmLabel}`,
        fields: [
          { label: "Élément", value: `${cell.label} — ${person.name}` },
          { label: "Matériel", value: pmLabel },
        ],
        warnings: clearing ? [] : ["On rattache, on ne recopie pas : le matériel garde son propre circuit — la case en lit l'avancement."],
        args: { id: cell.id, promoMaterialId: pmId },
        successMessage: clearing ? `« ${cell.label} » détaché.` : `« ${cell.label} » rattaché à ${pmLabel}.`,
        revalidate: ["/congress-national", "/congress-international"],
      };
    },
    execute: (args) => runFd2(linkCareCellPromoMaterial, args, "Le rattachement a été refusé.", { revalidate: ["/congress-national"] }),
  },
};

// ─────────────────────────── MATÉRIEL PROMOTIONNEL ───────────────────────────

interface PromoHit { id: string; reference: string; title: string }

/**
 * LE DOSSIER, SOUS LA PORTE DE LA FICHE (§118.152). La version d'avant cherchait dans la table
 * sans regarder qui demandait : une désignation ambiguë listait la référence et le TITRE de
 * dossiers que la personne n'a pas le droit d'ouvrir (§118.150d). Une seule désignation pour les
 * deux circuits — deux résolveurs du même dossier finiraient par choisir différemment (§118.5).
 */
async function resolvePromo(user: Parameters<OpImpl["propose"]>[1], raw: string): Promise<PromoHit | { error: string }> {
  return designerDossierPromo(user, raw);
}

/** Marche simple du circuit long : résolution + statut attendu annoncé, args {id} (+ extras). */
function promoStep(opts: {
  title: (pm: PromoHit) => string;
  warning?: string;
  action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
  extraFields?: (input: Record<string, unknown>) => [string, string | null][];
  extraArgs?: (input: Record<string, unknown>) => Record<string, string | null>;
  success: (pm: PromoHit) => string;
}): OpImpl {
  return {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      return {
        title: opts.title(pm),
        fields: [
          { label: "Dossier", value: `${pm.reference} — ${pm.title}` },
          ...fieldsOf(opts.extraFields ? opts.extraFields(input) : []),
        ],
        warnings: opts.warning ? [opts.warning] : [],
        args: { id: pm.id, ...(opts.extraArgs ? opts.extraArgs(input) : {}) },
        successMessage: opts.success(pm),
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(opts.action, args, "L'étape a été refusée.", { revalidate: ["/promo-material"] }),
  };
}

const PROMO_TRACK_FR: [string, string][] = [
  ["PURCHASE_ORDER", "Bon de commande"], ["PAYMENT", "Demande de paiement"], ["AD_VISA", "Demande de visa publicitaire"],
];

export const PROMO_OPS_IMPL: Record<string, OpImpl> = {
  submit_promo_quotes: promoStep({
    title: (pm) => `Devis déposés (assistante) — ${pm.reference}`,
    warning: "Ferme l'étape « Prospection demandée » — le Marketing arbitre ensuite les devis.",
    action: submitQuotes,
    success: (pm) => `Devis déposés sur ${pm.reference} — au Marketing d'arbitrer.`,
  }),

  choose_promo_agency: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      const agency = opStr(input, "supplier") || opStr(input, "name");
      if (!agency) return { error: "Précisez l'agence retenue (champ « supplier »)." };
      return {
        title: `Retenir l'agence « ${agency} » — ${pm.reference}`,
        fields: fieldsOf([
          ["Dossier", `${pm.reference} — ${pm.title}`],
          ["Agence retenue", agency],
          ["Montant", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Commentaire", opStr(input, "note") || null],
        ]),
        warnings: ["Geste du MARKETING (demandeur), une fois les devis déposés — la création du BC part à l'assistante."],
        args: { id: pm.id, chosenAgency: agency, chosenAmount: opStr(input, "amount") || null, comment: opStr(input, "note") || null },
        successMessage: `Agence « ${agency} » retenue sur ${pm.reference} — création du BC demandée.`,
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(chooseAgency, args, "Le choix de l'agence a été refusé.", { revalidate: ["/promo-material"] }),
  },

  submit_promo_bc: promoStep({
    title: (pm) => `Transmettre le BC au centre de validation Ad & Pro — ${pm.reference}`,
    warning: "Geste de l'ASSISTANTE, après le choix de l'agence — le centre de validation Ad & Pro valide ensuite le BC.",
    action: submitBcForFinance,
    extraFields: (input) => [["N° du BC", opStr(input, "note") || null]],
    extraArgs: (input) => ({ bcReference: opStr(input, "note") || null }),
    success: (pm) => `Bon de commande de ${pm.reference} transmis au centre de validation Ad & Pro.`,
  }),

  remind_promo_finance: promoStep({
    title: (pm) => `Relancer le centre de validation Ad & Pro — ${pm.reference}`,
    action: remindFinance,
    success: (pm) => `Centre de validation Ad & Pro relancé sur ${pm.reference}.`,
  }),

  validate_promo_bc: promoStep({
    title: (pm) => `Valider le BC (centre Ad & Pro) — ${pm.reference}`,
    warning: "Geste du CENTRE DE VALIDATION AD & PRO (Direction Générale, Super Admin) — le BC validé repart à l'assistante pour envoi à l'agence.",
    action: validateBc,
    success: (pm) => `Bon de commande de ${pm.reference} validé (centre Ad & Pro).`,
  }),

  confirm_promo_bc_sent: promoStep({
    title: (pm) => `BC envoyé à l'agence — ${pm.reference}`,
    warning: "Geste de l'ASSISTANTE — l'information médicale initie ensuite le bordereau de paiement.",
    action: confirmBcSent,
    success: (pm) => `BC de ${pm.reference} transmis à l'agence.`,
  }),

  initiate_promo_payment: promoStep({
    title: (pm) => `Initier le bordereau de paiement — ${pm.reference}`,
    warning: "Geste de l'INFORMATION MÉDICALE — crée l'ordre de dépense (montant du bordereau, sinon montant retenu du dossier) : il part au CENTRE DE PAIEMENT, qui l'autorise avant que les Finances ne le règlent.",
    action: initiatePayment,
    extraFields: (input) => [["Montant du bordereau", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : "montant retenu du dossier"]],
    extraArgs: (input) => ({ amount: opStr(input, "amount") || null }),
    success: (pm) => `Bordereau de paiement initié sur ${pm.reference} — l'ordre de dépense attend le centre de paiement.`,
  }),

  confirm_promo_payment: promoStep({
    title: (pm) => `Paiement effectué (Finances) — ${pm.reference}`,
    warning: "Geste des FINANCES, CONSTATÉ sur l'ordre de dépense : refusé tant que l'ordre du bordereau n'est pas réglé (le refus dit où il attend). L'information médicale dépose ensuite la quittance.",
    action: confirmPayment,
    extraFields: (input) => [["Commentaire", opStr(input, "note") || null]],
    extraArgs: (input) => ({ comment: opStr(input, "note") || null }),
    success: (pm) => `Paiement de ${pm.reference} confirmé.`,
  }),

  submit_promo_material: promoStep({
    title: (pm) => `Matériel réalisé par l'agence — ${pm.reference}`,
    warning: "Geste du MARKETING, après paiement — la Direction examine ensuite.",
    action: submitMaterial,
    success: (pm) => `Matériel de ${pm.reference} déposé — à l'examen de la Direction.`,
  }),

  review_promo_direction: promoStep({
    title: (pm) => `Examen de la Direction — ${pm.reference}`,
    warning: "Geste de la DIRECTION — part ensuite en vérification de conformité (information médicale).",
    action: directionReview,
    extraFields: (input) => [["Commentaire", opStr(input, "note") || null]],
    extraArgs: (input) => ({ comment: opStr(input, "note") || null }),
    success: (pm) => `Matériel de ${pm.reference} examiné — en conformité.`,
  }),

  confirm_promo_conformity: promoStep({
    title: (pm) => `Conformité + visa publicitaire — ${pm.reference}`,
    warning: "Geste de l'INFORMATION MÉDICALE : conformité validée, références du visa consignées — le Marketing lance ensuite le BAT.",
    action: confirmConformity,
    extraFields: (input) => [["Référence du visa", opStr(input, "note") || null], ["Référence autorité", opStr(input, "message") || null]],
    extraArgs: (input) => ({ visaReference: opStr(input, "note") || null, authorityRef: opStr(input, "message") || null }),
    success: (pm) => `Visa publicitaire obtenu sur ${pm.reference}.`,
  }),

  start_promo_bat: promoStep({
    title: (pm) => `Lancer le BAT / l'impression — ${pm.reference}`,
    action: startBat,
    success: (pm) => `BAT / impression lancés sur ${pm.reference}.`,
  }),

  submit_promo_final: promoStep({
    title: (pm) => `Matériel final livré — ${pm.reference}`,
    warning: "La facture de l'agence est attendue ensuite (assistante).",
    action: submitFinalMaterial,
    success: (pm) => `Matériel final de ${pm.reference} déposé.`,
  }),

  record_promo_invoice: promoStep({
    title: (pm) => `Facture finale enregistrée — ${pm.reference}`,
    warning: "Les Finances règlent ensuite (dernière marche).",
    action: recordInvoice,
    success: (pm) => `Facture finale de ${pm.reference} enregistrée — au règlement des Finances.`,
  }),

  settle_promo: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      return {
        title: `Règlement final — ${pm.reference}`,
        fields: fieldsOf([
          ["Dossier", `${pm.reference} — ${pm.title}`],
          ["Montant du règlement", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : "montant retenu du dossier (défaut)"],
        ]),
        warnings: [
          "Geste des FINANCES, en DEUX temps (§118.148) : sans ordre de règlement, il le CRÉE — l'ordre part au centre de paiement et le dossier reste « facturé » ; une fois cet ordre RÉGLÉ, il CLÔT le dossier (la demande administrative liée passe « terminée »). Clore avant le paiement est refusé.",
        ],
        args: { id: pm.id, amount: opStr(input, "amount") || null },
        successMessage: `Règlement final de ${pm.reference} traité.`,
        revalidate: ["/promo-material", "/finances/paiements-a-faire"],
      };
    },
    // LA PHRASE DE L'ACTION, pas celle de la carte : le même geste crée l'ordre OU clôt le dossier,
    // et seule l'action sait lequel des deux a eu lieu — annoncer « réglé et clôturé » sur un ordre
    // qui vient de partir au centre serait le faux succès que ce geste existe pour éviter.
    async execute(args) {
      const f = new FormData();
      f.set("id", args.id ?? "");
      if (args.amount) f.set("amount", args.amount);
      const r = await settle(f);
      if (!r.ok) return { ok: false, error: r.error ?? "Le règlement a été refusé." };
      return { ok: true, message: r.message ?? "Dossier réglé et clôturé.", revalidate: ["/promo-material", "/finances/paiements-a-faire"] };
    },
  },

  comment_promo: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le commentaire (champ « message »)." };
      return {
        title: `Commenter ${pm.reference}`,
        fields: [{ label: "Dossier", value: `${pm.reference} — ${pm.title}` }, { label: "Commentaire", value: body }],
        args: { promoId: pm.id, body },
        successMessage: `Commentaire posé sur ${pm.reference}.`,
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(addPromoComment, args, "Le commentaire a été refusé.", { revalidate: ["/promo-material"] }),
  },

  cancel_promo: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      // LE MOTIF EST EXIGÉ PAR L'ACTION DEPUIS LE LOT C4a (§118.189) : la carte ne l'envoyait pas, et chaque
      // annulation confirmée était refusée APRÈS le clic (§118.83). Elle le demande donc AVANT la carte.
      const motif = opStr(input, "note");
      if (!motif) return { error: "Donnez le motif de l'annulation (champ « note ») — l'annulation est définitive, et le motif va au fil du dossier." };
      return {
        title: `ANNULER le dossier ${pm.reference}`,
        fields: [{ label: "Dossier", value: `${pm.reference} — ${pm.title}` }, { label: "Motif", value: motif }],
        // Ce que l'action FAIT, pas ce qu'on aurait aimé qu'elle fasse (vague « restes ») : une demande au
        // secrétariat dont le paiement est réglé reste ouverte, un ordre réglé reste réglé.
        warnings: [
          "Le dossier passe ANNULÉ (définitif). Ses demandes encore ouvertes au secrétariat sont annulées avec lui, sauf celle dont le paiement est déjà réglé, qui reste ouverte ; un ordre qui attendait le centre de paiement est annulé, un ordre réglé reste réglé.",
          "Refusé si un bon de commande a été généré pour ce dossier, ou s'il est déjà clos.",
        ],
        args: { id: pm.id, motif },
        successMessage: `Dossier ${pm.reference} annulé.`,
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(cancelPromoMaterial, args, "L'annulation a été refusée.", { revalidate: ["/promo-material"] }),
  },

  start_promo_circuit: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      // LA BASCULE SUR LE CIRCUIT 2 (§118.152). La carte d'avant promettait « devis en main : la
      // demande est sautée » — l'action ne lit plus ce champ : un devis en main se remet à
      // l'assistante et se retranscrit comme les autres. Une carte qui annonce un effet que le clic
      // ne produira pas est une fausse promesse (§118.83).
      return {
        title: `Basculer sur le nouveau circuit — ${pm.reference}`,
        fields: [{ label: "Dossier", value: `${pm.reference} — ${pm.title}` }],
        warnings: [
          "Refusé si le circuit est déjà lancé. Le validateur de la demande est figé maintenant : la directrice marketing pour un membre du marketing, sinon le N+1 (jamais au-delà du directeur des opérations).",
          "Les devis se demandent ensuite au secrétariat et se retranscrivent ligne à ligne ; un devis déjà en main se remet à l'assistante.",
        ],
        args: { id: pm.id },
        successMessage: `${pm.reference} basculé sur le nouveau circuit.`,
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(startPromoCircuit, args, "La bascule sur le nouveau circuit a été refusée.", { revalidate: ["/promo-material"] }),
  },

  mark_promo_quote_received: promoStep({
    title: (pm) => `Devis reçu — ${pm.reference}`,
    warning: "Exige qu'un devis soit DÉPOSÉ dans les documents du dossier (confirmer sans pièce est refusé) — la validation du demandeur s'ouvre.",
    action: markQuoteReceived,
    success: (pm) => `Devis de ${pm.reference} enregistré — au demandeur de valider.`,
  }),

  complete_promo_track: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const pm = await resolvePromo(user, opStr(input, "reference") || opStr(input, "label"));
      if ("error" in pm) return pm;
      const m = matchLabel(opStr(input, "track") || opStr(input, "label"), PROMO_TRACK_FR);
      if (typeof m === "object") return m;
      return {
        title: `Clore le chantier « ${PROMO_TRACK_FR.find(([c]) => c === m)?.[1]} » — ${pm.reference}`,
        fields: [
          { label: "Dossier", value: `${pm.reference} — ${pm.title}` },
          { label: "Chantier", value: PROMO_TRACK_FR.find(([c]) => c === m)?.[1] ?? m },
        ],
        warnings: ["Les trois chantiers avancent en parallèle — le dossier n'est TERMINÉ que lorsque le dernier est clos."],
        args: { id: pm.id, track: m },
        successMessage: `Chantier « ${PROMO_TRACK_FR.find(([c]) => c === m)?.[1]} » clos sur ${pm.reference}.`,
        revalidate: ["/promo-material"],
      };
    },
    execute: (args) => runFd(completePromoTrack, args, "La clôture du chantier a été refusée.", { revalidate: ["/promo-material"] }),
  },
};

