import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { entityHref } from "@/lib/entity-href";
import { CATEGORY_LABELS, CATEGORY_PATH, isWorkflowCategory } from "@/lib/workflow/types";
import {
  ADMIN_REQUEST_STATUS, LOGISTICS_STATUS, MEDICAL_INFO_STATUS, MODULE_LABELS, PROMO_MATERIAL_STATUS,
} from "@/lib/labels";
import {
  analyzeCircuit, median, responseTimesByActor, segmentsOf, DAY_MS,
  type CircuitStats, type EventKind, type MiningCase, type MiningEvent,
} from "@/lib/process/mining";
import { sansBloquer } from "@/lib/journal";

/**
 * PROCESS INTELLIGENCE — les LECTURES (refonte 07/10). Le calcul est dans `lib/process/mining.ts` (pur, testé) ;
 * ici, on lit les journaux qui existent déjà et on les met à la forme d'un dossier (`MiningCase`) :
 *
 *   • les circuits Ad & Pro (moteur de workflow) — `WorkflowStepEvent` ;
 *   • les validations — `ValidationStep` (demandé → décidé), niveau par niveau ;
 *   • les demandes de paiement — `PaymentRequestEvent` ;
 *   • les demandes d'achat — `PurchaseRequestLogEntry` ;
 *   • le recrutement — `RecruitmentApproval` (la chaîne de validation) ;
 *   • à défaut de journal propre (matériel promotionnel, information médicale, secrétariat, logistique) : les
 *     changements de statut de l'`AuditLog` (ancien → nouveau).
 *
 * Réservé au Super Admin (les pages sont gardées par `requireModule("PROCESS_INTELLIGENCE")`).
 */

export type Periode = "30j" | "90j" | "12m";
export const PERIODES: { cle: Periode; label: string; jours: number }[] = [
  { cle: "30j", label: "30 jours", jours: 30 },
  { cle: "90j", label: "90 jours", jours: 90 },
  { cle: "12m", label: "12 mois", jours: 365 },
];
export function periodeDe(p: string | null | undefined): { cle: Periode; label: string; jours: number } {
  return PERIODES.find((x) => x.cle === p) ?? PERIODES[1];
}

/** Bloqué par défaut au-delà de ce nombre de jours à une étape sans délai fixé. */
export const STUCK_DAYS_DEFAULT = 14;

// ───────────────────────────── Les dossiers, par source ─────────────────────────────

interface Source { label: string; cases: MiningCase[] }

const WF_KIND: Record<string, EventKind> = {
  CREATE: "start",
  APPROVE: "advance", AUTO_SKIP: "advance", SKIP: "advance", AUTO_APPROVE_REQUESTER: "advance", OPINION_AGAINST: "advance",
  RETURN: "return", RESUBMIT: "resubmit", REJECT: "reject", CANCEL: "end",
};

