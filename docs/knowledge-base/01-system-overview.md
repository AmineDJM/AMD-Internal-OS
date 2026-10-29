# 01 — System overview, architecture synthesis & risk register

> Lead-architect synthesis of the ten subsystem chapters (02–11), built on 2026-10-24 against **HEAD `41b2ef0`**
> (branch `claude/hopeful-goodall-phd0nb`, the deploy branch). Every claim carries a tag:
> **[V]** verified by reading code or running a command (citation given), **[V·agent]** verified by the chapter's
> author agent with file:line in that chapter (not re-checked by the orchestrator), **[U]** inferred / unconfirmed.
> Where the orchestrator re-checked an agent claim it is marked **[V·orch]**.

---

## 1. What the system is (business view)

**AMD Internal OS** is the single internal "enterprise OS" of **Adventum Pharma**, an Algerian pharmaceutical
laboratory: one web application meant to run 100 % of the company's activity (README.md). French UI, money in **DZD**,
business time zone **Africa/Algiers** (UTC+1, no DST). It explicitly forbids simulated/demo data (CLAUDE.md;
`prisma/bootstrap.ts` creates only the first Super Admin).

Navigation groups (`src/lib/navigation.ts`, `NAVIGATION` in `src/lib/labels.ts`) [V·agent 05/11]:

| Group | Contents (main modules) |
|---|---|
| **Pilotage** | Mon espace (action centre: validations, tasks, missions, HR file), Messagerie (internal chat), Messagerie e-mail (Microsoft 365), Directives, Calendrier, Réunions, Sujets (`/dossiers`), Mon équipe, Recrutement, Assistant IA / Chief of Staff / Missions d'Adam (Super-Admin-only by doctrine — see risk R3) |
| **Pôles** | **Regulatory** (AMM/ANPP dossiers, pipeline, CTD analysis, Budget Regulatory) · **Administration** (RH, Formations, Moyens généraux, Legal, Courriers, Annuaires, Campagne budgétaire) · **Marketing** (Marketing cockpit, Segmentation, Produits 360, Ad & Pro, Budget Marketing, Stock promotionnel, Site web) · **Operations & Sales** (Cockpit Opérations, Promotion médicale, Force de vente, Business Units, Marchés PCH, Ventes PCH, Stocks, Budget Ops) · Business Development |
| **Transverse** | Budgets & enveloppes, Finances (Banque & paiements · Comptabilité), Centre de paiement, Centre de validations, Centre Ad & Pro, Bons de commande, Drive / Documents / Office, Search, Support, Feedback |
| **Système** | Administration console (`/admin`: users, access matrix, sessions, adoption, settings, trash), Adventum Brain (Super Admin cockpit), Process intelligence |

Retired modules (data kept, access refused for everyone incl. Super Admin, enforced centrally in
`rbac.getAccess`, `src/lib/rbac.ts:1275,1440`) [V·agent 07]: manual **Ventes** (`SALES`), **Commandes & logistique**,
**Market Intelligence** (`BUSINESS_DEVELOPMENT`), **Retours & réclamations**.

Business glossary (AMM, ANPP, DCI, PCH, AO, BC, KAM, BU, DR, CTD, BV 25 %/75 % = *bon de versement*, segmentation
letters H/A–D/NA…): chapter **07 §4.1** and `docs/readme/04-glossaire-metier-algerie-pharma.md`.

---

## 2. Size & shape (measured at HEAD)

