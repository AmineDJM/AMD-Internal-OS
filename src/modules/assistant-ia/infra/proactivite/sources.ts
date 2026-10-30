import { prisma } from "@/lib/prisma";
import { userCan, type Module } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { AccesIa } from "../../domaine/acces-regles";
import {
  bcNonSignes, budgetsAuSeuil, contratsAFin, demandesBloquees, doublonsDeFactures, echeancesReglementaires, finsDEssai,
  paiementsEnRetard, reservesNonLevees, reunionsProches, validationsEnAttente, visitesNonRapportees,
  type CodeVeilleur, type Constat, type FicheVeilleur,
} from "../../domaine/proactivite/veilleurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE CHAQUE VEILLEUR LIT — sous l'identité de la personne, relue en base à chaque passage.
 *
 * Deux portes avant toute lecture : un module d'écran ouvert (si la fiche en nomme) et la famille
 * de la console ouverte à l'assistant pour elle (`accesAssistantIa`, relu par l'appelant). Puis la
 * lecture ne prend que ce qui est À LA PERSONNE — ses demandes, ses BC, ses échéances, ses
 * visites, ses collaborateurs DIRECTS — : un veilleur n'élargit jamais ce qu'elle voit à l'écran.
 * (Le veilleur des doublons de factures parcourt toutes les factures pour qui VALIDE en Finances,
 * les siennes sinon.)
 *
 * Toujours bornées : quelques dizaines de lignes par veilleur, jamais un balayage de table.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const JOUR_MS = 86_400_000;
const LOT = 40;
const nombre = (v: unknown): number => (v == null ? 0 : Number(v));

/** Le veilleur est-il ouvert à cette personne (module d'écran ET famille de la console) ? */
export function veilleurOuvert(fiche: FicheVeilleur, user: CurrentUser, acces: AccesIa): boolean {
  if (!acces.ouvertes.includes(fiche.famille)) return false;
  return fiche.modules.length === 0 || fiche.modules.some((m) => userCan(user, m as Module, "VIEW"));
}

const ATTENTE_SPONSORING = [
  "RECEIVED", "IN_ANALYSIS", "AWAITING_DIRECTION", "AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED",
  "AWAITING_FINAL", "APPEAL_PENDING", "AWAITING_FINAL_APPEAL", "PRE_VALIDATED",
] as const;
const PAIEMENT_OUVERT = ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD", "CHANGES_REQUESTED", "APPROVED"] as const;

type Lecteur = (user: CurrentUser, seuil: number, now: Date, contexte: { constatsOuverts: ReadonlySet<string> }) => Promise<Constat[]>;

