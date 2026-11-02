/**
 * Composeur — L'AVANCEMENT : faire jouer au moteur les tours d'une mission existante.
 */
import { prisma } from "@/lib/prisma";
import { prechargerCapacitesDynamiques } from "@/platform/in-process/skills";
import { assurerFormes } from "@/platform/in-process/missions/formes";
import type { CurrentUser } from "@/lib/session";
import { avancer } from "@/lib/missions/runtime/engine";
import { agentPour } from "@/lib/missions/agent/principal";
import { withTurn, setTurnContext } from "@/lib/models/telemetry";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { sansBloquer } from "@/lib/journal";
import { assembler, type OptionsAssemblage } from "./assemblage";

/**
 * FAIT AVANCER UNE MISSION — le point d'entrée de l'ordonnanceur, du routeur d'événements,
 * de l'écran et de la conversation.
 *
 * Réentrant : deux appels concurrents se disputent les étapes par réservation en base. C'est ce
 * qui permet à l'ordonnanceur et à l'utilisateur de cliquer en même temps sans dommage.
 */
export function avancerMission(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage & { maxTours?: number } = {},
) {
  return withTurn("background", async () => {
    setTurnContext({ userId: user.id, missionId, feature: "mission" });
    await prechargerCapacitesDynamiques(user).catch(sansBloquer("missions-runtime.avancerMission.prechargerCapacitesDynamiques", 0));
    await assurerFormes();
    return avancerMissionInterne(user, missionId, opts);
  });
}

async function avancerMissionInterne(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage & { maxTours?: number } = {},
) {
  const proprietaire = await prisma.mission.findFirst({
    where: { id: missionId, ownerId: user.id },
    select: { id: true, complexity: true },
  });
  // LE CLOISONNEMENT EST ICI, PAS PLUS LOIN : une mission qui n'appartient pas à la personne
  // n'avance pas, quels que soient ses droits par ailleurs. La mission porte les droits de son
  // propriétaire ; la faire avancer sous quelqu'un d'autre les emprunterait.
  if (!proprietaire) return null;

  const { deps } = assembler(user, {
    ...opts,
    complexite: opts.complexite ?? (proprietaire.complexity as "A" | "B" | "C" | null) ?? "B",
  });
  const agent = agentPour({ initiatedBy: user.id, executedBy: user.id, label: user.name });
  const res = await avancer(missionId, agent, { ...deps, maxTours: opts.maxTours });
  // ── UNE QUESTION AU DIRIGEANT SE POSE, ELLE NE S'ATTEND PAS EN SILENCE ─────────────────
  //
  // Une étape WAIT_INPUT met la mission en WAITING_INPUT ; avant ce crochet, personne n'était
  // prévenu — la mission dormait jusqu'à ce que quelqu'un ouvre l'écran. La porte d'attention
  // classe la question en ARBITRAGE et ne la redemande pas d'elle-même (cadence infinie).
  if (res.status === "WAITING_INPUT") {
    const q = await prisma.missionStep.findFirst({
      where: { missionId, status: "WAITING", nodeType: "WAIT_INPUT" },
      select: { key: true, title: true, waitFor: true },
      orderBy: { updatedAt: "desc" },
    }).catch(sansBloquer("missions-runtime.avancerMissionInterne.missionStep", null));
    if (q) {
      const ask = (q.waitFor as { ask?: unknown } | null)?.ask;
      const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { title: true, planVersion: true } }).catch(sansBloquer("missions-runtime.avancerMissionInterne.mission", null));
      await porteAttentionPour().signaler({
        kind: "QUESTION", missionId, ownerId: user.id, titre: m?.title ?? "",
        raison: typeof ask === "string" && ask.trim() ? ask : `« ${q.title} » attend un élément de votre part.`,
        decision: "répondre depuis l'écran de la mission", stepKey: q.key, planVersion: m?.planVersion ?? null,
      }).catch(sansBloquer("missions-runtime.avancerMissionInterne.signaler"));
    }
  }
  return res;
}
