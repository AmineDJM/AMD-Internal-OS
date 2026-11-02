/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE MISSION = UNE CONFIRMATION — et un seul aller-retour serveur pour l'exécuter.
 *
 * ── LE PROBLÈME RÉEL ─────────────────────────────────────────────────────────────────────
 *
 * « Envoie à Amine la situation Regulatory et crée-moi un rappel vendredi » produisait déjà
 * DEUX cartes en un seul tour — ça, c'était acquis. Mais « tout confirmer » BOUCLAIT DANS LE
 * NAVIGATEUR : un appel serveur par action, en série, piloté par la page. Un onglet fermé, un
 * réseau qui coupe ou un téléphone qui se verrouille au milieu, et la moitié du lot était
 * partie sans que personne ne sache laquelle.
 *
 * Ce module fait passer l'enchaînement CÔTÉ SERVEUR : un appel, un compte rendu, et un lot qui
 * ne dépend plus de la survie d'un onglet.
 *
 * ── CE QU'IL N'INVENTE PAS, ET C'EST L'ESSENTIEL ─────────────────────────────────────────
 *
 * Aucune sémantique d'exécution nouvelle. Chaque étape repasse par le MÊME chemin canonique —
 * `executeIntentGuarded` (réclamation atomique, reçu rejoué, jamais deux fois) puis
 * `performAction` (RBAC ré-autorisé, arrêt d'urgence, journal d'audit). Ce fichier ne fait
 * qu'ORDONNANCER. Un ordonnanceur qui se mettrait à écrire lui-même serait une seconde porte
 * vers les mutations, c'est-à-dire exactement ce que l'architecture interdit.
 *
 * ── TROIS RÈGLES, ET POURQUOI ELLES SONT ASYMÉTRIQUES ────────────────────────────────────
 *
 *   1. UNE ACTION CRITIQUE NE S'ENCHAÎNE JAMAIS. Elle exige la ressaisie d'une valeur (montant,
 *      référence) : la noyer dans un « tout confirmer » reviendrait à supprimer la garde en la
 *      contournant. Elle est REFUSÉE explicitement, pas sautée en silence — un lot qui tait ce
 *      qu'il n'a pas fait est pire qu'un lot qui échoue.
 *
 *   2. UN ÉCHEC N'ARRÊTE PAS CE QUI EST INDÉPENDANT. Si le mail ne part pas, le rappel de
 *      vendredi n'a aucune raison de tomber avec lui.
 *
 *   3. …MAIS IL ARRÊTE CE QUI EN DÉPEND. Une étape qui référence « $prev » lit une valeur
 *      produite par l'étape précédente. Si celle-ci n'a pas eu lieu, l'exécuter la ferait
 *      travailler sur un état qui n'existe pas. Elle n'est donc PAS tentée, et on le dit.
 *
 * ── POURQUOI AUCUN RÉESSAI AUTOMATIQUE DES MUTATIONS ─────────────────────────────────────
 *
 * Le garde rend une action REJOUABLE une fois qu'elle a abouti (le reçu d'origine revient). Mais
 * une action qui a ÉCHOUÉ peut avoir écrit à moitié — rien ne prouve le contraire de façon
 * générique. Rejouer là serait risquer un double envoi ou un double paiement pour économiser un
 * clic. Une action manquée est un désagrément ; une action faite deux fois ne se reprend pas.
 * Le réessai appartient donc à l'utilisateur, informé de ce qui a échoué.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { sansBloquer } from "@/lib/journal";
export type BundleLevel = "NORMAL" | "SENSITIVE" | "CRITICAL";

export interface BundleItem {
  intentId: string;
  /** Le libellé montré à l'écran — repris tel quel dans le compte rendu. */
  title: string;
  level: BundleLevel;
  /** L'étape lit-elle une valeur produite par la précédente ? (voir règle 3) */
  dependsOnPrevious: boolean;
}

export type BundleStatus = "executed" | "already" | "refused" | "failed" | "skipped";

export interface BundleOutcome {
  intentId: string;
  title: string;
  status: BundleStatus;
  message?: string;
  link?: string;
  error?: string;
}

export interface BundleResult {
  /** VRAI seulement si tout ce qui devait partir est parti. Un lot à moitié fait n'est pas « ok ». */
  ok: boolean;
  executed: number;
  failed: number;
  /** Refusées (CRITIQUE) + non tentées (dépendance non satisfaite). */
  held: number;
  outcomes: BundleOutcome[];
  /** Le compte rendu, en français, jamais optimiste. */
  message: string;
}

/** Ce que l'exécuteur a besoin de savoir faire — injecté, donc testable sans base ni réseau. */
export type RunOne = (
  intentId: string,
) => Promise<{ ok: boolean; alreadyExecuted?: boolean; message?: string; link?: string; error?: string } | null>;

