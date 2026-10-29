import type { CurrentUser } from "./action-registry/dependances";
import { buildIndex, resolve, type ResolverContext } from "./nl/resolver";
import { OPS_CATALOG, catalogCoveredKeys } from "@/lib/assistant/ops/catalog";
import type { NativeAction } from "./action-registry/types";
import { CORE_ERP_ACTIONS } from "./action-registry/actions-natives";
import { CLASSIFICATION, type ActionClassification } from "./action-registry/classement";
import { classerNatifsEtCouverts } from "./action-registry/natifs-couverts";
import { classerTrous } from "./action-registry/trous";
import { classerExclusionsCircuits } from "./action-registry/exclusions-circuits";
import { classerExclusionsAttestations } from "./action-registry/exclusions-attestations";

/**
 * ERP ACTION REGISTRY — le Chief of Staff est le PLAN DE CONTRÔLE en langage naturel de l'ERP.
 *
 * Trois pièces, un principe (« pour chaque bouton métier auquel la personne a droit, le Chief
 * sait invoquer LA MÊME action serveur ») :
 *
 *   1. `ERP_ACTIONS` — les actions natives que le Chief sait déjà PROPOSER : id stable, libellé
 *      du bouton à l'écran, ALIAS en langage naturel, outil du Chief, risque, porte. C'est ce
 *      qui permet de résoudre « demande l'actualisation des soldes » vers le bouton Finances
 *      réel — au lieu de fabriquer une demande administrative générique plus faible.
 *   2. `matchNativeAction(question)` — la résolution intention → action native (repli des
 *      accents, singulier/pluriel, containment de TOUS les jetons d'un alias). Injectée dans le
 *      plan de la question : PRIORITÉ AU NATIF, les replis (tâche, demande générique, message)
 *      ne viennent qu'ensuite.
 *   3. `ACTION_CLASSIFICATION` — l'INVENTAIRE EXHAUSTIF : chaque `export async function` de
 *      `src/lib/actions/` est classée NATIVE (le Chief exécute cette action même), COVERED (le
 *      Chief obtient le même résultat métier par un outil équivalent), GAP (trou de capacité
 *      RECONNU, à combler), ou EXCLUDED (hors sujet pour un assistant, raison donnée).
 *      Le test `action-parity.test.ts` échoue dès qu'une action serveur existe sans
 *      classification — un bouton ajouté à l'ERP ne peut plus devenir un trou silencieux.
 *
 * Module PUR (pas de Prisma) : importable par le planner, testable sans base. Les portes ici
 * sont un PRÉ-FILTRE de découverte — chaque action canonique revérifie les droits à l'exécution.
 *
 * Découpé dans `action-registry/` : `types.ts`, `actions-natives.ts` (les actions écrites à la
 * main), `classement.ts` (la table de parité et ses écrivains) et un fichier par bloc de
 * classement (`natifs-couverts`, `trous`, `exclusions-*`), appelés ici dans l'ordre d'origine.
 */

export type { NativeAction } from "./action-registry/types";

/**
 * Les OPS DE DOMAINE (`ops/catalog.ts`) entrent dans le MÊME registre : mêmes alias, même
 * matching, même découverte (`find_available_actions`) — une op ajoutée au catalogue devient
 * découvrable ici sans rien recopier. `toolOp` porte la valeur du champ `op` à passer.
 */
const CATALOG_ERP_ACTIONS: NativeAction[] = OPS_CATALOG.map((m) => ({
  id: `OP_${m.tool.toUpperCase()}_${m.op.toUpperCase()}`,
  module: m.module,
  uiLabel: m.uiLabel,
  toolName: m.tool,
  toolOp: m.op,
  aliases: m.aliases,
  risk: m.risk,
  summary: m.summary,
  gate: m.gate,
  ...(m.gateNote ? { gateNote: m.gateNote } : {}),
}));

export const ERP_ACTIONS: NativeAction[] = [...CORE_ERP_ACTIONS, ...CATALOG_ERP_ACTIONS];

// ───────────────────────── Résolution intention → action native ─────────────────────────