async function workflowCases(since: Date): Promise<Map<string, Source>> {
  const instances = await prisma.workflowInstance.findMany({
    where: { OR: [{ status: { in: ["IN_PROGRESS", "RETURNED"] } }, { updatedAt: { gte: since } }] },
    select: {
      id: true, entityType: true, entityId: true, category: true, status: true, currentSlug: true, createdAt: true, updatedAt: true,
      definition: { select: { name: true, steps: { select: { slug: true, title: true } } } },
      events: { orderBy: { createdAt: "asc" }, select: { stepSlug: true, stepTitle: true, action: true, actorName: true, note: true, createdAt: true } },
    },
  });
  const ids = (t: string) => instances.filter((i) => i.entityType === t).map((i) => i.entityId);
  const [spo, ci, cn, evts] = await Promise.all([
    prisma.sponsoringRequest.findMany({ where: { id: { in: ids("SPONSORING") } }, select: { id: true, reference: true, institution: true } }),
    prisma.congressInternational.findMany({ where: { id: { in: ids("CONGRESS_INTERNATIONAL") } }, select: { id: true, name: true } }),
    prisma.congressNational.findMany({ where: { id: { in: ids("CONGRESS_NATIONAL") } }, select: { id: true, name: true } }),
    prisma.event.findMany({ where: { id: { in: ids("EVENT") } }, select: { id: true, name: true } }),
  ]);
  const noms = new Map<string, string>([
    ...spo.map((s) => [s.id, `${s.reference} — ${s.institution}`] as [string, string]),
    ...ci.map((c) => [c.id, c.name] as [string, string]),
    ...cn.map((c) => [c.id, c.name] as [string, string]),
    ...evts.map((e) => [e.id, e.name] as [string, string]),
  ]);

  const out = new Map<string, Source>();
  for (const i of instances) {
    const key = `WF:${i.category}`;
    const label = isWorkflowCategory(i.category) ? CATEGORY_LABELS[i.category] : i.definition.name;
    const titres = new Map(i.definition.steps.map((s) => [s.slug, s.title]));
    const termine = ["APPROVED", "REJECTED", "CANCELLED"].includes(i.status);
    const events: MiningEvent[] = i.events.map((e) => ({
      at: e.createdAt, step: e.stepSlug, stepLabel: e.stepTitle || titres.get(e.stepSlug) || e.stepSlug,
      kind: WF_KIND[e.action] ?? "other", actor: e.actorName, note: e.note,
    }));
    // La décision qui clôt est la dernière avancée d'un circuit terminé.
    const fin = termine ? (i.events[i.events.length - 1]?.createdAt ?? i.updatedAt) : null;
    const href = isWorkflowCategory(i.category) ? `${CATEGORY_PATH[i.category]}/${i.entityId}` : entityHref(i.entityType, i.entityId);
    const src = out.get(key) ?? { label, cases: [] };
    src.cases.push({
      id: i.id, circuit: key, label: noms.get(i.entityId) ?? label, href,
      startedAt: i.createdAt, endedAt: fin,
      currentStep: termine ? null : i.currentSlug, currentStepLabel: i.currentSlug ? titres.get(i.currentSlug) ?? i.currentSlug : null,
      events,
    });
    out.set(key, src);
  }
  return out;
}

async function validationCases(since: Date): Promise<Map<string, Source>> {
  const reqs = await prisma.validationRequest.findMany({
    where: { OR: [{ status: { in: ["PENDING", "CHANGES_REQUESTED"] } }, { updatedAt: { gte: since } }] },
    select: {
      id: true, reference: true, title: true, module: true, status: true, link: true, mode: true, createdAt: true, decidedAt: true, updatedAt: true,
      steps: { orderBy: { order: "asc" }, select: { order: true, status: true, decidedAt: true, reason: true, validator: { select: { name: true } } } },
    },
  });
  const out = new Map<string, Source>();
  for (const r of reqs) {
    const key = `VAL:${r.module}`;
    const termine = ["APPROVED", "REJECTED", "CANCELLED"].includes(r.status);
    const events: MiningEvent[] = [];
    if (r.mode === "SEQUENTIAL") {
      for (const s of r.steps) {
        if (!s.decidedAt) continue;
        const kind: EventKind = s.status === "APPROVED" ? "advance" : s.status === "REJECTED" ? "reject" : s.status === "CHANGES_REQUESTED" ? "return" : "other";
        events.push({ at: s.decidedAt, step: `n${s.order}`, stepLabel: `Niveau ${s.order}`, kind, actor: s.validator?.name ?? null, note: s.reason });
      }
    } else {
      // En parallèle, chacun décide sur la même attente : on ne garde que la dernière décision.
      const decides = r.steps.filter((s) => s.decidedAt).sort((a, b) => a.decidedAt!.getTime() - b.decidedAt!.getTime());
      const last = decides[decides.length - 1];
      if (last) events.push({ at: last.decidedAt!, step: "parallele", stepLabel: "Validateurs (en parallèle)", kind: termine ? "advance" : "other", actor: last.validator?.name ?? null, note: last.reason });
    }
    const courant = r.steps.find((s) => s.status === "PENDING");
    const src = out.get(key) ?? { label: `Validation · ${r.module}`, cases: [] };
    src.cases.push({
      id: r.id, circuit: key, label: `${r.reference} — ${r.title}`, href: r.link || `/validations/${r.id}`,
      startedAt: r.createdAt, endedAt: termine ? r.decidedAt ?? r.updatedAt : null,
      currentStep: r.mode === "SEQUENTIAL" ? (courant ? `n${courant.order}` : null) : "parallele",
      currentStepLabel: r.mode === "SEQUENTIAL" ? (courant ? `Niveau ${courant.order}` : null) : "Validateurs (en parallèle)",
      events,
    });
    out.set(key, src);
  }
  return out;
}

