import type { CurrentUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { loadPlanTournee } from "@/lib/queries/tour-schedule";
import { accesAuPlan, estJourOuvrePourTournee, type StatutPlan } from "@/lib/sfe/tournee";
import { jourIso } from "@/lib/sfe/grille-tournee";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { isManagerOfUser } from "@/lib/departments";
import { moneyEntityOf } from "@/lib/company";
import { nomDuPdf, type VisitePdf } from "@/lib/sfe/plan-pdf";
import { rendrePlanTourneePdf } from "@/lib/plan-tournee-pdf";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { choisirEntree } from "@/lib/segmentation/lettre-requise";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_PDF, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * LE PDF DU PLAN DE TOURNÉE (Direction, 07/10 : « exportable une fois confirmé, en PDF très clean ») — partagé par
 * `/api/medical/plan-de-tournee/[id]/pdf` et l'Assistant IA (lot K7, décision 0037).
 *
 * La porte est CELLE DE LA PAGE (`accesAuPlan` : le KAM, son validateur, le N+2, sa chaîne, une vue globale, et qui
 * remplace l'un d'eux) — un PDF n'ouvre pas plus que l'écran. Et seulement pour un plan VALIDÉ au moins une fois : un
 * brouillon n'est pas un engagement qu'on imprime. L'assistant désigne le plan par le KAM (son nom ; la personne
 * elle-même par défaut) et le mois (AAAA-MM ; le plus récent sinon).
 */
export interface DesignationPlan {
  plan?: string | null;
  kam?: string | null;
  mois?: string | null;
}

async function planDesigne(user: CurrentUser, d: DesignationPlan): Promise<string | null> {
  if (d.plan && estIdentifiant(d.plan)) return d.plan;
  const kam = d.kam?.trim()
    ? (await prisma.user.findFirst({ where: { name: { contains: d.kam.trim(), mode: "insensitive" } }, select: { id: true } }))?.id
    : user.id;
  if (!kam) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(d.mois ?? "");
  const dans = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)) : null;
  const p = await prisma.tourPlan.findFirst({
    where: { repId: kam, ...(dans ? { periodStart: { lte: dans }, periodEnd: { gte: dans } } : {}) },
    orderBy: { periodStart: "desc" }, select: { id: true },
  });
  return p?.id ?? null;
}

export async function exporterPlanTourneePdf(user: CurrentUser, designation: DesignationPlan): Promise<ResultatExport> {
  if (!userCan(user, "MEDICAL", "VIEW")) return refusExport(403, "Non autorisé.");
  const id = await planDesigne(user, designation);
  const plan = id ? await loadPlanTournee(id) : null;
  if (!plan) return refusExport(404, "Plan introuvable.");

  const agitPour = await standInForUserIds(user.id);
  const acces = accesAuPlan({
    userId: user.id, vueGlobale: hasGlobalView(user), repId: plan.repId,
    reviewerId: plan.reviewerId, escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan,
    chaineDuKam: plan.repId === user.id || plan.reviewerId === user.id || plan.escalatedToId === user.id || hasGlobalView(user)
      ? []
      : (await isManagerOfUser(user.id, plan.repId)) ? [user.id] : [],
    agitPour,
  });
  // Hors de la règle, la même réponse que pour un plan qui n'existe pas.
  if (!acces.voir) return refusExport(404, "Plan introuvable.");
  if (!plan.dejaValide) return refusExport(409, "Le PDF se télécharge une fois le plan validé.");

  const [decision, visites, societeId] = await Promise.all([
    prisma.tourPlan.findUnique({ where: { id: plan.id }, select: { decidedAt: true, decidedBy: { select: { name: true } } } }),
    prisma.medicalVisit.findMany({
      where: { tourPlanId: plan.id, doctorId: { not: null } },
      select: { date: true, status: true, doctor: { select: { id: true, name: true, specialty: true, institution: true, potential: true } } },
    }),
    moneyEntityOf(plan.repId),
  ]);
  // LA LETTRE DE SEGMENTATION de chaque praticien (Direction, 07/10) — stratégie de la BU du KAM d'abord.
  const [lettres, profil] = await Promise.all([
    lettresDesPraticiens([...new Set(visites.flatMap((v) => (v.doctor ? [v.doctor.id] : [])))]),
    prisma.salesRepProfile.findUnique({ where: { repId: plan.repId }, select: { businessUnitId: true } }),
  ]);
  const societe = societeId ? await prisma.company.findUnique({ where: { id: societeId }, select: { name: true } }) : null;

  const joursOuvres: string[] = [];
  for (const d = new Date(plan.periodStart); d <= plan.periodEnd; d.setDate(d.getDate() + 1)) {
    if (estJourOuvrePourTournee(d)) joursOuvres.push(jourIso(d));
  }
  const lignes: VisitePdf[] = visites.filter((v) => v.doctor).map((v) => ({
    jour: jourIso(v.date),
    nom: v.doctor!.name,
    detail: [v.doctor!.specialty, v.doctor!.institution].filter(Boolean).join(" · "),
    potentiel: v.doctor!.potential ? String(v.doctor!.potential) : null,
    lettre: choisirEntree(lettres.get(v.doctor!.id), profil?.businessUnitId ?? null)?.lettre ?? null,
    etat: v.status === "CANCELLED" || v.status === "POSTPONED" ? "NON_TENUE" : v.status === "COMPLETED" ? "FAITE" : "PREVUE",
  }));
  const memeMois = plan.periodStart.getMonth() === plan.periodEnd.getMonth() && plan.periodStart.getFullYear() === plan.periodEnd.getFullYear();
  const periode = memeMois
    ? plan.periodStart.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })
    : `${plan.periodStart.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} au ${plan.periodEnd.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`;

  const pdf = await rendrePlanTourneePdf({
    societe: societe?.name ?? "Adventum Pharma",
    kam: plan.repName,
    periode,
    joursOuvres,
    visites: lignes,
    validation: decision?.decidedAt ? { le: decision.decidedAt, par: decision.decidedBy?.name ?? null } : null,
    valideur: decision?.decidedBy?.name ?? plan.reviewerName,
    genereLe: new Date(),
  });
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Promotion médicale", entityId: plan.id, summary: `PDF du plan de tournée — ${plan.repName}, ${periode}` });
  return exporte(pdf, nomDuPdf(plan.repName, periode), MIME_PDF, `le plan de tournée de ${plan.repName} — ${periode} (${lignes.length} visite(s))`);
}
