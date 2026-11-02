import { prisma } from "@/lib/prisma";
import { ORDRE_NON_ANNULE } from "@/modules/finances/partage";
import type { CurrentUser } from "@/lib/session";
import { platformScope } from "@/lib/company";
import { toNumber, formatMontant } from "@/lib/utils";
import { FINISHED_REG_STATUSES } from "@/lib/regulatory/stage";

/**
 * LE MOTEUR DE PROACTIVITÉ du Chief of Staff — les DÉTECTEURS qui repèrent ce qui cloche AVANT
 * qu'on le demande : paiement en souffrance au centre, validation qui dort, tâche critique en
 * retard, facture jamais chaînée à un BC, BC sans facture, contrat qui expire, dossier Regulatory
 * sans activité, stock épuisé, demande de paiement sans décision.
 *
 * Trois règles :
 *   • chaque signal porte sa PREUVE (référence, date, lien) — jamais « quelque chose traîne » ;
 *   • la CRITICITÉ est calculée sur des seuils simples et DITS (l'âge en jours est dans le
 *     détail) — pas un score opaque ;
 *   • les requêtes sont BORNÉES : ce moteur tourne dans une conversation, pas dans un batch.
 */

export type AlertCriticality = "INFO" | "WATCH" | "IMPORTANT" | "CRITICAL";

export interface ExecutiveAlert {
  code: string;
  criticite: AlertCriticality;
  titre: string;
  detail: string;
  reference?: string | null;
  lien: string;
}

const DAY = 86_400_000;
const days = (from: Date, now: Date): number => Math.floor((now.getTime() - from.getTime()) / DAY);

const RANK: Record<AlertCriticality, number> = { CRITICAL: 0, IMPORTANT: 1, WATCH: 2, INFO: 3 };