async function paymentCases(since: Date): Promise<Source> {
  const reqs = await prisma.paymentRequest.findMany({
    where: { OR: [{ status: { in: ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED"] } }, { updatedAt: { gte: since } }] },
    select: { id: true, reference: true, title: true, status: true, createdAt: true, events: { orderBy: { at: "asc" }, select: { kind: true, message: true, at: true, actorId: true } } },
  });
  const acteurs = await nomsDe(reqs.flatMap((r) => r.events.map((e) => e.actorId)));
  const cases: MiningCase[] = [];
  for (const r of reqs) {
    if (r.status === "DRAFT") continue;
    const events: MiningEvent[] = [];
    let soumis = false;
    let renvoye = false;
    let suspendu = false;
    for (const e of r.events) {
      const actor = e.actorId ? acteurs.get(e.actorId) ?? null : null;
      const base = { at: e.at, actor, note: e.message };
      switch (e.kind) {
        case "SUBMIT":
          events.push({ ...base, step: "examen", stepLabel: "Examen aux Finances", kind: soumis && renvoye ? "resubmit" : "start" });
          soumis = true; renvoye = false;
          break;
        case "HOLD": events.push({ ...base, step: "examen", stepLabel: "Examen aux Finances", kind: "advance" }); suspendu = true; break;
        case "RESUME": events.push({ ...base, step: "attente", stepLabel: "Mise en attente", kind: "advance" }); suspendu = false; break;
        case "CHANGES": events.push({ ...base, step: "examen", stepLabel: "Examen aux Finances", kind: "return" }); renvoye = true; break;
        case "APPROVE": events.push({ ...base, step: "examen", stepLabel: "Examen aux Finances", kind: "end" }); break;
        case "REJECT": events.push({ ...base, step: "examen", stepLabel: "Examen aux Finances", kind: "reject" }); break;
        default: events.push({ ...base, step: "examen", kind: "other" });
      }
    }
    const fin = ["APPROVED", "REJECTED", "CANCELLED"].includes(r.status)
      ? [...r.events].reverse().find((e) => ["APPROVE", "REJECT"].includes(e.kind))?.at ?? null
      : null;
    if (["APPROVED", "REJECTED", "CANCELLED"].includes(r.status) && !fin) continue; // clos sans trace de décision : illisible
    cases.push({
      id: r.id, circuit: "PAY", label: `${r.reference} — ${r.title}`, href: `/validations/paiements/${r.id}`,
      startedAt: r.events.find((e) => e.kind === "SUBMIT")?.at ?? r.createdAt, endedAt: fin,
      currentStep: suspendu ? "attente" : "examen", currentStepLabel: suspendu ? "Mise en attente" : "Examen aux Finances",
      events,
    });
  }
  return { label: "Demande de paiement", cases };
}

async function purchaseCases(since: Date): Promise<Source> {
  const lignes = await prisma.purchaseRequestLogEntry.findMany({
    where: { createdAt: { gte: new Date(since.getTime() - 365 * DAY_MS) } },
    orderBy: { createdAt: "asc" },
    select: { requestId: true, reference: true, title: true, event: true, actorName: true, note: true, createdAt: true },
  });
  const parDemande = new Map<string, typeof lignes>();
  for (const l of lignes) parDemande.set(l.requestId, [...(parDemande.get(l.requestId) ?? []), l]);
  const cases: MiningCase[] = [];
  for (const [id, ls] of parDemande) {
    const depot = ls.find((l) => l.event === "SUBMITTED");
    if (!depot) continue;
    const derniere = ls[ls.length - 1];
    const fin = ["APPROVED", "REJECTED", "WITHDRAWN"].includes(derniere.event) ? derniere.createdAt : null;
    const events: MiningEvent[] = ls.map((l) => ({
      at: l.createdAt, step: "validation", stepLabel: "Validation de l'achat", actor: l.actorName, note: l.note,
      kind: l.event === "SUBMITTED" ? "start" : l.event === "APPROVED" ? "end" : l.event === "REJECTED" ? "reject" : l.event === "WITHDRAWN" ? "end" : "other",
    }));
    cases.push({
      id, circuit: "ACHAT", label: `${depot.reference} — ${depot.title}`, href: `/demandes/${id}`,
      startedAt: depot.createdAt, endedAt: fin, currentStep: "validation", currentStepLabel: "Validation de l'achat", events,
    });
  }
  return { label: "Demande d'achat", cases };
}

async function recruitmentCases(since: Date): Promise<Source> {
  const reqs = await prisma.recruitmentRequest.findMany({
    where: { OR: [{ stage: { in: ["CHAIN", "HR_REVIEW", "INFO_REQUESTED", "RETURNED"] } }, { updatedAt: { gte: since } }] },
    select: {
      id: true, reference: true, position: true, stage: true, createdAt: true, closedAt: true, returnedAt: true, returnNote: true,
      approvals: { orderBy: { order: "asc" }, select: { order: true, status: true, decidedAt: true, reason: true, approver: { select: { name: true } } } },
    },
  });
  const cases: MiningCase[] = [];
  for (const r of reqs) {
    const events: MiningEvent[] = [];
    for (const a of r.approvals) {
      if (!a.decidedAt) continue;
      events.push({
        at: a.decidedAt, step: `n${a.order}`, stepLabel: `Validation niveau ${a.order}`,
        kind: a.status === "APPROVED" ? "advance" : a.status === "REJECTED" ? "reject" : "other",
        actor: a.approver?.name ?? null, note: a.reason,
      });
    }
    if (r.returnedAt) events.push({ at: r.returnedAt, step: "rh", stepLabel: "Revue RH", kind: "return", note: r.returnNote });
    const enChaine = ["CHAIN", "HR_REVIEW", "INFO_REQUESTED", "RETURNED"].includes(r.stage);
    const derniere = [...r.approvals].reverse().find((a) => a.decidedAt)?.decidedAt ?? null;
    // Le circuit de VALIDATION finit quand la demande part au sourcing (ou se clôt) : la suite est un autre travail.
    const fin = enChaine ? null : ["REJECTED", "CANCELLED", "CLOSED"].includes(r.stage) ? r.closedAt ?? derniere : derniere;
    if (!enChaine && !fin) continue;
    const courant = r.approvals.find((a) => a.status === "PENDING");
    cases.push({
      id: r.id, circuit: "REC", label: `${r.reference} — ${r.position}`, href: `/recrutement/${r.id}`,
      startedAt: r.createdAt, endedAt: fin,
      currentStep: r.stage === "HR_REVIEW" ? "rh" : courant ? `n${courant.order}` : "rh",
      currentStepLabel: r.stage === "HR_REVIEW" ? "Revue RH" : courant ? `Validation niveau ${courant.order}` : "Revue RH",
      events,
    });
  }
  return { label: "Recrutement", cases };
}

/** Circuits sans journal propre : leurs changements de statut dans l'AuditLog. */
const AUDIT_CIRCUITS: { type: "PROMO_MATERIAL" | "MEDICAL_INFO_DECLARATION" | "ADMIN_REQUEST" | "LOGISTICS"; label: string; statuts: Record<string, { label: string }>; fins: string[]; refus: string[] }[] = [
  { type: "PROMO_MATERIAL", label: "Matériel promotionnel", statuts: PROMO_MATERIAL_STATUS, fins: ["SETTLED", "CANCELLED"], refus: ["CANCELLED"] },
  { type: "MEDICAL_INFO_DECLARATION", label: "Information médicale", statuts: MEDICAL_INFO_STATUS, fins: ["VALIDATED", "CANCELLED"], refus: ["CANCELLED"] },
  { type: "ADMIN_REQUEST", label: "Bureau du secrétariat", statuts: ADMIN_REQUEST_STATUS, fins: ["DONE", "CANCELLED"], refus: ["CANCELLED"] },
  { type: "LOGISTICS", label: "Logistique", statuts: LOGISTICS_STATUS, fins: ["DELIVERED", "CANCELLED"], refus: ["CANCELLED"] },
];

async function auditCases(since: Date): Promise<Map<string, Source>> {
  const debut = new Date(since.getTime() - 365 * DAY_MS);
  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: { in: AUDIT_CIRCUITS.map((c) => c.type) }, entityId: { not: null }, createdAt: { gte: debut },
      OR: [{ action: "CREATE" }, { field: { in: ["status", "stage", "requestStatus"] }, newValue: { not: null } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20_000,
    select: { entityType: true, entityId: true, action: true, field: true, oldValue: true, newValue: true, summary: true, createdAt: true, actor: { select: { name: true } } },
  });
  const parObjet = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.entityType}:${r.entityId}`;
    parObjet.set(k, [...(parObjet.get(k) ?? []), r]);
  }
  const out = new Map<string, Source>();
  for (const [k, rs] of parObjet) {
    const [type, id] = k.split(":");
    const def = AUDIT_CIRCUITS.find((c) => c.type === type);
    if (!def) continue;
    const changements = rs.filter((r) => r.field && r.newValue);
    if (changements.length === 0) continue;
    const creation = rs.find((r) => r.action === "CREATE");
    const lib = (s: string) => def.statuts[s]?.label ?? s;
    const events: MiningEvent[] = [];
    let precedent: string | null = null;
    for (const c of changements) {
      const quitte: string = c.oldValue ?? precedent ?? "__ouverture";
      const nouveau = c.newValue!;
      if (quitte === nouveau) continue;
      const fin = def.fins.includes(nouveau);
      events.push({
        at: c.createdAt, step: quitte, stepLabel: quitte === "__ouverture" ? "Ouverture" : lib(quitte),
        kind: fin ? (def.refus.includes(nouveau) ? "reject" : "end") : "advance",
        actor: c.actor?.name ?? null, note: c.summary,
      });
      precedent = nouveau;
    }
    if (events.length === 0) continue;
    const dernier = precedent!;
    const clos = def.fins.includes(dernier);
    const key = `AUD:${type}`;
    const src = out.get(key) ?? { label: def.label, cases: [] };
    src.cases.push({
      id, circuit: key, label: creation?.summary?.slice(0, 90) || `${def.label} ${id.slice(-6)}`, href: entityHref(type, id),
      startedAt: creation?.createdAt ?? changements[0].createdAt,
      endedAt: clos ? events[events.length - 1].at : null,
      currentStep: clos ? null : dernier, currentStepLabel: clos ? null : lib(dernier),
      events,
    });
    out.set(key, src);
  }
  return out;
}

async function nomsDe(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const uniques = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniques.length) return new Map();
  const us = await prisma.user.findMany({ where: { id: { in: uniques } }, select: { id: true, name: true } });
  return new Map(us.map((u) => [u.id, u.name]));
}

/** Tous les dossiers de tous les circuits, regroupés par circuit. Chaque source est tolérante aux pannes. */
export async function chargerCircuits(since: Date): Promise<Map<string, Source>> {
  const garde = <T>(p: Promise<T>, vide: T, nom: string) => p.catch((e) => { console.error(`[process] ${nom}`, e); return vide; });
  const [wf, val, pay, achat, rec, aud] = await Promise.all([
    garde(workflowCases(since), new Map<string, Source>(), "workflow"),
    garde(validationCases(since), new Map<string, Source>(), "validations"),
    garde(paymentCases(since), { label: "Demande de paiement", cases: [] }, "paiements"),
    garde(purchaseCases(since), { label: "Demande d'achat", cases: [] }, "achats"),
    garde(recruitmentCases(since), { label: "Recrutement", cases: [] }, "recrutement"),
    garde(auditCases(since), new Map<string, Source>(), "audit"),
  ]);
  const out = new Map<string, Source>([...wf, ...val, ...aud]);
  if (pay.cases.length) out.set("PAY", pay);
  if (achat.cases.length) out.set("ACHAT", achat);
  if (rec.cases.length) out.set("REC", rec);
  return out;
}

/** Les délais cibles par circuit → (étape → jours). */
export async function chargerSla(): Promise<Map<string, Map<string, number>>> {
  const rows = await prisma.processStepSla.findMany({ select: { circuit: true, stepKey: true, targetDays: true } }).catch(sansBloquer("process-intelligence.chargerSla.processStepSla", []));
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const m = out.get(r.circuit) ?? new Map<string, number>();
    m.set(r.stepKey, r.targetDays);
    out.set(r.circuit, m);
  }
  return out;
}

async function stuckDaysSetting(): Promise<number> {
  const r = await prisma.riskSetting.findUnique({ where: { id: "global" }, select: { processStuckDays: true } }).catch(sansBloquer("process-intelligence.stuckDaysSetting.riskSetting", null));
  return r?.processStuckDays ?? STUCK_DAYS_DEFAULT;
}

// ───────────────────────────── Vue « Circuits » ─────────────────────────────

export interface VueCircuits {
  circuits: CircuitStats[];
  stuckDays: number;
}

export async function getCircuitsView(periode: Periode, now: Date = new Date()): Promise<VueCircuits> {
  const since = new Date(now.getTime() - periodeDe(periode).jours * DAY_MS);
  const [sources, sla, stuckDays] = await Promise.all([chargerCircuits(since), chargerSla(), stuckDaysSetting()]);
  const circuits = [...sources.entries()]
    .map(([key, s]) => analyzeCircuit(key, s.label, s.cases, { now, since, sla: sla.get(key), stuckDays }))
    .filter((c) => c.cases > 0)
    .sort((a, b) => b.stuck.length - a.stuck.length || b.cases - a.cases);
  return { circuits, stuckDays };
}

/** Les dossiers au-delà du délai FIXÉ pour leur étape (pour le détecteur d'Adventum Brain). */
export async function dossiersHorsDelai(now: Date = new Date()): Promise<{ circuit: string; circuitLabel: string; item: CircuitStats["stuck"][number] }[]> {
  const sla = await chargerSla();
  if (sla.size === 0) return [];
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const sources = await chargerCircuits(since);
  const out: { circuit: string; circuitLabel: string; item: CircuitStats["stuck"][number] }[] = [];
  for (const [key, cible] of sla) {
    const s = sources.get(key);
    if (!s) continue;
    const st = analyzeCircuit(key, s.label, s.cases, { now, since, sla: cible, stuckDays: Number.MAX_SAFE_INTEGER });
    for (const item of st.stuck) if (item.sla) out.push({ circuit: key, circuitLabel: s.label, item });
  }
  return out;
}

// ───────────────────────────── Vue « Personnes » ─────────────────────────────

export interface LignePersonne {
  userId: string;
  name: string;
  department: string | null;
  received: number;
  medianResponseDays: number | null;
  pending: number;
  overdueTasks: number;
  lastSeenAt: string | null;
}

export async function getPeopleView(periode: Periode, now: Date = new Date()): Promise<LignePersonne[]> {
  const since = new Date(now.getTime() - periodeDe(periode).jours * DAY_MS);
  const [users, departments, recus, decides, enAttente, recAttente, retards, sources] = await Promise.all([
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, departmentId: true, lastSeenAt: true } }),
    prisma.department.findMany({ select: { id: true, name: true } }),
    prisma.validationStep.groupBy({ by: ["validatorId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.validationStep.findMany({
      where: { decidedAt: { gte: since } },
      select: { validatorId: true, order: true, createdAt: true, decidedAt: true, request: { select: { mode: true, steps: { select: { order: true, decidedAt: true } } } } },
    }),
    prisma.validationStep.groupBy({ by: ["validatorId"], where: { status: "PENDING" }, _count: { _all: true } }),
    prisma.recruitmentApproval.groupBy({ by: ["approverId"], where: { status: "PENDING" }, _count: { _all: true } }),
    prisma.task.groupBy({ by: ["assignedToId"], where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueDate: { lt: now } }, _count: { _all: true } }),
    chargerCircuits(since).catch(sansBloquer("process-intelligence.getPeopleView.chargerCircuits", new Map<string, Source>())),
  ]);

  // Réponses aux validations : de l'arrivée RÉELLE chez le valideur (après le niveau précédent) à sa décision.
  const reponses = new Map<string, number[]>();
  for (const s of decides) {
    let arrivee = s.createdAt;
    if (s.request.mode === "SEQUENTIAL") {
      const prec = s.request.steps.find((x) => x.order === s.order - 1)?.decidedAt;
      if (prec && prec > arrivee) arrivee = prec;
    }
    const d = Math.max(0, (s.decidedAt!.getTime() - arrivee.getTime()) / DAY_MS);
    reponses.set(s.validatorId, [...(reponses.get(s.validatorId) ?? []), d]);
  }
  // + les décisions des circuits Ad & Pro et du recrutement, lues par nom (le journal des circuits garde le nom).
  const parNom = new Map<string, number[]>();
  const tousCas = [...sources.values()].flatMap((s) => s.cases.filter((c) => !c.circuit.startsWith("VAL:")));
  for (const [nom, d] of responseTimesByActor(tousCas, since, now)) parNom.set(nom, d);

  const count = (rows: { _count: { _all: number } }[], key: string) => {
    const m = new Map<string, number>();
    for (const r of rows) { const id = (r as unknown as Record<string, string | null>)[key]; if (id) m.set(id, r._count._all); }
    return m;
  };
  const mRecus = count(recus, "validatorId");
  const mAttente = count(enAttente, "validatorId");
  const mRec = count(recAttente, "approverId");
  const mRetards = count(retards, "assignedToId");
  const dept = new Map(departments.map((d) => [d.id, d.name]));

  return users
    .map((u) => {
      const d = [...(reponses.get(u.id) ?? []), ...(parNom.get(u.name) ?? [])];
      return {
        userId: u.id, name: u.name, department: u.departmentId ? dept.get(u.departmentId) ?? null : null,
        received: (mRecus.get(u.id) ?? 0) + (parNom.get(u.name)?.length ?? 0),
        medianResponseDays: median(d),
        pending: (mAttente.get(u.id) ?? 0) + (mRec.get(u.id) ?? 0),
        overdueTasks: mRetards.get(u.id) ?? 0,
        lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
      };
    })
    .filter((r) => r.received > 0 || r.pending > 0 || r.overdueTasks > 0)
    .sort((a, b) => b.pending - a.pending || (b.medianResponseDays ?? 0) - (a.medianResponseDays ?? 0));
}

// ───────────────────────────── Vue « Plateforme » ─────────────────────────────

export interface LigneAdoption { module: string; label: string; vues: number; utilisateurs: number; tendance: number | null }
export interface LigneTache { id: string; nom: string; passages: number; echecs: number; derniereErreur: string | null; dureeMedianeMs: number | null; dernierPassage: string | null; statut: string }
export interface LigneIa { feature: string; appels: number; erreurs: number; latenceMedianeMs: number | null; coutUsd: number | null }
export interface VuePlateforme { adoption: LigneAdoption[]; taches: LigneTache[]; ia: LigneIa[] }

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : v === null || v === undefined ? 0 : Number(v));

export async function getPlatformView(periode: Periode, now: Date = new Date()): Promise<VuePlateforme> {
  const jours = periodeDe(periode).jours;
  const since = new Date(now.getTime() - jours * DAY_MS);
  const milieu = new Date(now.getTime() - (jours / 2) * DAY_MS);

  const [adoption, taches, ia, coutsAppels] = await Promise.all([
    prisma.$queryRaw<{ module: string | null; vues: bigint; utilisateurs: bigint; recentes: bigint }[]>`
      SELECT "module", COUNT(*) AS vues, COUNT(DISTINCT "userId") AS utilisateurs,
             SUM(CASE WHEN "createdAt" >= ${milieu} THEN 1 ELSE 0 END) AS recentes
      FROM "ActivityLog"
      WHERE "type" = 'PAGE_VIEW' AND "createdAt" >= ${since}
      GROUP BY "module"
      ORDER BY vues DESC
      LIMIT 60`.catch(sansBloquer("process-intelligence.getPlatformView", [])),
    prisma.$queryRaw<{ id: string; nom: string; statut: string; passages: bigint; echecs: bigint; mediane: number | null; dernier: Date | null; erreur: string | null }[]>`
      SELECT w."id", w."name" AS nom, w."status" AS statut, COUNT(r."id") AS passages,
             SUM(CASE WHEN r."status" = 'FAILED' THEN 1 ELSE 0 END) AS echecs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY r."ms") AS mediane,
             MAX(r."startedAt") AS dernier,
             (SELECT r2."error" FROM "WorkflowRun" r2 WHERE r2."workflowId" = w."id" AND r2."status" = 'FAILED' ORDER BY r2."startedAt" DESC LIMIT 1) AS erreur
      FROM "ScheduledWorkflow" w
      LEFT JOIN "WorkflowRun" r ON r."workflowId" = w."id" AND r."startedAt" >= ${since}
      GROUP BY w."id", w."name", w."status"
      ORDER BY echecs DESC, passages DESC`.catch(sansBloquer("process-intelligence.getPlatformView", [])),
    prisma.$queryRaw<{ feature: string; appels: bigint; erreurs: bigint; latence: number | null; cout: Prisma.Decimal | null; sanstarif: bigint }[]>`
      SELECT "feature", COUNT(*) AS appels, SUM(CASE WHEN "ok" THEN 0 ELSE 1 END) AS erreurs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs") AS latence,
             SUM("costUsd") AS cout, SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS sanstarif
      FROM "AiUsageLog"
      WHERE "createdAt" >= ${since}
      GROUP BY "feature"
      ORDER BY appels DESC`.catch(sansBloquer("process-intelligence.getPlatformView", [])),
    prisma.$queryRaw<{ feature: string | null; cout: Prisma.Decimal | null }[]>`
      SELECT "feature", SUM("costUsd") AS cout FROM "ModelCallLog" WHERE "at" >= ${since} GROUP BY "feature"`.catch(sansBloquer("process-intelligence.getPlatformView", [])),
  ]);

  const coutParAppels = new Map(coutsAppels.map((c) => [c.feature ?? "", c.cout === null ? null : Number(c.cout)]));
  const labelModule = (m: string | null) => (m && (MODULE_LABELS as Record<string, string>)[m]) || m || "Sans module";

  return {
    adoption: adoption.map((a) => {
      const vues = num(a.vues);
      const recentes = num(a.recentes);
      const anciennes = vues - recentes;
      return { module: a.module ?? "", label: labelModule(a.module), vues, utilisateurs: num(a.utilisateurs), tendance: anciennes > 0 ? (recentes - anciennes) / anciennes : null };
    }),
    taches: taches.map((t) => ({
      id: t.id, nom: t.nom, statut: t.statut, passages: num(t.passages), echecs: num(t.echecs), derniereErreur: t.erreur,
      dureeMedianeMs: t.mediane === null ? null : Math.round(Number(t.mediane)), dernierPassage: t.dernier ? new Date(t.dernier).toISOString() : null,
    })),
    ia: ia.map((x) => {
      // Le coût du tour quand il est connu en entier ; sinon celui du journal des appels de modèle.
      const parTour = num(x.sanstarif) === 0 && x.cout !== null ? Number(x.cout) : null;
      return {
        feature: x.feature, appels: num(x.appels), erreurs: num(x.erreurs),
        latenceMedianeMs: x.latence === null ? null : Math.round(Number(x.latence)),
        coutUsd: parTour ?? coutParAppels.get(x.feature) ?? null,
      };
    }),
  };
}

// ───────────────────────────── Pour l'instantané horaire ─────────────────────────────

/** Les compteurs de l'instantané horaire (Adventum Pulse) — lus sans recalcul de tous les circuits. */
export async function processPulseStats(now: Date = new Date()): Promise<{ inProgress: number; stuck: number; overdue: number; validationsPending: number }> {
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const [sources, sla, stuckDays, overdue, validationsPending] = await Promise.all([
    chargerCircuits(since),
    chargerSla(),
    stuckDaysSetting(),
    prisma.task.count({ where: { status: { in: ["TODO", "IN_PROGRESS"] }, dueDate: { lt: now } } }),
    // Un COMPTE, pas une liste bornée : la liste de 30 plafonnait le compteur à 30.
    prisma.validationStep.count({ where: { status: "PENDING" } }),
  ]);
  let inProgress = 0;
  let stuck = 0;
  for (const [key, s] of sources) {
    for (const c of s.cases) {
      if (c.endedAt) continue;
      inProgress++;
      const w = segmentsOf(c, now).waiting;
      if (w && w.days > (sla.get(key)?.get(w.step) ?? stuckDays)) stuck++;
    }
  }
  return { inProgress, stuck, overdue, validationsPending };
}
