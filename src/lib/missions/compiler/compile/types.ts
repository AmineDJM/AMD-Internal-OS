/**
 * Compilateur de mission — LES FORMES : l'étape compilée, sa spécification d'exécution, la mission
 * compilée, le résultat de la compilation et les options du compilateur.
 */
import { CompileIssue, Complexity, NodeType, PlannedStep, Scale, type StepCondition } from "@/lib/missions/planner/contract";
import type { ApprovalStrategy, PlannedArtifact, PlannedWorkstream } from "@/lib/missions/planner/contract";
import { Effect, type Primitive } from "@/lib/missions/registry/capability-meta";

export interface CompiledStep {
  key: string;
  title: string;
  workstream: string | null;
  nodeType: NodeType;
  capability: string | null;
  input: Record<string, unknown>;
  dependsOn: string[];
  effect: Effect;
  /** La capacité est-elle rejouable PAR ELLE-MÊME ? Voir la nuance dans `capability-meta.ts`. */
  idempotent: boolean;
  /** Le moteur doit-il poser une clé d'idempotence autour de l'appel ? */
  needsIdempotencyKey: boolean;
  /** Cette étape entre-t-elle dans le périmètre soumis à approbation ? */
  needsApproval: boolean;
  maxAttempts: number;
  modelRole: "cheap" | "standard" | "strong" | null;
  forEach: { from: string; path: string; as: string } | null;
  waitFor: PlannedStep["waitFor"] | null;
  /**
   * LA SPÉCIFICATION D'EXÉCUTION — à côté de `input`, jamais dedans.
   *
   * `input` est le payload : ce que l'humain approuve, ce que la capacité reçoit. `spec` est ce
   * que le MOTEUR doit savoir pour exécuter l'étape correctement — quel schéma de sortie exiger
   * d'un worker, à quelle condition l'étape est finie, quel niveau de réflexion elle demande.
   * Mélanger les deux ferait diverger le payload stocké du payload approuvé.
   */
  spec: StepSpec | null;
  /** La vague d'exécution : les étapes de même vague partent ensemble. */
  wave: number;
}

/** Ce que le moteur lit pour exécuter une étape — produit par le planner, figé à la compilation. */
export interface StepSpec {
  /** Le JSON Schema qu'un WORKER doit respecter. Imposé au fournisseur, pas espéré. */
  expectedOutputSchema?: Record<string, unknown>;
  /** La condition VÉRIFIABLE d'achèvement, en français. Lue par le contrôle qualité et le juge. */
  completionCondition?: string;
  /** La réflexion demandée — choisit le rôle de modèle (§4). */
  reasoningRequirement?: "NONE" | "LIGHT" | "HEAVY";
  /** Le niveau d'accord PROPOSÉ par le planner. La politique tranche ensuite. */
  approvalRequirement?: "NONE" | "NORMAL" | "SENSITIVE" | "CRITICAL";
  /**
   * CE QUI REND UN RÉSULTAT ACCEPTABLE — lu par l'évaluateur sémantique (§6).
   *
   * Sans lui, une étape qui rend HTTP 200 est « réussie », même si elle a rapporté une
   * convention speaker là où on demandait un contrat. Avec lui, la vérification est
   * arithmétique ou typée, donc sans appel de modèle.
   */
  attendu?: { type?: string; nombre?: number; cible?: string };
  /** L'ÉTAPE CONDITIONNELLE : l'issue ou la sortie amont qui l'autorise à partir (`runtime/condition.ts`). */
  when?: StepCondition;
  /** Pour une étape ARTIFACT : quel livrable elle produit. */
  artifactKey?: string;
  artifactFormat?: string;
  artifactTitle?: string;
}