/**
 * UNE ÉTAPE LIT-ELLE LA PRÉCÉDENTE ? Le chaînage « $prev.x » est déjà la convention des plans
 * d'action de ce produit : on la relit ici plutôt que d'inventer un second vocabulaire de
 * dépendances que le modèle ne connaîtrait pas.
 *
 * Recherche RÉCURSIVE : la référence peut être imbriquée dans un objet ou un tableau du payload.
 */
export function referencesPrevious(payload: unknown): boolean {
  if (typeof payload === "string") return payload.includes("$prev");
  if (Array.isArray(payload)) return payload.some(referencesPrevious);
  if (payload && typeof payload === "object") return Object.values(payload).some(referencesPrevious);
  return false;
}

const REFUSAL_CRITICAL =
  "Action critique : elle se confirme seule, en ressaisissant la valeur demandée. Rien n'a été exécuté.";

const SKIP_DEPENDENCY =
  "Non tentée : elle dépend d'une étape précédente qui n'a pas abouti.";

/**
 * Rédige le compte rendu. Il dit d'abord ce qui EST FAIT, puis ce qui ne l'est pas — dans cet
 * ordre parce que c'est l'ordre des questions qu'on se pose, et jamais l'un sans l'autre.
 */
export function bundleMessage(outcomes: BundleOutcome[]): string {
  const done = outcomes.filter((o) => o.status === "executed" || o.status === "already");
  const failed = outcomes.filter((o) => o.status === "failed");
  const held = outcomes.filter((o) => o.status === "refused" || o.status === "skipped");

  if (!outcomes.length) return "Rien à exécuter.";

  const parts: string[] = [];
  if (done.length === outcomes.length) {
    parts.push(done.length === 1 ? "Fait." : `Les ${done.length} actions sont faites.`);
  } else {
    parts.push(done.length === 0 ? "Rien n'a été exécuté." : `${done.length} sur ${outcomes.length} exécutée${done.length > 1 ? "s" : ""}.`);
  }
  for (const f of failed) parts.push(`Échec — ${f.title} : ${f.error ?? "raison inconnue"}.`);
  for (const h of held) {
    parts.push(`${h.title} : ${h.status === "refused" ? "à confirmer séparément (action critique)" : "non tentée (dépendance non satisfaite)"}.`);
  }
  return parts.join(" ");
}

/**
 * EXÉCUTE LE LOT, dans l'ordre proposé.
 *
 * L'ordre n'est pas décoratif : c'est celui que le modèle a produit, et c'est déjà lui qui porte
 * le chaînage « $prev ». Le respecter est donc la façon la moins inventive — donc la plus sûre —
 * de traiter les dépendances.
 */
export async function executeBundle(items: BundleItem[], runOne: RunOne): Promise<BundleResult> {
  const outcomes: BundleOutcome[] = [];
  // « L'étape précédente a-t-elle abouti ? » — la seule information dont la règle 3 a besoin.
  let previousSucceeded = true;

  for (const item of items) {
    const base = { intentId: item.intentId, title: item.title };

    // Règle 1 — une action critique ne s'enchaîne jamais.
    if (item.level === "CRITICAL") {
      outcomes.push({ ...base, status: "refused", error: REFUSAL_CRITICAL });
      // Elle n'a pas eu lieu : ce qui en dépendrait ne doit pas partir non plus.
      previousSucceeded = false;
      continue;
    }

    // Règle 3 — ce qui dépend d'une étape non aboutie n'est pas tenté.
    if (item.dependsOnPrevious && !previousSucceeded) {
      outcomes.push({ ...base, status: "skipped", error: SKIP_DEPENDENCY });
      continue;
    }

    const r = await runOne(item.intentId).catch(sansBloquer("bundle.executeBundle.runOne", null));

    if (!r) {
      outcomes.push({ ...base, status: "failed", error: "Action introuvable ou expirée — rien n'a été exécuté." });
      previousSucceeded = false;
      continue;
    }
    if (r.ok) {
      outcomes.push({
        ...base,
        status: r.alreadyExecuted ? "already" : "executed",
        message: r.message,
        link: r.link,
      });
      previousSucceeded = true;
      continue;
    }
    outcomes.push({ ...base, status: "failed", error: r.error ?? "L'action n'a pas pu être exécutée." });
    previousSucceeded = false;
  }

  const executed = outcomes.filter((o) => o.status === "executed" || o.status === "already").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const held = outcomes.filter((o) => o.status === "refused" || o.status === "skipped").length;

  return {
    // `outcomes.length > 0` n'est pas une précaution défensive : sans lui, un lot VIDE serait
    // « ok » par vacuité, et l'appelant afficherait « Fait. » alors que rien n'a eu lieu.
    // `ok` se lit « votre demande a été exécutée » — sans demande, la réponse est non.
    ok: outcomes.length > 0 && failed === 0 && held === 0 && executed === outcomes.length,
    executed,
    failed,
    held,
    outcomes,
    message: bundleMessage(outcomes),
  };
}
