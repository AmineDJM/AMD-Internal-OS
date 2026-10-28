import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { loadPlanTournee } from "@/lib/queries/tour-schedule";
import { accesAuPlan, estJourOuvrePourTournee, type StatutPlan } from "@/lib/sfe/tournee";
import { jourIso } from "@/lib/sfe/grille-tournee";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { isManagerOfUser } from "@/lib/departments";
import { moneyEntityOf } from "@/lib/company";
import { nomDuPdf, type VisitePdf } from "@/lib/sfe/plan-pdf";
import { rendrePlanTourneePdf } from "@/lib/plan-tournee-pdf";
import { contentDisposition } from "@/lib/http/content-disposition";
import { lettresDesPraticiens } from "@/lib/segmentation/lettres-service";
import { choisirEntree } from "@/lib/segmentation/lettre-requise";

export const dynamic = "force-dynamic";

/**
 * LE PDF DU PLAN DE TOURNÉE (Direction, 07/10 : « exportable une fois confirmé, en PDF très clean »).
 *
 * La porte est CELLE DE LA PAGE (`accesAuPlan`, mêmes faits : le KAM, son validateur, le N+2, sa chaîne, une vue globale,
 * et qui remplace l'un d'eux) — un PDF n'ouvre pas plus que l'écran. Et seulement pour un plan VALIDÉ au moins une fois :
 * un brouillon n'est pas un engagement qu'on imprime.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, "MEDICAL", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  const plan = await loadPlanTournee(params.id);
  if (!plan) return NextResponse.json({ error: "Plan introuvable." }, { status: 404 });

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
  if (!acces.voir) return NextResponse.json({ error: "Plan introuvable." }, { status: 404 });
  if (!plan.dejaValide) return NextResponse.json({ error: "Le PDF se télécharge une fois le plan validé." }, { status: 409 });

  const [decision, visites, societeId] = await Promise.all([
    prisma.tourPlan.findUnique({ where: { id: plan.id }, select: { decidedAt: true, decidedBy: { select: { name: true } } } }),
    prisma.medicalVisit.findMany({
      where: { tourPlanId: plan.id, doctorId: { not: null } },
      select: { date: true, status: true, doctor: { select: { id: true, name: true, specialty: true, institution: true, potential: true } } },
    }),
    moneyEntityOf(plan.repId),
  ]);
  // LA LETTRE DE SEGMENTATION de chaque praticien (Direction, 07/10) — stratégie de la BU du KAM d'abord ; sans lettre, le
  // potentiel reste le repère du liseré.
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
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(nomDuPdf(plan.repName, periode), "inline"),
      "Cache-Control": "private, no-store",
    },
  });
}
