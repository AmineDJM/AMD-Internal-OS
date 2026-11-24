/**
 * CIRCUIT À TROIS MARCHES — **N+1 → RH → DG**.
 *
 * Deux demandes très différentes suivent exactement ce chemin : le CONGÉ et la FORMATION.
 * Ce n'est pas une coïncidence — dans les deux cas, trois questions se posent qu'une seule
 * personne ne sait pas trancher : le responsable direct connaît la charge de l'équipe et
 * l'absence tolérable, les RH le droit applicable et le budget, la direction générale
 * l'arbitrage final.
 *
 * Le moteur est donc écrit UNE fois, ici, en termes neutres ; `leave-workflow.ts` lui donne
 * ses libellés « congé », le module Formation les siens. Deux copies du même enchaînement
 * auraient fini par diverger sur le seul point qui compte : à quel moment la demande est
 * réellement accordée.
 *
 * Un REFUS arrête tout, à n'importe quelle marche : inutile de faire monter au DG ce que le
 * responsable a déjà écarté — et cruel de laisser espérer pendant deux étapes de plus.
 *
 * Module PUR (aucun accès base, aucun import lourd) : importable côté client comme serveur.
 */

/**
 * `OPERATIONS` — la dernière marche de la FORMATION depuis le 24/11/2026 : « toutes les formations (réglementaires comprises)
 * passent par l'autorisation du Directeur des opérations », sans le DG. Le congé ne la connaît pas.
 */
export type ChainStage = "MANAGER" | "HR" | "DG" | "OPERATIONS" | "DONE";
export type ChainStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export const CHAIN_STAGE_LABELS: Record<ChainStage, string> = {
  MANAGER: "En attente du responsable (N+1)",
  HR: "En attente des ressources humaines",
  DG: "En attente de la direction générale",
  OPERATIONS: "En attente du Directeur des opérations",
  DONE: "Circuit terminé",
};

/**
 * L'étape qui suit, quand la marche courante approuve. `sansDG` : le circuit s'arrête aux RH — c'est celui du CONGÉ
 * depuis la décision de la Direction (06/10 : « supprime l'étape DG »). `derniere` : la troisième marche, si ce n'est pas
 * le DG — la FORMATION monte au Directeur des opérations (24/11/2026).
 */
export function nextChainStage(stage: ChainStage, opts: { sansDG?: boolean; derniere?: "DG" | "OPERATIONS" } = {}): ChainStage {
  switch (stage) {
    case "MANAGER": return "HR";
    case "HR": return opts.sansDG ? "DONE" : opts.derniere ?? "DG";
    default: return "DONE";
  }
}

export interface ChainDecider {
  id: string;
  /** Est-il le responsable hiérarchique (N+1) résolu pour cette demande ? */
  isManager: boolean;
  /** Porte-t-il la fonction RH (droit de valider sur le module RH) ? */
  isHr: boolean;
  /** Direction générale / vue globale / Super Admin — l'outrepasse à toute marche. */
  isDg: boolean;
  /** Le Directeur des opérations qui autorise CETTE demande (formation, `rh/domaine/directeurs.ts`). */
  isOps?: boolean;
}

export interface ChainState {
  status: ChainStatus;
  stage: ChainStage;
  /** Le demandeur — personne ne valide sa propre demande. */
  requesterUserId?: string | null;
}

/**
 * Cette personne peut-elle trancher MAINTENANT ?
 *
 * Trois refus possibles, et ils ne disent pas la même chose : la demande est close, ce n'est
 * pas (encore) son tour, ou c'est sa propre demande. Le message doit le dire — « non
 * autorisé » ne permet à personne de comprendre quoi faire.
 */
