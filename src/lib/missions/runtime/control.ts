import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { journaliser, transitionner } from "@/lib/missions/runtime/store";
import { canTransition, type MissionState } from "@/lib/missions/runtime/state";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MAIN HUMAINE SUR UNE MISSION (§39-40) — pause, reprise, arrêt.
 *
 * ── POURQUOI CE FICHIER EXISTE, ET POURQUOI IL EST SI PETIT ─────────────────────────────
 *
 * Tout ce qu'il fait, la machine à états et le journal savaient déjà le faire. Ce qui manquait
 * n'était pas la mécanique : c'était la PORTE. Une mission suspendue, reprise ou arrêtée était
 * une capacité écrite nulle part, donc une capacité inexistante — le PDG pouvait lancer une
 * mission de trois mille actions et n'avait aucun moyen de lui dire « stop ».
 *
 * ── LE CLOISONNEMENT EST DANS LA SIGNATURE ──────────────────────────────────────────────
 *
 * Chaque fonction exige le `ownerId` et le met dans le `where`. On ne vérifie pas la propriété
 * après avoir lu la mission : on lit la mission DE cette personne, et un identifiant deviné ne
 * donne rien. C'est la même règle que la mémoire d'assistant, pour la même raison.
 *
 * ── CE QU'ON NE FAIT PAS ────────────────────────────────────────────────────────────────
 *
 * On ne touche pas aux ÉTAPES. Une mission suspendue pendant qu'elle attendait un contrat
 * repart en attendant toujours ce contrat ; une mission arrêtée laisse ses étapes telles
 * qu'elles étaient, et le journal dit pourquoi. Remettre les étapes à zéro rendrait la reprise
 * dangereuse — on relancerait des actions déjà faites — et l'arrêt illisible.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatControle {
  ok: boolean;
  /** L'état AVANT, quand la mission a été trouvée. */
  depuis: MissionState | null;
  /** L'état APRÈS. Égal à `depuis` quand rien n'a bougé. */
  vers: MissionState | null;
  message: string;
}

const introuvable: ResultatControle = {
  ok: false, depuis: null, vers: null,
  message: "Mission introuvable — ou elle ne vous appartient pas.",
};

/**
 * `kind` : les gestes valent pour les missions d'Adam (`RUNTIME`, défaut) ET pour les travaux (`TRAVAIL`, J2) —
 * la même main sur le même moteur. Le `where` garde la famille : un geste sur un travail ne touche jamais une
 * mission d'Adam, et l'inverse.
 */
export type FamilleMission = "RUNTIME" | "TRAVAIL";

async function etat(missionId: string, ownerId: string, kind: FamilleMission = "RUNTIME"): Promise<MissionState | null> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId, kind },
    select: { status: true },
  });
  return (m?.status as MissionState) ?? null;
}

/**
 * SUSPEND UNE MISSION.
 *
 * Le motif est facultatif mais fortement encouragé : trois jours plus tard, « pourquoi cette
 * mission est-elle en pause ? » est exactement la question qu'on se pose, et le journal est le
 * seul endroit qui puisse répondre.
 */
