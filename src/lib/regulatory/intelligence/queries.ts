import { prisma } from "@/lib/prisma";

/**
 * Lectures du Regulatory Intelligence OS — **toujours** filtrées par organisation
 * (`companyId`) pour l'isolation multi-locataire. Le `companyId` passé est déjà résolu
 * ET vérifié (feature flag) par la page appelante.
 */

export async function listDossiers(companyId: string) {
  const dossiers = await prisma.regulatoryDossier.findMany({
    where: { companyId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, reference: true, title: true, procedureType: true, status: true,
      productId: true, createdAt: true, updatedAt: true,
      versions: {
        orderBy: { versionNo: "desc" },
        take: 1,
        select: { id: true, versionNo: true, fileCount: true, totalBytes: true, createdAt: true },
      },
      _count: { select: { versions: true } },
    },
  });
  return dossiers;
}

export async function getDossier(companyId: string, dossierId: string) {
  return prisma.regulatoryDossier.findFirst({
    where: { id: dossierId, companyId },
    select: {
      id: true, companyId: true, reference: true, title: true, procedureType: true,
      status: true, productId: true, createdById: true, createdAt: true, updatedAt: true,
    },
  });
}

/** Versions d'un dossier (récentes d'abord), avec compteurs de sécurité du manifeste. */
export async function listVersions(dossierId: string) {
  const versions = await prisma.regulatoryDossierVersion.findMany({
    where: { dossierId },
    orderBy: { versionNo: "desc" },
    select: {
      id: true, versionNo: true, label: true, fileCount: true, totalBytes: true,
      originalZipBlobId: true, originalSha256: true, createdAt: true,
      documents: {
        select: { securityStatus: true, extractionStatus: true },
      },
    },
  });
  return versions.map((v) => {
    const safe = v.documents.filter((d) => d.securityStatus === "SAFE").length;
    const suspicious = v.documents.filter((d) => d.securityStatus === "SUSPICIOUS").length;
    const blocked = v.documents.filter(
      (d) => d.securityStatus.startsWith("BLOCKED") || d.securityStatus === "CORRUPTED",
    ).length;
    const { documents, ...rest } = v;
    void documents;
    return { ...rest, counts: { total: v.documents.length, safe, suspicious, blocked } };
  });
}

/** Manifeste (documents) d'une version — l'inventaire fichier par fichier. */
export async function listVersionDocuments(dossierVersionId: string) {
  return prisma.regulatoryDocument.findMany({
    where: { dossierVersionId },
    orderBy: [{ securityStatus: "asc" }, { originalPath: "asc" }],
    select: {
      id: true, kind: true, originalPath: true, originalFilename: true, suggestedFilename: true,
      approvedFilename: true, ext: true, sizeBytes: true, sha256: true, compressionRatio: true,
      securityStatus: true, extractionStatus: true, blobId: true, detectedMimeType: true,
      ctdModule: true, ctdSection: true, containedSections: true, ctdConfidence: true, classificationMethod: true,
    },
  });
}

export async function getDocument(companyId: string, documentId: string) {
  return prisma.regulatoryDocument.findFirst({
    where: { id: documentId, dossierVersion: { dossier: { companyId } } },
    select: {
      id: true, originalFilename: true, ext: true, blobId: true, sizeBytes: true,
      securityStatus: true, dossierVersion: { select: { dossierId: true } },
    },
  });
}

/** Métadonnées d'une version (pour le téléchargement de l'archive originale). */
export async function getVersionForCompany(companyId: string, dossierVersionId: string) {
  return prisma.regulatoryDossierVersion.findFirst({
    where: { id: dossierVersionId, dossier: { companyId } },
    select: { id: true, versionNo: true, originalZipBlobId: true, dossier: { select: { id: true, reference: true } } },
  });
}

export async function getAssessment(dossierVersionId: string) {
  return prisma.regulatoryAssessment.findUnique({ where: { dossierVersionId } });
}

export async function listFindings(dossierVersionId: string) {
  return prisma.regulatoryFinding.findMany({
    where: { dossierVersionId },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
    select: {
      id: true, code: true, severity: true, category: true, title: true, detail: true,
      evidence: true, sectionCode: true, source: true, status: true, blocker: true, draft: true, createdAt: true,
      // De quoi DÉFENDRE le constat : la règle appliquée, la pièce (document, page, extrait),
      // ce qui se contredit, quoi faire, et si l'ANPP nous l'a déjà reproché.
      ruleRef: true, confidence: true, documentId: true, page: true, excerpt: true,
      conflictingValues: true, recommendation: true, similarReserveIds: true, reserveRisk: true,
    },
  });
}

/**
 * Noms de fichiers des documents visés par des constats, chargés EN UNE FOIS.
 * `RegulatoryFinding.documentId` est un scalaire (pas de relation Prisma) : on résout ici.
 */
export async function documentNamesByIds(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))].slice(0, 500);
  if (unique.length === 0) return new Map<string, string>();
  const rows = await prisma.regulatoryDocument.findMany({
    where: { id: { in: unique } },
    select: { id: true, originalFilename: true },
  });
  return new Map(rows.map((d) => [d.id, d.originalFilename]));
}

/**
 * Les réserves ANPP rattachées à des constats, pour les afficher sans une requête par constat.
 * Rendu sous forme de dictionnaire indexé par identifiant.
 */
export async function reservesByIds(ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 200);
  if (unique.length === 0) return new Map<string, { id: string; verbatim: string; status: string; response: string | null; ctdSection: string | null }>();
  const rows = await prisma.anppReserve.findMany({
    where: { id: { in: unique } },
    select: { id: true, verbatim: true, status: true, response: true, ctdSection: true },
  });
  return new Map(rows.map((r) => [r.id, { ...r, status: String(r.status) }]));
}

export async function listFacts(dossierVersionId: string) {
  return prisma.regulatoryFact.findMany({
    where: { dossierVersionId },
    orderBy: [{ hasConflict: "desc" }, { factKey: "asc" }],
    select: {
      id: true, factKey: true, label: true, value: true, unit: true, status: true, hasConflict: true,
      approvedValue: true, approvedAt: true,
      occurrences: {
        orderBy: { confidence: "desc" },
        select: { id: true, documentId: true, sectionCode: true, rawValue: true, extract: true, confidence: true, method: true, humanStatus: true },
      },
    },
  });
}

export async function listConflicts(dossierVersionId: string) {
  return prisma.regulatoryConflict.findMany({
    where: { dossierVersionId },
    orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
    select: { id: true, factKey: true, label: true, severity: true, status: true, values: true, proposedAction: true, finalValue: true, resolutionNote: true },
  });
}

/**
 * Journal d'audit Regulatory TRANSVERSE (tous dossiers). Sur la fiche d'un dossier, le journal
 * répondait à « qu'est-il arrivé à celui-ci » ; la question de gouvernance est « qui a fait quoi
 * sur le module », et elle ne se répond qu'en regardant l'ensemble. D'où cette vue, en
 * administration. `companyId` cloisonne par entité ; absent, on regarde tout.
 */
export async function listRegulatoryAudit(opts: { companyId?: string | null; take?: number } = {}) {
  return prisma.regulatoryAuditLog.findMany({
    where: opts.companyId ? { companyId: opts.companyId } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.take ?? 200, 1), 500),
    select: {
      id: true, action: true, detail: true, actorId: true, createdAt: true,
      dossier: { select: { id: true, reference: true, title: true } },
    },
  });
}
