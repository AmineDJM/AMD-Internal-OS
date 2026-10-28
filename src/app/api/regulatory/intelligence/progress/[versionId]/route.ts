import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { regCan, resolveRegCompanyIdFor } from "@/lib/regulatory/intelligence/access";
import { getAnalysisProgress } from "@/lib/regulatory/intelligence/progress/query";

/**
 * PROGRESSION VIVANTE d'une version de dossier — interrogée toutes les quelques secondes par la
 * carte cliente. Org-scopée + permission de consultation. Renvoie l'état RÉEL du pipeline
 * (étape, %, temps restant) — jamais une animation décorative.
 *
 * Effet de bord VOULU : chaque appel réveille aussi le planificateur (débouncé à 1×/min). Un
 * pharmacien qui REGARDE sa barre est, de fait, un client actif — donc l'analyse avance pendant
 * qu'il l'observe, sans qu'il ait besoin de rien faire d'autre.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, props: { params: Promise<{ versionId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!regCan(user, "regulatory.workspace.view")) return NextResponse.json({ error: "Accès refusé." }, { status: 403 });

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return NextResponse.json({ error: "Module non activé." }, { status: 403 });

  // Vérifie l'appartenance de la version au périmètre de l'organisation — jamais de fuite.
  const version = await prisma.regulatoryDossierVersion.findFirst({
    where: { id: params.versionId, dossier: { companyId } },
    select: { id: true, dossier: { select: { status: true } } },
  });
  if (!version) return NextResponse.json({ error: "Version introuvable." }, { status: 404 });

  // Réveille le pipeline (débouncé) : regarder la barre suffit à faire avancer l'analyse.
  const { runScheduledJobs } = await import("@/lib/scheduled");
  void runScheduledJobs();

  const progress = await getAnalysisProgress(version.id, version.dossier.status);
  return NextResponse.json(progress, { headers: { "Cache-Control": "private, no-store" } });
}
