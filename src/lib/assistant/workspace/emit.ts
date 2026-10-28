/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'UNE LECTURE DÉCLARE MONTRER — écrit une fois, réutilisé partout.
 *
 * Chaque outil canonique qui veut un bloc riche pourrait l'écrire à la main dans son `_blocs`.
 * Après trois outils, les formes divergeraient : ici « en retard », là « retard », ailleurs un
 * badge oublié. Ces fabriques imposent la MÊME forme à tout le monde, et rendent la déclaration
 * courte au point qu'on n'a plus de raison de la contourner.
 *
 * ── ELLES NE LISENT RIEN ─────────────────────────────────────────────────────────────────
 *
 * Aucun import ERP, aucune base, aucun droit. On reçoit des valeurs déjà lues et autorisées par
 * l'outil appelant, et on les met en forme. La porte reste devant la donnée, pas ici.
 *
 * ── LA PHRASE, PAS L'ORDRE ───────────────────────────────────────────────────────────────
 *
 * Une action porte une PHRASE que le clic écrira dans la conversation. Elle est composée ici,
 * côté serveur, avec la référence exacte — jamais par le modèle, jamais par le navigateur. Le
 * geste emprunte donc le chemin normal : proposition, carte de confirmation, action canonique.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EmitTon = "neutre" | "attention" | "alerte" | "succes";

export interface EmitAction {
  libelle: string;
  phrase: string;
  ton?: "primaire" | "danger";
}

/** Un geste sûr : libellé court, phrase explicite. Les deux sont obligatoires. */
export const geste = (libelle: string, phrase: string, ton?: "primaire" | "danger"): EmitAction =>
  ton ? { libelle, phrase, ton } : { libelle, phrase };

/**
 * LE RETARD EN JOURS — et pourquoi il est calculé ici plutôt qu'affiché brut.
 *
 * « échéance 22/08/2025 » demande au lecteur de faire la soustraction ; « 4 jours » la lui
 * donne. C'est la même information, mais une seule des deux se lit en passant.
 */
export function retardJours(cible: Date | string | null | undefined, now = new Date()): number | null {
  if (!cible) return null;
  const d = cible instanceof Date ? cible : new Date(cible);
  if (Number.isNaN(d.getTime())) return null;
  const jours = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  return jours > 0 ? jours : null;
}

/** « 4 jours », « 1 jour » — l'accord se fait ici, pas dans dix appelants. */
export const retardLabel = (jours: number): string => `${jours} jour${jours > 1 ? "s" : ""}`;

/**
 * TROIS CHIFFRES POUR UNE PERSONNE.
 *
 * Ce qui est REFUSÉ ici a autant d'importance que ce qui est rendu : le « taux à jour » n'est
 * calculé que s'il y a des dossiers. Sur un portefeuille vide, « 100 % à jour » serait vrai et
 * trompeur — il n'y a rien à tenir à jour.
 */
export function chargeMetriques(total: number, enRetard: number): { valeur: string; label: string; ton?: EmitTon }[] {
  if (total === 0) return [];
  const aJour = Math.round(((total - enRetard) / total) * 100);
  return [
    { valeur: String(total), label: "Dossiers assignés" },
    { valeur: String(enRetard), label: "En retard", ...(enRetard > 0 ? { ton: "alerte" as const } : { ton: "succes" as const }) },
    { valeur: `${aJour} %`, label: "Dans les délais", ton: aJour >= 90 ? "succes" : aJour >= 70 ? "attention" : "alerte" },
  ];
}