export const LECTEURS: Record<CodeVeilleur, Lecteur> = {
  async ADPRO_DEMANDE_BLOQUEE(user, seuil, now) {
    const avant = new Date(now.getTime() - seuil * JOUR_MS);
    const moi = [{ requesterId: user.id }, { productManagerId: user.id }];
    const [sponsorings, autres] = await Promise.all([
      prisma.sponsoringRequest.findMany({
        where: { OR: moi, status: { in: [...ATTENTE_SPONSORING] }, updatedAt: { lt: avant } },
        select: { id: true, reference: true, institution: true, status: true, updatedAt: true }, orderBy: { updatedAt: "asc" }, take: LOT,
      }),
      prisma.adProOtherRequest.findMany({
        where: { requesterId: user.id, status: "AWAITING_DECISION", updatedAt: { lt: avant } },
        select: { id: true, reference: true, title: true, status: true, updatedAt: true }, orderBy: { updatedAt: "asc" }, take: LOT,
      }),
    ]);
    return demandesBloquees([
      ...sponsorings.map((s) => ({ id: s.id, reference: s.reference, nature: "SPONSORING" as const, titre: s.institution, statut: s.status, majLe: s.updatedAt, lien: `/sponsoring/${s.id}` })),
      ...autres.map((a) => ({ id: a.id, reference: a.reference, nature: "AUTRE" as const, titre: a.title, statut: a.status, majLe: a.updatedAt, lien: `/ad-pro/autres/${a.id}` })),
    ], seuil, now);
  },

  async BUDGET_SEUIL(user, seuil) {
    const lignes = await prisma.budgetLine.findMany({
      where: { ownerId: user.id, status: { not: "CLOSED" } },
      select: { id: true, label: true, initialBudget: true, consumedBudget: true, futureCommitted: true }, take: LOT,
    });
    return budgetsAuSeuil(lignes.map((l) => ({ id: l.id, nom: l.label, initial: nombre(l.initialBudget), consomme: nombre(l.consumedBudget), engage: nombre(l.futureCommitted) })), seuil);
  },

  async BC_NON_SIGNE(user, seuil, now) {
    const bcs = await prisma.legalDocument.findMany({
      where: {
        kind: "PURCHASE_ORDER", createdById: user.id, status: "ACTIVE", signedAt: null, signatureReturnedAt: null,
        bcCircuitAt: { not: null, lt: new Date(now.getTime() - seuil * JOUR_MS) },
      },
      select: { id: true, reference: true, title: true, counterparty: true, amount: true, bcCircuitAt: true }, take: LOT,
    });
    return bcNonSignes(bcs.map((b) => ({ id: b.id, reference: b.reference ?? b.title, tiers: b.counterparty, montant: b.amount == null ? null : nombre(b.amount), circuitLe: b.bcCircuitAt! })), seuil, now);
  },

  async REG_ECHEANCE(user, seuil, now) {
    const horizon = new Date(now.getTime() + seuil * JOUR_MS);
    const [obligations, produits] = await Promise.all([
      prisma.regulatoryObligation.findMany({
        where: { status: { in: ["OPEN", "OVERDUE"] }, dueDate: { not: null, lte: horizon }, OR: [{ createdById: user.id }, { dossier: { createdById: user.id } }] },
        select: { id: true, label: true, dueDate: true, dossierId: true, dossier: { select: { reference: true } } }, take: LOT,
      }),
      prisma.regulatoryProduct.findMany({
        where: { responsibleId: user.id, externalDeadline: { not: null, lte: horizon }, status: { notIn: ["DECISION_OBTAINED", "CLOSED"] } },
        select: { id: true, reference: true, dci: true, brandName: true, externalDeadline: true }, take: LOT,
      }),
    ]);
    return echeancesReglementaires([
      ...obligations.map((o) => ({ id: o.id, source: "OBLIGATION" as const, titre: `${o.label} (${o.dossier.reference})`, echeance: o.dueDate!, lien: `/regulatory/enregistrement/analyse/${o.dossierId}` })),
      ...produits.map((p) => ({ id: p.id, source: "PRODUIT" as const, titre: `${p.brandName ?? p.dci} (${p.reference})`, echeance: p.externalDeadline!, lien: `/regulatory/${p.id}` })),
    ], seuil, now);
  },

  async REG_RESERVE(user, seuil, now) {
    const points = await prisma.regulatoryReservePoint.findMany({
      where: { assignedToId: user.id, status: "OPEN", cycle: { status: "OPEN", receivedAt: { lt: new Date(now.getTime() - seuil * JOUR_MS) } } },
      select: { id: true, subject: true, cycle: { select: { receivedAt: true, dossierId: true, dossier: { select: { reference: true } } } } }, take: LOT,
    });
    return reservesNonLevees(points.map((p) => ({
      id: p.id, titre: p.subject ?? "Point de réserve", dossier: p.cycle.dossier.reference, recueLe: p.cycle.receivedAt,
      lien: `/regulatory/enregistrement/analyse/${p.cycle.dossierId}`,
    })), seuil, now);
  },

  async RH_FIN_ESSAI(user, seuil, now) {
    return finsDEssai(await collaborateursDirects(user, now, seuil), seuil, now);
  },

  async RH_CONTRAT_FIN(user, seuil, now) {
    return contratsAFin(await collaborateursDirects(user, now, seuil), seuil, now);
  },

  async FIN_PAIEMENT_RETARD(user, seuil, now) {
    const avant = new Date(now.getTime() - seuil * JOUR_MS);
    const [demandes, ordres] = await Promise.all([
      prisma.paymentRequest.findMany({
        where: { requesterId: user.id, status: { in: [...PAIEMENT_OUVERT] }, dueDate: { not: null, lt: avant } },
        select: { id: true, reference: true, payee: true, amount: true, dueDate: true }, take: LOT,
      }),
      prisma.expenseOrder.findMany({
        where: { requestedById: user.id, status: "PENDING", paidDate: null, dueDate: { not: null, lt: avant } },
        select: { id: true, reference: true, beneficiary: true, amount: true, dueDate: true }, take: LOT,
      }),
    ]);
    return paiementsEnRetard([
      ...demandes.map((d) => ({ id: d.id, source: "DEMANDE" as const, reference: d.reference, beneficiaire: d.payee, montant: nombre(d.amount), echeance: d.dueDate!, lien: `/centre-de-paiement` })),
      ...ordres.map((o) => ({ id: o.id, source: "ORDRE" as const, reference: o.reference, beneficiaire: o.beneficiary, montant: nombre(o.amount), echeance: o.dueDate!, lien: `/finances` })),
    ], seuil, now);
  },

  async FIN_DOUBLON_FACTURE(user, seuil, now) {
    const tout = userCan(user, "FINANCES", "VALIDATE");
    const factures = await prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" }, createdAt: { gte: new Date(now.getTime() - seuil * JOUR_MS) }, ...(tout ? {} : { createdById: user.id }) },
      select: { id: true, reference: true, counterparty: true, amount: true, startDate: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: 400,
    });
    return doublonsDeFactures(factures.map((f) => ({ id: f.id, reference: f.reference, fournisseur: f.counterparty, montant: f.amount == null ? null : nombre(f.amount), date: f.startDate ?? f.createdAt })));
  },

  async TERRAIN_VISITE_NON_RAPPORTEE(user, seuil, now) {
    const visites = await prisma.medicalVisit.findMany({
      where: {
        delegateId: user.id, date: { lt: new Date(now.getTime() - seuil * JOUR_MS), gte: new Date(now.getTime() - 30 * JOUR_MS) },
        OR: [{ status: "PLANNED" }, { status: "COMPLETED", report: null, fieldReports: { none: {} } }],
      },
      select: { id: true, date: true, doctor: { select: { name: true } } }, orderBy: { date: "asc" }, take: LOT,
    });
    return visitesNonRapportees(visites.map((v) => ({ id: v.id, praticien: v.doctor?.name ?? "praticien", date: v.date })), seuil, now);
  },

  async VALIDATION_EN_ATTENTE(user, seuil, now) {
    const demandes = await prisma.validationRequest.findMany({
      where: { requesterId: user.id, status: "PENDING" },
      select: {
        id: true, reference: true, title: true, createdAt: true,
        steps: { orderBy: { order: "asc" }, select: { id: true, status: true, createdAt: true, decidedAt: true, validator: { select: { name: true } } } },
      },
      take: LOT,
    });
    const lignes = demandes.flatMap((d) => {
      const i = d.steps.findIndex((s) => s.status === "PENDING");
      if (i < 0) return [];
      const etape = d.steps[i]!;
      // Le validateur attend depuis que l'étape PRÉCÉDENTE a été tranchée (ou depuis la création).
      const precedent = i > 0 ? d.steps[i - 1]!.decidedAt : null;
      const depuis = [etape.createdAt, precedent, d.createdAt].filter((x): x is Date => x instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0]!;
      return [{ id: d.id, reference: d.reference, titre: d.title, validateur: etape.validator?.name ?? null, etapeId: etape.id, depuis }];
    });
    return validationsEnAttente(lignes, seuil, now);
  },

  async REUNION_PROCHE(user, seuil, now, contexte) {
    const de = new Date(now.getTime() + Math.max(5, seuil - 30) * 60_000);
    const a = new Date(now.getTime() + (seuil + 15) * 60_000);
    const [evenements, reunions] = await Promise.all([
      prisma.calendarEvent.findMany({
        where: { startAt: { gte: de, lte: a }, OR: [{ organizerId: user.id }, { invitees: { some: { userId: user.id, status: { not: "DECLINED" } } } }] },
        select: { id: true, title: true, startAt: true, organizer: { select: { id: true, name: true } }, invitees: { select: { user: { select: { id: true, name: true } } }, take: 12 } },
        take: 10,
      }),
      prisma.meeting.findMany({
        where: { status: "SCHEDULED", scheduledAt: { gte: de, lte: a }, OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }] },
        select: { id: true, title: true, scheduledAt: true, organizer: { select: { id: true, name: true } }, participants: { select: { user: { select: { id: true, name: true } } }, take: 12 } },
        take: 10,
      }),
    ]);
    const autres = (gens: { id: string; name: string }[]) => gens.filter((g) => g.id !== user.id);
    const lignes = [
      ...evenements.map((e) => ({ id: e.id, source: "AGENDA" as const, titre: e.title, debut: e.startAt, gens: autres([e.organizer, ...e.invitees.map((i) => i.user)]), lien: "/calendar" })),
      ...reunions.map((m) => ({ id: m.id, source: "REUNION" as const, titre: m.title, debut: m.scheduledAt!, gens: autres([m.organizer, ...m.participants.map((p) => p.user)]), lien: `/meetings/${m.id}` })),
    ];
    // « Points ouverts » : les constats en cours de la personne dont le texte nomme un participant — sans rien lire de plus.
    const ouverts = [...contexte.constatsOuverts].map((t) => t.toLowerCase());
    return reunionsProches(lignes.map((l) => ({ ...l, participants: l.gens.map((g) => g.name) })), seuil, now,
      (noms) => ouverts.filter((t) => noms.some((n) => n.length > 2 && t.includes(n.toLowerCase()))).length);
  },
};

/** Les collaborateurs DIRECTS de la personne (sa fiche salarié est leur manager), dont une échéance tombe dans l'horizon. */
async function collaborateursDirects(user: CurrentUser, now: Date, horizonJours: number) {
  const moi = await prisma.employee.findFirst({ where: { userId: user.id, isActive: true }, select: { id: true } });
  if (!moi) return [];
  const horizon = new Date(now.getTime() + horizonJours * JOUR_MS);
  const dans = { gte: now, lte: horizon };
  const gens = await prisma.employee.findMany({
    where: { managerId: moi.id, isActive: true, OR: [{ trialEnd: dans }, { trialRenewalEnd: dans }, { contractEnd: dans }] },
    select: { id: true, fullName: true, trialEnd: true, trialRenewed: true, trialRenewalEnd: true, contractType: true, contractEnd: true }, take: LOT,
  });
  return gens.map((g) => ({
    id: g.id, nom: g.fullName, finEssai: g.trialRenewed && g.trialRenewalEnd ? g.trialRenewalEnd : g.trialEnd,
    contrat: g.contractType ?? null, finContrat: g.contractEnd,
  }));
}
