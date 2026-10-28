import type { HrDocumentCategory, HrRequestType, HrRequestStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DocItem } from "@/components/documents/document-list";
import type { CommentItem } from "@/components/shared/comment-thread";

/** Lecture du dossier RH employé (documents + demandes d'attestation). */

export interface HrDocumentDTO {
  id: string;
  category: HrDocumentCategory;
  name: string;
  mime: string;
  size: number;
  period: string | null;
  createdAt: string;
  /**
   * Le salarié voit-il cette pièce dans « Mon dossier RH » ? Affiché sur la ligne côté RH :
   * une restriction qu'on ne voit pas est une restriction dont on doute.
   */
  visibleToEmployee: boolean;
}

export interface HrRequestDTO {
  id: string;
  type: HrRequestType;
  status: HrRequestStatus;
  details: string | null;
  hrNote: string | null;
  createdAt: string;
  fulfilmentDocId: string | null;
  // Note de frais
  expenseMonth: string | null;
  /** Le MONTANT avancé — un champ, plus un chiffre noyé dans le motif. */
  expenseAmount: number | null;
  approvedMonth: string | null;
  originalsAckAt: string | null;
  originalsAckByName: string | null;
  /** Fin des quinze minutes pendant lesquelles le demandeur se corrige. */
  editableUntil: string | null;
  /** Réouverture accordée par les RH — elle prime sur le délai. */
  editUnlockedAt: string | null;
  // Congé / absence : période demandée + jours + débit du solde effectué (congé annuel).
  periodStart: string | null;
  periodEnd: string | null;
  periodDays: number | null;
  balanceApplied: boolean;
  // Entrevue RH
  meetingAt: string | null;
  meetingProposedById: string | null;
  meetingConfirmedAt: string | null;
  // Archive « Dossier traité » (Drive)
  archivedNodeId: string | null;
  /** Ordre de mission d'une mission Ad & Pro : la marche du N+1 (nulle = aucune) et les champs pré-remplis. */
  managerGate: "PENDING" | "APPROVED" | "REJECTED" | null;
  missionPrefill: { objet: string; destination: string; datesDepart: string[]; datesRetour: string[]; transport?: string; hebergement?: string } | null;
  documents: DocItem[];
  comments: CommentItem[];
}

/** Les champs d'un ordre pré-remplis depuis la mission (JSON stocké), relus prudemment. */
function lirePrefill(v: unknown): HrRequestDTO["missionPrefill"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const liste = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    objet: typeof o.objet === "string" ? o.objet : "",
    destination: typeof o.destination === "string" ? o.destination : "",
    datesDepart: liste(o.datesDepart),
    datesRetour: liste(o.datesRetour),
    // La mission de l'équipe convenue (Direction, 10/2026) : le transport et l'hébergement de l'accord.
    ...(typeof o.transport === "string" ? { transport: o.transport } : {}),
    ...(typeof o.hebergement === "string" ? { hebergement: o.hebergement } : {}),
  };
}

export interface MyHrDossier {
  employee: {
    id: string;
    fullName: string;
    position: string | null;
    department: string | null;
    contractType: string | null;
    hireDate: string | null;
    cnasNumber: string | null;
    // AUCUNE RÉMUNÉRATION ici (Direction, 06/10) : le salaire ne s'affiche plus dans le dossier du salarié.
  };
  documents: HrDocumentDTO[];
  requests: HrRequestDTO[];
}

function mapDoc(d: { id: string; category: HrDocumentCategory; name: string; mime: string; size: number; period: string | null; createdAt: Date; visibleToEmployee?: boolean }): HrDocumentDTO {
  return {
    id: d.id, category: d.category, name: d.name, mime: d.mime, size: d.size, period: d.period,
    createdAt: d.createdAt.toISOString(),
    // Côté salarié, la requête ne remonte QUE ses pièces partagées : l'absence du champ y vaut
    // « visible », et non « on ne sait pas ».
    visibleToEmployee: d.visibleToEmployee ?? true,
  };
}

