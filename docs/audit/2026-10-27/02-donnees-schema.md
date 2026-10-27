# 02 — Données, schéma Prisma et migrations

> Audit du 27/10/2026, branche `audit/donnees-schema`, base `claude/hopeful-goodall-phd0nb`.
> Mesures prises sur une base Postgres 16 **locale** (`amd_internal_os`), migrée de zéro par `prisma migrate deploy`
> (toutes les migrations s'appliquent en 4,5 s), et sur le DMMF du client généré (440 modèles).
> Rien n'a été lu ni écrit sur une base distante.

## 1. Synthèse

**Note du périmètre : 6,5 / 10.** Le socle est meilleur que la moyenne d'un ERP de cette taille : l'argent est en
`Decimal` partout (aucun montant en `Float`, vérifié par le DMMF), les migrations sont additives et idempotentes depuis
juillet 2026, la numérotation officielle est atomique, et une bonne partie des courses « lire puis écrire » est déjà
fermée par le patron §118.151. Ce qui coûte des points, c'est ce que le patron n'a **pas encore atteint**, et des clés
étrangères en cascade posées sans regarder ce qu'elles effaçaient.

Les trois risques majeurs :

1. **Des cascades effacent de l'argent et de l'historique sans corbeille.** Supprimer une catégorie ou une enveloppe
   budgétaire effaçait les dépenses saisies dessous (DONNEES-01, **corrigé**). Supprimer un médecin efface ses visites,
   ses montants attribués Ad & Pro et ses fiches de segmentation, y compris quand le geste vient de l'assistant (DONNEES-07).
2. **Des doubles clics produisent encore deux mouvements d'argent.** Mesurés et reproduits : deux ordres de dépense
   pour une facture, deux écritures de trésorerie, un solde de congés débité deux fois, une caisse d'avance en négatif
   (DONNEES-02 à 04 et 06, **corrigés**). Il reste au moins deux chemins du même type (DONNEES-08, DONNEES-09).
3. **Des lectures sans borne sur des tables qui grandissent sans fin.** Le livre comptable entier est chargé à chaque
   affichage, de même que tous les ordres du centre de paiement et les références d'une année entière à chaque création
   (DONNEES-11 à 13).

Six correctifs sont commités, un par constat. Chacun a un test qui échoue avant et passe après.

## 2. Constats

| ID | Sévérité | Catégorie | Constat | Effort | Statut |
|---|---|---|---|---|---|
| DONNEES-01 | HAUTE | Intégrité des données | Supprimer une catégorie ou une enveloppe efface en cascade les dépenses budgétaires | S | **CORRIGÉ** `08558da` |
| DONNEES-02 | HAUTE | Correction (argent) | Un double clic sur « Transmettre » ouvre deux ordres de dépense | S | **CORRIGÉ** `7eb43c6` |
| DONNEES-03 | HAUTE | Correction (argent) | Une facture marquée payée deux fois écrit deux sorties au livre | S | **CORRIGÉ** `aa2ab2b` |
| DONNEES-04 | HAUTE | Correction (RH) | Un congé annuel accordé à deux clics débite le solde deux fois | S | **CORRIGÉ** `0af0031` |
| DONNEES-05 | HAUTE | Correction (argent) | Une facture annulée part au paiement depuis la fiche Legal | S | **CORRIGÉ** `0b75a9f` |
| DONNEES-06 | HAUTE | Correction (argent) | La seconde porte de la caisse d'avance la met en négatif | S | **CORRIGÉ** `06376e7` |
| DONNEES-07 | HAUTE | Intégrité des données | `deleteDoctor` efface visites, montants et segmentation sans corbeille (accessible à Adam) | M | PROPOSÉ |
| DONNEES-08 | HAUTE | Correction (argent) | Accepter un devis de prise en charge à deux clics ouvre deux ordres | S | PROPOSÉ |
| DONNEES-09 | MOYENNE | Correction (argent) | La réponse au centre de paiement écrase une décision concurrente | S | PROPOSÉ |
| DONNEES-10 | MOYENNE | Intégrité des données | `ExpenseOrder (sourceType, sourceId)` n'a aucune unicité, même partielle | M | PROPOSÉ |
| DONNEES-11 | MOYENNE | Performance | Le livre comptable et le centre de paiement chargent toute l'histoire à chaque affichage | M | PROPOSÉ |
| DONNEES-12 | MOYENNE | Performance | Chaque création charge toutes les références de l'année pour calculer la suivante | S | PROPOSÉ |
| DONNEES-13 | MOYENNE | Performance | Droits sur les documents en listes `IN` de milliers d'ids, import de consommation sur toute l'histoire | M | PROPOSÉ |
| DONNEES-14 | MOYENNE | Performance | N+1 sur les panels de segmentation et le calcul des KPI pendant le rendu | M | PROPOSÉ |
| DONNEES-15 | MOYENNE | Intégrité des données | `deleteOrder` (PCH) efface livraisons et lignes sans audit ni corbeille | S | PROPOSÉ |
| DONNEES-16 | MOYENNE | Maintenabilité | Les migrations des branches `refonte/*` sont datées avant le maximum de la base | S | PROPOSÉ |
| DONNEES-17 | BASSE | Intégrité des données | Cycles de réserves ANPP numérotés par `count()+1` sans unicité | S | PROPOSÉ |
| DONNEES-18 | BASSE | Intégrité des données | `MissionInput.milestoneId` : relation au schéma, aucune clé étrangère en base | S | PROPOSÉ |
| DONNEES-19 | BASSE | Performance | 87 clés étrangères sans index en tête, dont `FileVersion.blobId` (RESTRICT) | S | PROPOSÉ |
| DONNEES-20 | BASSE | Maintenabilité | `schema.prisma` n'est pas au format `prisma format` (355 lignes), d'où des diffs parasites | S | PROPOSÉ |

---

### DONNEES-01 — Supprimer une catégorie ou une enveloppe effaçait les dépenses budgétaires · HAUTE · CORRIGÉ `08558da`

- **Preuve.**
  - `prisma/schema.prisma:3765` : `category BudgetCategoryLine @relation(..., onDelete: Cascade)` sur
    `BudgetExpenseLine`.
  - `:3176` et `:3182` : `envelopeId` et `parentId` des catégories sont aussi en `Cascade`.
  - L'ancien `deleteBudgetCategory` (`src/lib/actions/budget-envelope-actions.ts`) commentait « Les dépenses attribuées
    repassent en « non attribué » (FK SetNull) ». C'est vrai pour `FinanceTransaction`, faux pour `BudgetExpenseLine`.
  - L'écran le promettait aussi (`src/app/(app)/budgets/budget-settings.tsx:83`, `enveloppe-marketing-forms.tsx:158`).
  - Une enveloppe portant un `AdProIntegrationLot` (FK `Restrict`) levait une exception non rattrapée, et
    `budget-forms.tsx:368` fermait la fenêtre comme si la suppression avait réussi.
- **Scénario réel.** Un gestionnaire délégué d'enveloppe supprime la catégorie de tête « Regulatory BV » pour la
  réorganiser. Les BV saisis « payé le » (`budget-pole-actions.ts:259`), les frais de mission
  (`mission-actions.ts:639`) et les saisies manuelles des sous-catégories disparaissent de la consommation de l'année.
  Il n'y a ni corbeille ni audit de ces lignes, et l'écran avait annoncé l'inverse.
- **Correctif appliqué.** Nouveau module `src/lib/budget/suppression-garde.ts`, utilisé par `deleteBudgetCategory`,
  `deleteEnvelope` et `deletePoleEnvelope` :
  1. il calcule le sous-arbre de catégories et le verrouille (`FOR UPDATE`) ;
  2. il compte les dépenses et les lots ; s'il y en a, il refuse en donnant leur nombre ;
  3. sinon il supprime, dans la même transaction.

  Une dépense ajoutée au même instant attend le verrou : sa clé étrangère prend un `FOR KEY SHARE` sur la catégorie.
  L'écran affiche maintenant le refus, et les textes de confirmation disent la vérité.
- **Test.** `src/lib/actions/budget-suppression-garde.test.ts` (3 cas). Avant le correctif : 3 échecs (la dépense est
  effacée). Après : vert.

### DONNEES-02 — « Transmettre » à deux clics ouvrait deux ordres de dépense · HAUTE · CORRIGÉ `7eb43c6`

- **Preuve.** Dans `submitPaymentRequest` (`src/lib/actions/payment-request-actions.ts`) :
  - le statut et `expenseOrderId` sont lus ligne 827 ;
  - suivent deux lectures (`ttcDesFacturesEnVigueur`, `paymentRequestEvent.count`) ;
  - puis `paymentRequest.update({ where: { id } })` par le seul id, et `createExpenseOrder` si `!req.expenseOrderId`
    **à la lecture**.

  Le chemin voisin (`decidePaymentRequest`, ligne ~952) avait déjà reçu la réservation conditionnelle ; celui-ci non.
- **Scénario réel.** Un délégué double-clique sur « Transmettre ». Deux ordres arrivent au centre de paiement pour une
  facture. Le second écrase `expenseOrderId`, et le premier reste orphelin, autorisable et payable.
  **Mesuré : 2 ordres.**
- **Correctif appliqué.** `updateMany({ where: { id, status: <lu>, expenseOrderId: <lu> } })`. Si le compte vaut 0, on
  s'arrête avant de créer l'ordre (ligne 852).
- **Test.** `src/lib/actions/payment-submit-double-clic.test.ts` : 2 ordres avant, 1 après. Les 58 tests des trois flux
  de paiement existants restent verts.

### DONNEES-03 — Une facture marquée payée deux fois écrivait deux sorties d'argent · HAUTE · CORRIGÉ `aa2ab2b`

- **Preuve.** `syncInvoiceSettlement` (`src/lib/finance/settle-invoice.ts`) est appelé par `setInvoicePaid`,
  `updateInvoice` et `updateLegalDocument`. Il lisait `settlementTxId`, puis faisait `financeTransaction.create`, puis
  `legalDocument.update({ where: { id } })`, sans transaction ni condition.
- **Scénario réel.** Deux comptables, ou deux onglets, marquent la même facture payée. Deux écritures `SETTLED` entrent
  au livre ; la première est orpheline mais comptée dans le solde du compte de trésorerie. Quand les deux gestes tombent
  à la même milliseconde, ils se disputent aussi la référence `FIN-…`, et le second reçoit une erreur P2002 au lieu
  d'un « déjà fait ». **Mesuré : 2 écritures.**
- **Correctif appliqué.** L'écriture et le lien naissent dans une transaction. Le lien ne se pose que si
  `settlementTxId IS NULL` (ligne 122) ; sinon la transaction s'annule. Une collision P2002 dont l'autre geste a gagné
  est traitée comme « déjà réglée ».
- **Test.** `src/lib/finance/settle-invoice-double.test.ts` (4 appels décalés de 0 à 10 ms) : 2 écritures avant, 1
  après, stable sur 3 passages. Le cliquet `ecrivains-tresorerie.test.ts` reste vert.

### DONNEES-04 — Un congé annuel accordé à deux clics débitait le solde deux fois · HAUTE · CORRIGÉ `0af0031`

- **Preuve.** `applyAnnualLeaveBalance` (`src/lib/actions/hr-document-actions.ts:64`) suivait cet ordre :
  1. `if (req.balanceAppliedAt) return 0`, évalué en JS sur la lecture ;
  2. `employee.update({ decrement })` ;
  3. **puis** `update({ balanceAppliedAt })`.

  L'appelant `decideHrLeave` ne vérifie même pas le statut.
- **Scénario réel.** La RH double-clique sur « Accorder » pour un congé de 10 jours. Le salarié perd 20 jours.
  **Mesuré : solde 30 → 10.**
- **Correctif appliqué.** Le verrou se prend d'abord (`updateMany` où `balanceAppliedAt` est nul), puis le débit suit
  dans la même transaction. Cela couvre aussi `processHrRequest`.
- **Test.** `src/lib/actions/hr-conge-double-debit.test.ts`.
- **Reste à faire (PROPOSÉ).** `decideHrLeave` peut encore re-décider une demande déjà refusée. Ajouter
  `status: "PENDING"` (ou le statut lu) à la condition de l'écriture du statut.

### DONNEES-05 — Une facture annulée partait au paiement depuis la fiche Legal · HAUTE · CORRIGÉ `0b75a9f`

- **Preuve.** `sendLegalInvoiceToSettlement` (`src/lib/actions/legal-actions.ts:890`) ne sélectionnait pas `status`, et
  la règle pure `canSendToSettlement` (`src/lib/finances/settlement.ts:226`) ne le connaissait pas. Le dossier
  promotionnel excluait déjà `CANCELLED` à la lecture (`promo-execution-actions.ts:933`) ; la fiche Legal, non.
- **Scénario réel.** Un juriste annule une facture contestée. Un comptable, sur l'écran resté ouvert, l'envoie au
  règlement, et un ordre de dépense payable naît d'une pièce annulée.
- **Correctif appliqué.** `canSendToSettlement` reçoit `status` et refuse `CANCELLED`. La fiche Legal le lui passe
  (ligne 913).
- **Test.** Nouveau cas dans `src/lib/finances/settlement.test.ts` (rouge avant, vert après).
- **Reste (PROPOSÉ).** La course entre l'annulation et l'envoi : `cancelLegalDocument`, à la ligne 725, écrit le statut
  sans prendre la clé `enSerie(cleEnvoiAuReglement(id))`. Prendre la même clé, ou conditionner l'écriture sur
  `expenseOrderId` lu.

### DONNEES-06 — La seconde porte de la caisse d'avance la mettait en négatif · HAUTE · CORRIGÉ `06376e7`

- **Preuve.** `addDepartmentExpense` (`src/lib/actions/department-budget-actions.ts:422-439`) faisait `cashOf()` puis
  `canSpendFromFund()` hors transaction, puis `departmentBudgetExpense.create`. C'est exactement le défaut corrigé dans
  `spendFromPettyCash` (`petty-cash-actions.ts:331`, verrou `FOR UPDATE`), resté ouvert par l'option
  `paymentSource=CASH`.
- **Scénario réel.** Il reste 40 000 DZD en caisse. Deux saisies de 30 000 « payées sur la caisse » passent toutes deux,
  et la caisse finit à −20 000. **Mesuré.**
- **Correctif appliqué.** Même remède que la première porte : département `FOR UPDATE`, fond relu dessous, écriture
  dans la même transaction (ligne 439).
- **Test.** Cas (a′) ajouté à `src/lib/actions/caisse-avance-atomique-flow.test.ts` (rouge avant, vert après).
- **Reste (PROPOSÉ).** Même défaut à corriger dans `updateDepartmentExpense` (lignes 573-606, passage d'une dépense vers
  la caisse) et `closePettyCash` (`petty-cash-actions.ts:232-244` : clôture sans verrou ni condition de statut ;
  `confirmPettyCashReceipt:205` peut ensuite réécrire `RECEIVED` sur une remise clôturée).

### DONNEES-07 — `deleteDoctor` efface visites, montants et segmentation sans corbeille · HAUTE · PROPOSÉ

- **Preuve.**
  - `src/lib/actions/medical-actions.ts:490-498` : `medicalVisit.deleteMany({ where: { doctorId } })` puis
    `medicalDoctor.delete`.
  - Les cascades du schéma emportent `AdProMedecin` (avec son `montant Decimal(14,2)`, `schema.prisma:16761`),
    `SegmentationFiche`, `HcpObservation`, `SegmentationDerogation` et `DirectoryCellStyle`.
  - L'action est exposée à l'assistant (`src/lib/assistant/ops/impl-wave4b.ts:430`).
  - Le type de suppression `DOCTOR` du registre de corbeille (`admin-delete-registry.ts:376`) n'est pas `lot: true` :
    même par la corbeille, les lignes en cascade ne sont pas sauvegardées.
  - Le modèle a déjà `archivedAt` (« archive, pas suppression », KB 03 §4.2).
- **Scénario réel.** Un délégué qui a le droit MEDICAL:DELETE, ou Adam sur sa demande, supprime un doublon de médecin.
  Trois ans de visites, l'attribution des montants Ad & Pro à ce praticien et son historique de segmentation
  disparaissent, et la fiche « 360° » des autres écrans perd ces faits sans retour possible.
- **Correctif concret.**
  1. `deleteDoctor` appelle `supprimerReversible("DOCTOR", …)`, et le type `DOCTOR` passe en `lot: true`.
  2. Ajouter un `refuse` : refuser tant que le médecin a des visites `COMPLETED` ou des `AdProMedecin`, en proposant
     l'archivage (`archivedAt`).
  3. Retirer la suppression physique des visites de l'action.
- **Effort.** M.

### DONNEES-08 — Accepter un devis de prise en charge à deux clics ouvre deux ordres · HAUTE · PROPOSÉ

- **Preuve.** `decideCareQuote` (`src/lib/actions/care-actions.ts`) :
  - lit le devis ligne 990 ;
  - vérifie `if (quote.expenseOrderId)` ligne 1003 et les chevauchements en JS (`quoteConflicts`, ligne 1032) ;
  - appelle `createExpenseOrder` ligne 1048 ;
  - écrit ensuite `careQuote.update({ where: { id } })` ligne 1060, sans condition.
- **Scénario réel.** Le PDG et le DG acceptent le même devis, ou deux devis A et B qui couvrent les mêmes personnes, à
  la même minute. Chaque garde voit l'autre encore `PENDING`. Résultat : deux ordres, et les mêmes billets payés deux
  fois.
- **Correctif concret.** Réserver d'abord : `careQuote.updateMany({ where: { id, status: "PENDING", expenseOrderId: null }, data: { status: "ACCEPTED", … } })`,
  et s'arrêter si le compte vaut 0. Ensuite, dans une transaction, `careCell.updateMany({ where: { id: { in }, quoteId: null } })`
  en exigeant `count === cellIds.length`, sinon on défait. L'ordre n'est créé qu'après.
  Le patron de test est le même que pour DONNEES-02.

### DONNEES-09 — La réponse au centre de paiement écrase une décision concurrente · MOYENNE · PROPOSÉ

- **Preuve.** `respondToPaymentCentre` (`src/lib/actions/payment-centre-actions.ts:248-271`) lit `centralStatus`,
  vérifie `canResubmit`, puis fait `expenseOrder.update({ where: { id }, data: { centralStatus: next } })` sans
  condition. `decidePayment` (lignes 172-180) est, lui, conditionnel.
- **Scénario réel.** Le demandeur répond à une demande d'information au moment où un siège du centre tranche. La
  réponse remet `AWAITING` par-dessus `REFUSED` (l'ordre refusé revit) ou par-dessus `APPROVED` (l'autorisation
  disparaît). C'est possible seulement si le centre peut trancher un ordre en `INFO_REQUESTED`, ce que je n'ai pas
  vérifié.
- **Correctif concret.** Écrire avec `updateMany({ where: { id, centralStatus: order.centralStatus, status: order.status } })`
  et refuser si le compte vaut 0. Une ligne.

### DONNEES-10 — Aucune unicité sur l'origine d'un ordre de dépense · MOYENNE · PROPOSÉ

- **Preuve.** Les index de `ExpenseOrder` en base sont `ExpenseOrder_sourceType_sourceId_idx` (non unique) et
  `_reference_key`. 21 appelants de `createExpenseOrder` portent chacun leur garde anti-doublon (`enSerie`,
  `updateMany` conditionnel, `expenseOrderId` lu). DONNEES-02 et DONNEES-08 montrent que deux d'entre eux l'avaient
  manquée.
- **Pourquoi « MOYENNE » et non une migration tout de suite.** Plusieurs sources ont **légitimement** plusieurs ordres
  vivants : les devis de prise en charge (un ordre par devis, même `sourceId` = la demande), la paie (un ordre par
  société), les remises de caisse, et une facture renvoyée après un ordre refusé (l'ancien est annulé, I8). Une
  unicité brute casserait ces circuits.
- **Correctif concret, en deux temps.**
  1. Mesurer les doublons vivants en production : `SELECT "sourceType", "sourceId", count(*) FROM "ExpenseOrder" WHERE status <> 'CANCELLED' GROUP BY 1,2 HAVING count(*) > 1`.
  2. Poser un index unique **partiel** sur les sources à ordre unique, par exemple
     `CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseOrder_source_unique_vivant" ON "ExpenseOrder"("sourceType","sourceId") WHERE status <> 'CANCELLED' AND "sourceType" IN ('PAYMENT_REQUEST','SALARY_ADVANCE','LEGAL_DOCUMENT','ADMIN_REQUEST')`,
     déclaré dans `exceptions.ts` du contrôle de dérive (famille D). La base porte alors la garde que 21 appelants
     doivent aujourd'hui se rappeler.

### DONNEES-11 — Le livre comptable et le centre de paiement chargent toute l'histoire · MOYENNE · PROPOSÉ

- **Preuve.**
  - `src/lib/queries/finance.ts:47`, `getFinanceData` :
    `financeTransaction.findMany({ where: …, orderBy: { date: "desc" } })` sans `take`, sans borne de date, sans
    `select`. Le Json `custom` et les notes de chaque écriture suivent. Les totaux mensuels sont calculés en JS sur ce
    tableau, qui est envoyé au client. Appelé par `finances/comptabilite/page.tsx:51`.
  - Lignes 153 et 191 (`chargerTresorerie`) : toutes les écritures SETTLED depuis l'ancrage le plus ancien, lues
    **deux fois**.
  - `src/lib/queries/centre-paiement.ts:156` : tous les ordres non annulés, `PAID` compris, depuis l'origine, puis
    `classerLesLignes` à chaque rendu.
- **Scénario réel.** Après deux ans, la page Comptabilité sérialise des dizaines de milliers d'écritures vers le
  navigateur à chaque visite, sur une instance Render à 512 Mo. Le temps de rendu et la mémoire croissent sans fin.
- **Correctif concret.**
  - Totaux par `groupBy(["direction", <mois>])` avec `_sum` (ou `$queryRaw` avec `date_trunc`).
  - Livre paginé par curseur (`take: 100`, `cursor`).
  - Pour la trésorerie, un seul `groupBy(["treasuryAccountId","direction"])` après la date d'ancrage.
  - Pour le centre : statuts ouverts pour la liste, `groupBy(["companyId","centralStatus"])` pour les pastilles.

### DONNEES-12 — La référence suivante se calcule en chargeant toutes celles de l'année · MOYENNE · PROPOSÉ

- **Preuve.** Le patron `findMany({ where: { reference: { startsWith: "FIN-2026-" } }, select: { reference } })` puis
  `buildRef` (max + 1 en JS) se retrouve dans :
  - `src/lib/finance/next-ref.ts:17` ;
  - `src/lib/finance/settle-invoice.ts:86` ;
  - `src/lib/actions/finance-actions.ts:22` et `:287` ;
  - `src/lib/expense-orders.ts:16` et `:22` ;
  - `src/lib/actions/payment-request-actions.ts:75`.

  Le coût est O(n) par création et croît linéairement dans l'année. KB 03 §4.7 le note pour `nextRef` ; la mesure ici
  couvre tous les sites.
- **Correctif concret.** Les références sont zéro-complétées à 3 chiffres (`buildRef`), mais au-delà de 999 l'ordre
  lexical casse (`FIN-2026-1000` < `FIN-2026-999`). Ne pas passer à `findFirst({ orderBy: { reference: "desc" } })`.
  Faire passer ces séries par le compteur atomique qui existe déjà : `DocumentSequence` avec
  `INSERT … ON CONFLICT DO UPDATE … RETURNING last` (`references/registre-serveur.ts:23-40`), une ligne par
  (série, année). Cela supprime aussi la dépendance à `enSerie` (mono-processus), qui empêche aujourd'hui de passer à
  deux instances (KB 03 §7).

### DONNEES-13 — Droits sur les documents et import de consommation : lectures non bornées · MOYENNE · PROPOSÉ

- **Preuve.**
  - `src/lib/queries/documents.ts:56`, `:64` et `:72` (`accessibleDocumentWhere`, appelé par `/documents` et par
    **chaque recherche globale** via `queries/search.ts:102`) : pour un utilisateur sans vue globale, tous les ids de
    médecins, de **visites** et de **ventes** de son périmètre sont chargés, puis collés dans un `entityId IN (…)`.
  - `src/lib/consommation/service.ts:61` : chaque import charge toutes les lignes de consommation validées depuis
    l'origine pour détecter les doublons.
- **Correctif concret.** Remplacer les listes d'ids par une sous-requête relationnelle (`EXISTS` en `$queryRaw`, ou une
  relation inverse). Pour l'import, filtrer `existantes` sur les couples (établissement, produit) et les périodes du
  fichier, ou poser l'index unique sur la clé de doublon.

### DONNEES-14 — N+1 dans le rendu : panels de segmentation et KPI · MOYENNE · PROPOSÉ

- **Preuve.**
  - `src/lib/segmentation/service.ts:244` : `for (const r of reps) await prisma.medicalDoctor.findMany({ where: { AND: [clausePanelDuKam(r.repId), { id: { in: ids } }] } })`.
    C'est une requête par KAM, chacune avec un `IN` de tout le panel.
  - `chargerPanel` est lui-même appelé dans des boucles : par BU (`segmentation/lettres-service.ts:37`) et par
    stratégie (`queries/produits-360-sante.ts:68`).
  - `src/lib/kpi/service.ts:207-224`, `valeursPour` : calcul et `kpiValue.upsert` séquentiels, par KPI et par personne,
    **pendant le rendu** de `/mon-equipe`.
- **Correctif concret.**
  - Panels : une seule requête `OR` sur toutes les clauses KAM, puis répartition en mémoire, et un chargement de
    panel par requête HTTP.
  - KPI : lecture groupée des briques pour tous les `userIds`, écriture du cache par `createMany` + `updateMany`, ou
    déléguée au planificateur (`rafraichirKpiSiDu`).

### DONNEES-15 — `deleteOrder` (PCH) efface livraisons et lignes sans audit · MOYENNE · PROPOSÉ

- **Preuve.**
  - `src/lib/actions/pch-actions.ts:260-269` : `prisma.pchOrder.delete` sans `recordAudit`.
  - La cascade emporte `PchOrderLine` et `PchDelivery` (`schema.prisma:7538`), puis `PchDeliveryLine`.
  - `StockMovement.deliveryId` passe à NULL : le mouvement de stock survit, mais sans son bon de livraison.
- **Scénario réel.** Un utilisateur PCH supprime un bon de commande livré pour le ressaisir. Les BL, les réserves de
  réception et le lien des mouvements de stock à leur livraison sont perdus, sans trace de qui l'a fait.
- **Correctif concret.** Refuser la suppression d'une commande qui a des livraisons (`deliveredAt` non nul), ou la
  router par `supprimerReversible` avec un type `PCH_ORDER` en `lot: true`. Dans tous les cas, appeler `recordAudit`.

### DONNEES-16 — Migrations des branches `refonte/*` datées avant le maximum de la base · MOYENNE · PROPOSÉ

- **Preuve.**
  - `refonte/p1-schema-referentiels` ajoute `20270130100000_referentiels` et `refonte/lieux-reference` ajoute
    `20270130110000_lieux_reference`.
  - La base porte déjà `20270131140000_adpro_porte_dg_total` et `20270131150000_adpro_autre_postes`, commitées le
    27/10 à 18:53.
  - Le nom d'une migration est une **horloge d'ordre** (KB 03 §4.9, §8). En production, `migrate deploy` les appliquera
    après les 20270131*. Sur une base neuve (tests, nouvel environnement), elles passeront **avant**. Deux ordres
    d'application différents pour le même dépôt : c'est sans effet aujourd'hui (aucune dépendance croisée), mais c'est
    exactement la classe d'erreur que la règle interdit.
- **Correctif concret.** Avant l'intégration, renommer en `2027013116xxxx_…` (au-dessus du maximum au moment de
  l'intégration). Ajouter le test-cliquet décrit au §4 (« toute migration ajoutée sort après le maximum de la base
  cible »).