/** Mots-outils français écartés du matching (sinon « demande rh » se réduirait à « demande »). */
const STOP = new Set([
  "de", "du", "des", "le", "la", "les", "un", "une", "en", "et", "ou", "au", "aux",
  "ce", "ces", "cette", "se", "sa", "son", "ses", "ne", "pas", "par", "sur", "pour",
  "dans", "que", "qui", "est", "il", "elle", "je", "tu", "on", "nous", "vous", "ils",
  "me", "te", "mon", "ton", "ma", "ta", "mes", "tes", "avec", "plus", "faut",
  // Démonstratifs et pronoms manquants — mesuré : leur absence rapprochait « supprime CET
  // employé » de « modifie le département de CET employé ». Deux phrases n'ont rien en commun
  // parce qu'elles partagent un démonstratif ; proposer une suppression définitive à qui
  // demande une modification est le pire faux positif possible.
  "cet", "celui", "celle", "ceux", "celles", "leur", "leurs", "lui", "eux", "y",
  "ete", "etre", "soit", "tout", "tous", "toute", "toutes", "meme", "memes",
  "comme", "quand", "dont", "donc", "alors", "aussi", "tres", "bien",
  "vers", "chez", "sans", "sous", "entre", "apres", "avant", "depuis", "encore", "deja",
  "ont", "ai", "as", "ont", "oui", "non", "merci", "stp", "svp",
]);

