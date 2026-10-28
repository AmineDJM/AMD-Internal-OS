import type { CurrentUser } from "@/lib/session";
import { peutPiloterMissionsAdam } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { approbationsEnAttente, decider } from "@/lib/missions/approval/gate";
import { annuler, mettreEnPause, reprendre } from "@/lib/missions/runtime/control";
import { ECRAN_REGLAGES_ADAM, suspendreMissions } from "@/lib/interrupteurs/missions";
import { avancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE CONDUITE, VUS DEPUIS ADAM — et pourquoi ils passent par le pont.
 *
 * ── LE CLIQUET A TRANCHÉ, ET IL AVAIT RAISON ────────────────────────────────────────────
 *
 * L'outil `mission_control` vit dans `src/lib/assistant/` : le périmètre d'Adam. Y importer
 * directement `missions/runtime/control` et `missions/approval/gate` ajoutait deux
 * franchissements de la frontière Adam → ERP, et `boundary.test.ts` l'a refusé.
 *
 * La bonne réponse n'était pas de relever le plafond mais de reconnaître ce qu'est ce code :
 * une COMPOSITION, exactement comme `runtime.ts` et `sweep.ts` à côté. Le pont est le seul
 * endroit d'Adam autorisé à connaître l'ERP ; c'est sa raison d'être, et c'est ce qui garde la
 * propriété utile — arracher Adam, c'est supprimer `assistant/`, `models/` et `in-process/`,
 * et le Mission Runtime reste debout.
 *
 * ── CE QUE CE FICHIER N'EXPOSE PAS, DÉLIBÉRÉMENT ────────────────────────────────────────
 *
 * `decider(GRANTED)` et `fournirEntree`. Ce sont des attestations humaines : elles passent par
 * une vraie session, sur `/missions/<id>`. Le REFUS, lui, est ici — parce qu'il ne fait que
 * réduire ce qui va se produire, et qu'une injection qui ferait refuser une mission se voit
 * immédiatement et se répare d'un clic.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface GesteMission {
  fait: boolean;
  statut: string | null;
  message: string;
}

export async function pauserMission(
  user: CurrentUser, missionId: string, motif?: string,
): Promise<GesteMission> {
  const r = await mettreEnPause(missionId, user.id, motif);
  return { fait: r.ok, statut: r.vers, message: r.message };
}

/**
 * REPREND, puis RELANCE tout de suite.
 *
 * Sans la relance, la personne qui vient de dire « reprends » verrait « suspendue » jusqu'au
 * prochain battement — jusqu'à une minute pendant laquelle rien ne semble se passer.
 */
export async function reprendreMissionAgent(
  user: CurrentUser, missionId: string,
): Promise<GesteMission> {
  const r = await reprendre(missionId, user.id);
  if (!r.ok) return { fait: false, statut: r.vers, message: r.message };
  await avancerMission(user, missionId, { maxTours: 25 }).catch(sansBloquer("control.reprendreMissionAgent.avancerMission"));
  return { fait: true, statut: "RUNNING", message: r.message };
}

/**
 * « BLOQUE TOUTES LES MISSIONS D'ADAM » — l'interrupteur global, dans le SEUL sens qu'une
 * conversation a le droit de prendre (§118.132, §118.15).
 *
 * POSER réduit : au pire, une injection gèle le moteur, ce qui se voit sur tous les écrans et
 * se lève d'un clic. LEVER rouvre un moteur : ce geste n'existe PAS ici — il vit dans l'écran
 * des réglages d'Adam, dont le fichier d'actions est refusé au chemin générique (§118.78). Le
 * message le dit à la personne au lieu de faire semblant.
 *
 * Réservé au Super Admin, comme tout ce qui touche aux missions d'Adam (§118.136) : c'est un
 * fait qui vaut pour TOUT LE MONDE, et l'outil qui porte ce geste n'est de toute façon exposé
 * qu'à lui — la garde est ici aussi, pour tout appelant présent ou futur (§118.71).
 */
export async function suspendreToutesLesMissions(
  user: CurrentUser, motif?: string,
): Promise<GesteMission> {
  if (!peutPiloterMissionsAdam(user)) {
    return {
      fait: false, statut: null,
      message: "L'interrupteur global des missions est réservé au Super Admin, comme toutes les missions d'Adam : "
        + "il gèle les missions de tout le monde.",
    };
  }
  const r = await suspendreMissions(user.id);
  if (r.change) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Chief of Staff",
      summary: `Missions d'Adam SUSPENDUES depuis la conversation (interrupteur global)${motif ? ` — ${motif}` : ""}`,
    }).catch(sansBloquer("control.suspendreToutesLesMissions.recordAudit"));
  }
  return {
    fait: true, statut: null,
    message: (r.change
      ? "Toutes les missions d'Adam sont suspendues : plus rien n'avance, ne se replanifie, ne se lance ni ne "
        + "notifie, pour tout le monde. Rien n'est perdu — chaque mission repartira où elle en était. "
      : "Les missions étaient déjà suspendues. ")
      + `La levée ne se fait pas d'ici : c'est un clic dans les Réglages d'Adam (${ECRAN_REGLAGES_ADAM}). `
      + "Pour arrêter DÉFINITIVEMENT les missions bloquées (celles de banc, par exemple), le Centre de "
      + "missions a un bouton « Arrêter les missions bloquées ».",
  };
}

