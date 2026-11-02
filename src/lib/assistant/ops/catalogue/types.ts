import type { CurrentUser } from "./dependances";

/**
 * TYPES DU CATALOGUE DES OPS — la forme d'une op (`OpMeta`), son niveau de risque, et la porte
 * Super Admin partagée par les morceaux de `catalogue/` (réexportés par `../catalog.ts`).
 */

export type OpRisk = "NORMAL" | "SENSITIVE" | "CRITICAL";

export interface OpMeta {
  /** Outil de domaine porteur (`drive_operation`…). */
  tool: string;
  /** Valeur du champ `op` de l'outil. */
  op: string;
  /** Module d'écran, en français. */
  module: string;
  /** Le libellé du geste tel qu'il se lit à l'écran. */
  uiLabel: string;
  /** Formulations naturelles (repliées par le matcher du registre). */
  aliases: string[];
  risk: OpRisk;
  /** Effet, qui est touché, réversibilité — la sémantique. */
  summary: string;
  /** Pré-filtre synchrone (l'action canonique revérifie toujours). */
  gate: (user: CurrentUser) => boolean;
  gateNote?: string;
  /** Clés d'inventaire `fichier:fonction` que cette op rend NATIVE. */
  covers: string[];
}

export const isSA = (u: CurrentUser) => u.role === "SUPER_ADMIN";
