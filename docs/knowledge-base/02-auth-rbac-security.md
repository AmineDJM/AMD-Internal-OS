# 02 — Authentication, sessions, RBAC & security posture

> Knowledge-base chapter. Written from a read-only code review on 2026-10-24 (HEAD `11a281d`; Graphify built from `41b2ef0e`).
> Tags: **[V]** = verified by reading the cited code; **[U]** = inferred / not executed / not exhaustively checked.

---

## 1. Scope

What this chapter covers:

- **Authentication of employees**: Auth.js v5 (`next-auth@5.0.0-beta.32` — no stable v5 exists; beta.32 closes GHSA-8fpg/7rqj/xmf8/x445, V3-A) Credentials provider, JWT cookie, the **revocable DB session** (`UserSession`), brute-force lockout (`LoginAttempt`), forced password change, invitation links (`/invite/[token]`), guided onboarding.
- **Other authentication planes**: the supplier portal (`/portail`, own HMAC cookie), the agent API (`/api/v1`, API keys + scopes), the public website inbound calls (`/api/site-web/v1`, key + HMAC), OnlyOffice server-to-server routes (signed JWT in query string), public pages (`/inscription`, `/meet`, `/api/events/qr`).
- **Authorization**: the role × module × action matrix (`src/lib/rbac.ts`), per-user overrides (`UserAccess`), row grants (`RowGrant`), implicit grants (pending validations, org chart, seats, interim), row-level scope helpers (`scope*`), polymorphic entity access (`src/lib/entity-access.ts`), special "seats"/predicates (`PaymentCentreSeat`, `sitsOnValidationCentre`, `peutVoirAdam`…), "Vue exacte" (Super Admin impersonation-as-view).
- **Guard conventions** for pages, server actions and API routes; navigation hiding vs authorization.
- **Security mechanisms**: encryption at rest, HTTP headers/CSP, audit log, upload policy, client-bundle guard, ratchet tests, the RBAC coherence checker (`npm run autotest`).
- **Substantiated risks** (section 8.3).

Out of scope: business circuits themselves (validations, payments) except where they define a permission.

---

## 2. Summary

- **The edge middleware never runs.** `middleware.ts` sits at the repo root, but Next only looks for it in `join(appDir, "..")` = `src/` — true on 14.2.35 (`build/index.js:478-488`) and re-checked on 15.5.28 (`build/index.js:548`; built `.next/server/middleware-manifest.json` has `"middleware": {}`) [V]. The `authorized()` callback and public whitelist in `src/auth.config.ts` are therefore **dead code**; all protection comes from **server-side guards in each layout/page/action/route**: `requireModule()` / `requireUser()` + `userCan()` + row scope (`scope*`) or `canAccessEntity()` [V]. An audit of every page outside `(app)` and all 129 API handlers found no unauthenticated route returning internal data except by design (§4.1b) [V].
- The JWT carries `id/role/sid/mustChangePassword`; every server-side read of the user (`build()` in `src/lib/session.ts`) re-checks the `UserSession` row (revoked/expired) and recomputes **effective access from the DB** (`getAccess`, per-request cached) — so role/override changes apply on the next request [V].
- Effective access = role defaults (19 roles × 70 modules × 7 actions) → per-user override (replaces primary-role defaults; `canView=false` = absolute block) → secondary role union → implicit grants via a single `grantImplicit()` that never overrides a block [V].
- Super Admin is "sovereign": all modules, plus exclusive predicates (`peutVoirAdam`, impersonation view). Administration can be *delegated* via an `ADMIN` override, bounded by `admin/garde-comptes.ts` [V].
- Many guards are enforced by **ratchet tests** ("cliquets") that read source files; a static/live coherence checker (`scripts/auto-test`) cross-checks pages, guards, nav and matrix [V].
- **Top risks found**: stored-XSS via inline serving of client-typed uploads (no `script-src` CSP); OnlyOffice callback SSRF with optional body signature; agent-API document download fail-open for unregistered entity types (live, since nothing blocks `/api/v1`); demoted Super Admin keeps impersonation via JWT-frozen role; deactivation through `toggleUserActive` does not revoke sessions; supplier portal login unthrottled; unguarded `"use server"` exports become callable **without any session** because no middleware stands in front of them. **Trap**: "fixing" the middleware by moving it to `src/` would break the webhooks and APIs that never got whitelisted (`/api/v1`, `/invite`, `/api/mail/inbound`, `/api/google/pubsub`, `/api/events/inbound`).

---

## 3. Key files

| Path | Role |
|---|---|
| `middleware.ts` | Intended edge middleware = `NextAuth(authConfig).auth`. **Never compiled**: at the repo root, while Next looks in `src/` (§4.1). |
| `src/auth.config.ts` | Shared config: `session.strategy = "jwt"`, `pages.signIn = "/login"`; its `authorized()` **public-route whitelist is dead code** (it only runs in middleware). |
| `src/app/(app)/layout.tsx` | **The real outer gate** for internal pages: `requireUser()`, `mustChangePassword` and `mustOnboard` redirects (`:45-55`). |
| `src/auth.ts` | Node config: Credentials `authorize()` (zod, lockout, `peutSeConnecter`, bcrypt, creates `UserSession`, logs), `jwt`/`session` callbacks. |
| `src/lib/login-throttle.ts` | Per-email lockout: 5 failures / 15 min window → 15 min lock doubling to 2 h. |
| `src/lib/session.ts` | `requireUser`, `requireUserAuNomDeLaVue`, `requireModule`, `getCurrentUser`, `getCurrentUserPourEcrire`, `safeLanding`; revocation check; Vue exacte resolution. |
| `src/lib/rbac.ts` (2,169 l.) | `MODULES` (70), `ACTIONS` (7), `PERMISSIONS` matrix, predicates (`hasGlobalView`, `isTopManagement`, `peutVoirAdam`…), `accesAttribue`, `getAccess`, `userCan`, `estPrete`, `scope*` Prisma clauses. |
| `src/lib/entity-access.ts` (1,113 l.) | `ENTITY_MODULE`, `canAccessEntity` (polymorphic row-level rule for attachments/comments/etc.), `canModerateEntity`, `lecteurDeLaDemandeDeValidation`. |
| `src/lib/admin/garde-comptes.ts` | Pure `refusAdministration`: only a Super Admin makes/touches a Super Admin; nobody edits own rights/role. |
| `src/lib/actions/access-actions.ts` | Admin console actions: overrides matrix, module access, row grants, password reset, profile/role, activation, session revocation. |
| `src/lib/actions/admin-actions.ts` | Older admin actions (createUser, `toggleUserActive`, `updateUserRole`, `setSecondaryRole`) — used by Adam's ops. |
| `src/lib/actions/auth-actions.ts` | `authenticate` (login form), `doSignOut` (revokes current `sid`), `changePassword` (revokes all sessions). |
| `src/lib/actions/impersonation-actions.ts`, `src/lib/vue-exacte.ts`, `src/lib/vue-exacte-ui.ts` | Vue exacte cookie set/clear; pure rule `vueHonoree`. |
| `src/lib/user-invites.ts`, `src/app/invite/[token]/*` | One-shot invite tokens (72 h). |
| `src/lib/supplier-auth.ts`, `src/lib/actions/supplier-portal-actions.ts`, `src/app/(portal)/portail/*` | Supplier portal auth (separate table + HMAC cookie scoped to `/portail`). |
| `src/lib/api/{auth,http,scopes}.ts`, `src/app/api/v1/**` | Agent API: `amd_sk_` keys (SHA-256 stored), scopes, `handle()` wrapper, `ApiCall` journal. |
| `src/lib/site-web/entrant.ts`, `src/app/api/site-web/v1/**` | Public website → ERP: Bearer key + `X-Adventum-Signature` HMAC; audience beacon gated by Origin. |
| `src/lib/onlyoffice.ts`, `src/app/api/onlyoffice/{file,callback,session}/route.ts` | Edit tokens (HS256 with `ONLYOFFICE_JWT_SECRET`), file fetch + save callback. |
| `src/lib/nav-access.ts`, `src/lib/labels.ts` (`NAVIGATION`), `src/lib/navigation.ts`, `src/lib/modules-visibility.ts`, `src/lib/modules-retired.ts` | Sidebar visibility (not authorization), hidden/retired modules. |
| `src/modules/finances/domaine/authorization.ts`, `src/lib/validations/centre.ts`, `src/modules/finances/actions-sieges.ts` | Seat predicates (`sitsOnPaymentCentre`, `sitsOnValidationCentre`) and seat grant/revoke. |
| `src/lib/crypto/secret-box.ts`, `src/lib/drive-storage.ts`, `src/lib/mail.ts` | AES-256-GCM at rest; keys derived from env (`AUTH_SECRET` fallback). |
| `next.config.mjs` | Security headers + minimal CSP; `serverActions.bodySizeLimit: "256mb"`. |
| `src/lib/audit.ts` | `recordAudit` (best-effort `AuditLog` + business-event fan-out), `recordFieldChanges`. |
| `src/lib/files/politique-televersement.ts`, `src/lib/storage.ts`, `src/lib/attach-files.ts` | Upload policy (blocked extensions + size). |
| `src/lib/client-bundle-guard.test.ts` | Ratchet: no `"use client"` module reaches Node-only modules. |
| `src/lib/session-vue-exacte.test.ts`, `src/lib/vue-exacte-etanche.test.ts`, `src/lib/access-*.test.ts`, `src/lib/site-web/liaison-portes.test.ts` | Ratchets on identity/guards. |
| `scripts/auto-test/{run,lib,live,ai}.ts` | `npm run autotest` RBAC/navigation coherence checker (+ Playwright live crawl). |
| `prisma/schema.prisma` | `User`, `UserSession` (l.5407), `UserAccess` (l.5363), `RowGrant` (l.5391), `PaymentCentreSeat` (l.5349), `AuditLog` (l.5291), `LoginAttempt` (l.9027), `UserInvite` (l.818), `SupplierUser` (l.6953), `ApiClient` (l.12409), `ApiCall` (l.12438), `ApiIdempotencyKey`. |
| `prisma/bootstrap.ts` | First Super Admin (from `ADMIN_EMAIL/ADMIN_PASSWORD`, default `ChangeMe123!` + `mustChangePassword`). |

