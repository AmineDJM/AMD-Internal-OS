import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber, formatCurrency } from "@/lib/utils";
import { getRiskThresholds, type RiskThresholds } from "./risk-settings";
import { kamsQuiCouvrent } from "@/lib/queries/panel-kam";
import { lienRapportTerrain } from "@/lib/chemins/rapports-terrain";
import { lienOrdreAPayer } from "@/lib/chemins/finances";
import { lienCibleEnveloppe, ancreCategorieBudget } from "@/lib/chemins/budgets";
import { DETECTEURS_PLUS } from "./risks-plus";
import { categoriesGouvernees, consommationIntegree, contextesDesCategories } from "@/lib/queries/budget-integration";

/**
 * Adventum Brain — moteur Risk Radar. **Lecture seule, calculé à la volée** (aucune
 * table de risque). Chaque détecteur interroge des données RÉELLES et produit des
 * « Risk Cards » : niveau, objet, impact, responsable, cause probable, preuves,
 * action recommandée (réutilisant les mécanismes existants : Tâche, Notification).
 */

export type RiskLevel = "critical" | "high" | "medium" | "low";

/** Action proposée par l'Autopilot — exécutée seulement après confirmation. */
export type AutopilotPayload =
  | { kind: "task"; title: string; assigneeId?: string | null; priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; module?: string }
  | { kind: "notify"; role?: UserRole; userId?: string | null; title: string; body: string; link?: string };

export interface RiskAction {
  label: string;
  icon?: string;
  /** Présent → ouvre la confirmation Autopilot. */
  payload?: AutopilotPayload;
  /** Présent → simple lien d'ouverture (pas d'action). */
  href?: string;
}

export interface Risk {
  id: string;
  level: RiskLevel;
  category: string; // clé de filtre : REGULATORY | PCH | BUDGET | EVENTS | MEDICAL | CONGRESS | SPONSORING | FINANCE | QUALITY | DOCUMENTS | VALIDATION | DIRECTIVES
  module: string; // libellé lisible
  title: string;
  object: string;
  impact: string;
  owner: string;
  deadline: string | null;
  ageDays: number | null;
  probableCause: string;
  recommendation: string;
  evidence: string[];
  href: string | null;
  actions: RiskAction[];
  /** Date pertinente pour le fil (détection ≈ date du signal). */
  at: string;
}

const LEVEL_RANK: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const DAY = 86_400_000;
const daysSince = (d: Date | null | undefined): number | null => (d ? Math.floor((Date.now() - d.getTime()) / DAY) : null);
const daysUntil = (d: Date | null | undefined): number | null => (d ? Math.ceil((d.getTime() - Date.now()) / DAY) : null);

