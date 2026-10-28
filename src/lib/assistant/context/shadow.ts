import { routeQuery, type QueryRoute, type RouterContext } from "./router";
import { shortlistNames } from "./tool-shortlist";
import { BUDGETS } from "./budget";

/**
 * LE MODE OMBRE — comparer sans risquer (§30).
 *
 * LA RÈGLE DE LA MISSION : « Before fully replacing existing context construction, run new
 * ContextCompiler/router in shadow mode… Then cut over once benchmarks pass. Do not destabilize
 * production Adam. »
 *
 * POURQUOI ON NE BASCULE PAS SUR LA FOI D'UN BANC. Le banc de routage tourne sur 158 phrases
 * choisies ; la production, elle, verra tout le reste. Couper soixante-neuf outils sur le chemin
 * critique de l'assistant de toute l'entreprise parce qu'un banc affiche 100 % serait exactement
 * le raisonnement qui casse les produits. Le banc dit que la direction est bonne ; il ne dit pas
 * que la couverture est complète.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * LA QUESTION QUE CE MODULE POSE, ET C'EST LA SEULE QUI DÉCIDE DE LA BASCULE :
 *
 *      « Sur les tours réels, la liste courte contenait-elle TOUJOURS l'outil que le chemin
 *        actuel a effectivement appelé ? »
 *
 * Ce n'est pas une question d'opinion. Le chemin actuel voit les 77 outils et choisit ; on note
 * son choix, et on vérifie après coup que la liste courte l'aurait contenu. Un seul manque, et
 * l'on sait précisément lequel — le domaine à corriger, pas une intuition à débattre.
 *
 * Un manque n'est d'ailleurs PAS fatal en production : `list_more_tools` permettrait au modèle de
 * réclamer le reste. Mais il coûterait un tour, et c'est justement ce qu'on mesure : la fréquence
 * de ce tour supplémentaire est le prix réel de la liste courte.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * CE MODULE N'A AUCUN EFFET DE BORD SUR LA CONVERSATION. Il calcule, il compare, il rend un
 * constat. Ce que l'appelant en fait — le journaliser, l'ignorer — ne change rien à la réponse
 * que le PDG reçoit.
 */

export interface ShadowPlan {
  route: QueryRoute;
  /** Les outils que la liste courte aurait exposés. */
  shortlisted: string[];
  /** Combien d'outils le chemin actuel expose. */
  fullToolCount: number;
  /** Le plafond de contexte que la route aurait imposé. */
  budgetMax: number;
}

export interface ShadowVerdict {
  plan: ShadowPlan;
  /** Les outils que le chemin ACTUEL a réellement appelés sur ce tour. */
  actuallyUsed: string[];
  /** Vrai si la liste courte les contenait tous — la condition de bascule. */
  covered: boolean;
  /** Ceux qui auraient manqué : la liste exacte de ce qu'il reste à classer. */
  missing: string[];
  /** Combien d'outils la liste courte économise sur ce tour. */
  toolsSaved: number;
}

export function shadowPlan(
  utterance: string,
  ctx: RouterContext,
  fullToolCount: number,
): ShadowPlan {
  const route = routeQuery(utterance, ctx);
  return {
    route,
    shortlisted: shortlistNames(route),
    fullToolCount,
    budgetMax: BUDGETS[route.tier].max,
  };
}

/**
 * LE VERDICT D'UN TOUR.
 *
 * Attention à un piège de comptage : une route déterministe n'expose AUCUN outil, mais elle n'est
 * pas censée en appeler non plus — le code répond seul. Si le chemin actuel a quand même appelé
 * un outil sur un tour que le routeur jugeait déterministe, c'est une information PRÉCIEUSE et
 * pas un faux positif : cela veut dire que le raccourci se serait trompé. On la remonte donc
 * comme un manque, franchement.
 */
export function judgeShadow(plan: ShadowPlan, actuallyUsed: string[]): ShadowVerdict {
  const exposed = new Set(plan.shortlisted);
  const missing = actuallyUsed.filter((t) => !exposed.has(t));
  return {
    plan,
    actuallyUsed,
    covered: missing.length === 0,
    missing,
    toolsSaved: Math.max(0, plan.fullToolCount - plan.shortlisted.length),
  };
}

