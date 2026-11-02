import { hasGlobalView, hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { entitePermisePourFiche, platformScope, predicatEntitePermise } from "@/lib/company";

/** Lecture des rapports terrain (vocaux). Un délégué voit les siens ; un manager
 *  / la Direction / la Direction Marketing **gèrent** tout (édition + validation + synthèse).
 *  Le **superviseur national** (National Sales), lui, **voit** tous les rapports des
 *  délégués (lecture + synthèse), sans les éditer. */

export function managesReports(user: SessionUser): boolean {
  return hasGlobalView(user) || user.role === "MEDICAL_PROMOTION_MANAGER" || user.role === "PRODUCT_MANAGER";
}

/**
 * QUI PEUT SUPPRIMER UN RAPPORT (§118.212) — la règle, une fois, lue par l'action, l'aperçu de la
 * fenêtre de confirmation, la liste et la fiche. Pure : l'entité est un FAIT que l'appelant lit.
 *
 *   • l'AUTEUR du rapport, brouillon ou validé — c'est son compte rendu ;
 *   • qui le GÈRE déjà (`managesReports` : la hiérarchie et la Direction — la règle de `canEdit`)…
 *     …pour un rapport de SON périmètre d'entité : la fiche ne s'ouvre pas plus large que la liste ;
 *   • jamais le superviseur national, qui voit sans éditer.
 *
 * Le nom est un prédicat (`peut…`) : la carte de confirmation le lit comme une garde, et non comme
 * « gardé par rien » (§118.150g).
 */
export function peutSupprimerLeRapport(user: SessionUser, rapport: { delegateId: string | null }, entitePermise: boolean): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  if (!userCan(user, "FIELD_REPORTS", "VIEW")) return false;
  if (rapport.delegateId !== null && rapport.delegateId === user.id) return true;
  return managesReports(user) && entitePermise;
}

/** La même règle pour UN rapport lu en base — l'action et l'aperçu passent par ici. */
export async function peutSupprimerUnRapportTerrain(user: SessionUser, id: string): Promise<boolean> {
  const rapport = await prisma.fieldReport.findUnique({ where: { id }, select: { delegateId: true, companyId: true } });
  if (!rapport) return false;
  return peutSupprimerLeRapport(user, rapport, await entitePermisePourFiche(user.id, rapport.companyId));
}

/** Voit TOUS les rapports (managers + superviseur national). */
export function viewsAllReports(user: SessionUser): boolean {
  return managesReports(user) || hasRole(user, "NATIONAL_SALES");
}

/** Peut voir l'onglet « Overview » (graphes d'analyse) : Super Admin, ou un rôle que le Super
 *  Admin a explicitement autorisé (réglage `fieldReportsOverviewRoles`, configuré en Administration). */
export function canViewFieldReportsOverview(user: SessionUser, overviewRoles: string[]): boolean {
  return user.role === "SUPER_ADMIN" || overviewRoles.includes(user.role) || overviewRoles.includes(user.secondaryRole ?? "");
}

export interface FieldReportListItem {
  id: string;
  status: string;
  visitDate: string;
  doctorName: string | null;
  specialty: string | null;
  products: string | null;
  summary: string | null;
  delegateName: string | null;
  attachments: number;
  validatedAt: string | null;
  /** Le bouton « Supprimer » de la ligne — la même règle que l'action (`peutSupprimerLeRapport`). */
  canDelete: boolean;
}

export interface FieldReportAttachmentDTO { id: string; name: string; mime: string; size: number; isImage: boolean }

export interface FieldReportDetail {
  id: string;
  status: string;
  visitDate: string;
  transcript: string | null;
  hasAudio: boolean;
  doctorId: string | null;
  doctorIds: string[]; // médecins (annuaire) de la visite
  doctorName: string | null;
  institution: string | null;
  specialty: string | null;
  products: string | null;
  interest: string | null;
  objection: string | null;
  medicalQuestion: string | null;
  documentRequest: string | null;
  sponsoringRequest: string | null;
  careRequest: string | null;
  competitorInfo: string | null;
  opportunity: string | null;
  qualitySignal: string | null;
  nextAction: string | null;
  summary: string | null;
  aiNotes: string | null;
  delegateName: string | null;
  validatedAt: string | null;
  attachments: FieldReportAttachmentDTO[];
  canEdit: boolean;
  canDelete: boolean;
}

export async function getMyFieldReports(user: SessionUser): Promise<FieldReportListItem[]> {
  const reports = await prisma.fieldReport.findMany({
    where: { AND: [viewsAllReports(user) ? {} : { delegateId: user.id }, await platformScope(user.id)] },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { delegate: { select: { name: true } }, doctor: { select: { name: true } }, _count: { select: { attachments: true } } },
  });
  // La règle d'entité se calcule UNE fois pour la personne, pas une fois par ligne (§118.102b).
  const entitePermise = await predicatEntitePermise(user.id);
  return reports.map((r) => ({
    id: r.id, status: r.status, visitDate: r.visitDate.toISOString(),
    doctorName: r.doctor?.name ?? r.doctorName, specialty: r.specialty, products: r.products, summary: r.summary,
    delegateName: r.delegate?.name ?? null, attachments: r._count.attachments,
    validatedAt: r.validatedAt?.toISOString() ?? null,
    canDelete: peutSupprimerLeRapport(user, r, entitePermise(r.companyId)),
  }));
}

