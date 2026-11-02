# 03 — Audit « Argent » : ordres de dépense, centre de paiement, règlement, budgets, BC/factures, trésorerie

> Audit du 27/10/2026, branche `audit/argent-finances` (base `claude/hopeful-goodall-phd0nb` @ `456c8f6`).
> Périmètre : `src/lib/expense-orders.ts` et ses 21 appelants, `payments/*` (centre de paiement, révision, annulation),
> `actions/expense-actions.ts` (règlement, report, purge), `actions/finance-actions.ts` (livre), `PaymentRequest`,
> budgets/engagé/consommé (`budget/*`, `queries/budget-sources.ts`), BC et factures (`LegalDocument`, devis de prise
> en charge), trésorerie (`finance/tresorerie.ts`, `queries/finance.ts`).
> Méthode : carte `docs/knowledge-base/06-finance-budgets-approvals.md` (dettes G1–G12 connues) → lecture de chaque
> point d'émission d'un ordre et de chaque écrivain de `PAID` / du livre → reproduction sur Postgres local par les
> VRAIES actions serveur. Chaque constat ci-dessous a un chemin réel depuis un geste d'écran ; ceux qui sont corrigés
> ont un banc qui **échoue sur la base** et passe sur la branche (vérifié par `git stash` du correctif).

---

## 1. Synthèse

**Note du périmètre : 6,5 / 10.** Le cœur est d'un bon niveau, rare dans un ERP de cette taille : un **seul écrivain**
d'ordres (`createExpenseOrder`), un **seul écrivain** de `PAID` (`settleExpenseOrder`, désormais transactionnel et
conditionnel), un centre de paiement à deux issues avec écriture conditionnelle sur ce qui a été lu (montant,
bénéficiaire), des cliquets qui lisent le source, des règles pures testées. Mais la chaîne avait encore des trous qui
font **payer deux fois** ou **mentir le budget**, tous sur les bords : un geste d'administration, un émetteur oublié
par la doctrine des écritures conditionnelles, une requête d'écran bornée.

Les 3 risques majeurs (tous trois corrigés sur cette branche) :
1. **ARGENT-01 (CRITIQUE)** — « Vider l'historique » **supprimait** les ordres réglés : le poste payé redevenait
   « Engagé » (engagé fantôme) et pouvait être **consommé et payé une seconde fois**.
2. **ARGENT-02 (HAUTE)** — Accepter un devis de prise en charge à deux clics émettait **deux ordres** au centre.
3. **ARGENT-05 (HAUTE)** — L'écriture de trésorerie d'un ordre payé se **supprimait / se ré-chiffrait** librement :
   ordre « payé », trésorerie et consommation qui ne le comptent plus.

Reste ouvert (proposé, décision de Direction) : la **séparation des tâches** n'est garantie par aucun contrôle —
un même compte `DIRECTION` peut demander, autoriser et régler (ARGENT-06).

---

## 2. Constats

| ID | Sévérité | Catégorie | Constat | Effort | Statut |
|---|---|---|---|---|---|
| ARGENT-01 | CRITIQUE | Intégrité des données | La purge de l'historique supprime des ordres PAYÉS → engagé fantôme, re-consommation, double paiement | S | CORRIGÉ `66527ea` |
| ARGENT-02 | HAUTE | Correction (concurrence) | `decideCareQuote` : deux acceptations simultanées → deux ordres de dépense | S | CORRIGÉ `5225fe3` |
| ARGENT-03 | HAUTE | Correction | « Banque & paiements » ne lit que les 300 ordres les plus récents, tous états : un paiement autorisé ancien disparaît de la file | S | CORRIGÉ `ffc1564` |
| ARGENT-05 | HAUTE | Intégrité des données | L'écriture d'un règlement se supprime / change de montant, de sens ou de statut | S | CORRIGÉ `7e49470` |
| ARGENT-06 | HAUTE | Sécurité (séparation des tâches) | Un même compte peut demander, autoriser au centre et régler | M | APPLIQUÉ `990a6df` (réglage actif par défaut) — décision de Direction à confirmer |
| ARGENT-04 | MOYENNE | Correction (concurrence) | Le règlement n'épingle pas le montant lu : une révision à la baisse pendant le règlement inscrit l'ancien montant au livre | S | CORRIGÉ `082965b` |
| ARGENT-07 | MOYENNE | Intégrité (budget) | Un ordre REFUSÉ par le centre reste « engagé » / « en circuit » au budget | S | CORRIGÉ `833f498` |
| ARGENT-08 | MOYENNE | Sécurité (cloisonnement) | Les gestes d'argent (centre, règlement, livre) ne revérifient pas l'entité de l'ordre / de l'écriture | M | CORRIGÉ `9a1f97c` |
| ARGENT-09 | BASSE | Robustesse | L'écrivain unique `createExpenseOrder` n'impose ni montant fini > 0 ni arrondi au centime | S | PROPOSÉ |
| ARGENT-10 | BASSE | Maintenabilité | Anciennes décisions congrès hors circuit (`finalDecision`…) : exportées, mortes, écritures d'argent non conditionnelles | S | PROPOSÉ |