- **Remarque.** `refonte/lieux-reference` a passé `prisma format` sur tout le schéma : 333 lignes réalignées dans une
  trentaine de modèles sans rapport (`Department`, `User`, `Company`, `AdProItem`…). C'est un aimant à conflits avec P1
  et toute branche parallèle. Le reformatage doit faire l'objet d'un commit isolé (voir DONNEES-20).

### DONNEES-17 — Cycles de réserves ANPP numérotés par `count()+1` · BASSE · PROPOSÉ

- **Preuve.** `src/lib/regulatory/intelligence/reserves/ingest.ts:54` fait
  `const cycleNo = (await prisma.regulatoryReserveCycle.count({ where: { dossierId } })) + 1`.
  `RegulatoryReserveCycle` (`schema.prisma:11285`) n'a pas `@@unique([dossierId, cycle])`.
- **Scénario réel.** Deux lettres de réserves déposées ensemble, ou après la suppression d'un cycle, reçoivent le
  même numéro. Le tableau « cycle 1 / 2 / 3 » de l'écran devient ambigu.
- **Correctif concret.** Calculer max + 1, puis poser `@@unique([dossierId, cycle])` par une migration idempotente,
  après vérification qu'il n'existe pas de doublon en production (requête `GROUP BY … HAVING count(*) > 1`).

