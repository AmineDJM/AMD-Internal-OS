# 05 — Frontend architecture, design system, UI/UX standards

> Knowledge-base chapter. Measured on `HEAD 11a281d` (2026-10-24). Graphify graph built from `41b2ef0e` (slightly behind).
> Tags: **[V]** = read in code (file:line cited) · **[U]** = inferred / not executed.

---

## 1. Scope

- The in-house component kit: `src/components/ui/*` (primitives), `src/components/shared/*` (composite building blocks), `src/components/layout/*` (the app shell: sidebar, topbar, mobile tab bar, palette, banners, background listeners), `src/components/charts/*` (hand-rolled chart kit) and the domain component folders (`ad-pro`, `hr`, `documents`, `workflow`, `chief`, …).
- Styling system: `tailwind.config.ts`, `src/app/globals.css`, `src/app/chief.css`, the `cn()` helper, icons, motion, charts.
- Server/client split (RSC pages → serializable props → `"use client"` islands → server actions), and the client-bundle boundary rule.
- UX conventions: French copy, `src/lib/labels.ts`, formatting (DZD, dates, Africa/Algiers), empty states, confirmations (`BoutonDecisif`), feedback, tables/filters, tabs, responsive/PWA, accessibility, print, document preview / OnlyOffice.
- Real-time UX: notification bell, unread badges, Web Audio chimes, messaging refresh.
- Verification of `docs/UI_UX_AUDIT.md` against current code; a house-style checklist.

Out of scope: RBAC internals (`rbac.ts`), the Adam/Chief-of-Staff product internals (only its CSS isolation is noted), server-action business logic.

## 2. Summary

- **Every route page is a React Server Component** (0 of 294 `page.tsx` start with `"use client"`); 566 of 948 `.tsx`/`.ts` files under `src` are `"use client"` islands fed by serializable props (ISO strings, numbers) [V].
- The "shadcn-style" kit is **much thinner than shadcn**: no Radix, no `class-variance-authority`, no Tabs/Dropdown primitives. `ui/` = Button, Badge, Card, Input/Textarea/Select/Label, Table, Sheet, Progress, Avatar, Icon, InfoBulle, BoutonDecisif, and since V3-B (28/10/2026) **DialogueConfirmation (`useConfirmer`/`useSaisir`) and Retour (`<Retour>`/`useRetours`)** [V].
- One visual language: CSS-variable tokens in `globals.css` (azure brand `#1677FF`, night-blue sidebar, 4 status colours + `info` + reserved `luna` violet); **no dark mode** despite `darkMode: ["class"]` [V].
- Two house mechanisms dominate interaction: **`BoutonDecisif`** (two-click confirmation, no `window.confirm`) and **`useAction` / `useKeyedAction` / `useRafraichir`** (server action call with throw-catch, 45 s watchdog, and `router.refresh()` inside a transition so buttons stay locked until fresh data is on screen, §118.172) [V].
- Forms mostly go through `CreateRecordButton` → `Sheet` → `RecordForm` (`useActionState` + guarded action + redirect to `${redirectBase}/${id}`) [V].
- Real-time is **polling only** (no SSE/WebSocket for app data): notifications every 15 s (single poller since PERF-04; the chime listens), messaging badge every 12 s, open conversation every 3.5 s; sounds generated with Web Audio oscillators [V].
- Several source-scanning Vitest "ratchets" enforce UI rules (client bundle, responsive tables, decisive buttons, icon names, dead links, no `loading.tsx`, bare `router.refresh()` ceiling) [V].
- `docs/UI_UX_AUDIT.md` (measured 2026-08-30) is directionally right but numerically stale; some debts grew (dead `dark:` classes 33 → 212, raw Tailwind palette), others improved (aria-live 0 → 25) [V].

## 3. Key files

| Path | Role |
|---|---|
| `tailwind.config.ts` | Maps semantic tokens `hsl(var(--x))`, `xs: 480px` breakpoint, radius scale, Inter font var, `fade-in`/`slide-in`/`slide-up` animations |
| `src/app/globals.css` (451 l.) | All ERP colour tokens, mobile root scaling, z-index scale, `.surface`, `.table-clean`, `.focus-ring`, `table.mobile-cards`, `.ik-mail` scoped theme, `amd-focus` full-screen mode |
| `src/app/chief.css` (439 l.) | Separate token system `--chief-*` scoped under `.chief-root`, imported only by `src/app/(app)/chief-of-staff/page.tsx:20` |
| `src/app/layout.tsx` | Root: `<html lang="fr">`, Inter via `next/font`, manifest, viewport/theme-color |
| `src/app/(app)/layout.tsx` | The authenticated app shell (RSC): auth gates, nav computation, unread counts, providers, sidebar/topbar/tab bar, background listeners |
| `src/lib/utils.ts` | `cn()`, `formatCurrency`, `formatMontant`, `formatDate`, `formatDateTime`, `formatMonth`, `toNumber`, `percent`… |
| `src/lib/calendar-tz.ts` | Client-safe Africa/Algiers helpers (`algiersYmd`, `formatAlgiers`, `algiersInputToUtc`…) |
| `src/lib/labels.ts` (2,284 l.) | French labels + `BadgeTone` for every enum, `ROLE_LABELS`, all `*_TABS`, `NAVIGATION`, `moduleForPath` |
| `src/lib/nav-access.ts` | `navigationFor(user)` — filters `NAVIGATION` by RBAC, hidden modules, features, gates (server) |
| `src/components/ui/*` | Primitives (see §4.2) |
| `src/components/shared/*` | `DataTable`, `StatusBadge`, `EmptyState`, `PageHeader`, `ModuleTabs`, `KpiCard`, `Tuile`, `CreateRecordButton`, `form-fields`, `BackLink`, `use-action`, `use-rafraichir`, `RecordDeleteButton`… |
| `src/components/layout/*` | `sidebar`, `topbar`, `mobile-tabbar`, `command-palette`, `messages-indicator`, `notification-chime`, `notification-popup`, `push-register`, `nav-progress`, `chrome-metrics`, `focus-mode`, `screen-guard`, `session-recorder`, banners |
| `src/components/charts/*` | Pure SVG/HTML chart kit (`Bars`, `Meter`, `Donut`, `Trend`, `Projection`, `Repartition`) + validated colour `palette.ts` |
| `src/components/documents/document-preview.tsx` | In-app document viewer with toolbar (print, edit in OnlyOffice, rename, download, delete) |
| `src/app/(app)/drive/[id]/edit/office-editor.tsx`, `src/components/documents/editeur-en-ligne.tsx` | OnlyOffice `DocsAPI.DocEditor` embeds |
| `public/manifest.webmanifest`, `public/sw.js`, `src/components/layout/push-register.tsx` | PWA install + Web Push (no offline cache) |
| `src/lib/client-bundle-guard.test.ts` | Fails `npm test` when a client component reaches Node-only modules |
| `src/lib/responsive-guard.test.ts`, `src/lib/ui/*.test.ts`, `src/components/ui/*.test.ts`, `src/components/shared/rafraichir.test.ts` | UI ratchets (see §8) |

## 4. How it works

### 4.1 Styling foundation

