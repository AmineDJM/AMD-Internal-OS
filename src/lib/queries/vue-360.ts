import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, clausePanelDuKam, type SessionUser } from "@/lib/rbac";
import { clausePraticiensVisibles } from "@/lib/queries/annuaires";
import { chargerStrategie, chargerPanel } from "@/lib/segmentation/service";

/**
 * LES VUES 360° (cahier des charges §11-13) — un objet, tout ce que l'entreprise en sait, sans rien ressaisir :
 * chaque section se LIT par les clés étrangères (`productId`, `businessUnitId`, `doctorId`, `institutionId`) et
 * n'apparaît qu'à qui a le droit du module qu'elle montre. Façade (`queries/`) : elle traverse les domaines.
 */

export { sections360 } from "@/lib/vues-360-acces";

/** Un praticien est-il visible pour cette personne (annuaire de la Promotion médicale, ou panel de segmentation) ? */
export async function praticienVisible(user: SessionUser, doctorId: string): Promise<boolean> {
  const ors: Prisma.MedicalDoctorWhereInput[] = [];
  // La MÊME clause que l'annuaire et la recherche : portée du module, entité, annuaires nommés fermés (§118.177).
  if (userCan(user, "MEDICAL", "VIEW")) ors.push(await clausePraticiensVisibles(user, { entier: false }));
  if (userCan(user, "SEGMENTATION", "VIEW")) ors.push(user.access.modules.get("SEGMENTATION")?.scope === "ALL" ? {} : clausePanelDuKam(user.id));
  if (!ors.length) return false;
  return (await prisma.medicalDoctor.count({ where: { AND: [{ id: doctorId }, { OR: ors }] } })) > 0;
}

/** Le praticien dans chaque stratégie : segments par produit, H, priorité, visites, et le pourquoi. */
export async function segmentationDuPraticien(doctorId: string) {
  const fiches = await prisma.segmentationFiche.findMany({ where: { doctorId, retireeLe: null, strategie: { statut: "ACTIVE" } }, select: { strategieId: true } });
  const out = [];
  for (const f of fiches) {
    const s = await chargerStrategie(f.strategieId);
    if (!s) continue;
    const panel = await chargerPanel(s, { id: doctorId });
    out.push({ strategieId: s.id, strategie: s.nom, businessUnit: s.businessUnit.name, produits: s.produits, ligne: panel[0] ?? null, regles: !!s.regle?.regles });
  }
  return out;
}