### DONNEES-18 — `MissionInput.milestoneId` sans clé étrangère en base · BASSE · PROPOSÉ

- **Preuve.**
  - `prisma migrate diff` (base locale migrée → schéma) propose `ADD CONSTRAINT "MissionInput_milestoneId_fkey"`.
  - Le schéma déclare la relation (`schema.prisma:14343-14344`, `onDelete: SetNull`).
  - `20260908130000_missions_long_horizon` crée la colonne sans la contrainte (elle la pose pour `MissionStep`, pas pour
    `MissionInput`).
  - C'est le seul écart où la base est **plus faible** que le schéma. `refonte/p0-outillage` le relève aussi.
- **Correctif concret.** Migration idempotente : d'abord `UPDATE "MissionInput" SET "milestoneId" = NULL WHERE …`
  pour les orphelins, puis `ADD CONSTRAINT … ON DELETE SET NULL` dans un bloc `DO $$ … EXCEPTION WHEN duplicate_object`.

### DONNEES-19 — 87 clés étrangères sans index en tête · BASSE · PROPOSÉ

- **Preuve.** Requête `pg_constraint` × `pg_index` sur la base migrée : 87 FK à une colonne n'ont aucun index qui
  commence par elles. La plupart sont des `createdById`/`decidedById` vers `User` (SetNull) : sans enjeu. Celles qui
  comptent :
  - `FileVersion.blobId` → `FileBlob`, **RESTRICT** : chaque suppression de blob par le ramasse-miettes balaie
    `FileVersion` entier ;
  - `MessageReaction.userId` et `SalesSector.repId` (CASCADE) ;
  - `Message.senderId` ;
  - `PaymentRequest.companyId` ;
  - `AdProItem.budgetCategoryId` (lu par la consommation des catégories) ;
  - `ValidationRequest.ruleId`, `WorkflowInstance.definitionId` (RESTRICT).
