import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { regulatoryVisibleWhere } from "@/lib/queries/regulatory-rows";
import { recordAudit } from "@/lib/audit";
import { effectiveStage } from "@/lib/regulatory/manufacturing-stage";
import { dossierReceived } from "@/lib/regulatory/dossier-received";
import { buildRegulatoryWorkbook, regulatoryExportFilename, type RegulatoryExportRow } from "@/lib/regulatory/export";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * EXPORT EXCEL DES DOSSIERS REGULATORY — la fonction partagée par le bouton de l'écran (`/api/regulatory/export`) et
 * l'Assistant IA (lot K7, décision 0037).
 *
 * L'écran envoie la liste des dossiers **actuellement affichés** (`ids`), filtres compris : exporter autre chose que ce
 * qu'on a sous les yeux est la meilleure façon de faire circuler un classeur dont personne ne sait ce qu'il contient.
 * L'assistant, lui, donne les filtres de l'écran (statut, catégorie, gamme, responsable, recherche).
 *
 * La PORTÉE reste maîtresse : identifiants et filtres sont recroisés avec la clause de l'écran
 * (`regulatoryVisibleWhere` : portée par ligne, verrou, entité, GAMME). Un identifiant deviné ne sort donc rien — et
 * un dossier VERROUILLÉ reste invisible, ici comme ailleurs (§118.178).
 */
export interface OptionsExportRegulatory {
  ids?: string[] | null;
  statuts?: string[];
  categorie?: string | null;
  canal?: string | null;
  responsable?: string | null;
  recherche?: string | null;
}

export async function exporterSuiviRegulatory(user: CurrentUser, o: OptionsExportRegulatory = {}): Promise<ResultatExport> {
  // Le suivi des dossiers OU le pipeline (Direction, 08/10) : chacun exporte ce que SON écran montre — la clause
  // ci-dessous ne rend que les dossiers ouverts à qui a le suivi, que les verrouillés à qui a le pipeline.
  if (!userCan(user, "REGULATORY", "VIEW") && !userCan(user, "REGULATORY_PIPELINE", "VIEW")) return refusExport(403, "Non autorisé.");

  const filtres: Prisma.RegulatoryProductWhereInput[] = [];
  if (o.ids && o.ids.length > 0) filtres.push({ id: { in: o.ids } });
  if (o.statuts?.length) filtres.push({ status: { in: o.statuts as Prisma.EnumRegulatoryStatusFilter["in"] } });
  if (o.categorie) filtres.push({ category: o.categorie as Prisma.RegulatoryProductWhereInput["category"] });
  if (o.canal) filtres.push({ channel: o.canal as Prisma.RegulatoryProductWhereInput["channel"] });
  if (o.responsable) filtres.push({ responsible: { name: { contains: o.responsable, mode: "insensitive" } } });
  if (o.recherche) {
    const q = o.recherche;
    filtres.push({ OR: [
      { reference: { contains: q, mode: "insensitive" } }, { dci: { contains: q, mode: "insensitive" } },
      { brandName: { contains: q, mode: "insensitive" } }, { partnerLab: { contains: q, mode: "insensitive" } },
    ] });
  }

  const products = await prisma.regulatoryProduct.findMany({
    where: { AND: [await regulatoryVisibleWhere(user), ...filtres] },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    include: {
      responsible: { select: { name: true } },
      assistant: { select: { name: true } },
      supplier: { select: { name: true } },
      company: { select: { name: true, shortName: true } },
      variations: { select: { toStatus: true, status: true, decisionDate: true, createdAt: true } },
      steps: { select: { status: true } },
    },
  });

  // « DOSSIER REÇU » — le FAIT, pas une déclaration : une archive CTD a-t-elle été téléversée ? Une seule requête pour
  // tout le classeur ; la lire dossier par dossier ferait autant d'allers en base que de lignes exportées.
  const withArchive = await prisma.regulatoryDossier.findMany({
    where: { productId: { in: products.map((p) => p.id) }, versions: { some: { originalZipBlobId: { not: null } } } },
    select: { productId: true },
  });
  const recus = new Set(withArchive.map((d) => d.productId).filter((v): v is string => Boolean(v)));

  const rows: RegulatoryExportRow[] = products.map((p) => {
    const stage = effectiveStage(p.manufacturingStatus, p.variations);
    const done = p.steps.filter((s) => s.status === "DONE").length;
    return {
      reference: p.reference,
      dci: p.dci,
      molecules: Array.isArray(p.molecules) ? (p.molecules as string[]) : null,
      brandName: p.brandName,
      dosage: p.dosage,
      dosageUnit: p.dosageUnit,
      pharmaceuticalForm: p.pharmaceuticalForm,
      packaging: p.packaging,
      therapeuticClass: p.therapeuticClass,
      category: p.category,
      channel: p.channel,
      supplier: p.supplier?.name ?? null,
      partnerLab: p.partnerLab,
      countryOfOrigin: p.countryOfOrigin,
      manufacturingStatus: stage.status,
      manufacturingSource: stage.source,
      status: p.status,
      priority: p.priority,
      responsible: p.responsible?.name ?? null,
      assistant: p.assistant?.name ?? null,
      company: p.company?.shortName || p.company?.name || null,
      targetSubmissionDate: p.targetSubmissionDate?.toISOString() ?? null,
      targetDate: p.targetDate?.toISOString() ?? null,
      stepsDone: done,
      stepsTotal: p.steps.length,
      deHolder: p.deHolder,
      manufacturer: p.manufacturer,
      manufacturingVariation: p.manufacturingVariation,
      comments: p.comments,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      dossierReceived: dossierReceived({ hasArchive: recus.has(p.id) }),
    };
  });

  const buffer = await buildRegulatoryWorkbook(rows);
  await recordAudit({
    actorId: user.id, action: "EXPORT", module: "Regulatory",
    summary: `Export Excel de ${rows.length} dossier(s) réglementaire(s)`,
  });
  return exporte(buffer, regulatoryExportFilename(), MIME_XLSX, `${rows.length} dossier(s) réglementaire(s)`);
}
