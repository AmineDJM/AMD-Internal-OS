/**
 * Accès par enregistrement — les règles AD & PRO : propriétaire d'une demande, parties prenantes,
 * qui tranche, société ouverte et portée d'une demande du pôle. Internes : lues par `acces-entite.ts`.
 */

import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { entitePermisePourFiche } from "@/lib/company";
import { isOwnBusiness } from "@/modules/ad-pro/partage";
import {
  userCan, hasGlobalView, type Module, type SessionUser,
  scopeCongressIntl, scopeCongressNational, scopePromoMaterial, scopeSponsoring, scopeAdProOther,
} from "@/lib/rbac";
import { ENTITY_MODULE } from "./modules";

/**
 * Authoritative server-side access check for a single entity row. Enforces both
 * module permission and row-level scope, so a user can never read/modify a row
 * outside their assignment even if they guess the id.
 */
/** Le demandeur d'une demande de sponsoring/congrès en est-il le requester ? */
export async function isRequestOwner(user: SessionUser, entityType: EntityType, entityId: string): Promise<boolean> {
  if (entityType === "SPONSORING") {
    const r = await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    return r?.requesterId === user.id;
  }
  if (entityType === "CONGRESS_INTERNATIONAL") {
    const r = await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    return r?.requesterId === user.id;
  }
  if (entityType === "CONGRESS_NATIONAL") {
    const r = await prisma.congressNational.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    return r?.requesterId === user.id;
  }
  if (entityType === "EVENT") {
    const r = await prisma.event.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    return r?.requesterId === user.id;
  }
  if (entityType === "AD_PRO_OTHER") {
    const r = await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { requesterId: true } });
    return r?.requesterId === user.id;
  }
  return false;
}

/** Les natures de dossier du module Ad&Pro — « Autre » comprise (SA-14 : absente, elle échappait au contrôle de société). */
export const AD_PRO_TYPES: EntityType[] = [
  "SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "PROMO_MATERIAL", "AD_PRO_OTHER",
];

/**
 * LES PARTIES PRENANTES NOMMÉES d'un dossier Ad&Pro — demandeur, Direction Marketing, assistante.
 *
 * Elles instruisent ce dossier-là. Leur refuser d'y joindre la facture ne protège rien : cela
 * sort la pièce de l'ERP, et six semaines plus tard personne ne sait plus à quel événement elle
 * correspondait.
 */
export async function adProStakeholders(
  entityType: EntityType, entityId: string,
): Promise<PartiesAdPro | null> {
  // Le SUPERVISEUR de la gamme du dossier y est lu aussi : il tranche les demandes de ses KAM
  // (étape du National Sales), donc il doit pouvoir OUVRIR ce qu'on lui demande de trancher, même
  // si sa fiche salarié ne lui ouvre pas la société du demandeur (§118.184). Lire, pas écrire.
  const bu = { businessUnit: { select: { supervisorId: true } } } as const;
  const sel = { select: { requesterId: true, productManagerId: true, companyId: true, ...bu } } as const;
  const r = await (async () => {
    switch (entityType) {
      case "SPONSORING": return prisma.sponsoringRequest.findUnique({ where: { id: entityId }, ...sel });
      case "CONGRESS_INTERNATIONAL": return prisma.congressInternational.findUnique({ where: { id: entityId }, ...sel });
      case "CONGRESS_NATIONAL": return prisma.congressNational.findUnique({ where: { id: entityId }, ...sel });
      case "EVENT": return prisma.event.findUnique({ where: { id: entityId }, ...sel });
      case "PROMO_MATERIAL":
        return prisma.promoMaterial.findUnique({ where: { id: entityId }, select: { requesterId: true, assistantId: true, companyId: true, ...bu } });
      case "AD_PRO_OTHER": return prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { requesterId: true, companyId: true, ...bu } });
      default: return null;
    }
  })();
  if (!r) return null;
  const { businessUnit, ...parties } = r as typeof r & { businessUnit?: { supervisorId: string | null } | null };
  return { ...parties, superviseurGammeId: businessUnit?.supervisorId ?? null };
}

/** Ce qu'une porte Ad & Pro sait d'un dossier : ses parties prenantes, sa société, le superviseur de sa gamme. */
interface PartiesAdPro {
  requesterId?: string | null;
  productManagerId?: string | null;
  assistantId?: string | null;
  companyId?: string | null;
  superviseurGammeId: string | null;
}

