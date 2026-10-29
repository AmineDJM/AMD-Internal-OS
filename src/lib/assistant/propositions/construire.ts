/**
 * CONSTRUIRE UNE ACTION PROPOSÉE — l'outil d'écriture appelé par le modèle devient une carte à
 * confirmer, jamais une écriture. `buildProposal` prépare la fermeture partagée puis interroge les
 * familles (`propositions/*.ts`) dans l'ordre de l'ancienne chaîne de `if`.
 */

import type { CurrentUser } from "@/lib/assistant/coeur/erp";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { resolveurDePersonnes } from "@/platform/ia/outils/partages";
import type { ContexteProposition } from "@/lib/assistant/propositions/aides";
import { proposerReglementaire } from "@/lib/assistant/propositions/reglementaire";
import { proposerEspaceEtCourrier } from "@/lib/assistant/propositions/espace-et-courrier";
import { proposerDemandes } from "@/lib/assistant/propositions/demandes";
import { proposerPaiementAgendaNotification } from "@/lib/assistant/propositions/paiement-agenda-notification";
import { proposerSuiviEtJuridique } from "@/lib/assistant/propositions/suivi-et-juridique";
import { proposerDonneesEtCorbeille } from "@/lib/assistant/propositions/donnees-et-corbeille";
import { proposerAdministration } from "@/lib/assistant/propositions/administration";
import { proposerComposees } from "@/lib/assistant/propositions/composees";

/** Les familles, dans l'ordre exact de l'ancienne chaîne de `if` (l'ordre est un comportement). */
const FAMILLES_DE_PROPOSITIONS = [
  proposerReglementaire,
  proposerEspaceEtCourrier,
  proposerDemandes,
  proposerPaiementAgendaNotification,
  proposerSuiviEtJuridique,
  proposerDonneesEtCorbeille,
  proposerAdministration,
  proposerComposees,
] as const;

export async function buildProposal(toolName: string, input: Record<string, unknown>, user: CurrentUser): Promise<ProposedAction | { error: string }> {
  const warnings: string[] = [];

  // La résolution de personne (désignation → compte, avertissements) est partagée avec l'Assistant IA : au socle.
  const resolve = resolveurDePersonnes(warnings);

  // LES FAMILLES, DANS L'ORDRE DE L'ANCIENNE CHAÎNE DE `if` : la première qui reconnaît le cas répond.
  const ctx: ContexteProposition = { toolName, input, user, warnings, resolve, buildProposal };
  for (const famille of FAMILLES_DE_PROPOSITIONS) {
    const proposition = await famille(ctx);
    if (proposition !== undefined) return proposition;
  }

  return { error: `Action non prise en charge : ${toolName}.` };
}
