import { DECLARATIONS_COMMUNICATIONS } from "./declarations/communications";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ANNULATIONS DÉCLARÉES (lot K10, décision 0040) — « toute action peut être réversible ».
 *
 * Le registre DÉRIVE l'annulation d'une action de sa nature (`reversibilite.ts`) : un courriel → « aucune ». Quand
 * l'ERP a été MODIFIÉ pour qu'une action se défasse (fenêtre d'annulation des envois, corbeille, compensation métier),
 * sa ligne ici le dit, avec le mécanisme et la raison — et `registre.ts` la classe ainsi. Une déclaration n'est pas
 * une promesse : chaque ligne a son test qui EXÉCUTE l'action puis l'ANNULE contre la base (le cliquet de chaque
 * périmètre vérifie qu'aucune action écrivante de son périmètre ne reste « aucune »).
 *
 * Une table PAR PÉRIMÈTRE (K10a argent, K10b communications, K10c le reste), fusionnées ici : pas de conflit d'édition.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type MecanismeAnnulation =
  /** Le journal des effets J7 (`gesteReversible`) : valeurs d'avant réécrites, créations retirées ou passées à ANNULÉ. */
  | "journal"
  /** Le journal ET la fenêtre d'annulation des effets sortants (`differerEffetSortant`) : rien ne part avant elle. */
  | "fenetre"
  /** Une compensation métier tracée (avoir, contre-passation, réouverture d'étape) codée pour cette action. */
  | "compensation-metier"
  /** Rien n'est écrit qui demande d'être défait (texte proposé, lecture déguisée) — la raison le dit. */
  | "sans-effet";

export interface DeclarationAnnulation {
  annulation: "retour" | "compensation" | "delegation";
  mecanisme: MecanismeAnnulation;
  /** Ce que l'annulation fait, et ce qu'elle ne peut pas faire — la phrase montrée sur la fiche de la capacité. */
  raison: string;
}

export const ANNULATIONS_DECLAREES: Readonly<Record<string, DeclarationAnnulation>> = {
  ...DECLARATIONS_COMMUNICATIONS,
};

/** Le port du registre (`PortsRegistre.annulationDeclaree`). */
export function annulationDeclaree(c: { id: string }): { annulation: DeclarationAnnulation["annulation"]; raison: string } | null {
  const d = ANNULATIONS_DECLAREES[c.id];
  return d ? { annulation: d.annulation, raison: d.raison } : null;
}
