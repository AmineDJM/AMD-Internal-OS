# 04 — Backend application conventions: pages, server actions, queries, API routes

> Knowledge-base chapter. Written 2026-10-24 against `HEAD 11a281d`. Read-only analysis; every
> `[V]` claim was checked in the code at the cited `path:line`, `[U]` claims are inferred or not
> runtime-tested. French identifiers are kept verbatim, with a short gloss the first time they
> appear.

---

## 1. Scope

How a feature is built end to end in AMD Internal OS:

- the `src/app` tree: route groups, layouts, the ~79 module folders under `src/app/(app)`, how a
  page is put together, error and not-found handling, tabs driven by `searchParams`, dynamic `[id]`
  segments, redirect stubs and retired modules;
- server actions (`src/lib/actions/*`, plus about 20 other `"use server"` modules): the usual
  skeleton, the result shape they return, how errors reach the UI;
- the query layer (`src/lib/queries/*`): caching, pagination, `Decimal` conversion;
- every HTTP route under `src/app/api/**` (121 `route.ts`), and the external agent REST API
  `/api/v1` compared with `docs/api/*`;
- the helpers that actions import most (`refs`, `audit`, `notify`, `labels`, `utils`, `formats`,
  `http`);
- naming, TypeScript/ESLint/tsconfig settings, how tests are placed and gated;
- a recipe for adding a module or feature, built only from patterns seen in the code.

RBAC internals (`rbac.ts` scoping, company scoping), the Mission Runtime/Adam agent and Prisma
modelling are other chapters' subjects. They appear here only where an action or route touches
them.

## 2. Summary

- **Pages** are async RSC `page.tsx` files. They are guarded by `requireModule(MODULE)` (199 of
  283 pages) or `requireUser()` plus an entity check (46). They load data with Prisma, directly or
  through `src/lib/queries/*`, and pass plain props to `"use client"` components. 304 files set
  `export const dynamic = "force-dynamic"`. There is no data cache at all: no `unstable_cache`, no
  `revalidateTag`, only per-request `React.cache`. [V]
- **Server actions**: 176 `*-actions.ts` files hold 1,147 exported `async function`s. They take a
  `FormData` and return `ActionResult {ok, error?, id?, message?, redirect?, …}`
  (`src/lib/actions/types.ts:4`). They **never throw for business refusals** and **never call
  `redirect()`**. Input parsing is hand-written with the `fdStr/fdNum/fdDate/fdCase` helpers.
  **Zod is not used** in actions: `src/lib/validations/` holds approval-workflow logic, not input
  schemas. [V]
- **Canonical order inside an action**: `requireUser()` → `userCan`/domain guard → parse →
  load + entity/state check → write (sometimes `$transaction`, sometimes a conditional
  `updateMany` lock) → `recordAudit` (this also feeds the event ledger) → `notifyUser/notifyRoles`
  → `revalidatePath` → `return {ok:true,id}`. [V]
- **UI**: `useFormState` inside `CreateRecordButton`, or the `useAction()` hook. Both guard against
  a thrown action and a 45-second timeout, with a message that says "check the list before you
  resubmit" (`src/lib/action-outcome.ts`). Several screens still use a hand-written
  `await fn(); setBusy(false)` with no `try`. [V]
- **API**: 121 route handlers. Session routes use `getCurrentUser()` for reads and
  `getCurrentUserPourEcrire()` for writes. `/api/v1` is a bearer-key API built on `handle()`
  (`src/lib/api/http.ts:44`) with scopes, a call journal and optional idempotency. It has **no rate
  limiting** and **no webhook emitter**. [V]
- **Top risk found**: the edge middleware (`middleware.ts` + `src/auth.config.ts:16-58`) exempts
  only `/portail`, `/inscription`, `/api/events/qr`, `/meet/`, `/api/site-web/v1/` and two
  OnlyOffice paths. `/api/v1/**` (bearer keys), `/api/mail/inbound`, `/api/events/inbound/*` and
  `/api/google/pubsub` are *documented and coded as public*, but a cookie-less request to them
  should get a 307 redirect to `/login` (§9, item D1). [V code / U runtime]

## 3. Key files

| Path | Role |
|---|---|
| `middleware.ts` | Edge auth: `NextAuth(authConfig).auth`, matcher excludes only `api/auth`, `_next`, images. |
| `src/auth.config.ts:16` | `authorized()` callback: the list of public path prefixes. |
| `src/app/(app)/layout.tsx` | Authenticated shell: `requireUser`, onboarding redirect, `navigationFor(user)`, badges, providers. |
| `src/app/(app)/error.tsx`, `src/app/(app)/not-found.tsx`, `src/app/not-found.tsx` | The only error and not-found boundaries. There are **no `loading.tsx`** files. |
| `src/app/(portal)/layout.tsx`, `src/lib/supplier-auth.ts:84` | Supplier portal, with its own cookie session (`requireSupplier`). |
| `src/lib/session.ts:205-271` | `requireUser`, `requireUserAuNomDeLaVue`, `requireModule`, `getCurrentUser`, `getCurrentUserPourEcrire`; handles the "Vue exacte" (Super Admin impersonation view). |
| `src/lib/rbac.ts:29,185,249,1344,1712` | `MODULES`, `ACTIONS`, `PERMISSIONS`, `getAccess` (per-request cached), `userCan`. |
| `src/lib/entity-access.ts:36,516` | `ENTITY_MODULE: Record<EntityType, Module>`, `canAccessEntity` (row-level). |
| `src/lib/labels.ts:1739,1920,2256,2273` | `MODULE_LABELS`, `NAVIGATION` (sidebar + tabs), `moduleForPath`, `firstAccessibleHref`; plus about 150 enum→label maps. |
| `src/lib/nav-access.ts`, `src/lib/nav-tabs.ts:15` | Which nav entries and tabs a user sees (RBAC + gates + feature flags). |
| `src/lib/modules-retired.ts:45`, `src/lib/modules-visibility.ts:51,109` | Retired modules (code decision), hidden modules (admin setting). |
| `src/lib/actions/types.ts` | `ActionResult` and the FormData parsers `fdStr/fdNum/fdDate/fdBool/fdCase`. |
| `src/lib/action-outcome.ts` | Pure module: failure wording (`actionFailureMessage`), `ACTION_TIMEOUT_MS = 45_000`. |
| `src/components/shared/use-action.ts:29,83` | `useAction()` / `useKeyedAction()`: client wrapper around an action (catch + timeout + refresh). |
| `src/components/shared/create-record-button.tsx:331-433` | Generic create dialog: `useFormState` with a guarded action, then navigate to `${redirectBase}/${id}`. |
| `src/lib/audit.ts:23,63,91` | `recordAudit` (best-effort) → `emettreFait` (event ledger) ; `recordFieldChanges`. |
| `src/lib/notify.ts:19,84` | `notifyUser` (row + PWA push), `notifyRoles`. |
| `src/lib/refs.ts:23,32,68` | `buildRef("SUP", year, existing)`, `createWithRetry` (P2002 retry), `enSerie` (in-process serial queue). |
| `src/lib/utils.ts:116` | `toNumber` (Prisma `Decimal` → number), plus `formatCurrency/formatDate/…`. |
| `src/lib/chemins/*.ts` | Pure route-constant modules (`CHEMIN_*`, `lien*()`), so notification links have one source. |
| `src/lib/entity-href.ts:28` | `entityHref(type,id)`: the canonical URL of an entity (checked by `src/lib/ui/dead-links.test.ts`). |
| `src/lib/api/{http,auth,scopes,errors,query,openapi}.ts`, `src/lib/api/registry/*` | The `/api/v1` framework. |
| `src/lib/assistant/action-registry.ts:2094` | `ACTION_CLASSIFICATION`: every exported action must be classified (enforced by a test). |
| `src/lib/actions/contrat.genere.json`, `aiguillage.genere.ts` | Generated contract and loader for all 1,145 actions (`npm run actions:contrat`). |
| `next.config.mjs`, `tsconfig.json`, `tsconfig.build.json`, `.eslintrc.json`, `vitest.config.ts`, `render.yaml` | Build and lint settings (§5.8). |

