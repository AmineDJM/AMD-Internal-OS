# 07 — Pharma commercial & regulatory core

> Knowledge-base chapter. Written from a read-only pass over the code at `HEAD` (graph built from `41b2ef0e`).
> Tags: **[V]** = verified in code (file:line cited), **[U]** = inferred / not fully traced.
> French identifiers and domain terms are kept verbatim, with a short English gloss the first time they appear.

---

## 1. Scope

This chapter covers the "pharma core" of AMD Internal OS, the ERP of Adventum Pharma (an Algerian pharmaceutical lab):

| Area | Route(s) | RBAC module key(s) |
|---|---|---|
| Regulatory: AMM/ANPP dossiers, the official ANPP process, pipeline, BV, variations, CTD analysis ("Regulatory Intelligence OS") | `/regulatory`, `/regulatory/pipeline`, `/regulatory/[id]`, `/regulatory/enregistrement/*`, `/regulatory/catalogue` | `REGULATORY`, `REGULATORY_PIPELINE`, `PHARMACOVIGILANCE`, plus a per-company flag `RegulatoryFeatureAccess` for the CTD analysis |
| Produits 360 (product catalogue, where product = regulatory dossier) | `/produits`, `/produits/[id]`, `/produits/rapprocher` | `PRODUCTS`, with one facet per module (`src/lib/vues-360-acces.ts`) |
| Marchés PCH (public tenders of the Pharmacie Centrale des Hôpitaux) | `/pch`, `/pch/[id]` | `PCH`, plus `LEGAL` for contracts and amendments (avenants) |
| Ventes PCH (imported PCH files) | `/sales/*` (the old "Ventes" URL now hosts this module) | `PCH_VENTES` |
| Stocks (dated stock states) | `/stocks`, `/stocks/chaine`, `/stocks/pch-central` | `STOCKS` |
| Segmentation Studio (letters H / A–D / NA / NC) | `/segmentation` | `SEGMENTATION`, `SEGMENTATION_POTENTIEL` |
| Force de vente (planning), Business Units, sectors | `/planning/*`, `/business-units/*` | `SALES_PLANNING`, `BUSINESS_UNITS` |
| Promotion médicale (Ma journée, tour plans, visits, field reports, coaching) | `/medical/*` | `MEDICAL`, `FIELD_REPORTS`; coaching is role-based and has no module key |
| Marketing cockpit | `/marketing-cockpit` | `MARKETING_COCKPIT` |
| Stock & Catalogue promotionnel | `/stock-promotionnel`, `/stock-promotionnel/catalogue` | `PROMO_STOCK`, `PROMO_CATALOG` (the purchasing circuit itself is `PROMO_MATERIAL`, part of Ad & Pro) |
| Market data (IQVIA / PCH receptions / Nomenclature snapshots) | `/explorateur-produits` (the `/business-development/marche/*` pages are retired) | `PRODUCT_EXPLORER` (`BUSINESS_DEVELOPMENT` is retired) |
| Annuaires (doctors, pharmacists, establishments, specialties…) | `/annuaires`, `/medical/annuaire` | `DIRECTORIES` (granted implicitly to everyone) plus per-directory grants; `MEDICAL` for practitioners and hospitals |
| Consommation (hospital consumption files) | `/consommation` (no menu entry) | `CONSUMPTION` |
| Site web (outbound publication to adventumdz.com, inbound candidatures) | `/site-web`, `/site-web/audience`, `/api/site-web/v1/*` | `SITE_WEB`; job offers need `RH` write |

Retired modules are also covered: Ventes (manual), Commandes & logistique, Market Intelligence, and Retours & réclamations.

## 2. Summary

- **Dossier first, product second.** A `RegulatoryProduct` (an AMM/ANPP registration dossier) automatically creates and keeps updated its own canonical `Product`, one per dossier (`ensureProduitDuDossier`). Every commercial module points at `Product.id`. Stocks are the exception: they point at the dossier id. [V]
- **Process level is derived, not entered by hand.** The 19-step official ANPP process is stored as JSON in `RegulatoryProduct.workflow`. The dossier `status` is computed from it (`deriveStatus`) and never moves backwards. The product `lifecycle` follows that status. A legacy 17-row `RegulatoryStep` table is still seeded and read in a few places. [V]
- **PCH tenders run AO → versioned submission → award per lot → contract (a `LegalDocument`) and avenants → BC lines → deliveries.** The tender's displayed level is derived (`deriverNiveau`). A delivery can write an OUT `StockMovement` against the single matching dossier. [V]
- **Ventes PCH import is idempotent.** The SHA-256 of the file is checked first: a known file does nothing. Otherwise each (DR × month) tranche the file carries replaces the same tranche, whichever import held it ("last applied wins"; file dates are not compared). Postes, establishments and suppliers are remembered, and manual mappings are never overwritten. [V]
- **Field chain:** annuaire → Segmentation (letter H/A–D/NA/NC per BU) → required visit frequency → Ma journée / tour plan → visits and field reports (which also draw promo stock) → Marketing cockpit / Force de vente / Produits 360. [V]
- **Retirement is enforced in `rbac.getAccess`.** A retired module never enters effective access, so every `userCan`/`requireModule` returns false, even for Super Admin. Code and data are kept. [V]
- **Site web.** The ERP is the source of truth: a versioned outbound queue (PUT/DELETE, with retries), a daily reconciliation with `GET /jobs` and `GET /posts`, and inbound calls authenticated by Bearer key plus HMAC-SHA256. [V]

## 3. Key files

