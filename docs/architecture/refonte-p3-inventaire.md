# Refonte des données — P3 : inventaire des écrivains et des lecteurs

> 27/10/2026 · lot W10 · **lecture seule** : aucun code ni aucune migration modifiés.
> Complète `refonte-donnees-et-monolithe-modulaire.md` (§3 référentiels R1-R6, §4 palier P3 « double écriture »).
> Mesuré sur la branche `claude/hopeful-goodall-phd0nb` (commit `6293c32`).

## 0. Méthode et limites

- **Écrivains** : relevé dans `src/`, `scripts/` et `prisma/` de tout appel `<client>.<délégué>.(create|createMany|update|updateMany|upsert|delete|deleteMany)`,
  quel que soit le nom du client (`prisma`, `tx`, `ctx.prisma`…), puis rattachement à la fonction qui le contient. Recoupé avec
  `src/lib/actions/contrat.genere.json` (le contrat des 1 159 actions, champ `modelesEcrits`), qui ne voit que le corps de l'action
  et rate donc les écritures faites dans un module auxiliaire.
- Recherches complémentaires : écritures imbriquées (`relation: { create: … }`) — **aucune** sur les tables visées ; SQL brut
  (`$executeRaw`, `INSERT/UPDATE/DELETE "Table"`) — **aucun** dans `src/` ni `scripts/` ; délégués dynamiques (`prisma[modele]`) —
  corbeille et test-center seulement (voir §3).
- **Lecteurs** : fichiers de `src/` (hors tests) qui appellent `findMany/findUnique/findFirst/count/aggregate/groupBy` sur le délégué.
  Les lectures **par inclusion** (`include: { employee: … }`) ne sont pas comptées : le chiffre est un plancher.
- Les numéros de ligne sont ceux de l'appel Prisma, pas de la déclaration de la fonction.
- Légende des écrivains : **[A]** action serveur · **[H]** module auxiliaire appelé par une action · **[I]** import en masse ·
  **[IA]** Adam / Assistant IA · **[G]** chemin générique (corbeille, workflow, champs personnalisés, qualité) ·
  **[P]** entrée publique (route API, portail, formulaire public) · **[M]** migration de données · **[T]** banc, script ou recette.
  **(id)** = l'écriture touche un attribut d'identité (nom, e-mail, téléphone, établissement, NIF…) → **concernée par la double écriture**.
  Sans ce marqueur, elle ne touche qu'un état (statut, solde de congés, date de dernière visite, montant) et P3 peut l'ignorer.

### Correction du périmètre demandé

- Les champs `organizer` / `society` **n'existent pas** sur les demandes. Les champs texte « organisation » réels sont :
  `SponsoringRequest.institution` (obligatoire), `CongressNational.hostInstitution`, `CareBeneficiary.institution`,
  `MedicalDoctor.institution` (libellé dénormalisé de `institutionId`), `EventRegistration.institution`,
  `FieldReport.institution`, `Sale.institution`. `CongressInternational` et `Event` n'ont qu'un lieu (`city`, `country`, `location`).
- `TreasuryAccount.rib` (comptes de trésorerie) est une donnée bancaire en clair **hors liste** : signalée en §4.

---

## 1. Personnes (R1)

### 1.1 `User` — 24 écrivains de production, 14 de test · 256 fichiers lecteurs

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `createUser` | `src/lib/actions/admin-actions.ts:39` | [A] (id) |
| `toggleUserActive`, `updateUserRole`, `setSecondaryRole` | `admin-actions.ts:77, 102, 131` | [A] |
| `adminResetPassword`, `updateUserProfile`, `setUserActive`, `requestOnboarding` | `src/lib/actions/access-actions.ts:221, 270, 303, 349` | [A] — `updateUserProfile` (id) |
| `saveOnboardingProfile`, `completeOnboarding` | `src/lib/actions/onboarding-actions.ts:22, 33` | [A] (id) — l'utilisateur saisit son propre profil |
| `changePassword` | `src/lib/actions/auth-actions.ts:71` | [A] |
| `setMessagingStatus`, `toggleMyTestMode` | `messaging-actions.ts:36`, `feature-actions.ts:79` | [A] |
| `saveAdoptionSettings`, `resetActivityTime` | `adoption-actions.ts:70, 87` | [A] `updateMany` sans filtre |
| `deleteDepartment` | `department-actions.ts:161` | [A] |
| `createAccountWithInvite`, `redeemInvite` | `src/lib/user-invites.ts:46, 106` | [H] (id) |
| `compteSuitLaFiche` | `src/lib/hr/depart.ts:51` | [H] appelé par `updateEmployee` / `setEmployeeActive` |
| `alignerSurLaFiche`, `alignerTousLesComptes` | `src/lib/org/source-unique.ts:24, 28, 52` | [H] le compte suit la fiche Employee (département) |
| `getAdoptionBadge` | `src/lib/adoption.ts:491` | [H] **écriture dans une fonction de lecture** |
| `assurerCompteAgent` | `src/lib/missions/agent/account.ts:96, 129` | [IA] compte technique d'Adam (pas une personne) |
| `CORRECTEURS` (e-mail, désactivation, département) | `src/lib/quality/fix.ts:34, 45, 49` | [G] (id) correctifs de qualité des données |
| `main` | `prisma/bootstrap.ts:23` | [T] premier Super Admin (`npm run seed`) |
| Bancs et recettes | `scripts/bench/*`, `scripts/ui-audit/run.ts`, `scripts/auto-test/live.ts`, `src/lib/test-center/*`, `src/platform/in-process/missions/acceptance.ts` | [T] |
| Migrations | `20260805090000_departments_deep`, `20270118100000_campagne_budgetaire` | [M] (`departmentId`) |

Les ops d'Adam passent par les actions (`impl-hr2.ts` → `updateUserProfile`, `requestOnboarding`…) ; `generique.ts`
interdit structurellement `user` au chemin générique de l'agent (`MODELES_INTERDITS`).

