import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { journaliser } from "@/lib/missions/runtime/store";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'UN TRAVAIL DIT AUX PERSONNES (J2, J8) — une notification par clé, et le signal du réveil rapide.
 *
 * La clé est au journal du travail (`MissionEvent`, pas de second registre) : un battement qui revoit le
 * même état ne renotifie pas, deux exécutants pendant la bascule n'envoient qu'un avis.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * PRÉVENIR UNE PERSONNE, UNE FOIS — par défaut la personne du travail ; J8 : aussi la personne sollicitée
 * par une demande, ou le responsable d'une escalade (`lien` dit où l'avis mène).
 */
export async function signalerUneFois(
  travailId: string, userId: string, cle: string, titre: string, corps: string, lien = `/assistant?travail=${travailId}`,
): Promise<boolean> {
  const deja = await prisma.missionEvent.findFirst({
    where: { missionId: travailId, kind: "TRAVAIL_SIGNAL", detail: { path: ["cle"], equals: cle } },
    select: { id: true },
  });
  if (deja) return false;
  await journaliser(travailId, "TRAVAIL_SIGNAL", titre, { cle, a: userId }, userId);
  await notifyUser({ userId, type: "GENERIC", title: titre.slice(0, 200), body: corps.slice(0, 280), link: lien })
    .catch(sansBloquer("travaux.signalerUneFois.notifyUser"));
  return true;
}

/**
 * LE RÉVEIL RAPIDE (J8) — un fait vient de régler une attente de ces travaux : la boucle courte des réveils
 * (`reveil.ts`) les reprend en quelques secondes au lieu d'attendre le battement d'une minute. Ne lève jamais :
 * au pire, le battement les reprendra.
 */
export async function signalerReveil(missionIds: readonly string[], maintenant = new Date()): Promise<void> {
  if (missionIds.length === 0) return;
  await prisma.mission.updateMany({
    where: { id: { in: [...new Set(missionIds)] }, kind: "TRAVAIL" },
    data: { reveilDemandeLe: maintenant },
  }).catch(sansBloquer("travaux.signalerReveil"));
}
