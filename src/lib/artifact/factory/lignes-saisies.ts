import type { DemandeDocument } from "@/platform/ia/artifact/factory";

/**
 * LA SAISIE DES LIGNES D'UNE PIÈCE, CONVERTIE CÔTÉ SERVEUR — une seule conversion pour la composition, la révision
 * depuis la fiche Legal (§118.194) et la modification d'un bon de commande depuis son poste Ad & Pro (Direction,
 * 06/10) : deux lecteurs de la même saisie finiraient par arrondir ou couper différemment. L'écran l'écrit par
 * `ajouterLignes` (`components/legal/lignes-editables.tsx`).
 *
 * Les CHAMPS (`formData.getAll("ligneDesignation")`…) se lisent dans l'action elle-même : la dérivation des contrats
 * ne suit pas un import (§118.87c) — lus ici, ils disparaîtraient de ce que l'action déclare recevoir.
 */

/** « 2 500 000,00 » (espaces, insécables, virgule) → 2500000 ; vide ou illisible → null. */
export function nombreSaisi(v: string | null | undefined): number | null {
  const s = (v ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Un pourcentage saisi (« 19 », « 2,5 ») → une fraction (0,19) ; vide → null. */
export const fractionSaisie = (v: string | null | undefined): number | null => {
  const n = nombreSaisi(v);
  return n === null ? null : n / 100;
};

export interface ListesDeLignes {
  designations: string[]; details: string[]; quantites: string[]; prix: string[]; remises: string[]; tvas: string[]; sections: string[];
  /** L'unité de chaque ligne (« u », « boîte ») — absente des formulaires qui ne la saisissent pas. */
  unites?: string[];
}

/** Les lignes : des listes parallèles, une entrée par ligne saisie, dans l'ordre de l'écran. */
export function lignesDepuisListes(l: ListesDeLignes): DemandeDocument["lignes"] {
  return l.designations.map((designation, i) => {
    const section = l.sections[i] === "1" || l.sections[i] === "true";
    return {
      designation: designation.trim(),
      section,
      details: (l.details[i] ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      // Une ligne chiffrée dont la quantité ou le prix est illisible arrive à NaN : la fabrique la
      // REFUSE en nommant la ligne, au lieu qu'un zéro silencieux fasse une pièce fausse.
      quantite: section ? 0 : (nombreSaisi(l.quantites[i]) ?? Number.NaN),
      prixUnitaire: section ? 0 : (nombreSaisi(l.prix[i]) ?? Number.NaN),
      remise: fractionSaisie(l.remises[i]),
      tva: fractionSaisie(l.tvas[i]),
      ...(l.unites ? { unite: section ? null : (l.unites[i] ?? "").trim() || null } : {}),
    };
  });
}