## 4. How it works

### 4.1 `src/app` layout and route groups

- `src/app/(app)/`: the authenticated ERP shell. It holds 79 module folders plus `layout.tsx`,
  `error.tsx` and `not-found.tsx`, and 283 `page.tsx` in total. Folder names are French URL slugs
  (`centre-de-paiement`, `moyens-generaux`, `bons-de-commande`), with some legacy English ones
  (`sales`, `logistics`, `field-reports`, `business-development`). [V]
- `src/app/(auth)/login`: the login form, which uses `useFormState`. [V]
- `src/app/(portal)/portail`: the external supplier portal. Its layout is deliberately bare
  (`(portal)/layout.tsx`), and pages call `requireSupplier()`, which redirects to
  `/portail/login`. The middleware skips `/portail` (`auth.config.ts:23`). [V]
- Top-level folders outside any group, one page each: `change-password`, `onboarding`,
  `invite/[token]` (has its own `actions.ts`), `inscription` (public event sign-up), `meet` (Jitsi
  guest), `impression/coaching/[id]` (print view), `office-embed`. `src/app/page.tsx` sends the
  user to `/aujourdhui` or `/mon-espace` depending on the `HOME_TODAY` feature flag. [V]
- `src/app/api/`: 40 top-level groups, 121 route handlers (§4.6). [V]

**The `(app)` shell** (`src/app/(app)/layout.tsx:41-…`), in order:

1. `requireUser()`.
2. Redirect to `/change-password` if `mustChangePassword`.
3. Redirect to `/onboarding` if `mustOnboard` is set (read live from the database, skipped under
   impersonation).
4. `navigationFor(user)` builds the sidebar from RBAC, hidden modules, gates and tabs.
5. A `Promise.all` loads unread counts, the adoption badge and the user's companies.
6. Sidebar, topbar, banners and the upload, call and push providers are mounted. [V]

### 4.2 How a page is put together

Typical list page (`src/app/(app)/support/page.tsx`): [V]

```tsx
export const dynamic = "force-dynamic";
export default async function SupportPage() {
  const user = await requireModule("SUPPORT");              // guard: login + RBAC + hidden module
  const [requests, users] = await Promise.all([getSupportRequests(user), prisma.user.findMany(...)]);
  return (<PageHeader …><CreateRecordButton action={createSupportRequest} redirectBase="/support" fields={[…]} /></PageHeader> …);
}
```

- **Guard.** `requireModule(module, action="VIEW")` (`session.ts:239`) does four things in order:
  redirect to `/login` if there is no session; redirect to `/change-password` if required;
  redirect to `safeLanding(user)?denied=MODULE` if `!userCan`; redirect with `?masque=` if an admin
  has hidden the module (the Super Admin is exempt). `safeLanding` walks `NAVIGATION` and picks
  the first href the user can see, so there is never a redirect loop (`session.ts:228`). [V]
- **Detail pages** (`[id]`, 49 folders) usually call `requireUser()`, then load the record, then
  run an entity-level check and call `notFound()` if it fails. They do **not** use
  `requireModule`. Example: `support/[id]/page.tsx:23-27` (`getSupportRequest` →
  `canViewSupport` → `notFound()`). `validations/paiements/[id]/page.tsx` computes
  `isFinance/isRequester` inline. One consequence: an admin-hidden module stays reachable through
  its detail URLs (§8). [V]
- **Data.** Pages either call `src/lib/queries/*` loaders (`getSupportRequests(user)` applies
  `scopeSupport(user)` and `platformScope(user.id)`) or call `prisma.*` inline. Both styles are
  common. [V]
- **Client components** sit next to their page (`support/[id]/panel.tsx`,
  `validations/paiements/[id]/dossier.tsx`). They import server actions directly from
  `@/lib/actions/*`. They must not import Node-only modules: `client-bundle-guard.test.ts`
  enforces this (see CLAUDE.md). [V]
- **Delegated pages.** Some pages hand the whole job, guard included, to a shared server
  component, e.g. `congress-national/[id]/devis/page.tsx` renders `<PageDevisPriseEnCharge …/>`, or
  to a platform composer (`chief-of-staff/inbox/page.tsx` calls `ouvrirInbox()`). [V]
- **Tabs driven by `searchParams`.** 101 pages read `searchParams`. A tab is a validated
  allow-list read, e.g.
  `const vue = (VUES as readonly string[]).includes(searchParams?.vue ?? "") ? … : "circuits"`
  (`process-intelligence/page.tsx:27`, `marketing-cockpit/page.tsx:65`). `?vue=` appears in 19
  files and `?bu=` in 17. Route-level tabs are declared as `NavTab[]` in `labels.ts`
  (e.g. `SITE_WEB_TABS`, `ANNUAIRES_TABS`) and filtered by `visibleTabs()` (`nav-tabs.ts:15`). [V]
- **Loading, error, not-found.** There is no `loading.tsx` anywhere; navigation feedback comes
  from `NavProgress` in the layout. `(app)/error.tsx` is the single error boundary: French message,
  `reset()`, and `error.digest` shown as "réf." (reference). `(app)/not-found.tsx` renders
  `notFound()` inside the shell. [V]
- **Redirect stubs.** Old URLs are kept as tiny pages (6 to 13 lines) that only call
  `redirect(...)`, e.g. `comptabilite/page.tsx → /finances`,
  `finances/paiements/[id] → /validations/paiements/[id]`,
  `planning/messages → /marketing-cockpit?vue=messages`. At least 30 such stubs exist. Targets are
  often taken from `src/lib/chemins/*` (`CHEMIN_RAPPORTS_TERRAIN`, `lienRapportTerrain(id)`).
  There are **no** `redirects()` in `next.config.mjs`. [V]
- **Retired modules** (`SALES`, `LOGISTICS`, `BUSINESS_DEVELOPMENT`; `modules-retired.ts:45`).
  Their pages still exist and still call `requireModule("LOGISTICS")`. `getAccess` skips retired
  modules (`rbac.ts:1275`), so `userCan` is false for everyone, the Super Admin included, and the
  guard redirects to `safeLanding?denied=…`. The data stays. One slug was reused:
  `src/app/(app)/sales/page.tsx` is now "Ventes PCH" under module `PCH_VENTES`. [V]

### 4.3 Server actions

**Inventory.** [V]

- `src/lib/actions/` holds 183 `.ts` files outside tests. 176 of them start with `"use server"`.
  The other 7 are infrastructure: `types.ts`, `contrat.ts`, `contrat-scan.ts`,
  `contrat.genere.ts` (+ `.json`), `generique.ts`, `executer.ts`, `aiguillage.genere.ts`.
- They export 1,147 `async function`s; the generated contract lists 1,145, of which 1,041 write.
- 114 colocated `*.test.ts` files.
- About 20 more `"use server"` modules live elsewhere:
  - `src/lib/regulatory/intelligence/**/actions.ts` (14);
  - `src/platform/in-process/{inbox,quality,artifact}/actions.ts`;
  - `src/app/invite/[token]/actions.ts`, `src/app/(app)/assistant/beta/actions.ts`,
    `src/app/(app)/admin/ai/health-actions.ts`.
- Biggest files: `ad-pro-item-actions.ts` (4,454 lines), `care-actions.ts`,
  `regulatory-actions.ts`, `recruitment-actions.ts`, `admin-request-actions.ts`,
  `payment-request-actions.ts` (about 1.2–1.5k lines each).

**Signatures.** Two forms exist:

- `(formData: FormData) => Promise<ActionResult>`, used by `useAction` and `onClick` callers;
- `(_prev: ActionResult | undefined, formData: FormData)`, used by `useFormState`, e.g.
  `createSupportRequest` (`support-actions.ts:46`) and `createPaymentRequest`
  (`payment-request-actions.ts:183`). Create actions wired to `CreateRecordButton` use this one.

