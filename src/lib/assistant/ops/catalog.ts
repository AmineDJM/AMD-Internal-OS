import { hasGlobalView } from "./catalogue/dependances";
import { isSA, type OpMeta } from "./catalogue/types";
import { OPS_SOCLE } from "./catalogue/socle";
import { OPS_FINANCES } from "./catalogue/finances";
import { OPS_REGULATORY } from "./catalogue/regulatory";
import { OPS_RH } from "./catalogue/rh";
import { OPS_REUNIONS_COURRIERS } from "./catalogue/reunions-courriers";
import { OPS_LEGAL_ORG } from "./catalogue/legal-org";
import { OPS_COMMERCIAL } from "./catalogue/commercial";
import { OPS_MARCHES } from "./catalogue/marches";
import { OPS_STOCKS_ANNUAIRE } from "./catalogue/stocks-annuaire";
import { OPS_GAMMES_ETUDES_EVENTS } from "./catalogue/gammes-etudes-events";
import { OPS_AD_PRO } from "./catalogue/ad-pro";
import { OPS_CONSULTING_PRISES_EN_CHARGE } from "./catalogue/consulting-prises-en-charge";
import { OPS_MATERIEL_PROMOTIONNEL } from "./catalogue/materiel-promotionnel";
import { OPS_BUSINESS_DEV_SUIVI } from "./catalogue/business-dev-suivi";
import { OPS_VALIDATIONS_TERRAIN } from "./catalogue/validations-terrain";
import { OPS_PLANNING_SFE } from "./catalogue/planning-sfe";
import { OPS_DEMANDES_ADMINISTRATIVES } from "./catalogue/demandes-administratives";
import { OPS_REUNIONS_MESSAGERIE } from "./catalogue/reunions-messagerie";
import { OPS_ADMINISTRATION } from "./catalogue/administration";
import { OPS_FICHIERS } from "./catalogue/fichiers";

/**
 * CATALOGUE DES OPS DE DOMAINE — la couche SYSTÉMIQUE qui ferme les trous de parité en série.
 *
 * Une « op » = un geste métier de l'écran (bouton, menu, décision) exposé au Chief à travers un
 * OUTIL DE DOMAINE (`drive_operation`, `task_operation`, `finance_operation`…) : l'outil reçoit
 * `{ op, ...entrées humaines }`, la proposition résout et montre, l'exécution appelle L'ACTION
 * CANONIQUE de l'écran. Ce fichier ne contient QUE les MÉTADONNÉES (pur, sans Prisma ni actions
 * serveur) : le registre ZERO-GAP l'importe pour la découverte, les alias et la reclassification
 * AUTOMATIQUE de l'inventaire (chaque op déclare les server actions qu'elle couvre — les ajouter
 * ici fait passer leurs clés de GAP à NATIVE sans toucher la classification à la main).
 *
 * Les implémentations (résolution + exécution) vivent dans `impl-<domaine>.ts`, importées par
 * l'orchestrateur seulement.
 *
 * Découpé par famille d'ops dans `catalogue/` (`types.ts` + un fichier par famille) : ce fichier
 * recompose `OPS_CATALOG` dans l'ordre d'origine et garde l'index et les aides.
 */

export type { OpRisk, OpMeta } from "./catalogue/types";

export const OPS_CATALOG: OpMeta[] = [
  ...OPS_SOCLE,
  ...OPS_FINANCES,
  ...OPS_REGULATORY,
  ...OPS_RH,
  ...OPS_REUNIONS_COURRIERS,
  ...OPS_LEGAL_ORG,
  ...OPS_COMMERCIAL,
  ...OPS_MARCHES,
  ...OPS_STOCKS_ANNUAIRE,
  ...OPS_GAMMES_ETUDES_EVENTS,
  ...OPS_AD_PRO,
  ...OPS_CONSULTING_PRISES_EN_CHARGE,
  ...OPS_MATERIEL_PROMOTIONNEL,
  ...OPS_BUSINESS_DEV_SUIVI,
  ...OPS_VALIDATIONS_TERRAIN,
  ...OPS_PLANNING_SFE,
  ...OPS_DEMANDES_ADMINISTRATIVES,
  ...OPS_REUNIONS_MESSAGERIE,
  ...OPS_ADMINISTRATION,
  ...OPS_FICHIERS,
];

/** Index par outil → op (généré une fois). */
export const OPS_BY_TOOL: Record<string, Record<string, OpMeta>> = {};
for (const m of OPS_CATALOG) {
  (OPS_BY_TOOL[m.tool] ??= {})[m.op] = m;
}

/** Toutes les clés d'inventaire couvertes par le catalogue (reclassées NATIVE par le registre). */
export function catalogCoveredKeys(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of OPS_CATALOG) for (const k of m.covers) out.set(k, `${m.tool}:${m.op}`);
  return out;
}
