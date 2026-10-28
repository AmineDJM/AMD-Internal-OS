import { natureApercu, TAILLE_MAX_TEXTE_OCTETS } from "@/lib/formats/apercu";

/** Ce fichier est-il un texte qu'on peut éditer ici ? (la nature vient de la table unique des aperçus) */
export const estUnTexteEditable = (nom: string, mime?: string | null): boolean => natureApercu(nom, mime) === "texte";

/** Les octets d'un fichier → le texte à afficher, tronqué au-delà de la limite (un journal de 50 Mo ne s'édite pas ici). */
export function lireTexte(octets: Buffer): { texte: string; tronque: boolean } {
  const tronque = octets.length > TAILLE_MAX_TEXTE_OCTETS;
  const utile = tronque ? octets.subarray(0, TAILLE_MAX_TEXTE_OCTETS) : octets;
  return { texte: new TextDecoder("utf-8", { fatal: false }).decode(utile), tronque };
}

/**
 * LE TEXTE À ENREGISTRER, vérifié. Refus nommés : un fichier tronqué à l'affichage ne se réécrit JAMAIS (on
 * écraserait la fin du fichier qu'on n'a pas montrée), et un texte plus gros que la limite est refusé.
 */
export function texteAEnregistrer(brut: unknown, fichierTronque: boolean): { ok: true; octets: Buffer } | { ok: false; error: string } {
  if (fichierTronque) {
    return { ok: false, error: "Ce fichier dépasse 1 Mo : il s'affiche tronqué et ne se modifie pas d'ici (enregistrer écraserait la fin du fichier). Téléchargez-le pour le modifier." };
  }
  if (typeof brut !== "string") return { ok: false, error: "Texte manquant." };
  const octets = Buffer.from(brut, "utf8");
  if (octets.length > TAILLE_MAX_TEXTE_OCTETS) {
    return { ok: false, error: "Le texte dépasse 1 Mo : il ne s'enregistre pas d'ici." };
  }
  return { ok: true, octets };
}