export function canDecideChain(state: ChainState, decider: ChainDecider): { ok: boolean; reason?: string } {
  if (state.status !== "PENDING" || state.stage === "DONE") {
    return { ok: false, reason: "Cette demande a déjà été traitée." };
  }
  if (state.requesterUserId && state.requesterUserId === decider.id && !decider.isDg) {
    // Le DG garde la main (il est parfois le seul au-dessus) ; personne d'autre ne s'auto-valide.
    return { ok: false, reason: "On ne valide pas sa propre demande." };
  }
  switch (state.stage) {
    case "MANAGER":
      // Le DG peut trancher à toute étape : sans cela, une demande resterait bloquée quand le
      // responsable est absent — précisément la période où elles s'accumulent.
      if (decider.isManager || decider.isDg) return { ok: true };
      return { ok: false, reason: "En attente du responsable hiérarchique (N+1)." };
    case "HR":
      if (decider.isHr || decider.isDg) return { ok: true };
      return { ok: false, reason: "En attente des ressources humaines." };
    case "DG":
      if (decider.isDg) return { ok: true };
      return { ok: false, reason: "En attente de la direction générale." };
    case "OPERATIONS":
      if (decider.isOps || decider.isDg) return { ok: true };
      return { ok: false, reason: "En attente du Directeur des opérations." };
    default:
      return { ok: false, reason: "Circuit terminé." };
  }
}

export interface ChainTransition {
  stage: ChainStage;
  status: ChainStatus;
  /** La demande est-elle DÉFINITIVEMENT accordée (dernière marche franchie) ? */
  granted: boolean;
}

/**
 * L'état APRÈS une décision. Approuver fait monter d'une marche ; la dernière (DG) accorde
 * définitivement. Refuser clôt le circuit sur-le-champ, quelle que soit la marche.
 * Fonction PURE — testée.
 */
export function applyChainDecision(stage: ChainStage, decision: "APPROVED" | "REJECTED", opts: { sansDG?: boolean; derniere?: "DG" | "OPERATIONS" } = {}): ChainTransition {
  if (decision === "REJECTED") return { stage: "DONE", status: "REJECTED", granted: false };
  const next = nextChainStage(stage, opts);
  if (next === "DONE") return { stage: "DONE", status: "APPROVED", granted: true };
  return { stage: next, status: "PENDING", granted: false };
}

/** Qui doit être prévenu de l'arrivée d'une demande à cette étape (rôles de repli). */
/**
 * ⚠️ CES NOMS SONT DES `UserRole` RÉELS. « RH_MANAGER » figurait ici et n'existe pas dans
 * l'énumération : Prisma refusait la requête ENTIÈRE, l'erreur était avalée par le `try/catch`
 * de `notifyRoles`, et **personne** n'était prévenu quand un congé arrivait à l'étape RH — pas
 * même le Super Admin, pourtant correctement listé. Une liste de rôles inventés ne rate pas
 * seulement sa cible : elle fait taire tout l'envoi.
 *
 * Qui porte réellement la fonction RH (`RH: MANAGE`, donc VALIDATE) : la Direction et le
 * Directeur Général. Et la dernière marche appartient au sommet — DG compris (`isTopManagement`).
 */
export function chainNotifyRoles(stage: ChainStage): string[] {
  switch (stage) {
    case "HR": return ["DIRECTION", "GENERAL_MANAGER", "SUPER_ADMIN"];
    case "DG": return ["DIRECTION", "GENERAL_MANAGER", "SUPER_ADMIN"];
    // Le Directeur des opérations est une PERSONNE (l'organigramme) : il est prévenu nommément, jamais par un rôle.
    default: return [];
  }
}

/**
 * DEPUIS QUAND LA DEMANDE ATTEND À SA MARCHE (lot E2 — audit 360°, 07-05) — l'instant où elle y est
 * ARRIVÉE : son dépôt pour la marche du N+1, l'accord du N+1 pour celle des RH, celui des RH (à
 * défaut du N+1) pour la dernière. Une demande qui entre directement aux RH (pas de N+1 résolu)
 * attend depuis son dépôt. Fonction PURE — la file des congés la lit, un test aussi.
 *
 * On ne date pas une marche sur `updatedAt` : une note, une correction de dates par les RH
 * réécrivent la ligne sans que la demande ait bougé, et l'ancienneté repartirait à zéro.
 */
export function arriveeALaMarche(
  stage: ChainStage | string,
  f: { creeLe: Date; n1DecideLe: Date | null; rhDecideLe: Date | null },
): Date {
  if (stage === "HR") return f.n1DecideLe ?? f.creeLe;
  if (stage === "DG" || stage === "OPERATIONS") return f.rhDecideLe ?? f.n1DecideLe ?? f.creeLe;
  return f.creeLe;
}