- **Correctif concret.** Une migration `CREATE INDEX IF NOT EXISTS` pour ces 9 colonnes, avec les `@@index` au schéma.
  Pour `Message`, qui peut être gros, faire le `CREATE INDEX CONCURRENTLY` hors migration Prisma (qui tourne en
  transaction), puis une migration `IF NOT EXISTS` qui le constate.

### DONNEES-20 — `schema.prisma` n'est pas au format canonique · BASSE · PROPOSÉ

- **Preuve.** `prisma format` sur une copie de `prisma/schema.prisma` modifie **355 lignes** d'alignement. Toute branche
  qui lance `prisma format` produit donc des centaines de lignes de diff parasites (voir `refonte/lieux-reference`,
  DONNEES-16).
- **Correctif concret.** Un commit isolé « prisma format, aucun changement de modèle », fait au moment de la bascule
  `prismaSchemaFolder` (§3). Puis un test qui formate une copie et exige zéro différence, car Prisma 5.22 n'a pas de
  `format --check`.

### Déjà connu, non répété

Les points suivants sont documentés dans KB 03 et restent vrais à HEAD ; je ne les compte pas comme constats :

- cascade de `Department` sur l'historique de la caisse d'avance (§7) ;
- `companyId` nullable sans RLS (§4.4) ;
- 680 `…Id` sans relation (§4.3) ;
- `migrate deploy` lancé avant le lint et le build sur Render, que `refonte/p0-outillage` corrige ;
- 49 migrations de juin non idempotentes.

