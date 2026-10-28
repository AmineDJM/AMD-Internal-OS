import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BAIL D'UNE MISSION — une seule instance la conduit à la fois.
 *
 * ── CE QU'IL FERME ───────────────────────────────────────────────────────────────────────
 *
 * Deux moteurs peuvent vouloir la même mission au même instant : le battement de fond et la
 * conversation qui vient de la lancer, deux processus qui se chevauchent pendant un déploiement,
 * ou — mesuré sur le banc — un banc d'essai qui conduit une mission avec SON exécuteur pendant
 * qu'un battement voisin la reprend avec l'exécuteur de production : 112 envois sur 500 partis
 * par le mauvais chemin, et un « le message est vide » que personne n'avait écrit.
 *
 * La SÛRETÉ ne dépend pas du bail : chaque étape se réserve une à une en base (`reserver`), et
 * la clé d'idempotence protège l'effet. Mais sans bail, deux instances paient deux fois les
 * mêmes tours, et surtout la mission est conduite par un moteur que son lanceur n'a pas choisi.
 *
 * ── LA RÈGLE ─────────────────────────────────────────────────────────────────────────────
 *
 * Le moteur PREND le bail à chaque vague (`avancer`), et le RENOUVELLE tant qu'il tourne : un
 * autre processus vivant trouve porte close et passe. Le bail expire seul (`BAIL_MISSION_MS`)
 * après la dernière vague d'un processus mort — c'est la reprise après panne, gratuite. La même
 * instance le reprend toujours : `leaseOwner` est le SIEN.
 *
 * Il n'est pas rendu à la fin d'un `avancer` : le battement suivant de la même instance le
 * reprend sans frais, et une instance concurrente attend au plus `BAIL_MISSION_MS`. Le battement
 * de fond, lui, rend explicitement ce qu'il a pris (`rendreBail`) quand il a fini son passage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'identité de CETTE instance — ce que le bail écrit en base. */
export const INSTANCE = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/** Au-delà, un bail sans renouvellement appartient à un processus mort et se reprend. */
export const BAIL_MISSION_MS = 90_000;

/** Prend (ou renouvelle) le bail — atomique : la base tranche entre deux prétendants. */
export async function prendreBail(missionId: string, maintenant = new Date()): Promise<boolean> {
  const r = await prisma.mission.updateMany({
    where: {
      id: missionId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: maintenant } }, { leaseOwner: INSTANCE }],
    },
    data: { leaseOwner: INSTANCE, leaseUntil: new Date(maintenant.getTime() + BAIL_MISSION_MS) },
  });
  return r.count === 1;
}

/** Rend le bail — seulement le sien : rendre le bail d'un autre le lui volerait. */
export async function rendreBail(missionId: string): Promise<void> {
  await prisma.mission.updateMany({
    where: { id: missionId, leaseOwner: INSTANCE },
    data: { leaseOwner: null, leaseUntil: null },
  }).catch(sansBloquer("bail.rendreBail.mission"));
}

/** Qui tient le bail en ce moment — pour dire, pas pour décider. */
export async function detenteurDuBail(missionId: string, maintenant = new Date()): Promise<string | null> {
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { leaseOwner: true, leaseUntil: true } });
  if (!m?.leaseOwner || !m.leaseUntil || m.leaseUntil < maintenant) return null;
  return m.leaseOwner;
}
