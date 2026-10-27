import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan, clausePanelDuKam, type SessionUser } from "@/lib/rbac";
import { clausePraticiensVisibles } from "@/lib/queries/annuaires";
import { chargerStrategie, chargerPanel } from "@/lib/segmentation/service";
import { synthese } from "@/lib/segmentation/moteur";
import type { EtatProduit } from "@/lib/segmentation/regles";
import { calculerAffinites, lireConfig, lignesDuMarche } from "@/modules/consommation/api";

/**
 * LES VUES 360° (cahier des charges §11-13) — un objet, tout ce que l'entreprise en sait, sans rien ressaisir :
 * chaque section se LIT par les clés étrangères (`productId`, `businessUnitId`, `doctorId`, `institutionId`) et
 * n'apparaît qu'à qui a le droit du module qu'elle montre. Façade (`queries/`) : elle traverse les domaines.
 */

export { SECTIONS_360, sections360, type Section360 } from "@/lib/vues-360-acces";

/** Les segments d'un produit dans chaque stratégie qui le classe — calculés par le même moteur que le Studio. */
export async function segmentationDuProduit(productId: string): Promise<{ strategieId: string; strategie: string; businessUnit: string; rang: number; repartition: Record<EtatProduit, number>; h: number }[]> {
  const liens = await prisma.segmentationStrategieProduit.findMany({ where: { productId, jusqua: null, strategie: { statut: "ACTIVE" } }, select: { strategieId: true, rang: true } });
  const out = [];
  for (const l of liens) {
    const s = await chargerStrategie(l.strategieId);
    if (!s?.regle?.regles) continue;
    const panel = await chargerPanel(s);
    const syn = synthese(panel.flatMap((p) => (p.resultat ? [p.resultat] : [])));
    out.push({ strategieId: s.id, strategie: s.nom, businessUnit: s.businessUnit.name, rang: l.rang, repartition: syn.parProduit[productId] ?? { NON_CIBLE: 0, EN_ATTENTE: 0, A: 0, B: 0, C: 0, D: 0 }, h: syn.h });
  }
  return out;
}

/** La consommation d'un produit par établissement (imports validés) et son affinité quand elle est réglée. */
export async function consommationDuProduit(productId: string): Promise<{ parEtablissement: { institutionId: string; nom: string; quantite: number; unite: string | null; affinite: number | null }[]; periode: string | null; reglee: boolean }> {
  const g = await prisma.consommationLigne.groupBy({
    by: ["institutionId", "unite"], where: { productId, statut: "OK", import: { statut: "VALIDE" }, institutionId: { not: null } },
    _sum: { quantite: true }, orderBy: { _sum: { quantite: "desc" } }, take: 30,
  });
  const cfgRow = await prisma.affiniteConfig.findUnique({ where: { productId } });
  const aff = new Map<string, number>();
  let periode: string | null = null;
  if (cfgRow) {
    const cfg = lireConfig(cfgRow);
    const r = calculerAffinites(await lignesDuMarche(cfg), cfg);
    periode = r.fenetre?.libelle ?? null;
    for (const a of r.parEtablissement) aff.set(a.institutionId, a.valeur);
  }
  const noms = new Map((await prisma.medicalInstitution.findMany({ where: { id: { in: g.map((x) => x.institutionId!) } }, select: { id: true, name: true } })).map((n) => [n.id, n.name]));
  return {
    parEtablissement: g.map((x) => ({ institutionId: x.institutionId!, nom: noms.get(x.institutionId!) ?? "—", quantite: Number(x._sum.quantite ?? 0), unite: x.unite, affinite: aff.get(x.institutionId!) ?? null })),
    periode, reglee: !!cfgRow,
  };
}

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

