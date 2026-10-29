/**
 * LES PIÈCES COMMUNES AUX DEUX BOUCLES (texte et flux) — prompt du chemin rapide, journal du
 * roulement, libellés de lecture, bornes de la boucle, relecture critique des questions à fort
 * enjeu, effort de raisonnement par niveau, outils déclarés au modèle.
 */

import type { CurrentUser } from "@/lib/assistant/coeur/erp";
import type { ClaudeMessage, ClaudeContentBlock } from "@/lib/models/compat";
import { callModel } from "@/lib/models/gateway";
import type { ReasoningEffort } from "@/lib/models/contract";
import { CHIEF_STYLE_RULES } from "@/lib/assistant/chief-style";
// L'ACTIVATION BORNÉE (§1–§4, §26) : lectures canoniques sûres en direct, reste des lectures en
// canary, TOUTES les mutations sur le chemin prouvé. La politique vit dans `rollout.ts` ; ici on
// ne fait que l'appliquer.
import { recordOutcome, type RolloutDecision } from "@/lib/assistant/context/rollout";
import { powerToolLabels } from "@/lib/assistant/power-tools";
import { ROLE_LABELS } from "@/lib/labels";
import type { ChatTurn } from "@/lib/assistant/coeur/contrat-actions";

/**
 * CE QU'ON ENREGISTRE À CHAQUE TOUR (§7) — et ce qu'on n'enregistre pas.
 *
 * Jamais le TEXTE de la demande : ce journal sert à régler un aiguillage, pas à relire les
 * conversations du PDG. Sa longueur et sa route suffisent à diagnostiquer.
 *
 * `missingTool` mérite un mot : il ne vaut que sur le chemin en liste courte. Sur LEGACY le
 * modèle voit les 77 outils — un appel à la découverte y serait impossible, et compter un
 * manque sur un chemin qui ne restreint rien fausserait la garde dans le sens dangereux
 * (elle se déclencherait pour un problème qui n'existe pas).
 */
/**
 * LE PROMPT DU CHEMIN RAPIDE — quelques centaines de tokens au lieu de trente-huit mille.
 *
 * Sur une lecture canonique, le modèle n'a plus à CHOISIR : le code a déjà appelé le bon outil
 * et tient le résultat. Il ne lui reste qu'à le formuler. Tout ce qui servait à choisir — les
 * soixante-dix-sept schémas d'outils, le mode d'emploi des écritures, le digest réglementaire —
 * n'a plus aucune raison d'être envoyé.
 *
 * CE QU'ON GARDE, ET POURQUOI CHAQUE LIGNE EST LÀ :
 *   • l'identité et le nom de la personne servie — sans quoi Adam redevient « Assistant IA » ;
 *   • le style tac-au-tac — c'est une réponse d'une phrase qu'on attend, pas un rapport ;
 *   • l'interdiction d'inventer — la seule règle de sécurité qui compte quand on lit.
 */
export function fastReadSystem(user: CurrentUser, blocRegles: string | null = null): string {
  // Les règles enseignées (Teach Adam) valent sur CE chemin aussi : une consigne de forme
  // (« termine par Prochaine étape ») s'applique à une réponse d'une ligne comme à une longue.
  // Le reste du contexte personnel (identité, souvenirs) n'entre pas : il coûte et ne sert pas ici.
  const regles = blocRegles ? `\n\n${blocRegles}` : "";
  return `Tu es Adam, le chef de cabinet de ${user.name}.

On vient d'interroger la source CANONIQUE pour lui, et son résultat t'est donné ci-dessous.
Ton seul travail : le DIRE, en français, aussi brièvement que possible.

${CHIEF_STYLE_RULES}

RÈGLES DE CE TOUR :
- Réponds à partir du RÉSULTAT fourni, et de rien d'autre. Tu n'as pas d'autre source ici.
- Si le résultat est vide, dis-le simplement — n'invente aucun nom, aucune adresse, aucun chiffre.
- Ne mentionne jamais l'outil, la requête technique, ni le format des données.
- Pas de préambule, pas de « voici », pas de question finale.${regles}`;
}

export function observeRollout(
  decision: RolloutDecision,
  info: { user: CurrentUser; allToolCount: number; exposed: number; usedTools: string[]; discoveryCalls: number; startedAt: number },
): void {
  try {
    const restricted = decision.mode === "SHORTLIST" || decision.mode === "FAST_READ";
    const missingTool = restricted && info.discoveryCalls > 0;
    // Le repli : la garde le compte pour surveiller la tendance, il n'est pas une faute en soi.
    const fallback = decision.mode === "LEGACY" && !decision.isMutation;
    if (restricted || fallback) recordOutcome({ missingTool, fallback });

    console.info("[chief-rollout]", {
      mode: decision.mode,
      route: decision.route.route,
      domain: decision.route.domain,
      tier: decision.route.tier,
      confidence: Number(decision.route.confidence.toFixed(2)),
      isMutation: decision.isMutation,
      bucket: decision.bucket,
      canaryPercent: decision.canaryPercent,
      reason: decision.reason,
      toolsExposed: info.exposed,
      toolsFull: info.allToolCount,
      toolsUsed: info.usedTools.length,
      discoveryCalls: info.discoveryCalls,
      latencyMs: Date.now() - info.startedAt,
    });
  } catch {
    // Observer ne doit jamais coûter une réponse.
  }
}

