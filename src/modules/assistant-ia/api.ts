/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE ASSISTANT IA — LA PORTE SERVEUR (« Adventum Brain », Mastra + `gpt-6.1-terra`).
 *
 * Hors de `src/modules/assistant-ia/`, on importe CE fichier (ou `./partage` pour les règles pures, ou les
 * fichiers d'actions), jamais `domaine/` ni `infra/` : tenu par ESLint et `src/modules/frontieres.test.ts`.
 *
 * Tables possédées : `AssistantIaFil` / `AssistantIaTour` (le fil gardé), `AssistantMemoryItem` (mémoire
 * personnelle), `AssistantRoutine` / `AssistantRoutineRun`, `AssistantRoleConfig`, `AssistantIaAcces` (console
 * d'accès), `AssistantIaReglage` / `AssistantIaPlafondAtteint` (consommation). Les intentions (cartes à
 * confirmer, `AssistantActionIntent`) sont au socle IA, partagées avec Adam.
 *
 * Ce que le module n'importe JAMAIS : Adam (`lib/assistant*`, son écran, son pont) — sauf le catalogue d'outils
 * nommé dans `src/platform/ia/frontieres.test.ts` (décision 0013). Ce que les deux partagent vit au socle IA.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

// ── Le fil : une conversation gardée, jouée en arrière-plan, reprise après un redémarrage
export {
  deposerMessage, ETAT, filDe, lireFil, nouvelleConversation, reglerReponseVocale, reprendreLesFils, traiterFil,
  type PieceDuTour,
} from "./infra/fil/service";
export { jouerTour } from "./infra/fil/tour";

// ── Vocaux et pièces citées
export { deposerAudio, nomDeVocal, synthetiser } from "./infra/lecture/voix";
export { piecesCitees } from "./infra/operations/pieces";

// ── Mémoire personnelle
export {
  ajouterMemoire, effacerMemoire, listerMemoire, modifierMemoire, toutEffacerMemoire, type ElementMemoire,
} from "./infra/memoire";

// ── Routines programmées (lecture seule, balayées par `runScheduledJobs`)
export {
  changerStatut, executerMaintenant, executerRoutinesDues, lirePassage, listerRoutines, passagesNonLus, supprimerRoutine,
} from "./infra/routines/service";

// ── La proactivité sous mandat (J12, décision 0024) : veilleurs, budget d'interruptions, mandats
export { executerVeilles, passerLaVeille } from "./infra/proactivite/veille";

// ── Opérations (écritures confirmées) et accès
export { executerOperationIA, executerOperationJournalisee } from "./infra/operations";
// J6 (décision 0020) : le registre des capacités de l'ERP, branché — l'exécution d'une carte de capacité confirmée.
export { capacitesOffertes, executerCapacite, porteOuverte, registreDesCapacites } from "./infra/capacites";
export { estChargeCapacite } from "./domaine/capacites";
export { accesAssistantIa, chargerConsoleAccesIa, verifierReperesAvantExecution } from "./infra/role-config";

// ── Consommation (budget par tour, plafonds, tableau de bord) et moteur
export { auNomDe, lireReglagesAssistantIa, tarifPose } from "./infra/consommation";
export { consommationAssistantIa, type Agregat } from "./infra/consommation-stats";
export { modeleOpenAi } from "./infra/modele";
export { outilsV1 } from "./infra/outils-v1";

// ── Les travaux longs (J2, décision 0016) : la persona que le moteur des travaux joue pour l'Assistant IA
export { PERSONA_ASSISTANT_IA } from "./infra/travaux";
// ── J8 (décision 0023) : délégation (demandes reçues), priorité, vue d'un responsable sur son équipe (console + audit)
export {
  declinerDemande, equipeVisible, lireTravailEquipe, listerDemandesRecues, listerTravauxEquipe, PIECES_TRAVAUX, reglerPrioriteTravail, repondreDemande,
  type DemandeRecue, type EtapeVue, type TravailDEquipe,
} from "./infra/travaux";

// ── L'Atelier (J3, décision 0017) : documents ouverts côte à côte, modifiés en place, convertis
export { etatAtelier } from "./infra/atelier/etat";

// J14 (décision 0022) : les traces rejouables d'un tour, et leur rejeu sans modèle.
export { decoderTrace, lireTrace, purgerTraces, type Trace } from "./infra/qualite/traces";
export { rejouerTrace, type BilanRejeu } from "./infra/qualite/rejeu";
// J5 (décision 0022) : le banc programmé ; J14 : le modèle de chaque rôle, changé seulement sur un banc vert.
export {
  demanderPassage, enregistrerReglageBanc, etatBaseEssai, lireReglageBanc, tacheBancProgramme,
} from "./infra/qualite/banc";
export { changerModeleRole, modelesEnService, revenirModeleEnvironnement, type ModeleEnService } from "./infra/qualite/modeles";
export { tableauQualite } from "./infra/qualite/tableau";
// ── Le terrain et la voix (J13, décision 0025) : vocaux et photos de délégué → cartes ; voix temps réel
export {
  capterPhoto, capterVocal, lireCaptations, peutCapterTerrain, TAILLE_MAX_CAPTATION, type IssueCaptation, type VueCaptation,
} from "./infra/terrain/captation";
export { deleguerALaVoix, journaliserVoix, ouvrirVoixAssistant, type ResultatDelegationVoix } from "./infra/voix/temps-reel";
