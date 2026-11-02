import type { RegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clauseEvenementsVisibles } from "@/lib/queries/visibilite-listes";
import { toNumber } from "@/lib/utils";

export interface EventListItem {
  id: string;
  name: string;
  type: string;
  scope: string;
  format: string;
  status: string;
  startDate: string | null;
  city: string | null;
  registrations: number;
  present: number;
  capacity: number | null;
}

export interface RegistrationDTO {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  specialty: string | null;
  institution: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  qrToken: string;
  checkedInAt: string | null;
  source: string | null;
}

export interface EventStats {
  total: number;
  present: number;
  confirmed: number;
  registered: number;
  pending: number;
  absent: number;
  attendanceRate: number;
  capacity: number | null;
  spotsLeft: number | null;
  bySpecialty: { name: string; count: number }[];
  byRole: { role: string; count: number }[];
}

export interface EventDetail {
  id: string;
  name: string;
  type: string;
  scope: string;
  format: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  specialty: string | null;
  products: string | null;
  /** LES PRATICIENS CONCERNÉS — noms joints, choisis dans l'annuaire (§118.142). */
  doctor: string | null;
  /** LA GAMME qui porte la demande — c'est SON budget Ad&Pro qui est engagé. */
  businessUnitId: string | null;
  description: string | null;
  /** QUI ORGANISE l'événement — il est externe (Direction, 27/10). */
  organizer: string | null;
  capacity: number | null;
  estimatedBudget: number | null;
  meetingLink: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  // Circuit de prise en charge (financement) — requestStatus null si non soumis.
  requestStatus: string | null;
  /** Qui a demandé la prise en charge : c'est LUI qui peut corriger sa demande. */
  requesterId: string | null;
  /** Qui a créé l'événement — son demandeur tant qu'aucune demande de prise en charge n'est partie. */
  createdById: string | null;
  requesterName: string | null;
  productManagerId: string | null;
  productManagerName: string | null;
  productManagerBudget: number | null;
  productManagerNotes: string | null;
  preliminaryByName: string | null;
  preliminaryAt: string | null;
  preliminaryNote: string | null;
  finalByName: string | null;
  finalAt: string | null;
  finalNote: string | null;
  finalAmount: number | null;
  rejectionReason: string | null;
  expenseOrder: { reference: string; status: string; amount: number } | null;
  registrations: RegistrationDTO[];
  stats: EventStats;
}

const ACTIVE: RegistrationStatus[] = ["REGISTERED", "CONFIRMED", "PRESENT", "PENDING"];

export async function getEvents(userId: string): Promise<EventListItem[]> {
  const events = await prisma.event.findMany({
    where: await clauseEvenementsVisibles(userId),
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    include: { registrations: { select: { status: true } } },
  });
  return events.map((e) => ({
    id: e.id, name: e.name, type: e.type, scope: e.scope, format: e.format, status: e.status,
    startDate: e.startDate?.toISOString() ?? null, city: e.city, capacity: e.capacity,
    registrations: e.registrations.filter((r) => ACTIVE.includes(r.status)).length,
    present: e.registrations.filter((r) => r.status === "PRESENT").length,
  }));
}

