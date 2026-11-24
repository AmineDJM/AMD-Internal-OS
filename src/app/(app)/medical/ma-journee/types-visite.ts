import type { EtatVisite } from "@/lib/sfe/tournee";
import type { Lettre } from "@/lib/segmentation/regles";
import type { LectureDuCompteRendu } from "@/lib/sfe/compte-rendu-envoye";
import type { RemisesInitiales } from "./materiel-remis";
import type { BesoinVue, PotentielVue } from "./formulaire-rapport";

/**
 * LES FORMES QUE « MA JOURNÉE » ET LA GRILLE DU PLAN PARTAGENT — une visite de l'emploi du temps, la gamme du
 * délégué, le praticien d'une visite hors plan. Types seulement : aucun code ne vit ici.
 */

export interface LigneVue {
  id: string;
  date: string;
  doctorId?: string | null;
  doctorName: string;
  institution: string | null;
  wilaya: string | null;
  specialty: string | null;
  etat: EtatVisite;
  origine: string;
  objectif: string | null;
  rapport: string | null;
  produits: string[];
  messages: string[];
  produitIds: string[];
  messageIds: string[];
  suite: string | null;
  remises: RemisesInitiales;
  heuresRestantes: number;
  vocal: boolean;
  /** Pourquoi elle n'a pas eu lieu, quand elle est dite reportée ou annulée (§118.193). */
  motifNonTenue: string | null;
  /** Le potentiel à mettre à jour, quand le praticien est dans le panel d'une stratégie de segmentation. */
  potentiel: PotentielVue | null;
  /** Le besoin annuel du service, quand le praticien est décideur d'une stratégie de sa BU (Marketing cockpit · terrain). */
  besoin?: BesoinVue | null;
  /** « Objections du médecin », telles que saisies (`doctorFeedback`). */
  objections?: string | null;
  /** L'après-envoi : la lecture par l'IA, le cas déclaré, « ce n'est pas un cas », la relecture (« Ma journée »). */
  lecture?: LectureDuCompteRendu;
}

/** La gamme du délégué qui rapporte : ses produits, ses messages — ce que le formulaire de rapport propose. */
export interface GammeVue {
  produits: { productId: string; name: string }[];
  produitsIncomplets: string[];
  messages: { id: string; title: string; body: string | null; buName: string | null }[];
  sansBu: boolean;
}

/** Le geste suivi de l'écran hôte : appelle l'action, montre l'erreur, rafraîchit (`useRafraichir`). Vrai si réussi. */
export type Executer = (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => Promise<boolean>;

/** Un praticien vu HORS PLAN — ce que la feuille montre en tête. */
export interface PraticienVisite {
  id: string;
  name: string;
  specialty: string | null;
  institution: string | null;
  wilaya: string | null;
  lettre?: Lettre | null;
}

/** Ce que la feuille de visite ouvre : le rapport d'une visite planifiée, ou une visite hors plan. */
export type OuvertureVisite =
  | { sorte: "PLANIFIEE"; ligne: LigneVue }
  | { sorte: "HORS_PLAN"; praticien: PraticienVisite };

/** « La dernière fois » — lu des visites déjà rapportées (`queries/journee-delegue.ts`). */
export interface DerniereVisiteVue {
  visitId: string;
  doctorId: string;
  date: string;
  produits: string[];
  messages: string[];
  materiel: string[];
  suite: string | null;
}

/** Ce que la feuille sait EN PLUS du praticien quand l'écran hôte l'a lu (« Ma journée » ; pas la grille du plan). */
export interface ContexteVisite {
  lettre?: Lettre | null;
  /** « n / m visites ce mois » — le requis de la segmentation, le même que la tournée proposée. */
  frequence?: { faites: number; attendues: number } | null;
  /** Les deux dernières visites rapportées : la feuille écarte celle qu'elle corrige. */
  dernieres?: DerniereVisiteVue[];
}
