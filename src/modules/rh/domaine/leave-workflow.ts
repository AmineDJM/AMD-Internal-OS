/**
 * CIRCUIT DE VALIDATION D'UN CONGÉ — deux marches : **N+1 → RH** (la marche DG est supprimée — Direction, 06/10 ;
 * une demande déjà arrivée à la DG avant ce changement reste tranchable par elle et s'y accorde).
 *
 * Chacune répond à une question que les autres ne savent pas trancher : le responsable direct
 * connaît la charge de l'équipe et l'absence tolérable, les RH le solde acquis et le droit
 * applicable, la direction générale l'arbitrage final. Une seule signature ne pouvait pas
 * porter les trois.
 *
 * Un REFUS arrête tout : inutile de faire monter au DG ce que le responsable a déjà écarté —
 * et cruel de laisser espérer l'employé pendant deux étapes de plus.
 *
 * ⚠️ L'ENCHAÎNEMENT lui-même vit dans `approval-chain.ts` : la FORMATION suit exactement le
 * même chemin, et deux copies auraient fini par diverger sur le seul point qui compte — à quel
 * moment la demande est réellement accordée. Ce fichier n'apporte que le VOCABULAIRE du congé.
 *
 * Module PUR (aucun accès base, aucun import lourd) : importable côté client comme serveur.
 */

import {
  nextChainStage, canDecideChain, applyChainDecision, chainNotifyRoles,
  type ChainStage, type ChainStatus, type ChainDecider, type ChainState, type ChainTransition,
} from "@/lib/approval-chain";

export type LeaveStage = ChainStage;
export type LeaveStatus = ChainStatus;
export type LeaveDecider = ChainDecider;
export type LeaveState = ChainState;
export type LeaveTransition = ChainTransition;

export const LEAVE_STAGE_LABELS: Record<LeaveStage, string> = {
  MANAGER: "En attente du responsable (N+1)",
  HR: "En attente des ressources humaines",
  DG: "En attente de la direction générale",
  DONE: "Circuit terminé",
};

/** L'étape qui suit, quand la marche courante approuve. */
export function nextStage(stage: LeaveStage): LeaveStage {
  return nextChainStage(stage, { sansDG: true });
}

/**
 * Cette personne peut-elle trancher MAINTENANT ? Le refus dit CE QUI manque — « non autorisé »
 * ne permet à personne de comprendre quoi faire.
 */
export function canDecideLeave(state: LeaveState, decider: LeaveDecider): { ok: boolean; reason?: string } {
  const r = canDecideChain(state, decider);
  // Le message générique parle de « demande » ; ici, on nomme la chose.
  if (!r.ok && r.reason === "On ne valide pas sa propre demande.") {
    return { ok: false, reason: "On ne valide pas sa propre demande de congé." };
  }
  return r;
}

/**
 * L'état APRÈS une décision. Approuver fait monter d'une marche ; la dernière (RH) accorde
 * définitivement — et c'est là, et là seulement, que le solde se débite. Refuser clôt le
 * circuit sur-le-champ.
 */
export function applyLeaveDecision(stage: LeaveStage, decision: "APPROVED" | "REJECTED"): LeaveTransition {
  return applyChainDecision(stage, decision, { sansDG: true });
}

/** Qui doit être prévenu de l'arrivée d'une demande à cette étape (rôles de repli). */
export function stageNotifyRoles(stage: LeaveStage): string[] {
  return chainNotifyRoles(stage);
}
