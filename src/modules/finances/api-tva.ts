/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE FINANCES — LA PORTE ÉTROITE DE LA TVA DES FACTURES (lot « tva », 24/11/2026).
 *
 * La fabrique des pièces, le formulaire Legal et la facture de matériel ENREGISTRENT la TVA d'une facture ; l'écran des
 * impôts la LIT par mois (`tvaDuMois`, `tvaAPayerDuMois` pour la ligne « TVA du mois » de la G50). Une porte à part pour
 * qu'un écrivain de pièce ne tire pas tout le module (centre de paiement, trésorerie) dans son graphe : Prisma et le
 * domaine pur, rien d'autre. `api.ts` la réexporte pour qui veut tout.
 *
 * Tables possédées : `FactureTva`, `FactureTvaTaux`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export {
  appliquerTvaDuFormulaire, effacerTvaFacture, enregistrerTvaDeLaPieceEmise, enregistrerTvaFacture, type EtatTvaFacture,
  etatTvaDesFactures, tvaAPayerDuMois, tvaDeLaFacture, tvaDuMois,
} from "./infra/tva";
export {
  lireSaisieTva, lireTvaDeLaPiece, saisieDesTotaux, type ResultatTvaDuMois, type SaisieTva,
} from "./domaine/tva";
