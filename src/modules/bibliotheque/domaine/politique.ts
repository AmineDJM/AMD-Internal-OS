/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUI PEUT PARTIR À UN MODÈLE — la politique de la bibliothèque (J1). Pur.
 *
 * Deux questions distinctes, deux portes :
 *   1. La PERSONNE peut-elle ouvrir la pièce ? — la règle de l'écran qui la sert (`infra/acces.ts`).
 *   2. Le résultat part-il à un MODÈLE (`pourModele`) ? — alors s'y ajoute cette politique : une pièce
 *      CONFIDENTIELLE, ou une pièce SENSIBLE (identité, paie, RIB… reconnue par le classement local, ou
 *      annoncée par son nom), ne sort pas — même à qui a le droit de l'ouvrir à l'écran. C'est la même
 *      règle que l'Assistant IA applique à une pièce jointe (`agent/lecture/pieces.ts`, étape « coffre »).
 *
 * Et une troisième, en amont : le TEXTE d'une telle pièce n'est jamais envoyé au fournisseur
 * d'embeddings (`vectorisable`). Il est lu et indexé sur ce serveur, en plein texte seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ConfidentialiteFiche = "INTERNAL" | "RESTRICTED" | "CONFIDENTIAL";

export interface FichePolitique {
  confidentiality: ConfidentialiteFiche;
  sensible: boolean;
}

export const RAISONS_EXCLUSION_MODELE = {
  CONFIDENTIELLE: "Pièce confidentielle : elle ne part pas à un modèle d'IA.",
  SENSIBLE: "Pièce du coffre (identité, paie, coordonnées bancaires) : elle ne part pas à un modèle d'IA.",
} as const;
export type RaisonExclusionModele = keyof typeof RAISONS_EXCLUSION_MODELE;

/** Pourquoi la pièce n'est pas rendue à un modèle — `null` quand elle peut l'être. */
export function exclusionPourModele(f: FichePolitique): RaisonExclusionModele | null {
  if (f.confidentiality === "CONFIDENTIAL") return "CONFIDENTIELLE";
  if (f.sensible) return "SENSIBLE";
  return null;
}

/** Le texte de la pièce peut-il être envoyé au fournisseur d'embeddings ? Même règle qu'un modèle. */
export function vectorisable(f: FichePolitique): boolean {
  return exclusionPourModele(f) === null;
}

/** La confidentialité la plus stricte des deux (une pièce rangée à deux endroits garde la plus stricte). */
export function plusStricte(a: ConfidentialiteFiche, b: ConfidentialiteFiche): ConfidentialiteFiche {
  const ordre: ConfidentialiteFiche[] = ["INTERNAL", "RESTRICTED", "CONFIDENTIAL"];
  return ordre[Math.max(ordre.indexOf(a), ordre.indexOf(b))];
}
