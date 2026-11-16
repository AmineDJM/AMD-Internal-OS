import { deadlineLabel, isOverdue, sortByPriority } from "./payment-request";
import { deadlineNatureLabel, deadlineNatureOf } from "./deadline-nature";
import { isCompanionDossier } from "./dossier-auto";
import type { CleDeTri } from "./mes-demandes-ordre";

/**
 * UNE LIGNE DE « MES DEMANDES » — ce que la liste triable affiche et trie, calculé côté serveur une fois (Direction,
 * 10/11/2026). Les textes (échéance, nature) y sont déjà écrits : la liste, côté navigateur, ne fait que trier et ranger.
 */
export interface LigneMaDemande extends CleDeTri {
  reference: string;
  titre: string;
  beneficiaire: string;
  echeance: string;
  enRetard: boolean;
  /** La nature de l'échéance (« Date ferme »…), quand il y a une date. */
  nature: string | null;
  natureFixe: boolean;
  /** Le dossier accompagne un ordre né d'un autre circuit. */
  compagnon: boolean;
}

interface DemandeLue {
  id: string; reference: string; title: string; payee: string; amount: unknown; status: string;
  dueDate: Date | string | null; urgency: string; deadlineNature?: string | null; origin?: string | null;
  createdAt: Date | string; rangDemandeur?: number | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Les demandes lues → les lignes de la liste, avec leur place dans le tri par échéance. Pur. */
export function lignesMesDemandes(demandes: readonly DemandeLue[], libellesUrgence: Record<string, string>): LigneMaDemande[] {
  const rangEcheance = new Map(sortByPriority(demandes).map((d, i) => [d.id, i]));
  return demandes.map((d) => ({
    id: d.id,
    creeLe: iso(d.createdAt),
    montant: Number(d.amount ?? 0) || 0,
    statut: d.status,
    rangEcheance: rangEcheance.get(d.id) ?? 0,
    rang: d.rangDemandeur ?? null,
    reference: d.reference,
    titre: d.title,
    beneficiaire: d.payee,
    echeance: deadlineLabel(d, libellesUrgence),
    enRetard: isOverdue(d),
    nature: d.dueDate ? deadlineNatureLabel(d.deadlineNature) : null,
    natureFixe: deadlineNatureOf(d.deadlineNature) === "FIXED",
    compagnon: isCompanionDossier(d.origin),
  }));
}