Sur les « 680 colonnes `…Id` sans relation », la question posée est de savoir lesquelles comptent vraiment. Ce sont
celles qui portent un lien d'**argent** :

- `expenseOrderId` (×10) : `PaymentRequest`, `LegalDocument`, `AdProItem`, `CareQuote`…
- `RegulatoryDossier.companyId` / `.productId`.

Pour les `expenseOrderId`, une FK `ON DELETE SET NULL` serait sûre : les ordres ne sont jamais supprimés en
production, seulement annulés. Elle rendrait impossibles les liens morts que DONNEES-02 savait créer. Il faut la poser
après une requête d'orphelins. Les `createdById` (118), les ids polymorphes (`entityId`) et les `blobId` (gérés par le
ramasse-miettes) ne gagnent rien à une FK.

## 3. Dérive schéma ↔ migrations (mesurée)

`prisma migrate diff --from-url <base locale migrée> --to-schema-datamodel prisma/schema.prisma --script` rend
**676 lignes** :

| Nature | Nombre | Lecture |
|---|---:|---|
| `updatedAt DEFAULT CURRENT_TIMESTAMP` en SQL, absent au schéma | ~120 | Voulu, sans effet |
| `DROP INDEX` d'index SQL seuls | 50 | Trigrammes, plein texte, `DESC`, et ~39 B-tree **non déclarés** au schéma (dette sans risque) |
| `RENAME INDEX` (nom court SQL / nom Prisma) | 8 | Dette : `map:` au schéma |
| FK `Mission*`, `ExecutiveCommitment`, `OperationalTemplate` re-posées | 9 | Seul `ON UPDATE CASCADE` diffère ; sans effet (cuid immuables) |
| FK présentes en base, absentes du schéma (`BesoinAnnuelService` ×4, `InfluenceScore`, `PraticienRelation` ×2) | 7 | La base est plus stricte que le schéma : déclarer les `@relation` |
| Index uniques **partiels** vus comme totaux (`MissionStep_idempotencyKey_key`, `AssistantEpisode_span_key`) | 2 | Invariants SQL voulus |
| Tables historiques `SalesTeam`, `MailEntryLink` (+ `SalesRepProfile.teamId`) | 2 + 3 | Voulu (pas de destruction) |
| `MissionInput_milestoneId_fkey` à **ajouter** | 1 | **Dette réelle** → DONNEES-18 |