**Result shape.** `ActionResult` (`types.ts:4-23`): `ok`, `error?` (French sentence shown as-is),
`id?` (used for navigation), `message?` (an informational success sentence), `redirect?` (where
to go when the object no longer exists), plus domain fields (`factureConnue`, `avertissement`,
`ecartMontant`). [V]

**Canonical skeleton** (seen in `support-actions.ts`, `payment-request-actions.ts`,
`promo-devis-actions.ts`):

1. **Who.** `const user = await requireUser()`, used by 174 files. Use `requireUserAuNomDeLaVue()`
   only for actions that *create a request* under the "Vue exacte" (7 files, §118.184). Actions
   never call `requireModule`, which would redirect. [V]
2. **May they.** `if (!userCan(user, "SUPPORT", "CREATE")) return { ok:false, error:"Non autorisé." }`
   (99 files), or a domain predicate such as `isFinance(user)` (`payment-request-actions.ts:61`),
   `isResponder`, or `canAccessEntity` (54 files). [V]
3. **Parse.** `fdStr/fdNum/fdDate/fdCase`, followed by allow-list checks on enums
   (`CATEGORIES.includes(category)`) and required-field checks. Each failure returns a French
   error. [V]
4. **Load + state check.** `findUnique` → `"… introuvable."`. State transitions go through *pure*
   functions in a domain module: `nextPaymentStatus(from, move)` and `canApprove(...)` in
   `src/lib/finance/payment-request.ts:67,147`; `canDecideFromDossier` in `finance/dossier-auto`. [V]
5. **Write.** Three styles are seen:
   - plain `prisma.x.create/update`, the majority;
   - `prisma.$transaction(async (tx) => …)` in 77 files;
   - a conditional `tx.x.updateMany({ where: { id, state: EXPECTED } })` used as an optimistic lock,
     plus a custom `Error` subclass thrown to abort, plus a compensation in the `catch`
     (`promo-devis-actions.ts:424-481`, `RefusDevis` at `:103`).

   References come from `buildRef` / `createWithRetry` / `enSerie` (`refs.ts`). [V]
6. **Trace.** `recordAudit({ actorId, action, module, entityType, entityId, summary })`: 902 call
   sites, 151 action files. The domain may also write its own thread (`trace()` →
   `paymentRequestEvent`, `payment-request-actions.ts:87`). [V]
7. **Tell.** `notifyUser` / `notifyRoles`. Both are best-effort and never throw (`notify.ts`). [V]
8. **Refresh.** A local `revalidate(id)` helper calls `revalidatePath` on the list, the detail page
   and sometimes `/mon-espace` or `/validations`. There are 1,289 `revalidatePath` calls, 6 of them
   `("/", "layout")`. [V]
9. **Return** `{ ok:true, id }` or `{ ok:true, id, message }`. No action imports `next/navigation`;
   navigation happens client-side from `id` or `redirect`. [V]

Some actions wrap the whole body in `try { … } catch { console.error(...); return { ok:false,
error:"… n'a pas pu être enregistrée." } }` (`decidePaymentRequest`, `:896/999`). Others let
unexpected errors throw, and the client guard catches them (§4.4). [V]

**Shared business core.** When the same write is reachable from a screen *and* from the API or an
agent, it is moved into a `xxxFor(user, input): Promise<ActionResult>` function in a domain module.
The action then only resolves the user, parses `FormData` and calls it. Example:
`createMailEntryFor` (`src/lib/mail-register/write.ts:154`) is called by
`mail-register-actions.ts:115` *and* by `src/lib/api/registry/operations.ts:89`. 11 action files
follow this `…For(user` pattern. [V]

**Action registries that must stay in sync.** Tests enforce both:

- `src/lib/assistant/action-registry.ts` must classify every `file:function`
  (NATIVE/COVERED/GAP/EXCLUDED). `src/lib/assistant/action-parity.test.ts:52-71` scans the folder
  and fails on any unclassified or stale key. The GAP ratchet is `0`. [V]
- `contrat.genere.json` / `aiguillage.genere.ts` are produced by `npm run actions:contrat`
  (`scripts/actions-contrat.ts`). `contrat.test.ts` re-derives them and fails on drift;
  `executer.test.ts` resolves all 1,145. [V from file headers; tests not run]

### 4.4 How errors reach the UI

- **`CreateRecordButton`** (`create-record-button.tsx`). The action is wrapped in `guarded()`
  (`:345-361`), which catches a throw and returns `{ok:false, error:"L'enregistrement n'a pas
  abouti … VÉRIFIEZ D'ABORD LA LISTE …"}`. That is passed to
  `useFormState(guarded, undefined)` (`:362`). On `ok` it calls `router.push(redirectBase/id)` or
  `router.refresh()` (`:419-433`). `state.error` is rendered inline (`:550`). A separate timer
  covers the "never answered" case. [V]
- **`useAction()`** (`use-action.ts:29-79`). `run(fn, onOk)` sets `saving`, starts a 45-second
  timeout that shows `actionFailureMessage("TIMEOUT")`, catches a throw and shows
  `actionFailureMessage("THROWN")`, and otherwise sets `err = r.error ?? "Action impossible."`. On
  success it calls `rafraichir()`, which keeps the button busy until fresh data is on screen
  (§118.172). `useKeyedAction()` is the multi-button variant. Used in about 10 files. [V]
- **Hand-written runners** still exist, e.g. `validations/paiements/[id]/dossier.tsx:237-254`
  (`run(key, fn, fields)`) and `NudgePanel` (`:101-110`): `const r = await fn(fd); setEnVol(null);`
  with **no try/catch and no timeout**. That is the exact defect `use-action.ts` documents. [V]
- **No toast library.** Errors appear as inline `<p className="… text-destructive">`. All wording
  is French and addressed to the reader, e.g. "Un refus se motive : c'est ce que lira le
  demandeur." (a refusal needs a reason: it is what the requester will read). 4,678
  `ok: false, error:` returns across the actions. [V]
- **Page-level errors** go to `(app)/error.tsx`; missing records go to `notFound()` and
  `(app)/not-found.tsx`. [V]

### 4.5 Query layer (`src/lib/queries/*`)

- 124 modules plus 34 tests. Plain server modules: no `"use server"` (two files explain in comments
  why they deliberately are not one, `ad-pro-suppression.ts:22`, `suppression-piece.ts:17`) and no
  `server-only` import anywhere in `src/lib`. [V]
- **Signature convention**: loaders take a `SessionUser` and apply RBAC row scope and company
  scope inside the `where`, e.g. `where: { AND: [scopeSupport(user), await platformScope(user.id)] }`
  (`queries/support.ts:7`). Visibility predicates for detail pages live next to the loader
  (`canViewSupport`, `isSupportResponder`) so the page and the action share them. Shared
  visibility clauses live in `queries/visibilite-listes.ts`, `regulatory-visibilite.ts`,
  `stock-portee.ts`. [V]
- **Typed results**: `export type SupportDetail = NonNullable<Awaited<ReturnType<typeof getSupportRequest>>>` (`support.ts:30`). [V]
- **Caching**:
  - no `unstable_cache`, `revalidateTag` or `noStore` in production code; they appear only in
    `vi.mock("next/cache")` inside tests;
  - per-request memoisation only, through `React.cache`: `getAccess = perRequest(...)`
    (`rbac.ts:15,1344`), plus `company.ts`, `settings.ts`, `features.ts`, `departments.ts`,
    `session.ts`;
  - freshness comes from `force-dynamic` on pages and `revalidatePath` in actions. [V]
- **Pagination**: mostly `take:` caps (223 `take/skip/cursor` occurrences). Real offset paging is
  rare (`queries/mes-taches.ts:300`). The `/api/v1` list uses `limit` (default 50, max 500) and
  `offset` (`src/lib/api/query.ts:16-28`). [V]
