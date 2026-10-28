/**
 * OUTILS DE BANC — le BC signé sur papier et la facture contrôlée (Direction, 06/10).
 *
 * Signer un BC exige désormais la copie signée et le nom du signataire (`signerBonDeCommande`) ; une demande de
 * paiement dont la facture s'écarte du BC exige l'argumentation et la confirmation. Les bancs qui éprouvent AUTRE
 * CHOSE (le circuit, les seuils, la concurrence) passent par ces deux habits, au lieu de répéter les champs partout.
 * Hors banc, Luna n'est pas configurée : la copie est enregistrée « non vérifiée », ce qui ne bloque rien.
 */

/** Une image d'un pixel — le plus petit PNG valide. */
const PNG_1PX = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export function avecCopieSignee(fd: FormData, signataire = "Directeur général"): FormData {
  if (!fd.has("signataire")) fd.set("signataire", signataire);
  if (!fd.has("copieSignee")) fd.set("copieSignee", new File([PNG_1PX], "bc-signe.png", { type: "image/png" }));
  return fd;
}