| Metric | Value | Source |
|---|---|---|
| TS/TSX lines | `src/lib` 601k (incl. tests) · `src/app` 127k · `src/components` 41k · `src/platform` 36k | [V] `find … \| wc -l` |
| Files in code graph | 4,048 files · 31,488 nodes · 128,302 edges | [V] `graphify-out/GRAPH_REPORT.md` (refreshed this session) |
| Pages under `src/app/(app)` | 283 (`page.tsx` total 294, **none** is `"use client"`) | [V·agent 04/05] |
| Server-action files / exported actions | 176 files in `src/lib/actions` · ~1,147–1,226 exported actions (counts differ by method) | [V·agent 04/11] |
| API route files | 121 `route.ts` (129 handlers) | [V·agent 02/04] |
| Prisma | 433 models · 206 enums · 7,316 fields · 16,648-line schema | [V] `grep -c '^model '` ; [V·agent 03] |
| Migrations | 462 folders (+ `migration_lock.toml`), hand-written idempotent SQL after June 2026 | [V] |
| Tests | 1,222 `*.test.ts` files (~14.3k cases; 457 DB-backed) · 40 Playwright specs · 1 live spec | [V] count ; [V·agent 10] |
| Doctrine | §118.1 → §118.215 numbered engineering rules, cited ~3,000 times in `src/` | [V] `grep -oh '§118\.[0-9]+'` |

Stack (`package.json`) [V]: Next.js **15.5.28** (App Router, RSC, Server Actions; async `params`/`searchParams`/`cookies()`/`headers()` — V3-A, 2026-10-28) · React 19.2 · TypeScript 5.6 strict ·
Prisma **5.22** / PostgreSQL · next-auth **5.0.0-beta.32** (Credentials + JWT + DB-revocable sessions) · Tailwind 3.4 ·
lucide-react · Recharts (marginal) · `@mastra/core` 1.79 (new agent, Oct 2026) · file tooling (mammoth, xlsx, exceljs,
jszip, pdfkit, mupdf, pdf-parse, tesseract.js, sharp, docxtemplater, pptxgenjs) · mail (imapflow, nodemailer, mailparser) ·
web-push · qrcode · zod (used in only 7 files). Node 22 on Render.

---

## 3. Architecture at a glance

```
 Browser (French UI, polling every 3.5–20 s, Web Audio chimes, service worker = push only)
   │  RSC HTML + Server Action POSTs + fetch to /api/*
   ▼
 Next.js 15 app (single Render web service, Node 22)   ── NO effective middleware (see R5)
   ├─ src/app/(app)/layout.tsx  → requireUser() + must-change-password / onboarding redirects  ← the real outer gate
   │    └─ 283 pages: requireModule("X") (lists) | requireUser + canAccessEntity + notFound() (details)
   ├─ src/app/(auth) login · (portal) supplier portal (own cookie auth) · public: inscription, meet, invite
   ├─ src/app/api/** 121 route files: session routes, signed/HMAC routes (site-web, mail inbound, pubsub,
   │    OnlyOffice), /api/v1 external REST (bearer API keys), /api/assistant SSE stream
   ├─ src/lib/actions/*  "use server" mutations  → src/lib/<domain>/* business logic
   ├─ src/lib/queries/*  read models for screens (React.cache per request, force-dynamic, no data cache)
   ├─ src/lib/{session,rbac,entity-access}.ts   authorization core (19 roles × 70 modules × 7 actions + overrides + row scope)
   ├─ src/lib/audit.ts recordAudit → AuditLog → events/from-audit whitelist → BusinessEvent → 6 consequences
   │    (task reconciliation, mission wake-up, engagements, reminders, watches, cache) — awaited in the request
   ├─ src/lib/notify.ts / notifications  → in-app Notification rows + Web Push (VAPID). No e-mail channel.
   ├─ src/lib/scheduled.ts  in-process setInterval(60 s), started on first import (first /api/messaging/sync poll)
   ├─ src/lib/drive-storage.ts  one blob store: compress → AES-256-GCM → sha256 dedup → S3/R2 bucket or Postgres
   │    (direct browser multipart uploads >20 MB go to the bucket UNencrypted, previewed via 15-min presigned GET)
   └─ AI layer: src/lib/assistant* + src/lib/models/gateway.ts (role-based model routing, OpenAI default)
        + Mission Runtime (src/lib/missions) + src/platform (contract / in-process bridge, import-debt cap)
        + NEW (Oct 22–24) Mastra agent src/lib/agent + /assistant/beta (bypasses the gateway — see R3)
   ▼
 Prisma 5.22 → PostgreSQL (Render managed; extensions + ~98 SQL-only indexes: trigram, FTS, partial uniques)

 External: OnlyOffice Document Server (JWT HS256) · Microsoft 365 (Entra, Graph) · Google (Gmail, Pub/Sub) ·
 Jitsi (/meet) · adventumdz.com public site (outbound queue + inbound HMAC + daily reconciliation) ·
 AI providers via raw fetch (OpenAI incl. Whisper/Realtime, Anthropic optional, Mistral OCR, Xiaomi MiMo in beta) ·
 S3-compatible storage (R2/S3/Supabase). Every integration is INERT when its env vars are unset.
```