/** Tous les signaux, triés du plus critique au plus doux. Requêtes parallèles et bornées. */
export async function detectExecutiveAlerts(user: CurrentUser, now: Date = new Date()): Promise<ExecutiveAlert[]> {
  const entity = await platformScope(user.id);
  const alerts: ExecutiveAlert[] = [];

  const [
    centreAwaiting, centreStalled, validationsStuck, tasksLate, invoicesUnchained,
    posWithoutInvoice, contractsExpiring, regStale, stockSnaps, paymentsUndecided,
    commitmentsOverdue, invoicesRecent, ordersUnpaid,
  ] = await Promise.all([
    // 1) Paiements EN ATTENTE au centre — chaque jour d'attente est un fournisseur qui patiente.
    prisma.expenseOrder.findMany({
      where: { AND: [entity, { centralStatus: "AWAITING", ...ORDRE_NON_ANNULE }] },
      select: { reference: true, label: true, amount: true, createdAt: true },
      orderBy: { createdAt: "asc" }, take: 15,
    }),
    // 2) Paiements où le centre a demandé une révision / une argumentation… restée sans suite.
    prisma.expenseOrder.findMany({
      where: { AND: [entity, { centralStatus: { in: ["CHANGES_REQUESTED", "INFO_REQUESTED"] }, ...ORDRE_NON_ANNULE, updatedAt: { lt: new Date(now.getTime() - 5 * DAY) } }] },
      select: { reference: true, label: true, centralStatus: true, updatedAt: true },
      orderBy: { updatedAt: "asc" }, take: 10,
    }),
    // 3) Validations qui dorment (aucune décision depuis > 5 jours).
    prisma.validationRequest.findMany({
      where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - 5 * DAY) } },
      select: {
        reference: true, title: true, createdAt: true,
        steps: { where: { status: "PENDING" }, select: { validator: { select: { name: true } } }, take: 3 },
      },
      orderBy: { createdAt: "asc" }, take: 10,
    }),
    // 4) Tâches importantes en retard.
    prisma.task.findMany({
      where: { status: { in: ["TODO", "IN_PROGRESS"] }, priority: { in: ["HIGH", "CRITICAL"] }, dueDate: { lt: now } },
      select: { title: true, priority: true, dueDate: true, assignedTo: { select: { name: true } } },
      orderBy: { dueDate: "asc" }, take: 10,
    }),
    // 5) Factures Legal jamais chaînées à un BC (déposées il y a > 3 jours).
    prisma.legalDocument.findMany({
      where: { AND: [entity, { kind: "INVOICE", chainFromId: null, createdAt: { lt: new Date(now.getTime() - 3 * DAY) } }] },
      select: { id: true, reference: true, title: true, createdAt: true },
      orderBy: { createdAt: "asc" }, take: 8,
    }),
    // 6) BC de plus de 30 jours sans facture chaînée.
    prisma.legalDocument.findMany({
      where: { AND: [entity, { kind: "PURCHASE_ORDER", createdAt: { lt: new Date(now.getTime() - 30 * DAY) }, chainNext: { none: { kind: "INVOICE" } } }] },
      select: { id: true, reference: true, title: true, createdAt: true },
      orderBy: { createdAt: "asc" }, take: 8,
    }),
    // 7) Contrats / engagements expirant sous 30 jours.
    prisma.legalDocument.findMany({
      where: { AND: [entity, { status: "ACTIVE", endDate: { gte: now, lt: new Date(now.getTime() + 30 * DAY) } }] },
      select: { id: true, reference: true, title: true, kind: true, endDate: true, counterparty: true },
      orderBy: { endDate: "asc" }, take: 10,
    }),
    // 8) Dossiers Regulatory sans AUCUNE activité depuis 60 jours (fiche jamais retouchée).
    prisma.regulatoryProduct.findMany({
      where: { status: { notIn: [...FINISHED_REG_STATUSES] }, updatedAt: { lt: new Date(now.getTime() - 60 * DAY) } },
      select: { id: true, reference: true, dci: true, brandName: true, status: true, updatedAt: true },
      orderBy: { updatedAt: "asc" }, take: 10,
    }),
    // 9) Derniers relevés de stock (pour repérer les niveaux épuisés / très bas).
    prisma.stockSnapshot.findMany({
      where: entity,
      select: { scope: true, annexId: true, date: true, quantity: true, product: { select: { id: true, brandName: true, dci: true } }, annex: { select: { name: true } } },
      orderBy: { date: "desc" }, take: 2000,
    }),
    // 10) Demandes de paiement soumises sans décision depuis > 5 jours.
    prisma.paymentRequest.findMany({
      where: { AND: [entity, { status: { in: ["SUBMITTED", "UNDER_REVIEW"] }, createdAt: { lt: new Date(now.getTime() - 5 * DAY) } }] },
      select: { id: true, reference: true, title: true, payee: true, amount: true, createdAt: true },
      orderBy: { createdAt: "asc" }, take: 10,
    }),
    // 11) ENGAGEMENTS suivis en retard — ceux de CETTE personne uniquement (registre personnel).
    //     Un retard se VOIT ici ; il ne déclenche JAMAIS de relance automatique.
    prisma.executiveCommitment.findMany({
      where: { ownerId: user.id, status: "OPEN", dueAt: { lt: now } },
      select: { who: true, what: true, toWhom: true, dueAt: true, relatedRef: true },
      orderBy: { dueAt: "asc" }, take: 10,
    }),
    // 12) ANOMALIE : factures candidates au DOUBLON — même contrepartie, même montant, à
    //     moins de 45 jours d'écart. Le backend DÉTECTE (règle simple et dite) ; conclure
    //     au doublon réel appartient au lecteur, pièce en main.
    prisma.legalDocument.findMany({
      where: { AND: [entity, { kind: "INVOICE", createdAt: { gte: new Date(now.getTime() - 180 * DAY) } }] },
      select: { id: true, reference: true, title: true, counterparty: true, amount: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: 200,
    }),
    // 13) ANOMALIE : règlement en attente d'un montant INHABITUEL pour son bénéficiaire
    //     (≥ 4× la médiane de son historique payé, avec au moins 3 paiements de référence).
    prisma.expenseOrder.findMany({
      where: { AND: [entity, { paidDate: null, status: { not: "CANCELLED" }, beneficiary: { not: null } }] },
      select: { reference: true, label: true, beneficiary: true, amount: true },
      orderBy: { createdAt: "desc" }, take: 12,
    }),
  ]);

  for (const o of centreAwaiting) {
    const age = days(o.createdAt, now);
    if (age < 3) continue;
    alerts.push({
      code: "payment_stuck",
      criticite: age >= 7 ? "CRITICAL" : "IMPORTANT",
      titre: `Paiement en attente au centre depuis ${age} j`,
      detail: `${o.reference} — ${o.label} (${Math.round(toNumber(o.amount)).toLocaleString("fr-FR")} DZD)`,
      reference: o.reference, lien: "/centre-de-paiement",
    });
  }
  for (const o of centreStalled) {
    alerts.push({
      code: "payment_revision_stalled",
      criticite: "WATCH",
      titre: o.centralStatus === "CHANGES_REQUESTED" ? "Révision demandée restée sans réponse" : "Argumentation demandée restée sans réponse",
      detail: `${o.reference} — ${o.label} (dernier mouvement il y a ${days(o.updatedAt, now)} j)`,
      reference: o.reference, lien: "/centre-de-paiement",
    });
  }
  for (const v of validationsStuck) {
    alerts.push({
      code: "approval_stuck",
      criticite: days(v.createdAt, now) >= 10 ? "IMPORTANT" : "WATCH",
      titre: `Validation en souffrance depuis ${days(v.createdAt, now)} j`,
      detail: `${v.reference} — ${v.title}${v.steps.length ? ` (attend : ${v.steps.map((s) => s.validator.name).join(", ")})` : ""}`,
      reference: v.reference, lien: "/validations",
    });
  }
  for (const t of tasksLate) {
    const age = t.dueDate ? days(t.dueDate, now) : 0;
    alerts.push({
      code: "task_critical_overdue",
      criticite: t.priority === "CRITICAL" && age >= 3 ? "CRITICAL" : "IMPORTANT",
      titre: `Tâche ${t.priority === "CRITICAL" ? "critique" : "importante"} en retard de ${age} j`,
      detail: `${t.title}${t.assignedTo ? ` — chez ${t.assignedTo.name}` : ""}`,
      lien: "/mon-espace",
    });
  }
  for (const d of invoicesUnchained) {
    alerts.push({
      code: "invoice_without_po",
      criticite: "WATCH",
      titre: "Facture sans bon de commande chaîné",
      detail: `${d.reference ?? ""} ${d.title} (déposée il y a ${days(d.createdAt, now)} j) — chaîner via update_legal_document`,
      reference: d.reference, lien: `/legal/${d.id}`,
    });
  }
  for (const d of posWithoutInvoice) {
    alerts.push({
      code: "po_without_invoice",
      criticite: "WATCH",
      titre: `BC sans facture depuis ${days(d.createdAt, now)} j`,
      detail: `${d.reference ?? ""} ${d.title} — la facture est-elle arrivée sans être déclarée ?`,
      reference: d.reference, lien: `/legal/${d.id}`,
    });
  }
  for (const d of contractsExpiring) {
    const left = d.endDate ? Math.max(0, Math.ceil((d.endDate.getTime() - now.getTime()) / DAY)) : 0;
    alerts.push({
      code: "contract_expiring",
      criticite: left <= 7 ? "IMPORTANT" : "WATCH",
      titre: `Échéance dans ${left} j — ${d.kind === "CONTRACT" ? "contrat" : "engagement"}`,
      detail: `${d.title}${d.counterparty ? ` (${d.counterparty})` : ""}`,
      reference: d.reference, lien: `/legal/${d.id}`,
    });
  }
  for (const r of regStale) {
    alerts.push({
      code: "regulatory_no_activity",
      criticite: "WATCH",
      titre: `Dossier Regulatory sans activité depuis ${days(r.updatedAt, now)} j`,
      detail: `${r.reference} — ${r.brandName ?? r.dci} (statut ${r.status})`,
      reference: r.reference, lien: `/regulatory/${r.id}`,
    });
  }
  // Stock : dernier relevé par (produit × lieu), niveaux épuisés ou très bas.
  const seen = new Set<string>();
  for (const s of stockSnaps) {
    const lieu = s.scope === "PCH" ? "PCH (centrale)" : s.annex?.name ?? "Hôpital";
    const key = `${s.product.id}|${lieu}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.quantity > 10) continue;
    alerts.push({
      code: "stock_critical",
      criticite: s.quantity <= 0 ? "CRITICAL" : "IMPORTANT",
      titre: s.quantity <= 0 ? "Stock ÉPUISÉ au dernier relevé" : `Stock très bas (${s.quantity})`,
      detail: `${s.product.brandName?.trim() || s.product.dci} — ${lieu} (relevé du ${s.date.toISOString().slice(0, 10)})`,
      lien: "/stocks",
    });
  }
  for (const p of paymentsUndecided) {
    alerts.push({
      code: "payment_request_undecided",
      criticite: "WATCH",
      titre: `Demande de paiement sans décision depuis ${days(p.createdAt, now)} j`,
      detail: `${p.reference} — ${p.title} (${p.payee}, ${Math.round(toNumber(p.amount)).toLocaleString("fr-FR")} DZD)`,
      reference: p.reference, lien: `/validations/paiements/${p.id}`,
    });
  }

  for (const c of commitmentsOverdue) {
    const late = c.dueAt ? days(c.dueAt, now) : 0;
    alerts.push({
      code: "commitment_overdue",
      criticite: late >= 7 ? "IMPORTANT" : "WATCH",
      titre: `Engagement en retard de ${late} j`,
      detail: `${c.who} devait « ${c.what} »${c.toWhom ? ` (envers ${c.toWhom})` : ""}${c.relatedRef ? ` — réf. ${c.relatedRef}` : ""} — à vous de décider la suite (aucune relance automatique)`,
      reference: c.relatedRef, lien: "/chief-of-staff",
    });
  }

  // ANOMALIE — factures candidates au doublon : même contrepartie (repliée), même montant
  // arrondi, moins de 45 jours d'écart. Deux pièces au plus par paire, jamais de conclusion.
  const invKey = (s: string | null): string => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const byPair = new Map<string, typeof invoicesRecent>();
  for (const inv of invoicesRecent) {
    if (!inv.counterparty || inv.amount == null) continue;
    const key = `${invKey(inv.counterparty)}|${Math.round(toNumber(inv.amount))}`;
    byPair.set(key, [...(byPair.get(key) ?? []), inv]);
  }
  let duplicatePairs = 0;
  for (const group of byPair.values()) {
    if (group.length < 2 || duplicatePairs >= 4) continue;
    const sorted = [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 1; i < sorted.length && duplicatePairs < 4; i += 1) {
      const gap = Math.abs(days(sorted[i - 1].createdAt, sorted[i].createdAt));
      if (gap > 45) continue;
      duplicatePairs += 1;
      alerts.push({
        code: "invoice_duplicate_candidate",
        criticite: "IMPORTANT",
        titre: "Facture candidate au DOUBLON (à vérifier pièce en main)",
        detail: `${sorted[i - 1].reference ?? sorted[i - 1].title} et ${sorted[i].reference ?? sorted[i].title} — ${sorted[i].counterparty}, même montant (${Math.round(toNumber(sorted[i].amount)).toLocaleString("fr-FR")} DZD), à ${gap} j d'écart. Règle : même contrepartie + même montant sous 45 j.`,
        reference: sorted[i].reference,
        lien: `/legal/${sorted[i].id}`,
      });
    }
  }

  // ANOMALIE — montant inhabituel : règlement en attente ≥ 4× la médiane payée à ce
  // bénéficiaire (au moins 3 paiements de référence). Le seuil est DIT — pas de score opaque.
  const beneficiaries = [...new Set(ordersUnpaid.map((o) => o.beneficiary).filter((b): b is string => Boolean(b)))].slice(0, 12);
  if (beneficiaries.length > 0) {
    const history = await prisma.expenseOrder.findMany({
      where: { AND: [entity, { paidDate: { not: null }, beneficiary: { in: beneficiaries } }] },
      select: { beneficiary: true, amount: true },
      orderBy: { paidDate: "desc" }, take: 300,
    });
    const paidBy = new Map<string, number[]>();
    for (const h of history) {
      if (!h.beneficiary) continue;
      paidBy.set(h.beneficiary, [...(paidBy.get(h.beneficiary) ?? []), toNumber(h.amount)]);
    }
    for (const o of ordersUnpaid) {
      if (!o.beneficiary) continue;
      const prior = paidBy.get(o.beneficiary) ?? [];
      if (prior.length < 3) continue; // trop peu d'historique : pas de fausse précision
      const sorted = [...prior].sort((a, b) => a - b);
      const med = sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const amount = toNumber(o.amount);
      if (med > 0 && amount >= 4 * med) {
        alerts.push({
          code: "payment_amount_outlier",
          criticite: "IMPORTANT",
          titre: "Montant INHABITUEL pour ce bénéficiaire (à vérifier avant paiement)",
          detail: `${o.reference} — ${o.label} : ${formatMontant(amount)} DZD pour ${o.beneficiary}, contre une médiane payée de ${formatMontant(med)} DZD sur ${prior.length} paiement(s). Règle : ≥ 4× la médiane.`,
          reference: o.reference,
          lien: "/centre-de-paiement",
        });
      }
    }
  }

  return alerts.sort((a, b) => RANK[a.criticite] - RANK[b.criticite]).slice(0, 40);
}
