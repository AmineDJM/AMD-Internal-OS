# 09 — AI subsystem: Adam assistant, Chief of Staff, Mission Runtime, model gateway, `src/platform`

> Knowledge-base chapter. Analysis done read-only against HEAD `11a281d` / `41b2ef0` (2026-10-24).
> Tags: **[V]** = verified by reading code (file:line cited); **[U]** = inferred / not executed.
> Tests were NOT run (the vitest `globalSetup` touches Postgres); test outcomes below are derived
> statically from the test source plus a read-only run of the boundary scanner (`scripts/adam-boundary.ts`).

> **Update 2026-10-29 — lot J0, Adam / Assistant IA / AI socle separation** (decision record
> `docs/assistant/decisions/0013-jarvis-architecture.md`, map `docs/architecture/MODULES.md` §7) [V]:
> - **Three perimeters.** *Adam* = `src/lib/assistant.ts`, `src/lib/assistant/**`, `src/lib/assistant-*.ts`, the bridge
>   `src/platform/in-process/**`, `src/lib/actions/assistant-actions.ts`, UI `src/components/chief/**` (incl. the chat
>   `assistant-chat*` and the voice call `voice-mode.tsx` / `realtime-voice*`, **moved out of** `src/app/(app)/assistant/`),
>   `src/app/(app)/chief-of-staff/**`, `src/app/api/assistant/**`. *Assistant IA* = `src/lib/agent/**`,
>   `src/app/(app)/assistant/**` (now only `page.tsx` + `beta/`), `src/components/assistant-beta/**`,
>   `src/app/api/assistant-ia/**`, `src/lib/actions/assistant-ia-*.ts`. *AI socle* = **`src/platform/ia/**`** (README there).
> - **Socle content** (moved with `git mv` + `tsconfig.json` forwarding addresses, or extracted): `PowerTool` (`outil.ts`);
>   model-argument reading and person resolution (`outils/arguments.ts`); directory/Regulatory reads, workflow admin (`lectures/`); `action-intents` + stale-proposal logic (`intentions/`);
>   `resolveDriveFile`/`driveNodeToFile` (`drive.ts`); web research; ffmpeg + attachments + media door (`media/`); the
>   document factory and Live Office artifact ports/store (`artifact/`, ex-`in-process/artifact/`); `teach/store.ts`;
>   `proprietaire.ts`; the model-usage sink (`telemetry/usage-sink.ts`, now also installed by the socle modules that call
>   a model); workspace protocol + block components (`workspace/`, `ecrans/`).
> - **Guards.** `src/platform/ia/frontieres.test.ts` (in `test:architecture`): IA ↛ Adam, Adam ↛ IA, socle ↛ either (0,
>   no exception), residuals = exact list. ESLint `@typescript-eslint/no-restricted-imports` overrides (a distinct rule so
>   the base `no-restricted-imports` patterns are not clobbered). Before (base b42a952c, with V4-G
>   business rights): 38 IA→Adam imports in 24 files. After: 4, named — `lib/agent/outils-v1.ts` borrows Adam's tool
>   catalogue (`assistantToolsFor`, `executeReadTool`, `buildProposal`, `executePowerTool`, `DOMAIN_TOOLS`; decision 0012),
>   and `assistant/beta/actions.ts → lib/actions/assistant-actions` (`confirmerIntentionAssistantIA` lives in Adam's actions
>   file and executes business cards via Adam's `performAction`; moving it changes the action contract). Plus the reverse 3
>   imports of that file into `lib/agent/{operations*,role-config}`, plus tests `lib/agent/{limites,droits-metier}.test.ts`. All → phase B.
> - **Ratchets.** `boundary.test.ts`: Adam→ERP `DEBT_CEILING` 419 → **393**; new `SOCLE_IA_CEILING = 180` (socle ERP
>   imports counted apart; `src/app/(app)/assistant/` left `ADAM_PATHS`). `domains.ts`: new layer "socle IA";
>   crossings 58 / providers 39 (base 37a29edc measures 62 / 39: this lot removes 4). Action contract (`npm run actions:contrat`) byte-identical.
> - **Phase B (2026-10-30).** `src/lib/agent/` → module **`src/modules/assistant-ia/`** (`domaine/` 14 pure rules, `infra/` engine,
>   `ecrans/` = ex-`components/assistant-beta/`, `actions.ts` / `actions-consommation.ts` keep keys `assistant-ia-actions` /
>   `assistant-ia-consommation-actions`; doors `api.ts` / `partage.ts`; map `assistant-ia → ad-pro, coffre`, `bibliotheque →
>   assistant-ia`). `confirmerIntentionAssistantIA` moved there — the ONLY action-contract key change
>   (`assistant-actions:` → `assistant-ia-actions:`); `executerIntention` + `confirm.ts` moved to `platform/ia/intentions/`.
>   Adam → IA = 0. Remaining IA → Adam was Adam's tool catalogue (`infra/outils-v1.ts`, `actions.ts` → `performAction`) — its
>   closure is 92 % of Adam; kept, named and ratcheted until J6, which removed it (see J6 below).
> - **J5 + J14 (2026-10-30) — continuous quality of the Assistant IA** (decision `docs/assistant/decisions/0022-qualite-continue.md`) [V]:
>   scheduled bench on the WORKER (`qualite.banc` → child process `scripts/bench/banc-programme.ts`, trial DB only:
>   `BANC_ESSAI_DATABASE_URL` + fingerprint ≠ prod + `BancBaseEssai` marker; refused and said otherwise), Super-Admin calendar
>   (default weekly, 1 $ cap per run), history `AssistantIaBancPassage`/`Scenario`, regression (success down, P50/P95 or cost
>   +30 %) → Super Admin notified; dashboard `/admin/ai/qualite`. Replayable traces of every fil turn (`AssistantIaTrace`, gzip,
>   30 d; `modeleTrace` wraps the Mastra model; `npm run assistant:rejouer`). Third-party provenance on every card
>   (`domaine/provenance-tierce.ts`: RIB/e-mail/phone/link/amount/name from a framed third-party content and not said by the
>   person → "ce RIB provient du document X, à vérifier"; injection detection FR/AR/EN, hidden text) — 240-item trap corpus,
>   0 unflagged misleading card. Model per role changed on screen (`AssistantIaModeleRole`) ONLY with a green A/B bench for that
>   exact candidate (< 14 d); revert to env always allowed. New env: `ASSISTANT_IA_MODEL_RAISONNEMENT`, `ASSISTANT_IA_TRACES(_JOURS)`.
> - **J4 (2026-10-30) — speed & memory of the Assistant IA** (decision `docs/assistant/decisions/0018-vitesse-memoire.md`) [V]:
>   tools on demand — a 10-tool socle + a 6-tool lexical preselection (`domaine/selection-outils.ts`, French full-text, 0 ms;
>   reference corpus 60 requests: top-1 56/60, top-3 60/60) + meta-tool `trouver_outil` (`infra/selection.ts`); ALL tools stay
>   registered with Mastra, only the step's ACTIVE ones are sent (`prepareStep` → `activeTools`, `infra/repondre.ts`). Fiches =
>   tools the adapter would offer (`allowed`, `config.allowedTools`) → never out of rights; console families still judged at
>   run time. Stable prompt prefix (`infra/contexte.ts`: rules → presentation → general instructions → person → variable tail →
>   time LAST; per-tool-family rules via `reglesPour`/`reglesAjoutees`; `promptCacheKey` per user). **Measured: any change to
>   the tool list voids the whole cached prefix** (tools precede instructions) — cache rate fell 89 % → ~47 %, accepted for a
>   4× smaller input. Memory in 4 layers: (a) J2 work notebook; (b) 4 verbatim exchanges + ROLLING SUMMARY
>   (`AssistantIaFil.resume/resumeJusquA/resumeLe`, migration `20270209100000_assistant_ia_resume_roulant`, `infra/fil/resume.ts`,
>   fast model, after the reply, idempotent, filtered twice); (c) `AssistantMemoryItem` ranked by relevance; (d) knowledge tools
>   `chercher_documents`/`ouvrir_documents`/`faits_confirmes` in the AI socle (`platform/ia/lectures/connaissance.ts`, facts rule in `bibliotheque/infra/faits.ts`; `SOCLE_IA_CEILING` 180 → 179,
>   `pourModele: true`, framed as untrusted content; placed in the socle because `bibliotheque → assistant-ia` already exists
>   in `carte.ts`). Context assembler `domaine/assembleur.ts` (fixed envelopes 500/700/3 500 tokens). Model per gesture:
>   `platform/ia/modeles-roles.ts` (fast `gpt-6-luna`, standard `gpt-6.1-terra` effort low, reasoning effort medium;
>   env `ASSISTANT_IA_MODEL_RAPIDE`, `ASSISTANT_IA_EFFORT*`). Bench (same 26 scenarios, same criteria): input/call 22 925 →
>   ~6 100 tokens, first word P50 5.3 → 3.4–3.7 s, P95 15.4 → 7.1–8.2 s (long task excluded; 3 passes), cost/turn 0.0238 → 0.018 $, 21 → 22/26.
> - **J6 (2026-10-30) — capability registry & generic call** (decision `docs/assistant/decisions/0020-capacites.md`) [V]:
>   `src/platform/ia/capacites/` is a PURE registry derived from `lib/actions/contrat.genere.json` (1 206 actions) + the
>   Assistant IA's own tools + the 16 Atelier commands; ports injected by the module (`interdictionGenerique`, `classerGeste`,
>   `MODULE_LABELS`) so `SOCLE_IA_CEILING` stays 177. Each fiche: JSON + zod input schema, console family, French label (word
>   lexicon, no per-action table), risk R0→R4 (R0 70 / R1 628 / R2 159 / R3 61 / R4 288), simulable (oui 809 / inconnu 247 /
>   non 150, for J7), annulation (retour/compensation/délégation/aucune via `reversibilite.ts`), third-party content, screen gate
>   (RBAC modules from `userCan` → audit module → file prefix; unknown → Super Admin only). Never callable: `illisible`,
>   generic refusal, `SURFACES_HORS_ASSISTANT` (the IA's own actions, Adam, auth, impersonation, supplier portal, admin
>   plumbing), binary-object actions. Reviewed snapshot `classement.genere.json` (`npm run capacites:classement`) fails
>   `registre.test.ts` on any unclassified new action. Module side `infra/capacites.ts`: one PowerTool per offered capability
>   (`fichier__fonction`), R0 executed in-turn via `executerAction` under the person's own session (no session → refusal),
>   R1+ → intent `assistant_ia_capacite` (one card per turn), R3/R4 CRITICAL + server-checked retype; confirmation
>   (`confirmerIntentionAssistantIA` → `executerCapacite`) re-reads kill switch, gate, family, then calls the action itself.
>   Not in J2 plans (capability gestures always go through a card). Selection: capabilities are J4 fiches (weights: label 2,
>   context 1; first word ×1.4, same verb ×1.2; infinitive/imperative merged) — recall@5 96 % on a 300-request French corpus,
>   worst fixed tool tokens 3 837, never out of rights, bench 26/26 at fake-model selection level. Adam residues removed
>   (`RESIDUS` = []): writes → capabilities; `send_message` → own operation (`createDirect` + `sendMessage`); cross-cutting
>   reads → own tools (`infra/lectures-erp.ts`, `read_budget`, `read_hr_overview`, `finance_totals`). Known gap: task due-date /
>   priority change (no screen action). Per-turn cost (1 039 tools, warm): catalogue ~5–30 ms, selection ~15 ms, Mastra
>   adapter ~90–110 ms (definitions, zod schemas and fiche weights are memoised per process).
>   **No capability regression (0020 §8, 30/10):** generated inventory `npm run capacites:inventaire` maps the 123 gestures the IA
>   borrowed from Adam before J6 (114 domain ops + 9 writes) to an appelable capability whose gate opens for every role Adam's
>   gate passed (snapshot `modules/assistant-ia/infra/equivalents-avant-j6.json`, replayed by `equivalents-avant-j6.test.ts`). Gaps
>   closed: new screen actions `modifierTache` (due date/priority/assignee), `corrigerMaDemande`, `modifierChampPersonnalise`;
>   employee fiche via IA-only policy `interdictionDeLAssistantIa` (`GESTES_DE_FICHE`, never `userId`, R4 "account follows the
>   fiche", `updateEmployee` re-read and replayed at confirmation); `PORTES_DU_GESTE` (owner-OR-module-right gestures get the
>   workspace gate); optional file no longer blocks a call; `assistant-ia-*` files always out of reach.
> - Paths below that name `src/lib/assistant/action-intents.ts`, `in-process/artifact/`, `in-process/telemetry/usage-sink.ts`,
>   `src/app/(app)/assistant/assistant-chat.tsx` predate J0: read them as their `src/platform/ia/…` / `src/components/chief/…` homes.