export async function mettreEnPause(
  missionId: string, ownerId: string, motif?: string, kind: FamilleMission = "RUNTIME",
): Promise<ResultatControle> {
  const depuis = await etat(missionId, ownerId, kind);
  if (!depuis) return introuvable;
  if (depuis === "PAUSED") {
    return { ok: true, depuis, vers: depuis, message: "Cette mission était déjà en pause." };
  }
  if (!canTransition(depuis, "PAUSED")) {
    return {
      ok: false, depuis, vers: depuis,
      message: `Une mission ${depuis === "COMPLETED" ? "terminée" : "annulée"} ne se met pas en pause.`,
    };
  }

  await transitionner(missionId, "PAUSED", motif ? `Suspendue : ${motif}` : "Suspendue à la demande");
  /**
   * LA PAUSE PORTE SA DATE, SON MOTIF ET SON ÉTAT D'ORIGINE.
   *
   * Sans ces trois champs, `PAUSED` est un mot sans contenu : l'écran ne peut pas dire « en
   * pause depuis mardi, parce qu'on attend l'avis du juriste », et la reprise ne peut que
   * DEVINER d'où repartir. `pausedFrom` n'est pas là pour restaurer l'état d'avant — on repart
   * par RUNNING, voir `reprendre` — mais pour pouvoir DIRE ce qu'on a interrompu : une mission
   * suspendue en pleine attente et une mission suspendue en plein travail ne se reprennent pas
   * avec la même phrase.
   */
  await prisma.mission.updateMany({
    where: { id: missionId, ownerId },
    data: { pausedAt: new Date(), pausedReason: motif ?? null, pausedFrom: depuis },
  });
  await journaliser(missionId, "PAUSED",
    motif ? `Mise en pause — ${motif}` : "Mise en pause",
    { motif: motif ?? null, depuis }, ownerId);
  return {
    ok: true, depuis, vers: "PAUSED",
    message: depuis.startsWith("WAITING")
      ? "Mission suspendue pendant qu'elle attendait. Elle repartira en attendant toujours la même chose."
      : "Mission suspendue. Elle repartira où elle s'est arrêtée.",
  };
}

/**
 * REPREND UNE MISSION SUSPENDUE.
 *
 * On repasse par RUNNING et non par l'état d'avant la pause — délibérément. Ré-établir l'état
 * antérieur exigerait de le stocker, donc de l'entretenir, et il serait faux dès qu'un
 * événement serait arrivé pendant la pause. RUNNING est l'état honnête : « elle travaille » ;
 * le moteur redécouvre en un tour, sans effet de bord, ce qu'elle attend réellement.
 */
export async function reprendre(missionId: string, ownerId: string, kind: FamilleMission = "RUNTIME"): Promise<ResultatControle> {
  const depuis = await etat(missionId, ownerId, kind);
  if (!depuis) return introuvable;
  if (depuis !== "PAUSED") {
    return { ok: false, depuis, vers: depuis, message: `Cette mission n'est pas en pause (${depuis}).` };
  }

  const trace = await prisma.mission.findUnique({
    where: { id: missionId }, select: { pausedAt: true, pausedReason: true, pausedFrom: true },
  });
  await transitionner(missionId, "RUNNING", "Reprise à la demande");
  /**
   * ON EFFACE LA TRACE DE PAUSE, ET ON ROUVRE LE DROIT DE REPLANIFIER.
   *
   * Une mission suspendue pendant des jours a très bien pu voir son contexte changer : la
   * personne a répondu, la source a bougé, la contrainte a sauté. Garder `replanBloque` la
   * condamnerait à un refus décidé dans un monde qui n'existe plus (§118.42).
   */
  await prisma.mission.updateMany({
    where: { id: missionId, ownerId },
    data: { pausedAt: null, pausedReason: null, pausedFrom: null, replanBloque: false, replanRefus: null },
  });
  const duree = trace?.pausedAt
    ? Math.max(0, Math.round((Date.now() - trace.pausedAt.getTime()) / 60_000))
    : null;
  await journaliser(missionId, "RESUMED", "Reprise",
    { pausedFrom: trace?.pausedFrom ?? null, motif: trace?.pausedReason ?? null, minutesEnPause: duree }, ownerId);
  return {
    ok: true, depuis, vers: "RUNNING",
    message: duree === null
      ? "Mission reprise."
      : `Mission reprise après ${duree < 60 ? `${duree} min` : `${Math.round(duree / 60)} h`} de pause`
        + `${trace?.pausedFrom ? `, là où elle en était (${trace.pausedFrom})` : ""}.`,
  };
}

/**
 * ARRÊTE UNE MISSION, DÉFINITIVEMENT.
 *
 * `CANCELLED` est terminal : c'est ce qui garantit qu'un événement en retard ne la réveillera
 * pas trois jours après. Ce qui a DÉJÀ été fait reste fait — on n'annule pas un e-mail parti, et
 * prétendre le contraire serait le pire des mensonges d'interface.
 */
