import type { FrequenceRevue, NatureKpi, SensKpi, UniteKpi } from "./briques";
import type { Couleur } from "./score";
import type { NiveauGrille } from "./definition";

/**
 * LES FORMES QUE LES ÉCRANS REÇOIVENT — types seuls, aucun import de valeur : un composant client peut les lire
 * sans tirer la moindre ligne serveur (règle de la frontière client / serveur, CLAUDE.md).
 */

export interface ColonneKpi {
  famille: string;
  definitionId: string;
  version: number;
  nom: string;
  nature: NatureKpi;
  unite: UniteKpi;
  sens: SensKpi;
  /** Le poids le plus fréquent parmi les personnes à qui le KPI s'applique (l'en-tête l'affiche). */
  poids: number;
  cible: number | null;
  calcul: string;
  definitionBrique: string | null;
  niveauMax: number | null;
  /** Qui peut retoucher la définition (créateur ou Super Admin). */
  modifiable: boolean;
}

export interface CelluleKpi {
  definitionId: string;
  valeur: number | null;
  affichage: string;
  couleur: Couleur;
  note: number | null;
  poids: number;
  raison: string | null;
  /** ÉVALUÉ : le niveau que Luna propose, en attente du manager. */
  propositionLuna: number | null;
  /** DÉCLARÉ : des déclarations attendent la validation du manager. */
  aValider: number;
}

export interface LigneKpi {
  userId: string;
  employeeId: string | null;
  nom: string;
  poste: string | null;
  depth: number;
  cellules: Record<string, CelluleKpi>;
  score: number | null;
  sansDonnee: number;
  revue: { statut: "SIGNEE" | "BROUILLON" | "AUCUNE"; signeeLe: string | null };
  aValider: number;
}

export interface TableauKpi {
  periode: { cle: string; libelle: string; frequence: FrequenceRevue };
  periodes: { cle: string; libelle: string }[];
  frequence: FrequenceRevue;
  colonnes: ColonneKpi[];
  lignes: LigneKpi[];
  droits: { creer: boolean; signer: boolean; superAdmin: boolean };
  /** Mes propositions de KPI envoyées au Super Admin, et leur suivi. */
  propositions: { id: string; resume: string; statut: string; le: string }[];
}

export interface PreuveLuna {
  source: string;
  date: string | null;
  extrait: string;
}

export interface KpiDuBilan {
  famille: string;
  definitionId: string;
  version: number;
  nom: string;
  nature: NatureKpi;
  unite: UniteKpi;
  sens: SensKpi;
  poids: number;
  cible: number | null;
  cibleAffichee: string;
  valeur: number | null;
  affichage: string;
  couleur: Couleur;
  note: number | null;
  raison: string | null;
  calcul: string;
  definitionBrique: string | null;
  /** Les six dernières fenêtres, la plus ancienne d'abord : la note (0..120), null = sans donnée. */
  tendance: (number | null)[];
  /** « 31 visites · 53 cibles » — le résumé du numérateur et du dénominateur. */
  origine: string | null;
  drill: boolean;
  grille: NiveauGrille[] | null;
  evaluation: {
    propositionNiveau: number | null;
    preuves: PreuveLuna[];
    justification: string | null;
    niveau: number | null;
    commentaire: string | null;
  } | null;
  declarations: { id: string; libelle: string; valeur: number; statut: string; piece: string | null; le: string }[];
}

export interface BilanKpi {
  userId: string;
  nom: string;
  poste: string | null;
  periode: { cle: string; libelle: string };
  periodes: { cle: string; libelle: string }[];
  score: number | null;
  sansDonnee: number;
  figee: boolean;
  revue: { statut: "SIGNEE" | "BROUILLON" | "AUCUNE"; signeeLe: string | null; signeePar: string | null; commentaireManager: string | null; commentaireLuna: string | null };
  kpis: KpiDuBilan[];
  droits: { manager: boolean; soi: boolean };
}

export interface LigneDetail {
  date: string | null;
  libelle: string;
  etat: string | null;
  compte: boolean;
}

export interface ApercuKpi {
  colonnes: {
    nom: string; unite: UniteKpi; cibleProposee: number | null; moyenne: number | null; meilleur: number | null;
    /** Pourquoi cette cible : la lecture de Luna sur l'historique, ou la règle fixe qui s'est appliquée. Null = cible posée par la définition. */
    justification: string | null;
    /** Vrai quand la cible vient de Luna (historique de 3 à 6 mois), faux quand c'est la règle fixe. */
    parLuna: boolean;
  }[];
  /** Un mot sur la source des cibles (Luna indisponible, historique trop court…) ; null quand tout s'est passé normalement. */
  noteCibles: string | null;
  lignes: { nom: string; valeurs: { affichage: string; couleur: Couleur }[] }[];
  periodes: string[];
}