// Quelques responsables types (résolus une fois, réutilisés par les détecteurs).
async function firstActive(role: UserRole): Promise<{ id: string; name: string } | null> {
  return prisma.user.findFirst({ where: { role, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

// ───────────────────────────── Détecteurs ─────────────────────────────

async function pchCautionRisks(th: RiskThresholds): Promise<Risk[]> {
  const tenders = await prisma.pchTender.findMany({
    where: { status: { not: "COMPLETED" }, cautionEnd: { not: null } },
    select: { id: true, reference: true, supplier: true, cautionEnd: true, cautionDeposited: true, cautionAmount: true },
  });
  const finance = await firstActive("FINANCE_BUDGET_MANAGER");
  const out: Risk[] = [];
  for (const t of tenders) {
    const left = daysUntil(t.cautionEnd);
    if (left === null || left > th.pchCautionWarnDays) continue;
    const level: RiskLevel = left <= 0 ? "critical" : left <= 7 ? "critical" : left <= 15 ? "high" : "medium";
    out.push({
      id: `pch-caution-${t.id}`, level, category: "PCH", module: "PCH — Marchés",
      title: left <= 0 ? "Caution PCH expirée" : "Caution PCH proche de l'expiration",
      object: t.reference, impact: "Risque administratif / financier (marché exposé).",
      owner: "Finance", deadline: t.cautionEnd?.toISOString() ?? null, ageDays: null,
      probableCause: "Aucune action de renouvellement créée.",
      recommendation: `Renouveler ou récupérer la caution ${t.reference} avant le ${t.cautionEnd?.toLocaleDateString("fr-FR")}.`,
      evidence: [
        `Échéance caution : ${t.cautionEnd?.toLocaleDateString("fr-FR")} (${left <= 0 ? "dépassée" : `dans ${left} j`})`,
        `Caution déposée : ${t.cautionDeposited ? "oui" : "non"}`,
        t.cautionAmount ? `Montant : ${formatCurrency(toNumber(t.cautionAmount))}` : "Montant non renseigné",
        t.supplier ? `Fournisseur : ${t.supplier}` : "Fournisseur non renseigné",
      ],
      href: `/pch/${t.id}`, at: new Date().toISOString(),
      actions: [
        { label: "Créer tâche Finance", icon: "ListChecks", payload: { kind: "task", title: `Renouveler/récupérer la caution ${t.reference} avant le ${t.cautionEnd?.toLocaleDateString("fr-FR")}`, assigneeId: finance?.id, priority: level === "critical" ? "CRITICAL" : "HIGH", module: "PCH" } },
        { label: "Notifier Direction", icon: "Bell", payload: { kind: "notify", role: "DIRECTION", title: "Caution PCH à renouveler", body: `${t.reference} — échéance ${t.cautionEnd?.toLocaleDateString("fr-FR")}`, link: `/pch/${t.id}` } },
        { label: "Ouvrir PCH", icon: "ExternalLink", href: `/pch/${t.id}` },
      ],
    });
  }
  return out;
}

type CongressRow = { id: string; name: string; requestStatus: string; updatedAt: Date; productManagerId: string | null; requesterId: string | null };
async function congressLikeRisks(th: RiskThresholds): Promise<Risk[]> {
  const [intl, natl] = await Promise.all([
    prisma.congressInternational.findMany({ where: { requestStatus: { in: ["PRELIMINARY_APPROVED", "AWAITING_FINAL"] } }, select: { id: true, name: true, requestStatus: true, updatedAt: true, productManagerId: true, requesterId: true } }),
    prisma.congressNational.findMany({ where: { requestStatus: { in: ["PRELIMINARY_APPROVED", "AWAITING_FINAL"] } }, select: { id: true, name: true, requestStatus: true, updatedAt: true, productManagerId: true, requesterId: true } }),
  ]);
  const rows: (CongressRow & { kind: "ci" | "cn" })[] = [
    ...intl.map((c) => ({ ...c, kind: "ci" as const })),
    ...natl.map((c) => ({ ...c, kind: "cn" as const })),
  ];
  const out: Risk[] = [];
  for (const c of rows) {
    const age = daysSince(c.updatedAt) ?? 0;
    if (age < th.congressStaleDays) continue; // délai normal ~3 j
    const awaitingPm = c.requestStatus === "PRELIMINARY_APPROVED";
    const level: RiskLevel = age >= 10 ? "critical" : age >= 6 ? "high" : "medium";
    const path = c.kind === "ci" ? "/congress-international" : "/congress-national";
    out.push({
      id: `congress-${c.kind}-${c.id}`, level, category: "CONGRESS", module: c.kind === "ci" ? "Prise en charge Internationale" : "Prise en charge Nationale",
      title: "Congrès bloqué", object: c.name,
      impact: "Validation définitive impossible ; logistique non lancée ; risque de hausse des prix billets/hôtels.",
      owner: awaitingPm ? "Direction Marketing" : "Direction", deadline: null, ageDays: age,
      probableCause: awaitingPm ? "Analyse de la Direction Marketing non soumise." : "Validation définitive de la Direction en attente.",
      recommendation: awaitingPm ? "Relancer la Direction Marketing aujourd'hui." : "Trancher la validation définitive.",
      evidence: [
        `Statut : ${awaitingPm ? "analyse Direction Marketing" : "validation définitive"}`,
        `Sans évolution depuis ${age} j (délai normal ~3 j)`,
        awaitingPm ? (c.productManagerId ? "Référent Direction Marketing nommé, aucun budget arbitré" : "Aucun budget arbitré par Direction Marketing") : "Arbitrage soumis, décision en attente",
      ],
      href: `${path}/${c.id}`, at: c.updatedAt.toISOString(),
      actions: [
        awaitingPm && c.productManagerId
          ? { label: "Relancer Direction Marketing", icon: "Bell", payload: { kind: "notify", userId: c.productManagerId, title: "Analyse de congrès en attente", body: `${c.name} — bloqué depuis ${age} j`, link: `${path}/${c.id}` } }
          : { label: "Notifier Direction", icon: "Bell", payload: { kind: "notify", role: "DIRECTION", title: "Congrès en attente de décision", body: `${c.name} — depuis ${age} j`, link: `${path}/${c.id}` } },
        { label: "Créer une relance", icon: "ListChecks", payload: { kind: "task", title: `Débloquer le congrès « ${c.name} » (en attente depuis ${age} j)`, assigneeId: c.productManagerId, priority: level === "critical" ? "CRITICAL" : "HIGH", module: "Congrès" } },
        { label: "Ouvrir dossier", icon: "ExternalLink", href: `${path}/${c.id}` },
      ],
    });
  }
  return out;
}

/**
 * QUI UN SPONSORING ATTEND — lu sur son CIRCUIT, pas sur son statut projeté (§118.151).
 *
 * Le statut hérité ne suffit pas : `PRELIMINARY_APPROVED` couvre DEUX étapes (la porte du DG et la
 * Direction des opérations), et `AWAITING_FINAL` n'est plus la décision définitive de la Direction
 * — c'est la pré-validation de la TENUE par la Direction Marketing. La carte disait « Rendre la
 * décision définitive » à la Direction pour une demande qui attendait la Direction Marketing : une
 * relance envoyée à la mauvaise personne, et la bonne jamais prévenue. L'étape COURANTE de l'instance
 * dit où la demande attend ; sans instance lisible, on retombe sur le statut, en le disant moins
 * précisément plutôt qu'en nommant quelqu'un au hasard.
 */
export interface AttenteSponsoring { owner: string; cause: string; recommendation: string; role: UserRole }

export function attenteSponsoring(statut: string, etapeCourante: string | null | undefined): AttenteSponsoring {
  if (statut === "AWAITING_FINAL_APPEAL") {
    return { owner: "Direction", cause: "Décision définitive sur l'appel du demandeur en attente.", recommendation: "Rendre la décision sur l'appel.", role: "DIRECTION" };
  }
  if (etapeCourante === "dg") {
    return { owner: "Directeur Général", cause: "Validation du Directeur Général en attente (montant au-dessus du seuil).", recommendation: "Relancer le Directeur Général.", role: "GENERAL_MANAGER" };
  }
  if (etapeCourante === "final") {
    return { owner: "Direction des opérations", cause: "Validation de la Direction des opérations en attente.", recommendation: "Relancer la Direction des opérations.", role: "DIRECTION" };
  }
  if (etapeCourante === "marketing" || statut === "AWAITING_FINAL") {
    return { owner: "Direction Marketing", cause: "Pré-validation de la tenue par la Direction Marketing en attente.", recommendation: "Relancer la Direction Marketing.", role: "PRODUCT_MANAGER" };
  }
  return { owner: "Circuit de validation", cause: "Étape de validation intermédiaire en attente (Directeur Général ou Direction des opérations).", recommendation: "Ouvrir la demande et relancer le valideur de l'étape en cours.", role: "DIRECTION" };
}

async function sponsoringRisks(th: RiskThresholds): Promise<Risk[]> {
  const rows = await prisma.sponsoringRequest.findMany({
    where: { status: { in: ["PRELIMINARY_APPROVED", "AWAITING_FINAL", "AWAITING_FINAL_APPEAL"] } },
    select: { id: true, reference: true, institution: true, status: true, updatedAt: true, productManagerId: true },
  });
  // Une lecture pour toutes les demandes, pas une par demande (§118.102b).
  const instances = rows.length
    ? await prisma.workflowInstance.findMany({
      where: { entityType: "SPONSORING", entityId: { in: rows.map((r) => r.id) } },
      select: { entityId: true, currentSlug: true },
    })
    : [];
  const etape = new Map(instances.map((i) => [i.entityId, i.currentSlug]));
  const out: Risk[] = [];
  for (const s of rows) {
    const age = daysSince(s.updatedAt) ?? 0;
    if (age < th.sponsoringStaleDays) continue;
    const attente = attenteSponsoring(s.status, etape.get(s.id));
    const level: RiskLevel = age >= 10 ? "high" : "medium";
    // Le référent de la gamme est prévenu NOMMÉMENT quand c'est la Direction Marketing qu'on attend ;
    // sinon, le rôle qui tient l'étape.
    const cibleNommee = attente.role === "PRODUCT_MANAGER" && s.productManagerId ? s.productManagerId : null;
    out.push({
      id: `spo-${s.id}`, level, category: "SPONSORING", module: "Sponsoring",
      title: "Sponsoring bloqué", object: `${s.reference} — ${s.institution}`,
      impact: "Décision retardée ; engagement vis-à-vis de l'institution en suspens.",
      owner: attente.owner, deadline: null, ageDays: age,
      probableCause: attente.cause,
      recommendation: attente.recommendation,
      evidence: [`En attente : ${attente.owner}`, `Sans évolution depuis ${age} j`],
      href: `/sponsoring/${s.id}`, at: s.updatedAt.toISOString(),
      actions: [
        cibleNommee
          ? { label: `Relancer ${attente.owner}`, icon: "Bell", payload: { kind: "notify", userId: cibleNommee, title: "Sponsoring en attente de votre pré-validation", body: `${s.reference} — depuis ${age} j`, link: `/sponsoring/${s.id}` } }
          : { label: `Relancer ${attente.owner}`, icon: "Bell", payload: { kind: "notify", role: attente.role, title: "Sponsoring en attente de validation", body: `${s.reference} — depuis ${age} j`, link: `/sponsoring/${s.id}` } },
        { label: "Ouvrir dossier", icon: "ExternalLink", href: `/sponsoring/${s.id}` },
      ],
    });
  }
  return out;
}

/**
 * QUI SUIT UN MÉDECIN STRATÉGIQUE — son délégué rattaché, ou les KAM dont le SECTEUR le couvre
 * (§118.179). L'alerte disait « Aucun délégué assigné » et prévenait la Promotion médicale pour
 * tout KOL sans `delegateId` — y compris celui d'un CHU qu'un secteur entier couvre : le panel du
 * KAM a UNE définition, et l'alerte la lit au lieu d'en garder une seconde.
 *
 * Plusieurs KAM le couvrent → l'alerte nomme CHACUN (une relance par personne) : en choisir un
 * déciderait à la place d'un humain qui doit y aller (§118.34).
 */
export function suiviDuKol(
  d: { delegateId: string | null; delegate: { name: string } | null },
  couvrants: readonly { id: string; name: string }[],
): { owner: string; preuve: string; destinataires: { id: string; name: string }[] } {
  if (d.delegateId) {
    const nom = d.delegate?.name ?? "Délégué";
    return { owner: nom, preuve: `Délégué : ${nom}`, destinataires: [{ id: d.delegateId, name: nom }] };
  }
  if (couvrants.length > 0) {
    const noms = couvrants.map((k) => k.name).join(", ");
    return { owner: noms, preuve: `Couvert par son secteur : ${noms}`, destinataires: [...couvrants] };
  }
  return { owner: "Délégué", preuve: "Aucun délégué rattaché, et aucun secteur ne couvre son établissement", destinataires: [] };
}

async function medicalKolRisks(th: RiskThresholds): Promise<Risk[]> {
  const doctors = await prisma.medicalDoctor.findMany({
    where: { influenceLevel: { in: ["KEY_OPINION_LEADER", "HIGH"] } },
    select: { id: true, name: true, title: true, specialty: true, targetProducts: true, lastVisit: true, delegateId: true, delegate: { select: { name: true } } },
    // LES PLUS EN RETARD D'ABORD : la liste est bornée, et une borne sans ordre rendait « 200
    // médecins quelconques » — un KOL jamais vu pouvait tomber hors de la fenêtre (§118.60).
    orderBy: [{ lastVisit: { sort: "asc", nulls: "first" } }, { id: "asc" }],
    take: 200,
  });
  const enRetard = doctors.filter((d) => {
    const age = daysSince(d.lastVisit);
    return !(age !== null && age < th.kolVisitStaleDays); // visité récemment → pas un risque
  });
  const couvrants = await kamsQuiCouvrent(enRetard.filter((d) => !d.delegateId).map((d) => d.id));
  const out: Risk[] = [];
  for (const d of enRetard) {
    const age = daysSince(d.lastVisit);
    const level: RiskLevel = age === null || age >= 90 ? "high" : "medium";
    const since = age === null ? "jamais enregistrée" : `il y a ${age} j`;
    const suivi = suiviDuKol(d, couvrants.get(d.id) ?? []);
    const relances: RiskAction[] = suivi.destinataires.length > 0
      ? suivi.destinataires.slice(0, 3).map((k) => ({
          label: `Message à ${k.name}`, icon: "Bell",
          payload: { kind: "notify", userId: k.id, title: "Médecin KOL à visiter", body: `${d.name} — non visité ${since}`, link: `/praticiens/${d.id}` },
        }))
      : [{ label: "Notifier Promotion médicale", icon: "Bell", payload: { kind: "notify", role: "MEDICAL_PROMOTION_MANAGER", title: "Médecin KOL sans délégué ni secteur", body: d.name, link: `/praticiens/${d.id}` } }];
    out.push({
      id: `kol-${d.id}`, level, category: "MEDICAL", module: "Promotion médicale",
      title: "Médecin stratégique non visité", object: `${d.title ? d.title + " " : ""}${d.name}`,
      impact: "Perte d'engagement et risque concurrentiel.",
      owner: suivi.owner, deadline: null, ageDays: age,
      probableCause: "Aucune visite récente planifiée.",
      recommendation: "Planifier une visite cette semaine.",
      evidence: [
        d.specialty ? `Spécialité : ${d.specialty}` : "Spécialité non renseignée",
        `Dernière visite : ${since}`,
        d.targetProducts ? `Produits liés : ${d.targetProducts}` : "Produits non renseignés",
        suivi.preuve,
      ],
      href: `/praticiens/${d.id}`, at: (d.lastVisit ?? new Date(0)).toISOString(),
      actions: [
        ...relances,
        // La tâche va à UNE personne quand une seule le suit ; sinon à personne (on ne choisit pas).
        { label: "Créer tâche visite", icon: "ListChecks", payload: { kind: "task", title: `Planifier une visite : ${d.name} (KOL non visité ${since})`, assigneeId: suivi.destinataires.length === 1 ? suivi.destinataires[0].id : null, priority: "HIGH", module: "Promotion médicale" } },
        { label: "Voir médecin", icon: "ExternalLink", href: `/praticiens/${d.id}` },
      ],
    });
  }
  return out.slice(0, 12);
}

async function expenseOrderRisks(th: RiskThresholds): Promise<Risk[]> {
  const orders = await prisma.expenseOrder.findMany({ where: { status: "PENDING" }, select: { id: true, reference: true, label: true, amount: true, createdAt: true, dueDate: true } });
  const finance = await firstActive("FINANCE_BUDGET_MANAGER");
  const out: Risk[] = [];
  for (const o of orders) {
    const age = daysSince(o.createdAt) ?? 0;
    if (age < th.expenseStaleDays) continue;
    const level: RiskLevel = age >= 21 ? "high" : "medium";
    out.push({
      id: `od-${o.id}`, level, category: "FINANCE", module: "Espace comptable",
      title: "Ordre de dépense non réglé", object: `${o.reference} — ${o.label}`,
      impact: "Règlement en retard ; relation fournisseur/bénéficiaire exposée.",
      owner: "Comptable", deadline: o.dueDate?.toISOString() ?? null, ageDays: age,
      probableCause: "Aucun règlement effectué depuis l'émission.",
      recommendation: "Régler ou demander une révision de budget.",
      evidence: [`Montant : ${formatCurrency(toNumber(o.amount))}`, `Émis il y a ${age} j`, o.dueDate ? `Échéance : ${o.dueDate.toLocaleDateString("fr-FR")}` : "Pas d'échéance"],
      href: lienOrdreAPayer(o.id), at: o.createdAt.toISOString(),
      actions: [
        { label: "Notifier comptable", icon: "Bell", payload: { kind: "notify", userId: finance?.id, role: finance ? undefined : "FINANCE_BUDGET_MANAGER", title: "Ordre de dépense à régler", body: `${o.reference} — ${formatCurrency(toNumber(o.amount))}`, link: lienOrdreAPayer(o.id) } },
        { label: "Ouvrir", icon: "ExternalLink", href: lienOrdreAPayer(o.id) },
      ],
    });
  }
  return out;
}

async function budgetRisks(th: RiskThresholds): Promise<Risk[]> {
  const envelope = await prisma.budgetEnvelope.findFirst({ where: { isActive: true }, orderBy: { periodStart: "desc" }, select: { id: true } });
  if (!envelope) return [];
  const lines = await prisma.budgetCategoryLine.findMany({ where: { envelopeId: envelope.id }, select: { id: true, name: true, allocated: true } });
  // UNE lecture groupée pour toutes les lignes (elle en faisait une par ligne).
  const sums = lines.length
    ? await prisma.financeTransaction.groupBy({ by: ["budgetCategoryId"], where: { budgetCategoryId: { in: lines.map((l) => l.id) }, direction: "OUT" }, _sum: { amount: true } })
    : [];
  // L'INTÉGRATION DES DÉPENSES RÉELLES (Ad & Pro 2026) : une enveloppe dont un lot est validé se lit par la règle du lot
  // (`budget/integration-regle.ts`) — ses agrégats rapides sont remplacés par les sources qui comptent et les postes historiques.
  const ctxs = await contextesDesCategories(lines.map((l) => l.id));
  const gouvernees = categoriesGouvernees(ctxs, lines.map((l) => l.id));
  const consumedBy = new Map(sums.filter((s) => !gouvernees.has(s.budgetCategoryId ?? "")).map((s) => [s.budgetCategoryId, toNumber(s._sum.amount ?? 0)]));
  if (ctxs.length) {
    const integ = await consommationIntegree(ctxs, lines.map((l) => l.id));
    for (const e of integ.ecritures) consumedBy.set(e.budgetCategoryId, (consumedBy.get(e.budgetCategoryId) ?? 0) + toNumber(e.amount as Parameters<typeof toNumber>[0]));
    for (const [cat, m] of integ.historiqueParCategorie) consumedBy.set(cat, (consumedBy.get(cat) ?? 0) + m);
  }
  const out: Risk[] = [];
  for (const l of lines) {
    const allocated = toNumber(l.allocated);
    if (allocated <= 0) continue;
    const consumed = consumedBy.get(l.id) ?? 0;
    const ratio = consumed / allocated;
    if (ratio < th.budgetWarnPct / 100) continue;
    const level: RiskLevel = ratio >= 1 ? "critical" : ratio >= 0.95 ? "high" : "medium";
    const lienBudget = lienCibleEnveloppe("/budgets", envelope.id, ancreCategorieBudget(l.id));
    out.push({
      id: `budget-${l.id}`, level, category: "BUDGET", module: "Budgets",
      title: ratio >= 1 ? "Budget dépassé" : "Budget à surveiller", object: l.name,
      impact: "Risque de dépassement budgétaire.",
      owner: "Direction / Finance", deadline: null, ageDays: null,
      probableCause: "Consommation élevée des dépenses attribuées.",
      recommendation: ratio >= 1 ? "Arbitrer : réallouer ou geler les engagements." : "Surveiller et anticiper les prochains engagements.",
      evidence: [`Consommé : ${formatCurrency(consumed)} / ${formatCurrency(allocated)} (${Math.round(ratio * 100)} %)`],
      // L'enveloppe ET la catégorie visée : la notification arrive sur sa barre, pas en tête d'un écran de budget.
      href: lienBudget, at: new Date().toISOString(),
      actions: [
        { label: "Notifier Direction", icon: "Bell", payload: { kind: "notify", role: "DIRECTION", title: "Alerte budget", body: `${l.name} consommé à ${Math.round(ratio * 100)} %`, link: lienBudget } },
        { label: "Ouvrir budgets", icon: "ExternalLink", href: lienBudget },
      ],
    });
  }
  return out;
}

async function medicalInfoRisks(th: RiskThresholds): Promise<Risk[]> {
  const decls = await prisma.medicalInfoDeclaration.findMany({ where: { status: { in: ["AWAITING_REVIEW", "DOCS_REQUESTED"] } }, select: { id: true, reference: true, label: true, updatedAt: true, pharmacistId: true } });
  const out: Risk[] = [];
  for (const d of decls) {
    const age = daysSince(d.updatedAt) ?? 0;
    if (age < th.medicalInfoStaleDays) continue;
    out.push({
      id: `mi-${d.id}`, level: age >= 14 ? "high" : "medium", category: "REGULATORY", module: "Information médicale",
      title: "Déclaration réglementaire en attente", object: `${d.reference} — ${d.label}`,
      impact: "Ordre de dépense bloqué tant que le pharmacien n'a pas validé.",
      owner: "Pharmacien information médicale", deadline: null, ageDays: age,
      probableCause: "Déclaration aux autorités / validation non finalisée.",
      recommendation: "Relancer le pharmacien responsable.",
      evidence: [`Sans évolution depuis ${age} j`],
      href: `/information-medicale/${d.id}`, at: d.updatedAt.toISOString(),
      actions: [
        { label: "Relancer pharmacien", icon: "Bell", payload: { kind: "notify", userId: d.pharmacistId, role: d.pharmacistId ? undefined : "MEDICAL_INFO_PHARMACIST", title: "Déclaration en attente", body: `${d.reference} — depuis ${age} j`, link: `/information-medicale/${d.id}` } },
        { label: "Ouvrir", icon: "ExternalLink", href: `/information-medicale/${d.id}` },
      ],
    });
  }
  return out;
}

async function directiveRisks(): Promise<Risk[]> {
  const dirs = await prisma.directive.findMany({ where: { status: { notIn: ["DONE", "ARCHIVED"] }, dueDate: { lt: new Date() } }, select: { id: true, reference: true, title: true, dueDate: true, targetUserId: true, targetRole: true } });
  return dirs.map((d) => ({
    id: `dir-${d.id}`, level: "medium" as RiskLevel, category: "DIRECTIVES", module: "Directives",
    title: "Directive en retard", object: `${d.reference} — ${d.title}`,
    impact: "Instruction de la Direction non traitée dans les délais.",
    owner: d.targetRole ?? "Destinataire", deadline: d.dueDate?.toISOString() ?? null, ageDays: daysSince(d.dueDate),
    probableCause: "Échéance dépassée sans clôture.",
    recommendation: "Relancer le destinataire.",
    evidence: [`Échéance dépassée : ${d.dueDate?.toLocaleDateString("fr-FR")}`],
    href: `/directives/${d.id}`, at: (d.dueDate ?? new Date()).toISOString(),
    actions: [
      { label: "Relancer", icon: "Bell", payload: d.targetUserId ? { kind: "notify", userId: d.targetUserId, title: "Directive en retard", body: d.title, link: `/directives/${d.id}` } : { kind: "notify", role: d.targetRole ?? "DIRECTION", title: "Directive en retard", body: d.title, link: `/directives/${d.id}` } },
      { label: "Ouvrir", icon: "ExternalLink", href: `/directives/${d.id}` },
    ],
  }));
}

async function silentSupplierRisks(th: RiskThresholds): Promise<Risk[]> {
  const cutoff = new Date(Date.now() - th.silentSupplierDays * DAY);
  const prods = await prisma.regulatoryProduct.findMany({
    where: { portalVisible: true, supplierId: { not: null }, status: { notIn: ["CLOSED", "DECISION_OBTAINED"] }, OR: [{ externalUpdatedAt: null }, { externalUpdatedAt: { lt: cutoff } }] },
    select: { id: true, dci: true, reference: true, externalUpdatedAt: true, supplier: { select: { name: true } } },
    take: 50,
  });
  return prods.map((p) => {
    const age = daysSince(p.externalUpdatedAt);
    return {
      id: `supplier-${p.id}`, level: (age !== null && age >= 30 ? "high" : "medium") as RiskLevel, category: "REGULATORY", module: "Regulatory",
      title: "Fournisseur silencieux", object: `${p.reference} — ${p.dci}`,
      impact: "Dossier Regulatory ralenti faute de retour fournisseur.",
      owner: p.supplier?.name ?? "Fournisseur", deadline: null, ageDays: age,
      probableCause: "Aucune mise à jour du fournisseur sur le portail.",
      recommendation: "Relancer le fournisseur via le portail.",
      evidence: [p.supplier?.name ? `Fournisseur : ${p.supplier.name}` : "Fournisseur lié", age === null ? "Aucune mise à jour externe" : `Dernière mise à jour il y a ${age} j`],
      href: `/regulatory/${p.id}`, at: (p.externalUpdatedAt ?? new Date(0)).toISOString(),
      actions: [{ label: "Ouvrir le dossier", icon: "ExternalLink", href: `/regulatory/${p.id}` }],
    };
  });
}

async function qualitySignalRisks(): Promise<Risk[]> {
  const cutoff = new Date(Date.now() - 30 * DAY);
  const reports = await prisma.fieldReport.findMany({
    where: { qualitySignal: { not: null }, createdAt: { gte: cutoff } },
    select: { id: true, qualitySignal: true, doctorName: true, products: true, createdAt: true, delegate: { select: { name: true } } },
    orderBy: { createdAt: "desc" }, take: 30,
  });
  return reports.filter((r) => (r.qualitySignal ?? "").trim().length > 0).map((r) => ({
    id: `quality-${r.id}`, level: "high" as RiskLevel, category: "QUALITY", module: "Rapports terrain",
    title: "Signal qualité / pharmacovigilance", object: r.products?.slice(0, 60) || "Signalement terrain",
    impact: "Sujet qualité/PV à tracer (confirmation renforcée requise).",
    owner: r.delegate?.name ?? "Délégué", deadline: null, ageDays: daysSince(r.createdAt),
    probableCause: "Signalement remonté du terrain, à instruire.",
    recommendation: "Instruire le signalement et confirmer avec le responsable qualité.",
    evidence: [`Signal : ${(r.qualitySignal ?? "").slice(0, 160)}`, r.doctorName ? `Médecin : ${r.doctorName}` : "", r.delegate?.name ? `Remonté par : ${r.delegate.name}` : ""].filter(Boolean),
    href: lienRapportTerrain(r.id), at: r.createdAt.toISOString(),
    actions: [
      { label: "Créer tâche de suivi", icon: "ListChecks", payload: { kind: "task", title: `Instruire signalement qualité/PV (${r.products?.slice(0, 40) || "terrain"})`, priority: "HIGH", module: "Qualité" } },
      { label: "Ouvrir le rapport", icon: "ExternalLink", href: lienRapportTerrain(r.id) },
    ],
  }));
}

// Stocks PCH bas / rupture. Source principale : les états de stock datés du module
// Stocks (dernier état par produit à la PCH). Les anciens mouvements entrées/sorties
// restent pris en compte pour les produits sans état enregistré (transition).
type StockRow = { product: string; net: bigint | number | null; lastdate: Date | null };
async function pchStockRisks(th: RiskThresholds): Promise<Risk[]> {
  const [rows, snaps] = await Promise.all([
    prisma.$queryRaw<StockRow[]>`
    SELECT product, SUM(net) AS net, MAX(lastdate) AS lastdate
    FROM (
      SELECT product,
             SUM(CASE WHEN direction='IN' THEN quantity WHEN direction='OUT' THEN -quantity ELSE 0 END) AS net,
             MAX(date) AS lastdate
      FROM "StockMovement"
      WHERE location = 'PCH'
      GROUP BY product
      UNION ALL
      SELECT product, SUM(quantity) AS net, MAX(date) AS lastdate
      FROM "StockOpeningLevel"
      WHERE location = 'PCH'
      GROUP BY product
    ) s
    GROUP BY product`,
    prisma.stockSnapshot.findMany({
      where: { scope: "PCH" },
      orderBy: { date: "desc" },
      include: { product: { select: { brandName: true, dci: true } } },
    }),
  ]);
  // Dernier état par produit (le plus récent d'abord) ; il prime sur l'estimation par mouvements.
  const latest = new Map<string, { product: string; net: number; lastdate: Date }>();
  for (const s of snaps) {
    if (latest.has(s.productId)) continue;
    latest.set(s.productId, { product: s.product.brandName?.trim() || s.product.dci, net: s.quantity, lastdate: s.date });
  }
  const snapNames = new Set([...latest.values()].map((v) => v.product.toLowerCase()));
  const merged = [
    ...latest.values(),
    ...rows
      .map((r) => ({ product: r.product, net: typeof r.net === "bigint" ? Number(r.net) : Number(r.net ?? 0), lastdate: r.lastdate }))
      .filter((r) => !snapNames.has(r.product.toLowerCase())),
  ];
  const logistics = await firstActive("LOGISTICS_MANAGER");
  const out: Risk[] = [];
  for (const r of merged) {
    const net = r.net;
    if (net > th.stockLowThreshold) continue;
    const rupture = net <= 0;
    out.push({
      id: `stock-${r.product}`, level: rupture ? "critical" : net <= th.stockLowThreshold / 2 ? "high" : "medium",
      category: "PCH", module: "Stocks PCH",
      title: rupture ? "Rupture de stock à la PCH" : "Stock PCH bas", object: r.product,
      impact: rupture ? "Produit indisponible à la PCH : ventes et engagements exposés." : "Risque de rupture imminente à la PCH.",
      owner: "Logistique", deadline: null, ageDays: null,
      probableCause: "Sorties supérieures aux réceptions ; réapprovisionnement non déclenché.",
      recommendation: rupture ? `Réapprovisionner ${r.product} en urgence.` : `Anticiper le réapprovisionnement de ${r.product}.`,
      evidence: [`Stock net estimé : ${net} unité·s`, `Seuil bas : ${th.stockLowThreshold}`, r.lastdate ? `Dernier relevé : ${new Date(r.lastdate).toLocaleDateString("fr-FR")}` : "Aucun relevé récent"],
      href: `/stocks`, at: new Date().toISOString(),
      actions: [
        { label: "Créer tâche réappro", icon: "ListChecks", payload: { kind: "task", title: `${rupture ? "Réapprovisionner d'urgence" : "Anticiper le réappro"} : ${r.product} (stock net ${net})`, assigneeId: logistics?.id, priority: rupture ? "CRITICAL" : "HIGH", module: "Stocks" } },
        { label: "Notifier Logistique", icon: "Bell", payload: { kind: "notify", userId: logistics?.id, role: logistics ? undefined : "LOGISTICS_MANAGER", title: rupture ? "Rupture PCH" : "Stock PCH bas", body: `${r.product} — stock net ${net}`, link: `/stocks` } },
        { label: "Ouvrir stocks", icon: "ExternalLink", href: `/stocks` },
      ],
    });
  }
  return out;
}

// Retards de livraison : commandes logistiques dont l'arrivée estimée est dépassée
// (au-delà de la tolérance) sans livraison, ou bloquées en douane / transit.
async function deliveryDelayRisks(th: RiskThresholds): Promise<Risk[]> {
  const grace = new Date(Date.now() - th.deliveryGraceDays * DAY);
  const orders = await prisma.logisticsOrder.findMany({
    where: {
      status: { notIn: ["DELIVERED"] },
      OR: [{ estimatedArrival: { lt: grace }, pchDeliveryDate: null }, { status: "BLOCKED" }],
    },
    select: { id: true, reference: true, product: true, supplier: true, status: true, estimatedArrival: true, ownerId: true },
    take: 100,
  });
  const logistics = await firstActive("LOGISTICS_MANAGER");
  return orders.map((o) => {
    const late = daysSince(o.estimatedArrival);
    const blocked = o.status === "BLOCKED";
    return {
      id: `delivery-${o.id}`, level: (blocked || (late ?? 0) >= 14 ? "high" : "medium") as RiskLevel,
      category: "PCH", module: "Logistique",
      title: blocked ? "Livraison bloquée" : "Retard de livraison", object: `${o.reference} — ${o.product}`,
      impact: "Retard d'approvisionnement ; risque de rupture en aval (PCH).",
      owner: "Logistique", deadline: o.estimatedArrival?.toISOString() ?? null, ageDays: late,
      probableCause: blocked ? "Commande marquée bloquée (douane / transit)." : "Arrivée estimée dépassée sans livraison enregistrée.",
      recommendation: "Relancer le transitaire / fournisseur et mettre à jour le statut.",
      evidence: [
        `Statut : ${o.status}`,
        o.estimatedArrival ? `Arrivée estimée : ${o.estimatedArrival.toLocaleDateString("fr-FR")}${late !== null && late > 0 ? ` (retard ${late} j)` : ""}` : "Arrivée estimée non renseignée",
        o.supplier ? `Fournisseur : ${o.supplier}` : "Fournisseur non renseigné",
      ],
      href: `/logistics/${o.id}`, at: (o.estimatedArrival ?? new Date()).toISOString(),
      actions: [
        { label: "Créer relance", icon: "ListChecks", payload: { kind: "task", title: `Débloquer la livraison ${o.reference} (${blocked ? "bloquée" : `retard ${late ?? "?"} j`})`, assigneeId: o.ownerId ?? logistics?.id, priority: "HIGH", module: "Logistique" } },
        { label: "Notifier Logistique", icon: "Bell", payload: { kind: "notify", userId: o.ownerId ?? logistics?.id, role: o.ownerId || logistics ? undefined : "LOGISTICS_MANAGER", title: blocked ? "Livraison bloquée" : "Retard de livraison", body: `${o.reference} — ${o.product}`, link: `/logistics/${o.id}` } },
        { label: "Ouvrir", icon: "ExternalLink", href: `/logistics/${o.id}` },
      ],
    };
  });
}

// Événements à faible présence : événements à venir (sous l'horizon) avec trop peu
// d'inscrits confirmés.
async function lowAttendanceEventRisks(th: RiskThresholds): Promise<Risk[]> {
  const horizon = new Date(Date.now() + th.eventHorizonDays * DAY);
  const events = await prisma.event.findMany({
    where: {
      status: { in: ["VALIDATED", "PREPARATION", "REGISTRATION_OPEN"] },
      startDate: { gte: new Date(), lte: horizon },
    },
    select: { id: true, name: true, startDate: true, capacity: true, responsibleId: true, _count: { select: { registrations: { where: { status: { in: ["REGISTERED", "CONFIRMED", "PRESENT"] } } } } } },
    take: 100,
  });
  const out: Risk[] = [];
  for (const e of events) {
    const count = e._count.registrations;
    if (count >= th.eventMinAttendance) continue;
    const left = daysUntil(e.startDate);
    out.push({
      id: `event-att-${e.id}`, level: (left !== null && left <= 2 ? "high" : "medium") as RiskLevel,
      category: "EVENTS", module: "Events",
      title: "Événement à faible présence", object: e.name,
      impact: "Risque d'événement sous-rempli (ROI faible, image).",
      owner: "Responsable événement", deadline: e.startDate?.toISOString() ?? null, ageDays: null,
      probableCause: "Peu d'inscriptions confirmées à l'approche de la date.",
      recommendation: "Relancer les invitations / élargir la cible cette semaine.",
      evidence: [
        `${count} inscrit·s confirmé·s (seuil ${th.eventMinAttendance})`,
        e.capacity ? `Capacité : ${e.capacity}` : "Capacité non renseignée",
        e.startDate ? `Dans ${left} j (${e.startDate.toLocaleDateString("fr-FR")})` : "Date non renseignée",
      ],
      href: `/events/${e.id}`, at: new Date().toISOString(),
      actions: [
        { label: "Créer tâche relance", icon: "ListChecks", payload: { kind: "task", title: `Booster les inscriptions : ${e.name} (${count} inscrits)`, assigneeId: e.responsibleId, priority: "HIGH", module: "Events" } },
        e.responsibleId
          ? { label: "Notifier responsable", icon: "Bell", payload: { kind: "notify", userId: e.responsibleId, title: "Événement à faible présence", body: `${e.name} — ${count} inscrits`, link: `/events/${e.id}` } }
          : { label: "Notifier Promotion médicale", icon: "Bell", payload: { kind: "notify", role: "MEDICAL_PROMOTION_MANAGER", title: "Événement à faible présence", body: `${e.name} — ${count} inscrits`, link: `/events/${e.id}` } },
        { label: "Ouvrir l'événement", icon: "ExternalLink", href: `/events/${e.id}` },
      ],
    });
  }
  return out;
}

// Demandes du Bureau du secrétariat en retard : échéance dépassée, ou sans action depuis
// longtemps. Module très sollicité — jusqu'ici absent du Risk Radar. (Suppressions douces exclues.)
async function adminRequestRisks(): Promise<Risk[]> {
  const now = new Date();
  const staleCutoff = new Date(Date.now() - 10 * DAY);
  const rows = await prisma.administrativeRequest.findMany({
    where: {
      status: { notIn: ["DONE", "CANCELLED"] },
      deletedAt: null,
      OR: [{ deadline: { lt: now } }, { updatedAt: { lt: staleCutoff } }],
    },
    select: { id: true, reference: true, title: true, updatedAt: true, deadline: true, assignedToId: true },
    take: 100,
  });
  const out: Risk[] = [];
  for (const a of rows) {
    const overdue = Boolean(a.deadline && a.deadline.getTime() < now.getTime());
    const age = daysSince(a.updatedAt) ?? 0;
    const level: RiskLevel = overdue || age >= 21 ? "high" : "medium";
    out.push({
      id: `adm-${a.id}`, level, category: "ADMIN", module: "Bureau du secrétariat",
      title: overdue ? "Demande du secrétariat en retard" : "Demande du secrétariat sans suite",
      object: `${a.reference} — ${a.title}`,
      impact: "Demande interne non traitée : agent bloqué en attente.",
      owner: "Secrétariat", deadline: a.deadline?.toISOString() ?? null, ageDays: age,
      probableCause: overdue ? "Échéance dépassée sans clôture." : `Aucune action depuis ${age} j.`,
      recommendation: "Traiter la demande ou informer le demandeur de l'avancement.",
      evidence: [
        a.deadline ? `Échéance : ${a.deadline.toLocaleDateString("fr-FR")}${overdue ? " (dépassée)" : ""}` : "Pas d'échéance",
        `Sans évolution depuis ${age} j`,
      ],
      href: `/demandes/${a.id}`, at: (a.deadline && overdue ? a.deadline : a.updatedAt).toISOString(),
      actions: [
        a.assignedToId
          ? { label: "Relancer le traitant", icon: "Bell", payload: { kind: "notify", userId: a.assignedToId, title: "Demande du secrétariat à traiter", body: `${a.reference} — ${overdue ? "en retard" : `depuis ${age} j`}`, link: `/demandes/${a.id}` } }
          : { label: "Créer une tâche de suivi", icon: "ListChecks", payload: { kind: "task", title: `Traiter la demande secrétariat « ${a.title} » (${overdue ? "en retard" : `${age} j`})`, priority: level === "high" ? "HIGH" : "MEDIUM", module: "Secrétariat" } },
        { label: "Ouvrir la demande", icon: "ExternalLink", href: `/demandes/${a.id}` },
      ],
    });
  }
  return out;
}

// FRICTION DE PROCESS (anti-bureaucratie) : détecte les étapes de validation Ad&Pro qui
// APPROUVENT À 100 % — elles ne filtrent rien et ne font que ralentir. Candidates à un seuil
// d'auto-skip (petits montants) ou à la suppression dans le builder no-code. + circuits en
// souffrance (bloqués longtemps à une étape). Source : WorkflowStepEvent / WorkflowInstance réels.
async function processFrictionRisks(): Promise<Risk[]> {
  const MIN_EVENTS = 8; // ne juger qu'une étape avec un historique suffisant
  const [approves, negatives, stuck] = await Promise.all([
    prisma.workflowStepEvent.groupBy({ by: ["stepSlug", "stepTitle"], where: { action: "APPROVE" }, _count: { _all: true } }),
    prisma.workflowStepEvent.groupBy({ by: ["stepSlug"], where: { action: { in: ["REJECT", "OPINION_AGAINST"] } }, _count: { _all: true } }),
    prisma.workflowInstance.count({ where: { status: "IN_PROGRESS", updatedAt: { lt: new Date(Date.now() - 12 * DAY) } } }),
  ]);
  const negBySlug = new Map(negatives.map((n) => [n.stepSlug, n._count._all]));
  const out: Risk[] = [];
  for (const a of approves) {
    const approveCount = a._count._all;
    const negCount = negBySlug.get(a.stepSlug) ?? 0;
    if (approveCount < MIN_EVENTS || negCount > 0) continue; // filtre au moins une fois → utile
    out.push({
      id: `friction-step-${a.stepSlug}`, level: "low", category: "VALIDATION", module: "Adventum Brain — Process",
      title: "Étape de validation qui ne filtre rien", object: a.stepTitle,
      impact: "Bureaucratie : une étape approuvée à 100 % ralentit le circuit sans jamais rien bloquer.",
      owner: "Super Admin / Direction", deadline: null, ageDays: null,
      probableCause: `L'étape « ${a.stepTitle} » a été approuvée ${approveCount} fois, jamais refusée ni contestée.`,
      recommendation: "Poser un seuil de montant qui l'auto-saute pour les petits enjeux, ou la retirer du circuit (builder no-code). Un saut manuel tracé reste possible à tout moment.",
      evidence: [`Approuvée ${approveCount} fois`, "0 refus / avis défavorable", "Aucun filtrage observé sur l'historique"],
      href: "/admin/workflows", at: new Date().toISOString(),
      actions: [{ label: "Ouvrir le builder de circuits", icon: "ExternalLink", href: "/admin/workflows" }],
    });
  }
  // Signal global : nombre de circuits Ad&Pro en souffrance (bloqués > 12 j à une étape).
  if (stuck >= 3) {
    out.push({
      id: "friction-stuck-instances", level: stuck >= 8 ? "high" : "medium", category: "VALIDATION", module: "Adventum Brain — Process",
      title: "Files de validation en souffrance", object: `${stuck} demande·s bloquée·s`,
      impact: "Plusieurs demandes Ad&Pro stagnent à une étape : effet goulot / lassitude, contournement de l'outil.",
      owner: "Direction", deadline: null, ageDays: null,
      probableCause: "Approbateurs surchargés ou étapes trop nombreuses.",
      recommendation: "Alléger le circuit (auto-skip par seuil, suppression d'étapes), ou relancer les approbateurs goulots.",
      evidence: [`${stuck} circuits Ad&Pro sans évolution depuis plus de 12 j`],
      href: "/admin/workflows", at: new Date().toISOString(),
      actions: [{ label: "Ouvrir le builder de circuits", icon: "ExternalLink", href: "/admin/workflows" }],
    });
  }
  return out;
}

const DETECTORS: ((th: RiskThresholds) => Promise<Risk[]>)[] = [
  pchCautionRisks, congressLikeRisks, sponsoringRisks, medicalKolRisks, expenseOrderRisks,
  budgetRisks, medicalInfoRisks, directiveRisks, silentSupplierRisks, qualitySignalRisks,
  pchStockRisks, deliveryDelayRisks, lowAttendanceEventRisks, adminRequestRisks, processFrictionRisks,
  ...DETECTEURS_PLUS,
];

/** Le nombre de détecteurs — affiché sous le titre du cockpit. */
export const DETECTOR_COUNT = DETECTORS.length;

/** Calcule tous les risques (détecteurs en parallèle, tolérants aux pannes), triés par gravité.
 *  Les seuils de déclenchement sont ceux réglés par le Super Admin. */
export async function getRisks(): Promise<Risk[]> {
  const th = await getRiskThresholds();
  const results = await Promise.all(DETECTORS.map((d) => d(th).catch((e) => { console.error("[brain] detector failed", e); return [] as Risk[]; })));
  return results.flat().sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
}
