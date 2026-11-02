# Audit 04 — Ad & Pro et moteur de workflow

> Audit du 27/10/2026, branche `audit/adpro-workflow` (base `claude/hopeful-goodall-phd0nb` @ `456c8f6`).
> Périmètre : le circuit du 27/10 (`docs/architecture/adpro-circuit-2026-10-27.md`), `src/lib/workflow/*`,
> `src/lib/ad-pro/*` (porte-dg, validation-poste, poste-etapes, centre), `src/lib/actions/ad-pro-item-actions.ts`,
> actions sponsoring / congrès / événements / PEC (`care-actions.ts`), et **tous les chemins qui touchent à
> l'argent d'une demande Ad & Pro sans passer par l'écran du poste** (Legal, Budget Marketing, Information
> médicale, Adam, transfert).
> Lignes citées : sur la base `456c8f6` sauf mention « après correctif ».

## 1. Synthèse

**Note du périmètre : 6/10.** Le cœur est solide et remarquablement documenté : la route du 27/10 est une table
pure (`parcoursAdPro`), gelée à la naissance de l'instance ; chaque geste du moteur prend le circuit
(`claimedAt`) avant son premier effet ; les gestes de poste écrivent conditionnellement à l'état lu ; la porte du
DG sur le total a une règle pure unique (`seuils/porte-dg-total.ts`) et une lecture unique (`totalDeLaDemande`).
Ce qui fait perdre des points : **la règle est tenue sur les chemins du poste, pas sur ceux qui le contournent.**
Quatre portes latérales émettaient de l'argent hors du circuit du 27/10 — toutes corrigées dans cette branche.

Les 3 risques majeurs (tous **corrigés**) :
1. **ADPRO-03 (CRITIQUE)** — un ordre de dépense **global** naissait à la validation de la déclaration
   d'information médicale, du montant de postes **refusés** (prise en charge / événement).
2. **ADPRO-01 (HAUTE)** — la facture d'un poste partait au règlement **depuis Legal** : ni porte du DG, ni plafond
   de l'accordé, ni budget, et le poste pouvait ensuite demander son propre paiement — **deux ordres, une facture**.
3. **ADPRO-02 (HAUTE)** — « Consommer » (Budget Marketing › Dépenses) émettait l'ordre d'un poste **sans la porte
   du DG** ; le banc existant le faisait d'ailleurs sur une demande de 18 M DZD jamais validée par le DG.

Constats : **1 CRITIQUE · 5 HAUTES · 5 MOYENNES · 3 BASSES** (+ 6 points « Autre » à transmettre).
Correctifs commités : **5** (ADPRO-01 à 05), chacun avec un banc qui échoue avant et passe après.

## 2. Constats