**Lecteurs principaux** : `/admin/users`, `/admin/users/[id]`, `/annuaires/personnes`, `/organigramme`, l'authentification
(`src/auth.ts`), `src/lib/directory/resolve.ts` (résolution d'une personne pour Adam), l'API `GET /api/v1/entities/user/:id`,
l'export Adam `comptes` (`src/lib/assistant/exports.ts:188`). 67 fichiers d'écran, 43 fichiers d'IA : `User` est lu partout comme
**acteur** (demandeur, validateur) — ces lectures ne basculent pas, seule la fiche « personne » bascule.

### 1.2 `Employee` — 24 écrivains de production · 78 lecteurs

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `createEmployee` | `src/lib/actions/hr-actions.ts:61` | [A] (id) + **iban, nationalId, baseSalary**, crée aussi le compte `User` |
| `updateEmployee` | `hr-actions.ts:202` | [A] (id) + **iban, nationalId, cnasNumber, base/grossSalary** |
| `setEmployeeActive` | `hr-actions.ts:306` | [A] |
| `decideLeave`, `cancelLeave`, `updateLeaveRequest` | `hr-actions.ts:435, 532, 613` | [A] solde de congés |
| `applyAnnualLeaveBalance`, `deleteHrRequest` | `hr-document-actions.ts:71, 914` | [A] solde |
| `createEmployee` (doublon Finances) | `src/lib/actions/finance-actions.ts:532` | [A] (id) + **iban, baseSalary** — second chemin de création, hors RH |
| `onboardRecruitment` | `src/lib/actions/recruitment-actions.ts:849` | [A] (id) **candidat → salarié** |
| `assignEmployeeDepartment`, `assignEmployeeManager`, `deleteDepartment` | `department-actions.ts:196, 231, 160` | [A] |
| `saveOrgNode`, `saveOrgPosition` | `org-actions.ts:47, 64` | [A] poste, manager |
| `rattacherSalariesAEntite` | `payroll-hr-actions.ts:421` | [A] `companyId` en masse |
| `alignerSurLaFiche`, `alignerLibellesDuDepartement` | `src/lib/org/source-unique.ts:21, 39, 40` | [H] |
| `accrueMonthlyLeave` | `src/lib/scheduled.ts:325` | [H] routine de fond (solde) |
| `performAction` → `update_salary` | `src/lib/assistant.ts:7174` | [IA] **écriture directe des salaires, hors action** |
| `remove` / `restored` (congés, demandes RH) | `src/lib/admin-delete-registry.ts:192, 227, 242, 273, 285` | [G] corbeille |
| `EMPLOYEE` | `src/lib/custom-fields.ts:91` | [G] champ `custom` |
| `CORRECTEURS` | `src/lib/quality/fix.ts:22` | [G] (id) e-mail |
| Bancs | `scripts/bench/seed-adam-bench.ts`, `adam-live-defis.ts`, `acceptance.ts:802` | [T] |
| Migrations | `20260805090000_departments_deep:57`, `20270118100000_campagne_budgetaire:147,156` | [M] |

Ops Adam via actions : `impl-hr2.ts` (`create_employee` → `createEmployee`, `update_employee` / `update_employee_salary` →
`updateEmployee`), `impl-hr.ts` (`setEmployeeActive`), `impl-wave2b.ts` (`onboardRecruitment`).

**Lecteurs principaux** : `/rh`, `/rh/[id]` (fiche + formulaire), `/rh/equipe`, `/rh/paie`, `/rh/departements`, `/organigramme`,
`/admin/entites`, `/mon-equipe` (`queries/my-team*.ts`), `/annuaires/personnes` (`queries/annuaires.ts`), `api/rh/upload`,
l'API `/api/v1/entities/employee`, l'export Adam `employes` (sans rémunération), les outils Adam `three-sixty.ts`,
`executive-read-tools.ts`, `what-if.ts`, `directory-tools.ts`, la projection de connaissances (`fabric/entites.ts`,
`knowledge/entities/project.ts`), `directory/resolve.ts`.

### 1.3 `MedicalDoctor` — 28 écrivains · 66 lecteurs (la table la plus écrite du périmètre)

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `createDoctor`, `updateDoctor`, `deleteDoctor` | `src/lib/actions/medical-actions.ts:559, 640, 498` | [A] (id) |
| `logVisit` | `medical-actions.ts:778` | [A] `lastVisit` |
| `updateInstitution` | `medical-actions.ts:186` | [A] (id) recopie le nom d'établissement dans `institution` |
| `updateSpecialty`, `deleteSpecialty`, `fusionnerSpecialite`, `rattacherLibelleSpecialite` | `medical-actions.ts:305, 351-352, 396-400, 469` | [A] spécialité en masse |
| `addDirectoryDoctor` | `src/lib/actions/medical-directory-actions.ts:862` | [A] (id) |
| `saveDirectoryCell`, `saveDirectoryCustomCell` | `medical-directory-actions.ts:560, 788` | [A] (id) édition cellule par cellule de la feuille |
| `importDirectorySheet` | `medical-directory-actions.ts:319, 333` | [I] (id) import d'un classeur, boucle `update`/`create` |
| `rattacherEtablissementsParNom`, `rattacherSpecialitesParNom` | `medical-directory-actions.ts:609, 699` | [A] (id) rattachement texte → référence |
| `deleteDirectoryDoctors`, `restaurerDirectoryDoctors` | `medical-directory-actions.ts:914, 955` | [A] archivage logique |
| `moveDoctorsToDirectory` | `medical-directory-crud-actions.ts:129` | [A] |
| `affecterAuDelegue` | `force-de-vente-actions.ts:33` | [A] |
| `rapporterVisite`, `ajouterVisiteImprevue` | `tour-visit-actions.ts:190, 324` | [A] `lastVisit` |
| `appliquerImport` | `src/lib/segmentation/service.ts:467, 469` | [I] (id) (`importerSegmentation`) |
| `appliquerImportDirection` | `src/lib/segmentation/import-direction.ts:476, 478` | [I] (id) (`importerClasseurDirection`) |
| `creerProfilMedecin` | `src/lib/medical/profil-rapide.ts:39` | [H] (id) **bénéficiaire → professionnel** (`care-actions.ts:256, 310`) |
| `completerRattachement` | `src/lib/medical/rattachement-auto.ts:27, 34` | [H] (id) (`rattacherAutomatiquement`) |
| `DOCTOR` | `custom-fields.ts:87` | [G] |
| `remove` | `admin-delete-registry.ts:388` | [G] |
| `CORRECTEURS` | `quality/fix.ts:30` | [G] (id) e-mail |
| Migrations | `20260630170000_doctor_segmentation`, `20260717100000_medical_institution:45`, `20260815120000_entity_backfill:110,114` | [M] |

Ops Adam via actions : `impl-wave4b.ts` (create/update/delete, feuille d'annuaire), `impl-wave6b.ts` (lecture puis action).

**Lecteurs principaux** : `/annuaires/medecins` (`feuille-praticiens.tsx`, `medical/directory-grid.ts`), `/praticiens/[id]`,
`/medical/*`, `/segmentation`, l'export **`/api/medical/annuaire/export`**, la vue 360 (`queries/vue-360.ts`), les tournées
(`queries/tour-schedule.ts`, `platform/in-process/tournee`), Ad & Pro (`queries/ad-pro*.ts`, `queries/care.ts`), l'influence
(`queries/influence.ts`, `influence-luna.ts`), le cockpit marketing, l'export Adam `medecins`, `agent/operations/annuaire-medical.ts`.

### 1.4 `CareBeneficiary` — 5 écrivains · 12 lecteurs

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `addCareBeneficiary` | `src/lib/actions/care-actions.ts:270` | [A] (id) nom, `institution` texte ; peut créer un `MedicalDoctor` (`creerProfilProfessionnel`) |
| `setCareOpinion`, `decideCareBeneficiary`, `removeCareBeneficiary` | `care-actions.ts:332, 361, 409` | [A] |
| `createCongressRequest` | `src/lib/actions/congress-request-actions.ts:211` | [A] (id) bénéficiaires saisis avec la demande |
| Migrations | `20260806160000_care_beneficiaries:117,132`, `20270107090000_prise_en_charge_professionnels:21-75` | [M] (id) |

Écrivains IA : `impl-wave5b.ts` (Adam) → actions ; `agent/operations/adpro-prise-en-charge.ts` (Assistant) → `createCongressRequest`.
**Lecteurs** : Ad & Pro (`queries/care.ts`, `queries/ad-pro-items.ts`, `queries/ad-pro-medecins.ts`), ROI (`roi-adpro.ts`),
force de vente, missions, cockpit marketing, livret (`livret/serveur.ts`).

### 1.5 `AdProVoyageur` et `AdProHebergement` — 4 écrivains chacun · 6 et 5 lecteurs

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `ajouterVoyageur`, `modifierVoyageur`, `retirerVoyageur` | `src/lib/actions/ad-pro-item-actions.ts:3189, 3256, 3280` | [A] (id) identité de passeport |
| `ajouterHebergement`, `modifierHebergement`, `retirerHebergement` | `ad-pro-item-actions.ts:3326, 3384, 3404` | [A] (id) |
| `creerPosteEtFiches` | `src/lib/ad-pro/fiches-poste.ts:115, 116` | [H] (id) fiches créées avec le poste (`addAdProItem`, l. 795) |

Écrivain IA : `agent/operations/voyageur-passeport.ts` (MRZ locale → `ajouterVoyageur`). Verrou `FOR UPDATE` en SQL brut
(lecture) : `ad-pro-item-actions.ts:3727`.
**Lecteurs** : fiche poste (`queries/ad-pro-items.ts`), fiche de voyage envoyée à l'assistante (`reservation-fiche/fiches.ts`,
`reservation-fiche-actions.ts`), accès au passeport (`ad-pro/passeport-acces.ts`).

Hors liste mais même rôle : `AdProMedecin` (`ad-pro-medecins-actions.ts:63` upsert, `:91` delete) — lien poste ↔ médecin déjà
référencé, il suivra `MedicalDoctor.personneId` sans double écriture propre.

### 1.6 `RecruitmentCandidate` — 6 écrivains · 3 lecteurs directs (+ inclusions depuis `RecruitmentRequest`)

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `addRecruitmentCandidate` | `src/lib/actions/recruitment-actions.ts:630` | [A] (id) |
| `moveRecruitmentCandidate` | `recruitment-actions.ts:729` | [A] statut |
| `onboardRecruitment` | `recruitment-actions.ts:872` | [A] lie `employeeId` |
| `annulerEmbaucheRecrutement` | `recruitment-actions.ts:1205` | [A] |
| `recevoirLue` (via `recevoirCandidature`) | `src/lib/site-web/candidatures.ts:233` | **[P]** (id) `POST /api/site-web/v1/candidatures` — site public |
| `partieALaDemande` (via `rattacherCandidature`) | `candidatures.ts:332` | [A] (id) `candidatures-site-actions.ts` |

Écrivain IA : `impl-wave2b.ts` → actions. **Lecteurs** : `/recrutement` (par inclusion), `/recrutement/candidatures`, `entity-access.ts`.

### 1.7 `DirectoryEntry` — 2 écrivains · 3 lecteurs

`ensureDirectoryEntry` (`src/lib/actions/directory-actions.ts:48`) et `updateDirectoryEntry` (`:76`), [A] (id).
Les points de contact (`addDirectoryEndpoint`, `updateDirectoryEndpoint`…) écrivent `DirectoryEndpoint` — préfiguration de
R3 `PointDeContact`. **Lecteurs** : `directory/resolve.ts` (source n° 1 de la résolution d'Adam), `knowledge/entities/project.ts`.

### 1.8 `SupplierUser` — 3 écrivains · 4 lecteurs

`createSupplierUser` (`supplier-actions.ts:88`) [A] (id), `toggleSupplierUser` (`:115`) [A], `supplierLogin`
(`supplier-portal-actions.ts:30`) **[P]** portail fournisseur (`lastLoginAt`). Ops Adam : `impl-wave7d.ts` (`toggleSupplierUser`).
**Lecteurs** : `supplier-auth.ts` (session du portail), `supplier-actions.ts`.

---

## 2. Organisations (R2)

### 2.1 `Company` — 3 écrivains de production · 33 lecteurs

`createCompany` (`src/lib/actions/company-actions.ts:55`), `updateCompany` (`:85`) [A] (id) ; `toggleCompany` (`:107`) [A].
Ops Adam : `impl-org.ts` (`createCompany`, `toggleCompany`), `impl-wave7d.ts` (`updateCompany`). Migration
`20260707120000_companies_multi_entity:20` [M]. Bancs : `scripts/bench/{seed-adam-bench,adam-live-defis,ingest-pool,upload}.ts` [T].
**Lecteurs** : `/admin/entites`, `/admin/settings`, `/business-units`, `/directives`, en-têtes de lettres (`queries/letterheads.ts`),
attestation de travail et ordre de mission, PDF du plan de tournée, livret, `company.ts` (portée multi-société), API v1.

### 2.2 `CompanyLegalIdentity` — 1 écrivain · 7 lecteurs

`saveCompanyIdentity` (`src/lib/actions/company-identity-actions.ts:44`, upsert) [A] (id) **+ rib, iban, swift, NIF, RC**.
Op Adam : `impl-wave7d.ts` → `saveCompanyIdentity`.
**Lecteurs** : `/legal/identites` (champs `rib`/`iban` « copiables », `legal/identity.ts:67-68`), la fabrique de pièces
commerciales (`platform/in-process/artifact/factory.ts` — le RIB imprimé sur devis et factures), `factures/connues.ts`,
`pieces-lues/service.ts` (reconnaissance de l'émetteur d'une pièce lue), `budget-marketing/rapprochement-luna.ts`, livret.

### 2.3 `CompanyContact` — 3 écrivains · 14 lecteurs

`createCompanyContact` (`src/lib/actions/company-contact-actions.ts:71`), `updateCompanyContact` (`:105`) [A] (id) **+ rib** ;
`deleteCompanyContact` (`:145`) [A]. Ops Adam : `impl-org.ts`, `impl-wave7d.ts`.
**Lecteurs** : `/mon-espace/annuaire` (`contacts-board.tsx`, `queries/annuaires.ts:389` renvoie `rib`), `queries/company-contacts.ts`,
devis natif (`secretariat/devis-natif-serveur.ts`), BC depuis devis (`agent/operations/bc-depuis-devis.ts`, `ad-pro-bc-devis.ts`),
**ingestion Gmail** (`google/gmail/ingest.ts` — rapproche l'expéditeur), `directory/resolve.ts`, `assistant/adam-tools.ts`,
`pieces-lues/service.ts`, `promo-automatismes.ts`.

### 2.4 `Supplier` — 8 écrivains · 18 lecteurs

| Écrivain | Fichier:ligne | Nature |
|---|---|---|
| `createSupplier`, `toggleSupplier` | `src/lib/actions/supplier-actions.ts:64, 103` | [A] (id) / état |
| `creerFournisseurAnnuaire`, `modifierFournisseurAnnuaire`, `retirerFournisseurAnnuaire` | `fournisseurs-annuaire-actions.ts:41, 58, 73-78` | [A] (id) |
| `createRegulatorySupplier` | `regulatory-actions.ts:243` | [A] (id) création depuis un dossier réglementaire |
| `remove` | `admin-delete-registry.ts:531` | [G] |
| `CORRECTEURS` | `quality/fix.ts:26` | [G] (id) e-mail |

**Lecteurs** : `/annuaires/fournisseurs`, `/admin/suppliers`, `/regulatory`, `/regulatory/[id]`, recherche globale,
ingestion Gmail, `adam-tools.ts`, `impl-wave4.ts`.

### 2.5 `MedicalInstitution` — 5 écrivains · 40 lecteurs

`createInstitution`, `updateInstitution`, `deleteInstitution` (`src/lib/actions/medical-actions.ts:124, 170, 211`) [A] (id) ;
`appliquerImport` (`segmentation/service.ts:439`) et `appliquerImportDirection` (`segmentation/import-direction.ts:449`) **[I]** (id)
— les imports créent les établissements qu'ils ne reconnaissent pas, par nom. Migration `20260717100000_medical_institution:40` [M].
Op Adam : `impl-wave4b.ts` (`deleteInstitution`).
**Lecteurs** : `/annuaires/etablissements`, `/consommation`, `/segmentation`, `/sales/importer`, ventes PCH (`ventes-pch/*`), stocks
et lieux (`stocks/lieux.ts`, `stock-portee.ts`), pharmacovigilance, vue 360, influence, outils Adam (`investigation.ts`,
`executive-read-tools.ts`).

### 2.6 Champs texte « organisation » des demandes

| Table.champ | Écrivains (id) |
|---|---|
| `SponsoringRequest.institution` (obligatoire) | `createSponsoring` (`sponsoring-actions.ts:184`) [A] · `save` (`ad-pro-edit-actions.ts:61`) [A] · `createTarget` (`ad-pro-transfer-actions.ts:137`, recopie `src.institution ?? src.title`) [A] · `creerDemande` (`budget-marketing/integration-serveur.ts:390`, `institution: d.libelle`) **[I]** · `SPONSORING` (`custom-fields.ts:81`) [G] · Assistant `adpro-sponsoring.ts` → `createSponsoring` [IA] |
| `CongressNational.hostInstitution` | `createCongressRequest` (`congress-request-actions.ts:192`) [A] · `updateCongress` (`:47`) [A] · `save` (`ad-pro-edit-actions.ts:68`) [A] · `createTarget` (`ad-pro-transfer-actions.ts:159`) [A] · `creerDemande` (`integration-serveur.ts:401`) [I] · `performAction` (`assistant.ts:6777`) **[IA] hors action** · Assistant `adpro-prise-en-charge.ts:156` → `createCongressRequest` |
| `CareBeneficiary.institution` | voir §1.4 |
| `MedicalDoctor.institution` | voir §1.3 (`updateInstitution` la recopie, `importDirectorySheet` l. 338) |
| `EventRegistration.institution` | `publicRegister` (`event-actions.ts:433`) **[P]** formulaire public `/inscription/[id]` · `addRegistration` (`:455`) [A] |
| `FieldReport.institution` | `field-report-actions.ts:68, 124, 235` [A] |
| `Sale.institution` | `sales-actions.ts:35, 91` [A] |

Les autres écrivains de `SponsoringRequest`, `CongressNational`, `CongressInternational` et `Event` ne touchent qu'un état et
sont **hors double écriture** : `workflow/engine.ts:307-315` (statut), `reprojeterMontantDemande` (`ad-pro-item-actions.ts:428-434`,
montant), `closeSource` (`ad-pro-transfer-actions.ts:187-194`), `cloturerSponsoring` / `rouvrirSponsoring` / `sponsoringAppeal`,
`settleExpenseOrder` (`expense-actions.ts:258`), `validateDeclarationByDirection` (`medical-info-actions.ts:1026-1028`),
`assurerSujet` (`reservation-fiche/serveur.ts:113-114`), `ecrireAAssistante` (`care-actions.ts:184-185`), la corbeille
(`admin-delete-registry.ts:159, 177, 667, 683`) et l'annulation de lot (`integration-serveur.ts:700-703`).

**Lecteurs** (47 à 55 fichiers chacun) : `/sponsoring`, `/congress-national`, `/congress-international`, `/events`, `/ad-pro`,
`/centre-ad-pro`, `/demandes/[id]`, budget marketing, ROI Ad & Pro, outils Adam (`executive-tools.ts:665` expose
`spo.institution`), API v1.

---

## 3. Données sensibles en clair

| Colonne | Écrivains | Lecteurs (qui voit la valeur en clair) |
|---|---|---|
| `Employee.iban` | `createEmployee` (`hr-actions.ts:68`), `updateEmployee` (`:168`), `createEmployee` Finances (`finance-actions.ts:535`), op Adam `update_employee` (`impl-hr2.ts:228` → `updateEmployee`) | `/rh/[id]` (formulaire, `page.tsx:97`), `/rh/equipe` (colonne « RIB / IBAN », `page.tsx:79`), **API `GET /api/v1/entities/employee/:id`**, proposition d'op Adam (`impl-hr2.ts:91` — l'ancienne valeur affichée dans la carte) |
| `Employee.nationalId`, `cnasNumber` | mêmes écrivains (`hr-actions.ts:76, 191`, `impl-hr2.ts:230`) | `/rh/[id]` (`page.tsx:98`, `:306` affiché si salaires visibles), `/rh/equipe` (`:80`), API v1, `impl-hr2.ts:92` |
| `Employee.baseSalary`, `grossSalary`, `netToPay`, `employerCost` | `createEmployee`, `updateEmployee`, `onboardRecruitment` (`recruitment-actions.ts:862`), **`performAction` `update_salary` (`assistant.ts:7174`, direct)**, migration `campagne_budgetaire` | `/rh/paie`, `/rh/[id]`, `/rh/equipe` (gardé par `canSeeSalary`), `queries/hr.ts`, `hr/payroll-cost.ts`, `hr/workforce-mass.ts`, `budget-campagne/prefill.ts`, **outils Adam** `three-sixty.ts:136`, `executive-read-tools.ts:507`, `what-if.ts:45-148`, `assistant.ts:3959, 7152`, **`sql_query`** (non masqués), API v1 |
| `CompanyContact.rib` | `createCompanyContact` (`company-contact-actions.ts:47`), `updateCompanyContact` | `/mon-espace/annuaire` (`queries/annuaires.ts:389` → `contacts-board.tsx`) |
| `CompanyLegalIdentity.rib`, `iban`, `swift` | `saveCompanyIdentity` (`company-identity-actions.ts:44`) | `/legal/identites`, PDF de devis/factures (`artifact/factory/commercial.ts:91`), `pieces-lues/emetteur.ts` |
| *(hors liste)* `TreasuryAccount.rib` | `finance-actions.ts:394, 457` (validé par `lireRib`) | `/finances` (`comptes-tresorerie.tsx`), `/finances/actualisation-soldes/[id]` |

Filets existants : `filtre-confidentialite.ts` (Assistant IA nouvelle génération seulement), `sandbox/sql.ts:42` (masque `iban`,
`rib`, `swift`, `nationalId`, `cnasNumber`, **pas** les salaires), `replay/capture.ts:51`, `test-center/redact.ts:10`, l'export
Adam `employes` (sans rémunération, `exports.ts:179`).

---

## 4. Risques

| # | Gravité | Risque | Où | Conséquence pour P3 / P5 |
|---|---|---|---|---|
| R1 | **Haute** | L'API v1 rend **tous les champs scalaires** quand `detailFields` est absent (`selectOf(undefined)` → pas de `select`). Aucun `detailFields` sur `employee` ni `user` : `GET /api/v1/entities/employee/:id` renvoie `iban`, `nationalId`, `cnasNumber` et les salaires à toute identité ayant le module RH et `erp.read` ; `user/:id` renvoie `passwordHash` (module ADMIN). | `src/lib/api/registry/entities.ts:127-138, 433-442`, `src/lib/api/query.ts:134`, `src/app/api/v1/entities/[entity]/[id]/route.ts:22` | À corriger **avant** P3, indépendamment de la refonte (liste blanche `detailFields`). À vérifier par un test d'API. |
| R2 | **Haute** | Écritures d'Adam **hors action** : `performAction` met à jour les salaires (`assistant.ts:7174`) et crée des congrès (`:6773, 6777`) directement en base. | `src/lib/assistant.ts` | Un crochet posé dans les actions ne les verra pas : soit les rerouter vers `updateEmployee` / `createCongressRequest`, soit y appeler le même crochet. |
| R3 | **Haute** | Salaires lisibles par les outils de l'ancien Adam sans passer par `filtre-confidentialite.ts` (`three-sixty`, `executive-read-tools`, `what-if`) ; `sql_query` masque par **nom de colonne de sortie** : un alias (`SELECT iban AS x FROM "Employee"`) passe, et les salaires ne sont pas dans la liste. Réservé à la vue globale. | `src/lib/sandbox/sql.ts:42, 118`, `src/lib/assistant/*` | À trancher avec la décision n° 4 (qui lit quoi) ; le coffre R6 règle le fond. |
| R4 | Moyenne | `analyzeEmployeeContract` envoie le texte OCR **complet** d'un contrat de travail (salaire, NIN, RIB) à `askClaude`, hors filtre de confidentialité. | `src/lib/actions/hr-actions.ts:249-275` | Le moteur E (P4) doit reprendre ce cas en « local seulement » (§3 E.2). |
| R5 | Moyenne | `/rh/[id]` envoie au formulaire client les valeurs en clair (IBAN, NIN, salaires) dès que l'édition est permise, même quand l'affichage des salaires est masqué (risque R8 déjà noté dans `docs/knowledge-base/01-system-overview.md:245`). | `src/app/(app)/rh/[id]/page.tsx:68-98` | Premier écran à basculer en P5 (valeur masquée + révélation journalisée). |
| R6 | Moyenne | **Deux chemins de création** d'un salarié : RH (`hr-actions.ts:61`) et Finances (`finance-actions.ts:532`), aux champs différents. Plus `onboardRecruitment`. | | Les trois doivent appeler le même crochet, sinon doublons `Personne`. |
| R7 | Moyenne | **Imports en masse** qui créent personnes et établissements **par nom** : `importDirectorySheet`, `appliquerImport`, `appliquerImportDirection`, `creerDemande` (budget marketing, texte `institution`). Boucles de `create` dans une transaction, parfois longues. | voir §1.3, §2.5, §2.6 | Le crochet doit accepter un **lot** (résolution en mémoire, puis `createMany`) ; sinon N requêtes de plus par ligne. |
| R8 | Moyenne | **Entrées publiques** non authentifiées : `POST /api/site-web/v1/candidatures`, `publicRegister` (`/inscription/[id]`), `supplierLogin`. | | Ne jamais **rattacher d'office** une entrée publique à une `Personne` existante : créer une proposition de doublon (P2), pas une liaison. |
| R9 | Moyenne | **Corbeille** : `restoreDeletedRecord` recrée la ligne depuis l'instantané JSON (`admin-delete-actions.ts:184`, `deleteDelegateOf(spec).create`), `restaurerLot` idem (`suppression/lot.ts:437-438`). Un instantané pris avant P1 n'a pas `personneId` ; un instantané récent peut pointer une `Personne` **fusionnée** depuis. | | La restauration doit repasser par le crochet (résoudre `fusionneeDansId`). |
| R10 | Moyenne | Écritures **génériques** qui contournent la logique métier : `custom-fields.ts:81-91` (champ `custom` de 6 modèles), `quality/fix.ts` (e-mails de User, Employee, MedicalDoctor, Supplier), `workflow/engine.ts:304-316`. | | `quality/fix.ts` modifie un attribut d'identité (e-mail) : il doit appeler le crochet. Les deux autres non. |
| R11 | Basse | Écriture dans un chemin de **lecture** : `getAdoptionBadge` met `User.adoptionScore` à jour (`adoption.ts:491`). Recopies **dénormalisées** en masse : `updateInstitution` réécrit `MedicalDoctor.institution` (`medical-actions.ts:186`), `alignerLibellesDuDepartement` réécrit `Employee.department`. | | Exemples du motif que R2 doit faire disparaître : une valeur recopiée à N endroits. |
| R12 | Basse | Migrations de données passées qui ont écrit ces tables (10 fichiers). Aucune ne sera rejouée, mais elles montrent que des lignes existent **sans passer par une action** (bénéficiaires créés en SQL, établissements dédoublonnés par nom). | `prisma/migrations/2026063017…`, `…0717…`, `…0806…`, `…0815…`, `2027010709…` | La reprise P2 ne doit pas supposer que chaque ligne a un auteur ni un `createdById`. |
| R13 | Basse | Aucune extension Prisma (`$extends`) ni middleware : rien n'intercepte les écritures aujourd'hui, et le contrat `contrat.genere.json` ne voit que le corps des actions (il rate `creerPosteEtFiches`, `creerProfilMedecin`, `appliquerImport*`, `recevoirLue`). | `src/lib/prisma.ts` | Le test de garde proposé en §5.3 doit lire **tous** les fichiers, pas seulement les actions. |

---

## 5. Point d'accroche proposé pour la double écriture

### 5.1 Principe

Un **service de référentiel** par socle, appelé **explicitement** dans la transaction de l'écrivain, jamais une extension Prisma
implicite (une écriture qui en déclenche une autre en silence est ce que §118 refuse ; et `$extends` ne voit pas les `createMany`
d'un import comme un lot) :

```
src/modules/referentiels/api.ts           (seule porte, §5 du document de refonte)
  assurerPersonne(tx, { source: "EMPLOYEE", sourceId, nom, prenoms, email, telephone, … }, acteurId) → personneId
  assurerOrganisation(tx, { source: "SUPPLIER", sourceId, raisonSociale, nif, rc, … }, acteurId) → organisationId
  assurerPersonnesEnLot(tx, lignes[])  /  assurerOrganisationsEnLot(tx, lignes[])   — pour les imports
```

- **Idempotent** et **déterministe** (même entrée → même `personneId`), comme la reprise P2 : la double écriture et la reprise
  partagent le même code de rapprochement.
- **Jamais de fusion** : en cas de candidat ambigu (même nom, e-mail différent), la fonction crée une nouvelle `Personne` et
  dépose une proposition de doublon (§4 P2). Une entrée publique (R8) ne fait **que** ça.
- **Interrupteur** par source (`REFERENTIEL_DOUBLE_ECRITURE=EMPLOYEE,DOCTOR,…`) : P3 s'ouvre table par table, et se referme.
- **Erreur non bloquante** pendant P3 : un échec du référentiel est journalisé et laisse `personneId` à `null` (la reprise le
  rattrapera) — l'action métier ne doit pas échouer à cause du socle tant que les lectures n'y ont pas basculé. Il devient
  bloquant au moment où l'écran correspondant lit le référentiel.
- Le crochet se pose **après** la validation et **dans la même transaction** que l'écriture historique, avec la colonne de lien
  (`Employee.personneId`) écrite dans le même `create`/`update`.

### 5.2 Où accrocher, table par table

Les écrivains marqués (id) sont seuls concernés. Les écrivains d'état n'ont rien à faire.

| Table | Points d'accroche (id) | Remarques |
|---|---|---|
| `Employee` | `createEmployee` (RH), `createEmployee` (Finances), `updateEmployee`, `onboardRecruitment`, `quality/fix.ts` (e-mail) | `onboardRecruitment` **réutilise** la `Personne` du candidat (rôle CANDIDAT → COLLABORATEUR), il n'en crée pas. |
| `User` | `createUser`, `createAccountWithInvite`, `updateUserProfile`, `saveOnboardingProfile`, `quality/fix.ts` | Si le compte est lié à une fiche `Employee`, il prend **sa** `Personne` (`alignerSurLaFiche` en est déjà le lieu). Compte d'agent (`assurerCompteAgent`) : **pas** de `Personne`. |
| `MedicalDoctor` | `createDoctor`, `updateDoctor`, `addDirectoryDoctor`, `saveDirectoryCell`, `importDirectorySheet` (lot), `appliquerImport` (lot), `appliquerImportDirection` (lot), `creerProfilMedecin`, `quality/fix.ts` | `creerProfilMedecin` reprend la `Personne` du bénéficiaire. Les imports appellent la version en lot. |
| `CareBeneficiary` | `addCareBeneficiary`, `createCongressRequest` | Si le bénéficiaire est un médecin connu (`doctorId`), prendre sa `Personne`. |
| `AdProVoyageur` / `AdProHebergement` | `ajouterVoyageur`, `modifierVoyageur`, `creerPosteEtFiches`, `ajouterHebergement`, `modifierHebergement` | Le n° de passeport va au coffre (P5), pas dans `Personne`. |
| `RecruitmentCandidate` | `addRecruitmentCandidate`, `partieALaDemande`, `recevoirLue` (**proposition seulement**) | |
| `DirectoryEntry` | `ensureDirectoryEntry`, `updateDirectoryEntry` | Les `DirectoryEndpoint` alimentent R3 `PointDeContact`. |
| `SupplierUser` | `createSupplierUser` | Rôle CONTACT_TIERS + `Affiliation` vers l'`Organisation` du fournisseur. |
| `Company` | `createCompany`, `updateCompany` | Rôle SOCIETE_DU_GROUPE. |
| `CompanyLegalIdentity` | `saveCompanyIdentity` | Écrit les `OrganisationIdentifiant` (NIF, NIS, RC, AI) de l'organisation de la société. RIB/IBAN → coffre (P5). |
| `CompanyContact` | `createCompanyContact`, `updateCompanyContact` | Une organisation (le tiers) **et** une personne (`contactName`) + `Affiliation`. RIB → coffre (P5). |
| `Supplier` | `createSupplier`, `creerFournisseurAnnuaire`, `modifierFournisseurAnnuaire`, `createRegulatorySupplier`, `quality/fix.ts` | Rapprochement par NIF/RC d'abord, nom ensuite (proposition). |
| `MedicalInstitution` | `createInstitution`, `updateInstitution`, `appliquerImport` (lot), `appliquerImportDirection` (lot) | Rôle ETABLISSEMENT_SANTE. |
| Demandes (texte) | `createSponsoring`, `createCongressRequest`, `updateCongress`, `ad-pro-edit-actions.save`, `createTarget`, `creerDemande` (lot), `publicRegister`, `addRegistration` | Le texte reste écrit tel quel ; `organisationId` est **proposé** (résolution par alias), confirmé par la personne qui saisit — jamais imposé sur un mot libre. |
| Écrivains hors action | `performAction` `update_salary` et création de congrès (`assistant.ts:6773-6777, 7174`) | **Rerouter vers l'action** plutôt que dupliquer le crochet (R2). |
| Corbeille | `restoreDeletedRecord`, `restaurerLot` | Repasser par le crochet à la restauration (R9). |

### 5.3 Garde automatique

Ajouter, sur le modèle de `client-bundle-guard.test.ts` et de `generique.ts` (« la garde s'arme sur le **modèle écrit** ») :
un test qui relève dans **tout** `src/` les `create/update/upsert` sur les tables rattachées (même expression régulière que
`RE_MODELE_ECRIT`, élargie à tout récepteur) et exige que la fonction appelle `assurerPersonne` / `assurerOrganisation`, ou
figure dans une **liste d'exceptions motivées** (les écrivains d'état du présent inventaire). Un écrivain d'identité ajouté
demain fait échouer `npm test` au lieu de créer des lignes orphelines.

---

## 6. Ordre de bascule recommandé (lectures), écran par écran

Règle : un écran ne bascule que lorsque **tous** les écrivains (id) de sa table passent par le crochet et que la reprise P2 a
rempli 100 % des liens (contrôle : `count(*) where personneId is null = 0`). Ordre du moins risqué au plus risqué :

| Rang | Écran / lecteur | Table(s) | Pourquoi à ce rang |
|---|---|---|---|
| 1 | `/legal/identites`, en-têtes de lettres, fabrique de pièces (en-tête société) | `Company`, `CompanyLegalIdentity` | 1 à 3 écrivains, < 10 lignes, aucun import. Banc d'essai idéal. |
| 2 | `/annuaires/fournisseurs`, `/admin/suppliers` | `Supplier`, `SupplierUser` | 8 écrivains, tous des actions ; rapprochement par NIF. |
| 3 | `/mon-espace/annuaire`, `queries/company-contacts.ts` | `CompanyContact` | 3 écrivains ; premier usage de l'`Affiliation`. |
| 4 | `directory/resolve.ts` (résolution d'Adam), `/annuaires/personnes` | `DirectoryEntry`, `User`, `Employee`, `CompanyContact` | Lecture **transverse** : c'est elle que la fiche Personne remplace ; bascule derrière interrupteur, comparaison ancien/nouveau résultat journalisée. |
| 5 | `/rh/[id]`, `/rh/equipe`, `/organigramme` | `Employee`, `User` | Après correction de R1 et R2. La fiche affiche la `Personne` ; les colonnes RH (contrat, congés) restent sur `Employee`. |
| 6 | `/recrutement` | `RecruitmentCandidate` | Après le rang 5 : l'embauche relie candidat et salarié sur la même `Personne`. |
| 7 | `/annuaires/etablissements`, `/segmentation`, `/consommation` | `MedicalInstitution` | 40 lecteurs, deux imports en masse : passer les imports en lot d'abord. |
| 8 | `/annuaires/medecins`, `/praticiens/[id]`, export `/api/medical/annuaire/export` | `MedicalDoctor` | La table la plus écrite (28) et la plus importée ; la feuille édite cellule par cellule. |
| 9 | Ad & Pro : fiche poste, bénéficiaires, voyageurs, fiche de voyage | `CareBeneficiary`, `AdProVoyageur`, `AdProHebergement` | Dépend des rangs 5 et 8 (un bénéficiaire est souvent un médecin ou un collaborateur). |
| 10 | `/sponsoring`, `/congress-*`, `/events`, budget marketing, ROI | champs texte `institution` / `hostInstitution` | Le lien n'est que **proposé** : on affiche l'organisation quand elle est confirmée, le texte sinon. |
| 11 | Outils IA (vue 360, `executive-read-tools`, `fabric/entites.ts`, projection `knowledge/entities`) et API v1 | toutes | En dernier : ils doivent lire la même chose que l'écran (§118, « le Chief ne contredit jamais l'écran »). |
| P5 | `/rh/[id]` formulaire, `/rh/equipe` colonnes IBAN/NIN, API v1, `/legal/identites`, `/mon-espace/annuaire` (RIB), fabrique de pièces (RIB imprimé) | colonnes sensibles | Bascule vers le coffre R6 : valeur masquée (4 derniers caractères), révélation journalisée dans `AccesDonneeSensible`. La fabrique de pièces lit le coffre côté serveur uniquement. |

---

## 7. Synthèse

Écrivains = fonctions de production distinctes qui écrivent la table (hors bancs, recettes et migrations).
Lecteurs = fichiers `src/` qui l'interrogent directement (plancher : les inclusions ne sont pas comptées).

| Table | Écrivains | dont (id) | Lecteurs | Difficulté | Raison principale |
|---|---|---|---|---|---|
| `User` | 24 | 5 | 256 | **Haute** | Moyeu de 170 FK ; lu partout comme acteur ; écrit par RH, admin, invitations, onboarding |
| `Employee` | 24 | 5 | 78 | **Haute** | Deux chemins de création, écriture IA hors action, données sensibles, API v1 trop large |
| `MedicalDoctor` | 28 | 9 | 66 | **Haute** | Trois imports en masse, feuille éditée cellule par cellule, création depuis un bénéficiaire |
| `CareBeneficiary` | 5 | 2 | 12 | Moyenne | Créé avec la demande ; recouvre médecins et collaborateurs |
| `AdProVoyageur` | 4 | 3 | 6 | Moyenne | Identité de passeport (MRZ) ; part sensible vers le coffre |
| `AdProHebergement` | 4 | 3 | 5 | Basse | |
| `RecruitmentCandidate` | 6 | 3 | 3 | Moyenne | Entrée publique (site web) |
| `DirectoryEntry` | 2 | 2 | 3 | Basse | Mais lecteur clé : `directory/resolve.ts` |
| `SupplierUser` | 3 | 1 | 4 | Basse | Portail fournisseur |
| `Company` | 3 | 2 | 33 | Basse | |
| `CompanyLegalIdentity` | 1 | 1 | 7 | Basse | RIB/IBAN imprimés sur les pièces : P5 délicat |
| `CompanyContact` | 3 | 2 | 14 | Moyenne | Une ligne = une organisation **et** une personne ; RIB en clair |
| `Supplier` | 8 | 5 | 18 | Moyenne | Trois écrans de création distincts (achats, annuaire, réglementaire) |
| `MedicalInstitution` | 5 | 4 | 40 | Moyenne | Deux imports créent par nom |
| `SponsoringRequest.institution` | 14 | 6 | 47 | Moyenne | Texte obligatoire ; lien seulement proposé |
| `CongressNational.hostInstitution` | 14 | 7 | 54 | Moyenne | Écriture IA hors action |
| `CongressInternational` / `Event` | 14 / 9 | 0 | 55 / 46 | Basse | Aucun champ d'organisation : rien à doubler |
| `EventRegistration.institution` | 5 | 2 | — | Basse | Formulaire public |
| Colonnes sensibles (`Employee`, `CompanyContact`, `CompanyLegalIdentity`) | 6 | — | 15+ | **Haute** | R1, R3, R4, R5 à traiter avant P5 |

**À retenir.** Sur ~170 points d'écriture, **moins de 70 touchent l'identité** et sont concernés par P3 : la double écriture tient
dans une vingtaine d'actions et quatre imports. Le vrai travail est ailleurs : deux écritures d'Adam hors action (R2), l'API v1
qui expose les colonnes sensibles (R1), et les imports en masse qui doivent passer en lot (R7). À traiter avant d'ouvrir P3.