---

## 1. Scope

Covered:

- **Model access layer**: `src/lib/models/*` (the *passerelle* = gateway), `src/lib/ai.ts` (legacy facade),
  `src/lib/ai-settings.ts` (kill switches + `AiUsageLog`), `src/lib/openai-luna.ts` (Regulatory CTD path),
  Whisper/STT (`src/lib/ai.ts`, `src/lib/media/stt.ts`), realtime voice (`src/lib/assistant/voice-realtime.ts`),
  Mistral OCR (`src/lib/regulatory/intelligence/ocr/`).
- **Adam** (the conversational agent, a.k.a. "Assistant IA" / "My Chief of Staff"): `src/lib/assistant.ts` (7.3k lines),
  `src/lib/assistant/**` (~62k non-test lines, 118 test files), `src/lib/actions/assistant-actions.ts`,
  `src/app/api/assistant/**`, `src/app/(app)/chief-of-staff/**`, `src/components/chief/**`.
- **Assistant IA** (`/assistant`, "Adventum Brain" engine — Mastra on MiMo; NOT Adam): `src/lib/agent/**`,
  `src/app/(app)/assistant/**`, `src/components/assistant-beta/**`, `src/lib/actions/assistant-ia-actions.ts`.
  Opened per person (RBAC module `ASSISTANT_IA`). Writes = `OPERATIONS_IA` registry (`src/lib/agent/operations/`):
  `proposer` → card (`persistActionIntents`, kind `assistant_ia_op`) → `confirmerIntentionAssistantIA` →
  `executerOperationIA` (re-checks `ouverte`) → the SCREEN's server action. Personal memory (`AssistantMemoryItem`),
  documents (`documents-lus.ts`, `mrz.ts`, `traduction.ts`, `formulaire-pdf.ts`, `bc-depuis-devis.ts`), user-scheduled
  read-only routines (`src/lib/agent/routines/`, tables `AssistantRoutine`/`AssistantRoutineRun`, swept from
  `runScheduledJobs`). Decision records: `docs/assistant/decisions/0001`–`0012`.
  **User's rights + sensitive values as tokens (decision 0012, 2026-10-28)**: `outilsV1` now exposes the engine reads and
  writes the PERSON is entitled to — `lectures.ts` — `lecturesRh` (`lire_fiche_rh` RH VIEW or self; `lire_paie` `voitLesSalaires` +
  `entitePermisePourFiche` or self; `documents_rh` = the `/api/rh/document/[id]` rule, returns the download link, reads a
  contract LOCALLY), power reads by their own `allowed` (`read_hr_overview` with payroll mass stripped/tokenised,
  `search_everything`, `read_calendar`, `search_drive`), engine writes via `buildProposal` (`create_hr_request`,
  `create_admin_request`, regulatory field/step tools…) and domain tools `regulatory_operation` (incl. `create_product`),
  `hr_operation`, `task_operation`, `drive_operation`, `request_operation` offered iff one op `meta.gate` passes. NOT the
  engine's `read_employee`/`read_payroll` (guard wider than the screen). Every tool output goes through
  `jetonnerSortie` (`filtre-confidentialite.ts` — repères, pure) with the turn's `CoffretDuTour`: sensitive keys/patterns → opaque `⟦Sn⟧`; the model
  writes with the token; `Revelateur` (`fil/tour.ts` — `Revelateur`) replaces tokens BEFORE display/storage iff the coffre policy
  `peutLire` allows (coffre columns also through `controlerLecture` = policy + `AccesDonneeSensible` journal, no
  decryption — exported from `@/modules/coffre/api`, NOT `api-lecture`, the frontier holds); else `[confidentiel]`.
  Revealed values are wrapped in U+2063: `filtrerSaisie` always strips them from assistant history; TTS and notifications
  too. Routines (no coffret) keep the old `[CONFIDENTIEL]` censorship. **Access families** (Direction 29/10):
  `acces-regles.ts` (pure, socle) — SUPER_ADMIN = everything; others default to app rights (`droitsApplicatifsIa`,
  `role-config.ts`) with SALAIRES/CONTRATS_RH CLOSED; `AssistantIaAcces` rows (per role, per user — user wins) open/close
  families; explicit opening may exceed app rights (own HR tools, token reveal — audited — and the RH document route).
  Re-read every turn (`accesAssistantIa`); closed family → tool refuses naming it (`refusFamille`). Console
  `/admin/ai/acces` (`enregistrerAccesAssistantIa`, Super Admin, audit, EXCLUDED in the action registry).
  Follow-up (Direction 29/10): `vueDeLAssistant` adds VIEW on the modules of explicitly-opened families, so engine READS
  accept "app right OR console opening" (writes still run under the real session); `Revelateur`/`peutVoirLaValeur` live
  in `role-config.ts`; tokens inside a card input are substituted server-side (`substituerReperes`, refused without the
  right), stored as `reperesSubstitues` on the intent, re-checked at confirmation (`verifierReperesAvantExecution` in
  `confirmerIntentionAssistantIA`), audited at card and execution; non-vault values are journaled through
  `journaliserLectureHorsColonne` (coffre door) with tool name and source (`PayrollEntry`, `EmployeeDocument`).
  Bench V4-H gaps closed: directory returns manager/department (`findPeople`), `list_pending_decisions` exposed,
  `demandes_adpro` / `etat_dossier_reglementaire` (`lecturesMetier`, `lectures.ts`, under the elevated view, perimeter-
  scoped — `product_360` not lent), leave requests on the HR card, cached input billed at `cacheParM`
  (`ASSISTANT_IA_PRICE_CACHED`, defaults `TARIFS_PAR_DEFAUT` 2/12/0.2 $ per M), `consigneGestesFermes` (refusals name the right). Bench: `src/lib/agent/droits-metier.test.ts`.
  **Voice notes & reading attachments (decision 0011, 2026-10-28)**: `src/lib/agent/lecture/` — `pieces.ts` READS each
  attachment before the turn (text/Office/PPTX/CSV natively, scanned PDF and images by VISION through the `genererTexte`
  door with role `vision`, audio/video by STT + ffmpeg key frames), after vault gates (local nature, CONFIDENTIAL, file
  name, local OCR + `classerPiece`/`natureSensible` BEFORE any image leaves) → `censurerTexte` → bounds (24k chars/piece,
  60k/message, 12 images) → `encadrerNonFiable`; each `LecturePiece` (LUE/PARTIELLE/REFUSEE/ECHEC/NOMMEE + limit phrase)
  is stored on the user turn (`AssistantIaTour.lecture`) and shown under the piece. `voix.ts`: voice note = Drive file in
  the owner's "Assistant IA — vocaux" folder, `AssistantIaTour.vocal` transcribed when the thread plays it; optional spoken
  reply (`AssistantIaFil.reponseVocale`, OpenAI TTS → `AssistantIaTour.audio`). STT/TTS metered by `appelVoix`
  (`consommation.ts`, provider `openai-audio`, token equivalents). Route `POST /api/assistant-ia/vocal`.
  **Operations (lot V3-D, 2026-10-28)**: the only two model doors (`repondre.ts`, `generer.ts`) read the master switch,
  then open a **budget** (`consommation.ts`): per-step usage from Mastra `onStepFinish` → one `ModelCallLog` row per
  call (feature `assistant_ia`, `role` = origin conversation/fil/routine/redaction, `threadId` = fil id) + one
  `AiUsageLog` row per turn. Caps from `AssistantIaReglage` (Super Admin, `/admin/ai/consommation`): steps/turn,
  tokens/turn, tokens/person/day (Algiers day) → `PlafondIaAtteint`, abort before the next call, one Super Admin
  notice per person/day (`AssistantIaPlafondAtteint` unique key). Identity/budget travel via `AsyncLocalStorage`
  (`auNomDe`, `sousBudget`), so a summary launched by a tool counts in its turn. Third-party tool outputs are framed
  (`contenu-non-fiable.ts`). Ratchets: `consommation.test.ts` (every `new Agent(` file opens+closes a budget; no prod
  caller of `remplacerReglagesPourTests`), `contenu-non-fiable.test.ts` (tool names evoking documents/messages/web are classified).
- **Mission Runtime** (durable multi-step autonomous missions): `src/lib/missions/**` (~25k lines),
  `src/platform/in-process/missions/**`, `src/lib/interrupteurs/missions.ts`.
- **`src/platform`**: contract, event bus, domain map, boundary ratchet, the in-process bridge (~22k non-test lines).
- Supporting AI libs: `fabric`, `knowledge`, `evals`, `sandbox`, `skills`, `teach`, `verite`, `verification`,
  `cout`, `apprentissage`, `replay`, `process`, `sortie` (egress guard), `ia`.
