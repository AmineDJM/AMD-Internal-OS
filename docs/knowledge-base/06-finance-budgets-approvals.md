# 06 — Money & approval backbone: Ad & Pro, validation engines, budgets, payment centre, Finances, BC, invoices

> Knowledge-base chapter. Written from the code at HEAD `11a281d` (2026-10-24). French identifiers are kept verbatim
> with a gloss on first use. Tags: **[V]** = read in code (file:line cited), **[U]** = inferred / not exhaustively checked.

---

## 1. Scope

Everything that decides, commits, authorises, pays and books money:

- **Ad & Pro** ("Advertising & Promotion" — the medical-promotion spending pole) requests, all 7 natures
  (*natures* = kinds): sponsoring, prise en charge internationale / nationale (congress travel/accommodation cover),
  événement (event), matériel promotionnel (promo material), consulting, « autre demande » (other).
- The **configurable workflow engine** (`WorkflowDefinition/Step/Instance`) that runs the 4 configurable Ad & Pro
  circuits, the **parcours** (routing by requester rank), and the DG threshold gate.
- **Postes** (`AdProItem` — line items of an operation) and their two-stage validation, BC (*bon de commande* =
  purchase order) request/visa/signature, invoice deposit, payment request.
- The **generic validation centre** (`ValidationRequest/Step/Rule`, `/validations`, `/centre-de-validations`).
- The **Ad & Pro validation centre** (`/centre-ad-pro`, `AdProGateVisa`) and the **BC routing** (`aiguillage`).
- The **payment centre** (`/centre-de-paiement`) and **expense orders** (`ExpenseOrder`, *ordre de dépense*).
- **Payment requests** (`PaymentRequest`, *demande de paiement*, `/validations/paiements`).
- **Finances**: *Banque & paiements* (`/finances/paiements-a-faire`), *Comptabilité* (`/finances/comptabilite`),
  treasury accounts and the treasury balance (§118.176), the ledger (`FinanceTransaction`).
- **Budgets**: envelopes, categories/sub-categories, pole budgets (Marketing / Regulatory / Operations), consumption,
  committed ("engagé") and the Budget-Marketing poste-expense lifecycle.

Out of scope (touched only at boundaries): medical-info declarations (PRIM), payroll, petty cash, regulatory BV, Legal
registry internals, promo-material execution chantiers.

## 2. Summary

1. Every outgoing payment is an `ExpenseOrder` created by **one** writer, `createExpenseOrder`
   (`src/lib/expense-orders.ts:269`), which always sets `centralStatus = "AWAITING"` [V]. 21 call sites feed it.
2. The **payment centre** (PDG = role `DIRECTION`, `SUPER_ADMIN`, named `PaymentCentreSeat`s) authorises or refuses
   (`decidePayment`), and **Finances** pays (`settleExpenseOrder`), which is the only place `PAID` is written and is
   gated by `canDisburse` (`src/lib/payments/authorization.ts:94`) [V]. A source-reading ratchet test enforces both.
3. Ad & Pro requests are routed by **who asks** (`parcoursAdPro`, `src/lib/workflow/parcours.ts:146`), with a DG gate
   above `AppSetting.adProDgThreshold` (default 1,000,000 DZD) that auto-skips below it [V].
4. Sponsoring is "tenue d'abord, argent à la fin": the circuit only **pre-validates the event**; money is decided per
   **poste** (two stages: Direction des opérations, then Direction Marketing with amount + budget category), each poste
   spending through BC → Finances signature → invoice → expense order → centre → Finances [V].
5. Budget **consumption** = settled OUT `FinanceTransaction`s carrying `budgetCategoryId` (+ budget-only lines);
   **engagé** is computed from open orders and signed BCs. Overspend is **displayed, never blocked** [V].
6. Amounts are `Decimal(14,2)` in DB, handled as JS `number` in logic, displayed with `toLocaleString("fr-FR")` + DZD [V].
7. Separation of duties is a **role-default convention, not a per-person check**: the `DIRECTION` role can approve
   the request, authorise at the centre, and settle in Finances (it has `FINANCES: MANAGE`) [V].

## 3. Key files