Ces mesures concordent avec celles de `refonte/p0-outillage` (223 écarts atomiques classés). Mon évaluation de ce lot :
**bon, à intégrer tel quel**.

- Découper le diff en écarts à clé stable, refuser les exceptions périmées et interdire qu'une règle couvre l'inconnu,
  c'est la bonne conception.
- Le passage de `migrate deploy` **après** `build:render` corrige un vrai défaut.
- Seule réserve : `derive-schema.test.ts` lance `prisma migrate diff` sur la base de `npm test`, partagée et
  persistante. Une base locale en retard d'un `db:deploy` fait échouer toute la suite, ce qui est voulu, et le message
  nomme le remède.

## 4. Évaluation du plan `refonte-donnees-et-monolithe-modulaire.md` et des branches

**Sur le fond, le plan est juste** : une chose réelle = une ligne, des liens nullables additifs, une montée par
paliers, et un coffre pour les données sensibles. Ce qu'il oublie, vu depuis ce périmètre :

1. **La garde d'intégrité de l'argent passe avant les référentiels.** Les constats DONNEES-01 à 10 sont des pertes ou
   des doublons d'argent *aujourd'hui*. Le palier P0 devrait inclure un « P0-bis » : réservation conditionnelle
   systématique (cliquet, §6), unicité partielle des origines d'ordres, et `expenseOrderId` en FK.
