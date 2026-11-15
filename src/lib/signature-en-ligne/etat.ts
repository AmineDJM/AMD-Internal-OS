import { etatVisuels } from "./visuels";
import { etatSecondFacteur } from "./second-facteur";
import type { SignaturePrete } from "./partage";

/** Ce qui est prêt pour signer en ligne chez cette personne — serveur seulement. */
export async function etatSignatureEnLigne(userId: string): Promise<SignaturePrete> {
  const [v, f] = await Promise.all([etatVisuels(userId), etatSecondFacteur(userId)]);
  return { signature: Boolean(v.SIGNATURE), cachet: Boolean(v.CACHET), code: f.actif };
}