- Doctrine: `docs/claude-md/03-mission-runtime-*` and `08-versionnement-graphify-*` (§118.x rules).

Not covered in depth: Adventum Brain *cockpit* risk detectors (`src/lib/adventum/*`), Regulatory intelligence
pipeline internals, Live Office (§104).

## 2. Summary

- One **gateway** (`src/lib/models/gateway.ts`) is the intended single door to LLM providers; it resolves a **role**
  (`realtime | orchestrator | worker | bulk`) to a provider+model, validates the request shape, throttles, and records
  usage/cost. **Default provider is OpenAI** (`gpt-5.6-terra` / `gpt-5.6-luna`, `gpt-realtime-2.1`), with
  `ADAM_MODEL_PROVIDER=anthropic` as rollback (`claude-sonnet-4-6` / `claude-haiku-4-5`). All transport is raw `fetch`, no SDK.
- **Adam** = an agent loop (≤16 model rounds) in `assistant.ts` over a per-user tool catalogue filtered by RBAC; **reads**
  execute immediately (re-checked at execution), **writes are never executed by the model**: they become an
  `AssistantActionIntent` + confirmation card, executed later by `performAction` after the user clicks (RBAC re-checked, audit).
- Adam is **Super Admin only** (`peutVoirAdam` → `role === "SUPER_ADMIN"`, §118.153) and "in development pause".
- **Mission Runtime**: model proposes a plan, a compiler validates it, a DB-driven engine (`avancer`) executes steps with
  idempotency keys/receipts, driven by a 60-s in-process heartbeat; missions pause when the owner loses Super Admin, and a global
  switch (`AppSetting.missionsPaused`) freezes everything.
- **`src/platform`** is a code-level (not deployment) boundary between Adam and the ERP, with a ratchet test capping
  Adam→ERP imports (ceiling 425).
- **HEAD is red on at least three architecture tests** (static derivation): the 2026-10-24 "Adventum Brain" beta replaced `/assistant`,
  dropped the `peutVoirAdam` gate, calls Xiaomi MiMo directly via `fetch`, and pushed boundary crossings to 433 > 425.
- AI can be **disabled at runtime** cleanly (keys, `AiSetting.masterEnabled`, mission switch, env vars), but cannot be
  **removed at code level** without touching ~41 ERP files (audit→ledger→mission wake-ups, scheduler, admin pages).

## 3. Key files

| Path | Role |
|---|---|
| `src/lib/models/registry.ts` | Role→model table, provider switch, prices (`DEFAULT_MODELS` :44, `ANTHROPIC_FALLBACK` :109, `bindingFor` :154) |
| `src/lib/models/gateway.ts` | The *passerelle*: `callModel` :192, `streamModel` :233, `askModel` :277; protocol choice, validation, throttle, telemetry |
| `src/lib/models/{openai-responses,openai,anthropic}.ts` | Raw-`fetch` adapters (Responses API default; Chat Completions; Anthropic Messages) |
| `src/lib/models/{throttle,budget,capabilities,protocol,telemetry}.ts` | Per-process concurrency gate, output budget incl. reasoning headroom, request-shape validator, turn trace |
| `src/lib/models/compat.ts` | Legacy Claude-shaped API (`callClaude`, `callClaudeStream`) mapped onto the gateway |
| `src/lib/models/passerelle-unique.test.ts` | Ratchet: no file outside an allow-list may name a provider endpoint |
| `src/lib/ai.ts` | Legacy facade (`askClaude`=worker, `askClaudeCheap`=bulk); reads master kill switch first; Whisper transcription |
| `src/lib/ai-settings.ts` | `AiSetting` row (master + per-feature toggles), `aiFeatureEnabled`, `interrupteurIaCoupe`, `logAiUsage` |
| `src/lib/openai-luna.ts` | Regulatory CTD path: Luna vision, Batch API, embeddings; own accounting (`RegulatoryAiCall`) |
| `src/platform/ia/telemetry/usage-sink.ts` | Buffered sink → `ModelCallLog` (installed by side-effect import: `assistant.ts`, mission reasoner, socle modules that call a model) |
| `src/lib/assistant.ts` | Adam: tool lists, prompts, `executeReadTool` :2354, `buildProposal` :2805, loops :4850/:5468, `performAction` :6107 |
| `src/lib/assistant/power-tools.ts` | RBAC-gated "power" read tools; `powerToolsFor` :461, `executePowerTool` :477 |
| `src/lib/assistant/ops/index.ts` + `ops/impl-*.ts` | Generic `domain_op` tools (catalogue × implementations, ~40 files) |
| `src/platform/ia/intentions/action-intents.ts` (ex-`lib/assistant/`, lot J0) | Intent state machine: `persistActionIntents`, `executeIntentGuarded` — shared by Adam and the Assistant IA |
| `src/platform/ia/**` | The AI socle shared by Adam and the Assistant IA (lot J0, see the update note at the top) |
| `src/lib/actions/assistant-actions.ts` | Server actions: `assistantChat` :162, `assistantNudge` :239, `executeAssistantAction` :273 |
| `src/app/api/assistant/stream/route.ts` | SSE entry point for the Adam text loop |
| `src/app/api/assistant/{transcribe,voice/*}` | Whisper dictation; realtime voice session / tool / turn / log routes |
| `src/lib/actions/executer.ts` + `aiguillage.genere.ts` | Generic "call any server action" executor (1,145 actions, generated dispatch) |
| `src/lib/rbac.ts:806-834` | `peutPiloterMissionsAdam`, `peutVoirAdam`, `REFUS_ADAM` |
| `src/platform/contract.ts` | Zero-import port: `Principal`, `PlatformQuery`, `PlatformCommand`, `DomainEvent`, `PlatformPort` |
| `src/platform/event-bus.ts`, `events.ts` | In-memory pub/sub (500-event replay buffer); closed list of 17 event types; `emit` never throws |
| `src/platform/boundary-scan.ts`, `boundary.test.ts` | Adam↔ERP import scanner and ratchet (ceiling 425) |
| `src/platform/domains.ts` (+ `domains.test.ts`) | Layer map L0 socle / L1 domains / L2 façades / L3 Adam; cross-domain ratchets |
| `src/platform/in-process/adapter.ts` | The single "bridge" implementing `PlatformPort` (`runCommand` :410 → `performAction`) |
| `src/platform/in-process/*/` (~30 dirs) | Bridge sub-modules: missions, fabric, teach, sandbox, skills, telemetry, evals, events… |
| `src/lib/missions/runtime/engine.ts` | Mission engine `avancer` :243, `conclure` :1769, `BAIL_MS` :77 |
| `src/lib/missions/{compiler,planner,registry,policy,approval,goal,recovery,events,…}` | Plan compile/validation, approvals, goal judge, recovery ladder, event matching |
| `src/platform/in-process/missions/{runtime,sweep,runner,reasoner,control}.ts` | Launch (`lancerMission` :285), heartbeat (`balayerMissions` :246), capability runner, model port impl |
| `src/lib/interrupteurs/missions.ts` | Global mission switch (`AppSetting.missionsPaused`) |
| `src/lib/scheduled.ts` | In-process heartbeat `runScheduledJobs` (60 s); calls `balayerMissions` :240 |
| `src/lib/events/ledger.ts` | `recordEvent` (BusinessEvent) → task reconciliation, mission wake-up, reminders, watches |
| `src/lib/audit.ts:43,63` | `recordAudit` → `emettreFait` → `recordEvent` (every audited ERP write may wake AI) |
| `src/lib/sortie/garde.ts` | Egress guard for tests/benches (mail, push, calendar, external writes) |
| `src/lib/prisma.ts:66-120` | DB guard: tests need local DB, benches need local DB named `*bench*` |
| `src/lib/evals/{cibles,registre}.ts`, `scripts/bench/*` | Eval targets (§33 mandates) and live/offline benches |
| `src/lib/agent/*`, `src/app/(app)/assistant/beta/actions.ts` | Assistant IA (Mastra on MiMo): context, V1 tools, `operations/` registry, memory, documents, `routines/`; fake model for tests (`testing/modele-factice.ts`) |

## 4. How it works

### 4.1 Providers, models, keys, transport

- **Roles, not model names** [V] `registry.ts:44-49`: `realtime: gpt-realtime-2.1`, `orchestrator: gpt-5.6-terra (reasoning medium)`,
  `worker: gpt-5.6-terra (none)`, `bulk: gpt-5.6-luna (none)`. Per-role overrides: `ADAM_MODEL_<ROLE>`,
  `ADAM_REASONING_<ROLE>`, `ADAM_PRICE_<ROLE>_{IN,OUT,CACHED_IN}`; web search priced `ADAM_PRICE_WEB_SEARCH_CALL` (default $0.01).
- **Provider switch** [V] `registry.ts:136`: `ADAM_MODEL_PROVIDER=anthropic` → Anthropic for text roles; `realtime` is always OpenAI.
  Keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (read per call, `registry.ts:183`), base URLs `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`.
  Other env: `ADAM_OPENAI_PROTOCOL` (`protocol.ts:89`), `ADAM_SAFETY_SALT`, `ADAM_MODEL_DEBUG=1` (redacted request-shape logs),
  `ADAM_MODEL_CONCURRENCY` (default 8, `throttle.ts:50`), `STT_MODEL` (default `whisper-1`), `CTD_MODEL_CHEAP`, `MISTRAL_API_KEY`.
- **Transport** [V]: no vendor SDK in `package.json`; adapters use `fetch` (`anthropic.ts:161,269` `/v1/messages`;
  `openai-responses.ts:636,905` `/v1/responses` with 120 s / 180 s timeouts and 429 back-pressure via `noter429`).
- **Gateway duties** [V] `gateway.ts:192-275`: (1) resolve binding; (2) choose protocol (Responses vs Chat Completions) and
  **refuse** invalid shapes before network (`preparerOpenAi`: `protocolViolation`, `validateModelRequest`; no `temperature` is ever sent);
  (3) compute output budget incl. reasoning headroom (`budget.ts`); (4) take a throttle slot (`prendrePlace`), released in `finally`;
  (5) `recordModelCall(reply.usage)` → telemetry sink → `ModelCallLog`. Errors are returned as `{ok:false}` — never thrown.
- **Streaming** [V]: `streamModel` / `callClaudeStream` with an `onText` callback; the SSE route re-emits as
  `data: {...}\n\n` events `delta | reset | trace | source | workspace | done` (`src/app/api/assistant/stream/route.ts`).
