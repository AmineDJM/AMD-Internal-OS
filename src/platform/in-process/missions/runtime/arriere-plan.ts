/**
 * Composeur — LE LANCEMENT EN ARRIÈRE-PLAN : talon immédiat, finalisation différée, et rattrapage
 * des lancements perdus (processus redémarré pendant la planification).
 */
import { prisma } from "@/lib/prisma";
import { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/lib/rbac";
import { suspendreMissionHorsDroit } from "@/platform/in-process/missions/habilitation";
import type { CurrentUser } from "@/lib/session";
import { journaliser } from "@/lib/missions/runtime/store";
import { sansBloquer } from "@/lib/journal";
import { creerTalon, estPanneTransitoire, type LancementOptions, lancerMission, titreDe } from "./lancement";

export async function lancerEnArrierePlan(
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<{ ok: true; missionId: string; titre: string } | { ok: false; error: string }> {
  // La même porte que `lancerMission` (§118.136) : un talon n'est pas écrit pour quelqu'un qui n'y a pas droit.
  if (!peutPiloterMissionsAdam(user)) return { ok: false, error: REFUS_MISSIONS_ADAM };
  try {
    const titre = opts.titre ?? titreDe(objectif);
    const id = await creerTalon(user, objectif, titre);
    if (!id) return { ok: false, error: "la mission n'a pas pu être enregistrée" };
    const stub = { id };
    await journaliser(stub.id, "DETACHED",
      "Mission enregistrée : la planification et l'exécution continuent en arrière-plan.",
      { objectif: objectif.slice(0, 300) });

    setImmediate(() => {
      void finaliserLancementDifere(stub.id, user, objectif, opts).catch((e) => {
        console.error(`[missions] finalisation différée de ${stub.id} échouée`, e);
      });
    });

    return { ok: true, missionId: stub.id, titre };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * PLANIFIE ET DÉMARRE une mission-talon — le second temps du lancement détaché, et le chemin
 * de RATTRAPAGE après un crash. Idempotent par construction : si le talon porte déjà des
 * étapes (une autre instance a fini le travail), il n'y a rien à faire.
 */
export async function finaliserLancementDifere(
  missionId: string,
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<{ finalise: boolean; raison?: string }> {
  const etapes = await prisma.missionStep.count({ where: { missionId } });
  if (etapes > 0) return { finalise: false, raison: "déjà matérialisée" };
  const mission = await prisma.mission.findUnique({
    where: { id: missionId }, select: { status: true },
  });
  if (!mission || mission.status === "CANCELLED" || mission.status === "FAILED") {
    return { finalise: false, raison: "mission close" };
  }

  const r = await lancerMission(user, objectif, { ...opts, missionId });
  if (!r.ok) {
    // UNE PANNE TRANSITOIRE NE CLÔT PAS LA MISSION : le talon reste PLANNING, le journal dit
    // pourquoi, et `rattraperLancementsPerdus` reprendra (trois tentatives au plus, espacées
    // par le battement). Seul un refus DURABLE — plan irrecevable, aucun fournisseur — passe
    // FAILED : la personne voit « la planification a échoué », pas une carte qui tourne pour
    // toujours.
    if (estPanneTransitoire(r.error)) {
      await journaliser(missionId, "PLANNING_DEFERRED",
        `Le fournisseur de modèle a lâché pendant la planification (${r.error.slice(0, 120)}) : nouvelle tentative au prochain battement.`,
        { transitoire: true });
      return { finalise: false, raison: r.error };
    }
    // LA PANNE EST DITE, JAMAIS SILENCIEUSE : la mission passe FAILED avec le motif — la
    // personne voit « la planification a échoué », pas une carte qui tourne pour toujours.
    await prisma.mission.update({
      where: { id: missionId },
      data: { status: "FAILED" },
    }).catch(sansBloquer("missions-runtime.finaliserLancementDifere.mission"));
    await journaliser(missionId, "PLANNING_FAILED",
      `La planification en arrière-plan a échoué : ${r.error}`, {});
    return { finalise: false, raison: r.error };
  }
  return { finalise: true };
}

/**
 * RATTRAPE LES LANCEMENTS PERDUS — le filet du talon (§5 durabilité).
 *
 * Une mission PLANNING sans étape ET sans activité récente est un lancement dont le processus
 * est mort entre la promesse et la planification. Le battement la retrouve et RELANCE — au
 * plus deux reprises (comptées au journal), sinon FAILED avec le motif : relancer sans fin une
 * planification qui meurt à chaque fois serait une boucle, pas de la persévérance.
 *
 * ── « ZÉRO ÉTAPE » EST L'ÉTAT NORMAL D'UNE MISSION LONGUE (§118.46, SECOND LECTEUR) ─────
 *
 * Mesuré sur la chaîne humaine, deux runs de suite : la mission est découpée en cinq jalons
 * (`MILESTONES_PLANNED`), l'enquête tourne — et le filet la déclare PERDUE, parce qu'un jalon
 * qui n'a pas encore été atteint par la frontière n'a PAS d'étapes. C'est exactement ce que
 * §118.40 exige : « le plan du jalon N est écrit quand le jalon N-1 a produit ses résultats,
 * pas avant ». Le filet relançait donc TOUTE la planification — jalons + enquête, payés à
 * chaque fois — trois fois, puis fermait en `PLANNING_FAILED` une mission parfaitement saine.
 * Verdict du banc : « FOURNISSEUR INDISPONIBLE : la mission n'a jamais reçu de plan », sur un
 * fournisseur qui répondait (`PRÊT`, 1,8 s, mesuré une minute plus tard).
 *
 * §118.46 avait appris cette leçon à la requête du BATTEMENT ; ce second lecteur gardait
 * l'ancienne hypothèse. Le fait à lire est le même et il est dans la base : **une mission qui
 * a des JALONS a été planifiée.** Ses étapes viennent plus tard, du pilote d'horizon
 * (`conduireHorizon` compile la frontière, §118.40) — et ce pilote la reprend précisément
 * parce qu'elle est en PLANNING. Le filet reste ARMÉ sur le vrai cas : un talon sans jalons ET
 * sans étapes est bien un lancement mort.
 */
export async function rattraperLancementsPerdus(
  chargerProprietaire: (userId: string) => Promise<CurrentUser | null>,
  opts: { plusVieuxQueMs?: number; limite?: number } = {},
): Promise<number> {
  const seuil = new Date(Date.now() - (opts.plusVieuxQueMs ?? 2 * 60_000));
  const talons = await prisma.mission.findMany({
    where: {
      kind: "RUNTIME", status: "PLANNING", updatedAt: { lt: seuil },
      steps: { none: {} },
      // Un jalon PROUVE que la planification a abouti : les étapes viennent de la frontière.
      milestones2: { none: {} },
    },
    select: { id: true, ownerId: true, goalRaw: true },
    take: opts.limite ?? 5,
    orderBy: { updatedAt: "asc" },
  });

  let repris = 0;
  for (const talon of talons) {
    if (!talon.goalRaw) continue;
    const reprises = await prisma.missionEvent.count({
      where: { missionId: talon.id, kind: "PLANNING_RETRY" },
    });
    if (reprises >= 2) {
      await prisma.mission.update({ where: { id: talon.id }, data: { status: "FAILED" } }).catch(sansBloquer("missions-runtime.rattraperLancementsPerdus.mission"));
      await journaliser(talon.id, "PLANNING_FAILED",
        "Trois lancements ont été tentés sans qu'aucun n'aboutisse — la mission est close, le motif est au journal.", {});
      continue;
    }
    const user = await chargerProprietaire(talon.ownerId);
    if (!user) continue;
    // Un talon dont le propriétaire n'a pas (ou plus) le droit aux missions n'est pas replanifié :
    // il est SUSPENDU, motif au journal (§118.136) — la même relecture d'autorité que le battement.
    if (!peutPiloterMissionsAdam(user)) { await suspendreMissionHorsDroit(talon.id, talon.ownerId); continue; }
    await journaliser(talon.id, "PLANNING_RETRY",
      "Lancement retrouvé sans plan : la planification reprend (le processus qui la portait s'est arrêté).", {});
    const f = await finaliserLancementDifere(talon.id, user, talon.goalRaw, {});
    if (f.finalise) repris += 1;
  }
  return repris;
}