type ReqRow = {
  id: string; type: HrRequestType; status: HrRequestStatus; details: string | null; hrNote: string | null;
  createdAt: Date; fulfilment: { id: string } | null;
  expenseMonth: string | null; expenseAmount: unknown; approvedMonth: string | null;
  originalsAckAt: Date | null; originalsAckById: string | null;
  editableUntil: Date | null; editUnlockedAt: Date | null;
  periodStart: Date | null; periodEnd: Date | null; periodDays: unknown; balanceAppliedAt: Date | null;
  meetingAt: Date | null; meetingProposedById: string | null; meetingConfirmedAt: Date | null;
  archivedNodeId: string | null;
  managerGate?: "PENDING" | "APPROVED" | "REJECTED" | null;
  omPrefill?: unknown;
};

function mapReq(r: ReqRow): HrRequestDTO {
  return {
    id: r.id, type: r.type, status: r.status, details: r.details, hrNote: r.hrNote,
    createdAt: r.createdAt.toISOString(), fulfilmentDocId: r.fulfilment?.id ?? null,
    expenseMonth: r.expenseMonth,
    expenseAmount: r.expenseAmount == null ? null : Number(r.expenseAmount.toString()),
    approvedMonth: r.approvedMonth,
    originalsAckAt: r.originalsAckAt?.toISOString() ?? null,
    originalsAckByName: r.originalsAckById, // remplacé par le nom dans attachThreads
    editableUntil: r.editableUntil?.toISOString() ?? null,
    editUnlockedAt: r.editUnlockedAt?.toISOString() ?? null,
    periodStart: r.periodStart?.toISOString() ?? null,
    periodEnd: r.periodEnd?.toISOString() ?? null,
    periodDays: r.periodDays == null ? null : Number(r.periodDays.toString()),
    balanceApplied: Boolean(r.balanceAppliedAt),
    meetingAt: r.meetingAt?.toISOString() ?? null,
    meetingProposedById: r.meetingProposedById,
    meetingConfirmedAt: r.meetingConfirmedAt?.toISOString() ?? null,
    archivedNodeId: r.archivedNodeId,
    managerGate: r.managerGate ?? null,
    missionPrefill: lirePrefill(r.omPrefill),
    documents: [], comments: [],
  };
}

