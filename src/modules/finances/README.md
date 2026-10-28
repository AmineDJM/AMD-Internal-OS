# Module `finances` — ordres de dépense, centre de paiement, demandes de paiement, règlement, trésorerie

Tout l'argent qui sort (et qui entre) : un **ordre de dépense** naît d'un seul écrivain, en attente du **centre de
paiement** (PDG, DG, Super Admin, sièges nommés), qui autorise ou refuse ; les **Finances** paient ce qui est autorisé
(`canDisburse`), l'écriture de **trésorerie** se pose au règlement. Les **demandes de paiement** (`/validations/paiements`)
entrent au centre dès leur transmission. Une **remise de caisse d'avance** autorisée par le centre entre directement
dans la caisse (`verserLaRemise`, Direction 28/10/2026). Lit `referentiels` et `coffre` (`carte.ts`).
Ancien emplacement : `src/lib/{finance,finances,payments}/`, `src/lib/expense-orders.ts`, six lectures de
`src/lib/queries/` et sept fichiers d'actions — **fusionnés** ici (deux dossiers pour un même métier, c'était fini).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : autorisation du centre (`canDisburse`, `applyDecision`, `canResubmitAuCentre`, `ROLES_CENTRE_DE_PAIEMENT`), chemins de paiement, porte budgétaire (`budgetGate`), règlement, machine d'état des demandes, trésorerie, libellés |
| `api.ts` | **Porte serveur** : `createExpenseOrder` (l'unique écrivain), `reviserOrdreNonRegle`, `annulerOrdreNonRegle`, `verserLaRemise`, `syncInvoiceSettlement`, comptes ; les lectures des écrans (`chargerCentre`, `chargerOrdresDesFinances`, `getFinanceData`, `getComptaData`…) |
| `actions-*.ts` | `actions-depenses` (`expense-actions` : payer, reporter, purger), `actions-centre` (`payment-centre-actions` : décider), `actions-sieges` (`payment-centre-seat-actions`), `actions-demandes` (`payment-request-actions`), `actions-relances` (`relance-paiement-actions`), `actions-soldes` (`actualisation-soldes-actions`), `actions-tresorerie` (`finance-actions`) — chacun sous sa **clé historique** (`src/lib/actions/parc.ts`) |
| `domaine/` | `authorization` (le centre), `chemins-paiement` (ex-`finances/settlement` : `PAYMENT_PATHS`), `settlement` (UNPAID / DEFERRED / PAID), `settle-budget`, `payment-request`, `payment-dossier`, `correction-demande`, `dossier-auto`, `relance-paiement`, `montant-facture`, `money-entity`, `deadline-nature`, `sections-centre`, `reglement`, `tresorerie`, `virement-paie`, `payroll-cost`, `payroll-mass`, `actualisation-soldes`, `resultat-mensuel`, `ledger-audit`, `intelligence`, `invariants-argent` |
| `infra/` | `expense-orders`, `revision-ordre`, `annulation`, `verser-remise`, `settle-invoice`, `compagnon-regle`, `comptes`, `next-ref`, `facture-ordre`, `pieces-depense`, `a-imputer`, `relance-destinataires`, `paie-centre`, `demandes` (aides privées des actions de demande) |
| `infra/requetes/` | les lectures des écrans : `centre-paiement`, `paiements-a-faire`, `finance`, `compta`, `my-payment-requests`, `demande-paiement-suppression` |

- **Tables** : `ExpenseOrder`, `PaymentCentreSeat`, `PaymentCentreMessage`, `PaymentRequest`, `PaymentPiece`,
  `PaymentRequestEvent`, `FinanceTransaction`, `TreasuryAccount`, `PayrollWire`.
- **La paie VERSÉE** (décision du 28/10/2026 : les RH décident les salaires, les Finances les versent) :
  `infra/paie-centre` (`solderVirementPaie` au règlement, `instantDuCentreDePaie`, la masse salariale actualisée),
  `domaine/virement-paie` (mois de la paie, état d'un salaire et du virement), `domaine/payroll-cost` (coût
  employeur), `domaine/payroll-mass` (masse salariale) — venus de `src/modules/rh/`, qui les lit par nos portes
  (`rh → finances` ; ce module ne lit jamais `rh`, la carte reste sans cycle).
- **Règles tenues par des tests du module** : un seul écrivain d'ordre, qui le fait naître au centre ; liste FERMÉE des
  écrivains de l'autorisation, de `PAID` et du montant (`centre-ecrivains.test.ts`) ; écrivains de la trésorerie
  (`ecrivains-tresorerie.test.ts`) ; deux issues au centre (`centre-deux-issues.test.ts`).
- **Consommateurs** : tous les métiers qui émettent un ordre (Ad & Pro, RH/paie, Legal, Regulatory, moyens généraux,
  information médicale…) par `api.ts` ; les pages `/finances`, `/centre-de-paiement`, `/validations/paiements`.
- **Hors périmètre** : les budgets (`src/lib/budget*`, non migrés) ; les écrans restent dans `src/app/` et
  `src/components/finance/` (pas encore de dossier `ecrans/`).
- **Dette héritée** (nommée dans `frontieres.test.ts`, 53 arêtes) : notifications et numérotation, l'entité de
  l'argent (`company`, `entity-access`), les pièces, la garde des factures connues, et surtout la **clôture des
  chantiers d'origine au règlement** (sponsoring, matériel promo, BV) — à remplacer par un événement « ordre réglé ».

### Ce qui n'existe plus (et pourquoi) — ex-fin de `payment-request-actions.ts`

`askPaymentValidation` (faire valider le dossier) et `askPieceValidation` (faire valider une pièce) permettaient aux
Finances de demander une signature sur un paiement. Elles n'ont plus d'objet : depuis que le centre de paiement est le
GUICHET UNIQUE, un dossier n'atteint les Finances **que parce que le centre l'a autorisé**. Faire valider ce qui vient
d'être validé n'aboutit nulle part — et proposer un geste sans effet est pire que ne rien proposer. Supprimées à
l'écran, dans les ops d'Adam et dans les actions, ensemble : une action sans appelant réel n'existe pas (§118-14), et une
action que l'écran ne propose plus mais que l'assistant peut encore appeler est une porte dérobée (§118-7). Ce que les
Finances gardent sur un dossier : LIRE les pièces, et RÉCLAMER celles qui manquent (`ItemAskPanel`).
