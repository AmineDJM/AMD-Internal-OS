/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES D'UNE PRISE EN CHARGE (congrès), POUR QUI RÉSERVE ET QUI ACCOMPAGNE — la règle, sans base.
 *
 * Même porte ÉTROITE qu'au sponsoring (`ad-pro/passeport-acces.ts`, §118.185) : l'assistante de direction réserve
 * les billets d'un congrès SANS le module des prises en charge. Son sujet de réservation annonce les passeports
 * (`/api/documents/…`) et la page « Billets et confirmations » montre les e-billets et vouchers qu'elle dépose —
 * le téléchargement lui répondait « Accès refusé ».
 *
 *   • PASSEPORT / PIÈCE D'IDENTITÉ d'une personne de la demande : aux membres du SUJET DE RÉSERVATION seulement ;
 *   • BILLET ÉMIS / VOUCHER : aux membres du sujet, et à qui peut les déposer (`peutTeleverserBillet` : assistante de
 *     direction, demandeur, Direction Marketing, Super Admin, vue globale) ;
 *   • LIVRET DE SÉJOUR : comme un billet émis — et le livret GÉNÉRAL aussi à l'équipe Adventum qui accompagne ;
 *   • DEVIS saisi sur la demande (`CareQuote.documentId`) : aux membres du sujet, et à l'assistante SOLLICITÉE pour
 *     les devis de cette demande (`care-devis-acces.ts` — audit Assistante de direction, 10/2026) ;
 *   • tout le reste (factures, programme…) reste derrière la porte de la demande.
 *
 * Module PUR : le serveur (`ad-pro/passeport-acces.ts`) établit les faits, cette fonction tranche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NaturePiece = "PIECE_IDENTITE" | "BILLET_EMIS" | "LIVRET_INDIVIDUEL" | "LIVRET_GENERAL" | "DEVIS" | "AUTRE";

/** Le `stepKey` d'un livret : « livret:general » ou « livret:<id de la personne> ». */
export const CLE_LIVRET_GENERAL = "livret:general";
export const cleLivret = (beneficiaryId: string | null): string => (beneficiaryId ? `livret:${beneficiaryId}` : CLE_LIVRET_GENERAL);

export function natureDuLivret(stepKey: string | null | undefined): "LIVRET_GENERAL" | "LIVRET_INDIVIDUEL" | null {
  if (!stepKey || !stepKey.startsWith("livret:")) return null;
  return stepKey === CLE_LIVRET_GENERAL ? "LIVRET_GENERAL" : "LIVRET_INDIVIDUEL";
}

export interface FaitsPiece {
  nature: NaturePiece;
  /** Responsable ou participant du sujet de réservation de la demande. */
  membreDuSujet: boolean;
  /** Peut déposer les billets émis de la demande (`peutTeleverserBillet`). */
  organise: boolean;
  /** Membre de l'équipe Adventum qui accompagne (mission active, non déclinée). */
  equipe: boolean;
  /** Assistante sollicitée pour les devis de la demande (`solliciteePourLesDevis`). Absent : non. */
  solliciteePourDevis?: boolean;
}

export function peutLirePiecePriseEnCharge(f: FaitsPiece): boolean {
  switch (f.nature) {
    case "PIECE_IDENTITE": return f.membreDuSujet;
    case "BILLET_EMIS":
    case "LIVRET_INDIVIDUEL": return f.membreDuSujet || f.organise;
    case "LIVRET_GENERAL": return f.membreDuSujet || f.organise || f.equipe;
    case "DEVIS": return f.membreDuSujet || f.solliciteePourDevis === true;
    default: return false;
  }
}
