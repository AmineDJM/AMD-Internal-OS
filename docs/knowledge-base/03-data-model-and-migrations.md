# 03 — Data model & migrations (Prisma / PostgreSQL)

> Knowledge-base page for AMD Internal OS (Adventum Pharma ERP). Written from the code at HEAD `41b2ef0` (2026-10-24).
> Tags: **[V]** = verified by reading code/schema (path:line cited) · **[U]** = inferred / not checked end-to-end.
> All counts below come from a parser run over `prisma/schema.prisma` and `prisma/migrations/*/migration.sql` (scratch scripts, not committed).

## 1. Scope

- `prisma/schema.prisma` (16,648 lines): **433 models, 206 enums, 7,316 fields**; its conventions, domain grouping, central models, relations and delete rules.
- `prisma/migrations/` (**462 migration folders** + `migration_lock.toml` = 463 entries): naming, idempotency style, data migrations, schema/SQL drift.
- `prisma/bootstrap.ts`, `render.yaml` deploy chain (generate → lint/tsc/build → `migrate deploy` → bootstrap, since refonte P0).
- The runtime client `src/lib/prisma.ts` (singleton, pool sizing, the test/bench DB guard) and how application code uses it: `$transaction`, row locks, raw SQL, reference numbering (`src/lib/refs.ts`, `src/lib/references/registre-serveur.ts`), soft delete / trash (`src/lib/suppression/*`, `src/lib/admin-delete-registry.ts`), company scoping (`src/lib/company.ts`).
- Test DB setup (`vitest.config.ts`, `vitest.global-setup.ts`).
- Out of scope: per-module business rules (other KB pages); RBAC semantics beyond the tables (`src/lib/rbac.ts`).

## 2. Summary

- One giant single-file schema (433 models). `User` is the hub (**170 FK columns point to it**, 171 back-relation fields), then `Company` (48 FKs), `Product`, `BusinessUnit`, `Department`, `AdProItem`, `RegulatoryProduct`, `LegalDocument`. [V]
- Conventions: `String @id @default(cuid())` (414/433), `createdAt @default(now())` (362), `updatedAt @updatedAt` (249), money in `Decimal @db.Decimal(14,2)` (205 Decimal fields, none in Float except AI cost USD), polymorphism via `(entityType EntityType, entityId String)` on 18 models, `custom Json?` columns on 22 models for admin-defined fields. [V]
- Multi-entity ("multi-société") scoping is by a **nullable `companyId`** on 61 models; reads are composed through `companyScopedWhere` which keeps `companyId = null` rows visible (`src/lib/company.ts:112`). No Postgres RLS. [V]
- Soft delete is **not** a `deletedAt` convention: deletion is a hard delete preceded by a JSON snapshot into `DeletedRecord` (the *corbeille*, trash), driven by a registry of 37 deletable kinds (`src/lib/admin-delete-registry.ts`, `src/lib/suppression/coeur.ts:36`). [V]
- Migrations: 49 of the 71 June-2026 ones (incl. `init`) are Prisma-generated, non-idempotent; everything after is hand-written idempotent SQL (`IF NOT EXISTS` in 382 files, `DO $$ … EXCEPTION WHEN duplicate_object` in 142). Names are a **synthetic monotonic clock** that already runs into 2027 (139 folders are "future-dated"). [V]
- *(Updated 2026-10-27, refonte P0)* A structural drift check now exists: `src/lib/derive-schema/derive-schema.test.ts` runs `migrate diff` against the local migrated DB and fails on any drift not listed in `src/lib/derive-schema/exceptions.ts` (see `docs/architecture/refonte-p0-outillage.md` §1). Before it: there was **no automated schema.prisma ↔ SQL structural drift check**; only per-feature tests that read a migration file, and a Test-Center check of disk vs `_prisma_migrations` (`src/lib/test-center/migration-cert.ts:27-78`). The DB intentionally holds objects Prisma does not know (98 SQL-only indexes incl. trigram/FTS/partial uniques, legacy tables `SalesTeam`, `MailEntryLink`). [V]
- *(Fixed 2026-10-27, refonte P0)* `render.yaml` used to run `prisma migrate deploy` **before** lint/typecheck/build (a failed build left the DB migrated under the old code); it now runs `build:render` first, then `migrate deploy` and `db:bootstrap` (`docs/architecture/refonte-p0-outillage.md` §2). [V]

## 3. Key files

| Path | Role |
|---|---|
| `prisma/schema.prisma` | Single schema file; header conventions at L1-10; enums L22-655; sections by `// ─── X ───` banners (see §4.1). |
| `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/migration.sql` | 462 hand-applied SQL migrations; `migration_lock.toml` = `postgresql`. |
| `prisma/bootstrap.ts` | Idempotent creation of the single Super Admin from `ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_NAME` (L12-34). Also `prisma.seed`. |
| `render.yaml` `buildCommand` | Deploy: `npm install && prisma generate && build:render && prisma migrate deploy && db:bootstrap` (order changed in refonte P0). |
| `package.json:15-23` | `test` forces local `DATABASE_URL`; `db:deploy` = `prisma migrate deploy`; `db:push`/`db:migrate`/`db:reset` exist but are dangerous here (§8). |
| `src/lib/prisma.ts` | `PrismaClient` singleton, test/bench DB refusal (L93-122), pool `connection_limit=12` in prod (L144-160). |
| `vitest.config.ts` / `vitest.global-setup.ts` | DB-backed test suite config; seeds a stable GENERAL_MANAGER "siège" (L22-42). |
| `src/lib/refs.ts` | `PREFIX-YYYY-NNN` references: `buildRef` (max+1), `createWithRetry` (P2002 retry), `enSerie` (in-process serialisation). |
| `src/lib/references/registre-serveur.ts` | Official `NNN/DG/AAAA` numbering via atomic `INSERT … ON CONFLICT DO UPDATE` on `DocumentSequence` (L23-40). |
| `src/lib/admin-delete-registry.ts` | Registry of 37 `DeletableKind`s (L24-61) + `KindSpec` (L63-128). |
| `src/lib/suppression/coeur.ts`, `lot.ts`, `branches.ts` | Reversible delete core, cascade inventory from Prisma DMMF (`lot.ts:48-75,179`), restore. |
| `src/lib/company.ts:112-150` | `companyScopedWhere`, `ficheScopedWhere` (multi-entity scoping). |
| `src/lib/audit.ts:23-44` | `recordAudit` → `AuditLog` row (+ event registry emission). |
| `src/lib/storage/blob-refs.ts` | Blob holders derived from DMMF: any String column named `*blobId`, plus JSON keys. |
| `src/lib/sandbox/sql.ts` | Read-only SQL sandbox for Adam (READ ONLY tx, `SET LOCAL ROLE amd_sandbox_ro`, table whitelist L31, masked columns L42). |
| `src/lib/test-center/migration-cert.ts` | Disk vs `_prisma_migrations` comparison + backup/restore roundtrip in an ephemeral schema. |
| `scripts/gen-selection-pf-migration.ts` | Generator of the data-import migration `20260812110000_selection_pf_products` from `data/selection-pf-produits.xlsx`. |
| `docs/readme/26-base-de-donnees-migrations.md`, `docs/readme/21-modele-de-donnees-entites-cles.md` | Human docs (partly stale, §9). |

## 4. How it works

### 4.1 Schema layout and the domain map

The schema is organised by banner comments (`// ───── Core / identity ─────` L656, `Regulatory` L1534, `Budgets` L2774, `Finances` L5502, `Drive` L6318, `PCH — marchés publics` L6969, `Matériel promotionnel` L7460, `Messagerie interne` L8343, `Regulatory Intelligence OS` L10234, `Force de vente & prévisions (SFE)` L11514, `LEGAL` L13070, `COURRIERS` L13315, `ADAM — le Chief of Staff VIVANT` L13549, `SITE WEB ADVENTUM` L15306, `KPI SANS CODE` L16345 …). [V] **Banners are not reliable section boundaries**: many models were appended in the wrong section (e.g. `Product` L14868 sits in the Adam section; `PchVenteImport`, `SegmentationStrategie` sit under "SITE WEB"; `LoginAttempt`, `AppSetting`, `PushSubscription` under "Module Events / Billetterie"; the `FACTURES` banner L13472 contains only `AssistantReminder` and `SessionEvent` — invoices now live in `LegalDocument` kind `INVOICE`). [V]

Domain grouping used in this KB (model counts; full list in the Domain map below and Appendix A):

| Domain | # | Anchor models |
|---|---|---|
| AI: Adam assistant, missions & knowledge | 50 | `AssistantThread/Message/Episode/Memory`, `Mission`, `MissionStep`, `KnowledgeItem/Chunk/Job`, `AiUsageLog`, `ModelCallLog` |
| Segmentation, field force & medical promotion | 44 | `MedicalDoctor`, `MedicalVisit`, `MedicalInstitution`, `SalesSector`, `TourPlan`, `CoachingSheet`, `SegmentationStrategie` |
| Regulatory intelligence OS | 37 | `RegulatoryDossier`, `RegulatoryDossierVersion`, `RegulatoryDocument`, `RegulatoryFinding`, `AnppReserve` |
| Ad & Pro (marketing spend) | 30 | `AdProItem`, `SponsoringRequest`, `CongressNational/International`, `AdProDevis`, `AdProIntegrationLot` |
| PCH public markets, sales & logistics | 20 | `PchTender`, `PchTenderLine`, `PchOrder`, `PchDelivery`, `Sale`, `PchVenteImport` |
| HR, recruitment & training | 19 | `Employee`, `RecruitmentRequest`, `LeaveRequest`, `Training`, `PayrollEntry`, `Task` |
| Budgets & budget campaigns | 19 | `BudgetEnvelope`, `BudgetCategoryLine`, `BudgetCampaign`, `BudgetProposal`, `DepartmentBudget`, `PettyCash*` |
| Promotional material (promo stock) | 19 | `PromoMaterial`, `PromoStockItem`, `PromoStockMovement`, `PromoStockLot`, `PromoFacture` |
| Direction intelligence, KPI & risk | 16 | `KpiDefinition/Value`, `BrainRisk`, `IntelligenceSnapshot`, `RiskSetting` |
| Drive, files & blobs | 14 | `DriveNode`, `FileBlob`, `FileBlobChunk`, `FileVersion`, `Document`, `StoredFile` |
| Admin, settings, audit & platform | 13 | `AuditLog`, `ActivityLog`, `DeletedRecord`, `AppSetting`, `CustomFieldDef`, `EntityLink` |
| Mail (email accounts & Gmail) | 11 | `MailAccount`, `GoogleConnection`, `EmailRecord`, `OutboundMailIntent` |
| Identity, org & RBAC | 10 | `User`, `Department`, `BusinessUnit`, `UserAccess`, `RowGrant`, `UserCompanyAccess`, `UserSession` |
| Payments, finance & accounting | 10 | `PaymentRequest`, `ExpenseOrder`, `FinanceTransaction`, `TreasuryAccount`, `PaymentThreshold` |
| Validation & workflow engines | 10 | `ValidationRequest/Step/Rule`, `WorkflowDefinition/Instance` |
| Stocks (PCH dated states) | 10 | `StockSnapshot`, `StockAnnex`, `StockCountRequest`, `StockMovement` |
| Companies & regulatory (core) | 9 | `Company`, `CompanyLegalIdentity`, `RegulatoryProduct`, `RegulatoryStep` |
| Business development & market research | 9 | `BdProject/Range/Product`, `MarketResearch*` |
| Calendar, meetings & reminders | 8 | `Meeting`, `CalendarEvent`, `Reminder` |
| Website (site web) | 8 | `BlogArticle`, `SitePublication`, `SiteWebCle`, `SiteCandidature` |
| Legal & courriers | 7 | `LegalDocument` (contracts, BC, invoices), `MailEntry` (courrier register) |
| Internal requests & directives / Directories / Admin requests / Messaging | 7 each | `Directive`, `Dossier` / `DirectoryEntry`, `MedicalDirectory` / `AdministrativeRequest` / `Conversation`, `Message` |
| Products & catalogue | 6 | `Product` (canonical product), `ProductAlias`, `ProductPrice`, `ProductRange` |
| Medical info & pharmacovigilance; Events & field missions; External API | 5 each | `MedicalInfoDeclaration`; `Event`, `MissionAssignment`; `ApiClient`, `WebhookEndpoint` |
| Documents numbering & templates | 4 | `DocumentSequence`, `DocumentReference`, `CompanyDocumentProfile`, `OfficeLetterhead` |
| Test center / Notifications & push / Supplier portal | 3 / 2 / 2 | `TestRun`; `Notification`, `PushSubscription`; `Supplier`, `SupplierUser` |

Note: there is no dedicated purchase-order or invoice table. A **bon de commande** (BC, purchase order) and a **facture** (invoice) are `LegalDocument` rows (`LegalDocKind`: `PURCHASE_ORDER`, `INVOICE`, `QUOTE`, `CREDIT_NOTE`…) chained via `chainFromId`; the old `Invoice` table was migrated into `LegalDocument` keeping its ids and dropped (`20261015090000_facture_document_legal_ordinaire/migration.sql:1-30`). PCH client orders are `PchOrder`; promo-material supplier invoices are `PromoFacture`. [V]

### 4.2 The most central models (by relation degree)

Degree = relation fields on both sides; "FK in" = number of FK columns elsewhere pointing at the model. [V] (computed from schema)

| Model (line) | FK in / fields | Key fields, status enums, relations |
|---|---|---|
| `User` (L1122) | 170 / 198 | `email`, `passwordHash`, `role`+`secondaryRole: UserRole` (19 values: SUPER_ADMIN, DIRECTION, GENERAL_MANAGER, OPERATIONS_DIRECTOR, HEAD_OF_REGULATORY, …, VIEWER), `isActive`, `isSystem`, `testMode`, `tokenVersion` (session revocation), `mustChangePassword`, `departmentId`. Only one FK of its own (Department). Users are deactivated, not deleted (no prod `user.delete`). |
| `Company` (L1571) | 48 / 57 | `name`, `shortName`, `color`, `isActive`. Root of multi-entity scoping. Delete cascades to 18 tables (Department → budgets, DocumentSequence…). |
| `Product` (L14868) | 23 / 39 | Canonical product: `code`, `canonicalName`, `dci`, `dosage`, `form`, `identityKey`, `channel: ProductChannel`, `lifecycle` (string). Children `ProductAlias`, `ProductPrice`, `ProductAssignment` cascade; `Restrict` from promo/segmentation links. |
| `BusinessUnit` (L11530) | 17 / 32 | BU (sales/marketing unit), `companyId`, `departmentId`, `headId`, `supervisorId`; `Restrict` from `SegmentationStrategie`. |
| `Department` (L663) | 15 / 30 | N-level tree (`parentId`), `@@unique([companyId, name])`, `head/deputy → Employee`. **`company` onDelete Cascade** (L670). |
| `AdProItem` (L2307) | 7 / 73 | The Ad & Pro budget line ("poste"): `kind: AdProItemKind` (16), `status: AdProItemStatus` (DRAFT/PENDING/REVISION/APPROVED/REJECTED), `orderStage` (NONE→REQUESTED→DIRECTION_OK→ISSUED/REFUSED), `amountEstimated/Granted/orderVisaAmount: Decimal(14,2)`, parents (sponsoring / congress / event / training / promo material / info-med declaration — all **Cascade**), `budgetCategoryId → BudgetCategoryLine` (SetNull), `expenseOrderId` (scalar, no FK). 12 indexes. |
| `RegulatoryProduct` (L1732) | 9 / 66 | `reference @unique` (REG-…), `dci`, `brandName`, `status: RegulatoryStatus` (9), `externalStatus`, `workflow/checklist/molecules/custom Json`, `assignedUsers User[]` (implicit m2m table `_RegulatoryAssignedUsers`), `canonicalProduct → Product`. |
| `LegalDocument` (L13110) | 8 / 66 | `kind: LegalDocKind` (12), `status: LegalDocStatus` (ACTIVE/EXPIRED/RENEWED/CANCELLED), `amount/amountDelta: Decimal`, self-chains `renewedFrom`, `amends`, `chainFrom`; `settlementTx → FinanceTransaction`; `expenseOrderId` (scalar); `reference` **not unique**. |
| `MedicalDoctor` (L4656) | 8 / 51 | HCP: `name`, specialty/institution/service refs, segmentation `influence/potential/affinity: SegmentLevel`, `delegateId`, `archivedAt` (archive, not delete). |
| `Employee` (L5828) | 10 / 58 | HR: salary components all `Decimal` (`baseSalary`, `netToPay`, `employerCost`…), `iban`, `nationalId`, `leaveBalanceDays: Decimal`. |
| `Mission` (L13815) | 12 / 57 | Adam execution mission: `status: MissionStatus` (19), JSON `entities/extracted/commitments/acceptance/planMeta`, lease (`leaseOwner`, `leaseUntil`), cost `costUsd: Float`; `owner → User` **Cascade**. |
| `MissionStep` (L13936) | 4 / 35 | `@@unique([missionId, key])`, `@@unique([idempotencyKey])` (+ partial unique in SQL), `status` string, `input/result/spec Json`. |
| `DriveNode` (L6322) | 10 / 28 | Internal drive tree (`parentId` Cascade), `isTrashed` (drive trash), `spaceId → DriveSpace`, `size: Float`. |
| `FileBlob` (L6388) | 2 / 13 | Encrypted content (AES-256-GCM), `sha256 @unique` (dedup), `data Bytes?` or `FileBlobChunk[]` or `storageKey` (S3/R2), `refCount`, `codec` (brotli). |
| `PromoStockItem` (L7878) / `PromoStockMovement` (L7985) | 10 / 31; 0 / 28 | Promo stock ledger: movement `delta: Decimal`, `kind: PromoMovementKind` (11), lot/transfer/annule FKs with **NoAction** (ledger cannot lose referenced rows). |
| `PchTender` (L6973) / `PchTenderLine` (L7044) | 5 / 36; 5 / 49 | Public tender (`status: PchTenderStatus`), lines with DZD pricing as Decimal. |
| `RegulatoryDossier` (L10343) / `…Version` (L10513) | 9 / 20; 8 / 19 | CTD dossier (`status: RegDossierStatus` 12 values); **`companyId` and `productId` are plain strings, no FK**. Versions `@@unique([dossierId, versionNo])`, Cascade. |
| `AdministrativeRequest` (L6547) | 4 / 42 | Admin request centre: `status: AdminRequestStatus` (9), `deletedAt/deletedById/deletionReason` (one of the few real soft-delete columns). |
| `PaymentRequest` (L12936) | 2 / 32 | `reference @unique` (PAY-YYYY-NNN), `amount Decimal`, `status: PaymentRequestStatus` (DRAFT…CANCELLED, 8), polymorphic `entityType/entityId`, `expenseOrderId` (scalar). |
| `ExpenseOrder` (L6232) | 3 / 38 | Disbursement order ("ordre de dépense", OD-…): `status: ExpenseOrderStatus` (PENDING/REVISION_REQUESTED/PAID/CANCELLED) + `centralStatus` **String** (payment-centre authorisation), `sourceType: EntityType` + `sourceId`, `amount/proposedAmount Decimal`. |
| `BudgetEnvelope` (L2969) / `BudgetCategoryLine` (L3017) | 2 / 23; 5 / 20 | Envelope `totalAmount Decimal`, access lists as `String[]` (`accessRoles`, `accessUserIds`, `managerRoles`…), category tree `allocated Decimal`. `AdProIntegrationLot → BudgetEnvelope` is **Restrict**. |
| `ValidationRequest` (L6832) | 2 / 28 | `reference @unique` (VAL-…), `status: ValidationStatus`, `amount Decimal?`, polymorphic, steps `ValidationStep`. |
| `Notification` (L5244) | 0 / 10 | `userId` Cascade, `type: NotificationType` (12), `isRead`, `popup`; indexes `(userId,isRead,createdAt DESC)`, `(userId,createdAt DESC)` — comment cites 4.7 M rows measured. |
| `AuditLog` (L5291) | 0 / 13 | `action: AuditAction` (10), `module` string, polymorphic entity, `field/oldValue/newValue` strings, indexes on actor/module/entity/createdAt. Actor FK default (SetNull-on-optional). |
| `Document` (L5206) / `Comment` (L5231) | — | Polymorphic attachments/comments (`entityType: EntityType` 59 values, `entityId`), `category: DocumentCategory` (40), `confidentiality`. No FK to the owner row. |
| `UserAccess` (L5363) / `RowGrant` (L5391) | — | Dynamic RBAC: one row per (user, module string) with `canView/Create/Update/Delete/Validate/Export/Upload`, `scope: AccessScope` (ALL/ASSIGNED), `sections String[]`; `RowGrant(userId, entityType, entityId)` unique. Read by `src/lib/rbac.ts:1347`, evaluated by `userCan` (`rbac.ts:1712`). |
| `DeletedRecord` (L9296) | — | The trash: `kind`, `sourceId`, `payload Json`, `documents/comments/lot Json?`, `restoredAt`, `purgedAt`. |
| `AppSetting` (L9318) | — | Singleton `id @default("global")` with kill-switches (e.g. `aiExternalActionsDisabled`). Same pattern: `AiSetting`, `RiskSetting`, `AdoptionSetting`, `SfeSettings`. |

