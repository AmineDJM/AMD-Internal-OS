import * as XLSX from "xlsx";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { DOCTOR_TITLE } from "@/lib/labels";
import { chargerStrategie, chargerPanel } from "@/lib/segmentation/service";
import { droitsSegmentation, porteeSegmentation } from "@/lib/segmentation/droits";
import { STATUT_LABELS, affiniteAffichee } from "@/lib/segmentation/regles";
import { enteteQ1, enteteQ2, libelleLettre } from "@/lib/segmentation/charge";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * L'EXPORT DE LA SEGMENTATION D'UNE BU (Direction, 07/10) — exactement les colonnes du classeur : Secteur, CDR,
 * Spécialité, Nom, Prénom, Grade, Statut, Q1, Q2, %, Potentiel. Les lignes sont celles que la personne voit (son panel
 * pour un KAM), la lettre celle qui s'applique (forcée ou calculée). Partagé par `/api/segmentation/export` et
 * l'Assistant IA (lot K7, décision 0037) — qui désigne la stratégie par son nom ou celui de sa BU (la stratégie ACTIVE).
 */
export async function exporterSegmentation(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!droitsSegmentation(user).voir) return refusExport(403, "Non autorisé.");
  const d = designation.trim();
  const id = !d ? "" : estIdentifiant(d) ? d : (await prisma.segmentationStrategie.findFirst({
    where: { OR: [{ nom: { contains: d, mode: "insensitive" } }, { businessUnit: { name: { contains: d, mode: "insensitive" } } }] },
    orderBy: [{ statut: "asc" }, { updatedAt: "desc" }],
    select: { id: true },
  }))?.id ?? "";
  const s = id ? await chargerStrategie(id) : null;
  if (!s) return refusExport(404, "Stratégie introuvable.");
  const panel = await chargerPanel(s, porteeSegmentation(user));
  const p1 = s.produits[0];
  const regleP1 = s.regle?.regles?.produits.find((p) => p.productId === p1?.productId);
  const metrique = regleP1?.metrique ?? null;
  const methode = regleP1?.methodeAffinite ?? "SUR_10";
  const lignes: (string | number | null)[][] = [
    ["Secteur", "CDR", "Spécialité", "Nom", "Prénom", "Grade", "Statut", enteteQ1(metrique), enteteQ2(p1?.nom), "%", "Potentiel"],
    ...panel.map((l) => [
      l.secteurNom ?? "Sans secteur", l.etablissement ?? "", l.specialite ?? "", l.nomFamille, l.prenom ?? "",
      DOCTOR_TITLE[l.grade] ?? l.grade, l.statut ? STATUT_LABELS[l.statut] : "", l.q1, l.q2,
      ((a) => (a === null ? null : Math.round(a * 1000) / 10))(affiniteAffichee(l.q1, l.q2, methode)),
      l.resultat ? libelleLettre(l.resultat.lettre) : "",
    ]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lignes), "Segmentation");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const nom = `segmentation-${s.businessUnit.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase()}.xlsx`;
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Segmentation", summary: `Export de la segmentation « ${s.businessUnit.name} » — ${panel.length} praticien(s)` });
  return exporte(buffer, nom, MIME_XLSX, `la segmentation de la BU ${s.businessUnit.name} — ${panel.length} praticien(s)`);
}