Livrable complémentaire (pas un constat) : **test d'invariant global** `src/lib/finance/invariants-argent.ts` +
`invariants-argent-flow.test.ts` — commit `cd817a5` (voir §2.11).

### ARGENT-01 — La purge de l'historique supprimait des ordres payés (CRITIQUE) — CORRIGÉ `66527ea`

- **Preuve** (base) : `src/lib/actions/expense-actions.ts:368-379`
  ```ts
  where: { status: { in: ["PAID", "CANCELLED"] } }  …
  await prisma.expenseOrder.deleteMany({ where: { id: { in: cibles.map((o) => o.id) } } });
  ```
  Or l'ordre PAYÉ est le fait que lisent : `depenseDuPoste` (`src/lib/budget/depense-poste.ts:146-163` — sans ordre
  vivant, un poste imputé retombe en `ENGAGEE` avec `engage = montantEngage`), `consommerDepensePoste` (prise
  conditionnelle sur l'état `ENGAGEE`), `requestBV` (`regulatory-actions.ts:1184` — « un BV de cette nature à la
  fois » lit les ordres existants), la paie (`payrollWire.expenseOrder`), la caisse, le fil du centre (cascade).
- **Scénario** : un poste Ad & Pro de 80 000 DZD est payé. Fin de mois, le Super Admin clique « Vider l'historique »
  (bouton de `/finances/paiements-a-faire`). Le Budget Marketing affiche de nouveau 80 000 « engagés » sur la catégorie
  (consommé + engagé = double comptage), le poste réapparaît « Engagée » avec son bouton « Consommer » ; le chef de
  produit le consomme → un second ordre de 80 000 part au centre, qui voit un ordre ordinaire. Même mécanique pour un
  BV ANPP déjà payé (redemandable).
- **Correctif appliqué** : colonne additive `ExpenseOrder.historiqueMasqueLe` (migration
  `20270131160000_ordre_historique_masque`, idempotente) ; la purge **masque** (`updateMany`), seul l'historique de
  l'écran lit le masque (`chargerOrdresDesFinances`). Banc `src/lib/actions/purge-historique-flow.test.ts` (témoin pur
  de l'engagé fantôme + banc DB : échoue sur la base, passe sur la branche).

### ARGENT-02 — Un devis de prise en charge émettait deux ordres à deux clics (HAUTE) — CORRIGÉ `5225fe3`

- **Preuve** (base) : `src/lib/actions/care-actions.ts:1003` lit `if (quote.expenseOrderId) return …`, puis `:1048`
  `createExpenseOrder(...)`, puis `:1062` `careQuote.update({ where: { id } … expenseOrderId: order.id })` — aucune
  écriture conditionnelle entre la lecture et l'émission (§118.151 non appliqué à cet émetteur).
- **Scénario** : la Direction accepte un devis d'hôtel de 120 000 DZD ; latence, second clic (ou deux directeurs sur
  la même fiche). Les deux appels passent la garde ; deux ordres `CONGRESS_INTERNATIONAL` de 120 000 naissent au
  centre ; le devis ne pointe que le second, le premier reste payable sans lien. Reproduit : `[{"ok":true…},{"ok":true…}]`,
  2 ordres.
- **Correctif appliqué** : réserve conditionnelle du devis (`updateMany` sur `expenseOrderId: null`, statut et date de
  décision lus) avant toute émission ; réserve rendue si l'ordre n'est pas né ; conservée s'il est né mais non rattaché
  (re-accepter émettrait un second ordre). Banc `src/lib/actions/care-devis-double-clic-flow.test.ts` (deux appels
  `Promise.all`, 1 ordre attendu).

