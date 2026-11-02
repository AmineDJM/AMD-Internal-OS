import type { CompteRenduStructure, LangueDictee } from "./compte-rendu";
import type { LecturePhoto } from "./photo";

/**
 * LA CAPTATION TELLE QUE L'ÉCRAN LA MONTRE (lot J13, décision 0025) — une forme pure, partagée par le serveur qui la
 * rend et l'écran du téléphone qui l'affiche.
 */
export interface CarteTerrain {
  intentId: string;
  op: string;
  kind: "assistant_ia_op";
  title: string;
  fields: { label: string; value: string }[];
  warnings: string[];
  libelleBouton?: string;
  confirmText?: string;
  /** L'état de l'intention relu en base (une carte confirmée hier reste confirmée à l'écran). */
  statut?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
  resultat?: { message: string | null; lien: string | null };
}

export interface VueCaptation {
  id: string;
  cle: string;
  sorte: "VOCAL" | "PHOTO";
  etat: "RECU" | "PRET" | "ECHEC";
  nom: string;
  transcription: string | null;
  langue: LangueDictee | null;
  compteRendu: CompteRenduStructure | null;
  photo: LecturePhoto | null;
  cartes: CarteTerrain[];
  /** Ce qui n'a pas donné de carte, dit (« combien de boîtes ? », « médecin hors annuaire »). */
  notes: string[];
  erreur: string | null;
  msTotal: number | null;
  creeLe: string;
}