- **Decimal → number**: `toNumber(value)` (`utils.ts:116`) accepts Decimal, number, string or null
  and returns 0 on null or NaN. 572 call sites, 45 of them in query files. Money is always
  converted before it reaches a client component or arithmetic. Writes go the other way with
  `new Prisma.Decimal(x)` (`promo-devis-actions.ts:410-420`). [V]
- **Aggregation**: one loader may run several `findMany` calls in a `Promise.all` and fold the rows
  in TypeScript, e.g. `queries/centre-paiement.ts:111,142` (`classerLesLignes`, `chargerCentre`). [V]

### 4.6 API routes, `src/app/api/**`

Auth modes:

| Code | Meaning |
|---|---|
| **S** | `getCurrentUser()` from `@/lib/session`, `401` if null |
| **S-L** | `identiteDuSondage()` from `@/lib/session-legere` — shell polls only (no access matrix; same revocation & Vue exacte) |
| **S-W** | `getCurrentUserPourEcrire()`, required for writing handlers by `session-vue-exacte.test.ts:120` |
| **S+R** | session plus `userCan(...)`, `403` if refused |
| **K** | `/api/v1` bearer API key via `handle()` |
| **H** | HMAC or shared-secret webhook |
| **T** | signed token in URL or body |
| **P** | public |
| **A** | raw `auth()` from NextAuth (telemetry) |

| Group (routes) | Methods | Auth | Purpose |
|---|---|---|---|
| `auth/[...nextauth]` (1) | GET/POST | NextAuth handlers | Login and session. Excluded from the middleware. |
| `activity` (1) | POST | A, returns 204 if no session | Page-activity telemetry. |
| `replay` (1) | POST | A | Session-replay batches. |
| `security/screenshot-attempt` (1) | POST | A | Screenshot attempt reporting. |
| `admin/{audit, mail-diagnostic, storage/cors-test, storage/self-test}` (4) | GET/POST/PATCH/DELETE | S/S-W + R | Admin diagnostics, audit export. |
| `annuaire/parties` (1) | GET | `requireUser` + R | Directory party lookup. |
| `artifact/[id]/{image/[imageId], page/[n]}` (2) | GET | S | Serve artifact renders. |
| `assistant/{stream, transcribe, voice/{log,session,tool,turn}}` (6) | POST | `requireUser` / S-W + R | Assistant streaming, speech-to-text, realtime voice. |
| `budgets/export`, `budgets/marketing/export` (2) | GET | S+R | XLSX exports. |
| `consommation/modele` (1) | GET | S+R | Import template download. |
| `documents/{[id], [id]/texte, [id]/texte/enregistrer, [id]/zip, upload, upload/direct, upload/direct/[id]}` (7) | GET/POST/DELETE | S / S-W | Generic document download, text edit, zip, chunked or direct upload. |
| `dossiers/message-attachment/[id]` (1) | GET | S+R | Attachment of a "Sujet" message. |
| `drive/{[id]/raw, [id]/texte, [id]/texte/enregistrer, [id]/zip, zip, upload, upload/claim, upload/direct, upload/direct/[id]}` (9) | GET/POST/DELETE | S / S-W | Drive storage I/O. |
| `events/[id]/export` (1) | GET | S+R | Event export. |
| `events/inbound/[source]` (1) | POST | H (per-source secret, 503 if unset) | Inbound third-party events. **Blocked by middleware?** See D1. |
| `events/qr/[token]` (1) | GET | T / P (middleware-exempt) | QR image for public sign-up. |
| `feedback/attachment/[id]` (1) | GET | S | Feedback attachment. |
| `field-reports/{[id]/transcribe, [id]/upload, attachment/[id]}` (3) | POST/GET | S-W+R / S+R | Field-report audio and attachments. |
| `google/{connect, callback}` (2) | GET | `requireUser` | Google OAuth. |
| `google/pubsub` (1) | POST | H (`verifyPubSubToken` + `?token=`) | Gmail push. **Middleware?** See D1. |
| `kpi/piece/[id]` (1) | GET | S | KPI evidence file. |
| `legal/[id]/fichier` (1) | GET | S | Legal document file. |
| `mail/{attachment, contacts, message, messages, ms/attachment, ms/data}` (6) | GET | S | Mailbox reads. |
| `mail/ms/{connect, callback}` (2) | GET | `requireUser` | Microsoft OAuth. |
| `mail/inbound` (1) | POST | H (`MAIL_WEBHOOK_SECRET`, 503 if unset) | Inbound mail webhook. **Middleware?** See D1. |
| `market-research/{[id]/export, presentation/[versionId]}` (2) | GET | S+R | Exports and PPTX. |
| `marque/[companyId]/logo` (1) | GET | S | Company logo. |
| `medical/{annuaire/export, coaching/export, coaching/[id]/export, plan-de-tournee/[id]/pdf}` (4) | GET | S+R | Medical exports and PDFs. |
| `meetings/{[id]/recording, message-attachment/[id]}` (2) | POST/GET | S-W+R / S | Recording upload, attachments. |
| `messaging/{attachment/[id], bookmarks, conversation, messages, sync, typing, upload}` (7) | GET/POST | S(+R) / S-W+R | Internal chat. `sync` (shell badge poll) uses S-L + `peutVoirLaMessagerie` (PERF-06). |
| `notifications/poll` (1) | GET | S-L | Notification polling — light poll identity `identiteDuSondage` (PERF-06). |
| `onlyoffice/{file, callback}` (2) | GET/POST | T (`readEditToken`/`readDocEditToken`), middleware-exempt | OnlyOffice server-to-server. |
| `onlyoffice/session` (1) | GET | S | Issues the edit token. |
| `pch/export`, `planning/export`, `segmentation/export`, `stocks/demandes/[id]/export`, `ventes-pch/fichier/[id]` (5) | GET | S(+R) | Exports and files. |
| `prises-en-charge/livret` (1) | POST | S-W | Booklet generation. |
| `push/key` (1) | GET | P | VAPID public key. Not middleware-exempt: works only with a session cookie. |
| `push/subscribe` (1) | POST/DELETE | S-W | Push subscription. |
| `regulatory/export` (1) | POST | S-W+R | Regulatory export. |
| `regulatory/intelligence/**` (14) | GET/POST/PUT/DELETE | S / S-W | CTD upload sessions (chunked `part`/`finalize`), OCR diagnose, generated docs, progress. |
| `rh/document/[id]`, `rh/upload` (2) | GET/POST | S / S-W+R | HR documents. |
| `search` (1) | GET | S | Global search. |
| `site-web/candidatures/[id]/cv` (1) | GET | S | CV served to HR. |
| `site-web/v1/{candidatures, contenus}` (2) | POST/GET | H (`site-web/entrant.ts` key + body signature; enforced by `liaison-portes.test.ts`) | Public website ↔ ERP. |
| `site-web/v1/{audience, audience.js}` (2) | POST/GET | P (origin-gated CORS) | Website audience beacon. |
| `uploads/limites` (1) | GET | S | Upload limits for the client. |
| `v1/**` (11) | GET/POST | K | External agent API (§4.7). |

Session-route conventions:

- `export const dynamic = "force-dynamic"`, and `runtime = "nodejs"` where Node APIs are needed
  (25 files). Long jobs set `maxDuration = 120/300`.
- Errors come back as `NextResponse.json({ error: "<French>" }, { status: 401|403|400|404 })`
  (e.g. `rh/upload/route.ts:19-33`).
- Downloads go through `src/lib/http/telechargement.ts`, the single download gate that reads
  `?qualite=`, and `contentDisposition()`. [V]

### 4.7 The external REST API, `/api/v1`

- **Framework.** Every v1 route except `openapi.json` is
  `export const GET|POST = handle({ operationId, scopes, write? }, fn)` (`src/lib/api/http.ts:44`).
  `handle()` does the following:
  1. takes `X-Correlation-Id` from the request or generates one;
  2. runs `authenticate(Authorization)`;
  3. checks `requireScopes`;
  4. handles optional idempotency on writes;
  5. runs `fn`;
  6. wraps the result as `{ data, correlationId }` with `Cache-Control: no-store`;
  7. maps any error to `ApiError.body(correlationId)`;
  8. logs every call to `ApiCall` (operation, entity, before/after, status, duration), best-effort.
     [V]
