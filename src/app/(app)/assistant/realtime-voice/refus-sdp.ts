/**
 * COUCHE TRANSPORT DE L'APPEL VOCAL — le refus de l'échange SDP, gardé avec ce qu'il dit.
 */
import { parseRetryAfter, isRateLimitStatus } from "@/lib/assistant/voice-cooldown";

/**
 * LE REFUS DE L'ÉCHANGE SDP, AVEC CE QU'IL DIT.
 *
 * `message` reste `SDP_<statut>` : l'appelant historique teste `startsWith("SDP_")`, et on ne
 * casse pas ce contrat au passage. Ce qui est NOUVEAU, c'est tout le reste — le corps de la
 * réponse et l'en-tête `Retry-After`, qu'on jetait.
 *
 * POURQUOI LA DISTINCTION `rateLimited` COMPTE. Un 429 n'est pas une panne : c'est le serveur
 * qui dit « ralentis ». Y répondre en reconnectant aussitôt — ce que faisait la reconnexion
 * automatique — transforme un incident passager en incident qu'on entretient soi-même. Un 500,
 * lui, mérite un nouvel essai. Les traiter pareil, c'est se tromper dans les deux sens.
 */
export class SdpRejection extends Error {
  readonly status: number;
  readonly detail: string;
  /** Délai demandé par le serveur, en millisecondes. `null` s'il n'a rien précisé. */
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, retryAfterHeader: string | null) {
    super(`SDP_${status}`);
    this.name = "SdpRejection";
    this.status = status;
    this.detail = (body ?? "").slice(0, 500);
    this.retryAfterMs = parseRetryAfter(retryAfterHeader);
  }

  /** 429 : quota atteint. 503 : capacité momentanément absente — même conduite à tenir. */
  get rateLimited(): boolean {
    return isRateLimitStatus(this.status);
  }
}
