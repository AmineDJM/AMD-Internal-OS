import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { buildTenderWorkbook, tenderExportFilename } from "@/lib/pch-tender-export";
import { recordAudit } from "@/lib/audit";
import { canAccessEntity } from "@/lib/entity-access";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * EXPORT EXCEL d'un appel d'offres PCH — le tableau de réponse (produits demandés, analyse de marché). Partagé par
 * `/api/pch/export` et l'Assistant IA (lot K7, décision 0037).
 *
 * LA MÊME PORTE QUE LA FICHE (§118.184 — audit 360°, S11) : hors de portée, la même réponse qu'un marché qui
 * n'existe pas. L'assistant désigne l'appel d'offres par sa référence : elle se résout, puis la porte se rejuge.
 */
export async function exporterAppelDOffres(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "PCH", "VIEW")) return refusExport(403, "Non autorisé.");
  const d = designation.trim();
  if (!d) return refusExport(400, "Appel d'offres non précisé.");
  const id = estIdentifiant(d) ? d : (await prisma.pchTender.findFirst({
    where: { OR: [{ reference: { equals: d, mode: "insensitive" } }, { title: { contains: d, mode: "insensitive" } }] },
    orderBy: { createdAt: "desc" }, select: { id: true },
  }))?.id;
  if (!id || !(await canAccessEntity(user, "PCH_TENDER", id, "VIEW"))) return refusExport(404, "Appel d'offres introuvable.");

  const tender = await prisma.pchTender.findUnique({
    where: { id },
    select: { reference: true, title: true, client: true, awardDate: true, lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!tender) return refusExport(404, "Appel d'offres introuvable.");
  const n = (v: Parameters<typeof toNumber>[0] | null) => (v == null ? null : toNumber(v));
  const buffer = buildTenderWorkbook(
    { reference: tender.reference, title: tender.title ?? "", buyer: tender.client, submissionDeadline: tender.awardDate?.toISOString() ?? null },
    tender.lines.map((l) => ({
      designation: l.designation, dci: l.dci, dosage: l.dosage, form: l.form, unitLabel: l.unitLabel,
      quantityUnits: l.quantityUnits, unitsPerBox: l.unitsPerBox,
      refPriceDzd: n(l.refPriceDzd), refPriceSource: l.refPriceSource, haveProduct: l.haveProduct, ourProduct: l.ourProduct,
      unitPriceDzd: n(l.unitPriceDzd), registeredNomenclature: l.registeredNomenclature, registeredOurs: l.registeredOurs,
      status: l.status, marketEstimateDzd: n(l.marketEstimateDzd), competitorCount: l.competitorCount, marketOrigin: l.marketOrigin,
      marketVillePct: n(l.marketVillePct), marketHopitalPct: n(l.marketHopitalPct), marketHhi: l.marketHhi,
      competitorsTop: l.competitorsTop, note: l.note,
    })),
  );
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "PCH", summary: `Export Excel appel d'offres « ${tender.reference} » (${tender.lines.length} produit(s))` });
  return exporte(buffer, tenderExportFilename(tender.reference), MIME_XLSX, `l'appel d'offres « ${tender.reference} » — ${tender.lines.length} produit(s)`);
}