| Path | Role |
|---|---|
| `prisma/schema.prisma` (L1732 `RegulatoryProduct`, L2106 `RegulatoryDossierStep`, L2130 `RegulatoryStep`, L14868 `Product`, L6973 `PchTender`, L10102 `StockSnapshot`, L16163 `PchVenteImport`…, L15750 `Segmentation*`, L11530 `BusinessUnit`, L11750 `SalesSector`, L11899 `TourPlan`) | Data model |
| `src/lib/regulatory-workflow.ts` | The 19 official ANPP steps and 5 phases, pre-submission checklist, BV steps, progress, status milestones (pure) |
| `src/lib/regulatory/process-status.ts` | Process level derived from the ticked steps (`deriveStatus`, pure) |
| `src/lib/regulatory/sync-status.ts` | Single writer of `RegulatoryProduct.status`; syncs product lifecycle and sends notifications |
| `src/lib/actions/regulatory-actions.ts` (1,461 lines) | Create / update dossier, step state, presub outcome, BV request, lock, variations |
| `src/lib/regulatory/{bv-circuit,bv-reglement,ctd-initiale,dci-duplicate,pipeline-access,dossier-timeline}.ts` | BV state, BV receipt (quittance) → payment step, CTD initial document, DCI duplicate warning, timeline |
| `src/lib/regulatory/intelligence/**` (~16.8k lines) | CTD analysis subsystem: upload, zip inspection, extraction (worker), OCR (Mistral → Tesseract → vision AI), CTD classification, findings, reserves, jobs |
| `src/lib/products/{identity,produit-du-dossier,canonique,termines,fiche-360,sante}.ts` | Identity key, one-dossier→one-product decision (pure) and its writer, "terminated" (commercialised) rule, lifecycle frieze, health score |
| `src/lib/vues-360-acces.ts` | Which Produits 360 facet each module unlocks |
| `src/lib/pch/market-math.ts` | Derived tender level, deadline zones, contract quantity checks (pure) |
| `src/lib/actions/pch-actions.ts`, `pch-market-actions.ts`, `pch-tender-line-actions.ts` | Tender / BC CRUD; submission, award, contract, avenant, BC lines, deliveries; AO document reading |
| `src/lib/pch/{lecture-ao,extraction,deadline-sweep,porte-marche,rattachement-produit}.ts` | AO OCR + Claude line extraction, replace plan, deadline reminders, per-tender gate |
| `src/lib/ventes-pch/{lecture,normalisation,correspondance,calculs,service,requetes}.ts` | PCH file reading / mapping / replacement (pure), service, read API |
| `src/lib/actions/ventes-pch-actions.ts` | Preview / apply / mapping actions (module `PCH_VENTES`) |
| `src/lib/stocks/*.ts`, `src/lib/queries/stock-pch.ts`, `src/lib/actions/{stock-snapshot,stock-pch,demande-stocks,stock-recurrence}-actions.ts` | Dated states, PCH central entry, chain coverage, stock requests and recurrences |
| `src/lib/segmentation/{regles,moteur,lettre-requise,service,droits}.ts`, `src/lib/actions/segmentation-actions.ts` | Rules, deterministic engine, "required" letter, DB service, rights |
| `src/lib/queries/force-de-vente.ts`, `src/lib/force-de-vente/calculs.ts`, `src/lib/sfe*.ts`, `src/lib/sfe/*` | Force de vente pilotage, KAM day, alerts, sweep |
| `src/lib/actions/{sales-planning,tour-plan,medical,field-report,coaching}-actions.ts` | BU / sector / KAM set-up, tour plans, visits, field reports, coaching |
| `src/lib/marketing-cockpit/*.ts` | Cockpit reads (segmentation, visits, Ad & Pro, market) and access rules |
| `src/lib/promo/*.ts`, `src/lib/actions/promo-stock-actions.ts` | Promo stock ledger (movements per lot) |
| `src/lib/market/*.ts`, `src/data/market/*.ndjson.gz` | Embedded market snapshots (server-only `data.ts` reads `fs`/`zlib`) |
| `src/lib/annuaires/*.ts`, `src/lib/medical/*.ts`, `src/lib/actions/medical-directory*-actions.ts` | Directories, per-directory access, establishment linking, workbook import/export |
| `src/lib/consommation/*.ts` | Consumption import pipeline and establishment-level affinity |
| `src/lib/site-web/*.ts`, `src/app/api/site-web/v1/*/route.ts` | Contract, queue, transport, inbound auth, reconciliation, key rotation, candidatures, audience |
| `src/lib/rbac.ts`, `src/lib/modules-retired.ts`, `src/lib/modules-visibility.ts` | Module list, retirement, locked-dossier scope |
| `src/lib/scheduled.ts` | Heartbeat: boot product sweep, regulatory jobs, stock recurrences, PCH deadline sweep, SFE sweep, site-web queue / reconciliation |

## 4. How it works

### 4.1 Business glossary (verified against code)

