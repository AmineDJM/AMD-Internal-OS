import type { ClaudeToolDef } from "@/lib/ai";
// L'ORDRE D'ÉVALUATION est conservé à l'identique : catalogue, puis chaque implémentation dans
// l'ordre historique, AVANT les morceaux qui les zippent (`ops/index.ts` et `lib/assistant.ts`
// forment un cycle d'initialisation, voir `capability-audit.test.ts`).
import "./catalog";
import "./impl-capabilite";
import "./impl-drive";
import "./impl-task";
import "./impl-finance";
import "./impl-finance-budget";
import "./impl-finance-flows";
import "./impl-regulatory";
import "./impl-hr";
import "./impl-hr2";
import "./impl-wave2b";
import "./impl-wave3";
import "./impl-meeting";
import "./impl-mail";
import "./impl-legal";
import "./impl-org";
import "./impl-commercial";
import "./impl-wave4";
import "./impl-stock-recurrence";
import "./impl-wave4b";
import "./impl-wave5";
import "./impl-wave5b";
import "./impl-promo-circuit2";
import "./impl-wave6";
import "./impl-wave6b";
import "./impl-wave6c";
import "./impl-tournee";
import "./impl-wave7";
import "./impl-wave7b";
import "./impl-wave7c";
import "./impl-wave7d";
import "./impl-wave8-files";
import "./impl-market360";
import type { DomainToolSpec } from "./outils/assemblage";
import { OUTILS_SOCLE_FINANCES } from "./outils/socle-finances";
import { OUTILS_REGULATORY_RH_BUREAU } from "./outils/regulatory-rh-bureau";
import { OUTILS_COMMERCIAL_PILOTAGE } from "./outils/commercial-pilotage";
import { OUTILS_TERRAIN_LOGISTIQUE } from "./outils/terrain-logistique";

/**
 * ASSEMBLAGE des outils de domaine : le CATALOGUE (métadonnées pures) est zippé avec les
 * IMPLÉMENTATIONS (résolution + exécution) — une op déclarée sans implémentation fait
 * échouer le chargement (donc les tests) : le catalogue ne peut pas promettre dans le vide.
 *
 * Les DÉFINITIONS d'outils Claude sont GÉNÉRÉES d'ici : ajouter une op au catalogue met à
 * jour l'énumération `op` et la description de l'outil sans toucher l'orchestrateur.
 *
 * Découpé dans `outils/` : `assemblage.ts` (forme d'un outil + aides de dérivation) et un
 * fichier par famille d'outils ; ce fichier recompose `DOMAIN_TOOLS` dans l'ordre d'origine.
 */

export type { DomainToolSpec } from "./outils/assemblage";

export const DOMAIN_TOOLS: Record<string, DomainToolSpec> = {
  ...OUTILS_SOCLE_FINANCES,
  ...OUTILS_REGULATORY_RH_BUREAU,
  ...OUTILS_COMMERCIAL_PILOTAGE,
  ...OUTILS_TERRAIN_LOGISTIQUE,
};

export const DOMAIN_TOOL_DEFS: ClaudeToolDef[] = Object.values(DOMAIN_TOOLS).map((t) => t.def);