| Path | Role |
|---|---|
| `src/lib/expense-orders.ts` | `createExpenseOrder` — sole ExpenseOrder writer; entity resolution (`COMPANY_OF_SOURCE`), companion dossier, centre notification |
| `src/lib/payments/authorization.ts` | PURE centre rules: `initialCentralStatus`, `canDisburse`, `visibleToFinance`, `applyDecision`, `statutApresNouveauMontant/Revision`, `sitsOnPaymentCentre` |
| `src/lib/actions/payment-centre-actions.ts` | `decidePayment` (APPROVE/REFUSE), `respondToPaymentCentre` (legacy states) |
| `src/lib/actions/expense-actions.ts` | `settleExpenseOrder` (disbursement + ledger entry + source sync), `deferExpenseOrder`, `resumeExpenseOrder`, `requestInvoice`, `purgeSettledExpenseOrders` |
| `src/lib/payments/revision-ordre.ts` | `reviserOrdreNonRegle` — the single order-amount/beneficiary reviser (reopens authorisation on increase) |
| `src/lib/payments/annulation.ts` | `annulerOrdreNonRegle` — conditional cancel of an unpaid order when its source goes away |
| `src/lib/payments/sections-centre.ts` | Centre layout: entity tabs + Regulatory / Sales & Marketing / Autres sections |
| `src/lib/queries/centre-paiement.ts` | `chargerCentre` (entity-scoped via `ficheScopedWhere`) |
| `src/lib/finances/settlement.ts` | `PAYMENT_PATHS` registry (AUTORISE / ENREGISTRE / HORS_CENTRE), `canSendToSettlement` |
| `src/lib/finance/settle-budget.ts` | PURE `budgetGate` — classify before paying |
| `src/lib/finance/tresorerie.ts` + `src/lib/queries/finance.ts` | Anchored treasury balances, `disponible()` (§118.176), `chargerTresorerie` |
| `src/lib/finance/payment-request.ts` | PURE PaymentRequest state machine (`MOVES`) |
| `src/lib/actions/payment-request-actions.ts` | create/submit/decide/correct/cancel payment requests (order created at submission) |
| `src/lib/workflow/engine.ts` | Workflow engine: `ensureInstance`, `canActOnStep`, `advanceWorkflowInstance`, `emitFinancials`, resubmit/withdraw/reopen |
| `src/lib/workflow/parcours.ts` | PURE routing table (entry, `finalSlug` bound, `skippedSlugs` sieve) |
| `src/lib/workflow/origin.ts` | `adProOriginRank`, `adProInit` (legacy start status) |
| `src/lib/workflow/defaults.ts` | Seed circuit preliminary → dg → final → marketing; sponsoring pre-validation step |
| `src/lib/workflow/pouvoirs-argent.ts`, `issue-sponsoring.ts`, `renvoi.ts` | Money powers inherited by concluding step; sponsoring outcome; return-for-correction |
| `src/lib/seuils/ad-pro.ts` | PURE `porteDgRequise` (zero imports; shared by tasks & adpro domains) |
| `src/lib/actions/workflow-actions.ts` | `advanceWorkflow` server action (the only caller of the engine's advance) |
| `src/lib/actions/sponsoring-actions.ts` | `createSponsoring`, `cloturerSponsoring`, `rouvrirSponsoring`, `sponsoringAppeal` |
| `src/lib/ad-pro-items.ts` | PURE poste guards: `breakdown`, `canSubmitItem`, `canRequestPurchaseOrder`, `canEmitOrder` |
| `src/lib/ad-pro/validation-poste.ts` | PURE two-stage poste validation (`tempsEnAttente`, `droitsValidation`) §118.204 |
| `src/lib/actions/ad-pro-item-actions.ts` (4,454 lines) | All poste gestures incl. `decideAdProItem`, `requestAdProItemOrder`, `approveAdProItemOrder`, `demanderPaiementPoste`, `payerLesFacturesDuPoste` |
| `src/lib/ad-pro/centre.ts`, `visa.ts`, `actions/ad-pro-centre-actions.ts` | Ad & Pro centre: seat, `FORME_PORTE`, visa lifecycle |
| `src/lib/bons-de-commande/regle.ts` | PURE BC rule: `validationRequiseBC`, `gesteAiguillage`, `etapeBC` |
| `src/lib/bons-de-commande/aiguillage.ts` | BC routing (`aiguillerBC`, origin walk, threshold re-routing) |
| `src/lib/actions/bc-signature-actions.ts` | `signerBonDeCommande`, `renvoyerBonDeCommande` |
| `src/lib/validation.ts`, `src/lib/validations/decision.ts`, `actions/validation-actions.ts` | Generic validation centre (rules, sequential/parallel steps, return-for-correction) |
| `src/lib/budget/*.ts` | PURE budget rules: `domaines`, `engage`, `depense-poste`, `auto-category`, `integration-regle`, `cumul-categories` |
| `src/lib/queries/budget.ts`, `budget-sources.ts` | Consumption & committed aggregation |
| `src/lib/actions/budget-depense-poste-actions.ts` | Budget Marketing: impute / change / consume / cancel a poste expense |
| `src/lib/actions/settings-actions.ts` | Threshold setters (`setAdProDgThreshold`, `setBcValidationThreshold`, `setBcValidationThresholdCentre`) |
| `prisma/schema.prisma` | `ExpenseOrder` (6232), `AdProItem` (~2300), enums `SponsoringStatus` (142), `CongressRequestStatus` (205), `ExpenseOrderStatus` (590), `AppSetting` thresholds (9349–9360), `AdProGateVisa` (12781) |

## 4. How it works

### 4.1 Money representation

- DB: every money column in this area is `Decimal @db.Decimal(14,2)` — e.g. `ExpenseOrder.amount`
  (`prisma/schema.prisma:6240`), `AdProItem.amountEstimated/amountGranted` (2333–2334), thresholds (9349–9360) [V].
- Logic: converted to `number` (`toNumber`, `Number(order.amount)`); `createExpenseOrder` takes `amount: number`
  (`expense-orders.ts:41`) [V]. Rounding is explicit where sums are built (`Math.round(m*100)/100`,
  `ad-pro-item-actions.ts` in `payerLesFacturesDuPoste`) [V]. Comparison tolerance in budget rules `TOLERANCE = 0.005`
  (`budget/depense-poste.ts:248`) [V].
- Display: `x.toLocaleString("fr-FR") + " DZD"` throughout actions/notifications; `formatCurrency` in pages [V].
- Currency is implicitly DZD everywhere; there is no currency column on orders/transactions [V for ExpenseOrder model].
- `centralStatus` is a **String** column defaulting to `"NOT_REQUIRED"` (`schema.prisma:6278`), typed in TS only
  via `CentralStatus` (`authorization.ts:45`) [V].

### 4.2 Thresholds — who configures what

| Setting | Default | Meaning | Who sets | Readers |
|---|---|---|---|---|
| `AppSetting.adProDgThreshold` | 1,000,000 | DG gate for Ad & Pro requests, **strictly above**; 0 disarms; unknown amount opens gate (`porteDgRequise`, `seuils/ad-pro.ts:49`) | `setAdProDgThreshold` — `siegeAuCentreAdPro` = `SUPER_ADMIN` or `GENERAL_MANAGER` (`settings-actions.ts:63`, `ad-pro/centre.ts:94`) | `workflow/parcours.ts` (`seuilFranchissement`), engine `settleAutoSkips`, `promo-material/circuit.ts` (`REVIEW_DG`), Ad&Pro centre visas |
| `AppSetting.bcValidationThreshold` | 0 | BC of Ad & Pro origin above → Ad & Pro centre visa; 0 = every BC | `setBcValidationThreshold` (Ad & Pro centre seat) | `bons-de-commande/regle.ts:228`, poste visa `gesteVisaPoste` |
| `AppSetting.bcValidationThresholdCentre` | 0 | Same for non-Ad & Pro BCs → generic validation centre | `setBcValidationThresholdCentre` (`sitsOnValidationCentre`: DG, Super Admin) | `seuilDuCentre` (`regle.ts:239`) |
| `WorkflowStep.autoSkipMaxAmount` | null | Per-step manual threshold; overrides global for that step (`seuilFranchissement`, `parcours.ts:263`) | Super Admin in `/admin/workflows` | engine `autoSkipEligible` (`engine.ts:220`) |
| `CENTRAL_AUTH_THRESHOLD_DZD` | 50,000 (code const) | **Marker only** (`isHighValue`) for sorting the centre queue — not a filter (`authorization.ts:31`) | code | centre notifications/queue |
| `ValidationRule.minAmount/maxAmount` | — | Rule matching in the generic validation centre (`validation.ts:32`) | Super Admin (`createValidationRule`) | `findMatchingRule` |
| `PaymentThreshold` model (per entity, 500,000) | — | **Dead**: no `prisma.paymentThreshold` access in `src/` [V by rg] | — | none |

Changing a BC threshold **re-routes in-flight BCs** in both directions (`reaiguillerSurChangementDeSeuil`,
`aiguillage.ts:763`, called from `reglerSeuilBC`) [V]. Visas freeze the threshold that triggered them
(`AdProGateVisa.threshold`) [V schema].

### 4.3 Ad & Pro — the 7 natures and their state machines

Two `AdProKind` unions exist: `ad-pro/unified.ts:23` (`CONSULTING`, `OTHER`) and `ad-pro-edit.ts:30`
(`CONSULTING_CONTRACT`, `AD_PRO_OTHER`) [V] — watch which one a module uses.

| Nature | Status field / enum | Gate above DG threshold (`FORME_PORTE`, `ad-pro/centre.ts:157`) |
|---|---|---|
| Sponsoring | `SponsoringRequest.status: SponsoringStatus` (`schema:142`) | `ETAPE_CIRCUIT` — workflow step `dg` |
| Congrès international / national | `requestStatus: CongressRequestStatus` (`schema:205`, fields 3658/3738) | `ETAPE_CIRCUIT` |
| Événement | `Event.requestStatus: CongressRequestStatus?` (`schema:8822`) | `ETAPE_CIRCUIT` |
| Matériel promotionnel | `PromoMaterialStatus` (`schema:7487`) + circuit steps `PROMO_STEPS` (`promo-material/circuit.ts:50`) | `ETAPE_PROMO` — step `REVIEW_DG` |
| Consulting | `ConsultingStatus` DRAFT→AWAITING_VALIDATION→ACTIVE→EXPIRED/CANCELLED (`ad-pro/consulting.ts:42`) | `VISA_CENTRE` (`AdProGateVisa`) |
| Autre | `AdProOtherStatus` DRAFT, AWAITING_DECISION, APPROVED, REFUSED, DONE, CANCELLED (`schema:12682`) | `VISA_CENTRE` |

**The 4 configurable circuits** (sponsoring, 2 congresses, event) run on the engine; the entity's legacy status is a
**projection** of the instance (`LEGACY_FIELD`, `engine.ts:~296`; `positionFromLegacy`, `engine.ts:361`) [V].

Legacy statuses used by the circuit (`SponsoringStatus` / `CongressRequestStatus`): `AWAITING_PRELIMINARY` →
`PRELIMINARY_APPROVED` (DG gate and `final` both project this) → `AWAITING_FINAL` (marketing) → `APPROVED`
(congress/event; money granted) or, for sponsoring on the default circuit, `PRE_VALIDATED` (event held, money later)
→ `CLOSED` (sponsoring closure) ; `REJECTED`/`REFUSED`; `RETURNED` (sent back for correction); sponsoring appeal
`APPEAL_PENDING` / `AWAITING_FINAL_APPEAL`; `PAID` only for a legacy global-amount approval [V `defaults.ts:33-112`,
`schema:142-166`, `cloture-sponsoring.ts:40-60`].

**Consulting** transitions (pure `MOVES`, `consulting.ts:42`): DRAFT —SUBMIT→ AWAITING_VALIDATION —APPROVE→ ACTIVE
—EXPIRE→ EXPIRED; AWAITING_VALIDATION —REFUSE→ CANCELLED, —RETURN→ DRAFT; any non-final —CANCEL→ CANCELLED; ends
are final [V]. Promo material: v1/v2 circuits in `promo-material/circuit.ts` (v2: REVIEW_REQUEST by N+1 capped at
Directeur des Opérations, or Direction Marketing; quotes; REVIEW_REQUESTER; REVIEW_MANAGER unless requester is
Direction Marketing; REVIEW_DG iff `porteDgRequise`; IN_EXECUTION; COMPLETED) [V `circuit.ts:10-30, 177-190`].

### 4.4 The workflow engine (4 configurable circuits)

**Seed** (`defaults.ts:33`): `preliminary` (ROLE `NATIONAL_SALES`) → `dg` (ROLE `GENERAL_MANAGER`, no own threshold:
global one applies) → `final` (GLOBAL_VIEW, role `DIRECTION` — labelled **"Direction des opérations"**,
`labels.ts:36`) → `marketing` (ROLE `PRODUCT_MANAGER` = **"Direction Marketing"**, `requireAmount`,
`requireCategory`, `emitDeclaration`, `emitExpenseOrder`). For SPONSORING the `marketing` step is replaced by
`ETAPE_PRE_VALIDATION_SPONSORING` (`defaults.ts:139`): no amount/category, `emitExpenseOrder: false`,
`emitDeclaration: true` [V]. Seed applies only where no definition exists (doc: migration
`20261106090000_adpro_direction_marketing`) [U].

**Routing — `parcoursAdPro`** (`parcours.ts:146`), rank from `adProOriginRank` (`origin.ts:43`: 3 = global view /
GM / Operations Director; 2 = Direction Marketing roles; 1 = National Sales; 0 = others):

| Requester | Entry | `decision` (finalSlug) | `ignorees` (skippedSlugs) |
|---|---|---|---|
| rank ≥ 3 | `marketing` | null | preliminary, dg, final |
| rank 2 (Direction Marketing, Manager Promo médicale) | `dg` | `final` | preliminary |
| rank 1 (National Sales) | `dg` | null | preliminary |
| KAM (delegate) + SPONSORING | `preliminary` | null | — (traverses all 4) |
| KAM, other natures | `preliminary` | null | final |
| anyone else | `dg` | null | preliminary, final |

`finalSlug`/`skippedSlugs` are **frozen when the `WorkflowInstance` is created**, which is lazy: `ensureInstance`
(`engine.ts:380`) is called from the workflow panel query (`queries/workflow.ts:163`) or the first gesture — **not**
at request creation (`createSponsoring` only writes the legacy status from `adProInit`) [V]. Steps added later by a
Super Admin are traversed (filter in `parcoursEffectif`, `parcours.ts:213`) [V].

**Gesture entry** — `advanceWorkflow` (`actions/workflow-actions.ts:24`) → `advanceWorkflowInstance`
(`engine.ts:603`): instance must be `IN_PROGRESS` (`RETURNED` refused with a specific message), actor checked by
`canActOnStep` (`engine.ts:483`), then a **claim** (`claimedAt`, conditional `updateMany`, 2-min stale takeover,
`engine.ts:575-600, 656`) serialises gestures [V].

`canActOnStep`: `SUPER_ADMIN` → always true; `GLOBAL_VIEW` → global view or role; `ASSIGNEE`; `REQUESTER`;
`DEPARTMENT_MANAGER` (real N+1 chain via `isManagerOfUser`, never self); `DEPARTMENT_HEAD`; default `ROLE` [V
`engine.ts:483-516`]. **There is no "requester cannot act" check in the ROLE/GLOBAL_VIEW scopes**; self-arbitration
is prevented only by routing (rank table) [V].

**Transitions** (`appliquerLeGeste`, `engine.ts:686+`):

| Action | Guard | Effect |
|---|---|---|
| `COMMENT` | step has `COMMENT`; non-empty | `Comment` + `WorkflowStepEvent COMMENT`, no claim |
| `RETURN` | `refusDuRenvoi` (power REJECT, motif, a requester) (`renvoi.ts:47`) | conditional → `status RETURNED`; legacy `RETURNED`; requester resubmits via `resubmitWorkflowInstance` (`engine.ts:1406`) back to `etapeDeReprise` (a self-crossed amount gate is re-evaluated, §118.186) |
| `REJECT` | power REJECT, motif required | if a next step exists → **`OPINION_AGAINST`** (flow continues; optional revised amount on SET_AMOUNT steps); at the deciding step → instance `REJECTED`, `projectReject` (`engine.ts:723-786`) |
| `SKIP` | not the deciding step, no ASSIGN power, reason required | lands on next, then `settleAutoSkips` cascade (`engine.ts:788+`) |
| `APPROVE` | power APPROVE; `lectureDeLApprobation` (`engine.ts:195`) gives `next`, `conclut`, `nonAtteintes`, effective step (money powers inherited by `argentEffectif`); required amount/category/note/assignee checked | sets instance amount/category; **`emitFinancials`** if the step (or an unreached step) carries `emitDeclaration/emitExpenseOrder`; `projectApprove`; `settleAutoSkips`; instance → next or `APPROVED` |

Other gestures: `retirerDemande` (withdraw, `engine.ts:1621`), `relancerCycle` (`1670`), `reopenInstance`
(appeal/reopen, `1727`), `fermerInstance` (`1554`), `apresModificationDeLaDemande` (re-opens a self-crossed gate when
the amount changes, `1485`) [V names/lines].

**Anti-bureaucracy** (`settleAutoSkips`, `engine.ts:247`): AUTO_SKIP when amount ≤ effective threshold (global DG
threshold only for slug `dg`), AUTO_APPROVE_REQUESTER when the requester already holds the step's role
(`autoApproveIfRequester`, opt-in). Never on ASSIGN, emitting steps, or the deciding step. A **zero/unknown amount
never auto-skips** (`autoSkipEligible`: `!(amount > 0)` → false), consistent with `porteDgRequise` [V]. Auto-skips
are also applied at instance creation on the entry step (`engine.ts:440-470`) [V].

**`emitFinancials`** (`engine.ts:951`): requires `instance.amount > 0` unless sponsoring pre-validation. If a
pharmacist exists and the step emits a declaration → creates a `MedicalInfoDeclaration` and **no order here** (the
order is emitted later at the declaration's validation, `validateDeclarationByDirection` per comments) [V for the
branch, U for the downstream]. Otherwise, if `emitExpenseOrder` → `createExpenseOrder` (category `EVENEMENT`) **unless
the operation has postes** (`countAdProItems > 0` → no global order, anti double-count, `engine.ts:998`) [V].

### 4.5 Postes (AdProItem) — the spend unit

Statuses `AdProItemStatus` DRAFT → PENDING → APPROVED / REJECTED / REVISION (`schema:2264`); BC stage
`AdProItemOrderStage` NONE → REQUESTED → DIRECTION_OK (visa) → ISSUED (payment requested) / REFUSED
(`schema:2279`) [V]. Exactly one parent FK (DB constraint `AdProItem_one_parent`, per docs) [U].

- **Submit** `submitAdProItem` (`ad-pro-item-actions.ts:1902`), guard `canSubmitItem` (`ad-pro-items.ts:249`).
- **Two-stage decision** `decideAdProItem` (`:1974`), rule `ad-pro/validation-poste.ts` (§118.204): stage
  OPERATIONS by role `DIRECTION` (sets `opsDecidedAt`, status stays PENDING), then stage MARKETING by
  `PRODUCT_MANAGER`, which must supply **amount granted + `budgetCategoryId`**. If the operation was filed by
  Direction Marketing, the Direction des opérations takes the second stage; if filed by `DIRECTION`, stage one is
  crossed at submission. Super Admin can hold both, in order. Refuse/return need a motif. Writes are conditional
  (`updateMany` on status/`opsDecidedAt`/`expenseOrderId: null`) [V `:1974-2175`].
- Undecidable cases: an un-split `INDIRECT_SUPPORT` cannot be approved (`REFUS_INDIRECT_NON_REPARTI`); a poste with an
  issued order must have the order cancelled first (`annulerOrdrePoste`, `:2787`) [V].
- **BC request** `requestAdProItemOrder` (`:2442`) → opens a secretariat request to the *assistante de direction*;
  direct sponsoring (`VERSEMENT_SANS_BC`) has no BC [V]. **Visa** `approveAdProItemOrder` (`:2537`) — only
  `siegeAuCentreAdPro` (DG / Super Admin), conditional on the amount the seat saw (`montantVu`) [V].
- **Payment** `demanderPaiementPoste` (`:1285`): direct sponsoring → pro forma/letter as a QUOTE LegalDocument (+
  optional invoice) → `createExpenseOrder` (`:1433`); BC postes → `payerLesFacturesDuPoste` (`:1613`) requires the
  BC **signed**, invoice ≤ amount granted, invoice controlled against BC (`refusDemandePaiementBC`), duplicate-invoice
  guard (`verifierFacturesAvantDepot`), claim `orderStage → ISSUED`, then `createExpenseOrder` (`:1698`) [V]. Last
  rampart: if amount/supplier drifted beyond the visa footprint, the visa is reopened and payment refused
  (`gesteVisaPoste`, `ad-pro/bc-poste.ts:87`) [V].

### 4.6 Ad & Pro validation centre (`/centre-ad-pro`)

Seat `siegeAuCentreAdPro` = role **`SUPER_ADMIN` or `GENERAL_MANAGER`** (primary role only, `centre.ts:94`) [V].
Three gate shapes (`FORME_PORTE`, `centre.ts:157`): workflow step `dg` (the centre is a *lens*, the decision is
taken in the dossier), promo `REVIEW_DG`, and a **visa** (`AdProGateVisa`, unique per `(entityType, entityId)`,
status PENDING/APPROVED/REFUSED/CHANGES_REQUESTED, frozen threshold) for consulting and "autre", decided by
`deciderVisaCentreAdPro` (`ad-pro-centre-actions.ts:41`; refusal re-examined by `reexaminerVisaCentreAdPro`, resubmit
`resoumettreAuCentreAdPro`) [V]. The centre also lists poste BC visas and Legal BCs of Ad & Pro origin (`FormeBC`,
`centre.ts:142`) [V]. The DG queue reads `WorkflowInstance.currentSlug = 'dg'` (`queries/ad-pro-centre.ts:67`) —
so a request whose instance has not yet been lazily created is invisible there [V/U: inferred from lazy creation].

**"Over-budget escalation"** in the sense of an envelope overrun does **not** exist: escalation to this centre is
driven only by the DG threshold and the BC threshold. Envelope overrun is a display state ("Dépassé",
`budget/marketing-vue.ts:203`, `cumul-categories.ts`) [V for those; U for exhaustive absence of a blocking check].

### 4.7 Bons de commande (BC) — routing, visa, signature

Pure rule `bons-de-commande/regle.ts`: `validationRequiseBC` (strictly above threshold; 0 or unknown → required,
`:228`); `centreDeLOrigine` (any Ad & Pro link in the origin chain → `AD_PRO`, else `VALIDATION`); `gesteAiguillage`
(`:281`: POSER / RETIRER / TRANSFERER / ACTUALISER / ROUVRIR / RIEN; a REFUSED BC never reopens; poste BCs keep
their own gate); `etapeBC` (`:369`): HORS_CIRCUIT, SANS_PORTE, A_VALIDER, A_REVOIR, REFUSE, A_SIGNER, A_CORRIGER,
SIGNE [V]. Applied by `aiguillerBC` (`aiguillage.ts:460`) from every BC creation path (ratchet
`centre-ecrivains.test.ts:235+`) [V].

Signature `signerBonDeCommande` (`bc-signature-actions.ts:43`): `peutSignerBC` (module `PURCHASE_ORDERS` update;
doc: Direction, DG, Finances by default) [U for defaults], visibility via `bcVisiblesWhere`, step must be signable
(`motifNonSignable`), **a signed copy (PDF/image) must be uploaded and is checked by Luna** (`verifierSignatureParLuna`),
signer name required, conditional on `updatedAt` (what was read is what is signed); storage failure rolls back the
signature [V]. `renvoyerBonDeCommande` (`:145`) returns to issuer with motif [V]. A downstream invoice cannot be sent to
settlement while its BC is not validated (`canSendToSettlement` → `blocageParLeBC`, `finances/settlement.ts:226`,
`regle.ts:165`) [V].

### 4.8 Generic validation centre (`/validations`, `/centre-de-validations`)

`findMatchingRule` (`validation.ts:32`): active `ValidationRule`s filtered by module/objectType/requesterRole/
priority/category/department/min-max amount; most specific wins, then `sortOrder` [V]. `createValidationFromRules`
(`:107`) creates `ValidationRequest` + 1–2 `ValidationStep`s from `validator1Id/validator2Id`, `mode` SEQUENTIAL or
PARALLEL, notifies first (or all) [V]. `createDirectValidation` (`:163`) lets the requester pick validators [V].

`decideValidation` (`validation-actions.ts:339`): motif required for REJECTED/CHANGES_REQUESTED; actor =
`droitSurLEtape` (named validator, **any SUPER_ADMIN**, or an *intérimaire* who is not the requester, `:328`);
sequential turn enforced; **`SELECT … FOR UPDATE`** on the request then re-read steps; outcome by pure
`issueDeLaDecision` (`validations/decision.ts:66`): reject/return close the request, parallel needs all, sequential
advances, `unSeulSuffit` (only `INFO_MED_DIRECTEUR_OPS`) lets one decide for all [V]. Resubmission
`resoumettreValidation` (`:766`) reopens returned steps and, if the amount went **up**, all approved steps too
(`repriseApresCorrection`, `decision.ts:111`) [V]. Nothing prevents a rule from naming the requester as validator [U].

The "N+1 → … → DG" chains of the brief exist in three distinct places, not one engine: workflow scope
`DEPARTMENT_MANAGER/HEAD` (`engine.ts:495-510`), promo-material `REVIEW_REQUEST` ("N+1 plafonné", capped at the
Directeur des Opérations) and BCs of non-Ad & Pro origin addressed to the DG in the generic centre [V/U].

### 4.9 Payment requests (`PaymentRequest`)

Pure `MOVES` (`finance/payment-request.ts:51`): DRAFT —SUBMIT→ SUBMITTED; SUBMITTED/UNDER_REVIEW/ON_HOLD —
REVIEW/HOLD/RESUME/REQUEST_CHANGES/APPROVE(*bon à payer*)/REJECT/CANCEL; CHANGES_REQUESTED —SUBMIT→ SUBMITTED;
APPROVED/REJECTED/CANCELLED terminal [V]. The ExpenseOrder is created **at submission** (`payment-request-actions.ts`
`:350`, `:863`, `:962`) and linked by `PaymentRequest.expenseOrderId` [V]. Finances' refusal/requester withdrawal
cancels the unpaid order (`annulerOrdreNonRegle`, `:939`, `:1106`) [V]. Corrections go through
`reviserOrdreNonRegle` (`:658`) [V]. Every non-request order also gets a **companion dossier** (`origin =
EXPENSE_ORDER`) opened best-effort by `createExpenseOrder` (`expense-orders.ts:212`) and set to paid at settlement
(`syncCompanionOnSettle`, `expense-actions.ts:46`) [V].

### 4.10 Payment centre and expense-order state machines

`ExpenseOrder.status` (`ExpenseOrderStatus`, `schema:590`): PENDING → PAID (only `settleExpenseOrder`) |
PENDING → CANCELLED (only `annulerOrdreNonRegle`, conditional) ; `REVISION_REQUESTED` legacy only [V].

`ExpenseOrder.centralStatus` (`authorization.ts:45`):

```
(create) ── initialCentralStatus ──► AWAITING ──decidePayment APPROVE──► APPROVED ──(settle)──► [status PAID]
                                         │  └──decidePayment REFUSE (motif)──► REFUSED (terminal; status stays PENDING)
   APPROVED/NOT_REQUIRED ──amount ↑ or beneficiary changed (reviserOrdreNonRegle)──► AWAITING
   CHANGES_REQUESTED / INFO_REQUESTED (legacy) ──respondToPaymentCentre──► AWAITING
```

`decidePayment` (`payment-centre-actions.ts:104`): `sitsOnPaymentCentre` (`authorization.ts:168`: `SUPER_ADMIN`,
`DIRECTION`, or `access.paymentCentreSeat`); only APPROVE/REFUSE accepted (`isDecision`, `:94`); refusal needs a body;
closed orders refused (`refusOrdreFerme`); stale-read check (`montantVu`, `beneficiaireVu`); **conditional write** in a
transaction on `centralStatus + amount + beneficiary + status` and a `PaymentCentreMessage` (`:180`) [V]. Optional
centre-imposed `dueDate` on approval [V]. Finances do not see AWAITING/legacy-pending orders (`visibleToFinance`,
`:102`); REFUSED stays visible [V].

`settleExpenseOrder` (`expense-actions.ts:71`), in order: `FINANCES:UPDATE`; status PENDING; **`canDisburse`** (`:86`);
invoice required where `requiresInvoice` (`ordreAFacture`, `:94`) — default for SPONSORING/CONGRESS_*/PROMO_MATERIAL
sources or category EVENEMENT (`expense-orders.ts:76, 270`); regulatory BV needs its *quittance*; petty-cash
remittance skips budget; **budget category chosen = Finances' pick > order's (Direction's) > auto by source module**
(`pickAutoCategory`), enforced by `budgetGate` (`:179`); creates `FinanceTransaction` OUT/SETTLED with
`budgetCategoryId`, `companyId`, `treasuryAccountId` (`:203`); marks order PAID (`:216`); syncs companion; updates the
source (sponsoring → PAID only for `STATUTS_SOLDES_PAR_UN_REGLEMENT` = APPROVED/ACCEPTED; admin request → IN_PROGRESS;
promo dossier closure; BV step; payroll wire); notifies requester; audit `VALIDATE` (`:308`) [V]. Deferral is a **date**
(`deferExpenseOrder`, `:410`), not a status [V].

`PAYMENT_PATHS` (`finances/settlement.ts:77`): AUTORISE = expense-order, payment-request, invoice-settlement, payroll,
petty-cash-allotment, petty-cash-top-up; ENREGISTRE = finance-direct, invoice marked paid, petty-cash-expense;
**HORS_CENTRE = none** (`horsCentre()` comment, `:146-158`) [V].

### 4.11 Finances: ledger, treasury, "Solde trésorerie" (§118.176)

- Ledger = `FinanceTransaction` (direction IN/OUT, status, `budgetCategoryId`, `treasuryAccountId`, `companyId`).
  Every creation must set `treasuryAccountId` (ratchet `finance/ecrivains-tresorerie.test.ts:67`) [V].
- Account balance (pure `soldesTresorerie`, `finance/tresorerie.ts`): `solde = ancrage` (statement balance at
  `jourAncrage`, end of day, Africa/Algiers) `+ Σ signed SETTLED entries dated strictly after the anchor day`;
  account resolution in 5 steps (named account → name match → entity principal → principal without entity → only
  account); unplaceable entries are counted as `nonRattaches` [V].
- **§118.176 formula**: `disponible(totalComptes, paiementsAutorises) = totalComptes − paiementsAutorises`
  (`tresorerie.ts`, last function), where *paiements autorisés* = orders `status PENDING` with a `canDisburse`
  centralStatus (`ORDRES_AUTORISES_NON_REGLES`, `queries/finance.ts:14`), entity-scoped (`chargerTresorerie`,
  `queries/finance.ts:138-186`) [V]. **But** the Banque & paiements page now shows **"Solde bancaire" = total**
  and a separate **"Montant à régler"** card (`finances/paiements-a-faire/page.tsx:190-256`); `tresorerie.disponible`
  is computed and not rendered anywhere [V by rg].

### 4.12 Budgets: allocation, commitment, consumption

- Model: `BudgetEnvelope` (period, modules, `domaine` GENERAL/MARKETING/REGULATORY/OPERATIONS — `schema:2999`,
  `budget/domaines.ts`), `BudgetCategoryLine` (top-level categories; `parentId` = manual sub-category, internal split
  only), `BudgetExpenseLine` (budget-only lines) [V/U for exact fields].
- **Allocation**: category `allocated`; re-allocation bounded by `cessible = alloué − max(payé+engagé, réparti)`
  (`reallouerCategorie`, per docs) [U].
- **Consumption**: `Σ FinanceTransaction OUT SETTLED by budgetCategoryId` + `Σ BudgetExpenseLine` + general-means
  purchases, except envelopes governed by an integration batch (`integration-regle.ts`)
  (`queries/budget.ts:250-275`) [V].
- **Engagé**: open orders (`STATUTS_ORDRE_ENGAGES = PENDING, REVISION_REQUESTED`, `budget/engage.ts`) and signed BCs of
  approved postes minus paid, `max(enAttente, bc − payé)` per poste (`engagementDuPoste`) (`queries/budget-sources.ts`)
  [V].
- **Budget Marketing poste lifecycle** (`budget/depense-poste.ts:146`): `A_IMPUTER` (approved + all BCs signed) →
  `ENGAGEE` (imputed) → `CONSOMMEE` (order exists, located by `lieuDeLOrdre`: centre / answer / refused / Finances) →
  `PAYEE`; `ANNULEE`. Gestures in `budget-depense-poste-actions.ts` (`imputerDepensePoste:184`,
  `consommerDepensePoste:197` → `createExpenseOrder`, `annulerDepensePoste:294`) [V].
- Automatic attribution at settlement via `pickAutoCategory(sourceModule, envelopes, categories)`
  (`budget/auto-category.ts`) [V call site].

### 4.13 Audit trail and notifications

| Step | Audit | Notifications |
|---|---|---|
| Sponsoring created | `recordAudit CREATE` (`sponsoring-actions.ts:277`) + workflow `CREATE` event at instance birth | `notifyAdProCreation` (`:288`) — see discrepancy D5 |
| Workflow gesture | `WorkflowStepEvent` (`recordEvent`) + `recordAudit` UPDATE/VALIDATE/REFUSE | `notifyStepManager`, `prevenirEtapeAtteinte` (step roles + marketing referents), requester at end |
| Poste decision | `AdProItemDecision` (`recordDecision`) + `audit()` | next stage roles (`prevenirLeTemps`), requester |
| BC visa / signature | audit `VALIDATE` "Bons de commande" | issuer; signatories at queue entry (`notifierSignatairesBCASigner`) |
| Order created | (companion `PaymentRequestEvent SUBMIT`) | `notifyRoles(["DIRECTION","SUPER_ADMIN"])` (`expense-orders.ts:311`) — **named seats not notified** |
| Centre decision | `PaymentCentreMessage` + `recordAudit` | Finances+SA on APPROVE (`:208`); requester always |
| Settlement | `recordAudit VALIDATE` (`expense-actions.ts:308`) | requester; BV/petty-cash holders |
| Generic validation | `ValidationStep` rows + thread | `notifyValidator` next; requester at finalisation |

## 5. Conventions & patterns (house style)

1. **Pure rule module + thin action.** State rules live in import-free modules (`authorization.ts`, `regle.ts`,
   `parcours.ts`, `decision.ts`, `depense-poste.ts`, `seuils/ad-pro.ts`) read by action, screen and Adam alike.
   Never re-derive a rule in a page (§118.5 "one truth").
2. **Conditional writes for every state transition** (`updateMany` with the read state in `where`, check `count`),
   or a `claimedAt` claim (workflow) or `SELECT … FOR UPDATE` (validations). Pass what the user *saw*
   (`montantVu`, `beneficiaireVu`, `prestataireVu`) and refuse on drift.
3. **Refusals name what is missing** in one sentence, written once as a constant (`PAYMENT_CENTRE_REFUSAL`,
   `REFUS_CENTRE_AD_PRO`, `MOTIF_EXIGE`). Motif mandatory for refuse/return everywhere.
4. **Exhaustive `Record<Enum, …>` tables** instead of cascades so a new enum value fails to compile
   (`FORME_PORTE`, `POSTE_DE_LA_NATURE`, `COMPANY_OF_SOURCE` + test, `REFERENTIELS_PAR_NATURE`).
5. **Single writers + source-reading ratchets**: new ExpenseOrder creation must go through `createExpenseOrder`;
   new `centralStatus`/`PAID`/amount writes must be added to the closed lists in `payments/centre-ecrivains.test.ts`
   with their justifying rule; every `FinanceTransaction` create must pass `treasuryAccountId`.
6. **Fail-safe direction**: unknown amount opens a gate; unreadable setting → no auto-skip; illegible amount counts as
   an increase (`statutApresNouveauMontant`).
7. **Best-effort side effects never undo money**: companion dossier, notifications, entity resolution are wrapped and
   logged; the order/payment stays.
8. Literal FormData keys in actions (the action-contract generator `actions/contrat.ts` reads them; `if (!v)` = required,
   so optional motifs use `=== null`).
9. Every gesture: `recordAudit` + `revalidatePath` of all screens reading the object; notification links point to the
   exact dossier (`lienCentreDePaiement`, `lienOrdreAPayer`, `paymentDossierHref`).

## 6. End-to-end flow: a KAM's sponsoring, from request to budget consumption

Actors: KAM = `MEDICAL_DELEGATE`; NS = `NATIONAL_SALES`; DG = `GENERAL_MANAGER`; "Direction des opérations" = role
`DIRECTION`; DM = `PRODUCT_MANAGER`; assistante = `DIRECTION_ASSISTANT`; Finances = `FINANCE_BUDGET_MANAGER`;
centre seat = `DIRECTION` / `SUPER_ADMIN` / named seat.

1. **Create** — `actions/sponsoring-actions.ts:createSponsoring` (`:69`): `userCan(SPONSORING, CREATE)`; required
   fields named at once; `adProInit(user,"SPONSORING")` (`origin.ts:111`) → KAM ⇒ `AWAITING_PRELIMINARY`;
   business unit imposed from the author (`businessUnitDuDemandeur`); `companyId = moneyEntityOf(user.id)`;
   `createWithRetry` writes the request **and its first poste** atomically (nested create: kind from nature, amount =
   delegate's suggestion, `budgetKind INCLUDED`) (`:184-243`); attachments; audit; `notifyAdProCreation` → NS [V].
2. **Instance birth** — first view/gesture: `workflow/engine.ts:ensureInstance` (`:380`) → `parcoursEffectif` freezes
   `finalSlug=null`, `skippedSlugs=[]` (KAM + sponsoring traverses all steps); `currentSlug=preliminary` [V].
3. **NS approves** — `actions/workflow-actions.ts:advanceWorkflow` → `engine.ts:advanceWorkflowInstance` (claim) →
   `appliquerLeGeste` APPROVE → `settleAutoSkips`: if estimated amount ≤ `adProDgThreshold`, `dg` is AUTO_SKIPped and
   traced; else it lands on `dg` (visible at `/centre-ad-pro` via `queries/ad-pro-centre.ts`) and the DG approves in
   the dossier [V]. A NS "reject" here is only `OPINION_AGAINST` (not the deciding step) [V].
4. **Direction des opérations** (`final`, GLOBAL_VIEW `DIRECTION`) approves → lands on `marketing` [V].
5. **DM pre-validates the tenue** — APPROVE at `ETAPE_PRE_VALIDATION_SPONSORING`: `issueTerminaleSponsoring` →
   `PRE_VALIDATED` (`issue-sponsoring.ts:54`); `emitFinancials` with `argentDecideApres` → medical-info declaration
   (estimated from postes, `montantADeclarer`) but **no expense order**; instance `APPROVED`; requester notified "tenue
   pré-validée" (`engine.ts:858-940`) [V].
6. **Poste work** — (indirect: `repartirPoste` splits by nature). Requester `submitAdProItem` → `decideAdProItem`
   stage 1 by `DIRECTION` (sets `opsDecidedAt`) → stage 2 by DM with `amountGranted` + `budgetCategoryId` → poste
   `APPROVED`; `reprojeterMontantDemande` [V]. **Budget check = category choice only**; no availability check [V/U].
7. **BC** (indirect postes) — two mutually exclusive routes: (a) `requestAdProItemOrder` (`:2442`) → secretariat
   request to the assistante, who deposits the BC; or (b) platform-generated from validated quote lines:
   `genererBonDeCommandePoste` (`:4147`, mandatory preview draft, no number) → `validerEtEnvoyerBcPoste` (`:4163`,
   requester or Super Admin only; assigns number `NNN/DG/AAAA`, produces Word+PDF, starts the BC march). Above
   `bcValidationThreshold`, visa by DG/SA (`approveAdProItemOrder`, `:2537`); then Finances
   `bc-signature-actions.ts:signerBonDeCommande` (signed copy + Luna check) [V].
8. **Payment request** — `demanderPaiementPoste` (`:1285`) → `payerLesFacturesDuPoste` (`:1613`): invoice deposited &
   controlled vs BC, ≤ granted, claim `orderStage ISSUED` → `expense-orders.ts:createExpenseOrder` (`:269`) with
   `budgetCategoryId` of the poste, category EVENEMENT, `sourceType SPONSORING`, `requiresInvoice` per kind →
   `centralStatus AWAITING`, companion `PaymentRequest`, notify DIRECTION + SA [V]. (Direct sponsoring: pro forma
   instead of BC/invoice, same `createExpenseOrder` at `:1433`. Alternative entry from Budget Marketing:
   `budget-depense-poste-actions.ts:consommerDepensePoste` after `imputerDepensePoste`.)
9. **Centre authorises** — `payment-centre-actions.ts:decidePayment` (`:104`) → `applyDecision` → conditional write
   APPROVED + `PaymentCentreMessage` + audit; notify Finances + requester [V].
10. **Finances disburse** — `expense-actions.ts:settleExpenseOrder` (`:71`): `canDisburse`, invoice present
    (`finance/facture-ordre.ts:ordreAFacture`), `budgetGate` (poste's category), `FinanceTransaction` OUT SETTLED with
    `budgetCategoryId`/`treasuryAccountId`, order PAID, companion synced; sponsoring status is **not** set to PAID
    (PRE_VALIDATED/CLOSED are not "soldé par un règlement") [V].
11. **Booking / consumption** — the settled transaction is summed per category by `queries/budget.ts` (`groupBy` at
    `:253`) and reduces the account balance after its anchor in `finance/tresorerie.ts:soldesTresorerie`; the poste's
    Budget-Marketing state becomes `PAYEE` (`budget/depense-poste.ts:depenseDuPoste`) [V].
12. **Closure** — DM (or who pre-validated, `quiCloture`) `cloturerSponsoring` (`sponsoring-actions.ts:341`):
    `bilanCloture` requires every poste decided and approved ones budgeted; conditional `PRE_VALIDATED → CLOSED`,
    `amountGranted = Σ approved postes` [V]. Execution (BC, invoices, payments) may continue after closure (docs) [U].

## 7. Coupling & blast radius

- **`createExpenseOrder`** has 21 callers across 14 action files + the engine (rg list) [V]. Changing its input shape,
  default `requiresInvoice`, entity resolution or notification affects payroll, petty cash, BV, promo, secretariat,
  legal invoices, payment requests, congress, Ad & Pro postes.
- **`centralStatus` values**: String column — no DB enum protects it. Adding a state requires `CENTRAL_STATUS_LABEL`
  (Record → compile error), `canDisburse`, `visibleToFinance`, `applyDecision`, `blockedReason`,
  `ORDRES_AUTORISES_NON_REGLES` (derived via `canDisburse`), `lieuDeLOrdre` (`depense-poste.ts:135`, default branch
  would classify a new state as "chez les Finances"), `reglement.ts:etatDeLOrdre`, centre sections/queries, and the
  migration that backfills [V for listed readers; U exhaustive].
- **`ExpenseOrderStatus`** (Prisma enum): `STATUTS_ORDRE_ENGAGES`/`STATUTS_EN_CIRCUIT` (duplicated, test-pinned),
  `NON_REGLES` in `annulation.ts`, `refusOrdreFerme`, `settleExpenseOrder`, test-center registry.
- **`SponsoringStatus` / `CongressRequestStatus`**: `positionFromLegacy` string lists (`engine.ts:361-375`),
  `STATUTS_SOLDES_PAR_UN_REGLEMENT`, `SPONSORING_DECIDE`, `defaults.ts legacyStatus`, legacy lists/badges, Adam
  operation catalogs. A new status not in `positionFromLegacy` lists falls back to the **first step** (silent) [V].
- **Adding a workflow step**: edit via `/admin/workflows` (DB) — the seed only applies to empty installs; parcours
  sieve only knows the 4 spine slugs, so a new step is **traversed by every route** (deliberate) [V]. Instances in
  flight keep frozen `skippedSlugs`. If it emits money, inheritance rules (`etapesNonAtteintes`) apply.
- **Adding an Ad & Pro nature**: compile errors from `FORME_PORTE`, `REFERENTIELS_PAR_NATURE`, doc-category ratchet,
  `COMPANY_OF_SOURCE` test, `ENTITY_MODULE`, centre sections (`sections-centre.ts`), `PARENTS` table in
  `ad-pro-item-actions.ts:191` if it has postes [V/U].
- **Adding a budget domain**: `DOMAINES_POLE` + `DOMAINES` record (`budget/domaines.ts`), a new RBAC module
  (`ModuleBudgetPole`), routes `/budget-*`, `rbac.ts` reads `domaines.ts`; `domaine` is a String column (no enum)
  [V/U].
- **Thresholds**: `porteDgRequise` readers span workflow (domain `tasks`), promo material (domain `adpro`) and centre —
  keep it in the zero-import socle (`platform/domains.ts` forbids `adpro → tasks`) [V comment].
- **Roles**: `DIRECTION` is simultaneously "Direction des opérations" (workflow `final`, poste stage 1), "PDG" (payment
  centre seat) and holder of `FINANCES: MANAGE`. Renaming/splitting this role touches all three circuits [V].

## 8. Invariants, gotchas, doctrine

Invariants with their guards/tests:

| Invariant | Enforced by | Test |
|---|---|---|
| Every order is born AWAITING, only one writer | `createExpenseOrder` → `initialCentralStatus` | `payments/centre-ecrivains.test.ts:115-170`, `authorization.test.ts` |
| `PAID` only through `canDisburse` | `settleExpenseOrder` | `centre-ecrivains.test.ts:202` |
| Authorisation covers amount & beneficiary actually paid | `statutApresRevision`, `reviserOrdreNonRegle` | `centre-ecrivains.test.ts:206`, `centre-portes-flow.test.ts` |
| Cancelled orders invisible/undecidable at centre | `ORDRE_NON_ANNULE`, `refusOrdreFerme` | `centre-ordres-annules.test.ts`, `ordres-fermes-flow.test.ts` |
| Only two centre decisions | `isDecision` | `centre-deux-issues.test.ts` |
| No path outside the centre without a written decision | `PAYMENT_PATHS` | `finances/settlement.test.ts:42-90` |
| Every ledger entry pins its treasury account | — | `finance/ecrivains-tresorerie.test.ts` |
| Classify before paying | `budgetGate` | `finance/settle-budget.test.ts` |
| Every ExpenseOrder source resolves an entity | `COMPANY_OF_SOURCE` | `expense-orders.test.ts` |
| DG gate semantics (strict >, 0 disarms, unknown opens) | `porteDgRequise` | `seuils/ad-pro.test.ts` |
| Routing table & sieve | `parcoursAdPro`, `etapesNonAtteintes` | `workflow/parcours.test.ts`, `origin.test.ts`, `sponsoring-kam.test.ts`, `argent-route-coupee-flow.test.ts` |
| Return-for-correction | `renvoi.ts` | `renvoi.test.ts`, `renvoi-flow.test.ts`, `validations/renvoi-flow.test.ts` |
| No global order when postes carry the spend | `countAdProItems` check | `ad-pro/sponsoring-cloture-flow.test.ts`, `postes-chaine-flow.test.ts` [U exact] |
| BC rule & re-routing | `regle.ts`, `aiguillage.ts` | `bons-de-commande/regle.test.ts`, `aiguillage-flow.test.ts`, `seuil-signature-flow.test.ts`, `signature-renvoi-flow.test.ts` |
| Validation decision under concurrency | `FOR UPDATE` + `issueDeLaDecision` | `validations/decision.test.ts` |
| Poste money guards | `ad-pro-items.ts` | `ad-pro-items.test.ts`, `ad-pro/bc-poste.test.ts`, `postes-revision-flow.test.ts` |

Gotchas:

- **G1 — `*-flow.test.ts` are DB-gated**: they `describe.skip` when Postgres is unreachable
  (`payments/centre-portes-flow.test.ts:39-41`) [V]. A green `npm test` without a DB does not exercise the flows.
- **G2 — Settlement is not a conditional write**: `settleExpenseOrder` checks `status === "PENDING"` (`:79`), then
  creates the `FinanceTransaction` (`:203`) and updates the order by `id` only (`:215`). Two concurrent clicks can write
  two ledger entries. No concurrency test found for it [V code; U exploitability].
- **G3 — Separation of duties is not enforced per person**: neither `decidePayment` nor `settleExpenseOrder` compares
  `centralDecidedById`/`requestedById` with the actor; `DIRECTION` (centre seat) has `FINANCES: MANAGE`
  (`rbac.ts:258`) and `SUPER_ADMIN` has everything. "Celui qui autorise ≠ celui qui décaisse" is a screen/role
  convention [V].
- **G4 — `decidePayment` does not re-check entity scope**; only the page query is scoped (`chargerCentre` uses
  `ficheScopedWhere`) [V].
- **G5 — Centre REFUSED ≠ cancelled**: the order stays `status PENDING`, so it keeps counting as *engagé / en circuit*
  in budget queries (`budget-sources.ts:194-228`, `depense-poste.ts:146`) until someone cancels it [V].
- **G6 — Finances can override Direction Marketing's budget category** at settlement (`chosen` wins in `budgetGate`)
  [V]. Doc says "attribuée automatiquement".
- **G7 — Ledger entries of paid orders are freely editable/deletable** by `FINANCES:UPDATE/DELETE`
  (`finance-actions.ts:98-153`), no link check to `ExpenseOrder.transactionId`; consumption and balances move [V].
- **G8 — Workflow `SUPER_ADMIN` bypass**: `canActOnStep` returns true at every step, including on own requests;
  `droitSurLEtape` likewise lets any Super Admin decide any validation step [V].
- **G9 — Lazy instance**: parcours frozen at first view, not creation; DG queue in the centre only shows instances that
  exist [V/U].
- **G10 — Approval is multi-write, not one transaction**: emission, projection, auto-skips and instance update are
  sequential; the claim prevents concurrent gestures but a crash midway can leave an order emitted with the instance
  still on the step (stale claim recoverable after 2 min) [V structure; U recovery].
- **G11 — Two "AdProKind" unions** with different member names (`unified.ts` vs `ad-pro-edit.ts`) [V].
- Doctrine refs used by this area: §118.5 (one truth), §118.16 (fail-safe direction), §118.138 (DG threshold socle),
  §118.142 (parcours), §118.148/149 (BC centres & threshold), §118.151 (sponsoring tenue), §118.176 (treasury,
  payroll/petty-cash via centre), §118.186–191 (return-for-correction, conditional decisions, order revision),
  §118.204 (two-stage poste validation) — cited in code comments; texts in `docs/claude-md/` [U content].

## 9. Docs-vs-code discrepancies

- **D1 — HORS_CENTRE**: `docs/readme/12-…-p01.md` (centre section) says one path remains outside the centre (the
  *rallonge* of petty cash). Code: `petty-cash-top-up` is `AUTORISE` and `horsCentre()` documents "Il n'en reste
  aucune" (`finances/settlement.ts:124-158`) [V].
- **D2 — "Solde trésorerie = somme des comptes − paiements autorisés"** (p01 Finances table) vs the 05/10 note and the
  page: "Solde bancaire" = sum only, "Montant à régler" separate; `disponible` computed but unused [V].
- **D3 — `emitItemExpenseOrder`** still cited in `12-…-p03.md:1094` table and `13-…-p01.md:66`; removed per journal
  (`30-…-p01.md:453`) and absent from code [V].
- **D4 — Poste decision by "la Direction"** (p03 "Chaque poste se valide INDÉPENDAMMENT…") is outdated: two stages,
  Direction des opérations then Direction Marketing with mandatory budget (`validation-poste.ts`, §118.204) [V].
- **D5 — Creation notifications follow the old routing**: `notifyAdProCreation` (`sponsoring-actions.ts:288-298`)
  notifies `DIRECTION` for stage FINAL (rank 3 → decision is Direction Marketing) and `NATIONAL_SALES` ("à attribuer")
  for every non-PRELIMINARY, non-referent case — including ordinary requesters that never pass National Sales [V].
- **D6 — "Centre de paiement (Direction Générale)"**: `budget/depense-poste.ts:185-190` (`ROUTE_CONSOMMATION`,
  `PHRASE_ROUTE`) says the DG authorises; `authorization.ts:140` says the DG is **not** a seat (PDG = `DIRECTION`) [V].
- **D7 — Test-center state registry is stale** (`test-center/state-machines/registry.ts`): ExpenseOrder omits
  `PENDING→CANCELLED` and claims nothing produces CANCELLED (`annulation.ts` does); WorkflowInstance omits `RETURNED`
  and reopen transitions [V].
- **D8 — Named payment-centre seats are not notified** of new orders (`expense-orders.ts:311` notifies roles only);
  doc implies seats sit fully; seats appear only in reminders (`payments/relance-destinataires.ts:22`) [V].
- **D9 — BC threshold**: docs (§118.149 section) describe one `bcValidationThreshold`; code has a second
  `bcValidationThresholdCentre` for non-Ad & Pro BCs (`schema:9360`, `settings-actions.ts:124`) [V].
- **D10 — BC signature is "un clic"** in docs; code requires uploading a signed copy, a signer name, and a Luna check
  (`bc-signature-actions.ts:49-75`) [V].
- **D11 — `PaymentThreshold` model** ("seuil au-delà duquel la direction générale entre dans la chaîne") is unused [V].
- **D12 — `settleExpenseOrder` comment "rien ne produit CANCELLED"** echoes in registry; the schema comment on
  `REVISION_REQUESTED` is accurate (legacy) [V].

## 10. Verified vs uncertain (consolidated)

Verified [V] (read in code, cited above): centre rules & single writer; `decidePayment` guards and conditional
write; `settleExpenseOrder` sequence and non-conditional final write; `budgetGate` precedence; routing table and
lazy freezing; engine transitions incl. OPINION_AGAINST, RETURN, SKIP, auto-skip semantics; `emitFinancials`
pharmacist/postes branches; seed circuit and sponsoring pre-validation; two-stage poste decision; poste payment
paths; BC rule/etape/signature; Ad & Pro centre seat and FORME_PORTE; generic validation decision; payment-request
MOVES; treasury formula and its non-display; consumption and committed queries; threshold settings & setters;
`PAYMENT_PATHS` with no HORS_CENTRE; role labels (`DIRECTION` = "Direction des opérations").

Uncertain [U]: exact downstream of medical-info declaration → order (`validateDeclarationByDirection`, not read);
`reallouerCategorie` bound; `peutSignerBC` default role list; DB constraint `AdProItem_one_parent`; migration seed
behaviour; exploitability of G2/G10 under real load; exhaustive absence of an envelope-availability check; whether
`postes-chaine-flow.test.ts` covers the full chain end-to-end; content of §118.x texts in `docs/claude-md/`.