/**
 * QUI TRANCHE un dossier Ad & Pro : le droit de VALIDER son module (Direction Marketing, Direction,
 * Directeur Général, Super Admin), ou la vue globale. Ce sont eux que les étapes du circuit nomment
 * par leur RÔLE — et une notification de rôle part à toutes les personnes qui le portent, quelle que
 * soit leur société. Leur fermer la société du demandeur, ce serait leur demander de trancher ce
 * qu'ils ne peuvent pas ouvrir (§118.27).
 */
export function trancheAdPro(user: SessionUser, module: Module): boolean {
  return hasGlobalView(user) || userCan(user, module, "VALIDATE");
}

/**
 * LA SOCIÉTÉ DU DOSSIER EST-ELLE UNE FRONTIÈRE POUR CETTE PERSONNE ? Non pour ses parties prenantes,
 * pour qui le tranche et pour le superviseur de sa gamme ; oui pour tous les autres — la fiche ne
 * s'ouvre pas plus large que la liste (§118.184), sur TOUTES les sociétés auxquelles on a droit et
 * pas la seule sélectionnée dans l'en-tête : une fiche s'ouvre depuis une notification.
 */
export async function societeOuverteAdPro(user: SessionUser, module: Module, parties: PartiesAdPro): Promise<boolean> {
  if (isOwnBusiness(user.id, parties) || trancheAdPro(user, module)) return true;
  if (parties.superviseurGammeId && parties.superviseurGammeId === user.id) return true;
  return entitePermisePourFiche(user.id, parties.companyId);
}

/**
 * LA PORTÉE DE LIGNE d'un objet Ad & Pro — la MÊME que sa fiche et que ses listes (§118.153).
 *
 * Trois modules Ad & Pro ont une portée « ses lignes » : congrès international, congrès national
 * et matériel promotionnel (le délégué, et depuis §118.153 le National Sales, n'y voient que LEURS
 * dossiers). La fiche l'appliquait, les listes aussi ; cette porte-ci — celle des pièces, des
 * commentaires et du fil — ne l'appliquait pas : le raccourci « UPDATE sur le module » et le
 * `default` du dernier aiguillage ouvraient n'importe quel dossier à qui avait le module, sur son
 * seul identifiant. Mesuré par le banc du circuit 2 : ouvrir le matériel promotionnel au National
 * Sales lui faisait lire le dossier d'un KAM dont il n'est pas le N+1. Sponsoring et événements
 * n'ont pas de portée de ligne : qui a le module les voit tous, comme dans leur liste.
 *
 * Les clauses se COMPOSENT en `AND`, jamais par étalement (§118.133) : `{ id: "__none__" }` et
 * `{ OR: … }` ne doivent jamais pouvoir écraser l'identifiant visé.
 */
export async function dansLaPorteeAdPro(user: SessionUser, entityType: EntityType, entityId: string): Promise<boolean> {
  switch (entityType) {
    case "CONGRESS_INTERNATIONAL":
      return (await prisma.congressInternational.count({ where: { AND: [{ id: entityId }, scopeCongressIntl(user)] } })) > 0;
    case "CONGRESS_NATIONAL":
      return (await prisma.congressNational.count({ where: { AND: [{ id: entityId }, scopeCongressNational(user)] } })) > 0;
    case "PROMO_MATERIAL":
      return (await prisma.promoMaterial.count({ where: { AND: [{ id: entityId }, scopePromoMaterial(user)] } })) > 0;
    // Le sponsoring (§118.185, I4) : le délégué y entre pour SES demandes — sans ce cas, le module
    // reçu pour déposer la sienne lui ouvrait, par identifiant, celles de tous ses collègues.
    case "SPONSORING":
      return (await prisma.sponsoringRequest.count({ where: { AND: [{ id: entityId }, scopeSponsoring(user)] } })) > 0;
    // « Autre » (27/10/2026) : la même porte que le sponsoring — le délégué n'ouvre que SES demandes.
    case "AD_PRO_OTHER":
      return (await prisma.adProOtherRequest.count({ where: { AND: [{ id: entityId }, scopeAdProOther(user)] } })) > 0;
    default:
      return true;
  }
}