- **Auth** (`src/lib/api/auth.ts`). Keys look like `amd_sk_<base64url 32B>`; only the SHA-256 is
  stored, and comparison is constant-time. The key maps to an `ApiClient` with `scopes`,
  `isActive`, `expiresAt` and `actAs` (a real user). The request runs as a rebuilt `SessionUser`
  with that user's live `getAccess()`, so **all ERP guards apply unchanged**. Refusals are distinct
  `ApiError`s: unauthenticated, invalid key, disabled, expired. [V]
- **Scopes** (`scopes.ts`): `erp.read`, `erp.search`, `erp.write`, `erp.documents.read`,
  `erp.documents.write`, `erp.workflow.execute`, `erp.approve`, `erp.admin`. `erp.admin` is
  explicitly not a wildcard. `READ_ONLY_SCOPES` is the recommended default. [V]
- **Reads.** `entities/[entity]` lists, with filters, sort, `q` and `limit≤500`.
  `entities/[entity]/[id]` gets one record. `/[aspect]` covers history, related, workflow,
  available-actions, comments and documents. There are also `documents/[id]/content`, `search` and
  `meta/{modules, entities, entities/[entity], operations}`. Row scope comes from
  `porteeEntite(ctx.user, def)` plus `canReadEntity`. There are 29 entity definitions in
  `registry/entities.ts`. [V]
- **Writes.** `POST /api/v1/operations/[operation]` (`handle({scopes:[], write:true})`). It checks,
  in order: the operation exists in `OPERATIONS` (`registry/operations.ts:64`, **5 operations**:
  `mail.create`, `mail.update`, `mail.set_date`, `product.link_dossier`,
  `product.unlink_dossier`); the client has the operation's own scope; the user has
  `userCan(module, UPDATE|CREATE)`; `validateParams` passes; then `def.run(user, values)` runs. A
  business refusal (`ok:false`) becomes a validation `ApiError`. [V]
- **Idempotency.** Only when `write:true` *and* an `Idempotency-Key` header is present. The key is
  stored per client in `ApiIdempotencyKey` *after* success. A replay returns the stored body with
  `Idempotency-Replayed: true`; the same key with a different body hash raises
  `idempotencyMismatch`. A write without the header is not deduplicated. [V]
- **Versioning.** Only the `/v1` path prefix; `info.version: 1.0.0` in the spec. No version
  negotiation. [V]
- **Rate limits.** **None.** `RATE_LIMITED: 429` exists in `errors.ts:25` but nothing raises it.
  [V]
- **OpenAPI.** `GET /api/v1/openapi.json` serves `buildOpenApi(origin)` live
  (`src/lib/api/openapi.ts`), with no key and `max-age=300`. Static copies `docs/api/openapi.{yaml,json}`
  come from `scripts/api/gen-docs.ts`. [V]
- **Webhooks out.** Only the tables exist (`WebhookEndpoint`, `WebhookDelivery`,
  `prisma/schema.prisma:12483,12503`). No code in `src/` reads or writes them, and no
  `X-AMD-Signature` is produced. `docs/api/WEBHOOKS.md` says so ("émetteur à brancher", emitter
  still to be wired). [V]

### 4.8 Cross-cutting helpers that actions import

| Helper | What it is for | Notes |
|---|---|---|
| `@/lib/session` | Identity (`requireUser`, …) | Never read identity elsewhere in API routes (`vue-exacte-etanche.test.ts:340`). |
| `@/lib/rbac` | `userCan`, `hasGlobalView`, `scope*()` where-clauses | `getAccess` is per-request cached. |
| `@/lib/entity-access` | `canAccessEntity(user, type, id, action)`, `ENTITY_MODULE` | Polymorphic row check, used for documents, comments, links. |
| `@/lib/company` | `companyIdForNew(userId)`, `platformScope`, `getMyCompanies`, `moneyEntityOf` | Multi-company (group entity) stamping and scoping. |
| `@/lib/refs` | `buildRef(prefix, year, existing)` → `PREFIX-YYYY-NNN`; `createWithRetry(fn, 6)` retries P2002; `enSerie(serie, fn)` is an in-process FIFO per series | `enSerie` assumes **one process** (`render.yaml`). |
| `@/lib/audit` | `recordAudit` (swallows errors) and `recordFieldChanges(before, after, fields)` | Both feed `events/ledger` through the `faitDepuisAudit` allow-list (`audit.ts:63-84`). |
| `@/lib/notify` | `notifyUser` (DB row + web push), `notifyRoles(roles, …)`, `broadcastNotification` | Unknown roles are filtered, FK failures are replayed (`notify.ts:84-117`). |
| `@/lib/labels` | Every enum→French label map (`SUPPORT_STATUS`, `ROLE_LABELS`, …), `MODULE_LABELS`, `NAVIGATION`, tab sets | 2,284 lines; also imported by client components. |
| `@/lib/utils` | `cn`, `formatCurrency/formatMontant/formatDate/formatDateTime/formatNumber`, `toNumber`, `percent`, `daysUntil` | Locale `fr-FR`, currency DZD. |
| `@/lib/formats/*` | **File** format handling: preview nature (`apercu.ts`), CSV encoding and separator detection (`detection.ts`), spreadsheet parsing, conversion | Not number or date formatting; those are in `utils`. |
| `@/lib/http/*` | `contentDisposition(name, mode)` (RFC 5987), `telechargement.ts` (single download gate, `?qualite=` compression, zip) | Imported by 26 files. |
| `@/lib/chemins/*` | Pure route constants and link builders per domain | Removes the "five copies of an address" problem (§118.5). |
| `@/lib/actions/types` | `ActionResult`, `fdStr/fdNum/fdDate/fdBool/fdCase` | `fdCase` handles hidden "off" companions for checkboxes (§118.172). |

## 5. Conventions and house style

1. **Files.** Server actions go in `src/lib/actions/<domain>-actions.ts` (kebab-case, English or
   French: `promo-devis-actions.ts`, `relance-paiement-actions.ts`). Loaders go in
   `src/lib/queries/<domain>.ts`. Pure domain rules go in `src/lib/<domain>/*.ts`, with no Prisma
   import when possible, and are tested. Route constants go in `src/lib/chemins/<domain>.ts`. [V]
