/**
 * Centre de contrôle IA — réglages globaux + journal d'usage (serveur uniquement).
 *
 * Le Super Admin peut couper l'IA globalement ou par fonction sans toucher au code
 * ni aux variables d'environnement. Les points d'entrée qui déclarent une FONCTION appellent
 * `aiFeatureEnabled(feature)` avant d'appeler le modèle, et `logAiUsage(...)` après.
 *
 * Cette phrase disait « chaque point d'entrée » : c'était faux, et c'est ce qui laissait passer
 * l'analyse des AO PCH et des contrats RH sous un interrupteur coupé (audit 360°, rapport 19).
 * L'interrupteur GÉNÉRAL est désormais tenu aussi par le transport — voir `interrupteurIaCoupe`
 * plus bas, et ce qu'il ne couvre pas encore, dit au même endroit.
 */
import { prisma } from "./prisma";

export type AiFeature =
  | "assistant"
  | "nudge"
  | "brain"
  | "briefing"
  | "process_intel"
  | "field_report"
  | "voice"
  /** Session vocale speech-to-speech temps réel (API Realtime) — journalisée par session. */
  | "voice_realtime"
  /** « Rédiger avec l'IA » — un article de blog ou une offre d'emploi du site public (§118.160). */
  | "site_web"
  /**
   * La lecture des LIGNES d'une pièce commerciale déposée (devis, BC, facture) par un modèle — lot D2,
   * `lecture-pieces-ia.ts`. COUPÉE par défaut : elle a un coût, et la lecture locale suffit à proposer.
   */
  | "lecture_pieces"
  /**
   * LUNA CONSEILLE OÙ RANGER UNE PIÈCE déposée sur une demande Ad & Pro (`conseil-pieces-ia.ts`) :
   * consultatif, sans aucune écriture — ALLUMÉ par défaut.
   */
  | "conseil_pieces"
  /**
   * LUNA ET LES KPI (KPI sans code, Direction 08/10) : traduire une phrase en définitions, pré-noter un KPI évalué avec
   * ses preuves, rédiger le commentaire d'une revue. Jamais le chiffre. Suit la bascule de l'assistant.
   */
  | "kpi"
  /**
   * LA VOIX DU TERRAIN (Marketing cockpit, Cockpit Opérations — 10/2026) : Luna range les rapports de visite en
   * objections, signaux d'approvisionnement, opportunités, concurrence, pharmacovigilance, avec une citation MOT POUR
   * MOT. Suit la bascule des rapports terrain (analyse IA des rapports).
   */
  | "voix_terrain"
  /**
   * L'ESSENTIEL D'UN PRODUIT (Produits 360, Direction 10/2026) : Luna choisit et formule trois points à partir des faits
   * CALCULÉS de la fiche, chacun cité. Jamais un chiffre à elle. Suit la bascule de l'assistant.
   */
  | "produit_360"
  /**
   * LA CAMPAGNE BUDGÉTAIRE (Budgets 2027, 10/2026) : Luna rédige un brouillon de justification d'écart et résume ce qui a
   * changé entre deux versions d'une proposition. Jamais un montant. Suit la bascule de l'assistant.
   */
  | "budget_campagne"
  /**
   * LE GRAPHE D'INFLUENCE (Intelligence terrain, console d'administration, Super Admin seul — 10/2026) : Luna lit les
   * rapports de visite NOUVEAUX et repère les liens d'influence entre médecins, chacun prouvé par une citation mot pour mot,
   * PROPOSÉ jamais appliqué. Suit la bascule des rapports terrain.
   */
  | "influence"
  /**
   * L'ATTESTATION DE TRAVAIL (Demandes RH, Direction 10/2026) : Luna lit le contrat de travail du salarié pour préremplir
   * ce que la fiche RH n'a pas (naissance, poste, date d'embauche) — proposé, jamais écrit ; sans elle, la lecture
   * déterministe du contrat prend le relais (`attestation-travail-luna.ts`). Suit la bascule de l'assistant.
   */
  | "attestation_travail"
  /**
   * LES POSTES D'UNE DEMANDE AD & PRO LUS DANS SA DESCRIPTION (Direction 10/2026) : Luna propose l'événement et ses postes
   * (salle, repas, hôtellerie, billetterie et leurs fiches) — proposé, jamais écrit ; la personne reprend en un geste
   * (`postes-luna-ia.ts`). Suit la bascule de l'assistant.
   */
  | "postes_luna"
  /**
   * LA NATURE D'UNE DÉPENSE DES MOYENS GÉNÉRAUX (Direction, 10/2026) : l'IA range chaque article d'un ticket dans une
   * catégorie budgétaire des moyens généraux, ou en nomme une nouvelle ; les mots-clés prennent le relais sans elle
   * (`natures-depenses-ia.ts`). Suit la bascule de l'assistant.
   */
  | "nature_depense";