Key architectural decisions and their reasons (from code comments / doctrine):

| Decision | Why (as stated in repo) | Tag |
|---|---|---|
| Monolith, server-first (all pages RSC, mutations as server actions, hand-rolled FormData parsing) | Small team, one deploy, secrets never in the browser | [V·agent 04/05] |
| Authorization re-checked in every page/action/route, user re-read from DB each request | Rights change live; JWT role is not trusted for most checks (exception: R7) | [V·agent 02] |
| Single choke points for money: `createExpenseOrder` (only creator, starts "awaiting payment centre"), `settleExpenseOrder` (only PAID writer, only if `canDisburse`) — pinned by `payments/centre-ecrivains.test.ts` | §118.148 "all payments through the centre" after a rule leaked through six doors | [V·agent 06] |
| "Product = regulatory dossier" (`ensureProduitDuDossier`) | One canonical product; dossiers carry stock | [V·agent 07] |
| Hand-written idempotent SQL migrations; schema.prisma only types the client | Need trigram/FTS/partial-unique indexes Prisma can't express; safe re-runs on Render | [V] drift measured (ch. 03 addendum) |
| Pure modules split from server modules + `client-bundle-guard.test.ts` | `fs`/`web-push` leaked into client bundles twice in production | [V] CLAUDE.md |
| Ratchet / source-reading tests instead of CI (~66–80 guards inside `npm test`) | No CI exists; conventions are enforced where developers run tests | [V·agent 10/11] |
| In-process scheduler, polling instead of websockets | Single free/low-tier Render instance; no worker service | [V·agent 08/10] |
| Build memory tuning (`experimental.cpus`, no server minification, small webpack cache, lint/tsc in separate processes) | Render 8 GB container ceiling caused OOM deploys | [V] `render.yaml` comments |

---

## 4. The request lifecycle (how a typical feature works end to end)

1. **Page** `src/app/(app)/<module>/page.tsx` (RSC): `requireModule("MODULE_KEY")` → load via `src/lib/queries/*`
   (row-scoped with `scope*` helpers / `companyScopedWhere`) → pass plain props (ISO strings, numbers — `Decimal`
   converted with `Number()`/`toNumber`) to client components. [V·agent 04]
2. **Client component** (`"use client"`, 566 files) calls a server action through `CreateRecordButton`
   (`useActionState`) or the `useAction` / `useKeyedAction` / `useRafraichir` hooks (catch, 45 s timeout, keep buttons
   locked until fresh data is visible — §118.172). Destructive buttons use `BoutonDecisif` (double-click within 5 s)
   instead of `window.confirm`. No toast library: inline French messages. [V·agent 05]
3. **Server action** `src/lib/actions/<module>-actions.ts`: `requireUser()` → `userCan(user, MODULE, ACTION)` and/or
   `canAccessEntity` → `fdStr(formData, …)` parsing → load + state check → write (77 files use `$transaction`;
   conditional `updateMany` for state transitions per §118.151 where done right) → `recordAudit({module, action,
   entityType, …})` (literal values — they drive the generated action contract and the fact ledger) → `notifyUser` /
   `notifyRoles` → `revalidatePath` → return `{ ok, error?, id?, message? }` (never throw for a business refusal,
   never `redirect()`). [V·agent 04/11]
4. **Fan-out**: `recordAudit` → `AuditLog` → `events/from-audit.ts` whitelist → `BusinessEvent` → six consequences
   awaited in the request (best-effort, errors logged and swallowed). [V·agent 11]