- **Tokens, not colours.** `tailwind.config.ts:20-84` maps `border, input, ring, background, foreground, primary, info, secondary, destructive, muted, accent, success, warning, luna, card, popover, sidebar.*` to `hsl(var(--…))` [V]. Values live in `globals.css:5-83` with design rationale: background `216 38% 97%` (#F6F8FB, never pure white), cards pure white, single brand colour `--primary: 215 100% 54%` (#1677FF, "5–10 % of the screen"), status colours *only* for status (`--success/--warning/--destructive/--info`), `--luna` violet reserved for what the AI "Luna" pre-filled (`globals.css:55-60`, `[data-luna="1"]` rule near `:318`) [V].
- **Comment-as-spec**: "Toute couleur vit ici — aucune valeur en dur dans un écran" (`globals.css:7-14`) [V].
- **Radius** `--radius: 0.625rem` → `rounded-lg/md/sm` (`tailwind.config.ts:86-90`) [V].
- **Font**: Inter through `next/font/google` with `variable: "--font-inter"` (`src/app/layout.tsx:10-14`), chained into `--font-sans` (`globals.css:81`) and `fontFamily.sans` [V].
- **Dark mode**: `darkMode: ["class"]` (`tailwind.config.ts:4`) but no `.dark` token block exists in `globals.css`; `chief.css:12-15` states it explicitly ("L'ERP n'en a pas"). Root viewport still declares a dark `theme-color #0b1220` for `prefers-color-scheme: dark` (`src/app/layout.tsx:35-38`) [V].
- **Scoped themes**: `.ik-mail` re-skins primary/accent/status for the Courrier (mail) module only with Infomaniak colours, plus `[data-accent="blue"]` (`globals.css:86-108`) [V]. Adam/Chief-of-Staff has its own token system under `.chief-root` (`chief.css:18+`) loaded only on that route [V].
- **Mobile scale**: below 1024 px the root font is 106.25 % (17 px) so every `rem` grows together (`globals.css:120-145`) [V]. A custom `xs: 480px` screen exists (`tailwind.config.ts:15-19`).
- **z-index scale** (documented, `globals.css:261-282`): 30 topbar · 40 mobile tab bar · **50 every modal/sheet/drawer** · 60 "Tout" drawer/mail reader · 90 fullscreen mail · 100 command palette · 200 admin popup [V].
- **Utilities**: `.surface` = bordered white card with 1-px shadow (shadow removed < 640 px) (`globals.css:284-290`); `.motion-fast` 150 ms; `.table-clean`; `.badge-soft` (unused); `.focus-ring`; `table.mobile-cards` (`:367+`); `:root.amd-focus` full-screen mode (`:436-451`) [V].
- **`cn()`** = `twMerge(clsx(...))` (`src/lib/utils.ts:5-7`) — used by every primitive so caller classes override defaults [V].
- **Icons**: `lucide-react@0.446.0`, imported directly in 664 files [V]. String-named icons (config-driven nav, `EmptyState icon="Inbox"`) go through `Icon`/`iconeParNom` (`src/components/ui/icon.tsx:23-35`), which accepts renamed legacy names; `icon-names.test.ts` checks every literal name resolves (§118.149 in code) [V]. Note `icon.tsx` does `import * as Lucide` + `icons` — the whole icon table enters any client bundle that uses `Icon`. **Since 2026-10-28 (PERF-05)** the shell (`sidebar`, `topbar`, `command-palette`, `mobile-tabbar`, `office-pins`) uses `IconeCoque` (`ui/icone-coque.tsx`) over the static named-import table `ui/icones-coque.ts`; a name missing from the table lazy-loads `Icon`. Ratchet `icones-coque.test.ts` (every shell name present, no unused entry, no full-set import in `components/layout`). 8 page-level client files still use `Icon`. Measure: `node scripts/mesure-bundle.mjs` [V].
- **Motion**: CSS keyframes only (`tailwind.config.ts:94-115`; doctrine "150 ms, jamais plus", `globals.css:291-294`). `framer-motion` is installed but imported by a single file, `src/components/assistant-beta/luminescent-cursor.tsx` [V].
- **Charts**: the shared kit `src/components/charts/*` is **dependency-free SVG/HTML, server-renderable** (no `"use client"`, no Recharts) with a CVD-validated 8-colour `SERIES` + `OTHER_COLOR` + `INK` (`palette.ts:17-40`; "jamais la couleur seule", always labels/legend) [V]. Recharts (`2.12.7`) is imported in only 4 files: `components/dashboard/charts.tsx`, `stocks/stocks-view.tsx`, `medical/rapports/overview/overview-charts.tsx`, `budgets/marketing-graphiques.tsx` [V].

### 4.2 Primitive inventory (`src/components/ui`)

| Component | API / variants | Client? |
|---|---|---|
| `Button` (`button.tsx:4-44`) | `variant`: `primary` (default) · `secondary` · `outline` · `ghost` · `destructive` · `success`; `size`: `sm` (h-9 → `sm:h-8`) · `md` (h-10) · `lg` (h-11) · `icon` (10×10); forwardRef; `focus-ring`, `disabled:opacity-50` | no |
| `BoutonDecisif` (`bouton-decisif.tsx:8-192`) | Same props as `Button` + `confirmation?` (action name), `brut?` (bare `<button>`), `delaiMs?` (5 000). First click arms → "Confirmer : <action> ?" + "Annuler"; second click within 5 s executes; Escape disarms; announces via live region (`annonceArme`) | yes |
| `Badge` (`badge.tsx:5-35`) | `tone`: `neutral` · `info` · `success` · `warning` · `danger` · `purple` (the only hard-coded tone: `bg-purple-100 text-purple-700`, `:11`); `dot?` | no |
| `Card`, `CardHeader/Title/Description/Content/Footer` (`card.tsx`) | `Card` = `.surface`; header `p-5` | no |
| `Input`, `Textarea`, `Select` (native `<select>`), `Label` (`input.tsx`) | h-10, `border-input bg-card`, `focus-visible:ring-2 ring-ring` | no |
| `Table`, `TableHeader/Body/Row/Head/Cell` (`table.tsx:20-72`) | `mobileCards?` → under 640 px each row becomes a card; `EtiquettesMobiles` (client) copies `<th>` text into `data-label`; otherwise wrapper is `overflow-x-auto` | `Table` no; `EtiquettesMobiles` yes |
| `Sheet` (`sheet.tsx:26-76`) | `open, onClose, title, description?, footer?, width: md\|lg\|xl`; right-side panel on desktop, bottom sheet with grab handle on phones; `role="dialog" aria-modal`; Escape closes unless `defaultPrevented` (armed BoutonDecisif consumes it); counted scroll lock (`useScrollLock`) | yes |
| `Progress` (`progress.tsx`) | `tone`: primary/success/warning/danger | no |
| `Avatar` | `size`: sm/md/lg, initials | no |
| `Icon` / `iconeParNom` | lucide by string name | no |
| `InfoBulle` (`info-bulle.tsx:14`) | ⓘ tooltip, `label` default "Plus d'informations", `align` | yes |
| `DialogueConfirmation`, `useConfirmer()`, `useSaisir()` (`dialogue.tsx`, rule `dialogue-regle.ts`) — V3-B | `await confirmer("Supprimer ce document ?")` → `boolean`; `await saisir({ titre, saisie: { libelle, obligatoire } })` → `string \| null`. A plain string suffices: 1st paragraph = title, rest = detail, button = the verb when known (closed list) else "Confirmer"; cancel is always "Retour". `role="alertdialog"` + `aria-modal`, labelled/described, focus enters (on "Retour" for a risky gesture — `danger` tone auto-detected from supprimer/retirer/corbeille/irréversible…), Tab loops (`sautDeFocus`), Escape captured before an underlying `Sheet`, focus restored, voile click cancels, `z-[100]`, queued requests | yes |
| `Retour` (bandeau), `useRetours()` (avis flottants) (`retour.tsx`, rule `retour-regle.ts`) — V3-B | `<Retour ton="erreur\|alerte\|succes\|info">{err}</Retour>` renders nothing when empty; `role="alert"` for erreur/alerte, `status` otherwise. `useRetours().erreur/alerte/succes/info(msg)`: two `aria-live` regions present from first render; erreur/alerte stay until closed, succes/info 4–10 s; same message not stacked; max 3; above the mobile tab bar, `z-[110]` | yes |
| `PrimitivesUI` (`primitives-ui.tsx`) — V3-B | Mounts `RetoursProvider` (`retours-porteur.tsx`) + `DialoguesProvider` (`dialogue.tsx`) once in `app/(app)/layout.tsx` and `app/(portal)/layout.tsx` — not the root layout, a separate build entry that would duplicate them in every page's JS. The dialog window (`dialogue-fenetre.tsx`), the toast drawing (`retours-pile.tsx`) and the ⌘K palette / announcement window are fetched at browser idle (`differe.ts`), outside the shell budget; offline, confirmation falls back to the native box and toasts to plain text in the same `aria-live` region. Without a provider the hooks fall back to the native box (the only `window.confirm/alert/prompt` allowed, in `dialogue.tsx` and `retours-porteur.tsx`) | yes |

There is no Tabs, Dropdown, Popover or Tooltip primitive (other than InfoBulle) [V]. Since V3-B (28/10/2026) there **is** a confirmation dialog and a feedback (toast/banner) primitive — see the rows above and § 4.7. Modals are `Sheet` (127 importers) or ad-hoc `fixed inset-0` overlays (21 files) [V].

### 4.3 Shared building blocks (`src/components/shared`)

- `PageHeader` (`page-header.tsx:11-24`): `<h1>` `text-xl sm:text-2xl`, optional description, right-side actions slot; `min-w-0` + `break-words` to avoid horizontal page scroll [V]. Used in 175 files.
- `DataTable<T>` (`data-table.tsx:27-260`, client): `columns: Column<T>[]` (`key, header, align, sortable, render?, accessor?`), `rows`, client-side search (default placeholder "Rechercher…"), tri-state sort with `localeCompare(…, "fr")`, pagination (`pageSize` 12), CSV export with BOM for Excel, `getRowHref` for clickable rows, empty state ("Aucune donnée") [V]. Because `render`/`accessor` are functions, the columns **must be declared inside a client wrapper** (e.g. `sponsoring-table.tsx`); the RSC page only passes `rows` [V]. Only 10 files use it — most lists are hand-built `<Table>` (90 importers) or raw `<table>` (97 occurrences) [V].
- `StatusBadge` (`status-badge.tsx:11-18`): `map` (a `labels.ts` record) + `value` → `<Badge tone dot>`; unknown value falls back to the raw value in neutral; null → "—" [V].
- `EmptyState` (`empty-state.tsx:9-19`): dashed box, icon (default `Inbox`), title, description [V]. 93 files.
- `ModuleTabs` (`module-tabs.tsx:37-106`, client): **route-based tabs** — each tab is its own route guarded by its own module; `show` filters; single visible tab → no bar; most-specific match wins (`ongletActif`, §118.164 in code); `aria-current="page"` (`:81`); optional prev/next chevrons (`arrows`); count pill with `tonCompte`; single horizontally scrolling row on phones with the active tab scrolled into view [V].
- `KpiCard` (tones default/success/warning/danger/info + trend) and `Tuile` (label/value/context + `info` slot) [V].
- `CreateRecordButton` / `RecordForm` (`create-record-button.tsx`, 619 l.): declarative `FieldDef[]` (`text` with `inputType` number/date/datetime-local, `textarea`, `select`, `multiselect`, `checkbox`, `file`, `drivepicker`, `parties`, `hidden`), optional AI prefill (`analyze`), `autoOpenParam` (opens via `?new`), opens a `Sheet` (`:584-619`) [V].
- `form-fields.tsx`: `Field`, `TextField`, `TextAreaField`, `SelectField`, `optionsFromMap` (turn a labels map into options) [V].
- `use-action.ts` — **the single way to call a server action from a client island** (V3-B):
  - `useAction(opts?)` → `{ saving, busy, err, setErr, run(fn, onOk?, { confirmer?, succes? }) }`;
  - `useKeyedAction(opts?)` → `{ busy: key, error, setError, run(key, fn, { confirmer?, succes? }) }`;
  - `useFormAction(fn, { prepare?, onOk?, confirmer?, succes?, signalerErreurs? })` → `{ action, busy, err, setErr }` for `<form action>`, with a synchronous anti-double-submit lock.
  - All three: catch throws, 45 s watchdog, `actionFailureMessage` (never "réessayez"), refresh via `useRafraichir` on success, `confirmer` asked BEFORE the call (dialog), `succes` announced after. `opts.signalerErreurs` also sends errors to a floating notice (for icon-only row gestures). A refusal with no `error` → `REFUS_SANS_MOTIF`.
- `use-rafraichir.ts:29-36`: `rafraichir()` wraps `router.refresh()` in `useTransition`; `enCours` stays true until new RSC payload is rendered (§118.172) [V].
- `BackLink` (`back-link.tsx`): real `<Link>` that goes `router.back()` when there is in-app history (counted per tab in `sessionStorage` by `NavDepthTracker` mounted in the shell), else its written `href` [V]. 80 files.
- `RecordDeleteButton` (creator-level soft delete to admin trash, honest copy), `SuperAdminDeleteButton`, `CommentThread`, `EntityLinks`, `LinkedRecords`, `ValidationStepper`, `PartagerButton`, `CompanyBadge`… [V names; internals not reviewed].

### 4.4 App shell (`src/app/(app)/layout.tsx`)

Server layout, in order [V]:
1. `requireUser()` (`:46`); redirect `/change-password` if `mustChangePassword`; DB read of `mustOnboard` → `/onboarding` (skipped while impersonating) (`:47-57`).
2. `navigationFor(user)` (`:60`) — `src/lib/nav-access.ts:59-161` filters `NAVIGATION` by `accessibleModules`, admin-hidden modules, feature flags and gates (`regEnrollment`, `pipeline`, `payroll`, `myTeam`, `adamMissions`, `adam`, …). A forbidden entry is never sent to the browser.
3. `Promise.all` (`:62-77`): unread notification count, messaging unread (`getTotalUnread`), adoption badge, companies, unread notification links → per-module sidebar badges via `reécriteLienNotification` + `moduleForPath` (`:84-91`).
4. Providers: `IdentiteProvider`/`GardeIdentite` (reloads the tab if the impersonation "view" cookie changed elsewhere), `UploadProvider`, `BackgroundUploadProvider`, `CallProvider` (WebRTC realtime voice survives navigation).
5. Chrome: `NavProgress` (top progress bar; **no `loading.tsx` by design**), `ActivityTracker`, `SessionRecorder` (action replay via `sendBeacon`, no field values), `FocusExit`, `NavDepthTracker`, `ScreenGuard` (screenshot-shortcut detection → audit), `CommandPalette` (Ctrl/Cmd+K, `/api/search`), `Sidebar` (client, poles grouping, open poles in `localStorage`), `ChromeMetrics` (measures banners+topbar into `--app-chrome-top`), banners (impersonation, test mode, interim), `Topbar`.
6. `<main id={APP_SCROLL_ID}>` (`:153`) is the scroll container (`overflow-y-auto overflow-x-hidden overscroll-contain`, safe-area padding); content in `.page-shell` with `max-width: var(--shell-max, 1400px)` — dense screens may raise `--shell-max`.
7. After main: `MobileTabBar` (hidden ≥ `lg`), `PushRegister`, `NotificationChime`, `NotificationPopup`, `AssistantWelcomeDialog`.

Error/404: `src/app/(app)/error.tsx` (client, `reset()` + digest), `src/app/(app)/not-found.tsx`, `src/app/not-found.tsx`; no `loading.tsx` anywhere (enforced by `src/lib/ui/loading-boundary.test.ts`) [V].

### 4.5 Server vs client split

- Counts [V]: 948 `.tsx` files under `src`; 566 files (`.ts`+`.tsx`) start with `"use client"`; 198 start with `"use server"`; 294 `page.tsx` under `src/app`, **none** client.
- Pattern: page (RSC) does `requireModule`/`requireUser` + `userCan` + Prisma query, maps rows to plain objects (`Date → toISOString()`, `Decimal → toNumber`), passes them and boolean capabilities (`canCreate`, `isResponder`) to a co-located client file (`*-table.tsx`, `panel.tsx`, `*-board.tsx`) [V: `sponsoring/page.tsx:52-65`, `support/[id]/page.tsx:23-27,125`].
- Server actions are imported **directly** inside client files (e.g. `support/[id]/panel.tsx:6`) or passed as props (`CreateRecordButton action={createSponsoring}`, `sponsoring/page.tsx:82`) [V]. They return `ActionResult { ok, error?, id?, message?, redirect?, … }` (`src/lib/actions/types.ts:4+`) and call `revalidatePath` (`sponsoring-actions.ts:280-284`) [V]. Some domains still define their own local `ActionResult` interface (`document-actions.ts:13`, `regulatory-actions.ts:46`, `regulatory-ctd-actions.ts:19`, `regulatory/intelligence/actions.ts:26`) [V].
- Hook usage [V, file counts]: `useActionState` 7, `useFormStatus` 3, `useTransition` 33, `useRafraichir` 96, `useAction`/`useKeyedAction` 9, bare `router.refresh()` 204 files (ceiling-tested, see §8).
- **Client/server boundary rule** (CLAUDE.md): a `"use client"` module must never reach `fs`, `zlib`, `child_process`… or Node-only packages through ordinary imports; server actions are exempt. `client-bundle-guard.test.ts` walks static + dynamic imports from every client file, stops at `"use server"` modules (`:99`), and fails on `NODE_ONLY` builtins (`:28`) or `NODE_ONLY_PACKAGES` (`web-push, nodemailer, imapflow, mailparser, sharp, mupdf, pdfkit, pdf-parse, yauzl, @mastra/core`, `:41-43`) [V]. Pure helpers are split into import-free modules (`*-ui.ts`, `*-regle.ts`, e.g. `bouton-decisif-regle.ts` "pure, sans import"; `vue-exacte-ui.ts` imported by the layout) [V].

### 4.6 Labels, copy and formatting

- `src/lib/labels.ts` is the French vocabulary: `BadgeTone` (`:12-18`), `Display {label, tone}` maps per enum (e.g. `SPONSORING_STATUS` `:246-252`: Reçu/neutral, En analyse/info, Accepté/success, Refusé/danger, Attente Direction/warning, Payé/success), `ROLE_LABELS` (`:25+`, 19 labels kept pairwise distinct by `role-labels.test.ts`), tab sets (`EVENTS_TABS`, `HR_TABS`, `ADMIN_TABS`… `:1502-1913`), `NAVIGATION` (`:1920`), `moduleForPath` (`:2256-2271`, longest-prefix match), `firstAccessibleHref` [V]. 295 non-test files import it [V].
- Tone semantics: green = validated, amber = waiting, red = blocking, blue (`info`) = in progress, grey = neutral (`globals.css:41-45`) [V].
- Copy style [V by reading]: French, plain, explains consequences ("VÉRIFIEZ D'ABORD LA LISTE…" on failure, `create-record-button.tsx:353-356`); never invites blind retry (duplicate risk, `use-action.ts:26-27`); descriptions say what happens *today* (comment §118.151 in `sponsoring/page.tsx:73-76`); action `message`s are shown, not swallowed (§118.168 in `consulting/[id]/actions-panel.tsx:70-72`).
- **Money**: `formatCurrency(value, "DZD", "fr-FR")` → "12 500 DZD" / "12 500,50 DZD", never rounded (decision 05/10/2026), "—" for null (`utils.ts:10-27`); `formatMontant` same without currency (`:34-38`); `formatCompact`, `formatNumber` [V]. Money inputs must not use `step="1000"` (`src/lib/saisie-montant.test.ts`) [V].
- **Dates**: `formatDate` (`2-digit/short/numeric`, `fr-FR`) and `formatDateTime` (`utils.ts:55-79`) **do not set `timeZone`** → they render in the process/browser time zone [V]. `formatMonth` uses UTC deliberately [V]. Algiers-correct helpers exist but are scattered: `src/lib/calendar-tz.ts` (client-safe, fixed +60 min offset), `assistant/reminders.ts:formatAlgiersDue`, and duplicated `jourAlger` in `adventum/briefing.ts:143`, `finance/tresorerie.ts:84`, `coaching/dates.ts:22`, `aujourdhuiAlger` in `modules/rh/domaine/absences.ts:33` [V]. 178 raw `toLocale*String(` calls in `.tsx` files bypass both [V].

### 4.7 Feedback, confirmation, empty/loading states

- **Feedback (V3-B, 28/10/2026)**: inline next to the gesture with `<Retour ton="erreur">{err}</Retour>` (role alert/status), or a floating notice with `useRetours()` when the gesture has no room to speak. Older inline blocks (`bg-destructive/10 … text-destructive`) remain valid but carry no role — prefer `Retour` when touching them. Two local ad-hoc toasts predate it (`segmentation/praticiens-table.tsx`, `drive/node-actions.tsx`).
- **Confirmation**: `BoutonDecisif` remains the doctrine for any gesture that decides, commits money, signs, emits, pays (second click on the button itself); `boutons-decisifs.test.ts` pins named call sites. Every other confirmation (delete a row, quit unsaved, reset a setting, type a reason) goes through `useConfirmer()` / `useSaisir()` (dialog) — or `run(fn, onOk, { confirmer })`. **`window.confirm/alert/prompt` are banned** (ceiling 0, `src/lib/ui/dialogues-natifs.test.ts`), as are generic fallbacks `?? "Échec." / "Erreur." / "Action impossible."` — write what did NOT happen.
- **Busy states**: `Loader2 animate-spin` inside the button, `disabled={saving}`; `useAction` gives a 45 s watchdog (`ACTION_TIMEOUT_MS`, `src/lib/action-outcome.ts:53`) and a pure failure message (`actionFailureMessage`) [V].
- **Loading**: no Suspense skeletons; `NavProgress` top bar instead [V].
- **Empty**: `EmptyState` or `DataTable emptyTitle` [V].

### 4.8 Tables, filters, tabs

- Filters are **URL search params** read in RSC pages (`searchParams.vue`, `.bu`, `.produit`, `.dossier`, `.statut`, `.etape`, `.annuaire`, `.year`, `.pole`, `.p`…) [V by grep]. Module-level tabs are separate routes (`ModuleTabs`); `?tab=` is used in only 1 file; 11 files hand-roll `role="tablist"` [V].
- Wide tables: wrap in `overflow-x-auto` or use `<Table mobileCards>` (10 files); `responsive-guard.test.ts` fails a wide table outside a scroll container and un-prefixed `col-span-N` in 1-col grids [V].

### 4.9 Responsive / PWA / print / accessibility

- Mobile-first touches: `MobileTabBar` bottom nav (Espace, Messages, Assistant, "Tout" full grid) hidden ≥ `lg`; `Sheet` becomes a bottom sheet; button `sm` is 36 px on phones; safe-area insets everywhere; `.page-shell` makes top-level cards edge-to-edge < 640 px (`globals.css:333-365`) [V].
- **PWA**: `manifest.webmanifest` (standalone, portrait, `#0b1220`, single SVG icon "any"/"maskable"); `public/sw.js` handles `install/activate/push/notificationclick` and, since J13 (decision 0025), a **narrow offline cache**: only the `/medical/terrain` navigation (network first, fallback copy) and the `/_next/static/` files that page loads; captured audio/photos wait in IndexedDB (`ecrans/terrain/file-locale.ts`), never in the SW [V]. `PushRegister` registers `/sw.js`, fetches VAPID key from `/api/push/key`, subscribes via `/api/push/subscribe` (`push-register.tsx:18-47`) [V].
- **Print**: a single dedicated print route, `src/app/impression/coaching/[id]/page.tsx` (A4 `@page`, `print:hidden` controls, `toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })` `:49`), outside the `(app)` shell [V]. Documents print via `printDocument` from `DocumentPreview`; `window.print()` in `coaching/fiche-actions.tsx` and `messagerie/mail-workspace.tsx` [V].
- **Accessibility practices present** [V]: `lang="fr"`; `aria-label` on icon buttons ("Fermer", "Messagerie"); `aria-current="page"` on tabs; `role="dialog" aria-modal` on `Sheet`; BoutonDecisif live announcement; `focus-visible` rings in `Input`/`Button` (68 occurrences, 21 files); `palette.ts` "never colour alone". Gaps: 952 raw `<button>` vs 353 files importing `ui/button`; only 8 files with `role="dialog"` for 21+ custom overlays; no focus trap in `Sheet` [V for counts; U for full a11y audit].

### 4.10 Document preview & OnlyOffice

- `DocumentPreview` (`src/components/documents/document-preview.tsx`, client): clickable name → in-app viewer (`ApercuUniversel`, `ZipViewer`) with toolbar (print, edit in Office if extension in `OFFICE_EDIT`, rename/delete via `document-actions`, download via `BoutonTelecharger`), `srcOverride` to read bytes from non-`Document` routes (payslips) [V].
- OnlyOffice: `office-editor.tsx` loads the Document Server `api.js` with `next/script`, instantiates `new window.DocsAPI.DocEditor("onlyoffice-editor", config)` (`:73-75`), shows an explicit error if the script fails (`:185`); `editeur-en-ligne.tsx` does the same with its own loader and timeout (`:33-41,112-114`); `src/app/office-embed/[id]/page.tsx` is a shell-less embed [V].

- Assistant IA (`src/components/assistant-beta/apercu-piece.tsx`, decision 0015): a side panel that renders `ApercuUniversel` **without** an edit target (read-only viewers), loaded with `next/dynamic` on first open so `/assistant` does not pay for the Office viewers; download via `/api/drive/<id>/raw?dl=1`, "Ouvrir dans le Drive", Escape closes and restores focus [V].
- **Atelier** (J3, decision 0017) [V] `src/modules/assistant-ia/ecrans/atelier/`: tabbed document pane beside the chat in
  `/assistant` (`assistant-workspace.tsx`: glass container becomes `flex-row`, conversation width via `--conversation`
  25–75 %, `role="separator"` handle with arrow keys, full-screen toggle, `fixed inset-0` panel below `lg`). Renders with the Live
  Office scenes exported from `platform/ia/ecrans/blocks/artifact.tsx` (`SceneDocx/Pdf/Pptx/Xlsx`, now with `data-id` and
  multi-cell highlight). Effects in `atelier.css` (keyframes `atelier-lueur`, `atelier-ecrit` clip-path reveal,
  `atelier-apparait`), all disabled under `prefers-reduced-motion`. Review list (`data-testid="atelier-modif"`, `data-etat`),
  compare overlay, conversion menu, inline `ActionConfirmationCard` for sensitive saves. Polls `/api/assistant-ia/atelier`
  (0.6 s while the assistant works, 8 s idle). The preview panel gains « Ouvrir dans l'Atelier ».

### 4.11 Real-time UX — polling + Web Audio

| Signal | Mechanism | Interval | Ref |
|---|---|---|---|
| Notification chime + desktop `Notification` | `fetch("/api/notifications/poll")`, plays C5–E5–G5 sine arpeggio when `unread` increases | 20 s + on `visibilitychange` | `notification-chime.tsx:22-47,72-88` [V] |
| Admin pop-up notifications | same endpoint, `popups[]` | 15 s | `notification-popup.tsx:32,44` [V] |
| Messaging unread badge (topbar + sidebar) | `fetch("/api/messaging/sync")`, broadcast `CustomEvent("amd:messaging-unread")`; ping sound + desktop notification on increase; paused on `/messages` | 12 s | `messages-indicator.tsx:105-185`, `sidebar.tsx:44` [V] |
| Open messenger | sync / thread poll when tab visible | 6 s / 3.5 s | `messages/messenger.tsx:73,139` [V] |
| Assistant | the only SSE (`text/event-stream`) route, `api/assistant/stream` | streaming | [V] |
| Background push | Web Push through `sw.js` | server-initiated | [V] |

Audio contexts are unlocked on the first `pointerdown/keydown/touchstart` (autoplay policy) [V]. **The topbar bell count (`Topbar unreadCount`, `topbar.tsx:115-126`) comes only from the server layout render** — the chime detects new notifications but does not update the bell number [V]; it refreshes when the layout re-renders (`router.refresh()` / hard navigation) [U for exact Next 14 soft-nav behaviour].

### 4.12 Where screen code lives (domain folders)

Most screen-specific client code is **co-located with its route** under `src/app/(app)/<module>/…` (`*-table.tsx`, `panel.tsx`, `*-board.tsx`, `*-view.tsx`); `src/components/<domain>` holds only what several routes share [V by listing]. Sizes below = `.tsx` files / non-test lines [V]:

| Folder | Files / lines | Content |
|---|---|---|
| `ad-pro` | 28 / 6,716 | Ad & Pro request items panel (`items-panel.tsx`, many decisive buttons), pickers, BC flows |
| `chief` | 14 / 5,401 | Adam / Chief-of-Staff workspace (own CSS: `workspace/blocks*.css`), isolated from `ui/` |
| `layout` | 25 / 4,230 | App shell pieces (§4.4) |
| `shared` | 31 / 4,124 | Composite blocks (§4.3) |
| `missions` | 10 / 2,868 | Mission runtime panels (heaviest raw-palette users) |
| `documents` | 9 / 1,920 | `DocumentPreview`, `ApercuUniversel`, `DocumentUpload`, `DocumentList`, Office viewers, ZIP viewer |
| `care` | 8 / 1,898 | Care/medical sub-screens |
| `hr` | 10 / 1,601 | Leave approvals, stand-in (interim) panel, HR widgets |
| `site-web` | 9 / 1,242 | Website editorial screens (still use `window.confirm`) |
| `kpi`, `directory`, `coaching`, `reservation-fiche`, `purchase`, `pieces`, `grille` | 4–1 files each | Domain widgets |
| `ui` | 12 / 772 | Primitives (§4.2) |
| `workflow` | 1 / 605 | `WorkflowPanel`, `HistoriqueDuCircuit` |
| `charts` | 5 / 439 | SVG chart kit (§4.1) |
| `assistant`, `assistant-beta` | 1 + 6 / 981 | Assistant welcome dialog, beta chat UI (most dead `dark:` classes) |

| Layout component | Role [V] |
|---|---|
| `sidebar.tsx` | Night-blue desktop nav; groups items into business "pôles" (`groupIntoPoles`, `lib/navigation.ts`), remembers open poles in `localStorage`, module badges + messaging badge via `amd:messaging-unread` |
| `topbar.tsx` | Search trigger (`amd:open-palette`), `CompanySwitcher`, `MessagesIndicator`, notification bell (server count), `UserMenu` |
| `mobile-tabbar.tsx` | Bottom tabs (Espace, Messages, Assistant, "Tout" grid), hidden ≥ `lg` |
| `command-palette.tsx` | Ctrl/Cmd+K, nav items + `/api/search`, arrow keys/Escape |
| `nav-progress.tsx` | Top progress line on internal link clicks (capture phase), replaces `loading.tsx` |
| `chrome-metrics.tsx` | Publishes measured chrome height (`--app-chrome-top`) for full-height screens (assistant, messaging, Office) |
| `focus-mode.tsx` | Full-screen mode via `html.amd-focus` + floating exit button |
| `identite-vue.tsx` | Per-person client storage keys + reload when the impersonated identity changes |
| `screen-guard.tsx`, `session-recorder.tsx`, `activity-tracker.tsx` | Compliance/support telemetry via `sendBeacon` (`/api/security/screenshot-attempt`, `/api/replay`, `/api/activity`) |
| `impersonation-banner`, `test-mode-banner`, `interim-banner` | Context banners above the topbar |
| `upload-manager`, `background-upload`, `call-provider` | Providers surviving navigation (uploads, WebRTC call) |

## 5. Conventions & patterns (house style)

1. **Page = RSC.** Guard first (`requireModule("X")`/`requireUser` + `userCan`), query Prisma, map to serializable rows (ISO strings, `toNumber`), `export const dynamic = "force-dynamic"` (as in `sponsoring/page.tsx:16`).
2. **Layout of a list page**: `<div className="space-y-5">` → `PageHeader` (title, one-sentence French description, actions on the right) → `ModuleTabs` (from a `*_TABS` constant in `labels.ts`, `show: userCan(user, t.module, "VIEW")`) → content in `.surface`/`Card`.
3. **Interactivity lives in a co-located client file** (`./xxx-table.tsx`, `./panel.tsx`); keep it free of server imports except `"use server"` actions and `import type`.
4. **Enum display**: never print raw enums; add the map to `labels.ts` (`{label, tone}`) and render with `StatusBadge`. Tone only from `BadgeTone`; colours only from tokens (`bg-success/10 text-success`, never `amber-500` or hex).
5. **Numbers**: `formatCurrency` / `formatMontant` (never round); dates `formatDate`/`formatDateTime`, and for anything day- or hour-sensitive use `calendar-tz.ts` helpers (Algiers).
6. **Creating a record**: `CreateRecordButton` with `FieldDef[]`, `action` returning `ActionResult`, `redirectBase`, `autoOpenParam="new"`.
7. **Calling an action from a button**: `useAction()` (single) or `useKeyedAction()` (several buttons); disable on `saving`/`busy`; render `err` inline. If you must call `router.refresh()`, use `useRafraichir()` and keep gestures disabled while `enCours`.
8. **Decisive gestures** (approve/refuse/pay/sign/delete/emit): `BoutonDecisif`, `confirmation="…"` when the label is an icon or ambiguous; no `window.confirm`; add the call site to `boutons-decisifs.test.ts` if it is a key decision.
9. **Panels/modals**: `Sheet` (z-50, Escape, scroll lock, bottom sheet on mobile). New overlays sit at z-50 or above, never below (tab bar is 40).
10. **Tables**: `ui/table` with `mobileCards` for wide data, or `overflow-x-auto`; `DataTable` when you want search/sort/CSV client-side (columns defined in the client file).
11. **Empty**: `EmptyState` with a lucide name and a French sentence that says what to do.
12. **Back navigation**: `BackLink` (keeps filtered context), not a hard-coded "Retour" link.
13. **Icons**: import lucide components directly; use `Icon name="…"` only for config-driven names (checked by `icon-names.test.ts`).
14. **No `loading.tsx`**, no new Suspense boundary above pages that may `redirect()`.
15. **Responsive**: `sm:col-span-N` not `col-span-N` in 1-col grids; `min-w-0` on flex children with long text; touch targets ≥ 36–40 px.
16. **Copy**: French, sentence case, states consequences and current rules; error messages never say "réessayez" blindly.
17. **Verify**: `npm run typecheck && npm run build && npm test && npx next lint`; after changing client imports, `rm -rf .next && npm run build` (CLAUDE.md).

## 6. End-to-end flows traced

### 6.1 Create a sponsoring request (list → sheet → server action → detail)

1. `GET /sponsoring` → `src/app/(app)/layout.tsx` renders the shell (auth, `navigationFor`, badges) [V].
2. `src/app/(app)/sponsoring/page.tsx:18-19`: `requireModule("SPONSORING")`, `canCreate = userCan(user, "SPONSORING", "CREATE")` [V].
3. `:31-40` loads form referentials through the shared loader `getAdProCreateData` and builds `FieldDef[]` with `sponsoringCreateFields` (one loader for both entry points, §118.5 in comment) [V].
4. `:43-61` queries `prisma.sponsoringRequest.findMany({ where: await clauseSponsoringsVisibles(user) })` and maps to `SponsoringRow` (ISO date, numbers) [V].
5. `:68-86` renders `PageHeader` + `CreateRecordButton action={createSponsoring} redirectBase="/sponsoring" autoOpenParam="new"` + `ModuleTabs(EVENTS_TABS)` + `<SponsoringTable rows>` [V].
6. `sponsoring-table.tsx` (client) defines `Column<SponsoringRow>[]` with `formatDate`, `formatCurrency`, `StatusBadge(SPONSORING_STATUS)` and renders `DataTable` [V].
7. Clicking "Nouvelle demande" (or arriving with `?new`, `useAutoOpen`) opens `Sheet` → `RecordForm` (`create-record-button.tsx:584-619`) [V].
8. Submit: `useActionState(guarded)` (`:362`); `guarded` try/catches the server action and returns a French "check the list first" error on throw (`:348-360`); a synchronous `lock` ref blocks double submit; a 45 s timer frees the button (`:409-418`) [V].
9. Server: `createSponsoring(_prev, formData)` in `src/lib/actions/sponsoring-actions.ts:69` (`"use server"`): `requireUserAuNomDeLaVue()`, `userCan(…"CREATE")` → `{ok:false, error:"Non autorisé."}`, field validation with French messages, create, `revalidatePath("/sponsoring" | "/ad-pro" | "/mon-espace")`, `return { ok: true, id, message? }` (`:280-284`) [V].
10. Client effect (`:420-433`): on `ok` closes the sheet and `router.push("/sponsoring/<id>")` (no refresh of the list being left); on `error` re-enables and shows it inline [V].

### 6.2 Decide on a workflow step (detail page → decisive button → refresh)

1. Detail page (RSC) loads `WorkflowView` and renders `WorkflowPanel` (`src/components/workflow/workflow-panel.tsx:84`) [V].
2. Panel uses `useRafraichir()` (`:98`); `pending = pendingAction || enCours` (`:100`) [V].
3. Approve/Reject/Return/Skip are `BoutonDecisif` (`:259-276`), reject/return require a note; first click arms ("Confirmer : Refuser ?"), second click within 5 s calls `submit("REJECT")` → server action `advanceWorkflow` [V].
4. On success `rafraichir()` → `router.refresh()` inside a transition; buttons stay disabled until the new RSC payload is on screen (§118.172) [V for code path; exact submit body U].

### 6.3 New-notification signal

Server code creates a `Notification` row → within ≤ 20 s `NotificationChime` polls `/api/notifications/poll` (RBAC: `getCurrentUser`, `Cache-Control: private, no-store`) → `unread` increased → Web Audio chime + desktop `Notification` (if tab unfocused and permission granted) → click opens `/notifications`. In parallel `NotificationPopup` (15 s) shows admin-broadcast popups; Web Push reaches closed tabs via `sw.js` [V].

### 6.4 Drop files/folders into the Assistant IA (decision 0015)

`window` drag listeners in `assistant-workspace.tsx` show the drop zone only when `dataTransfer.types` contains `Files` → on drop, `depot-navigateur.ts:lireDepot` takes the `webkitGetAsEntry()` entries **during** the event and hands them to the pure walker `lib/agent/lecture/depot.ts:parcourirDepot` (relative paths, system files skipped, depth/entry caps) → `planifierDepot` accepts/refuses (10 per message, 40 MB, empty, duplicate) and every refusal is announced in an `aria-live` line → chips (`pieces-jointes.tsx:PiecesEnAttente`, keyboard: Space selects, Delete removes, arrows move). **No upload before send**: `preparerPieces` uploads each file with `XMLHttpRequest` progress to `/api/drive/upload`, stops on the first failure (the text returns to the field — `CommandPillBar.onSendMessage` may return `false`), then `envoyerAuFil` carries the Drive ids. Assistant-returned files come from the `piecesRendues` field of `/api/assistant-ia/fil` (`/drive/<id>` links re-checked by `piecesCitees`) [V].

### 6.5 Field voice report, offline (J13, decision 0025)

`/medical/terrain` (`ecrans/terrain/ecran-terrain.tsx`, mobile-first, tested at 390 px by `e2e/terrain-voix.spec.ts`) → `MediaRecorder` / `<input capture="environment">` → **IndexedDB queue first** (state + blob in one transaction, key = idempotency key) → pure `viderFile` sends one item at a time to `/api/assistant-ia/terrain`, removes it only on server ack; 5xx/network → retry 5 s→5 min; 4xx → kept as « refusé » → server returns the capture with its **cards** rendered by the shared `ActionConfirmationCard`, confirmed through `confirmerCarteTerrain`. The status line (`phraseFile`) is always visible. The realtime voice panel (`ecrans/voix-temps-reel.tsx`) is portalled to `document.body` (the composer's backdrop blur would otherwise contain a `fixed` child) [V].

## 7. Coupling & blast radius

- **`globals.css` tokens** → every screen (via Tailwind semantic classes). Changing `--warning`/`--success` fixes or breaks all badges at once; changing `--primary` re-skins all buttons except Courrier (`.ik-mail`) and Adam (`chief.css`) [V].
- **`ui/button.tsx`** → 353 importer files + `BoutonDecisif` (which wraps it). Renaming a variant breaks typecheck across the app [V].
- **`ui/badge.tsx` + `labels.ts` `BadgeTone`** → `StatusBadge`, `KpiCard`, 454 `<Badge>` usages; adding a tone requires adding it to `Badge.tones` [V].
- **`labels.ts`** → 295 importers *and* the server nav (`nav-access.ts`), `moduleForPath` (sidebar badges in the layout, notification routing), tabs on ~65 pages. Changing an `href` in `NAVIGATION`/`*_TABS` affects active-tab logic, badges, and `dead-links.test.ts` [V]. It must stay client-safe (only type imports + `chemins/*` constants) because client components import it [V: imports `labels.ts:1-5`].
- **`(app)/layout.tsx`** → runs 5+ queries on every navigation-render of the shell; adding a slow query there slows every page [V/U].
- **`create-record-button.tsx`** → 23 files' creation flows [V].
- **`use-action.ts` / `use-rafraichir.ts`** → ~100 files; `rafraichir.test.ts` ceiling (`PLAFOND_APPELS_NUS = 326`, `:68`) [V].
- **`/api/notifications/poll`, `/api/messaging/sync`** → polled by every open tab (one request per 20 s, 15 s and 12 s per tab, plus 6 s/3.5 s on `/messages`) — load scales with open tabs × users [V code; U capacity].
- **`client-bundle-guard`**: any new Node-only dependency must be added to `NODE_ONLY_PACKAGES` or it slips through (only builtins regex + explicit list) [V].
- **`Icon`** pulls the whole lucide `icons` table into client bundles that use it [V code; U size].

## 8. Invariants, gotchas, doctrine rules

- **Client bundle boundary** (CLAUDE.md; production broke twice — `market/data.ts` via `fs`, `messaging.ts` via `web-push`): ordinary imports from a client file must not reach Node-only code; split pure parts into an import-free module and re-export server-side. Guard: `src/lib/client-bundle-guard.test.ts` [V].
- **`npm run build` reuses `.next` cache**; Render runs `next lint` before build (§118.155) — one lint error blocks deploy [V CLAUDE.md].
- **No `loading.tsx` above redirecting pages** (Next 14.2 prod turned `redirect()` into client redirects → 26 screens "Application error") — `src/lib/ui/loading-boundary.test.ts`, `nav-progress.tsx:7-31` [V].
- **§118.172**: a state-changing gesture keeps its buttons closed until fresh data is displayed (`useRafraichir`); bare `router.refresh()` is ceiling-tested at **1** (the hook itself) since V3-B [V].
- **V3-B ratchets at zero** (28/10/2026): unguarded server-action calls (`src/lib/ui/action-gardee.test.ts`, 315 → 0), `confirm(` 125 → 0, `alert(` 46 → 0, `prompt(` 6 → 0, generic fallback 259 → 0 (`src/lib/ui/dialogues-natifs.test.ts`). Known blind spots of the unguarded-call detector: `const r: T = await f()` (annotated) and `await f(); setX(false)` without assignment — reviewed by hand during V3-B, not mechanically guarded.
- **Decisive buttons**: two-click confirmation, 5 s, Escape cancels; `Sheet` must not close on Escape when an armed button consumed it (`sheet.tsx:34-37`, `sheet-echap.test.ts`) [V].
- **Never round money**; inputs must not force `step="1000"` [V].
- **Action failure copy** never invites blind retry (duplicates) [V].
- **Status colour = information only**; `--luna` violet only for AI-proposed values [V].
- **z-index ≥ 50 for any modal** or the mobile tab bar (40) covers its buttons [V].
- **Main scroll container is `#APP_SCROLL_ID`**, not `body`: scroll locks target it (`useScrollLock`) [V].
- **Responsive guard**: wide tables need an `overflow-x-auto` ancestor; `col-span-N` must be `sm:`-prefixed in grids starting at 1 column [V].
- **Class collisions** (`w-full` + `w-16`) are tested (`src/lib/ui/class-collision.test.ts`) — `cn()` resolves conflicts only when used [V].
- **Hand-written links** to routes are checked by `src/lib/ui/dead-links.test.ts` [V].
- **Icons by name** must resolve (`icon-names.test.ts`, floor on names read, §118.17 in comment) [V].
- **Gotcha — time zone**: `formatDate/formatDateTime` have no `timeZone`; on a UTC server (Render default, no `TZ` in `render.yaml`) server-rendered times are 1 h behind Algiers and dates can shift near midnight; client components formatting the same ISO string during SSR vs hydration can differ [V code; U runtime TZ].
- **Gotcha — bell staleness**: chime plays but the bell digit only updates on layout re-render [V].
- **Gotcha — DataTable** cannot be fed `render` functions from an RSC page; always wrap [V].
- **Gotcha — hooks of the primitives** (`useConfirmer`, `useRetours`, `useAction`…) must be called at the top of a component, never inside a `.map` or a callback: in a row-level gesture, extract a small row component or lift the hook to the list.
- Section numbers cited in code (§118.149, §118.164, §118.151) do not always map one-to-one to a same-topic paragraph in `docs/claude-md` (e.g. §118.149 there covers Ad & Pro thresholds with sub-items a–i) [U — spot-checked only].

## 9. Docs-vs-code discrepancies

| Doc claim | Reality | |
|---|---|---|
| `docs/readme/29-architecture-du-code.md:22`: `shared/ (DataTable, StatusBadge, DocumentPreview, ModuleTabs…)` | `DocumentPreview` is in `src/components/documents/document-preview.tsx` | [V] |
| `docs/readme/06-stack-technique.md:9`: "design system maison (style shadcn/ui) · lucide-react · Recharts" | No Radix/cva; no Dialog/Tabs/Toast/Dropdown primitives. Recharts used in 4 files only; the shared chart kit is custom SVG | [V] |
| UI_UX_AUDIT §1: `globals.css` 384 l., `chief.css` 375 l. | 451 and 439 lines | [V] |
| UI_UX_AUDIT: "161 pages de `src/app/(app)/`" | 283 `page.tsx` under `(app)` (294 in `src/app`) | [V] |
| UI_UX_AUDIT E: `aria-live` **0** | 25 occurrences in 17 files | [V] |
| UI_UX_AUDIT E: `focus-visible` 15 usages / 4 files; `.focus-ring` 2 files | 68 / 21 files; `.focus-ring` 17 files | [V] |
| UI_UX_AUDIT C: 33 dead `dark:` classes in 7 files | **212 in 41 files** (worst: `assistant-beta/*`, `assistant-welcome-dialog.tsx`, `drive/file-glyph.tsx`); dark `theme-color` still present | [V] |
| UI_UX_AUDIT A: raw Tailwind palette 342 in 52 files; hex 124 | ~845 occurrences / 101 files (my regex counts more prefixes, so not strictly comparable — still clearly higher; top: `missions/mission-runtime-panel.tsx` 31, `mission-runtime-controls.tsx` 28); hex in TSX 102 | [V counts / U comparability] |
| UI_UX_AUDIT A: Badge `purple` tone is the only off-token tone | Still true (`badge.tsx:11`) | [V] |
| UI_UX_AUDIT D: `text-[0.6875rem]` 265, `text-[0.625rem]` 63, `text-[0.5625rem]` 13 | 403 / 23 / 11 | [V] |
| UI_UX_AUDIT E: 595 raw `<button>` vs 203 importers of `ui/button` | 952 vs 353 | [V] |
| UI_UX_AUDIT F: `.badge-soft` 0, `.table-clean` 2, `mobile-cards` 1 | 0 / 2 / 10 files using `mobileCards` | [V] |
| UI_UX_AUDIT §2: `PageHeader` 122, `EmptyState` 73, `KpiCard` 49 files | 175 / 93 / 49 | [V] |
| UI_UX_AUDIT: "aucun système de toast" | Still true (two local ad-hoc toasts) | [V] |
| Brief/onboarding expectation of "Africa/Algiers formatting helpers" as the norm | General helpers in `utils.ts` are TZ-naïve; Algiers helpers exist but are duplicated per domain | [V] |

## 10. Verified vs uncertain

**Verified [V]** (read in code, cited above): token system and absence of dark tokens; primitive inventory and variants; absence of Dialog/Tabs/Toast/Radix/cva; all pages are RSC; counts of client/server files and hook usage; `CreateRecordButton` guarded `useActionState` flow; `useAction`/`useRafraichir` semantics and ceiling test; `BoutonDecisif` mechanics and pinned call sites; polling intervals and endpoints; Web Audio chimes; PWA manifest + push-only service worker; single print route; OnlyOffice embed via `DocsAPI`; `labels.ts` structure and `moduleForPath`; layout composition; z-index scale; responsive and UI guard tests; `formatDate` lacks `timeZone`; bell not updated by polling; audit figures re-measured.

**Uncertain [U]**:
- Render's runtime TZ is UTC (no `TZ` key in `render.yaml`, but not executed) and therefore the magnitude of date drift in SSR output.
- Exact client bundle cost of `Icon` importing the full lucide table.
- Whether the topbar bell refreshes on every soft navigation (depends on Next 14 layout caching; code suggests no).
- Server load of N tabs × (20 s + 15 s + 12 s) polling.
- Full accessibility conformance (focus trapping in `Sheet` and ad-hoc overlays, contrast ratios from the audit — not recomputed).
- Whether raw-palette growth is real regression vs. regex difference from the audit's method.
- Mapping of code §118.x citations to the right doctrine paragraphs (spot-checked, partially inconsistent).

---

### UI house-style checklist (new screen)

1. `page.tsx` is a Server Component: guard (`requireModule`/`requireUser` + `userCan`), query, map to plain serializable props, `dynamic = "force-dynamic"`.
2. Top of page: `PageHeader` (French title + one-line description, actions slot) then `ModuleTabs` from a `labels.ts` `*_TABS` constant if the module has sub-routes.
3. Put interactivity in a co-located `"use client"` file; import only `"use server"` actions, `import type`, and pure/client-safe modules (run `npm test` — `client-bundle-guard`).
4. Every enum → `labels.ts` map → `StatusBadge`; no raw enum strings, no hex, no `amber-500`; use tokens (`text-success`, `bg-warning/10`, `text-muted-foreground`).
5. Money via `formatCurrency`/`formatMontant`; dates via `formatDate`/`formatDateTime`, Algiers-sensitive logic via `src/lib/calendar-tz.ts`.
6. Create flows via `CreateRecordButton` (`FieldDef[]`, `ActionResult`, `redirectBase`, `autoOpenParam`).
7. Button actions via `useAction`/`useKeyedAction`, forms via `useFormAction`; never `router.refresh()` by hand (the hooks refresh; else `useRafraichir`); keep gestures disabled while busy; show `err` with `<Retour ton="erreur">`.
8. Money/decide/sign gestures: `BoutonDecisif` (+ `confirmation`). Other confirmations: `useConfirmer()` / `run(…, { confirmer })`; a reason: `useSaisir()`. Never `window.confirm/alert/prompt` (ceiling 0).
9. Panels: `Sheet`; any custom overlay at z ≥ 50 with `role="dialog"`, `aria-modal`, Escape, `useScrollLock`.
10. Tables: `ui/table` (`mobileCards` for wide data) or `DataTable`; always an `overflow-x-auto` container; `EmptyState` when empty.
11. Responsive: test at 375 px; `sm:col-span-*`, `min-w-0`, no fixed widths that overflow.
12. Accessibility: `aria-label` on icon-only buttons, `aria-current` for active nav, `focus-visible` styles (use `Button`, not raw `<button>`).
13. Copy: French, factual, explains what happens now and what to do next; never "réessayez" after an uncertain failure.
14. No `loading.tsx`; no new polling without visibility handling.
15. Before commit: `npm run typecheck && npm run build && npm test && npx next lint` (and `rm -rf .next && npm run build` after changing client imports).

**Exemplary screens to copy:**
- **List + create**: `src/app/(app)/sponsoring/page.tsx` + `sponsoring-table.tsx` (RSC guard/query/map, `PageHeader`, `CreateRecordButton`, `ModuleTabs`, `DataTable` + `StatusBadge` + formatters).
- **Detail + actions**: `src/app/(app)/support/[id]/page.tsx` + `panel.tsx` (`notFound` on no access, `Card`s, `StatusBadge`, `BackLink`, `DocumentList`, `useAction` with inline `Err`).
- **Decision panel**: `src/components/workflow/workflow-panel.tsx` (`useRafraichir`, `BoutonDecisif` for approve/reject/return/skip, mandatory note, mobile-sized touch targets `h-11 sm:h-8`).

**Adventum IA (decision 0027, 2026-10-30)** — the Assistant IA as its own ChatGPT-style app at `/ia`
(`src/modules/assistant-ia/ecrans/app/adventum-ia-app.tsx`): conversation list left (shared with `/assistant`:
`ecrans/conversations/liste-conversations.tsx`), thread centre (`ChatMessageList apparence="app"`), drawer right (Notes /
Travaux / Documents), full-screen list and drawer below `lg`, safe-area insets, 16 px input on phones. Its **only theme file**
is `ecrans/app/theme.css`: `--aia-*` tokens under `.adventum-ia`, Adventum charter (`docs/charte/adventum-pharma.md`: `#2C59A7` primary, teal/cyan accents, Helvetica Neue), light/dark/system (`data-theme`
+ the `dark` class so shared components follow), no green. Logo/icons in `public/adventum-ia/`. State logic shared with the
ERP screen through hooks (`ecrans/use-fil.ts`, `ecrans/use-pieces.ts`) — one implementation.