export interface ShadowSummary {
  turns: number;
  /** LE CHIFFRE DE BASCULE : part des tours où la liste courte suffisait. */
  coverage: number;
  /** Les outils qui ont manqué, du plus fréquent au moins fréquent — la file de travail. */
  missingByTool: [string, number][];
  /** Répartition des routes observées en conditions réelles (§28). */
  routeShare: Record<string, number>;
  /** Économie moyenne d'outils par tour. */
  avgToolsSaved: number;
  /** Part des tours où le routeur promettait une réponse sans modèle. */
  fastShare: number;
}

/**
 * Le seuil au-delà duquel la bascule devient raisonnable.
 *
 * 99 % et non 100 % : `list_more_tools` rattrape le cas manquant au prix d'un tour, et exiger la
 * perfection sur un corpus vivant reviendrait à ne jamais basculer. Mais 99 % n'est PAS un
 * arrondi complaisant — à ce niveau, un PDG qui pose cent questions par semaine rencontre le tour
 * supplémentaire une fois par semaine, ce qu'on peut assumer et expliquer.
 */
export const CUTOVER_COVERAGE = 0.99;

export function summarizeShadow(verdicts: ShadowVerdict[]): ShadowSummary {
  const n = verdicts.length;
  const missing = new Map<string, number>();
  const routes = new Map<string, number>();
  let saved = 0;
  let fast = 0;

  for (const v of verdicts) {
    for (const m of v.missing) missing.set(m, (missing.get(m) ?? 0) + 1);
    routes.set(v.plan.route.route, (routes.get(v.plan.route.route) ?? 0) + 1);
    saved += v.toolsSaved;
    if (v.plan.route.route === "FAST_DETERMINISTIC") fast += 1;
  }

  const share = (x: number) => (n === 0 ? 0 : x / n);
  return {
    turns: n,
    coverage: share(verdicts.filter((v) => v.covered).length),
    missingByTool: [...missing.entries()].sort((a, b) => b[1] - a[1]),
    routeShare: Object.fromEntries([...routes.entries()].map(([k, v]) => [k, share(v)])),
    avgToolsSaved: share(saved),
    fastShare: share(fast),
  };
}

export const readyToCutOver = (s: ShadowSummary): boolean =>
  s.turns >= 200 && s.coverage >= CUTOVER_COVERAGE;

/**
 * La ligne déposée dans les journaux à chaque tour. Volontairement sans le texte de l'énoncé :
 * ce journal sert à régler un aiguillage, pas à relire les conversations du PDG. La longueur et
 * la route suffisent à diagnostiquer ; le contenu ne regarde pas l'observabilité.
 */
export function shadowLogLine(v: ShadowVerdict, utteranceLength: number): Record<string, unknown> {
  return {
    route: v.plan.route.route,
    domain: v.plan.route.domain,
    tier: v.plan.route.tier,
    confidence: Number(v.plan.route.confidence.toFixed(2)),
    fastKind: v.plan.route.fastKind,
    toolsShortlisted: v.plan.shortlisted.length,
    toolsFull: v.plan.fullToolCount,
    toolsUsed: v.actuallyUsed.length,
    covered: v.covered,
    missing: v.missing,
    utteranceLength,
  };
}

/** Le socle, réexporté : les tests de couverture s'y réfèrent. */

/**
 * LE POINT D'ENTRÉE DEPUIS LA BOUCLE RÉELLE — et son unique promesse : NE RIEN CHANGER.
 *
 * Appelé dans le `finally` de la boucle de l'assistant, donc sur TOUS les chemins de sortie, y
 * compris l'erreur. Il n'a aucun effet sur la réponse rendue au PDG ; il dépose une ligne de
 * journal. Toute exception y est avalée, délibérément : un défaut de l'observation ne doit pas
 * faire tomber une conversation. Un tableau de bord qui casse le produit qu'il observe est pire
 * que pas de tableau de bord.
 *
 * PRÉCISION SUR CE QUE MESURE CETTE VERSION. Elle route l'énoncé SANS jeu de travail (le
 * WorkingSet n'est pas encore branché sur la boucle texte). Les formes qui dépendent du contexte
 * — « Et Raihana ? », « Envoie-le », « Alors ? » — n'y prennent donc pas leur raccourci. La
 * couverture observée est un PLANCHER : la version branchée fera mieux, jamais moins bien.
 */
export function recordShadow(
  utterance: string,
  fullToolCount: number,
  actuallyUsed: string[],
  ctx: RouterContext = {},
): void {
  try {
    const verdict = judgeShadow(shadowPlan(utterance, ctx, fullToolCount), actuallyUsed);
    console.info("[context-shadow]", shadowLogLine(verdict, (utterance ?? "").length));
  } catch {
    // Observer ne doit jamais coûter une réponse.
  }
}