export async function annuler(missionId: string, ownerId: string, motif?: string, kind: FamilleMission = "RUNTIME"): Promise<ResultatControle> {
  const depuis = await etat(missionId, ownerId, kind);
  if (depuis === null) return introuvable;
  if (depuis === "CANCELLED") {
    return { ok: true, depuis, vers: depuis, message: "Cette mission était déjà arrêtée." };
  }
  if (!canTransition(depuis, "CANCELLED")) {
    return { ok: false, depuis, vers: depuis, message: "Une mission terminée ne s'annule pas." };
  }

  // LES ÉTAPES QUI N'ONT PAS COMMENCÉ SONT ANNULÉES ; celles qui tournent, attendent ou sont
  // faites ne sont PAS touchées. Une étape `DONE` annulée effacerait la trace d'un effet réel,
  // et une étape `RUNNING` annulée en base pendant qu'elle s'exécute vraiment produirait un
  // reçu sans étape pour le porter.
  await prisma.missionStep.updateMany({
    where: { missionId, status: { in: ["PENDING", "READY"] } },
    data: { status: "CANCELLED" },
  });
  /**
   * LES JALONS VIVANTS SONT ANNULÉS AVEC ELLE.
   *
   * Sans cette ligne, une mission arrêtée garderait un horizon OUVERT : `chargerEtat` rendrait
   * `horizonOuvert: true` pour toujours, et le pilote reprendrait indéfiniment une mission que
   * quelqu'un a explicitement arrêtée — le geste d'arrêt le plus important du produit, rendu
   * inopérant par une table qu'il ne connaissait pas.
   */
  await prisma.missionMilestone.updateMany({
    where: { missionId, statut: { notIn: ["DONE", "SKIPPED", "CANCELLED"] } },
    data: { statut: "CANCELLED", completedAt: new Date() },
  });

  await transitionner(missionId, "CANCELLED", motif ? `Arrêtée : ${motif}` : "Arrêtée à la demande");
  await journaliser(missionId, "CLOSED",
    motif ? `Arrêtée — ${motif}` : "Arrêtée à la demande", { motif: motif ?? null }, ownerId);
  return {
    ok: true, depuis, vers: "CANCELLED",
    message: "Mission arrêtée. Ce qui avait déjà été fait reste fait — rien n'est défait.",
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE MASSE D'UNE PERSONNE SUR SON PARC (§118.132).
 *
 * « Permets-moi de bloquer toutes les missions d'Adam » — le dirigeant recevait sans arrêt les
 * notifications de missions de banc laissées vivantes en production, et Mission Control
 * n'offrait que des gestes UN PAR UN. Deux gestes de masse, et pas un troisième :
 *
 *   • SUSPENDRE TOUTES SES MISSIONS VIVANTES — réversible, une par une ou par le bouton de
 *     reprise de chaque mission ; c'est `mettreEnPause` appliquée à chacune, donc le même
 *     journal, la même date, le même motif ;
 *   • ARRÊTER SES MISSIONS BLOQUÉES OU EN ÉCHEC — définitif, et c'est voulu : une mission que
 *     le juge a refusée deux fois, ou dont le plan ne compile plus, ne repartira pas toute
 *     seule, et la garder vivante ne sert qu'à la revoir dans les compteurs.
 *
 * ── LE PRÉDICAT « BLOQUÉE » VIT ICI, ET L'ÉCRAN LE LIT ──────────────────────────────────
 *
 * Le bouton dit « arrêter les N missions bloquées » : N doit être le nombre EXACT de missions
 * que le clic arrêtera. Deux prédicats — un pour compter, un pour agir — finissent par diverger
 * (§118.5), et le symptôme serait un bouton qui annonce trois missions et en arrête quatre.
 * `ouBloquee` est donc l'unique définition ; l'écran compte dessus, le geste agit dessus.
 *
 * Il inclut FAILED. L'écran range FAILED parmi les missions closes, mais la machine à états ne
 * le tient pas pour terminal (FAILED → PLANNING, RUNNING) et le battement le replanifie : une
 * mission FAILED de banc CONTINUE de coûter. Le libellé le dit — « bloquées ou en échec ».
 *
 * ── CE QUE CES GESTES NE FONT PAS ───────────────────────────────────────────────────────
 *
 * Ils ne touchent qu'aux missions DE CETTE PERSONNE (`ownerId` dans le `where`, comme partout
 * dans ce fichier) et ne posent PAS l'interrupteur global — celui-là est un geste de direction
 * (`lib/interrupteurs/missions.ts`). Et ils ne défont rien : un envoi parti reste parti.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les missions VIVANTES d'une personne — celles qu'une suspension de masse touche. */
export function ouSuspendable(ownerId: string): Prisma.MissionWhereInput {
  return { ownerId, kind: "RUNTIME", status: { notIn: ["COMPLETED", "CANCELLED", "PAUSED"] } };
}

/**
 * Les missions BLOQUÉES OU EN ÉCHEC d'une personne — le prédicat unique du compteur et du geste.
 * Même lecture que le drapeau `bloquee` du Centre de missions : statut BLOCKED ou FAILED, replan
 * fermé (§118.42), ou un jalon BLOCKED.
 */
export function ouBloquee(ownerId: string): Prisma.MissionWhereInput {
  return {
    ownerId,
    kind: "RUNTIME",
    status: { notIn: ["COMPLETED", "CANCELLED"] },
    OR: [
      { status: { in: ["BLOCKED", "FAILED"] } },
      { replanBloque: true },
      { milestones2: { some: { statut: "BLOCKED" } } },
    ],
  };
}

export interface ResultatControleMasse {
  /** Combien de missions répondaient au prédicat au moment du geste. */
  visees: number;
  /** Combien ont effectivement changé d'état. */
  faites: number;
  /** Celles qui étaient déjà dans l'état visé — rien n'a été écrit pour elles. */
  deja: number;
  /** Celles que la machine à états a refusées, avec sa phrase. */
  refusees: { id: string; message: string }[];
}

async function surChacune(
  ids: readonly string[],
  geste: (id: string) => Promise<ResultatControle>,
): Promise<ResultatControleMasse> {
  const out: ResultatControleMasse = { visees: ids.length, faites: 0, deja: 0, refusees: [] };
  for (const id of ids) {
    // UNE MISSION QUI ÉCHOUE N'EMPORTE PAS LES AUTRES : le geste de masse continue, et il DIT
    // laquelle a refusé. Un geste de masse qui s'arrête à la première erreur laisse la personne
    // devant un parc à moitié suspendu sans savoir quelle moitié.
    const r = await geste(id).catch((e): ResultatControle => ({
      ok: false, depuis: null, vers: null, message: e instanceof Error ? e.message : "erreur",
    }));
    if (!r.ok) { out.refusees.push({ id, message: r.message }); continue; }
    if (r.depuis === r.vers) out.deja += 1;
    else out.faites += 1;
  }
  return out;
}

/** SUSPEND toutes les missions vivantes de cette personne. Réversible mission par mission. */
export async function mettreEnPauseToutes(ownerId: string, motif?: string): Promise<ResultatControleMasse> {
  const cibles = await prisma.mission.findMany({
    where: ouSuspendable(ownerId), select: { id: true }, orderBy: { createdAt: "asc" },
  });
  return surChacune(cibles.map((c) => c.id), (id) => mettreEnPause(id, ownerId, motif));
}

/** ARRÊTE définitivement les missions bloquées ou en échec de cette personne. */
export async function arreterBloquees(ownerId: string, motif?: string): Promise<ResultatControleMasse> {
  const cibles = await prisma.mission.findMany({
    where: ouBloquee(ownerId), select: { id: true }, orderBy: { createdAt: "asc" },
  });
  return surChacune(cibles.map((c) => c.id), (id) => annuler(id, ownerId, motif));
}

/** Les deux nombres que les boutons de masse affichent — comptés sur les MÊMES prédicats que les gestes. */
export async function compterPourLesGestesDeMasse(ownerId: string): Promise<{ suspendables: number; bloquees: number }> {
  const [suspendables, bloquees] = await Promise.all([
    prisma.mission.count({ where: ouSuspendable(ownerId) }),
    prisma.mission.count({ where: ouBloquee(ownerId) }),
  ]);
  return { suspendables, bloquees };
}