export const READ_LABEL: Record<string, string> = {
  ...powerToolLabels(),
  search_people: "Annuaire interne consulté",
  my_overview: "Espace de travail consulté",
  list_my_tasks: "Tâches consultées",
  list_my_requests: "Demandes administratives consultées",
  search_doctors: "Annuaire médical consulté",
  search_products: "Produits Regulatory consultés",
  search_events: "Événements consultés",
  list_emails: "Boîte mail consultée",
  read_email: "E-mail lu",
  list_accounts: "Tous les comptes consultés",
  read_platform_settings: "Réglages de la plateforme consultés",
  export_excel: "Classeur Excel généré",
};

// ───────────────────────────── Boucle agent ─────────────────────────────

/**
 * Nombre d'allers-retours modèle ↔ outils avant d'abandonner.
 *
 * Six ne suffisait pas : une question du type « donne-moi tous les produits Regulatory »
 * consomme déjà plusieurs tours (chercher, élargir, recouper l'entité) et l'utilisateur
 * recevait « je n'ai pas pu finaliser la demande » alors que l'assistant travaillait
 * correctement. Chaque tour supplémentaire ne coûte que s'il est utilisé — la boucle
 * s'arrête dès que le modèle répond sans appeler d'outil.
 */
export const MAX_TURNS = 16;
const HISTORY_LIMIT = 24;

export function toMessages(history: ChatTurn[]): ClaudeMessage[] {
  return history
    .slice(-HISTORY_LIMIT)
    .filter((t) => t.content.trim().length > 0)
    .map((t) => ({ role: t.role, content: t.content }));
}

export function textOf(blocks: ClaudeContentBlock[]): string {
  return blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
}

/** L'étiquette de la seconde passe — visible dans la trace : le travail en plus se DIT. */
export const CRITIQUE_LABEL = "Relecture critique de la conclusion";
/** L'étape visible quand la garantie d'enseignement rappelle le modèle à l'outil (§119). */
export const TEACH_GARDE_LABEL = "Vérification : l'enseignement doit passer par l'outil";
export const DECOUVERTE_LABEL = "Carte complète des capacités relue";
export const ELARGISSEMENT_LABEL = "Recherche élargie avant de conclure à une absence";
export const PROMESSE_LABEL = "Suivi promis : un objet durable exigé";
/** L'étape visible quand « d'où tu tiens ça ? » se répond depuis le registre des lectures (F8). */
export const PROVENANCE_LABEL = "Provenance relue dans le registre des lectures";

/** Sous ce volume, la réponse est un fait simple — une relecture n'apporterait rien. */
export const CRITIQUE_MIN_DRAFT = 350;

const CRITIQUE_ADDENDUM = `SECONDE PASSE CRITIQUE (interne — jamais montrée) :
Tu relis un BROUILLON de réponse avant remise au décideur. Cherche, dans l'ordre :
l'hypothèse la plus fragile ; une preuve qui contredit la conclusion ; une explication
alternative ; ce qui manque et changerait la décision ; tout chiffre non sourcé.
Puis RÉÉCRIS LA RÉPONSE FINALE COMPLÈTE (pas ta critique) : même langue, même format,
corrigée là où le brouillon était fragile, avec chaque affirmation sensible qualifiée
(FAIT VÉRIFIÉ / FAIT DÉRIVÉ / ESTIMATION / HYPOTHÈSE / INCONNU quand c'est utile).
N'INVENTE AUCUNE donnée nouvelle : ce qui ne peut pas être vérifié ici se dit « à confirmer ».
Si le brouillon est déjà solide, rends-le tel quel (améliorations mineures permises).
Ta sortie = la réponse finale, rien d'autre.`;

/**
 * DAVANTAGE DE RAISONNEMENT QUAND L'ENJEU LE JUSTIFIE — un appel de plus, pas un modèle de
 * moins : la conclusion d'une question à fort enjeu (décision, recommandation, réorganisation,
 * gros montant) est relue par le même modèle en adversaire de sa propre analyse, puis remise
 * révisée. La chaîne de critique n'est JAMAIS exposée. En cas d'échec du second appel, le
 * brouillon d'origine est rendu — la passe ajoute, elle ne retire jamais.
 */
const CRITIQUE_SCHEMA = {
  name: "relecture_critique",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["brouillon_solide", "reponse_finale"],
    properties: {
      brouillon_solide: { type: "boolean", description: "vrai si le brouillon peut être remis tel quel" },
      reponse_finale: { type: "string", description: "LA RÉPONSE FINALE COMPLÈTE à remettre au décideur — jamais la critique, jamais une liste de points à corriger" },
    },
  },
} as const;

