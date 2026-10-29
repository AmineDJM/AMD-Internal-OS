/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPILATEUR DE MISSION — le plan d'un modèle n'est JAMAIS exécuté tel quel (§6).
 *
 * ── CE QUE FAIT CE FICHIER, EN UNE PHRASE ────────────────────────────────────────────────
 *
 * Il transforme une PROPOSITION (du texte structuré, produit par un modèle, donc faillible) en
 * un PROGRAMME (un graphe validé, dont chaque nœud existe, est autorisé, a un effet connu et
 * une stratégie de reprise). Entre les deux, il refuse.
 *
 * ── CE QU'IL REFUSE, ET POURQUOI CHACUN COMPTE ───────────────────────────────────────────
 *
 *   • une capacité qui n'existe pas — le modèle a inventé `super_magic_send()` ;
 *   • une capacité que l'acteur n'a pas le droit d'appeler — une mission n'est pas une porte
 *     dérobée (§48), et c'est ICI que ça se joue, pas au moment de l'appel ;
 *   • un graphe cyclique — il ne s'exécuterait jamais, et l'apprendre en production coûte ;
 *   • une forme incohérente — une attente sans condition de sortie, un appel sans capacité ;
 *   • une CARDINALITÉ fausse — trente-trois destinataires dans un champ au lieu de trente-trois
 *     étapes. C'est le refus le plus important du fichier, parce que c'est le seul dont la
 *     conséquence est irréversible et publique (§26).
 *
 * ── CE QU'IL NE FAIT PAS ─────────────────────────────────────────────────────────────────
 *
 * Il ne DÉPLOIE PAS l'éventail. Une étape « pour chaque salarié » ne connaît pas ses salariés
 * avant que l'étape amont ait tourné : les démultiplier ici obligerait à interroger la base
 * pendant la compilation, donc à recompiler à chaque exécution. Le compilateur valide la FORME
 * de l'éventail ; le moteur le matérialise avec les vraies données. C'est ce qui rend une
 * mission à trois étapes et une mission à trois mille strictement identiques (§4).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `compile/` : `types.ts` (le programme compilé et les
 * options), `outils.ts` (assainissement des clés, destinataires, forme des nœuds), `preparation.ts`
 * (passes 0 à 2 : assainir, réparer les règles, limites, clés, sorties attendues), `etape.ts` (passe 3 :
 * chaque étape, et le contexte explicite des passes), `couverture.ts` (porte vide, question de confort,
 * primitives et pièces exigées), `graphe.ts` (passe 4 : graphe, livrable unique), `controles.ts` (plan
 * vide, sans source, attentes humaines indiscernables). Ce fichier garde `compile`, qui enchaîne les
 * passes dans l'ordre d'origine et rend le programme.
 */
import type { CompileIssue, MissionPlan } from "@/lib/missions/planner/contract";
import { effetMaximal } from "@/lib/missions/registry/capability-meta";
import type { CapabilityCatalog, MissionActor } from "@/lib/missions/ports";
import type { CompiledStep, CompileResult, OptionsCompilation } from "@/lib/missions/compiler/compile/types";
import { preparerLePlan, verifierLimitesEtCles, sortiesDuPlan } from "@/lib/missions/compiler/compile/preparation";
import { type ContexteCompilation, compilerEtape } from "@/lib/missions/compiler/compile/etape";
import { porteDAccordVide, questionDeConfort, produireEstInterdit, couverturePrimitives, nombreDePieces } from "@/lib/missions/compiler/compile/couverture";
import { poserLeGraphe } from "@/lib/missions/compiler/compile/graphe";
import { planSansProduction, planSansSource, attentesIndiscernables } from "@/lib/missions/compiler/compile/controles";

export type { CompiledStep, StepSpec, CompiledMission, CompileResult, OptionsCompilation } from "@/lib/missions/compiler/compile/types";

export function compile(
  planBrut: MissionPlan,
  catalog: CapabilityCatalog,
  actor: MissionActor,
  opts: OptionsCompilation = {},
): CompileResult {
  const acquises = opts.acquises ?? new Set<string>();
  const issues: CompileIssue[] = [];
  const warnings: CompileIssue[] = [];

  // ── 0. L'ASSAINISSEMENT, PUIS LA RÉPARATION DES RÈGLES — et §28 (`compile/preparation.ts`) ──────
  const plan = preparerLePlan(planBrut, acquises, opts, warnings);
  // ── 1. LES LIMITES OPÉRATIONNELLES — 2. LES CLÉS ─────────────────────────────────────────
  const vues = verifierLimitesEtCles(plan, issues);
  // Ce que chaque étape va rendre, calculé UNE fois pour tout le plan.
  const sortieDe = sortiesDuPlan(plan, catalog);

  // ── 3. CHAQUE ÉTAPE, UNE PAR UNE (`compile/etape.ts`) ──────────────────────────────────────
  const compiled: CompiledStep[] = [];
  const ctx: ContexteCompilation = { planBrut, plan, catalog, actor, opts, acquises, issues, warnings, vues, sortieDe, compiled };
  for (const s of plan.steps) compilerEtape(s, ctx);

  // La porte d'accord vide, la question de confort (`compile/couverture.ts`).
  porteDAccordVide(ctx);
  questionDeConfort(ctx);
  // ── 3 bis. LE PLAN COUVRE-T-IL CE QUE LA DEMANDE EXIGE ? — 3 ter. AUTANT DE PIÈCES QUE DE FORMATS ──
  const produireInterdit = produireEstInterdit(opts);
  couverturePrimitives(ctx, produireInterdit);
  nombreDePieces(ctx, produireInterdit);

  // ── 4. LE GRAPHE (`compile/graphe.ts`), puis les contrôles du plan entier (`compile/controles.ts`) ──
  const g = poserLeGraphe(ctx);
  planSansProduction(ctx);
  planSansSource(ctx);
  attentesIndiscernables(ctx);

  if (issues.length > 0) return { ok: false, issues };

  const maxEffect = effetMaximal(compiled.map((c) => c.effect));
  return {
    ok: true,
    warnings,
    mission: {
      objective: plan.objective,
      acceptance: plan.acceptance,
      complexity: plan.complexity,
      scale: plan.scale,
      steps: compiled,
      maxEffect,
      requiresApproval: compiled.some((c) => c.needsApproval),
      capabilities: [...new Set(compiled.map((c) => c.capability).filter((x): x is string => Boolean(x)))].sort(),
      depth: g.depth,
      gaps: plan.gaps ?? [],
      planMeta: {
        workstreams: plan.workstreams ?? [],
        expectedArtifacts: plan.expectedArtifacts ?? [],
        approvalStrategy: plan.approvalStrategy ?? "BUNDLE",
        completionCriteria: plan.completionCriteria ?? null,
      },
    },
  };
}
