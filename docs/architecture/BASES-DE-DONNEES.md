# Bases de données — le catalogue (lot D1, 02/11/2026)

> **Demande de la Direction (02/11/2026)** : « pourquoi ne pas avoir aussi un accès par database ? Est-ce que tu
> pourrais lister les databases qu'on a et les tables […] ». Ce document est la **liste**. La proposition d'accès
> par base est dans [ACCES-PAR-BASE.md](ACCES-PAR-BASE.md) ; le résumé d'une page dans
> [BASES-RESUME-DIRECTION.md](BASES-RESUME-DIRECTION.md).

## Ce qu'est une « base » ici

L'ERP n'a **qu'une seule base PostgreSQL** (`prisma/schema.prisma` : **515 tables**, 226 listes de valeurs). Ce que la
Direction appelle « une database » est une **famille de tables d'un même métier** — la paie, le réglementaire, les
annuaires… Nous en avons rangé **29** : **24 bases métier** (381 tables) et **5 bases techniques** (134 tables :
comptes et droits, Assistant IA, journaux, plateforme).

**Règle de rangement — le contenu suit sa base.** Une table technique qui porte le contenu d'un métier (le cache des
appels IA du réglementaire, les morceaux d'un dépôt réglementaire, le journal du Regulatory Intelligence OS) reste
dans la base de ce métier : fermer une base doit fermer aussi ses copies. Les bases techniques ne rangent que ce qui ne
porte le contenu d'aucun métier, ou le porte pour **tous** (journal d'audit, corbeille, base de connaissances de l'IA) —
c'est pourquoi certaines y sont classées « secret ».

## Les quatre niveaux de sensibilité

| Niveau | Ce que cela veut dire | Exemples |
|---|---|---|
| **Public interne** | Tout collaborateur peut le savoir ; parfois déjà public | site web, wilayas, fiche produit |
| **Restreint** | Réservé à ceux dont c'est le métier | stocks, réglementaire, visites médicales |
| **Confidentiel** | Données personnelles ou stratégiques ; une fuite nuit | dossiers RH, budgets, contrats, courriels, conversations avec l'assistant |
| **Secret** | Une fuite expose une personne ou l'entreprise | salaires, IBAN/RIB, NIN, n° CNAS, données de santé, évaluations, mots de passe et jetons, journal d'audit |

Le niveau d'une base est celui de la **plupart** de ses tables ; une table plus sensible le dit (« jusqu'à secret »).
Décompte : **35 tables secrètes**, 188 confidentielles, 279 restreintes, 13 public interne.

## Comment ce catalogue est vérifié

- **Rangement** : à la main, table par table, dans `scripts/bases-de-donnees/*.ts` (base, libellé français,
  sensibilité, raison quand une table dépasse sa base), en partant de la carte des domaines de la base de connaissances
  (`docs/knowledge-base/03-data-model-and-migrations.md`, 433 tables au 24/10) complétée des 82 tables apparues depuis.
- **Qui écrit chaque table** : mesuré, pas déclaré — le contrat des actions (`src/lib/actions/contrat.genere.json`,
  champ `modelesEcrits`) donne les fichiers d'actions qui écrivent chaque table. **341 tables sur 515** ont au moins un
  écrivain dans le contrat ; les 174 autres sont écrites par l'Assistant IA, les tâches de fond, les routes d'API, les
  imports ou les migrations (l'IA, la plateforme et le réglementaire surtout) — la colonne affiche alors « — ».
- **Qui lit aujourd'hui** : la ligne « Lecture par défaut » est **calculée** depuis la matrice des rôles
  (`src/lib/rbac/permissions.ts`) : les rôles qui ont `VIEW` (pour la paie : `UPDATE` sur RH, ce qu'exige l'écran de paie)
  sur au moins un module de la base. Elle ne compte **pas** les surcharges individuelles (`UserAccess`, Administration ›
  Accès), qui ouvrent ou ferment module par module pour une personne.
- **Le cliquet** : `src/platform/bases-de-donnees.test.ts` (dans `npm test`) échoue si une table du schéma n'est
  rangée nulle part, l'est deux fois, ou a disparu ; si une colonne copiée au coffre (IBAN, RIB, NIN, salaire) vit dans
  une table qui n'est pas « secret » ; si un module ou une famille de l'assistant cité n'existe pas.

**Ajouter une table** : la ranger dans le bon fichier de `scripts/bases-de-donnees/`, puis `npm run bases:generer`
(régénère `bases-de-donnees.json` et la partie générée ci-dessous). Ne jamais éditer la partie générée à la main.

## Les mécanismes d'accès d'aujourd'hui (rappel)

Une lecture, aujourd'hui, est bornée par une **superposition** de mécanismes, tous **par module ou par ligne**, aucun
par base :

1. **Modules RBAC** — 71 modules × 7 gestes (voir, créer, modifier, supprimer, valider, exporter, déposer), une matrice
   par rôle (`src/lib/rbac/permissions.ts`), surchargée personne par personne (`UserAccess`, avec une portée
   `ASSIGNED` / `ALL` et des sections), console Administration › Accès.
2. **Périmètre d'entité** — `UserCompanyAccess` : les sociétés du groupe qu'une personne voit.
3. **Accès ligne à ligne** — `RowGrant` (un dossier, une fiche précise), et les règles propres d'un métier (membres d'une
   conversation, lecteurs d'un document légal, siège au centre de paiement, accès à un annuaire, au budget de son
   département, stock promotionnel par équipe…).
4. **Assistant IA** — neuf familles (`AssistantIaAcces`) par rôle ou par personne ; les familles sensibles (salaires,
   contrats RH) fermées par défaut et ouvertes **nominativement** sur autrui, par avenant (`AvenantContrat`,
   `DELEGATION`) ou droit daté (`AssistantIaDroitDate`) — décision 0048 (S1).
5. **Coffre** — IBAN, RIB, NIN, salaires copiés chiffrés (`DonneeSensible`) ; la lecture en clair passe par la politique
   du coffre et est journalisée (`AccesDonneeSensible`) ; aucun modèle d'IA ne le lit jamais.

<!-- BASES:DEBUT -->
_Généré par `npm run bases:generer` — 517 tables, 29 bases. Ne pas éditer à la main._

### Bases métier (381 tables)