export interface AiSettingsView {
  masterEnabled: boolean;
  assistantEnabled: boolean;
  proactiveNudgesEnabled: boolean;
  brainEnabled: boolean;
  processIntelEnabled: boolean;
  fieldReportAiEnabled: boolean;
  voiceTranscriptEnabled: boolean;
  siteWebAiEnabled: boolean;
  lecturePiecesEnabled: boolean;
  conseilPiecesEnabled: boolean;
}

const DEFAULTS: AiSettingsView = {
  masterEnabled: true,
  assistantEnabled: true,
  proactiveNudgesEnabled: true,
  brainEnabled: true,
  processIntelEnabled: true,
  fieldReportAiEnabled: true,
  voiceTranscriptEnabled: true,
  siteWebAiEnabled: true,
  // COUPÉE PAR DÉFAUT — le même défaut que sa colonne (`@default(false)`, migration
  // `20270104090000_lecture_pieces`) : sans ligne, ou base injoignable, aucune pièce ne part chez un
  // fournisseur. L'activer est une décision de la Direction, prise sur l'écran, pas un défaut du code.
  lecturePiecesEnabled: false,
  // Le conseil de rangement n'écrit rien et ne fait que conseiller : allumé, comme sa colonne
  // (`@default(true)`, migration `20270106100000_conseil_pieces`).
  conseilPiecesEnabled: true,
};

/** Quelle bascule gouverne quelle fonction. */
const FEATURE_KEY: Record<AiFeature, keyof AiSettingsView> = {
  assistant: "assistantEnabled",
  nudge: "proactiveNudgesEnabled",
  brain: "brainEnabled",
  briefing: "brainEnabled",
  process_intel: "processIntelEnabled",
  field_report: "fieldReportAiEnabled",
  voice: "voiceTranscriptEnabled",
  // La session temps réel suit la MÊME bascule que l'assistant : couper l'assistant coupe la voix.
  voice_realtime: "assistantEnabled",
  site_web: "siteWebAiEnabled",
  lecture_pieces: "lecturePiecesEnabled",
  conseil_pieces: "conseilPiecesEnabled",
  kpi: "assistantEnabled",
  voix_terrain: "fieldReportAiEnabled",
  produit_360: "assistantEnabled",
  budget_campagne: "assistantEnabled",
  influence: "fieldReportAiEnabled",
  attestation_travail: "assistantEnabled",
  postes_luna: "assistantEnabled",
  nature_depense: "assistantEnabled",
};

/**
 * Lit les réglages. Renvoie les valeurs par défaut si la ligne n'existe pas
 * encore (ou en cas de souci BDD : les réglages sont un confort, pas une garde
 * de sécurité — l'autorisation reste gérée par le RBAC). Toujours frais : une
 * bascule du Super Admin prend effet immédiatement (lecture d'une seule ligne).
 */
export async function getAiSettings(): Promise<AiSettingsView> {
  try {
    const row = await prisma.aiSetting.findUnique({ where: { id: "global" } });
    if (!row) return DEFAULTS;
    return {
      masterEnabled: row.masterEnabled,
      assistantEnabled: row.assistantEnabled,
      proactiveNudgesEnabled: row.proactiveNudgesEnabled,
      brainEnabled: row.brainEnabled,
      processIntelEnabled: row.processIntelEnabled,
      fieldReportAiEnabled: row.fieldReportAiEnabled,
      voiceTranscriptEnabled: row.voiceTranscriptEnabled,
      siteWebAiEnabled: row.siteWebAiEnabled,
      lecturePiecesEnabled: row.lecturePiecesEnabled,
      conseilPiecesEnabled: row.conseilPiecesEnabled,
    };
  } catch {
    return DEFAULTS;
  }
}

