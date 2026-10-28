/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE AD & PRO — LA PORTE SERVEUR.
 *
 * Le métier Ad & Pro : sponsoring, congrès nationaux et internationaux (prise en charge des
 * professionnels), événements, matériel promotionnel (sa demande ; le stock vit chez `promo/`),
 * « autres » demandes, et ce qu'elles partagent — les POSTES (devis, BC, facture, paiement), la
 * porte du DG, le centre de validation, la clôture.
 *
 * Hors de `src/modules/ad-pro/`, on importe CE fichier (ou `./partage` pour les règles pures, ou un
 * `./actions-*` pour une action), jamais `domaine/` ni `infra/` : tenu par ESLint et
 * `src/modules/frontieres.test.ts`.
 *
 * Tables possédées : `SponsoringRequest`, `CongressNational`, `CongressInternational`, `Event`,
 * `EventRegistration`, `AdProOtherRequest` ; les postes `AdProItem`, `AdProItemPiece`,
 * `AdProItemDecision`, `AdProDevis`, `AdProDevisLigne`, `AdProVoyageur`, `AdProVoyageurDevis`,
 * `AdProHebergement`, `AdProStockLine`, `AdProProductAllocation`, `AdProMedecin` ; la prise en charge
 * `CareBeneficiary`, `CareCell`, `CareQuote`, `CareQuoteCell`, `CareGroupPoste` ; les portes
 * `AdProGateVisa`, `AdProPorteDg`. (L'intégration des dépenses 2026 — `AdProIntegration*`,
 * `AdProRapprochement*` — reste chez le budget marketing.) Les écrivains du stock promotionnel, des bons de commande,
 * des ordres de dépense et du circuit de validation restent chez leurs domaines (`DETTE_HERITEE`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

export { apercuDuBC, type ApercuDuBC, composerApercuDuBC, genererLesBCsDuPoste, lignesDuBCDuDevis, phraseBilanGeneration, refusPlafondDuPoste, tiersDuDevis } from "./infra/bc-devis";
export { annulerBcNonSigne, bcEtablisDuPoste, bcVivantsDesPostes, refusAnnulationBcDuPoste, refusBcEtabli } from "./infra/bc-etablis";
export { businessUnitDuDemandeur, gammeImposee } from "./infra/business-unit-auto";
export { getAdProEventsAsCalendar } from "./infra/calendrier";
export { type NatureDemandeAdPro, refusCategoriePourLaDemande } from "./infra/categorie-budgetaire-serveur";
export { lireFactureDuPoste } from "./infra/facture-poste-lecture";
export { creerPosteEtFiches, donneesVoyageur, lireFichesDuFormulaire } from "./infra/fiches-poste";
export { ecrireAuFil } from "./infra/fil";
export { lireLaMarcheDuBC, notificationDuCentreBC, REFUS_MARCHE_PRISE } from "./infra/marche-bc";
export { peutLirePasseportDuSujet, peutLirePieceDePriseEnCharge } from "./infra/passeport-acces";
export { accesPiecesLiees, contextePiecesLiees } from "./infra/pieces-liees";
export { annulerDemandesPiecesDuPoste, assistantesDeDirection, demanderBcAAssistante, demandesBCDesPostes, natureDePiece, piecesDesPostes, rattacherPieceAuPoste, societeDuPoste } from "./infra/pieces-poste";
export { refusSiPorteDgFermee, signalerPorteDgSiBesoin, statuerSurLeTotal, totalDeLaDemande } from "./infra/porte-dg";
export { proposerPostesParModele, type ResultatPostes } from "./infra/postes-luna-ia";
export { peutSaisirLesDevis } from "./infra/prise-en-charge/devis-acces";
export { demandePrevalidee, REFUS_NON_PREVALIDEE, refusEngagementPriseEnCharge } from "./infra/prise-en-charge/engagement";
export { deposerFichiersSurLaPiece, retirerFichierDeLaPiece } from "./infra/prise-en-charge/pieces-db";
export { ENVOI_FINANCES_CHAMP, ENVOI_FINANCES_RESUME, envoiAuxFinances } from "./infra/prise-en-charge/realisation";
export { referentAInscrire } from "./infra/referent-de-la-gamme";
export { demandeAttendLeCentre, demandesAuCentreAdPro, demandeurDuVisa, peutResoumettreAuCentre, visasTranchesCentreAdPro, type VisaTranche } from "./infra/requetes/centre";
export { type CongressDetail, type CongressListRow, getCongressDetail, getCongressList } from "./infra/requetes/congres";
export { getAdProCreateData, getAdProRequests } from "./infra/requetes/demandes";
export { devisDesPostes, empreintesDesDevis } from "./infra/requetes/devis-poste";
export { adProEditValues } from "./infra/requetes/edition";
export { type EventDetail, getEventDetail, getEvents, getPublicEvent, type RegistrationDTO } from "./infra/requetes/evenements";
export { chargerLiensAdPro, medecinsParDemande } from "./infra/requetes/medecins";
export { adProBudgetOptions, contexteMaterielStock, contextePostes, loadAdProItems, postesPourCloture } from "./infra/requetes/postes";
export { getCareDossier } from "./infra/requetes/prise-en-charge";
export { peutSupprimerUneDemandeAdPro } from "./infra/requetes/suppression";
export { ajusterVisaAuMontant, blocageCentreAdPro, lireVisaAdPro, montantPourLeVisa, phraseGesteVisa, poserVisaAdPro, retirerVisaEnAttente, seuilAdProEnVigueur } from "./infra/visa";