export async function getFieldReportDetail(user: SessionUser, id: string): Promise<FieldReportDetail | null> {
  const r = await prisma.fieldReport.findUnique({
    where: { id },
    include: { delegate: { select: { name: true } }, attachments: { orderBy: { createdAt: "asc" } } },
  });
  if (!r) return null;
  const canEdit = managesReports(user) || r.delegateId === user.id;
  // Le superviseur national peut CONSULTER sans éditer.
  if (!canEdit && !viewsAllReports(user)) return null;

  return {
    id: r.id, status: r.status, visitDate: r.visitDate.toISOString(),
    transcript: r.transcript, hasAudio: Boolean(r.audioBlobId),
    doctorId: r.doctorId, doctorIds: r.doctorIds.length ? r.doctorIds : (r.doctorId ? [r.doctorId] : []),
    doctorName: r.doctorName, institution: r.institution, specialty: r.specialty,
    products: r.products, interest: r.interest, objection: r.objection, medicalQuestion: r.medicalQuestion,
    documentRequest: r.documentRequest, sponsoringRequest: r.sponsoringRequest, careRequest: r.careRequest,
    competitorInfo: r.competitorInfo, opportunity: r.opportunity, qualitySignal: r.qualitySignal,
    nextAction: r.nextAction, summary: r.summary, aiNotes: r.aiNotes,
    delegateName: r.delegate?.name ?? null, validatedAt: r.validatedAt?.toISOString() ?? null,
    attachments: r.attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, isImage: a.mime.startsWith("image/") })),
    canEdit,
    canDelete: peutSupprimerLeRapport(user, r, await entitePermisePourFiche(user.id, r.companyId)),
  };
}

// ─────────── Overview (graphes d'analyse) — suivi des rapports terrain ───────────

export interface NamedCount { name: string; value: number }
export interface FieldReportsOverview {
  kpis: { reports: number; validated: number; doctors: number; institutions: number; delegates: number; specialties: number };
  byMonth: NamedCount[]; // 12 derniers mois (nombre de visites)
  byDoctor: NamedCount[]; // top médecins visités
  byInstitution: NamedCount[]; // top hôpitaux / établissements
  byDelegate: NamedCount[]; // visites par délégué
  bySpecialty: NamedCount[]; // visites par spécialité
  byStatus: NamedCount[]; // brouillon / validé / archivé
  topProducts: NamedCount[]; // produits les plus discutés
}

const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/**
 * Données d'analyse des rapports terrain (onglet « Overview ») : volumes de visites par
 * médecin / hôpital / délégué / spécialité, tendance sur 12 mois, répartition par statut et
 * produits les plus discutés. Calculé sur l'ensemble des rapports (cap raisonnable).
 */
export async function getFieldReportsOverview(): Promise<FieldReportsOverview> {
  const reports = await prisma.fieldReport.findMany({
    orderBy: { visitDate: "desc" },
    take: 5000,
    include: { delegate: { select: { name: true } }, doctor: { select: { name: true } } },
  });

  const top = (m: Map<string, number>, n: number): NamedCount[] =>
    [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, n);

  const byDoctor = new Map<string, number>();
  const byInstitution = new Map<string, number>();
  const byDelegate = new Map<string, number>();
  const bySpecialty = new Map<string, number>();
  const byProduct = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const institutionSet = new Set<string>();
  const doctorSet = new Set<string>();
  const specialtySet = new Set<string>();
  const delegateSet = new Set<string>();

  // 12 derniers mois (buckets ordonnés, du plus ancien au plus récent).
  const now = new Date();
  const monthKeys: string[] = [];
  const monthLabels = new Map<string, string>();
  const byMonth = new Map<string, number>();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthKeys.push(key);
    monthLabels.set(key, `${MONTHS_FR[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`);
    byMonth.set(key, 0);
  }

  const inc = (m: Map<string, number>, k: string | null | undefined) => {
    const key = (k ?? "").trim();
    if (key) m.set(key, (m.get(key) ?? 0) + 1);
  };

  let validated = 0;
  for (const r of reports) {
    const doctor = (r.doctor?.name ?? r.doctorName ?? "").trim();
    const institution = (r.institution ?? "").trim();
    const delegate = (r.delegate?.name ?? "").trim();
    const specialty = (r.specialty ?? "").trim();
    if (doctor) { inc(byDoctor, doctor); doctorSet.add(doctor.toLowerCase()); }
    if (institution) { inc(byInstitution, institution); institutionSet.add(institution.toLowerCase()); }
    if (delegate) { inc(byDelegate, delegate); delegateSet.add(delegate.toLowerCase()); }
    if (specialty) { inc(bySpecialty, specialty); specialtySet.add(specialty.toLowerCase()); }
    for (const p of (r.products ?? "").split(/[,;/]/).map((s) => s.trim()).filter(Boolean)) inc(byProduct, p);
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    if (r.status === "VALIDATED") validated++;
    const mk = `${r.visitDate.getFullYear()}-${r.visitDate.getMonth()}`;
    if (byMonth.has(mk)) byMonth.set(mk, (byMonth.get(mk) ?? 0) + 1);
  }

  return {
    kpis: { reports: reports.length, validated, doctors: doctorSet.size, institutions: institutionSet.size, delegates: delegateSet.size, specialties: specialtySet.size },
    byMonth: monthKeys.map((k) => ({ name: monthLabels.get(k)!, value: byMonth.get(k) ?? 0 })),
    byDoctor: top(byDoctor, 12),
    byInstitution: top(byInstitution, 12),
    byDelegate: top(byDelegate, 15),
    bySpecialty: top(bySpecialty, 10),
    byStatus: [...byStatus.entries()].map(([name, value]) => ({ name, value })),
    topProducts: top(byProduct, 10),
  };
}
