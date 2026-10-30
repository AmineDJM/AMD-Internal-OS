import type { ClaudeToolDef } from "@/lib/ai";
import type { CurrentUser } from "@/lib/session";

/**
 * UN OUTIL QU'UN ASSISTANT PEUT APPELER — la forme partagée par Adam et par l'Assistant IA.
 *
 * Elle vivait dans `lib/assistant/power-tools.ts`, au milieu du catalogue d'Adam : l'Assistant IA
 * l'importait de là pour décrire ses propres outils, et tirait Adam dans son graphe pour un TYPE.
 * Le socle (`src/platform/ia/`) n'appartient à aucun des deux produits ; la forme d'un outil y vit,
 * et chacun la lit ici. `power-tools.ts` la réexporte pour le code d'Adam qui l'écrivait déjà.
 */
export interface PowerTool {
  def: ClaudeToolDef;
  /** Le droit qui ouvre l'outil — une PERMISSION, jamais un rôle en dur. */
  allowed: (user: CurrentUser) => boolean;
  /**
   * Le REFUS quand `allowed` dit non — facultatif. Par défaut, « ce module ne vous est pas
   * ouvert » ; un outil que ferme une RÈGLE et non un module (les missions d'Adam, réservées au
   * Super Admin) dit la règle et le geste qui reste : un refus qui nomme le remède évite un
   * aller-retour, et un refus qui nomme un faux remède en coûte deux (§118.30, §118.128).
   */
  refus?: string;
  /** Libellé affiché dans la trace (« ce que l'assistant a consulté »). */
  label: string;
  run: (input: Record<string, unknown>, user: CurrentUser) => Promise<string>;
}