- **Cost tracking** [V]: per call in gateway telemetry (tokens, cached, reasoning, web searches, `costUsd` or `null` when the price is
  unknown — "never invent a price", `registry.ts` header); per turn summarised by `withTurn`/`summarize` and persisted by the route via
  `logAiUsage` → `AiUsageLog` (`stream/route.ts`, `ai-settings.ts:278`). Luna/Regulatory keeps its own ledger (`RegulatoryAiCall`).
  Missions have a per-mission model-call cap (`Mission.modelCallsCap`, `sweep.ts` BUDGET_HOLD). `src/lib/cout/*` holds pure
  "cheapest architecture that keeps the quality floor" logic.
- **Other providers** [V]: OpenAI Whisper (`ai.ts:325`, `media/stt.ts`), OpenAI Realtime via WebRTC with ephemeral client secret
  (`voice-realtime.ts:356` `/v1/realtime/client_secrets`), Mistral OCR (`regulatory/intelligence/ocr/mistral-ocr.ts`),
  **Xiaomi MiMo** (`mimo-v2.6-flash`, env `mimo`/`MIMO`) directly in `src/app/(app)/assistant/beta/actions.ts:274-300` (NEW, off-gateway).
  No Gemini usage found.
- **Single-door ratchet** [V] `passerelle-unique.test.ts:51`: allow-list `src/lib/models/`, `openai-luna.ts`, `media/stt.ts`,
  `assistant/voice-realtime.ts`; regex on `api.anthropic.com | /v1/messages | /v1/chat/completions | /v1/responses`.

### 4.2 Kill switches (*interrupteurs*) and gating

| Switch | Storage | Read where | Effect |
|---|---|---|---|
| Master AI (`masterEnabled`) | `AiSetting` row `global` (`schema.prisma:9074`) | `lib/ai.ts` every door (`interrupteurIaCoupe`, `ai.ts:293-308`), OCR, Luna, `aiFeatureEnabled` | Refuses with `REFUS_IA_COUPEE`, `configured:true` |
| Per-feature (`assistantEnabled`, `proactiveNudgesEnabled`, `brainEnabled`, `processIntelEnabled`, `fieldReportAiEnabled`, `voiceTranscriptEnabled`, `siteWebAiEnabled`, `lecturePiecesEnabled` (default **off**), `conseilPiecesEnabled`) | same row | `aiFeatureEnabled(feature)` = master && toggle (`ai-settings.ts:159`) | Route-level refusal |
| Emergency stop for external actions (`aiExternalActionsDisabled`) | `AppSetting` (`schema.prisma:9324`) | `performAction` head (`assistant.ts:6107-6118`) for `ACTION_POLICY[kind].external` | Confirmed external actions refused |
| Missions global switch (`missionsPaused`, `…At`, `…ById`) | `AppSetting` (`schema.prisma:9332`) | `lireInterrupteurMissions` in engine `avancer`, sweep (`sweep.ts:263`), launch (`runtime.ts:310`), horizon pilot | Freezes all missions; lift only by a click (§118.132, §118.15) |
| `MISSIONS_SWEEP=off`, `SCHEDULER_DISABLED=1`, `SCHEDULER_TICK_MS` | env | `sweep.ts:248`, `scheduled.ts:80` | Stops heartbeat (whole ERP scheduler for the latter) |
| Missing key | env | `roleConfigured` | `configured:false` → UI "IA non configurée" with the right key name (`ia/cle-manquante.ts`, §118.128) |

Semantics [V]: AI settings **fail open** — DB error → defaults (AI on) (`ai-settings.ts:137-156`); the mission switch **fails closed**
(read error propagates; sweep does not proceed) (`sweep.ts:255-262`). Documented gap [V] `ai-settings.ts` header: callers that use
the gateway directly (Adam loop, web research, mission reasoner) are *not* covered by the master switch at the transport level; Adam's
text route compensates by checking `aiFeatureEnabled("assistant")` (master && assistant) at entry; the mission reasoner is governed only
by the mission switch.

**Adam visibility (§118.153)** [V]: `peutVoirAdam(u) = peutPiloterMissionsAdam(u) = role === "SUPER_ADMIN"` (principal role only, a
secondary SUPER_ADMIN hat does not count) (`rbac.ts:806-831`). Enforced at: `/api/assistant/stream` (`route.ts` first lines),
`/api/assistant/transcribe:18`, voice (`canUseRealtimeVoice`, `voice-realtime.ts:72-77`), `executeAssistantAction`/`assistantNudge`,
the `/chief-of-staff` segment layout (`exigerAdamVisible`, `platform/in-process/visibilite-adam.ts`), nav entries `gate: "adam"`
(`labels.ts:1928,1941`, `nav-access.ts:110`). Also "Vue exacte" (impersonation) disables Adam entirely (memory is strictly personal).
**Broken at HEAD for `/assistant`** — see §8/§9.

### 4.3 The Adam agent loop

Two near-identical implementations: `runAssistantImpl` (`assistant.ts:4850`, non-streamed: `assistantChat`, nudges, voice "delegate")
and `runAssistantStreamImpl` (`:5468`, SSE). Both wrapped in `withTurn` (telemetry turn) by `runAssistant` / `runAssistantStream` (`:7268/:7288`).

Per turn (stream variant, [V] `:5468-6072`):
1. `aiConfigured()` (provider key) else `configured:false`.
2. Context reads in parallel: `retirerCaduquesAvantLeTour` (cancel stale proposals), `recentActionIntentsContext`, `resolveSpokenMailApproval`
   (an "ok, envoie" closes a pending mail intent server-side), `assistantIdentityContext` (name + real sending mailbox).
3. Short-circuits: provenance question ("d'où tu tiens ça ?") answered by code from the provenance store, no model.
4. Query plan (`queryPlan`), entity resolution by code (`resoudreMentions` from `lib/fabric`), consignes (calc, period, signals, next gesture).
5. System prompt = stable prefix (`systemPrompt(user)` + identity) for prompt caching; per-turn context appended to the user message.
   `promptCacheKey = "adam:<userId>"`, `safetyIdentifier` = salted hash of user id.
6. Tool catalogue: `assistantToolsFor(user)` (`:1868`) = `READ_TOOLS` + `powerToolsFor(user)` (each with `allowed(user)` RBAC predicate,
   plus dynamic skills) + `EXPORT_TOOL` + (Super Admin) admin read/write tools + `WRITE_TOOLS` filtered by `ECRITURES_SOUS_CONDITION`.
   Then `decideRollout` → `resolveTools` → `fitToolBudget` shrink the list per question (schemas are ~86 % of fixed context);
   a `DISCOVERY_TOOL` lets the model unlock more.
7. Fast paths: `resolved.level === "AUCUN"` (greeting) → one `bulk` call; `FAST_READ` → execute one read tool by code, then phrase with
   `bulk` (fallback `orchestrator`). Pre-reads (`planifierPreLectures`) run in parallel before the first model call.
8. Loop `for turn < MAX_TURNS (16)` (`:4754`, `:5794`): `callClaudeStream(messages, …, {maxTokens:1400, reasoning by level})`.
   - No tool call → answer passes **code guards** before being returned: `gardeEnseignement` (claims a rule was saved without the tool),
     `gardeAbsence` ("nothing found" after one search → widen), `gardePromesse` (promise without durable object), `gardeImpossibilite`
     ("I can't" without verification → rediscover), link repair, optional high-stakes self-review, next-gesture cards.
   - Write tool calls (`WRITE_TOOL_NAMES`, `:1822`) → **interception** (`:5921`): `buildProposal` (resolves people, validates, builds card),
     `verdictCible` (target must be designated by the user/seen), `verdictEmpreinte` (mutation footprint ≤ request, §118.16), then
     `persistActionIntents` (status `PROPOSED`) and the turn **ends** with a proposal card. Nothing is written.
   - Read tool calls → `executeReadTool` in parallel (`:5986`), results appended as `tool_result`, loop continues.
9. `avecProvenance`: facts of the turn (`faitsDuTour`), calibration, "FAIT VÉRIFIÉ: aucun X" downgraded unless negative proof exists (§118.57).

Read tools **re-check RBAC at execution** [V]: `executeReadTool` → `executePowerTool` (`power-tools.ts:477-508`) re-evaluates
`tool.allowed(user)` and records a permission refusal; reads are additionally scoped by ERP helpers (`companyScopedWhere`, `scopeRegulatory`, …).

**Write confirmation** [V] `assistant-actions.ts:273-330`: `executeAssistantAction(payload, intentId, confirmTyped)` →
`peutVoirAdam` → for `CRITICAL` intents the server compares the retyped value with the stored `confirmText` → `executeIntentGuarded`
(atomic claim `PROPOSED|CONFIRMED|FAILED → EXECUTING` via `updateMany`, replay returns the original receipt, `action-intents.ts:218-277`)
→ `performAction(user, storedPayload)` — the **stored** payload, not the client's. A no-intent path exists for legacy cards but refuses
CRITICAL. `performAction` (`assistant.ts:6107`) = emergency stop → per-kind RBAC (`userCan`) → canonical ERP core function or
server action (e.g. `createTaskRecord`, `createDossierRecord`, `setRegulatoryResponsible(fd)`) → `recordAudit` → `revalidate` paths.
Generic `domain_op` kind dispatches to `DOMAIN_TOOLS[tool].ops[op]` with `meta.gate(user)` then `impl.execute` (`:6120-6134`).
Levels: READ · LOW · COMMUNICATION · SENSITIVE · CRITICAL (`ACTION_POLICY`, `assistant.ts:704`).

**Memory/knowledge** [V]: thread memory per user (`assistant-memory.ts`, `rememberExchange` in `lib/memoire-echange.ts` — moved out of a
`"use server"` file because a forged call could write into a colleague's memory, §118.153(f)); taught rules (`lib/teach`,
`platform/in-process/teach`) injected even when memory flag is off; provenance store (`fabric/provenance-store.ts`);
knowledge layer (`lib/knowledge`, owned by ERP: ingest → chunk → retrieve/rerank, "never call a model for what code can parse");
episodic memory aging in the scheduler (`vieillirMemoire`).

**Voice** [V]: (a) dictation: browser audio → `/api/assistant/transcribe` → Whisper → editable text; (b) realtime: `/api/assistant/voice/session`
mints an ephemeral OpenAI Realtime secret; the browser talks WebRTC to OpenAI; tool calls come back to `/api/assistant/voice/tool`, which
reuses `executeReadTool` / `buildProposal` (same RBAC + interception); usage posted to `/voice/log` → `journaliserSessionVocale`.

**Sandbox** [V] `lib/sandbox/js.ts`: model-written JS runs in a `worker_threads` Worker with `vm.runInContext`, `codeGeneration` disabled
and timeouts. [U] `node:vm` is not a security boundary per Node docs; isolation relies on the worker + empty context.

### 4.4 Mission Runtime

