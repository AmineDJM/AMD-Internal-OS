/**
 * LES PRATICIENS — le modèle de l'écran : la ligne, la règle affichée, les droits, les libellés des
 * colonnes et des filtres, l'application d'une saisie locale et le passage à la ligne triable.
 */
import { STATUT_LABELS, affiniteAffichee, type Comparaison, type Lettre, type MethodeAffinite, type Statut } from "@/lib/segmentation/regles";
import { lettreProvisoire } from "@/lib/segmentation/charge";
import { casseNom, FILTRES_LISTE, FILTRES_TEXTE, FILTRES_PLAGE, type Colonne, type LigneTri, type FiltreListe, type FiltreTexte, type FiltrePlage, type CleFiltre } from "@/lib/segmentation/tableau-praticiens";

export interface LignePraticien {
  doctorId: string;
  secteurId: string | null;
  secteurNom: string | null;
  secteurPose: boolean;
  /** L'établissement RATTACHÉ ; null avec un `etablissement` = texte « à rattacher ». */
  institutionId: string | null;
  etablissement: string | null;
  /** Seulement quand le praticien a un secteur (wilaya de la ville pivot) ; sinon rien. */
  inOut: "IN" | "OUT" | null;
  specialiteId: string | null;
  specialite: string | null;
  nomFamille: string;
  prenom: string | null;
  /** Le grade de la liste (enum) et son libellé ; `gradeBrut` = le grade hors liste du fichier (« KOL »). */
  titre: string;
  grade: string;
  gradeBrut: string | null;
  statut: Statut | null;
  q1: number | null;
  q2: number | null;
  /** null = aucune règle publiée. */
  lettre: Lettre | null;
  lettreCalculee: Lettre | null;
  forcee: { valeur: Lettre; motif: string } | null;
  pourquoi: string[];
}

/** Ce qu'il faut pour recalculer une lettre à l'écran, le temps que le serveur rende la sienne. */
export interface RegleEcran {
  hStatuts: Statut[];
  seuilPotentiel: number;
  seuilAffinite: number;
  comparaison: Comparaison;
  potentielNulNonCible: boolean;
  potentielNulNA: boolean;
  methode: MethodeAffinite;
  /** Seuil d'affinité propre à un secteur. */
  seuilParSecteur: Record<string, number>;
}

export interface Droits { saisir: boolean; panel: boolean; valider: boolean; forcer: boolean }
export interface DroitsAnnuaire { modifier: boolean; supprimer: boolean }
export interface Choix { valeur: string; libelle: string; detail?: string }
export type Local = Partial<Omit<LignePraticien, "doctorId" | "pourquoi">>;
export type EtatCellule = "envoi" | "erreur";
/** Après validation : où va le curseur — « ici » = reste sur la cellule ; null = nulle part (la personne a cliqué ailleurs). */
export type Deplacement = "bas" | "haut" | "droite" | "gauche" | "ici" | null;
export type Resultat = { ok: boolean; error?: string };

export const champ = "rounded-lg border border-border bg-background px-2.5 py-2 text-sm sm:py-1.5";
export const LIBELLES: Record<Colonne, string> = {
  secteur: "Secteur", cdr: "CDR", specialite: "Spécialité", nom: "Nom", prenom: "Prénom", grade: "Grade", statut: "Statut",
  q1: "Q1", q2: "Q2", pct: "%", potentiel: "Potentiel",
};
export const FILTRE_DE: Partial<Record<Colonne, CleFiltre>> = {
  secteur: "secteur", cdr: "cdr", specialite: "specialite", nom: "nom", prenom: "prenom", grade: "grade", statut: "statut",
  q1: "q1", q2: "q2", pct: "pct", potentiel: "potentiel",
};
export const estListe = (f: CleFiltre): f is FiltreListe => (FILTRES_LISTE as readonly string[]).includes(f);
export const estTexte = (f: CleFiltre): f is FiltreTexte => (FILTRES_TEXTE as readonly string[]).includes(f);
export const estPlage = (f: CleFiltre): f is FiltrePlage => (FILTRES_PLAGE as readonly string[]).includes(f);
export const COLS_TEXTE: readonly Colonne[] = ["nom", "prenom", "q1", "q2"];

export const fmt = (n: number | null) => (n === null ? "" : String(n).replace(".", ","));
export const libelleLettre = (l: Lettre | null) => (l === null ? "—" : l === "NC" ? "non ciblé" : l);
export const plie = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const gradeAffiche = (v: LignePraticien) => (v.titre === "AUTRE" && v.gradeBrut ? v.gradeBrut : v.grade);

/** La ligne effective : celle du serveur, plus ce que la personne vient d'écrire (la lettre se recalcule à l'écran). */
export function appliquer(l: LignePraticien, o: Local | undefined, regle: RegleEcran | null): LignePraticien {
  if (!o) return l;
  const v: LignePraticien = { ...l, ...o };
  if (regle && ("statut" in o || "q1" in o || "q2" in o || "secteurId" in o)) {
    const calc = lettreProvisoire({
      statut: v.statut, q1: v.q1, q2: v.q2, hStatuts: regle.hStatuts, seuilPotentiel: regle.seuilPotentiel, comparaison: regle.comparaison,
      seuilAffinite: (v.secteurId ? regle.seuilParSecteur[v.secteurId] : undefined) ?? regle.seuilAffinite, potentielNulNonCible: regle.potentielNulNonCible,
      methode: regle.methode, potentielNulNA: regle.potentielNulNA,
    });
    v.lettreCalculee = calc;
    if (!v.forcee) v.lettre = calc;
  }
  return v;
}

export function versTri(v: LignePraticien, methode: MethodeAffinite): LigneTri {
  const spe = casseNom(v.specialite);
  return {
    secteur: v.secteurId ?? "", secteurLib: v.secteurNom ?? "",
    cdr: v.institutionId ?? (v.etablissement ? `t:${v.etablissement}` : ""), cdrLib: v.etablissement ?? "",
    io: v.secteurId && v.inOut ? v.inOut : "",
    specialite: v.specialiteId ?? (spe ? `t:${spe}` : ""), specialiteLib: spe,
    nom: v.nomFamille, prenom: v.prenom ?? "",
    grade: v.titre === "AUTRE" && v.gradeBrut ? `brut:${v.gradeBrut}` : v.titre, gradeLib: gradeAffiche(v),
    statut: v.statut ?? "",
    q1: v.q1, q2: v.q2, pct: affiniteAffichee(v.q1, v.q2, methode),
    potentiel: v.lettre ?? "",
  };
}

/** Le libellé d'une valeur de filtre, lu sur une ligne qui la porte. */
export function libelleFiltre(f: FiltreListe, t: LigneTri): string {
  switch (f) {
    case "secteur": return t.secteurLib || "Sans secteur";
    case "cdr": return t.cdrLib || "Sans établissement";
    case "io": return t.io === "IN" ? "In" : t.io === "OUT" ? "Out" : "Non déterminé";
    case "specialite": return t.specialiteLib || "Sans spécialité";
    case "grade": return t.gradeLib || "—";
    case "statut": return t.statut ? STATUT_LABELS[t.statut as Statut] ?? t.statut : "Sans statut";
    case "potentiel": return t.potentiel ? (t.potentiel === "NC" ? "Non ciblé" : t.potentiel) : "Sans lettre";
  }
}

/** Plusieurs appels à la suite, quatre à la fois — un geste en lot ne sature pas le serveur. */
export async function enLot<T>(ids: string[], f: (id: string) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 4) out.push(...(await Promise.all(ids.slice(i, i + 4).map(f))));
  return out;
}
