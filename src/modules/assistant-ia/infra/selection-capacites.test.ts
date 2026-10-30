import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { outilsV1 } from "./outils-v1";
import { outilTravailPour } from "./travaux";
import { fichesOffertes, selectionDuTour } from "./selection";
import { registreDesCapacites } from "./capacites";
import { classer, indexer, OUTIL_TROUVER, PRESELECTION_MAX, SOCLE_OUTILS } from "../domaine/selection-outils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SÉLECTION SUR TOUT L'ERP (lot J6, décision 0020) — 300 demandes de référence, en français, toutes familles.
 *
 *   • RAPPEL@5 ≥ 95 % : pour 300 demandes (Ad & Pro, réglementaire, RH, finances, marketing, terrain, Drive et le
 *     quotidien), l'une des capacités justes est dans les 5 premières de la recherche (`trouver_outil`), parmi TOUTES
 *     les actions de l'ERP offertes au Super Admin (≈ 1 000) et les outils de l'Assistant IA ;
 *   • JAMAIS HORS DROITS : pour un rôle limité, ni la présélection ni `trouver_outil` ne rendent une capacité que la
 *     porte de son écran ne lui ouvre pas ;
 *   • ≤ 4 000 JETONS FIXES d'outils par étape : le socle, la présélection et `trouver_outil` d'un tour, mesurés sur
 *     les 300 demandes (estimation au caractère, calibrée sur la mesure J4 de ~18 700 jetons pour 65 outils).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__selcap_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let ad: CurrentUser;

async function compte(nom: string, role: "SUPER_ADMIN" | "DIRECTION_ASSISTANT"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}
const catalogue = (u: CurrentUser) => [...outilsV1(u, [], [], [], null, undefined, { capacites: true }), outilTravailPour(u)];