### ARGENT-03 — La file « à régler » était tronquée aux 300 derniers ordres (HAUTE) — CORRIGÉ `ffc1564`

- **Preuve** (base) : `src/app/(app)/finances/paiements-a-faire/page.tsx:82-87`
  ```ts
  prisma.expenseOrder.findMany({ where: …, orderBy: { createdAt: "desc" }, take: 300 })
    .filter((o) => visibleToFinance(o.centralStatus))
  ```
  La fenêtre porte sur **tous** les états (ordres encore au centre, réglés, annulés) ; le filtre vient après.
- **Scénario** : en régime de croisière (13 circuits émetteurs, ordres jamais supprimés depuis ARGENT-01), un ordre
  autorisé le 1er du mois puis reporté est dépassé par 300 ordres plus récents : il sort de « à régler » (ni ligne, ni
  total, ni bouton Régler, focus des notifications cassé) alors que la trésorerie (`chargerTresorerie`, sans borne) le
  compte encore dans « Montant à régler ». Le paiement le plus en retard est celui qu'on ne voit plus.
- **Correctif appliqué** : `src/lib/queries/paiements-a-faire.ts` — file ouverte sans borne, historique seul borné,
  filtre `visibleToFinance` en base. Banc `paiements-a-faire-flow.test.ts` avec témoin de l'ancienne fenêtre.

### ARGENT-04 — Le règlement n'épinglait pas le montant lu (MOYENNE) — CORRIGÉ `082965b`

- **Preuve** (base) : `expense-actions.ts:219` `where: { id, status: "PENDING", centralStatus: order.centralStatus }` ;
  `amount: order.amount` (lu en tête) est écrit au livre. Or `statutApresNouveauMontant`
  (`payments/authorization.ts:254-262`) **garde** `APPROVED` sur une baisse.
- **Scénario** : la facture définitive arrive à 80 000 au lieu de 100 000 ; le demandeur corrige sa demande
  (`reviserOrdreNonRegle`) pendant que le comptable règle (dépôt de quittance, lecture budgétaire : plusieurs
  secondes). Le livre reçoit 100 000, l'ordre dit 80 000 ; trésorerie et consommation faussées de 20 000.
- **Correctif appliqué** : `amount` et `beneficiary` lus dans la condition de la réserve. Banc
  `reglement-revision-flow.test.ts` à entrelacement **déterministe** (révision injectée pendant `compteDeLEcriture`).

### ARGENT-05 — L'écriture d'un règlement se supprimait ou changeait de montant (HAUTE) — CORRIGÉ `7e49470`

- **Preuve** (base) : `src/lib/actions/finance-actions.ts:148` `financeTransaction.delete({ where: { id } })`,
  `:99` `updateTransaction` (montant, sens, statut libres), `:79` `updateTransactionStatus` — aucune lecture de
  `ExpenseOrder.transactionId`. Dette G7 de la base de connaissances, documentée mais ouverte.
- **Scénario** : un comptable « nettoie » le livre (doublon apparent avec un relevé importé) et supprime l'écriture
  d'un règlement : l'ordre reste PAYÉ, la trésorerie remonte de la somme, la catégorie budgétaire n'est plus
  consommée — et rien sur l'ordre ne le dit. Même chose en ramenant le montant ou en passant le statut à `CANCELLED`.
- **Correctif appliqué** : `reglementPorte(id)` ; suppression, changement de montant/sens/statut refusés sur une
  écriture de règlement, avec renvoi à une contre-passation ; libellé, date, compte, notes restent modifiables. Banc
  `ecriture-reglement-flow.test.ts` (témoin : une écriture libre se corrige et se supprime).

### ARGENT-06 — Aucune séparation des tâches n'est contrôlée (HAUTE) — APPLIQUÉ `990a6df`, décision de Direction à confirmer

- **Preuve** : `decidePayment` (`payment-centre-actions.ts:104-133`) lit `requestedById` mais ne le compare pas à
  l'acteur ; `settleExpenseOrder` (`expense-actions.ts:71-73`) ne lit ni `requestedById` ni `centralDecidedById` ;
  `DIRECTION` et `GENERAL_MANAGER` siègent au centre (`ROLES_CENTRE_DE_PAIEMENT`, `authorization.ts:174`) **et** ont
  `FINANCES: MANAGE` (`rbac.ts:265`, `:299`) ; `SUPER_ADMIN` a tout. Le banc d'invariant (`invariants-argent-flow`)
  montre la chaîne émission → autorisation → règlement passée par trois rôles… qu'un seul compte `DIRECTION` peut tenir.
