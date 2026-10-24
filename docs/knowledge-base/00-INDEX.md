# Knowledge base — AMD Internal OS (architect's map)

A verified, reusable map of the ERP for future development sessions, built on **2026-10-24 against HEAD `41b2ef0`**
(deploy branch `claude/hopeful-goodall-phd0nb`). It complements — and fact-checks — the functional README
(`docs/readme/`), the doctrine (`docs/claude-md/`) and the code graph (`graphify-out/`). Analysis only: no source code
was changed to produce it.

## How to use it

1. Start with **[01 — System overview](01-system-overview.md)**: business map, architecture, request lifecycle,
   cross-system invariants, doctrine cheat sheet, baseline health, **risk register**, open questions, reading guide.
2. Open the chapter for the area you are about to change (table below). Each chapter has the same 10 sections:
   Scope · Summary · Key files · How it works · House style · End-to-end flows · Coupling & blast radius ·
   Invariants & doctrine · Docs-vs-code discrepancies · Verified vs uncertain.
3. Then follow CLAUDE.md's order: README → Graphify query → targeted code reading. Line numbers here are a snapshot;
   re-locate symbols with `npm run graphify:query -- "<symbol>"` or `rg` before editing.

**Evidence tags**: **[V]** read in code or measured (citation given) · **[V·agent]** verified by the chapter's author
with file:line, not re-checked · **[V·orch]** re-checked by the orchestrator · **[U]** inferred / unconfirmed.

## Chapters

| # | Chapter | Covers |
|---|---|---|
| 01 | [System overview & risk register](01-system-overview.md) | Synthesis, invariants, doctrine, baseline test/build health, consolidated risks, open questions |
| 02 | [Auth, RBAC & security](02-auth-rbac-security.md) | NextAuth v5, sessions, guards, 19 roles × 70 modules × 7 actions, overrides, row-level access, API auth, crypto, security risks |
| 03 | [Data model & migrations](03-data-model-and-migrations.md) | 433 models in 33 domains (full appendix), conventions (cuid, Decimal, JSON, trash, numbering), migrations, drift addendum |
| 04 | [Backend conventions, actions & API](04-backend-conventions-actions-api.md) | Page anatomy, server-action skeleton, queries, 121 API routes, `/api/v1`, **recipe to add a module** |
| 05 | [Frontend, design system & UX](05-frontend-ui-ux.md) | UI kit, styling tokens, client/server split, action hooks, polling real-time, French UX conventions, **screen checklist** |
| 06 | [Finance, budgets & approvals](06-finance-budgets-approvals.md) | Ad & Pro circuits, validation engines, budgets, payment centre, Finances, BC, invoices — state machines + full money trace |
| 07 | [Pharma commercial & regulatory](07-pharma-commercial-regulatory.md) | Glossary, Regulatory/ANPP, Produits 360, PCH markets & sales imports, stocks, segmentation, field force, marketing, site web |
| 08 | [HR, collaboration, documents & comms](08-hr-collaboration-documents-comms.md) | RH, recruitment, trainings, Mon espace, tasks, messaging, notifications, Drive/storage, OnlyOffice, mail, legal |
| 09 | [AI: Adam, missions & platform](09-ai-adam-missions-platform.md) | Model gateway, agent loop & tool RBAC, Mission Runtime, `src/platform` boundary, new Mastra agent/beta |
| 10 | [Infra, build, deploy & testing](10-infra-build-deploy-testing.md) | Render, build memory, ~200 env vars, in-process scheduler, test architecture & ratchets, **safe-change checklist** |
| 11 | [Cross-cutting mechanisms & coupling](11-cross-cutting-and-coupling.md) | Audit→fact→consequences spine, notifications, trash, search, action centre, fan-in coupling map, **impact playbook** |

## Keeping it current

- After a large functional batch, update the affected chapter(s) **together with** the README and the Graphify refresh
  (same rule as CLAUDE.md: the maps must stay exact). Update the risk register in 01 §8 when a risk is fixed or found.
- Prefer correcting a claim and its tag over appending; keep the "Verified vs uncertain" sections honest.
- Re-measure counts with commands, not by editing numbers by hand (the commands used are cited next to each figure).
