/**
 * Assistant IA (Chatbot) — boucle agent **serveur uniquement**.
 *
 * L'assistant comprend l'application et les données de l'utilisateur (toujours
 * filtrées par ses droits RBAC), répond à ses questions, et **propose** des
 * actions concrètes (créer une tâche, une demande administrative). Conformément
 * au choix « Confirmer chaque action avant exécution », l'assistant n'exécute
 * jamais lui-même une action : il l'intercepte et la renvoie au client pour une
 * confirmation explicite (voir `assistant-actions.ts` pour l'exécution réelle,
 * ré-autorisée et journalisée).
 *
 * Outils de LECTURE : exécutés automatiquement pendant la boucle, ils ne
 * renvoient que des données déjà visibles par l'utilisateur (scopes RBAC).
 * Outils d'ÉCRITURE : jamais exécutés ici — interceptés et transformés en
 * « action proposée » soumise à confirmation.
 *
 * La clé API reste serveur uniquement ; sans `ANTHROPIC_API_KEY`, l'appelant
 * affiche « IA non configurée ».
 *
 * DÉCOUPÉ PAR RESPONSABILITÉ (lot V4) : ce fichier n'est plus qu'une PORTE qui réexporte.
 * Le code vit dans `src/lib/assistant/` : `coeur/` (contrat des actions, prompt, franchissements
 * ERP), `outils/` (catalogues et lectures), `propositions/` (cartes à confirmer, par famille),
 * `actions-confirmees/` (exécution, par famille) et `boucle/` (boucle agent, flux, entrées).
 * Les morceaux n'importent jamais cette porte : ils s'importent entre frères.
 */

import "@/platform/in-process/telemetry/usage-sink";

export {
  type ChatTurn, type AssistantActionPayload, type AssistantActionKind, ACTION_POLICY,
  payloadRequiresStrongConfirm, type ProposedAction, type AssistantMetrics, type AssistantResult,
} from "./assistant/coeur/contrat-actions";
export { RESOLVER_WRITE_NAMES, assistantToolsFor } from "./assistant/outils/catalogue-ecriture";
export { assistantIdentityContext, buildChiefOfStaffContext } from "./assistant/coeur/prompt";
export { executeReadTool } from "./assistant/outils/lecture";
export { buildProposal } from "./assistant/propositions/construire";
export { outilsCreesParmi } from "./assistant/boucle/commun";
export { type AssistantStreamEvent, extractSources, resolveSpokenMailApproval } from "./assistant/boucle/sources";
export type { ExecuteResult } from "./assistant/actions-confirmees/aides";
export { performAction } from "./assistant/actions-confirmees/executer";
export { type AssistantRunOptions, runAssistant, runAssistantStream } from "./assistant/boucle/entree";