- **Scénario** : un directeur dépose une demande de paiement à un bénéficiaire de son choix (`payment-request-actions`),
  l'autorise au centre, puis la règle depuis « Banque & paiements ». Trois gestes, une personne, et l'audit dit
  seulement que c'est permis.
- **Correctif proposé** (module pur + deux gardes) :
  ```ts
  // src/lib/payments/separation.ts — PUR
  export function refusSeparation(geste: "AUTORISER" | "REGLER", o: { requestedById: string | null; centralDecidedById: string | null }, acteurId: string, siegesActifs: number): string | null {
    if (geste === "AUTORISER" && o.requestedById === acteurId && siegesActifs > 1) return "Vous avez demandé ce paiement : un autre siège du centre l'autorise.";
    if (geste === "REGLER" && (o.centralDecidedById === acteurId || o.requestedById === acteurId)) return "Celui qui demande ou autorise un paiement ne le règle pas : un comptable le règle.";
    return null;
  }
  ```
  appelé dans `decidePayment` et `settleExpenseOrder` ; exception explicite et auditée quand un seul siège est actif.
  Décision Direction requise (PDG seul siège ?) — c'est pourquoi il n'est pas appliqué ici.

### ARGENT-07 — Un ordre refusé par le centre reste « engagé » (MOYENNE) — CORRIGÉ `833f498`

- **Preuve** : `STATUTS_ORDRE_ENGAGES = ["PENDING", "REVISION_REQUESTED"]` (`budget/engage.ts`) et
  `STATUTS_EN_CIRCUIT` (`budget/depense-poste.ts:60`) ne lisent que `status` ; un refus du centre laisse
  `status = PENDING` (`applyDecision`). `engagementsBruts` (`queries/budget-sources.ts:220-221`) le compte. Or
  `ordreClos` (`finances/settlement.ts:277`) dit déjà qu'un ordre refusé « ne paiera jamais ». Dette G5 connue.
- **Scénario** : un ordre de 300 000 est refusé « hors budget » ; il reste 300 000 « engagés » sur la catégorie
  jusqu'à ce que quelqu'un annule la source — l'enveloppe paraît pleine et bloque les arbitrages.
- **Correctif proposé** : `ordreEngage(statut, centralStatus)` = engagé ssi `!ordreClos(...)` ; filtre
  `centralStatus: { not: "REFUSED" }` dans les deux requêtes de `budget-sources.ts` ; `depenseDuPoste` traite un
  ordre refusé comme `vivants` mais hors `attente`. Un test-cliquet : tout prédicat d'engagement passe par `ordreClos`.

### ARGENT-08 — Les gestes d'argent ne revérifient pas l'entité (MOYENNE) — CORRIGÉ `9a1f97c`

- **Preuve** : `decidePayment`, `settleExpenseOrder`, `deferExpenseOrder`, `updateTransaction`, `deleteTransaction`
  lisent l'objet par son seul `id` ; seul l'écran est filtré (`chargerCentre` → `ficheScopedWhere`,
  `companyScopedWhere` dans la page). Dette G4 (centre) étendue au règlement et au livre.