2. **Le schéma P1 reproduit le polymorphisme sans clé.** `DonneeSensible.titulaireType/titulaireId`,
   `PieceLien.sujetType/sujetId` et `FaitConfirme.sujetType/sujetId` n'ont pas de FK. Supprimer ou fusionner une
   `Personne` laissera des données sensibles orphelines, que personne ne verra plus et que personne ne purgera. C'est
   l'antipatron des « 680 ids sans relation », réintroduit dans le module le plus sensible. `Adresse` et
   `PointDeContact` montrent pourtant le bon patron (deux FK nullables + `CHECK (num_nonnulls(...) = 1)`). Il faut
   l'appliquer aussi à `DonneeSensible` (au minimum), avec `ON DELETE RESTRICT` : une donnée sensible ne disparaît pas
   par cascade, elle s'efface par un geste tracé.
3. **Unicités manquantes dans P1.**
   - `Piece.empreinte` est indexé mais pas unique, alors que la doctrine dit « le fichier une fois pour toutes » :
     deux dépôts simultanés du même passeport créent deux `Piece`.
   - `FaitConfirme` n'interdit pas deux faits **actifs** pour le même (sujet, attribut). Il faut un index unique
     partiel `WHERE actif` sur `(sujetType, sujetId, attribut)` pour les attributs monovalués, sinon « la fiche »
     a deux dates de naissance.
   - `DonneeSensible` mérite `UNIQUE (titulaireType, titulaireId, nature, empreinteHmac)`.
4. **Ordre des migrations** : DONNEES-16. **Reformatage global du schéma** dans `lieux-reference` : DONNEES-20.
5. **`refonte/coffre`** n'ajoute pas de migration. Il dépend du modèle P1 : il faut l'intégrer après P1, et son test de
   frontière (`coffre/frontiere.test.ts`) est une bonne pratique à généraliser.

## 5. Restructuration proposée — le schéma en dossier `prisma/schema/`

`refonte/p0-outillage` §3 a **mesuré** la faisabilité dans Prisma 5.22 : schéma en dossier, migrations inchangées dans
`prisma/migrations`. Il a aussi relevé le piège (un `--schema` pointé sur un fichier ne fait rien et sort en code 0) et
inventorié les 9 lecteurs du fichier. Je n'y reviens pas. Voici le **découpage concret** qui manquait, calculé sur le
DMMF de HEAD (440 modèles), aligné sur les domaines de KB 03 et sur `src/platform/domains.ts`.

```
prisma/
  schema/
    main.prisma              generator (+ previewFeatures = ["prismaSchemaFolder"]), datasource, en-tête de conventions
    commun.prisma            6 enums partagés par ≥ 2 fichiers (EntityType, UserRole, Confidentiality, DocumentCategory…)
    socle-identite.prisma    14  User, Department, BusinessUnit, Company, CompanyLegalIdentity, UserAccess, RowGrant,
                                 UserCompanyAccess, UserSession, Supplier, SupplierUser…
    socle-plateforme.prisma  27  AuditLog, ActivityLog, DeletedRecord, AppSetting, Notification, PushSubscription,
                                 DocumentSequence, DocumentReference, ApiClient, Webhook*, TestRun…
    fichiers.prisma          14  Document, DriveNode, DriveSpace, FileBlob, FileBlobChunk, FileVersion, StoredFile…
    referentiels.prisma      13  Product, ProductAlias, ProductPrice, ProductRange, DirectoryEntry, CompanyContact…
                                 (+ Personne, Organisation, Piece, Wilaya… de P1)
    finance.prisma           12  ExpenseOrder, PaymentRequest, FinanceTransaction, TreasuryAccount, PaymentThreshold,
                                 DemandeActualisationSoldes…
    workflow.prisma          10  ValidationRequest/Step/Rule, WorkflowDefinition/Instance…
    budgets.prisma           19  BudgetEnvelope, BudgetCategoryLine, BudgetExpenseLine, DepartmentBudget, PettyCash*…
    adpro.prisma             41  AdProItem, SponsoringRequest, Congress*, Care*, Event, MedicalInfoDeclaration…
    promo.prisma             19  PromoMaterial, PromoStock*, PromoFacture…
    pch.prisma               30  PchTender, PchOrder, PchDelivery, Sale, Stock*…
    terrain.prisma           53  MedicalDoctor, MedicalVisit, Segmentation*, SalesSector, TourPlan, Bd*, MarketResearch*…
    regulatory.prisma        44  RegulatoryProduct, RegulatoryDossier*, Anpp*, RegulatorySource*…
    rh.prisma                19  Employee, LeaveRequest, HrDocumentRequest, PayrollEntry, Recruitment*…
    moyens-generaux.prisma    7  AdministrativeRequest, OfficeSupplyArticle, DriverMission…
    collaboration.prisma     22  Conversation, Message*, Meeting*, CalendarEvent, Directive, Dossier…
    legal-courrier.prisma     7  LegalDocument, LegalFolder, MailEntry…
    messagerie-mail.prisma   11  MailAccount, EmailRecord, OutboundMailIntent…
    pilotage.prisma          16  Kpi*, BrainRisk, IntelligenceSnapshot…
    siteweb.prisma            8  BlogArticle, SitePublication…
    adam.prisma              54  Assistant*, Mission*, Knowledge*, AiUsageLog, ModelCallLog…
  migrations/                inchangé
```

Mesures sur ce découpage :

- 641 FK au total, dont **321 franchissent un fichier**. Les plus fréquentes vont toutes vers `socle-identite`
  (`User`) : adam 27, collaboration 27, rh 26, terrain 26, adpro 22, budgets 21.
- Entre modules métier, le plus fort couplage est `terrain → referentiels` (8).
- 200 enums sur 206 n'ont qu'un fichier utilisateur : ils voyagent avec leurs modèles. Seuls 6 vont dans
  `commun.prisma`.

**Chemin de migration** (petites étapes sûres, chacune déployable seule) :

1. `src/lib/schema-prisma-source.ts` (`lireSchemaPrisma()`, lecteur fichier ou dossier) et ses 7 lecteurs, comme décrit
   dans P0 §3.3. C'est neutre.
2. Commit « `prisma format` seul » (DONNEES-20), pendant une fenêtre sans branche de schéma ouverte.
3. Déclarer au schéma ce qui existe déjà en base (familles G, H, J, K du contrôle de dérive : `@@index`, `map:`,
   `@relation`, `@default([])`), **sans migration**. Les exceptions correspondantes tombent en « périmées » et se
   retirent au même commit.
