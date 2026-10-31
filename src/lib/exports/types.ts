/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXPORTS DE L'ERP (lot K7, décision 0037) — un fichier produit sous les droits d'UNE personne.
 *
 * Chaque export d'écran (Excel du suivi Regulatory, budget, pilotage…) est une fonction `(personne, options)` qui rend
 * ce fichier, ou un refus avec le statut HTTP que la route rendait. La ROUTE (le bouton de l'écran) et l'ASSISTANT IA
 * appellent la MÊME fonction : même portée, mêmes droits, même audit — l'un ne peut pas sortir ce que l'autre cache.
 *
 * Module PUR (aucun import) : la forme du résultat, partagée par les routes, le catalogue et l'assistant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MIME_CSV = "text/csv; charset=utf-8";
export const MIME_PDF = "application/pdf";
export const MIME_PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export interface FichierExporte {
  octets: Uint8Array;
  nomDeFichier: string;
  mime: string;
  /** Ce que contient le fichier, en une phrase (« 42 dossier(s) réglementaire(s) ») — dit par l'assistant. */
  resume: string;
}

/** Les statuts que rendaient les routes : non autorisé, introuvable, illisible, trop gros, mal demandé. */
export type StatutRefus = 400 | 401 | 403 | 404 | 409 | 413;

export type ResultatExport = { ok: true; fichier: FichierExporte } | { ok: false; statut: StatutRefus; erreur: string };

export const refusExport = (statut: StatutRefus, erreur: string): ResultatExport => ({ ok: false, statut, erreur });

export const exporte = (octets: Uint8Array | ArrayBuffer | string, nomDeFichier: string, mime: string, resume: string): ResultatExport => ({
  ok: true,
  fichier: {
    octets: typeof octets === "string" ? new TextEncoder().encode(octets) : octets instanceof Uint8Array ? octets : new Uint8Array(octets),
    nomDeFichier,
    mime,
    resume,
  },
});

/** Un nom de fichier sans caractère interdit par un système de fichiers (le Drive, un poste Windows). */
export const nomDeFichierSur = (t: string, repli = "export"): string =>
  t.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || repli;
