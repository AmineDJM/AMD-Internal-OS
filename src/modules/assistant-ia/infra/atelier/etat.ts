import { ongletsAtelier } from "@/platform/ia/artifact/atelier/service";
import { conversionsRecentes } from "@/platform/ia/artifact/atelier/conversions";

/**
 * L'ÉTAT DE L'ATELIER, relu par l'écran (route `/api/assistant-ia/atelier`) — toutes les ~0,6 s pendant que
 * l'assistant travaille, sinon à l'ouverture et après chaque geste. Léger à dessein : les onglets (révision,
 * modifié, version) et les conversions récentes ; l'écran ne relit la VUE d'un onglet que si sa révision a bougé.
 */
export async function etatAtelier(userId: string) {
  const [onglets, conversions] = await Promise.all([ongletsAtelier(userId), conversionsRecentes(userId)]);
  return { onglets, conversions };
}
