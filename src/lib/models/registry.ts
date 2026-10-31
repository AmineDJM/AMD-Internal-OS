import {
  type ModelBinding,
  type ModelProvider,
  type ModelRole,
  type ReasoningEffort,
  type Verbosity,
  MODEL_ROLES,
} from "./contract";
import { PRIX_RECHERCHE_WEB, tarifDuModele } from "./tarifs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI TRAVAILLE POUR QUI — la table des rôles, et le seul endroit qui nomme un modèle.
 *
 * ── LA STACK CIBLE ───────────────────────────────────────────────────────────────────────
 *
 *   realtime      gpt-realtime-2.1     Adam écoute, comprend, converse, décide.
 *   orchestrator  gpt-5.6-terra medium Adam travaille : investigue, planifie, synthétise.
 *   worker        gpt-5.6-terra none   une sous-tâche qui demande de comprendre.
 *   bulk          gpt-5.6-luna  none   extraire, classer, normaliser — en volume.
 *
 * ── POURQUOI UNE TABLE PLUTÔT QUE DES CONSTANTES DISPERSÉES ──────────────────────────────
 *
 * Parce qu'un modèle se remplace en exploitation, pas en revue de code. Chaque rôle est
 * surchargeable par variable d'environnement : le jour où un modèle sort, où un autre devient
 * moins cher, où l'un tombe en panne, on rebranche sans toucher à une boucle d'agent.
 *
 * ── LE RETOUR EN ARRIÈRE EST PRÉVU, ET C'EST VOULU ───────────────────────────────────────
 *
 * `ADAM_MODEL_PROVIDER=anthropic` rebascule les rôles textuels sur l'ancien chemin Claude, qui
 * reste en place. Une migration de cerveau sans marche arrière n'est pas une migration, c'est un
 * pari. Le rôle `realtime` ne bascule pas : il n'a pas d'équivalent chez l'autre fournisseur.
 *
 * ── LES TARIFS, ET CE QU'ON REFUSE D'INVENTER ────────────────────────────────────────────
 *
 * Le tarif de Luna est connu et vérifié (0,20 $ / 1,20 $ par million — voir `openai-luna.ts`).
 * Ceux de Terra et du temps réel ne le sont PAS dans ce dépôt : ils valent donc `null`, et le
 * coût rapporté vaut `null` plutôt qu'un chiffre plausible. Un tableau de bord de coût qui
 * affiche une estimation inventée fait prendre de vraies décisions sur des faux chiffres.
 * Ils se renseignent sans redéploiement : `ADAM_PRICE_ORCHESTRATOR_IN` / `_OUT`, etc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Modèles par défaut. Le seul endroit du produit où ces chaînes sont écrites. */
export const DEFAULT_MODELS: Record<ModelRole, string> = {
  realtime: "gpt-realtime-2.1",
  orchestrator: "gpt-5.6-terra",
  worker: "gpt-5.6-terra",
  bulk: "gpt-5.6-luna",
};

/**
 * QUELS MODÈLES RAISONNENT a déménagé dans `capabilities.ts`, avec le reste de leurs capacités.
 * Ce fichier dit QUI TRAVAILLE POUR QUI (rôle → modèle, effort, tarif) ; le registre des
 * capacités dit CE QUE CHAQUE MODÈLE ACCEPTE. Les deux questions sont distinctes, et les avoir
 * mêlées est ce qui a permis d'envoyer `temperature` à un modèle qui le refuse.
 */

/**
 * LA CONCISION PAR RÔLE — le remplaçant de `temperature`, réglé là où vivent déjà les rôles.
 *
 * Adam converse et doit être rapide : les réponses opérationnelles partent en `low`.
 * L'orchestrateur, lui, produit des synthèses qu'on lit pour décider — `medium` lui laisse la
 * place d'expliquer sans le pousser au bavardage.
 */
export const DEFAULT_VERBOSITY: Record<ModelRole, Verbosity> = {
  realtime: "low",
  orchestrator: "medium",
  worker: "low",
  bulk: "low",
};

/** Effort de raisonnement par défaut, par rôle. */
export const DEFAULT_REASONING: Record<ModelRole, ReasoningEffort> = {
  realtime: "none",
  orchestrator: "medium",
  worker: "none",
  bulk: "none",
};

/**
 * Tarifs connus, en dollars par million de jetons. Une entrée absente vaut « inconnu », ce qui
 * n'est pas la même chose que gratuit — voir l'en-tête.
 */
/**
 * LES TARIFS VIENNENT DE LA GRILLE DATÉE (`tarifs.ts`, lot K8) — un seul endroit pour tous les
 * fournisseurs, vérifié contre la documentation publique ; toute variable `ADAM_PRICE_*` les
 * remplace sans redéploiement le jour où la grille change. Le temps réel est tarifé ici au TEXTE :
 * l'audio est ventilé et facturé par le journal (`response.done.usage`), pas par cette passerelle.
 */