- **Scénario** : un comptable cloisonné sur Pharmagène reçoit (lien partagé, Adam, appel direct de l'action) l'id d'un
  ordre Adventum autorisé : il le règle, ou modifie une écriture d'Adventum.
- **Correctif proposé** : un garde unique `refusHorsEntite(user, companyId)` (lit `getMyCompanies`) appelé en tête de
  chaque geste d'argent ; cliquet source « tout `"use server"` qui écrit `expenseOrder`/`financeTransaction` appelle
  ce garde ».

### ARGENT-09 — L'écrivain unique n'impose pas un montant valide (BASSE) — PROPOSÉ

- **Preuve** : `createExpenseOrder` (`expense-orders.ts:269-287`) écrit `amount: input.amount` sans contrôle ; chaque
  appelant valide à sa façon (`requestBV` : `Number.isFinite && > 0`, congrès : `> 0`, d'autres : `toNumber(...)`).
  Postgres arrondit silencieusement à 2 décimales ; un `NaN` lève tard.
- **Correctif proposé** : en tête de `createExpenseOrder`, `montantDOrdre(input.amount)` (pur : fini, > 0, arrondi au
  centime, refus explicite) — défense en profondeur au seul point par lequel tout ordre passe.

### ARGENT-10 — Anciennes décisions congrès hors circuit, mortes mais exportées (BASSE) — PROPOSÉ

- **Preuve** : `congress-request-actions.ts:335` `finalDecision` lit `requestStatus`, émet un ordre puis écrit par id
  (`updateCongress`) — non conditionnel ; le registre (`action-registry.ts:1090`) les déclare « aucun écran ne les
  propose », et le composant `FinalDecision` de `congress-international/congress-workflow.tsx` n'est importé nulle part.
  Non joignable aujourd'hui (aucun client ne les référence, donc pas d'identifiant d'action), mais un ré-import les
  rouvrirait avec leurs écritures non conditionnelles.
- **Correctif proposé** : supprimer `preliminaryDecision`, `submitProductAnalysis`, `finalDecision`,
  `updateGrantedBudget` et le composant mort ; garder la classification `X(...)` le temps d'un cycle.

### 2.11 Test d'invariant global (livrable) — `cd817a5`

`src/lib/finance/invariants-argent.ts` (pur) pose six règles : un ordre PAYÉ pointe une écriture existante, sortante,
réglée, de même montant au centime, qui ne règle que lui ; un ordre non payé n'en pointe aucune ;
`totauxReglements` → Σ ordres réglés = Σ écritures. Le banc `invariants-argent-flow.test.ts` parcourt la chaîne
**réelle** (5 ordres à centimes, 4 autorisés + 1 refusé, double clic simultané au règlement) puis vérifie l'invariant
sur la base. Le module peut tourner en lecture seule sur une copie de production (voir §4).

---

## 3. À vérifier (soupçons non établis)

- **Verrous en mémoire** : `enSerie` (`src/lib/refs.ts:68`) sérialise par processus. `sendLegalInvoiceToSettlement`
  et le dossier promo en dépendent pour « un envoi à la fois par facture ». Render tourne aujourd'hui sur une instance
  (`render.yaml`, `plan: free`) : sûr ; **faux dès la 2ᵉ instance**. À remplacer par `pg_advisory_xact_lock`, comme
  `requestBV`.
- **Refus vs acceptation d'un devis simultanés** (`decideCareQuote`, branche REJECT écrite par id) : l'état final
  observé reste cohérent (l'acceptation réécrit), mais les cases peuvent repasser « demandées » sous un devis accepté.
  Non reproduit.
- **Chemins `ENREGISTRE`** (`finances/settlement.ts:106-133`) : une écriture OUT saisie à la main ou une facture
  « marquée réglée » n'est pas un paiement au sens du centre, par conception. Aucun seuil ni justificatif n'est exigé
  au-delà du journal d'audit : à arbitrer avec la Direction.
- **Totaux en `number`** : la page « Banque & paiements » somme `toNumber(o.amount)` en flottant ; sans effet
  d'affichage mesuré (arrondi `fr-FR`), mais aucun total d'argent ne devrait s'additionner hors centimes.

---

## 4. Restructuration proposée

**Cible : un domaine `argent` à trois couches, une seule porte par geste, l'idempotence en base.**

```
src/lib/argent/
  montant.ts            PUR — type Montant (centimes entiers), lire/arrondir/additionner/formater DZD ; USD×taux figé
  invariants.ts         PUR — (ex finance/invariants-argent.ts) + règles d'engagement (ordreClos, ordreEngage)
  separation.ts         PUR — refusSeparation (ARGENT-06)
  ordres/
    emettre.ts          emettreOrdre({ source, cle, montant, … }) — SEUL appel de prisma.expenseOrder.create
    autoriser.ts        decider (ex decidePayment, garde entité + séparation)
    regler.ts           regler (ex settleExpenseOrder) — la transaction PENDING→PAID + écriture
    reviser.ts / annuler.ts   (ex payments/revision-ordre.ts, annulation.ts)
  livre/
    ecritures.ts        créer/corriger/contre-passer ; jamais supprimer une écriture de règlement
  lectures/
    file-finances.ts    (ex queries/paiements-a-faire.ts) ; centre.ts ; tresorerie.ts
src/lib/actions/argent-*.ts   actions "use server" minces : session → garde → appel du domaine → revalidate
```

**Le contrat central — l'idempotence d'émission en base** (supprime la classe ARGENT-02 pour tous les circuits) :

```ts
// prisma : ExpenseOrder.cleEmission String? @unique   (migration additive, nullable)
export async function emettreOrdre(input: { cle: string; /* "CARE_QUOTE:<id>", "AD_PRO_ITEM:<id>:<n>" */ } & CreateExpenseOrderInput) {
  try { return await createExpenseOrder({ ...input, cleEmission: input.cle }); }
  catch (e) { if (estViolationUnicite(e, "cleEmission")) return prisma.expenseOrder.findUniqueOrThrow({ where: { cleEmission: input.cle } }); throw e; }
}
```

**Migration par petites étapes sûres :**
1. Ajouter `cleEmission` nullable unique (aucun impact). 2. `emettreOrdre` délègue à `createExpenseOrder` ; migrer
les 21 appelants un par un (un commit chacun, banc double clic par circuit). 3. Cliquet : `createExpenseOrder(` n'est
plus appelé hors `argent/ordres/emettre.ts`. 4. Déplacer `settleExpenseOrder` / `decidePayment` derrière le domaine
(les actions deviennent des adaptateurs de 20 lignes). 5. Introduire `Montant` en centimes aux frontières (lecture
Decimal → centimes, écriture centimes → Decimal), puis à l'intérieur. 6. Brancher `violationsArgent` dans
`quality/rules.ts` (constat quotidien) et dans un script `scripts/verifier-argent.ts` lecture seule.

**Gains** : la double émission devient impossible par construction (et non par la vigilance de chaque auteur de
circuit — 21 points d'appel, 4 370 lignes dans `ad-pro-item-actions.ts`) ; un seul fichier à lire pour comprendre
« comment l'argent sort » ; la séparation des tâches et le cloisonnement à un seul endroit ; des montants exacts.

---

## 5. Bonnes pratiques à graver

1. **Cliquet « émetteur conditionnel »** : tout fichier qui appelle `createExpenseOrder(` doit, dans la même
   fonction, faire une prise conditionnelle (`updateMany` + `count === 0`), un verrou `pg_advisory_xact_lock`, ou
   passer une `cle` d'émission. Test source (même style que `refs-filet.test.ts`).
2. **Jamais supprimer un fait d'argent** : cliquet interdisant `expenseOrder.delete`/`deleteMany` et
   `financeTransaction.delete` hors tests et hors gardes nommées (`reglementPorte`). Un masque ou une contre-passation,
   jamais un effacement.
3. **Une file d'action n'a pas de `take:`** : une liste de travail (à régler, à autoriser, à signer) se lit entière ;
   seul un historique se borne. Règle de revue + cliquet sur les `page.tsx` des files.
4. **Toute écriture conditionnelle porte ce qui est écrit ailleurs** : si l'action recopie `amount`/`beneficiary`
   lus dans une autre table, ils sont dans le `where` (ARGENT-04).
5. **Invariant global en CI et en production** : `invariants-argent-flow.test.ts` reste vert ; `violationsArgent`
   tourne chaque nuit sur la base (règle qualité) — Σ ordres réglés = Σ écritures.
6. **Chaque geste d'argent revérifie l'entité et la séparation des tâches côté serveur**, jamais par l'écran seul.
7. **Banc à deux clics** pour tout nouveau geste qui fait naître de l'argent (`Promise.all` de deux appels, un seul
   effet attendu) — le modèle : `care-devis-double-clic-flow.test.ts`.

---

## 6. Vérifications faites sur la branche

- `tsc --noEmit` : vert. `next lint` sur chaque fichier touché : vert. `npm run actions:contrat` : régénéré
  (`purgeSettledExpenseOrders` n'écrit plus `paymentRequest`).
- `npm test` (Postgres local, 1 273 fichiers) : 14 725 tests verts, 3 rouges, tous hors périmètre — les deux échecs
  préexistants connus (`platform/boundary.test.ts` 430 > 425, `platform/domains.test.ts` 71 > 68) et
  `platform/in-process/missions/sorties-declarees.test.ts`, qui dépend de l'environnement (compte Google d'Adam non
  connecté dans le conteneur).
- Chaque banc de correctif a été rejoué avec le correctif retiré (`git stash`) : il échoue sur la base.
