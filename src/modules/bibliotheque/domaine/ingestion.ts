import type { Format } from "./format";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES DE L'INGESTION — quoi lire, comment, et que faire d'un échec (J1). Pur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * La version des règles d'ingestion (lecteurs, découpage). La monter fait relire les pièces déjà lues,
 * par le rattrapage, jamais en silence : une fiche dont `versionIngestion` est inférieure se remet en file.
 */
export const VERSION_INGESTION = 1;

/** Au-delà, la pièce n'est pas chargée en mémoire pour être lue (un serveur de 512 Mo) : elle est IGNORÉE, et c'est dit. */
export const OCTETS_MAX_LECTURE = 40 * 1024 * 1024;
/** La limite du service de transcription (Whisper : 25 Mo). */
export const OCTETS_MAX_TRANSCRIPTION = 25 * 1024 * 1024;
/** Pages lues au plus (OCR compris) — au-delà, la fin du document n'est pas indexée, et la fiche le dit. */
export const PAGES_MAX = 200;
/** Essais avant l'échec définitif (une pièce en ÉCHEC se relance à la main ou par une nouvelle version). */
export const TENTATIVES_MAX = 6;
/** Une ligne EN_COURS plus vieille que ceci appartient à un processus mort : elle se reprend. */
export const VERROU_PERIME_MS = 10 * 60_000;

export type Lecture = "lecteur" | "transcription";

/** Comment lire une pièce de ce format — `null` : rien à lire (archive, format inconnu). */
export function lectureDe(format: Format): Lecture | null {
  switch (format) {
    case "pdf": case "traitement-texte": case "tableur": case "presentation": case "texte": case "image":
      return "lecteur";
    case "audio": case "video":
      return "transcription";
    default:
      return null;
  }
}

/** Pourquoi la pièce n'est pas lue (raison DURABLE : la fiche passe IGNORÉE) — `null` quand elle se lit. */
export function raisonDIgnorer(format: Format, taille: number | null | undefined): string | null {
  const l = lectureDe(format);
  if (!l) return `format « ${format} » : aucun texte à lire`;
  const t = Number(taille ?? 0);
  if (l === "transcription" && t > OCTETS_MAX_TRANSCRIPTION) return `enregistrement de ${Math.round(t / 1048576)} Mo : au-delà de 25 Mo, pas de transcription`;
  if (t > OCTETS_MAX_LECTURE) return `fichier de ${Math.round(t / 1048576)} Mo : au-delà de 40 Mo, il n'est pas lu`;
  return null;
}

/** Le prochain essai après un échec : 1 min, 4 min, 16 min, 1 h 04, 4 h 16, plafonné à 6 h. */
export function prochainEssai(tentatives: number, maintenant: number = Date.now()): Date {
  const minutes = Math.min(360, 4 ** Math.max(0, tentatives - 1));
  return new Date(maintenant + minutes * 60_000);
}

/** L'issue d'un échec : on retente, ou on s'arrête (ÉCHEC) après `TENTATIVES_MAX`. */
export function issueApresEchec(tentatives: number): "A_FAIRE" | "ECHEC" {
  return tentatives >= TENTATIVES_MAX ? "ECHEC" : "A_FAIRE";
}

/** Un message d'erreur rangé en base : une ligne, borné, sans pile. */
export function messageErreur(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? "erreur");
  return m.replace(/\s+/g, " ").trim().slice(0, 300) || "erreur";
}
