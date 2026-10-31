import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMarketResearch, getPresentationVersionForExport } from "@/lib/queries/market-research";
import { buildPresentationPptx, presentationFilename } from "@/lib/market-presentation-pptx";
import type { PresentationAnalysis } from "@/lib/market-presentation";
import { buildResearchWorkbook, researchExportFilename } from "@/lib/market-research-export";
import { estIdentifiant } from "./filtres";
import { exporte, MIME_PPTX, MIME_XLSX, refusExport, type ResultatExport } from "./types";

/**
 * Export Excel d'une étude de marché (Business Development) au format exact du modèle — partagé par
 * `/api/market-research/[id]/export` et l'Assistant IA (lot K7, décision 0037), qui la désigne par son titre.
 */
export async function exporterEtudeDeMarche(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "BUSINESS_DEVELOPMENT", "VIEW")) return refusExport(403, "Non autorisé.");
  const t = designation.trim();
  const id = !t ? null : estIdentifiant(t) ? t : (await prisma.marketResearch.findFirst({
    where: { title: { contains: t, mode: "insensitive" } }, orderBy: { createdAt: "desc" }, select: { id: true },
  }))?.id ?? null;
  const d = id ? await getMarketResearch(id) : null;
  if (!d) return refusExport(404, "Étude introuvable.");
  const buffer = buildResearchWorkbook(d);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Business Development", summary: `Export Excel étude « ${d.title} »` });
  return exporte(buffer, researchExportFilename(d.title), MIME_XLSX, `l'étude de marché « ${d.title} »`);
}

/**
 * LA PRÉSENTATION D'UNE ÉTUDE (.pptx), (re)construite depuis l'analyse stockée — partagée par
 * `/api/market-research/presentation/[versionId]` et l'Assistant IA, qui la désigne par le titre de l'étude ou de la
 * présentation (la dernière version).
 */
export async function exporterPresentationEtude(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "BUSINESS_DEVELOPMENT", "VIEW")) return refusExport(403, "Non autorisé.");
  const t = designation.trim();
  const versionId = !t ? null : estIdentifiant(t) ? t : (await prisma.marketResearchPresentationVersion.findFirst({
    where: { presentation: { OR: [{ title: { contains: t, mode: "insensitive" } }, { research: { title: { contains: t, mode: "insensitive" } } }] } },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }], select: { id: true },
  }))?.id ?? null;
  const v = versionId ? await getPresentationVersionForExport(versionId) : null;
  if (!v) return refusExport(404, "Présentation introuvable.");
  const buffer = await buildPresentationPptx(v.research, v.analysis as PresentationAnalysis, {
    presentationTitle: v.presentationTitle, version: v.version, generatedAt: v.createdAt,
  });
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Business Development", summary: `Téléchargement présentation « ${v.presentationTitle} » (v${v.version})` });
  return exporte(buffer, presentationFilename(v.presentationTitle, v.version), MIME_PPTX, `la présentation « ${v.presentationTitle} » (v${v.version})`);
}
