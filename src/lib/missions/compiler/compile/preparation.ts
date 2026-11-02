/**
 * Compilateur de mission — PASSES 0 À 2 : assainir le plan et réparer ses règles d'acceptation,
 * convertir les attentes humaines d'une mission en lecture seule (§28), refuser les limites
 * dépassées et les clés invalides, et préparer la lecture mémoïsée des sorties attendues.
 */
import { type CompileIssue, type MissionPlan, type NodeType, PLAN_LIMITS } from "@/lib/missions/planner/contract";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import type { CapabilityCatalog } from "@/lib/missions/ports";
import { reparerReglesDacceptation } from "@/lib/missions/goal/rules";
import { sortieAttendue, type SortieEtape } from "@/lib/missions/compiler/sorties";
import type { OptionsCompilation } from "@/lib/missions/compiler/compile/types";
import { assainirPlan, contexteReglesDuPlan, issue } from "@/lib/missions/compiler/compile/outils";

/**
 * PASSE 0 — rend le plan ASSAINI (identifiants, critères réparés) et, sous plafond de lecture,
 * débarrassé des attentes humaines qui suspendraient la réponse à son propre demandeur (§28).
 */
export function preparerLePlan(planBrut: MissionPlan, acquises: ReadonlySet<string>, opts: OptionsCompilation, warnings: CompileIssue[]): MissionPlan {
  // ── 0. L'ASSAINISSEMENT, PUIS LA RÉPARATION DES RÈGLES ───────────────────────────────
  //
  // LE TAUX DE CRÉATION DE MISSION EST UN INVARIANT (100 %). Une faute de FORME écrite par le
  // modèle dans un identifiant ou dans un critère ne condamne jamais un plan dont les étapes
  // compilent : elle se répare en CODE, la réparation est DITE en warning, et l'audit la voit.
  // Refuser renverrait la faute au même modèle qui vient de la commettre — mesuré : il récidive.
  const assainissement = assainirPlan(planBrut);
  for (const note of assainissement.notes) warnings.push(issue("INVALID_SHAPE", null, note));
  const reparation = reparerReglesDacceptation(
    assainissement.plan.acceptance,
    contexteReglesDuPlan(assainissement.plan, acquises),
  );
  for (const note of reparation.notes) warnings.push(issue("INVALID_SHAPE", null, note));
  let plan: MissionPlan = { ...assainissement.plan, acceptance: reparation.criteres };

  /**
   * ── §28 — UNE QUESTION NE SUSPEND PAS SA RÉPONSE À SON PROPRE DEMANDEUR ──────────────
   *
   * Trois missions d'ANALYSE d'un run réel ont fini WAITING_INPUT : le planificateur, ne
   * trouvant pas la donnée, avait écrit une étape « attendre que la personne fournisse X » —
   * et la mission suspendait sa réponse… à celui qui posait la question. Pour une mission en
   * LECTURE SEULE (plafond ≤ ANALYZE), la réponse honnête à une donnée absente n'est pas une
   * attente : c'est « voici ce qui existe, voici ce qui manque » — une absence DITE est une
   * réponse recevable. L'attente humaine se CONVERTIT donc en travail de synthèse qui nomme
   * le manque ; la conversion est dite en warning, et le juge garde le dernier mot sur la
   * qualité de la réponse. Une mission qui ÉCRIT garde ses attentes : un envoi peut
   * légitimement attendre une pièce humaine — c'est le plafond d'effet qui les distingue.
   */
  if (opts.effetMax && EFFECT_RANK[opts.effetMax] <= EFFECT_RANK.ANALYZE) {
    const attentes = plan.steps.filter(
      (s) => (s.nodeType ?? (s.capability ? "CAPABILITY" : "WORKER")) === "WAIT_INPUT");
    if (attentes.length > 0) {
      plan = {
        ...plan,
        steps: plan.steps.map((s) => {
          if ((s.nodeType ?? (s.capability ? "CAPABILITY" : "WORKER")) !== "WAIT_INPUT") return s;
          const demande = s.waitFor?.ask?.trim() || s.title;
          return {
            ...s,
            nodeType: "WORKER" as NodeType,
            waitFor: undefined,
            reasoningRequirement: s.reasoningRequirement ?? "LIGHT",
            completionCondition: `Ce qui est déjà établi pour « ${demande} » est dit avec sa provenance, `
              + "et ce qui manque est nommé précisément — sans rien inventer.",
          };
        }),
      };
      for (const a of attentes) {
        warnings.push(issue("INVALID_SHAPE", a.key,
          `l'attente humaine « ${a.waitFor?.ask ?? a.title} » est convertie en synthèse : une mission `
          + `d'analyse en lecture seule répond avec ce qui existe et DIT ce qui manque, elle ne `
          + `suspend pas sa réponse à une fourniture humaine (§28).`));
      }
    }
  }
  return plan;
}