5. **Registration side-effects a new action must satisfy** (tests fail otherwise): classify it in
   `src/lib/assistant/action-registry.ts`; re-run `npm run actions:contrat` to regenerate the action contract;
   respect boundary/egress/visibility ratchets. Full 10-step "add a module" recipe: **chapter 04 §10**; impact
   playbook per change type: **chapter 11 appendix**.

---

## 5. Cross-system invariants you must not break

1. **Every payment** goes through the payment centre; only `createExpenseOrder` creates and only `settleExpenseOrder`
   marks PAID (`src/modules/finances/infra/expense-orders.ts:269`, `src/modules/finances/actions-depenses.ts:71`). [V·orch]
2. **Every BC** (purchase order) goes through a validation centre; BCs and invoices are `LegalDocument` rows
   (`kind = PURCHASE_ORDER | INVOICE`) — there is no Invoice/PO table. [V·agent 03/06]
3. **Ad & Pro routing** (circuit of 27/10/2026, `docs/architecture/adpro-circuit-2026-10-27.md`) is decided by the
   requester's rank (`parcoursAdPro`, `workflow/parcours.ts`): prévalidation without money (délégué → National Sales →
   Operations Director → Direction Marketing; Direction Marketing's own = d'office), then postes accepted by Direction
   Marketing only, then the **DG validates the TOTAL** (postes + retained/accepted PEC quotes) strictly above
   `adProDgThreshold` — no BC/visa/payment/quote acceptance before (`lib/ad-pro/porte-dg.ts`, table `AdProPorteDg`).
   The `dg` workflow step is always sieved out. [V·orch 27/10]
4. **Manager tree** has one source: `resolveManager` (`src/modules/rh/domaine/reporting-line.ts`); `directReportsOf`/`subtreeOf` are its
   inverse and route leave, Mon équipe, KPIs, promo stock. [V·agent 08]
5. **Retired modules** stay retired via `rbac.getAccess`; a test keeps them retired. [V·agent 07]
6. **Dossier status is derived** (`process-status.ts` `deriveStatus`, only writer `syncStatusFromWorkflow`), never typed. [V·agent 07]
7. **SQL migrations are the database truth** — never `prisma migrate dev` / `db push` on a real DB; new folder names must
   sort after `20270126100000_*`. [V]
8. **Client components never import Node-only modules**, even transitively (`client-bundle-guard.test.ts`). [V CLAUDE.md]
9. **Tests and benches only touch local databases** (`src/lib/prisma.ts` refuses otherwise, §118.90); benches need a DB name
   containing `bench`. [V]
10. **Notification links are routes**: moving a route requires a rewrite rule in `notifications/lien-actuel.ts`
    (menu badges are computed from `link`). [V·agent 11]
11. **Global search and the action centre are hand-maintained lists** — a new module must be added to both, reusing the
    screen's own visibility clause (§118.177). [V·agent 11]
12. **Adam / AI is Super-Admin-only** (§118.153, `peutVoirAdam`) — *currently violated at HEAD*, see R3. [V·orch]
13. **No simulated data**, French copy, DZD, Algiers time. [V CLAUDE.md]

---

## 6. Doctrine cheat sheet (§118 — the house engineering principles)

The numbered rules live in `docs/claude-md/03-*.md` and `08-*.md` (item `N.` = §118.N). Most cited in `src/`:

