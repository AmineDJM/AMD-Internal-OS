/**
 * L'ESSAI DE L'AGENT D'UNE PERSONNE (Super Admin) — la part PURE, partagée par le service (`infra/essai/service.ts`) et
 * l'écran (`/admin/ai/acces`) : les bornes, ce que l'essai rend. Aucun import : l'écran la charge dans le navigateur.
 */

/** Un message essayé, et chaque question d'un échange précédent. */
export const ESSAI_MESSAGE_MAX = 4000;
/** Une réponse d'un échange précédent (relue par le tour comme un fil ordinaire). */
export const ESSAI_REPONSE_MAX = 12_000;
/** Les échanges précédents de l'essai que le tour relit — au-delà, les plus anciens tombent. */
export const ESSAI_ECHANGES_MAX = 10;

/** Un échange précédent de l'essai : la question posée, la réponse que l'agent a rendue. */
export interface EchangeEssai {
  question: string;
  reponse: string;
}

/** Un tour, tel que l'écran de la personne le reçoit (`filPourEcran`) — sérialisé. */
export type TourEssai = Record<string, unknown> & { id: string; role: string; contenu: string; etat: string; createdAt: string };

export type IssueEssai =
  | {
    ok: true;
    personne: { id: string; nom: string; role: string };
    /** Le refus que la personne aurait reçu au dépôt (assistant fermé, file pleine…) — dit tel quel. */
    refus: string | null;
    /** Le fil de l'essai, tel que son écran l'aurait montré (le dernier tour est la réponse). */
    tours: TourEssai[];
    /** Ce que ce tour AURAIT écrit — annulé (cartes et mémoire comprises). */
    ecritures: string[];
    /** Ce qui serait SORTI — neutralisé (courriel, poussée, appel sortant…). */
    sorties: string[];
    consommation: { appels: number; jetonsEntree: number; jetonsSortie: number; coutUsd: number };
    dureeMs: number;
  }
  | { ok: false; erreur: string };

/** Le dernier échange abouti d'un essai, pour le relire au tour suivant. */
export function echangeDe(question: string, tours: TourEssai[]): EchangeEssai | null {
  const reponse = [...tours].reverse().find((t) => t.role === "assistant" && t.etat === "TERMINE");
  return reponse ? { question, reponse: reponse.contenu } : null;
}
