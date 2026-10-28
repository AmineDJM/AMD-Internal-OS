import { prisma } from "@/lib/prisma";
import {
  refusCategoriePourDemande,
  type CategoriePourControle, type DemandePourControle, type NatureDemandeAdPro, type NoeudCategorieControle,
} from "@/lib/ad-pro/categorie-budgetaire";

/**
 * LA LECTURE derrière `categorie-budgetaire.ts` : la catégorie (avec ses parentes et son enveloppe) et
 * la demande (nature, date, Business Unit). La règle, elle, reste pure et testée à part.
 */

export { type NatureDemandeAdPro } from "@/lib/ad-pro/categorie-budgetaire";

/** Profondeur maximale lue pour les parentes — garde-fou contre une boucle de rattachement. */
const PROFONDEUR = 8;

export async function categoriePourControle(id: string): Promise<CategoriePourControle | null> {
  const cat = await prisma.budgetCategoryLine.findUnique({
    where: { id },
    select: {
      name: true, module: true, businessUnitId: true, parentId: true,
      envelope: { select: { name: true, isActive: true, modules: true, module: true, periodStart: true, periodEnd: true, businessUnitId: true } },
    },
  });
  if (!cat) return null;
  const ancetres: NoeudCategorieControle[] = [];
  let parentId = cat.parentId;
  const vus = new Set<string>([id]);
  while (parentId && !vus.has(parentId) && ancetres.length < PROFONDEUR) {
    vus.add(parentId);
    const p = await prisma.budgetCategoryLine.findUnique({ where: { id: parentId }, select: { name: true, module: true, businessUnitId: true, parentId: true } });
    if (!p) break;
    ancetres.push({ nom: p.name, module: p.module, businessUnitId: p.businessUnitId });
    parentId = p.parentId;
  }
  return {
    nom: cat.name, module: cat.module, businessUnitId: cat.businessUnitId, ancetres,
    enveloppe: { nom: cat.envelope.name, isActive: cat.envelope.isActive, modules: cat.envelope.modules, module: cat.envelope.module, periodStart: cat.envelope.periodStart, periodEnd: cat.envelope.periodEnd, businessUnitId: cat.envelope.businessUnitId },
  };
}

/** La date et la Business Unit d'une demande Ad & Pro, lues sur la demande elle-même. */
export async function demandePourControle(nature: NatureDemandeAdPro, id: string): Promise<DemandePourControle | null> {
  const select = { createdAt: true, businessUnitId: true } as const;
  const r = await (async () => {
    switch (nature) {
      case "SPONSORING": return prisma.sponsoringRequest.findUnique({ where: { id }, select });
      case "CONGRESS_NATIONAL": return prisma.congressNational.findUnique({ where: { id }, select });
      case "CONGRESS_INTERNATIONAL": return prisma.congressInternational.findUnique({ where: { id }, select });
      case "EVENT": return prisma.event.findUnique({ where: { id }, select });
      case "AD_PRO_OTHER": return prisma.adProOtherRequest.findUnique({ where: { id }, select });
      case "PROMO_MATERIAL": return prisma.promoMaterial.findUnique({ where: { id }, select });
    }
  })();
  return r ? { nature, date: r.createdAt, businessUnitId: r.businessUnitId } : null;
}

/**
 * LE REFUS, lu et jugé en une fois : `null` si la catégorie convient à la demande, sinon la phrase à
 * rendre. Une catégorie ou une demande introuvable est elle aussi un refus nommé.
 */
export async function refusCategoriePourLaDemande(categoryId: string, nature: NatureDemandeAdPro, demandeId: string): Promise<string | null> {
  const [cat, demande] = await Promise.all([categoriePourControle(categoryId), demandePourControle(nature, demandeId)]);
  if (!cat) return "Catégorie budgétaire introuvable.";
  if (!demande) return "Demande introuvable : la catégorie budgétaire ne peut pas être contrôlée.";
  return refusCategoriePourDemande(cat, demande);
}