- **What a mission is** [V] `schema.prisma:13815`: a `Mission` row (owner, objective, status, plan version, `kind` RUNTIME/WATCH vs
  historical coordination missions), `MissionStep`s (DAG nodes: capability calls, waits on person/event/time, ARTIFACT, joins, fan-outs),
  `MissionEvent` journal, receipts, `WorkerRun`. Status enum mixes legacy coordination values and runtime values (`schema.prisma:13780`).
- **Launch** [V] `platform/in-process/missions/runtime.ts:285`: `lancerMission` → `peutPiloterMissionsAdam` (else `REFUS_MISSIONS_ADAM`) →
  mission switch → preload dynamic skills → horizon (milestones, §118.40) or single plan. The planner is an LLM behind the `Reasoner` port
  (`reasoner.ts`, roles `CHEAP_WORKER…EXCEPTIONAL_PLANNER` mapped to gateway roles); `compiler/compile.ts` refuses invented capabilities,
  capabilities forbidden to the actor, cycles, wrong cardinality, self-escalation (`policy/guard.ts`).
- **Engine** [V] `engine.ts:243` `avancer()`: stateless — reloads full state from DB each turn, takes a lease (`prendreBail`), honours
  `PAUSED` and the global switch, schedules ready steps by resource class (`scheduler.ts`: `MODELE | BASE | EXTERNE | LIBRE`, unblock-power
  ordering), executes, writes receipts, then returns. Orphaned `RUNNING` steps are reclaimed after `BAIL_MS = 10 min` — safe only because each
  write carries an idempotency key. `conclure` (`:1769`) requires an arithmetic QC and a goal judge (no judge → no conclusion, §118.10).
- **Writes in missions** [V] `runner.ts:380-430`: an `AssistantActionIntent` is created already `CONFIRMED` (approval was given at mission scope,
  §118.8) with a unique `idempotencyKey`, then `executeIntentGuarded` → `performAction` — the same path as a confirmation card.
- **Scheduling** [V]: no cron. `src/lib/scheduled.ts` arms `setInterval(runScheduledJobs, 60 s)` on first module load (not in tests/build);
  debounce + `running` flag per process. `balayerMissions` (`sweep.ts:246`): kill switches → wake time-based waits → recover lost launches →
  `missionsAFaireAvancer` → per mission: model-call cap (BUDGET_HOLD) → **owner re-read** → lease → `conduireMission` (horizon pilot or
  `avancerMission`, replan on BLOCKED/PARTIAL/FAILED, notify once on transition) → overdue waits → `relancerAttente` (escalating reminders).
- **Event-driven wake-up** [V] `events/ledger.ts:48-160`: every `BusinessEvent` (also derived from `recordAudit` via a whitelist,
  `audit.ts:63`) triggers `reveillerMissions`, `satisfaireEngagements`, reminder extinction, late-reply observation, watch wake-ups and
  hot-state invalidation, awaited with `Promise.allSettled`.
- **Pause when rights are lost** [V] `sweep.ts:333`: `if (!proprietaireHabilite(user)) suspendreMissionHorsDroit(...)` → mission set to PAUSED with a
  journal reason, never deleted (§118.136, §118.119b). Also applied to lost-launch recovery (`runtime.ts:907`).
- **Controls** [V] `platform/in-process/missions/control.ts`: pause, resume, suspend-all, stop, refuse approval, replan, prioritise, model cap.

- **Travaux (J2, 30/10/2026)** [V] `src/lib/missions/travaux/`: the SAME engine for every employee. A *travail* is a `Mission` with
  `kind = "TRAVAIL"`, `principalId` (any user) and `persona` (`ASSISTANT_IA` today; `ADAM` port-ready). Persona injected through
  `travaux/persona.ts` (the runtime never imports an assistant); plan DSL compiled to `CompiledStep`s at approval (`plan.ts`);
  `conduite.ts` drives `avancer` wave by wave, re-reading rights (`refusTravail`) and spend caps (`motifPlafond` → pause
  `pausedReason = "BUDGET_HOLD — …"`) before each wave; writes go through `TravailEcriture` receipts (claimed before, closed after;
  an unclosed claim is never replayed). Sweep `travaux.balayage` (`balayage.ts`, raw-SQL candidate query that skips sleeping
  travaux; web abstains under `les-deux` when the worker is alive). Adam's sweeps/views filter `kind = "RUNTIME"`, so they never
  touch travaux. Additive engine changes: `materialiser({ kind, naissance })`, `kind` on pause/resume/cancel, `payload` predicate
  on waits (`events/match.ts`), `reveillerAttentesTemporelles(now, seulement?)`. Decision `docs/assistant/decisions/0016-travaux.md`.

- **Simulation & undo J7 (30/10/2026)** [V] decision `docs/assistant/decisions/0029-simulation-annulation.md`. A card for a
  simulable R1–R4 capability (`infra/capacites.ts`) runs the real screen action inside a rolled-back Prisma transaction
  (`lib/effets/simulation.ts`) and shows the real diff (`domaine/simulation.ts` `VueSimulation`, card block in
  `ecrans/action-confirmation-card.tsx`); at confirmation the simulation is replayed and its fingerprint compared — any
  difference executes nothing and re-shows the card. Confirmed cards, work steps and mandated gestures run under
  `journaliserGeste` (before/after of every write, `AssistantGesteJournal`/`AssistantEffet`); `/assistant/gestes` lists them
  with an honest undo (annulé / compensé / impossible / sans objet + why). Classification: `simulableDe` (J7 rules), 92.5 %
  of R1–R2 capabilities simulable. Cross-cutting details: KB 11 § 8ter.

- **Travaux J8 (30/10/2026)** [V] decision `docs/assistant/decisions/0023-delegation.md`. **Delegation**: plan step `DEMANDE`
  → `WAIT_INPUT`, handled in `conduite.ts` by `delegation.ts deposerDemande` (one `TravailDemande` per step, unique
  `missionId, stepKey`; delays counted from the deposit; shared Drive pieces granted VIEW via the persona port
  `pieces`, audited). The recipient sees `DemandeRecue` only (question, expected/shared pieces, due date — never the
  carnet); `repondreDemande` / `declinerDemande` settle the step (conditional on WAITING), write the answer to the carnet,
  signal the fast wake. **Jalons** `jalons.ts` (relance / escalade to N+1 via `persona.responsable` / abandon → TIMEOUT),
  run by `travaux.balayage` before conducting. **Fast wake** `reveil.ts`: `router.ts` (events + timers) and delegation set
  `Mission.reveilDemandeLe`; `scheduled.ts armerReveilsTravaux` (10 s loop, worker + web) conducts flagged travaux under the
  mission lease — measured p95 10 s. **Fairness**: `travauxAFaireAvancer` round-robins per `principalId` (window
  function), priority within a person. **Team view** `assistant-ia/infra/travaux-equipe.ts`: gated by
  `AssistantIaReglage.managerVoitEquipe` (default false), team = `isManagerOfUser`, summary + steps only, every read
  audited. **Deliverables** `assistant-ia/infra/travaux-livrables.ts`: Markdown → `composerDocx` / `construireClasseurVerifie`,
  deposited through `portsArtefact.documents.creerFichier` (personal Drive « Travaux », Bibliothèque inscription), PDF via
  Atelier conversions; deposit under a `TravailEcriture` receipt (`|livrable`), reprise finds the document by its
  deterministic name. **Robustness** `robustesse.test.ts`: real child processes (`scripts/bench/travail-processus.ts`)
  SIGKILLed 10× over a 3-week fake-clock travail, plus web + worker processes racing on one travail.

- **Atelier (J3, 30/10/2026)** [V] `src/platform/ia/artifact/atelier/`: the Live Office (§104) as TABS for every employee. A tab is an
  `ArtifactSession` with `blockId` `atelier-…`. `gestes.ts` (pure) translates assistant "gestures" into IR commands **per format**
  (reads the view to locate targets, e.g. every PPTX shape holding a text) and computes `zonesModifiees` (content-based diff for
  highlighting). `service.ts`: rights re-read (`voir`/`modifier` — edits refused before applying for viewers), gestures applied
  ONE command per revision (0.7 s pace), review via engine `revoir(seq, ACCEPTER|REFUSER|A_REVOIR)` (reject = undone + replay,
  no inverse command), save = new `FileVersion` (port inscribes Bibliothèque), `documentSensible` (legal doc, mail entry,
  shared space → confirmation card; both live in `artifact/ports.ts`, tabs queries in `artifact/store.ts`, so the socle ceiling went DOWN 180 → 178). `conversions.ts` (composition) + `src/lib/office/conversions-atelier.ts` (engines + queue): voies WORKER (LibreOffice in worker image, queue `AtelierConversion`,
  task `atelier.conversions`), EDITEUR, LOCAL, RENDU, MAISON — the voie is returned and shown. Engine additions:
  `OperationPersistee.touches/revue`, `MagasinSessions.marquerRevue?`, op `docx.inserer_tableau`. Module tools
  `ouvrir_dans_l_atelier` / `modifier_document` / `convertir_document` (family DRIVE, excluded from routines/travaux) and op
  `enregistrer_document`. The screen polls `/api/assistant-ia/atelier` (no SSE: the op journal IS the stream). Decision
  `docs/assistant/decisions/0017-atelier.md`.

- **Proactivity under mandate (J12, 30/10/2026)** [V] `src/modules/assistant-ia/{domaine,infra}/proactivite/`: 12 **watchers**
  (veilleurs) = pure CODE rules over what belongs to the person (own Ad & Pro requests, own budget lines ≥ 90 %, own unsigned
  POs, ANPP obligations/deadlines, assigned reserve points, DIRECT reports' trial/CDD end, own overdue payments, duplicate
  invoices, unreported visits, own stale validations, meeting within the hour). Gated by a screen module AND the console family
  (re-read each pass). Signature = unique `(userId, veilleur, cle)` on `AssistantSignal` → said once; vanished → RESOLU;
  reappears → reopened as JOURNAL (never rings twice). **Interruption budget** (`domaine/proactivite/budget.ts`, pure):
  quiet hours 19→8 Algiers + Fri/Sat, one grouped notification per pass, ≥ 1 h apart, ≤ 5/day (console
  `AssistantIaReglage.interruptionsMaxJour`, person can only lower) → else JOURNAL. One-click useful/not-useful adjusts the
  watcher (threshold factor ×1.25 up to ×3; < 1/3 useful over ≥ 3 → discreet). Morning point = only model call (fast role,
  confidentiality filter, fallback text). Heartbeat task `assistant.veilleurs` (15 min/person, 20/beat). **Mandates**
  (`AssistantMandat`, receipts `AssistantMandatGeste` unique per mandate+signal, taken BEFORE acting): bounded capability /
  recipients / amount / per-day / expiry ≤ 90 d, revocable, R1 by default (`NIVEAU_OPERATION`), sensitive family or R2 →
  console approval. **Gestures run in the person's own request** (`ExecuteurMandats` in the `(app)` layout, server-side
  10-min window): screen actions need `requireUser` and `revalidatePath` throws outside a request (after the write) — the
  same limit applies to J2 travaux gestures on the worker. Actions key `assistant-ia-proactivite-actions`. Decision
  `docs/assistant/decisions/0024-proactivite.md`.