function buildStats(regs: { status: RegistrationStatus; specialty: string | null; role: string }[], capacity: number | null): EventStats {
  const count = (s: string) => regs.filter((r) => r.status === s).length;
  const present = count("PRESENT");
  const absent = count("ABSENT");
  const confirmed = count("CONFIRMED");
  const registered = count("REGISTERED");
  const pending = count("PENDING");
  const expected = present + absent + confirmed + registered; // hors annulés/refusés/attente
  const taken = regs.filter((r) => ACTIVE.includes(r.status)).length;

  const bySpecMap = new Map<string, number>();
  const byRoleMap = new Map<string, number>();
  for (const r of regs) {
    if (!ACTIVE.includes(r.status)) continue;
    const sp = (r.specialty || "Non précisée").trim();
    bySpecMap.set(sp, (bySpecMap.get(sp) ?? 0) + 1);
    byRoleMap.set(r.role, (byRoleMap.get(r.role) ?? 0) + 1);
  }
  return {
    total: regs.length, present, confirmed, registered, pending, absent,
    attendanceRate: expected > 0 ? Math.round((present / expected) * 100) : 0,
    capacity, spotsLeft: capacity !== null ? Math.max(0, capacity - taken) : null,
    bySpecialty: [...bySpecMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byRole: [...byRoleMap.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count),
  };
}

export async function getEventDetail(id: string): Promise<EventDetail | null> {
  const e = await prisma.event.findUnique({
    where: { id },
    include: {
      responsible: { select: { name: true } },
      registrations: { orderBy: [{ createdAt: "asc" }] },
    },
  });
  if (!e) return null;
  const regs: RegistrationDTO[] = e.registrations.map((r) => ({
    id: r.id, firstName: r.firstName, lastName: r.lastName, fullName: `${r.firstName} ${r.lastName}`.trim(),
    specialty: r.specialty, institution: r.institution, city: r.city, email: r.email, phone: r.phone,
    role: r.role, status: r.status, qrToken: r.qrToken, checkedInAt: r.checkedInAt?.toISOString() ?? null, source: r.source,
  }));

  // Acteurs du circuit de prise en charge (champs scalaires → résolution des noms).
  const actorIds = [e.requesterId, e.productManagerId, e.preliminaryById, e.finalById].filter((x): x is string => Boolean(x));
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = (id: string | null) => (id ? actors.find((u) => u.id === id)?.name ?? null : null);
  const order = e.expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: e.expenseOrderId }, select: { reference: true, status: true, amount: true } })
    : null;

  return {
    id: e.id, name: e.name, type: e.type, scope: e.scope, format: e.format, status: e.status,
    startDate: e.startDate?.toISOString() ?? null, endDate: e.endDate?.toISOString() ?? null,
    location: e.location, city: e.city, country: e.country, specialty: e.specialty, products: e.products,
    doctor: e.doctor, businessUnitId: e.businessUnitId,
    description: e.description, organizer: e.organizer, capacity: e.capacity, estimatedBudget: e.estimatedBudget ? toNumber(e.estimatedBudget) : null,
    meetingLink: e.meetingLink, responsibleId: e.responsibleId, responsibleName: e.responsible?.name ?? null,
    requestStatus: e.requestStatus, requesterId: e.requesterId, createdById: e.createdById ?? null, requesterName: nameOf(e.requesterId),
    productManagerId: e.productManagerId, productManagerName: nameOf(e.productManagerId),
    productManagerBudget: e.productManagerBudget ? toNumber(e.productManagerBudget) : null,
    productManagerNotes: e.productManagerNotes,
    preliminaryByName: nameOf(e.preliminaryById), preliminaryAt: e.preliminaryAt?.toISOString() ?? null, preliminaryNote: e.preliminaryNote,
    finalByName: nameOf(e.finalById), finalAt: e.finalAt?.toISOString() ?? null, finalNote: e.finalNote,
    finalAmount: e.finalAmount ? toNumber(e.finalAmount) : null,
    rejectionReason: e.rejectionReason,
    expenseOrder: order ? { reference: order.reference, status: order.status, amount: toNumber(order.amount) } : null,
    registrations: regs,
    stats: buildStats(e.registrations.map((r) => ({ status: r.status, specialty: r.specialty, role: r.role })), e.capacity),
  };
}

export interface PublicEvent {
  id: string;
  name: string;
  type: string;
  scope: string;
  format: string;
  status: string;
  open: boolean;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  description: string | null;
  spotsLeft: number | null;
}

/** Vue publique d'un événement (page d'inscription, sans authentification). */
export async function getPublicEvent(id: string): Promise<PublicEvent | null> {
  const e = await prisma.event.findUnique({
    where: { id },
    select: {
      id: true, name: true, type: true, scope: true, format: true, status: true,
      startDate: true, endDate: true, location: true, city: true, country: true, description: true,
    },
  });
  if (!e) return null;
  return {
    id: e.id, name: e.name, type: e.type, scope: e.scope, format: e.format, status: e.status,
    // ÉVÉNEMENTS EXTERNES (Direction, 27/10) : on s'y inscrit chez l'organisateur — jamais ici.
    open: false,
    startDate: e.startDate?.toISOString() ?? null, endDate: e.endDate?.toISOString() ?? null,
    location: e.location, city: e.city, country: e.country, description: e.description,
    spotsLeft: null,
  };
}