/** 300 demandes — et les outils (capacités ou outils de l'Assistant IA) qui y répondent. */
export const CORPUS_ERP: [string, string[]][] = [
  // ── Ad & Pro : demandes, postes, prise en charge, congrès, événements, matériel, BC (60) ──
  ["Ajoute un poste hôtellerie à la demande de sponsoring du Dr Mansouri.", ["ad-pro-item__addAdProItem", "preparer_poste"]],
  ["Supprime le poste traiteur de la demande EVT-2026-14.", ["ad-pro-item__deleteAdProItem"]],
  ["Modifie le montant estimé du poste billetterie.", ["ad-pro-item__updateAdProItem"]],
  ["Soumets le poste salle de la demande pour validation.", ["ad-pro-item__submitAdProItem"]],
  ["Approuve l'ordre du poste imprimerie.", ["ad-pro-item__approveAdProItemOrder"]],
  ["Ajoute un voyageur au poste billetterie du congrès.", ["ad-pro-item__ajouterVoyageur", "preparer_voyageur_passeport"]],
  ["Retire le voyageur Karim du poste billetterie.", ["ad-pro-item__retirerVoyageur"]],
  ["Modifie les dates du voyageur Nadia sur la billetterie.", ["ad-pro-item__modifierVoyageur"]],
  ["Modifie l'hébergement du Dr Saidi : arrivée le 12.", ["ad-pro-item__modifierHebergement"]],
  ["Retire l'hébergement de ce poste.", ["ad-pro-item__retirerHebergement"]],
  ["Demande une réservation pour le poste hôtel.", ["ad-pro-item__demanderReservation", "care__demanderReservationPriseEnCharge"]],
  ["Génère le bon de commande du poste traiteur.", ["ad-pro-item__genererBonDeCommandePoste", "preparer_bon_de_commande"]],
  ["Génère la demande de devis du poste salle.", ["ad-pro-item__genererDemandeDevisPoste"]],
  ["Demande une révision du montant du poste stand.", ["ad-pro-item__demanderRevisionPoste"]],
  ["Demande une pièce au secrétariat pour ce poste.", ["ad-pro-item__demanderPieceSecretariat"]],
  ["Valide les lignes du devis du poste imprimerie.", ["ad-pro-item__validerLignesDuDevis"]],
  ["Retire le devis du poste traiteur.", ["ad-pro-item__retirerDevisDuPoste", "promo-devis__retirerDemandeDevisPromo"]],
  ["Définis le budget du poste hôtellerie sur la catégorie congrès.", ["ad-pro-item__setAdProItemBudget"]],
  ["Ajoute un commentaire sur la demande Ad & Pro : en attente du devis.", ["ad-pro-discussion__addAdProComment"]],
  ["Ajoute le Dr Benali comme médecin concerné par la demande.", ["ad-pro-medecins__ajouterMedecinConcerne"]],
  ["Retire le médecin concerné Dr Haddad de la demande.", ["ad-pro-medecins__retirerMedecinConcerne"]],
  ["Cherche un médecin dans l'annuaire pour la demande : Mansouri.", ["ad-pro-medecins__chercherMedecinsAnnuaire", "directory_lookup"]],
  ["Crée une demande Ad & Pro autre : abonnement à une revue médicale.", ["preparer_demande_autre", "ad-pro-other__createAdProOtherRequest"]],
  ["Clôture la demande autre AUT-2026-12.", ["ad-pro-other__closeAdProOtherRequest"]],
  ["Décide la demande autre AUT-2026-09 : accordée.", ["ad-pro-other__decideAdProOtherRequest"]],
  ["Transfère la demande sponsoring vers une prise en charge.", ["ad-pro-transfer__transferAdProRequest"]],
  ["Décide le visa du centre Ad & Pro sur cette demande.", ["ad-pro-centre__deciderVisaCentreAdPro"]],
  ["Resoumets la demande au centre Ad & Pro avec le nouveau montant.", ["ad-pro-centre__resoumettreAuCentreAdPro"]],
  ["Supprime la pièce jointe de la demande.", ["ad-pro-pieces__supprimerPieceDeLaDemande", "ad-pro-pieces__supprimerFichierDePieceDeLaDemande"]],
  ["Ajoute un bénéficiaire à la prise en charge du congrès : Dr Kaci.", ["care__addCareBeneficiary"]],
  ["Retire le bénéficiaire Dr Kaci de la prise en charge.", ["care__removeCareBeneficiary"]],
  ["Décide le bénéficiaire de la prise en charge : accepté.", ["care__decideCareBeneficiary"]],
  ["Demande les devis de la prise en charge du congrès national.", ["care__requestCareQuotes"]],
  ["Décide le devis de la prise en charge : retenu.", ["care__decideCareQuote", "care__retenirDevisPriseEnCharge"]],
  ["Envoie la prise en charge aux finances.", ["care__sendCareToFinance"]],
  ["Marque la prise en charge comme réalisée.", ["care__marquerPriseEnChargeRealisee"]],
  ["Demande les pièces de la prise en charge aux médecins.", ["care__demanderPiecesPriseEnCharge"]],
  ["Demande le bon de commande de la prise en charge.", ["care__demanderBCPriseEnCharge"]],
  ["Crée une demande de congrès international à Paris pour la BU Hépatologie.", ["congress-request__createCongressRequest", "preparer_prise_en_charge"]],
  ["Annule la demande de congrès de Lyon.", ["congress-request__cancelCongressRequest"]],
  ["Prends la décision finale sur la demande de congrès.", ["congress-request__finalDecision"]],
  ["Crée une demande de sponsoring pour la société algérienne de cardiologie.", ["sponsoring__createSponsoring", "preparer_sponsoring"]],
  ["Clôture le sponsoring SP-2026-014.", ["sponsoring__cloturerSponsoring"]],
  ["Rouvre le sponsoring SP-2026-014.", ["sponsoring__rouvrirSponsoring"]],
  ["Crée un événement : soirée scientifique à Constantine.", ["event__createEvent", "preparer_evenement"]],
  ["Supprime l'événement du 3 décembre.", ["event__deleteEvent"]],
  ["Soumets l'événement pour approbation.", ["event__submitEventForApproval"]],
  ["Ajoute une inscription du Dr Amrani à l'événement.", ["event__addRegistration"]],
  ["Crée une demande de matériel promotionnel : 300 sacs.", ["preparer_materiel_promo", "promo-material__createPromoMaterial"]],
  ["Annule la demande de matériel promotionnel MP-2026-08.", ["promo-material__cancelPromoMaterial"]],
  ["Choisis l'agence pour le matériel promotionnel.", ["promo-material__chooseAgency"]],
  ["Démarre le BAT du matériel promotionnel.", ["promo-material__startBat"]],
  ["Demande les devis du matériel promotionnel aux fournisseurs.", ["promo-devis__demanderDevisPromo"]],
  ["Génère les bons de commande du matériel promotionnel.", ["promo-execution__genererBonsDeCommandePromo"]],
  ["Demande le paiement de la facture du matériel promotionnel.", ["promo-execution__demanderPaiementFacturePromo"]],
  ["Avance le circuit de la demande au validateur suivant.", ["workflow__advanceWorkflow"]],
  ["Retire la demande Ad & Pro du circuit.", ["workflow__retirerDemandeAdPro"]],
  ["Fais appel de la décision sur la demande Ad & Pro.", ["workflow__faireAppelAdPro"]],
  ["Statue sur le total de la demande au-dessus du seuil DG.", ["porte-dg__statuerTotalDg"]],
  ["Envoie la fiche de réservation à l'agence.", ["reservation-fiche__envoyerFiche"]],

  // ── Réglementaire (40) ──
  ["Crée un dossier réglementaire pour le sofosbuvir.", ["regulatory__createRegulatoryProduct"]],
  ["Ouvre un nouveau dossier d'enregistrement ANPP pour le ténofovir.", ["regulatory__createRegulatoryProduct"]],
  ["Vérifie si la DCI daclatasvir existe déjà en doublon.", ["regulatory__checkDciDuplicate"]],
  ["Modifie la marque du dossier réglementaire Nivolex.", ["regulatory__updateRegulatoryProduct"]],
  ["Change le statut réglementaire du dossier REG-2026-9002 en attente ANPP.", ["regulatory__updateRegulatoryStatus"]],
  ["Change la priorité réglementaire du dossier REG-2026-9011 en critique.", ["regulatory__setRegulatoryPriority"]],
  ["Fixe les dates cibles du dossier réglementaire : soumission en mars.", ["regulatory__setRegulatoryTargetDates"]],
  ["Ajoute un commentaire au dossier réglementaire Nivolex.", ["regulatory__addRegulatoryComment"]],
  ["Coche l'élément de checklist du dossier réglementaire : CTD module 3.", ["regulatory__setRegulatoryChecklistItem"]],
  ["Ajoute une note à l'étape dépôt du dossier réglementaire.", ["regulatory__setRegulatoryStepNote"]],
  ["Définis les participants du dossier réglementaire Nivolex.", ["regulatory__setRegulatoryParticipants"]],
  ["Verrouille le dossier réglementaire confidentiel.", ["regulatory__setRegulatoryLock"]],
  ["Crée une variation sur le dossier Nivolex : changement de fabricant.", ["regulatory__createVariation"]],
  ["Supprime la variation du dossier réglementaire.", ["regulatory__deleteVariation"]],
  ["Change le statut de la variation en approuvée.", ["regulatory__setVariationStatus"]],
  ["Enregistre l'issue de la présoumission du dossier : favorable.", ["regulatory__setRegulatoryPresubOutcome"]],
  ["Crée un fournisseur réglementaire : laboratoire Kwality.", ["regulatory__createRegulatorySupplier"]],
  ["Combien de dossiers réglementaires ne sont pas entamés ?", ["regulatory__compterDossiersNonEntames"]],
  ["Mets au pipeline les dossiers non entamés.", ["regulatory__mettreAuPipelineNonEntames"]],
  ["Classe le dossier réglementaire dans le segment oncologie.", ["regulatory__setRegulatoryClassification"]],
  ["Ajoute une étape à la chronologie du dossier : réponse aux réserves.", ["regulatory-timeline__addDossierStep"]],
  ["Supprime l'étape de la chronologie du dossier.", ["regulatory-timeline__deleteDossierStep"]],
  ["Démarre la chronologie du dossier réglementaire.", ["regulatory-timeline__startDossierTimeline"]],
  ["Renomme le dossier CTD du produit.", ["regulatory-ctd__renommerDossierCtd"]],
  ["Synchronise le Drive du dossier réglementaire.", ["regulatory-drive__synchroniserDriveRegulatory"]],
  ["Envoie un rappel de mise à jour réglementaire au responsable.", ["regulatory-reminder__sendRegulatoryUpdateReminder", "regulatory__requestRegulatoryStatusUpdate"]],
  ["Où en est le dossier réglementaire du ténofovir ?", ["etat_dossier_reglementaire"]],
  ["Quel est le cadre réglementaire des redevances ANPP ?", ["regulatory_knowledge"]],
  ["Quelle est la charge de dossiers de chaque responsable Regulatory ?", ["regulatory_workload"]],
  ["Montre le portefeuille du partenaire Kwality.", ["regulatory_portfolio"]],
  ["Signale un cas de pharmacovigilance : effet indésirable sous Nivolex.", ["pharmacovigilance__signalerCasPv"]],
  ["Ouvre une enquête de pharmacovigilance sur le cas PV-2026-03.", ["pharmacovigilance__ouvrirEnquetePv"]],
  ["Change le statut du cas de pharmacovigilance en clos.", ["pharmacovigilance__changerStatutCasPv"]],
  ["Commente le cas de pharmacovigilance PV-2026-03.", ["pharmacovigilance__commenterCasPv"]],
  ["Ajoute des participants au cas de pharmacovigilance.", ["pharmacovigilance__ajouterParticipantsPv"]],
  ["Ajoute un alias au produit canonique sofosbuvir.", ["produit-canonique__ajouterAliasProduitCanonique"]],
  ["Renomme le produit canonique Nivolex.", ["produit-canonique__renommerProduitCanonique"]],
  ["Rattache le dossier au produit canonique.", ["produit-canonique__rattacherDossierCanonique"]],
  ["Enregistre le prix du produit Nivolex.", ["prix-produit__enregistrerPrixProduit"]],
  ["Crée une gamme de produits Hépatologie.", ["product-range__createProductRange", "bd-project__createBdRange"]],

  // ── RH (40) ──
  ["Pose un congé du 12 au 16 août pour moi.", ["hr__requestLeave"]],
  ["Demande un congé pour Nadia du 2 au 5 décembre.", ["hr__requestLeave"]],
  ["Annule mon congé de décembre.", ["hr__cancelLeave"]],
  ["Accorde le congé de Karim.", ["hr__decideLeave", "hr-document__decideHrLeave"]],
  ["Modifie la demande de congé : fin le 18 août.", ["hr__updateLeaveRequest"]],
  ["Demande l'avis du N+1 sur le congé de Walid.", ["hr__demanderAvisN1Conge"]],
  ["Commente la demande de congé de Nadia.", ["conge-discussion__commenterConge"]],
  ["Demande une avance sur salaire de 50 000 DZD.", ["hr__requestAdvance"]],
  ["Décide l'avance sur salaire de Walid : accordée.", ["hr__decideAdvance"]],
  ["Annule l'avance sur salaire.", ["hr__cancelAdvance"]],
  ["Demande une attestation de travail.", ["hr-document__requestHrDocument", "hr-document__genererAttestationDeTravail"]],
  ["Génère l'attestation de travail de Nadia.", ["hr-document__genererAttestationDeTravail", "hr-document__preparerAttestationDeTravail"]],
  ["Génère l'ordre de mission pour le déplacement à Oran.", ["hr-document__genererOrdreDeMission"]],
  ["Traite la demande RH de Karim.", ["hr-document__processHrRequest"]],
  ["Annule ma demande RH.", ["hr-document__annulerDemandeRh"]],
  ["Ajoute un commentaire à la demande RH.", ["hr-document__addHrRequestComment"]],
  ["Décide la note de frais de Walid.", ["hr-document__decideExpenseReport"]],
  ["Supprime le document RH de la fiche de Karim.", ["hr-document__deleteEmployeeDocument"]],
  ["Propose une réunion RH à Nadia jeudi.", ["hr-document__proposeHrMeeting"]],
  ["Crée une demande de recrutement : délégué médical à Sétif.", ["recruitment__createRecruitmentRequest"]],
  ["Ajoute un candidat à la demande de recrutement.", ["recruitment__addRecruitmentCandidate"]],
  ["Déplace le candidat à l'étape entretien.", ["recruitment__moveRecruitmentCandidate"]],
  ["Décide l'étape de recrutement : retenu.", ["recruitment__decideRecruitmentStep"]],
  ["Clôture la demande de recrutement.", ["recruitment__closeRecruitmentRequest"]],
  ["Annule la demande de recrutement du poste de KAM.", ["recruitment__cancelRecruitmentRequest"]],
  ["Ouvre le sourcing du recrutement.", ["recruitment__openRecruitmentSourcing"]],
  ["Publie l'offre d'emploi sur le site du recrutement.", ["recrutement-diffusion__publierOffreSiteDuRecrutement"]],
  ["Envoie l'offre d'emploi sur Emploitic.", ["recrutement-diffusion__envoyerOffreEmploitic"]],
  ["Enregistre l'offre d'emploi de chef de produit.", ["offres-emploi__enregistrerOffre"]],
  ["Crée une formation RH sur les bonnes pratiques de promotion.", ["training__createHrTraining"]],
  ["Invite les délégués à la formation du 20 novembre.", ["training__inviteTrainingParticipants"]],
  ["Demande une formation Excel.", ["training__requestTraining"]],
  ["Annule la formation de mardi.", ["training__annulerFormation"]],
  ["Crée une fiche de coaching pour Karim.", ["coaching__creerFicheCoaching"]],
  ["Finalise la fiche de coaching de Walid.", ["coaching__finaliserFicheCoaching"]],
  ["Attribue Karim comme manager de Nadia.", ["department__assignEmployeeManager"]],
  ["Crée un département Accès au marché.", ["department__createDepartment"]],
  ["Quelle est la situation RH : effectif et contrats qui finissent ?", ["read_hr_overview"]],
  ["Quand finit le contrat de Walid ?", ["lire_fiche_rh"]],
  ["Montre-moi le bulletin de paie de septembre de Nadia.", ["lire_paie", "documents_rh"]],

  // ── Finances et budgets (45) ──
  ["Crée une enveloppe budgétaire Marketing 2027 de 40 millions.", ["budget-envelope__createEnvelope", "budget-pole__createPoleEnvelope"]],
  ["Supprime l'enveloppe budgétaire Test.", ["budget-envelope__deleteEnvelope"]],
  ["Ajoute une catégorie Congrès à l'enveloppe budgétaire.", ["budget-envelope__createBudgetCategory"]],
  ["Ajoute une dépense de 120 000 DZD au budget Séminaires.", ["budget-envelope__addBudgetExpense", "department-budget__addDepartmentExpense"]],
  ["Supprime la dépense budgétaire en double.", ["budget-envelope__deleteBudgetExpense", "department-budget__deleteDepartmentExpense"]],
  ["Attribue la transaction à la catégorie budgétaire Congrès.", ["budget-envelope__attributeTransaction"]],
  ["Réalloue 500 000 DZD de la catégorie Séminaires vers Congrès.", ["budget-pole__reallouerCategorie"]],
  ["Impute le BV sur l'enveloppe du pôle.", ["budget-pole__imputerBv"]],
  ["Saisis un BV manuel de 80 000 DZD.", ["budget-pole__saisirBvManuel"]],
  ["Crée une campagne budgétaire 2027.", ["budget-campagne__creerCampagne"]],
  ["Soumets la proposition budgétaire du pôle Marketing.", ["budget-campagne__soumettreProposition"]],
  ["Vote la proposition budgétaire du pôle Opérations.", ["budget-campagne__voterProposition"]],
  ["Décide la ligne de proposition budgétaire : ajustée.", ["budget-campagne__deciderLigneProposition"]],
  ["Renvoie la proposition budgétaire au pôle pour correction.", ["budget-campagne__renvoyerProposition"]],
  ["Demande un budget pour le département Logistique.", ["department-budget__requestDepartmentBudget"]],
  ["Définis le budget du département Marketing.", ["department-budget__setDepartmentBudget"]],
  ["Décide la demande de budget du département.", ["department-budget__decideDepartmentBudgetRequest"]],
  ["Règle l'ordre de dépense ODD-2026-77.", ["expense__settleExpenseOrder"]],
  ["Reporte l'ordre de dépense au mois prochain.", ["expense__deferExpenseOrder"]],
  ["Demande la facture au fournisseur pour cet ordre de dépense.", ["expense__requestInvoice"]],
  ["Crée une transaction financière de 300 000 DZD.", ["finance__createTransaction"]],
  ["Supprime la transaction financière erronée.", ["finance__deleteTransaction"]],
  ["Modifie le statut de la transaction en réglée.", ["finance__updateTransactionStatus"]],
  ["Importe les transactions du relevé bancaire.", ["finance__importTransactions"]],
  ["Définis le solde d'ouverture de la trésorerie.", ["finance__setTreasuryOpeningBalance"]],
  ["Modifie le compte de trésorerie BNA.", ["finance__modifierCompteTresorerie"]],
  ["Marque la facture comme payée.", ["invoice__setInvoicePaid"]],
  ["Supprime la facture FA-2026-1187.", ["invoice__deleteInvoice"]],
  ["Modifie la facture de l'imprimerie Atlas.", ["invoice__updateInvoice"]],
  ["Soumets la demande de paiement au centre.", ["payment-request__submitPaymentRequest"]],
  ["Annule la demande de paiement DP-2026-31.", ["payment-request__cancelPaymentRequest"]],
  ["Décide la demande de paiement : accordée.", ["payment-request__decidePaymentRequest", "payment-centre__decidePayment"]],
  ["Corrige la demande de paiement : mauvais bénéficiaire.", ["payment-request__corrigerDemandePaiement"]],
  ["Ajoute un commentaire sur la demande de paiement.", ["payment-request__addPaymentComment"]],
  ["Dote la petite caisse de 100 000 DZD.", ["petty-cash__allotPettyCash"]],
  ["Demande une recharge de la petite caisse.", ["petty-cash__requestPettyCashTopUp"]],
  ["Clôture la petite caisse du mois.", ["petty-cash__closePettyCash"]],
  ["Dépense 4 000 DZD de la petite caisse pour des fournitures.", ["petty-cash__spendFromPettyCash"]],
  ["Émets une pièce commerciale : facture pour la clinique El Azhar.", ["fabrique__emettrePieceCommerciale"]],
  ["Émets un avoir sur la facture de la clinique.", ["fabrique__emettreAvoir"]],
  ["Révise le numéro du bon de commande.", ["fabrique__reviserNumeroDuBc"]],
  ["Envoie la facture juridique au règlement.", ["legal__sendLegalInvoiceToSettlement"]],
  ["Combien reste-t-il sur l'enveloppe Congrès 2026 ?", ["read_budget"]],
  ["Combien avons-nous payé à l'imprimerie Atlas depuis janvier ?", ["finance_totals"]],
  ["Crée une demande d'achat de deux ordinateurs portables.", ["purchase-request__createPurchaseRequest"]],

  // ── Marketing, BD, marché, segmentation, KPI (35) ──
  ["Crée un projet BD pour le marché des biosimilaires.", ["bd-project__createBdProject", "bd__createBD"]],
  ["Supprime le projet BD Test.", ["bd-project__deleteBdProject"]],
  ["Ajoute un produit BD au projet biosimilaires : adalimumab.", ["bd-project__createBdProduct"]],
  ["Commente le projet BD biosimilaires.", ["bd-project__addBdProjectComment"]],
  ["Crée une étude de marché sur l'hépatite C.", ["market-research__createMarketResearch"]],
  ["Ajoute un acteur à l'étude de marché : Gilead.", ["market-research__addResearchPlayer"]],
  ["Supprime l'étude de marché obsolète.", ["market-research__deleteMarketResearch"]],
  ["Génère une présentation de l'étude de marché.", ["market-presentation__generatePresentation"]],
  ["Analyse le marché de la molécule sofosbuvir 400 mg.", ["market__analyzeMarketMolecule"]],
  ["Cherche les produits du marché à base de ténofovir.", ["market__searchMarketProducts", "search_products"]],
  ["Crée une stratégie de segmentation pour la BU Hépatologie.", ["segmentation__creerStrategie"]],
  ["Ajoute le Dr Saidi au panel de segmentation.", ["segmentation__ajouterAuPanel"]],
  ["Enregistre le potentiel du praticien dans la segmentation.", ["segmentation__enregistrerPotentiel"]],
  ["Clôture le cycle de segmentation.", ["segmentation__cloreCycleSegmentation"]],
  ["Cible les spécialités du produit dans la segmentation.", ["segmentation__ciblerSpecialitesProduit"]],
  ["Crée un KPI : nombre de visites par mois.", ["kpi__creerKpi", "kpi__proposerKpiDepuisPhrase"]],
  ["Déclare le KPI du mois de Karim.", ["kpi__declarerKpi"]],
  ["Signe la revue KPI de l'équipe.", ["kpi__signerRevueKpi"]],
  ["Valide l'évaluation KPI de Walid.", ["kpi__validerEvaluationKpi"]],
  ["Archive le KPI des congrès.", ["kpi__archiverKpi"]],
  ["Quel est le bilan KPI de Karim ce trimestre ?", ["kpi__bilanKpi", "my-team__teamMemberKpis"]],
  ["Crée une note de service sur les horaires du ramadan.", ["directive__createDirective"]],
  ["Publie la note de service des horaires.", ["directive__publishDirective"]],
  ["Archive la note de service de septembre.", ["directive__archiveDirective"]],
  ["Enregistre l'article du site web sur le lancement.", ["site-web__enregistrerArticle"]],
  ["Supprime l'article du site web.", ["site-web__supprimerArticle"]],
  ["Rédige un article pour le site avec l'IA sur notre nouveau produit.", ["site-web-redaction__redigerArticleAvecIA"]],
  ["Crée une unité business Oncologie.", ["sales-planning__createBusinessUnit"]],
  ["Crée un secteur de vente Est.", ["sales-planning__createSector"]],
  ["Enregistre le territoire du KAM Karim.", ["sales-planning__enregistrerTerritoireKam"]],
  ["Enregistre la prévision de ventes du trimestre.", ["sales-planning__saveForecast"]],
  ["Crée un produit promotionnel pour la BU.", ["sales-planning__createPromoProduct"]],
  ["Crée un message promotionnel pour le Nivolex.", ["promo-message__createPromoMessage"]],
  ["Crée un article au catalogue promotionnel : clé USB.", ["promo-catalogue__creerArticleCatalogue"]],
  ["Définis le papier en-tête par défaut.", ["direction-artistique__definirPapierParDefaut"]],

  // ── Terrain : médecins, établissements, visites, tournées, stocks, ventes (40) ──
  ["Crée la fiche du médecin Dr Yacine Ferhat, cardiologue.", ["medical__createDoctor", "medical-directory__addDirectoryDoctor"]],
  ["Modifie la fiche du Dr Ferhat : nouveau téléphone.", ["medical__updateDoctor"]],
  ["Supprime le médecin en double Dr Ferhat.", ["medical__deleteDoctor", "medical-directory__deleteDirectoryDoctors"]],
  ["Crée l'établissement CHU de Tizi Ouzou.", ["medical__createInstitution"]],
  ["Modifie l'établissement clinique El Azhar.", ["medical__updateInstitution"]],
  ["Crée la spécialité néphrologie.", ["medical__createSpecialty"]],
  ["Fusionne les spécialités cardiologie et cardio.", ["medical__fusionnerSpecialite"]],
  ["Crée une visite chez le Dr Ferhat mardi.", ["medical__createVisit", "tour-visit__ajouterVisiteImprevue"]],
  ["Supprime la visite de lundi.", ["medical__deleteVisit"]],
  ["Ajoute une visite imprévue au plan de tournée.", ["tour-visit__ajouterVisiteImprevue"]],
  ["Rapporte la visite chez le Dr Saidi.", ["tour-visit__rapporterVisite"]],
  ["Dis que la visite du Dr Kaci n'a pas été tenue.", ["tour-visit__direVisiteNonTenue"]],
  ["Soumets mon plan de tournée de la semaine.", ["tour-plan__soumettrePlanTournee"]],
  ["Décide le plan de tournée de Karim.", ["tour-plan__deciderPlanTournee"]],
  ["Planifie les visites de la tournée de novembre.", ["tour-plan__planifierVisites"]],
  ["Demande une révision du plan de tournée.", ["tour-plan__demanderRevisionPlanTournee"]],
  ["Crée un rapport terrain de la semaine.", ["field-report__createFieldReport"]],
  ["Soumets le rapport terrain.", ["field-report__submitFieldReport"]],
  ["Valide le rapport terrain de Walid.", ["field-report__validateFieldReport"]],
  ["Supprime le rapport terrain brouillon.", ["field-report__deleteFieldReport"]],
  ["Crée une annexe de stock à Oran.", ["stock-snapshot__createStockAnnex"]],
  ["Enregistre un relevé de stock à l'hôpital Mustapha.", ["stock-snapshot__recordStockSnapshot", "stock-pch__enregistrerStockPch"]],
  ["Demande l'état du stock à l'annexe d'Oran.", ["stock-snapshot__requestStockState"]],
  ["Crée une récurrence de relevé de stock mensuel.", ["stock-recurrence__createStockRecurrence"]],
  ["Entre 500 boîtes d'échantillons en stock.", ["promo-stock__entrerEnStock"]],
  ["Transfère 50 kits du stock d'Alger vers Oran.", ["promo-stock__transferer"]],
  ["Déclare une perte de 20 stylos dans le stock promotionnel.", ["promo-stock__declarerPerte"]],
  ["Corrige l'inventaire du stock promotionnel.", ["promo-stock__corrigerInventaire"]],
  ["Demande du matériel au stock promotionnel : 30 sacs.", ["promo-stock__demanderMateriel"]],
  ["Sers la demande de matériel de Karim.", ["promo-stock__servirDemande"]],
  ["Planifie un comptage du stock promotionnel.", ["promo-comptage__planifierComptage"]],
  ["Saisis le comptage du stock.", ["promo-comptage__saisirComptage"]],
  ["Crée une demande de stocks aux délégués.", ["demande-stocks__creerDemandeStocks"]],
  ["Crée un appel d'offres PCH pour 2027.", ["pch__createTender"]],
  ["Ajoute une ligne à l'appel d'offres PCH.", ["pch-tender-line__addTenderLine"]],
  ["Crée une commande PCH.", ["pch__createOrder"]],
  ["Crée une soumission au marché PCH.", ["pch-market__createSubmission"]],
  ["Importe les ventes du mois.", ["sales__importSales"]],
  ["Crée une vente de 200 boîtes à la pharmacie centrale.", ["sales__createSale"]],
  ["Affecte le médecin au délégué Karim.", ["force-de-vente__affecterAuDelegue"]],

  // ── Drive, documents, courriers, messagerie, tâches, agenda, quotidien (40) ──
  ["Crée un dossier Contrats 2027 dans le Drive.", ["drive__createFolder"]],
  ["Renomme le fichier du Drive en « Plan 2027 final ».", ["drive__renameNode"]],
  ["Mets ce fichier du Drive à la corbeille.", ["drive__trashNode", "drive__trashNodes"]],
  ["Restaure le fichier du Drive supprimé.", ["drive__restoreNode"]],
  ["Partage le dossier du Drive avec Nadia.", ["drive__shareNode", "drive__shareNodeWithMany", "drive__shareNodesWithMany"]],
  ["Retire le partage du dossier avec Karim.", ["drive__unshareNode"]],
  ["Copie le fichier dans le dossier Archives.", ["drive__copyNodes"]],
  ["Convertis ce fichier du Drive en PDF.", ["drive__convertNodeToPdf", "convertir_document"]],
  ["Crée un espace Drive pour le projet biosimilaires.", ["drive-space__createDriveSpace"]],
  ["Commente le document du Drive : à relire.", ["drive-comment__postDriveComment"]],
  ["Renomme le document joint.", ["document__renameDocument", "drive__renameNode"]],
  ["Demande un document à Karim : la facture du traiteur.", ["document-request__requestDocument", "medical-info__requestDocument"]],
  ["Enregistre un courrier arrivé de l'ANPP au registre.", ["mail-register__createMailEntry"]],
  ["Modifie le courrier du registre : date d'arrivée.", ["mail-register__editMailEntry", "mail-register__setMailDate"]],
  ["Crée un dossier de courriers Partenaires.", ["mail-folder__createMailFolder"]],
  ["Envoie un e-mail au laboratoire Kwality avec ma boîte Microsoft.", ["microsoft-mail__sendMessage", "smart-mail__sendMail", "mail__sendMailAction"]],
  ["Enregistre un brouillon d'e-mail pour l'agence.", ["microsoft-mail__saveDraft"]],
  ["Enregistre la pièce jointe de l'e-mail dans le Drive.", ["microsoft-mail__saveAttachmentToDrive"]],
  ["Crée un groupe de messagerie Hépatologie.", ["messaging__createGroup"]],
  ["Crée un canal de messagerie pour le lancement.", ["messaging__createChannel"]],
  ["Ajoute Nadia à la conversation Hépatologie.", ["messaging__addMembers"]],
  ["Supprime mon dernier message dans la conversation.", ["messaging__deleteMessage"]],
  ["Archive la conversation du séminaire.", ["messaging__archiveConversation"]],
  ["Envoie un message à Nadia : la réunion est décalée.", ["send_message", "messaging__sendMessage"]],
  ["Crée une tâche pour Karim : préparer le stand.", ["task__createTask", "task__requestTask"]],
  ["Supprime la tâche « Rapport ANPP ».", ["task__deleteTask"]],
  ["Démarre la tâche « préparer le stand ».", ["task__startTask"]],
  ["Soumets le travail de la tâche du stand.", ["task__submitTaskWork"]],
  ["Ajoute un commentaire à la tâche : stand réservé.", ["task__addTaskComment"]],
  ["Réattribue la demande de tâche à Walid.", ["task__reattribuerDemandeTache"]],
  ["Crée un rappel pour vendredi : appeler l'agence.", ["reminder__createReminder"]],
  ["Reporte le rappel à lundi.", ["reminder__snoozeReminder"]],
  ["Crée un rendez-vous dans mon agenda jeudi à 10 h avec Karim.", ["calendar__createCalendarEvent", "preparer_rendez_vous"]],
  ["Supprime le rendez-vous de jeudi.", ["calendar__deleteCalendarEvent"]],
  ["Accepte l'invitation à la réunion de lundi.", ["calendar__respondToInvite", "meeting__respondToMeetingInvite"]],
  ["Crée une réunion d'équipe mardi.", ["meeting__createMeeting", "calendar__createCalendarEvent"]],
  ["Résume la réunion d'hier.", ["meeting__summarizeMeeting"]],
  ["Crée une demande de support : l'imprimante ne marche pas.", ["support__createSupportRequest"]],
  ["Envoie un retour sur l'application : bouton manquant.", ["feedback__submitFeedback"]],
  ["Marque toutes mes notifications comme lues.", ["notification__markAllNotificationsRead"]],
];