### 4.5 `src/platform` — the boundary

- **Why** [V] `docs/ADAM_PLATFORM_BOUNDARY.md`: separate Adam from ERP *in code*, same process (no microservices, no local cache —
  measured canonical reads at 1–7 ms vs ~1 s model turn).
- **Contract** [V] `contract.ts` (zero imports, test-enforced): `PlatformPort { contractVersion; query; command; authorize; subscribe }`
  (`:448`), `Principal` with opaque role + capability set, `CommandOutcome` distinguishing refusal vs failure (`:399-404`), `DomainEvent`.
- **Bridge** [V]: `BRIDGE_PATHS = ["src/platform/in-process/"]` (`boundary-scan.ts:74`), the only Adam code allowed to import ERP.
  Since lot J0 the **AI socle** `src/platform/ia/` also knows the ERP by design; its imports are counted apart
  (`SOCLE_IA_PATHS`, `SOCLE_IA_CEILING`), and the "zero in `src/platform/`" rule excludes it.
  `adapter.ts` implements the port; `runCommand` (`:410`) re-reads the session user (never trusts `Principal`) and calls `performAction`.
  Some queries (`record.get`, `record.search`, `pending-decisions.list`) throw "not served yet" by design (`adapter.ts:224-226`).
- **Ratchet** [V] `boundary.test.ts`: `src/platform/` (minus bridge) has zero ERP imports; total Adam→ERP crossings ≤ `DEBT_CEILING = 425`
  (`:128`) and within 25 of measurement; contract import-free; exactly one bridge; `NEUTRAL` modules must stay import-free.
  `ADAM_PATHS` (`boundary-scan.ts:33`): `src/platform/`, `src/lib/models/`, `src/lib/assistant/`, `assistant.ts`, `assistant-*`, `src/lib/comms/`,
  `src/components/chief/`, `src/app/(app)/{chief-of-staff,assistant}/`, `src/app/api/assistant/`. Audit: `npm run adam:boundary` (pure fs).
- **Domain map** [V] `domains.ts`: L0 socle (prisma, session, rbac, utils, crypto, platform, seuils, interrupteurs, …) imports nothing above;
  L1 domains must not import each other; L2 façades (`queries/`, `api/registry/`, `links/`) are the authorised crossings; L3 Adam (`assistant/`, `models/`).
- **Event bus** [V] `event-bus.ts` / `events.ts`: in-memory, per process, `REPLAY_CAPACITY = 500`, handlers isolated (errors swallowed),
  `emit` never throws and drops unknown types. Closed catalogue of **17** past-tense facts (`events.ts`). Actually emitted by ERP code in
  **3** places: `modules/rh/actions.ts:97` (`hr.employee-added`), `actions/regulatory-actions.ts:824` (`regulatory.owner-changed`),
  `comms/outbound.ts:514` (`mail.sent`). One subscriber: Adam's change feed (`assistant/platform/change-feed.ts:78-89`, `replayFrom: 0`),
  served via the `what_changed` tool as a *hint*, never as truth.
- **Two event systems — do not confuse** [V]: the volatile `platform` bus (hints for Adam) vs the persistent `BusinessEvent` ledger
  (`lib/events/ledger.ts`, fed by `recordAudit` and explicit `recordEvent`), which is what actually drives missions, watches, reminders.

### 4.6 Evals, benches and their safety

- `src/lib/evals/cibles.ts`: ~20 mandated targets (§33–§39: permission safety 100 %, false success 0, actions without receipt 0,
  deterministic crash recovery ≥ 99 %, entity resolution ≥ 95 %, sabotages 100 %, …), each pointing to the vitest file that measures it;
  `registre.ts` writes `bench-out/evals/<id>.json`; `npm run evals:report` aggregates.
- Architecture "goldens" for Adam: `src/lib/assistant/ops-goldens*.test.ts`, `adam-golden-benchmark.test.ts`, `golden-queries.test.ts`.
- Live benches `scripts/bench/*` (`adam:bench`, `bench:ab`, `bench:chaine`, `bench:horizon`, …) all run with
  `DATABASE_URL=${BENCH_DATABASE_URL:-postgresql://amd:amd@localhost:5432/amd_bench}` and a proxy dispatcher (`package.json:42-58`), and call the
  real provider (keys required). Smokes `adam:smoke:provider` / `adam:smoke:deep` live in `scripts/` (not `scripts/bench/`) and are designed to run in the
  Render shell against production (§118.132(b)).
- **DB guard** [V] `prisma.ts:66-120`: at Prisma construction, a test process requires a local host; a bench process (entry script under
  `scripts/bench/`, detected from `argv[1]`/`npm_lifecycle_script`) requires a local host **and** a DB name containing "bench"; otherwise
  throws with the remedy. No override. Comment states the container's default `DATABASE_URL` points to the **Render production** DB.
- **Egress guard** [V] `sortie/garde.ts:126-200`: `sortiesInterdites()` is true under `NODE_ENV=test`, `VITEST`, Playwright, `ADAM_SORTIE_INTERDITE=1`
  or a bench entry script (override `ADAM_SORTIE_AUTORISEE=1`). `exigerSortieAutorisee` throws `SortieInterdite` before opening a transport
  (used in `lib/mail.ts`, `mail/graph/provider.ts`, `site-web/transport.ts`); `sortieAutorisee` is the non-throwing variant (`push.ts`,
  `mail-smart.ts`). Attempts are logged in memory so benches can assert what *would* have been sent. It does **not** cover LLM egress.

## 5. Conventions & patterns ("house style")

1. **Call models only through the gateway**, by **role** (`callModel("worker", …)`, `askModel`, or legacy `askClaude`/`askClaudeCheap`).
   Never write a model name or provider URL outside `src/lib/models/` (test-enforced). Never send `temperature`.
2. **Read the kill switch before any provider call** if you add a door outside `lib/ai.ts`/gateway users with their own toggle
   (`interrupteurIaCoupe()` / `aiFeatureEnabled(feature)`); a new `AiSetting` toggle must be read by the action, offered by the admin screen
   AND replayed by Adam's op (ratchet `ai-settings.test.ts`).
3. **Absent key ≠ outage**: return `configured:false`; use `phraseIaNonConfiguree` with the key from `cleModeleRequise()` (§118.128).
4. **Errors are values**: AI helpers return `{ok, configured, error}` and never throw to callers; telemetry/event emission must never fail the business write.
5. **Model proposes, code disposes**: every write by Adam = `buildProposal` → `AssistantActionIntent` → user confirmation → `performAction`;
   missions = compiled plan + scope approval + intents. Add a new write as a `domain_op` (catalogue entry + `impl-*.ts`) that replays the
   *screen's* canonical action — never a second implementation of a rule (§118.5).
6. **RBAC three locks**: (a) tool visible only if `allowed(user)`; (b) re-checked at execution (`executePowerTool`, `buildProposal`, `performAction`);
   (c) the ERP action re-checks. Rights decide, not role names — except Adam visibility/missions which are explicitly Super-Admin rules.
7. **Content is data, never instructions** (§118.7): consignes only read code-written text (e.g. `outilsNommes([planCtx, indiceNatif])`, `assistant.ts` ~5545).
8. **Stable outputs**: a capability's output *shape* must not depend on data (§118.20, §118.58); declare outputs; a writing capability that returns
   `{ok:false}` has failed (§118.25, `executer.ts:56`).
9. **Adam ↔ ERP imports**: new Adam code reaches ERP only through `src/platform/in-process/` (bridge) or the contract; shared pure helpers go to
   `NEUTRAL`/socle (zero imports). ERP → Adam must go through ports (e.g. `Reasoner`), dynamic imports, or events.
10. **Client/server split** (CLAUDE.md): server-only AI modules must not leak into `"use client"` graphs (`client-bundle-guard.test.ts`).
11. **Tests that touch global switches** inject readers (`remplacerLecteurInterrupteurIaPourTests`, `deps.interrupteur`) or use a rolled-back transaction
    (`interrupteurs/missions.test.ts`) — never flip the shared row (§118.115, §118.132).
12. Long explanatory French block comments citing §-rules are the norm; each guard names its remedy (§118.30).

## 6. End-to-end flows (traced)

### 6.1 "Crée une tâche pour Nadia : relancer le fournisseur" (Adam, text)

1. Browser (Super Admin, `/chief-of-staff` chat, `src/components/chief/chief-workspace.tsx` → `src/app/(app)/assistant/assistant-chat.tsx`) POSTs
   `{history, threadId}` to `/api/assistant/stream`.
2. `route.ts`: `requireUser()` → `userCan(WORKSPACE,VIEW) && peutVoirAdam` else 403 → impersonation refusal → parallel
   `aiFeatureEnabled("assistant")`, memory flag, `personalContext` → `runAssistantStream(user, history, send, …)`.
3. `runAssistantStreamImpl` (`assistant.ts:5468`): context reads, query plan, entity resolution ("Nadia" → user id or a disambiguation instruction),
   system prompt; `assistantToolsFor(user)` includes `create_task` (WRITE_TOOLS) since no `ECRITURES_SOUS_CONDITION` blocks it; rollout/resolver keep it.
4. Loop: `callClaudeStream` → `models/compat` → `streamModel("worker"…)` (`gateway.ts:233`) → `preparerOpenAi` (Responses protocol, budget) →
   throttle slot → `streamOpenAiResponses` (`fetch /v1/responses`, `stream:true`) → deltas emitted → `recordModelCall`.
5. Model returns `tool_use create_task {title, assigneeName:"Nadia"}` → `writes.length>0` (`:5921`) → `buildProposal("create_task")` (`:3109`):
   `resolvePerson`, card fields, warning "she will accept/refuse" → `verdictCible` + `verdictEmpreinte` pass → `persistActionIntents` (PROPOSED) →
   reply "Je propose : « Demander une tâche à Nadia … ». Confirmez-vous ?" + `proposal{intentId}`; loop ends. **No DB write yet** (except intent row).
6. Route logs `AiUsageLog` (tokens, cost), `rememberExchange` (thread), `consignerProvenance`; sends `done`.
7. User clicks Confirm → server action `executeAssistantAction(payload, intentId)` (`assistant-actions.ts:273`): `peutVoirAdam` → not CRITICAL →
   `executeIntentGuarded` atomically claims → `performAction(user, storedPayload)`.
