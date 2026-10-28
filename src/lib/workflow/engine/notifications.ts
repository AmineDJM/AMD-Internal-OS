/**
 * Moteur de workflow — LES NOTIFICATIONS : le point unique « étape atteinte » (référents de gamme
 * compris), le gestionnaire d'étape, et la pose d'une demande.
 */
import type { EntityType, UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyRoles, notifyUser } from "@/lib/notify";
import { aPrevenirPourLaGamme, laGammeEstConcernee, porteLeRoleQuiTranche, type ReferentMarketing } from "@/lib/personnes/referents-gamme";
import { getManagerOfUser } from "@/lib/departments";
import type { ActorScope } from "../types";
import type { LoadedInstance, LoadedStep } from "./definitions";
import { entityPath } from "./entites";

// ───────────────────────────── Divers ─────────────────────────────

/**
 * Notifie le **responsable hiérarchique du demandeur** quand l'étape où l'on arrive lui est
 * confiée (portées `DEPARTMENT_MANAGER` / `DEPARTMENT_HEAD`). Sans cela, une étape « N+1 »
 * n'aurait aucun destinataire : personne ne saurait qu'il y a quelque chose à valider.
 * Best-effort : ne fait jamais échouer la progression.
 */
/**
 * PRÉVENIR L'ÉTAPE QUI VIENT D'ÊTRE ATTEINTE — le rôle, ET les référents de la gamme.
 *
 * ── POURQUOI UN SEUL POINT ──────────────────────────────────────────────────────────────
 *
 * Une étape est « atteinte » à TROIS endroits de ce moteur : après une approbation, après un
 * saut, et après un avis défavorable qui renvoie plus loin. Les trois appelaient `notifyRoles`
 * pour leur compte. Ajouter les référents à deux sur trois aurait laissé une porte muette à côté
 * de deux portes qui parlent (§118.71) — et c'est le chemin le plus rare, celui de l'avis
 * défavorable, qui serait resté silencieux. Un cliquet interdit désormais un `notifyRoles` nu
 * dans ce fichier.
 *
 * ── CE QUE LES RÉFÉRENTS AJOUTENT, ET CE QU'ILS NE RETIRENT PAS ─────────────────────────
 *
 * Les rôles de l'étape sont TOUJOURS prévenus : c'est ainsi que « le directeur du département
 * marketing recevra ÉGALEMENT l'accès et la notif » est tenu sans avoir à deviner qui est le
 * directeur. Les référents de la gamme s'y AJOUTENT, nommément. Une gamme sans référent retombe
 * donc exactement sur le comportement d'avant (§118.16).
 *
 * Un échec de notification ne casse JAMAIS le franchissement : l'étape a été décidée, et la
 * refuser parce qu'un envoi a raté ferait perdre la décision (§118.137).
 */
export async function prevenirEtapeAtteinte(
  entityType: EntityType,
  entityId: string,
  etape: LoadedStep,
  msg: { title: string; body: string; link: string },
  requesterId: string | null,
  // « À vous d'agir » par défaut ; « pour information » quand le circuit s'ouvre et annonce la
  // demande aux acteurs des étapes suivantes (décision #1, 27/10/2026) — mêmes destinataires.
  type: "VALIDATION_REQUIRED" | "GENERIC" = "VALIDATION_REQUIRED",
): Promise<void> {
  const roles = (etape.notifyRoles as UserRole[]).filter(Boolean);
  if (roles.length) await notifyRoles(roles, { type, ...msg });
  // LES RÉFÉRENTS DE LA GAMME s'AJOUTENT au rôle — et seulement là où l'étape NOMME ce rôle.
  // La décision est pure (`laGammeEstConcernee`) : l'écrire ici en lisant le slug ferait une
  // seconde vérité, fausse au premier circuit remanié (§118.5, §118.73).
  if (!laGammeEstConcernee(roles)) return;
  try {
    const referents = await referentsDeLaDemande(entityType, entityId);
    for (const userId of aPrevenirPourLaGamme({ referents, demandeurId: requesterId })) {
      await notifyUser({ userId, type, ...msg });
    }
  } catch (err) {
    console.error("[workflow] notification des référents Direction Marketing impossible", err);
  }
}

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
async function referentsDeLaDemande(entityType: EntityType, entityId: string): Promise<ReferentMarketing[]> {
  const ligne =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
          : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
            : await prisma.event.findUnique({ where: { id: entityId }, select: { businessUnitId: true } });
  if (!ligne?.businessUnitId) return [];
  const lignes = await prisma.businessUnitMarketingReferent.findMany({
    where: { businessUnitId: ligne.businessUnitId, user: { isActive: true } },
    select: { userId: true, user: { select: { name: true, role: true, secondaryRole: true } } },
  });
  return lignes.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    porteLeRole: porteLeRoleQuiTranche(r.user),
  }));
}

export async function notifyStepManager(step: LoadedStep, requesterId: string | null, title: string, body: string, link: string): Promise<void> {
  const scope = step.actorScope as ActorScope;
  if (scope !== "DEPARTMENT_MANAGER" && scope !== "DEPARTMENT_HEAD") return;
  if (!requesterId) return;
  try {
    const mgr = await getManagerOfUser(requesterId);
    if (mgr?.userId) await notifyUser({ userId: mgr.userId, type: "VALIDATION_REQUIRED", title, body, link });
  } catch (err) {
    console.error("[workflow] notification N+1 impossible", err);
  }
}

/**
 * PRÉVIENT L'ÉTAPE OÙ L'ON POSE UNE DEMANDE hors d'une approbation (resoumission, porte rouverte,
 * nouveau cycle) : la personne désignée, le N+1 si l'étape lui revient, le rôle et les référents.
 * Les trois chemins d'approbation le faisaient chacun ; les trois chemins de révision passent ici.
 */
export async function prevenirLaPose(
  entityType: EntityType, entityId: string, instance: LoadedInstance, etape: LoadedStep,
  requesterId: string | null, titre: string, corps: string,
): Promise<void> {
  const link = entityPath(entityType, entityId);
  if (etape.actorScope === "ASSIGNEE" && instance.assigneeId) {
    await notifyUser({ userId: instance.assigneeId, type: "ASSIGNMENT", title: titre, body: corps, link });
  }
  await notifyStepManager(etape, requesterId, titre, corps, link);
  await prevenirEtapeAtteinte(entityType, entityId, etape, { title: titre, body: corps, link }, requesterId);
}