export interface CompiledMission {
  objective: string;
  acceptance: string[];
  complexity: Complexity;
  scale: Scale;
  steps: CompiledStep[];
  /** L'effet le plus grave du plan — ce qui décide du niveau d'approbation (§32). */
  maxEffect: Effect;
  requiresApproval: boolean;
  /** Les capacités réellement mobilisées. C'est le PÉRIMÈTRE que l'humain approuve (§33). */
  capabilities: string[];
  depth: number;
  gaps: string[];
  /**
   * LA CARTE DU PLAN — axes, livrables attendus, stratégie d'accord, critère de fin.
   *
   * Le compilateur ne la VALIDE pas : ce sont des intentions, pas des instructions exécutables.
   * Il la TRANSPORTE, parce que le contrôle qualité et le juge en ont besoin et qu'ils lisent
   * la mission, pas le plan d'origine.
   */
  planMeta: {
    workstreams: PlannedWorkstream[];
    expectedArtifacts: PlannedArtifact[];
    approvalStrategy: ApprovalStrategy;
    completionCriteria: string | null;
  };
}

export type CompileResult =
  | { ok: true; mission: CompiledMission; warnings: CompileIssue[] }
  | { ok: false; issues: CompileIssue[] };

/**
 * CE QUI EXISTE DÉJÀ DANS LA MISSION, D'UN PLAN PRÉCÉDENT.
 *
 * ── LE DÉFAUT QUE CE PARAMÈTRE CORRIGE ───────────────────────────────────────────────────
 *
 * À la replanification, le planificateur reçoit la liste de ce qui est DÉJÀ FAIT — c'est
 * volontaire : lui cacher l'acquis le ferait refaire trente-et-un envois déjà partis. Il écrit
 * donc, très logiquement, un plan dont certaines étapes dépendent de ces clés-là.
 *
 * Le compilateur ne connaissait que le plan qu'on lui donnait. Il refusait donc le nouveau plan
 * pour « dépend de « rechercher:dossiers-reglementaires », qui n'existe pas dans le plan » —
 * alors que cette étape existe bel et bien, en base, terminée, avec son résultat. Deux missions
 * réelles sur trois sont mortes BLOCKED sur ce refus.
 *
 * ── POURQUOI LE MOTEUR, LUI, N'AVAIT PAS DE PROBLÈME ─────────────────────────────────────
 *
 * `etapesPretes` résout les dépendances contre TOUTES les étapes de la mission, pas contre le
 * plan courant. Une dépendance vers une étape v1 terminée se satisfait immédiatement. Le
 * blocage était donc entièrement statique : le compilateur refusait ce que le moteur savait
 * exécuter.
 *
 * ── CE QUI RESTE REFUSÉ, ET C'EST VOULU ──────────────────────────────────────────────────
 *
 * Seules les clés ABOUTIES sont acceptées. Dépendre d'une étape en échec produirait une
 * attente que rien ne viendra lever : le refus est alors le bon comportement, et il garde son
 * message d'origine.
 */
export interface OptionsCompilation {
  /**
   * LE PLAFOND D'EFFET DE LA MISSION.
   *
   * Absent = aucun plafond, et c'est le cas courant : la politique et le catalogue tranchent.
   * Présent, il REFUSE À LA COMPILATION toute étape qui produirait davantage — y compris un
   * nœud sans capacité, comme un ARTIFACT qui fabrique un fichier. C'est cette dernière porte
   * qu'un run Render a trouvée ouverte alors que le rapport annonçait « lecture seule ».
   */
  effetMax?: Effect;
  /** Les clés d'étapes déjà présentes ET abouties dans la mission (plans antérieurs). */
  acquises?: ReadonlySet<string>;
  /**
   * LES PRIMITIVES QUE LA DEMANDE EXIGE (§56) — lues dans la phrase par `planner/primitives.ts`.
   *
   * Le compilateur refuse un plan qui n'en couvre aucune étape, À LA CONDITION que le catalogue
   * en offre une. La condition n'est pas un détail : exiger une primitive que personne ne sait
   * exécuter enfermerait la mission dans une boucle de replanifications identiques. Quand la
   * capacité n'existe pas, ce n'est plus une faute de plan, c'est un MANQUE — et le planificateur
   * le déclare dans `gaps`, ce qui est la bonne réponse.
   */
  primitivesRequises?: readonly Primitive[];
  /**
   * LES FORMATS DE LIVRABLE que la demande NOMME explicitement, quand elle en nomme plusieurs
   * (`formatsLivrablesDemandes`). Vide dans tous les autres cas — et un tableau vide n'exige
   * rien. Voir la règle de cardinalité des pièces plus bas.
   */
  formatsLivrables?: readonly string[];
}