| ID | Sév. | Catégorie | Titre | Effort | Statut |
|---|---|---|---|---|---|
| ADPRO-01 | HAUTE | Intégrité / sécurité financière | Facture de poste envoyée au règlement depuis Legal : hors porte DG, en double | S | CORRIGÉ `a62be2c` |
| ADPRO-02 | HAUTE | Correction (règle 27/10) | « Consommer » (Budget Marketing) ignore la porte du DG | S | CORRIGÉ `15cb6c9` |
| ADPRO-03 | CRITIQUE | Intégrité financière | Ordre global émis sur l'estimation de postes refusés (déclaration périmée) | S | CORRIGÉ `64628ce` |
| ADPRO-04 | HAUTE | Correction / cohérence | Adam crée une prise en charge à la main : ni circuit, ni gamme, ni date de fin | S | CORRIGÉ `59caaba` |
| ADPRO-05 | HAUTE | Intégrité des données | Transfert d'une PEC dont les postes engagent la dépense ; double transfert | S | CORRIGÉ `f5ed0ac` |
| ADPRO-06 | HAUTE | Sécurité (RBAC ligne) | `advanceWorkflow` sans porte de ligne ; l'étape « National Sales » ouverte à tout le rôle | M | CORRIGÉ `fbc2a2e` |
| ADPRO-07 | MOYENNE | Performance | `totauxEnAttenteDuDg` : N+1 (jusqu'à 300 × 5 requêtes) sur le centre de validation | S | CORRIGÉ `de9dafb` |
| ADPRO-08 | MOYENNE | Intégrité des données | Références de déclaration réutilisées après suppression → restauration impossible | S | CORRIGÉ `937e11f` |
| ADPRO-09 | MOYENNE | Robustesse | Transfert non transactionnel (cible créée, source restée ouverte en cas d'échec) | M | CORRIGÉ `5903d71` |
| ADPRO-10 | MOYENNE | Maintenabilité | `ad-pro-item-actions.ts` : 4 370 lignes, 47 actions, 7 familles, 789 lignes de commentaire | L | PROPOSÉ (§3) |
| ADPRO-11 | MOYENNE | Robustesse | `ensureInstance` avale toute erreur (`catch {}`) et rend l'instance d'un autre | S | CORRIGÉ `ad8cfdb` |
| ADPRO-12 | BASSE | UX | Le centre ne peut pas **refuser** un BC tant que la porte du DG est fermée | S | PROPOSÉ |
| ADPRO-13 | BASSE | Concurrence | `signalerPorteDgSiBesoin` lit puis écrit : deux gestes simultanés = deux alertes DG | S | PROPOSÉ |
| ADPRO-14 | BASSE | Doc ↔ code | La doc du 27/10 annonce la catégorie de circuit `OTHER` (décision #17) — absente du code | S | À TRANSMETTRE |

---

### ADPRO-01 — La facture d'un poste partait au règlement depuis Legal (HAUTE, CORRIGÉ)

- **Catégorie** : intégrité / sécurité financière.
- **Preuve** : `src/lib/actions/legal-actions.ts:911` — `canSendToSettlement({ kind, amount, paidDate, expenseOrderId, bc, ordreLie, direction })`
  ne sait rien du poste ; `deposerFactureSurPoste` (`ad-pro-item-actions.ts:1557`) crée une pièce Legal `INVOICE`
  rattachée au poste (`AdProItemPiece.nature = "FACTURE"`) **sans `expenseOrderId`**. Le bouton est affiché par
  `legal/[id]/chain-card.tsx:150` à quiconque a `LEGAL:UPDATE` ou `FINANCES:CREATE` (et Adam l'expose :
  `assistant/ops/impl-legal.ts:386`). `payerLesFacturesDuPoste` (`:1750`, qui réécrit `expenseOrderId` des factures) ne lit pas l'`expenseOrderId` des factures.
- **Scénario réel** : la Direction Marketing accepte un poste « Impression » de 2 M DZD sur une PEC dont le total
  dépasse le seuil ; le DG n'a pas statué. L'assistante dépose la facture sur le poste. Un juriste ouvre la pièce
  dans Legal et clique « Envoyer au règlement » → **ordre de 2 M DZD** (catégorie `FOURNISSEUR`, **sans budget**),
  porte du DG ignorée, montant accordé non vérifié. Plus tard, le demandeur clique « Demander le paiement » sur le
  poste → **second ordre** pour la même facture (l'`expenseOrderId` de la facture est même écrasé).
- **Correctif** : règle pure `refusFactureDePoste` + champ `posteAdPro` dans `canSendToSettlement`
  (`finances/settlement.ts`) ; l'action relit le lien `AdProItemPiece` FACTURE ; la fiche Legal affiche la même
  phrase à la place du bouton (`legal/[id]/page.tsx`). Une seule règle, lue par l'action et l'écran.
- **Test** : `src/lib/ad-pro/audit-adpro-workflow-flow.test.ts` › ADPRO-01 (échouait : `ok: true`, ordre créé).
- **Effort** : S. **Statut** : CORRIGÉ (voir §Commits).

### ADPRO-02 — « Consommer » ignorait la porte du DG (HAUTE, CORRIGÉ)

- **Preuve** : `src/lib/actions/budget-depense-poste-actions.ts:201-271` — `consommerDepensePoste` appelle
  `createExpenseOrder` après la seule garde `canManageEnvelope` ; aucune lecture de `refusSiPorteDgFermee`, alors
  que les 4 autres portes d'argent du poste l'appliquent (`ad-pro-item-actions.ts:1328, 2459, 2558, 4096`).
- **Scénario réel** : Événement de 3 M DZD (seuil 1 M), BC signé, dépense imputée. La Direction Marketing ouvre
  Budget Marketing › Dépenses et clique « Consommer » → un ordre part au centre de paiement **sans validation du
  DG** — exactement ce que la décision du 27/10 interdit (« ni bon de commande, ni visa, ni paiement »).
  Le banc existant `budget-marketing/depense-poste-flow.test.ts` consommait 4 M DZD sur une demande de **18 M**
  sans aucune décision du DG, en vert.
- **Correctif** : la porte du DG est lue juste après le droit d'enveloppe ; le banc existant pose désormais la
  validation du DG (ce que la règle exige).
- **Test** : ADPRO-02 (refus porte fermée, puis un seul ordre après `statuerSurLeTotal`). **Effort** : S.

### ADPRO-03 — Ordre global émis sur l'estimation de postes refusés (CRITIQUE, CORRIGÉ)

- **Preuve** :
  - `src/lib/workflow/engine.ts:1134` — `reporterLesPostesSurLaDeclaration` : `if (nombre === 0) return;` — quand le
    dernier poste est refusé ou retiré, la déclaration **garde la dernière estimation**.
  - `src/lib/actions/medical-info-actions.ts:71` — `laDepenseEstPorteeParLesPostes` ne compte que les postes non
    refusés → `false` ; `:995` — `order = amount > 0 && !parLesPostes ? await createExpenseOrder(...)`.
- **Scénario réel** (reproduit par le banc) : PEC nationale prévalidée (la déclaration naît **sans montant**, la
  prévalidation n'en fixe pas). Le délégué ajoute un poste estimé 1,5 M → la déclaration passe à 1,5 M. La
  Direction Marketing **refuse** le poste. Le Directeur des opérations valide la déclaration → **ordre global de
  1 500 000 DZD** (`EVENEMENT`) au bénéficiaire de la PEC : rien n'a été accordé, la porte du DG n'a jamais été
  consultée, et la décision #6 (« plus d'ordre global ») est violée. Le sponsoring y échappe par hasard (le statut
  `PRE_VALIDATED` court-circuite la lecture), pas les congrès ni les événements.
- **Correctif** : sans poste, la déclaration revient au montant **fixé par le circuit** (`WorkflowInstance.amount`,
  la même lecture que `montantADeclarer`) — `null` pour une prévalidation ; sans circuit (déclaration manuelle),
  on n'y touche pas.
- **Test** : ADPRO-03 (mesuré avant correctif : `expected 1 to be 0` sur le compte d'ordres). **Effort** : S.
- **À suivre (PROPOSÉ)** : défense en profondeur — `validateDeclarationByDirection` ne devrait jamais émettre
  d'ordre global pour une demande dont l'instance de circuit est née sous la règle du 27/10 (marqueur à poser sur
  l'instance, cf. §4).

### ADPRO-04 — Adam créait une prise en charge à la main (HAUTE, CORRIGÉ)

- **Preuve** : `src/lib/assistant.ts:6753-6786` (`performAction`, `create_congress_request`) : `prisma.congress*.create`
  direct, `requestStatus: "AWAITING_PRELIMINARY"` figé (`:6769`), `companyIdForNew` au lieu de `moneyEntityOf`, ni
  `gammeImposee` (la gamme dont **le budget** est engagé), ni date de fin (exigée depuis le 04/10), **ni
  `ouvrirLeCircuit`** ; notification à `DIRECTION` pour une « validation préliminaire » qui n'existe plus (`:6783`).
  Le registre le déclare pourtant `COVERED` par `createCongressRequest` (`assistant/action-registry.ts:665`) ; le
  sponsoring et l'événement, eux, délèguent déjà à leur action (`:6814`, `:6832`).
- **Scénario réel** : un délégué demande à Adam « crée une PEC nationale pour le congrès de cardiologie d'Oran » →
  la demande naît sans BU (la catégorie budgétaire de la gamme ne pourra pas être contrôlée — point 9), sans fin, son
  National Sales n'est pas prévenu ; une Direction Marketing qui crée par Adam n'est pas prévalidée d'office avant
  qu'on ouvre la fiche.
- **Correctif** : le chemin construit le `FormData` et appelle `createCongressRequest` (mêmes refus, même circuit).
- **Test** : ADPRO-04 (sans date de fin : refus et rien créé ; avec : instance `IN_PROGRESS` sur `preliminary`).

### ADPRO-05 — Transfert d'une PEC qui engage déjà la dépense ; double transfert (HAUTE, CORRIGÉ)

- **Preuve** : `src/lib/actions/ad-pro-transfer-actions.ts:119, 128` — pour un congrès, `engagement` ne lit que
  `r.expenseOrderId` (l'ordre **global**, qui n'existe plus depuis le 27/10). Le sponsoring, lui, compte les postes
  engagés (`:95`). Aucune garde sur une source déjà close (`CANCELLED` / `CLOSED`) ni sur deux clics.
- **Scénario réel** : PEC dont un poste a son BC demandé (ou un devis de personne payé). La Direction la transfère
  vers Sponsoring : la source passe `CANCELLED`, **ses postes, sa demande de BC et ses ordres y restent accrochés**,
  hors de toute file. Un double clic (ou un onglet resté ouvert) crée **deux** demandes cibles.
- **Correctif** : `engagementPriseEnCharge` — ordre global, postes engagés (BC demandé/visé/émis, ordre), devis
  avec ordre, source déjà annulée ; sponsoring déjà clos refusé ; transfert sérialisé par demande (`enSerie`), la
  source étant relue sous la file. Le contrat dérivé de l'action est inchangé (corps gardé dans l'action).
- **Test** : ADPRO-05. **Reste** : ADPRO-09 (atomicité entre processus).

### ADPRO-06 — Le moteur ne vérifie pas que l'acteur voit la demande (HAUTE, CORRIGÉ `fbc2a2e`)

- **Preuve** : `src/lib/actions/workflow-actions.ts:27-63` — `advanceWorkflow` appelle `advanceWorkflowInstance`
  sans `canAccessEntity(... "VIEW")`, alors que `resoumettreDemande` (`:123`) et `retirerDemandeAdPro` (`:153`) le
  font. `canActOnStep` (`engine.ts:516`) ne lit que le **rôle** pour `actorScope: "ROLE"` ; l'étape `preliminary`
  est `ROLE: NATIONAL_SALES` (`workflow/defaults.ts:62-67`) et ses `notifyRoles` préviennent **tous** les National
  Sales (`engine.ts:1334`). Or le National Sales ne voit que **ses** dossiers de congrès (`rbac.ts:2050`, §118.153).
- **Scénario réel** : le National Sales de la BU B reçoit l'alerte d'une PEC d'un délégué de la BU A (il ne peut
  pas l'ouvrir) ; par l'identifiant (lien de la notification, Adam `advance_workflow`), il peut **l'approuver ou la
  refuser** à la place du N+1 réel. Même trou pour toute personne qui porte le rôle d'une étape sur une demande
  d'une société qu'elle ne voit pas.
- **Correctif proposé** : (1) `advanceWorkflow` et `faireAppelAdPro` : `canAccessEntity(user, entityType, entityId, "VIEW")`
  avant le moteur (la phrase « Demande introuvable. ») ; (2) l'étape du National Sales en `actorScope` lié à la
  **gamme** (`businessUnit.supervisorId`) — c'est déjà la lecture de `adProStakeholders` pour la porte des pièces —
  et la notification ciblée sur ce superviseur.
- **Pourquoi pas corrigé ici** : la porte de ligne Ad & Pro combine société, gamme et portée de module ; il faut
  d'abord prouver, par un banc par rôle × étape, qu'aucun acteur légitime (Directeur des opérations multi-sociétés,
  superviseur de gamme hors société) n'est bloqué. **Effort** : M.

### ADPRO-07 — Centre de validation : N+1 sur les totaux en attente du DG (MOYENNE, CORRIGÉ `de9dafb`)

- **Preuve** : `src/lib/ad-pro/porte-dg.ts:222-229` — pour chacune des 300 lignes signalées : `lirePorteDg`
  (3 requêtes, dont 2 `findMany`) + `demandeurEtNom` (1) → jusqu'à **~1 500 requêtes** séquentielles à chaque
  ouverture du centre. Les lignes jamais purgées (`signaleMontant` reste posé après validation) font grossir la liste.
- **Correctif** : agréger en 4 requêtes (`adProItem.groupBy` par colonne parent, `careQuote.groupBy`,
  `adProPorteDg.findMany`, demandeurs par `findMany in`), puis appliquer `etatPorteDg` en mémoire ; remettre
  `signaleMontant` à `null` quand le DG statue. **Effort** : S.

### ADPRO-08 — Référence de déclaration réutilisée → restauration impossible (MOYENNE, CORRIGÉ `937e11f`)

- **Preuve** : `src/lib/medical-info.ts:27-31` — `nextDeclarationRef` = max + 1 des références **vivantes** ; une
  déclaration mise à la corbeille libère sa référence. Le banc pré-existant
  `ad-pro-postes-flow.test.ts › SUPPRIMER … RÉVERSIBLE` a échoué **par intermittence** sur la base locale (1er
  passage rouge, 2e vert — la collision dépend des déclarations créées en parallèle par les autres bancs) :
  `Unique constraint failed on the fields: (reference)` lors de `restoreDeletedRecord` (le retrait d'une demande
  Ad & Pro **est** une suppression réversible, `workflow-actions.ts:147`).
- **Scénario** : on retire un sponsoring prévalidé (sa déclaration part à la corbeille), une autre déclaration naît
  et reprend `DIM-2026-0042`, le Super Admin restaure le sponsoring → « Restauration impossible ».
- **Correctif** : référence tirée d'une séquence (ou max sur vivantes **et** corbeille), avec `createWithRetry`
  comme les autres numérotations. **Effort** : S. (Domaine Information médicale : à arbitrer avec son auditeur.)

### ADPRO-09 — Transfert non transactionnel (MOYENNE, CORRIGÉ `5903d71`)

- **Preuve** : `ad-pro-transfer-actions.ts` — `createTarget` → `document.updateMany` → `fermerInstance` →
  `closeSource` → `ouvrirLeCircuit`, cinq écritures hors transaction ; `fermerInstance(...).catch(() => false)`.
- **Scénario** : une panne entre `createTarget` et `closeSource` laisse **deux demandes vivantes** (pièces déjà
  déplacées vers la cible) ; la file `enSerie` (ADPRO-05) ne protège pas entre deux instances Render.
- **Correctif** : prise conditionnelle de la source en premier (`updateMany where status ∉ {CANCELLED, CLOSED}`
  → état « TRANSFERT_EN_COURS » ou `transferredToId`), puis le reste dans une `$transaction` ; `ouvrirLeCircuit`
  après commit. **Effort** : M.

### ADPRO-10 — `ad-pro-item-actions.ts` : un module-monde (MOYENNE, PROPOSÉ — hors lot V3-F : découpage du module Ad & Pro, feuille de route n° 10)

- **Preuve** : 4 370 lignes, **47 actions exportées**, 38 importeurs, 25 entrées dans `action-registry.ts`,
  789 lignes de commentaires ; 7 familles sans lien (postes, décision, devis/pièces, paiement/facture, BC, stock,
  voyageurs/hébergement, lignes de devis/BC généré) partagent ~400 lignes d'aides privées (`loadItem`,
  `canEditItems`, `refus*`, `reprojeterMontantDemande`, `appliquerGesteVisa`…).
- **Conséquence mesurée dans cet audit** : la porte du DG est appliquée à la main dans 4 actions de ce fichier et
  **oubliée** dans les 2 portes d'argent situées ailleurs (ADPRO-01, 02). La règle n'a pas de point d'entrée unique.
- **Correctif** : §3.

### ADPRO-11 — `ensureInstance` avale toute erreur (MOYENNE, CORRIGÉ `ad8cfdb`)

- **Preuve** : `engine.ts:509` — `} catch { return prisma.workflowInstance.findUnique(...) }` couvre la création,
  la ligne d'historique, la **prévalidation d'office** et les franchissements. Une panne de `settleAutoSkips` rend
  l'instance « posée » sans que rien ne le dise ; une erreur de schéma devient un `null` (« Impossible
  d'initialiser le circuit »).
- **Correctif** : ne rattraper que `P2002` (création concurrente) ; journaliser et relancer le reste. **Effort** : S.

### ADPRO-12 — Le centre ne peut pas refuser un BC porte fermée (BASSE, PROPOSÉ)

- **Preuve** : `ad-pro-item-actions.ts:2558` — `refusSiPorteDgFermee` est lu **avant** la branche `REFUSE` de
  `approveAdProItemOrder`. Refuser n'engage rien ; le centre doit attendre le DG pour dire non.
- **Correctif** : ne lire la porte que pour `decision === "APPROVE"`. **Effort** : S.

### ADPRO-13 — Double alerte « total à valider » (BASSE, PROPOSÉ)

- **Preuve** : `porte-dg.ts:126-150` — lecture de `signaleMontant`, puis `upsert`, puis `notifyRoles` : deux
  décisions de poste simultanées sur la même demande notifient deux fois le DG et le Super Admin.
- **Correctif** : `updateMany` conditionnel sur `signaleMontant` lu (ou `INSERT … ON CONFLICT … WHERE`), notifier
  seulement si `count === 1`. **Effort** : S.

### ADPRO-14 — « Autre » : ce que le circuit du 27/10 n'a pas encore (À TRANSMETTRE à la session en cours)

La décision #17 est documentée comme faite (« catégorie de circuit `OTHER`, postes `AdProItem.otherRequestId` »,
`adpro-circuit-2026-10-27.md`) ; dans le code de la base, seule la colonne `AdProItem.otherRequestId` existe
(`schema.prisma:2473`). Pour que l'intégration en cours soit complète, il lui faut au minimum :
1. `WORKFLOW_CATEGORIES` / `CATEGORY_ENTITY` / `CATEGORY_PATH` (`workflow/types.ts:44`) et `entityToCategory`,
   `LEGACY_FIELD`, `loadEntity`, `referentsDeLaDemande` (engine) ;
2. `AdProParent` / `AD_PRO_PARENTS` / `PARENT_COLONNE` / `PARENT_ENTITE` (`ad-pro-items.ts:18-38`) — sans quoi
   **la porte du DG ne s'applique pas** (`totalDeLaDemande`, `demandeurEtNom` n'ont pas de cas `OTHER`) ;
3. `WORKFLOW_ENTITIES` (`workflow-actions.ts:22`), `MODULE_DE`, `CHEMIN`, `demandeurDe`, `faireAppelAdPro` ;
4. `parentDe` de `budget-depense-poste-actions.ts` et `operation()` (sinon « Consommer » ne voit pas le poste) ;
5. `laDepenseEstPorteeParLesPostes` / `ordreGlobalALaValidation` (ADPRO-03 pour « Autre ») ;
6. le refus `refusFactureDePoste` (ADPRO-01) est déjà générique : rien à faire.

## À vérifier (soupçons non prouvés)

- **Porte du DG et brouillons** : `totalDeLaDemande` compte les postes `DRAFT` (estimés). Un brouillon ajouté après
  la validation du DG referme la porte pour **tous** les postes de la demande, y compris ceux dont le BC est prêt.
  Voulu (« une rallonge rouvre la porte ») ou trop large (seuls les postes soumis devraient compter) ? À trancher
  par la Direction.
- **BC déposé porte fermée** : la demande de BC est refusée porte fermée, mais une pièce BC déposée par
  l'assistante après une rallonge part quand même à la signature des Finances (`signalerSiASigner`). Le paiement
  reste bloqué (`demanderPaiementPoste`) ; à confirmer que la signature d'un BC n'est pas considérée comme un
  engagement par la Direction.
- **`CongressRequest` (ancien modèle)** : `congress-request-actions.ts:403` `finalDecision` émet encore un ordre
  global. Chemin d'écran encore atteignable ? Non tracé dans le temps imparti.
- **Prise de circuit périmée à 2 min** (`engine.ts:598`) : un geste qui dépasse 2 min (OCR d'une pièce jointe
  lourde dans le même appel ?) laisserait un second geste reprendre la prise.

## 3. Restructuration proposée

### 3.1 Le principe : une **porte d'argent** unique, et des actions qui ne savent pas l'oublier

Aujourd'hui chaque action qui engage de l'argent appelle (ou oublie d'appeler) `refusSiPorteDgFermee`, le refus
de clôture, le refus d'historique, le refus de stock… Six chemins différents, six listes de gardes. Cible :

```ts
// src/lib/ad-pro/argent/porte.ts — serveur, sans "use server"
export type GesteArgent = "DEMANDE_BC" | "VISA_BC" | "BC_GENERE" | "PAIEMENT" | "CONSOMMATION" | "ORDRE_DEVIS_PEC";
export async function refusArgent(geste: GesteArgent, cible: { parent: AdProParent; parentId: string; itemId?: string }, enPlus = 0): Promise<string | null>;
// = porte du DG + demande fermée/close + poste historique + poste de stock + prévalidation, dans CET ordre.
```

et **une seule porte d'écriture des ordres Ad & Pro** :

```ts
// src/lib/ad-pro/argent/ordre.ts
export async function emettreOrdrePoste(input: { geste: GesteArgent; itemId: string; montant: number; ... }): Promise<ResultatOrdre>;
// appelle refusArgent, prend le poste (updateMany conditionnel), crée l'ordre, pose expenseOrderId sur le poste ET les factures.
```

`createExpenseOrder` refuserait (cliquet de test, §4) tout `sourceType ∈ {SPONSORING, CONGRESS_*, EVENT}` qui ne
passe pas par `emettreOrdrePoste` — c'est ce qui aurait fermé ADPRO-01, 02 et 03 d'un coup.

### 3.2 Découpage de `ad-pro-item-actions.ts`

Contrainte du dépôt : la dérivation des contrats lit **à plat** `src/lib/actions/*.ts` (`contrat-scan.ts:58`) et
identifie une action par `fichier:fonction` (registre Adam, 25 entrées). Les fichiers d'actions restent donc à plat ;
le noyau partagé descend dans `src/lib/ad-pro/postes/` (serveur, sans `"use server"`).

```
src/lib/ad-pro/postes/
  noyau.ts            loadItem, PARENTS, parentOf, revalidate, audit, demandeVisible           (~250 l.)
  droits.ts           canEditItems, canAllocate, peutTrancherSur, valideursDuPoste               (~80 l.)
  refus.ts            refusSiClos, refusDemandeFermee, refusAvantPrevalidation, refusPostesClos  (~80 l.)
  projection.ts       reprojeterMontantDemande (+ déclaration + signalement DG)                  (~70 l.)
  visa.ts             etatBcDe, appliquerGesteVisa                                               (~80 l.)
  secretariat.ts      cloreDemandesSecretariat, cloreDemandesAuBureau, envoyerDemandeBC          (~120 l.)
src/lib/ad-pro/argent/
  porte.ts, ordre.ts  (§3.1)
src/lib/actions/
  ad-pro-poste-actions.ts        repartir, add, update, delete, linkPromoMaterial, submit        (~600 l.)
  ad-pro-decision-actions.ts     decideAdProItem, setAdProItemBudget, demanderRevisionPoste      (~350 l.)
  ad-pro-devis-actions.ts        ajouter/retirerDevis, demanderPieceSecretariat, demandes de devis (~350 l.)
  ad-pro-bc-actions.ts           request/approve/retirer/modifierDemandeBC, annulerOrdre, BC poste (~700 l.)
  ad-pro-bc-lignes-actions.ts    lignes du devis, BC généré, aperçus (§118.206)                 (~650 l.)
  ad-pro-paiement-actions.ts     demanderPaiementPoste, deposerFacturePoste (→ argent/ordre.ts)  (~450 l.)
  ad-pro-stock-actions.ts        article du stock, confirmation                                 (~220 l.)
  ad-pro-voyageurs-actions.ts    voyageurs, hébergements, réservation, devis voyageurs, billetterie (~600 l.)
```

**Chemin de migration, par étapes vertes :**
1. Extraire `src/lib/ad-pro/postes/*` (fonctions privées → exportées, aucun changement de comportement) ;
   `ad-pro-item-actions.ts` les importe. Tests du périmètre verts, `actions:contrat` sans diff.
2. Introduire `refusArgent` et l'appeler dans les 6 portes d'argent (4 du fichier + Legal + Budget Marketing) —
   même sémantique, un banc par geste.
3. Déplacer **une famille par commit** vers son fichier d'actions ; mettre à jour les importeurs (38 fichiers,
   `rg -l ad-pro-item-actions`), les 25 identifiants du registre Adam et `contrat.genere.json` (régénéré).
   Commencer par le stock (autonome), finir par le BC (le plus couplé).
4. Introduire `emettreOrdrePoste` et y faire passer `payerLesFacturesDuPoste`, `demanderPaiementPoste` (direct),
   `consommerDepensePoste`, `decideCareQuote` ; puis le cliquet sur `createExpenseOrder`.
5. Graphify refresh + README (« Carte du code » Ad & Pro).

**Gain** : chaque fichier < 700 lignes, une famille lisible d'un tenant ; la règle d'argent écrite une fois ;
un nouveau chemin d'argent ne peut plus « oublier » le DG sans faire rougir un test.

### 3.3 Le moteur : séparer règle et effets

`engine.ts` (1 851 l.) mêle lecture de définition, routage, prise, gestes, émission financière, projection legacy,
notifications. Cible : `workflow/moteur/{definition,instance,prise,gestes,emission,projection,notifications}.ts`,
avec `appliquerLeGeste` qui **rend une liste d'effets** (`{ ecrire, notifier, emettre }`) exécutés après la prise —
testables purement, et les notifications sorties du chemin critique (outbox).

## 4. Bonnes pratiques à graver

1. **Cliquet « porte d'argent »** (test statique) : toute fonction de `src/lib/actions/**` qui appelle
   `createExpenseOrder` avec un `sourceType` Ad & Pro, ou crée une demande de BC Ad & Pro, doit appeler
   `refusArgent` (ou `refusSiPorteDgFermee` d'ici là) dans son corps. Liste d'exceptions motivée, comme
   `client-bundle-guard.test.ts`. Ce cliquet aurait trouvé ADPRO-01/02/03.
2. **Cliquet « Adam délègue »** : une branche de `performAction` classée `COVERED` dans `action-registry.ts` ne
   peut pas écrire `prisma.<modèle>.create/update` du modèle de l'action couverte — elle appelle l'action
   (ADPRO-04 était `COVERED` sur le papier).
3. **Porte de ligne obligatoire** : toute action qui prend `entityType`/`entityId` d'un `FormData` appelle
   `canAccessEntity` avant d'agir (règle ESLint locale ou test qui scanne les actions — ADPRO-06).
4. **Une seule source pour « ce que porte une demande »** : montant déclaré, total DG, montant de la demande
   doivent sortir d'un seul module (`ad-pro/argent/montants.ts`) ; interdiction (revue) de recompter les postes
   ailleurs. ADPRO-03 vient de deux lectures (`reporter…` / `laDepenseEstPortee…`) qui ne retombaient pas d'accord
   à zéro poste.
5. **Bancs de régression = scénarios de contournement** : pour chaque règle de la Direction, un banc qui essaie
   les chemins *hors écran* (Legal, Budget, Adam, API, transfert), pas seulement le bouton prévu.
6. **Plafond de taille** : test-cliquet sur la taille des fichiers `src/lib/actions/*.ts` (ex. 1 500 lignes, liste
   gelée des dépassements actuels qui ne peut que diminuer), comme `boundary.test.ts`.
7. **`catch {}` nu interdit** dans `src/lib/workflow/**` (règle ESLint `no-empty` + revue) : rattraper un code
   Prisma précis (ADPRO-11).

## Commits

| Commit | Constat | Résumé |
|---|---|---|
| `a62be2c` | ADPRO-01 | La facture d'un poste ne part plus au règlement depuis Legal (règle pure `refusFactureDePoste`, fiche + action) |
| `15cb6c9` | ADPRO-02 | « Consommer » (Budget Marketing) passe par la porte du DG sur le total |
| `64628ce` | ADPRO-03 | La déclaration suit les postes jusqu'à zéro : plus d'ordre global sur des postes refusés |
| `59caaba` | ADPRO-04 | Adam crée une prise en charge par `createCongressRequest` (circuit, gamme, dates) |
| `f5ed0ac` | ADPRO-05 | Transfert refusé quand la PEC engage déjà la dépense ; source close refusée ; transfert sérialisé |

Vérifications : `npm run typecheck` ✔ · `npx next lint` ✔ · `npm run actions:contrat` (diff limité aux 3 contrats
d'Adam qui n'écrivent plus `congress*` en direct) · banc `src/lib/ad-pro/audit-adpro-workflow-flow.test.ts`
(5 cas, tous rouges avant correctif) · suites `workflow`, `ad-pro`, `actions`, `seuils`, `finances`,
`budget-marketing`, `assistant`, `medical-info`, `bons-de-commande`, `payments`, `client-bundle-guard` :
**352 fichiers, 4 350 tests verts**.
