/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE ASSISTANT IA — LA PORTE SERVEUR (« Adventum Brain », Mastra + `gpt-6.1-terra`).
 *
 * Hors de `src/modules/assistant-ia/`, on importe CE fichier (ou `./partage` pour les règles pures, ou les
 * fichiers d'actions), jamais `domaine/` ni `infra/` : tenu par ESLint et `src/modules/frontieres.test.ts`.
 *
 * Tables possédées : `AssistantIaFil` / `AssistantIaTour` (le fil gardé), `AssistantMemoryItem` (mémoire
 * personnelle), `AssistantRoutine` / `AssistantRoutineRun`, `AssistantRoleConfig`, `AssistantIaAcces` (console
 * d'accès), `AssistantIaReglage` / `AssistantIaPlafondAtteint` (consommation), `AssistantIaNote{Page,Version,Corbeille,
 * Proposition}` (« Mes notes », décision 0026 — privées, aucune porte pour un autre compte). Les intentions (cartes à
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
export { filPourEcran } from "./infra/fil/ecran";
// ── L'essai de l'agent d'une personne par le Super Admin (son vrai tour, rien d'enregistré chez elle)
export { essayerAgentDe } from "./infra/essai/service";

// ── Les conversations et les dossiers (décision 0027, Adventum IA) : plusieurs conversations, privées, rangées
export {
  conversationDe, listerConversations, purgerConversationsPrivees, rechercherConversations, resumerConversation,
} from "./infra/conversations/service";
export { listerDossiers } from "./infra/conversations/dossiers";

// ── Vocaux et pièces citées
export { deposerAudio, nomDeVocal, synthetiser } from "./infra/lecture/voix";
export { piecesCitees } from "./infra/operations/pieces";

// ── Mémoire personnelle
export {
  ajouterMemoire, annulerSouvenir, effacerMemoire, jetonsDeLaMemoire, listerMemoire, purgerHistoriqueMemoire, memoireAutoActive, modifierMemoire, reglerMemoireAuto, souvenirsParIds,
  toutEffacerMemoire, type ElementMemoire, type MemoireRetenue,
} from "./infra/memoire";
export { capturerApresTour, memoirePourVoix, rappelDuTour } from "./infra/memoire-capture";
export { consoliderMemoire, tacheMemoire } from "./infra/memoire-consolidation";
export { jetonsMemoire } from "./domaine/memoire/rappel";

// ── Routines programmées (lecture seule, balayées par `runScheduledJobs`)
export {
  changerStatut, executerMaintenant, executerRoutinesDues, lirePassage, listerRoutines, passagesNonLus, supprimerRoutine,
} from "./infra/routines/service";

// ── La proactivité sous mandat (J12, décision 0024) : veilleurs, budget d'interruptions, mandats
export { executerVeilles, passerLaVeille } from "./infra/proactivite/veille";

// ── Opérations (écritures confirmées) et accès
export { executerOperationIA, executerOperationJournalisee } from "./infra/operations";
export { confirmerCarte } from "./infra/confirmation";
// J6 (décision 0020) : le registre des capacités de l'ERP, branché — l'exécution d'une carte de capacité confirmée.
export { capacitesOffertes, chercherReferenceDeCarte, corrigerCarteCapacite, executerCapacite, porteOuverte, registreDesCapacites } from "./infra/capacites";
export { estChargeCapacite } from "./domaine/capacites";
export { cloreLotDossier, etatDesLots, lotDesigne, ouvrirLotDossier, piecesDuLot } from "./infra/depot-dossier";
export { lectureDossierDepose } from "./infra/lecture-dossier";
export { accesAssistantIa, chargerConsoleAccesIa, ficheEtAvenantsDe, verifierReperesAvantExecution } from "./infra/role-config";
// S1 (décision 0048) : le profil de la personne (à qui l'assistant parle) et sa préférence d'adresse.
export { adresseDeLaPersonne, oublierProfil, profilDeLaPersonne, reglerAdresse } from "./infra/profil-personne";

// ── Consommation (budget par tour, plafonds, tableau de bord) et moteur
export { auNomDe, lireReglagesAssistantIa, tarifPose } from "./infra/consommation";
export { consommationAssistantIa, type Agregat } from "./infra/consommation-stats";
export { lireConsommation, lireAppels, cibleDe, LIMITE_EXPORT } from "./infra/consommation-detail";
export { modeleOpenAi } from "./infra/modele";
export { outilsV1, type PropositionPreparee } from "./infra/outils-v1";

// ── Les travaux longs (J2, décision 0016) : la persona que le moteur des travaux joue pour l'Assistant IA
export { PERSONA_ASSISTANT_IA } from "./infra/travaux";
// P1 (décision 0047) : qui conduit les missions (Administration › IA), piloter ses missions (la voix et l'écrit).
export { executantsPourAdministration } from "./infra/missions/executants";
export { mesMissions, piloterMission, type MissionLue } from "./infra/missions/pilotage";
// ── J8 (décision 0023) : délégation (demandes reçues), priorité, vue d'un responsable sur son équipe (console + audit)
export {
  declinerDemande, equipeVisible, lireTravailEquipe, listerDemandesRecues, listerTravauxEquipe, PIECES_TRAVAUX, reglerPrioriteTravail, repondreDemande,
  type DemandeRecue, type EtapeVue, type TravailDEquipe,
} from "./infra/travaux";
// ── K3 (décision 0033) : sous-missions en arrière-plan, synthèse dans la conversation, tableau de bord en temps réel
export {
  annulerMissionEtSousMissions, balayerSousMissions, conclureSousMissions, lirePreferenceDOffice, reglerPreferenceDOffice, signatureTableau, tableauDesMissions, travauxDOfficePour,
  type MissionDuTableau, type TableauDesMissions,
} from "./infra/sous-missions";
// ── C1 (décision 0042) : les chantiers de développement du Super Admin — la carte de validation du tableau « Missions »
export { etatChantiersPourAdministration, normaliserReglagesChantiers, validerDepuisLeTableau } from "./infra/chantiers";

// ── L'Atelier (J3, décision 0017) : documents ouverts côte à côte, modifiés en place, convertis
export { etatAtelier } from "./infra/atelier/etat";
export { depenseOcrVisionDuMois, fabriqueVisionOcr, lireReglageOcrVision } from "./infra/atelier/ocr-vision";

// ── « Mes notes » (décision 0026) : le bloc-notes privé de chacun ; l'IA propose, la personne accepte
export { outilsNotes, OUTILS_NOTES } from "./infra/notes/outils";
export { propositionsParIds, type PropositionNote } from "./infra/notes/propositions";
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
// ── K6 (décision 0036) : les pièces reçues par WhatsApp et par mail, rattachées à l'attente de la conversation
export {
  attenteOuvertePour, ouvrirAttente, personneParAdresse, recevoirMessage, recevoirPieces, DOSSIER_PIECES_RECUES,
  type EntreeReception, type FichierRecu, type ResultatReception,
} from "./infra/canaux/reception";
export { sectionAttentesDuTour } from "./infra/canaux/section";
export { outilAttendrePieces, OUTIL_ATTENDRE_PIECES } from "./infra/canaux/outil";
export { deleguerALaVoix, journaliserVoix, ouvrirVoixAssistant, type ResultatDelegationVoix } from "./infra/voix/temps-reel";
// K9 (décision 0039) : la voix entièrement orale — travail délégué suivi en asynchrone, annoncé de lui-même.
export { annoncesEnAppel, suivreTravailVocal, type SuiviOral } from "./infra/voix/oral";
// O1 (décision 0046) : l'orchestrateur de conversation à l'écrit — dépôt orchestré, état lu par l'écran du fil.
export { deposerEcrit, orchestrationDuFil, type OrchestrationFil } from "./infra/orchestration/ecrit";
// ── Les visuels (lot K2, décision 0032) : images, vidéos, vidéos de données — la tâche de fond, la carte, le média
export { etatVisuel, etatVisuelsPourAdministration, fichierDuVisuel, traiterVisuelsEnFile } from "./infra/visuels/service";
// ── L'analyse de données (K1, décision 0031) : le classeur Excel d'une analyse — export d'un clic, dépôt au Drive sur geste
export { classeurDAnalyse, type ClasseurDemande } from "./infra/analyse/classeur";