2. **Identifiers.** English is historical (`createSupportRequest`, `decidePaymentRequest`); French
   is the current norm (`enregistrerDevisPromo`, `supprimerDemandePaiement`,
   `corrigerDemandePaiement`). Both are fine. **UI strings, errors, audit summaries and comments are
   in French.** Long block comments state *why* (`── LE DÉFAUT QU'ON CORRIGE ──`, "the defect being
   fixed") and cite § rules. [V]
3. **Pages** start with `requireModule(MODULE)` for list or module pages, or `requireUser()` plus a
   query-module predicate plus `notFound()` for detail pages. They set
   `export const dynamic = "force-dynamic"`. Data loading uses `Promise.all`. Tabs are an allow-list
   read of `searchParams.vue`. [V]
4. **Actions.**
   - Always `requireUser()` first.
   - A business refusal *returns* `{ ok:false, error:"<phrase française>" }`. Throw only inside a
     `$transaction` to abort, and convert it in the `catch`.
   - Never `redirect()`. Return `id`, `redirect` or `message` instead.
   - Use a local `revalidate(id)` helper for list, detail and dashboards.
   - Audit every write.
   - Notify only *other* people (`if (r.requesterId !== user.id)`).
   - Error wording tells the user the remedy (§118.30 "nommer le remède", name the remedy). When
     the outcome is unknown it never says "réessayez" (try again), because retrying creates
     duplicates.
5. **Enums from forms** are cast and then checked against a local allow-list
   (`STATUSES.includes(status)`), never trusted. [V]
6. **Money.** Read with `toNumber`; write with `new Prisma.Decimal(n)`; compare and validate in
   pure modules (`finance/*`). [V]
7. **Client calls.** Prefer `CreateRecordButton` (create dialogs) or `useAction` / `useKeyedAction`.
   Never write `await action(); setBusy(false)` without a try/catch. [V]
8. **Tooling.**
   - `tsconfig.json`: `strict: true`, `moduleResolution: bundler`, alias `@/* → src/*`.
   - `tsconfig.build.json` extends it with `incremental:false` and **excludes `*.test.ts(x)` and
     `*.spec.ts(x)`**. It is the typecheck used on Render (`next.config.mjs:19-31`, 5 GB heap).
   - `npm run typecheck` checks tests too.
   - `.eslintrc.json`: `next/core-web-vitals`, with `no-explicit-any`, `no-unescaped-entities` and
     `no-assign-module-variable` turned off.
   - `next build` skips ESLint (`eslint.ignoreDuringBuilds: true`); `build:render` runs
     `next lint` first, so lint errors block deploy (§118.155). [V]
9. **Tests** are colocated as `*.test.ts`; Vitest only includes `src/**/*.test.ts` (no `.tsx`
   tests exist). There are 1,222 test files.
   - Integration tests hit a real Postgres. They mock `next/cache` and `@/lib/session`
     (`support-flow.test.ts:4-6`) and become `describe.skip` when the DB is unreachable (`:13-15`).
   - "Cliquet" (ratchet) tests read the source and enforce structure: action parity,
     client-bundle guard, session-only identity in routes, site-web gate order.
10. **Migrations** are hand-written idempotent SQL (`CREATE TABLE IF NOT EXISTS …`) in
    `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/migration.sql` (463 folders). Recent folders are
    dated 2027-01-xx, ahead of the calendar, so they sort after older ones. Applied with
    `db:deploy`. [V]

## 6. End-to-end flows

### 6.1 Simple CRUD: create a support request

1. **Menu.** `NAVIGATION` has a `SUPPORT` entry (`labels.ts`). The `(app)` layout shows it if
   `userCan(user,"SUPPORT","VIEW")` (`nav-access.ts`). [V]
2. **Page.** `support/page.tsx:22` runs `requireModule("SUPPORT")`, then `getSupportRequests(user)`
   (scoped by `scopeSupport` and `platformScope`) and an active-user list, in parallel. [V]
3. **Form.** `<CreateRecordButton action={createSupportRequest} redirectBase="/support" fields=[…]>`
   (`:38-55`). On submit, `useFormState(guarded)` posts the `FormData` to the action. [V]
4. **Action** `createSupportRequest(_prev, formData)` (`support-actions.ts:46-77`):
   - `requireUser()` (`:47`);
   - `userCan(user,"SUPPORT","CREATE")`, else "Non autorisé." (`:48`);
   - `fdStr` subject and body; recipient (role or person) required; category allow-list
     (`:50-59`);
   - `nextRef()` → `buildRef("SUP", year, existing refs)` (`:31-35`);
   - `prisma.supportRequest.create` with `companyId: await companyIdForNew(user.id)` (`:61-72`);
   - `notifyResponders` (a person or a role pool) (`:73`, `:37-41`);
   - `recordAudit({action:"CREATE", module:"Support", entityType:"SUPPORT_REQUEST", …})` (`:74`);
   - `revalidate(id)`, which revalidates `/support`, `/support/<id>` and `/mon-espace` (`:25-29`);
   - `return { ok:true, id }`. [V]
5. **Client.** `state.ok` leads to `router.push("/support/<id>")`
   (`create-record-button.tsx:427`). [V]
6. **Detail page.** `support/[id]/page.tsx:23-27`: `requireUser`, then `getSupportRequest`, then
   `canViewSupport` or `notFound()`. Follow-up gestures (`takeSupportRequest`,
   `updateSupportStatus`, `answerSupportRequest`) are called from `panel.tsx` through
   `useAction().run(...)` (`panel.tsx:17-46`). [V]
7. **Covered by** `src/lib/actions/support-flow.test.ts` (real DB) and classified in
   `action-registry.ts:1009`. [V]

### 6.2 Workflow transition with money: Finance decides a payment request

`decidePaymentRequest(formData)` (`payment-request-actions.ts:895-1003`), called from
`validations/paiements/[id]/dossier.tsx:458-473` through
`run("hold", decidePaymentRequest, {id, move, note})`:

1. The whole body is in a `try` (`:896`).
2. `requireUser()` (`:897`); the guard `isFinance(user)` = Finance role, or FINANCES
   VALIDATE/UPDATE, or global view (`:61-65`, `:898`).
3. Parse `id`, and `move ∈ {REVIEW, HOLD, RESUME, REQUEST_CHANGES, APPROVE, REJECT}`; anything
   else gives "Geste inconnu." (`:899-902`).
4. Load the request with its *in-force* pieces only (`replacedBy: null`, §118.191) (`:907`).
5. `canDecideFromDossier(req.origin)`: companion dossiers are decided at the payment centre, not
   here (§118.148) (`:916`).
6. `nextPaymentStatus(status, move)`, a pure state machine (`finance/payment-request.ts:67`); a
   null result gives "Ce geste n'a pas de sens à ce stade du dossier." (`:919`).
7. HOLD and REJECT require a note. APPROVE runs `canApprove({amount: toNumber(req.amount), …},
   pieces)` (`:925-931`).
8. On REJECT, the linked unpaid expense order is cancelled **first**
   (`annulerOrdreNonRegle`, §118.185) (`:939`).
9. `prisma.paymentRequest.update` sets status, hold or decision note, `decidedBy/At` (`:944-953`).
   Then `trace()` writes a `paymentRequestEvent` (`:954`).
10. As a fallback for legacy dossiers, APPROVE with no order calls
    `createExpenseOrder(...)` (`expense-orders.ts:269`). That function uses
    `enSerie` + `createWithRetry` for the reference, sets `centralStatus` from
    `initialCentralStatus`, opens the companion dossier and notifies DIRECTION/SUPER_ADMIN when
    the order is AWAITING (`:962-974`).
11. `notifyUser` the requester, with a title chosen per move (`:985`).
12. `recordAudit({action: APPROVE ? "VALIDATE" : "UPDATE", module:"Demandes de paiement", …})`
    (`:991`).
13. `revalidate(id)` (`/validations`, `/validations/paiements[/id]`). Return `{ok:true,id}` plus a
    `message` when an order was cancelled (`:995-998`).
14. `catch` → `console.error` and "La décision n'a pas pu être enregistrée." (`:999-1002`).
15. Client: `run()` puts `r.error` or `r.message` on screen, then calls `rafraichir()`
    (`dossier.tsx:237-254`). [V]

*Note:* steps 9–12 are separate statements, not one transaction, and the status update is not
conditional on the status that was read (see §8). [V]

### 6.3 Transactional write with an optimistic lock and compensation: promo quote transcription

`enregistrerDevisPromo` (`promo-devis-actions.ts:325-491`):

1. `requireUser()`.
2. Checks, then an optional "scan read" confirmation.
3. The uploaded scan is persisted **before** the transaction (`persistUploadedDocument`, `:398-406`).
4. `prisma.$transaction(async tx => …)` (`:424`):
   - the first statement is `tx.promoMaterial.updateMany({ where:{ id, circuitState:"QUOTE_REQUESTED" }})`,
     and `count===0` throws `RefusDevis(ETAPE_CHANGEE)` (the step changed); this gives a row lock
     and a state check in one statement;
   - the quote and its lines are written with Decimals;
   - an attestation is written inside the same transaction.
5. `catch`: compensate by removing the orphan scan (`retirerScanOrphelin`). Known refusals become
   `{ok:false,error}`; anything else is rethrown (`:469-481`).
6. Drive mirror runs fire-and-forget (`void …catch`).
7. `audit`, `revalidatePath`, `return {ok:true,id,message}` (`:483-490`). [V]

### 6.4 Agent write through the API

1. `POST /api/v1/operations/mail.create` with `Authorization: Bearer amd_sk_…` and
   `Idempotency-Key`.
2. **(Middleware: see D1.)**
3. `handle()` runs `authenticate`; scopes `[]` at the route level; then the idempotency lookup.
4. The handler (`operations/[operation]/route.ts:22-50`) runs `getOperation`, the scope check
   `erp.write`, `userCan(user,"MAIL_REGISTER",UPDATE|CREATE)`, then `validateParams`.
5. `def.run` calls `createMailEntryFor(user, …)`, the same core as the screen action.
6. `{data:{ok, operation, id, message}, correlationId}` is returned, the idempotency row stored,
   and an `ApiCall` logged. [V]

## 7. Coupling and blast radius

- **`requireUser` / `build()`** (`session.ts:112-201`) runs on every page, action and route, with a
  DB lookup of `userSession` and live `getAccess`. A change touches everything, including "Vue
  exacte" semantics: what writes, and in whose name (§118.184; `vueHonoree` in `vue-exacte-ui.ts`).
  [V]
- **`MODULES` / `PERMISSIONS` / `MODULE_LABELS`.** Adding a module makes TypeScript require an
  entry in `MODULE_LABELS: Record<Module,string>` (`labels.ts:1739`) and in the assistant
  `modules-domaines.ts` (`Record<Module, …>`, which "ne compile pas" — will not compile — until
  someone decides who serves it, §118.72). [V]
- **`EntityType` enum.** Adding a value requires `ENTITY_MODULE` (`entity-access.ts:36`) and
  `SECTION_DU_TYPE` (`payments/sections-centre.ts:72`), both total `Record<EntityType,…>`. Partial
  maps (`entity-href.ts`, `entity-exists.ts`, `partage.ts`, `links/source-link.ts`,
  `expense-orders.ts:108`) only fail at runtime or in tests (`dead-links.test.ts:126`). [V]
- **`NAVIGATION`** (`labels.ts:1920`) drives the sidebar, `moduleForPath` (notification badges),
  `firstAccessibleHref` / `safeLanding` (where denied users land) and the command palette. Removing
  an entry can change where *every* denied user is sent. [V]
- **`recordAudit`** has graph degree 1,057 (`graphify:query recordAudit`). Its signature or
  `AuditAction` enum changes ripple through about 150 action files and the event ledger
  (`events/from-audit.ts`). [V]
- **`ActionResult`** is read by `CreateRecordButton`, `useAction`, hand-written runners, the
  agent executor (`executer.ts`: `echecDeclare` treats `ok:false` as failure, §118.25) and `/api/v1`
  operations. Renaming `ok` or `error` breaks all of them. [V]
- **Adding or removing an exported action** fails `action-parity.test.ts` until it is classified,
  and `contrat.test.ts` until `npm run actions:contrat` is re-run. [V]
- **Importing a Node-only module from anything a client component imports** fails
  `client-bundle-guard.test.ts` and, on a clean build, `next build` with "Can't resolve 'fs'"
  (CLAUDE.md). `labels.ts` is client-imported, so it must stay pure. [V]
- **`enSerie`** serialises reference generation per process. Scaling Render to more than one
  instance would fall back to `createWithRetry` only (`refs.ts:45-62`). [V]

## 8. Invariants, gotchas, doctrine rules

- **No zod, no `src/lib/validations` for input.** `src/lib/validations/*` holds the "centre de
  validations" (approval centre) rules (`validations/centre.ts`). Zod appears only in `src/auth.ts`,
  `src/lib/agent/schema.ts` and regulatory AI. Do not add a zod layer in one action: follow the
  `fd*` + allow-list pattern. [V]
- **Writes inside API routes must use `getCurrentUserPourEcrire()`.** Otherwise a Super Admin in
  "Vue exacte" writes in the viewed person's name (§118.184; `session.ts:263-271`; ratchet
  `session-vue-exacte.test.ts:120`). Server actions are recognised automatically
  (`actionServeurEnCours`). [V]