---

## 4. How it works

### 4.1 Request pipeline (employee)

**The middleware is not part of the pipeline** [V]. Next 14.2.35 — unchanged in 15.5.28 (`build/index.js:548`) — computes `rootDir = path.join(pagesDir || appDir, "..")` and only collects `middleware.(ts|js…)` from that directory (`node_modules/next/dist/build/index.js:476-488`). Here `appDir = src/app`, so `rootDir = src/`; there is no `src/middleware.ts`, and the repo-root `middleware.ts` is never compiled. Consequences:

- The `authorized()` callback (`src/auth.config.ts:16-57`) and its whitelist never execute; nothing redirects anonymous users at the edge; `/login` does not bounce logged-in users to `/mon-espace`.
- Had it run, `false` would have meant a 307 to `/login` for every path, APIs included (`next-auth/lib/index.js:156-164`) — which would have broken the non-whitelisted machine endpoints listed in §2.
- Ratchet tests that read `auth.config.ts` textually (`src/lib/site-web/liaison-portes.test.ts:109`, `src/lib/onlyoffice-diagnostic.test.ts`) check a whitelist that has no runtime effect [V].

Actual pipeline:
1. Request reaches the route segment directly.
2. Internal pages: `src/app/(app)/layout.tsx:45` `requireUser()` (→ `/login`), then `mustChangePassword`/`mustOnboard` redirects; then the page's own guard (usually `requireModule`) [V]. Layout and page render concurrently in the App Router, so a page without its own guard still starts its data reads before the layout's redirect wins [U: framework behaviour]; the 42 unguarded `(app)` pages are plain `redirect()` stubs (§5).
3. Server actions: their **body runs before any layout**, so the action's own `requireUser()`/check is the *only* gate (§8.3 R10) [V by design of Next actions; U for anonymous reachability of each ID].
4. API routes: the handler's own check is the only gate.
5. Guards in `src/lib/session.ts` call `auth()` (decodes the JWT cookie) and `build()` [V].

#### 4.1b Protection audit without middleware [V]

Pages outside `(app)` (11):

| Page | Own gate | Data exposed anonymously |
|---|---|---|
| `src/app/page.tsx` | `requireUser()` `:12` | none |
| `src/app/(auth)/login/page.tsx` | none (by design) | none |
| `src/app/change-password/page.tsx` | `requireUser()` `:7` | none |
| `src/app/onboarding/page.tsx` | `requireUser()` `:47` + mustChangePassword `:48` | none |
| `src/app/office-embed/[id]/page.tsx` | `requireUser()` `:20` + `buildEditorSetup(user, id)` | none |
| `src/app/impression/coaching/[id]/page.tsx` | `requireModule("MEDICAL")` `:23` | none |
| `src/app/(portal)/portail/page.tsx` | `requireSupplier()` `:12` | none |
| `src/app/(portal)/portail/login/page.tsx` | none (by design) | none |
| `src/app/invite/[token]/page.tsx` | invite token (`inviteState`) `:20` | invitee's name + e-mail for a valid token |
| `src/app/meet/[token]/page.tsx` | `Meeting.publicToken` lookup `:16-20` | meeting title, status, Jitsi link |
| `src/app/inscription/[id]/page.tsx` | none — `getPublicEvent(id)` `:11` | **any** event by cuid regardless of status (name, type, dates, place, spots left): `src/lib/queries/events.ts:208-218` does not filter on `REGISTRATION_OPEN` (Low) |

Layouts: `src/app/layout.tsx` (no gate), `(app)/layout.tsx` (`requireUser`), `(app)/chief-of-staff/layout.tsx`, `(portal)/layout.tsx` (no gate; the portal page guards itself). No `route.ts` exists outside `src/app/api` [V].

API routes: 121 `route.ts` files, 129 exported handlers, scanned per handler for `getCurrentUser*`/`requireUser*`/`requireModule`/`auth()`/`handle()`/token or signature checks (script in scratchpad, regex-based). Handlers with no session check, all verified by reading:

| Handler | Gate | Verdict |
|---|---|---|
| `src/app/api/events/qr/[token]/route.ts:12` GET | unguessable `qrToken` | by design (QR image only) |
| `src/app/api/push/key/route.ts:7` GET | none | public VAPID key + enabled flag — by design |
| `src/app/api/v1/openapi.json/route.ts:9` GET | none | API spec, no business data — by design |
| `src/app/api/site-web/v1/audience.js/route.ts:13` GET | none | serves the beacon script — by design |
| `src/app/api/site-web/v1/audience/route.ts` POST | Origin allow-list + per-IP quota | by design (write-only telemetry) |
| `src/app/api/site-web/v1/{candidatures,contenus}/route.ts` | `authentifierLeSite` (key + HMAC) | OK |
| `src/app/api/events/inbound/[source]/route.ts:21` POST | `autoriser()` HMAC per source, 503 without secret | OK |
| `src/app/api/mail/inbound/route.ts:20` POST | `MAIL_WEBHOOK_SECRET` HMAC, 503 without secret (`:21-31`) | OK |
| `src/app/api/google/pubsub/route.ts:26` POST | URL token and/or Google OIDC JWT; refuses if neither (`:31-55`) | OK |
| `src/app/api/onlyoffice/{file,callback}` | signed edit token | OK, but see R2 |
| `src/app/api/v1/**` (except openapi) | `handle()` → API key + scopes | OK, but see R3 |
| `src/app/api/regulatory/intelligence/upload/session/[sessionId]/route.ts:20,28` | file-local `scope()` → `getCurrentUser*` + `regCan` | OK |