### 4.3 Conventions measured in the schema [V]

- **Ids**: `String @id @default(cuid())` on 414 models. Exceptions: singletons `@default("global")` (5), natural keys (`StoredFile.key`, `PchPoste.poste: Int`, `PchDirectionRegionale.code`, `InfluenceScore.doctorId`, `AssistantRoleConfig.role: UserRole`, `…cle` cache keys), 5 composite `@@id` join tables (`PromoStockItemProduct`, `CareQuoteCell`…). SQL-inserted rows use `md5(...)`/`randomUUID()` ids (e.g. `bcnum…` in `20270117130500_bc_numerotation`, `registre-serveur.ts:28`), so **ids are not guaranteed to be cuids**. Data-import migrations use deterministic prefixed ids (`regpf…`, `scripts/gen-selection-pf-migration.ts:20-21`) to stay replayable.
- **Timestamps**: `createdAt DateTime @default(now())` on 362 models; `updatedAt @updatedAt` on 249 (never a plain `updatedAt`). Header (L5-7) claims every business model carries `createdById/updatedById`; reality: 133 have `createdById`, 52 `updatedById`, and these are **scalar ids without FK** (118 `createdById` lack a relation).
- **Money**: `Decimal` with explicit `@db.Decimal(p,s)` — `(14,2)` ×102, `(12,2)` ×26, `(16,2)` ×15, `(18,2)` ×13; rates `(5,2)`, FX `(10,4)`; quantities `(12,3)`. No money in `Float`/`Int` except AI cost in USD (`Mission.costUsd`, `MissionWorkerRun.costUsd`, `MediaTranscript.coutUsd`: Float) and `KpiValue.valeur: Float`. Application code converts with `Number(x)` (≈550 call sites) and rounds with local helpers, e.g. `round2` in `src/lib/budget/imputation.ts:26`; `.toNumber()` is used only 3 times. No central Decimal serializer.
- **File sizes** are `Float` (`FileBlob.size`, `DriveNode.size`, `Document.sizeBytes`) — deliberate: "exact up to 9 PB" comment at L6389.
- **Enums vs strings**: 128 status/kind/type fields are Prisma enums, **90 are free `String`** (e.g. `PromoMaterial.circuitState`, `Reclamation.status`, `MissionStep.status`, `ExpenseOrder.centralStatus`, `BudgetCampaign.status`, `KnowledgeJob.status`). Newer modules prefer `String` + TS union (avoids `ALTER TYPE … ADD VALUE` migrations). `EntityType` (59 values) is the polymorphism key; `DocumentCategory` 40; `UserRole` 19.
- **JSON**: 203 `Json` fields on 125 models — workflow state, snapshots (`DeletedRecord.payload/lot`), AI outputs, settings, `custom` custom-field values (22 models: `RegulatoryProduct`, `SponsoringRequest`, `ExpenseOrder`, `LegalDocument`, `MailEntry`, `DriveNode`, `Employee`…). Field definitions live in `CustomFieldDef(entityType, key)` (L5485-5500).
- **Arrays**: 101 `String[]` fields (access lists on `BudgetEnvelope`/`DriveSpace`, `participantIds`, `aliases`).
- **Text sizes**: `@db.Text` only 36 times, `@db.VarChar` once — everything else is unbounded `text` in Postgres anyway (`String` → `TEXT`).
- **Delete rules** (on FK-holding relation fields): Cascade 333, SetNull 184, Prisma default 99 (= SetNull if optional, Restrict if required), Restrict 13, NoAction 3. Required-default (implicit Restrict) relations: e.g. `ValidationStep.validator`, `RecruitmentRequest.requester`, `FileVersion.blob`, `WorkflowInstance.definition` — they block deleting the parent.
- **Loose references**: 680 scalar `…Id` columns have no `@relation` (audit ids, `expenseOrderId` ×10, `blobId` ×13, `documentId` ×12, polymorphic `entityId` ×17, `companyId` ×13 e.g. on `RegulatoryDossier`, `KnowledgeItem`). Integrity for those is application-level.
- **Indexes**: 858 `@@index`, 121 `@@unique`, 233 field `@unique`. `@@map`/`@map` are never used: table and column names equal model/field names (quoted PascalCase in SQL).
- **Doc comments** (`///`) carry the business rationale and frequently cite doctrine (§118.x); 338/433 models are documented.

### 4.4 Multi-entity ("multi-société") scoping

`companyId` was added to the main tables by `20260707120000_companies_multi_entity` (L26-47) and `20260807000000_company_scope_platform` (L22-41, dynamic `EXECUTE format(...)` loop over 10 tables), always **nullable** with `ON DELETE SET NULL` FKs. Reads go through `companyScopedWhere(userId, base)` which returns `{ AND: [base, { OR: [{companyId: X}, {companyId: null}] }] }` (`src/lib/company.ts:112-117`), so rows without an entity stay visible ("une ligne sans entité n'est le secret d'aucune société"); detail pages use `ficheScopedWhere` (all permitted companies, L131-139). Per-user entitlement: `UserCompanyAccess`. There is no DB-level tenant isolation (no RLS) — scoping correctness depends on every query using these helpers (84 graph neighbours of `companyScopedWhere`). [V]

### 4.5 Client singleton, pool and the test/bench guard

- `src/lib/prisma.ts:170-177`: global singleton (cached on `globalThis` outside production). Logs `error`(+`warn` in dev). [V]
- Pool: in production, `connection_limit=12` is appended to `DATABASE_URL` unless already present; `DB_CONNECTION_LIMIT`, `DB_POOL_TIMEOUT` override (L144-160). Rationale in comment: Prisma's default (CPUs×2+1 = 3 on 1 vCPU) starved uploads. [V]
- **Refusal at import** (L93-122): under Vitest (`NODE_ENV=test` or `VITEST`) the URL host must be `localhost/127.0.0.1/::1`; for a bench (entry script under `scripts/bench/`, detected by `estUnBancDeMesure` in `src/lib/sortie/garde.ts:118-124`) the DB must be local **and** named `*bench*`. Otherwise the constructor throws a sentence naming the remedy. Motivation documented in the comment: the container's default `DATABASE_URL` pointed at Render **production** and `npm test` seeded into it. Unit-tested in `src/lib/prisma.test.ts`. [V]
- Scripts that build their own `new PrismaClient()` (`prisma/bootstrap.ts:10`, `scripts/context-baseline.ts:32`, `scripts/api/issue-key.ts:16`, `scripts/ui-audit/run.ts:78`) **bypass this guard**. [V]

### 4.6 Transactions, locks and raw SQL

- `$transaction`: 157 call sites in 84 production files; 28 batched-array form, the rest interactive `async (tx) => …`. Explicit timeouts only where long: `suppression/lot.ts:419,450` (60 s), `regulatory/intelligence/ingest/ingest-dossier.ts:285` (120 s). No `isolationLevel` anywhere (READ COMMITTED default). [V]
- Pessimistic locks inside interactive transactions (14 `FOR UPDATE` in 9 files): e.g. petty cash spend re-reads the fund under `SELECT … FROM "Department" … FOR UPDATE` (`src/lib/actions/petty-cash-actions.ts:326-328`); validation decisions lock `ValidationRequest` (`validation-actions.ts:384,816`); promo circuit locks `PromoMaterial` with an optimistic `circuitVersion` (`promo-circuit-actions.ts:248`). Advisory locks: `pg_advisory_xact_lock(hashtext(...))` in `regulatory-actions.ts:1183` and `missions/artifacts/build.ts:386`. [V]
- Raw SQL: tagged `$queryRaw` (76 sites/34 files), `$executeRaw` (8), `$queryRawUnsafe` (17 sites/11 files) and `$executeRawUnsafe` (10, in `sandbox/sql.ts` and `test-center/ephemeral.ts`). The "Unsafe" readers are full-text/trigram search with positional parameters (`queries/search-everything.ts:137`, `fabric/text-search.ts:156`, `regulatory/intelligence/corpus/rag.ts:103,119`, `…/reserves/library.ts:99`, `knowledge/entities/resolve.ts:107`) — they rely on Postgres extensions created best-effort (`unaccent`, `pg_trgm` in `20260824210000_search_extensions`) and fall back to `LIKE` when absent. [V]
- The Adam SQL sandbox (`src/lib/sandbox/sql.ts:104-118`) runs `SET TRANSACTION READ ONLY`, `SET LOCAL statement_timeout`, tries `SET LOCAL ROLE amd_sandbox_ro` (role created best-effort by `20261024090000_sandbox_role`), forbids DDL/DML keywords (L44), whitelists tables (L31) and masks columns (`passwordHash`, `iban`, `nationalId`, `token`… L42). [V]
- DMMF introspection at runtime (`Prisma.dmmf.datamodel`) is a deliberate pattern: cascade inventory for deletes (`suppression/lot.ts:48-60`), blob holders (`storage/blob-refs.ts:29`), enum lists (`sandbox/sql.ts:158`, `actions/contrat-scan.ts:27`), API registry scope (`api/registry/portee.ts:53`). Adding a column/relation is thus automatically seen by these mechanisms. [V]

### 4.7 Reference numbering

Two coexisting schemes [V]:
1. **`PREFIX-YYYY-NNN` business references** (REG-, SPO-, PAY-, OD-, VAL-, MP-…; 24 models with `reference @unique`). `buildRef` takes the **max** existing number + 1 (`src/lib/refs.ts:13-25`, robust to deleted rows, unlike the old `count()+1`), `createWithRetry` retries up to 6 times on `P2002` (L32-43), and `enSerie(serie, fn)` serialises creations of the same series **within the process** (L66-82) because 25 parallel creations exhausted the retries (§118.148). Series constants: `SERIE_ORDRES="OD"`, `SERIE_DEMANDES_PAIEMENT="PAY"` (`src/lib/expense-orders.ts:36-37`); the PAY series is shared between direct payment requests and companion dossiers of expense orders (§118.182). Cross-process (scripts, test workers) protection is only the P2002 retry. `nextRef` reads all references of the year (`payment-request-actions.ts:72-78`) — O(n) per creation.
2. **Official chrono `NNN/DG/AAAA`** (BC, ordres de mission, registre DG): atomic counter `DocumentSequence(companyId, kind, year, last)` with `@@unique([companyId, kind, year])` (schema L5662-5674), advanced by `INSERT … ON CONFLICT … DO UPDATE SET last = GREATEST(last+1, plancher) RETURNING last` inside the document's transaction (`src/lib/references/registre-serveur.ts:23-40`; same in `src/platform/in-process/artifact/factory.ts:780-801`), and registered in `DocumentReference` (unique `companyId_year_numero`). Starting points are **data** set by migrations (`20270117130500_bc_numerotation` raises the 2026 counter to 36 so the next BC is 037; idempotent, never moves backwards).

### 4.8 Delete, trash (corbeille) and "soft delete"

- There is no global soft-delete column. Real `deletedAt` exists only on `AdministrativeRequest`, `Message` (chat tombstone), `TestArtifact`; archive flags elsewhere (`MedicalDoctor.archivedAt`, `MissionAssignment.archivedAt`, `DriveNode.isTrashed`, `Conversation/DriveSpace.isArchived`, `isActive` on 23 models, `annuleLe` cancellation stamps on ledgers). [V]
- The generic mechanism is **snapshot-then-hard-delete**: `supprimerReversible(kind, id, actorId, summary)` (`src/lib/suppression/coeur.ts:36-97`) → kind-specific refusal (`spec.refuse`) → snapshot main row → snapshot+delete polymorphic `Document`/`Comment` → `spec.remove(id)` (DB cascades follow) → `DeletedRecord` row → `recordAudit(DELETE)`. Kinds flagged `lot: true` (≈16 of 37: SPONSORING, EVENT, PAYMENT_REQUEST, AD_PRO_ITEM, PCH_TENDER, DRIVE_NODE…) instead inventory **every row Postgres would cascade-delete**, breadth-first from DMMF relations with `onDelete: Cascade`, plus polymorphic referents and direct links (`lot.ts:179-240`, cap `MAX_LIGNES = 5000` L34), and delete+snapshot them in one transaction (`supprimerLot`, `lot.ts:390-419`), restorable as a batch (`restaurerLot` L426). Physical files are only destroyed at purge (`purgedAt`). [V]
- Only callers that already checked rights call the core: `superAdminDelete`, `deleteOwnRecord`, `deleteEvent` (comment `coeur.ts:20-23`); Adam's `delete_record` tool goes through the same registry (`admin-delete-registry.ts:12-20`). [V]
- Many other deletes are plain `prisma.x.delete` outside the registry (e.g. `deleteDepartment`, `src/lib/actions/department-actions.ts:152-164`) and therefore not restorable. [V]

### 4.9 Migrations