- **Request creation under the view** must use `requireUserAuNomDeLaVue()` deliberately; any other
  write goes in the Super Admin's name. [V]
- **Refusals are returned, not thrown** (§118.25). The agent executor reads `{ok:false}` as
  failure; a throw is reported as a named error. An action that returns `ok:true` after a partial
  failure would be a "faux succès" (false success). [V `executer.ts:56`]
- **Never tell the user to retry when the outcome is unknown.** `actionFailureMessage` wording
  (`action-outcome.ts:38-44`). `CreateRecordButton` hard-codes its *own* copy of this sentence
  (`:355-357`) instead of calling `actionFailureMessage`; that is a small duplication. [V]
- **Detail pages skip `requireModule`.** Admin-*hidden* modules (`canOpenModule`) are therefore
  enforced on list pages only. A deep link to `/support/<id>` still opens when SUPPORT is hidden.
  Retired modules are still closed everywhere, because `userCan` is false. [V code, U intent]
- **Read-then-write without a condition.** `decidePaymentRequest` reads `req.status` then
  `update({ where:{id} })`. Two Finance users acting at once can both pass `nextPaymentStatus`
  (TOCTOU). Compare the `updateMany` state-lock pattern in `promo-devis-actions.ts:431-435`, which
  is the safer house pattern for transitions. [V]
- **`createSupportRequest` uses `buildRef` without `createWithRetry`** while
  `SupportRequest.reference` is `@unique`. Concurrent creation can throw P2002, which is surfaced
  by the client guard as "n'a pas abouti". 20 action files use `buildRef`, 16 use
  `createWithRetry`. [V]
- **Non-transactional sequences.** Most actions do write, trace, audit and notify as separate
  awaits; audit and notify are best-effort by design (`audit.ts:19-21`, `notify.ts:18`). Business
  consistency relies on ordering ("annuler l'ordre AVANT le refus", cancel the order before the
  refusal) and compensations, not on database transactions. [V]
- **No data cache.** Do not introduce `unstable_cache` for per-user data: pages are all dynamic and
  access is resolved per request (`getAccess` is `React.cache`). [V]
- **Tests can silently skip.** DB-backed suites use `describe.skip` when Postgres is down
  (`support-flow.test.ts:13-15`), so `npm test` "passes" without a DB. Start Postgres
  (`pg_ctlcluster 16 main start`). [V]
- **Clean build after touching client imports**: `rm -rf .next && npm run build` (CLAUDE.md). [V]
- **§118.5** "one truth": do not copy a rule or path; import it (`chemins/*`, `queries/*`
  predicates). **§118.14**: a guard with no production caller is a defect (see the
  `canDecideFromDossier` story at `payment-request-actions.ts:910-915`). **§118.172**: forms send
  `off` companions for checkboxes, so read them with `fdCase`. [V from code comments]

## 9. Docs-vs-code discrepancies