Every other handler calls a session guard. **No unauthenticated route returns internal business data** [V within the regex scan's limits].

Public whitelist (`src/auth.config.ts`, *dead* — kept as the documented intent) and the in-route gate that actually applies:

| Prefix | Line | Justification in code | Own gate |
|---|---|---|---|
| `/portail*` | 23 | Supplier portal has its own auth | `requireSupplier()` in `src/app/(portal)/portail/page.tsx:12` [V] |
| `/inscription*` | 27 | Shareable event sign-up | `publicRegister` checks `event.status === "REGISTRATION_OPEN"` (`src/lib/actions/event-actions.ts:425-427`) [V]; no rate limit/captcha [V] |
| `/api/events/qr*` | 28 | QR image; unguessable `qrToken` | lookup by token (`src/app/api/events/qr/[token]/route.ts:13`) [V] |
| `/meet/*` | 32 | Jitsi guest link, unguessable token | `meeting.publicToken` lookup (`src/app/meet/[token]/page.tsx:16-17`) [V] |
| `/api/site-web/v1/*` | 39 | Website has no session | `authentifierLeSite` (key + HMAC) on `candidatures`, `contenus`; `audience` uses Origin + per-IP quota [V] |
| `/api/onlyoffice/file`, `/callback` (exact) | 46 | Document Server calls server-to-server | `readEditToken` / `readDocEditToken` [V] |
| `/login` | 48-53 | — | — |

**Not whitelisted** although they must be public: `/invite/[token]`, `/api/v1/**` (incl. `openapi.json`, "Publique et sans clé"), `/api/mail/inbound`, `/api/google/pubsub`, `/api/events/inbound/*` [V]. They work today *only because* the middleware does not run.

### 4.2 Login (Credentials) — `src/auth.ts`

- zod `{email, password}` (`:12-15`); lower-cased key for throttling (`:32`) [V].
- `checkLockout(emailKey)` before any DB lookup (`:43`) [V]. Lockout is **per e-mail only**, stored in `LoginAttempt` (`src/lib/login-throttle.ts:10-13,39-66`): 5 failures in a 15-min sliding window → lock 15 min, doubling per tier up to 2 h; failures on unknown/inactive/system accounts are counted too (anti-enumeration) [V]. Best-effort: DB errors fail *open* (`.catch(() => null)`) [V].
- Case-insensitive `findFirst` ordered by `createdAt` (`:48-51`) [V].
- `peutSeConnecter(user)` (`src/lib/missions/agent/account.ts`) rejects system accounts (Adam, role SUPER_ADMIN but never loginable) and inactive accounts **before** bcrypt (`:60-65`) [V for call; predicate body U].
- On success: clear attempts, create `UserSession` (30-day `expiresAt`, IP/UA/device; geo enrichment async) (`:89-100`), update `lastLoginAt`, write `ActivityLog` + `AuditLog` `LOGIN` (`:102-128`) [V].
- Returned user → `jwt` callback copies `id, role, sid, mustChangePassword` into the token (`:143-151`); `session` callback exposes them (`:152-160`) [V]. Auth.js default JWT cookie (httpOnly, `lax`, secure on HTTPS), no custom cookie config [V: none in `auth.ts`/`auth.config.ts`]. **No MFA** anywhere [V: no TOTP/WebAuthn code].
- The login form action `authenticate` (`src/lib/actions/auth-actions.ts:11-33`) clears any Vue exacte cookie first and returns a generic error [V].

### 4.3 Revocable sessions & live identity — `src/lib/session.ts`

> **Update 2026-10-28 (V3-C, PERF-06/10).** The revocation read and the Vue exacte resolution moved to
> `src/lib/session-compte.ts` (`lireSessionRevocable` — `UserSession` ⋈ `User` in **one** raw query;
> `vueDemandee` — the `vueHonoree` rule), shared by `build()` and by the **light poll identity**
> `src/lib/session-legere.ts` (`identiteDuSondage`: same revocation, inactive account refused, live role, same Vue
> exacte, no cache; `peutVoirLaMessagerie`: attributed access via `accesAttribue`, exact fallback to `getAccess`).
> Used only by the shell polls (`/api/messaging/sync`, `/api/notifications/poll`) — ratchet in
> `notifications-sondage-unique.test.ts`; equivalence bench `session-legere.test.ts`. `requireUser`/`getCurrentUser`
> are memoised per RSC render (`buildDuRendu`, React `cache`); outside a render nothing is memoised. Without a `sid`,
> `identiteDuSondage` also refuses an inactive account (stricter than `build()`, see the line below). Line numbers
> below predate this split.

`build(session, opts)` (`:112-202`) is the single resolver:

1. If `session.user.sid` present, read `UserSession{revokedAt, expiresAt}`; missing/revoked/expired ⇒ `null` ⇒ guards redirect to `/login` (`:117-123`) [V]. `lastSeenAt` touched at most 1×/min (`shouldTouch`) (`:126-130`) [V].
2. **Vue exacte** (see 4.7) if the JWT role is `SUPER_ADMIN` and the `amd_impersonate` cookie names another active user (`:153-184`) [V].
3. Otherwise `getAccess(id, jwtRole)`; the **role returned is the live DB role** (`access.role ?? session.user.role`, `:195`) [V].

Revocation writers: `doSignOut` (current sid, `auth-actions.ts:37-43`), `changePassword` (all, `:76-79`), `adminResetPassword` (`access-actions.ts:232`), `setUserActive` (on deactivate, `:305`), `revokeSession` (`:329`), `revokeAllSessions` (`:365`), HR departure (`src/lib/hr/depart.ts:52`) [V]. **Not** revoking: `updateUserProfile`/`updateUserRole`/`setSecondaryRole` (role change) and `admin-actions.ts:toggleUserActive` (deactivation used by Adam) [V] — see §8.3.

`build()` does **not** check `User.isActive` for the real user [V]; deactivation relies on session revocation.

Guards exported (complete list, `src/lib/session.ts`):

| Guard | Line | Behaviour |
|---|---|---|
| `requireUser()` | 205 | `build()` or `redirect("/login")`. Does **not** enforce `mustChangePassword`. |
| `requireUserAuNomDeLaVue()` | 216 | Same, but under Vue exacte returns the *viewed* person — only for **creating a demande** (Ad & Pro etc.). |
| `requireModule(module, action="VIEW")` | 239 | `requireUser` → `mustChangePassword` ⇒ `/change-password` → `!userCan` ⇒ `safeLanding(user)?denied=` → hidden module (`AppSetting.hiddenModules`, Super Admin exempt) ⇒ `safeLanding?masque=`. |
| `getCurrentUser()` | 260 | Non-redirecting; for layouts/GET API routes. |
| `getCurrentUserPourEcrire()` | 269 | Non-redirecting, **write identity** (ignores Vue exacte) — mandatory in POST/PUT/PATCH/DELETE API handlers (ratchet, §5). |
| `safeLanding(user)` | 228 | First NAVIGATION href the user can VIEW, else `/no-access` (anti redirect-loop). |
| `IMPERSONATE_COOKIE` | 23 | Re-export. |

Related guards elsewhere: `requireSupplier()` (`src/lib/supplier-auth.ts:84`), `authenticate()`+`requireScopes()` (`src/lib/api/auth.ts:57,100`), `authentifierLeSite()` (`src/lib/site-web/entrant.ts:63`), `readEditToken/readDocEditToken` (`src/lib/onlyoffice.ts:135,150`), file-local helpers like `requireAdmin()` (`access-actions.ts:17-21`, = `userCan(ADMIN, UPDATE)`).

`mustChangePassword` is enforced by `requireModule` and by the `(app)` layout (`src/app/(app)/layout.tsx:45-46`; also `mustOnboard` → `/onboarding`, read live, `:49-55`) [V]; **not** by server actions/API routes that only call `requireUser`/`getCurrentUser` (e.g. `/api/messaging/sync` checks it explicitly, `src/app/api/messaging/sync/route.ts:13`) [V].

### 4.4 Password change, invitations, onboarding

- `/change-password` (`src/app/change-password/page.tsx:7`) uses `requireUser`; action `changePassword` (`auth-actions.ts:51-89`): min 8 chars, verifies current via bcrypt, sets `mustChangePassword:false`, **revokes all sessions**, audits, `signOut` → `/login?changed=1` [V]. Uses raw `auth()` (no revocation check) and has no attempt throttling [V].
- Invitations (`src/lib/user-invites.ts`): token from `randomBytes` (`:1`), TTL 72 h (`:20`), `issueInvite` deletes unused previous invites (`:70`), `inviteState` (`:76-88`), `redeemInvite` claims atomically (`updateMany where usedAt:null`, `:100-104`), sets bcrypt hash and clears `mustChangePassword` (`:106-109`) [V]. Accounts are created **unconnectable** (random unknowable hash, `:50`) [V]. Only caller: Adam op `create_account_invite` (`src/lib/assistant/ops/impl-org.ts:102`) [V]. Page/action claim to be public (`src/app/invite/[token]/page.tsx:15-19`, `actions.ts:5-9`) and they are, in practice, because the middleware is dead. The (inactive) whitelist omits `/invite` — see §9.
- Admin-set password: `adminResetPassword` (`access-actions.ts:191-240`) can force `mustChangePassword` and revokes sessions [V].
- Onboarding: `requestOnboarding` (`access-actions.ts:342-356`) sets `User.mustOnboard`; layout redirects to `/onboarding` (not under Vue exacte) [V].
- Bootstrap: `prisma/bootstrap.ts:13-33` creates the first Super Admin at build time (`render.yaml` `buildCommand` runs `db:bootstrap`); default password `ChangeMe123!` only when `ADMIN_PASSWORD` is unset, with `mustChangePassword:true` [V].

### 4.5 The authorization model — `src/lib/rbac.ts`

**Vocabulary** [V]:
- `MODULES` — 70 keys (`:29-182`), e.g. `WORKSPACE, REGULATORY, REGULATORY_PIPELINE, SPONSORING, BUDGETS, FINANCES, RH, PAYMENT_CENTRE, VALIDATIONS, DRIVE, DOSSIERS, ADMIN, ADVENTUM_BRAIN, PROCESS_INTELLIGENCE…`. Retired: `SALES, LOGISTICS, BUSINESS_DEVELOPMENT` (`src/lib/modules-retired.ts:45`).
- `ACTIONS` — `VIEW, CREATE, UPDATE, DELETE, VALIDATE, EXPORT, UPLOAD` (`:185-188`).
- Action bundles (`:190-247`): `READ`, `CONTRIBUTE`, `MANAGE`, `WORKSPACE_USER`, `DRIVE_USER`, `MESSAGING_USER`, `BC_SIGNATAIRE`…
- `AccessScope` (Prisma enum): `ALL` (whole module) vs `ASSIGNED` (only rows one owns/is party to + `RowGrant`s).
- **Roles** (`prisma/schema.prisma:24-44`, 19): `SUPER_ADMIN, DIRECTION, GENERAL_MANAGER, OPERATIONS_DIRECTOR, HEAD_OF_REGULATORY, REGULATORY_ASSISTANT, HEAD_OF_SALES, SALES_USER, LOGISTICS_MANAGER, MEDICAL_PROMOTION_MANAGER, MEDICAL_DELEGATE, NATIONAL_SALES, PRODUCT_MANAGER` (UI label **"Direction Marketing"**, `src/lib/labels.ts:49`), `BUSINESS_DEVELOPMENT_MANAGER, FINANCE_BUDGET_MANAGER, MEDICAL_INFO_PHARMACIST, DIRECTION_ASSISTANT, COORDINATOR, VIEWER`. Users may also carry a `secondaryRole` ("autre rôle").

**Matrix** `PERMISSIONS: Record<UserRole, RoleMatrix>` (`:249-506`): `SUPER_ADMIN` = every module × every action (`:250`); others listed explicitly. Then **load-time mutation loops** derive defaults for newer modules from older ones (`BD_PROJECTS` from `REGULATORY:VIEW`, `MARKETING_COCKPIT` from `SALES_PLANNING`, `BUSINESS_UNITS` from `SALES_PLANNING:UPDATE`, segmentation…; `:508-700`) [V]. Only `SUPER_ADMIN` holds `ADMIN` and `PROCESS_INTELLIGENCE` by default; `ADVENTUM_BRAIN` also given (VIEW/UPDATE) to `OPERATIONS_DIRECTOR` (`:345`) [V].

`defaultScope(role, module)` (`:1058-…`): `ALL` for global-view roles; `DRIVE` → `ASSIGNED`; `ADMIN_REQUESTS` → `ALL` for `DIRECTION_ASSISTANT/GENERAL_MANAGER/OPERATIONS_DIRECTOR`; module-specific cases follow [V partial].

**Role predicates** (all accept a role or a `{role, secondaryRole}` bearer unless noted) [V]:

| Predicate | Line | Rule |
|---|---|---|
| `hasGlobalView` | 752 | `SUPER_ADMIN` or `DIRECTION`, primary **or secondary** role. |
| `isTopManagement` | 770 | + `GENERAL_MANAGER` (override for company decisions, never a shortcut). |
| `peutPiloterMissionsAdam` | 806 | **Primary** role `SUPER_ADMIN` only. |
| `peutVoirAdam` | 829 | = `peutPiloterMissionsAdam` (§118.153: Adam visible only to Super Admin). Refusal strings `REFUS_MISSIONS_ADAM`, `REFUS_ADAM`. |
| `hasRole` | 837 | primary or secondary. |
| `isRegulatorySupervisor` | 848 | SA or a role configured in `AppSetting.regulatorySupervisorRoles`. |
| `rolesWithModule` / `anyRoleFilter` | 863/867 | Derive "who is concerned" from the matrix; Prisma filter on role OR secondaryRole. |
| `can(role, module, action)` | 999 | **Baseline only, ignores overrides** — not a guard. |
| `sitsOnPaymentCentre` | `payments/authorization.ts:168` | `SUPER_ADMIN` or `DIRECTION` (primary) or `access.paymentCentreSeat`. |
| `sitsOnValidationCentre` | `validations/centre.ts:26` | `SUPER_ADMIN` or `GENERAL_MANAGER` (primary). |
| `canManageEnvelope(s)`, `canViewDriveSpace`, `peutBudgetDuPole`, `recruitmentAccessFor`, `seesWholeSecretariat`, `peutAnnuaire`, `peutGererSpecialites`, `seesLockedRegulatory`, `holdsRegulatoryLock` | 887-1855 | Domain-specific rules co-located with the matrix. |

**Effective access** — `accesAttribue(role, secondaryRole, overrides)` (pure, `:1256-1336`) then `getAccess(userId, roleHint)` (`:1344-…`, `react.cache` per request) [V]:

1. Parallel reads (`:1346-1371`): `UserAccess[]`, `RowGrant[]`, `User{role, secondaryRole}` (live role), pending `ValidationStep`s where user is validator, `Department` count headed/deputised, active stand-ins (`activeStandInsFor`), `getAppSettings()`, `PaymentCentreSeat` count.
2. Per module (`accesAttribue`): skip retired modules (`:1275`); override row with `canView=false` ⇒ **blocked** (`:1281`); override present ⇒ it *replaces* primary-role defaults, else primary defaults; an override never narrows a natively-`ALL` scope (`:1314`); secondary role's defaults are **unioned** unless blocked (`:1328`); `sections` (only `DIRECTORIES` today) come only from overrides [V].
3. Non-global-view users have `DRIVE` and `DOSSIERS` forced to `ASSIGNED` (`:1394-1399`) [V].
4. `grantImplicit(module, actions, scope, mode)` (`:1428-…`) is the **only** place allowed to add access after attribution: refuses blocked and retired modules; widens scope only upward [V]. Implicit grants:
   - pending validation step ⇒ `VIEW/EXPORT` on the module derived from the request (`moduleFromValidation`) + row grant on the linked entity; any pending step ⇒ `VALIDATIONS:VIEW` (`:1459-1472`);
   - `PaymentCentreSeat` ⇒ `PAYMENT_CENTRE: VIEW+VALIDATE, ALL` (`:1483`);
   - RH-update or Finance-update ⇒ `ADMIN_REQUESTS: VIEW/EXPORT, ALL` (read-only);
   - `RECRUITMENT` per `recruitmentAccessFor` (everyone: VIEW/CREATE/UPLOAD ASSIGNED; dept head: more; RH: MANAGE ALL) (`:1520-1524`);
   - department head ⇒ `BUDGET_CAMPAIGN:VIEW`; everyone ⇒ `MY_TEAM:VIEW` (nav shows it only to managers) and `DIRECTORIES:VIEW` (`:1542,1551`);
   - **interim (stand-in)**: absent person's *attributed* modules, bounded by their primary role, never DELETE, never Drive/messaging; recorded in `access.interims` and `access.pretes` (lent actions) (`:1553-…`);
   - carrier of a Regulatory dossier ⇒ `REGULATORY` (and `REGULATORY_PIPELINE` if pipeline-view) at ASSIGNED; shared budget envelope ⇒ `BUDGETS:VIEW/EXPORT`; shared Drive space/node ⇒ `DRIVE:VIEW`.
   - The old implicit "RH ⇒ GENERAL_MEANS" backdoor was **removed** and is tested (`access-implicit-block.test.ts:66`).
5. `userCan(user, module, action)` (`:1712`) = `access.modules.get(module)?.actions.has(action)`. `estPrete` (`:1728`) tells whether an action is only lent by an interim — rights-granting gestures must refuse lent rights [V].

**Row-level scope**: `scope*` helpers return Prisma `where` clauses (`:1901-2169`), e.g. `scopeSales` (`:1992`): no module ⇒ `{id:"__none__"}`; `ALL` ⇒ `{}`; else `OR[owner, rowGrant ids]`. `scopeRegulatory`/`regulatoryLockWhere` add the pipeline lock (locked dossiers visible only to SA + configured roles). Gotcha: never wrap `{}` inside an `OR` (Prisma drops it — §118.184).

**Per-entity rule** — `canAccessEntity(user, entityType, entityId, action)` (`src/lib/entity-access.ts:516-1063`) [V]:
- resolves the owning module (`ENTITY_MODULE` `:36`, or per-row for `CONSULTING_CONTRACT` via `moduleDeLEntite` `:163`);
- special pre-module branches: `DOCUMENT_REQUEST` (asker/askee/interim), `BUDGET` (campaign proposal), `MEDICAL_INFO_DECLARATION`, `VALIDATION_REQUEST` (requester/validators/participants/interim via `lecteurDeLaDemandeDeValidation` `:501`), `PHARMACOVIGILANCE_CASE`, `STOCK_PCH_RELEVE`, expense lines (delegate to parent operation), Regulatory (module per lock), finance/payments, directives, tasks…;
- then `if (!userCan(user, module, action)) return false` (`:900`); Ad & Pro types additionally require company scope and "own business or decider" for writes (`:913-919`);
- final `switch` with per-type ownership checks; types used only for audit (`BUSINESS_UNIT, TOUR_PLAN, SALES_SECTOR, INSTITUTION, SPECIALTY`) return `false` (`:1050-1056`); **`default: return true`** — module permission suffices for unlisted types (`:1061-1063`).
- `canModerateEntity` = `canAccessEntity(..., "UPDATE")` (`:1073`).

### 4.6 Storage & administration of overrides

- `UserAccess` (`schema.prisma:5363-5387`): one row per `(userId, module)`, booleans `canView..canUpload`, `scope`, `sections String[]`. Row present + `canView=false` = BLOCKED; row present = CUSTOM (replaces primary-role defaults); no row = DEFAULT [V].
- `RowGrant` (`:5391-5401`): `(userId, entityType, entityId)` unique — opens specific rows under `ASSIGNED` scope [V].
- `PaymentCentreSeat` (`:5349-5361`): one per user, `grantedById`, mandatory `note` on screen [V].
- Edited in **`/admin/users/[id]`** (`page.tsx:38` guarded by `requireModule("ADMIN","UPDATE")`) via `saveAccessMatrix` (`mode_<MODULE> = DEFAULT|CUSTOM|BLOCKED`, `act_<MODULE>_<ACTION>`, `scope_<MODULE>`), `saveModuleAccess`, `setRowGrants` (`access-actions.ts:63,114,164`) — each calls `refusSurLaCible(…, "DROITS")` and bounds writable actions to those that exist in the matrix (`supportedActions`, `:43-45`) [V]. `/admin` itself: `requireModule("ADMIN")` (`src/app/(app)/admin/page.tsx:33`).
- Delegated administration: anyone with `ADMIN:UPDATE` (override) passes `requireAdmin()`; `refusAdministration` (`src/lib/admin/garde-comptes.ts:25-38`) then forbids: naming a Super Admin, touching a Super Admin's account, changing one's own rights/role [V].

### 4.7 Vue exacte (Super Admin "view as")

- `startImpersonation` (`src/lib/actions/impersonation-actions.ts:15-…`) checks **JWT role** `=== "SUPER_ADMIN"`, target active, sets httpOnly `amd_impersonate` + JS-readable marker cookie (`src/lib/vue-exacte.ts:20-21`) [V].
- `build()` honours the cookie only if the JWT role is `SUPER_ADMIN` (`session.ts:154`). The pure rule `vueHonoree({ecriture, auNomDeLaVue, lecture, actionServeur, rendu})` decides: anything that **renders** (incl. the render following a revalidating action, detected via `react.cache` probe `rendreEnCours`) sees the viewed person; the **body of a write** (server action executing per `actionAsyncStorage.isAction`, or API write route via `getCurrentUserPourEcrire`) runs as the real Super Admin with `visualise` set; creation of a *demande* via `requireUserAuNomDeLaVue` runs as the viewed person with `impersonatedBy` (§118.184, §118.210) [V].
- Login and logout clear the view (`auth-actions.ts:18,45`) [V].

### 4.8 Sidebar ≠ authorization

`navigationFor(user)` (`src/lib/nav-access.ts:59`) filters `NAVIGATION` (`src/lib/labels.ts:1920`) by `accessibleModules`, minus `hiddenModules` (SA exempt), minus closed extra gates (`adam`, `pipeline`, `payroll`, `myTeam`…), minus tabs without rights. Its header states explicitly: *"Rien de tout cela n'est un contrôle d'accès : c'est de la VISIBILITÉ. Chaque page garde sa propre garde (`requireModule`)"* [V]. Note the asymmetry:
- **Retired** modules are removed inside `accesAttribue` ⇒ `userCan` false everywhere (pages, actions, API, Adam) [V].
- **Hidden** modules (`AppSetting.hiddenModules`) are enforced only by `requireModule` (`session.ts:252-255`) and nav; `userCan` does **not** consult them, so server actions/API of a hidden module still work [V: `canOpenModule` used only in `session.ts`/`nav-access.ts`/a few queries].

### 4.9 Non-employee authentication planes

**Supplier portal** (`src/lib/supplier-auth.ts`) [V]: `SupplierUser` table (bcrypt), cookie `amd_portal_session` = `base64url(json{u,s,exp}).HMAC` with key `HMAC(AUTH_SECRET-ish, "supplier-portal-session-v1")` (`:17-20`), `path=/portail`, 8 h, httpOnly, `lax` (`:54-63`); every read re-validates user+supplier active and supplier binding (`:70-81`). Login (`supplier-portal-actions.ts:10-35`) compares bcrypt against a dummy hash for unknown users (timing), generic error, audits — **no lockout/throttle** [V]. Portal page is read-only (`portail/page.tsx`).

**Agent API `/api/v1`** (`src/lib/api/*`) [V]: keys `amd_sk_` + 32 random bytes, only SHA-256 stored, `keyPrefix` = first 13 chars (`auth.ts:20-23`); lookup by hash + constant-time compare (`:61-71`); refuses inactive/expired client and inactive `actAs` user (`:72-78`); builds a real `SessionUser` from `getAccess(actAs)` so ERP rules apply (`:80-87`). `handle()` (`http.ts:44-…`) = authenticate → `requireScopes` → idempotency (`Idempotency-Key`, body hash) → handler → `ApiCall` log. Scopes (`scopes.ts:13-43`): `erp.read, erp.search, erp.write, erp.documents.read, erp.documents.write, erp.workflow.execute, erp.approve, erp.admin`; read-only profile by default. Keys are issued by CLI only (`scripts/api/issue-key.ts`, per `docs/api/API_SECURITY.md`) [U for script]. `RATE_LIMITED` error code exists but is never raised [V: only `errors.ts:25`].

**Public website inbound** (`src/lib/site-web/entrant.ts:63-100`) [V]: Bearer key must equal the ERP's ACTIVE key, the PENDING key (then promoted — rotation), or `ADVENTUM_API_KEY` env only while no active key exists; all comparisons constant-time; if the key has a secret, `X-Adventum-Signature` must equal `HMAC-SHA256(secret, exact body or "")`. No timestamp/nonce ⇒ replay of a captured signed request is possible [V by absence]. A ratchet (`liaison-portes.test.ts`) requires each `/api/site-web/v1` route to call it first. The `audience` beacon (`src/app/api/site-web/v1/audience/route.ts`) is public by design: Origin allow-list, 120 events/min per IP in an in-memory `Map` keyed by first `X-Forwarded-For` value (`audience-collecte.ts:28,66,120`) [V].

**OnlyOffice** [V]: `/api/onlyoffice/session` (session-guarded, `getCurrentUser`) returns the editor `config` including `callbackUrl=/api/onlyoffice/callback?…&token=<edit token>` to the browser (`src/lib/onlyoffice-session.ts:74,91,111`). Tokens: HS256 signed with `ONLYOFFICE_JWT_SECRET`, 24 h, `kind` discriminated (`onlyoffice.ts:131-153`). `/file` serves bytes for a valid token (`file/route.ts:15-40`); `/callback` accepts a body JWT **only if one is present** (`callback/route.ts:32-39`) then `fetch(body.url)` and stores the result as a new version (`:48-60`).

**Cron / scheduler**: no cron HTTP endpoint exists. Periodic jobs piggy-back on authenticated polling — `runScheduledJobs()` debounced 1×/min inside `GET /api/messaging/sync` (`src/app/api/messaging/sync/route.ts:16-17`) [V]. Mission heartbeats run in-process [U].

### 4.10 Security mechanisms

- **HTTP headers** (`next.config.mjs:129-169`) [V]: `X-Frame-Options: SAMEORIGIN`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` camera/mic/geo self, HSTS 2 y + preload, `COOP: same-origin`, `X-DNS-Prefetch-Control: off`, `X-Permitted-Cross-Domain-Policies: none`, `poweredByHeader:false`. **CSP** only `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests` — no `default-src`/`script-src` ⇒ no XSS mitigation by CSP.
- **Server Actions**: Next 15.5's built-in Origin/Host check is the CSRF defence [U: framework behaviour, not re-verified]; body limit 256 MB (`next.config.mjs:95`).
- **Encryption at rest** [V]: AES-256-GCM, random 12-byte IV.
  - `secret-box.ts:14-21`: key = `SHA-256(MAIL_ENCRYPTION_KEY || DRIVE_ENCRYPTION_KEY || AUTH_SECRET || NEXTAUTH_SECRET || "dev-secret-box-change-me")`; format `iv:tag:ct` base64; `openSecret` returns `null` on any failure. Used by Google/Microsoft mail connections, site-web keys, invoice knowledge, missions acceptance.
  - Drive blobs (`drive-storage.ts:28-36`): `DRIVE_ENCRYPTION_KEY` (32 bytes hex/base64) else `SHA-256(NEXTAUTH_SECRET ?? AUTH_SECRET ?? "amd-internal-os")`; S3 bucket receives ciphertext only.
  - `render.yaml` sets `AUTH_SECRET` but no `DRIVE_ENCRYPTION_KEY`/`MAIL_ENCRYPTION_KEY` ⇒ in production the **session-signing secret is also the at-rest key** (no KDF, no domain separation except supplier portal) [V].
  - Other HMACs off the same secret: messaging blob refs (`messaging.ts:112-125`), invoice reminder tokens (`factures/jeton-relance.ts:22-25`, 24 h), OAuth `state` (`mail/oauth.ts:21`, `google/oauth.ts:24`) [V].
- **Sensitive-data vault** *(added 2026-10-27, refonte V2-E — `docs/architecture/refonte-v2e-coffre.md`)* [V]: `src/modules/coffre/` — dedicated key `COFFRE_KEY` (no production fallback, refused if equal to `DRIVE_ENCRYPTION_KEY`), HKDF sub-keys for AES-256-GCM and the search HMAC. Clear columns `Employee.iban/nationalId/baseSalary/grossSalary/netToPay/employerCost`, `CompanyContact.rib`, `CompanyLegalIdentity.rib/iban` are **copied** (catalogue `champs.ts`; columns stay until P5). Read policy `politique.ts` (AI never; Super Admin; self; HR = `voitLesSalaires` for salaries/NIN; Finance UPDATE for RIB/IBAN; "pièce officielle" prints an organisation's RIB). Every read — granted or refused — writes `AccesDonneeSensible` **before** any value leaves (`acces.ts`); screens decrypt via `lecture.ts`; decryption lives only in `dechiffrement.ts`, never reachable from the assistant/agents (`frontiere.test.ts`). Switches `AppSetting.coffreEcriture` / `coffreLecture` (closed by default, Super Admin at `/admin/refonte-donnees`); access journal at `/admin/acces-donnees-sensibles`.
- **Audit log** (`src/lib/audit.ts:23-44`): `AuditLog` row (actor, `AuditAction` enum `CREATE…REFUSE`, module label, entity, field old/new, summary, IP) — **best-effort** (errors swallowed), not in the business transaction, not tamper-evident; also fans out whitelisted facts to the business-event registry (`emettreFait`). Agent calls are journaled separately in `ApiCall` [V]. Screenshot-attempt beacon `POST /api/security/screenshot-attempt` audits + notifies Super Admins (30 s debounce, in-memory) [V].
- **Upload policy** (`src/lib/files/politique-televersement.ts:18-53`): blocks executable/script extensions (`exe, js, sh, ps1, hta, …`) and size > `maxUploadMb` (AppSetting, default 200 in `/api/documents/upload`; env `MAX_UPLOAD_MB` 25 elsewhere). **HTML/SVG/XHTML are allowed**; stored `mimeType` is the client-sent `file.type` (`documents.ts:109`, `attach-files.ts:96`) [V].
- **Client-bundle guard** (`src/lib/client-bundle-guard.test.ts`, 148 l.): walks static + dynamic imports from every `"use client"` module and fails on Node built-ins (`NODE_ONLY` regex `:28`) or Node-only packages (`:41`). It is a *build-safety* guard (prevents "Can't resolve 'fs'"), not a secret-leak detector; it does not inspect `process.env` usage in client code [V].

---

## 5. Conventions & house style

1. **Every page guards itself** — first line: `const user = await requireModule("X"[, action])`. Detail pages then load with the scope clause and 404 on miss, never 403:
   ```ts
   const user = await requireModule("SPONSORING");
   const req = await prisma.sponsoringRequest.findFirst({ where: { AND: [{ id: params.id }, scopeSponsoring(user)] } });
   if (!req) notFound();
   ```
   (`src/app/(app)/sponsoring/[id]/page.tsx:57-64`). Polymorphic/lock-sensitive objects use `canAccessEntity` (`regulatory/[id]/page.tsx:71-73`). Stats: 283 `(app)` pages; 199 call `requireModule`, 42 another guard, 42 none — those 42 are redirect stubs (spot-checked 4) and still sit under the layout's `requireUser` [V].
2. **Every server action re-authorizes** — `requireUser()` (or `requireUserAuNomDeLaVue()` for creating a demande) then `userCan`/domain predicate/`canAccessEntity`, return `{ ok:false, error }` (French) instead of throwing; then mutate, `recordAudit(...)`, `revalidatePath(...)`:
   ```ts
   const user = await requireUser();
   if (!userCan(user, "SUPPORT", "CREATE")) return { ok: false, error: "Non autorisé." };
   ```
   (`src/lib/actions/support-actions.ts:46-48`; `takeSupportRequest :81-93` uses a row predicate `isResponder`; `createSponsoring` `sponsoring-actions.ts:69-74`). Form fields are never trusted as authorization ("un champ de formulaire se forge"); re-read the target from DB (e.g. `refusSurLaCible`).
3. **`"use server"` files expose every export.** Keep helpers non-exported (stated in `access-actions.ts:24-26`). The generic Adam path reads a generated contract (`src/lib/actions/contrat.genere.json`, 1,145 actions) whose `porte` is informational — "la porte est LUE, et elle n'autorise rien — l'action revérifie à l'exécution" (`contrat.test.ts:148`).
4. **API routes**: GET → `getCurrentUser()`; POST/PUT/PATCH/DELETE → `getCurrentUserPourEcrire()`; mixed routes must use `req.method === "GET" ? await getCurrentUser() : await getCurrentUserPourEcrire()`; never `requireUser()` in a route (ratchet `session-vue-exacte.test.ts:109-133`). Then `canAccessEntity`/`userCan`; respond 401/403/404 JSON.
5. **One predicate per rule** (§118.5, §118.71): screens, actions, Adam tools, nav and engine read the *same* function (`peutVoirAdam`, `sitsOnPaymentCentre`, `lecteurDeLaDemandeDeValidation`…). Never copy a role list; derive from `PERMISSIONS` (`rolesWithModule`).
6. **Implicit access only via `grantImplicit`**; an explicit console block always wins (ratchet `access-implicit-block.test.ts:96-97`: no `modules.set` outside it).
7. **Primary role for sovereignty**, primary-or-secondary for capabilities (`peutPiloterMissionsAdam` vs `hasGlobalView`).
8. Refusal strings written once (`REFUS_ADAM`, refusal helpers in `payments/authorization.ts:174+`).
9. New public route ⇒ add an exact-prefix line in `auth.config.ts` with a comment saying which in-route check replaces the session, plus a ratchet (pattern: `/api/site-web/v1/` + `liaison-portes.test.ts`).
10. Pure rule modules with no imports (`garde-comptes.ts`, `vue-exacte-ui.ts`, `annuaires/acces.ts`) so they are testable and client-safe.

---

## 6. End-to-end flows traced

### 6.1 Login → page → write → attachment download

1. `POST /login` (server action `authenticate`, `auth-actions.ts:11`) → `signIn("credentials")` → `authorize()` (`auth.ts:27`): lockout check (`:43`) → user lookup (`:48`) → `peutSeConnecter` (`:60`) → bcrypt (`:67`) → `UserSession.create` (`:89`) → audit (`:118`) → token `{id, role, sid, mustChangePassword}` (`:143-151`) → redirect `/mon-espace`.
2. `GET /sponsoring/abc` → no middleware (§4.1) → straight to the route segment.
3. `(app)/layout.tsx:45` `requireUser()` → `build()` validates `UserSession` (`session.ts:117-123`), `getAccess()` resolves matrix + overrides + implicit grants (`rbac.ts:1344+`) → `mustChangePassword`/`mustOnboard` redirects → `navigationFor(user)` builds the sidebar.
4. Page `requireModule("SPONSORING")` (`sponsoring/[id]/page.tsx:57`) → `userCan` + hidden-module check (`session.ts:245-255`) → `findFirst({ AND:[{id}, scopeSponsoring(user)] })` → `notFound()` if out of scope; UI flags `userCan(user,"SPONSORING","UPDATE"|…)` only decide buttons.
5. User clicks "Clôturer" → server action `cloturerSponsoring` (`sponsoring-actions.ts:341`) → `requireUser()` (body of an action ⇒ real identity even under Vue exacte) → loads row → `peutCloturer(...)` → conditional `updateMany` (optimistic) → audit.
6. User uploads a file → `POST /api/documents/upload` (`route.ts:21`) → `getCurrentUserPourEcrire()` → `canAccessEntity(user, entityType, entityId, "UPLOAD")` (`:38`) → size/extension policy → `Document` row with client `mimeType`.
7. Another user opens it → `GET /api/documents/[id]` (`route.ts:23-34`) → `getCurrentUser()` → `canAccessEntity(..., "VIEW")` OR passport/prise-en-charge exceptions → `repondreFichier` serves bytes **inline** with stored `mimeType` (`telechargement.ts:105-108`), or a 15-min presigned S3 URL for big direct uploads; download (`?dl=1`) is audited as `EXPORT`.

### 6.2 Admin blocks a module for one user

`/admin/users/[id]` (`requireModule("ADMIN","UPDATE")`) → form posts `saveAccessMatrix` (`access-actions.ts:63`) → `requireAdmin()` → `refusSurLaCible(admin, userId, "DROITS")` → writes `UserAccess{module, canView:false}` → next request of the target: `accesAttribue` marks it blocked (`rbac.ts:1281`), secondary role and every `grantImplicit` skip it (`:1328`, `:1428+`) → `userCan` false in pages, actions, API, Adam. No session revocation needed.

### 6.3 Agent API call

`GET /api/v1/search?q=…` with `Authorization: Bearer amd_sk_…` → (no middleware) → `handle()` (`http.ts:44`) → `authenticate` (`auth.ts:57`) → `requireScopes(["erp.search"])` → handler uses `porteeEntite(ctx.user, def)` per entity → `ApiCall` row. If the middleware were ever activated as written, this call would get a 307 to `/login` instead.

---

## 7. Coupling & blast radius

- `getAccess` is on the hot path of **every** authenticated request (≥8 queries, `rbac.ts:1346-1371`, cached per request only). Adding a query there costs every page; making it throw locks everyone out (most reads `.catch` to safe defaults, e.g. seat → 0, stand-ins → []).
- `PERMISSIONS` is mutated at module load by derivation loops (`rbac.ts:508-700`): reordering or editing a base module (e.g. `SALES_PLANNING`, `REGULATORY`) silently changes defaults of derived modules (`MARKETING_COCKPIT`, `BUSINESS_UNITS`, `BD_PROJECTS`).
- `PERMISSIONS` is also read by: `rolesWithModule` (notification audiences), admin console (`supportedActions`), autotest matrix, `rbac-sheet.ts`, interim bounding. Changing a role's defaults changes who gets notified, not only who sees.
- `ENTITY_MODULE` + `canAccessEntity`'s `default: return true` (`entity-access.ts:1061`): adding a new `EntityType` enum value without a `case` makes its attachments/comments open to **any holder of the mapped module** (the code comments at `:1050-1056` record that this already bit once, §118.153g/§118.181).
- `NAVIGATION` (`labels.ts`) feeds `safeLanding` — removing/reordering entries changes where denied users land; `firstAccessibleHref` must never return a page that refuses again (loop).
- JWT payload shape (`auth.ts:143-160`) is consumed by `build()`, `impersonation-actions.ts`, screenshot/replay/activity routes (raw `auth()`), and `changePassword`.
- `AUTH_SECRET` is coupled to: JWT signing, Drive at-rest key, secret-box key (mail OAuth tokens, site-web keys), supplier cookie, messaging blob signatures, invoice reminder tokens, OAuth state. **Rotating it invalidates sessions *and* makes Drive blobs and sealed secrets undecryptable** unless `DRIVE_ENCRYPTION_KEY`/`MAIL_ENCRYPTION_KEY` were set first [V by derivation code; operational impact U].
- **Middleware activation is a blast-radius event**: moving/copying `middleware.ts` into `src/` (the "obvious fix") would turn on the `auth.config.ts` whitelist, and every public machine endpoint missing from it would start returning 307 → `/login`: `/api/v1/**`, `/invite/*`, `/api/mail/inbound`, `/api/google/pubsub`, `/api/events/inbound/*`. Today the only choke points are the per-page/per-handler guards; there is no defence in depth.
- `src/lib/session.ts` depends on Next internals (`next/dist/client/components/action-async-storage.external`) — a Next upgrade can silently change Vue exacte semantics; guarded by `session-vue-exacte.test.ts` and `vue-exacte-etanche.test.ts`.

---

## 8. Invariants, gotchas, doctrine

### 8.1 Invariants (enforced by code/tests)

- An explicit BLOCK (override `canView=false`) beats primary role, secondary role and every implicit grant (`rbac.ts:1281,1328,1428+`; `access-override.test.ts:48`, `access-implicit-block.test.ts:74`).
- Retired modules are absent from effective access (`rbac.ts:1275`, `grantImplicit`).
- Writes never run as the viewed person under Vue exacte, except creation of a demande (`session.ts:137-152`; §118.184, §118.210; two test files).
- A system account (Adam) can never log in (`auth.ts:52-65`), never sits on the payment centre (`payment-centre-seat-actions.ts:77`), cannot be deactivated from a screen (`admin-actions.ts:70-73`).
- Only a Super Admin makes or touches a Super Admin; nobody edits own rights/role (`garde-comptes.ts:31-36`).
- Non-global-view users can never have `ALL` on Drive/Dossiers (`rbac.ts:1394-1399`).
- Detail page = same scope as list ("Une fiche ouverte par son lien ne s'ouvre pas plus large que sa liste", §118.184).
- Out-of-scope objects answer 404, not 403 (pages via `notFound()`; API per `API_SECURITY.md` §7).

### 8.2 Gotchas

- `can()` (`rbac.ts:999`) ignores overrides — use `userCan()` for decisions.
- `requireUser()` ≠ `requireModule()`: the former skips `mustChangePassword` and hidden-module checks.
- Raw `auth()` skips revocation: used in `impersonation-actions.ts:15,40`, `api/replay`, `api/activity`, `api/security/screenshot-attempt`, `auth-actions.ts` [V].
- Prisma drops `{}` inside `OR` — return the empty clause unwrapped (§118.184).
- The middleware never runs (§4.1), so **a new page outside `(app)` or a new API handler without its own guard is public**. Nothing upstream will catch it; the `autotest` live anonymous pass is the only detector (pages only, not API, not actions).
- (If the middleware is ever activated: its `startsWith` prefixes also match `/portailX`, `/inscriptionX`, and its matcher skips every path ending in an image extension, `middleware.ts:11`.)
- `JWT.role` is frozen at login; `build()` replaces it by the live role for access, but **not** for the Vue exacte gate (§8.3 R4).
- Messages "Réservé au Super Admin" in `requireAdmin`/`canSeat` actually test `ADMIN:UPDATE`, which can be delegated (`access-actions.ts:17-21`, `payment-centre-seat-actions.ts:48-50`).
- `/api/messaging/sync` triggers background schedulers; removing that poll stops periodic jobs.

### 8.3 Concrete risks (substantiated)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| R1 | **High** (insider) | **Stored XSS via uploads served inline.** `.html/.htm/.svg/.xhtml` are not blocked; `mimeType` is the browser-sent `file.type`; `GET /api/documents/[id]` serves original bytes with that `Content-Type` and `Content-Disposition: inline` from the app origin; CSP has no `script-src`. Any user able to attach to an entity that a Super Admin/Direction can VIEW can run script in their session (server actions are same-origin). | `politique-televersement.ts:18-22`; `documents.ts:109`, `attach-files.ts:96`; `api/documents/[id]/route.ts:46-55`; `telechargement.ts:105-108`; `next.config.mjs:136-142`. Exploit not executed [U]; Drive download path not checked [U]. |
| R2 | **Medium** | **OnlyOffice callback SSRF / overwrite.** The callback accepts an *unsigned* body when no `token` field/Authorization header is sent, then `fetch(body.url)` server-side and stores the response as a new version. The callback token (24 h) is handed to the browser in the editor config, so any user who opened an editor can make the server fetch an arbitrary internal URL and read the result back as the document; also keeps write access 24 h after rights are removed. | `callback/route.ts:32-39,48`; `onlyoffice-session.ts:74,91,111`; `onlyoffice.ts:131-133`. |
| R3 | **Medium** | **Agent API document download fail-open.** `/api/v1/documents/{id}/content` checks scope only `if (def)` — for the ~43 `EntityType`s not in the API registry (16 registered), any key with `erp.documents.read` downloads the document regardless of the `actAs` user's rights (e.g. recruitment CVs, validation attachments). Diverges from `canAccessEntity`. Reachable (no middleware); mitigated only by CLI-only key issuance and cuid ids. | `api/v1/documents/[id]/content/route.ts:27-34`; `lib/api/registry/entities.ts` (16 `entityType`). |
| R4 | **Medium** | **Demoted Super Admin keeps "Vue exacte".** Role changes don't revoke sessions; the JWT keeps `role: "SUPER_ADMIN"` up to 30 days; both `startImpersonation` and `build()` gate on the JWT role, so the ex-SA can view the OS as any active user (reads with the target's access) and create demandes in their name. | `access-actions.ts:243-293` (no revocation), `admin-actions.ts:87-115`; `impersonation-actions.ts:16`; `session.ts:154`. |
| R5 | **Medium** | **Deactivation via `toggleUserActive` leaves sessions alive.** Used by Adam's `set_account_active` op; `build()` never checks `isActive`, so the deactivated user stays logged in until `UserSession.expiresAt` (30 days). The console's `setUserActive` does revoke. | `admin-actions.ts:62-85`; `assistant.ts:6491`; `session.ts:117-123`; contrast `access-actions.ts:295-316`. |
| R6 | **Medium** | **Supplier portal login has no throttling/lockout** (internet-facing, bcrypt only). | `supplier-portal-actions.ts:10-35`. |
| R7 | Low–Medium | Delegated admin (`ADMIN:UPDATE` override) can grant **itself** a payment-centre seat (VALIDATE ALL on payments) — `grant/revokePaymentCentreSeat` don't call `refusAdministration`, contradicting "ses propres droits passent par quelqu'un d'autre". | `payment-centre-seat-actions.ts:48-50,59-90`; `garde-comptes.ts:34-36`. |
| R8 | **Medium** (architecture) | **The middleware is dead** (repo-root `middleware.ts`, Next looks in `src/`): no edge/defence-in-depth authentication at all; the documented whitelist is fiction; activating it as written would break five public endpoints. | `node_modules/next/dist/build/index.js:476-488`; `middleware.ts`; `auth.config.ts:16-57`. |
| R9 | Low | Login lockout is per e-mail only: anyone can lock any account (DoS, 15 min → 2 h); no per-IP limit for credential stuffing across e-mails; no MFA. | `login-throttle.ts:10-66`; `auth.ts:43`. |
| R10 | Low–Medium | Unguarded exports in `"use server"` files are callable **without any session** (no middleware; the action body runs before layouts) by anyone holding the action ID. IDs are `sha1(absoluteFilePath + ":" + exportName)` (`node_modules/next/dist/build/webpack/loaders/utils.js:87-89`) and appear in public client chunks for actions referenced by client components [U per action]. Examples: `runPettyCashRechargeReminders` (sends notifications), `ensureCycle` (creates `PromoCycle`), `nextRechargeFor` (reads a plan). Heuristic scan: 86/1,226 exported actions show no visible guard call; most use local helpers (`guard()`, `loadManaged()`), not all checked. | `petty-cash-actions.ts:627,652`; `sales-planning-actions.ts:48`. |
| R11 | Low | Site-web inbound HMAC has no timestamp/nonce (replay of captured signed calls, e.g. duplicate candidatures); audience quota keyed on spoofable first `X-Forwarded-For`, in-memory per instance. | `entrant.ts:84-90`; `audience-collecte.ts:66,120`. |
| R12 | Low | Shared secret reuse: `AUTH_SECRET` signs JWTs and is (absent dedicated keys, as in `render.yaml`) the AES key for Drive and secret-box, via plain SHA-256; dev fallbacks hard-coded (`"amd-internal-os"`, `"dev-secret-box-change-me"`) if env missing. | `drive-storage.ts:28-36`; `secret-box.ts:14-21`; `render.yaml` env list. |
| R13 | Low | Hidden modules remain usable through server actions/API (`userCan` ignores `hiddenModules`). Probably intended as UI-only, but "masqué" is presented as stronger in `session.ts:248-251`. | `session.ts:252-255`; `modules-visibility.ts:109`. |
| R14 | Info | Audit log is best-effort and mutable (no hash chain); 256 MB server-action body limit; password policy = 8 chars min, bcrypt cost 10; `changePassword` has no attempt limit. | `audit.ts:23-41`; `next.config.mjs:95`; `auth-actions.ts:62-69`. |

### 8.4 Doctrine references seen in code

§118.5 (no second source of truth — one predicate), §118.71 (a guarded door next to an open door lets the same thing through), §118.153 (Adam visible only to SA), §118.159 (public site → ERP), §118.163 (module split keeps yesterday's population), §118.176 (BC signing module), §118.181 (audit-only entity types return false), §118.184 (Audit 360° lot A: fiche scope = list scope, delegated admin bounds, Vue exacte is a view), §118.196 (interims: lent rights never re-granted), §118.210 (action detection by execution, not header). Full texts: `docs/claude-md/08-versionnement-graphify-p04.md:81-…`.

---

## 9. Docs-vs-code discrepancies

0. **The middleware itself.** `middleware.ts` comments ("Edge middleware … enforces the `authorized` callback"), `auth.config.ts` comments ("Runs in middleware on every matched request"), and the README journal (`docs/readme/30-journal-…-p09.md:136`: OnlyOffice routes "étaient derrière la connexion (middleware)") all assume an edge gate that Next 14.2.35 never builds from the repo root (`next/dist/build/index.js:476-488`) [V]. That journal's "fix" (whitelisting `/api/onlyoffice/*`) cannot have changed runtime behaviour [U: possibly the file lived in `src/` back then — git history here is shallow].
1. **`docs/api/API_SECURITY.md`** describes a working Bearer-key API and `openapi.json` says "Publique et sans clé"; `auth.config.ts` has no `/api/v1` exemption. This works today only because the middleware is dead [V].
2. **`/invite/[token]`** is described as a public page/action ("PAGE PUBLIQUE… aucune session requise", `invite/[token]/page.tsx:15-19`; journal `30-…-p06.md:9`) and is not whitelisted — same remark [V].
3. `API_SECURITY.md` §3: "`keyPrefix` (8 caractères)" — code stores 13 chars (`"amd_sk_"` + 6) (`src/lib/api/auth.ts:22`) [V].
4. `API_SECURITY.md` §4 "Chaque lecture passe par les fonctions de portée de l'ERP" — false for documents of unregistered entity types (R3) [V].
5. `src/auth.config.ts:36-38` says routes under `/api/site-web/v1/` verify key and signature — `audience` (and `audience.js`) intentionally don't (Origin gate) [V].
6. `requireAdmin`/`canSeat` messages say "Réservé au Super Admin" while the check is the delegable `ADMIN:UPDATE` [V].
7. `docs/readme/10-roles.md` "19 rôles" matches the enum [V]; it names "Direction Marketing" as if a role — it is the label of `PRODUCT_MANAGER` (`labels.ts:49`) [V].
8. `docs/readme/29-architecture-du-code.md:25` lists `session.ts` as "requireUser / requireModule" only — it also holds `getCurrentUserPourEcrire`, `requireUserAuNomDeLaVue`, Vue exacte resolution [V].
9. `rbac.ts:18-27` header says "two layers" (matrix + overrides/row grants); the code has a third, large layer of implicit grants (`grantImplicit`) [V].
10. `scripts/auto-test/README.md` presents `autotest` "utilisable comme garde CI" — there is no `.github/workflows` directory; it is not wired to CI [V]. Its live anonymous pass expects every page to redirect to `/login`, which `(app)/layout.tsx` provides even without middleware, so it cannot reveal that the middleware is dead; it does not probe API routes or server actions [V by README/`lib.ts`].

---

## 10. Verified vs uncertain (claim ledger)

**Verified [V]** (file:line read):
- Middleware not compiled (re-checked on 15.5.28): Next 14.2.35 `rootDir = join(appDir,"..")` = `src/` (`node_modules/next/dist/build/index.js:476-488`); no `src/middleware.ts`; repo-root `middleware.ts` ignored. Whitelist text `auth.config.ts:16-57` therefore dead; Auth.js redirect-on-false semantics `node_modules/next-auth/lib/index.js:156-164`.
- Protection audit without middleware: 11 pages outside `(app)` and 129 API handlers in 121 files (table §4.1b); `(app)/layout.tsx:45-55`.
- Credentials flow, lockout policy, session creation, JWT fields — `auth.ts:27-160`, `login-throttle.ts:10-71`.
- Revocation check & live role — `session.ts:117-123,186-195`; all guard signatures — `session.ts:205-271`.
- Revocation call sites and their absence on role change/`toggleUserActive` — `access-actions.ts:232,305,329,365`, `admin-actions.ts:62-115`, `auth-actions.ts:37-79`, `hr/depart.ts:52`.
- 19 roles, 70 modules, 7 actions; predicates; `accesAttribue`; `getAccess` queries & implicit grants; `userCan` — `rbac.ts` lines cited in §4.5.
- `canAccessEntity` structure incl. `default: return true` — `entity-access.ts:516-1063`.
- Override/row-grant/seat models — `schema.prisma:5349-5401`; admin guard — `garde-comptes.ts:25-38`.
- Supplier portal cookie/login — `supplier-auth.ts:13-88`, `supplier-portal-actions.ts:10-35`.
- API key auth, scopes, `handle()` — `lib/api/auth.ts:17-104`, `http.ts:44-80`, `scopes.ts:13-43`; document-content fail-open — `api/v1/documents/[id]/content/route.ts:27-34`.
- Site-web HMAC — `entrant.ts:63-100`; audience gate — `audience/route.ts`, `audience-collecte.ts`.
- OnlyOffice tokens/callback — `onlyoffice.ts:11-153`, `callback/route.ts:16-60`, `file/route.ts:15-40`, `onlyoffice-session.ts:55-111`.
- Headers/CSP — `next.config.mjs:129-169`; crypto key derivation — `secret-box.ts:14-48`, `drive-storage.ts:28-36`; audit — `audit.ts:23-90`; upload policy — `politique-televersement.ts:18-53`; inline serving — `telechargement.ts:95-112`.
- Ratchets: `session-vue-exacte.test.ts:109-133`, `access-implicit-block.test.ts:96-97`, `client-bundle-guard.test.ts:28-145`, `contrat.test.ts:148`; autotest — `scripts/auto-test/README.md`, `lib.ts:64-129`, `run.ts:116`.
- Page guard statistics (283/199/42/42) — scripted count over `src/app/(app)/**/page.tsx`.

**Uncertain [U]**:
- Runtime confirmation of R1 (XSS), R2 (SSRF), R10 (anonymous action invocation) — derived from code, not executed; no `.next` build present to inspect `middleware-manifest.json`.
- Whether the middleware ever lived in `src/` (shallow git history).
- The API-handler scan is regex-based; a handler whose guard sits in an imported helper with an unusual name could be misclassified as guarded.
- `peutSeConnecter` body (assumed: inactive or system ⇒ false).
- Next 14.2 server-action CSRF (Origin check) behaviour in this deployment (behind Render proxy, `AUTH_TRUST_HOST`).
- Whether Drive file download routes share R1 (not inspected).
- Completeness of the 86 "no visible guard" server actions list (heuristic regex; only 6 spot-checked).
- `scripts/api/issue-key.ts` existence/behaviour (taken from `API_SECURITY.md`).
- Mission heartbeat execution context (in-process) — not traced here.