suite("Sélection sur tout l'ERP (J6) — 300 demandes, droits, jetons", () => {
  beforeAll(async () => {
    sa = await compte("sa", "SUPER_ADMIN");
    ad = await compte("ad", "DIRECTION_ASSISTANT");
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("300 demandes, chaque outil attendu existe au catalogue du Super Admin, toutes les familles", () => {
    expect(CORPUS_ERP).toHaveLength(300);
    const noms = new Set(fichesOffertes(catalogue(sa), sa).map((f) => f.nom));
    for (const [d, attendus] of CORPUS_ERP) expect(attendus.some((a) => noms.has(a)), `${d} → ${attendus.join("|")}`).toBe(true);
    expect(noms.size).toBeGreaterThan(900);
  });

  it("RAPPEL@5 ≥ 95 % : l'outil juste est dans les 5 premiers de `trouver_outil` (Super Admin, tout l'ERP)", () => {
    const index = indexer(fichesOffertes(catalogue(sa), sa));
    const rates = CORPUS_ERP.filter(([d, attendus]) => !classer(d, index, 5).some((c) => attendus.includes(c.nom)));
    const rappel = 1 - rates.length / CORPUS_ERP.length;
    console.info(`[J6] rappel@5 = ${(rappel * 100).toFixed(1)} % (${CORPUS_ERP.length - rates.length}/${CORPUS_ERP.length}) ; ratés : ${rates.map(([d, a]) => `${d} → ${a[0]} ⇐ ${classer(d, index, 5).map((c) => c.nom).join(", ")}`).join(" | ")}`);
    expect(rappel, `rappel@5 = ${(rappel * 100).toFixed(1)} % ; ratés :\n${rates.map(([d, a]) => `  ${d} → ${a.join("|")} ; rendu : ${classer(d, index, 5).map((c) => c.nom).join(", ")}`).join("\n")}`).toBeGreaterThanOrEqual(0.95);
  });

  it("JAMAIS HORS DROITS : l'assistante de direction ne se voit ni présélectionner ni trouver une capacité fermée à son écran", async () => {
    const outils = catalogue(ad);
    const permis = new Set(fichesOffertes(outils, ad).map((f) => f.nom));
    const fermees = fichesOffertes(catalogue(sa), sa).map((f) => f.nom).filter((n) => !permis.has(n));
    expect(fermees.length).toBeGreaterThan(100);
    for (const [demande] of CORPUS_ERP) {
      const s = selectionDuTour(outils, ad, demande);
      expect(s.initiaux.filter((n) => n !== OUTIL_TROUVER && !permis.has(n)), demande).toEqual([]);
      const r = JSON.parse(await s.outil.run({ intention: demande }, ad)) as { trouves: { outil: string }[] };
      expect(r.trouves.map((t) => t.outil).filter((n) => !permis.has(n)), demande).toEqual([]);
    }
    // Et la porte vient de l'écran : chaque capacité offerte a l'un de ses modules ouvert à la personne.
    const { userCan } = await import("@/lib/rbac");
    for (const c of registreDesCapacites().capacites.filter((x) => x.source === "action" && permis.has(x.outil))) {
      expect(c.modules.some((m) => userCan(ad, m as never, (c.verbe ?? "VIEW") as never)), c.id).toBe(true);
    }
  });

  it("≤ 4 000 JETONS FIXES d'outils par étape : socle + présélection + `trouver_outil`, sur les 300 demandes", () => {
    const outils = catalogue(sa);
    const parNom = new Map(outils.map((o) => [o.def.name, o]));
    // Calibré sur la mesure du banc J4 (décision 0018) : les 65 outils d'avant pesaient ~18 700 jetons d'entrée.
    const jetons = (noms: string[]) => Math.ceil(noms.reduce((s, n) => s + JSON.stringify(parNom.get(n)?.def ?? {}).length, 0) / 3.2);
    let pire = 0;
    let pireDemande = "";
    for (const [demande] of CORPUS_ERP) {
      const s = selectionDuTour(outils, sa, demande);
      expect(s.initiaux.length, demande).toBeLessThanOrEqual(SOCLE_OUTILS.length + PRESELECTION_MAX + 1);
      const j = jetons([...s.initiaux, OUTIL_TROUVER]);
      if (j > pire) { pire = j; pireDemande = demande; }
    }
    console.info(`[J6] pire étape : ${pire} jetons fixes d'outils (« ${pireDemande} »)`);
    expect(pire, `pire étape : ${pire} jetons (« ${pireDemande} »)`).toBeLessThanOrEqual(4000);
  });
});