8. `performAction` (`assistant.ts:6107`): `create_task` not external → `userCan(WORKSPACE,CREATE)` (`:6571`) → `activeUserId` →
   `createTaskRecord(user.id, …, {module:"Assistant IA"})` (`lib/tasks/create-core.ts`: REQUESTED task + pop-up + audit) → result with link.
9. `recordAudit` inside the core → `emettreFait` → if whitelisted, `recordEvent` → `reveillerMissions`/reminders/watches awaited.
10. Intent → EXECUTED with receipt; `revalidatePath("/mon-espace","/mon-travail")`; card shows link.

### 6.2 Mission heartbeat

`scheduled.ts` interval → `runScheduledJobs` → … → `balayerMissions()` → switch check → `missionsAFaireAvancer` → for mission M of owner O:
cap check → `proprietaire(O)` → `proprietaireHabilite` (Super Admin?) else PAUSE → lease → `conduireMission` → `avancerMission` →
engine `avancer` → ready steps → `CapabilityRunner` (read: `executeReadTool`; write: CONFIRMED intent + `performAction`) → receipts →
on BLOCKED: `replanifierMission` (Reasoner → `callModel("orchestrator")`) → notify owner once via attention gate (push/mail, egress-guarded).

### 6.3 ERP fact → Adam

`createEmployee` (hr-actions) → `emit({type:"hr.employee-added",…})` → `event-bus.publish` → change-feed array (in memory) →
later `what_changed` tool reads it as a hint and re-reads canonical data.

### 6.4 Field voice & realtime voice of the Assistant IA (J13, decision 0025)

- **Capture → cards**: `infra/terrain/captation.ts` (idempotent on `(userId, cle)`) → Drive → `transcrireMedia` (`gpt-transcribe`, no forced language, vocabulary hint; `modeleSttTerrain` in `platform/ia/modeles-roles.ts`, chosen by the bench `scripts/banc-stt-terrain.mjs`) → `genererTexte` + `lireCompteRendu` (untrusted JSON) → `resoudreMedecin` over `scopeMedicalDoctors` → `preparerCarte` (same `proposer` + `persistActionIntents` as model tools). Operations `terrain_*` live in `OPERATIONS_IA` (MOTS_CLES fiches, not SOCLE_OUTILS) and execute through screen actions (`createFieldReport`/`updateFieldReport`, `demanderMateriel`, `ouvrirPlanTournee`+`planifierVisites`, `rattacherPhotoTerrain`).
- **Realtime voice (GPT-Live, `gpt-live-1` only — Direction 30/10, no fallback)**: socle `platform/ia/voix/session-temps-reel.ts` (server-side SDP exchange with `POST /v1/live/sessions`, `delegation: { type: "client" }`, no secret reaches the browser; zero imports) + `client-temps-reel.ts` (thin WebRTC client: on `session.delegation.created` it posts what the user said to `/api/assistant-ia/voix/delegation` and returns the result with `session.commentary.append`; latency read on the session timeline from transcript `start_ms`/`end_ms`; graceful `session.close` → `session.closed` usage). Module `infra/voix/temps-reel.ts`: delegation = `deposerMessage` + `traiterFil` — the SAME text assistant (tools, rights, console, repères, cards) in the SAME fil; voice text via `sansValeursRevelees`; transcript appended to the fil at the end; model = admin setting `AssistantIaReglage.modeleVoix` → `ASSISTANT_IA_VOICE_MODEL` → `gpt-live-1`. Adam's realtime untouched.
- **Known limit**: a real `gpt-live-1` session was created (HTTP 201, 6.8 s) but WebRTC media (UDP) does not pass the dev container's egress; first real p50 is logged in production (`[assistant-ia] voix temps réel`).

### 6.5 Card forms, folder deposit, large volumes (J11, decision 0030)

- **Form from the contract**: `platform/ia/capacites/schema.ts` (extracted from `registre.ts`, re-exported: `libelleChamp`, `schemaDe`, `zodDe`) + `formulaire.ts` (pure: `widgetDe`, `formulaireDe`, `entreeDepuisSaisies`, `verifierFormulaire`, `champsCorriges`). `infra/capacites.ts:carteDe` builds fields/level/confirmText/form for every R1+ card; `corrigerCarteCapacite` (called by `confirmerIntentionAssistantIA(intentId, confirmTyped, corrections)` BEFORE `executerIntention`) re-runs the proposal gates (contract keys, `zodDe`, console families incl. salary, `preparer` = name resolution + `validerEntree`) and rewrites the intent (payload, summary, confirmText, `CORRECTED` event) only while `PROPOSED`. `chercherReferenceDeCarte` → `lib/cibles/resoudre-entrees.ts:candidatsDuChamp` (directory for `User`, `resoudreCible` under `porteeEntite` otherwise). Bench `formulaires.test.ts`: all 1 157 R1–R4 capacities, 0 schema gap.
- **Folder lot**: table `AssistantIaDepotDossier` (migration `20270215140000_assistant_ia_depot_dossier`); `infra/depot-dossier.ts` (`ouvrirLotDossier` with a **port** `creerArborescence` supplied by the app route — the module adds no `lib/drive` debt; resume by list fingerprint; `etatDesLots` = recursive CTE under the root + LATERAL join on `BibliothequeFiche.cles @> ['DRIVE_NODE:<id>']`). Pure rules `domaine/lecture/depot-dossier.ts` (bounds `ASSISTANT_DEPOT_DOSSIER_FICHIERS/_MO`, default 1 000 / 2 GB).
- **Ingestion throughput**: `bibliotheque/infra/ingestion.ts:traiterFile({ budgetMs, parallele })` drains batch after batch within a budget with N concurrent readers; `scheduled.ts` passes `BIBLIOTHEQUE_BUDGET_S` (45) / `BIBLIOTHEQUE_PARALLELE` (2). Without budget: one batch (previous behaviour). Bench `npm run bench:dossier` (300 unique files, fake embedder).
- **Answering on the folder**: tool `lire_dossier_depose` (`infra/lecture-dossier.ts`, family DRIVE, third-party framed) reads the lot's files and their fiches in ONE batch (`bibliotheque:fichesDeDossier` via socle `connaissance.ts:fichesDeDossierPourModele` — same rights as `ouvrirDocuments`, vault/confidential without text) and classifies by CTD rules (`domaine/ctd.ts`: section number in path wins, else FR/EN keywords, S vs P tie-break, unclassified is said) + expected-but-missing sections of a generic dossier. No file re-read, no per-file model call.

## 7. Coupling & blast radius

**Adam → ERP** [V] (boundary scan, read-only run): 288 Adam files, **433** crossing imports to 181 ERP targets; top targets `src/lib/prisma` 63,
`session` 42, `rbac` 28, `@prisma/client` 14; most coupled files `assistant.ts` (37), `assistant/ops/impl-wave7d.ts` (25), `impl-wave8-files.ts` (14).
Changing an ERP server action's signature can silently break a `domain_op` impl or the generated contract/dispatch (`actions:contrat`,
`executer.test.ts` resolves all 1,145 actions).

**ERP → Adam (reverse coupling, NOT ratcheted)** [V]: 41 non-Adam files import `@/lib/assistant*`, `@/lib/models/*` or `@/platform/in-process*`, e.g.
`lib/events/ledger.ts` (dynamic `import("@/lib/assistant/reminders")`, `import("@/platform/in-process/missions/relance")`), `lib/scheduled.ts`
(mission sweep), `app/(app)/layout.tsx`, `components/layout/call-provider.tsx`, `lib/actions/{adventum,brand,fabrique,mission-runtime,promo-execution,secretariat-devis}-actions.ts`,
`lib/{lecture-pieces-ia,conseil-pieces-ia,redaction-site-ia,postes-luna-ia,promo-automatismes,demande-devis-depot}.ts`, `lib/queries/{story,e360-blocks}.ts`,
admin pages (`admin/ai`, `admin/qualite`, `admin/marque`), `legal/[id]`, `office/live/[id]`, `validations/paiements/[id]`, `api/events/inbound/[source]`.
Also `src/platform/in-process/adapter.ts:410` imports `performAction` from `@/lib/assistant` — the ERP-write executor for Adam lives *in Adam's file*.
61 files import `@/lib/ai` or `@/lib/ai-settings` (ERP AI features: meeting minutes, field reports, contract analysis, AO extraction, brief).

**Runtime coupling on the hot path** [V]: `recordAudit` (called by ~all ERP writes) awaits `emettreFait` → `recordEvent` → `Promise.allSettled`
of mission wake-up, engagement satisfaction, reminder extinction, watch wake-up (`ledger.ts:66-160`). Errors are swallowed, but **latency** of
every whitelisted audited write includes these queries [V]; a slow mission table slows ERP writes [U].

**Process-local state** [V]: event bus, change feed, throttle, usage-sink buffer, scheduler debounce and egress attempt log are per-process.
With >1 instance: duplicated heartbeats (missions protected by DB leases; other jobs rely on their own idempotency [U]), partial change feed
(documented), per-instance concurrency limits.

