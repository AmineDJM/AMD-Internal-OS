# 10 — Infrastructure, build, deployment, scheduled jobs, testing & dev workflow

> Knowledge-base page. Written from the code and config at HEAD `41b2ef0` (branch
> `claude/magical-cray-1v5ld6`, shallow clone, 2026-10-24). Tags: **[V]** = verified by reading
> the cited file/line; **[U]** = inferred or not checked end-to-end.

---

## 1. Scope

This page covers everything around the application code: how it is built and deployed to Render
(`render.yaml`, `next.config.mjs`, `package.json` scripts, `tsconfig*.json`, `.eslintrc.json`,
`.npmrc`), how background work runs without a cron (`src/lib/scheduled.ts`), the full
environment-variable inventory, the test architecture (Vitest unit + DB-backed integration
suites, source-scanning "guard/ratchet" tests, Playwright E2E and live benches, the RBAC
auto-tester, measurement benches), observability, and the developer workflow (Graphify, README
refresh, migrations). It also identifies the legacy/odd folders at the repo root (`audit/`,
`data/`, `streamlit_app/`, `.streamlit/`, `docs/wip/*.patch`, `public/`).

Out of scope: business logic of the individual jobs (each domain page covers it), RBAC semantics
(see the security page), the Prisma data model itself.

---

## 2. Summary

- **Deploy**: a single Render *free* web service (`next start`) + a free managed Postgres, from a
  Blueprint (`render.yaml:15-53`). There is **no CI** (no `.github/`, no other CI config); the
  "gate" is the developer running `typecheck → build → test → next lint` locally, plus Render's
  own build failing.
- **Build memory** is the dominant infra concern: Render kills builds at 8 GB (processes + workspace
  files). `next.config.mjs` caps workers (`cpus: 1`), disables server minification and per-page file tracing (Next 15: by removing
  `TraceEntryPointsPlugin` from the server compiler — the `outputFileTracing` option is gone),
  shrinks the webpack cache and, **when `RENDER` is set, runs `tsc` in its own 5 GB process** before
  compiling — because (doctrine §118.208) the Render dashboard command overrides `render.yaml`.
  **Since Next 15 (V3-A, 2026-10-28)** the compile heap is **3584 MB** (`TAS_DU_BUILD_MO`): Next 15's
  server compile dies at 3072. Clean-build peaks (RENDER=1): Next 14 @3072 = 4542 MB; Next 15 @3584 =
  5150 MB; @4096 = 5612 MB.
- **Background jobs**: no external cron, no `instrumentation.ts`. `src/lib/scheduled.ts` arms an
  in-process `setInterval` (60 s) **the first time the module is imported** — in practice the first
  `GET /api/messaging/sync` poll by a logged-in browser — and runs ~48 sequential, idempotent,
  DB-gated sweeps (meeting reminders at T-30 min, reminders, payroll, regulatory jobs, site-web
  queue + daily reconciliation, durable missions, Gmail sweep…).
  **Since V2-F** the sweeps are a task table with a per-task DB lease, runnable by the web (default) or by a
  separate `npm run worker` process (`TACHES_DE_FOND=web|worker|les-deux`) — see §4.5.
- **Tests**: 1,222 `*.test.ts` files (~14,260 `it/test` calls). ~457 import Prisma; 397 use the
  `dbOk ? describe : describe.skip` idiom (skip silently without Postgres). `src/lib/prisma.ts`
  **throws at import** if a test/bench process points at a non-local DB (§118.90). ~66 test files
  scan the source tree as architectural guards/ratchets (client-bundle guard, boundary budget,
  reachability, lint directives, use-server exports, dead links…).
- **E2E**: 40 Playwright specs (312 tests) against `next start` on port 3100 with outbound effects
  disabled (`ADAM_SORTIE_INTERDITE=1`), plus one live spec (`e2e-live/`, real model provider, local
  `amd_bench` DB only).
- **Observability** is home-grown: `console.*` to Render logs, DB-persisted audit/usage tables
  (`AuditLog`, `ActivityLog`, `ModelCallLog`, `AiHealthCheck`), session replay, an in-app "Test
  Center", and read-only diagnostic CLIs (`adam:doctor`, `storage:check`). No APM/Sentry/metrics
  endpoint; Render's health check hits `/login`.
- **Notable finding**: `middleware.ts` sits at the **repo root** while the app lives in `src/app`;
  Next (14.2 and 15.5) only looks for middleware next to the `app` dir's parent (`src/`), so the edge auth
  middleware is very likely **not compiled at all** (details §8, §9).

---

## 3. Key files