- **D1. The middleware blocks "public" machine routes (high severity).** `src/auth.config.ts:16-58`
  returns `isLoggedIn` for every path not listed. It lists `/portail`, `/inscription`,
  `/api/events/qr`, `/meet/`, `/api/site-web/v1/`, `/api/onlyoffice/{file,callback}`. With
  `next-auth@5.0.0-beta.22`, `handleAuth` redirects to the sign-in page when `authorized` is false
  (`node_modules/next-auth/lib/index.js`, `else if (!authorized)` branch), and the matcher only
  excludes `api/auth`. These routes are documented or commented as reachable without a session:
  - `/api/v1/**`: `docs/api/AGENT_API_GUIDE.md`, `API_SECURITY.md`, and
    `openapi.json/route.ts`, which says "Publique et sans clé" (public, no key);
  - `/api/mail/inbound` ("Route PUBLIQUE");
  - `/api/events/inbound/[source]`;
  - `/api/google/pubsub` ("Ce point d'entrée est PUBLIC");
  - `/api/push/key`.

  `vue-exacte-etanche.test.ts:333-336` lists them as `SANS_SESSION` (no-session) routes, but no
  test checks the middleware exemption list (only site-web's, `liaison-portes.test.ts:108-112`).
  Expected effect: a cookie-less agent or webhook request gets a 307 to `/login?callbackUrl=…`.
  [V code; U runtime, not exercised here]
- **D2. "Zod validation (src/lib/validations)" is not a pattern here.** Zod is used in 7 files,
  none of them a screen action. [V]
- **D3. `docs/readme/29-architecture-du-code.md` is stale.** It says 54 action files (actual 176
  plus 7 infra), 27 query files (124), 32 API routes (121), 86 pages (283 under `(app)`), 93 models,
  134 lib files and 21 tests (1,222). [V]
- **D4. `docs/api/openapi.yaml` / `.json` (generated 2026-10-06) lag the code.**
  - The static spec covers 26 entities; `registry/entities.ts` defines 29.
  - It has no `/api/v1/operations/{operation}` and no `/api/v1/meta/operations`; both exist in
    code.
  - `API_COVERAGE.md` says "Actions serveur couvertes par l'API : 0 / 494" and "Objets métier
    195". Code: 5 operations exist, 1,147 actions, 433 models.
  - The live `/api/v1/openapi.json` is generated at runtime and may differ (not exercised). [V]
- **D5. `AGENT_API_GUIDE.md` §11 "Écriture (à venir) … exigeront `Idempotency-Key`"** (writes
  coming, will require the key). Writes exist (5 operations), and the key is **optional**:
  without it there is no deduplication (`http.ts:62`). [V]
- **D6. Rate limiting.** `RATE_LIMITED` is defined but never raised. No limiter exists on
  `/api/v1` or the session routes, and the docs make no promise either way. [V]
- **D7. Webhooks out.** `WEBHOOKS.md` correctly says the emitter is not wired. No code touches
  `WebhookEndpoint` / `WebhookDelivery`. [V]
- **D8. The Render build command is contradictory.** `render.yaml:52` runs `npm run build:render`.
  The `next.config.mjs:7-10` comment says the Render dashboard runs a bare `npx next build`, which
  is why the separate-typecheck logic lives in the config. CLAUDE.md follows `render.yaml`. Which
  is authoritative depends on dashboard settings. [U]
- **D9. Wording duplication.** `CreateRecordButton` uses its own failure sentence rather than
  `actionFailureMessage` (see §8). It is minor and the wording is close. [V]

## 10. Recipe: adding a new module or feature (from observed patterns)

1. **Schema.** Add the model, enums and any new `EntityType` / `AuditAction` value to
   `prisma/schema.prisma`. Write a hand-written idempotent SQL migration in
   `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/migration.sql` (`CREATE TABLE IF NOT EXISTS`, guarded
   `ALTER TYPE … ADD VALUE`). Apply with `npm run db:deploy`. Add `companyId String?` if the object
   belongs to a group entity (pattern: `SupportRequest`). [V pattern]
2. **RBAC module.** Append the key to `MODULES` (`src/lib/rbac.ts:29`, with a comment saying why it
   is a separate module). Grant role defaults in `PERMISSIONS` (`rbac.ts:249+`; `SUPER_ADMIN` gets
   `ALL` automatically). Add a scope helper `scopeX(user)` if rows are personal. TypeScript will
   then require:
   - `MODULE_LABELS` (`labels.ts:1739`);
   - `src/lib/assistant/context/modules-domaines.ts` (which tool domain serves it).

   The admin access console reads `MODULES` and `MODULE_LABELS`
   (`src/app/(app)/admin/access/page.tsx`). [V]
3. **Entity wiring** (if a new `EntityType`):
   - required: `ENTITY_MODULE` (`entity-access.ts:36`), its branch in `canAccessEntity` (`:516`),
     `SECTION_DU_TYPE` (`payments/sections-centre.ts:72`);
   - as needed: `entityHref` (`entity-href.ts:28`, checked against real pages by
     `ui/dead-links.test.ts`), `entity-exists.ts`, `partage.ts` labels,
     `admin-delete-registry.ts` (`DELETE_REGISTRY`) if the Super Admin may delete it. [V]
4. **Labels and navigation.**
   - Add enum→French maps in `labels.ts`.
   - Add a `NAVIGATION` entry `{ module, label, href, icon, group, pole?, tabs?, match?, gate? }`
     (`labels.ts:1920`), plus a `XXX_TABS: NavTab[]` if there are sub-pages.
   - Add path constants in `src/lib/chemins/<domain>.ts` if notifications link to it.
   - Add search aliases in `navigation.ts` (`NAV_ALIASES`) if useful. [V]
5. **Queries.** `src/lib/queries/<domain>.ts`: loaders take `SessionUser`, apply `scopeX(user)` and
   `platformScope(user.id)`, and convert Decimals with `toNumber`. Put the visibility predicates
   (`canViewX`) here so page and action share them. [V]
6. **Pure rules.** `src/lib/<domain>/*.ts`: state machine (`nextXStatus`), permission predicates,
   wording. No Prisma import if possible, so it is unit-testable and safe for client import. [V]
7. **Actions.** `src/lib/actions/<domain>-actions.ts` with `"use server"`. Follow the skeleton in
   §4.3. Use `(_prev, formData)` for `CreateRecordButton`. Use `buildRef` + `createWithRetry`
   (+ `enSerie` if bursty) for references. Use `recordAudit` (module name in French), `notify*`,
   a local `revalidate(id)`, and return `ActionResult`. If an API or agent will also write it,
   factor a `xxxFor(user, input)` core. Then:
   - classify every new export in `src/lib/assistant/action-registry.ts`;
   - run `npm run actions:contrat` to regenerate `contrat.genere.json` and `aiguillage.genere.ts`.
   [V]
8. **Pages.**
   - `src/app/(app)/<slug>/page.tsx`: `requireModule("X")`, `force-dynamic`, loaders,
     `<PageHeader>` with `<CreateRecordButton action={createX} redirectBase="/<slug>">`.
   - `[id]/page.tsx`: `requireUser` → loader → predicate → `notFound()`.
   - Client panels next to the page use `useAction`.
   - Use `?vue=` allow-lists for in-page tabs. Keep old URLs as redirect stubs. [V]
9. **API (optional).** For an agent read, add an entity definition in
   `src/lib/api/registry/entities.ts`. For an agent write, add an `OperationDef` in
   `registry/operations.ts` that calls the shared `…For` core. Then regenerate the docs with
   `npx tsx scripts/api/gen-docs.ts` (and see D1 before relying on keys). [V]
10. **Tests.**
    - Colocated `*.test.ts` for pure rules.
    - A `*-flow.test.ts` against Postgres that mocks `next/cache` and `@/lib/session` (pattern:
      `support-flow.test.ts`).
    - Run `npm run typecheck && npm run build && npm test`, then `npx next lint`. After touching
      client imports, rebuild from a clean `.next`. [V]
11. **Maps.** After a sizeable batch, update `docs/readme/` (panorama, circuits, journal) and run
    `npm run graphify:refresh` together (CLAUDE.md). [V]

## 11. Verified vs uncertain, summary

- **[V]** Counts (pages 283; actions 176 files / 1,147 exports; queries 124; API routes 121;
  force-dynamic 304; revalidatePath 1,289; recordAudit 902; tests 1,222), action skeleton, result
  shape, UI error plumbing, absence of zod, data cache, `redirect()` in actions, rate limiting and
  webhook emitter; the v1 `handle()` pipeline, scopes, idempotency; the three traced flows; the
  middleware public-path list and next-auth's redirect branch.
- **[U]** The runtime effect of D1 (not executed; a proxy or Render setting could in theory
  intervene, though nothing in the repo suggests one). Whether the Render dashboard overrides
  `render.yaml` (D8). Whether hidden-module bypass via detail pages is intended. Whether the live
  `/api/v1/openapi.json` differs from the static spec. Test outcomes (`contrat.test.ts`,
  `executer.test.ts`) were read, not run.