**Can AI be disabled cleanly?** Runtime: yes — unset keys (`configured:false` everywhere), `masterEnabled=false` (all `lib/ai.ts` doors + features),
`missionsPaused`/`MISSIONS_SWEEP=off`, `aiExternalActionsDisabled`, and Adam is already hidden from non-Super-Admins. Residual: the gateway-direct
callers rely on their own toggles; the `/assistant` MiMo path reads the master switch and the emergency stop (audit 27/10) and is
capped per turn and per person/day (V3-D). Code removal: **no** — deleting `src/lib/assistant/`,
`src/lib/models/`, `src/platform/in-process/` (the boundary doc's claim) would break the 41 ERP importers above, notably the audit→ledger chain
and the scheduler; the Mission Runtime (`src/lib/missions`) itself only depends on ports and would survive.

**What breaks if X changes**:
- `AiSetting` columns → admin screen, `getAiSettings`, Adam op replay (ratchet).
- `AssistantIaReglage` columns → `consommation-regles.ts` (defaults/bounds, pure, shared with the client form),
  `consommation.ts`, `fil/tour.ts` (IA-09/IA-10 switches), `action-intents.ts` (`expirationCartesHeures`, read via Prisma
  so the intent layer never imports `lib/agent`).
- `ModelCallLog` rows with feature `assistant_ia` → daily cap (`jetonsDuJour`) AND the Consommation IA screen: deleting
  them resets people's daily budget.
- `AssistantActionIntent` schema/status strings → Adam cards, missions runner, beta `lib/agent/ecritures.ts`, idempotency.
- `rbac.ts` `peutVoirAdam`/`peutPiloterMissionsAdam` → ~19 files + mission pause semantics (owners lose rights → all their missions PAUSE).
- `faitDepuisAudit` whitelist → which ERP writes wake missions/watches/reminders.
- Registry defaults → cost dashboards (price `null` if unknown model), protocol validation (`capabilities.ts`).

### 7bis. Recipes (lot J10, decision 0028)

- The Assistant IA reads the `recettes` module (`assistant-ia/infra/recettes.ts`, tool `recette_pour`, a selection card in
  `MOTS_CLES`, context rule 13). Only VALIDATED versions are served; `AUCUNE`/`AMBIGU` never claim a recipe. The plan it returns is a
  J2 work plan (ANALYSE → LIVRABLE → ATTENTE timer → LIVRABLE) valid against any persona catalogue; `RecetteUsage` + the TRAVAIL
  mission launched afterwards measure "accepted unchanged". `MissionPlanPattern` VALIDATED shapes become Super-Admin-only recipe
  cards (no plan): a pattern validated by repetition is still only a PROPOSAL until a human process owner validates it.

## 8. Invariants, gotchas, doctrine rules

Most constraining §118 rules (paraphrased; source `docs/claude-md/03-*` and `08-*`):

1. **§118 preamble — "Models decide WHAT, code decides HOW"**: persistence, rights, states, DAG, retries, idempotency, approvals, verification are software.
2. **§118.3** A model's plan is never executed as-is; the compiler refuses invented/forbidden capabilities, cycles, wrong cardinality.
3. **§118.4** A finished step with its receipt *is* the checkpoint (no separate checkpoint table).
4. **§118.5** Don't recreate what exists: `MissionEvent` journal, `BusinessEvent` ledger, `push.ts`, the existing scheduler, `AssistantActionIntent`. One rule = one implementation.
5. **§118.6** No self-escalation: agent may never touch permissions/RBAC/credentials/guards — refused at compile time, not by prompt.
6. **§118.7** A mission is never a backdoor: same rights, actor, audit and confirmation policy as the screen; content is data.
7. **§118.8** One approval over a fingerprinted scope, not 99 confirmations; material change reopens only the changed part.
8. **§118.10** "All steps ran" ≠ "goal achieved"; no judge → no conclusion.
9. **§118.13** No god-file, no specialised mission (`newYearMission.ts` would be failure). (Note: `assistant.ts` is a 7.3k-line god-file, a known debt.)
10. **§118.14** A capability without a real caller does not exist; dead code/data must be wired or removed.
11. **§118.15** Attestations (grant authorisation, provide a document, lift the mission switch) require a human click in a real session — never a tool.
12. **§118.16** A mutation's real footprint (depth × cardinality) never exceeds the requested one (`mutations/empreinte.ts`, used by chat and compiler).
13. **§118.17** A check that cannot fail protects nothing (e.g. `sorties.every(() => true)`); guards must be falsifiable.
14. **§118.20/58** Output shape must not depend on data; enforce generically, including for skills Adam creates.
15. **§118.25** A writing capability that reports its own failure has failed (no "ok: true" on `{ok:false}`).
16. **§118.30** A refusal names the remedy (for whoever reads it — planner or human, §118.69).
17. **§118.42** Replan loops stop on lack of PROGRESS, not a global cap.
18. **§118.45** A state nothing reads is a screen promise (`PAUSED` had to be honoured by engine and horizon pilot).
19. **§118.49** A test that checks a function body without checking its caller tests nothing.
20. **§118.52** Silent filters leave no trace — log what you drop.
21. **§118.57** Never label an absence "FAIT VÉRIFIÉ" without negative proof.
22. **§118.100** Adam is a module inside the ERP shell, not a separate route group.
23. **§118.114/§118.136** Boundary ratchets are not raised to admit a crossing; Adam missions are Super-Admin only (predicate + 11 doors).
24. **§118.115** Do not run two jobs touching the same file / do not flip global DB rows from parallel tests.
25. **§118.119b** A schedule is a permission that would outlive its holder — re-read the owner each heartbeat; pause, don't delete.
26. **§118.128** Name the right missing key (provider-dependent), never a wrong remedy.
27. **§118.132** Global mission switch: checked by engine, heartbeat, horizon pilot and launch; lifting only by click; smokes must close their missions.
28. **§118.153(f)** "Adam must be visible to nobody but the Super Admin" — segment-level guard, `peutVoirAdam`, `REFUS_ADAM`; Adam is in development pause.
29. **§118.155** Render runs `next lint` before build; a single lint error blocks all deploys.

Gotchas [V]:
- Default provider is **OpenAI** although names (`askClaude`, `ClaudeToolDef`, `callClaude`) say Claude — names were kept deliberately (`ai.ts` header).
- `AiSetting` reads fail **open**; mission switch fails **closed**.
- `logAiUsage` in the stream route hardcodes `provider: "openai"` even when `ADAM_MODEL_PROVIDER=anthropic` (`stream/route.ts`, logAiUsage call).
- Two copies of the agent loop (`:4850` and `:5468`) must be changed together.
- Telemetry sink is installed by **side-effect import** (`assistant.ts:67`, `reasoner.ts:2`); a process that never loads either would not persist `ModelCallLog` rows [U].
- The scheduler runs inside the web process; an idle-suspended host stops missions (documented, `scheduled.ts:74`).
- Container `DATABASE_URL` may default to production; benches/tests are protected by `prisma.ts`, ad-hoc `tsx` scripts outside `scripts/bench/` are **not**.

## 9. Docs-vs-code discrepancies

1. **`docs/readme/15-intelligence-artificielle-claude-whisper.md`** says the assistant is a "boucle agent Claude" with `ANTHROPIC_API_KEY`; code defaults to
   OpenAI `gpt-5.6-terra`/`luna` (`registry.ts:44,136`); Anthropic is a rollback. It also describes `/assistant` as Adam's full-page module — at HEAD `/assistant`
   renders the new Mastra/MiMo beta (`src/app/(app)/assistant/page.tsx`), Adam's chat lives under `/chief-of-staff`.
2. **"Adam visible to Super Admin only" (§118.153)** — violated at HEAD: `fa9b9ab` (2026-10-24) removed `if (!peutVoirAdam(user)) notFound();` from
   `/assistant` (now `requireModule("WORKSPACE")`, `page.tsx:13`); `beta/actions.ts` server actions (`chargerKpiBeta` :33, `envoyerMessageBeta` :66,
   `confirmerActionBeta` :58) only `requireUser()`; and `AssistantWelcomeDialog` (rendered for everyone in `src/app/(app)/layout.tsx:177`) links to `/assistant`.
   `src/lib/adam-visibilite.test.ts:63-64` still asserts the guard → **fails** [V statically].
3. **Single gateway** — `beta/actions.ts:283` `fetch("https://token-plan-ams.xiaomimimo.com/v1/chat/completions")` matches `PORTES` and is not allow-listed →
   `passerelle-unique.test.ts` **fails** [V statically]; no kill switch, no telemetry/cost, client-supplied `historique` roles forwarded verbatim (role spoofing [U]),
   user content sent to a third-party provider not mentioned in any doc.
4. **Boundary ratchet** — scan gives **433 > 425** (`boundary.test.ts:128`); the 9 new crossings are all from `assistant/beta/actions.ts` (7) and
   `assistant/page.tsx` (2) → `boundary.test.ts` **fails** [V via the same scanner]. Also `visibilite-adam.ts` comment mentions "431 pour un plafond de 427" (stale).
5. **"Aucune donnée simulée"** (CLAUDE.md) vs beta: production server action imports `lib/agent/testing/modele-factice` (a test double) and returns canned
   regex answers, including a hardcoded claim "Toutes les tables sont actives, intègres et synchronisées" and DB name "(amd_dev)" (`beta/actions.ts:100-150`).
6. **"Adventum Brain"** — readme 16 defines it as the Super Admin cockpit (`/adventum-brain`); the beta reuses the name for the general assistant.
7. **`docs/ADAM_PLATFORM_BOUNDARY.md`** — "123 Adam files / 425 imports" (now 288 / 433); "un seul pont: `in-process/adapter.ts`" (bridge is now a ~30-folder
   directory); "the result distinguishes refusal from failure" — `runCommand` always returns `refused: true` (`adapter.ts:426-433`), the `refused:false` branch is never produced.
8. `ai-settings.ts` header and readme claim the master switch "coupe toute l'IA" — by its own admission gateway-direct callers (mission reasoner, web research) are not covered;
   the beta MiMo path is not covered at all.
9. CHIEF_OF_STAFF_ARCHITECTURE §1.1 "Un seul moteur" — there are now two engines (Adam loop and the Mastra beta agent with its own executor
   `lib/agent/ecritures.ts:210`, which does **not** re-check `userCan` at execution nor honour `aiExternalActionsDisabled`).

## 10. Verified vs uncertain

[V] Provider/role table, env vars and raw-fetch transport (`registry.ts`, `gateway.ts`, adapters).
[V] Kill-switch semantics and read sites (`ai-settings.ts:130-245`, `ai.ts:288-308`, `assistant.ts:6107-6118`, `sweep.ts:248-266`).
[V] Adam stream route gating and turn logging (`api/assistant/stream/route.ts`).
[V] Agent loop structure, write interception, guards (`assistant.ts:5468-6072`).
[V] Confirmation path, CRITICAL retype, idempotent intent claim (`assistant-actions.ts:273-330`, `action-intents.ts:218-277`).
[V] `performAction` emergency stop and `create_task` RBAC + canonical core (`assistant.ts:6107,6570-6590`).
[V] Mission launch gate, sweep owner re-read and pause, global switch, lease, replan/notify (`runtime.ts:285-318`, `sweep.ts:246-380`).
[V] Mission writes via CONFIRMED intents + `performAction` (`runner.ts:380-430`).
[V] Event catalogue (17 types), 3 emitters, 1 subscriber; BusinessEvent ledger consequences (`events.ts`, `ledger.ts:66-160`, `audit.ts:43-85`).
[V] Boundary scanner result 433 (read-only run of `scripts/adam-boundary.ts` + attribution script).
[V] Beta assistant: Mastra `Agent`, fake model, MiMo fetch, missing `peutVoirAdam`, welcome dialog in layout (files cited in §9).
[V] Prisma bench/test DB guard and egress guard behaviour (`prisma.ts`, `sortie/garde.ts`).
[V] Three architecture tests fail at HEAD — derived statically from test sources + scanner; **not executed**.
[U] Whether missions can execute CRITICAL-level actions without the human retype (runner sets `confirmText` but `executeIntentGuarded` does not check it; scope approval may cover it).
[U] How server actions that call `requireUser()` behave when invoked from the background heartbeat (no request context) via `domain_op`/generic executor.
[U] Multi-instance behaviour of in-process scheduler/throttle/bus in production (Render instance count unknown).
[U] Whether `ModelCallLog` misses calls in processes that never import the usage sink.
[U] `node:vm` + worker sandbox strength against hostile model-generated code.
[U] Production `AiSetting` / `AppSetting` values (switch states) — not read.