/** PASSES 1 ET 2 — les limites opérationnelles et les clés ; rend les clés vues, dans l'ordre du plan. */
export function verifierLimitesEtCles(plan: MissionPlan, issues: CompileIssue[]): Set<string> {
  // ── 1. LES LIMITES OPÉRATIONNELLES ────────────────────────────────────────────────────
  if (plan.steps.length > PLAN_LIMITS.plannedSteps) {
    issues.push(issue("LIMIT_EXCEEDED", null,
      `${plan.steps.length} étapes écrites à la main dépassent la limite de ${PLAN_LIMITS.plannedSteps}. `
      + `Un plan de cette taille se découpe en sous-missions — le moteur est le même.`));
  }
  if (plan.steps.length === 0) {
    issues.push(issue("INVALID_SHAPE", null, "un plan sans étape ne peut pas atteindre son objectif."));
  }
  if (plan.acceptance.length === 0) {
    issues.push(issue("INVALID_SHAPE", null,
      "un plan sans critère d'acceptation produit une mission qui se déclare finie parce qu'elle a "
      + "fini de tourner. Ce n'est pas la question posée (§20)."));
  }
  // ── 2. LES CLÉS ───────────────────────────────────────────────────────────────────────
  const vues = new Set<string>();
  for (const s of plan.steps) {
    if (!s.key || !/^[A-Za-z0-9:_\-.]+$/.test(s.key)) {
      issues.push(issue("INVALID_SHAPE", s.key || null,
        `clé « ${s.key} » invalide : lettres, chiffres et « :_-. » seulement.`));
      continue;
    }
    if (vues.has(s.key)) issues.push(issue("DUPLICATE_KEY", s.key, `la clé « ${s.key} » apparaît deux fois.`));
    vues.add(s.key);
  }
  return vues;
}

/** Ce que chaque étape va rendre — la lecture mémoïsée que la passe 3 consulte pour juger une référence. */
export function sortiesDuPlan(plan: MissionPlan, catalog: CapabilityCatalog): (cle: string) => SortieEtape | null {
  /**
   * ── CE QUE CHAQUE ÉTAPE VA RENDRE, calculé UNE fois pour tout le plan ─────────────────
   *
   * Une référence `{{a.b}}` se juge sur la sortie de « a ». Le calcul est mémoïsé parce qu'un
   * plan de trente étapes lit cinq fois la même amont, et qu'une forme apprise vient d'un cache
   * dont la lecture, si elle est gratuite, ne l'est pas au point d'être refaite cent fois.
   */
  const parCle = new Map(plan.steps.map((e) => [e.key, e]));
  const sorties = new Map<string, SortieEtape>();
  const sortieDe = (cle: string): SortieEtape | null => {
    const deja = sorties.get(cle);
    if (deja) return deja;
    const e = parCle.get(cle);
    if (!e) return null; // Une étape ACQUISE d'un plan précédent : on n'a pas sa définition ici.
    const v = sortieAttendue(e, catalog.sortie ? (n) => catalog.sortie!(n) : undefined);
    sorties.set(cle, v);
    return v;
  };
  return sortieDe;
}
