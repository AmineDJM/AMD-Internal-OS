import type { CurrentUser } from "@/lib/session";
import { userCan, peutAnnuaire, annuaireOuvertParConsole } from "@/lib/rbac";
import { clausePraticiensVisibles } from "@/lib/queries/annuaires";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { buildAnnuaireWorkbook } from "@/lib/medical/directory-workbook";
import { directoryExportFilename } from "@/lib/medical/directory-sheet";
import { ligneAnnuaire } from "@/lib/medical/directory-grid";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * EXPORT DE L'ANNUAIRE EN CLASSEUR — exactement les colonnes de l'écran. Partagé par `/api/medical/annuaire/export` et
 * l'Assistant IA (lot K7, décision 0037).
 *
 * La PORTÉE gouverne : un délégué exporte ses praticiens, pas ceux des autres — la même clause que l'écran
 * (`clausePraticiensVisibles`). LE GRADE : « medecins » (tout grade sauf pharmacien) ou « pharmaciens » quand l'onglet
 * d'un annuaire exporte ce qu'il montre ; absent = toute la feuille. LA PORTE est celle de l'écran qui exporte
 * (§118.147) : l'onglet d'un annuaire lit l'accès par annuaire, la feuille entière lit le module.
 */
export async function exporterAnnuaire(user: CurrentUser, grade: string | null = null): Promise<ResultatExport> {
  const cle = grade === "pharmaciens" ? "PHARMACIENS" : grade === "medecins" ? "MEDECINS" : null;
  const voit = cle ? peutAnnuaire(user, cle, "VIEW") : userCan(user, "MEDICAL", "VIEW");
  if (!voit) return refusExport(403, "Non autorisé.");
  const gradeWhere = grade === "pharmaciens"
    ? { title: "PHARMACIEN" as const }
    : grade === "medecins" ? { title: { not: "PHARMACIEN" as const } } : {};
  // Un annuaire ouvert par la console s'ouvre en entier — la même portée que l'écran.
  const entier = cle ? annuaireOuvertParConsole(user, cle, "VIEW") : false;
  const doctors = await prisma.medicalDoctor.findMany({
    // LES CLAUSES SE COMPOSENT EN `AND` : la portée d'un délégué et l'exclusion des annuaires fermés sont deux `OR`.
    where: { AND: [await clausePraticiensVisibles(user, { entier }), gradeWhere] },
    orderBy: [{ name: "asc" }],
    include: { specialtyRef: { select: { name: true } }, institutionRef: { select: { name: true } }, serviceRef: { select: { name: true } } },
  });
  // LA MÊME TRADUCTION QUE LA FEUILLE (`ligneAnnuaire`, §118.5).
  const rows = doctors.map(ligneAnnuaire);
  const buffer = buildAnnuaireWorkbook(rows);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Promotion médicale", summary: `Export de l'annuaire — ${rows.length} praticien(s)` });
  return exporte(buffer, directoryExportFilename(), MIME_XLSX, `l'annuaire — ${rows.length} praticien(s)`);
}