- **Naming**: `YYYYMMDDHHMMSS_<snake_or_french_slug>`. Distribution: 2026-06 (71), 07 (73), 08 (121), 09 (21), 10 (37), **11 (28), 12 (34), 2027-01 (77)**. Today is 2026-10-24, yet the latest is `20270126100000_assistant_role_config` (committed 2026-10-23, `git log`). The timestamp is therefore a **monotonic ordering key, not a date**: each new migration must sort after the current maximum. 4 timestamp collisions exist (`20270107090000`, `20270111090000`, `20270112090000`, `20270118150000`, two folders each) — ordered by slug lexically. [V]
- **Generations**: the June 2026 bootstrap (`20260624172824_init`, 705 lines, 19 tables) and 49 of the 71 June-2026 migrations are Prisma-generated (`CREATE TABLE` without guards, `ALTER TYPE … ADD VALUE` without `IF NOT EXISTS`). From July on, migrations are hand-written and idempotent: `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, FKs in `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;` (sample: `20270126100000_assistant_role_config/migration.sql:4-46`), extension/role creation in nested `BEGIN … EXCEPTION WHEN insufficient_privilege` blocks (`20260824210000_search_extensions:7-18`, `20261024090000_sandbox_role:11-30`). Counts: `IF NOT EXISTS` 382 files, `DO $$` 207, `EXCEPTION` 147, `ADD VALUE` 70, `UPDATE` (data fixes) 254, `INSERT INTO` 32, `DELETE FROM` 3, `DROP TABLE` 1, `DROP COLUMN` 0, `CREATE INDEX CONCURRENTLY` 0, explicit `BEGIN;` 0. [V]
- **Enum additions** never use the new value in the same migration (stated in-file, e.g. `20270116143000_retours_reclamations:9-12`). [V]
- **Data migrations** are first-class: backfills (`20260815120000_entity_backfill`, 212 lines), re-qualifications, numbering floors (`20270117130500_bc_numerotation`), table merges keeping ids (`Invoice` → `LegalDocument`), renames (`SponsoringItem` → `AdProItem`), and generated imports (`20260812110000_selection_pf_products`, 33 KB, from `scripts/gen-selection-pf-migration.ts` — the SQL is committed; the script documents/re-generates it). They guard themselves with `WHERE` predicates (`… < 37`, `IS NULL`) or `ON CONFLICT`, so replay is a no-op. [V]
- **Destructive changes are avoided**: no `DROP COLUMN` ever; superseded tables are left in place (`SalesTeam`, `MailEntryLink` still exist in DB but not in the schema; `20261002090000_bu_colonne_vertebrale:11` "La table `SalesTeam` n'est PAS [supprimée]"). [V]
- **Application**: only via `prisma migrate deploy` (`npm run db:deploy`) — on Render inside `buildCommand` (`render.yaml:52`); locally by hand. `migrate dev`/`db push` are not used in practice (they would fight the SQL-only objects, §8). [V/U: practice inferred from docs + scripts]
- **Drift control**: (a) per-feature tests read their migration file and assert/replay it, e.g. `src/lib/actions/audit-types-graphe.test.ts:53-84` replays a migration twice inside a transaction on `TEMP` copies to prove idempotence, `src/lib/notifications/index-lectures.test.ts:29,80` checks schema index ↔ migration index, `src/lib/ad-pro/tva-jamais-devinee.test.ts:62-67`; (b) `src/lib/api/registry/entities.test.ts:16-40` checks the agent API registry against schema field names; (c) Test Center `certifyMigrationsAndRecovery` compares disk folders to `_prisma_migrations` (HIGH finding if missing; `migration-cert.ts:63-75`); `scripts/adam-doctor.ts:49-63` gives the same `db:deploy` remedy. **Nothing compares the full schema to the migrated DB** (no `prisma migrate diff --exit-code` in CI/tests). [V]

### 4.10 Test database

- `npm test` sets `DATABASE_URL=${TEST_DATABASE_URL:-postgresql://amd:amd@localhost:5432/amd_internal_os}` (`package.json:15`). 448 test files import `@/lib/prisma`; tests seed real rows and the DB is **persistent and shared across runs** (comment `prisma.ts:18-19`: 592 payment requests, 211 "test" accounts residue). [V]
- `vitest.global-setup.ts:24-42` upserts a stable `GENERAL_MANAGER` "siège" dated 2000-01-01 so that `centreValidatorFrom` (§118.148) always picks it instead of a bench-created DG; it no-ops if the DB is unreachable (DB-dependent suites then `describe.skip`). Timeouts raised to 20 s/test and 120 s/hook (`vitest.config.ts:37,60`). [V]
- No migration step runs before tests; the local DB must have been brought to HEAD with `npm run db:deploy` (Postgres may need `pg_ctlcluster 16 main start`, CLAUDE.md). [V for absence of step; U for usual practice]

### 4.11 Domain map — all 433 models (generated; ordered by schema line within each domain)

- **AI: Adam assistant, missions & knowledge** (50): `AssistantThread`, `AssistantMessage`, `AssistantEpisode`, `AssistantMemory`, `AssistantActionIntent`, `AssistantMemoryItem`, `ExecutiveDecision`, `ExecutiveObjective`, `ExecutiveCommitment`, `AssistantArtifact`, `DailyBrief`, `AdamRule`, `AssistantHotState`, `AssistantRoleConfig`, `AssistantRoleConfigAudit`, `AiSetting`, `AiHealthCheck`, `AiUsageLog`, `ModelCallLog`, `VoiceTurnLog`, `AdamSkill`, `IngestedEvent`, `MediaTranscript`, `AdamWatch`, `AssistantReminder`, `CommunicationPolicy`, `Mission`, `MissionStep`, `MissionPlanPattern`, `MissionMilestone`, `MissionInput`, `MissionStepDep`, `MissionWorkerRun`, `MissionArtifact`, `MissionApproval`, `OperationalTemplate`, `MissionParticipant`, `MissionEvent`, `KnowledgeItem`, `KnowledgeChunk`, `KnowledgeJob`, `KnowledgeLink`, `KnowledgeEntity`, `KnowledgeAlias`, `ScheduledWorkflow`, `WorkflowRun`, `BusinessEvent`, `ArtifactSession`, `ArtifactOperation`, `AssistantProvenance`
- **Segmentation, field force & medical promotion** (44): `MedicalSpecialty`, `MedicalDoctor`, `MedicalInstitution`, `MedicalInstitutionService`, `MedicalVisit`, `MedicalVisitSupportNumerique`, `MedicalDelegatePlan`, `FieldReport`, `FieldReportAttachment`, `BusinessUnitSpecialty`, `PromoProduct`, `PromoCycle`, `ProductForecast`, `SfeSettings`, `SalesRepProfile`, `SalesSector`, `SalesSectorInstitution`, `SalesSectorInstitutionService`, `SalesSectorRep`, `TourPlan`, `PromoMessage`, `MedicalVisitMessage`, `CoachingGrid`, `CoachingSheet`, `SalesRepMonthlyKpi`, `PromotionAssignment`, `MedicalVisitProduct`, `SegmentationStrategie`, `SegmentationStrategieProduit`, `SegmentationRegle`, `SegmentationFiche`, `HcpObservation`, `SegmentationDerogation`, `SegmentationImport`, `PromoProductSpecialite`, `ConsommationImport`, `ConsommationLigne`, `ConsommationMemoire`, `AffiniteConfig`, `SegmentationCycle`, `VoixTerrainCache`, `PraticienRelation`, `InfluenceScore`, `AnalyseWatermark`
- **Regulatory intelligence OS** (37): `RegulatoryFeatureAccess`, `RegulatoryDossier`, `RegulatoryDossierVersion`, `RegulatoryDocument`, `RegulatoryExtraction`, `RegulatoryFinding`, `RegulatorySource`, `RegulatorySourceVersion`, `RegulatorySourceSection`, `RegulatoryCorpusApproval`, `RegulatoryFact`, `RegulatoryFactOccurrence`, `RegulatoryConflict`, `RegulatoryAssessment`, `RegulatoryJob`, `RegulatoryAuditLog`, `RegulatoryRulePack`, `RegulatoryRule`, `RegulatoryUploadSession`, `RegulatoryUploadPart`, `RegulatoryGeneratedDoc`, `RegulatoryDossierChatMessage`, `RegulatoryReserveCycle`, `RegulatoryReservePoint`, `RegulatoryAiCall`, `RegulatoryAiBatch`, `RegulatoryAiCache`, `AnppReserveBatch`, `AnppReserve`, `AnppDerivedRule`, `RegulatorySimulation`, `RegulatorySupplierRequest`, `RegulatorySupplierQuestion`, `RegulatoryLifecycleEvent`, `RegulatoryObligation`, `RegulatoryCaseStudy`, `RegulatoryCaseDoc`
- **Ad & Pro (marketing spend)** (30): `SponsoringRequest`, `AdProItem`, `AdProVoyageur`, `AdProVoyageurDevis`, `AdProHebergement`, `DemandeReservation`, `AdProDevis`, `AdProDevisLigne`, `AdProItemPiece`, `AdProItemDecision`, `AdProIntegrationLot`, `AdProRapprochement`, `AdProRapprochementLecture`, `AdProIntegrationDemande`, `AdProIntegrationDecision`, `CongressInternational`, `CongressNational`, `CareBeneficiary`, `CareCell`, `CareQuote`, `CareQuoteCell`, `CareGroupPoste`, `ConsultingContract`, `ConsultingTask`, `BusinessUnitMarketingReferent`, `AdProOtherRequest`, `AdProGateVisa`, `AdProProductAllocation`, `AdProStockLine`, `AdProMedecin`
- **PCH public markets, sales & logistics** (20): `Sale`, `LogisticsOrder`, `PchTender`, `PchTenderLine`, `PchTenderExtraction`, `PchTenderLineBusinessUnit`, `PchOrder`, `PchSubmission`, `PchContractLine`, `PchOrderLine`, `PchDelivery`, `PchDeliveryLine`, `Reclamation`, `PchVenteImport`, `PchVenteLigne`, `PchReceptionLigne`, `PchPoste`, `PchEtablissementMemoire`, `PchDirectionRegionale`, `PchFournisseurProduit`
- **HR, recruitment & training** (19): `RecruitmentRequest`, `RecruitmentApproval`, `RecruitmentInfoRequest`, `RecruitmentCandidate`, `Training`, `TrainingParticipant`, `TaskComment`, `Employee`, `EmployeeDocument`, `HrDocumentRequest`, `LeaveRequest`, `LeaveEscalation`, `Task`, `SalaryAdvance`, `PayrollEntry`, `PayrollWire`, `JobPosting`, `RecruitmentFollower`, `RecruitmentChannelPost`
- **Budgets & budget campaigns** (19): `BudgetLine`, `BudgetEnvelope`, `BudgetCategoryLine`, `BudgetCampaign`, `BudgetProposal`, `BudgetProposalVersion`, `BudgetProposalLine`, `BudgetProposalComment`, `BudgetProposalVote`, `DepartmentBudgetAccess`, `DepartmentBudget`, `DepartmentBudgetRequest`, `PettyCashPlan`, `PettyCashTopUpRequest`, `PettyCashAllotment`, `DepartmentBudgetExpense`, `DepartmentExpenseLine`, `BudgetExpenseLine`, `CoutRepartitionBu`
- **Promotional material (promo stock)** (19): `PromoMaterial`, `PromoQuote`, `PromoQuoteLine`, `PromoRequestItem`, `PromoRequestItemProduct`, `PromoFacture`, `PromoFactureLigne`, `PromoCatalogueArticle`, `PromoStockItem`, `PromoStockItemProduct`, `PromoStockLot`, `PromoStockMovement`, `PromoStockTransfer`, `PromoStockRequest`, `PromoStockComptage`, `PromoStockComptageLigne`, `PromoStockComptageRecurrence`, `PromoStockAlerte`, `PromoStockRefonte`
- **Direction intelligence, KPI & risk** (16): `RiskSetting`, `IntelligenceSnapshot`, `BrainRisk`, `BrainBriefing`, `BrainQuestion`, `ProcessStepSla`, `AdoptionSetting`, `AdoptionSnapshot`, `KpiDefinition`, `KpiAssignment`, `KpiValue`, `KpiEvaluation`, `KpiDeclaration`, `KpiImport`, `KpiReview`, `KpiReviewSetting`
- **Drive, files & blobs** (14): `Document`, `DriveNode`, `DriveSpace`, `FileBlob`, `FileBlobChunk`, `FileVersion`, `DriveTextIndex`, `EntityMention`, `DriveShare`, `DriveComment`, `StoredFile`, `LecturePiece`, `LecturePieceConfirmation`, `DirectUpload`
- **Admin, settings, audit & platform** (13): `FeatureFlag`, `Comment`, `AuditLog`, `ActivityLog`, `CustomFieldDef`, `EntityLink`, `Feedback`, `FeedbackAttachment`, `DeletedRecord`, `AppSetting`, `SessionEvent`, `DataQualityFinding`, `DataQualitySweep`
- **Mail (email accounts & Gmail)** (11): `OutboundEmail`, `InboundEmail`, `MailAccount`, `MailConnection`, `MailFolderState`, `MailLink`, `GoogleConnection`, `GmailIngestionState`, `EmailRecord`, `EmailAttachmentRecord`, `OutboundMailIntent`
- **Identity, org & RBAC** (10): `Department`, `UserInvite`, `User`, `UserCompanyAccess`, `UserAccess`, `RowGrant`, `UserSession`, `LoginAttempt`, `BusinessUnit`, `AuthorityHolder`
- **Payments, finance & accounting** (10): `PaymentCentreSeat`, `FinanceTransaction`, `TreasuryAccount`, `ExpenseOrder`, `PaymentCentreMessage`, `PaymentThreshold`, `DocumentRequest`, `PaymentRequest`, `PaymentPiece`, `PaymentRequestEvent`
- **Validation & workflow engines** (10): `WorkflowDefinitionVersion`, `ValidationRule`, `ValidationRequest`, `ValidationParticipant`, `ValidationStep`, `ValidationItemDecision`, `WorkflowDefinition`, `WorkflowStep`, `WorkflowInstance`, `WorkflowStepEvent`
- **Stocks (PCH dated states)** (10): `StockMovement`, `StockOpeningLevel`, `StockAnnex`, `StockRequestRecurrence`, `StockRequestRecurrenceHospital`, `StockSnapshot`, `StockCountRequest`, `StockCountRequestHospital`, `StockCountRequestLine`, `StockCountRequestRecipient`
- **Companies & regulatory (core)** (9): `Company`, `CompanyLegalIdentity`, `RegulatoryProduct`, `RegulatoryVariation`, `RegulatoryUpdateReminder`, `RegulatoryDossierStep`, `RegulatoryStep`, `RegulatoryRequest`, `RegulatoryRequestMessage`
- **Business development & market research** (9): `BusinessDevelopmentOpportunity`, `BdProject`, `BdRange`, `BdProduct`, `MarketResearch`, `MarketResearchRow`, `MarketResearchPlayer`, `MarketResearchPresentation`, `MarketResearchPresentationVersion`
- **Calendar, meetings & reminders** (8): `Reminder`, `Meeting`, `MeetingParticipant`, `MeetingTaskProposal`, `MeetingMessage`, `MeetingMessageAttachment`, `CalendarEvent`, `CalendarInvite`
- **Website (site web)** (8): `BlogArticle`, `SiteReprise`, `SitePublication`, `SitePushAttempt`, `SiteReconciliation`, `SiteWebCle`, `SiteCandidature`, `SiteAnalyticsEvent`
- **Internal requests & directives** (7): `Directive`, `DirectiveMessage`, `SupportRequest`, `SupportMessage`, `Dossier`, `DossierMessage`, `DossierMessageAttachment`
- **Directories & contacts** (7): `MedicalDirectory`, `MedicalDirectoryColumn`, `MedicalDirectoryAccess`, `CompanyContact`, `DirectoryCellStyle`, `DirectoryEntry`, `DirectoryEndpoint`
- **Administrative requests & purchasing** (7): `AdministrativeRequest`, `OfficeSupplyArticle`, `AdminApproval`, `DriverMission`, `DriverMissionStop`, `PurchaseRequestLogEntry`, `BesoinAnnuelService`
- **Messaging (internal chat)** (7): `Conversation`, `ConversationMember`, `Message`, `MessageReaction`, `MessageAttachment`, `MessageMention`, `MessageBookmark`
- **Legal & courriers** (7): `LegalDocument`, `LegalFolder`, `LegalDocumentReader`, `MailPartner`, `MailEntry`, `MailEntryPiece`, `MailEntryFolder`
- **Products & catalogue** (6): `ProductRange`, `UserProductRange`, `Product`, `ProductPrice`, `ProductAlias`, `ProductAssignment`
- **Medical information & pharmacovigilance** (5): `MedicalInfoDeclaration`, `MedicalInfoSlip`, `MedicalInfoDocRequest`, `PharmacovigilanceCase`, `PharmacovigilanceParticipant`
- **Events, ticketing & field missions** (5): `Event`, `EventRegistration`, `MissionAssignment`, `MissionParticipationVersion`, `MissionExpenseLine`
- **External API & webhooks** (5): `ApiClient`, `ApiCall`, `ApiIdempotencyKey`, `WebhookEndpoint`, `WebhookDelivery`
- **Documents, numbering & templates** (4): `OfficeLetterhead`, `CompanyDocumentProfile`, `DocumentSequence`, `DocumentReference`
- **Autonomous test center** (3): `TestRun`, `TestArtifact`, `TestFinding`
- **Notifications & push** (2): `Notification`, `PushSubscription`
- **Supplier portal** (2): `Supplier`, `SupplierUser`

### 4.12 Reference data — *référentiels* (data overhaul, phase P1, 2026-10-27)

Added by `prisma/migrations/20270130100000_referentiels/` (additive, idempotent; **tables created empty**, back-fill is P2). Target model: `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` §3; shared contract: `src/lib/enrichissement/types.ts`. +16 models, +14 enums (the 433-model counts above predate them). Users are referenced by **scalar** ids (`creeParId`, `decideeParId`…), no new FK on `User`. Guarded by `src/lib/referentiels/schema-p1.test.ts` (text is additive, replay ×2 on a scratch schema and on the work DB, DB constraints, and a `prisma migrate diff` filtered on this lot's objects must be empty).

| Model | Ref. | Purpose |
|---|---|---|
| `Personne` | R1 | One real person (civilité, nom, prénoms, `nomReplie` search key, naissance, nationalité, langues, `photoBlobId`, complétude 0–100, `fusionneeDansId` self-FK — merge is proposed, never automatic). |
| `PersonneRole` | R1 | Dated role of a person (`RolePersonne`: COLLABORATEUR, PROFESSIONNEL_SANTE, BENEFICIAIRE, VOYAGEUR, CANDIDAT, CONTACT_TIERS, INTERVENANT). Cascade with the person. |
| `Organisation` | R2 | One real organisation (raison sociale, nom court, `nomReplie`, forme juridique, capital `Decimal(14,2)`, pays, statut, site, `logoBlobId`, complétude, `fusionneeDansId`). |
| `OrganisationRole` | R2 | Dated role (`RoleOrganisation`: SOCIETE_DU_GROUPE … TRANSPORTEUR, AUTRE); unique (organisation, role). |
| `OrganisationIdentifiant` | R2 | NIF / NIS / RC / AI / AGREMENT / CODE_PCH; **unique (type, valeurNormalisee)** — the matching key for a third party. |
| `Affiliation` | R2 | Personne ↔ Organisation (fonction, service, depuis, jusqu'à, principale) — replaces free-text `institution`. |
| `Adresse` | R3 | Address of a person **or** an organisation (`CHECK num_nonnulls = 1`); `wilayaCode`/`communeCode` are **scalar codes, no FK** (Wilaya/Commune come from another lot); type SIEGE/LIVRAISON/DOMICILE/AUTRE, lat/lng. |
| `PointDeContact` | R3 | Phone / e-mail / site of a person **or** an organisation (same CHECK); `valeurNormalisee` (E.164, lower-case), principal, vérifié le, source. |
| `Piece` | R5 | The file once and for all: `blobId` (scalar → `FileBlob.id`), `empreinte` sha256 (indexed), nom, mime, taille, pages, langue, `nature` (string, `NATURES_PIECE`), `confidentiality`, `source` (`SourcePiece`), déposée par / le. |
| `PieceLien` | R5 | Piece ↔ subject (PERSONNE / ORGANISATION / ENTITE + free `entityType`), with a role; unique (pieceId, sujetType, sujetId, role). |
| `DonneeSensible` | R6 | Vault entry: titulaire (type, id), `nature` = sensitive attribute key, AES-GCM `valeurChiffree`/`iv`/`tag`, `cleVersion`, `empreinteHmac` (indexed), `derniersCaracteres`, source piece, validity. |
| `AccesDonneeSensible` | R6 | Who read what, when, for which gesture; survives the entry (`SetNull`, nature + titulaire copied). |
| `Extraction` | E | One extractor pass on a piece (moteur, local, statut, notes[], durée, `coutUsd`). |
| `FaitPropose` | E | A fact read on a piece — a proposal (sujetRef, sujetType, sujetId once resolved, rôle, attribut, valeur(s), confiance 0–1, preuve Json, décision). **CHECK: a sensitive fact holds no clear value** (→ `donneeSensibleId`). |
| `FaitConfirme` | E | What the record holds as true, historised (source PIECE/SAISIE/IMPORT, confirmé par / le, valide du / au, `actif`); same no-clear-value CHECK when `sensible`. |
| `ConflitDeFait` | E | Disagreement between a confirmed and a proposed fact — a decision queue, never an overwrite. |

**Link columns** (nullable, indexed, FK `ON DELETE SET NULL`): `personneId` on `User`, `Employee`, `MedicalDoctor`, `CareBeneficiary`, `AdProVoyageur`, `AdProHebergement`, `RecruitmentCandidate`, `DirectoryEntry`, `SupplierUser`; `organisationId` on `Company`, `CompanyContact`, `Supplier`, `MedicalInstitution`, `SponsoringRequest`, `CongressNational`, `CongressInternational`; `pieceId` on `Document`, `DriveNode`. CHECK constraints live only in SQL (Prisma ignores them, no drift).

## 5. Conventions & patterns to follow (house style)

**Changing the schema**
1. Edit `prisma/schema.prisma` in the right banner section (or append, but prefer the domain section). Write a `///` doc comment that says *why* the model/field exists — this repo's schema is its own design log.
2. Create **one new folder** whose timestamp is **greater than the current maximum** (`ls prisma/migrations | sort | tail -1`, today `20270126100000`), not the wall-clock date. The `date +%Y%m%d%H%M%S` recipe in `docs/readme/26-base-de-donnees-migrations.md` would today produce a name that sorts *before* 139 existing migrations (§8, §9).
3. Hand-write idempotent SQL: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS "<Model>_<cols>_idx|_key"` (use Prisma's default index names so the schema and DB agree), FKs as `DO $$ BEGIN ALTER TABLE … ADD CONSTRAINT "<Model>_<field>_fkey" … ; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`, enum values with `ALTER TYPE "X" ADD VALUE IF NOT EXISTS 'V'` and **never use the new value in the same file**. Quote identifiers (PascalCase tables, camelCase columns). Timestamps `TIMESTAMP(3)`, money `DECIMAL(14,2)`, JSON `JSONB`, ids `TEXT`.
4. Data fixes go in migrations, guarded by predicates so a replay changes nothing; never move a counter or a status backwards (`GREATEST`, `WHERE … < n`). Keep existing ids when merging tables.
5. Do not drop columns/tables; leave legacy tables and stop using them. Partial/expression/trigram indexes are allowed in SQL only, with a comment in the schema next to the model when they encode an invariant.
6. Apply with `npm run db:deploy` locally (never `db:push`, `db:migrate`, `db:reset` on a shared DB), then `npm run typecheck && npm run build && npm test` (CLAUDE.md). Add a test that reads the migration (and ideally replays it twice in a transaction on `TEMP` tables, pattern `src/lib/actions/audit-types-graphe.test.ts:57-90`).

**Modelling choices**
- New models: `id String @id @default(cuid())`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, `createdById String?` (scalar, usually no FK), `companyId String?` + `company Company? @relation(..., onDelete: SetNull)` + `@@index([companyId])` if the row belongs to an entity.
- Money: `Decimal @db.Decimal(14,2)` (DZD); convert with `Number()` at the edge and round with a 2-decimal helper; never `Float`.
- Polymorphic attachment/comment/audit: use `Document`/`Comment`/`AuditLog` with an `EntityType` value (requires an `ADD VALUE` migration) instead of new attachment tables.
- Any column holding a blob must be named `…blobId` (String) or be a JSON key ending in `blobId`, otherwise the blob GC will not see it (`src/lib/storage/blob-refs.ts:3-37`).
- New status fields: newer modules use `String` + a TS union and pure transition modules; a Prisma enum is fine when the set is stable.
- Choose `onDelete` deliberately: child rows that are *part of* the parent → `Cascade`; references to people/catalogue → `SetNull` (optional FK); ledgers → `NoAction`/`Restrict`.

**Runtime code**
- Always `import { prisma } from "@/lib/prisma"` (server only). Client components may only `import type` from `@prisma/client` (e.g. `src/components/shared/attach-to-source.tsx:4`).
- Reads that list business rows: wrap `where` with `companyScopedWhere(userId, base)` (lists) or `ficheScopedWhere` (detail pages); never spread a `{companyId}` into a `where` that already has an `OR`.
- New business references: `enSerie(SERIE, () => createWithRetry(async () => prisma.x.create({ data: { reference: await nextRef(), … } })))` — the ref must be recomputed inside the retried closure. Official chrono numbers: go through `references/registre-serveur.ts` inside the document's transaction.
- Check-then-write on balances or circuit states: re-read under `SELECT … FOR UPDATE` inside an interactive `$transaction` (`petty-cash-actions.ts:319-345`).
- Deletion of a business object: add a `DeletableKind` with `describe/remove/refuse` (and `lot: true` if it has cascaded children worth restoring) and call `supprimerReversible`; record audit via `recordAudit`.
- Raw SQL: tagged `$queryRaw` templates; `…Unsafe` only with positional parameters (`$1…`) and never with user text concatenated.

## 6. End-to-end flow — creating a payment request (*demande de paiement*) down to the DB

Server action `createPaymentRequest` (`src/lib/actions/payment-request-actions.ts:183`):

1. `requireUser()` (L185); `amount = fdNum(formData,"amount")` (L190) — a JS number, later written into `PaymentRequest.amount Decimal(14,2)`. [V]
2. Entity: `adventumCompanyId()` (L214) — employee requests are attached to Adventum by rule (06/10); otherwise `resolveMoneyEntity` + `checkMoneyEntity` against the user's companies. Result goes in nullable `companyId` (no index on `PaymentRequest.companyId`, §8). [V]
3. Business gates before any write: medical-info slip proof, dossier completeness (`canSubmitDossier`), duplicate-invoice guard reading other tables (`verifierFacturesAvantDepot`), amount-vs-invoice check. [V]
4. Insert with numbering (L283-325): `enSerie("PAY", () => createWithRetry(async () => prisma.paymentRequest.create({ data: { reference: await nextRef(), …, status: submit ? "SUBMITTED" : "DRAFT", entityType, entityId } })))`. `nextRef` (L72-78) loads every `PAY-<year>-*` reference and `buildRef` returns max+1 padded to 3 (`refs.ts:23-25`); a concurrent duplicate triggers `P2002` on `PaymentRequest.reference @unique` (schema L12938) and the closure is retried. [V]
5. Pieces (L320-345): each file → `persistUploadedDocument` (encrypted `FileBlob` + polymorphic `Document(entityType "PAYMENT_REQUEST", entityId)`), then `PaymentPiece` row. Failures are logged and skipped — **not in a transaction with step 4 by design** ("un dossier créé auquel il manque une pièce" beats a lost form). [V]
6. If submitted (L348-361): `createExpenseOrder({ sourceType: "PAYMENT_REQUEST", sourceId: req.id, amount, category: "FOURNISSEUR", … })` (`src/lib/expense-orders.ts:269`): computes `centralStatus` (payment-centre gate), resolves `companyId` once, then `enSerie("OD", () => createWithRetry(() => prisma.expenseOrder.create(...)))` (L282), skips the companion PAY dossier because `needsCompanionDossier("PAYMENT_REQUEST") === false` (`src/lib/finance/dossier-auto.ts:73-75`), notifies DIRECTION/SUPER_ADMIN (L311). Back in the action, `paymentRequest.update({ expenseOrderId: order.id })` (L360) — a scalar back-link, no FK. [V]
7. Trail: `PaymentRequestEvent` rows via `trace()` (L87-91), duplicate marks, then `recordAudit({ action: "CREATE", entityType: "PAYMENT_REQUEST", … })` (L367) → `AuditLog` insert + event-registry emission (`src/lib/audit.ts:23-44`; audit failures are swallowed with `console.error`). `revalidatePath` refreshes RSC pages. [V]
8. Deletion later: `PAYMENT_REQUEST` is a `lot: true` kind; `supprimerReversible` inventories cascaded rows (`PaymentPiece`, `PaymentRequestEvent` are its Cascade children) and snapshots them into `DeletedRecord.lot` in one 60 s transaction (`suppression/lot.ts:390-419`). [V for mechanism; per-kind refusal `refusSuppressionDemandePaiement` wired at `admin-delete-registry.ts:505`, its rules not read]

Observations from this flow: steps 4→6 span ~5 independent statements without a wrapping transaction; a crash between 4 and 6 leaves a SUBMITTED request without `expenseOrderId` (the system tolerates it but nothing re-links automatically) [U on recovery tooling]. Two series locks are taken sequentially (PAY then OD), never nested, so no lock-order deadlock. [V]

Secondary flow (official numbering): a BC (`LegalDocument` kind `PURCHASE_ORDER`) gets `NNN/DG/AAAA` from `magasinPrisma(tx).avancer(companyId, year, plancher)` = one `INSERT … ON CONFLICT DO UPDATE … RETURNING last` on `DocumentSequence` in the same transaction as the document, then `inscrire` into `DocumentReference` with `ON CONFLICT DO NOTHING` (`registre-serveur.ts:23-50`). [V]

## 7. Coupling & blast radius

- **`schema.prisma` → everything**: 885 production files and 448 test files import `@/lib/prisma`. `prisma generate` runs in `build` (`package.json:8`) and Render's build; a schema change without its migration compiles fine but fails at runtime on the first query (column/table missing) — typecheck cannot catch it. [V]
- **DMMF consumers** react automatically to schema edits: adding a `Cascade` relation enlarges the trash inventory (`suppression/lot.ts:60`) and may push a delete over `MAX_LIGNES` (5000) → refusal; adding a String field ending in `blobId` makes it a GC root; adding a Json column makes the GC scan it (`storage/blob-refs.ts`). Renaming such a field silently removes protection. [V]
- **`EntityType` enum** (59 values) couples `Document`, `Comment`, `AuditLog`, `RowGrant`, `ValidationRequest`, `PaymentRequest`, `ExpenseOrder.sourceType`, `LegalDocument.sourceType`, `MailEntry.sourceType`, `Conversation.refType`, `CustomFieldDef`, plus maps such as `ENTITE_DU_MODELE` (`suppression/branches.ts`) and `ENTITY_MODULE` (`expense-orders.ts`). Removing/renaming a value is effectively impossible (PG enum + stored rows). [V]
- **`User` deletion** would cascade into 85 tables (60 direct: notifications, assistant threads/memory, missions, push subscriptions, accesses…) and be blocked by required-default FKs (`ValidationStep.validator`, `RecruitmentRequest.requester`, `Feedback.user`…). Production code never deletes users; tests/bench do (`test-center/manifest.ts:17`, `missions/acceptance.ts:1233`). [V]
- **`Company` deletion** cascades into 18 tables including every `Department` (L670) and, through it, `DepartmentBudget`, `DepartmentBudgetExpense`, `PettyCash*`, `DocumentSequence` (numbering counters!), `CompanyDocumentProfile`, `PayrollWire`. Other company-scoped rows are SetNull and become "sans entité". No prod `company.delete` found. [V]
- **`Department` deletion** (`department-actions.ts:152-164`, allowed to `canManageStructure`) re-parents children and unassigns users/employees but **hard-deletes via cascade** its `DepartmentBudget`, `DepartmentBudgetExpense` (petty-cash spending history), `PettyCashPlan`, `PettyCashAllotment`, `PettyCashTopUpRequest`, `DepartmentBudgetAccess`, `DepartmentExpenseLine`, `AdamRule` (schema L3251, L3420, L3478, L3523) — no trash snapshot. [V]
- **Parents of `AdProItem`** (Sponsoring, congresses, Event, Training, PromoMaterial, MedicalInfoDeclaration) cascade-delete the budget lines that carry granted amounts and expense imputation; protected only because those kinds go through the `lot` trash. A direct `prisma.sponsoringRequest.delete` elsewhere would lose them. [V for cascade; U for absence of such direct deletes everywhere]
- **Multi-entity**: changing `companyScopedWhere` semantics (null rows visible) affects every scoped list (84 graph edges). [V]
- **Numbering**: `refs.ts` is used by ~40 files; `enSerie` assumes a **single Node process** (`render.yaml` one web service). Scaling to 2+ instances degrades to the 6-try optimistic retry, which was measured insufficient for bursts (refs.ts:47-61). [V]
- **Migrations ↔ deploy** *(fixed in refonte P0 — `migrate deploy` now runs after `build:render`; text below describes the former order)*: `migrate deploy` ran before `next lint`/`tsc`/`next build` in the same Render build (`render.yaml:52`). A lint/type/build failure after a successful migration leaves production running the previous code on the new schema; since migrations are additive this is usually harmless, but a data migration that changes semantics is live before the code that understands it. [V]

## 8. Invariants, gotchas, doctrine rules

- **Test DB guard (§118.90, §118.17, §118.30, §118.39)**: any process under Vitest must use a local DB; benches need a local `*bench*` DB; no override (`prisma.ts:24-58,93-122`). Do not "fix" a refusal by exporting a remote `DATABASE_URL`. [V]
- **Siège DG for tests (§118.148)**: the oldest active GENERAL_MANAGER is the validation-centre seat; tests rely on the seeded 2000-01-01 account (`vitest.global-setup.ts:1-22`). Creating an older GM in a test would hijack all BC validations. [V]
- **References (§118.148, §118.182)**: never `count()+1`; always max+1 + `createWithRetry` + `enSerie`, ref computed inside the retried closure; series shared between creators must use the same series key (`refs.ts:3-10,45-65`, `expense-orders.ts:221-230`). [V]
- **Trash (§118.162, §118.53, §104.16)**: preview and delete read the *same* inventory; cascaded rows that are not snapshotted are not restorable, and the confirmation text must say so (`admin-delete-registry.ts:74-90`, `coeur.ts:10-23`). [V]
- **Company scope**: `companyId` null ⇒ visible to everyone in scope; `currentCompanyWhereFor` was deleted on purpose (`company.ts:89-111`). [V]
- **Enum values** added in a migration are unusable in that same migration (PG); the old Prisma-generated migrations use `ADD VALUE` without `IF NOT EXISTS` — they must never be re-run manually. [V]
- **Migration names are an ordering clock**: a migration named with today's date (2026-10-24) would sort before ~139 already-applied ones. `migrate deploy` would still apply it on existing DBs (it applies any unapplied folder), but on a **fresh DB** it would run before the migrations that create the tables it alters → broken bootstrap of new environments/test DBs. [V for ordering facts; U for exact Prisma behaviour on out-of-order names in 5.22]
- **Do not run `prisma migrate dev`, `db push` or `migrate diff --from-url … --to-schema-datamodel` blindly**: the DB contains 98 SQL-only indexes (trigram `*_trgm`, FTS `*_fts`/`*_tsv_idx`, partial uniques like `AdProVoyageurDevis_un_retenu`, `SiteWebCle_une_par_etat`, `SegmentationStrategieProduit_*_en_vigueur`, `AdProIntegrationLot_actif`, `MissionStep_idempotencyKey_key … WHERE NOT NULL`), legacy tables (`SalesTeam`, `MailEntryLink`), a role (`amd_sandbox_ro`) and extensions Prisma does not model; a diff would propose dropping them (and `db push --accept-data-loss` would). The partial uniques are **business invariants** (e.g. one retained quote per traveller) that exist only in SQL. [V for objects; U for exact diff output]
- **Index names**: some SQL indexes use custom names for schema-declared indexes (e.g. `AssistantEpisode_user_ended_idx` vs schema-default `AssistantEpisode_userId_endedAt_idx`; `KnowledgeJob_pick_idx`, `KnowledgeLink_edge_key`) — Prisma would see them as different indexes. [V via name diff; U for whether `@@index(map:)` would be needed]
- **Unindexed FK columns** (no index leading with the column in schema or SQL; 107 found by script, most are low-traffic `createdById`/`decidedById`). The ones with likely impact: `FileVersion.blobId` (FK `ON DELETE RESTRICT` → every `FileBlob` delete scans `FileVersion`; blob GC/`drive-storage.ts:250,327`), `Message.senderId` (SetNull scan on user delete; per-sender queries), `PaymentRequest.companyId` (entity-scoped payment lists), `ValidationRequest.ruleId`, `WorkflowInstance.definitionId`, `MissionArtifact.stepId`, `Comment.authorId`. [V for absence; U for query impact]
- **Loose ids**: `expenseOrderId`, `documentId`, `blobId`, `sourceId`, `RegulatoryDossier.companyId/productId` have no FK → no cascade, no SetNull, dangling ids possible after deletes; readers must tolerate missing targets. [V]
- **`LegalDocument.reference`, `MailEntry.reference`, `PchOrder.reference` are not unique** (unlike the 24 `reference @unique` models); duplicate BC numbers are prevented by `DocumentReference` (`@@unique companyId_year_numero`) and `DocumentSequence`, not by the document table. [V]
- **Precision**: amounts up to `Decimal(14,2)` (≤ 999 999 999 999.99 DZD) are handled as JS `Number` — exact to the centime up to ~9×10¹³ DZD, so no practical loss; the real risk is summing floats without rounding (helpers like `round2` exist per module, not centrally). Some request amounts are `(12,2)` (≤ 9 999 999 999.99): `SponsoringRequest.amount*`, `Sale.unitPrice`, `RecruitmentRequest.salary*`. [V]
- **Transactions default to Prisma's 5 s interactive timeout** except where overridden; long work inside `$transaction` (file I/O, AI calls) will abort. Pool is 12 per process in prod, unbounded-default (CPU-based) elsewhere. [V]
- **Schema doc-comment misplacement**: the `///` block "LE REJEU DE SESSION" (session replay, L13474-13478) is attached by Prisma to `AssistantReminder`, not `SessionEvent`. Harmless at runtime; misleading in generated types/docs. [V]
- **Audit is best-effort** (`audit.ts:24-41` swallows insert errors) — an `AuditLog` gap is not proof that nothing happened. [V]

## 9. Docs-vs-code discrepancies

| Claim (where) | Code reality |
|---|---|
| "93 modèles, 86 enums, 69 migrations" (`docs/readme/26-base-de-donnees-migrations.md:3`, `docs/readme/29-architecture-du-code.md:36`) | 433 models, 206 enums, 462 migrations. |
| "422 modèles, 202 enums — décompte du 09/10/2026" (`docs/readme/21-modele-de-donnees-entites-cles.md:3`) | 433 / 206 at HEAD (+11 models, +4 enums since). |
| Migration recipe: `mkdir prisma/migrations/$(date +%Y%m%d%H%M%S)_…` + `migrate diff --from-url --to-schema-datamodel` (`docs/readme/26:6-13`) | Names must exceed the max (`20270126100000`); the diff would include drops of SQL-only indexes/tables. |
| "SQL manuel idempotent" (CLAUDE.md) | True from July 2026; 49 of the 71 June-2026 migrations (incl. `init`) are Prisma-generated, non-idempotent. |
| Schema header: "Every business model carries audit fields createdAt, updatedAt, createdById, updatedById" (`schema.prisma:5-7`) | createdAt 362/433, updatedAt 249, createdById 133, updatedById 52. |
| Schema header: "Files & comments are polymorphic via (entityType, entityId)" | True for `Document`/`Comment`, but the Drive (`DriveNode`/`FileBlob`), `MessageAttachment`, `PaymentPiece`, `EmployeeDocument`… use their own FKs/blob columns. |
| Banner `// ─── FACTURES ───` (`schema.prisma:13472`) | No invoice model there; invoices are `LegalDocument(kind=INVOICE)` since `20261015090000`; the old `Invoice` table was dropped. |
| `docs/readme/24-deploiement-render.md:8`: Render runs "… db:bootstrap && next build" | `render.yaml:52` runs `build:render` = `next lint` + `tsc -p tsconfig.build.json` + `next build` (lint is blocking, CLAUDE.md §118.155). |
| `docs/readme/26:4` "migrate deploy s'exécute au déploiement" | True, but *before* lint/typecheck/build in the same command, so a failed build still leaves migrations applied. |

## 10. Verified vs uncertain (recap)

- [V] Counts (models, enums, fields, ids, Decimal, Json, onDelete, indexes) — parsed from `prisma/schema.prisma`.
- [V] Migration counts/patterns/naming/collisions — parsed from `prisma/migrations/*/migration.sql`; future-dated commit date from `git log`.
- [V] `src/lib/prisma.ts` guard and pool; `vitest.global-setup.ts`; `refs.ts`; `registre-serveur.ts`; `company.ts:112-150`; `suppression/coeur.ts`, `lot.ts` (inventory/transaction); payment-request flow lines cited in §6; `department-actions.ts` cascade risk.
- [V] SQL-only objects: index-name diff schema vs SQL (98 SQL-only names, some later dropped — e.g. `Notification_userId_isRead_idx` replaced per schema comment; the list is an upper bound), orphan tables `SalesTeam`, `MailEntryLink`.
- [U] That nobody runs `migrate dev`/`db push` (inferred from docs and absence in scripts).
- [U] Exact Prisma 5.22 behaviour with out-of-order migration names on a fresh DB, and the exact output of `migrate diff` against prod.
- [U] Query-level impact of the unindexed FK columns (no EXPLAIN run; DB access forbidden in this analysis).
- [U] Domain assignment of ~40 cross-cutting models (e.g. `EntityLink`, `BusinessEvent`, `AdamRule`) is a judgement call; purposes marked [U] in Appendix A are guessed from names/fields.

## Appendix A — Model → domain → purpose (all 433 models)

Columns: model · domain (this KB's grouping) · number of fields (scalars + relations) · line in `prisma/schema.prisma` · purpose. "FR: « … »" = verbatim first sentence of the model's `///` doc comment in the schema (verified, French kept as-is; may be truncated). Purposes in English without a quote were written from the model name/fields; those marked **[U]** were not checked against code.

| Model | Domain | Fields | Line | Purpose |
|---|---|---|---|---|
| `AssistantThread` | AI: Adam assistant, missions & knowledge | 8 | 711 | FR: « FIL DE CONVERSATION avec l'assistant — STRICTEMENT PERSONNEL. » |
| `AssistantMessage` | AI: Adam assistant, missions & knowledge | 8 | 731 | FR: « Message d'un fil. `userId` est VOLONTAIREMENT redondant avec `thread.userId` : » |
| `AssistantEpisode` | AI: Adam assistant, missions & knowledge | 21 | 761 | FR: « L'épisode est daté, borné, et sa FIDÉLITÉ décroît avec l'âge sans jamais perdre ce qui compte. » |
| `AssistantMemory` | AI: Adam assistant, missions & knowledge | 6 | 795 | FR: « MÉMOIRE DISTILLÉE d'une personne : ce que l'assistant retient d'elle sur la durée (habitudes, dossie » |
| `AssistantActionIntent` | AI: Adam assistant, missions & knowledge | 21 | 832 | Adam action proposal state machine (PROPOSED→CONFIRMED→EXECUTED…) [U] |
| `AssistantMemoryItem` | AI: Adam assistant, missions & knowledge | 12 | 874 | Typed memory item retained by the assistant [U] |
| `ExecutiveDecision` | AI: Adam assistant, missions & knowledge | 19 | 900 | FR: « LE REGISTRE DES DÉCISIONS EXÉCUTIVES — « on choisit le fournisseur B » mérite d'être retrouvable six » |
| `ExecutiveObjective` | AI: Adam assistant, missions & knowledge | 17 | 945 | FR: « `lastProbability` est un SOUVENIR de la dernière estimation, jamais une vérité : » |
| `ExecutiveCommitment` | AI: Adam assistant, missions & knowledge | 20 | 974 | Commitment tracked for an executive (status string) [U] |
| `AssistantArtifact` | AI: Adam assistant, missions & knowledge | 10 | 1014 | FR: « REGISTRE DES LIVRABLES fabriqués par l'assistant (rapports Word, classeurs Excel, présentations PowerPoint). » |
| `DailyBrief` | AI: Adam assistant, missions & knowledge | 6 | 1035 | FR: « Point du matin de l'assistant : un texte par personne et par jour (fuseau d'Alger). » |
| `AdamRule` | AI: Adam assistant, missions & knowledge | 27 | 5709 | FR: « Une règle est une ATTESTATION (qui l'a dite, pour qui, depuis quand, d'où) — » |
| `AssistantHotState` | AI: Adam assistant, missions & knowledge | 8 | 6498 | FR: « ÉTAT CHAUD précalculé (fabric F5) : un résultat coûteux persisté avec son instant de calcul et son coût MESURÉ. » |
| `AssistantRoleConfig` | AI: Adam assistant, missions & knowledge | 11 | 9045 | FR: « Centre de contrôle IA (réglages globaux, Super Admin uniquement). » |
| `AssistantRoleConfigAudit` | AI: Adam assistant, missions & knowledge | 8 | 9060 | FR: « Traçabilité des modifications des configurations de rôle de l'Assistant IA (qui, quand, avant/après). » |
| `AiSetting` | AI: Adam assistant, missions & knowledge | 13 | 9074 | Singleton AI settings (id "global") |
| `AssistantRoutine` | AI: Assistant IA | 25 | — | FR: « Une routine de l'Assistant IA — programmée par la personne, exécutée sous ses droits relus, en lecture seule. » (migration `20270128100000_assistant_routines`) |
| `AssistantRoutineRun` | AI: Assistant IA | 12 | — | FR: « Un passage d'une routine — son rapport, ou la raison de son échec. Jamais un échec muet. » |
| `AiHealthCheck` | AI: Adam assistant, missions & knowledge | 8 | 9473 | FR: « Sonde QUOTIDIENNE de l'API IA (chatbot & fonctions IA). » |
| `AiUsageLog` | AI: Adam assistant, missions & knowledge | 25 | 9504 | FR: « Journal d'usage de l'IA — alimente le tableau de bord du Centre de contrôle (volume, taux de succès, » |
| `ModelCallLog` | AI: Adam assistant, missions & knowledge | 20 | 9551 | FR: « `AiUsageLog` dit ce qu'un TOUR a coûté ; cette table dit à QUEL modèle, dans quel RÔLE, pour quelle  » |
| `VoiceTurnLog` | AI: Adam assistant, missions & knowledge | 35 | 9598 | FR: « CE QUI EST STOCKÉ ET CE QUI NE L'EST PAS. La transcription FINALE est conservée : » |
| `AdamSkill` | AI: Adam assistant, missions & knowledge | 26 | 10391 | FR: « UN MICRO-OUTIL CRÉÉ PAR ADAM (mandat 5 §36) : du code passé par la porte de qualité, exposé comme ou » |
| `IngestedEvent` | AI: Adam assistant, missions & knowledge | 12 | 10433 | FR: « UN FAIT REÇU DE L'EXTÉRIEUR (mandat 5 §37) — ce qu'un webhook a livré, sa source, son identifiant fo » |
| `MediaTranscript` | AI: Adam assistant, missions & knowledge | 16 | 10456 | FR: « LA TRANSCRIPTION D'UN MÉDIA du Drive (mandat 5 §38) — » |
| `AdamWatch` | AI: Adam assistant, missions & knowledge | 20 | 10482 | Adam watch (monitoring rule) [U] |
| `AssistantReminder` | AI: Adam assistant, missions & knowledge | 21 | 13484 | FR: « LE REJEU DE SESSION — la suite des actions d'une personne, pour le support technique. » |
| `CommunicationPolicy` | AI: Adam assistant, missions & knowledge | 8 | 13571 | FR: « La politique de communication. Une ligne « global » aujourd'hui ; » |
| `Mission` | AI: Adam assistant, missions & knowledge | 57 | 13815 | FR: « « Demande à Regulatory ce dont ils ont besoin de Deepak » n'est pas une réponse de chat : » |
| `MissionStep` | AI: Adam assistant, missions & knowledge | 35 | 13936 | FR: « Il n'y a pas de table de checkpoints : une étape TERMINÉE, avec son reçu, EST le checkpoint. » |
| `MissionPlanPattern` | AI: Adam assistant, missions & knowledge | 9 | 14031 | FR: « On ne retient jamais le contenu d'une mission (destinataires, textes, chiffres) : » |
| `MissionMilestone` | AI: Adam assistant, missions & knowledge | 20 | 14073 | FR: « `dependsOn` porte les ORDRES (pas les ids) : un jalon se décrit avant que ses voisins existent en ba » |
| `MissionInput` | AI: Adam assistant, missions & knowledge | 16 | 14128 | FR: « `stepKey` dit QUELLE branche dépend de cette lecture : » |
| `MissionStepDep` | AI: Adam assistant, missions & knowledge | 5 | 14161 | Dependency edge between mission steps [U] |
| `MissionWorkerRun` | AI: Adam assistant, missions & knowledge | 18 | 14179 | FR: « Il reçoit un objectif, des entrées et une liste FERMÉE de capacités ; » |
| `MissionArtifact` | AI: Adam assistant, missions & knowledge | 18 | 14219 | FR: « `status` n'a donc pas de valeur « produit » : un fichier est BUILT (fabriqué) ou VERIFIED (fabriqué ET contrôlé). » |
| `MissionApproval` | AI: Adam assistant, missions & knowledge | 13 | 14262 | FR: « `scopeHash` la rend IMMUABLE (§33) : si le périmètre change matériellement — » |
| `OperationalTemplate` | AI: Adam assistant, missions & knowledge | 19 | 14293 | FR: « `state` empêche la promotion silencieuse (§82) : » |
| `MissionParticipant` | AI: Adam assistant, missions & knowledge | 13 | 14322 | FR: « QUI est attendu dans une mission — interne (compte ERP) ou externe (adresse). » |
| `MissionEvent` | AI: Adam assistant, missions & knowledge | 8 | 14344 | FR: « LE JOURNAL D'UNE MISSION — ce qui s'est passé, dans l'ordre, avec sa provenance. » |
| `KnowledgeItem` | AI: Adam assistant, missions & knowledge | 31 | 14481 | FR: « La clé d'idempotence est `(sourceType, sourceId)` : » |
| `KnowledgeChunk` | AI: Adam assistant, missions & knowledge | 12 | 14547 | FR: « Le découpage suit la STRUCTURE (§13), jamais « tous les 500 jetons » : » |
| `KnowledgeJob` | AI: Adam assistant, missions & knowledge | 16 | 14580 | FR: « Réclamation ATOMIQUE (QUEUED → RUNNING par `updateMany` conditionnel), réessai à attente croissante, » |
| `KnowledgeLink` | AI: Adam assistant, missions & knowledge | 9 | 14617 | FR: « Le vocabulaire des prédicats est FERMÉ (voir `RelationPredicate`) : » |
| `KnowledgeEntity` | AI: Adam assistant, missions & knowledge | 12 | 14650 | FR: « D'OÙ VIENNENT LES ALIAS. De l'ERP lui-même, jamais d'un dictionnaire écrit à la main. » |
| `KnowledgeAlias` | AI: Adam assistant, missions & knowledge | 8 | 14687 | FR: « UNE GRAPHIE d'une entité. La provenance (`source`) n'est pas décorative : » |
| `ScheduledWorkflow` | AI: Adam assistant, missions & knowledge | 18 | 14724 | FR: « Une planification NE PEUT PAS contourner une approbation. » |
| `WorkflowRun` | AI: Adam assistant, missions & knowledge | 9 | 14772 | FR: « L'HISTORIQUE. Sans lui, « ça n'a pas tourné » et « ça a tourné et n'a rien trouvé » sont indiscernables — » |
| `BusinessEvent` | AI: Adam assistant, missions & knowledge | 13 | 14810 | FR: « Pas un bus de messages, pas Kafka, pas une file. » |
| `ArtifactSession` | AI: Adam assistant, missions & knowledge | 23 | 15098 | Artifact editing session (Adam) [U] |
| `ArtifactOperation` | AI: Adam assistant, missions & knowledge | 13 | 15145 | FR: « `operationId` est fourni par l'appelant et rend l'application IDEMPOTENTE : » |
| `AssistantProvenance` | AI: Adam assistant, missions & knowledge | 8 | 15180 | FR: « Une ligne par tour de conversation : les faits lus (fiche, page, message, calcul) avec leur famille, » |
| `SponsoringRequest` | Ad & Pro (marketing spend) | 49 | 2153 | Sponsoring request (SPO-…) with preliminary/final validation [U] |
| `AdProItem` | Ad & Pro (marketing spend) | 73 | 2307 | FR: « **Deux clés étrangères plutôt qu'un couple (type, id)** : » |
| `AdProVoyageur` | Ad & Pro (marketing spend) | 20 | 2481 | FR: « Le PASSEPORT n'est pas une colonne : c'est un `Document` du poste (catégorie « pièce d'identité ») d » |
| `AdProVoyageurDevis` | Ad & Pro (marketing spend) | 9 | 2531 | FR: « LE DEVIS OU LA PRO FORMA D'UN VOYAGEUR (§118.205). » |
| `AdProHebergement` | Ad & Pro (marketing spend) | 17 | 2554 | FR: « La PIÈCE D'IDENTITÉ n'est pas une colonne : c'est un `Document` du poste dont `stepKey` est l'identifiant de la fiche — » |
| `DemandeReservation` | Ad & Pro (marketing spend) | 38 | 2606 | FR: « Exactement une fiche (contrainte `DemandeReservation_une_fiche`). » |
| `AdProDevis` | Ad & Pro (marketing spend) | 17 | 2670 | FR: « HISTORIQUE DES DÉCISIONS D'UN POSTE — « autant de fois qu'il le faut » : » |
| `AdProDevisLigne` | Ad & Pro (marketing spend) | 18 | 2704 | FR: « UNE LIGNE DE DEVIS DE POSTE — référence/désignation, unité, quantité, prix unitaire HT. » |
| `AdProItemPiece` | Ad & Pro (marketing spend) | 9 | 2744 | FR: « Un lien, jamais une copie : la pièce vit dans Legal (§17 — » |
| `AdProItemDecision` | Ad & Pro (marketing spend) | 9 | 2760 | Decision history on an Ad & Pro budget line [U] |
| `AdProIntegrationLot` | Ad & Pro (marketing spend) | 21 | 2786 | FR: « Un LOT = un fichier « Dépenses AP » intégré d'un bloc dans une enveloppe : » |
| `AdProRapprochement` | Ad & Pro (marketing spend) | 24 | 2826 | FR: « LE RAPPROCHEMENT AD & PRO (Direction, 14/10/2026) — » |
| `AdProRapprochementLecture` | Ad & Pro (marketing spend) | 16 | 2867 | FR: « CE QUE LUNA A LU D'UNE PIÈCE POUR LE RAPPROCHEMENT — » |
| `AdProIntegrationDemande` | Ad & Pro (marketing spend) | 17 | 2891 | FR: « UNE DEMANDE AD & PRO TOUCHÉE PAR UN LOT — créée « Historique 2026 » (`mode = CREEE`) ou existante co » |
| `AdProIntegrationDecision` | Ad & Pro (marketing spend) | 9 | 2924 | FR: « « DANS LA PLATEFORME, ABSENTES DU FICHIER » — ce qui comptait au budget avant le lot et ne correspond à aucune ligne : » |
| `CongressInternational` | Ad & Pro (marketing spend) | 57 | 3625 | International congress request/budget [U] |
| `CongressNational` | Ad & Pro (marketing spend) | 54 | 3707 | National congress request/budget [U] |
| `CareBeneficiary` | Ad & Pro (marketing spend) | 22 | 3849 | FR: « Deux clés étrangères nullables (même raison que `AdProItem`) : » |
| `CareCell` | Ad & Pro (marketing spend) | 36 | 3893 | FR: « Chaque personne a ses propres cases : l'une a besoin d'un visa et pas l'autre, l'une loge à l'hôtel et l'autre chez elle. » |
| `CareQuote` | Ad & Pro (marketing spend) | 25 | 3974 | FR: « Un devis couvre **ce qu'il couvre réellement** : » |
| `CareQuoteCell` | Ad & Pro (marketing spend) | 4 | 4017 | FR: « Ce qu'un devis couvre : les cases concernées. » |
| `CareGroupPoste` | Ad & Pro (marketing spend) | 21 | 4030 | FR: « UN POSTE DE GROUPE (Direction, 10/2026) — en prise en charge « de groupe », un coût qui s'applique à CHAQUE personne : » |
| `ConsultingContract` | Ad & Pro (marketing spend) | 34 | 12596 | FR: « CONTRAT DE CONSULTING — un engagement entre DEUX PARTIES. » |
| `ConsultingTask` | Ad & Pro (marketing spend) | 8 | 12665 | FR: « UNE TÂCHE ATTENDUE DU PRESTATAIRE. Elles vivent à part et non dans un champ de texte : » |
| `BusinessUnitMarketingReferent` | Ad & Pro (marketing spend) | 6 | 12711 | FR: « C'est aussi ce qui donne enfin un ÉCRIVAIN à `productManagerId` (§118.142 : » |
| `AdProOtherRequest` | Ad & Pro (marketing spend) | 21 | 12725 | Ad & Pro "autre" request [U] |
| `AdProGateVisa` | Ad & Pro (marketing spend) | 12 | 12781 | FR: « `status` est du TEXTE et non un enum Prisma, comme `WorkflowInstance.status` : » |
| `AdProProductAllocation` | Ad & Pro (marketing spend) | 10 | 15051 | FR: « `tenderLineId` rattache la dépense à une ligne d'AO quand elle en relève — » |
| `AdProStockLine` | Ad & Pro (marketing spend) | 20 | 15618 | FR: « DEMANDÉE (le demandeur liste l'article et la quantité ; » |
| `AdProMedecin` | Ad & Pro (marketing spend) | 9 | 16537 | FR: « LES MÉDECINS CONCERNÉS PAR UNE DEMANDE AD & PRO (Direction, 08/10) — » |
| `FeatureFlag` | Admin, settings, audit & platform | 10 | 1107 | FR: « DRAPEAU DE VERSION — chaque nouveauté livrée arrive au stade TEST : » |
| `Comment` | Admin, settings, audit & platform | 8 | 5231 | Polymorphic comment (entityType, entityId) |
| `AuditLog` | Admin, settings, audit & platform | 13 | 5291 | Append-only audit trail (action, module, entity, old/new value) |
| `ActivityLog` | Admin, settings, audit & platform | 20 | 5429 | FR: « Fine-grained activity: page views, logins, and time-on-page (from a client beacon), enriched with de » |
| `CustomFieldDef` | Admin, settings, audit & platform | 11 | 5485 | FR: « Admin-defined extra field for a module. Values are stored in each record's `custom` JSON column keyed by `key`. » |
| `EntityLink` | Admin, settings, audit & platform | 10 | 7396 | FR: « Les LIBELLÉS des deux bouts sont photographiés à la création : » |
| `Feedback` | Admin, settings, audit & platform | 11 | 8298 | User feedback ticket [U] |
| `FeedbackAttachment` | Admin, settings, audit & platform | 10 | 8325 | FR: « `onDelete: Cascade` : un retour supprimé emporte ses pièces. » |
| `DeletedRecord` | Admin, settings, audit & platform | 13 | 9296 | FR: « Réglages d'instance modifiables par le Super Admin (limites de taille d'upload, etc.). » |
| `AppSetting` | Admin, settings, audit & platform | 46 | 9318 | Singleton platform settings (id "global"), incl. kill-switches |
| `SessionEvent` | Admin, settings, audit & platform | 10 | 13529 | Session-replay action event (doc comment misplaced, see §9) [U] |
| `DataQualityFinding` | Admin, settings, audit & platform | 27 | 15205 | FR: « Le moteur (`lib/quality/engine.ts`) balaie la base par règles ; » |
| `DataQualitySweep` | Admin, settings, audit & platform | 11 | 15245 | FR: « Le journal des BALAYAGES : quand, quel mode (FULL la nuit, LIGHT toutes les heures pour le risque fi » |
| `AdministrativeRequest` | Administrative requests & purchasing | 42 | 6547 | FR: « Demande administrative transverse (« Bureau de Donna »). » |
| `OfficeSupplyArticle` | Administrative requests & purchasing | 13 | 6611 | FR: « Catalogue d'articles de fourniture de bureau (Achats). » |
| `AdminApproval` | Administrative requests & purchasing | 15 | 6633 | FR: « Demande de validation rattachée à une demande administrative. » |
| `DriverMission` | Administrative requests & purchasing | 22 | 6661 | FR: « Mission chauffeur / coursier (Akila), autonome ou rattachée à une demande. » |
| `DriverMissionStop` | Administrative requests & purchasing | 8 | 6691 | FR: « Point de passage d'une course chauffeur (point A, B, C…) : » |
| `PurchaseRequestLogEntry` | Administrative requests & purchasing | 15 | 15275 | FR: « Ce n'est pas un second registre des demandes : » |
| `BesoinAnnuelService` | Administrative requests & purchasing | 11 | 16562 | FR: « LE BESOIN ANNUEL D'UN SERVICE (Direction, 10/2026 — » |
| `TestRun` | Autonomous test center | 27 | 12276 | Autonomous Test Center run [U] |
| `TestArtifact` | Autonomous test center | 12 | 12317 | FR: « Le MANIFESTE : chaque ressource synthétique créée par le run. » |
| `TestFinding` | Autonomous test center | 14 | 12335 | Finding of a test run [U] |
| `BudgetLine` | Budgets & budget campaigns | 17 | 2940 | Legacy budget line (initial/consumed/committed) [U] |
| `BudgetEnvelope` | Budgets & budget campaigns | 23 | 2969 | FR: « Enveloppe budgétaire : un budget TOTAL défini par la Direction pour une période, réparti en catégori » |
| `BudgetCategoryLine` | Budgets & budget campaigns | 20 | 3017 | FR: « Catégorie créée par la Direction au sein d'une enveloppe, avec son allocation. » |
| `BudgetCampaign` | Budgets & budget campaigns | 18 | 3058 | FR: « Statuts en texte (DRAFT \| OPEN \| REVIEW \| ARBITRAGE \| CLOSED) — » |
| `BudgetProposal` | Budgets & budget campaigns | 24 | 3090 | FR: « LA PROPOSITION D'UN PÔLE pour une campagne. Statuts : » |
| `BudgetProposalVersion` | Budgets & budget campaigns | 11 | 3127 | FR: « Une version SOUMISE, figée : les lignes telles qu'envoyées, et le résumé des changements (Luna ou repli exact). » |
| `BudgetProposalLine` | Budgets & budget campaigns | 17 | 3145 | FR: « Une ligne de la proposition. Source : AUTO_PAIE \| AUTO_RECRUTEMENT \| AUTO_BV \| AUTO_ADPRO \| REALISE_2026 \| SAISIE. » |
| `BudgetProposalComment` | Budgets & budget campaigns | 8 | 3171 | FR: « Le fil d'échanges d'une proposition, éventuellement sur une ligne. » |
| `BudgetProposalVote` | Budgets & budget campaigns | 8 | 3186 | FR: « L'avis d'un valideur sur UNE version (ACCEPTE \| REFUSE). » |
| `DepartmentBudgetAccess` | Budgets & budget campaigns | 15 | 3224 | FR: « Trois portées distinctes, parce que ce ne sont pas les mêmes personnes : » |
| `DepartmentBudget` | Budgets & budget campaigns | 11 | 3248 | Yearly budget of a department [U] |
| `DepartmentBudgetRequest` | Budgets & budget campaigns | 15 | 3271 | FR: « Celui qui gère le budget ne se l'accorde pas à lui-même : » |
| `PettyCashPlan` | Budgets & budget campaigns | 13 | 3417 | FR: « Sans ce réglage, la caisse dépendait d'un geste dont personne ne se souvenait à date fixe — » |
| `PettyCashTopUpRequest` | Budgets & budget campaigns | 15 | 3450 | Petty-cash (caisse) top-up request [U] |
| `PettyCashAllotment` | Budgets & budget campaigns | 19 | 3475 | Petty-cash remittance to a department [U] |
| `DepartmentBudgetExpense` | Budgets & budget campaigns | 19 | 3520 | FR: « Sans elle, les moyens généraux affichaient un montant alloué et AUCUNE consommation : » |
| `DepartmentExpenseLine` | Budgets & budget campaigns | 11 | 3565 | FR: « Le `label` est FIGÉ à l'achat, en plus du lien vers le catalogue : » |
| `BudgetExpenseLine` | Budgets & budget campaigns | 10 | 3604 | Expense line imputed on a budget envelope [U] |
| `CoutRepartitionBu` | Budgets & budget campaigns | 9 | 16067 | FR: « LA RÈGLE D'ALLOCATION DES COÛTS PARTAGÉS D'UNE BU (cahier des charges §15, §85) : » |
| `BusinessDevelopmentOpportunity` | Business development & market research | 25 | 5065 | BD opportunity [U] |
| `BdProject` | Business development & market research | 16 | 5104 | BD project (Projet→Gamme→Produit) [U] |
| `BdRange` | Business development & market research | 9 | 5135 | BD range (gamme) [U] |
| `BdProduct` | Business development & market research | 33 | 5151 | BD product with market sizing & investment [U] |
| `MarketResearch` | Business development & market research | 11 | 12142 | Market research study [U] |
| `MarketResearchRow` | Business development & market research | 13 | 12160 | FR: « Une ligne = un produit / une molécule dans une classe thérapeutique. » |
| `MarketResearchPlayer` | Business development & market research | 9 | 12180 | FR: « Un acteur du marché sur une ligne (Player 1, 2, 3… — » |
| `MarketResearchPresentation` | Business development & market research | 8 | 12198 | FR: « Présentation stratégique (PPTX) générée par IA à partir d'une étude de marché. » |
| `MarketResearchPresentationVersion` | Business development & market research | 9 | 12215 | FR: « Une version = une passe d'analyse IA. `instruction` = commentaires ajoutés par l'utilisateur pour cette relance ; » |
| `Reminder` | Calendar, meetings & reminders | 14 | 1408 | FR: « RAPPEL personnel « en un clic » posé sur n'importe quel sujet (dossier réglementaire, demande du sec » |
| `Meeting` | Calendar, meetings & reminders | 26 | 9685 | Jitsi call/meeting [U] |
| `MeetingParticipant` | Calendar, meetings & reminders | 7 | 9731 | Meeting participant [U] |
| `MeetingTaskProposal` | Calendar, meetings & reminders | 10 | 9745 | Task proposed from a meeting [U] |
| `MeetingMessage` | Calendar, meetings & reminders | 8 | 9762 | FR: « Fil de discussion (chat) d'une réunion — texte + pièces jointes, comme le chat des dossiers. » |
| `MeetingMessageAttachment` | Calendar, meetings & reminders | 8 | 9777 | FR: « Pièce jointe d'un message du fil d'une réunion — » |
| `CalendarEvent` | Calendar, meetings & reminders | 16 | 9811 | Calendar appointment [U] |
| `CalendarInvite` | Calendar, meetings & reminders | 8 | 9835 | Invitation to a calendar event [U] |
| `Company` | Companies & regulatory (core) | 57 | 1571 | Legal entity of the group (multi-entity scoping root) |
| `CompanyLegalIdentity` | Companies & regulatory (core) | 25 | 1647 | FR: « Un seul jeu par entité (relation 1-1) : deux « identités fiscales » d'une même société seraient exac » |
| `RegulatoryProduct` | Companies & regulatory (core) | 66 | 1732 | Product registration file (REG-…): DCI, status, workflow/checklist JSON [U] |
| `RegulatoryVariation` | Companies & regulatory (core) | 12 | 1860 | FR: « Variation de fabrication : après la DE d'un produit, on peut demander une variation vers un packagin » |
| `RegulatoryUpdateReminder` | Companies & regulatory (core) | 10 | 2061 | FR: « Une ligne PAR PERSONNE relancée, même quand la relance visait tout le monde d'un coup : » |
| `RegulatoryDossierStep` | Companies & regulatory (core) | 13 | 2106 | FR: « Une étape porte SES pièces : elles se rattachent par `Document.stepKey` = l'id de l'étape, exactemen » |
| `RegulatoryStep` | Companies & regulatory (core) | 13 | 2130 | Step of a regulatory product workflow [U] |
| `RegulatoryRequest` | Companies & regulatory (core) | 16 | 4420 | Request addressed to Regulatory [U] |
| `RegulatoryRequestMessage` | Companies & regulatory (core) | 7 | 4446 | Thread message on a regulatory request [U] |
| `RiskSetting` | Direction intelligence, KPI & risk | 22 | 9096 | FR: « Seuils de déclenchement du Risk Radar (Adventum Brain), ajustables par le Super Admin. » |
| `IntelligenceSnapshot` | Direction intelligence, KPI & risk | 13 | 9128 | FR: « Adventum Pulse — instantané périodique (au plus 1×/h) de l'état d'intelligence de la société : » |
| `BrainRisk` | Direction intelligence, KPI & risk | 22 | 9151 | FR: « UN RISQUE QUI A UNE VIE (Adventum Brain, refonte 07/10). » |
| `BrainBriefing` | Direction intelligence, KPI & risk | 10 | 9185 | FR: « LE BRIEFING DU MATIN, GARDÉ — un par jour (heure d'Alger). » |
| `BrainQuestion` | Direction intelligence, KPI & risk | 8 | 9201 | FR: « UNE QUESTION POSÉE À ADVENTUM BRAIN, et sa réponse — » |
| `ProcessStepSla` | Direction intelligence, KPI & risk | 7 | 9216 | FR: « LE DÉLAI CIBLE D'UNE ÉTAPE DE CIRCUIT (Process Intelligence). » |
| `AdoptionSetting` | Direction intelligence, KPI & risk | 22 | 9232 | FR: « Réglage du score d'adoption — **poids** de chaque dimension et **seuils** de libellé, définis librem » |
| `AdoptionSnapshot` | Direction intelligence, KPI & risk | 8 | 9264 | FR: « Historique quotidien du score d'adoption (un instantané par utilisateur et par jour). » |
| `KpiDefinition` | Direction intelligence, KPI & risk | 23 | 16353 | FR: « UNE VERSION D'UNE DÉFINITION DE KPI. Modifier un KPI crée une NOUVELLE ligne (version + 1) dans la m » |
| `KpiAssignment` | Direction intelligence, KPI & risk | 10 | 16395 | FR: « À QUI S'APPLIQUE UN KPI, et avec quel POIDS : un rôle (modèle par rôle), l'équipe d'un manager, ou une personne. » |
| `KpiValue` | Direction intelligence, KPI & risk | 12 | 16416 | FR: « LA VALEUR CALCULÉE d'une version de KPI pour une personne et une période — » |
| `KpiEvaluation` | Direction intelligence, KPI & risk | 15 | 16438 | FR: « UN KPI ÉVALUÉ pour une personne et une période : » |
| `KpiDeclaration` | Direction intelligence, KPI & risk | 16 | 16460 | FR: « UN KPI DÉCLARÉ : une valeur saisie par la personne avec sa pièce, validée (ou refusée) par son manager. » |
| `KpiImport` | Direction intelligence, KPI & risk | 12 | 16485 | FR: « UN IMPORT de KPI IMPORTÉ : le fichier, les colonnes choisies (personne, période, valeur), ce qui a été écarté. » |
| `KpiReview` | Direction intelligence, KPI & risk | 14 | 16504 | FR: « LA REVUE d'une personne pour une période : le score pondéré, signé par le manager. » |
| `KpiReviewSetting` | Direction intelligence, KPI & risk | 4 | 16525 | FR: « LA FRÉQUENCE DE REVUE choisie par un manager pour son équipe (Direction, 08/10 : » |
| `MedicalDirectory` | Directories & contacts | 11 | 4751 | FR: « UN ANNUAIRE DE PRATICIENS — une liste nommée, pas LA liste. » |
| `MedicalDirectoryColumn` | Directories & contacts | 11 | 4782 | FR: « LA VALEUR VIT DANS `MedicalDoctor.custom` (JSON), pas dans une colonne SQL : » |
| `MedicalDirectoryAccess` | Directories & contacts | 7 | 4804 | FR: « UN ACCÈS DÉSIGNÉ à un annuaire de praticiens. Supprimer l'annuaire emporte ses accès. » |
| `CompanyContact` | Directories & contacts | 25 | 4822 | FR: « L'ANNUAIRE DE L'ENTREPRISE — tout ce qui n'est ni un praticien, ni un salarié. » |
| `DirectoryCellStyle` | Directories & contacts | 10 | 4960 | FR: « Une feuille se colore comme dans Excel : « ces praticiens à revoir », « ces hôpitaux déjà couverts ». » |
| `DirectoryEntry` | Directories & contacts | 21 | 14372 | FR: « LA RÈGLE : ON NE DUPLIQUE PAS LA VÉRITÉ MÉTIER. » |
| `DirectoryEndpoint` | Directories & contacts | 16 | 14436 | FR: « UN MOYEN DE JOINDRE quelqu'un. Plusieurs par personne : » |
| `OfficeLetterhead` | Documents, numbering & templates | 12 | 5604 | FR: « L'assistante de direction les téléverse, les renomme et les supprime : » |
| `CompanyDocumentProfile` | Documents, numbering & templates | 17 | 5631 | FR: « LE PROFIL DOCUMENTAIRE D'UNE SOCIÉTÉ — ce que la fabrique de documents applique d'elle-même à chaque » |
| `DocumentSequence` | Documents, numbering & templates | 7 | 5662 | FR: « LE COMPTEUR DE NUMÉROTATION des pièces émises : » |
| `DocumentReference` | Documents, numbering & templates | 11 | 5681 | FR: « LE REGISTRE COMMUN DES RÉFÉRENCES NNN/DG/AAAA (Direction, 10/2026 : » |
| `Document` | Drive, files & blobs | 17 | 5206 | Polymorphic attachment (entityType, entityId) → stored file |
| `DriveNode` | Drive, files & blobs | 28 | 6322 | FR: « Nœud de l'arborescence Drive : dossier ou fichier. » |
| `DriveSpace` | Drive, files & blobs | 12 | 6370 | FR: « Catégorie / espace PARTAGÉ du Drive (ex. « Promotion Médicale »), présenté comme un onglet à côté de » |
| `FileBlob` | Drive, files & blobs | 13 | 6388 | FR: « Contenu binaire chiffré (AES-256-GCM), dédupliqué par empreinte du clair (SHA-256). » |
| `FileBlobChunk` | Drive, files & blobs | 5 | 6412 | FR: « Tranche de contenu chiffré d'un gros FileBlob (data=null). » |
| `FileVersion` | Drive, files & blobs | 11 | 6423 | FR: « Version d'un fichier (historique). Pointe vers un FileBlob partagé. » |
| `DriveTextIndex` | Drive, files & blobs | 12 | 6445 | FR: « INDEX TEXTUEL PROGRESSIF du Drive — le texte extrait d'un fichier, mémorisé à la première lecture (r » |
| `EntityMention` | Drive, files & blobs | 8 | 6478 | FR: « LIEN PERSISTÉ document ↔ entité canonique (fabric F4). » |
| `DriveShare` | Drive, files & blobs | 7 | 6514 | FR: « Partage d'un nœud avec un utilisateur précis (droits VIEW/EDIT). » |
| `DriveComment` | Drive, files & blobs | 7 | 6530 | FR: « Commentaire sur un nœud du Drive (fichier ou dossier) : » |
| `StoredFile` | Drive, files & blobs | 4 | 9282 | FR: « Fichiers des **documents** (modèle Document, hors Drive) stockés de façon **durable** : » |
| `LecturePiece` | Drive, files & blobs | 25 | 15659 | FR: « UNE LECTURE DE PIÈCE COMMERCIALE (devis, BC, facture) — » |
| `LecturePieceConfirmation` | Drive, files & blobs | 9 | 15698 | FR: « QUI A CONFIRMÉ QUOI — l'attestation qu'une personne a relu, ligne à ligne, ce qu'une lecture proposa » |
| `DirectUpload` | Drive, files & blobs | 16 | 15718 | FR: « Envoi DIRECT navigateur → bucket (S3/R2) d'un gros fichier, en plusieurs parties. » |
| `Event` | Events, ticketing & field missions | 44 | 8783 | Event / ticketing request with validation [U] |
| `EventRegistration` | Events, ticketing & field missions | 18 | 8851 | Registration to an event [U] |
| `MissionAssignment` | Events, ticketing & field missions | 54 | 8899 | Field mission assignment (ordre de mission) [U] |
| `MissionParticipationVersion` | Events, ticketing & field missions | 14 | 8984 | FR: « UNE VERSION DE LA FICHE DE PARTICIPATION — proposition de la personne ou contre-proposition d'Advent » |
| `MissionExpenseLine` | Events, ticketing & field missions | 13 | 9005 | FR: « UNE DÉPENSE DE MISSION (note de frais d'un membre de l'équipe) — » |
| `ApiClient` | External API & webhooks | 16 | 12409 | FR: « DEUX COUCHES d'autorisation, et c'est volontaire : » |
| `ApiCall` | External API & webhooks | 17 | 12438 | FR: « JOURNAL DES APPELS D'API. Distinct du journal d'audit humain (`AuditLog`) et relié à lui : » |
| `ApiIdempotencyKey` | External API & webhooks | 7 | 12467 | FR: « CLÉ D'IDEMPOTENCE. Un agent rejoue une requête dès qu'il perd la réponse : » |
| `WebhookEndpoint` | External API & webhooks | 10 | 12483 | FR: « ABONNEMENT À DES ÉVÉNEMENTS. L'agent est prévenu au lieu d'interroger en boucle. » |
| `WebhookDelivery` | External API & webhooks | 10 | 12503 | FR: « UNE LIVRAISON d'événement. Conservée même en échec : » |
| `RecruitmentRequest` | HR, recruitment & training | 35 | 1915 | Hiring request with stage workflow [U] |
| `RecruitmentApproval` | HR, recruitment & training | 10 | 1978 | FR: « Figée, parce qu'une réorganisation en cours de route changerait les validateurs d'une demande déjà partie — » |
| `RecruitmentInfoRequest` | HR, recruitment & training | 11 | 1998 | FR: « Ce va-et-vient est le cœur du travail RH, pas une exception : » |
| `RecruitmentCandidate` | HR, recruitment & training | 23 | 2019 | FR: « Le pipeline vit ICI et non sur la demande : plusieurs candidats avancent en parallèle, à des vitesses différentes. » |
| `Training` | HR, recruitment & training | 34 | 3326 | Training request/session with amount [U] |
| `TrainingParticipant` | HR, recruitment & training | 10 | 3380 | FR: « Une personne conviée à une formation organisée par les RH. » |
| `TaskComment` | HR, recruitment & training | 7 | 5279 | FR: « Tout le CERCLE de la tâche écrit ici (voir `canComment` dans `lib/tasks/request-flow.ts`) : » |
| `Employee` | HR, recruitment & training | 58 | 5828 | HR employee record incl. salary Decimals [U] |
| `EmployeeDocument` | HR, recruitment & training | 14 | 5924 | FR: « Document RH rattaché à un employé (contrat, bulletin PDF, attestation…), stocké chiffré (FileBlob). » |
| `HrDocumentRequest` | HR, recruitment & training | 34 | 5948 | FR: « Demande d'attestation faite par l'employé (travail, CNAS, relevé des émoluments…), traitée par les R » |
| `LeaveRequest` | HR, recruitment & training | 38 | 6039 | FR: « Demande de congé / absence avec circuit de validation. » |
| `LeaveEscalation` | HR, recruitment & training | 11 | 6108 | FR: « UNE MARCHE REMONTÉE sur un congé : qui a demandé l'avis de qui, quand, pourquoi — » |
| `Task` | HR, recruitment & training | 35 | 6133 | FR: « Tâche assignable — cœur de l'espace de travail (to-do, délégation, suivi). » |
| `SalaryAdvance` | HR, recruitment & training | 16 | 6207 | FR: « Demande d'avance sur salaire. Validée par les RH, réglée par la Comptabilité (crée alors une écritur » |
| `PayrollEntry` | HR, recruitment & training | 24 | 6705 | FR: « Monthly payslip. When PAID it links to a FinanceTransaction (treasury OUT). » |
| `PayrollWire` | HR, recruitment & training | 14 | 6757 | FR: « `paidAt` et `transactionId` gardent le FAIT du virement même quand l'ordre est purgé de l'historique des règlements : » |
| `JobPosting` | HR, recruitment & training | 21 | 15317 | FR: « UNE OFFRE D'EMPLOI destinée au site public (`/carrieres/<slug>`). » |
| `RecruitmentFollower` | HR, recruitment & training | 7 | 16084 | FR: « QUI SUIT UN RECRUTEMENT — désigné(s) par le DG à la validation (Direction, 07/10) : » |
| `RecruitmentChannelPost` | HR, recruitment & training | 13 | 16099 | FR: « UNE DIFFUSION DE L'OFFRE SUR UN CANAL (Direction, 07/10) — » |
| `Department` | Identity, org & RBAC | 30 | 663 | FR: « Département de l'entreprise. Hiérarchie sur N NIVEAUX (« comme une vraie boîte ») : » |
| `UserInvite` | Identity, org & RBAC | 8 | 818 | FR: « UNE MÉMOIRE TYPÉE ET DURABLE du Chief of Staff — » |
| `User` | Identity, org & RBAC | 198 | 1122 | Account: role/secondaryRole (UserRole), department, flags (isActive, isSystem, testMode); 171 back-relations |
| `UserCompanyAccess` | Identity, org & RBAC | 9 | 1554 | FR: « `canEdit` sépare voir et modifier : on donne souvent la lecture sur une entité voisine sans le droit d'y écrire. » |
| `UserAccess` | Identity, org & RBAC | 15 | 5363 | Per-user, per-module RBAC flags (view/create/update/delete/validate/export/upload, scope ALL\|ASSIGNED, sections) |
| `RowGrant` | Identity, org & RBAC | 6 | 5391 | FR: « Explicit grant of a single row (line) to a user. » |
| `UserSession` | Identity, org & RBAC | 14 | 5407 | FR: « A revocable session. The JWT carries this row's `id`; » |
| `LoginAttempt` | Identity, org & RBAC | 7 | 9027 | FR: « Anti-bruteforce / anti-credential-stuffing : suivi des tentatives de connexion échouées par identifi » |
| `BusinessUnit` | Identity, org & RBAC | 32 | 11530 | FR: « Elle portait autrefois seulement un nom et un chef ; » |
| `AuthorityHolder` | Identity, org & RBAC | 11 | 12531 | FR: « Une autorité se rattache à un RÔLE, pas à une personne : » |
| `Directive` | Internal requests & directives | 31 | 4264 | Direction → team directive [U] |
| `DirectiveMessage` | Internal requests & directives | 7 | 4325 | Thread message on a directive [U] |
| `SupportRequest` | Internal requests & directives | 21 | 4357 | Support request to medical director / product manager [U] |
| `SupportMessage` | Internal requests & directives | 7 | 4390 | Thread message on a support request [U] |
| `Dossier` | Internal requests & directives | 21 | 4472 | FR: « Dossier de suivi d'un sujet ad hoc : on délègue une recherche / analyse / tâche (ex. » |
| `DossierMessage` | Internal requests & directives | 9 | 4507 | Thread message on a generic Dossier [U] |
| `DossierMessageAttachment` | Internal requests & directives | 8 | 4523 | FR: « Pièce jointe d'un message du fil « Suivi & discussion » (chat) — » |
| `LegalDocument` | Legal & courriers | 66 | 13110 | FR: « Le document lui-même reste où il est : dans le DRIVE. » |
| `LegalFolder` | Legal & courriers | 12 | 13281 | FR: « Le dossier ne porte AUCUN droit : la restriction d'un engagement reste sur lui (ses lecteurs désignés) et sur son entité. » |
| `LegalDocumentReader` | Legal & courriers | 7 | 13301 | Reader grant on a legal document [U] |
| `MailPartner` | Legal & courriers | 10 | 13323 | FR: « Liste PROPRE au module, et non les fournisseurs du Regulatory : » |
| `MailEntry` | Legal & courriers | 34 | 13352 | FR: « Les quatre dates ne disent pas la même chose et se remplissent à des moments différents : » |
| `MailEntryPiece` | Legal & courriers | 13 | 13423 | FR: « UNE PIÈCE D'UN COURRIER, AVEC SON PROPRE DESTINATAIRE. » |
| `MailEntryFolder` | Legal & courriers | 12 | 13452 | FR: « LES DOSSIERS DE CLASSEMENT DU COURRIER — l'armoire du registre, pendant exact de LegalFolder. » |
| `OutboundEmail` | Mail (email accounts & Gmail) | 15 | 1058 | FR: « COURRIER SORTANT — journal de tous les e-mails envoyés par la plateforme. » |
| `InboundEmail` | Mail (email accounts & Gmail) | 10 | 1081 | FR: « COURRIER ENTRANT — messages reçus par webhook (le fournisseur pousse, on ne relève pas de boîte IMAP). » |
| `MailAccount` | Mail (email accounts & Gmail) | 14 | 1438 | FR: « Boîte mail personnelle d'un employé (Infomaniak), connectée à la plateforme. » |
| `MailConnection` | Mail (email accounts & Gmail) | 19 | 1462 | FR: « La connexion d'UNE personne à SA boîte Exchange Online. » |
| `MailFolderState` | Mail (email accounts & Gmail) | 11 | 1492 | FR: « État de synchronisation d'UN dossier : le jeton de delta et les compteurs. » |
| `MailLink` | Mail (email accounts & Gmail) | 13 | 1511 | FR: « Ce qui relie un mail (ou une de ses pièces) à l'ERP : » |
| `GoogleConnection` | Mail (email accounts & Gmail) | 19 | 13589 | FR: « Isolation structurelle : tout part de `userId`. » |
| `GmailIngestionState` | Mail (email accounts & Gmail) | 12 | 13623 | FR: « Le push (watch + Pub/Sub) est un SIGNAL, jamais la charge utile : » |
| `EmailRecord` | Mail (email accounts & Gmail) | 29 | 13643 | FR: « Google reste la source de vérité du contenu : on garde ici de quoi CHERCHER, RELIER et SE SOUVENIR ( » |
| `EmailAttachmentRecord` | Mail (email accounts & Gmail) | 12 | 13693 | FR: « Le PDG ne doit jamais avoir à télécharger puis re-téléverser : » |
| `OutboundMailIntent` | Mail (email accounts & Gmail) | 35 | 13730 | FR: « L'approbation porte sur un CONTENU EXACT (`contentHash` : » |
| `MedicalInfoDeclaration` | Medical information & pharmacovigilance | 49 | 4081 | Medical-information regulatory declaration (bons de versement) [U] |
| `MedicalInfoSlip` | Medical information & pharmacovigilance | 13 | 4189 | FR: « DEUX TEMPS : une VALIDATION couvre le dépôt du lot entier (`MedicalInfoDeclaration.bvValidationId`), » |
| `MedicalInfoDocRequest` | Medical information & pharmacovigilance | 12 | 4215 | Document request within a medical-info declaration [U] |
| `PharmacovigilanceCase` | Medical information & pharmacovigilance | 24 | 8623 | Pharmacovigilance case [U] |
| `PharmacovigilanceParticipant` | Medical information & pharmacovigilance | 6 | 8667 | FR: « Une personne ajoutée à l'échange d'un cas : elle lit le cas et prend part à la conversation. » |
| `Conversation` | Messaging (internal chat) | 16 | 8375 | Messaging conversation (DM/group/channel) [U] |
| `ConversationMember` | Messaging (internal chat) | 12 | 8402 | Membership in a conversation [U] |
| `Message` | Messaging (internal chat) | 21 | 8421 | Chat message (soft-deleted via deletedAt) |
| `MessageReaction` | Messaging (internal chat) | 7 | 8455 | Emoji reaction [U] |
| `MessageAttachment` | Messaging (internal chat) | 11 | 8476 | FR: « Pièce jointe d'un message — de DEUX natures, jamais des deux à la fois. » |
| `MessageMention` | Messaging (internal chat) | 5 | 8494 | @mention in a message [U] |
| `MessageBookmark` | Messaging (internal chat) | 6 | 8505 | Saved message [U] |
| `Notification` | Notifications & push | 10 | 5244 | In-app notification (isRead, popup) |
| `PushSubscription` | Notifications & push | 8 | 9488 | FR: « Abonnement Web Push (PWA) d'un appareil/navigateur d'un utilisateur, pour les notifications poussées sur le téléphone. » |
| `Sale` | PCH public markets, sales & logistics | 33 | 4538 | Sales record (unitPrice/revenue Decimal) [U] |
| `LogisticsOrder` | PCH public markets, sales & logistics | 36 | 4589 | PCH logistics order [U] |
| `PchTender` | PCH public markets, sales & logistics | 36 | 6973 | PCH public tender (appel d'offres) [U] |
| `PchTenderLine` | PCH public markets, sales & logistics | 49 | 7044 | Line of a PCH tender with pricing/market data [U] |
| `PchTenderExtraction` | PCH public markets, sales & logistics | 18 | 7141 | FR: « La lecture d'avant océrisait même un PDF qui porte son texte, coupait le texte à 24 000 caractères s » |
| `PchTenderLineBusinessUnit` | PCH public markets, sales & logistics | 7 | 7185 | FR: « Affecter une BU inscrit le produit à son PORTEFEUILLE (`PromoProduct`), d'où la force de vente l'att » |
| `PchOrder` | PCH public markets, sales & logistics | 22 | 7198 | PCH purchase order (bon de commande PCH) [U] |
| `PchSubmission` | PCH public markets, sales & logistics | 13 | 7248 | Our submission to a PCH tender [U] |
| `PchContractLine` | PCH public markets, sales & logistics | 15 | 7277 | Contract line of an awarded PCH market [U] |
| `PchOrderLine` | PCH public markets, sales & logistics | 14 | 7310 | Line of a PCH order [U] |
| `PchDelivery` | PCH public markets, sales & logistics | 15 | 7338 | Delivery against a PCH order [U] |
| `PchDeliveryLine` | PCH public markets, sales & logistics | 9 | 7363 | Line of a PCH delivery [U] |
| `Reclamation` | PCH public markets, sales & logistics | 24 | 8685 | FR: « Un RETOUR de marchandise, une RÉCLAMATION QUALITÉ ou un RAPPEL DE LOT : » |
| `PchVenteImport` | PCH public markets, sales & logistics | 20 | 16163 | FR: « Deux natures, chaque mois (parfois un fichier annuel) : » |
| `PchVenteLigne` | PCH public markets, sales & logistics | 28 | 16198 | FR: « UNE LIGNE DE VENTE D'UNE DR À UN ÉTABLISSEMENT — » |
| `PchReceptionLigne` | PCH public markets, sales & logistics | 24 | 16249 | FR: « UNE RÉCEPTION DE LA PCH CENTRALE — FO fournisseur (notre sell-in quand c'est notre fournisseur), TR  » |
| `PchPoste` | PCH public markets, sales & logistics | 10 | 16289 | FR: « UN POSTE PCH (code produit de la PCH) ET NOTRE PRODUIT — » |
| `PchEtablissementMemoire` | PCH public markets, sales & logistics | 5 | 16307 | FR: « « CE CLIENT DE LA PCH EST CET ÉTABLISSEMENT » — » |
| `PchDirectionRegionale` | PCH public markets, sales & logistics | 4 | 16319 | FR: « UNE DIRECTION RÉGIONALE DE LA PCH — son libellé et ses wilayas (déduites de ses clients, corrigeables). » |
| `PchFournisseurProduit` | PCH public markets, sales & logistics | 10 | 16328 | FR: « LES FOURNISSEURS DE LA PCH QUI SONT « NOUS » POUR UN PRODUIT — » |
| `PaymentCentreSeat` | Payments, finance & accounting | 7 | 5349 | FR: « Désigner quelqu'un au centre, c'est lui donner le pouvoir d'engager l'argent de la société. » |
| `FinanceTransaction` | Payments, finance & accounting | 26 | 5548 | FR: « General ledger entry — the simplified accounting book + treasury source. » |
| `TreasuryAccount` | Payments, finance & accounting | 15 | 5758 | FR: « UN COMPTE DE TRÉSORERIE ANCRÉ (§118.176) — « SGA Birkhadem, compte Adventum, 2 966 153 DZD au 28/09/2026 ». » |
| `ExpenseOrder` | Payments, finance & accounting | 38 | 6232 | FR: « Ordre de dépense : émis automatiquement quand la Direction valide une dépense (sponsoring accepté, avance approuvée…). » |
| `PaymentCentreMessage` | Payments, finance & accounting | 8 | 6302 | FR: « LE FIL DU CENTRE DE PAIEMENT — la discussion qui accompagne une autorisation. » |
| `PaymentThreshold` | Payments, finance & accounting | 5 | 12552 | FR: « Seuil au-delà duquel la direction générale entre dans la chaîne, par entité. » |
| `DocumentRequest` | Payments, finance & accounting | 21 | 12829 | FR: « GÉNÉRIQUE par construction : elle vise n'importe quel objet de l'ERP (`entityType`/`entityId`). » |
| `PaymentRequest` | Payments, finance & accounting | 32 | 12936 | FR: « Elle porte ce qui décide d'un paiement : un montant, un bénéficiaire, une échéance (ou, à défaut, un » |
| `PaymentPiece` | Payments, finance & accounting | 17 | 13019 | FR: « Le commentaire du demandeur (`note`) et celui des finances (`reviewNote`) vivent côte à côte : » |
| `PaymentRequestEvent` | Payments, finance & accounting | 8 | 13054 | FR: « LE FIL DE LA DEMANDE — chaque geste laisse une trace lisible, dans l'ordre. » |
| `ProductRange` | Products & catalogue | 13 | 1688 | FR: « L'entité dit DE QUI est le produit ; la gamme dit DE QUOI il relève. » |
| `UserProductRange` | Products & catalogue | 7 | 1717 | FR: « Quelqu'un rattaché à une entité voit tout ce qui est de cette entité. » |
| `Product` | Products & catalogue | 39 | 14868 | FR: « `RegulatoryProduct`, `PromoProduct`, `BdProduct` deviennent des PROFILS : » |
| `ProductPrice` | Products & catalogue | 9 | 14947 | FR: « L'Explorateur donne le prix OBSERVÉ (IQVIA ville : » |
| `ProductAlias` | Products & catalogue | 9 | 14969 | FR: « Un alias est une DÉCISION HUMAINE, pas une mesure : » |
| `ProductAssignment` | Products & catalogue | 12 | 15001 | FR: « La PÉRIODE (`startedAt` / `endedAt`) est indispensable : » |
| `PromoMaterial` | Promotional material (promo stock) | 48 | 7506 | Promotional-material request (MP-…) with multi-actor circuit [U] |
| `PromoQuote` | Promotional material (promo stock) | 24 | 7619 | FR: « Le FOURNISSEUR est choisi dans l'annuaire de l'entreprise (`CompanyContact`) : » |
| `PromoQuoteLine` | Promotional material (promo stock) | 15 | 7663 | FR: « UNE LIGNE DE DEVIS — ce que le demandeur RETIENT, ou non, une à une. » |
| `PromoRequestItem` | Promotional material (promo stock) | 17 | 7711 | FR: « UN ARTICLE DEMANDÉ (§118.165) — une ligne de la demande d'achat ou de location, piochée dans le CATALOGUE : » |
| `PromoRequestItemProduct` | Promotional material (promo stock) | 4 | 7742 | FR: « LES PRODUITS d'un article demandé — les produits CANONIQUES, ceux que portera l'article de stock. » |
| `PromoFacture` | Promotional material (promo stock) | 13 | 7758 | FR: « « La facture doit renseigner exactement le matériel reçu en stock. » |
| `PromoFactureLigne` | Promotional material (promo stock) | 26 | 7787 | FR: « Pré-remplie depuis la ligne du BC (`quoteLineId`) ; » |
| `PromoCatalogueArticle` | Promotional material (promo stock) | 16 | 7840 | FR: « Le Super Admin le tient ; il l'ouvre en lecture ou en écriture à qui il veut (module `PROMO_CATALOG` » |
| `PromoStockItem` | Promotional material (promo stock) | 31 | 7878 | FR: « La quantité N'EST PAS stockée ici : elle se calcule à partir des mouvements, par lot et par détenteur. » |
| `PromoStockItemProduct` | Promotional material (promo stock) | 4 | 7936 | FR: « LES PRODUITS d'un article de stock — les produits CANONIQUES, ceux que la visite coche (§118.115). » |
| `PromoStockLot` | Promotional material (promo stock) | 14 | 7960 | FR: « Personne ne choisit un lot à la main : une sortie prend toujours le lot qui expire le plus tôt (puis le plus ancien). » |
| `PromoStockMovement` | Promotional material (promo stock) | 28 | 7985 | FR: « UN MOUVEMENT DE STOCK — la seule chose qu'on écrit vraiment. » |
| `PromoStockTransfer` | Promotional material (promo stock) | 20 | 8077 | FR: « Tant qu'il est EN_ROUTE, la quantité a quitté l'envoyeur et n'est chez personne : » |
| `PromoStockRequest` | Promotional material (promo stock) | 14 | 8117 | FR: « UNE DEMANDE DE MATÉRIEL — un délégué demande au magasin ; » |
| `PromoStockComptage` | Promotional material (promo stock) | 21 | 8170 | FR: « Compter est une ATTESTATION : seul celui qui détient le matériel la donne (la gestionnaire du magasin pour le magasin). » |
| `PromoStockComptageLigne` | Promotional material (promo stock) | 8 | 8205 | FR: « UNE LIGNE DE COMPTAGE — ce que le registre attendait, ce qui a été compté, l'écart. » |
| `PromoStockComptageRecurrence` | Promotional material (promo stock) | 18 | 8228 | FR: « L'AUTORITÉ DE L'AUTEUR EST RELUE À CHAQUE DÉCLENCHEMENT : » |
| `PromoStockAlerte` | Promotional material (promo stock) | 2 | 8263 | FR: « UNE ALERTE DE STOCK DÉJÀ ENVOYÉE — l'alerte part à l'ENTRÉE dans un état, pas à chaque battement (§118.168). » |
| `PromoStockRefonte` | Promotional material (promo stock) | 11 | 8279 | FR: « UNE PROPOSITION DE REFONTE d'un support DURABLE — » |
| `RegulatoryFeatureAccess` | Regulatory intelligence OS | 6 | 10333 | FR: « Déblocage du module Regulatory Intelligence PAR ORGANISATION (Company). » |
| `RegulatoryDossier` | Regulatory intelligence OS | 20 | 10343 | FR: « Un dossier réglementaire (un produit × une procédure) pour une organisation. » |
| `RegulatoryDossierVersion` | Regulatory intelligence OS | 19 | 10513 | FR: « Une version reçue du dossier (fournisseur V1, V2…). » |
| `RegulatoryDocument` | Regulatory intelligence OS | 24 | 10541 | FR: « Un document du dossier = entrée de MANIFEST immuable + statut de sécurité/extraction. » |
| `RegulatoryExtraction` | Regulatory intelligence OS | 14 | 10576 | FR: « Texte extrait d'un document (une entrée par document). » |
| `RegulatoryFinding` | Regulatory intelligence OS | 29 | 10620 | FR: « Constat d'analyse (moteur de règles déterministe OU agent IA OU humain). » |
| `RegulatorySource` | Regulatory intelligence OS | 12 | 10675 | FR: « CORPUS RÉGLEMENTAIRE VERSIONNÉ — une source (texte de loi/arrêté/guideline). » |
| `RegulatorySourceVersion` | Regulatory intelligence OS | 18 | 10699 | FR: « Version datée d'une source : texte original + hash, statut (ACTIVE = fait foi), approbation. » |
| `RegulatorySourceSection` | Regulatory intelligence OS | 9 | 10728 | FR: « Section/article d'une version — unité de découpage pour le RAG + citation exacte. » |
| `RegulatoryCorpusApproval` | Regulatory intelligence OS | 7 | 10745 | FR: « Traçabilité d'approbation d'une version de corpus (qui a validé/activé/retiré). » |
| `RegulatoryFact` | Regulatory intelligence OS | 15 | 10767 | FR: « JUMEAU NUMÉRIQUE — un fait réglementaire canonique par (version, clé) : » |
| `RegulatoryFactOccurrence` | Regulatory intelligence OS | 14 | 10791 | FR: « Une occurrence sourcée d'un fait : document + section (+ page quand l'OCR la fournit), extrait EXACT » |
| `RegulatoryConflict` | Regulatory intelligence OS | 15 | 10820 | FR: « CONFLIT : valeurs concurrentes d'un même fait entre documents/modules. » |
| `RegulatoryAssessment` | Regulatory intelligence OS | 12 | 10843 | FR: « Bilan de complétude/conformité d'une version (recalculé à chaque passage du moteur). » |
| `RegulatoryJob` | Regulatory intelligence OS | 18 | 10860 | FR: « File de jobs asynchrones (Node-first, en base). » |
| `RegulatoryAuditLog` | Regulatory intelligence OS | 10 | 10886 | FR: « Journal d'audit dédié Regulatory Intelligence (qui, quoi, quand, preuve/méta). » |
| `RegulatoryRulePack` | Regulatory intelligence OS | 13 | 10915 | FR: « MOTEUR DE RÈGLES ADMINISTRABLE (G5) — un « rule pack » regroupe des règles versionnées, approuvées p » |
| `RegulatoryRule` | Regulatory intelligence OS | 23 | 10937 | FR: « Une règle exécutable, sourcée sur le corpus (citation) — » |
| `RegulatoryUploadSession` | Regulatory intelligence OS | 19 | 10979 | FR: « UPLOAD RÉSUMABLE DE GROS FICHIERS (G14) — session d'envoi par parties. » |
| `RegulatoryUploadPart` | Regulatory intelligence OS | 8 | 11011 | FR: « Une partie reçue d'une session d'upload (octets chiffrés au repos non requis ici : » |
| `RegulatoryGeneratedDoc` | Regulatory intelligence OS | 12 | 11029 | FR: « GÉNÉRATION DOCUMENTAIRE (G10) — un document produit à partir d'un TEMPLATE versionné et des données  » |
| `RegulatoryDossierChatMessage` | Regulatory intelligence OS | 11 | 11051 | FR: « MESSAGERIE DU DOSSIER — le fil « Discuter avec ce dossier » PERSISTE côté serveur, comme une messagerie : » |
| `RegulatoryReserveCycle` | Regulatory intelligence OS | 16 | 11077 | FR: « RÉSERVES ANPP (G9) — un CYCLE de réserves = une lettre reçue de l'ANPP, océrisée (texte verbatim), d » |
| `RegulatoryReservePoint` | Regulatory intelligence OS | 17 | 11103 | FR: « Un point de réserve décomposé : extrait verbatim, catégorie, réponse proposée/approuvée. » |
| `RegulatoryAiCall` | Regulatory intelligence OS | 19 | 11137 | FR: « `cacheKey` est l'empreinte de l'entrée (SHA-256 du prompt + modèle + schéma) : » |
| `RegulatoryAiBatch` | Regulatory intelligence OS | 25 | 11175 | FR: « `mapping` relie chaque réponse du lot au document et à la part de texte d'origine : » |
| `RegulatoryAiCache` | Regulatory intelligence OS | 8 | 11214 | FR: « RÉSULTAT D'ANALYSE MIS EN CACHE — indexé par empreinte d'entrée. » |
| `AnppReserveBatch` | Regulatory intelligence OS | 17 | 11258 | FR: « LOT DE RÉSERVES — une lettre, un courriel, un tableau reçu de l'ANPP. » |
| `AnppReserve` | Regulatory intelligence OS | 34 | 11288 | FR: « UNE RÉSERVE ANPP, normalisée et rattachée à son contexte produit et CTD. » |
| `AnppDerivedRule` | Regulatory intelligence OS | 16 | 11360 | FR: « C'est ici que se joue « apprendre sans apprendre aveuglément » : » |
| `RegulatorySimulation` | Regulatory intelligence OS | 8 | 11388 | FR: « REVIEWER SIMULATOR (G11) — stress test MULTI-PERSPECTIVES du dossier, présenté comme une SIMULATION  » |
| `RegulatorySupplierRequest` | Regulatory intelligence OS | 17 | 11412 | FR: « BOUCLE FOURNISSEUR (G8) — demande de compléments au fournisseur : » |
| `RegulatorySupplierQuestion` | Regulatory intelligence OS | 8 | 11436 | FR: « Une question posée au fournisseur (+ réponse reçue). » |
| `RegulatoryLifecycleEvent` | Regulatory intelligence OS | 11 | 11477 | FR: « LIFECYCLE (G12) — chronologie réglementaire d'un dossier : » |
| `RegulatoryObligation` | Regulatory intelligence OS | 12 | 11495 | FR: « OBLIGATION post-enregistrement / certificat expirant (G12) — » |
| `RegulatoryCaseStudy` | Regulatory intelligence OS | 9 | 12358 | FR: « ÉTUDE DE CAS — un produit PASSÉ, son dossier et son ISSUE RÉELLE à l'ANPP. » |
| `RegulatoryCaseDoc` | Regulatory intelligence OS | 10 | 12371 | Document of a regulatory case study [U] |
| `MedicalSpecialty` | Segmentation, field force & medical promotion | 10 | 4639 | FR: « Spécialité médicale (Cardiologie, Oncologie…) — » |
| `MedicalDoctor` | Segmentation, field force & medical promotion | 51 | 4656 | HCP (médecin) master record, segmentation letters, delegate [U] |
| `MedicalInstitution` | Segmentation, field force & medical promotion | 23 | 4882 | Hospital/clinic (établissement) [U] |
| `MedicalInstitutionService` | Segmentation, field force & medical promotion | 9 | 4934 | FR: « Le NOM est unique par établissement, sans égard à la casse ni aux espaces de bord : » |
| `MedicalVisit` | Segmentation, field force & medical promotion | 29 | 4979 | Field visit of a delegate to a doctor [U] |
| `MedicalVisitSupportNumerique` | Segmentation, field force & medical promotion | 5 | 5030 | FR: « UN SUPPORT NUMÉRIQUE PRÉSENTÉ EN VISITE (§118.166) — » |
| `MedicalDelegatePlan` | Segmentation, field force & medical promotion | 14 | 5042 | Delegate visit plan [U] |
| `FieldReport` | Segmentation, field force & medical promotion | 35 | 8529 | Voice field report from a delegate [U] |
| `FieldReportAttachment` | Segmentation, field force & medical promotion | 8 | 8590 | Attachment of a field report [U] |
| `BusinessUnitSpecialty` | Segmentation, field force & medical promotion | 8 | 11595 | FR: « La BU Specialty Care vise la neurologie, la dermatologie et l'urologie : » |
| `PromoProduct` | Segmentation, field force & medical promotion | 18 | 11619 | Promoted product of a BU (field force) [U] |
| `PromoCycle` | Segmentation, field force & medical promotion | 8 | 11650 | FR: « Cycle promotionnel mensuel. » |
| `ProductForecast` | Segmentation, field force & medical promotion | 13 | 11666 | FR: « Prévision Direction par produit et par cycle (FTE cible, couverture, visites, budget). » |
| `SfeSettings` | Segmentation, field force & medical promotion | 7 | 11687 | FR: « Paramètres SFE (ligne globale) : 100% configurables par la Direction / le Super Admin. » |
| `SalesRepProfile` | Segmentation, field force & medical promotion | 16 | 11710 | FR: « Profil de KAM / délégué — configuration INDIVIDUELLE (équipe, capacité surchargée, ETP contractuel). » |
| `SalesSector` | Segmentation, field force & medical promotion | 16 | 11750 | FR: « PLUSIEURS SECTEURS PAR KAM. Un KAM peut couvrir « Alger » ET « Est » ; » |
| `SalesSectorInstitution` | Segmentation, field force & medical promotion | 8 | 11795 | FR: « UN HÔPITAL DANS UN SECTEUR. Lien pur : si l'établissement disparaît de l'annuaire, le lien n'a plus d'objet (Cascade) — » |
| `SalesSectorInstitutionService` | Segmentation, field force & medical promotion | 5 | 11817 | FR: « UN SERVICE CHOISI dans un établissement d'un secteur (§118.172) — » |
| `SalesSectorRep` | Segmentation, field force & medical promotion | 6 | 11835 | FR: « La clé est l'UTILISATEUR et non `SalesRepProfile` : » |
| `TourPlan` | Segmentation, field force & medical promotion | 27 | 11899 | FR: « Une visite planifiée EST une `MedicalVisit` au statut `PLANNED` : » |
| `PromoMessage` | Segmentation, field force & medical promotion | 13 | 11970 | FR: « LA PORTÉE SUIT LA CONVENTION DU DÉPÔT : `businessUnitId` nul = message ouvert à toutes les gammes, ` » |
| `MedicalVisitMessage` | Segmentation, field force & medical promotion | 6 | 11992 | FR: « LES MESSAGES RETENUS lors d'un rapport terrain. » |
| `CoachingGrid` | Segmentation, field force & medical promotion | 8 | 12012 | FR: « La grille (titre, quatre niveaux de maîtrise, axes et critères, libellés du bilan) est UN document J » |
| `CoachingSheet` | Segmentation, field force & medical promotion | 20 | 12035 | FR: « Le TOTAL n'est pas stocké : il se calcule sur les notes et la grille (`bilanDesNotes`). » |
| `SalesRepMonthlyKpi` | Segmentation, field force & medical promotion | 15 | 12079 | FR: « L'instantané est donc écrit UNE FOIS, au passage du mois, avec ce qui était vrai ce mois-là — » |
| `PromotionAssignment` | Segmentation, field force & medical promotion | 12 | 12109 | FR: « Affectation d'un produit à un KAM pour un cycle, avec rang de détail (position) et visites prévues. » |
| `MedicalVisitProduct` | Segmentation, field force & medical promotion | 5 | 15032 | FR: « `MedicalVisit.presentedProducts` (texte libre) est CONSERVÉ : » |
| `SegmentationStrategie` | Segmentation, field force & medical promotion | 15 | 15750 | FR: « Le classeur « Segmentation Finale » devient des objets : » |
| `SegmentationStrategieProduit` | Segmentation, field force & medical promotion | 10 | 15776 | FR: « UN PRODUIT CLASSÉ DANS LA STRATÉGIE — rang 1, 2 ou 3, sur une PÉRIODE. » |
| `SegmentationRegle` | Segmentation, field force & medical promotion | 8 | 15796 | FR: « UNE VERSION DE RÈGLES — seuils par produit (potentiel, affinité, exceptions régionales), ciblage, st » |
| `SegmentationFiche` | Segmentation, field force & medical promotion | 17 | 15812 | FR: « LA PLACE D'UN PRATICIEN DANS UNE STRATÉGIE — le praticien est CELUI DE L'ANNUAIRE (jamais une copie) ; » |
| `HcpObservation` | Segmentation, field force & medical promotion | 16 | 15845 | FR: « LE POTENTIEL TERRAIN D'UN PRATICIEN, HISTORISÉ — » |
| `SegmentationDerogation` | Segmentation, field force & medical promotion | 17 | 15874 | FR: « UNE DÉROGATION — le calcul propose, une personne tranche, et cela se voit : » |
| `SegmentationImport` | Segmentation, field force & medical promotion | 10 | 15900 | FR: « UN FICHIER DE SEGMENTATION IMPORTÉ — son empreinte (le même fichier ne s'importe pas deux fois dans  » |
| `PromoProductSpecialite` | Segmentation, field force & medical promotion | 7 | 15918 | FR: « PRODUIT × BU → SPÉCIALITÉS VISÉES (cahier des charges §6). » |
| `ConsommationImport` | Segmentation, field force & medical promotion | 13 | 15940 | FR: « Un fichier importé (`ConsommationImport`) devient des lignes au FORMAT CANONIQUE (`ConsommationLigne » |
| `ConsommationLigne` | Segmentation, field force & medical promotion | 25 | 15962 | Line of a consumption import [U] |
| `ConsommationMemoire` | Segmentation, field force & medical promotion | 8 | 15998 | FR: « CE QU'UNE PERSONNE A CONFIRMÉ — « ETAB » est un établissement, « RAL 400MG » est ce produit. » |
| `AffiniteConfig` | Segmentation, field force & medical promotion | 9 | 16014 | FR: « COMMENT L'AFFINITÉ D'UN PRODUIT SE CALCULE : sa consommation ÷ celle d'un marché pertinent (un panie » |
| `SegmentationCycle` | Segmentation, field force & medical promotion | 17 | 16036 | FR: « Pourquoi pas `PromoCycle` : celui-ci est un MOIS CALENDAIRE unique (année, mois) qui porte les prévi » |
| `VoixTerrainCache` | Segmentation, field force & medical promotion | 5 | 16586 | FR: « LA VOIX DU TERRAIN, MISE EN CACHE POUR LA JOURNÉE (`src/lib/voix-terrain-luna.ts`) : » |
| `PraticienRelation` | Segmentation, field force & medical promotion | 14 | 16601 | FR: « INTELLIGENCE TERRAIN (console d'administration, Super Admin seul — » |
| `InfluenceScore` | Segmentation, field force & medical promotion | 4 | 16631 | FR: « LE SCORE D'INFLUENCE EN CACHE (0–100) et ses raisons (points expliqués) — » |
| `AnalyseWatermark` | Segmentation, field force & medical promotion | 6 | 16642 | FR: « LE FILIGRANE D'UNE ANALYSE INCRÉMENTALE : jusqu'où les rapports ont été lus (`dernierLe` + `dernierI » |
| `StockMovement` | Stocks (PCH dated states) | 14 | 7416 | Stock movement (PCH stock tracking) [U] |
| `StockOpeningLevel` | Stocks (PCH dated states) | 11 | 7443 | FR: « Stock initial d'un produit à un emplacement (PCH…). » |
| `StockAnnex` | Stocks (PCH dated states) | 8 | 9989 | FR: « Lieu de stockage nommé du module Stocks, géré par le Super Admin. » |
| `StockRequestRecurrence` | Stocks (PCH dated states) | 19 | 10035 | FR: « Mêmes champs et mêmes valeurs que `ScheduledWorkflow` (récurrence nommée + heure locale + jour), et  » |
| `StockRequestRecurrenceHospital` | Stocks (PCH dated states) | 4 | 10092 | FR: « LES HÔPITAUX visés par une récurrence. Une table de liaison et non une liste de texte : » |
| `StockSnapshot` | Stocks (PCH dated states) | 14 | 10102 | Dated stock state (PCH/annex) [U] |
| `StockCountRequest` | Stocks (PCH dated states) | 14 | 10144 | FR: « La ligne porte la SAISIE (brouillon compris). L'ENVOI écrit l'état daté (`StockSnapshot`) du module Stocks : » |
| `StockCountRequestHospital` | Stocks (PCH dated states) | 12 | 10168 | FR: « UN ÉTABLISSEMENT VISÉ. Le nom et la wilaya sont FIGÉS : » |
| `StockCountRequestLine` | Stocks (PCH dated states) | 15 | 10193 | FR: « UNE CASE de la matrice établissement × produit. » |
| `StockCountRequestRecipient` | Stocks (PCH dated states) | 9 | 10219 | FR: « UN KAM DESTINATAIRE — une seule vue par KAM et par demande, son envoi, ses relances. » |
| `Supplier` | Supplier portal | 16 | 6930 | Supplier (portal account owner) [U] |
| `SupplierUser` | Supplier portal | 11 | 6953 | External supplier login [U] |
| `WorkflowDefinitionVersion` | Validation & workflow engines | 7 | 5470 | FR: « INSTANTANÉ d'un circuit de validation à chaque enregistrement du builder : » |
| `ValidationRule` | Validation & workflow engines | 20 | 6805 | Configurable validation rule (Validation Center) [U] |
| `ValidationRequest` | Validation & workflow engines | 28 | 6832 | Validation request (VAL-…) routed to validators [U] |
| `ValidationParticipant` | Validation & workflow engines | 6 | 6876 | FR: « Un collègue ajouté à une demande de validation : » |
| `ValidationStep` | Validation & workflow engines | 11 | 6888 | Ordered validator step of a validation request [U] |
| `ValidationItemDecision` | Validation & workflow engines | 8 | 6911 | FR: « Décision GRANULAIRE d'un validateur, élément par élément : » |
| `WorkflowDefinition` | Validation & workflow engines | 10 | 9856 | Configurable workflow (Ad & Pro engine) [U] |
| `WorkflowStep` | Validation & workflow engines | 23 | 9869 | Step of a workflow definition [U] |
| `WorkflowInstance` | Validation & workflow engines | 17 | 9907 | Running workflow on an entity [U] |
| `WorkflowStepEvent` | Validation & workflow engines | 11 | 9966 | Event on a workflow step [U] |
| `BlogArticle` | Website (site web) | 20 | 15353 | FR: « UN ARTICLE DE BLOG destiné au site public (`/blog/<slug>`). » |
| `SiteReprise` | Website (site web) | 10 | 15392 | FR: « La ligne SURVIT au contenu (`SetNull`) : un article repris puis supprimé dans l'ERP doit rester caché sur le site — » |
| `SitePublication` | Website (site web) | 25 | 15432 | FR: « La ligne SURVIT à la suppression du contenu (opération DELETE) : » |
| `SitePushAttempt` | Website (site web) | 14 | 15474 | FR: « LE JOURNAL DES REQUÊTES vers le site : externalId, code HTTP, corps de réponse (§7 du contrat). » |
| `SiteReconciliation` | Website (site web) | 21 | 15497 | FR: « UNE RÉCONCILIATION avec le site (`GET /jobs`, `GET /posts`) — » |
| `SiteWebCle` | Website (site web) | 12 | 15547 | FR: « SCELLÉES au repos (`secret-box`, AES-256-GCM), comme les jetons Google et Microsoft. » |
| `SiteCandidature` | Website (site web) | 25 | 15576 | FR: « La boîte d'ARRIVÉE, pas le pipeline : le pipeline vit dans `RecruitmentCandidate`. » |
| `SiteAnalyticsEvent` | Website (site web) | 18 | 16123 | FR: « L'AUDIENCE DU SITE PUBLIC (Direction, 07/10) — » |

---

## Orchestrator verification addendum (2026-10-24, HEAD 41b2ef0)

- [V] **Fresh bootstrap works.** On an empty local PostgreSQL 16 database, `npx prisma migrate deploy` applied all 462 migration folders without error ("All migrations have been successfully applied"). The future-dated and duplicate timestamps do not break a clean bootstrap today.
- [V] **Schema ↔ DB drift, measured.** `prisma migrate diff --from-url <freshly migrated DB> --to-schema-datamodel prisma/schema.prisma --script` produces 664 lines: 123 `AlterTable` (119 of them are `updatedAt DROP DEFAULT` — the SQL sets `DEFAULT now()`, Prisma uses `@updatedAt`), 50 `DropIndex` (SQL-only indexes: trigram `*_trgm`, full-text `tsv`/`search_vector`, partial/business indexes), 19 `DropForeignKey` + 10 `AddForeignKey` (FKs declared differently or only in SQL — mostly Mission*/Assistant*), 8 `RenameIndex`, 4 `CreateIndex` (constraints the SQL expresses as *partial* unique indexes, e.g. `MissionStep_idempotencyKey_key … WHERE "idempotencyKey" IS NOT NULL` — semantically present), 2 `DropTable` (`MailEntryLink`, `SalesTeam` — kept in DB, removed from schema) and dropped columns `RegulatoryExtraction.tsv`, `RegulatorySourceSection.search_vector`, `SalesRepProfile.teamId`.
- **Rule that follows:** `schema.prisma` is the source of truth for the *Prisma client types*; the SQL migrations are the source of truth for the *database*. Never run `npm run db:migrate` (`prisma migrate dev`) or `npm run db:push` against a real database — both would try to drop the objects above. Write new migrations by hand, idempotent, named after the latest folder (`> 20270126100000_*`).
