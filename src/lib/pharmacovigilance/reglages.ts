import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { DELAIS_PV_DEFAUT, lireDesignationsPv, viseursDuCasPv, type DelaisPv } from "./declaration";

/**
 * PHARMACOVIGILANCE — LES RÉGLAGES DU SUPER ADMIN (déclaration à l'autorité, 24/11/2026) : les délais de déclaration et
 * le pharmacien responsable désigné par société. Serveur : lit la ligne « global » ; sans ligne (ou base muette), les
 * valeurs par défaut de `declaration.ts` — les mêmes que les `@default` de `PvReglage`.
 */

export interface ReglagesPv {
  delais: DelaisPv;
  /** { companyId: userId } */
  pharmaciens: Record<string, string>;
}

export async function lireReglagesPv(): Promise<ReglagesPv> {
  const r = await prisma.pvReglage.findUnique({ where: { id: "global" } }).catch(sansBloquer("pharmacovigilance.lireReglagesPv", null));
  if (!r) return { delais: { ...DELAIS_PV_DEFAUT }, pharmaciens: {} };
  return { delais: { graveJours: r.delaiGraveJours, nonGraveJours: r.delaiNonGraveJours }, pharmaciens: lireDesignationsPv(r.pharmaciensResponsables) };
}

/** La société d'un cas : celle du produit canonique (choisi au signalement ou derrière le produit de BU), sinon rien. */
export async function societeDuCasPv(cas: { productId: string | null; promoProductId: string | null }): Promise<string | null> {
  const produitId = cas.productId
    ?? (cas.promoProductId ? (await prisma.promoProduct.findUnique({ where: { id: cas.promoProductId }, select: { productId: true } }))?.productId ?? null : null);
  if (!produitId) return null;
  return (await prisma.product.findUnique({ where: { id: produitId }, select: { companyId: true } }))?.companyId ?? null;
}

/** Ceux qui visent la déclaration de ce cas (vide : aucun pharmacien responsable désigné, pas de visa attendu). */
export async function viseursPourLeCasPv(cas: { productId: string | null; promoProductId: string | null }, reglages?: ReglagesPv): Promise<string[]> {
  const r = reglages ?? (await lireReglagesPv());
  if (Object.keys(r.pharmaciens).length === 0) return [];
  return viseursDuCasPv(r.pharmaciens, await societeDuCasPv(cas));
}