/** L'IA est-elle activée pour cette fonction ? (interrupteur général ET bascule de la fonction) */
export async function aiFeatureEnabled(feature: AiFeature): Promise<boolean> {
  const s = await getAiSettings();
  return s.masterEnabled && s[FEATURE_KEY[feature]];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTERRUPTEUR GÉNÉRAL, TENU PAR LE TRANSPORT — et plus seulement par ceux qui pensent à le lire.
 *
 * ── LE TROU, MESURÉ (audit 360°, rapport 19, F3) ────────────────────────────────────────
 *
 * Interrupteur coupé, l'écran « Contrôle de l'IA » affiche « Toute l'IA est coupée, quelles que
 * soient les bascules ci-dessous ». `masterEnabled` n'était pourtant lu QUE dans
 * `aiFeatureEnabled`, appelé par treize points d'entrée. `lib/ai.ts` — par lequel passent l'analyse
 * d'un contrat RH, l'extraction des lignes d'un appel d'offres PCH, le compte rendu de réunion, le
 * brief du matin, la mémoire d'Adam et dix modules de l'intelligence réglementaire — ne lisait
 * rien ; et le moteur OCR envoyait les scans à Mistral, un service cloud, quoi qu'il arrive. Un
 * Super Admin coupait l'IA, lançait l'analyse d'un AO, et l'appel partait quand même. Un
 * interrupteur que l'écran promet et que le code ignore est pire que pas d'interrupteur : il
 * rassure, et c'est sur cette assurance qu'on décide (§118.17).
 *
 * ── LE REMÈDE : LA RÈGLE VIT LÀ OÙ LES APPELS PASSENT (§118.58) ─────────────────────────
 *
 * Réparer vingt-sept appelants un par un ne protégerait pas le vingt-huitième. `lib/ai.ts`
 * (questions, appels avec outils, transcription) et `ocrDocument` (Mistral, secours vision) lisent
 * `interrupteurIaCoupe()` AVANT tout effet : coupé, aucun appel ne part, rien n'est journalisé, et
 * l'appelant reçoit la forme d'échec qu'il sait déjà traiter, avec `REFUS_IA_COUPEE`.
 *
 * ── CE QUE ÇA CHANGE EN PRODUCTION, DIT D'AVANCE ────────────────────────────────────────
 *
 * Si la ligne `AiSetting` de la production porte déjà `masterEnabled = false`, ce déploiement
 * ARRÊTE l'analyse des AO PCH, des contrats RH et l'IA réglementaire, qui passaient jusqu'ici par
 * le trou. Ce n'est pas une régression : c'est l'interrupteur qui fait enfin ce que l'écran dit, et
 * le remède est sur ce même écran — rallumer l'interrupteur.
 *
 * ── CE QUE L'INTERRUPTEUR NE COUPE PAS ENCORE — dit, plutôt que promis (§118.116) ─────────
 *
 * Les modules qui appellent la passerelle (`models/gateway`) sans passer par `lib/ai.ts` — la
 * boucle d'Adam, la recherche web, le raisonneur des missions — ne sont tenus que par leur propre
 * bascule quand ils en lisent une (Adam est réservé au Super Admin et a ses interrupteurs). La
 * lecture des lignes d'une pièce commerciale (`lecture-pieces-ia.ts`) passe elle aussi par la
 * passerelle, et lit `interrupteurIaCoupe()` explicitement, AVANT sa bascule et sa clé. Le client
 * Luna de l'intelligence réglementaire (`callLuna`, `submitBatch`, `lunaEmbed`) et la transcription
 * des médias du Drive (`media/stt.ts`) lisent l'interrupteur depuis le lot D1 (§118.196) ; lire l'état
 * d'un lot déjà déposé reste ouvert, exprès. La sonde de santé (`aiSelfTest`) aussi : son commentaire
 * dit pourquoi. L'Assistant IA (Mastra sur MiMo, `lib/agent/`) le lit dans ses deux seules portes vers le
 * modèle, `repondreAvecSecours` et `genererTexte` (audit 27/10, cliquet `agent/interrupteur.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** LA PHRASE D'UN REFUS SOUS INTERRUPTEUR — une seule, pour le transport ET pour l'OCR. */
export const REFUS_IA_COUPEE =
  "L'IA est coupée par l'interrupteur général (Administration › Contrôle de l'IA) : aucun appel n'est parti.";

/**
 * LE VRAI LECTEUR. VRAI seulement quand la ligne enregistrée dit `masterEnabled === false`.
 *
 * Sans ligne, ou base injoignable, `getAiSettings` rend les défauts — IA active : la sémantique
 * d'`aiFeatureEnabled` depuis toujours, et elle ne change pas ici. Les réglages restent un confort
 * d'exploitation, pas une garde de sécurité : l'autorisation, elle, est au RBAC.
 */
export async function iaCoupeeGlobalement(): Promise<boolean> {
  const s = await getAiSettings();
  return s.masterEnabled === false;
}

/**
 * LE LECTEUR S'INJECTE — et ce n'est pas une ligne de la base qu'un banc devrait poser.
 *
 * L'interrupteur est GLOBAL et la suite tourne en parallèle sur une seule base : un test qui
 * couperait la vraie ligne pour s'éprouver couperait, pendant sa fenêtre, l'IA de tous les bancs
 * voisins (§118.132, §118.115). Le transport et l'OCR lisent donc `interrupteurIaCoupe()`, dont le
 * défaut est le vrai lecteur ; un banc pose le sien par `remplacerLecteurInterrupteurIaPourTests`,
 * et un cliquet (`ai-interrupteur.test.ts`) refuse tout appel de PRODUCTION à ce remplaçant —
 * sinon l'interrupteur serait désarmé en ayant l'air armé.
 */
export type LecteurInterrupteurIa = () => Promise<boolean>;

let lecteurInterrupteurIa: LecteurInterrupteurIa = iaCoupeeGlobalement;

/** Ce que lisent `lib/ai.ts` et `ocrDocument` avant tout appel à un fournisseur. */
export function interrupteurIaCoupe(): Promise<boolean> {
  return lecteurInterrupteurIa();
}

/** RÉSERVÉ AUX TESTS — jamais appelé en production (cliquet). `null` remet le vrai lecteur. */
export function remplacerLecteurInterrupteurIaPourTests(lecteur: LecteurInterrupteurIa | null): void {
  lecteurInterrupteurIa = lecteur ?? iaCoupeeGlobalement;
}

/**
 * LES FONCTIONS JOURNALISÉES SANS BASCULE À ELLES — l'Assistant IA (MiMo, `lib/agent/`) n'a pas de
 * bascule dans `AiSetting` : il est tenu par l'interrupteur GÉNÉRAL et par ses propres plafonds
 * (`AssistantIaReglage`, écran Consommation IA). Le lui donner dans `AiFeature` aurait promis une
 * bascule que rien ne lit (§118.17).
 */
export type AiFeatureJournalisee = AiFeature | "assistant_ia";

export interface AiUsageInput {
  feature: AiFeatureJournalisee;
  /** Le fournisseur RÉELLEMENT appelé (`anthropic`, `openai`, `mimo`…) — jamais un nom gravé. */
  provider?: string;
  model?: string | null;
  userId?: string | null;
  ok: boolean;
  latencyMs?: number | null;
  errorCode?: string | null;
  /** Boucle agent uniquement : ressenti (1er mot), tours, outils appelés / en erreur, temps outils. */
  ttftMs?: number | null;
  turns?: number | null;
  toolCalls?: number | null;
  toolErrors?: number | null;
  toolLatencyMs?: number | null;
  /** Le COÛT du tour (voir la migration `adam_cout_par_appel`) : agrégats des appels de modèle. */
  turnId?: string | null;
  route?: string | null;
  complexity?: string | null;
  threadId?: string | null;
  llmCalls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  webSearchCalls?: number | null;
  /** `null` = au moins un appel sans tarif connu — le total est INCONNU, pas nul. */
  costUsd?: number | null;
}

/** Journalise un appel IA (best-effort, ne lève jamais). */
export async function logAiUsage(input: AiUsageInput): Promise<void> {
  try {
    await prisma.aiUsageLog.create({
      data: {
        feature: input.feature,
        provider: input.provider ?? "anthropic",
        model: input.model ?? null,
        userId: input.userId ?? null,
        ok: input.ok,
        latencyMs: input.latencyMs ?? null,
        errorCode: input.errorCode ?? null,
        ttftMs: input.ttftMs ?? null,
        turns: input.turns ?? null,
        toolCalls: input.toolCalls ?? null,
        toolErrors: input.toolErrors ?? null,
        toolLatencyMs: input.toolLatencyMs ?? null,
        turnId: input.turnId ?? null,
        route: input.route ?? null,
        complexity: input.complexity ?? null,
        threadId: input.threadId ?? null,
        llmCalls: input.llmCalls ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        reasoningTokens: input.reasoningTokens ?? null,
        webSearchCalls: input.webSearchCalls ?? null,
        costUsd: input.costUsd ?? null,
      },
    });
  } catch {
    /* best-effort */
  }
}