| Base | Tables | Sensibilité | Modules qui l'ouvrent aujourd'hui |
|---|---:|---|---|
| Personnel & dossiers RH (`personnel`) | 8 | Confidentiel (jusqu'à secret) | Ressources humaines, Employés, Demandes RH, Formations, Mon Équipe |
| Paie & rémunérations (`paie`) | 3 | Secret | Ressources humaines |
| Recrutement (`recrutement`) | 8 | Confidentiel (jusqu'à secret) | Recrutement |
| Finances, paiements & trésorerie (`finances`) | 12 | Confidentiel (jusqu'à secret) | Finances, Centre de paiement |
| Budgets & caisses (`budgets`) | 19 | Confidentiel | Budgets, Budget Marketing, Budget Regulatory, Budget Operations & Sales, Campagne budgétaire |
| Juridique, contrats & courriers (`juridique`) | 8 | Confidentiel | Legal, Courriers, Bons de commande |
| Sociétés du groupe & organisation interne (`societes`) | 5 | Restreint (jusqu'à secret) | Administration, Business Units |
| Coffre des données sensibles (`coffre`) | 2 | Secret | Administration |
| Annuaires, personnes & organisations (`annuaires`) | 20 | Restreint (jusqu'à secret) | Annuaires |
| Ad & Pro, congrès & événements (`ad-pro`) | 36 | Confidentiel | Sponsoring, Prises en charge Internationales, Prises en charge Nationales, Événements, Consulting, Ad & Pro — autres demandes, Centre de validation Ad & Pro |
| Matériel promotionnel (`materiel-promo`) | 19 | Restreint | Matériel promotionnel, Stock promotionnel, Catalogue promotionnel |
| Réglementaire (`reglementaire`) | 44 | Restreint | Regulatory, Pipeline réglementaire |
| Produits & gammes (`produits`) | 6 | Public interne (jusqu'à restreint) | Produits, Explorateur produits |
| Développement & études de marché (`developpement`) | 9 | Confidentiel | Market Intelligence, Projets |
| Marchés publics, ventes & logistique (`ventes`) | 20 | Restreint | Marchés PCH, Ventes PCH, Ventes, Logistique |
| Stocks (`stocks`) | 10 | Restreint | Stocks PCH |
| Force de vente, médecins & segmentation (`terrain`) | 44 | Restreint (jusqu'à confidentiel) | Promotion médicale, Rapports terrain, Prévisions & Force de vente, Segmentation Studio, Segmentation — potentiel forcé à la main, Consumption Intelligence, Marketing cockpit |
| Information médicale & pharmacovigilance (`info-medicale`) | 5 | Confidentiel (jusqu'à secret) | Information médicale, Pharmacovigilance |
| Drive & documents (`documents`) | 27 | Restreint (jusqu'à confidentiel) | Drive, Documents |
| Messagerie, courriels & agenda (`communication`) | 22 | Confidentiel | Messagerie, Espace de travail, Notifications |
| Tâches, demandes internes & validations (`travail`) | 19 | Restreint | Espace de travail, Directives, Demandes de support, Sujets, Demandes de validations, Centre de validations |
| Moyens généraux & demandes administratives (`moyens-generaux`) | 9 | Restreint | Bureau du secrétariat, Moyens généraux |
| Pilotage, KPI & intelligence de direction (`pilotage`) | 20 | Confidentiel (jusqu'à secret) | KPI & bilans, Adventum Brain, Process Intelligence, Cockpit Opérations, My Chief of Staff |
| Site web public (`site-web`) | 6 | Public interne | Site web |

### Bases techniques (136 tables)

| Base | Tables | Sensibilité | Modules qui l'ouvrent aujourd'hui |
|---|---:|---|---|
| Comptes, connexions & droits d'accès (`comptes-et-droits`) | 19 | Secret | Administration |
| Assistant IA — conversations, notes & mémoire personnelles (`ia-conversations`) | 31 | Confidentiel | Assistant IA, My Chief of Staff |
| IA — moteur, missions, connaissances & réglages (`ia-moteur`) | 56 | Restreint (jusqu'à confidentiel) | Administration, Assistant IA, Recettes |
| Journaux & traçabilité (`journaux`) | 8 | Confidentiel (jusqu'à secret) | Administration |
| Plateforme, réglages, files & intégrations (`plateforme`) | 22 | Restreint (jusqu'à secret) | Administration, Feedback |

### Détail, base par base

#### Personnel & dossiers RH — `personnel` (8 tables, confidentiel)

Qui travaille chez nous, à quel poste, sous quel contrat, avec quels congés, formations et pièces RH.

- **Écrite par** : Ressources humaines (`src/modules/rh/`, écrans RH, Mon espace, Mon équipe)
- **Modules** : Ressources humaines (`RH`), Employés (`EMPLOYEES`), Demandes RH (`HR_REQUESTS`), Formations (`TRAINING`), Mon Équipe (`MY_TEAM`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général
- **Assistant IA** (familles) : FICHES, CONTRATS_RH
- Périmètre d'entité (`UserCompanyAccess`) : une fiche ne se lit que dans les sociétés permises
- Portée du module (`ASSIGNED` / `ALL`) et accès ligne à ligne (`RowGrant`, type EMPLOYEE / LEAVE_REQUEST)
- Mon dossier : chacun lit SA fiche liée (`Employee.userId`), jamais celle d'autrui
- Coffre : IBAN, NIN et salaires de la fiche ne se lisent en clair que par la porte de lecture du coffre (journalisée)
- Assistant : FICHES suit les droits ; CONTRATS_RH fermée par défaut, ouverte nominativement (avenant `DELEGATION`, droit daté)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Employee` | Fiche salarié | Secret — IBAN, NIN, n° CNAS, date de naissance, salaires (base, brut, net, coût employeur) | assistant-actions, custom-field-actions, department-actions, finance-actions +6 |
| `EmployeeDocument` | Pièce du dossier RH (contrat, attestation, fiche de paie) | Secret — contrats et fiches de paie en pièce jointe | hr-document-actions, payroll-hr-actions |
| `AvenantContrat` | Avenant au contrat (fonction, délégation, entité) | Secret — les délégations ouvrent la paie d'autrui à l'assistant (S1) | assistant-ia-consommation-actions |
| `HrDocumentRequest` | Demande de document RH | Confidentiel | assistant-actions, hr-document-actions, mission-actions |
| `LeaveRequest` | Demande de congé | Confidentiel | custom-field-actions, hr-actions, stand-in-actions |
| `LeaveEscalation` | Relance d'une demande de congé | Confidentiel | hr-actions |
| `Training` | Formation | Confidentiel | training-actions |
| `TrainingParticipant` | Participant à une formation | Confidentiel | training-actions |

#### Paie & rémunérations — `paie` (3 tables, secret)

Ce que chaque salarié gagne, mois par mois, les virements de paie et les avances sur salaire.

- **Écrite par** : Ressources humaines — paie (`src/modules/rh/actions-paie.ts`, écran RH › Paie)
- **Modules** : Ressources humaines (`RH`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général
- **Assistant IA** (familles) : SALAIRES
- Écran et actions de paie : module RH en MODIFICATION (`userCan(user, "RH", "UPDATE")`), pas la simple lecture
- Périmètre d'entité (`UserCompanyAccess`)
- Chacun voit SA paie (Mon dossier) ; autrui seulement par droit RH réel, avenant `DELEGATION` ou droit daté (S1, décision 0048)
- Assistant : SALAIRES fermée par défaut, jamais ouverte sur autrui par un réglage de rôle ; filtre de confidentialité avant tout modèle

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `PayrollEntry` | Ligne de paie mensuelle d'un salarié | Secret | finance-actions, payroll-hr-actions |
| `PayrollWire` | Virement de paie groupé | Secret | expense-actions, payroll-hr-actions |
| `SalaryAdvance` | Avance sur salaire | Secret | custom-field-actions, expense-actions, hr-actions |

#### Recrutement — `recrutement` (8 tables, confidentiel)

Les postes ouverts, leurs approbations, les candidats et leurs candidatures (dont celles reçues par le site).

- **Écrite par** : Recrutement (`src/lib/recruitment/`, écran Recrutement) ; le site web dépose les candidatures
- **Modules** : Recrutement (`RECRUITMENT`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général
- **Assistant IA** (familles) : FICHES
- Suiveurs d'une demande (`RecruitmentFollower`) et approbateurs nommés
- Portée du module (`ASSIGNED` / `ALL`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `RecruitmentRequest` | Demande de recrutement | Secret — fourchette de salaire du poste (`salaryMin`, `salaryMax`) | recruitment-actions |
| `RecruitmentApproval` | Approbation d'une demande de recrutement | Confidentiel | recruitment-actions |
| `RecruitmentInfoRequest` | Demande de complément sur un recrutement | Confidentiel | recruitment-actions |
| `RecruitmentCandidate` | Candidat | Confidentiel | candidatures-site-actions, recruitment-actions |
| `RecruitmentFollower` | Suiveur d'une demande de recrutement | Confidentiel | recruitment-actions |
| `RecruitmentChannelPost` | Diffusion d'une offre sur un canal | Confidentiel | recrutement-diffusion-actions |
| `JobPosting` | Offre d'emploi | Confidentiel | offres-emploi-actions, recrutement-diffusion-actions |
| `SiteCandidature` | Candidature reçue par le site web | Confidentiel | candidatures-site-actions |

#### Finances, paiements & trésorerie — `finances` (12 tables, confidentiel)

Les demandes de paiement, ordres de dépense, mouvements, comptes de trésorerie et le centre de paiement.

- **Écrite par** : Finances (`src/modules/finances/`, écrans Finances, Centre de paiement, Demandes de paiement)
- **Modules** : Finances (`FINANCES`), Centre de paiement (`PAYMENT_CENTRE`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Responsable Finance / Budget
- **Assistant IA** (familles) : BUDGETS
- Centre de paiement : siège réservé (`PaymentCentreSeat`, règle `sitsOnPaymentCentre`)
- Seuils de paiement (`PaymentThreshold`) : qui signe au-delà de quel montant
- Périmètre d'entité (`UserCompanyAccess`) ; accès ligne à ligne (`RowGrant`, FINANCE_TRANSACTION / EXPENSE_ORDER)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `PaymentRequest` | Demande de paiement | Confidentiel | expense-actions, medical-info-actions, payment-request-actions |
| `PaymentPiece` | Pièce d'une demande de paiement | Confidentiel | medical-info-actions, payment-request-actions |
| `PaymentRequestEvent` | Événement d'une demande de paiement | Confidentiel | ad-pro-item-actions, budget-depense-poste-actions, expense-actions, invoice-actions +3 |
| `ExpenseOrder` | Ordre de dépense | Confidentiel | ad-pro-item-actions, admin-request-actions, budget-depense-poste-actions, budget-envelope-actions +18 |
| `FinanceTransaction` | Mouvement financier (encaissement, décaissement) | Confidentiel | budget-depense-poste-actions, budget-envelope-actions, budget-pole-actions, custom-field-actions +7 |
| `TreasuryAccount` | Compte de trésorerie (banque, caisse) | Secret — banque et RIB des comptes de la société | actualisation-soldes-actions, finance-actions |
| `DemandeActualisationSoldes` | Demande d'actualisation des soldes | Confidentiel | actualisation-soldes-actions, finance-actions |
| `LigneActualisationSoldes` | Solde déclaré pour un compte | Confidentiel | actualisation-soldes-actions |
| `PaymentCentreSeat` | Siège au centre de paiement | Confidentiel | payment-centre-seat-actions |
| `PaymentCentreMessage` | Message du centre de paiement | Confidentiel | congress-request-actions, payment-centre-actions, payment-request-actions, relance-paiement-actions |
| `PaymentThreshold` | Seuil de signature d'un paiement | Confidentiel | — |
| `DocumentRequest` | Demande de pièce justificative | Confidentiel | document-request-actions, hr-document-actions, reservation-fiche-actions |

#### Budgets & caisses — `budgets` (19 tables, confidentiel)

Les enveloppes, lignes et campagnes budgétaires, les budgets de département et les caisses d'avance.

- **Écrite par** : Budgets (`src/lib/budget/`, écrans Budgets, Campagne budgétaire, Budget marketing / réglementaire / opérations)
- **Modules** : Budgets (`BUDGETS`), Budget Marketing (`BUDGET_MARKETING`), Budget Regulatory (`BUDGET_REGULATORY`), Budget Operations & Sales (`BUDGET_OPERATIONS`), Campagne budgétaire (`BUDGET_CAMPAIGN`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Direction Marketing, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Direction Marketing, Responsable Finance / Budget
- **Assistant IA** (familles) : BUDGETS
- Accès d'un responsable à SON budget de département (`DepartmentBudgetAccess`)
- Caisse d'avance : titulaire du plan (`PettyCashPlan`)
- Périmètre d'entité (`UserCompanyAccess`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `BudgetLine` | Ligne budgétaire | Confidentiel | budget-actions, custom-field-actions |
| `BudgetEnvelope` | Enveloppe budgétaire | Confidentiel | budget-campagne-actions, budget-envelope-actions, budget-pole-actions |
| `BudgetCategoryLine` | Ligne par catégorie budgétaire | Confidentiel | budget-campagne-actions, budget-envelope-actions, budget-pole-actions, integration-adpro-actions +1 |
| `BudgetExpenseLine` | Dépense imputée au budget | Confidentiel | budget-envelope-actions, budget-pole-actions, mission-actions |
| `BudgetCampaign` | Campagne budgétaire | Confidentiel | budget-campagne-actions |
| `BudgetProposal` | Proposition de budget | Confidentiel | budget-campagne-actions |
| `BudgetProposalVersion` | Version d'une proposition de budget | Confidentiel | budget-campagne-actions |
| `BudgetProposalLine` | Ligne d'une proposition de budget | Confidentiel | budget-campagne-actions |
| `BudgetProposalComment` | Commentaire sur une proposition de budget | Confidentiel | budget-campagne-actions |
| `BudgetProposalVote` | Avis sur une proposition de budget | Confidentiel | budget-campagne-actions |
| `DepartmentBudget` | Budget de département | Confidentiel | department-budget-actions |
| `DepartmentBudgetAccess` | Accès d'un responsable au budget de son département | Confidentiel | department-budget-actions |
| `DepartmentBudgetRequest` | Demande sur un budget de département | Confidentiel | department-budget-actions |
| `DepartmentBudgetExpense` | Dépense d'un budget de département | Confidentiel | admin-request-actions, department-budget-actions, natures-moyens-generaux-actions, petty-cash-actions |
| `DepartmentExpenseLine` | Ligne de dépense de département | Confidentiel | department-budget-actions, natures-moyens-generaux-actions, petty-cash-actions |
| `PettyCashPlan` | Plan de caisse d'avance | Confidentiel | petty-cash-actions |
| `PettyCashTopUpRequest` | Demande de réapprovisionnement de caisse | Confidentiel | petty-cash-actions |
| `PettyCashAllotment` | Dotation de caisse d'avance | Confidentiel | expense-actions, payment-centre-actions, petty-cash-actions |
| `CoutRepartitionBu` | Répartition d'un coût entre business units | Confidentiel | repartition-couts-actions |

#### Juridique, contrats & courriers — `juridique` (8 tables, confidentiel)

Les contrats, bons de commande, factures et devis (documents légaux) et le registre des courriers entrants et sortants.

- **Écrite par** : Juridique (`src/lib/legal/`, écran Legal), Bons de commande, Registre des courriers (`src/lib/mail-register/`)
- **Modules** : Legal (`LEGAL`), Courriers (`MAIL_REGISTER`), Bons de commande (`PURCHASE_ORDERS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Finance / Budget, Assistante de Direction
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Finance / Budget, Assistante de Direction
- **Assistant IA** (familles) : AD_PRO
- Lecteurs nommés d'un document légal (`LegalDocumentReader`)
- Signataires et lecteurs des bons de commande (gestes `BC_SIGNATAIRE` / `BC_LECTEUR`)
- Périmètre d'entité (`UserCompanyAccess`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `LegalDocument` | Document légal (contrat, bon de commande, facture, devis, avoir) | Confidentiel | ad-pro-item-actions, ad-pro-rattacher-legal, bc-signature-actions, budget-depense-poste-actions +9 |
| `LegalFolder` | Dossier juridique | Confidentiel | legal-folder-actions |
| `LegalDocumentReader` | Lecteur autorisé d'un document légal | Confidentiel | legal-actions |
| `BcBrouillonVersion` | Version du brouillon d'un bon de commande | Confidentiel | ad-pro-item-actions |
| `MailPartner` | Correspondant du registre des courriers | Confidentiel | mail-partner-actions |
| `MailEntry` | Courrier enregistré (arrivée / départ) | Confidentiel | mail-folder-actions, mail-register-actions |
| `MailEntryPiece` | Pièce d'un courrier | Confidentiel | mail-piece-actions |
| `MailEntryFolder` | Classeur du registre des courriers | Confidentiel | mail-folder-actions |

#### Sociétés du groupe & organisation interne — `societes` (5 tables, restreint)

Les entités du groupe (Adventum, Pharmagène…), leur identité légale, leurs départements, business units et délégations de pouvoir.

- **Écrite par** : Administration (Sociétés, Organigramme) et Business units
- **Modules** : Administration (`ADMIN`), Business Units (`BUSINESS_UNITS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale
- La liste des sociétés est lue partout (choix d'entité) ; sa modification est réservée à l'Administration
- Coffre : le RIB et l'IBAN de la société ne se lisent en clair que par la porte de lecture du coffre

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Company` | Société du groupe (entité) | Restreint | company-actions |
| `CompanyLegalIdentity` | Identité légale d'une société (NIF, RC, banque) | Secret — banque, agence, RIB et IBAN de la société | company-identity-actions |
| `Department` | Département | Restreint | department-actions, org-coherence-actions, sales-planning-actions |
| `BusinessUnit` | Business unit | Restreint | org-coherence-actions, sales-planning-actions |
| `AuthorityHolder` | Titulaire d'un pouvoir (signature, délégation) | Restreint | — |

#### Coffre des données sensibles — `coffre` (2 tables, secret)

La copie chiffrée des IBAN, RIB, NIN et salaires, et le journal de qui les a lus, quand et pourquoi.

- **Écrite par** : Module Coffre (`src/modules/coffre/`) — double écriture depuis chaque écrivain d'une colonne sensible
- **Modules** : Administration (`ADMIN`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin
- **Écriture par défaut** : Super Admin
- Chiffrement AES-256-GCM avec une clé dédiée ; la lecture en clair passe par la politique `peutLire` et est journalisée
- Deux portes serveur : l'écriture (`api.ts`) ne déchiffre jamais ; la lecture (`api-lecture.ts`) est interdite à l'assistant (test de frontière)
- Interrupteurs `coffreEcriture` / `coffreLecture` réservés au Super Admin
- Aucun modèle d'IA ne lit jamais le coffre (décision de la Direction ; `ia-jamais.test.ts`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `DonneeSensible` | Donnée sensible chiffrée (IBAN, RIB, NIN, salaire) | Secret | — |
| `AccesDonneeSensible` | Journal des lectures d'une donnée sensible | Secret | — |

#### Annuaires, personnes & organisations — `annuaires` (20 tables, restreint)

Le référentiel unique des personnes et organisations réelles (médecins, fournisseurs, partenaires), leurs adresses et contacts, et les annuaires.

- **Écrite par** : Référentiels (`src/modules/referentiels/`, `src/modules/lieux/`) et Annuaires (`src/lib/directory/`)
- **Modules** : Annuaires (`DIRECTORIES`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin
- **Écriture par défaut** : Super Admin
- Accès par annuaire (`MedicalDirectoryAccess`) et sections du module Annuaires (`UserAccess.sections`)
- L'extraction du registre complet par l'assistant se juge sur le droit RÉEL de la personne (S1, `directory_list`)
- Coffre : le RIB d'un partenaire ne se lit en clair que par la porte de lecture du coffre

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Personne` | Personne réelle (référentiel unique) | Confidentiel — date de naissance et identité civile | — |
| `PersonneRole` | Rôle daté d'une personne | Restreint | — |
| `DoublonPersonne` | Doublon de personne proposé | Restreint | — |
| `Organisation` | Organisation réelle (référentiel unique) | Restreint | organisation-actions |
| `OrganisationRole` | Rôle daté d'une organisation | Restreint | — |
| `OrganisationIdentifiant` | Identifiant officiel d'une organisation (NIF, RC…) | Restreint | — |
| `PropositionDoublonOrganisation` | Doublon d'organisation proposé | Restreint | organisation-actions |
| `Affiliation` | Rattachement d'une personne à une organisation | Restreint | — |
| `Adresse` | Adresse d'une personne ou d'une organisation | Restreint | — |
| `PointDeContact` | Téléphone ou courriel d'une personne ou d'une organisation | Restreint | — |
| `Wilaya` | Wilaya (découpage administratif officiel) | Public interne — donnée officielle publique | — |
| `Commune` | Commune (découpage administratif officiel) | Public interne — donnée officielle publique | — |
| `MedicalDirectory` | Annuaire | Restreint | medical-directory-crud-actions, segmentation-actions |
| `MedicalDirectoryColumn` | Colonne d'un annuaire | Restreint | medical-directory-crud-actions |
| `MedicalDirectoryAccess` | Accès d'une personne à un annuaire | Restreint | medical-directory-crud-actions |
| `DirectoryEntry` | Entrée d'annuaire | Restreint | directory-actions |
| `DirectoryCellStyle` | Mise en forme d'une cellule d'annuaire | Restreint | annuaire-couleurs-actions |
| `DirectoryEndpoint` | Point de diffusion d'un annuaire | Restreint | directory-actions |
| `CompanyContact` | Contact d'un partenaire | Secret — RIB du partenaire (copié au coffre) | company-contact-actions |
| `Supplier` | Fournisseur | Restreint | fournisseurs-annuaire-actions, regulatory-actions, supplier-actions |

#### Ad & Pro, congrès & événements — `ad-pro` (36 tables, confidentiel)

Les dépenses de promotion auprès des professionnels de santé : sponsoring, congrès, prises en charge, voyages, devis et événements.

- **Écrite par** : Ad & Pro (`src/modules/ad-pro/`, écrans Ad & Pro, Congrès, Sponsoring, Événements, Centre de validation Ad & Pro)
- **Modules** : Sponsoring (`SPONSORING`), Prises en charge Internationales (`CONGRESS_INTERNATIONAL`), Prises en charge Nationales (`CONGRESS_NATIONAL`), Événements (`EVENTS`), Consulting (`CONSULTING`), Ad & Pro — autres demandes (`AD_PRO_OTHER`), Centre de validation Ad & Pro (`AD_PRO_CENTRE`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Responsable Finance / Budget, Pharmacien resp. information médicale
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing
- **Assistant IA** (familles) : AD_PRO
- Visas de porte (`AdProGateVisa`) et porte du DG sur le total d'une demande (`AdProPorteDg`)
- Référents marketing par business unit (`BusinessUnitMarketingReferent`)
- Portée du module et accès ligne à ligne (`RowGrant`, SPONSORING / CONGRESS_*)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AdProItem` | Demande Ad & Pro | Confidentiel | ad-pro-item-actions, budget-depense-poste-actions, document-request-actions, integration-adpro-actions |
| `AdProItemPiece` | Pièce d'une demande Ad & Pro | Confidentiel | ad-pro-item-actions, budget-depense-poste-actions |
| `AdProItemDecision` | Décision sur une demande Ad & Pro | Confidentiel | — |
| `AdProVoyageur` | Voyageur d'une demande Ad & Pro | Confidentiel | ad-pro-item-actions |
| `AdProVoyageurDevis` | Devis de voyage d'un voyageur | Confidentiel | ad-pro-item-actions |
| `AdProHebergement` | Hébergement d'une demande Ad & Pro | Confidentiel | ad-pro-item-actions |
| `AdProMedecin` | Médecin bénéficiaire d'une demande Ad & Pro | Confidentiel | ad-pro-medecins-actions |
| `AdProDevis` | Devis Ad & Pro | Confidentiel | ad-pro-item-actions |
| `AdProDevisLigne` | Ligne d'un devis Ad & Pro | Confidentiel | ad-pro-item-actions |
| `AdProGateVisa` | Visa d'une porte Ad & Pro | Confidentiel | ad-pro-centre-actions, ad-pro-edit-actions, ad-pro-item-actions, ad-pro-other-actions +5 |
| `AdProPorteDg` | Porte du DG sur le total d'une demande | Confidentiel | ad-pro-item-actions, care-actions, porte-dg-actions |
| `AdProIntegrationLot` | Lot d'intégration budgétaire Ad & Pro | Confidentiel | integration-adpro-actions |
| `AdProIntegrationDemande` | Demande intégrée au budget | Confidentiel | integration-adpro-actions, rapprochement-adpro-actions |
| `AdProIntegrationDecision` | Décision d'intégration budgétaire | Confidentiel | integration-adpro-actions |
| `AdProRapprochement` | Rapprochement Ad & Pro / budget | Confidentiel | rapprochement-adpro-actions |
| `AdProRapprochementLecture` | Lecture d'un rapprochement | Confidentiel | rapprochement-adpro-actions |
| `AdProOtherRequest` | Autre demande Ad & Pro | Confidentiel | ad-pro-centre-actions, ad-pro-other-actions, workflow-actions |
| `AdProProductAllocation` | Répartition d'une demande par produit | Confidentiel | — |
| `AdProStockLine` | Ligne de stock consommée par une demande | Confidentiel | ad-pro-item-actions |
| `DemandeReservation` | Demande de réservation (voyage, hôtel) | Confidentiel | ad-pro-item-actions, care-actions, reservation-fiche-actions |
| `SponsoringRequest` | Demande de sponsoring | Confidentiel | custom-field-actions, expense-actions, medical-info-actions, sponsoring-actions |
| `CongressInternational` | Congrès international | Confidentiel | care-actions, congress-request-actions, custom-field-actions, medical-info-actions +1 |
| `CongressNational` | Congrès national | Confidentiel | care-actions, congress-request-actions, custom-field-actions, medical-info-actions +1 |
| `CareBeneficiary` | Bénéficiaire d'une prise en charge | Confidentiel | care-actions, congress-beneficiary-actions, congress-request-actions |
| `CareCell` | Cellule de prise en charge | Confidentiel | care-actions, congress-beneficiary-actions, congress-request-actions, reservation-fiche-actions |
| `CareQuote` | Devis de prise en charge | Confidentiel | care-actions, reservation-fiche-actions |
| `CareQuoteCell` | Cellule d'un devis de prise en charge | Confidentiel | — |
| `CareGroupPoste` | Poste d'un groupe de prise en charge | Confidentiel | care-actions |
| `ConsultingContract` | Contrat de consulting | Confidentiel | ad-pro-centre-actions, consulting-actions |
| `ConsultingTask` | Tâche de consulting | Confidentiel | consulting-actions |
| `BusinessUnitMarketingReferent` | Référent marketing d'une business unit | Confidentiel | sales-planning-actions |
| `Event` | Événement | Confidentiel | event-actions, workflow-actions |
| `EventRegistration` | Inscription à un événement | Confidentiel | event-actions |
| `MissionAssignment` | Mission terrain d'un événement | Confidentiel | hr-document-actions, mission-actions |
| `MissionParticipationVersion` | Version de la participation à une mission | Confidentiel | mission-actions |
| `MissionExpenseLine` | Frais d'une mission terrain | Confidentiel | mission-actions |

#### Matériel promotionnel — `materiel-promo` (19 tables, restreint)

Le matériel promotionnel : catalogue, devis et factures fournisseurs, stock par lot, mouvements, transferts et inventaires.

- **Écrite par** : Matériel promotionnel & stock promo (`src/lib/promo/`, `src/lib/promo-material/`, écrans Stock promotionnel, Catalogue)
- **Modules** : Matériel promotionnel (`PROMO_MATERIAL`), Stock promotionnel (`PROMO_STOCK`), Catalogue promotionnel (`PROMO_CATALOG`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Responsable Finance / Budget
- **Assistant IA** (familles) : AD_PRO
- Règle propre du stock promotionnel (`src/lib/promo/stock-acces.ts`) : quelles équipes voient quel stock

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `PromoMaterial` | Article de matériel promotionnel | Restreint | expense-actions, medical-info-actions, promo-budget-actions, promo-circuit-actions +4 |
| `PromoCatalogueArticle` | Article du catalogue promotionnel | Restreint | promo-catalogue-actions, promo-demande-actions |
| `PromoQuote` | Devis de matériel promotionnel | Restreint | promo-circuit-actions, promo-devis-actions, promo-execution-actions |
| `PromoQuoteLine` | Ligne d'un devis de matériel | Restreint | promo-devis-actions |
| `PromoRequestItem` | Demande de matériel promotionnel | Restreint | promo-demande-actions |
| `PromoRequestItemProduct` | Produit concerné par une demande de matériel | Restreint | promo-demande-actions |
| `PromoFacture` | Facture fournisseur de matériel | Restreint | promo-execution-actions |
| `PromoFactureLigne` | Ligne d'une facture de matériel | Restreint | promo-execution-actions |
| `PromoStockItem` | Article en stock promotionnel | Restreint | promo-execution-actions, promo-stock-actions |
| `PromoStockItemProduct` | Produit associé à un article en stock | Restreint | — |
| `PromoStockLot` | Lot de stock promotionnel | Restreint | promo-execution-actions, promo-stock-actions |
| `PromoStockMovement` | Mouvement de stock promotionnel | Restreint | ad-pro-item-actions, promo-execution-actions, promo-stock-actions |
| `PromoStockTransfer` | Transfert de stock promotionnel | Restreint | promo-stock-actions |
| `PromoStockRequest` | Demande de sortie de stock promotionnel | Restreint | mission-actions, promo-stock-actions |
| `PromoStockComptage` | Inventaire du stock promotionnel | Restreint | promo-comptage-actions |
| `PromoStockComptageLigne` | Ligne d'inventaire | Restreint | promo-comptage-actions |
| `PromoStockComptageRecurrence` | Récurrence d'inventaire | Restreint | promo-comptage-actions |
| `PromoStockAlerte` | Alerte de stock promotionnel | Restreint | — |
| `PromoStockRefonte` | Reprise du stock promotionnel (refonte) | Restreint | promo-comptage-actions |

#### Réglementaire — `reglementaire` (44 tables, restreint)

Les produits enregistrés, dossiers d'AMM et leurs versions, réserves ANPP, sources réglementaires, obligations et études de cas.

- **Écrite par** : Réglementaire (`src/lib/regulatory/`, écrans Regulatory, Pipeline réglementaire, Regulatory Intelligence)
- **Modules** : Regulatory (`REGULATORY`), Pipeline réglementaire (`REGULATORY_PIPELINE`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Responsable Réglementaire, Assistante Réglementaire
- **Assistant IA** (familles) : REGLEMENTAIRE
- Accès par fonctionnalité du Regulatory Intelligence OS (`RegulatoryFeatureAccess`)
- Pipeline réglementaire (droit `REGULATORY_PIPELINE`) ; accès ligne à ligne (`RowGrant`, REGULATORY_PRODUCT / STEP)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `RegulatoryProduct` | Produit enregistré (réglementaire) | Restreint | assistant-actions, custom-field-actions, expense-actions, product-range-actions +4 |
| `RegulatoryVariation` | Variation d'un enregistrement | Restreint | regulatory-actions |
| `RegulatoryUpdateReminder` | Rappel de mise à jour réglementaire | Restreint | regulatory-reminder-actions |
| `RegulatoryStep` | Étape réglementaire | Restreint | regulatory-actions |
| `RegulatoryDossierStep` | Étape d'un dossier réglementaire | Restreint | regulatory-timeline-actions |
| `RegulatoryRequest` | Demande au pôle réglementaire | Restreint | — |
| `RegulatoryRequestMessage` | Message d'une demande réglementaire | Restreint | — |
| `RegulatoryFeatureAccess` | Accès à une fonctionnalité réglementaire | Restreint | — |
| `RegulatoryDossier` | Dossier réglementaire (AMM) | Restreint | — |
| `RegulatoryDossierVersion` | Version d'un dossier réglementaire | Restreint | — |
| `RegulatoryDocument` | Document d'un dossier réglementaire | Restreint | — |
| `RegulatoryExtraction` | Extraction d'un document réglementaire | Restreint | — |
| `RegulatoryFinding` | Constat sur un dossier | Restreint | — |
| `RegulatorySource` | Source réglementaire (texte, guide) | Restreint | — |
| `RegulatorySourceVersion` | Version d'une source réglementaire | Restreint | — |
| `RegulatorySourceSection` | Section d'une source réglementaire | Restreint | — |
| `RegulatoryCorpusApproval` | Approbation d'une source du corpus | Restreint | — |
| `RegulatoryFact` | Fait réglementaire | Restreint | — |
| `RegulatoryFactOccurrence` | Occurrence d'un fait réglementaire | Restreint | — |
| `RegulatoryConflict` | Contradiction entre sources | Restreint | — |
| `RegulatoryAssessment` | Évaluation d'un dossier | Restreint | — |
| `RegulatoryJob` | Traitement réglementaire en file | Restreint | — |
| `RegulatoryAuditLog` | Journal du Regulatory Intelligence OS | Restreint | — |
| `RegulatoryRulePack` | Jeu de règles réglementaires | Restreint | — |
| `RegulatoryRule` | Règle réglementaire | Restreint | — |
| `RegulatoryUploadSession` | Dépôt réglementaire en cours | Restreint | — |
| `RegulatoryUploadPart` | Morceau d'un dépôt réglementaire | Restreint | — |
| `RegulatoryGeneratedDoc` | Document réglementaire généré | Restreint | — |
| `RegulatoryDossierChatMessage` | Échange sur un dossier réglementaire | Restreint | — |
| `RegulatoryReserveCycle` | Cycle de réserves | Restreint | — |
| `RegulatoryReservePoint` | Point de réserve | Restreint | — |
| `RegulatoryAiCall` | Appel IA du réglementaire | Restreint | — |
| `RegulatoryAiBatch` | Lot d'appels IA du réglementaire | Restreint | — |
| `RegulatoryAiCache` | Cache des réponses IA du réglementaire | Restreint | — |
| `AnppReserveBatch` | Lot de réserves ANPP | Restreint | — |
| `AnppReserve` | Réserve ANPP | Restreint | — |
| `AnppDerivedRule` | Règle tirée des réserves ANPP | Restreint | — |
| `RegulatorySimulation` | Simulation réglementaire | Restreint | — |
| `RegulatorySupplierRequest` | Demande au fournisseur (réglementaire) | Restreint | — |
| `RegulatorySupplierQuestion` | Question au fournisseur | Restreint | — |
| `RegulatoryLifecycleEvent` | Événement du cycle de vie d'un produit | Restreint | — |
| `RegulatoryObligation` | Obligation réglementaire | Restreint | — |
| `RegulatoryCaseStudy` | Étude de cas réglementaire | Restreint | — |
| `RegulatoryCaseDoc` | Document d'une étude de cas | Restreint | — |

#### Produits & gammes — `produits` (6 tables, public interne)

Le catalogue des produits du groupe : fiche produit unique, gammes, prix, noms alternatifs et affectations.

- **Écrite par** : Produits 360 (`src/lib/products/`, écrans Produits, Explorateur produits)
- **Modules** : Produits (`PRODUCTS`), Explorateur produits (`PRODUCT_EXPLORER`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Manager Business Development
- Gammes attribuées à une personne (`UserProductRange`) : filtre des écrans terrain et marketing

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Product` | Produit (fiche unique) | Public interne | produit-canonique-actions, regulatory-actions, sales-planning-actions |
| `ProductAlias` | Nom alternatif d'un produit | Public interne | produit-canonique-actions |
| `ProductPrice` | Prix d'un produit | Restreint — prix et conditions commerciales | prix-produit-actions |
| `ProductRange` | Gamme de produits | Public interne | product-range-actions |
| `UserProductRange` | Gamme attribuée à une personne | Public interne | product-range-actions |
| `ProductAssignment` | Affectation d'un produit | Public interne | — |

#### Développement & études de marché — `developpement` (9 tables, confidentiel)

Les opportunités et projets de développement (nouvelles gammes, nouveaux produits) et les études de marché.

- **Écrite par** : Business Development (actions `bd-project-actions`, `market-research-actions` ; écrans Business Development, Projets BD, Études de marché)
- **Modules** : Market Intelligence (`BUSINESS_DEVELOPMENT`), Projets (`BD_PROJECTS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Manager Business Development
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Manager Business Development
- Accès ligne à ligne (`RowGrant`, BD_OPPORTUNITY / BD_PROJECT)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `BusinessDevelopmentOpportunity` | Opportunité de développement | Confidentiel | bd-actions, custom-field-actions |
| `BdProject` | Projet de développement | Confidentiel | bd-project-actions |
| `BdRange` | Gamme d'un projet de développement | Confidentiel | bd-project-actions |
| `BdProduct` | Produit d'un projet de développement | Confidentiel | bd-project-actions, product-catalog-actions |
| `MarketResearch` | Étude de marché | Confidentiel | market-research-actions |
| `MarketResearchRow` | Ligne d'une étude de marché | Confidentiel | market-research-actions |
| `MarketResearchPlayer` | Acteur d'un marché étudié | Confidentiel | market-research-actions |
| `MarketResearchPresentation` | Présentation d'une étude de marché | Confidentiel | market-presentation-actions |
| `MarketResearchPresentationVersion` | Version d'une présentation d'étude | Confidentiel | market-presentation-actions |

#### Marchés publics, ventes & logistique — `ventes` (20 tables, restreint)

Les appels d'offres et commandes de la PCH, les livraisons, réclamations, ventes et imports de ventes.

- **Écrite par** : PCH & ventes (écrans PCH, Ventes PCH, Ventes, Logistique)
- **Modules** : Marchés PCH (`PCH`), Ventes PCH (`PCH_VENTES`), Ventes (`SALES`), Logistique (`LOGISTICS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, National Sales, Direction Marketing, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Ventes, Commercial, Responsable Logistique
- Portée du module et accès ligne à ligne (`RowGrant`, SALE / LOGISTICS)
- Business units attribuées (lignes d'appel d'offres par BU)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `PchTender` | Appel d'offres PCH | Restreint | pch-actions, pch-market-actions |
| `PchTenderLine` | Ligne d'un appel d'offres | Restreint | pch-market-actions, pch-tender-line-actions |
| `PchTenderLineBusinessUnit` | Business unit d'une ligne d'appel d'offres | Restreint | pch-tender-line-actions |
| `PchTenderExtraction` | Lecture automatique d'un appel d'offres | Restreint | pch-tender-line-actions |
| `PchSubmission` | Soumission à un appel d'offres | Restreint | pch-market-actions |
| `PchContractLine` | Ligne d'un marché attribué | Restreint | pch-market-actions |
| `PchOrder` | Commande PCH | Restreint | pch-actions, pch-tender-line-actions |
| `PchOrderLine` | Ligne d'une commande PCH | Restreint | pch-market-actions |
| `PchDelivery` | Livraison PCH | Restreint | pch-market-actions |
| `PchDeliveryLine` | Ligne d'une livraison | Restreint | pch-market-actions |
| `PchReceptionLigne` | Ligne de réception | Restreint | ventes-pch-actions |
| `PchPoste` | Poste PCH | Restreint | ventes-pch-actions |
| `PchEtablissementMemoire` | Établissement connu (rapprochement des ventes) | Restreint | ventes-pch-actions |
| `PchDirectionRegionale` | Direction régionale PCH | Restreint | ventes-pch-actions |
| `PchFournisseurProduit` | Produit d'un fournisseur PCH | Restreint | ventes-pch-actions |
| `PchVenteImport` | Import de ventes PCH | Restreint | ventes-pch-actions |
| `PchVenteLigne` | Ligne de ventes importée | Restreint | ventes-pch-actions |
| `Sale` | Vente | Restreint | custom-field-actions, sales-actions |
| `LogisticsOrder` | Ordre logistique | Restreint | custom-field-actions, logistics-actions |
| `Reclamation` | Réclamation | Restreint | — |

#### Stocks — `stocks` (10 tables, restreint)

Les états de stock datés chez les établissements, les niveaux d'ouverture, mouvements et demandes d'inventaire.

- **Écrite par** : Stocks (écran Stocks, demandes d'inventaire aux établissements)
- **Modules** : Stocks PCH (`STOCKS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Ventes, Commercial, Responsable Logistique, Délégué Médical, National Sales, Responsable Finance / Budget
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Ventes, Responsable Logistique, Délégué Médical, National Sales
- Destinataires nommés d'une demande d'inventaire (`StockCountRequestRecipient`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `StockSnapshot` | État de stock daté | Restreint | demande-stocks-actions, stock-pch-actions, stock-snapshot-actions |
| `StockOpeningLevel` | Niveau de stock d'ouverture | Restreint | — |
| `StockMovement` | Mouvement de stock | Restreint | pch-market-actions |
| `StockAnnex` | Annexe d'un état de stock | Restreint | demande-stocks-actions, medical-actions, stock-snapshot-actions |
| `StockCountRequest` | Demande d'inventaire | Restreint | demande-stocks-actions |
| `StockCountRequestHospital` | Établissement d'une demande d'inventaire | Restreint | demande-stocks-actions |
| `StockCountRequestLine` | Ligne d'une demande d'inventaire | Restreint | demande-stocks-actions |
| `StockCountRequestRecipient` | Destinataire d'une demande d'inventaire | Restreint | demande-stocks-actions |
| `StockRequestRecurrence` | Récurrence d'une demande d'inventaire | Restreint | stock-recurrence-actions |
| `StockRequestRecurrenceHospital` | Établissement d'une récurrence d'inventaire | Restreint | stock-recurrence-actions |

#### Force de vente, médecins & segmentation — `terrain` (44 tables, restreint)

Les médecins et établissements visités, les visites, plans de tournée, secteurs, rapports terrain, coaching, segmentation et consommation.

- **Écrite par** : Promotion médicale & segmentation (`src/lib/medical/`, `src/modules/consommation/`, écrans Médical, Rapports terrain, Planification, Segmentation, Consommation)
- **Modules** : Promotion médicale (`MEDICAL`), Rapports terrain (`FIELD_REPORTS`), Prévisions & Force de vente (`SALES_PLANNING`), Segmentation Studio (`SEGMENTATION`), Segmentation — potentiel forcé à la main (`SEGMENTATION_POTENTIEL`), Consumption Intelligence (`CONSUMPTION`), Marketing cockpit (`MARKETING_COCKPIT`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Ventes, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Pharmacien resp. information médicale
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development
- Le délégué voit SON secteur (`SalesSectorRep`) ; le responsable son équipe ; accès ligne à ligne (`RowGrant`, DOCTOR / VISIT / DELEGATE_PLAN)
- Gammes attribuées (`UserProductRange`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `MedicalSpecialty` | Spécialité médicale | Restreint | medical-actions, segmentation-actions |
| `MedicalDoctor` | Médecin (professionnel de santé) | Restreint | care-actions, custom-field-actions, force-de-vente-actions, fournisseurs-annuaire-actions +5 |
| `MedicalInstitution` | Établissement de santé | Restreint | fournisseurs-annuaire-actions, medical-actions, segmentation-actions |
| `MedicalInstitutionService` | Service d'un établissement | Restreint | etablissement-services-actions |
| `MedicalVisit` | Visite médicale | Restreint | custom-field-actions, medical-actions, tour-plan-actions, tour-visit-actions |
| `MedicalVisitProduct` | Produit présenté en visite | Restreint | tour-visit-actions |
| `MedicalVisitMessage` | Message promotionnel délivré en visite | Restreint | tour-visit-actions |
| `MedicalVisitSupportNumerique` | Support numérique utilisé en visite | Restreint | field-report-actions, medical-actions, tour-visit-actions |
| `MedicalDelegatePlan` | Plan de visite d'un délégué | Restreint | delegate-plan-actions |
| `FieldReport` | Rapport terrain | Restreint | field-report-actions, tour-visit-actions |
| `FieldReportAttachment` | Pièce d'un rapport terrain | Restreint | field-report-actions |
| `BusinessUnitSpecialty` | Spécialité ciblée par une business unit | Restreint | medical-actions, sales-planning-actions |
| `PromoProduct` | Produit promu | Restreint | pch-tender-line-actions, product-catalog-actions, sales-planning-actions, segmentation-actions |
| `PromoProductSpecialite` | Spécialité ciblée par un produit promu | Restreint | medical-actions, sales-planning-actions, segmentation-actions |
| `PromoCycle` | Cycle promotionnel | Restreint | sales-planning-actions |
| `PromoMessage` | Message promotionnel | Restreint | promo-message-actions |
| `PromotionAssignment` | Affectation promotionnelle | Restreint | sales-planning-actions |
| `ProductForecast` | Prévision de ventes d'un produit | Restreint | sales-planning-actions |
| `SfeSettings` | Réglages de la force de vente | Restreint | sales-planning-actions |
| `SalesRepProfile` | Profil d'un délégué | Restreint | sales-planning-actions |
| `SalesSector` | Secteur de vente | Restreint | sales-planning-actions |
| `SalesSectorInstitution` | Établissement d'un secteur | Restreint | fournisseurs-annuaire-actions, sales-planning-actions |
| `SalesSectorInstitutionService` | Service d'établissement d'un secteur | Restreint | sales-planning-actions |
| `SalesSectorRep` | Délégué affecté à un secteur | Restreint | sales-planning-actions |
| `TourPlan` | Plan de tournée | Restreint | tour-plan-actions |
| `CoachingGrid` | Grille de coaching | Restreint | coaching-actions |
| `CoachingSheet` | Fiche de coaching d'un délégué | Confidentiel — évaluation individuelle d'un délégué | coaching-actions |
| `SalesRepMonthlyKpi` | Indicateurs mensuels d'un délégué | Confidentiel — performance individuelle d'un délégué | — |
| `SegmentationStrategie` | Stratégie de segmentation | Restreint | segmentation-actions |
| `SegmentationStrategieProduit` | Produit d'une stratégie de segmentation | Restreint | segmentation-actions |
| `SegmentationRegle` | Règle de segmentation | Restreint | segmentation-actions |
| `SegmentationFiche` | Fiche de segmentation d'un médecin | Restreint | segmentation-actions |
| `SegmentationDerogation` | Dérogation de segmentation | Restreint | segmentation-actions |
| `SegmentationImport` | Import de segmentation | Restreint | segmentation-actions |
| `SegmentationCycle` | Cycle de segmentation | Restreint | segmentation-actions |
| `HcpObservation` | Observation sur un médecin | Restreint | segmentation-actions, tour-visit-actions |
| `ConsommationImport` | Import de consommation | Restreint | consommation-actions |
| `ConsommationLigne` | Ligne de consommation | Restreint | consommation-actions |
| `ConsommationMemoire` | Rapprochement de consommation retenu | Restreint | consommation-actions |
| `AffiniteConfig` | Réglage des affinités | Restreint | consommation-actions |
| `VoixTerrainCache` | Synthèse de la voix du terrain (cache) | Restreint | — |
| `PraticienRelation` | Relation entre praticiens | Restreint | intelligence-terrain-actions |
| `InfluenceScore` | Score d'influence d'un praticien | Restreint | intelligence-terrain-actions |
| `AnalyseWatermark` | Repère d'avancement des analyses terrain | Restreint | intelligence-terrain-actions |

#### Information médicale & pharmacovigilance — `info-medicale` (5 tables, confidentiel)

Les questions d'information médicale reçues et les cas de pharmacovigilance (effets indésirables déclarés).

- **Écrite par** : Information médicale & Pharmacovigilance (écrans Information médicale, Pharmacovigilance)
- **Modules** : Information médicale (`MEDICAL_INFO`), Pharmacovigilance (`PHARMACOVIGILANCE`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Manager Promotion Médicale, Délégué Médical, National Sales, Responsable Finance / Budget, Pharmacien resp. information médicale
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Responsable Réglementaire, Assistante Réglementaire, Manager Promotion Médicale, Délégué Médical, National Sales, Responsable Finance / Budget, Pharmacien resp. information médicale
- Participants nommés d'un cas (`PharmacovigilanceParticipant`) ; pharmacien responsable (rôle `MEDICAL_INFO_PHARMACIST`)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `MedicalInfoDeclaration` | Déclaration d'information médicale | Confidentiel | ad-pro-item-actions, congress-request-actions, medical-info-actions, promo-execution-actions |
| `MedicalInfoSlip` | Fiche d'information médicale | Confidentiel | medical-info-actions |
| `MedicalInfoDocRequest` | Demande de document d'information médicale | Confidentiel | medical-info-actions |
| `PharmacovigilanceCase` | Cas de pharmacovigilance | Secret — donnée de santé d'un patient (âge, sexe, effet indésirable) | pharmacovigilance-actions |
| `PharmacovigilanceParticipant` | Participant à un cas de pharmacovigilance | Confidentiel | pharmacovigilance-actions |

#### Drive & documents — `documents` (27 tables, restreint)

Les fichiers de l'entreprise : Drive, versions, partages, pièces classées et leurs faits lus, bibliothèque, numérotation et en-têtes.

- **Écrite par** : Drive & documents (`src/lib/drive/`, `src/lib/files/`, `src/modules/bibliotheque/`, écrans Drive, Documents)
- **Modules** : Drive (`DRIVE`), Documents (`DOCUMENTS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier
- **Assistant IA** (familles) : DRIVE
- Droits par fichier et par espace (`DriveShare`, `DriveSpace`) ; la confidentialité d'une pièce (`Piece`) borne sa lecture
- Une pièce rattachée à un sujet (RH, paie…) hérite des droits de ce sujet

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `DriveSpace` | Espace du Drive | Restreint | drive-space-actions |
| `DriveNode` | Dossier ou fichier du Drive | Restreint | ad-pro-item-actions, custom-field-actions, database-admin-actions, drive-actions +5 |
| `DriveShare` | Partage d'un élément du Drive | Restreint | drive-actions |
| `DriveComment` | Commentaire sur un fichier | Restreint | drive-comment-actions |
| `DriveTextIndex` | Index de recherche plein texte du Drive | Restreint | — |
| `FileVersion` | Version d'un fichier | Restreint | drive-actions |
| `FileBlob` | Contenu d'un fichier | Confidentiel — contenu brut de TOUS les fichiers, contrats et fiches de paie compris | — |
| `FileBlobChunk` | Morceau du contenu d'un fichier | Confidentiel — contenu brut de tous les fichiers | — |
| `StoredFile` | Fichier stocké | Restreint | ad-pro-pieces-actions, admin-delete-actions, care-actions, database-admin-actions +6 |
| `DirectUpload` | Dépôt de fichier en cours | Restreint | — |
| `Document` | Document | Restreint | ad-pro-discussion-actions, ad-pro-item-actions, ad-pro-other-actions, ad-pro-pieces-actions +44 |
| `EntityMention` | Mention d'un sujet dans un document | Restreint | — |
| `Piece` | Pièce (fichier classé, une fois pour toutes) | Confidentiel — pièces d'identité, passeports, RIB classés | feedback-actions, kpi-actions, messaging-actions |
| `PieceLien` | Rattachement d'une pièce à un sujet | Restreint | feedback-actions, kpi-actions, messaging-actions |
| `LecturePiece` | Lecture automatique d'une pièce | Restreint | — |
| `LecturePieceConfirmation` | Confirmation d'une lecture de pièce | Restreint | promo-devis-actions, promo-execution-actions |
| `Extraction` | Passage d'un extracteur sur une pièce | Restreint | — |
| `FaitPropose` | Fait lu sur une pièce (proposition) | Confidentiel — valeurs lues sur des pièces d'identité ou bancaires | enrichissement-actions |
| `FaitConfirme` | Fait confirmé sur une fiche | Confidentiel — valeurs confirmées sur une fiche (identité, coordonnées) | — |
| `ConflitDeFait` | Désaccord entre une fiche et une pièce | Restreint | enrichissement-actions |
| `BibliothequeFiche` | Fiche de bibliothèque d'une pièce | Restreint | bibliotheque-actions, feedback-actions, kpi-actions, messaging-actions |
| `BibliothequePassage` | Passage indexé d'une pièce | Restreint | — |
| `OfficeLetterhead` | En-tête de document | Restreint | direction-artistique-actions, letterhead-actions |
| `CompanyDocumentProfile` | Profil documentaire d'une société | Restreint | brand-actions, direction-artistique-actions, fabrique-actions |
| `DocumentSequence` | Séquence de numérotation | Restreint | — |
| `DocumentReference` | Référence de document attribuée | Restreint | legal-actions, secretariat-devis-actions |
| `SerieReference` | Compteur de numérotation des pièces émises | Restreint | — |

#### Messagerie, courriels & agenda — `communication` (22 tables, confidentiel)

Les conversations internes, les courriels envoyés et reçus, les réunions, l'agenda, les rappels et les notifications.

- **Écrite par** : Messagerie (`src/lib/comms/`), Courriels (`src/lib/mail/`), Réunions et Agenda, Notifications
- **Modules** : Messagerie (`MESSAGING`), Espace de travail (`WORKSPACE`), Notifications (`NOTIFICATIONS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- Membres d'une conversation (`ConversationMember`) ; participants d'une réunion (`MeetingParticipant`)
- Une boîte de courriel n'est lue que par son titulaire ; une notification par son destinataire

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Conversation` | Conversation | Confidentiel | meeting-actions, messaging-actions, partage-actions |
| `ConversationMember` | Membre d'une conversation | Confidentiel | meeting-actions, messaging-actions, partage-actions |
| `Message` | Message | Confidentiel | meeting-actions, messaging-actions, partage-actions |
| `MessageReaction` | Réaction à un message | Confidentiel | messaging-actions |
| `MessageAttachment` | Pièce jointe d'un message | Confidentiel | — |
| `MessageMention` | Mention dans un message | Confidentiel | — |
| `MessageBookmark` | Message marqué | Confidentiel | messaging-actions |
| `OutboundEmail` | Courriel envoyé | Confidentiel | smart-mail-actions |
| `InboundEmail` | Courriel reçu | Confidentiel | — |
| `MailLink` | Lien entre un courriel et un sujet | Confidentiel | microsoft-mail-actions |
| `EmailRecord` | Courriel archivé | Confidentiel | — |
| `EmailAttachmentRecord` | Pièce jointe d'un courriel archivé | Confidentiel | — |
| `OutboundMailIntent` | Courriel préparé à confirmer | Confidentiel | — |
| `Meeting` | Réunion | Confidentiel | meeting-actions |
| `MeetingParticipant` | Participant à une réunion | Confidentiel | meeting-actions |
| `MeetingMessage` | Message d'une réunion | Confidentiel | meeting-actions |
| `MeetingMessageAttachment` | Pièce jointe d'un message de réunion | Confidentiel | meeting-actions |
| `MeetingTaskProposal` | Tâche proposée en réunion | Confidentiel | meeting-actions |
| `CalendarEvent` | Événement d'agenda | Confidentiel | calendar-actions, hr-document-actions |
| `CalendarInvite` | Invitation d'agenda | Confidentiel | calendar-actions |
| `Reminder` | Rappel | Confidentiel | reminder-actions |
| `Notification` | Notification | Confidentiel | actualisation-soldes-actions, ad-pro-centre-actions, ad-pro-edit-actions, ad-pro-item-actions +54 |

#### Tâches, demandes internes & validations — `travail` (19 tables, restreint)

Les tâches, directives, demandes de support, dossiers suivis et les circuits de validation et de workflow.

- **Écrite par** : Espace de travail (`src/lib/tasks/`, `src/lib/workflow/`, `src/lib/validations/`, `src/modules/suivi-dossiers/`)
- **Modules** : Espace de travail (`WORKSPACE`), Directives (`DIRECTIVES`), Demandes de support (`SUPPORT`), Sujets (`DOSSIERS`), Demandes de validations (`VALIDATIONS`), Centre de validations (`VALIDATION_CENTRE`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Assistant IA** (familles) : ECRITURES
- Assigné, créateur et participants nommés ; accès ligne à ligne (`RowGrant`, TASK / DIRECTIVE / DOSSIER / VALIDATION_REQUEST)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `Task` | Tâche | Restreint | assistant-actions, custom-field-actions, meeting-actions, stock-snapshot-actions +1 |
| `TaskComment` | Commentaire sur une tâche | Restreint | assistant-actions, task-actions |
| `Directive` | Directive | Restreint | directive-actions |
| `DirectiveMessage` | Message d'une directive | Restreint | directive-actions |
| `SupportRequest` | Demande de support | Restreint | support-actions |
| `SupportMessage` | Message d'une demande de support | Restreint | support-actions |
| `Dossier` | Dossier suivi | Restreint | ad-pro-item-actions, dossier-actions, reservation-fiche-actions |
| `DossierMessage` | Message d'un dossier suivi | Restreint | ad-pro-item-actions, dossier-actions, reservation-fiche-actions |
| `DossierMessageAttachment` | Pièce jointe d'un message de dossier | Restreint | dossier-actions |
| `ValidationRule` | Règle de validation | Restreint | validation-actions |
| `ValidationRequest` | Demande de validation | Restreint | ad-pro-item-actions, ad-pro-rattacher-legal, admin-request-actions, legal-actions +7 |
| `ValidationParticipant` | Participant à une validation | Restreint | validation-actions |
| `ValidationStep` | Étape de validation | Restreint | validation-actions |
| `ValidationItemDecision` | Décision par élément d'une validation | Restreint | validation-actions |
| `WorkflowDefinition` | Circuit (définition) | Restreint | workflow-actions |
| `WorkflowDefinitionVersion` | Version d'un circuit | Restreint | workflow-actions |
| `WorkflowStep` | Étape d'un circuit | Restreint | workflow-actions |
| `WorkflowInstance` | Circuit en cours | Restreint | ad-pro-edit-actions, ad-pro-other-actions, ad-pro-transfer-actions, event-actions +2 |
| `WorkflowStepEvent` | Événement d'une étape de circuit | Restreint | ad-pro-other-actions, ad-pro-transfer-actions, porte-dg-actions |

#### Moyens généraux & demandes administratives — `moyens-generaux` (9 tables, restreint)

Les demandes administratives et d'achats, fournitures, missions de chauffeur, salles et véhicules et leurs réservations.

- **Écrite par** : Demandes administratives & Moyens généraux (`src/lib/general-means/`, `src/modules/salles/`)
- **Modules** : Bureau du secrétariat (`ADMIN_REQUESTS`), Moyens généraux (`GENERAL_MEANS`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- Demandeur, approbateurs et assistante de direction ; accès ligne à ligne (`RowGrant`, ADMIN_REQUEST / DRIVER_MISSION)

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AdministrativeRequest` | Demande administrative | Restreint | ad-pro-item-actions, admin-request-actions, assistant-actions, custom-field-actions +8 |
| `AdminApproval` | Approbation d'une demande administrative | Restreint | admin-request-actions, promo-devis-actions, promo-material-actions, purchase-request-actions |
| `OfficeSupplyArticle` | Article de fourniture de bureau | Restreint | office-supply-actions |
| `PurchaseRequestLogEntry` | Journal d'une demande d'achat | Restreint | admin-request-actions, purchase-request-actions |
| `BesoinAnnuelService` | Besoin annuel d'un service | Restreint | besoins-services-actions |
| `DriverMission` | Mission de chauffeur | Restreint | admin-request-actions |
| `DriverMissionStop` | Étape d'une mission de chauffeur | Restreint | admin-request-actions |
| `MoyenGeneral` | Moyen général (salle, véhicule) | Restreint | moyens-generaux-registre-actions |
| `MoyenGeneralReservation` | Réservation d'une salle ou d'un véhicule | Restreint | moyens-generaux-registre-actions |

#### Pilotage, KPI & intelligence de direction — `pilotage` (20 tables, confidentiel)

Les indicateurs et leurs évaluations, les risques, l'adoption, les décisions, objectifs et engagements de la Direction.

- **Écrite par** : KPI (écran KPI), Adventum Brain, Process Intelligence, Cockpit opérations, My Chief of Staff
- **Modules** : KPI & bilans (`KPI`), Adventum Brain (`ADVENTUM_BRAIN`), Process Intelligence (`PROCESS_INTELLIGENCE`), Cockpit Opérations (`COCKPIT_OPERATIONS`), My Chief of Staff (`CHIEF_OF_STAFF`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- Adventum Brain et Process Intelligence réservés au Super Admin ; My Chief of Staff au cercle du centre de paiement
- KPI : chacun ses indicateurs (`KpiAssignment`), le responsable son équipe

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `KpiDefinition` | Indicateur (définition) | Confidentiel | kpi-actions |
| `KpiAssignment` | Indicateur attribué à une personne | Confidentiel | kpi-actions |
| `KpiValue` | Valeur d'un indicateur | Confidentiel | kpi-actions |
| `KpiDeclaration` | Déclaration d'une valeur d'indicateur | Confidentiel | kpi-actions |
| `KpiImport` | Import de valeurs d'indicateurs | Confidentiel | kpi-actions |
| `KpiEvaluation` | Évaluation sur indicateurs | Secret — évaluation individuelle de performance | kpi-actions |
| `KpiReview` | Revue de performance | Secret — revue individuelle de performance | kpi-actions |
| `KpiReviewSetting` | Réglage des revues de performance | Confidentiel | kpi-actions |
| `RiskSetting` | Réglage des risques | Confidentiel | adventum-actions |
| `BrainRisk` | Risque détecté | Confidentiel | adventum-actions |
| `BrainBriefing` | Note de synthèse de direction | Confidentiel | adventum-actions |
| `BrainQuestion` | Question posée à Adventum Brain | Confidentiel | adventum-actions |
| `IntelligenceSnapshot` | Instantané d'intelligence de direction | Confidentiel | — |
| `ProcessStepSla` | Délai cible d'une étape de processus | Confidentiel | process-intelligence-actions |
| `AdoptionSetting` | Réglage du suivi d'adoption | Confidentiel | adoption-actions |
| `AdoptionSnapshot` | Mesure d'adoption de l'ERP | Confidentiel | — |
| `ExecutiveDecision` | Décision de direction | Confidentiel | — |
| `ExecutiveObjective` | Objectif de direction | Confidentiel | — |
| `ExecutiveCommitment` | Engagement de direction | Confidentiel | — |
| `DailyBrief` | Brief quotidien de la Direction | Confidentiel | assistant-actions |

#### Site web public — `site-web` (6 tables, public interne)

Ce que le site public d'Adventum publie (articles, pages reprises) et la mesure de son audience.

- **Écrite par** : Site web (écran Site web, publication vers le site)
- **Modules** : Site web (`SITE_WEB`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Direction Marketing
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Direction Marketing

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `BlogArticle` | Article du blog | Public interne | site-web-actions |
| `SiteReprise` | Contenu repris de l'ancien site | Public interne | — |
| `SitePublication` | Publication vers le site | Public interne | site-web-actions |
| `SitePushAttempt` | Tentative de publication | Public interne | — |
| `SiteReconciliation` | Rapprochement du site publié | Public interne | site-web-actions |
| `SiteAnalyticsEvent` | Mesure d'audience du site | Public interne | — |

#### Comptes, connexions & droits d'accès — `comptes-et-droits` (19 tables, secret)

Qui peut se connecter, avec quels droits, sur quelles sociétés, et les connexions aux services externes (courriel, Google, API).

- **Écrite par** : Administration › Accès (`src/lib/rbac/`, `src/lib/session.ts`), connexion, Contrôle de l'IA
- **Modules** : Administration (`ADMIN`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin
- **Écriture par défaut** : Super Admin
- Réservé au Super Admin (Administration) ; chacun lit son propre compte
- Mots de passe hachés, jetons de connexion chiffrés ; jamais exposés à l'assistant

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `User` | Compte utilisateur | Secret | access-actions, admin-actions, adoption-actions, auth-actions +6 |
| `UserInvite` | Invitation à créer un compte | Secret | — |
| `UserSession` | Session de connexion | Secret | access-actions, assistant-ia-conversations-actions, auth-actions, hr-actions |
| `LoginAttempt` | Tentative de connexion | Secret | access-actions, auth-actions, supplier-portal-actions |
| `UserAccess` | Droit sur un module (surcharge de la matrice des rôles) | Secret | access-actions |
| `UserCompanyAccess` | Accès d'une personne à une société | Secret | company-access-actions |
| `RowGrant` | Accès à une ligne précise | Secret | access-actions |
| `AssistantIaAcces` | Familles de l'assistant ouvertes ou fermées (rôle ou personne) | Secret | assistant-ia-consommation-actions |
| `AssistantIaDroitDate` | Droit daté de l'assistant sur une famille sensible | Secret | assistant-ia-consommation-actions |
| `AccesBase` | Réglage d'accès à une base (rôle ou personne, daté) | Secret | acces-bases-actions |
| `AccesBaseParametre` | Paramètre d'une base (accès à ses propres données) | Secret | acces-bases-actions |
| `SupplierUser` | Compte du portail fournisseur | Secret | supplier-actions, supplier-portal-actions |
| `ApiClient` | Client de l'API externe | Secret | — |
| `MailAccount` | Boîte de courriel connectée | Secret | mail-actions |
| `MailConnection` | Connexion à une messagerie (jetons) | Secret | microsoft-mail-actions |
| `MailFolderState` | État de synchronisation d'un dossier de courriel | Secret | — |
| `GoogleConnection` | Connexion Google (jetons) | Secret | adam-settings-actions |
| `GmailIngestionState` | État de lecture d'une boîte Gmail | Secret | — |
| `SiteWebCle` | Clé de publication du site web | Secret | site-web-actions |

#### Assistant IA — conversations, notes & mémoire personnelles — `ia-conversations` (31 tables, confidentiel)

Ce que chaque personne dit à son assistant et ce qu'il retient d'elle : fils, messages, notes, dossiers, voix, visuels, routines et veilles.

- **Écrite par** : Assistant IA (`src/modules/assistant-ia/`, écran Assistant) et Adam (`src/lib/assistant/`)
- **Modules** : Assistant IA (`ASSISTANT_IA`), My Chief of Staff (`CHIEF_OF_STAFF`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations
- **Écriture par défaut** : Super Admin, Direction des opérations
- STRICTEMENT PERSONNEL : toute lecture filtre `userId` de la session ; rien d'une autre personne n'y entre (S1, décision 0048)
- Fermé en Vue exacte ; le filtre de confidentialité retire paie, IBAN et pièces d'identité avant tout modèle

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AssistantThread` | Fil de conversation avec Adam | Confidentiel | assistant-actions |
| `AssistantMessage` | Message d'un fil d'Adam | Confidentiel | assistant-actions |
| `AssistantEpisode` | Épisode mémorisé | Confidentiel | — |
| `AssistantMemory` | Mémoire distillée d'une personne | Confidentiel | assistant-actions |
| `AssistantMemoryItem` | Souvenir typé | Confidentiel | assistant-actions, assistant-ia-actions |
| `AssistantHotState` | État courant de la conversation | Confidentiel | — |
| `AssistantArtifact` | Document produit par l'assistant | Confidentiel | — |
| `AssistantReminder` | Rappel posé par l'assistant | Confidentiel | — |
| `AssistantIaFil` | Fil de l'Assistant IA (une conversation par personne) | Confidentiel | — |
| `AssistantIaTour` | Tour du fil (message ou réponse) | Confidentiel | — |
| `AssistantIaAttentePieces` | Pièces attendues dans un fil | Confidentiel | — |
| `AssistantIaDossier` | Dossier de conversations | Confidentiel | — |
| `AssistantIaReception` | Pièce reçue par WhatsApp ou courriel | Confidentiel | — |
| `AssistantIaPreference` | Préférences personnelles de l'assistant | Confidentiel | assistant-ia-actions |
| `AssistantIaNotePage` | Page de notes | Confidentiel | — |
| `AssistantIaNoteVersion` | Historique d'une page de notes | Confidentiel | — |
| `AssistantIaNoteCorbeille` | Ligne de notes supprimée | Confidentiel | — |
| `AssistantIaNoteProposition` | Modification de notes proposée par l'IA | Confidentiel | — |
| `AssistantIaDepotDossier` | Dépôt dans un dossier de conversations | Confidentiel | — |
| `AssistantIaTerrainCapture` | Captation de terrain (vocal, photo) | Confidentiel | field-report-actions |
| `AssistantIaVisuel` | Image ou vidéo générée | Confidentiel | — |
| `AssistantIaVoixSession` | Session vocale | Confidentiel | — |
| `AssistantIaVoixTravail` | Travail délégué par la voix | Confidentiel | — |
| `AssistantIaAgenda` | Précision donnée pendant un travail | Confidentiel | — |
| `AssistantRoutine` | Routine programmée | Confidentiel | — |
| `AssistantRoutineRun` | Passage d'une routine | Confidentiel | — |
| `AssistantVeille` | Veille d'une personne | Confidentiel | — |
| `AssistantVeilleur` | Veilleur d'une personne | Confidentiel | — |
| `AssistantSignal` | Constat d'un veilleur | Confidentiel | — |
| `MediaTranscript` | Transcription d'un média | Confidentiel | — |
| `VoiceTurnLog` | Journal d'un tour vocal | Confidentiel | — |

#### IA — moteur, missions, connaissances & réglages — `ia-moteur` (56 tables, restreint)

Ce qui fait tourner l'IA : réglages et plafonds, missions et travaux, gestes et leurs effets, base de connaissances, consommation, banc d'essai.

- **Écrite par** : Adam & Assistant IA (`src/lib/assistant/`, `src/modules/assistant-ia/`, `src/modules/recettes/`, `src/platform/ia/`), Administration › Contrôle de l'IA
- **Modules** : Administration (`ADMIN`), Assistant IA (`ASSISTANT_IA`), Recettes (`RECETTES`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- Réglages réservés au Super Admin (Administration › IA) ; missions et travaux visibles de leur auteur et participants

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AssistantActionIntent` | Action proposée par l'assistant (à confirmer) | Restreint | assistant-actions |
| `AssistantProvenance` | Provenance d'une réponse | Restreint | — |
| `AssistantRoleConfig` | Réglage de l'assistant par rôle | Restreint | — |
| `AssistantRoleConfigAudit` | Historique des réglages par rôle | Restreint | — |
| `AssistantIaReglage` | Bornes globales de l'assistant | Restreint | assistant-ia-consommation-actions |
| `AssistantIaPlafondAtteint` | Plafond du jour franchi | Restreint | — |
| `AssistantIaModeleRole` | Modèle choisi par rôle de l'IA | Restreint | assistant-ia-qualite-actions |
| `AssistantIaTrace` | Trace rejouable d'un tour | Confidentiel — copie intégrale de ce que le modèle a reçu (consigne, messages, résultats d'outils) | — |
| `AssistantIaBancReglage` | Calendrier du banc d'essai | Restreint | assistant-ia-qualite-actions |
| `AssistantIaBancPassage` | Passage du banc d'essai | Restreint | assistant-ia-qualite-actions |
| `AssistantIaBancScenario` | Résultat d'un scénario du banc | Restreint | — |
| `BancBaseEssai` | Marqueur d'une base d'essai | Restreint | — |
| `AssistantMandat` | Mandat (approbation durable) | Restreint | — |
| `AssistantMandatGeste` | Geste fait sous mandat | Restreint | — |
| `AssistantGesteJournal` | Journal des gestes d'agent | Restreint | — |
| `AssistantEffet` | Effet d'un geste (écriture, envoi) | Confidentiel — valeurs AVANT / APRÈS de chaque écriture d'un geste | — |
| `EffetSortantDiffere` | Envoi différé (fenêtre d'annulation) | Restreint | — |
| `TravailEcriture` | Reçu d'un geste écrit par un travail | Restreint | — |
| `TravailDemande` | Travail demandé à une autre personne | Restreint | — |
| `AtelierConversion` | Opération de l'Atelier (conversion de fichier) | Restreint | — |
| `AdamRule` | Règle enseignée à Adam | Restreint | — |
| `AdamSkill` | Compétence d'Adam | Restreint | — |
| `AdamWatch` | Surveillance programmée par Adam | Restreint | — |
| `CommunicationPolicy` | Politique de communication d'Adam | Restreint | adam-settings-actions |
| `IngestedEvent` | Événement reçu par Adam | Restreint | — |
| `BusinessEvent` | Événement métier | Restreint | consulting-actions |
| `AiSetting` | Réglage de l'IA | Restreint | ai-settings-actions |
| `AiHealthCheck` | Contrôle de santé de l'IA | Restreint | — |
| `AiUsageLog` | Consommation de l'IA | Restreint | adventum-actions, assistant-actions, field-report-actions |
| `ModelCallLog` | Appel d'un modèle d'IA | Restreint | — |
| `Mission` | Mission d'agent | Restreint | mission-runtime-actions |
| `MissionStep` | Étape d'une mission | Restreint | mission-runtime-actions |
| `MissionStepDep` | Dépendance entre étapes | Restreint | — |
| `MissionPlanPattern` | Modèle de plan de mission | Restreint | — |
| `MissionMilestone` | Jalon d'une mission | Restreint | mission-runtime-actions |
| `MissionInput` | Entrée d'une mission | Restreint | — |
| `MissionWorkerRun` | Exécution d'une étape de mission | Restreint | — |
| `MissionArtifact` | Livrable d'une mission | Restreint | — |
| `MissionApproval` | Approbation d'une mission | Restreint | mission-runtime-actions |
| `MissionParticipant` | Participant à une mission | Restreint | — |
| `MissionEvent` | Événement d'une mission | Restreint | — |
| `OperationalTemplate` | Modèle opérationnel | Restreint | mission-runtime-actions |
| `ScheduledWorkflow` | Travail programmé | Restreint | — |
| `WorkflowRun` | Exécution d'un travail programmé | Restreint | — |
| `ArtifactSession` | Session d'édition d'un document | Restreint | — |
| `ArtifactOperation` | Opération d'édition d'un document | Restreint | — |
| `KnowledgeItem` | Élément de la base de connaissances | Confidentiel — documents ingérés de toutes les bases | — |
| `KnowledgeChunk` | Passage indexé de la base de connaissances | Confidentiel — texte indexé de documents de toutes les bases | — |
| `KnowledgeJob` | Traitement de la base de connaissances | Restreint | — |
| `KnowledgeLink` | Lien de la base de connaissances | Restreint | — |
| `KnowledgeEntity` | Entité de la base de connaissances | Restreint | — |
| `KnowledgeAlias` | Nom alternatif d'une entité | Restreint | — |
| `Recette` | Recette (circuit appris) | Restreint | recettes-actions |
| `RecetteVersion` | Version d'une recette | Restreint | recettes-actions |
| `RecetteUsage` | Usage d'une recette par l'assistant | Restreint | — |
| `RecetteResponsable` | Responsable d'un processus | Restreint | recettes-actions |

#### Journaux & traçabilité — `journaux` (8 tables, confidentiel)

Qui a fait quoi et quand : journal d'audit, activité, corbeille, appels d'API, incidents et qualité des données.

- **Écrite par** : Socle (`src/lib/audit.ts`, `src/lib/journal.ts`, corbeille) — écrit par toutes les actions
- **Modules** : Administration (`ADMIN`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin
- **Écriture par défaut** : Super Admin
- Lecture réservée au Super Admin (Administration › Journal, Corbeille) ; l'activité d'un sujet se lit sur sa fiche selon les droits du sujet

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AuditLog` | Journal d'audit | Secret — les valeurs avant / après de toute écriture, paie comprise | acces-bases-actions, access-actions, actualisation-soldes-actions, ad-pro-centre-actions +155 |
| `ActivityLog` | Journal d'activité | Confidentiel | adoption-actions |
| `SessionEvent` | Événement de session | Confidentiel | — |
| `DeletedRecord` | Élément en corbeille | Secret — copie complète de chaque ligne supprimée, de toutes les bases | ad-pro-item-actions, ad-pro-pieces-actions, admin-delete-actions, bd-project-actions +9 |
| `ApiCall` | Appel de l'API externe | Confidentiel | — |
| `IncidentRepete` | Incident répété | Confidentiel | — |
| `DataQualityFinding` | Anomalie de qualité des données | Confidentiel | — |
| `DataQualitySweep` | Passage de contrôle de qualité des données | Confidentiel | — |

#### Plateforme, réglages, files & intégrations — `plateforme` (22 tables, restreint)

Les réglages de l'application, les champs personnalisés, les tâches de fond, webhooks, notifications poussées, le centre de test et les chantiers de développement.

- **Écrite par** : Administration (réglages), ordonnanceur (`src/lib/scheduler/`), centre de test, chantiers
- **Modules** : Administration (`ADMIN`), Feedback (`FEEDBACK`)
- **Lecture par défaut** (matrice des rôles, avant surcharges individuelles) : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- **Écriture par défaut** : Super Admin, Direction des opérations, Directeur Général, Directeur des Opérations, Responsable Réglementaire, Assistante Réglementaire, Responsable Ventes, Commercial, Responsable Logistique, Manager Promotion Médicale, Délégué Médical, National Sales, Direction Marketing, Manager Business Development, Responsable Finance / Budget, Pharmacien resp. information médicale, Assistante de Direction, Coordination / Coursier, Lecteur
- Réglages réservés au Super Admin ; retours (Feedback) lus par leur auteur et l'Administration

| Table | Libellé | Sensibilité | Écrite par (actions) |
|---|---|---|---|
| `AppSetting` | Réglage de l'application | Restreint | assistant-actions, assistant-ia-consommation-actions, budget-envelope-actions, coffre-actions +7 |
| `FeatureFlag` | Interrupteur de fonctionnalité | Restreint | feature-actions |
| `CustomFieldDef` | Champ personnalisé | Restreint | custom-field-actions |
| `EntityLink` | Lien entre deux sujets | Restreint | link-actions, pch-actions |
| `Comment` | Commentaire | Restreint | ad-pro-discussion-actions, ad-pro-item-actions, ad-pro-other-actions, ad-pro-pieces-actions +27 |
| `Feedback` | Retour d'un utilisateur | Restreint | feedback-actions |
| `FeedbackAttachment` | Pièce jointe d'un retour | Restreint | feedback-actions |
| `PushSubscription` | Abonnement aux notifications poussées | Restreint | — |
| `ApiIdempotencyKey` | Clé d'idempotence de l'API | Restreint | — |
| `WebhookEndpoint` | Point de réception d'un webhook | Secret — secret de signature des webhooks | — |
| `WebhookDelivery` | Envoi d'un webhook | Restreint | — |
| `ControleWorker` | Bail d'une tâche de fond | Restreint | — |
| `TacheDeFond` | Tâche de fond | Restreint | — |
| `TacheEnrichissement` | File d'enrichissement des pièces | Restreint | enrichissement-actions |
| `TestRun` | Passage du centre de test | Restreint | test-center-actions |
| `TestArtifact` | Pièce d'un passage de test | Restreint | — |
| `TestFinding` | Constat d'un passage de test | Restreint | — |
| `ChantierReservation` | Réservation d'une ressource par un chantier | Restreint | — |
| `MemoireTechnique` | Mémoire technique des chantiers | Restreint | — |
| `DevLancement` | Lancement de Claude Code | Restreint | — |
| `ClaudeRelaisOrdre` | Ordre pour le relais Claude Code | Restreint | — |
| `ClaudeRelaisEtat` | État du relais Claude Code | Restreint | — |

<!-- BASES:FIN -->
