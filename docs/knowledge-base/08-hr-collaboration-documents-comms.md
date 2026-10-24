# 08 — HR & administration · Collaboration · Documents/Files · Communications

> Knowledge-base chapter written from a read-only code walk on 2026-10-24 (HEAD `11a281d`, Graphify built from `41b2ef0e`).
> Tags: **[V]** = read in code (file:line cited) · **[U]** = inferred / not executed / not fully traced.
> French domain terms are kept verbatim with a short gloss on first use.

---

## 1. Scope

| Sub-area | What is covered |
|---|---|
| **HR (RH, *ressources humaines*)** | `Employee` record, contracts & probation (*période d'essai*), leave (*congés*), payroll elements and their confidentiality, HR requests from **« Mon dossier RH »** (employee self-service), expense notes (*notes de frais*), recruitment (*recrutement*) pipeline, trainings (*formations*), org chart / reporting line (*N+1* = direct manager), **« Mon équipe »**. |
| **Collaboration** | **Mon espace** (personal action center, tab « Aujourd'hui »), tasks (*tâches*), directives (*notes de service*), dossiers a.k.a. **« Sujets »**, third-party involvement (*implication d'une tierce personne*), calendar (Africa/Algiers), meetings (Jitsi, transcription), internal messaging (*messagerie*), notifications (in-app + Web Push). |
| **Files** | Storage abstraction (`FileBlob` encrypted vault, S3/R2 bucket vs Postgres), Drive model, direct browser→bucket uploads (presigned multipart), preview (mammoth/xlsx/jszip/native), OnlyOffice editing, printing, PDF generation (pdfkit / mupdf / home-made), compression at rest and "reduced" downloads, OCR pointers. |
| **Mail & comms** | Microsoft 365 mailbox (`/messagerie`), the retired Infomaniak IMAP webmail (`/courrier`), "smart mail" HTTP providers, Google (Adam/Chief identity), physical mail register (*registre des courriers*, `/courriers`). |
| **Legal register** | `LegalDocument`, restricted readers (*lecteurs désignés*), expiry sweep / reminders, the document factory (*fabrique*) pointer. |

Out of scope (other chapters): validations engine internals, Ad & Pro, Regulatory CTD pipeline (it reuses the same storage), Adam assistant/mission runtime (only touched where it emits/consumes events here).

---

## 2. Summary

- **One encrypted vault, two backends**: every byte goes through `src/lib/drive-storage.ts` (`putBlob`/`getBlob`), AES-256-GCM, brotli-compressed *before* encryption when worthwhile, deduplicated by SHA-256 of the clear text, stored in an S3-compatible bucket if `S3_*` is set, otherwise in Postgres (`FileBlob.data` or `FileBlobChunk`). **Exception**: files ≥ `S3_DIRECT_THRESHOLD_MB` (20 MB default) go browser→bucket via presigned multipart and are stored **unencrypted by the app** (marked by an empty IV) [V].
- **HR requests** are `HrDocumentRequest` rows created from `/mon-dossier` by `requestHrDocument`; leave-type requests are *re-routed* to the `LeaveRequest` circuit (N+1 → RH, DG step removed 06/10). RH processes in `/rh/demandes` (`processHrRequest`, `decideHrLeave`, `decideExpenseReport`), the employee is notified with `notifyUser` [V].
- **Reporting line is a single pure cascade** (`resolveManager` in `src/lib/hr/reporting-line.ts`); `directReportsOf` and `subtreeOf` are defined *as its inverse*, so "Mon équipe" and request routing cannot diverge [V].
- **Real-time = polling** (no SSE/WebSocket): `/api/messaging/sync` every 6 s in the messenger / 12 s for the topbar badge, thread poll 3.5 s, `/api/notifications/poll` every 15 s; in-memory "typing" registry (single instance assumption) [V]. The messaging sync route also kicks the **global scheduler** (`runScheduledJobs`) [V].
- **Notifications**: `notifyUser` / `notifyRoles` / `broadcastNotification` write `Notification` rows and fire Web Push (VAPID auto-generated and persisted if env keys absent). **No e-mail channel exists for notifications** [V].
- **OnlyOffice**: hand-rolled HS256 JWT; Document Server reads `/api/onlyoffice/file?token=…` and saves through `/api/onlyoffice/callback`. **Top risk**: the callback does not re-check write access and accepts unsigned bodies, while view-mode sessions still ship a write-capable token to the browser (§8, §10) [V].
- **Mail**: Microsoft 365 behind three locks (flag `MICROSOFT_MAIL`, Entra vars, pilot list), tokens sealed with AES-GCM; Infomaniak webmail is retired (`/courrier` redirects) but `src/lib/mail.ts` + `/api/mail/*` routes remain [V].
- **Legal**: restricted readers are additive to entity scoping; a daily-ish sweep expires and reminds, respecting readers and company [V].

---

## 3. Key files

| Path | Role |
|---|---|
| `src/lib/drive-storage.ts` | The vault: `putBlob`, `putBlobFromFile`, `getBlob`, `infoBlob`, `releaseBlob`, `purgeOrphanBlobs`, `cleObjetDirect`; AES-GCM master key; compression at rest. |
| `src/lib/storage.ts` | `Document`-model storage (`saveFile`/`readFileByKey` via `StoredFile` key→blob map) + upload validators (`validateUpload`, `validateDriveUpload`, `validateDocumentUpload`). |
| `src/lib/storage/object-storage.ts` | Dependency-free S3 SigV4 client: put/get/multipart, `presignPutUrl`, `presignGetUrl`, `presignUploadPartUrl`, `listParts`, `headObjectSize`. |
| `src/lib/storage/s3-config.ts` | Env resolution (`S3_*`, legacy `REG_S3_*`, `S3_DISABLED`). |
| `src/lib/storage/televersement-direct.ts` | Shared browser→bucket multipart engine (open / resume plan / finalize, injectable client). |
| `src/lib/storage/envoi-direct-client.ts` | Import-free browser module that PUTs parts in parallel with progress/abort. |
| `src/lib/storage/limites-blob.ts`, `phrases-stockage.ts` | Pure limits: 2 GB vault cap, 10 GB per-file cap, `MAX_DB_UPLOAD_MB` (default 100). |
| `src/lib/drive.ts` | `resolveDriveAccess` (owner / share / space / module scope), `canCreateInSpace`, `effectiveSpaceId`. |
| `src/lib/drive/depot.ts` | Single authorization (`refusDepotDrive`) + registration (`enregistrerFichierDrive`) shared by normal and direct upload paths. |
| `src/lib/drive/depot-direct.ts` | Drive large-file direct upload sessions (`DirectUpload` model). |
| `src/app/api/drive/upload/{route,claim,direct,direct/[id]}` | Upload endpoints: multipart form, hash-claim (instant dedup), direct open/replan/finalize/abort. |
| `src/app/api/drive/[id]/raw/route.ts` | Download/preview stream; ZIP for folders; presigned GET redirect for direct objects. |
| `src/components/drive/envoi-drive.ts` | Client orchestration: pre-refusal, direct-path selection, hash preflight. |
| `src/app/(app)/drive/[id]/{page,file-viewer}.tsx`, `src/components/documents/{apercu-universel,office-viewers}.tsx`, `src/lib/formats/apercu.ts` | Open-a-file page, preview routing table, mammoth/xlsx/jszip lazy viewers. |
| `src/lib/onlyoffice.ts`, `onlyoffice-session.ts`, `onlyoffice-config.ts`, `office-convert.ts` | JWT, edit tokens, editor config (Drive + `Document`), conversion. |
| `src/app/api/onlyoffice/{file,callback,session}/route.ts`, `src/app/office-embed/[id]/page.tsx` | Document-Server-facing routes and embed page. |
| `src/lib/print-document.ts` | Hidden same-origin iframe print, `window.open` fallback. |
| `src/lib/compression/{politique,flux,reduction,reduction-cache,zip-ecriture}.ts` | Brotli-at-rest policy, "taille réduite" downloads, streaming ZIP writer. |
| `src/lib/pdf/simple-pdf.ts`, `src/lib/payslip/to-pdf.ts` | Zero-dependency text PDF; DOCX→PDF via pdfkit (payslips etc.). |
| `src/lib/actions/hr-document-actions.ts` | HR request lifecycle (create, edit expense, process, decide leave/expense, ack originals, HR interview, cancel, archive). |
| `src/lib/actions/hr-actions.ts`, `src/lib/hr/leave-core.ts`, `src/lib/leave-workflow.ts`, `src/lib/approval-chain.ts` | Employees, leave circuit, advances. |
| `src/lib/hr/reporting-line.ts`, `src/lib/hr/team-tree.ts`, `src/lib/departments.ts` | N+1 cascade, N-1 inverse, subtree; DB loader `loadReportingLine`. |
| `src/lib/hr/confidentialite.ts` | `voitLesSalaires`, absence-nature masking. |
| `src/lib/recruitment/request-flow.ts`, `src/lib/actions/recruitment-actions.ts` | Dynamic recruitment chain + candidate pipeline. |
| `src/lib/actions/training-actions.ts` | Training requests (3-step chain N+1 → RH → DG). |
| `src/lib/queries/action-center.ts`, `src/lib/espace/aujourdhui.ts` | Mon espace aggregation (data) and grouping/urgency rules (pure). |
| `src/lib/tasks/*`, `src/lib/actions/task-actions.ts` | Task request/accept/do flow. |
| `src/lib/directives/{access,audience,recipients}.ts`, `src/lib/actions/directive-actions.ts` | Directives. |
| `src/lib/actions/dossier-actions.ts`, `src/lib/third-party.ts` | « Sujets » and third-party involvement. |
| `src/lib/calendar.ts`, `src/lib/calendar-tz.ts`, `src/lib/meetings.ts`, `src/app/api/meetings/[id]/recording/route.ts`, `src/app/meet/[token]` | Calendar, Algiers TZ, Jitsi rooms, transcription. |
| `src/lib/messaging.ts`, `messaging-ui.ts` (pure), `messaging-typing.ts`, `messaging-attachments.ts`, `src/lib/actions/messaging-actions.ts`, `src/lib/queries/messaging.ts`, `src/app/api/messaging/*` | Internal messaging. |
| `src/lib/notify.ts`, `src/lib/notifications/ecrire.ts`, `src/lib/push.ts`, `src/app/api/notifications/poll`, `src/app/api/push/{key,subscribe}` | Notifications. |
| `src/lib/events/{catalogue,ledger,messaging-events}.ts` | Business-event registry (`MESSAGE_RECEIVED`, `EMAIL_RECEIVED`, `MEETING_*`…). |
| `src/lib/mail/*` (`config`, `access`, `oauth`, `connection`, `graph/*`), `src/lib/crypto/secret-box.ts`, `src/app/(app)/messagerie`, `src/app/api/mail/ms/*` | Microsoft 365. |
| `src/lib/mail.ts`, `src/app/(app)/courrier/page.tsx`, `src/app/api/mail/{messages,message,attachment,contacts}` | Retired IMAP/SMTP webmail (dormant). |
| `src/lib/mail-smart.ts`, `src/app/api/mail/inbound` | HTTPS mail providers (Resend/Postmark/Brevo). |
| `src/lib/google/*`, `src/app/api/google/{connect,callback,pubsub}` | Google Workspace for the Adam identity. |
| `src/lib/mail-register/{write,trace}.ts`, `src/app/(app)/courriers` | Physical mail register. |
| `src/lib/lecteurs/legal.ts`, `src/lib/legal/{lifecycle,expiry-sweep,piece-emise}.ts`, `src/lib/actions/legal-actions.ts` | Legal register, readers, expiry. |
| `src/lib/scheduled.ts` | In-process scheduler (heartbeat + piggy-back) running leave accrual, meeting reminders, legal sweep, direct-upload cleanup… |
| `src/lib/sortie/garde.ts` | Outbound guard: every transport (mail, push, Graph, Google) must call it; throws/no-ops in tests. |

---

## 4. How it works

### 4.1 Storage abstraction (the vault)

- **Master key** `masterKey()` `src/lib/drive-storage.ts:28-37`: `DRIVE_ENCRYPTION_KEY` (64 hex chars or base64 of 32 bytes); otherwise `sha256(NEXTAUTH_SECRET ?? AUTH_SECRET ?? "amd-internal-os")` [V]. Rotating the auth secret without an explicit `DRIVE_ENCRYPTION_KEY` makes every stored file unreadable [V by construction].
- **Write** `putBlob(plain)` `drive-storage.ts:192-229` [V]:
  1. `sha256(plain)` → `reemployer(hash)` (dedup: existing row → bump refCount, return).
  2. `decider(plain)` (`compression/flux.ts:61`) — brotli only if gain ≥ thresholds in `compression/politique.ts` (min 4 KB, gain ≥10 %, sample gain ≥15 %, already-compressed magic numbers skipped) (§118.214).
  3. Bucket configured (`objectStorageConfigured()`): encrypt whole buffer, `putObject` or `putObjectStream` above `MULTIPART_THRESHOLD_BYTES` = 32 MB (`object-storage.ts:221`), unique key `blobs/<h2>/<hash>-<rand>` (`drive-storage.ts:54`, avoids concurrent overwrite — "audit du 04/10, constat 4").
  4. Else Postgres: chunked (`FileBlobChunk`, `REG_BLOB_CHUNK_MB` default 16) or single `bytea`.
  5. A bucket write failure **throws** (`storageFailure`) — no silent fallback to DB (doc 25 confirms) [V].
- **Read** `getBlob` `drive-storage.ts:336-368`: `storageKey && iv.length===0` ⇒ raw object (direct upload, not app-encrypted) `:341`; else decrypt, then `decompresser` and **re-verify SHA-256** of the decompressed clear `:365-366` [V].
- **Two "documents" stacks share the vault**: Drive (`DriveNode`→`FileVersion`→`FileBlob`) and the generic `Document` model (`fileKey` → `StoredFile.key` → `FileBlob`) via `src/lib/storage.ts:27-56` [V]. HR request attachments, directive attachments, module pieces use the latter.
- **Limits** (`src/lib/storage.ts:65-89`, `limites-blob.ts`): `validateUpload` default `MAX_UPLOAD_MB`=25, `validateDriveUpload` default `MAX_DRIVE_UPLOAD_MB`→`MAX_UPLOAD_MB`→100; runtime values come from `AppSettings` (`maxUploadMb`, `maxDriveUploadMb`) passed as arguments [V]. Vault cap `BLOB_MAX_BYTES`=2 147 483 647 (32-bit `size` legacy), per-file cap 10 GB, DB-only cap `MAX_DB_UPLOAD_MB` default 100 [V]. The browser learns them from `GET /api/uploads/limites` (`src/app/api/uploads/limites/route.ts:19-28`, `private, max-age=60`) [V].
- **Policy on file types**: Drive and messaging refuse executables only (`src/lib/files/politique-televersement.ts`, `attachment-policy.ts`) [U: rule body not read; docs 18 assert it].

### 4.2 Drive model & access

- Models (`prisma/schema.prisma`): `DriveNode` (6322; tree via `parentId`, `spaceId` for shared categories, `size Float`, `isTrashed`), `FileVersion` (6423, `@@unique([nodeId, version])`), `FileBlob` (6388), `FileBlobChunk` (6412), `DriveShare` (6514, VIEW/EDIT per user), `DriveSpace` (6370), `DirectUpload` (15718) [V].
- `resolveDriveAccess` `src/lib/drive.ts:15-45` [V]: Super Admin → EDIT; module scope `ALL` → baseline VIEW on **every** node; space managers → EDIT, space viewers → VIEW; then walks ancestors (one query per level): owner → EDIT, any EDIT share → EDIT, any share → VIEW.
- Upload authorization (shared by both paths) `refusDepotDrive` `src/lib/drive/depot.ts:37-48`: new version ⇒ EDIT on node; new file in folder ⇒ EDIT on folder; category root ⇒ `canCreateInSpace`; personal root ⇒ `DRIVE:UPLOAD` [V]. Registration `enregistrerFichierDrive` `depot.ts:54-98` creates `DriveNode`+v1 or next `FileVersion`, shares with `skipDuplicates`, audit [V].
- Messaging attachments "from the Drive" are *references* (`MessageAttachment.driveNodeId`), granting VIEW shares with `skipDuplicates` so an existing EDIT is never downgraded (docs 18; `sendMessage` `messaging-actions.ts:432` calls `grantDriveRefAccess`) [V for call site, U for helper body].

### 4.3 Preview, editing, printing, PDF, compression, OCR

- **Open a file** `/drive/[id]` `src/app/(app)/drive/[id]/page.tsx:32-80`: `requireModule("DRIVE")`, `resolveDriveAccess` (NONE → 404), folders redirect; Office formats get an editor session built server-side (`sessionEditeur`) [V].
- **Preview routing** `src/lib/formats/apercu.ts` (pure table: image/video/audio/pdf native; docx/xlsx/pptx; "converti"; zip) → `FileViewer` → `ApercuUniversel` or `ZipViewer` (`file-viewer.tsx:17-22`) [V]. Fallback viewers lazy-load `mammoth` (`office-viewers.tsx:48`), `xlsx` (`:75`), `jszip` (`:113`) on bytes fetched from `/api/drive/[id]/raw` [V]. PDFs are rendered by the browser (no pdf.js dependency) [V: not in package.json].
- **Raw route** `src/app/api/drive/[id]/raw/route.ts:17-78`: VIEW check, folder → streaming ZIP (`collecterPourZip`), file → `repondreFichier` with `?dl=1` (audited EXPORT) and `?qualite=max|reduite|estimer`; **direct-uploaded blobs are served by a 900 s presigned GET redirect** (`:58-75`) [V].
- **OnlyOffice** (see §6.3 for the flow): `onlyofficeConfigured()` = `ONLYOFFICE_URL` && `ONLYOFFICE_JWT_SECRET` (`onlyoffice.ts:12-17`); `signJwt`/`verifyJwt` HS256 with `timingSafeEqual` and `exp` (`:42-70`); tokens `makeEditToken` (kind `edit`, 24 h) / `makeDocEditToken` (kind `docedit`) (`:132-153`) [V]. `sessionEditeur` (`onlyoffice-session.ts:52-90`) sets mode `edit` only if Drive EDIT / entity `UPLOAD`; `key = nodeId_version` (or `doc_id_version_size`) to bust DS cache [V]. `buildEditorSetup` (`onlyoffice-config.ts:24-87`) is the older Drive-only builder, still used by `/office-embed/[id]` [V].
- **Conversion** `office-convert.ts:13-15` uses DS `ConvertService.ashx`; inert without OnlyOffice + `APP_URL` [V].
- **Printing** `print-document.ts:7-25`: hidden iframe on `/api/documents/[id]`, `print()`, fallback `window.open`; removed after 60 s [V]. `/impression/coaching/[id]` is a dedicated print page [V exists].
- **PDF generation**: `pdfkit` for payslip/DOCX→PDF fallback (`payslip/to-pdf.ts:1`), tour plans, livret, marketing report; `mupdf` for lossless PDF rewrite and rasterization (`compression/reduction.ts`, `storage/raster.ts`, Regulatory OCR split); `lib/pdf/simple-pdf.ts` home-made Helvetica/WinAnsi text PDF [V].
- **Compression**: at rest (brotli, transparent, `FileBlob.codec/storedSize`) and on download ("taille réduite": JPEG q80, lossless PNG/TIFF, mupdf PDF rewrite never on signed/encrypted/PDF-A, Office media optimisation, text→zip; refused if gain < 10 %) `compression/reduction.ts:7-25` [V header].
- **OCR**: `tesseract.js` lives in Regulatory intelligence (`regulatory/intelligence/ocr/*`, `extract/texte-ou-ocr.ts`); `pieces-lues/service.ts` reuses `moteurParDefaut` (text-or-OCR) + the "Luna" model for invoice/quote reading [V imports]. No OCR on generic Drive uploads except via the Drive ingestion sweep (`runDriveIngestionSweep` in `scheduled.ts`) [U whether it OCRs].

### 4.4 HR

- **Employee** `prisma/schema.prisma:5828-5922` [V]: `departmentId` is the source of truth, `department` a denormalised cache written by `org/source-unique.ts`; payroll elements `baseSalary, retSS9, retSS35*, tfp*, retIrg, expenseRefund, netToPay, grossSalary*, employerCost*` (* = confidential per schema comment); contract `contractType` (CDI/CDD/INTERIM/STAGE/FREELANCE/CONSULTING/OTHER), `contractStart/End`; probation `trialStart/End/Renewable/Renewed/RenewalStart/RenewalEnd`; `leaveBalanceDays` (default 30) + `leaveAccruedThrough` (2.5 d/month accrual, `accrueMonthlyLeave` in `scheduled.ts:104`); `managerId` explicit N+1; `orgX/orgY` org-chart map coordinates; `userId` link to the app account.
- **Confidentiality** `src/lib/hr/confidentialite.ts:19-21`: `voitLesSalaires = RH:UPDATE || RH:VALIDATE` (§118.184). `/rh/[id]` hides base salary, NIN, CNAS and payroll cards behind it (`rh/[id]/page.tsx:48,222,306-313`) [V]. Absence nature masked for managers (« Congé » vs « Absent ») [V header].
- **RBAC**: there is **no HR role** in `UserRole` (`schema.prisma:24-44`); HR is carried by module rights `RH`, and since 06/10 by sub-modules `EMPLOYEES`, `HR_REQUESTS`, `TRAINING` defaulting to each role's `RH` rights (`rbac.ts:153,663-670`) [V].
- **HR requests** (`HrDocumentRequest`, `schema.prisma:5948`; types `HrRequestType` 5799 — certificates, mission order, expense report, exceptional exit, leaves, HR interview; statuses PENDING/IN_PROGRESS/READY/DELIVERED/APPROVED/REJECTED/CANCELLED) [V]. Nature split via `hrNature()` (`src/lib/hr-request-flow.ts`): DOCUMENT (prepare & deliver) vs APPROVAL (grant/refuse) [V import; U body].
- **Leave** (`LeaveRequest` 6039 + `LeaveEscalation` 6108): created by `createLeaveRequest` (`hr/leave-core.ts:69-121`) — stage `MANAGER` if a N+1 with an account is resolved (`getManagerOf`), else straight to `HR`; N+1 notified by `notifyUser`, HR by `notifyRoles(stageNotifyRoles("HR"))` = `DIRECTION, GENERAL_MANAGER, SUPER_ADMIN` (`approval-chain.ts:121-127`) [V]. Circuit is **N+1 → RH** only (`leave-workflow.ts:1-3,39-41`, `sansDG: true`); a request already at DG stays decidable. DG (`isTopManagement`) may decide at any stage; nobody but DG decides their own (`approval-chain.ts:67-90`) [V]. Decider includes the N+1's stand-in (*intérimaire*, §118.185) (`leave-core.ts:156-175`) [V partial].
- **Trainings** share the same engine **with** the DG step: `nextChainStage(stage)` without `sansDG` (`approval-chain.ts:35-41`), `training-actions.ts:19,195,260` [V]. `isManager` is true for anyone in the requester's management chain, not only the N+1 (`training-actions.ts:218-230`) [V].
- **Recruitment** (`RecruitmentRequest` 1915, stages `CHAIN/HR_REVIEW/INFO_REQUESTED/SOURCING/ONBOARDING/CLOSED/REJECTED/CANCELLED/RETURNED`, approvals incl. `SKIPPED`, candidate statuses `RECEIVED→SHORTLISTED→SELECTED→INTERVIEWED→HIRED|DECLINED`) [V]. Chain is **dynamic** (N+1 up to the CEO, frozen at submission); RH may loop "info requested"; requester shortlists, CEO picks; CONSULTING never becomes an `Employee` (`recruitment/request-flow.ts:1-33`) [V header].
- **Expense notes**: `HrDocumentRequest` type `EXPENSE_REPORT` with `expenseMonth`, `expenseAmount`, mandatory receipt, 15-min self-edit window `editableUntil` (`hr-document-actions.ts:212-262`), RH can reopen; **RH decision blocked until the secretariat acknowledges originals** (`decideExpenseReport` `:640-645`, `ackExpenseOriginals` `:730`) [V].
- **Org chart & N+1** — §4.5.

### 4.5 Reporting line: one cascade, both directions

`resolveManager(employeeId, employees, departments)` `src/lib/hr/reporting-line.ts:74-108` [V]:
1. explicit `managerId` (if active and not self);
2. head of own department — **unless the employee is that head**, then jump to the parent (deputy skipped);
3. deputy of own department when head missing/inactive;
4. walk parent departments (head, then deputy), `MAX_DEPTH = 20`.

`directReportsOf(m)` = active employees whose `resolveManager` is `m` (`:123-133`); `managementChainOf` (`:141-158`, cycle-safe); `subtreeOf` (`team-tree.ts:50-75`) recursively applies `directReportsOf` with a `places` set and `MAX_DEPTH = 12` [V]. DB loader `loadReportingLine` is `perRequest`-cached (`departments.ts:184-195`) [V]. Consumers: `getManagerOf`/`getManagerOfUser`/`isManagerOfUser` (`departments.ts:199-232`), leave creation, trainings, Mon équipe (`queries/my-team.ts:181-182`), my-team actions (`my-team-actions.ts:39-40`), KPI scope (`kpi/service.ts:89-90,685`), promo stock (`queries/promo-stock.ts:48-49`) [V].

### 4.6 Mon espace (action center)

- Data: `getActionCenter(user)` `src/lib/queries/action-center.ts:138` concatenates permission-filtered blocks: (1) my tasks TODO/IN_PROGRESS (≤60); (2) validations **where it is my turn** only; (2b) leaves/purchases/tour plans/trainings awaiting me *or the absentee I stand in for*; (2c) Ad & Pro corrections; (3) admin requests assigned; (4) payments to settle; (5) my Regulatory dossiers; (6a–6h) Ad & Pro arbitration, congresses, medical-info instruction, promo material, requested pieces, directives concerning me, support, dossiers I own, stock requests; (7) unread notifications (`:142-947`) [V section list].
- Presentation rules (pure, no DB): `src/lib/espace/aujourdhui.ts` — group by *lot* (nature), urgency = overdue days, then amount, then age; week = Sunday→Thursday (Algerian work week); per-role tiles; no invented numbers (§118.16) [V header].

### 4.7 Tasks, directives, dossiers, third parties

- **Tasks**: assigning to someone else = *requesting* (status `REQUESTED`), the assignee accepts (→ `IN_PROGRESS`, "accepter, c'est commencer") or declines with optional reason; validated work stays editable; reminders (*relance*) every 4 h (`RELANCE_DELAI_MS`) (`tasks/request-flow.ts:1-35,224`) [V]. Visibility via `clauseTachesVisibles` (`:154`). Tab `/mon-espace/taches` (`onglet-taches.ts:20`) [V].
- **Directives**: issuers = matrix `DIRECTIVES:CREATE` ∪ settings roles/users; **publishing reserved to `SUPER_ADMIN` and `GENERAL_MANAGER`** (`directives/audience.ts:59,72-74`); a publisher's own note is published immediately; recipients resolved to active accounts, notifications written with the row-by-row replay (`directives/recipients.ts`) [V].
- **Dossiers / « Sujets »** (renamed from « Projets » 30/09/2026, `dossiers/page.tsx:42-45`): `Dossier` (`schema.prisma:4472`, `DOS-AAAA-NNN`, `assignedToId`, `participantIds[]`, origin `sourceType/sourceId`) + `DossierMessage` thread [V].
- **Third-party involvement** `involveThirdParty` (`src/lib/third-party.ts:31-63`): creates a « Implication » dossier assigned to the person (no budget visible) + a direct validation request pointing to `/dossiers/<id>`, never to the source record; used by congress/event/sponsoring/Ad & Pro actions (`congress-request-actions.ts:507-531`) [V].

### 4.8 Calendar & meetings

- Time zone: fixed offset Algiers (`ALGIERS_TZ = "Africa/Algiers"`, UTC+1, no DST) with manual shifting helpers `algiersInputToUtc`/`utcToAlgiersInput` (`calendar-tz.ts:8-36`) [V]. Server stores UTC.
- `CalendarEvent`/`CalendarInvite` (`schema.prisma:9811,9835`); `createEventForUser` (`calendar.ts:174`) used e.g. when an HR interview is confirmed (`hr-document-actions.ts:14,797`) [V import].
- Meetings: `Meeting` (9685) + participants, task proposals, chat. Jitsi rooms `AdventumOS-<slug>` on `JITSI_DOMAIN` (default `meet.jit.si`) (`lib/meetings.ts:13-30`); public guest link `/meet/[token]`; the internal page now shows a "Rejoindre" button with an organiser-editable link instead of the embed (`meetings/[id]/meet-join.tsx:12-13`) [V]. Gate: `MESSAGING` module (`meetings/page.tsx:27`) [V].
- Transcription: `POST /api/meetings/[id]/recording` stores audio via `putBlob`, then `transcribeAudio` (OpenAI `STT_MODEL` default `whisper-1`) unless disabled in the AI control centre; stores `Meeting.transcript` (`recording/route.ts:18-54`) [V].
- Meeting reminders run in `runScheduledJobs` (`scheduled.ts:101`) [V].

### 4.9 Internal messaging

- Access is **membership-only** (`ConversationMember` with `leftAt: null`), never RBAC scope (`messaging.ts:23-35`) [V]. Module gates: `MESSAGING:VIEW/CREATE/UPLOAD` on actions (`messaging-actions.ts:241,264,382,473`) [V].
- `sendMessage` (`messaging-actions.ts:378-466`) [V]: membership check → parse uploaded attachments (each must carry an HMAC `sig` from `signBlob`, `:70-90`, `messaging.ts:115-128`) and Drive refs (re-read from DB) → `Message.create` → grant Drive VIEW shares → bump `lastMessageAt` & author's `lastReadAt` → `notifyRecipients` (one unread notification per conversation per user; mentions always notify; push `tag: conv-<id>` replaces) `:337-376` → `emettreMessageRecu` writes the `MESSAGE_RECEIVED` business event (`events/messaging-events.ts:19-59`).
- Uploads: `POST /api/messaging/upload` → `putBlob` with `maxUploadMb` (lower than Drive) and returns `{blobId, sig}` (`api/messaging/upload/route.ts:20-40`) [V]. Large files/folders go through the Drive (`preparerDepotMessagerie` creates « Messagerie / <conv> / Envoi du … » in the sender's Drive, then the Drive upload routes) (`:455-469`) [V header].
- **Real-time** = polling [V]: messenger list `setInterval(…, 6000)` (`messages/messenger.tsx:73`), open thread 3.5 s (`:139`), topbar badge 12 s **also when tab hidden** (`components/layout/messages-indicator.tsx:151-167`) with a Web Audio beep unlocked on first gesture (`:9-54`); presence heartbeat throttled to ~45 s per user (`messaging.ts:132-137`); typing indicator in-process `Map`, TTL 6 s (`messaging-typing.ts:1-11`).
- Moderation rules (who may delete) are pure in `messaging-ui.ts` and shared by UI and action (docs 18, verified file exists and is re-exported `messaging.ts:8`).

### 4.10 Notifications

- `notifyUser` (`notify.ts:19-28`): `Notification.create` (errors swallowed) then `sendPushToUser`. `notifyRoles` (`:84-117`) filters unknown role names (a bad name used to silence the whole batch), `createMany` + row-by-row replay `rejouerNotifications` (`notifications/ecrire.ts:58-76`, §118.137), push to each. `broadcastNotification` (`:36-81`) for ALL/ROLE/USERS audiences, optional full-screen `popup` [V].
- Web Push (`push.ts`): VAPID from env (`VAPID_PUBLIC_KEY/PRIVATE_KEY`), else generated once and persisted in `AppSetting.global` (`:27-48`); subject `VAPID_SUBJECT` default `mailto:admin@adventum.dz` (`:75`); 404/410 subscriptions deleted (`:113-115`); guarded by `sortieAutorisee("NOTIFICATION_PUSH")` (`:96`) [V].
- Client polling: `/api/notifications/poll` every 15 s → unread count + up to 5 unread popups, links rewritten to current module paths (`notifications/poll/route.ts:12-29`, `notification-popup.tsx:32-45`) [V].
- **E-mail**: no code path sends e-mail for in-app notifications. `nodemailer` appears only in `mail.ts` (user webmail), `mail-smart.ts` (comment) and `sortie/garde.ts` (comment) [V by grep].
- **Event registry**: `CATALOGUE` of canonical facts (`events/catalogue.ts:27-63`), e.g. `MESSAGE_RECEIVED`, `EMAIL_RECEIVED`, `MEETING_SCHEDULED/ENDED`, `DOCUMENT_UPLOADED`, `TASK_COMPLETED`; written to `BusinessEvent` by `recordEvent` (`events/ledger.ts`) and consumed by Mission Runtime `WAIT_EVENT` [V catalogue; U ledger internals].

### 4.11 Mail & external comms

- **Microsoft 365** (`/messagerie`): `mailAccess` (`mail/access.ts:38-56`) = flag `MICROSOFT_MAIL` (1/true/yes/on) → config `MICROSOFT_TENANT_ID/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI` → Super Admin always / else `MICROSOFT_MAIL_PILOT` comma list (empty = Super Admin only) [V]. OAuth code + PKCE + HMAC-signed `state` (secret `AUTH_SECRET||NEXTAUTH_SECRET||"dev-mail-state"`, `mail/oauth.ts:12-37,167`); scopes `openid profile offline_access User.Read Mail.ReadWrite Mail.Send` (`mail/config.ts:21-28`); tokens sealed by `sealSecret` AES-256-GCM `iv:tag:ct` with key `sha256(MAIL_ENCRYPTION_KEY||DRIVE_ENCRYPTION_KEY||AUTH_SECRET||NEXTAUTH_SECRET||"dev-secret-box-change-me")` (`crypto/secret-box.ts:14-48`); refresh on demand (`mail/connection.ts:117-134`); every read keyed by session `userId` (no mailbox id from outside) (`connection.ts:7-12`) [V]. Graph client with throttling in `mail/graph/*`; sends pass `exigerSortieAutorisee("COURRIEL")` (`graph/provider.ts:244`) [V].
- **Infomaniak webmail (retired)**: `/courrier` → `redirect("/mon-espace")` (`courrier/page.tsx`); `src/lib/mail.ts` (imapflow/nodemailer/mailparser, pool, breaker, cache, `MailAccount` password AES-GCM) and `/api/mail/{messages,message,attachment,contacts}` remain deployed but unused by the menu [V]; `MAIL_*` tuning vars documented in `docs/readme/23` still apply to that dormant code.
- **Smart mail**: `MAIL_PROVIDER` (resend|postmark|brevo) + `MAIL_API_KEY` + `MAIL_FROM`; inbound webhook `/api/mail/inbound` HMAC with `MAIL_WEBHOOK_SECRET`, refuses all when unset (`mail-smart.ts:4-24`, docs 23 line 22) [V header].
- **Google**: one identity (Adam/Chief) — `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `GOOGLE_ADAM_EMAIL` (other mailbox refused), optional Gmail push `GOOGLE_PUBSUB_TOPIC`/`GOOGLE_PUBSUB_AUDIENCE`; scopes gmail.modify (no permanent delete), calendar, drive, docs/sheets/slides, contacts.readonly (`google/config.ts:11-87`) [V].
- **Physical mail register** (`/courriers`, module `MAIL_REGISTER`): `MailEntry` (13352) + pieces (`MailEntryPiece` → Drive node) + folders + partners; single write core `createMailEntryFor/updateMailEntryFor` used by UI and agent ops, field-level trace (`mail-register/write.ts:14-24,154,212`, `trace.ts`) [V].

### 4.12 Legal register

- `LegalDocument` (13110), `LegalFolder` (13281), `LegalDocumentReader` (13301) [V].
- Readers rule `canReadLegalDocument` (`lecteurs/legal.ts:49`): Super Admin; depositor; designated readers; **no readers ⇒ open to module** (historical default). Additive to entity scoping. `legalViewScope` narrows Finances/BC viewers to purchase-chain kinds (`:153-201`) [V].
- Expiry: `lifecycle.ts` (90 d "soon", 30 d "imminent"), `runLegalExpirySweep` (`expiry-sweep.ts:40-136`) aligns ACTIVE→EXPIRED, claims `lastRemindedAt` atomically, notifies `LEGAL:UPDATE` holders who can read the doc **and** whose company predicate allows it, plus the depositor; link `/legal?echeances=1` [V].
- Document factory: `platform/in-process/artifact/factory.ts` emits quotes/POs/invoices (Word + PDF in Drive + Legal row); emitted fields are locked on the Legal form (`legal/piece-emise.ts:1-16`, §118.194) [V header].

---

## 5. Conventions & house style for this area

1. **Pure rule module + thin server wrapper.** Every rule that both screen and server need lives in an import-free module (`messaging-ui.ts`, `leave-workflow.ts`, `approval-chain.ts`, `reporting-line.ts`, `team-tree.ts`, `lecteurs/legal.ts`, `compression/politique.ts`, `storage/phrases-stockage.ts`, `storage/limites-blob.ts`, `mail/config.ts`, `google/config.ts`, `espace/aujourdhui.ts`). Server modules re-export them. Required by the client-bundle guard (`src/lib/client-bundle-guard.test.ts`; CLAUDE.md "Frontière client / serveur") [V file exists].
2. **One write path, many doors** (§118.5): `refusDepotDrive`/`enregistrerFichierDrive` for both upload paths; `createMailEntryFor` for UI + agents; `envoyerMessageDirect` for screen/assistant/reminders; `involveThirdParty` for all modules. Do not copy the rule into a new route — call the core.
3. **Server re-checks everything** (§118-7): e.g. expense edit window enforced in `updateExpenseClaim`, direct-upload finalisation re-reads rights (`depot-direct.ts:140`), messaging re-reads Drive refs from DB.
4. **Best-effort side effects never fail the business write**: `notifyUser` swallows, `notifyRoles` replays row-by-row; every `createMany` of notifications must be followed by a `catch` calling `rejouerNotifications` (ratchet described in `notifications/ecrire.ts:26-45`).
5. **Role names must be real `UserRole` values** — invented names silence the whole batch (`approval-chain.ts:110-120`, `notify.ts:88-96`).
6. **Inert when unconfigured, and say why**: OnlyOffice (`RAISON_EDITEUR`), Microsoft (`ACCESS_MESSAGE` + missing vars), storage (`refusSansStockageObjet` names the env vars), smart mail, transcription.
7. **Outbound transports call the guard** `exigerSortieAutorisee`/`sortieAutorisee` (`lib/sortie/garde.ts`); a test fails a new transport without it.
8. **Dates**: compute/display in Algiers via `calendar-tz.ts`; store UTC.
9. **Audit** every state change (`recordAudit`), with money changes carrying the old value (expense edit).
10. **French UI strings, explicit refusal messages** (never a bare "Non autorisé" when a reason exists — see `canDecideChain`).
11. After touching client imports: `rm -rf .next && npm run build`, and `npx next lint` (CLAUDE.md; §118.155).

---

## 6. End-to-end flows

### 6.1 HR request: employee « Mon dossier RH » → RH → notification

1. **UI** `/mon-dossier` (`app/(app)/mon-dossier/page.tsx`, `requireUser`) loads `getMyHrDossier(userId)` — employee identity, documents with `visibleToEmployee: true`, own requests + threads (`queries/hr-documents.ts:163-188`) [V]. "Nouvelle demande" (`request-controls.tsx:10,36`) posts a `FormData` to the server action `requestHrDocument` [V].
2. **Action** `requestHrDocument` (`hr-document-actions.ts:199-282`) [V]:
   - resolves `Employee` by `userId` (no employee ⇒ refusal);
   - normalises `type` (unknown ⇒ `WORK_CERTIFICATE`);
   - **leave types** ⇒ `createLeaveFromHrForm` → `createLeaveRequest` (`LeaveRequest`, stage MANAGER/HR) + `attachLeaveFiles` — *no* `HrDocumentRequest` row (`:211`, `:137-160`);
   - `EXPENSE_REPORT` requires `YYYY-MM`, valid amount, ≥1 file; sets `editableUntil`;
   - period types require dates; days computed inclusive;
   - `hrDocumentRequest.create` → `attachRequestFiles` (each file `validateUpload` vs `maxUploadMb`, `saveFile("HR_REQUEST/<id>/<uuid>__name")` → `putBlob`; on storage failure the `Document` row is still created so the missing piece is visible, `:178-196`);
   - `recordAudit` → `notifyRoles(["DIRECTION","SUPER_ADMIN"], …link /rh/demandes?demande=<id>)` (`:263`) → `revalidatePath("/mon-dossier","/rh")`.
3. **Notification fan-out**: `notifyRoles` reads active users holding either role (primary or secondary), `createMany`, Web Push to each subscription (`notify.ts:84-117`) [V].
4. **RH queue** `/rh/demandes` (`requireModule("HR_REQUESTS")`) lists `getHrRequestQueue(perimeter)` — PENDING/IN_PROGRESS, excluding mission orders still gated at the N+1 (`managerGate`), oldest first, take 100 (`queries/hr-documents.ts:212-224`) [V]. Expense notes additionally require the secretariat's `ackExpenseOriginals` from `/demandes` [V].
5. **Processing** (requires `HR_REQUESTS:UPDATE`):
   - document nature → `processHrRequest` (`:584-629`): refuse if mission order still at N+1; update status/hrNote/handledById; `marquerDemandeRhTraitee` (KPI timestamp, once); READY ⇒ legacy annual-leave debit + `synchroniserOrdreEmis`; certificates can be generated/attached (`genererAttestationDeTravail`, `genererOrdreDeMission`);
   - approval nature → `decideHrLeave` (`:680-726`); expense → `decideExpenseReport` (`:631-678`, APPROVE / APPROVE_NEXT month / REJECT).
6. **Employee notification**: `notifyUser({ userId: employee.userId, title, body: status label, link: /mon-dossier#demande-rh-<id> })` (`:612-620`) → in-app row + push; the employee's badge picks it up within 15 s (`/api/notifications/poll`).
7. **Archiving**: `archiveHrRequestIfDone` (`:82-…`) — on READY/DELIVERED/APPROVED/REJECTED, writes a « Demande.txt » summary + attachments into the bureau's Drive "Dossier traité" via `archiveProcessedRequest` (`lib/archive.ts:50`), idempotent via `archivedNodeId` [V].
8. Cancellation by the employee (`annulerDemandeRh`, `:854`) notifies `rolesWithModule("HR_REQUESTS","UPDATE")` (`:881`) [V].

### 6.2 Large file upload to the Drive (browser → presign → bucket → DB → preview)

1. **Limits**: the page hook `use-limites-envoi.ts:18` fetches `/api/uploads/limites` → `{maxUploadMb, maxDriveUploadMb, stockageObjet, seuilDirectOctets (20 MB), maxSansStockageObjetMo}` [V].
2. **Client decision** `envoiDrive(cible, limites)` (`components/drive/envoi-drive.ts:33-62`) [V]: `refus()` pre-refuses by type/size and, if no bucket, above `MAX_DB_UPLOAD_MB`; `direct()` returns a spec only if bucket configured **and** `size ≥ seuilDirectOctets`. Optionally `preflightDrive` hashes the file in the browser and POSTs `/api/drive/upload/claim` — if a visible copy of that SHA-256 exists, the node is created with zero bytes transferred (anti-oracle: requester must already see a copy) (`claim/route.ts:11-30`) [V].
3. **Open** `POST /api/drive/upload/direct` (metadata only) → `getCurrentUserPourEcrire` → `ouvrirDepotDirect` (`depot-direct.ts:52-108`) [V]: bucket required (else 413 naming env vars) → `refusDepotDrive` → `validateDriveUpload` vs `maxDriveUploadMb` → ≤10 GB → quota (`quotaVerdict`: per-user + global capacity from settings) → **resume** an `UPLOADING` `DirectUpload` with same user/fingerprint (`name|size|lastModified`)/canonical target within 7 days via `planDeReprise` (bucket `ListParts` is the source of truth) → else `createMultipartUpload` at key `direct/<userId>/<rand>` and persist `DirectUpload` (`purpose: "DRIVE"`).
4. **Plan**: part size `S3_DIRECT_PART_MB` (32 MB, ≥5 MiB), parallelism `S3_DIRECT_CONCURRENCY` (6, ≤16), one presigned `UploadPart` URL per missing part valid 6 h (`televersement-direct.ts:27-56`) [V].
5. **Browser → bucket**: `envoyerParties` (`envoi-direct-client.ts:113`) PUTs parts in parallel, reports throughput/ETA, collects ETags; expired URL (403) ⇒ `GET /api/drive/upload/direct/<id>` for a fresh plan [V].
6. **Finalize** `POST /api/drive/upload/direct/<id>` (body `{etags}`) → `finaliserDepotDirect` (`depot-direct.ts:128-185`) [V]: re-check rights; CAS `UPLOADING→FINALIZING`; `finaliserEnvoi` lists parts, verifies count/sizes, `CompleteMultipartUpload`, `HEAD` size check; incomplete ⇒ back to UPLOADING with `manquantes`; corrupt ⇒ ABORTED + object deleted. Then `fileBlob.create({ sha256: "direct:<key>", iv: Buffer.alloc(0), storageKey: key, refCount: 1 })` (`:169`) → `enregistrerFichierDrive` (node or new version + shares + audit) → `DirectUpload` COMPLETED with `resultId` (idempotent replay) → `addPhysicalUsage`.
7. **Preview**: `/drive/<id>` → `FileViewer` → `/api/drive/<id>/raw`; because `cleObjetDirect(blobId)` is non-null, `repondreFichier` redirects to a **900 s presigned GET** with `response-content-disposition` inline/attachment (`raw/route.ts:58-75`) [V]. Office formats instead open in OnlyOffice, which fetches via `/api/onlyoffice/file` → `getBlob` → `getObject` **in memory** [V for code path; size risk U].
8. **Cleanup**: abandoned sessions (>7 days) are aborted by `nettoyerDepotsDirectsPerimes`, invoked from `runScheduledJobs` (`scheduled.ts:112`) [V].
   *Small files* (< 20 MB, or any size without bucket up to `MAX_DB_UPLOAD_MB`, and ≤ 2 GB) use `POST /api/drive/upload` (multipart form → `putBlob` → encrypted/compressed/deduped → `enregistrerFichierDrive`, with a timing breakdown returned and logged) (`api/drive/upload/route.ts:15-86`) [V].

### 6.3 OnlyOffice edit/save

`/drive/<id>` builds `sessionEditeur` → config `{document.url: /api/onlyoffice/file?token=<edit JWT>, editorConfig.callbackUrl (edit mode only), token: signJwt(config)}` sent to the browser → DS loads `api.js`, fetches the file server-to-server, user edits → DS POSTs `/api/onlyoffice/callback?id=<node>&token=<edit JWT>` with status 2/6 and a result `url` → route verifies our token (+ body JWT **if present**), `fetch(body.url)`, `putBlob`, creates `FileVersion` n+1, updates node size, audits; for `Document` targets: `saveFile` on same `fileKey`, `version++` (`callback/route.ts:16-80`) [V].

---

## 7. Coupling & blast radius

| Change | Who breaks |
|---|---|
| `drive-storage.ts` (71 non-test importers) or `DRIVE_ENCRYPTION_KEY`/`NEXTAUTH_SECRET` | Every file in the ERP: Drive, Documents/`StoredFile`, messaging uploads, meeting recordings, HR docs, Regulatory CTD, OnlyOffice saves. Key change = all existing blobs undecryptable (except direct-upload objects, which are unencrypted). |
| `storage.ts` (52 importers) | All module attachments (`Document` model), HR request pieces, directives, OnlyOffice `docedit`. |
| `object-storage.ts` / `S3_*` | Bucket writes fail loudly (no DB fallback) → uploads 503; direct uploads unavailable (413) when unset. Existing bucket blobs unreadable if bucket creds removed (DB rows keep `storageKey`). |
| `notify.ts` (107 importers) | Every module's notifications + push. Throwing here would break business writes (callers assume best-effort). |
| `hr/reporting-line.ts` / `departments.ts` (33 importers) | Leave routing, training/recruitment chains, Mon équipe, KPI perimeter, promo-stock visibility, `isManagerOfUser` validations. Changing the cascade changes who decides — tests in `reporting-line`/leave circuit must stay green. |
| `approval-chain.ts` | Both leave (sansDG) and training; editing `chainNotifyRoles` changes who is told at HR/DG steps. |
| `onlyoffice.ts` (31 importers) / `ONLYOFFICE_JWT_SECRET` | Rotating secret invalidates all open sessions and 24 h tokens; mismatch with DS `JWT_SECRET` ⇒ editor fails to load. |
| `messaging.ts`/`/api/messaging/sync` | The sync route is one of only two callers of `runScheduledJobs` besides the heartbeat (`scheduled.ts:95`; regulatory progress route) — removing it slows scheduled tasks on hosts where the heartbeat is suspended. |
| `calendar-tz.ts` (22 importers) | Every displayed date/time and leave day count. Fixed +01:00 — a DST reintroduction in Algeria would require code change. |
| `lecteurs/legal.ts` | Legal list query (`legalReaderWhere`), file route, expiry sweep recipients. |
| Prisma `HrRequestType`/`HrRequestStatus` | `REQUEST_TYPES`/`REQUEST_STATUSES` arrays in `hr-document-actions.ts:43-44`, labels, KPI "demandes traitées", archive. |

---

## 8. Invariants, gotchas, doctrine rules

1. **OnlyOffice callback trusts its URL token only** — no `resolveDriveAccess`/`canAccessEntity` re-check, and if neither body `token` nor `Authorization` is present the body is accepted unsigned (`callback/route.ts:31-38`). Meanwhile `sessionEditeur` mints `makeEditToken`/`makeDocEditToken` **even in view mode** and places it in `document.url` sent to the browser (`onlyoffice-session.ts:72-73,89`). A view-only user can therefore craft `POST /api/onlyoffice/callback?id=<node>&token=<that token>` with `{status:2,url:<any>}` → new version written, and the server fetches an arbitrary URL (SSRF) [V by code reading; not exploited/tested]. Same for `Document` targets (`docId` param). Also tokens live 24 h and are bearer tokens for `/api/onlyoffice/file`.
2. **Direct uploads are not app-encrypted and not deduplicated** (`depot-direct.ts:23-30`, `limites-blob.ts:6-9`); they rely on provider at-rest encryption, and are read via presigned GET (15 min). Any server-side consumer calling `getBlob` on them (`getObject`) loads the whole object in memory — OnlyOffice file route, ZIP export (`entreesDeDrive`), Drive ingestion [U per consumer].
3. **Master-key fallbacks**: `drive-storage.ts:34` falls back to the literal `"amd-internal-os"` when no secret is set; `secret-box.ts:19` to `"dev-secret-box-change-me"`; messaging blob HMAC (`messaging.ts:111-113`) to `"amd-internal-os"`. Production must set `DRIVE_ENCRYPTION_KEY` (and `MAIL_ENCRYPTION_KEY`).
4. **Single-instance assumptions**: typing registry (`messaging-typing.ts`), `runScheduledJobs` debounce/`running` flags (`scheduled.ts:95-99`), notification push VAPID cache, reduction cache. Horizontal scaling would duplicate scheduled work (most jobs claim rows with CAS — e.g. legal sweep `updateMany` on `lastRemindedAt` — but not all) [U for each job].
5. **Scheduler**: in-process heartbeat `SCHEDULER_TICK_MS` (≥15 s, default 60 s), disabled by `SCHEDULER_DISABLED=1`, never in tests/build (`scheduled.ts:76-91`); also piggy-backed on `/api/messaging/sync` [V].
6. **N+1 cascade invariants**: never self; inactive accounts skipped; deputy only for one's own department when the head is absent; Mon équipe ≡ inverse of routing (do not write a department-based team query) [V]. Complexity: `directReportsOf` rebuilds maps per employee → O(n²) per call, O(n³) worst case for `subtreeOf` — fine at current headcount, watch it [V by reading].
7. **`resolveDriveAccess` with `DRIVE` scope ALL grants VIEW on every node, personal Drives included** (`drive.ts:17`) and costs one query per ancestor level [V].
8. **Salary visibility vs edit form**: `/rh/[id]` renders `EmployeeForm` — whose props carry `baseSalary, grossSalary, retSS35, tfp, employerCost, nationalId, cnasNumber, iban` — whenever `EMPLOYEES:UPDATE` (`rh/[id]/page.tsx:32,68-100,203-204`), while the read-only gate is `voitLesSalaires` = `RH:UPDATE|VALIDATE`. Since sub-modules can now be granted independently (06/10), a person with `EMPLOYEES:UPDATE` but not `RH:UPDATE` receives salaries in the RSC payload [V code; U whether any role is configured that way] (§118.184 intent: "Modifier suffit parce que le formulaire porte ces montants" — but on the RH module).
9. **HR request notifications target hard-coded roles**: creation/comment/HR-interview/ack notify `["DIRECTION","SUPER_ADMIN"]` (`hr-document-actions.ts:263,357,490,749,786,834`), whereas the HR step of leaves notifies `DIRECTION, GENERAL_MANAGER, SUPER_ADMIN` and cancellation notifies `rolesWithModule("HR_REQUESTS","UPDATE")` (`:881`). A General Manager or a role granted `HR_REQUESTS:UPDATE` via the console is not told about new requests [V].
10. **`processHrRequest` does not re-check the entity perimeter** (`clauseSalariesVisibles` is applied by the queue page only) nor the current status — any `HR_REQUESTS:UPDATE` holder can move any request id to any of PENDING/IN_PROGRESS/READY/DELIVERED/REJECTED (`hr-document-actions.ts:584-605`) [V].
11. **Expense originals lock**: RH cannot decide before `originalsAckAt` (`:640-645`) — secretariat must act first [V].
12. **Leave from Mon dossier is a `LeaveRequest`**, not an `HrDocumentRequest` (`:207-211`); `processHrRequest`'s READY annual-leave debit is a compat path only [V].
13. **Legal sweep window**: loads `status ∈ {ACTIVE, EXPIRED}` with `endDate ≤ now+90 d`, `orderBy endDate asc`, `take 300` (`expiry-sweep.ts:46-58`). Expired documents never leave that set, so once >300 old EXPIRED documents exist, upcoming expiries are never loaded and reminders stop silently [V code; U actual counts].
14. **Notification dedup in messaging**: one unread notification per conversation (`link` match); mentions bypass (`messaging-actions.ts:352-375`) [V].
15. **Messaging attachments require a server HMAC** (`verifyBlob`) — a client cannot attach an arbitrary `blobId` [V]. Membership, not RBAC, gates reading (Super Admin included) [V].
16. **Directives**: only `SUPER_ADMIN`/`GENERAL_MANAGER` publish (`audience.ts:59`); issuing ≠ publishing [V].
17. **Microsoft mail pilot**: empty `MICROSOFT_MAIL_PILOT` ⇒ Super Admin only (safe default) [V].
18. **Doctrine refs seen in code**: §118.5 (one rule, one place), §118-7 (server guard), §118.16 (never invent), §118.27 (reduction refused unless useful), §118.51/.52 (count what was really written), §118.58/.71 (fix at the choke point), §118.72 (import-ceiling between domains), §118.137 (notification replay), §118.155 (lint before Render build), §118.184 (salary confidentiality), §118.185 (stand-ins), §118.194 (emitted pieces), §118.214 (compression at rest) [V as cited strings].

---

## 9. Docs-vs-code discrepancies

| Doc claim | Code reality |
|---|---|
| `docs/readme/25-stockage…`: « Le bucket ne reçoit **jamais** que du chiffré » | Drive/Documents direct uploads write **plaintext** to the bucket (`depot-direct.ts:23-30`, `iv: Buffer.alloc(0)` `:169`). |
| Same doc: « Les seules URL présignées émises sont des PUT … jamais des URL de lecture » | `/api/drive/[id]/raw` issues a 900 s **presigned GET** for direct blobs (`raw/route.ts:72-74`); `presignGetUrl` exists (`object-storage.ts:101`). |
| Same doc: browser→bucket direct path "pour les dossiers CTD" | Also used by Drive (`/api/drive/upload/direct`) and Documents (`/api/documents/upload/direct`) and messaging lots. |
| Prisma `LeaveStage` comment (`schema.prisma:563-571`): three steps incl. DG; `approval-chain.ts` header "N+1 → RH → DG"; journal p04 "N+1 → RH → DG est prouvé" | Leave is **N+1 → RH** since 06/10 (`leave-workflow.ts:1-3`, `sansDG: true`). Only trainings keep DG (panorama line 68 is right for trainings). |
| `docs/readme/12-…p01.md:1320`: leave types via `requestHrDocument` "exigent periodStart + periodEnd" (implying an `HrDocumentRequest`) | Leave types are forwarded to `createLeaveFromHrForm` → `LeaveRequest`; no HR request row (`hr-document-actions.ts:211`). |
| Schema comment on `Employee` payroll fields: "visibles par le salarié SAUF brut, SS 35 %, TFP" | `getMyHrDossier` returns **no** payroll field to the employee at all (`queries/hr-documents.ts:175-187`); payslips reach them only as `EmployeeDocument` PDFs. |
| `src/app/(app)/courrier/page.tsx` comment: mail "se gère désormais dans l'app Infomaniak" | README §19 and code: replacement is **Microsoft 365** (`/messagerie`). |
| `src/lib/pdf/simple-pdf.ts` header: « Aucune bibliothèque PDF n'est installée » | `pdfkit ^0.20.2` and `mupdf ^1.28.0` are dependencies and used (`payslip/to-pdf.ts`, `compression/reduction.ts`). |
| `docs/readme/23-variables…` | Lists no `MICROSOFT_*`, `GOOGLE_*`, `JITSI_DOMAIN`, `VAPID_SUBJECT`, `S3_DIRECT_*`, `MAX_DB_UPLOAD_MB`, `SCHEDULER_*`, `STT_MODEL` variables that the code reads. |
| README §20 "Inerte tant que les variables ne sont pas posées (aucun bouton « Éditer »)" | Mostly true; but a Drive page for an Office file shows an explicit "not configured" message (`drive/[id]/page.tsx:55-57`) rather than nothing. Minor. |
| `approval-chain.ts:121-127` note "Qui porte réellement la fonction RH : la Direction et le DG" | HR notifications in `hr-document-actions.ts` omit `GENERAL_MANAGER` (see §8.9). Internal inconsistency rather than doc error. |

---

## 10. Verified vs uncertain

**Verified [V]** (read in code, cited above): vault encryption/compression/dedup and fallbacks (`drive-storage.ts:28-37,192-229,336-368`); direct upload engine and Drive session lifecycle (`televersement-direct.ts:27-56`, `depot-direct.ts:52-207`); upload routes and limits route; raw route presigned GET; `resolveDriveAccess` semantics; preview lazy libs; OnlyOffice JWT, tokens, session builder, callback logic (and its missing access re-check / unsigned-body acceptance); HR request creation/processing/decision/notification code paths; leave stage routing and sansDG; training DG step; reporting-line cascade and inverse functions and their consumers; confidentiality gate and `/rh/[id]` form props; action-center block list; directives publisher roles; third-party involvement; Jitsi domain/room helpers; transcription route; messaging send/notify/event, polling intervals, typing registry, HMAC'd attachments; notify/broadcast/replay; VAPID handling; absence of e-mail notifications; Microsoft access locks, scopes, token sealing; Google env; mail register write core; legal readers rule and expiry sweep (incl. take-300 window); scheduler wiring.

**Uncertain [U]**:
- Whether any production role actually has `EMPLOYEES:UPDATE` without `RH:UPDATE` (salary leak exposure, §8.8).
- Real exploitability of the OnlyOffice callback (depends on DS network placement; code path itself is verified) — recommend: verify body JWT mandatory, re-check EDIT at save, allowlist `body.url` host to `ONLYOFFICE_URL`, mint view tokens with a distinct `kind`.
- Which server-side consumers call `getBlob` on multi-GB direct objects (memory blow-up).
- `hrNature`, `files/politique-televersement.ts`, `grantDriveRefAccess`, `events/ledger.ts` internals (not read line by line).
- Whether Drive ingestion OCRs scanned PDFs.
- Multi-instance safety of every scheduled job.
- Count of `EXPIRED` legal documents in production (sweep starvation).
- Recruitment action internals beyond the pure flow header (1,265-line action file only skimmed).