| Term | Meaning | Code that embodies it |
|---|---|---|
| **AMM** | *Autorisation de Mise sur le Marché*, marketing authorisation. In practice the "registration decision" (DE, *décision d'enregistrement*). | `RegulatoryProduct` (schema L1732); status `DECISION_OBTAINED`; legacy step type `AMM_RECEIVED` [V] |
| **ANPP** | *Agence Nationale des Produits Pharmaceutiques*, the Algerian registration authority | `REG_STEPS` (`regulatory-workflow.ts:44`, 19 steps / `REG_PHASES` L25, 5 phases); `RegulatoryDossierStepKind.ANPP_RESERVES/ANPP_RESPONSE` (schema L2084) [V] |
| **Réserves** | Objections raised by ANPP; the back-and-forth cycle | `RegulatoryDossierStep` frieze ("la frise", the dossier timeline), not checkboxes (`ANPP_EXCHANGE_AFTER_STEP="evaluation"`, L109); CTD analysis `RegulatoryReserveCycle/ReservePoint` [V] |
| **DCI** | *Dénomination Commune Internationale* (INN, the active substance); a product can be mono / double / triple | `RegulatoryProduct.dci` + `molecules` JSON; `dciKey` sorts the molecules of an association (`regulatory/dci-duplicate.ts:40-50`); `Product.dci`, `cleDci` in `products/identity.ts` [V] |
| **CTD** | Common Technical Document (modules 1–5) | `REG_STEPS` step 1 `ctd` (the initial CTD is uploaded on this step, `regulatory/ctd-initiale.ts`); step 8 `modules345`; Module 1 = the Algerian administrative module (`module1`, `presub_checklist`); CTD analysis in `regulatory/intelligence/ctd/{classify,detect-sections,taxonomy}.ts` [V] |
| **BV 25 % / 75 %** | *Bon de versement* (the ANPP fee payment slip), split 25 % at pre-submission and 75 % before filing. The README glossary says "Bon de **Virement**"; the code says "bon de versement" 140 times and "virement" twice. | `BV_REQUEST_STEPS` {`bv25_req`,`bv75_req`} (L89), `BV_PAYMENT_STEPS`; `requestBV` → `createExpenseOrder({category:"IMPOT", beneficiary:"ANPP", sourceType:"REGULATORY_PRODUCT"})` (`regulatory-actions.ts:1160`); `regulatory/bv-circuit.ts` (`EtatBv` DEMANDE/AUTORISE/PAYE/REFUSE); status `AWAITING_BV_PAYMENT` [V] |
| **Présoumission** | Pre-submission request to ANPP, with an explicit outcome | step `presub_ans`, `RegPresubOutcome` FAVORABLE/DEFAVORABLE/EN_ATTENTE (L163-199); the *presub gate* (L217) [V] |
| **DE / variation** | Holder of the registration decision; manufacturing variation (Importation → secondary / primary packaging → full process) | `deHolder`, `manufacturingVariation`, `manufacturer` (mandatory for local manufacturing), `RegulatoryVariation`, enum `ManufacturingStatus` (schema L54) [V] |
| **Pipeline / cadenas** | Confidential (locked) dossiers, invisible to everyone except Super Admin and people who were granted the pipeline | `RegulatoryProduct.isLocked`; `seesLockedRegulatory` / `holdsRegulatoryLock` (`rbac.ts:1846,1855`) require both the named confidence setting and the `REGULATORY_PIPELINE` module; `scopeRegulatory` (L1901) [V] |
| **PCH** | *Pharmacie Centrale des Hôpitaux*, the public central purchasing body and the company's single institutional client | `PchTender.client @default("PCH")`; Ventes PCH; stock scope `"PCH"` [V] |
| **AO** | *Appel d'offres* (public tender) | `PchTender` (L6973); lots = `PchTenderLine` with `PchLineStatus` PENDING/QUOTED/SUBMITTED/WON/LOST/UNSUCCESSFUL/CANCELLED (L7032) [V] |
| **BC** | *Bon de commande* (purchase order issued by PCH against a contract) | `PchOrder` (+`PchOrderLine` → `PchContractLine`), `PchOrderStatus` PENDING/VALIDATED/DELIVERED/PAID/CANCELLED (L274); `PchOrder.estAvenant` [V] |
| **Avenant** | Contract amendment | `createAmendment` (`pch-market-actions.ts:391`, requires `LEGAL` CREATE); contract = `LegalDocument` (relation `TenderContracts`) [V] |
| **Caution** | Tender guarantee deposit | `PchTender.cautionAmount/cautionDeposited/cautionStart/cautionEnd` [V] |
| **DR** | In Ventes PCH and Stocks: *Direction Régionale* of the PCH (codes "DRA", "DRBE"…), the PCH regional warehouses that serve hospitals | `PchDirectionRegionale` (L16319), `codeDr()` (`ventes-pch/lecture.ts:171`), `StockSnapshot.drCode` [V] |
| **Poste PCH** | PCH article code (the CODE_PRO / POSTE column) | `PchPoste` (poste → Product, `manuel` flag) [V] |
| **Non servi** | Demand not served: the hospital ordered but the DR delivered 0 | `classerLigne` → `NON_SERVIE` (`ventes-pch/lecture.ts:158`), `quantiteNonServie` [V] |
| **KAM** | Key Account Manager, the field rep. In code these are the roles `MEDICAL_DELEGATE` ("Délégué Médical") and `NATIONAL_SALES` | `ROLES_KAM` (`queries/force-de-vente.ts:26`); `SalesRepProfile`, `SalesSector.repId` [V] |
| **BU** | Business Unit, a commercial team / portfolio (supervisor, specialties, products, KAMs, sectors) | `BusinessUnit` (L11530), `PromoProduct.businessUnitId` (the BU catalogue), `BusinessUnitSpecialty`, `BusinessUnitMarketingReferent` [V] |
| **Secteur / In-Out** | KAM territory = a set of establishments or services. "In" = inside the KAM's pivot wilaya | `SalesSector` (+`wilayaPivot`), `SalesSectorInstitution(Service)`; `FaitsPraticien.inOut` (`segmentation/moteur.ts`) [V] |
| **Lettre H / A–D / NA / NC** | Segmentation letter for the #1 product. H = *décideur* (a status, not "A++"); A–D = potential × affinity; NA = an answer is missing (never D); NC = *non ciblé* (not targeted) | `LETTRES` (`segmentation/regles.ts:22`), `STATUTS` DECIDEUR/INFLUENCEUR/REFERENT/PRESCRIPTEUR (L28), `EtatProduit` NON_CIBLE/EN_ATTENTE/A–D [V] |
| **Q1 / Q2 / affinité** | Q1 = patients per week (potential); Q2 = "out of 10 patients, how many on the product"; affinity = Q2/10 or Q2/Q1 | `affiniteAffichee`, `MethodeAffinite` SUR_10 / RATIO_FICHIER (`regles.ts`) [V] |
| **Plan de tournée** | Tour plan (week / month / quarter / half-year) | `TourPlan`, `TourPlanStatus` DRAFT/SUBMITTED/ESCALATED/APPROVED/REJECTED/REVISION (L11863) [V] |
| **Wilaya** | Algerian province (58, closed list) | `src/lib/geo/algeria.ts`, `medical/wilaya.ts` [V] |
| **IQVIA / Nomenclature** | Retail market data / national register of registered drugs | `src/data/market/{iqvia,nom,pch,labs}.ndjson.gz`, `meta.json` (IQVIA March 2026 MAT, 16,469 rows; DZD/USD 135) [V] |
| **PRIM** | *Pharmacien Responsable de l'Information Médicale* (the pharmacist responsible for medical information) | `RegulatoryRequest` (PRIM requests on a dossier), `MedicalInfoDeclaration.produit` (Produits 360 facet) [V, partial] |

### 4.2 Regulatory dossiers

- **Models** [V]: `RegulatoryProduct` is the dossier: `reference` REG-YYYY-NNN, identity tuple (`dci`, `dosage`, `dosageUnit`, `pharmaceuticalForm`, `packaging`), `status: RegulatoryStatus`, `workflow Json`, `checklist Json`, `isLocked`, `companyId`, `productId → Product`, and the supplier-portal fields `external*`. Related tables: `RegulatoryDossierStep` (the frieze: CTD_INITIAL → ANPP_RESERVES → ANPP_RESPONSE → CTD_VERSION → DECISION/OTHER, ordered by `order`), `RegulatoryVariation`, and `RegulatoryStep` (legacy, 17 rows).
- **Status ladder** (`process-status.ts:41`) [V]: PRE_SUBMISSION → IN_PREPARATION → AWAITING_BV_PAYMENT → SUBMITTED → AWAITING_ANPP → RESPONDING_TO_QUERIES → DECISION_OBTAINED → CLOSED. BLOCKED is a state outside the ladder.
- **Derivation** [V]: `statusFromWorkflow` (L108):
  1. any step BLOCKED → BLOCKED;
  2. no FAVORABLE presub answer → PRE_SUBMISSION;
  3. otherwise the first DONE milestone, scanning `MILESTONES` from the most advanced (L63, which still reads the 5 retired réserves keys);
  4. a BV requested but unpaid → AWAITING_BV_PAYMENT, unless something more advanced is reached.

  `deriveStatus` (L140) keeps CLOSED, lets BLOCKED override, and otherwise never moves the status backwards (`keepPast`).
- **Single writer** [V]: `syncStatusFromWorkflow` (`sync-status.ts:34`) writes `status`, audits, calls `synchroniserCycleDeVie(productId)`, and on entering SUBMITTED notifies the regulatory supervisor roles to set the target date.
- **Status as a request** [V]: `updateRegulatoryStatus` (`regulatory-actions.ts:956`) no longer writes `status`. A posted status is turned into "tick every step up to its milestone" (`REG_STATUS_MILESTONE`, `completeStepsThrough`, `regulatory-workflow.ts:269,282`). This also fills a FAVORABLE presub outcome when needed, and never unticks anything.
- **Progress display gate** [V]: `regProgress` (L224) counts the steps done, but shows the dossier as being at step 1 "Réception du CTD complet" until the presub outcome is FAVORABLE.
- **Pipeline** [V]: the `REGULATORY_PIPELINE` module plus `pipelineView` / `pipelineManage`. `scopeRegulatory` is an OR of a "suivi" half (`isLocked:false`, `REGULATORY` scope) and a "pipeline" half (`isLocked:true`). `regulatoryLockWhere` (L1920) is used by reads that do not go through `scopeRegulatory` (stock product pickers, PCH "our product" matching, counters).
- **BV → money** [V]: `requestBV` (`regulatory-actions.ts:1125`):
  - takes a per-(dossier, BV kind) lock inside a `$transaction`, and refuses a second BV unless the existing one was refused or cancelled (`bloqueUneNouvelleDemande`);
  - creates an `ExpenseOrder`, budget category `categorieBvPourOrdre(label)` (Budget Regulatory 25 %/75 %), pending at the payment centre;
  - ticks the `bv*_req` step.

  At settlement, `bv-reglement.ts` requires the *quittance* (payment receipt), files it on the dossier's payment step and ticks `bv*_pay` (`cocherPaiementBv`, L91).
- **Regulatory Intelligence OS** (CTD analysis) [V, structural only]: `RegulatoryDossier` (schema L10343, optional `productId` link to `RegulatoryProduct`) with versions, documents, extractions, findings, reserve cycles, an AI-cost ledger (`RegulatoryAiCall`, `aiBudgetUsd`), jobs (`runDueRegulatoryJobs` in `scheduled.ts:109`). It is gated per company by `RegulatoryFeatureAccess` and fine-grained `regCan` permissions (`intelligence/access.ts:89`). Routes: `/regulatory/enregistrement/{analyse,corpus,entrainement,reserves}`.

### 4.3 Produits 360 — "product = regulatory dossier"

- `Product` (L14868) is a thin identity anchor: `code` PRD-YYYY-NNN, `canonicalName`, the identity tuple, and a unique `identityKey`. Its profiles are `RegulatoryProduct`, `PromoProduct` (BU catalogue), `BdProduct`. Sales, visits, segmentation, tender and contract lines, consumption, PCH sales/receptions, costs and prices all reference `Product.id`. [V]
- `identityKey = cleDci|normalizeDosage|normalizeForme|normalizePackaging` (`products/identity.ts:197`). [V]
- **One dossier → one product** (`produit-du-dossier.ts:108`, pure). The plan is one of CREER / METTRE_A_JOUR / DEJA / PARTAGE / SEPARER [V]:
  - a dossier never borrows another dossier's product;
  - a legacy product shared by several dossiers is not split automatically — only a dossier whose identity diverges gets its own (SEPARER);
  - an incomplete identity gets a key derived from the dossier (`dossier:` prefix), so two incomplete dossiers never merge.
- **Writer**: `ensureProduitDuDossier` (`canonique.ts:153`) [V]:
  - returns VERROUILLE for a locked dossier that has no product yet, so the catalogue does not reveal the project;
  - handles a cross-process race with `updateMany` guarded on the old `productId`, and deletes its own orphan on loss;
  - called from create/update/lock/unlock, `createPromoProduct`, linking actions, and the boot sweep `assurerProduitsDesDossiersAuDemarrage` (`scheduled.ts:107`).
- **Lifecycle** [V]:
  - `cycleDeVieDerive` (`canonique.ts:51`) moves only between STUDY and REGISTERED (REGISTERED iff some dossier is DECISION_OBTAINED). MARKETED and DISCONTINUED are human decisions.
  - The **list** "Commercialisés" uses a different rule: `clauseProduitTermine` = some dossier with status in {DECISION_OBTAINED, CLOSED} (`products/termines.ts:11-14`). `etapeCycle` (`fiche-360.ts:31`) uses the same rule to show COMMERCIALISE.
- **Facets** (`vues-360-acces.ts:7`) [V]: reglementaire → REGULATORY, marches → PCH, ventes → SALES (retired, so always hidden), ventesPch → PCH_VENTES, segmentation, consommation, finances, terrain → MEDICAL, forceDeVente → SALES_PLANNING, adpro → SPONSORING, stock → STOCKS, pharmacovigilance, materiel → PROMO_STOCK, marketing → MARKETING_COCKPIT.
- **Prices** [V]: `peutModifierLesPrix` = PRODUCTS UPDATE or REGULATORY UPDATE. `voitLeMarche` = BUSINESS_DEVELOPMENT (retired) or PRODUCT_EXPLORER.
- **Health score** `products/sante.ts` /100 [U for weights; the README claims Stock 25 · Couverture 25 · Prescripteurs 20 · Réglementaire 15 · Qualité 15].

### 4.4 Marchés PCH (Market 360°)

- **Models** [V]: `PchTender` (dates `publishedAt`, `submissionDeadline`, `submittedAt`, `awardDate`; decided `status: PchTenderStatus`; caution; `businessUnitId`). Related: `PchTenderLine` (lots, `productId → Product`), `PchTenderLineBusinessUnit`, `PchTenderExtraction` (AO reading), `PchSubmission` (versioned, `lockedAt`), contracts = `LegalDocument`, `PchContractLine`, `PchOrder` / `PchOrderLine`, `PchDelivery` / `PchDeliveryLine`.
- **Derived level** `deriverNiveau` (`pch/market-math.ts:236`) [V]: decided states (CANCELLED / SUSPENDED / LOST / COMPLETED) win. Otherwise:
  - WON lots + a BC or an active contract → EXECUTION;
  - WON lots only → CONTRACTUALISATION;
  - all lots decided, none won → PERDU;
  - `submittedAt` set → SOUMIS;
  - some lot priced or worked → PREPARATION;
  - otherwise BROUILLON.

  Header steps: Préparation → Soumission → Attribution → Contrat → Exécution → Clôture.
- **Actions** [V]:
  - `submitSubmission` sets the submission to SUBMITTED + `lockedAt` and the tender's `submittedAt` in one transaction, which freezes the lines;
  - `setLineResult` (L242): WON requires awarded qty ≤ submitted qty, and stamps `modifieeLe` so a later AO re-read does not overwrite the human decision;
  - `createContractFromAward` (L292) needs PCH UPDATE and LEGAL CREATE;
  - `createAmendment` (L391) needs LEGAL CREATE;
  - `createDelivery` (L662): when "createStockMovements" is ticked, it writes `StockMovement{direction:"OUT", location:"PCH"}` only when the line's `Product` has **exactly one** dossier (`take: 2`, `reg.length === 1`, L722-741); otherwise it counts `sansProduit`.
- **AO reading** (`pch/lecture-ao.ts`) [V]: `lireDocumentAo` (L58) reads native text or OCRs it (`ocrDocument`, langs fra/eng, ≤40 pages). `demanderLignesAo` (L113) asks Claude (`askClaude`, temperature 0.1) for strict JSON `{lines:[…]}` on text cut to 24,000 characters (`BUDGET_CARACTERES`). `extraction.ts` validates the result and plans replacements, keeping human-touched lines.
- **Deadline sweep** `runPchDeadlineSweep` (`scheduled.ts:151`). Zones: J-7 PROCHE, J-2 URGENTE, passed DEPASSEE; it reminds once per zone entry (`doitRappelerDepot`). [V]
- Gate per tender: `peutAgirSurLeMarche` (`pch/porte-marche.ts:28`). [V]

### 4.5 Ventes PCH — file import pipeline

1. **Upload** at `/sales/importer`. `apercuFichiersVentesPch` (preview, nothing written) then `appliquerFichiersVentesPch` (`ventes-pch-actions.ts:75`, requires `PCH_VENTES` UPLOAD). The period can be chosen per file (`periodes` JSON {annee, mois | "annuel"}). [V]
2. **Read** `lireClasseurPch` (`ventes-pch/service.ts:32`): SheetJS `XLSX.read`, first sheet whose header is recognised. `detecterEntete` (`lecture.ts:69`) scans the first 10 rows [V]:
   - **VENTES_DR** (DR sales) needs CLIENT, POSTE, DCI, QTE_COMMANDEE, QTE_LIVREE;
   - **RECEPTIONS** (PCH central receptions) needs NOM_FOUR, CODE_PRO, DESI_PRO, QTE, TYPE_RECEP;
   - header keys are accent-stripped, upper-cased and normalised to `_`.
3. **Classify** each sale line: RETOUR (delivered < 0), NON_SERVIE (ordered > 0, delivered 0), PARTIELLE, SERVIE, NULLE (`lecture.ts:158`). [V]
4. **Map** (`correspondance.ts`, pure) [V]:
   - establishment: memory (`PchEtablissementMemoire`) wins; otherwise `cleClient` must match exactly one active `MedicalInstitution`; otherwise "à rattacher" (to be linked by hand);
   - product: a manual `PchPoste` mapping wins; otherwise the presentation (molecule + first dose + form family, packaging as tie-break) must match exactly one Product (IDENTITE). Otherwise AMBIGU, MOLECULE (our molecule, other presentation) or MARCHE (not ours → market data);
   - `decisionPoste` never overrides `manuel`.
5. **Replace plan** `planRemplacement` (`calculs.ts:121`) [V]:
   - same SHA-256 `empreinte` → nothing (`deja`);
   - otherwise each tranche `source × mois` (source = DR code, or `RECEPTIONS`) replaces the same tranche in any older import. Imports fully covered get `remplaceParId`; partly covered ones are "entamés" (partly superseded, e.g. an annual file after a corrected month).
6. **Apply** `appliquerFichierPch` (`service.ts:304`), in one `$transaction` (timeout 180 s) [V]:
   - delete the replaced tranche lines (`pchVenteLigne` by dr+mois, `pchReceptionLigne` by mois);
   - create `PchVenteImport` with the original file bytes (`fichier: buffer`), `sources`, `mois`, `periodeAnnee/periodeMois` and the report;
   - insert lines in batches of 1,000;
   - create new `PchPoste` rows; re-point non-manual postes whose decision changed, cascading `productId` onto already-imported lines.
   
   After the transaction, `apresImport` creates unknown DRs (wilayas inferred from linked clients) and `proposerFournisseursPch` proposes "our" suppliers (supplier name ≈ partner lab / DE holder / manufacturer), never overwriting a human setting.
7. **Manual mapping** actions (require `PCH_VENTES` UPDATE): `rattacherEtablissementVentesPch`, `rattacherPosteVentesPch`, `reglerFournisseurVentesPch`, `enregistrerDrVentesPch`. All are audited and memorised for future files. [V]
8. **Read API** (`requetes.ts`): `venteParProduitEtMois`, `demandeNonServie`, `consommationHospitaliereMensuelle`, `receptionsPch`, `partDeMarche`, `synthesePch`, `chainesContratsPch`, `territoiresPch`, `matriceNonServi`, `fraicheurPch`, `indicateursProduitsPch`. [V]

### 4.6 Stocks — dated states

- `StockSnapshot` (L10102) [V]:
  - `scope` PCH | HOSPITAL | ANNEX;
  - `annexId` = hospital/annex place; `drCode` = a PCH DR (scope ANNEX, `annexId` null);
  - `productId` references **`RegulatoryProduct`** (the dossier), not `Product`.
  
  The code states "Adventum n'a pas de stock propre": the chain is PCH central + DR + hospitals (`stocks/pch-central.ts:205-211`, `queries/stock-pch.ts:140-145`).
- **One state per (scope, annex, drCode, product, UTC day)**: `ecrireEtatDuJour` (`stocks/etat-jour.ts:24`) is find-then-update-or-create, so re-entering the same day corrects it. It is shared by the module form and the stock-request answer, and performs no permission check (callers hold the scope, §118.134). [V]
- **PCH central** is entered by hand from the PCH email ("Coller le tableau", or an xlsx via SheetJS in `stock-pch-actions.ts:11`). It writes ordinary snapshots. [V]
- **Chain coverage** [V]:
  - `chargerProduitsPch` (`queries/stock-pch.ts:50`) lists BU catalogue rows that have a dossier, with ids = **dossier ids**;
  - `chargerChaine` (L151) reads the latest snapshot per product / DR / hospital;
  - `chargerConsommationMensuelle` (L278) maps dossier → Product (`canoniquesDesDossiers`, L262) and averages the last 3 complete months of DR deliveries to hospitals from Ventes PCH (`consommationMoyenne`, `pch-central.ts:197`).
- **Stock requests and recurrences**: `StockCountRequest` (DO → KAM, lines per hospital × product, written as snapshots on send) and `StockRequestRecurrence` (DAILY / WEEKLY / MONTHLY). They are fired by `declencherRecurrencesStock` (`scheduled.ts:137`). [V for wiring; U for the auto-stop details]

### 4.7 Segmentation Studio → Force de vente → field

- **Models** [V]: `SegmentationStrategie` (one per BU, ≤3 ranked products via `SegmentationStrategieProduit` → `Product`), `SegmentationRegle` (versioned JSON `contenu`, published), `SegmentationFiche` (doctor × strategy: statut, zone, secteurId), `SegmentationDerogation`, `HcpObservation` (Q1/Q2 history, erasure markers), `SegmentationCycle` (frozen snapshot), `SegmentationImport`.
- **Engine** `segmentation/moteur.ts` is pure, deterministic and explainable [V]:
  - missing data → EN_ATTENTE / NA, never D;
  - H is a status, not a score;
  - every threshold comes from the rule version;
  - a derogation keeps both values readable.
  
  Context linked in (not copied): specialties per product (`PromoProductSpecialite`) and **establishment affinity from Consommation** (`affinitesEtablissements`, `segmentation/service.ts:20`).
- **Required visits** `segmentation/lettre-requise.ts` (pure, client-safe) is the only "requis" (required visit count): letter × In/Out × sector frequency. It falls back to the legacy potential tier (`MedicalDoctor.potential` × `SfeSettings.frequencyByTier`). Consumers [V]: `queries/force-de-vente.ts`, `my-field-day.ts` (Ma journée), `tour-schedule.ts`, `sfe-cockpit.ts`, `sfe-alerts.ts`, `kpi/briques-calcul.ts`, `influence.ts`, `api/medical/plan-de-tournee/[id]/pdf`.
- **Rights** `droitsSegmentation` [V]: VIEW = voir, UPDATE = saisir Q1/Q2/statut, CREATE = panel, VALIDATE = rules/import/strategy. FORCER requires `SEGMENTATION_POTENTIEL`, which is granted to no role by default and opens every other gesture. Scope is the KAM panel (`porteeSegmentation`). Ranked products must be in the BU catalogue (`produitsHorsCatalogue`).
- **BU set-up** `sales-planning-actions.ts` [V]: BU CRUD, BU specialties, BU catalogue (`createPromoProduct` → `ensureProduitDuDossier` when a dossier is linked), sectors / territories, KAM pivot wilaya, `renommerSecteur`, BU marketing referents.
- **Tour plan** (`tour-plan-actions.ts`, module **MEDICAL**, L37) [V]:
  - DRAFT → SUBMITTED (L333, reviewer = N+1) → ESCALATED (L402, compare-and-set on SUBMITTED) → APPROVED / REJECTED (L467-468);
  - APPROVED → REVISION (L535);
  - only a DRAFT can be deleted (CAS on `updatedAt`, L619).
- **Visits** [V]: `logVisit` (`medical-actions.ts:705`, MEDICAL CREATE + own doctor or DOCTOR UPDATE) creates a `MedicalVisit` COMPLETED with products and messages, and updates `MedicalDoctor.lastVisit`.
- **Field reports** [V]: `FieldReport` DRAFT → VALIDATED → ARCHIVED (dictation → Claude analysis → review). `submitFieldReport` (`field-report-actions.ts:160`) validates and, for a report without a visit, writes promo-material *remises* (handed-over items) from the KAM's own stock under locks. The rules: a doctor from the annuaire is required, a 48 h window applies, and nothing is handed over for a future visit (§118.204).
- **Coaching** (`coaching/*`, §118.157) [V]: grid of 5 axes × 4 levels MB/MP/MA/PM (total /20), `CoachingSheet` DRAFT → finalised, ExcelJS export. Access is role- and organigram-based (`coaching/acces.ts`: Direction / Operations Director / Super Admin administer), with no RBAC module key.

### 4.8 Marketing cockpit

- Reads only, assembled from existing tables (`marketing-cockpit/donnees.ts` header) [V]: segmentation panel (`chargerStrategie` / `chargerPanel`, never recomputed), completed visits, message ↔ visit links, Ad & Pro allocations, promo stock, budget envelopes. "Terrain" adds service needs, declared affinity over 3 cycles, our lots at hospitals, and the field voice (`terrain-donnees.ts`).
- **Market tab** gate `peutVoirMarcheCockpit = userCan(user,"BUSINESS_DEVELOPMENT","VIEW")` (`acces.ts:14-15`) [V]. Since `BUSINESS_DEVELOPMENT` is retired, this is always false (see §9).
- **Money** = BUDGET_MARKETING or BUDGETS or SPONSORING VIEW (L18-19). Writing messages = Super Admin role list plus a cockpit gesture. [V]

### 4.9 Stock & Catalogue promotionnel

- Ledger of `PromoStockMovement` per lot (`PromoMovementKind` (enum) values, schema L8044) [V]:
  - RECEIPT, DISTRIBUTION, LOSS, CORRECTION, OPENING;
  - TRANSFER_OUT / TRANSFER_IN / TRANSFER_BACK;
  - REVERSAL (exact inverse, `annuleId` unique);
  - RESERVATION_OUT / RESERVATION_BACK (Ad & Pro events, §118.167).
  
  Quantities are always computed from movements. A transfer counts for the recipient only after confirmation. Movements can be anchored to `visitId` / `fieldReportId` / `doctorId`.
- Catalogue = `PromoCatalogueArticle` with fixed CAT-NNNN references (`PROMO_CATALOG`). The purchasing circuit `PromoMaterial` (Ad & Pro) has 3 generations of status; always read it through `promo-material/statut.ts` (§118.153). [V]

### 4.10 Market data

`src/lib/market/data.ts` loads gzipped NDJSON lazily from `src/data/market/` with `readFileSync` + `gunzipSync`, and caches it in memory. It is **server-only**. Pure helpers `galenic.ts` and `text.ts` are client-safe, while `molecule.ts` re-exports for the server. [V]

Consumers [V]: the Product Explorer, `market-actions.ts`, `pch-tender-line-actions.ts` (enrichment: competitors, nomenclature, prices), `marketing-cockpit/marche.ts`, and the retired `/business-development/marche/*` pages.

### 4.11 Annuaires & Consommation

- **Annuaires** [V]:
  - `MedicalDoctor` (grade `title`, `specialtyId`, `institutionId`/`serviceId` links, wilaya, legacy segment fields), `MedicalInstitution(Service)`, `MedicalSpecialty`;
  - `DIRECTORIES` is granted implicitly (`rbac.ts:1551`); each directory is gated by `peutAnnuaire` (`annuaires/acces.ts:139`, with per-directory sections `ANNUAIRES_ACCORDABLES`);
  - linking a practitioner to an establishment by name is done "à coup sûr" (with certainty, `annuaires/rattachement.ts`, §118.172);
  - workbook import/export via SheetJS (`medical/directory-workbook.ts`).
- **Consommation** (`consommation/service.ts`) [V]:
  - pipeline: upload → analysis → resolution (memory 99 › exact 97 › partial 60 → review) → unit normalisation → duplicate checks → human review → validation;
  - affinity per establishment = product ÷ market basket, same unit only (`affinite.ts`). It feeds segmentation and Produits 360.

### 4.12 Site web (adventumdz.com)

- **Outbound** [V]:
  - `mettreEnFile` (`site-web/file.ts:85`) keeps one queue row per content (`SitePublication`) with a monotonically increasing `version`. A success confirms only the version it carried;
  - retries back off 1 s / 5 s / 30 s / 2 min / 10 min, with no retry on 4xx except 429 (`contrat.ts` header);
  - an in-process timer (`reveillerFile`, L238) handles short delays, and the heartbeat drains the rest (`viderFile` L286 via `scheduled.ts:198`);
  - `transport.ts` is the only network caller. It has an egress guard under tests / `ADAM_SORTIE_INTERDITE` (localhost allowed, §118.159) and signs bodies (`signer`, L87).
- **Daily reconciliation** `rapprocherSiteSiDu` (`reconciliation.ts:389`, interval 24 h, retry 1 h) [V]: `GET /jobs` and `GET /posts` are compared with what the ERP wants (`voulusDepuisLaBase`, recomputed from content):
  - missing or divergent content is re-queued;
  - deleted-here content has its DELETE replayed;
  - identical content is confirmed;
  - content unknown to the ERP is only named, never deleted (§118.9).
  
  It can be disabled with `SITE_WEB_RECONCILIATION=off`.
- **Liaison** [V]: `entretenirLiaison` presents a pending key, promotes it once the site uses it, reads `/health` hourly, and reconciles when `bootId` changes. Keys are generated by the ERP (`cles.ts`; `SiteWebCle` ATTENTE / ACTIVE / RETIREE).
- **Inbound** [V]: `authentifierLeSite` (`entrant.ts:63`) does constant-time comparison of the `Authorization: Bearer` key against the ACTIVE / ATTENTE keys (or the env `ADVENTUM_API_KEY` when no active key exists). When the candidate key has a secret, it requires `X-Adventum-Signature` = HMAC-SHA256 of the exact raw body ("" for GET). Routes: `/api/site-web/v1/{candidatures,contenus,audience,audience.js}`.
- **Candidatures** [V]: `recevoirCandidature` (`candidatures.ts:198`). A CV ≤5 MB for an offer linked to an open recruitment (SOURCING stage) becomes a `RecruitmentCandidate` directly. Otherwise it waits in the HR inbox (`SiteCandidature` NOUVELLE / RATTACHEE / CLASSEE) with a reason.
- **Audience**: cookieless events, purged after 13 months (`purgerAudienceSiDu`). [V]

### 4.13 Data import / parsing mechanisms (this area)

| Mechanism | Where | Library |
|---|---|---|
| PCH sales / receptions workbook | `ventes-pch/service.ts:32` | `xlsx` (SheetJS), raw cells, header detection |
| PCH central stock paste / file | `actions/stock-pch-actions.ts:11`, `stocks/pch-releve-fichier.ts` | `xlsx` + pure paste parser (`stocks/pch-central.ts`) |
| Segmentation workbook (Direction sheet) | `segmentation/feuilles.ts`, `import-direction.ts`, `lecture-classeur.ts` | `xlsx` |
| Consumption files | `consommation/service.ts`, template `api/consommation/modele` | `xlsx` |
| Annuaire import/export | `medical/directory-workbook.ts` | `xlsx` |
| Coaching sheet / regulatory export | `coaching/classeur.ts`, `regulatory/export.ts` | `exceljs` (write, formulas) |
| Planning / segmentation exports | `api/planning/export`, `api/segmentation/export` | `xlsx` |
| Tour-plan PDF | `src/lib/plan-tournee-pdf.ts` | `pdfkit` |
| AO documents (PDF, scans) | `pch/lecture-ao.ts` → `regulatory/intelligence/extract/texte-ou-ocr.ts` → `ocr/ocr-engine.ts` | `pdf-parse` / `mammoth` / `xlsx` in a worker thread (`extract.worker.cjs`, `heavy-parse.ts`); OCR via Mistral (`MISTRAL_API_KEY`, `REG_OCR_ENGINE`), fallback `mupdf` + `sharp` + `tesseract.js` (fra/eng/ara), then vision-AI rescue of empty pages (`vision-ocr.ts`, `REG_OCR_AI_PAGES`=40, cached and cost-tracked) |
| CTD zip upload | `intelligence/ingest/zip-inspector.ts` | `jszip` |

## 5. Conventions & patterns to follow (house style)

1. **Pure rule module + thin DB writer.** Examples: `produit-du-dossier.ts` / `canonique.ts`, `process-status.ts` / `sync-status.ts`, `ventes-pch/calculs.ts` / `service.ts`, `market-math.ts`, `segmentation/moteur.ts` / `service.ts`. Pure modules carry no value imports, so client components can use them (`lettre-requise.ts`, `site-web/contrat.ts`, `stocks/pch-central.ts`). [V]
2. **Derive, don't double-store (§118.5).** Dossier status comes from the workflow, the tender level from facts, product lifecycle from dossier statuses, promo quantity from movements, and site state from the queue. When adding a field that restates another, write a deriver instead. [V]
3. **Never step backwards and never erase history.** `deriveStatus` keeps the more advanced past; `completeStepsThrough` never unticks; retired workflow keys are still read in `MILESTONES`; replaced PCH imports are kept (`remplaceParId`). [V]
4. **Human decisions beat automation**: manual `PchPoste`, establishment memory, `setLineResult.modifieeLe`, supplier settings, human-chosen product names (`nomAutomatique`), forced segmentation letters. [V]
5. **Every write action** does `requireUser()`, then `userCan(module, verb)` or `canAccessEntity(entityType,id,verb)`, then the write, then `recordAudit` (and `notify*` when relevant), then `revalidatePath`. It returns `ActionResult {ok, error?, message?}` with French user-facing error messages. Pages use `requireModule("KEY")`. [V]
6. **Concurrency**: compare-and-set `updateMany({where:{id, status/updatedAt}})` for state transitions; `enSerie` + `createWithRetry` for human references (§118.175/178); per-key locks inside `$transaction` (BV); a cross-process race in `ensureProduitDuDossier` handled by guarded update + cleanup. [V]
7. **Scope at the query layer**: locked dossiers are filtered in `scopeRegulatory` / `regulatoryLockWhere`, never only in the screen. Any new read that names regulatory products must apply one of the two. [V]
8. **Missing ≠ 0**: `consommationMoyenne` returns `null` with no data; `partDeMarche` returns `null` on an empty market; segmentation NA is never D; the cockpit shows "—" with a reason. [V]
9. **Client/server boundary**: keep `market/data.ts`, `ventes-pch/service.ts`, `site-web/transport.ts` and the OCR modules out of client imports; the `client-bundle-guard.test.ts` ratchet enforces it (CLAUDE.md). [V for the doc; U for exhaustive coverage]
10. Module keys and copy are French. Use the `§118.x` citations in comments when encoding a doctrine decision.

## 6. End-to-end flows

### (a) Regulatory dossier → commercialised product → stock → PCH sales

1. **Create** `/regulatory` "Nouveau dossier" → `createRegulatoryProduct` (`regulatory-actions.ts:258`) [V]:
   - requires `REGULATORY` CREATE (or `REGULATORY_PIPELINE` CREATE when created locked) (L270);
   - DCI duplicates produce a warning that can be bypassed with "J'ai vérifié" (`duplicateNotice`);
   - entity (`companyId`) is mandatory;
   - a non-locked dossier requires initial CTD files (L322-325);
   - a local variation requires `manufacturer`.
2. **Insert** under `enSerie("REG")` (L330) with reference `REG-<year>-NNN`, and seed 17 legacy `RegulatoryStep` rows (L368-374). Then: audit; a Drive folder in the background (`creerDossierDriveProduit`); **`ensureProduitDuDossier`** (L402), which creates `Product` PRD-… with `lifecycle` STUDY (skipped while locked); notifications to the responsible person and supervisors (except when locked). [V]
3. **Work the process** on `/regulatory/[id]` [V]:
   - `setRegulatoryStepState` (L1035) updates the step JSON (`date` defaults to today on DONE);
   - `setRegulatoryPresubOutcome` (L1069) sets `presub_ans` with its outcome;
   - `requestBV` (L1125) on `bv25_req` / `bv75_req` creates an `ExpenseOrder` → payment centre → Finances settle with receipt → `cocherPaiementBv` ticks `bv*_pay`;
   - réserves are recorded as `RegulatoryDossierStep` entries.
   
   Each step change calls `syncStatusFromWorkflow`, so the status moves e.g. PRE_SUBMISSION → IN_PREPARATION (presub favourable + steps) → AWAITING_BV_PAYMENT → SUBMITTED (`depot`, with a supervisor notification) → AWAITING_ANPP → RESPONDING_TO_QUERIES → DECISION_OBTAINED (`decision`).
4. **Decision** → `synchroniserCycleDeVie` sets `Product.lifecycle = REGISTERED` (`canonique.ts:57`). The product now appears in Produits 360 "Commercialisés" because `clauseProduitTermine` matches DECISION_OBTAINED/CLOSED; `etapeCycle` = COMMERCIALISE. [V]
5. **BU catalogue** `createPromoProduct` (Business Units) links a `PromoProduct` to the dossier and Product. This makes it rankable in a segmentation strategy and visible in Stocks (`chargerProduitsPch` lists only promo products that have a dossier). [V]
6. **Stock** [V]:
   - KAM / DO / supply chain enter dated `StockSnapshot` rows against the **dossier id** (hospital, PCH central, DR);
   - PCH deliveries can write `StockMovement` OUT against the single dossier of the line's Product (`pch-market-actions.ts:722`).
7. **PCH sales** [V]: imported PCH files map `PchPoste` → **Product.id**. `/stocks/chaine` bridges dossier → Product (`canoniquesDesDossiers`) to compute coverage = stock ÷ average monthly hospital consumption (red under 2 months, orange under 3 — thresholds per README [U]). Produits 360 › Ventes & marchés reads `indicateursProduitsPch`.

### (b) PCH sales file → dashboards

1. `/sales/importer` (`requireModule("PCH_VENTES")`): the user drops `.xlsx` files and can choose a period per file. [V]
2. Preview: `apercuFichiersVentesPch` → `apercuFichierPch` (`service.ts:281`). It computes the SHA-256; a known `empreinte` reports "déjà importé". Then `preparer` (L257): `lireClasseurPch` → `detecterEntete` → `lireVentes` / `lireReceptions` → mapping context (`chargerContexte`: institutions, memory, active Products, postes) → `deciderPostes` → `planRemplacement` lists the tranches it would replace. Nothing is written. [V]
3. Apply: `appliquerFichiersVentesPch` → `appliquerFichierPch` [V]:
   - re-check the hash ("même fichier = rien");
   - in a single transaction, delete the lines of each replaced tranche (DR × mois, or mois for receptions) — "un fichier plus récent remplace sa DR × mois", meaning the most recently *applied* file (§9);
   - create `PchVenteImport` with the original bytes kept and old imports marked `remplaceParId`;
   - batch-insert the lines, create or re-point postes, and cascade `productId`.
   
   Then `apresImport` creates DRs and proposes suppliers. Each file is audited as `IMPORT` on module `PCH_VENTES`.
4. Mapping queue (`/sales/importer` "gestes"): `etablissementsARattacher`, `postesNosMolecules`, `fournisseursParProduit`. Each mapping action rewrites all already-imported lines and memorises the choice. [V]
5. Consumers of the data (`rg ventes-pch/requetes|pchVenteLigne`) [V]:
   - `/sales` (Synthèse BU → produit, Contrats via `chainesContratsPch` incl. `estAvenant`, Territoires, Non servi);
   - Cockpit Opérations (`queries/cockpit-operations*.ts`);
   - Stocks de la chaîne (`queries/stock-pch.ts`);
   - Produits 360 (`queries/produits-360.ts`);
   - Marketing cockpit terrain (`marketing-cockpit/terrain-donnees.ts`);
   - KPI bricks (`kpi/briques-pch.ts`), Ad & Pro ROI (`queries/roi-adpro.ts`), lots (`queries/parts-lots.ts`), Luna influence (`influence-luna.ts`).

## 7. Coupling & blast radius

```
Annuaires (MedicalDoctor/Institution/Specialty) ──► SalesSector (KAM territory) ──► Segmentation panel/letter
        ▲                                                                                │
Consommation (affinité établissement) ───────────────────────────────────────────────────┘
        │                                    lettre-requise ──► Ma journée / TourPlan / PDF / Force de vente / alerts / KPI
        │                                                       └─► MedicalVisit / FieldReport ──► PromoStockMovement (remises)
        │                                                                └──► Marketing cockpit (panel, visits, messages, voix terrain)
RegulatoryProduct ──ensureProduitDuDossier──► Product ◄── PromoProduct (BU catalogue) ◄── SegmentationStrategieProduit
   │  (BV) ─► ExpenseOrder ─► Payment centre ─► Finances ─► bv*_pay   ▲         ▲            ▲
   │                                                                  │         │            │
   ├─► StockSnapshot / StockMovement (dossier id!) ◄── PchDelivery    │   PchTenderLine / PchContractLine
   └─► Produits 360 (facets per module)                               └── PchPoste ◄── Ventes PCH import ──► Cockpit Ops, Stocks chaîne, P360, KPI
Site web: RecruitmentRequest / blog posts ─► SitePublication queue ─► adventumdz.com ; candidatures ─► Recruitment
```

- **Two id spaces for "product".** Stocks and `StockMovement` use `RegulatoryProduct.id`; everything commercial uses `Product.id`. Changing `ensureProduitDuDossier` or the dossier → product link affects stock coverage (`canoniquesDesDossiers`), PCH delivery → stock (needs exactly one dossier per Product), segmentation, and Produits 360. [V]
- **`RegulatoryProduct.workflow` JSON keys** are read by `process-status.ts` (`MILESTONES`), `regProgress`, the BV circuit, the CTD-initial rule (first step key `ctd`), the Chief of Staff (`workflowAsSteps`), Budget Regulatory and exports. Renaming a step key silently breaks status derivation; retired keys must stay in `MILESTONES`. [V]
- **`RETIRED_MODULE_KEYS`** affects `rbac.getAccess` (every `userCan`), the menu, URLs and Adam tools. Adding PCH or PRODUCT_EXPLORER there would kill Market 360 and the explorer (warned in the file). [V]
- **`lettre-requise.ts` / segmentation rules** drive every "required visits" figure: pilotage, Ma journée, tour plan PDF, alerts, KPI. [V]
- **Ventes PCH mapping** (`correspondance.ts`, `normalisation.ts` → `market/galenic.ts`): a change of the presentation key can re-point postes on the next import. Only non-manual postes move. [V]
- **Site-web contract** (`contrat.ts`) is shared with the external site repo (`docs/openapi.yaml` there). Field or limit changes must match. [U for the external side]

## 8. Invariants, gotchas, doctrine

- **§118.5** — one source per fact. This is cited throughout (process status, CTD initial, promo status, tour-day calendar). [V]
- **§118.9** — only something FOUND authorises action. Reconciliation never deletes unknown site content. [V]
- **§118.134** — `ecrireEtatDuJour` checks no permission; callers must scope. [V]
- **§118.157** — coaching. **§118.158/159** — site-web queue and liaison. **§118.163** — `BD_PROJECTS` survives the Market Intelligence retirement as its own module. **§118.164/167/173** — promo stock and catalogue. **§118.172** — linking by name to establishments. **§118.175/178** — reference under queue; product lifecycle. **§118.204** — promo items handed over in field reports. **§118.213** — CTD initial is a fact (category + step 1). **§118.193** — TourPlan REVISION. **§118.153** — read the promo status via `statut.ts`. [V, cited in code]
- Gotcha: **No DB unique constraint** on the "one snapshot per day" rule (`etat-jour.ts`: find then create). Two concurrent entries for the same place / day / product can create duplicates. [V for code; U for whether a migration adds a partial index]
- Gotcha: **The PCH delivery → stock movement is silently skipped** when a Product has 0 or ≥2 dossiers (reported only as a count, `sansProduit`). [V]
- Gotcha: **Lifecycle vs list disagree on CLOSED.** A product whose only dossier is CLOSED (never DECISION_OBTAINED) keeps `lifecycle` STUDY (`cycleDeVieDerive`) but shows as "Commercialisé" in the list and frieze (`termines.ts`, `etapeCycle`). [V]
- Gotcha: **The legacy `RegulatoryStep` table** (17 rows, the "17-step workflow") is still seeded on every create (`regulatory-actions.ts:368`) and editable through `updateRegulatoryStep` (L907). It is still read by `queries/team-kpis.ts:225`, `assistant/time-travel.ts:231` and `assistant/three-sixty.ts:625`. `workflowAsSteps` exists precisely because the Chief of Staff had read this stale store (`regulatory-workflow.ts` comment). Those readers can still diverge from the screen. [V]
- Gotcha: **Inbound site auth without a secret.** If the env fallback key `ADVENTUM_API_KEY` is used and `ADVENTUM_WEBHOOK_SECRET` is empty, the HMAC check is skipped (`entrant.ts`: `if (trouvee.secret)`). [V]
- Gotcha: the site-web drain guard `videEnCours` is per process; multi-instance safety relies on the row lock with `VERROU_PERIME_MS` = 2 min (`file.ts:45`). [V for the constant; U for the exact locking query]
- Gotcha: **The `scheduled.ts` heartbeat** only arms on the first request served after boot, and pauses when the host sleeps. Boot sweeps (products of dossiers) run from there. [V]
- Invariant: a ticked step date defaults to today only on DONE. Status milestones only tick steps that are not BLOCKED. [V]

## 9. Docs-vs-code discrepancies

1. **"Workflow 17 étapes + processus officiel ANPP (19 étapes / 5 phases)"** (panorama L47). The 17-step workflow is the legacy `RegulatoryStep` table, still seeded and read by KPIs and the assistant; the 19-step JSON is what the screen and status use. The schema comment on `workflow` says "22 étapes" (schema L1736) and `process-status.ts` says "vingt-trois étapes". All three numbers coexist; the code truth is 19. [V]
2. **BV = "Bon de Virement"** (glossary). The code says "bon de versement" (140× vs 2×). [V]
3. **"Un fichier plus récent remplace sa DR × mois."** There is no recency comparison: the **last applied** file replaces the tranche, even if its content is older (`planRemplacement`, `calculs.ts:121`). Re-importing an old file whose hash differs overwrites newer data. [V]
4. **Stocks de la chaîne = "notre stock + stock PCH central + somme des derniers relevés hôpitaux"** (panorama L79). The code explicitly drops "notre stock": the chain is PCH central + DR + hospitals (`stock-pch.ts:140-145`, `pch-central.ts:205-211`). [V]
5. **Marketing cockpit "Marché" tab "seulement pour qui a déjà le marché, Business Development"** (panorama L74). It is gated on `BUSINESS_DEVELOPMENT`, which is retired, so it is unreachable for everyone, Super Admin included (`marketing-cockpit/acces.ts:15`). It should probably use `PRODUCT_EXPLORER` like `voitLeMarche`. [V]
6. **Retired modules: "ni action serveur"** (panorama L76). `sales-actions.ts` / `logistics-actions.ts` and the `/logistics` and `/business-development` pages still exist. They are dead because `userCan` / `requireModule` refuse them (`rbac.ts:1275,1440`). `RETOURS_RECLAMATIONS` was removed from `MODULES` entirely, rather than added to `RETIRED_MODULE_KEYS`. The `Reclamation` table is kept, with no `prisma.reclamation` caller, and old links are redirected to `/mon-espace` (`notifications/lien-actuel.ts:87`). "Ses lignes" (README) do not exist as a model: the thread uses `Comment` and the attachments use `Document`. [V]
7. **Produits 360 `ventes` facet → `SALES`** (`vues-360-acces.ts:8`) is permanently hidden. Legacy `prisma.sale` reads remain in `product-360.ts:236-248`, `produits-360.ts:139`, `metrics.ts`, `graph.ts`; `/sales/historique` shows them under `PCH_VENTES`. [V]
8. Code-map doc lists `lib/regulatory/intelligence/upload/object-storage.ts`, which does not exist. [V]
9. Tour plans belong to module `MEDICAL` (`tour-plan-actions.ts:37`), not `SALES_PLANNING` as the "Force de vente" framing suggests. [V]

## 10. Verified vs uncertain

**Verified [V]** (read in code; references inline above): workflow / status derivation and its single writer; create flow and product creation; lock scoping; BV → expense order; product identity / plan / writer / lifecycle; facet map; PCH derived level, award / contract / amendment / delivery → stock; AO OCR + Claude extraction; full Ventes PCH preview / apply / replace / mapping and its consumers; StockSnapshot semantics, same-day correction, chain coverage join; segmentation letters / statuses / rights and lettre-requise consumers; tour-plan transitions; field report → promo remises; promo movement kinds; market data loader; site-web queue / transport / HMAC / reconciliation / scheduler wiring; retirement enforcement.

**Uncertain [U]**:
- Produits 360 health weights; coverage colour thresholds (2 / 3 months); stock-recurrence auto-stop on rights loss;
- exact DB-level row lock of the site-web queue; whether any migration adds a unique index for daily snapshots;
- Regulatory Intelligence internals beyond headers (extraction / OCR / cost ledger read only at header level);
- consumption duplicate detection details; coaching finalisation rules; full `/pch` UI coverage of invoices ("factures" in the README chain were not traced to a PCH-specific model — likely `LegalDocument` / Invoice via Legal);
- whether `client-bundle-guard.test.ts` covers every server-only module listed here.