| Path | Role |
|---|---|
| `render.yaml` | Render Blueprint: free Postgres `amd-postgres`, free web service, build/start commands, env vars, health check `/login`. |
| `next.config.mjs` | Build-memory controls, separate typecheck on Render, heap cap for build workers, security headers, server-external packages, 256 MB server-action body. |
| `package.json` | ~60 scripts (build, test, db, graphify, autotest, ~25 benches). Node deps pinned for Next 15.5.28 + React 19.2 / Prisma 5.22 / Vitest 2.1.9 / Playwright 1.62. `overrides`: `postcss` (Next pins a vulnerable 8.4.31) and `image-size` (declared, never loaded, by pptxgenjs). `xlsx` comes from the SheetJS CDN tarball (npm is no longer published). |
| `tsconfig.json` / `tsconfig.build.json` | Full typecheck (`**/*.ts`, incl. tests, scripts, e2e) vs production-only typecheck (`src/**`, tests excluded, non-incremental). |
| `.eslintrc.json` | `next/core-web-vitals` + 3 rules off. Lint only covers `src/` (Next default dirs). |
| `.npmrc` | `legacy-peer-deps=true` (imapflow → nodemailer 9 vs next-auth's optional peer nodemailer 6). |
| `vitest.config.ts` | `src/**/*.test.ts`, node env, inline `next-auth`/`@auth`, `testTimeout 20s`, `hookTimeout 120s`, global setup. |
| `vitest.global-setup.ts` | Upserts a permanent "Siège DG" test user (createdAt 2000-01-01) so validation-centre routing is deterministic (§118.148). |
| `src/lib/prisma.ts` | Prisma singleton; **local-DB guard** for tests/benches (`refusDeBase`, line 93-122); production pool `connection_limit=12`. |
| `src/lib/sortie/garde.ts` | Outbound "kill switch": refuses push/mail/site-web transport in tests, Playwright, benches or when `ADAM_SORTIE_INTERDITE=1`. |
| `src/lib/scheduled.ts` | The scheduler: web heartbeat + `runScheduledJobs()` (web wake-up) + the task table `TACHES_PLANIFIEES` (one entry per sweep) run by `executerTachesPlanifiees()` — shared by web and worker (V2-F). |
| `src/lib/taches-de-fond/` | V2-F: switch `mode.ts` (`TACHES_DE_FOND`, pure), per-task DB lease `bail.ts` (table `TacheDeFond`), runner `executer.ts` (lease, renewal, duration, outcome, JSON log), worker loop `worker.ts`, migration wait `migrations.ts`, health `sante.ts`, V2-A slot `enrichissement.ts`. |
| `scripts/worker.ts` | `npm run worker` entry point (tsx): declares the process as worker, SIGTERM/SIGINT → clean stop (25 s grace), runs the same task table. |
| `scripts/conversions/` + `src/lib/office/conversions-haute-fidelite.ts` | Decision 0019: the high-fidelity conversion engine (Python, pinned `requirements.txt`, venv `/opt/conversions` in the worker image): pdf2docx + PyMuPDF patched (logical bidi order from glyph geometry, targeted NFKC, harakat, intended line breaks, headers/footers), DOCX post-processing (`w:bidi`/`w:rtl`/`w:cs`, lists, RTL tables), two-pass tesseract OCR (`tessdata_best` 4.1.0, sha256-checked) composed into Word, LibreOffice Office → PDF, PDF → XLSX, image → PDF/DOCX, PPTX → PNG zip. CLI `convertir.py` (one JSON line); `--verifier` lists missing pieces. Bench `npm run conversions:bench` on the versioned corpus (`scripts/conversions/corpus/`, `attendu.json`), metrics `src/lib/office/conversions-mesure.ts`. |
| `src/app/api/health/worker/route.ts` | Background-task health: 200 if a task started < 5 min ago, else 503; holder/error detail for Super Admin only. |
| `src/lib/scheduler/runner.ts` | User-defined *workflow* schedules (atomic claim, `WORKFLOW_SCHEDULER=off`). |
| `src/app/api/messaging/sync/route.ts` | The hot route (polled every 12 s by each client) that imports `scheduled.ts` and kicks `runScheduledJobs()`. |
| `playwright.config.ts` / `playwright.live.config.ts` | E2E on :3100 (no AI) / live bench on :3101 (real provider, local DB enforced). |
| `e2e/global-setup.ts`, `e2e/global-teardown.ts` | Seed/cleanup of `__e2e__`-prefixed users, invitations, Drive files. |
| `scripts/` (68 files) | Bench harnesses, auto-tester, UI audit crawler, Graphify wrappers, diagnostics, generators. |
| `scripts/build-memory.sh` | `npm run build:measure`: clean build, samples RSS of node process tree, fails above `BUILD_MEM_LIMIT_MB` (default 4200). |
| `scripts/graphify-refresh.sh` / `graphify-query.sh` | Graph refresh (temporarily moves `aiguillage.genere.ts` out; refuses if a `next build` is running) / query wrapper. |
| `scripts/proxy-dispatcher.cjs` | `--require` preload for benches only: routes Node `fetch` through `HTTPS_PROXY` (§118.84). |
| `scripts/adam-doctor.ts`, `scripts/storage-status.ts` | Read-only production diagnostics, print variable *names* never values. |
| `scripts/actions-contrat.ts` | Generates `src/lib/actions/contrat.genere.{ts,json}` + `aiguillage.genere.ts` (server-action contract & dispatch table). |
| `prisma/bootstrap.ts` | Idempotent creation of the first Super Admin from `ADMIN_*`. |
| `public/sw.js`, `public/manifest.webmanifest` | PWA: push + notificationclick only (no fetch/offline caching). |
| `src/lib/client-bundle-guard.test.ts` | Walks import graph from every `"use client"` file; fails on reach to `fs`/`net`/Node-only packages. |
| `src/lib/lint-directives.test.ts` | Fails if an `eslint-disable` names a rule that the computed ESLint config doesn't load (§118.155). |
| `src/platform/boundary.test.ts`, `domains.test.ts`, `qualite-code.test.ts`, `decors-de-test.test.ts` | Architecture ratchets (debt ceilings, cycles, dead code and duplicates via knip/jscpd, fixture round-trip budget). |

---

## 4. How it works

### 4.1 Render deployment

- Blueprint provisions `amd-postgres` (free) and `amd-internal-os` (node runtime, free plan,
  `healthCheckPath: /login`) — `render.yaml:15-25` [V].
- `buildCommand` (`render.yaml:52`) [V]:
  `npm install && npx prisma generate && npm run build:render && npx prisma migrate deploy && npm run db:bootstrap`
  (order changed 2026-10-27, refonte P0 — `docs/architecture/refonte-p0-outillage.md` §2: lint, tsc and
  `next build` run **before** any DB write; `next build` was measured to need no DB). Migrations are
  still applied **during the build**, before the new code serves traffic; a failing migration fails the deploy.
- `startCommand: npx next start -p $PORT` (`render.yaml:53`) [V]. Full repo + `node_modules` on
  disk, which is why file tracing (`.nft.json`) is disabled (`next.config.mjs:104`) [V].
- Env in the Blueprint (`render.yaml:54-111`) [V]: `DATABASE_URL` from DB, `AUTH_SECRET`
  generated, `AUTH_TRUST_HOST=true`, `NODE_VERSION=22`, upload limits (`MAX_UPLOAD_MB=200`,
  `MAX_DRIVE_UPLOAD_MB=1024`, `MAX_DB_UPLOAD_MB=100`), `S3_*` (sync:false), `ADMIN_*`, `VAPID_*`,
  `ADVENTUM_*`. **No `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`MISTRAL_API_KEY`/`GOOGLE_*` entries** —
  AI and integrations must be added manually in the dashboard [V].
- Header comment tells operators to deploy branch `claude/hopeful-goodall-phd0nb` (`render.yaml:6`)
  [V]; §118.208 records that this branch "ne portait de toute façon aucun de nos commits" at one
  point — which branch Render actually tracks today is not determinable from the repo [U].
- **The dashboard command overrides `render.yaml`** (§118.208, `docs/claude-md/08-versionnement-graphify-p06.md:1`):
  Render logs showed a bare `npx next build`. Every memory/typecheck protection was therefore moved
  into `next.config.mjs`, which runs whatever command invokes `next build` [V for the code; U for
  what the dashboard currently runs].

### 4.2 `next.config.mjs` — build-time behaviour

Exported as a **phase function** (`next.config.mjs:191-196`) [V]:

1. `typecheckSepare(phase)` (`:19-34`): if `TYPECHECK_SEPARE=1` → already done, return true. Else,
   only in `phase-production-build` **and** when `process.env.RENDER` is set, spawn
   `node --max-old-space-size=5120 typescript/bin/tsc --noEmit -p tsconfig.build.json`; any error
   throws and aborts the build; then sets `TYPECHECK_SEPARE=1` so child processes skip it. The
   return value becomes `typescript.ignoreBuildErrors` (true only when the separate tsc ran).
   → Locally (`RENDER` unset) `next build` keeps its **integrated** typecheck, which uses
   `tsconfig.json` (includes tests/scripts/e2e).
2. `plafondDuBuild(phase)` (`:184-189`): during the production-build phase, if `NODE_OPTIONS` has no
   `--max-old-space-size`, append `--max-old-space-size=3072`; build workers inherit it.
3. Static config:
   - `eslint.ignoreDuringBuilds: true` (`:44`) — lint is **never** run by `next build`.
   - `experimental.cpus: 1` (`:70`) — one static-generation worker (~1.7 GB each, measured 10/2026).
   - `webpackBuildWorker: true`, `webpackMemoryOptimizations: true` (Next 15), `serverMinification: false`.
   - `serverExternalPackages` (top-level since Next 15): `bcryptjs, imapflow, nodemailer, mailparser,
     pdf-parse, mammoth, xlsx, tesseract.js, mupdf, sharp, docxtemplater, pizzip, pdfkit,
     @mastra/core` (pdfkit must stay external so its `.afm` font files resolve at runtime).
   - `serverActions.bodySizeLimit: "256mb"` (`:95`) — real limit enforced by `AppSetting`/
     `validateUpload`.
   - No `outputFileTracing` (removed by Next 15): the `webpack()` hook drops `TraceEntryPointsPlugin`
     from the production server compiler instead (−~250 MB peak, −33 s, measured 2026-10-28).
   - `webpack()` hook: `cache.maxMemoryGenerations = 1`; gzip cache compression when `RENDER` set.
   - `TAS_DU_BUILD_MO = 3584`: heap cap injected into build workers when no cap is set.
   - `headers()` (`:128-170`): CSP limited to `frame-ancestors 'self'; object-src 'none';
     base-uri 'self'; form-action 'self'; upgrade-insecure-requests` (no script/style/connect
     restrictions on purpose — OnlyOffice, inline Next scripts, blob: previews), plus
     `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`
     (camera/microphone/geolocation = self), HSTS 2 years + preload, COOP same-origin.
   - `reactStrictMode: true`, `poweredByHeader: false`.

### 4.3 `package.json` scripts — grouped

| Group | Scripts | Notes |
|---|---|---|
| App lifecycle | `dev`, `build` (`prisma generate && next build`), `start`, `build:render`, `build:measure` | `build:render` (`package.json:9`) = three **separate processes**: `next lint` (3 GB heap) → `tsc -p tsconfig.build.json` (5 GB) → `TYPECHECK_SEPARE=1 next build` (3 GB). Separate because ESLint (~1 GB) + typecheck in one heap OOM'd at Node's 2 GB default (comment `next.config.mjs:36-43`). `build:render` does **not** run `prisma generate` (Render's buildCommand does). |
| Quality gates | `typecheck` (`tsc --noEmit`, whole repo), `lint` (`next lint`), `test` (`vitest run` with `DATABASE_URL=${TEST_DATABASE_URL:-postgresql://amd:amd@localhost:5432/amd_internal_os}`), `test:e2e`, `test:e2e:live`, `evals:report` | `npm test` **overrides** any `.env` `DATABASE_URL`. |
| Database | `db:generate`, `db:push`, `db:migrate`, `db:deploy`, `db:bootstrap`, `db:reset` | House rule: write SQL migrations by hand, apply with `db:deploy`. `db:push` / `db:migrate` exist but contradict that rule. |
| Code map | `graphify:refresh`, `graphify:report`, `graphify:query` | Python CLI `graphifyy` auto-installed with `pip --user`. |
| Audits / diagnostics | `autotest`, `autotest:live`, `audit:reachability`, `adam:boundary`, `adam:doctor`, `storage:check`, `factures:doublons` | All read-only except `autotest:live --seed` (creates & deletes throwaway accounts). |
| Generators / migrations of data | `actions:contrat`, `blobs:migrate-r2` | `actions:contrat` must be rerun when server actions change (guarded by `contrat.test.ts:218-223`). |
| AI smoke | `adam:smoke:provider`, `adam:smoke:deep` | Real provider, cost money. |
| Benches (~25) | `office:bench`, `office:sabotage`, `sheets:bench`, `factory:bench`, `fabric:bench`, `adam:bench*`, `autonomy:bench*`, `bench:plan|latence|ab|intentions|chaine|horizon|live|smoke|site-web`, `sonde:conversation` | Almost all prefix `NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs"` and `DATABASE_URL=${BENCH_DATABASE_URL:-…/amd_bench}`. |

### 4.4 TypeScript, lint, npm config

- `tsconfig.json`: strict, `moduleResolution: bundler`, alias `@/* → ./src/*`, `include: ["**/*.ts",
  "**/*.tsx", …]` → `npm run typecheck` checks `src/`, tests, `scripts/`, `e2e/`, `prisma/`,
  `vitest*.ts` [V].
- `tsconfig.build.json`: extends, `incremental: false`, only `src/**` + `.next/types`, excludes
  `*.test.ts(x)` / `*.spec.ts(x)` [V]. Used by the Render-side tsc (≈3.7 GB instead of 4.7 GB,
  §118.208).
- `.eslintrc.json`: `next/core-web-vitals`; off: `@next/next/no-assign-module-variable`,
  `react/no-unescaped-entities`, `@typescript-eslint/no-explicit-any` [V]. Note the
  `@typescript-eslint` plugin is **not loaded** by `core-web-vitals`; an `eslint-disable` naming one of
  its rules is a hard ESLint error ("Definition for rule … was not found") — the §118.155 incident,
  now caught by `src/lib/lint-directives.test.ts`.
- `.npmrc`: `legacy-peer-deps=true` [V].

### 4.5 Background / scheduled work

> **Updated 2026-10-27 (refonte V2-F, worker séparé)** [V: code of this lot]. Two possible executors, chosen by
> `TACHES_DE_FOND` (`src/lib/taches-de-fond/mode.ts`, pure): `web` (default — unchanged production behaviour),
> `worker` (only `npm run worker` runs the tasks; the web heartbeat is not armed and `runScheduledJobs()` is a no-op),
> `les-deux` (both run; per-task lease decides). Unknown value → `web` (never silence). Both executors run the SAME
> table `TACHES_PLANIFIEES` (`scheduled.ts`) through `executerPassage` (`taches-de-fond/executer.ts`):
> - **Per-task lease** in table `TacheDeFond` (`bail.ts`): atomic `updateMany` claim when (no lease OR lease expired
>   OR own) AND last start ≥ `INTERVALLE_MIN_MS` (45 s) ago. Lease `BAIL_TACHE_MS` = 120 s, renewed every 40 s while
>   the task runs, released with outcome (`OK`/`ECHEC`/`IGNOREE`), duration, message, counters. Expired lease = dead
>   process → retaken (crash recovery). Not an advisory lock: Prisma pools connections, a session lock would be taken
>   and released on different connections. Proven by `taches-de-fond/bail.test.ts` (2 and 8 concurrent claimants →
>   1 run; two concurrent passes share the table).
> - **Failure isolation**: a throwing task is counted `ECHEC` and the pass continues (before V2-F five steps without
>   `.catch` aborted the whole pass; ~20 swallowed errors silently).
> - **Worker** (`scripts/worker.ts` → `taches-de-fond/worker.ts`): declares itself before importing `scheduled.ts`
>   (otherwise the module-load web heartbeat would arm), waits until `_prisma_migrations` contains every migration of
>   its checkout (`migrations.ts` — only the web build migrates, P0 order), one pass at start then every `TICK_MS`
>   start-to-start, SIGTERM → stop between tasks, 25 s grace then exit 1 (lease expires by itself). Under `web` mode or
>   `SCHEDULER_DISABLED=1` it idles (no restart loop).
> - **Logs**: JSON lines `{"source":"taches-de-fond", "evenement": …}` — `passage.fin` (per-task `durees`),
>   `tache.echec`, `tache.lente` (≥ 2 s), `tache.bail-perdu`, `worker.*`.
> - **Health**: `/api/health/worker` and the "Tâches de fond" card of Admin › Diagnostic (`lireSanteTachesDeFond`).
> - **Render**: commented `amd-worker` block in `render.yaml` (paid plan, build `npm install && npx prisma generate`,
>   start `npm run worker`, same env incl. identical `AUTH_SECRET` and explicit `APP_URL`). Activation procedure:
>   `docs/readme/24-deploiement-render.md`.
> - **V2-A hook**: task `enrichissement.file` → `taches-de-fond/enrichissement.ts`, returns `ignoree(...)` until V2-A
>   replaces its body with `traiterLaFile({ max: LOT_FILE_ENRICHISSEMENT })`.
>
> The description below (written 2026-10-24) remains accurate for the `web` mode, except: the heartbeat lives in
> `armHeartbeat()` gated by `battementWebArme()`; the list of steps is now the table, with stable keys
> (`rappels.reunions`, `missions.balayage`…); the in-process `running`/debounce flag only prevents a process from
> overlapping itself — cross-process exclusivity is the lease.

There is **no `instrumentation.ts`, no `/api/cron` route, no external cron** [V:
`ls src` and `ls src/app/api`]; a worker entry point exists since V2-F but is opt-in. Everything periodic goes through `src/lib/scheduled.ts`:

- **Heartbeat** (`scheduled.ts:78-92`) [V]: `TICK_MS = max(15 s, SCHEDULER_TICK_MS ?? 60 s)`;
  `armHeartbeat()` runs at module load; skipped when `SCHEDULER_DISABLED=1`, under Vitest /
  `NODE_ENV=test`, or `NEXT_PHASE=phase-production-build`; `setInterval(...).unref()`.
  The comment explains why not `instrumentation.ts`: it is also compiled for the Edge runtime where
  the server chain (IMAP, HTTP agents) does not resolve.
- **Who imports it**: statically only `src/app/api/messaging/sync/route.ts:6` (which also calls
  `void runScheduledJobs()` on each poll, `:17`), dynamically
  `src/app/api/regulatory/intelligence/progress/[versionId]/route.ts:35`. Next loads route modules
  lazily, so **the heartbeat starts at the first such request after boot** — normally the 12-second
  poll from `src/components/layout/messages-indicator.tsx:155-167` of any logged-in user [V]. The
  Render health check (`/login`) does not import it [V: login page imports only its form].
- **Debounce/lock** (`scheduled.ts:52-54, 95-101`) [V]: process-wide `running` flag + 60 s
  `DEBOUNCE_MS`; manual triggers and the heartbeat share it.
- **Order of work** (`scheduled.ts:102-270`, 48 awaited steps) [V], all serial:
  1. `sendDueMeetingReminders` (`:385`) — meetings `SCHEDULED`, `reminderSentAt null`, starting in
     ≤ 30 min (`REMINDER_LEAD_MS`, `:379`); claim with `updateMany where reminderSentAt null`, then
     `notifyUser` (bell + push) to organizer and participants.
  2. `sendDueReminders` (`:331`) — `Reminder` PENDING with `remindAt ≤ now`, claimed PENDING→SENT.
  3. `sendDuePayrollNotifications` (`:353`) — "votre salaire a été versé", ≥24 h after entry and
     only once the transfer is settled (§118.176).
  4. Leave accrual (+2.5 days/month, idempotent marker), product-per-dossier backfill, daily AI
     health check, **regulatory job runner** (`runDueRegulatoryJobs`, budget `REG_JOBS_BUDGET_MS`
     default 120 s), upload-session cleanup, ANPP watch (daily), AI batch polling, catch-ups,
     embeddings backlog, hourly Intelligence Pulse, 07:00 Algiers brain briefing, petty-cash
     reminders (48 h before), legal expiry sweep, stock recurrences / reception reminders /
     recurring counts / stock alerts (§118.164, §118.168), PCH deadlines, SFE sweep, KPI refresh,
     influence graph, assistant reminders, Drive ingestion, fabric mentions, hot alerts, data-quality
     sweep, Legal clause cache.
  5. **Site public** (§118.158-160, `:197-201`): `entretenirLiaison` → `viderFile` (outbound queue)
     → `rapprocherSiteSiDu` → audience purge (13 months).
     `rapprocherSiteSiDu` (`src/lib/site-web/reconciliation.ts:389-410`): off if
     `SITE_WEB_RECONCILIATION=off`, silent unless the site link is configured; runs once per
     24 h after a successful run (`INTERVALLE_RAPPROCHEMENT_MS`, `:50`), hourly retry after failure or
     until the site's repository has been read once (`REESSAI_RAPPROCHEMENT_MS`, `:52`).
  6. Knowledge layer (entity index, backlogs, stalled docs), **user workflow schedules**
     (`registerBuiltinWorkflows()` + `runScheduledWorkflows()`, `scheduler/runner.ts:51+`, batch 3,
     atomic claim on `claimedAt null`, `nextRunAt` advanced at claim), knowledge sweep.
  7. Adam Gmail sweep (watch renewal, incremental history, full reconcile every 30 min).
  8. **Durable missions** `balayerMissions` (`MISSIONS_SWEEP=off` to disable;
     `src/platform/in-process/missions/sweep.ts:246-248`, lease-based, 90 s expiry) and watches
     `balayerSurveillances`, memory ageing, commitment follow-ups.
- **Cadence lives in the DB, not in the timer**: each "…SiDu"/"…IfDue" function reads its last run
  row (e.g. `siteReconciliation`, `intelligenceSnapshot` bucket with `skipDuplicates`,
  `aiHealthCheck`), so restarts don't re-fire daily jobs and multiple instances don't double-run [V
  for the three cited; U for every job].
- Other in-process timers: site-web queue short retries via `setTimeout` (`src/lib/site-web/file.ts:245`,
  guarded by `NEXT_PHASE`/`VITEST`), upload-session heartbeat (`regulatory/intelligence/upload/session.ts:339`),
  model-usage sink flushing every 1.5 s (`src/platform/in-process/telemetry/usage-sink.ts`) [V].

### 4.6 Database connection & test-DB guard

- `refusDeBase()` (`src/lib/prisma.ts:93-122`) [V] runs **at import**: if the process is a test
  (`NODE_ENV=test` or `VITEST`) the DB host must be `localhost/127.0.0.1/::1`; if it is a bench
  (entry script path matches `scripts/bench/`, via `estUnBancDeMesure` in `sortie/garde.ts:118-124`)
  the host must be local **and** the DB name must contain `bench`. Otherwise it throws a French
  error naming the remedy. Rationale §118.90: the default `DATABASE_URL` used to be Adventum's
  production and the suite seeds rows.
- Pool (`prisma.ts:147-177`) [V]: in production `connection_limit=12` appended unless already in the
  URL; `DB_CONNECTION_LIMIT` overrides everywhere; `DB_POOL_TIMEOUT` optional; dev keeps a
  `globalThis` singleton; logs `error`(+`warn` in dev).

### 4.7 Outbound kill switch (tests, E2E, benches)

`sortiesInterdites()` (`src/lib/sortie/garde.ts:126-139`) [V] returns true when
`ADAM_SORTIE_INTERDITE=1`, `NODE_ENV=test`, `VITEST`, `PLAYWRIGHT`, `PLAYWRIGHT_TEST_BASE_URL`, or the
process is a bench — unless `ADAM_SORTIE_AUTORISEE=1`. Callers: `src/lib/push.ts:96`,
`src/lib/mail.ts`, `src/lib/mail-smart.ts`, `src/lib/mail/graph/provider.ts`,
`src/lib/site-web/transport.ts` [V]. Playwright configs set `ADAM_SORTIE_INTERDITE=1` on the
`next start` they launch because `PLAYWRIGHT` doesn't cross the process boundary
(`playwright.config.ts:45-51`).

### 4.8 Environment-variable inventory

Method: `rg` for `process.env.X`, `process.env["X"]`, `env.X` (functions taking
`env = process.env`), and helper calls `env("X")`/`num("X")` across `src/`, `scripts/`, `prisma/`
(non-test). ~200 distinct names. Templated families exist: `ADAM_MODEL_<ROLE>`,
`ADAM_REASONING_<ROLE>`, `ADAM_PRICE_<ROLE>_{IN,OUT,CACHED_IN}` (`src/lib/models/registry.ts:116-199`),
`ADAM_MISSION_ROLE_<METIER>` (`platform/in-process/missions/reasoner.ts:67`), `S3_<X>` with legacy
`REG_S3_<X>` fallback (`src/lib/storage/s3-config.ts:44-48`), `EVENTS_WEBHOOK_SECRET[_<SOURCE>]`
(`platform/in-process/events/ingestion.ts:83`). In `.env.example`: E; in readme 23: R; in render.yaml: Y.

**Core / platform**

| Var | Read in | Purpose | Req? | When unset |
|---|---|---|---|---|
| `DATABASE_URL` (E,R,Y) | `prisma/schema.prisma:19`, `src/lib/prisma.ts` | Postgres | Required | Prisma fails; tests skip (`dbOk`) |
| `AUTH_SECRET` (E,R,Y) / `NEXTAUTH_SECRET` | Auth.js; `crypto/secret-box.ts:14-20`; `drive-storage.ts:28-36` | JWT signing + key derivation | Required | secret-box falls back to `"dev-secret-box-change-me"`; Drive key to `"amd-internal-os"` — **insecure defaults** |
| `AUTH_TRUST_HOST` (R,Y) | Auth.js | proxy trust | Prod | `auth.config.ts` already sets `trustHost: true` |
| `NEXTAUTH_URL` / `AUTH_URL` / `APP_URL` / `RENDER_EXTERNAL_URL` | `meetings.ts:47`, `onlyoffice.ts:29`, `site-web/cles.ts:95-97`, Google/MS OAuth callbacks | public base URL | Optional* | each caller has its own fallback chain |
| `NODE_ENV`, `NEXT_PHASE`, `VITEST` | prisma, scheduler, site-web file | runtime mode | — | — |
| `RENDER`, `RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH`, `GIT_COMMIT`, `GIT_BRANCH`, `STAGING`, `TEST_CENTER_ENV` | `next.config.mjs`, `test-center/guard.ts:8-15`, `test-center/runner.ts:27-28` | Render detection; Test Center env (production ⇒ write modes need confirmation + phrase) | Auto | development mode assumed |
| `TYPECHECK_SEPARE`, `NODE_OPTIONS` | `next.config.mjs` | build plumbing | — | — |
| `DB_CONNECTION_LIMIT`, `DB_POOL_TIMEOUT` (R) | `prisma.ts:149-155` | pool | Opt | 12 in prod, Prisma default elsewhere |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` (R,Y) | `prisma/bootstrap.ts:13-15` | first Super Admin | Required at first deploy | **defaults `admin@adventum.dz` / `ChangeMe123!`** with `mustChangePassword=true` |

**Storage & uploads**

| Var | Read in | Purpose | When unset |
|---|---|---|---|
| `S3_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` (E,R,Y), `S3_REGION` (E,R,Y; default `auto`), `S3_FORCE_PATH_STYLE` (R; default true), `S3_DISABLED` (R) | `storage/s3-config.ts:44-190` | object storage | Files stay in Postgres; > `MAX_DB_UPLOAD_MB` refused |
| `REG_S3_*` (legacy, R) | same, fallback | old names | — |
| `S3_DIRECT_THRESHOLD_MB`, `S3_DIRECT_PART_MB`, `S3_DIRECT_CONCURRENCY`, `S3_UPLOAD_CONCURRENCY` | `storage/televersement-direct.ts:27-36`, `object-storage.ts:232` | browser→bucket multipart tuning | defaults |
| `MAX_UPLOAD_MB` (E,R,Y), `MAX_DRIVE_UPLOAD_MB` (Y), `MAX_DB_UPLOAD_MB` (E,Y) | `settings.ts:111-112`, `storage.ts:77`, `storage/phrases-stockage.ts:26` | default limits (DB `AppSetting` wins) | built-in defaults; `.env.example` says 25 vs Render 200 |
| `DRIVE_ENCRYPTION_KEY` (R) | `drive-storage.ts:29`, `secret-box.ts:16` | AES-256-GCM master key | derived from `NEXTAUTH_SECRET ?? AUTH_SECRET` |
| `REG_UPLOAD_*` (PART_MB, SMALL_MB, CONCURRENCY, MAX_ACTIVE, STALE_HOURS, REAP_MIN, FINALIZE_LEASE_MIN), `REG_ORG_QUOTA_GB`, `REG_MAX_PG_FILE_MB`, `REG_MAX_PG_BLOB_MB`, `REG_BLOB_CHUNK_MB`, `REG_INGEST_STORE_CONCURRENCY`, `REG_ZIP_MAX_*` (6) | `regulatory/intelligence/upload/session.ts:55-76`, `ingest/ingest-dossier.ts:47-58`, `ingest/zip-inspector.ts:40-45`, `drive-storage.ts:99` | CTD upload/ingest tuning, zip-bomb limits | defaults |

**AI / models / voice**

| Var | Read in | Purpose | When unset |
|---|---|---|---|
| `OPENAI_API_KEY` (R), `OPENAI_BASE_URL` (R) | `models/*`, `ai.ts:332`, `media/stt.ts:60`, `openai-luna.ts` | **default provider** (`ADAM_MODEL_PROVIDER` ≠ `anthropic` ⇒ OpenAI, `registry.ts:137`) | AI features refuse cleanly ("clé non configurée") |
| `ANTHROPIC_API_KEY` (R), `ANTHROPIC_BASE_URL` | `models/anthropic.ts:133-236` | only if `ADAM_MODEL_PROVIDER=anthropic` | — |
| `ADAM_MODEL_PROVIDER`, `ADAM_MODEL_<ROLE>` (realtime/orchestrator/worker/bulk; defaults `gpt-realtime-2.1`, `gpt-5.6-terra`×2, `gpt-5.6-luna`, `registry.ts:45-48`), `ADAM_REASONING_<ROLE>`, `ADAM_REASONING_SIMPLE`, `ADAM_REASONING_HEADROOM_SCALE`, `ADAM_PRICE_*`, `ADAM_MODEL_CONCURRENCY` (default 8, `throttle.ts:50`), `ADAM_OPENAI_PROTOCOL`, `ADAM_MODEL_DEBUG`, `ADAM_SAFETY_SALT`, `ADAM_PLANNER_ROLE`, `ADAM_MISSION_ROLE_*`, `ADAM_SPECIALISTS` (`off`), `ADAM_AGENT_EMAIL` (default `adam@adventum-pharma.dz`), `ADAM_BLOCK_PREVIEW` (E2E demo route) | `models/`, `assistant/`, `missions/` | model gateway config | registry defaults |
| `AI_MODEL`, `AI_MODEL_CHEAP` (R) | `ai.ts:150-161` | **dead** — only logs a warning once | — |
| `CTD_MODEL_CHEAP`, `CTD_EMBED_MODEL`, `CTD_BUDGET_USD_DEFAULT` (R) | `openai-luna.ts:57,451`, `regulatory/.../cost/ledger.ts:61` | CTD eco model / budget | defaults / no budget |
| `STT_MODEL`, `TTS_MODEL`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`, `OPENAI_TRANSCRIBE_MODEL`, `OPENAI_VOICE_*` (6 VAD knobs), `ADAM_VOICE_LANGUAGE`, `ADAM_PRICE_REALTIME_AUDIO_*` | `assistant/voice-*.ts`, `api/.../transcribe/route.ts` | voice | defaults |
| `MISTRAL_API_KEY` (R) + `REG_MISTRAL_OCR_*` (7) | `regulatory/intelligence/ocr/mistral-ocr.ts:37-95` | primary OCR | falls back to tesseract.js |
| `REG_OCR_*` (ENGINE, ENABLED, CONCURRENCY, BATCH, CHUNK_*, LANGS, MAX_PAGES, MIN_CONFIDENCE, SCALE, STORED_PAGES, CACHE_DIR, AI, AI_PAGES), `REG_AI_*` (10), `REG_VISION`, `REG_EXTRACT_*`, `REG_EXTRACTION_MAX_CHARS`, `REG_WORKER_*`, `REG_MAX_PROCESS_MB`, `REG_JOBS_BUDGET_MS`, `REG_FACTS_CONTENT_BUDGET_MB`, `REG_CASE_MAX_MB`, `REG_CORPUS_MAX_MB`, `REG_ANPP_WATCH` (`0` off), `REG_AGENT_AUTO` (`0` off) | `regulatory/intelligence/**` | CTD pipeline tuning | defaults (most documented in readme 23) |
| `MIMO` | `assistant/beta/actions.ts:274`, `scripts/chat-agent.ts` | experimental Xiaomi MiMo beta | feature off [U] |
| `SANDBOX_PYTHON` | `sandbox/python.ts:40` | python binary path | probes standard paths |

**Mail, integrations, push, site-web**

| Var | Read in | Purpose | When unset |
|---|---|---|---|
| `MAIL_ENCRYPTION_KEY`, `MAIL_MAX_CONCURRENCY`, `MAIL_MAX_POOL`, `MAIL_IMAP_IDLE_MS`, `MAIL_BREAKER_*`, `MAIL_CACHE_*` (R) | `mail.ts:19-283` | IMAP pool/breaker | defaults |
| `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM`, `MAIL_WEBHOOK_SECRET` (R) | `mail-smart.ts:31-173`, `api/mail/inbound/route.ts:21` | HTTPS mail API; inbound HMAC | send inactive; inbound route refuses all |
| `SMTP_*` (E only) | **not read anywhere in `src/`** [V by rg] | legacy | — |
| `MICROSOFT_*` (6) | `mail/config.ts:35-63` | Graph mail pilot | off |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI/ADAM_EMAIL/PUBSUB_TOPIC/PUBSUB_AUDIENCE/PUBSUB_TOKEN/PUBSUB_SERVICE_ACCOUNT` | `google/config.ts:77-87`, `api/google/pubsub/route.ts:31-44` | Adam Gmail | sweep is a no-op |
| `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT` (R,Y), `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `push.ts:22-75` | Web Push | **keys generated and stored in `AppSetting`** (`push.ts:31-44`) — push still works |
| `ADVENTUM_BASE_URL`, `ADVENTUM_API_KEY`, `ADVENTUM_WEBHOOK_SECRET` (E,R,Y), `SITE_WEB_RECONCILIATION` (E,R) | `site-web/config.ts:113-153`, `entrant.ts:72-74`, `audience-collecte.ts:94`, `reconciliation.ts:390` | public-site publishing (fallbacks; ERP-generated key preferred, §118.159) | queue & reconciliation silent |
| `EVENTS_WEBHOOK_SECRET[_SOURCE]` | `platform/in-process/events/ingestion.ts:83-92` | universal inbound webhooks | route closed |
| `EMPLOITIC_API_KEY` | `recruitment/diffusion.ts:57` | job-board diffusion | channel "non configuré" |
| `ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET` (E,R) | `onlyoffice.ts:12-13` | Office editor | editor inert |
| `JITSI_DOMAIN` | `meetings.ts:14` | video rooms | `meet.jit.si` |
| `DOCX_PDF_POLICES`, `HOME`, `LOCALAPPDATA`, `WINDIR` | `payslip/polices.ts:101-116` | font lookup for payslip PDF | probes OS dirs |

**Kill switches / feature flags / scheduler**

`TACHES_DE_FOND=web|worker|les-deux` (V2-F, default `web`), `SCHEDULER_DISABLED=1`, `SCHEDULER_TICK_MS`, `WORKFLOW_SCHEDULER=off`, `MISSIONS_SWEEP=off`,
`KNOWLEDGE_INGESTION=off` (`knowledge/worker.ts:52`), `ASSISTANT_DRIVE_INGESTION=off`,
`DATA_QUALITY_DISABLED=1`, `INTELLIGENCE_CACHE_DISABLED=1`, `CHIEF_ROUTER_DISABLED`,
`CHIEF_ROUTER_CANARY`, `ADAM_CIBLE_DESIGNEE_DISABLED`, `ADAM_EMPREINTE_MUTATION_DISABLED`,
`ADAM_PERIMEES_DISABLED`, `ATTENTION_FUSEAU`, `ADAM_SORTIE_INTERDITE` / `ADAM_SORTIE_AUTORISEE`
[V, file refs in the scratch map]. None are documented in `.env.example`; only
`SITE_WEB_RECONCILIATION` is in readme 23.

**Test / bench / tooling only**: `TEST_DATABASE_URL`, `BENCH_DATABASE_URL`, `BENCH_SEED_ALLOW`,
`BENCH_*`, `AUTONOMY_*`, `AB_*`, `IC_*`, `DIAG_*`, `DEEP_SMOKE_*`, `CHAINE*`, `SONDE_ONLY`, `TTUV_N`,
`PHASE`, `ADVERSAIRE`, `SITE_DIR`, `BANC_*`, `SHEETS_BENCH_*`, `FACTORY_BENCH_*`, `FABRIC_BENCH_N`,
`AUTOTEST_BASE_URL`, `AUTOTEST_CREDENTIALS`, `PW_CHROMIUM`, `PLAYWRIGHT_CHROMIUM_PATH`, `E2E_CAPTURES`,
`HTTPS_PROXY`, `CI` (only `playwright.config.ts:23` retries), `BUILD_MEM_LIMIT_MB`, `BUILD_HEAP_MB`,
`GRAPHIFY_FORCE`.

### 4.9 Test architecture

- **Runner**: Vitest 2.1.2, `environment: node`, `include: src/**/*.test.ts` (no `.tsx` tests exist),
  `server.deps.inline: [/next-auth/, /@auth\//]` (otherwise suites failed to *load* silently),
  `testTimeout 20 000`, `hookTimeout 120 000` (`vitest.config.ts:8-60`) [V].
- **Global setup** (`vitest.global-setup.ts:24-43`) [V]: if `DATABASE_URL` set and reachable, upsert
  `siege-dg@banc-de-tests.local` (GENERAL_MANAGER, createdAt 2000-01-01, `passwordHash "!"`). No
  migrations are run: **the test DB schema must be brought up with `npm run db:deploy` beforehand**
  [V: nothing else in setup].
- **Counts** [V, `rg --files`]: 1,222 test files; ~14,261 `it(`/`test(` occurrences; by area:
  `lib/assistant` 118, `lib/actions` 113, `lib/` root files 104, `lib/regulatory` 91,
  `lib/missions` 70, `platform/in-process` 66, `lib/ad-pro` 52, `lib/artifact` 35,
  `lib/queries` 33, `lib/hr` 23, `lib/finance` 22, `lib/legal` 19, `lib/pieces-lues` 16,
  `lib/drive` 13, `lib/secretariat` 13, `lib/site-web` 12, `lib/budget` 12,
  `lib/bons-de-commande` 12, `components` 11 (pure `.ts` checks), `platform/` root 6, `app/` 1, rest
  spread over ~60 smaller `lib/*` folders.
- **Unit vs integration**: 457 files import `@/lib/prisma` (DB-backed integration, mocking
  `@/lib/session` and `next/cache`, data tagged with a per-file prefix like `__cpt__`); 397 use
  `let dbOk…; const suite = dbOk ? describe : describe.skip` (e.g.
  `src/lib/actions/promo-comptage-flow.test.ts:20-22`). Without Postgres these **skip silently**, so
  a green run without a DB proves little [V].
- **Guard / ratchet tests** (source-scanning; ~66 files walk the tree, 80 mention *cliquet*/ratchet):

| Test | Enforces |
|---|---|
| `src/lib/client-bundle-guard.test.ts` | From each `"use client"` file, follow static **and** `import()` imports (stopping at `"use server"` modules) — fail on native Node modules (`fs, zlib, child_process, net, tls, http(s), os…`) or Node-only packages (`web-push, nodemailer, imapflow, mailparser, sharp, mupdf, pdfkit, pdf-parse, yauzl, @mastra/core`). Prints the offending chain. |
| `src/lib/actions/use-server-exports.test.ts` | `"use server"` files export only async functions (§118.133f); has a minimum-files floor. |
| `src/lib/lint-directives.test.ts` | Every `eslint-disable` rule name exists in ESLint's computed config (§118.155). |
| `src/platform/boundary.test.ts` | `src/platform/**` imports nothing from the ERP except the bridge; Adam→ERP import debt ≤ `DEBT_CEILING = 425` (`:128`). |
| `src/platform/domains.test.ts` | Architecture test: zero cycles / layer inversions; `CROSSING_CEILING = 68`, `PROVIDER_CEILING = 42` (`:68-69`). |
| `src/modules/frontieres.test.ts` *(extended 2026-10-28, V3-G)* | Modules (`src/modules/<m>/`) are entered only through their doors (`api.ts`, `api-*.ts`, `partage.ts`, `actions.ts`; `ecrans/` from `src/app/` only); `domaine/` pure (type-only `@prisma/client` allowed); module→module edges ⊆ `src/modules/carte.ts`, acyclic, no dead permission; nobody imports an old path (`tsconfig.json` exact `paths` = forwarding addresses, `src/platform/demenagements.ts`); exact inherited-debt list. ESLint `no-restricted-imports` mirrors rules 1/2/5. |
| `src/platform/couverture.test.ts` *(added 2026-10-28, V3-G)* | Six ceilings that can only go down (`src/platform/couverture.ts`): `src/lib` files in no layer 754 (after the `rh` module and assistant decision 0011), pages importing Prisma 126, routes 53, `components → app` 12, UI kit → business 6, tests reading source by path 128. `npm run test:architecture` runs all architecture guards in ~35 s. |
| `src/platform/reachability.test.ts` | No module in `src/lib/missions`, `src/lib/artifact` is test-only or orphaned (§53); uses the `rg` binary. |

| `src/platform/couverture.test.ts` *(added 2026-10-28, V3-G)* | Six ceilings that can only go down (`src/platform/couverture.ts`): `src/lib` files in no layer 768, pages importing Prisma 126, routes 53, `components → app` 12, UI kit → business 6, tests reading source by path 128. `npm run test:architecture` runs all architecture guards in ~35 s. |
| `src/platform/qualite-code.test.ts` | Dead code (knip, whole repo: zero unused file/export/type/dependency; test-only production files ⊆ a named list) and duplicate blocks (jscpd ceilings). Replaced `reachability.test.ts` (lot V4, 2026-10-28). |
| `src/platform/decors-de-test.test.ts` | Fixture cost measured in sequential DB round-trips: `PLAFOND_ATTENTES = 47`, notable ≥ 6 (`:49-52`). |
| `src/lib/actions/contrat.test.ts` | Generated action contract is up to date (`npm run actions:contrat`), unreadable actions ≤ 24, designable ≥ 500. |
| `src/lib/assistant/action-parity.test.ts`, `capability-audit.test.ts` | Every server action is classified in the Chief/Adam action registry. |
| `src/lib/models/passerelle-unique.test.ts`, `models.test.ts`, `routing.test.ts` | Single gateway to model providers. |
| `src/lib/ui/dead-links.test.ts` | Every hard-coded internal path matches a real `page.tsx`. |
| `src/lib/ui/loading-boundary.test.ts`, `class-collision.test.ts`, `src/lib/responsive-guard.test.ts`, `src/components/ui/icon-names.test.ts` | UI regressions (loading.tsx above redirecting pages; conflicting width classes; wide tables / un-prefixed `col-span`; icon names resolve §118.149). |
| `src/lib/sortie/garde.test.ts` | Zero external effect during tests. |
| `src/lib/adam-visibilite.test.ts`, `session-vue-exacte.test.ts`, `vue-exacte-etanche.test.ts`, `ai-interrupteur.test.ts`, `ia/cle-manquante.test.ts`, `refs-filet.test.ts`, `notifications/ecrire.test.ts`, `actions/temoins-cases.test.ts`, `missions/horizon/architecture.test.ts` | Product doctrines (§118.153, §118.184, AI master switch, §118.128, §118.175, §118.172…) held by scanning call sites. |

- **E2E** (`playwright.config.ts`) [V]: `testDir ./e2e`, 45 s timeout, retries only when `CI`,
  Chromium at `/opt/pw-browsers/chromium` (never `playwright install`), web server
  `npx next start -p 3100` **on an existing `.next` build** (`npm run build` first),
  `reuseExistingServer: true`. Env passed: `ADAM_SORTIE_INTERDITE=1`, `NEXTAUTH_SECRET` = seed secret
  (Drive keys derive from it), `ADAM_BLOCK_PREVIEW=1`, placeholder AI keys (one real request still
  leaves for the Super Admin daily brief and gets 401, `:61-71`). 40 spec files / 312 tests covering
  smoke (login, invitations), Live Office, legal docs, stock-promo, finances centre, AD-PRO, site web,
  vue exacte, chief UI, `ui-audit.spec.ts` (40 screens at 375/1440 px). Helpers: `decisif.ts`,
  `measure.ts`.
- **Live E2E** (`playwright.live.config.ts`) [V]: refuses unless `DATABASE_URL` is local (`:23-26`),
  port 3101, 240 s timeout, 1 worker, real `OPENAI_API_KEY`, deliberately **no** Anthropic key;
  judges each Adam turn by DB effect, latency and `ModelCallLog` cost. 1 spec / 28 tests.
- **Auto-tester** (`scripts/auto-test/`, `npm run autotest[:live]`) [V README]: static coherence of
  pages ↔ `requireModule` guard ↔ navigation ↔ RBAC matrix; `--live` crawls anonymously (every page
  must redirect to `/login`) and per role (seeded throwaway accounts with `--seed`); `--ai` triage.
  Outputs `auto-test-report.{md,json}` (git-ignored); non-zero exit on bugs.
- **UI audit crawler** `scripts/ui-audit/run.ts --shots` → `ui-audit-out/`.
- **Benches** `scripts/bench/*` (~32 files): upload/ingest/Postgres bytea measurements
  (`scripts/bench/README.md`), Adam live benches, autonomy, A/B, latency, site-web link sabotage.
  They must target a local DB whose name contains `bench` (enforced in `prisma.ts`), and run with
  outbound effects disabled (bench detection in `garde.ts`).
- **Evals**: `npm test`/`test:e2e` drop target measurements into `bench-out/evals/`;
  `npm run evals:report` prints the 17 targets and fails on a missed one (readme 28) [U: not traced].

### 4.10 Observability

> **Updated 2026-10-28 (lot V3-E « Fiabilité »)** [V: code of this lot]. The bullets below that describe
> `/login` as health check, plain logging and no `global-error.tsx` are superseded:
> - **Single structured journal** `src/lib/journal.ts` (zero imports → client-safe, NEUTRAL in
>   `platform/boundary-scan.ts`): one JSON line `{ts, niveau, evenement, …contexte, erreur, repetitions}`;
>   anti-avalanche (same event + same message rewritten once per 60 s, the next line carries the count of
>   silenced repeats); every `erreur` is **counted** per event in process memory. `taches-de-fond/journal.ts`
>   delegates to it (counting key `tache.echec:<clé>`).
> - **Named catches** replace silent `.catch(() => x)`: `sansBloquer("event", repli)` (tolerated failure:
>   logged + counted) and `attendu("raison", repli)` (expected rejection: client body, optional file,
>   best-effort close — nothing logged). Measured 1 211 silent catches → 12 (2 motivated server exceptions,
>   10 client screens that already show the failure). Ratchet: `src/lib/journal-catch-muets.test.ts`
>   (server = 0 outside named exceptions; client ceiling 10, can only go down).
> - **Repeated errors → Super Admin**: `src/lib/incidents-repetes.ts`. `verserCompteurs()` runs at the start
>   of EVERY pass in EVERY process (outside leases — web and worker each own their memory), atomic UPSERT into
>   `IncidentRepete` (window 1 h, reopened when stale; on DB failure the batch is restored in memory). Task
>   `observabilite.incidents` (leased) sends ONE aggregated `notifyRoles(["SUPER_ADMIN"])` for events ≥ 5 in
>   the window, then 6 h of silence per event. Diagnostic card "Erreurs rattrapées"
>   (`admin/diagnostic/incidents.tsx`). Migration `20270205100000_incidents_repetes`.
> - **Health**: `src/app/api/health/route.ts` — 503 on DB unreachable (3 s) **or** on migrations missing
>   (`src/lib/migrations-appliquees.ts`: `prisma/migrations/*` dirs vs finished, non-rolled-back rows of
>   `_prisma_migrations`; "up to date" memoised per process; unreadable folder → `inconnu`, not blocking);
>   200 with `etat: "degrade"` + counts (no event names) when this process has repeated errors (15 min).
>   `render.yaml` now `healthCheckPath: /api/health` and `npm ci`; `package.json` `engines.node = 22.x`.
> - **`src/app/global-error.tsx`**: French root error boundary (inline styles, `digest`, logs via the journal).
- **Logging**: plain `console.*` (≈452 `console.error`, 33 `warn`, 48 `log/info` in non-test `src/`),
  consumed by Render's log stream; scheduler steps log with `[scheduled]` / `[scheduler]` prefixes
  [V]. No structured logger, no log levels config.
- **Error surfacing**: `src/app/(app)/error.tsx` (French error boundary, shows `digest` for support,
  logs to browser console) [V]; there is **no `global-error.tsx`** [V]. No Sentry/OTel/Datadog
  dependency [V: package.json, rg].
- **DB-persisted telemetry**: `ModelCallLog` (buffered sink, `createMany` every 1.5 s or 40 rows,
  `platform/in-process/telemetry/usage-sink.ts`), `AiHealthCheck` (daily probe + Super Admin alert,
  `src/lib/ai-health.ts`), `AuditLog`/`recordAudit` (`src/lib/audit.ts:23`), `ActivityLog`,
  session-replay events (`POST /api/replay`, server-side masking), `BusinessEvent` registry
  [V for files; schema `prisma/schema.prisma:5291, 5429, 9473, 9551`].
- **Health**: Render `healthCheckPath: /login` (static page, no DB) — it proves the Node process is
  up, not that Postgres is reachable [V]. Deep checks are manual: `npm run adam:doctor`
  (exit 1 on FAIL), `npm run storage:check`, `scripts/audit-disk.sh` (run in Render Shell),
  in-app **Test Center** (`/admin/test-center`, `src/lib/test-center/` incl. `infra-checks.ts`;
  production is read-only unless confirmed with a safety phrase, `guard.ts:21-30`).
- `src/lib/metrics/catalog.ts` is **not** operational metrics: it is the business semantic layer
  (named KPI definitions such as the five meanings of "chiffre d'affaires").

### 4.11 PWA

`public/manifest.webmanifest` (standalone, portrait, SVG icon) and `public/sw.js` (38 lines:
`install`→`skipWaiting`, `activate`→`clients.claim`, `push`→`showNotification`, `notificationclick`
→ focus/open URL). No `fetch` handler, so no offline cache [V]. Registered from
`src/components/layout/push-register.tsx:25,45`.

### 4.12 CI

None. No `.github/`, `.gitlab-ci.yml`, `.circleci/` [V]. Substitutes: (1) the local gate in
CLAUDE.md; (2) guard tests inside `npm test` that encode past production failures; (3) Render's
build (lint if `build:render` is really used, separate tsc, compilation) as the last gate;
(4) scripts designed with CI-friendly exit codes (`autotest`, `build:measure`, `adam:doctor`,
`evals:report`) but not wired to any pipeline.

---

## 5. Conventions & house style for this area

- **Comments are the spec**: config decisions carry long French block comments with *measured*
  numbers and the incident that motivated them (`next.config.mjs`, `vitest.config.ts`,
  `render.yaml`). When you change a knob, update the measurement in the comment.
- **A fix must live where the command can't bypass it** (§118.208): build protections live in
  `next.config.mjs`, not only in `build:render`.
- **Guards arm on facts, not intentions** (§118.17): test/bench detection reads `argv[1]` /
  `npm_lifecycle_script`, the DB guard parses the URL, the lint test computes ESLint's real config.
  New guards should have a "floor" (minimum files scanned) so a broken walker can't go green.
- **Ratchets only go down**: lower `DEBT_CEILING`, `CROSSING_CEILING`, etc. when you pay debt;
  raising them must be a visible, justified diff.
- **Periodic work = a function called from `runScheduledJobs()`**, idempotent, gated by a DB row
  ("…SiDu"/"…IfDue"), claimed atomically (`updateMany where … null`), wrapped in
  `.catch(e => console.error("[scheduled] …", e))`, with an env kill switch (`X=off`). Effects
  (sending, publishing, mutating) go here, **not** in the user workflow registry, which declares
  `mutates: false` (`scheduled.ts:131-137, 186-196, 229-240`).
- **Tests**: DB-backed suites use `dbOk ? describe : describe.skip`, mock `@/lib/session` and
  `next/cache`, tag their rows with a unique prefix and clean up; build fixtures in parallel
  "waves" (decors ratchet); never point at a remote DB; never send anything out.
- **Client/server boundary**: pure helpers in import-free modules (`*-ui.ts`, `galenic.ts`,
  `text.ts`), re-exported by the server module (CLAUDE.md).
- **Migrations**: hand-written, idempotent SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`,
  `DO $$ … EXCEPTION …` for constraints), applied with `db:deploy`; a new enum value cannot be used in
  the same migration (PG16).
- **Diagnostics never print secrets** — only variable names and states.

---

## 6. End-to-end flows traced

### 6.1 "Remind me 30 min before a meeting" (scheduler → push)

1. User opens any `(app)` page → `messages-indicator.tsx:155-167` polls `GET /api/messaging/sync`
   every 12 s.
2. First hit loads `api/messaging/sync/route.ts`, whose import of `@/lib/scheduled` executes
   `armHeartbeat()` (`scheduled.ts:92`) → `setInterval(runScheduledJobs, 60 s).unref()`.
3. The route also calls `void runScheduledJobs()` (`route.ts:17`), after auth + RBAC check
   (`MESSAGING VIEW`).
4. `runScheduledJobs()` checks `running`/`lastRun` debounce (`scheduled.ts:96-101`), then calls
   `sendDueMeetingReminders()` first (`:102`).
5. Query: `meeting.findMany({ status: "SCHEDULED", reminderSentAt: null, scheduledAt: (now, now+30min] }, take 50)`
   (`:385-400`).
6. For each, atomic claim `meeting.updateMany({ where: { id, reminderSentAt: null }, data: { reminderSentAt: now } })`
   — a second instance/tick gets `count 0` and skips.
7. `notifyUser({ type: "DEADLINE_NEAR", … })` for organizer + participants →
   `src/lib/notify.ts:19-27` creates the `Notification` row (bell) then `sendPushToUser`.
8. `src/lib/push.ts:92-96`: outbound gate `sortieAutorisee("NOTIFICATION_PUSH", …)` (refuses in
   tests/E2E/benches), VAPID keys from env or `AppSetting` (generated on first use), `web-push` to
   each subscription; `public/sw.js` shows the OS notification and opens `data.url` on click.
9. Failure anywhere in step 5–8 throws out of `runScheduledJobs` into the outer `catch`
   (`[scheduled] run failed`); `running` resets in `finally`; the next tick retries [V].

### 6.2 Deploying a commit to Render

1. Push to the tracked branch → Render runs the build command (Blueprint: `render.yaml:52`; or the
   dashboard override, §118.208).
2. `npm install` (`.npmrc` legacy peers) → `prisma generate`.
3. `build:render` (before any DB write since refonte P0; then `prisma migrate deploy` → `db:bootstrap`): `next lint` (fails on any ESLint error, e.g. unknown rule in a directive) →
   `tsc -p tsconfig.build.json` → `next build` with `TYPECHECK_SEPARE=1`.
   If instead a bare `npx next build` runs: `next.config.mjs` detects `RENDER`, runs the separate
   tsc itself, caps heaps at 3 GB; **lint does not run** (`ignoreDuringBuilds`).
4. `next build`: 1 static worker, webpack build workers, gzip cache, no server minification, no
   tracing.
5. `npx next start -p $PORT`; Render probes `/login`. Background jobs stay idle until the first
   logged-in poll (§6.1 step 2).

### 6.3 `npm test` against a DB

`package.json:15` sets `DATABASE_URL` to `TEST_DATABASE_URL` or `amd:amd@localhost/amd_internal_os`
→ Vitest loads `vitest.global-setup.ts` → dynamic import of `src/lib/prisma.ts` → `refusDeBase()`
(VITEST set ⇒ requires local host; throws otherwise) → `SELECT 1` → upsert the Siège DG → each
test file imports Prisma again (per worker), probes `dbOk`, runs or skips; `scheduled.ts` does not
arm its heartbeat (`VITEST`), and every outbound transport is refused by `sortie/garde.ts`.

---

## 7. Coupling & blast radius

- **`src/lib/scheduled.ts` imports ~45 modules across every domain** (HR, stocks, regulatory,
  site-web, knowledge, Google, missions). Any heavy or Node-only import added to one of them is
  pulled into `api/messaging/sync/route.ts`. A **client** component must never import
  `scheduled.ts` (it would drag `web-push`, IMAP… into the browser bundle; the bundle guard would
  catch it).
- **Serial chain**: a step not wrapped in `.catch` — `sendDueMeetingReminders`,
  `sendDueReminders`, `sendDuePayrollNotifications`, `runDueRegulatoryJobs` (try/finally only,
  `jobs/runner.ts:160-168`), `runAnppWatchIfDue`, `pollAiBatches`, `runIntelligencePulse` — that
  throws aborts **all later steps** for that tick (missions, site-web queue, Gmail). The regulatory
  runner can also hold the chain for up to `REG_JOBS_BUDGET_MS` (120 s) [V].
- **Single instance assumptions**: in-memory debounce (`lastRun`, `running`) and in-memory flags
  (`rapprochementEnCours`, `passInFlight`) are per process; cross-instance safety relies on DB
  claims. Scaling to several instances multiplies the Prisma pool (12 each) [V comment
  `prisma.ts:139-142`].
- **`AUTH_SECRET` / `NEXTAUTH_SECRET` / `DRIVE_ENCRYPTION_KEY` / `MAIL_ENCRYPTION_KEY`**: changing
  or *adding* one of these changes derived keys → existing encrypted Drive blobs or stored mail /
  OAuth secrets become unreadable. Note the two derivations prefer **different** variables:
  `drive-storage.ts` uses `NEXTAUTH_SECRET ?? AUTH_SECRET`; `secret-box.ts` uses
  `MAIL_ENCRYPTION_KEY || DRIVE_ENCRYPTION_KEY || AUTH_SECRET || NEXTAUTH_SECRET` [V].
- **`next.config.mjs` `serverExternalPackages`** (Next 15 name) ↔ `client-bundle-guard`
  `NODE_ONLY_PACKAGES`: adding a new native/WASM dependency usually requires updating both.
- **`scripts/graphify-refresh.sh`** temporarily moves `src/lib/actions/aiguillage.genere.ts` away;
  any build/typecheck/test started during a refresh fails with "Can't resolve './aiguillage.genere'".
- **Upgrading Next** (15.5.28 since V3-A): the `cpus`/`webpackBuildWorker`/`serverMinification`/
  `webpackMemoryOptimizations` knobs, the `TraceEntryPointsPlugin` filter (by constructor name — a
  rename upstream silently re-enables tracing, +~250 MB) and the middleware location rule are
  version-specific. Next 16 removes `next lint` (`build:render` calls it): migrate to the ESLint CLI first.
- **Test DB = dev DB by default** (`amd_internal_os` on localhost): running `npm test` seeds tagged
  rows into the local working database.

---

## 8. Invariants, gotchas, doctrine rules

1. **Verification sequence** (CLAUDE.md, §118.155): `npm run typecheck && npm run build && npm test`
   then `npx next lint`. Local `next build` ignores lint; a single lint error (classic: an
   `eslint-disable` for `@typescript-eslint/*`) blocks the Render deploy when `build:render` runs.
2. **Stale `.next` cache**: `npm run build` reuses `.next/cache` and can hide a client-bundle error
   that a clean Render build hits. After touching a client component's imports:
   `rm -rf .next && npm run build` (CLAUDE.md; `build-memory.sh` also cleans).
3. **Client/server boundary** (CLAUDE.md): never import `fs`/`zlib`/`child_process` or Node-only
   packages, even transitively or via `import()`, from `"use client"` code; `"use server"` modules
   are RPC boundaries. Enforced by `client-bundle-guard.test.ts`.
4. **`"use server"` files export only async functions** (§118.133f) — otherwise production build
   fails ("Server actions must be async functions").
5. **Tests/benches never touch a remote DB** (§118.90) and **never send anything out** (§118.17,
   `sortie/garde.ts`).
6. **Do not set `NODE_OPTIONS` in the Render dashboard** (`render.yaml:46-49`): it would apply to
   `next start` too, and a big V8 heap on a small instance OOMs at runtime.
7. **`middleware.ts` location** [V]: Next 14.2.35 — and still Next 15.5.28 (`node_modules/next/dist/build/index.js:548`, re-checked 2026-10-28, V3-A) — resolves middleware in
   `path.join(pagesDir || appDir, "..")`, i.e.
   `src/` here, but the file is at the repo root and `src/middleware.ts` does not exist. The edge
   `authorized` callback (`src/auth.config.ts:16-71`) therefore probably never runs; protection
   comes from `requireUser()` in `src/app/(app)/layout.tsx:45` and per-route checks. Consistent with
   this: `e2e-live/adam-live.spec.ts:624-625` expects a raw `401` from an unauthenticated
   `POST /api/events/inbound/generic`, which a live middleware would have turned into a redirect to
   `/login` (next-auth `lib/index.js:156-163`). Pages outside `(app)` (`impression`, `office-embed`,
   `onboarding`, `change-password`, `invite`, `meet`, `inscription`) and every `/api/*` route must
   self-guard [U: per-route audit not done here].
8. **Heartbeat starts lazily**; on the free plan the instance sleeps after inactivity, pausing all
   jobs (meeting reminders included) until someone opens the app (`scheduled.ts:74-76`).
9. **Migration folder names are future-dated** (145 of 463 after 2026-10-24, up to
   `20270126100000`) and 4 timestamps are shared by two folders (e.g. `20270112090000_blob_compression`
   and `_devis_poste_lignes`). Prisma orders lexically; a new migration must sort **after** the
   latest existing name, not after "now" [V counts; U impact].
10. **Ratchet drift**: `boundary.test.ts` `DEBT_CEILING` is 425 today vs 424 in
    `audit/baseline/03-ratchets.txt`, and `domains.test.ts` `CROSSING_CEILING` 68 vs 69 — the
    boundary budget went **up** once despite "only goes down" [V].
11. *(Resolved, lot V4 2026-10-28 — test replaced by knip in `qualite-code.test.ts`.)* **`reachability.test.ts` had no floor** on files scanned and swallows `rg` failures
    (`execFileSync("rg", …)` in a `try { } catch { return []; }`): without the `rg` binary it passes
    vacuously — the exact anti-pattern §118.17 names [V].
12. **E2E seed has no local-DB guard** (`e2e/global-setup.ts:58`, `global-teardown.ts:6` build a raw
    `PrismaClient` from `DATABASE_URL`); unlike Vitest and the live config, a shell exported to a
    remote DB would seed `__e2e__` users there [V].
13. **`vitest` hook timeout is deliberately 120 s** (§118.83, §118.27): "red because slow" is treated
    as noise; structural fixture cost is held by `decors-de-test.test.ts` instead.
14. **Graphify refresh**: only after a big batch (never per micro-commit); refuses to run while a
    `next build` process exists; commit `graph.json`/`graph.html`/`GRAPH_REPORT.md`/
    `.graphify_labels.json`. `graph.json` is now ~46 MB (CLAUDE.md says "~8 Mo d'artefacts").
15. **Bootstrap default credentials** `admin@adventum.dz` / `ChangeMe123!` if `ADMIN_*` unset
    (`prisma/bootstrap.ts:13-15`); forced password change in that case.

---

## 9. Docs-vs-code discrepancies

| Claim (where) | Code reality |
|---|---|
| CLAUDE.md & `lint-directives.test.ts:10`: "Render runs `build:render` (lint before build)" | §118.208 and `next.config.mjs:6-12, 174-182` state the dashboard runs a bare `npx next build`, which never lints (`ignoreDuringBuilds: true`). Both cannot be true; which one Render runs today is unknown. |
| `docs/readme/24-deploiement-render.md`: Render runs `npm install && prisma generate && prisma migrate deploy && db:bootstrap && next build` | `render.yaml:52` ends with `npm run build:render`. |
| `render.yaml:29-33` comment: "`experimental.cpus: 2`", peak 3.6–3.9 GB | `next.config.mjs:70` is `cpus: 1`; its comment measures 5,437 MB with 1 worker. |
| `scripts/build-memory.sh` default limit 4,200 MB (and readme 27) | Latest measured peak in `next.config.mjs` comment is 5,437 MB → `npm run build:measure` would fail by default [U: not run]. |
| `render.yaml:96`: "VAPID … (sinon push inerte)" | `src/lib/push.ts:31-44` generates and persists VAPID keys in `AppSetting` when env keys are absent. |
| readme 23: `ANTHROPIC_API_KEY` activates the assistant; `AI_MODEL`/`AI_MODEL_CHEAP` choose Claude tiers; `OPENAI_API_KEY` = Whisper/Luna | Default provider is **OpenAI** (`models/registry.ts:137`, roles default to `gpt-5.6-*`); `AI_MODEL*` only log a deprecation warning (`ai.ts:140-161`); Anthropic used only with `ADAM_MODEL_PROVIDER=anthropic`. |
| `.env.example`: `SMTP_*` "for email notifications" | No `SMTP_*` read in `src/` or `scripts/`; mail uses `MAIL_PROVIDER/MAIL_API_KEY/MAIL_FROM` or IMAP/Graph. |
| `.env.example` lacks `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `VAPID_*`, `DRIVE_ENCRYPTION_KEY`, `MAIL_*`, `GOOGLE_*`, `EVENTS_WEBHOOK_SECRET`, kill switches | Read by code (§4.8). `render.yaml` also omits all AI keys. |
| readme 22: "Node.js ≥ 18" | `render.yaml:63` pins Node 22; render comment mentions Node 20 builder. |
| readme 26: "93 modèles, 86 enums, 69 migrations" | `prisma/schema.prisma`: 433 models, 206 enums; 463 migration folders. |
| readme 28: "2 491 passés · 23 skip sur 229 fichiers"; vitest.config comment "685/717 fichiers" | 1,222 test files today; `audit/baseline/11-vitest-run3.txt` recorded 389 files / 4,952 tests at an older commit. |
| readme 28: E2E = auth + invitation flows (also `playwright.config.ts:5-10` header) | 40 specs / 312 tests across many modules. |
| `scripts/bench/README.md`: run benches with `DATABASE_URL=…/amd_internal_os npx tsx scripts/bench/<x>.ts` | `prisma.ts` refuses a bench whose DB name lacks "bench" (§118.90). |
| `audit/FINDINGS.md`: instruments `audit/reachability.ts`, `audit/module-reach.ts` | Not present; the instrument is `scripts/audit-runtime-reachability.ts` (writes `audit/reachability.{json,md}`). |
| CLAUDE.md: "~29 400 nœuds / ~3 800 fichiers", "~8 Mo d'artefacts" | Current `GRAPH_REPORT.md`: 31,488 nodes / 4,048 files; `graph.json` 46 MB. |
| Brief: "scripts/ (61 files)" | 68 files under `scripts/`. |
| `scheduled.ts:65-66`: heartbeat armed "à la première requête servie après un démarrage" | Armed at first request **to a route that imports `scheduled.ts`** (messaging sync / regulatory progress), not any request. |

---

## 10. Root folders: what they are

- **`streamlit_app/` + `.streamlit/config.toml`** [V]: an independent Python/Streamlit + SQLite
  edition of the ERP with demo accounts (`streamlit_app/README.md:1-30`, `requirements.txt`). Nothing
  in the Node app, scripts or configs references it (only `docs/readme/29-architecture-du-code.md`
  mentions it). Legacy prototype; safe to ignore; `.streamlit/` at the root exists only for Streamlit
  Community Cloud.
- **`data/selection-pf-produits.xlsx`** [V]: input of `scripts/gen-selection-pf-migration.ts`, which
  regenerates a committed migration (readme 27). Not read at runtime.
- **`audit/`** [V]: output of an "Audit Frontier" (FINDINGS at commit `1ff570b`, raw baselines of
  vitest/e2e runs, ratchet values, graph stats from 2026-08-28) plus `reachability.{json,md}`
  regenerated by `npm run audit:reachability`. Historical evidence, not used by the build.
- **`docs/wip/*.patch`** (19 files) [V/U]: plain `git diff` outputs named like agent IDs, added in
  PR #7 (merge `8429e5a`, 2026-10-06). None applies cleanly forward or in reverse against HEAD
  (`git apply --check`), but at least their migration hunks are already in the tree (e.g.
  `abc90eae65d12c104.patch` reverse-applies on `prisma/*`). They look like saved diffs of parallel
  agent worktrees, superseded by later commits — not an active work queue [U].
- **`public/`**: PWA files, `icon.svg`, a background image, and two client PDFs under
  `public/docs/` (served **without auth**? — static files under `public/` bypass the app layout;
  whether middleware would have covered `.pdf` is moot given §8.7) [U].

---

## 11. Safe change checklist

1. **Before**: `npm run graphify:query -- "<symbol>"`; read `docs/readme/` section for the circuit.
2. **Code change**:
   - Touched a `"use client"` file or anything it imports → keep pure helpers in import-free
     modules; run `npm test -- src/lib/client-bundle-guard.test.ts`; then **clean** build
     `rm -rf .next && npm run build`.
   - Added/changed a server action → only async exports in `"use server"` files; classify it in the
     action registry (action-parity); `npm run actions:contrat` and commit the generated
     `contrat.genere.*` / `aiguillage.genere.ts`.
   - Added an `eslint-disable` → only for rules loaded by `next/core-web-vitals`.
   - Added a periodic job → function in its domain, DB-gated + atomic claim + env kill switch,
     called from `runScheduledJobs()` wrapped in `.catch`, placed after the critical reminders.
   - Added an env var → read it with a safe default, add it to `.env.example`, readme 23 and, for
     production, `render.yaml` (`sync: false` for secrets); never print values in diagnostics.
   - Added a native/Node-only dependency → `serverExternalPackages` and
     `NODE_ONLY_PACKAGES` in the bundle guard.
3. **Migration** → new folder sorting after `20270126100000_*`, hand-written idempotent SQL,
   `npm run db:deploy` locally (also on the test DB), update `schema.prisma`, `npm run db:generate`.
   Never use a freshly added enum value in the same file.
4. **Gate** (Postgres up: `pg_ctlcluster 16 main start`):
   `npm run typecheck && npm run build && npm test` then `npx next lint`. Check that DB-backed
   suites actually ran (not skipped). Optionally `npm run build:measure` after config/dependency
   changes, `npm run build && npm run test:e2e` for screen changes, `npm run autotest` for RBAC/nav.
5. **Ratchets**: if you paid debt, lower the ceilings in `boundary.test.ts` / `domains.test.ts` /
   `decors-de-test.test.ts`; never raise without a written reason.
6. **After a large batch**: `npm run graphify:refresh` (no build running), commit the four graph
   artifacts, and update the README (panorama, circuits, journal) in the same batch.
7. **Deploy check**: after Render deploys, `npm run adam:doctor` / `npm run storage:check` in the
   Render shell; open the app once to arm the scheduler.

---

## 12. Verified vs uncertain (recap)

- [V] Render blueprint, build/start commands, env list (`render.yaml:15-111`).
- [V] `next.config.mjs` phase function, typecheck-on-Render, heap cap, knobs, headers (`:19-196`).
- [V] Scripts and their composition (`package.json:6-60`).
- [V] Scheduler mechanism, import points, 48 serial steps, meeting-reminder claim
  (`scheduled.ts:52-420`, `api/messaging/sync/route.ts:6-17`).
- [V] Test/bench DB guard and pool (`prisma.ts:93-177`); outbound kill switch (`garde.ts:118-139`).
- [V] Test counts, `dbOk` idiom counts, guard tests listed and their ceilings.
- [V] Next 14.2.35 / 15.5.28 middleware lookup rule; root `middleware.ts`; no `src/middleware.ts`.
- [V] No APM. (CI, `global-error.tsx` and the `/api/health` health check exist since the 27/10 audit and lot V3-E — §4.10.)
- [U] Which build command the Render dashboard currently runs and which branch it tracks.
- [U] Whether `build:measure` fails at its 4,200 MB default today (not run, per instructions).
- [U] That every "…SiDu" job is DB-gated (three checked).
- [U] Per-route self-guarding of all `/api/*` and non-`(app)` pages given the inactive middleware.
- [U] Exact provenance/intent of `docs/wip/*.patch`.


> **Updated 2026-10-30 (decision 0019, « Cliquez Sync, c'est tout »)** [V: code of this lot]. `render.yaml` sets
> `TACHES_DE_FOND=les-deux` on BOTH web and worker (the per-task lease arbitrates; the web keeps doing everything until the
> worker has beaten); the worker gets `AUTH_SECRET`, `OPENAI_API_KEY`, `S3_*`, `VAPID_*`, `ADVENTUM_*` via `fromService` (only keys
> the web block declares — Render does not document `fromService` to an absent key), `DATABASE_URL` via `fromDatabase`, literal
> `APP_URL`; plans of DB and web unchanged, worker `starter`. `Dockerfile.worker` now on `node:22-trixie-slim` (Python 3.13,
> LibreOffice 25.2, Tesseract 5.5), three stages (deps, Python engine, runtime), Arabic/Latin fonts incl. Carlito/Caladea, and a
> build-time `convertir.py --verifier` gate. Worker start-up control (`evaluerControle`/`controlerAuDemarrage` in
> `src/lib/taches-de-fond/sante.ts`, after the migration wait via `apresMigrations`) logs each missing variable/engine piece
> (`worker.controle.manque`) and upserts table `ControleWorker` (migration `20270210090000_controle_worker`, additive; presence only,
> never values). Web side: `atelier.conversions` still never converts on the web, but expires queued conversions the worker did not
> take (15 min). Local docker builds behind the agent proxy need a CA-injected variant (not shipped).
