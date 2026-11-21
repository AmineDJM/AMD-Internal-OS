import { prisma } from "@/lib/prisma";
import { etatVisuels } from "./visuels";
import { etatSecondFacteur } from "./second-facteur";
import { enSuppleance } from "./suppleance";
import type { SignaturePrete } from "./partage";

/** Ce qui est prêt pour signer en ligne chez cette personne — serveur seulement. */
export async function etatSignatureEnLigne(userId: string): Promise<SignaturePrete> {
  const [v, f, u] = await Promise.all([
    etatVisuels(userId), etatSecondFacteur(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true, secondaryRole: true } }),
  ]);
  return {
    signature: Boolean(v.SIGNATURE), cachet: Boolean(v.CACHET), code: f.actif,
    // LA SUPPLÉANCE DU SUPER ADMIN (21/11/2026) : le formulaire la dit AVANT la signature.
    suppleance: { DIRECTION_MARKETING: enSuppleance("DIRECTION_MARKETING", u), FINANCES: enSuppleance("FINANCES", u) },
  };
}