| Rule | Headline (paraphrased from French) | Practical meaning |
|---|---|---|
| §118.5 (389 refs) | *Ne rien recréer de ce qui existe* | Reuse the existing function/table/registry; never fork a second source of truth |
| §118.16 | A mutation's real footprint never exceeds the requested footprint | Narrow writes; refuse/return null rather than guess |
| §118.17 | A check that cannot fail protects nothing | Guards/ratchets must arm on a fact of the process and be proven to fail |
| §118.18 | The compiler says everything at once; persistence is judged by progress | Fix all errors in one pass; loops must show progress |
| §118.30 | A refusal that names the fault without the remedy costs a round trip | Error messages must say what to do |
| §118.49 | A test of a function body without its caller tests nothing | Test through the real entry point |
| §118.90 | `npm test` used to write to the client's DB | Local-only DB guard, no exemptions |
| §118.148 | All payments through the centre, all BCs through a validation centre | See invariants 1–2 |
| §118.151 | Read and write a status in the same statement | Conditional `updateMany` for transitions |
| §118.153 | Walk each employee's journey — half the defects were invisible to Super-Admin tests | Test as real roles; AI Super-Admin-only |
| §118.155 | Three weeks of blocked deploys from one unread lint line | Always run `npx next lint` |
| §118.172 | A button had one cause shared by five screens | Fix at the shared cause; lock buttons until fresh data |
| §118.176 | Finances: the costliest defect was the *direction* of old data | Ledger entries carry entity + account |
| §118.204 | Replay the whole purchase chain through real entry points | End-to-end flow tests |

---

## 7. Development workflow (as practised)

- **Branches**: no `main`. Feature work happens on `claude/*` branches (and `dy` for the human developer youcef-dy),
  merged into **`claude/hopeful-goodall-phd0nb`**, which Render deploys (`render.yaml` header). Other remote branches:
  `checkpoint`, `claude/adam-audit-chantier-wf8n33`, `claude/docs-split-et-ameliorations`, `claude/gallant-galileo-yjqlgk`.
  Contributors in the (shallow) history: Claude (120), AmineDJM (49), youcef-dy (17). [V GitHub API + git log]
- **Commit style**: historically French sentence-style "Module : ce qui change" ; since Oct 22 conventional commits
  (`feat(agent): …`). Large doctrine comments (`═══` banners, French) explain *why* in-place. [V]
- **No CI** (no `.github/`). The gate is local: `npm run typecheck && npm run build && npm test`, then `npx next lint`
  (CLAUDE.md). Render's own build is the last line of defence. [V]
- **Maps to refresh after a large batch**: README (`docs/readme/`) + Graphify (`npm run graphify:refresh`, commit artefacts),
  and now this knowledge base.

### Baseline health at HEAD `41b2ef0` (run by the orchestrator, 2026-10-24, local Postgres 16, Node 22)

| Check | Result |
|---|---|
| `npx next lint` | ✅ clean — "No ESLint warnings or errors" [V] |
| `npx tsc --noEmit` (full, = `npm run typecheck`) | ❌ **6 errors**, all in test files `src/lib/agent/integration.test.ts` (5) and `src/lib/agent/role-config.test.ts` (1), from commits b455d23/2ef5f3a (Oct 23). The deploy typecheck `tsconfig.build.json` excludes tests, so production builds are not blocked. [V] |
| `prisma migrate deploy` on an empty DB | ✅ all 462 migrations apply [V] |
| `prisma migrate diff` DB → schema | 664-line representational drift (see ch. 03 addendum) [V] |
| `npm test` (full Vitest suite, DB available) | ❌ 11 / 1,222 files, 12 / 14,393 tests fail — attribution in §7.1 [V] |
| `npm run build` (clean) | ✅ passes (963 s); no middleware emitted — see §7.1 [V] |

### 7.1 Test & build results

**`npm test`** (local Postgres 16 with all migrations, 4 vCPU, 921 s): **1,222 files — 11 failed · 1,210 passed · 1 skipped;
14,393 tests — 12 failed · 14,354 passed · 27 skipped.** [V] Re-running the 11 failing files at **`5f80e5c`** (the last
commit before the Oct 22–24 assistant work) attributes them:

| Introduced by the Oct 22–24 commits (pass at `5f80e5c`) — 7 tests | Already red at `5f80e5c` (pre-existing) — 5 tests |
|---|---|
| `src/lib/adam-visibilite.test.ts` — pages/segment must refuse before loading (§118.49, R3) | `src/platform/boundary.test.ts` — Adam↔ERP import debt ceiling |
| `src/lib/models/passerelle-unique.test.ts` ×2 — a module outside `models/` opens its own provider connection (beta → MiMo) | `src/platform/domains.test.ts` — cross-domain crossings > 68 |
| `src/lib/sortie/garde.test.ts` — a network-sending module bypasses the egress guard | `src/lib/actions/contrat.test.ts` — the two action inventories disagree |
| `src/lib/actions/generique.test.ts` — a schema model that "smells of rights" is unclassified | `src/lib/assistant/action-parity.test.ts` — an existing server action is unclassified |
| `src/lib/vue-exacte-etanche.test.ts` — personal `localStorage` data under a shared key | `src/lib/queries/aujourdhui-espace-flow.test.ts` — "Aujourd'hui" visibility for a delegate |
| `src/platform/in-process/missions/sorties-declarees.test.ts` — declared capability output field doesn't exist | |

Caveat: the `5f80e5c` re-run used HEAD's generated Prisma client and database (the Oct 22–24 commits add one migration,
`20270126100000_assistant_role_config`). Most of these are source-reading ratchets, so the attribution is robust. [V]

Remember that without a reachable Postgres, 397 DB-backed suites skip silently and `npm test` can look green. [V·agent 10]

**`npm run build`** (clean `.next`, `rm -rf .next` first): ✅ **passes** in 963 s (256 static pages generated). [V]
The emitted `.next/server/middleware-manifest.json` is `{"middleware": {}, "sortedMiddleware": []}` — **empirical proof
that no middleware is compiled** (risk R5). [V]

---

## 8. Consolidated risk register

Severity is the orchestrator's judgement. The analysis itself changed no code; R1, R2 and R4 were then fixed at the user's
request on the same branch (see `docs/readme/30-journal-des-evolutions-recentes-p01.md`, entry of 2026-10-24).

