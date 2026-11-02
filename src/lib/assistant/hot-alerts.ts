/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES SIGNAUX EXÉCUTIFS CHAUDS — le premier consommateur des états précalculés (fabric F5).
 *
 * `detectExecutiveAlerts` coûte une dizaine de requêtes dont un balayage de relevés de stock,
 * et il était payé à CHAQUE company_state / ceo_attention / executive_brief. Ici :
 *
 *   • le battement RÉCHAUFFE le résultat pour les dirigeants récemment actifs — la question
 *     trouve un état déjà calculé ;
 *   • la lecture passe par l'état chaud (TTL court) et REND sa fraîcheur : l'appelant peut
 *     dire « signaux calculés à 14:32 » au lieu de laisser croire au temps réel ;
 *   • un fait métier inscrit au registre INVALIDE l'état — on ne sert jamais un signal
 *     démenti par un événement plus récent que lui.
 *
 * Les DROITS ne bougent pas d'un millimètre : l'état est calculé par utilisateur (son
 * périmètre d'entité, SES engagements) et servi à lui seul — la clé de la table l'impose.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lireEtatChaud, rechaufferEtatChaud, type LectureChaude } from "@/lib/fabric";
import { detectExecutiveAlerts, type ExecutiveAlert } from "@/lib/assistant/proactive";
import { sansBloquer } from "@/lib/journal";

/** La nature d'état — le registre d'événements invalide par cette clé. */
export const ETAT_ALERTES = "alertes-executives";

/**
 * TTL court : les détecteurs raisonnent en JOURS (paiement en souffrance depuis 5 jours…),
 * dix minutes d'âge ne changent aucun verdict — et l'invalidation par ÉVÉNEMENT couvre le
 * cas du fait qui survient à l'intérieur de la fenêtre.
 */
const TTL_ALERTES_MS = 10 * 60 * 1000;

/** La lecture chaude des signaux — même contrat que `detectExecutiveAlerts`, plus la fraîcheur. */
export async function alertesExecutivesChaudes(user: CurrentUser): Promise<LectureChaude<ExecutiveAlert[]>> {
  return lireEtatChaud<ExecutiveAlert[]>(ETAT_ALERTES, user.id, {
    ttlMs: TTL_ALERTES_MS,
    calcul: () => detectExecutiveAlerts(user),
  });
}

/** La phrase de fraîcheur, la même partout — dite, jamais devinée (§27 du mandat). */
export function fraicheurDeLecture(l: LectureChaude<unknown>): string {
  const instant = l.calculeLe.toISOString().slice(0, 16).replace("T", " ");
  return l.voie === "PRECALCULE"
    ? `signaux précalculés (battement) — calculés à ${instant} UTC, coût mesuré ${l.coutMesureMs} ms`
    : `signaux calculés à l'instant (${l.coutMesureMs} ms) — mis en réserve pour les prochaines lectures`;
}

/**
 * LE RÉCHAUFFAGE DU BATTEMENT — pour les dirigeants RÉCEMMENT ACTIFS seulement.
 *
 * Calculer pour un compte qui ne se connecte jamais serait du travail jeté ; le critère est
 * une session vue dans les trois derniers jours. L'utilisateur est RECONSTRUIT depuis son
 * compte, droits relus en base (`getAccess`) — le même geste que le balayage des missions :
 * jamais des droits supposés, toujours des droits du moment.
 */
export async function rechaufferAlertes(lot = 8): Promise<{ rechauffes: number }> {
  const recents = await prisma.userSession.findMany({
    where: {
      lastSeenAt: { gte: new Date(Date.now() - 3 * 86_400_000) },
      revokedAt: null,
      user: { isActive: true, role: { in: ["SUPER_ADMIN", "DIRECTION"] } },
    },
    select: { userId: true },
    distinct: ["userId"],
    orderBy: { lastSeenAt: "desc" },
    take: lot,
  });
  let rechauffes = 0;
  for (const { userId } of recents) {
    const u = await prisma.user.findFirst({
      where: { id: userId, isActive: true },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!u) continue;
    const access = await getAccess(u.id, u.role);
    const user: CurrentUser = {
      id: u.id, name: u.name, email: u.email,
      role: access.role ?? u.role, secondaryRole: access.secondaryRole,
      access, mustChangePassword: false,
    };
    await rechaufferEtatChaud(ETAT_ALERTES, u.id, () => detectExecutiveAlerts(user))
      .then(() => { rechauffes += 1; })
      .catch(sansBloquer("hot-alerts.rechaufferAlertes.rechaufferEtatChaud"));
  }
  return { rechauffes };
}