export async function arreterMissionAgent(
  user: CurrentUser, missionId: string, motif?: string,
): Promise<GesteMission> {
  const r = await annuler(missionId, user.id, motif);
  return { fait: r.ok, statut: r.vers, message: r.message };
}

/**
 * REFUSE L'AUTORISATION QU'UNE MISSION DEMANDE.
 *
 * On cherche dans la liste des accords EN ATTENTE DE CETTE PERSONNE : c'est le cloisonnement
 * lui-même. Une mission dont on n'attend rien ne donne rien à refuser, et on le dit.
 */
export async function refuserAccordMission(
  user: CurrentUser, missionId: string,
): Promise<GesteMission> {
  const cible = (await approbationsEnAttente(user.id)).find((a) => a.missionId === missionId);
  if (!cible) {
    return { fait: false, statut: null, message: "Cette mission n'attend aucune autorisation de votre part." };
  }
  const ok = await decider(cible.id, "REFUSED", user.id);
  return {
    fait: ok,
    statut: null,
    message: ok
      ? "Refus enregistré. Les étapes concernées ne seront pas exécutées."
      : "Cette demande avait déjà été tranchée.",
  };
}

/**
 * RÉÉCRIT LE PLAN, PUIS RELANCE.
 *
 * Le geste est ici parce qu'il ne peut RIEN faire sortir sans accord : tout ce que le nouveau
 * plan ajoute est rouvert à l'approbation de la personne par `reouvrirSiChange` (§8). Une
 * injection qui le déclencherait obtiendrait donc, au pire, une demande d'accord de plus — ce
 * qui se voit, et se refuse d'un clic.
 */
export async function replanifierAgent(
  user: CurrentUser, missionId: string,
): Promise<GesteMission> {
  const r = await replanifierMission(user, missionId);
  if (!r.replanifie) return { fait: false, statut: null, message: r.raison };
  await avancerMission(user, missionId, { maxTours: 25 }).catch(sansBloquer("control.replanifierAgent.avancerMission"));
  return { fait: true, statut: null, message: r.raison };
}

/**
 * PRIORISE une mission (« celle-ci passe devant ») — le battement sert les priorités hautes
 * d'abord, l'ancienneté ensuite : personne ne meurt de faim. L'appartenance est vérifiée par
 * la requête elle-même : la mission d'un autre ne bouge pas.
 */
export async function prioriserMission(
  user: CurrentUser, missionId: string, priorite: number,
): Promise<GesteMission> {
  const { prisma } = await import("@/lib/prisma");
  const { journaliser } = await import("@/lib/missions/runtime/store");
  const p = Math.max(-10, Math.min(10, Math.round(priorite)));
  const r = await prisma.mission.updateMany({
    where: { id: missionId, ownerId: user.id, kind: "RUNTIME" },
    data: { priority: p },
  });
  if (r.count !== 1) return { fait: false, statut: null, message: "Mission introuvable (ou pas la vôtre)." };
  await journaliser(missionId, "PRIORITY", `Priorité réglée à ${p}.`, { priorite: p }, user.id);
  return { fait: true, statut: null, message: p > 0 ? `Priorité relevée (${p}) : elle passera devant.` : `Priorité réglée (${p}).` };
}

/**
 * PLAFONNE le MODÈLE d'une mission (« ne dépense plus de modèle sur ce dossier aujourd'hui »).
 * Atteint, la mission DORT (BUDGET_HOLD au journal) — elle n'échoue pas ; `null` retire le
 * plafond et le battement la fait repartir au même point.
 */
export async function plafonnerModeleMission(
  user: CurrentUser, missionId: string, cap: number | null,
): Promise<GesteMission> {
  const { prisma } = await import("@/lib/prisma");
  const { journaliser } = await import("@/lib/missions/runtime/store");
  const plafond = cap === null ? null : Math.max(0, Math.round(cap));
  const r = await prisma.mission.updateMany({
    where: { id: missionId, ownerId: user.id, kind: "RUNTIME" },
    data: { modelCallsCap: plafond },
  });
  if (r.count !== 1) return { fait: false, statut: null, message: "Mission introuvable (ou pas la vôtre)." };
  await journaliser(missionId, "BUDGET_SET",
    plafond === null ? "Plafond de modèle retiré." : `Plafond de modèle : ${plafond} appel(s).`,
    { cap: plafond }, user.id);
  return {
    fait: true, statut: null,
    message: plafond === null
      ? "Plafond retiré — la mission peut de nouveau consommer du modèle."
      : `Plafond posé : ${plafond} appel(s) de modèle. Atteint, la mission dormira sans échouer.`,
  };
}
