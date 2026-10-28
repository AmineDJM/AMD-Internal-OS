import type { PowerTool } from "@/lib/assistant/power-tools";
import type { CurrentUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { EXEC } from "./executive-tools/commun";
import { OUTILS_DRIVE } from "./executive-tools/drive";
import { OUTILS_INSPECT_RECORD } from "./executive-tools/inspect-record";
import { OUTILS_PERSON_REPORT } from "./executive-tools/person-report";
import { OUTILS_PLANIFICATION } from "./executive-tools/planification";

/**
 * LES OUTILS EXÉCUTIFS — « My Chief of Staff », réservé au PDG et au Super Admin.
 *
 * Le Chief of Staff n'est pas un chatbot de plus : c'est l'interface de PILOTAGE. Ces outils lui
 * donnent ce qu'un chef de cabinet fait vraiment — fouiller le Drive et LIRE les pièces,
 * reconstituer l'HISTOIRE COMPLÈTE d'un dossier (devis → BC → validateurs → facture → règlement,
 * avec les dates), dresser le BILAN FACTUEL du travail d'une personne, et PLANIFIER (« rappelle-moi
 * mardi », « tous les dimanches relance Regulatory »).
 *
 * Trois règles, non négociables :
 *   • la PERMISSION se vérifie CÔTÉ SERVEUR, ici, à chaque appel — la liste d'outils envoyée au
 *     modèle n'est qu'une suggestion (`allowed`, revérifié par `executePowerTool`) ;
 *   • les PREUVES accompagnent chaque réponse : références, dates, auteurs, LIENS internes —
 *     jamais « le paiement est bloqué » sans dire lequel, depuis quand, chez qui ;
 *   • quand une donnée n'existe pas, l'outil le DIT (« aucune trace de… ») — il n'infère pas.
 *
 * Découpé dans `executive-tools/` : `commun.ts` (les aides partagées) et un fichier par famille
 * d'outils ; ce fichier recompose `EXECUTIVE_TOOLS` dans l'ordre d'origine et garde le briefing.
 */

export const EXECUTIVE_TOOLS: PowerTool[] = [
  ...OUTILS_DRIVE,
  ...OUTILS_INSPECT_RECORD,
  ...OUTILS_PERSON_REPORT,
  ...OUTILS_PLANIFICATION,
];

/** Le briefing du mode exécutif — annonce les pouvoirs, sinon le modèle ne les utilise pas. */
export function executiveBriefing(user: CurrentUser): string {
  if (!EXEC(user)) return "";
  void hasGlobalView;
  // COMPACT, ET C'EST VOULU. La version précédente (11 600 caractères) était le mode d'emploi
  // de trente outils — chacun porte déjà sa description dans son schéma, et le routeur choisit
  // la liste courte. Ce qui reste : le ton du chef de cabinet et les RÉFLEXES de jugement qu'un
  // schéma ne peut pas porter (quelle source fait autorité pour quelle question).
  return `

MODE EXÉCUTIF — chef de cabinet du dirigeant. Ton DIRECT, CHIFFRÉ, SOURCÉ : une question simple reçoit une ou deux
phrases avec le chiffre et sa source ; une question complexe, une synthèse structurée. Jamais de politesse de
remplissage. Réflexes : quand on ignore OÙ est la chose, la recherche fédérée (les PERSONNES et leurs coordonnées :
l'annuaire, directory_lookup / directory_list) ; « où en est », « qui a validé », « a-t-on payé » : la fiche complète
(inspect_record) ; un document se LIT (read_document) avant d'être résumé ou chiffré ; l'argent d'un produit :
product_economics, un marché PCH de la soumission à l'encaissement : pch_market_status — PAS la séquence de lectures
qu'ils remplacent ; l'état PASSÉ : time_travel, « qu'est-ce qui a changé » : what_changed ; « on avait décidé quoi ? » :
episodic_recall avant tout « je ne retrouve rien ». Une lecture qui rend zéro INDIQUE l'outil à prendre — le suivre
au lieu de relancer la même recherche.`;
}