4. Bascule en une fois par script, avec la table modèle → fichier ci-dessus versionnée en
   `scripts/schema/decoupe.json`. Preuves : `migrate diff` schéma → schéma vide, `prisma format` sans diff, 440
   modèles et 206 enums, « N migrations found ».
5. Ensuite, **chaque nouveau modèle va dans le fichier de son module**, ce qu'impose le cliquet du §6.

**Ce qu'on gagne.** Un développeur relit `budgets.prisma` (19 modèles, ~900 lignes) au lieu de 16 600 lignes ; un
conflit Git se limite au module touché ; la frontière socle → modules devient visible et mesurable (321 FK
inter-fichiers, à faire décroître hors `User`).

## 6. Bonnes pratiques à graver

| Règle | Comment l'imposer |
|---|---|
| **Tout passage d'état qui déclenche de l'argent est une réservation conditionnelle** (`updateMany({ where: { id, <état lu> } })`, puis `count === 0` ⇒ stop), avant toute création d'ordre ou d'écriture | Test-cliquet : dans `src/lib/actions/**`, tout fichier qui appelle `createExpenseOrder(` ou `financeTransaction.create(` doit, dans la même fonction, contenir `updateMany(` ou `FOR UPDATE` ou `enSerie(`. Plafond = l'existant, à faire descendre. Modèle : `finance/ecrivains-tresorerie.test.ts` |
| **Une écriture d'argent et son lien naissent dans la même transaction** | Même cliquet : `financeTransaction.create` hors `$transaction(` est refusé |
| **`onDelete: Cascade` jamais vers une ligne qui porte un montant** sans `refuse` dans le registre ou une garde de suppression | Test sur le DMMF : pour chaque relation `Cascade` dont l'enfant a un champ `Decimal`, le parent doit être dans une liste d'exceptions justifiées (`cascades-argent.exceptions.ts`). Les 46 parents mesurés au §2 forment la base de départ |
| **Pas de `prisma.<modèle>.delete` d'un modèle du registre de corbeille hors du registre** | Test : grep `\.(delete|deleteMany)\(` sur les modèles de `admin-delete-registry.ts`, hors registre, tests et `suppression/` ; plafond = l'existant (`deleteDoctor`, `deleteOrder`…) |
| **Pas de `findMany` sans `take` sur les tables à croissance illimitée** (`FinanceTransaction`, `ExpenseOrder`, `MedicalVisit`, `Sale`, `AuditLog`, `Notification`, `ConsommationLigne`…) dans `src/app/**` et `src/lib/queries/**` | Cliquet par analyse de source, plafond = l'existant |
| **Pas de requête Prisma dans une boucle de rendu** | Cliquet : `await prisma.` à l'intérieur de `for (` / `.map(async` dans `src/lib/queries/**`, plafond = l'existant |
| **Les numéros séquentiels passent par un compteur atomique**, jamais `count()+1` ni « charger l'année » | Cliquet sur `count(` suivi de `+ 1` (déjà interdit en doctrine, pas outillé) et sur `startsWith: \`…-${year}-\`` |
| **Une migration ajoutée sort après le maximum de la base cible** | Test : les dossiers de `prisma/migrations` non présents dans `origin/claude/hopeful-goodall-phd0nb` ont un horodatage strictement supérieur au maximum de cette branche |
| **`schema.prisma` reste au format canonique** | Test : `prisma format` sur une copie temporaire, zéro différence |
| **Dérive schéma ↔ base nulle hors exceptions justifiées** | `refonte/p0-outillage` (`derive-schema.test.ts`), à intégrer |
| **Polymorphisme : deux FK nullables + `CHECK (num_nonnulls(...) = 1)`** plutôt que `type/id` libres, pour toute donnée qui doit disparaître avec son titulaire | Convention dans KB 03 §5 ; revue des modèles P1 |

## 7. À vérifier (relevé par lecture, non reproduit)

Ces cas ont été repérés en lisant le code. Je ne les ai pas reproduits ; ils ne sont donc pas comptés comme constats.

- `congress-request-actions.ts` `finalDecision` (vérification ligne 347, écriture non conditionnelle ligne 416) : deux
  décisions finales simultanées, sans pharmacien responsable configuré, créeraient deux ordres.
- `hr-actions.ts` `updateLeaveRequest` (lignes 576-613) : le delta de solde est calculé sur un statut lu, hors
  transaction. En concurrence avec `decideLeave`, il pourrait débiter deux fois.
- `payroll-hr-actions.ts` : `unmarkSalaryPaid` (ligne 204) ne prend pas la clé `enSerie(paie:…)` d'`envoyerPaieAuCentre`
  (ligne 276), et `markSalaryPaid` (lignes 128/155) fait un « lire puis écrire » sans condition.
- `hr-document-actions.ts` `decideExpenseReport` (ligne 653) : aucune condition de statut.
- `budget-campagne-actions.ts:328` `enregistrerLigneProposition` pendant `soumettreProposition` : l'instantané de la
  version soumise peut différer des lignes.
- `src/lib/queries/medical.ts:171` `getMedicalData` : apparemment sans appelant (code mort). À supprimer s'il l'est,
  car il chargerait tous les médecins et toutes les visites du périmètre sans borne.

## 8. Vérifications faites

- Base locale `amd_internal_os` migrée de zéro : toutes les migrations s'appliquent.
- Tests ciblés verts après correctifs :
  - budgets (10) ;
  - les trois flux de paiement + le nouveau témoin (59) ;
  - `src/lib/finance` (294) ;
  - `src/lib/finances` + `src/lib/legal` + `ordres-fermes` (249) ;
  - RH (10) ;
  - caisse d'avance et moyens généraux (15).
- Chaque nouveau test a été joué **sans** son correctif et échoue.
- `npx next lint` sur chaque fichier touché : 0 erreur. `tsc --noEmit` (tas de 8 Go ; le défaut de Node manque de
  mémoire sur ce dépôt) : 0 erreur. `src/lib/client-bundle-guard.test.ts` : vert. `npm run actions:contrat` : régénéré (3 actions de suppression budgétaire écrivent
  désormais `budgetCategoryLine` via la garde) ; les 9 suites qui lisent le contrat restent vertes (149 tests).