/**
 * RACINISATION LÉGÈRE DU FRANÇAIS — parce que le PDG ne parle pas à l'infinitif.
 *
 * L'alias du registre dit « assigner le dossier », le PDG dit « assigne le dossier ». Sans cette
 * étape, ces deux mots sont étrangers l'un à l'autre et l'action native n'est jamais reconnue :
 * mesuré sur 110 formulations réelles, c'était la première cause de silence du résolveur.
 *
 * On coupe les terminaisons verbales et le pluriel, en gardant un radical d'au moins 4 lettres —
 * en dessous on rabote des mots courts et on fabrique des collisions. La même fonction s'applique
 * AUX DEUX CÔTÉS : ce qui compte n'est pas la justesse linguistique du radical, c'est que
 * « assigner » et « assigne » tombent sur le MÊME.
 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  // Du plus long au plus court : « ations » avant « ons », sinon on coupe trop court.
  const cut = word.replace(/(ations|ation|ements|ement|erait|eront|ions|iez|ons|ent|ez|er|es|ee|e|s|x)$/, "");
  return cut.length >= 4 ? cut : word.replace(/[sx]$/, "");
}

/** Repli : accents, apostrophes, ponctuation — jetons ≥ 2 lettres hors mots-outils, racinisés. */
function foldTokens(text: string): Set<string> {
  const folded = text
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[''`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ");
  const out = new Set<string>();
  for (const raw of folded.split(" ")) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * L'INDEX DE RÉSOLUTION — construit une fois, à partir du registre lui-même.
 *
 * La logique vit dans `nl/resolver.ts` : le registre déclare des actions, il ne sait pas
 * comprendre le français. Séparer les deux permet de mesurer le résolveur sur un corpus fixe
 * sans rien savoir de l'ERP, et d'améliorer la compréhension sans toucher aux 529 actions.
 */
const NL_INDEX = buildIndex(ERP_ACTIONS, (a) => ({
  id: a.id,
  module: a.module,
  aliases: a.aliases,
  risk: a.risk,
  uiLabel: a.uiLabel,
}));

/**
 * « Y a-t-il DÉJÀ une action native de l'ERP qui correspond à cette intention ? »
 *
 * Un alias correspond quand TOUS ses jetons (dé-accentués, dé-pluralisés) sont présents dans la
 * question — l'alias le plus SPÉCIFIQUE (le plus de jetons) l'emporte. On rend au plus deux
 * candidats distincts : c'est un INDICE injecté dans le plan, le modèle garde le jugement
 * (et la confirmation humaine garde le dernier mot).
 */
export function matchNativeAction(question: string, ctx: ResolverContext = {}): NativeAction[] {
  return resolve(NL_INDEX, question, ctx).candidates.map((c) => c.action);
}

/**
 * La résolution COMPLÈTE — score, confiance, ambiguïté, motif de refus.
 *
 * `matchNativeAction` n'en garde que la liste, pour les appelants qui n'ont besoin que d'un
 * indice. Ici on rend de quoi DÉCIDER : proposer, demander de préciser, ou se taire.
 */
export function resolveNativeAction(question: string, ctx: ResolverContext = {}) {
  return resolve(NL_INDEX, question, ctx);
}

/** Le bloc de plan injecté quand une action native correspond — PRIORITÉ AU NATIF. */
export function nativeActionHint(question: string): string | null {
  const matches = matchNativeAction(question);
  if (matches.length === 0) return null;
  const lines = matches.map((a) =>
    `• « ${a.uiLabel} » (${a.module}) → outil ${a.toolName}${a.toolOp ? ` (op « ${a.toolOp} »)` : ""}${a.risk !== "NORMAL" ? ` [${a.risk}]` : ""}`,
  );
  return `ACTION NATIVE DE L'ERP DÉTECTÉE pour cette demande :\n${lines.join("\n")}\n`
    + "RÈGLE : utiliser CET outil natif — jamais une demande administrative générique, une tâche ou un "
    + "message à la place d'un bouton métier qui existe. (Si l'intention réelle est différente, ignorer l'indice.)";
}

/**
 * LES ACTIONS DISPONIBLES SUR L'ÉCRAN d'où la conversation démarre (« Appeler » depuis une
 * fiche, entrée contextuelle) : le contexte d'écran (route + référence) se plie en tokens et
 * matche les modules du registre — l'assistant sait D'EMBLÉE quels boutons natifs existent LÀ,
 * au lieu de le découvrir (ou pas) par find_available_actions. Null sans correspondance :
 * jamais de bruit. Borné (12) : le budget d'instructions vocales se paie en latence.
 */
export function screenActionsContext(user: CurrentUser, screen: string): string | null {
  const matched = actionsForUser(user, screen);
  if (matched.length === 0) return null;
  const lines = matched.slice(0, 12).map((a) =>
    `• ${a.uiLabel} → ${a.toolName}${a.toolOp ? ` (op « ${a.toolOp} »)` : ""}${a.risk !== "NORMAL" ? ` [${a.risk}]` : ""}`,
  );
  const more = matched.length > 12 ? `\n(+${matched.length - 12} autres — find_available_actions pour la liste complète)` : "";
  return `ACTIONS NATIVES DISPONIBLES SUR CET ÉCRAN (priorité au natif — jamais une demande générique à la place d'un bouton qui existe ici) :\n${lines.join("\n")}${more}`;
}

/** Les actions natives OUVERTES à cette personne (pré-filtre écran ; l'exécution revérifie). */
export function actionsForUser(user: CurrentUser, moduleQuery?: string): NativeAction[] {
  const all = ERP_ACTIONS.filter((a) => {
    try { return a.gate(user) || Boolean(a.gateNote); } catch { return false; }
  });
  if (!moduleQuery?.trim()) return all;
  const q = foldTokens(moduleQuery);
  return all.filter((a) => {
    const m = foldTokens(a.module);
    return [...q].some((t) => m.has(t));
  });
}

// ───────────────────────── Inventaire exhaustif & classification ─────────────────────────

export type { ActionClassification } from "./action-registry/classement";

// Les blocs s'exécutent dans l'ordre : un bloc postérieur écrase un antérieur.
classerNatifsEtCouverts();
classerTrous();
classerExclusionsCircuits();
classerExclusionsAttestations();

// ── RECLASSIFICATION AUTOMATIQUE PAR LE CATALOGUE D'OPS (après tous les blocs ci-dessus). ──
// Chaque op de domaine déclare les server actions qu'elle rend NATIVE (`covers`) : leurs clés
// passent de GAP à NATIVE ici, sans retoucher les blocs à la main. Ajouter une op = fermer ses
// trous — c'est le mécanisme SYSTÉMIQUE anti « capability whack-a-mole ».
for (const [key, via] of catalogCoveredKeys()) {
  CLASSIFICATION[key] = { status: "NATIVE", via };
}

export const ACTION_CLASSIFICATION: Readonly<Record<string, ActionClassification>> = CLASSIFICATION;

/** La métrique UI_ACTION_PARITY : couvert / (couvert + trous), exclusions à part. */
export function parityStats(): { native: number; covered: number; gap: number; excluded: number; total: number; parityPct: number } {
  let native = 0, covered = 0, gap = 0, excluded = 0;
  for (const c of Object.values(CLASSIFICATION)) {
    if (c.status === "NATIVE") native++;
    else if (c.status === "COVERED") covered++;
    else if (c.status === "GAP") gap++;
    else excluded++;
  }
  const total = native + covered + gap + excluded;
  const denom = native + covered + gap;
  return { native, covered, gap, excluded, total, parityPct: denom ? Math.round(((native + covered) / denom) * 1000) / 10 : 0 };
}
