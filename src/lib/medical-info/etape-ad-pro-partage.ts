/**
 * L'ÉTAPE « Déclaration (information scientifique) » d'une demande Ad & Pro — ce que l'écran en reçoit (08/11/2026).
 *
 * Module PUR, sans base ni session : la carte du pharmacien est un composant CLIENT, et elle ne doit tirer vers le
 * navigateur que ces formes et ce titre. Le chargeur (`etape-ad-pro.ts`, serveur) les réexporte.
 */

import type { DeclareInput } from "./declare-decision";

export const TITRE_ETAPE_DECLARATION = "Déclaration (information scientifique)";

/**
 * LES DÉCLARATIONS PARTAGÉES AVEC LA DEMANDE (Direction, 09/11/2026 : « ajouter l'option télécharger pour les déclarations,
 * dans le cas où les KAM en auraient besoin ») — les fichiers que le pharmacien dépose depuis la carte de l'étape portent
 * cette marque (`Document.stepKey`) : ils se téléchargent par qui ouvre la demande Ad & Pro. Les autres pièces du dossier
 * d'information médicale restent au pharmacien.
 */
export const ETAPE_DECLARATION_PARTAGEE = "declaration";

export interface PieceDeDeclaration {
  id: string; nom: string; le: string; par: string | null;
  /** Déposée comme déclaration (depuis la carte) : téléchargeable par qui ouvre la demande. */
  partagee: boolean;
}

export interface EtapeDeclaration {
  titre: string;
  /** Pour la frise : fait (déclaration validée), en cours, ou à venir (circuit pas encore conclu). */
  etat: "done" | "current" | "todo";
  /** Sous le titre, dans la frise : la référence, « sans déclaration », ou chez qui. */
  detail: string | null;
  /** La phrase d'état, en entier. */
  phrase: string;
  ton: "succes" | "info" | "attente" | "neutre";
  declaration: { id: string; reference: string; authorityRef: string | null; authorityNotes: string | null } | null;
  /** Le dossier complet dans Information médicale — seulement pour qui peut l'ouvrir. */
  lienDossier: string | null;
  /** Le pharmacien (ou le Super Admin) : déposer les déclarations, enregistrer la référence. */
  peutAgir: boolean;
  /**
   * C'EST SON TOUR (23/11/2026) — sa lecture à soumettre, le dépôt ANPP, sa validation, ou la déclaration à ouvrir. Faux
   * pendant que le Directeur des Opérations tranche, ou que des pièces sont attendues d'autres : « À vous » dit le tour.
   */
  aVous: boolean;
  /** Aucune déclaration n'existe pour cette demande conclue : le pharmacien peut l'ouvrir. */
  peutOuvrir: boolean;
  /** La référence ANPP — et le dépôt des déclarations — ne s'ouvrent qu'une fois la lecture « à déclarer » accordée. */
  depot: { ouvert: boolean; motif: string | null };
  pieces: PieceDeDeclaration[];
  /**
   * LA LECTURE « à déclarer / sans déclaration » (08/11/2026) — tant qu'elle n'est pas accordée, le pharmacien la
   * soumet d'ici (`peutDemander`) ; `null` une fois accordée, ou pour qui n'agit pas.
   */
  decision: { etat: DeclareInput; peutDemander: boolean; validationHref: string | null } | null;
  /** « Valider et transmettre au Directeur des Opérations » : la même règle que le dossier (`pharmacienPeutValider`). */
  validation: { peut: boolean; piecesAttendues: boolean };
}