function knownPriceOf(model: string): { in: number; out: number; cachedIn: number } | null {
  const t = tarifDuModele(model);
  if (!t?.entree || !t.sortie) return null;
  return { in: Number(t.entree), out: Number(t.sortie), cachedIn: Number(t.entreeCache ?? t.entree) };
}

/** Le repli Anthropic, rôle par rôle — l'ancien cerveau, gardé pour pouvoir revenir. */
const ANTHROPIC_FALLBACK: Record<ModelRole, string> = {
  realtime: "gpt-realtime-2.1", // pas d'équivalent : ce rôle ne bascule jamais
  orchestrator: "claude-sonnet-4-6",
  worker: "claude-sonnet-4-6",
  bulk: "claude-haiku-4-5",
};

const env = (k: string): string => (process.env[k] ?? "").trim();

const num = (k: string): number | null => {
  const raw = env(k);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const REASONINGS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

function readReasoning(role: ModelRole): ReasoningEffort {
  const raw = env(`ADAM_REASONING_${role.toUpperCase()}`).toLowerCase();
  return (REASONINGS as string[]).includes(raw) ? (raw as ReasoningEffort) : DEFAULT_REASONING[role];
}

/**
 * Le fournisseur en vigueur pour les rôles TEXTUELS. `realtime` est toujours OpenAI : la session
 * temps réel n'existe que là, la basculer n'aurait aucun sens.
 */
export function activeProvider(): ModelProvider {
  return env("ADAM_MODEL_PROVIDER").toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

/**
 * LA LIAISON EFFECTIVE d'un rôle, à cet instant, dans cet environnement.
 *
 * Lue à CHAQUE appel plutôt que figée au chargement du module : sans cela, changer une variable
 * d'environnement demanderait un redémarrage, et les tests ne pourraient pas couvrir deux
 * configurations dans le même processus.
 */
/**
 * LE RÔLE DE LA VOIX, nommé une seule fois. Hors de la passerelle, personne n'écrit
 * `"realtime"` comme rôle (`routing.test.ts` l'interdit) : le journal d'usage d'une session
 * vocale prend donc le rôle ICI, pas dans une chaîne recopiée.
 */
export const ROLE_VOIX: ModelRole = "realtime";

export function bindingFor(role: ModelRole): ModelBinding {
  const provider: ModelProvider = role === "realtime" ? "openai" : activeProvider();

  const override = env(`ADAM_MODEL_${role.toUpperCase()}`);
  const model =
    override || (provider === "anthropic" ? ANTHROPIC_FALLBACK[role] : DEFAULT_MODELS[role]);

  const known = knownPriceOf(model);
  const priceInPerM = num(`ADAM_PRICE_${role.toUpperCase()}_IN`) ?? known?.in ?? null;
  const priceOutPerM = num(`ADAM_PRICE_${role.toUpperCase()}_OUT`) ?? known?.out ?? null;
  // Le tarif RÉDUIT des jetons en cache : la grille publique quand le modèle y figure, sinon
  // l'exploitation — jamais deviné. Absent, les jetons en cache restent facturés au tarif plein
  // (voir `costOf` dans le contrat). Un tarif d'entrée surchargé SANS tarif de cache surchargé
  // retombe sur le plein : deux grilles mélangées feraient un coût faux.
  const surchargeIn = num(`ADAM_PRICE_${role.toUpperCase()}_IN`);
  const priceCachedInPerM = num(`ADAM_PRICE_${role.toUpperCase()}_CACHED_IN`) ?? (surchargeIn == null ? known?.cachedIn ?? null : null);

  return { role, provider, model, reasoning: readReasoning(role), priceInPerM, priceOutPerM, priceCachedInPerM };
}

/** La table entière — pour l'écran d'administration et le rapport d'observabilité. */
export function allBindings(): ModelBinding[] {
  return MODEL_ROLES.map(bindingFor);
}

/**
 * Ce rôle est-il utilisable ? Un rôle sans clé n'est pas une panne : c'est une configuration
 * absente, et cela se dit autrement à l'écran.
 */
export function roleConfigured(role: ModelRole): boolean {
  const { provider } = bindingFor(role);
  return Boolean(env(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"));
}

/**
 * LE TARIF D'UNE RECHERCHE WEB, en dollars PAR RECHERCHE — pas par jeton.
 *
 * L'outil `web_search` de Responses est facturé à l'appel (tarif public OpenAI : 10 $ les
 * 1 000 recherches, soit 0,01 $ l'unité). Ce n'est pas une estimation inventée : c'est le tarif
 * affiché, et il se corrige sans redéploiement par `ADAM_PRICE_WEB_SEARCH_CALL` le jour où il
 * change. L'omettre du coût ferait précisément ce que `contract.ts` interdit : présenter un
 * total partiel comme un total.
 */
export function webSearchPricePerCall(): number {
  return num("ADAM_PRICE_WEB_SEARCH_CALL") ?? Number(PRIX_RECHERCHE_WEB);
}
