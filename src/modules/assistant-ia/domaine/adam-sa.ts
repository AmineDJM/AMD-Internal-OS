/**
 * LA CHARGE D'UNE CARTE D'ADAM (lot A2, décision 0054) — pure : l'outil d'Adam à exécuter à la confirmation, et son
 * entrée telle que le modèle l'a donnée. Exécutée par `infra/adam/outils-adam.ts`, pour le seul Super Admin.
 */
export const KIND_ADAM_SA = "adam_sa_op";

export interface ChargeAdamSA {
  kind: typeof KIND_ADAM_SA;
  outil: string;
  /** L'entrée de l'outil, en JSON (≤ 20 000 caractères). */
  entree: string;
}

export const estChargeAdamSA = (p: unknown): p is ChargeAdamSA =>
  !!p && typeof p === "object" && (p as { kind?: unknown }).kind === KIND_ADAM_SA
  && typeof (p as { outil?: unknown }).outil === "string" && typeof (p as { entree?: unknown }).entree === "string";
