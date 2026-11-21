/**
 * UN NOM DE FICHIER ABÎMÉ À L'ENVOI, RELU (recette, 21/11/2026) — « Adventum_en_TeÌ\u0082te_Word (1).docx » pour
 * « Adventum_en_Tête_Word (1).docx ».
 *
 * Entre le 30/06 et le 22/10/2026, les noms des fichiers envoyés ont été lus octet par octet (latin-1) au lieu d'UTF-8 : un
 * « ê » devenait « Ãª » (ou, écrit en deux temps par macOS, « e » + « Ì\u0082 »). 62 pièces en portent encore la trace. Ici
 * on relit, à l'AFFICHAGE, un nom qui en a la signature : uniquement des caractères d'un octet, dont une séquence qui, remise
 * en octets, est de l'UTF-8 valide. Un nom sain (accents d'origine compris) n'a jamais cette signature : il revient tel quel,
 * recomposé (NFC).
 *
 * Pur, sûr pour le navigateur.
 */
const SIGNATURE = /[Â-ô][\u0080-¿]/;

export function reparerNomDeFichier(nom: string): string {
  if (!SIGNATURE.test(nom) || /[^\u0000-ÿ]/.test(nom)) return nom.normalize("NFC");
  try {
    const relu = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(nom, (c) => c.charCodeAt(0)));
    return relu.normalize("NFC");
  } catch {
    return nom.normalize("NFC");
  }
}
