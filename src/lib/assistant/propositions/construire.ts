/**
 * CONSTRUIRE UNE ACTION PROPOSÉE — l'outil d'écriture appelé par le modèle devient une carte à
 * confirmer, jamais une écriture. `buildProposal` prépare la fermeture partagée puis interroge les
 * familles (`propositions/*.ts`) dans l'ordre de l'ancienne chaîne de `if`.
 */

import type { CurrentUser } from "@/lib/assistant/coeur/erp";
import { designationDePersonne, direCeQuiEstArrive } from "@/lib/personnes/designation";
import type { ProposedAction } from "@/lib/assistant/coeur/contrat-actions";
import { resolvePerson } from "@/lib/assistant/outils/arguments";
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

  /**
   * Résout une DÉSIGNATION de personne et alimente les avertissements.
   *
   * Elle n'arrive pas toujours en chaîne. Un éventail de mission déploie la sortie de
   * `resolve_person` — un objet `{ nom, adresse, source, detail }` — directement sur l'entrée.
   * Le lecteur d'avant appelait `asStr`, obtenait `""`, et refusait « Destinataire «  »
   * introuvable » sur une personne dont il tenait le nom ET l'adresse. `designationDePersonne`
   * traduit ; il rend `null` sur ce qu'il ne lit pas à coup sûr, et le refus dit alors ce qu'il
   * a réellement reçu au lieu d'un vide trompeur.
   */
  async function resolve(label: string, brut: unknown): Promise<{ id: string | null; name: string | null }> {
    const name = designationDePersonne(brut);
    if (!name) {
      // « Rien fourni » n'est pas « fourni et illisible » : le premier est banal, le second est
      // une anomalie qui doit se voir.
      const vide = brut === undefined || brut === null || (typeof brut === "string" && !brut.trim())
        || (Array.isArray(brut) && brut.length === 0);
      if (!vide) warnings.push(`${label} illisible : ${direCeQuiEstArrive(brut)} — ni nom ni adresse exploitable.`);
      return { id: null, name: null };
    }
    const r = await resolvePerson(name);
    if (!r) {
      warnings.push(`${label} « ${name} » introuvable dans l'annuaire — à préciser.`);
      return { id: null, name };
    }
    if ("ambiguous" in r) {
      warnings.push(`Plusieurs « ${name} » : ${r.ambiguous.map((m) => m.name).join(", ")}. À préciser.`);
      return { id: null, name };
    }
    return { id: r.id, name: r.name };
  }

  // LES FAMILLES, DANS L'ORDRE DE L'ANCIENNE CHAÎNE DE `if` : la première qui reconnaît le cas répond.
  const ctx: ContexteProposition = { toolName, input, user, warnings, resolve, buildProposal };
  for (const famille of FAMILLES_DE_PROPOSITIONS) {
    const proposition = await famille(ctx);
    if (proposition !== undefined) return proposition;
  }

  return { error: `Action non prise en charge : ${toolName}.` };
}
