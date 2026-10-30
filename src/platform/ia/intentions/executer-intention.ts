import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { executeIntentGuarded } from "@/platform/ia/intentions/action-intents";
import { matchesConfirmText } from "@/platform/ia/intentions/confirm";

/** Ce qu'une exécution rend à l'écran — la forme d'Adam (`ExecuteResult`) et de l'Assistant IA. */
export interface ResultatExecution {
  ok: boolean;
  message?: string;
  link?: string;
  error?: string;
  /** Chemins à revalider après une exécution réussie. */
  revalidate?: string[];
}

/**
 * EXÉCUTER UNE INTENTION CONFIRMÉE — la porte que partagent les deux assistants.
 *
 * Écrite pour Adam (`executeAssistantAction`, dans `lib/actions/assistant-actions.ts`) ; l'Assistant IA
 * (`confirmerIntentionAssistantIA`) passe par elle avec SON exécuteur. Elle était privée au fichier
 * d'actions d'Adam : l'action de l'IA y vivait donc aussi. Déplacée telle quelle au socle (lot J0, phase B).
 * Rend `null` quand l'intention n'est pas à ce compte (ou n'existe pas).
 */
export async function executerIntention(
  user: CurrentUser, intentId: string, confirmTyped: string | undefined,
  executeur: (stored: unknown) => Promise<ResultatExecution>,
): Promise<ResultatExecution | null> {
  // CONFIRMATION FORTE — vérifiée PAR LE SERVEUR : pour une action CRITIQUE, la valeur
  // ressaisie doit correspondre au confirmText STOCKÉ à la proposition. La carte arme son
  // bouton avec la même règle, mais l'autorité est ICI : appeler cette action serveur
  // directement (console, script) sans la bonne ressaisie n'exécute rien. Un intent déjà
  // EXÉCUTÉ reste idempotent : le reçu d'origine se renvoie sans nouvelle ressaisie.
  const meta = await prisma.assistantActionIntent.findFirst({
    where: { id: intentId, userId: user.id },
    select: { status: true, level: true, confirmText: true },
  });
  if (meta && meta.status !== "EXECUTED" && meta.level === "CRITICAL") {
    if (!meta.confirmText) {
      return { ok: false, error: "Cette carte CRITIQUE date d'avant le durcissement de la confirmation : redemandez la proposition à l'assistant, puis confirmez en ressaisissant la valeur demandée. Rien n'a été exécuté." };
    }
    if (!matchesConfirmText(confirmTyped ?? "", meta.confirmText)) {
      return { ok: false, error: `Confirmation renforcée : la valeur ressaisie ne correspond pas à « ${meta.confirmText} ». Rien n'a été exécuté.` };
    }
  }
  const guarded = await executeIntentGuarded(user, intentId, async (stored) => {
    const r = await executeur(stored);
    if (r.ok && r.revalidate) for (const path of r.revalidate) revalidatePath(path);
    return r;
  });
  return guarded ? { ok: guarded.ok, message: guarded.message, link: guarded.link, error: guarded.error } : null;
}
