import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { porteLeRoleQuiTranche, type ReferentMarketing } from "@/lib/personnes/referents-gamme";
import type { Porteur } from "./etape-gamme";

/**
 * LES RÉFÉRENTS DE LA GAMME QUE PORTE CETTE DEMANDE.
 *
 * La gamme vit sur la LIGNE de la demande (`businessUnitId`), pas sur l'instance de circuit : le
 * moteur est générique, et y recopier la gamme ferait une seconde vérité qui prendrait du retard
 * au premier rattachement corrigé (§118.5). On la lit donc là où elle est.
 *
 * Le rôle est relu EN MÊME TEMPS : une désignation ne garantit pas que la personne porte encore
 * le rôle, et prévenir quelqu'un qui ne peut plus trancher est une attente sans pouvoir.
 */
export async function referentsDeLaDemande(entityType: EntityType, entityId: string): Promise<ReferentMarketing[]> {
  const businessUnitId = await gammeDeLaDemande(entityType, entityId);
  if (!businessUnitId) return [];
  const lignes = await prisma.businessUnitMarketingReferent.findMany({
    where: { businessUnitId, user: { isActive: true } },
    select: { userId: true, user: { select: { name: true, role: true, secondaryRole: true } } },
  });
  return lignes.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    porteLeRole: porteLeRoleQuiTranche(r.user),
  }));
}

/** La gamme que porte la demande — lue sur sa LIGNE, là où elle vit (voir ci-dessus). */
async function gammeDeLaDemande(entityType: EntityType, entityId: string): Promise<string | null> {
  const ligne =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
          : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
            : entityType === "EVENT" ? await prisma.event.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
              : null;
  return ligne?.businessUnitId ?? null;
}

/**
 * LE SUPERVISEUR DE LA GAMME de la demande, avec ses rôles RELUS (ADPRO-06) — actif seulement : un
 * superviseur désactivé ne tient plus l'étape, elle retombe sur le rôle plutôt que d'attendre.
 */
export async function superviseurDeLaGamme(entityType: EntityType, entityId: string): Promise<Porteur | null> {
  const businessUnitId = await gammeDeLaDemande(entityType, entityId);
  if (!businessUnitId) return null;
  const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { supervisorId: true } });
  if (!bu?.supervisorId) return null;
  const u = await prisma.user.findFirst({ where: { id: bu.supervisorId, isActive: true }, select: { id: true, role: true, secondaryRole: true } });
  return u ? { id: u.id, role: u.role, secondaryRole: u.secondaryRole } : null;
}
