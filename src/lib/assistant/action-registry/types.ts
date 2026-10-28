import type { CurrentUser } from "@/lib/session";

/**
 * TYPES DU REGISTRE D'ACTIONS — la forme d'une action native (`NativeAction`), son risque, et la
 * porte Super Admin partagée par les morceaux de `action-registry/` (réexportés par `../action-registry.ts`).
 */

export type ActionRisk = "NORMAL" | "SENSITIVE" | "CRITICAL";

export interface NativeAction {
  /** Id stable de l'action ERP (indépendant du nom d'outil). */
  id: string;
  /** Module d'écran, en français (« Finances », « Regulatory »…). */
  module: string;
  /** Le libellé du bouton / geste tel qu'il s'affiche à l'écran. */
  uiLabel: string;
  /** L'outil du Chief qui PROPOSE cette action (confirmation obligatoire ensuite). */
  toolName: string;
  /** Outil de DOMAINE : la valeur du champ `op` à passer (ex. `drive_operation` op `move`). */
  toolOp?: string;
  /** Formulations naturelles (français) qui désignent cette action. */
  aliases: string[];
  risk: ActionRisk;
  /** Ce que l'action fait, qui est touché, réversibilité — la sémantique, pas le mécanisme. */
  summary: string;
  /** LA MÊME PORTE QUE L'ÉCRAN (pré-filtre synchrone ; l'exécution revérifie toujours). */
  gate: (user: CurrentUser) => boolean;
  /** Ouverture supplémentaire que le pré-filtre synchrone ne sait pas vérifier (réglages DB). */
  gateNote?: string;
}

export const isSA = (u: CurrentUser) => u.role === "SUPER_ADMIN";
