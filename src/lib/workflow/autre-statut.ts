import type { AdProOtherStatus } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE « AUTRE » DANS LE MOTEUR DE CIRCUIT — la traduction de ce que le moteur écrit.
 *
 * Depuis le 27/10/2026 (décision #17), la demande « autre » suit le circuit commun. Le moteur projette
 * sur l'entité source les statuts « legacy » des quatre autres natures (`AWAITING_PRELIMINARY`,
 * `PRELIMINARY_APPROVED`, `AWAITING_FINAL`, `APPROVED`/`VALIDATED`, `REJECTED`, `RETURNED`…) et leurs
 * colonnes de décision (`finalById`, `finalNote`, `rejectionReason`…). La demande « autre » n'a ni ces
 * statuts ni ces colonnes : `AdProOtherRequest.status` est une énumération courte, et la décision vit
 * dans `decidedById`/`decidedAt`/`decisionNote`.
 *
 * Plutôt que d'apprendre au moteur une sixième façon d'écrire, on TRADUIT ici, à l'écriture, une fois :
 *   • tout statut « en circuit » (attente préliminaire, Directeur des opérations, Direction Marketing,
 *     appel…) → `AWAITING_DECISION` — l'étape exacte se lit sur l'instance, pas sur la ligne ;
 *   • l'accord (`APPROVED`, `VALIDATED`, `PRE_VALIDATED`…) → `APPROVED` (« prévalidée ») ;
 *   • le refus → `REFUSED` ; le renvoi pour correction → `RETURNED` (« à corriger ») ;
 *   • `DRAFT`, `DONE`, `CANCELLED` passent tels quels ;
 *   • toute autre clé (montant accordé, référent, ordre global…) est ABANDONNÉE : la colonne n'existe
 *     pas, et l'argent de cette nature se décide poste par poste.
 *
 * Module PUR (aucune base) — éprouvé sans base, et lu par `engine.ts` (`updateEntity`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EN_ACCORD = new Set(["APPROVED", "VALIDATED", "PRE_VALIDATED", "ACCEPTED", "CLOSED", "COMPLETED", "PAID"]);
const EN_REFUS = new Set(["REJECTED", "REFUSED"]);
const TELS_QUELS = new Set<AdProOtherStatus>(["DRAFT", "DONE", "CANCELLED", "RETURNED"]);

/** Le statut d'une demande « autre » pour un statut legacy écrit par le moteur (`null` : rien à écrire). */
export function statutAutreDepuisCircuit(legacy: unknown): AdProOtherStatus | null {
  if (typeof legacy !== "string" || !legacy) return null;
  if (TELS_QUELS.has(legacy as AdProOtherStatus)) return legacy as AdProOtherStatus;
  if (EN_ACCORD.has(legacy)) return "APPROVED";
  if (EN_REFUS.has(legacy)) return "REFUSED";
  // AWAITING_PRELIMINARY, PRELIMINARY_APPROVED, AWAITING_FINAL, APPEAL_PENDING, AWAITING_DECISION…
  return "AWAITING_DECISION";
}

/** Les colonnes qu'une écriture du moteur peut toucher sur une demande « autre ». */
export interface EcritureAutre {
  status?: AdProOtherStatus;
  decidedById?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string | null;
  updatedById?: string;
}

/**
 * TRADUIT une écriture du moteur (pensée pour les congrès / l'événement / le sponsoring) en colonnes de
 * la demande « autre ». Le statut se lit sur `status` (le champ legacy de cette nature), à défaut sur
 * `requestStatus` (que la branche terminale du moteur écrit pour les natures non-sponsoring, avec
 * `status: "VALIDATED"`). La décision vient de `finalById`/`finalAt` et du motif (`finalNote`,
 * `finalDecision`, `rejectionReason`). Tout le reste est abandonné.
 */
export function ecritureAutreDepuisCircuit(data: Record<string, unknown>): EcritureAutre {
  const out: EcritureAutre = {};
  const statut = statutAutreDepuisCircuit(data.status ?? data.requestStatus);
  if (statut) out.status = statut;
  if (typeof data.finalById === "string") out.decidedById = data.finalById;
  if (data.finalAt instanceof Date) out.decidedAt = data.finalAt;
  const motif = [data.finalNote, data.finalDecision, data.rejectionReason].find((v) => typeof v === "string" && v.trim());
  if (typeof motif === "string") out.decisionNote = motif;
  else if ("finalById" in data && ("finalNote" in data || "finalDecision" in data || "rejectionReason" in data)) out.decisionNote = null;
  if (typeof data.updatedById === "string") out.updatedById = data.updatedById;
  return out;
}