| ID | Sev. | Area | Finding | Status | Where |
|---|---|---|---|---|---|
| **R1** | High | Security / documents | **OnlyOffice save callback**: the same 24 h token is minted for view *and* edit mode and exposed in `document.url`; `/api/onlyoffice/callback` (public) accepts an **unsigned** body, `fetch(body.url)` any URL (**SSRF**), and writes a new file version without re-checking edit rights → a view-only user can overwrite a file. | [V·orch] · ✅ **Fixed 2026-10-24** on `claude/magical-cray-1v5ld6`: read vs save tokens, mandatory DS signature, rights re-check, DS-host-only fetch (`lireRappelOnlyoffice`, `peutEnregistrerOnlyoffice`) | ch. 08, 02 R2 |
| **R2** | High | Security / files | **Stored XSS**: files served `inline` with their stored MIME (`src/lib/http/telechargement.ts:79,107`), SVG mapped to `image/svg+xml` (`drive/mime-nom.ts:16`), CSP has no `script-src` (`next.config.mjs:131-145`) → an uploaded HTML/SVG runs same-origin in the opener's session. | [V·orch] · ✅ **Fixed 2026-10-24**: `lib/http/types-actifs.ts` (sandbox CSP + nosniff for active types; forced download on presigned bucket URLs), applied to `repondreFichier` and every inline route, ratchet test | ch. 02 R1 |
| **R3** | High | AI governance | Commit `fa9b9ab` (Oct 24) removed `peutVoirAdam` from `/assistant` (now `requireModule("WORKSPACE")`); a welcome pop-up sends every user there. The beta's actions only `requireUser()` and post ERP context **directly to `token-plan-ams.xiaomimimo.com`** (`assistant/beta/actions.ts:283`), bypassing the model gateway, kill switches, egress guard (`sortie/garde`) and cost logging; client-supplied history forwarded as-is; beta write executor (`lib/agent/ecritures.ts`) doesn't re-check rights or the emergency stop. Guard tests turn red. | [V·orch] guard removal + direct fetch; rest [V·agent 09] · **Needs a product decision** | ch. 09 |
| **R4** | Med-High | Finance | **Double settlement race** in `settleExpenseOrder`: check-then-act across several awaits, unconditional `update` by id, no transaction → two SETTLED OUT ledger entries possible. Same shape in `decidePaymentRequest`. | [V·orch] race reproduced in a test on the old code · ✅ **Fixed 2026-10-24**: atomic claim + ledger write in one transaction; `decidePaymentRequest` conditional write (`actions/reglement-concurrent-flow.test.ts`) | ch. 06, 04 |
| **R5** | Medium | Security / platform | **Root `middleware.ts` is never compiled** (Next 14.2.35 and 15.5.28 look in `src/` only: `node_modules/next/dist/build/index.js:548` on 15.5.28). The `authorized` whitelist in `src/auth.config.ts` is dead code; protection rests entirely on per-page/route guards. Agent audit of all 129 handlers + 11 non-(app) pages found no unauthenticated business-data route. Moving the middleware into `src/` *as written* would break `/api/v1`, `/invite`, `/api/mail/inbound`, `/api/google/pubsub`, `/api/events/inbound`. | [V·orch] Next source + empty `middleware-manifest.json` after a clean build; route audit [V·agent 02] | ch. 02, 10 |
| R6 | Medium | API | `/api/v1/documents/{id}/content` skips the entity access check for ~43 entity types missing from the API registry. | [V·agent 02] | ch. 02 R3 |
| R7 | Medium | Auth | Demoted Super Admin keeps "Vue exacte" (role read from JWT); `toggleUserActive` doesn't revoke sessions and session checks ignore `isActive`. | [V·agent 02] | ch. 02 R4–R5 |
| R8 | Medium | HR data | `/rh/[id]` ships full salary data (gross, SS, IBAN, NIN) to anyone with `EMPLOYEES:UPDATE`, while salary visibility elsewhere requires `RH:UPDATE/VALIDATE`. `processHrRequest` checks neither perimeter nor status. | [V·agent 08]; real role configs [U] | ch. 08 |
| R9 | Medium | Data | `deleteDepartment` hard-deletes and DB cascades petty-cash/expense history without a trash snapshot; deleting a Company cascades to 18 tables. Single-row trash path not transactional (snapshot after delete). | [V·agent 03/11] | ch. 03, 11 |
| R10 | Medium | Crypto / config | Encryption keys derive from secrets with **different precedence** (`drive-storage.ts` prefers `NEXTAUTH_SECRET`, `secret-box.ts` prefers `AUTH_SECRET`) and fall back to fixed strings; `AUTH_SECRET` rotation breaks files/secrets. Bootstrap default admin `admin@adventum.dz` / `ChangeMe123!` if `ADMIN_*` unset (forced change). | [V·agent 08/10/02] | ch. 10 |
| R11 | Medium | Correctness | Dates: `formatDate`/`formatDateTime` (`src/lib/utils.ts:55-79`) pass no `timeZone`, no `TZ` set on Render, 178 raw `toLocale*String` calls → server-rendered times likely 1 h behind Algiers, date shifts near midnight. | [V·orch] code; runtime TZ [U] | ch. 05 |
| R12 | Medium | Ops | Scheduler is an in-process 60 s `setInterval` started by the first `/api/messaging/sync` poll — not by the health check; free plan sleeps → jobs pause; ~~early steps lack `.catch`~~ (fixed by V2-F: per-task isolation). **V2-F (2026-10-27)**: opt-in worker (`npm run worker`, `TACHES_DE_FOND`), per-task DB lease → the scheduler no longer assumes one instance; health at `/api/health/worker`. Other components still assume **one instance** (ref queue, typing indicator, event bus, usage buffer). | [V·agent 10/09/03] | ch. 10 |
| R13 | Medium | Finance controls | Separation of duties not enforced per person: `DIRECTION` sits on the payment centre, has full Finances rights and is an Ad & Pro step; Super Admin can act at every step. `decidePayment` has no company scope check. Refused payments stay "pending" → still counted as committed. Ledger entries editable/deletable without link back. | [V·agent 06] | ch. 06 |
| R14 | Low-Med | Various | Supplier portal login unthrottled; delegated admin can self-assign a payment-centre seat; legal-expiry sweep capped at 300 oldest docs (silently stops reminding); `getAppSettings` returns defaults on DB error (e.g. BC threshold → 0); CHANGES_REQUESTED audited as `VALIDATE` → may wake missions; daily stock state duplicates (no unique); Marketing cockpit "Marché" tab gated on retired module; Produits 360 "ventes" section mapped to retired `SALES`; site inbound HMAC skipped with fallback key + empty `ADVENTUM_WEBHOOK_SECRET`. | [V·agent 02/06/07/08/11] | resp. chapters |
| R15 | Process | Quality gates | No CI; `npm test` is green without Postgres (397 DB suites `describe.skip`); full typecheck red at HEAD; **which build command Render really runs is ambiguous** (`render.yaml` says `build:render` with blocking lint; `next.config.mjs:9,175` says the dashboard runs a bare `npx next build`); migrations run *before* lint/typecheck/build on deploy; boundary debt ceiling crept 424 → 425 (and is now exceeded, 433). | [V·orch] partially; [V·agent 10] | ch. 10 |

