import { et } from "@/lib/acces/compose";
import { userCan, scopeRegulatory, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/lib/actions/types";
import { ensureProduitDuDossier } from "./canonique";
import { sansBloquer } from "@/lib/journal";

/**
 * RATTACHER UN PRODUIT À SON DOSSIER RÉGLEMENTAIRE — le cœur, appelé par les DEUX portes.
 *
 * L'écran passe par une action serveur, l'API des agents par le registre d'opérations. Il n'y a
 * qu'UNE implémentation, et elle reçoit explicitement l'utilisateur au nom de qui l'on agit :
 * l'API n'a pas de session, et deux écritures parallèles auraient fini par diverger.
 *
 * C'est la seule écriture de la fusion des catalogues, et elle est toujours le fait d'une
 * PERSONNE. Le rapprochement automatique propose, il ne tranche pas : un 500 mg et un 1 g
 * partagent molécule, forme et nom commercial, et les confondre coûterait une erreur qu'on ne
 * découvrirait qu'au moment où elle est chère.
 *
 * Chaque décision part au journal. Un rattachement qui se révèle faux doit pouvoir se retrouver :
 * savoir QUI a dit que ces deux produits n'en font qu'un vaut, plus tard, tous les commentaires.
 */

export type CatalogKind = "BD" | "PROMO";

function guard(user: SessionUser, kind: CatalogKind) {
  // Rattacher, c'est déclarer une équivalence de produits : cela relève du réglementaire, qui
  // tient le catalogue de référence — pas du module d'où vient le produit.
  if (!userCan(user, "REGULATORY", "UPDATE")) {
    return { ok: false as const, error: "Seul le réglementaire rattache un produit à son dossier." };
  }
  if (kind !== "BD" && kind !== "PROMO") return { ok: false as const, error: "Catalogue inconnu." };
  return { ok: true as const, error: null as string | null };
}

export async function linkProductToDossierFor(user: SessionUser, input: {
  kind: CatalogKind; id: string; regulatoryProductId: string;
}): Promise<ActionResult> {
  const g = guard(user, input.kind);
  if (!g.ok) return { ok: false, error: g.error ?? "Non autorisé." };
  if (!input.id || !input.regulatoryProductId) return { ok: false, error: "Produit ou dossier manquant." };

  // Le dossier doit être DANS SA PORTÉE : sans ce contrôle, on rattacherait à un dossier
  // verrouillé ou hors périmètre en devinant son identifiant.
  const dossier = await prisma.regulatoryProduct.findFirst({
    where: et({ id: input.regulatoryProductId }, scopeRegulatory(user)),
    select: { id: true, dci: true, dosage: true, reference: true, productId: true },
  });
  if (!dossier) return { ok: false, error: "Dossier réglementaire introuvable dans votre périmètre." };

  // LE PRODUIT DU DOSSIER (produit = dossier, Direction 08/10) : rattaché à son dossier, le profil en
  // hérite — c'est lui qu'une visite rapporte et que la 360° lit. Un dossier sans produit (d'avant ce
  // lot) reçoit le sien ici, identité complète ou non.
  let produitDuDossier = dossier.productId;
  if (!produitDuDossier) {
    const lien = await ensureProduitDuDossier(dossier.id, { acteurId: user.id }).catch(sansBloquer("link.linkProductToDossierFor.ensureProduitDuDossier", null));
    if (lien && "produitId" in lien) produitDuDossier = lien.produitId;
  }

  const dossierName = [dossier.dci, dossier.dosage, dossier.reference && `(${dossier.reference})`].filter(Boolean).join(" ");

  if (input.kind === "BD") {
    const p = await prisma.bdProduct.findUnique({ where: { id: input.id }, select: { dci: true, productId: true } });
    if (!p) return { ok: false, error: "Produit introuvable." };
    await prisma.bdProduct.update({
      where: { id: input.id },
      // Un produit déjà choisi par une personne n'est pas remplacé par effet de bord.
      data: { regulatoryProductId: dossier.id, ...(p.productId ? {} : { productId: produitDuDossier }) },
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory",
      entityType: "REGULATORY_PRODUCT", entityId: dossier.id,
      summary: `Catalogues rapprochés — le produit BD « ${p.dci} » est rattaché à ${dossierName}`,
    });
  } else {
    const p = await prisma.promoProduct.findUnique({ where: { id: input.id }, select: { name: true, productId: true } });
    if (!p) return { ok: false, error: "Produit introuvable." };
    await prisma.promoProduct.update({
      where: { id: input.id },
      data: { regulatoryProductId: dossier.id, ...(p.productId ? {} : { productId: produitDuDossier }) },
    });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory",
      entityType: "REGULATORY_PRODUCT", entityId: dossier.id,
      summary: `Catalogues rapprochés — le produit promu « ${p.name} » est rattaché à ${dossierName}`,
    });
  }

  return { ok: true, message: `Rattaché à ${dossierName}.` };
}

/** Défaire un rattachement — un rapprochement faux doit se corriger aussi vite qu'il s'est fait. */
export async function unlinkProductFromDossierFor(user: SessionUser, input: { kind: CatalogKind; id: string }): Promise<ActionResult> {
  const g = guard(user, input.kind);
  if (!g.ok) return { ok: false, error: g.error ?? "Non autorisé." };
  if (!input.id) return { ok: false, error: "Produit manquant." };

  if (input.kind === "BD") {
    const p = await prisma.bdProduct.findUnique({
      where: { id: input.id },
      select: { dci: true, regulatoryProductId: true, productId: true, regulatoryProduct: { select: { productId: true } } },
    });
    if (!p) return { ok: false, error: "Produit introuvable." };
    // Le produit canonique HÉRITÉ du dossier part avec lui : défaire « c'est ce dossier », c'est
    // défaire « c'est ce produit ». Un produit choisi à part par une personne reste.
    const herite = Boolean(p.productId && p.productId === p.regulatoryProduct?.productId);
    await prisma.bdProduct.update({ where: { id: input.id }, data: { regulatoryProductId: null, ...(herite ? { productId: null } : {}) } });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory",
      entityType: "REGULATORY_PRODUCT", entityId: p.regulatoryProductId ?? undefined,
      summary: `Rapprochement défait — le produit BD « ${p.dci} » n'est plus rattaché`,
    });
  } else {
    const p = await prisma.promoProduct.findUnique({
      where: { id: input.id },
      select: { name: true, regulatoryProductId: true, productId: true, regulatoryProduct: { select: { productId: true } } },
    });
    if (!p) return { ok: false, error: "Produit introuvable." };
    const herite = Boolean(p.productId && p.productId === p.regulatoryProduct?.productId);
    await prisma.promoProduct.update({ where: { id: input.id }, data: { regulatoryProductId: null, ...(herite ? { productId: null } : {}) } });
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Regulatory",
      entityType: "REGULATORY_PRODUCT", entityId: p.regulatoryProductId ?? undefined,
      summary: `Rapprochement défait — le produit promu « ${p.name} » n'est plus rattaché`,
    });
  }

  return { ok: true };
}
