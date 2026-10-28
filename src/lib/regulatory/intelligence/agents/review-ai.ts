import { trackedLuna, type CallContext } from "@/lib/regulatory/intelligence/cost/ledger";
import { lunaConfigured } from "@/lib/openai-luna";
import { askClaudeCheap } from "@/lib/ai";
import type { AiFn } from "./review-agent";

/**
 * LE MOTEUR DE LA REVUE CTD — et pourquoi il ne pouvait pas rester `askClaudeCheap`.
 *
 * La revue de fond/forme est appelée une fois par part d'environ dix pages, soit des MILLIERS de
 * fois sur un dossier complet. C'est, de très loin, le premier poste de dépense du module. Or
 * elle passait par `askClaudeCheap`, qui n'écrit rien dans `RegulatoryAiCall`. Deux conséquences
 * que personne ne pouvait voir depuis l'écran :
 *
 *   • la carte « Coût de l'analyse IA » affichait tout SAUF l'analyse — elle ne montrait que
 *     l'ingestion des réserves et la lecture des figures ;
 *   • le plafond par dossier ne plafonnait rien, puisqu'il s'appuie sur cette même table. On
 *     pouvait croire un budget tenu alors qu'il était dépassé d'un ordre de grandeur.
 *
 * En passant par `trackedLuna`, les trois mécanismes du registre s'appliquent enfin à la seule
 * étape où ils comptent vraiment : **cache** (une part inchangée d'une version à l'autre est
 * relue, pas rachetée), **plafond** (refus AVANT la dépense) et **traçabilité** au fichier près.
 *
 * Le repli sur Claude n'est pas un choix de qualité, c'est un filet : si la clé OpenAI manque,
 * mieux vaut une analyse tracée nulle part qu'aucune analyse. Il est dit à l'écran.
 */
export function lunaReviewFn(ctx: CallContext): AiFn {
  if (!lunaConfigured()) return askClaudeCheap;

  return async (prompt, opts) => {
    const res = await trackedLuna(ctx, {
      system: opts.system,
      user: prompt,
      // Le budget couvre AUSSI le raisonnement interne du modèle : 2600 jetons calibrés pour la
      // seule réponse revenaient VIDES (puis « JSON invalide » en aval). On ne paie que ce qui
      // est réellement produit — le plafond large ne coûte rien.
      maxOutputTokens: Math.max(opts.maxTokens ?? 2600, 8000),
      // JSON garanti par l'API (response_format), pas par la bonne volonté du modèle.
      jsonObject: true,
      temperature: opts.temperature ?? 0.2,
    });
    return { ok: res.ok, configured: res.configured, text: res.text, error: res.error };
  };
}