---

## 9. Existing documentation: what is stale

Treat `docs/readme/*` as the functional map but **re-verify numbers and paths**. Confirmed stale (details in each chapter §9):
`29-architecture-du-code.md` (93 models / 54 action files / 32 routes — now 433 / 176 / 121), `26-base-de-donnees-migrations.md`
(69 migrations; recipe names folders with today's date and uses `migrate diff` → wrong), `28-tests-qualite.md` (229 test
files → 1,222), `23-variables-d-environnement.md` (Anthropic-centric, missing `MICROSOFT_*`, `GOOGLE_*`, `S3_DIRECT_*`,
`SCHEDULER_*`, …; `SMTP_*` in `.env.example` is never read), `24-deploiement-render.md` (build command), `15-…ia` (Claude →
OpenAI is default), `docs/ADAM_PLATFORM_BOUNDARY.md` (123 files / one bridge file), `docs/api/*` (openapi misses
`/api/v1/operations/{op}`; writes exist; no rate limiting; no webhook sender), `docs/UI_UX_AUDIT.md` (Aug 2026 counts).
Comments in `middleware.ts`/`auth.config.ts` describe an edge gate that does not run (R5).

---

## 10. Open questions for the team (need a human answer)

1. **R3** — Is opening the assistant (Adventum Brain beta, Xiaomi MiMo) to all users a deliberate Direction decision that
   supersedes §118.153? If yes, the gateway/kill-switch/egress/visibility tests and doctrine must be updated; if no, revert.
2. Which **build command and branch** does the Render dashboard actually use (blueprint `build:render` vs bare `npx next build`)?
3. How many **instances** run in production, and is the plan still free (sleeping)? (scheduler, ref queues, typing state)
4. What is the server process **time zone** on Render (UTC expected)?
5. Was `middleware.ts` ever meant to run (was it once under `src/`)? Should edge auth be restored (with a corrected whitelist)?
6. Are push-less notifications (tasks, directives, salary advances) and "no e-mail notifications" intentional?
7. Should the legacy 17-row `RegulatoryStep` table and its readers be retired (KPIs can disagree with the 19-step ANPP status)?
8. Production data volumes that change risk ranking: expired legal documents (>300?), largest direct-upload files read through `getBlob`.

---

## 11. Reading guide

| If you are about to… | Read first |
|---|---|
| touch permissions, a guard, an API route, uploads | 02, then 04 §4 |
| add/alter a model or migration | 03 (+ addendum) |
| add a screen / module / server action | 04 §10 recipe, 05 checklist, 11 appendix |
| change Ad & Pro, budgets, payments, BC, invoices | 06 |
| change regulatory, products, PCH, stocks, segmentation, field force, site web | 07 |
| change HR, messaging, drive/files, OnlyOffice, mail, calendar, legal | 08 |
| touch Adam / missions / models / `src/platform` | 09 (+ doctrine docs) |
| change build, env, scheduler, tests, deploy | 10 |
| estimate blast radius of any change | 11 (coupling map + impact playbook) |