/** Ce qui trahit une critique rendue à la place de la réponse — le défaut mesuré au banc. */
const RESSEMBLE_A_UNE_CRITIQUE = /\b(brouillon|à corriger avant|a corriger avant|le texte à relire|seconde passe)\b/i;

export async function reviseHighStakes(
  system: string,
  question: string,
  draft: string,
  model: string | undefined,
  promptCacheKey?: string,
): Promise<string | null> {
  // LA SORTIE EST STRUCTURÉE, ET C'EST LE CORRECTIF. En texte libre, le modèle rendait parfois
  // sa critique (« INCONNU — les montants du brouillon ne sont pas vérifiés… À corriger avant
  // diffusion ») À LA PLACE de la réponse révisée — mesuré au banc sur « prépare-moi le
  // comité ». Un schéma sépare les deux champs : le verdict d'un côté, la réponse de l'autre,
  // et un brouillon jugé solide est rendu tel quel sans être réécrit.
  const reply = await callModel(
    "orchestrator",
    [{ role: "user", content: `QUESTION D'ORIGINE :\n${question.slice(0, 2_000)}\n\nBROUILLON DE RÉPONSE À RELIRE :\n${draft}` }],
    { system: `${system}\n\n${CRITIQUE_ADDENDUM}`, jsonSchema: CRITIQUE_SCHEMA, maxOutputTokens: 1400, ...(model ? { modelOverride: model } : {}), ...(promptCacheKey ? { promptCacheKey } : {}) },
  );
  if (!reply.ok) return null;
  const brut = reply.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
  type VerdictCritique = { brouillon_solide?: unknown; reponse_finale?: unknown };
  let parsed: VerdictCritique | null;
  try { parsed = JSON.parse(brut) as VerdictCritique | null; } catch { return null; }
  if (!parsed || typeof parsed !== "object" || parsed.brouillon_solide === true) return null;
  const texte = typeof parsed.reponse_finale === "string" ? parsed.reponse_finale.trim() : "";
  if (texte.length < 80) return null;
  // Une « réponse » qui parle du brouillon est une critique déguisée : le brouillon reste.
  if (RESSEMBLE_A_UNE_CRITIQUE.test(texte) && !RESSEMBLE_A_UNE_CRITIQUE.test(draft)) return null;
  return texte;
}
/**
 * L'EFFORT DE RAISONNEMENT SUIT LE NIVEAU, pas l'inverse.
 *
 * A et B : le plan est connu (une ou plusieurs opérations nommées) — réfléchir longuement à
 * QUOI appeler est du temps payé pour rien ; « low » suffit et se mesure au banc (succès
 * identiques, premier mot plus tôt). C : le plan est à découvrir — l'effort du rôle (registre,
 * surchargeable par ADAM_REASONING_ORCHESTRATOR) s'applique. `ADAM_REASONING_SIMPLE` règle
 * l'effort des niveaux A/B sans redéploiement.
 */
export function effortPourNiveau(level: string): ReasoningEffort | undefined {
  if (level === "C") return undefined;
  const brut = (process.env.ADAM_REASONING_SIMPLE ?? "").trim().toLowerCase();
  return (["none", "low", "medium", "high"] as const).includes(brut as never) ? (brut as ReasoningEffort) : "low";
}

/** Un message sans demande (salutation, merci, essai) : un mot chaleureux, du rôle le moins cher. */
export function salutationSystem(user: CurrentUser, identite: string | null): string {
  return `Tu es Adam, le chef de cabinet de ${user.name} (${ROLE_LABELS[user.role] ?? user.role}) chez Adventum Pharma.
${identite ?? ""}
Le message reçu ne contient AUCUNE demande (salutation, remerciement, accusé de réception, essai).
Réponds en français, en une phrase ou deux, chaleureux et sobre : pas de liste de capacités, pas de
question de relance obligatoire ; à un remerciement, réponds simplement. N'invente aucun fait.`;
}

/** Les outils des pré-lectures sont DÉCLARÉS au tour : le modèle voit leurs appels, il peut les rejouer. */
/**
 * LES OUTILS NÉS DANS LE TOUR : les noms `skill_…` que `create_skill` vient de rendre (ok: true).
 * Pur, tolérant : une sortie qui n'est pas du JSON n'expose rien.
 */
export function outilsCreesParmi(sorties: readonly { name: string; out: string }[]): string[] {
  const noms: string[] = [];
  for (const s of sorties) {
    if (s.name !== "create_skill") continue;
    try {
      const j = JSON.parse(s.out) as { ok?: unknown; outil?: unknown };
      if (j && j.ok === true && typeof j.outil === "string" && /^skill_[a-z0-9_]+$/.test(j.outil)) noms.push(j.outil);
    } catch { /* pas du JSON : rien à exposer */ }
  }
  return [...new Set(noms)];
}

export function avecOutilsDeclares<T extends { name: string }>(tools: T[], all: T[], noms: string[]): T[] {
  const connus = new Set(tools.map((t) => t.name));
  const ajout = all.filter((t) => noms.includes(t.name) && !connus.has(t.name));
  return ajout.length ? [...tools, ...ajout] : tools;
}