/** Charge pièces jointes + fil d'échange + noms (accusé de réception) de chaque demande RH. */
async function attachThreads(requests: HrRequestDTO[]): Promise<void> {
  const ids = requests.map((r) => r.id);
  if (ids.length === 0) return;
  const ackIds = [...new Set(requests.map((r) => r.originalsAckByName).filter((v): v is string => Boolean(v)))];
  const [documents, comments, ackUsers] = await Promise.all([
    prisma.document.findMany({ where: { entityType: "HR_REQUEST", entityId: { in: ids } }, include: { uploadedBy: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.comment.findMany({ where: { entityType: "HR_REQUEST", entityId: { in: ids } }, include: { author: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
    ackIds.length ? prisma.user.findMany({ where: { id: { in: ackIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const ackNameById = new Map(ackUsers.map((u) => [u.id, u.name]));
  for (const r of requests) {
    if (r.originalsAckByName) r.originalsAckByName = ackNameById.get(r.originalsAckByName) ?? null;
  }
  const byReq = new Map(requests.map((r) => [r.id, r]));
  for (const d of documents) {
    byReq.get(d.entityId)?.documents.push({ id: d.id, name: d.name, category: d.category, version: d.version, sizeBytes: d.sizeBytes, confidentiality: d.confidentiality, uploadedBy: d.uploadedBy?.name ?? null, createdAt: d.createdAt.toISOString(), hasFile: Boolean(d.fileKey) });
  }
  for (const c of comments) {
    byReq.get(c.entityId)?.comments.push({ id: c.id, author: c.author?.name ?? "Utilisateur", authorId: c.authorId, body: c.body, createdAt: c.createdAt.toISOString(), editedAt: c.editedAt?.toISOString() ?? null });
  }
}

/** Dossier RH de l'utilisateur connecté (ou null s'il n'a pas de fiche employé). */
export async function getMyHrDossier(userId: string): Promise<MyHrDossier | null> {
  const employee = await prisma.employee.findUnique({
    where: { userId },
    include: {
      documents: { where: { visibleToEmployee: true }, orderBy: { createdAt: "desc" } },
      hrRequests: { orderBy: { createdAt: "desc" }, include: { fulfilment: { select: { id: true } } } },
    },
  });
  if (!employee) return null;
  const requests = employee.hrRequests.map(mapReq);
  await attachThreads(requests);
  return {
    employee: {
      id: employee.id,
      fullName: employee.fullName,
      position: employee.position,
      department: employee.department,
      contractType: employee.contractType,
      hireDate: employee.hireDate?.toISOString() ?? null,
      cnasNumber: employee.cnasNumber,
    },
    documents: employee.documents.map(mapDoc),
    requests,
  };
}

/** Documents + demandes d'un employé, pour la vue RH (gestionnaire). */
export async function getEmployeeHrDossier(employeeId: string) {
  const [documents, requests] = await Promise.all([
    prisma.employeeDocument.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" } }),
    prisma.hrDocumentRequest.findMany({ where: { employeeId }, orderBy: { createdAt: "desc" }, include: { fulfilment: { select: { id: true } } } }),
  ]);
  const reqs = requests.map(mapReq);
  await attachThreads(reqs);
  return { documents: documents.map(mapDoc), requests: reqs };
}

export interface HrQueueItem extends HrRequestDTO {
  employeeId: string;
  employeeName: string;
  employeePosition: string | null;
}

/**
 * LA FILE DES DEMANDES RH — le sous-module « Demandes RH » (Direction, 06/10) : les demandes OUVERTES des salariés que la
 * personne voit (bornées à la société, comme la liste des salariés — `clauseSalariesVisibles`), avec leurs pièces et leur
 * fil, pour les traiter sur place sans passer par la fiche du salarié. Les plus anciennes d'abord : elles attendent le plus.
 */
export async function getHrRequestQueue(perimetre: Prisma.EmployeeWhereInput = {}): Promise<HrQueueItem[]> {
  const rows = await prisma.hrDocumentRequest.findMany({
    // UN ORDRE DE MISSION ENCORE CHEZ LE N+1 n'est pas encore aux RH (missions Ad & Pro, 10/2026). `OR` explicite :
    // un `not` sur une colonne nullable écarterait aussi les demandes sans marche N+1.
    where: { status: { in: ["PENDING", "IN_PROGRESS"] }, employee: perimetre, OR: [{ managerGate: null }, { managerGate: { not: "PENDING" } }] },
    orderBy: { createdAt: "asc" },
    include: { employee: { select: { id: true, fullName: true, position: true } }, fulfilment: { select: { id: true } } },
    take: 100,
  });
  const items: HrQueueItem[] = rows.map((r) => ({ ...mapReq(r), employeeId: r.employee.id, employeeName: r.employee.fullName, employeePosition: r.employee.position }));
  await attachThreads(items);
  return items;
}

/**
 * LES DEMANDES RÉCEMMENT PRÊTES — le filtre « Prêtes » de « Demandes RH » (Direction, 07/10) : ce qui a été préparé,
 * remis ou accordé ces 30 derniers jours, dans le MÊME périmètre que la file (`clauseSalariesVisibles`), les plus récentes
 * d'abord, bornées à 50. Rien de plus que ce que l'écran voyait déjà sur les fiches des mêmes salariés.
 */
export async function getHrRequestsPretes(perimetre: Prisma.EmployeeWhereInput = {}, jours = 30): Promise<HrQueueItem[]> {
  const depuis = new Date(Date.now() - jours * 86_400_000);
  const rows = await prisma.hrDocumentRequest.findMany({
    where: { status: { in: ["READY", "DELIVERED", "APPROVED"] }, updatedAt: { gte: depuis }, employee: perimetre },
    orderBy: { updatedAt: "desc" },
    include: { employee: { select: { id: true, fullName: true, position: true } }, fulfilment: { select: { id: true } } },
    take: 50,
  });
  const items: HrQueueItem[] = rows.map((r) => ({ ...mapReq(r), employeeId: r.employee.id, employeeName: r.employee.fullName, employeePosition: r.employee.position }));
  await attachThreads(items);
  return items;
}
