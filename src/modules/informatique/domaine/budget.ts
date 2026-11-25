/**
 * LE BUDGET INFORMATIQUE — une enveloppe annuelle par société, au modèle des budgets de direction (une `BudgetEnvelope`
 * ordinaire, lue par Budgets comme toutes les autres) : trois lignes de départ, reconnues par leur CLÉ (le nom reste
 * modifiable), montants à ZÉRO — la campagne budgétaire ou le Super Admin les fixent, rien n'est simulé.
 *
 * Module PUR, sans import.
 */

export const CLE_LIGNE_IA = "IA_CONSOMMATION";
/** Le code de direction de l'enveloppe Informatique (`BudgetEnvelope.module`) — sa clé, avec la société et l'année. */
export const CODE_ENVELOPPE_INFORMATIQUE = "INFORMATIQUE";
export const CLE_LIGNE_ABONNEMENTS = "ABONNEMENTS_LICENCES";
export const CLE_LIGNE_MATERIEL = "MATERIEL_INFORMATIQUE";

export const LIGNES_INFORMATIQUE = [
  { cle: CLE_LIGNE_IA, nom: "Intelligence artificielle (consommation)" },
  { cle: CLE_LIGNE_ABONNEMENTS, nom: "Abonnements & licences" },
  { cle: CLE_LIGNE_MATERIEL, nom: "Matériel" },
] as const;

export const CLES_LIGNES_INFORMATIQUE: readonly string[] = LIGNES_INFORMATIQUE.map((l) => l.cle);

/** « Informatique 2026 ». */
export const nomEnveloppeInformatique = (annee: number): string => `Informatique ${annee}`;

/** Les lignes de départ qui manquent à une enveloppe (reconnues par clé, ou par nom pour une ligne créée à la main). */
export function lignesManquantes(existantes: readonly { name: string; cle: string | null; parentId: string | null }[]): { cle: string; nom: string; adopter?: string }[] {
  const tete = existantes.filter((c) => c.parentId === null);
  const out: { cle: string; nom: string; adopter?: string }[] = [];
  for (const l of LIGNES_INFORMATIQUE) {
    if (tete.some((c) => c.cle === l.cle)) continue;
    const memeNom = tete.find((c) => !c.cle && c.name.trim().toLowerCase() === l.nom.toLowerCase());
    out.push(memeNom ? { cle: l.cle, nom: l.nom, adopter: memeNom.name } : { cle: l.cle, nom: l.nom });
  }
  return out;
}

/**
 * L'ENVELOPPE INFORMATIQUE D'UNE SOCIÉTÉ POUR UNE DATE — parmi celles de la société qui couvrent la date et portent la
 * ligne IA : l'active d'abord, puis la plus récente. Une enveloppe désactivée exprès n'est jamais doublée (elle est choisie
 * à défaut d'une active) : c'est au Super Admin d'en ouvrir une autre.
 */
export function choisirEnveloppe<T extends { id: string; isActive: boolean; periodStart: Date }>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.periodStart.getTime() - a.periodStart.getTime())[0];
}

export interface MoisRapproche { mois: string; consomme: number; cumul: number; reste: number | null; depassement: boolean }

/**
 * LE RAPPROCHEMENT MOIS PAR MOIS — consommé du mois (DZD imputés), cumul depuis janvier, et reste de la ligne annuelle
 * (budget − cumul). Le budget n'est jamais réparti en douzièmes : ce serait un chiffre que personne n'a décidé. Une ligne
 * encore à zéro n'a pas de « reste » (`null`) : l'écran dit que le montant est à fixer.
 */
export function rapprocher(mois: readonly string[], consommeParMois: ReadonlyMap<string, number>, budget: number): MoisRapproche[] {
  let cumul = 0;
  return mois.map((m) => {
    const consomme = consommeParMois.get(m) ?? 0;
    cumul = Math.round((cumul + consomme) * 100) / 100;
    const reste = budget > 0 ? Math.round((budget - cumul) * 100) / 100 : null;
    return { mois: m, consomme, cumul, reste, depassement: reste !== null && reste < 0 };
  });
}
