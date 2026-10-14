import type { SessionUser } from "@/lib/rbac";
import { userCan } from "@/lib/rbac";
import { visibleTabs } from "@/lib/nav-tabs";
import { BUDGET_MARKETING_TABS } from "@/lib/labels";
import type { ModuleTab } from "@/components/shared/module-tabs";
import { enveloppesGerees, vueDuLot, type EnveloppeCandidate, type VueLot } from "@/lib/budget-marketing/integration-serveur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ONGLETS DU BUDGET MARKETING (maquette « onglets » validée, Direction 10/2026) : Vue d'ensemble · Dépenses ·
 * Demandes Ad & Pro · Réglages, puis « Intégration 2026 » — un onglet à part entière, plus un bandeau des Réglages.
 *
 * L'onglet Intégration n'apparaît qu'à qui GÈRE une enveloppe Budget Marketing couvrant 2026 (la porte des gestes
 * d'intégration : `enveloppesGerees`, `canManageEnvelope`) ; il porte le nombre d'éléments « absents du fichier » encore
 * à décider sur l'enveloppe regardée (ou, à défaut, la première gérée — celle que l'onglet ouvrira).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const CHEMIN_INTEGRATION = "/budget-marketing/integration";

export interface ContexteIntegration {
  /** Les enveloppes Budget Marketing 2026 que la personne gère. */
  gerees: EnveloppeCandidate[];
  /** L'enveloppe que l'onglet Intégration ouvre : celle regardée si elle est gérée, sinon la première. */
  enveloppe: EnveloppeCandidate | null;
  /** Son lot actif, lu (`vueDuLot`) — `null` sans lot. */
  lot: VueLot | null;
}

/**
 * Ce que l'intégration dit à la personne pour l'enveloppe regardée. `lotConnu` évite de relire un lot déjà lu par la
 * page (même enveloppe).
 */
export async function contexteIntegration(user: SessionUser, envIdVu: string | null, lotConnu?: { envelopeId: string; lot: VueLot | null }): Promise<ContexteIntegration> {
  const gerees = userCan(user, "BUDGET_MARKETING", "VIEW") ? await enveloppesGerees(user) : [];
  const enveloppe = gerees.find((e) => e.id === envIdVu) ?? gerees[0] ?? null;
  if (!enveloppe?.lotActif) return { gerees, enveloppe, lot: null };
  const lot = lotConnu && lotConnu.envelopeId === enveloppe.id ? lotConnu.lot : await vueDuLot(user, enveloppe.id);
  return { gerees, enveloppe, lot };
}

/** Le nombre d'éléments « absents du fichier » encore à décider d'un lot. */
export const nombreADecider = (lot: VueLot | null): number => lot?.absentes.filter((a) => a.decision === null).length ?? 0;

/** Les onglets du module, l'onglet Intégration compris quand la personne gère une enveloppe 2026. */
export async function ongletsBudgetMarketing(user: SessionUser, ctx: ContexteIntegration): Promise<ModuleTab[]> {
  const base = await visibleTabs(user, BUDGET_MARKETING_TABS);
  return [
    ...base,
    { label: "Intégration 2026", href: CHEMIN_INTEGRATION, show: ctx.gerees.length > 0, compte: nombreADecider(ctx.lot), tonCompte: "warning" },
  ];
}
