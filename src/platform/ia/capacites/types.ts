import type { FamilleIa } from "./familles";

/**
 * LES TYPES DU REGISTRE DES CAPACITÉS (lot J6, décision 0020) — purs, zéro import hors du dossier.
 *
 * `ContratLu` est la forme STRUCTURELLE d'un contrat d'action (`lib/actions/contrat/types.ts`, `ContratAction`) :
 * le socle ne l'importe pas (son plafond d'imports vers l'ERP, `SOCLE_IA_CEILING`, ne se relève pas) ; le module qui
 * lit `contrat.genere.json` le lui passe, et le compilateur vérifie que les deux formes se recouvrent.
 */

export type TypeChampLu = "texte" | "nombre" | "date" | "booleen" | "liste" | "reference";

export interface ChampLu {
  nom: string;
  type: TypeChampLu;
  obligatoire: boolean;
  valeurs: readonly string[] | null;
  modele: string | null;
}

export interface ContratLu {
  id: string;
  fichier: string;
  fonction: string;
  appel: string;
  champs: readonly ChampLu[];
  porte: { module: string | null; verbe: string | null; entite: string | null; gardes: readonly string[]; moduleFr: string | null };
  ecrit: boolean;
  modelesEcrits: readonly string[];
  audit: boolean;
  illisible: string | null;
}

/**
 * LE NIVEAU DE RISQUE — ce qui décide du chemin d'un appel :
 *   R0 lecture (exécutée directement) ; R1 écriture interne réversible ; R2 écriture interne qui prévient quelqu'un ;
 *   R3 effet EXTERNE (courrier, publication, diffusion) ; R4 argent, droits, signature ou décision, suppression.
 * R1 et R2 passent par la carte de confirmation ; R3 et R4 par la carte RENFORCÉE (ressaisie).
 */
export const RISQUES = ["R0", "R1", "R2", "R3", "R4"] as const;
export type Risque = (typeof RISQUES)[number];

/** Préparé pour J7 (simulation dans une transaction annulée) : « oui », « non » (effet hors base), « inconnu ». */
export const SIMULABLES = ["oui", "non", "inconnu"] as const;
export type Simulable = (typeof SIMULABLES)[number];

/** Comment un geste se défait — la table de `lib/annulation/reversibilite.ts`, en quatre mots. */
export const ANNULATIONS = ["retour", "compensation", "delegation", "aucune"] as const;
export type Annulation = (typeof ANNULATIONS)[number];

export type SourceCapacite = "action" | "outil" | "atelier";

/** La nature d'un geste, dans le vocabulaire de `lib/annulation/reversibilite.ts` (`NatureGeste`). */
export type NatureGesteLue =
  | "CHAMP_MODIFIE" | "ENREGISTREMENT_CREE" | "ENREGISTREMENT_SUPPRIME" | "MESSAGE_ENVOYE" | "DOCUMENT_MODIFIE"
  | "FICHIER_DEPLACE" | "REGLE_ENSEIGNEE" | "PAIEMENT_EXECUTE" | "SIGNATURE_DEMANDEE" | "DEPOT_AUTORITE";

/** Ce que rend `classerGeste` (même module) — l'injection garde le socle sans import vers l'ERP. */
export interface VerdictLu {
  reversibilite: "REVERSIBLE" | "DELEGUEE" | "PAR_COMPENSATION" | "IRREVERSIBLE";
  raison: string;
}

/** Ce que le registre reçoit de l'ERP — des fonctions, jamais un import (le port du socle). */
export interface PortsRegistre<C extends ContratLu = ContratLu> {
  /** `lib/actions/generique.ts` — le refus d'auto-escalade et des surfaces humaines (`null` : permise). */
  interdiction: (c: C) => string | null;
  /** `lib/annulation/reversibilite.ts` — `classerGeste`. */
  classerGeste: (nature: NatureGesteLue) => VerdictLu;
  /** Les modules RBAC et leur libellé (`MODULE_LABELS`) — pour lire la porte d'une action qui ne la nomme pas. */
  modules: Readonly<Record<string, string>>;
}

/** Un outil existant de l'Assistant IA, décrit par le module (le socle ne l'importe pas). */
export interface OutilDecrit {
  nom: string;
  libelle: string;
  description: string;
  /** Prépare une carte (geste) — sinon une lecture. */
  ecriture: boolean;
  /** Les familles qu'il exige (celles de la table du module). */
  familles: readonly FamilleIa[];
}

/** LA FICHE D'UNE CAPACITÉ — ce que le registre sait d'un geste de l'ERP. */
export interface Capacite {
  /** `fichier:fonction` (une action), `outil:<nom>`, `atelier:<geste>`. */
  id: string;
  source: SourceCapacite;
  /** Le nom de l'outil vu par le modèle (une action : `fichier__fonction`, sans `-actions`). */
  outil: string;
  libelle: string;
  description: string;
  risque: Risque;
  /** POURQUOI ce niveau — la règle qui l'a donné, en une phrase. */
  raisonRisque: string;
  /** Les familles de la console qu'exige l'exécution (« Écritures métier » comprise pour un geste). */
  familles: FamilleIa[];
  simulable: Simulable;
  annulation: Annulation;
  raisonAnnulation: string;
  /** Sa sortie peut porter un contenu écrit par un tiers (courrier, document, pièce) : encadrée avant le modèle. */
  contenuTiers: boolean;
  /** Appelable par l'appel générique ? Une action `illisible` ou refusée ne l'est JAMAIS. */
  appelable: boolean;
  /** Pourquoi elle ne l'est pas (`null` si elle l'est). */
  refus: string | null;
  /** La porte d'écran : les modules RBAC dont l'un doit être ouvert (vide : Super Admin seul). */
  modules: string[];
  /** Le verbe RBAC lu (`CREATE`, `UPDATE`…), `null` : la vue du module suffit à la proposer. */
  verbe: string | null;
  /** Réservée au Super Admin (garde `requireAdmin`, `requireChief`, porte illisible). */
  superAdminSeul: boolean;
  /** Les champs offerts au modèle (les fichiers binaires en sont retirés). */
  champs: ChampLu[];
  /** Les mots de la recherche (libellé, module, synonymes) — jamais envoyés au modèle. */
  mots: string;
  /** Les mots de CONTEXTE, plus faibles (le fichier, les champs) : ils départagent, ils ne désignent pas. */
  contexte: string;
  /** Le geste qui l'exécute quand ce n'est pas elle-même (une commande de l'Atelier → `modifier_document`). */
  executeePar: string | null;
}
