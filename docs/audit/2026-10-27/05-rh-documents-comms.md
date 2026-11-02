# Audit 05 — RH, documents, Drive, messagerie, courrier, Office

> Audit du 27/10/2026, branche `audit/rh-documents-comms` (base `claude/hopeful-goodall-phd0nb`, HEAD `456c8f6`).
> Périmètre : RH (employés, congés, paie, missions, recrutement, demandes RH, « Mon dossier »), Drive (`DriveNode`,
> `FileVersion`, `FileBlob`), `Document` polymorphe, messagerie interne, notifications et push, courrier (M365, ancien
> webmail IMAP, registre physique), OnlyOffice, impression.
> Méthode : lecture de la base de connaissance (chap. 08), puis lecture ciblée du code. Chaque constat a été retracé
> depuis un appelant réel : écran, action serveur ou route. Les correctifs sont prouvés par un test qui échoue avant
> et passe après, sur une base Postgres locale.

---

## 1. Synthèse

**Note du périmètre : 6/10.** Les fondations sont saines : coffre chiffré et dédupliqué, purge des blobs orphelins
dérivée du schéma, règles pures partagées entre l'écran et le serveur, circuit de congé unique (`createLeaveRequest`),
rappel OnlyOffice désormais signé et revérifié. Les défauts sont concentrés aux **portes secondaires** : celles qui
n'appellent pas la règle centrale, ou qui croient le formulaire.

Les trois risques majeurs :
1. **Lecture de pièces sans contrôle par l'API v1.** Pour tout type d'entité absent du registre API (paie, demandes
   RH, CV, pièces Legal…), la route ne vérifiait rien. **Corrigé**, voir RH-DOCUMENTS-COMMS-01.
2. **Solde de congés manipulable.** Le nombre de jours débité venait d'un champ caché du formulaire. Les décisions RH
   se reprenaient, se prenaient sur sa propre demande, ou débitaient deux fois. **Corrigé**, voir 02, 03 et 04.
3. **Un simple lecteur d'un fichier du Drive peut le repartager durablement par la messagerie** (canal ouvert à tous).
   Le Drive exige pourtant le droit EDIT pour partager. Un détenteur du périmètre `DRIVE`=`ALL` peut ainsi diffuser
   n'importe quel Drive personnel. **Proposé**, voir 07 : c'est un arbitrage produit.

Bilan : 22 constats (6 HAUTE, 11 MOYENNE, 5 BASSE). **6 corrigés** dans 6 commits.

---

## 2. Constats

| ID | Sév. | Catégorie | Titre | Statut |
|---|---|---|---|---|
| RH-DOCUMENTS-COMMS-01 | HAUTE | sécurité | `GET /api/v1/documents/:id/content` : aucun contrôle hors registre API | CORRIGÉ `2752a79` |
| RH-DOCUMENTS-COMMS-02 | HAUTE | intégrité | Jours de congé reçus du navigateur, débités tels quels | CORRIGÉ `35f9a8c` |
| RH-DOCUMENTS-COMMS-03 | HAUTE | correction | Décisions RH (note de frais, congé) rejouables, auto-décision, double débit | CORRIGÉ `865d85b` |
| RH-DOCUMENTS-COMMS-04 | HAUTE | sécurité | `updateLeaveRequest` : auto-accord, hors entité, écriture non atomique | CORRIGÉ `4c905d8` (partiel) |
| RH-DOCUMENTS-COMMS-05 | MOYENNE | sécurité | SSRF via l'adresse d'abonnement push | CORRIGÉ `3686deb` |
| RH-DOCUMENTS-COMMS-06 | MOYENNE | intégrité | `moveNode` : cible fichier ou corbeille ; sortie de catégorie sans droit | CORRIGÉ `2b83f23` |
| RH-DOCUMENTS-COMMS-07 | HAUTE | sécurité | Repartage Drive par la messagerie avec le seul droit VIEW | PROPOSÉ |
| RH-DOCUMENTS-COMMS-08 | HAUTE | sécurité | Relier un compte à une autre fiche donne ses bulletins ; salaires dans le formulaire | PROPOSÉ |
| RH-DOCUMENTS-COMMS-09 | MOYENNE | sécurité | Corbeille du Drive : le nœud reste lisible, partageable, versionnable | PROPOSÉ |
| RH-DOCUMENTS-COMMS-10 | MOYENNE | sécurité | OnlyOffice `/file` : jeton porteur 24 h, droit jamais relu | PROPOSÉ |
| RH-DOCUMENTS-COMMS-11 | MOYENNE | sécurité | `/api/rh/upload` : `requestId` non rattaché, statut et entité non vérifiés | PROPOSÉ |
| RH-DOCUMENTS-COMMS-12 | MOYENNE | sécurité | Paie et pièces RH : actions sans périmètre entité | PROPOSÉ |
| RH-DOCUMENTS-COMMS-13 | MOYENNE | correction | L'assistant crée des congés hors circuit (deuxième porte rouverte) | PROPOSÉ |
| RH-DOCUMENTS-COMMS-14 | MOYENNE | sécurité | Webmail IMAP retiré mais joignable : sonde réseau / SSRF | PROPOSÉ |
| RH-DOCUMENTS-COMMS-15 | MOYENNE | intégrité | `destroyDeletedRecord` sans prise atomique : double libération de blob | PROPOSÉ |
| RH-DOCUMENTS-COMMS-16 | MOYENNE | performance | Polling messagerie : tout `getSync` recalculé pour un badge | PROPOSÉ |
| RH-DOCUMENTS-COMMS-17 | MOYENNE | sécurité | Membre retiré d'un canal : il revient seul (`joinChannel`) | PROPOSÉ |
| RH-DOCUMENTS-COMMS-18 | BASSE | sécurité | Messagerie : un ADMIN retire l'OWNER ; `editMessage` après départ | PROPOSÉ |
| RH-DOCUMENTS-COMMS-19 | BASSE | correction | OnlyOffice : deux clés de document pour une même pièce | PROPOSÉ |
| RH-DOCUMENTS-COMMS-20 | BASSE | intégrité | Restaurer un nœud Drive dont le parent a été détruit échoue | PROPOSÉ |
| RH-DOCUMENTS-COMMS-21 | BASSE | correction | Notifications RH vers des rôles codés en dur (KB §8.9, toujours vrai) | PROPOSÉ |
| RH-DOCUMENTS-COMMS-22 | BASSE | performance | Listes et arbres : requêtes par niveau, `findMany` sans borne | PROPOSÉ |

### RH-DOCUMENTS-COMMS-01 — Contenu d'une pièce par l'API v1 sans contrôle hors registre (HAUTE, sécurité)
- **Preuve** : `src/app/api/v1/documents/[id]/content/route.ts:28-35` (avant correctif).
  ```ts
  const def = ENTITIES.find((e) => e.entityType && e.entityType === doc.entityType);
  if (def) { /* contrôle */ }        // pas de else
  const buffer = await readFileByKey(doc.fileKey)
  ```
  `ENTITIES` ne couvre qu'une quinzaine de types. `PAYROLL`, `HR_REQUEST`, `RECRUITMENT_CANDIDATE`, `LEGAL_DOCUMENT`,
  `DOSSIER`, `PHARMACOVIGILANCE_CASE`… n'y figurent pas.
- **Scénario** : un client API porte `erp.documents.read`, portée du profil « lecture seule » (`scopes.ts:43`). Il agit
  au nom d'un délégué sans aucun droit RH. Il demande `…/documents/<id>/content` pour la pièce jointe d'une demande RH
  d'un autre salarié et reçoit le fichier.
- **Correctif (fait)** : `src/lib/api/registry/document-lisible.ts` (`documentLisibleParApi`). La règle reste
  registre + portée composée quand le type est décrit. Sinon, la route applique `canAccessEntity` (règle de
  `/api/documents/[id]`). Une pièce sans porteur ne se lit pas.
- **Test** : `document-lisible.test.ts`. Un collègue reçoit `false`, le salarié reçoit `true`, une pièce sans porteur
  reçoit `false`. Le test-cliquet `portee.test.ts` suit le nouveau module.
- **Effort** : S. **Statut** : CORRIGÉ `2752a79`.

### RH-DOCUMENTS-COMMS-02 — Jours de congé fournis par le navigateur (HAUTE, intégrité des données)
- **Preuve** : `hr-actions.ts:345` `const days = fdNum(formData, "days") ?? daysBetween(...)`, et
  `hr-document-actions.ts:150` (`periodDays`). Côté client, `leave-request-button.tsx:134` envoie un
  `<input type="hidden" name="days">`. `decideLeave` débite ensuite `Number(leave.days)`.
- **Scénario** : un salarié (`WORKSPACE:CREATE`) appelle l'action avec `days=-15` pour vingt jours posés. À l'accord,
  son solde est **recrédité** de quinze jours. Avec `days=1`, il n'est débité que d'un jour.
- **Correctif (fait)** : `createLeaveRequest` (`hr/leave-core.ts`), passage unique des deux portes, calcule lui-même
  les jours calendaires. Le paramètre `days` disparaît de sa signature. `requestLeave` valide le type contre
  l'énumération `LeaveType` : un type inconnu donnait une erreur 500 Prisma.
- **Test** : `leave-circuit.test.ts`, « les jours sont recalculés par le serveur… » (forges `-15`, `1`, `Infinity`).
- **Effort** : S. **Statut** : CORRIGÉ `35f9a8c`.

### RH-DOCUMENTS-COMMS-03 — Décisions RH rejouables, auto-décision, double débit (HAUTE, correction)
- **Preuve** : `decideExpenseReport` et `decideHrLeave` faisaient `update({ where: { id } })` sans condition d'état
  (`hr-document-actions.ts:631-727`). `applyAnnualLeaveBalance` lisait `balanceAppliedAt` puis débitait, sans verrou
  (`:64-75`). Aucun test du cas « demandeur = décideur ». `decideExpenseReport` n'appelait pas `refusTraitementRh`,
  alors que `processHrRequest` le fait (`:594`).
- **Scénarios** :
  - Une note de frais **annulée** par le salarié reste validable.
  - Un REFUS après un ACCORD laisse le solde débité.
  - Deux clics simultanés provoquent deux débits.
  - Un membre des RH valide sa propre note.
  - Une note de frais de mission encore chez le N+1 (`managerGate: PENDING`, créée par `cloturerMission`) est tranchée
    aux RH.
- **Correctif (fait)** : `refusDecisionRh` vérifie l'état ouvert, refuse l'auto-décision et appelle
  `refusTraitementRh`. La prise est atomique : `updateMany` conditionné à `PENDING`/`IN_PROGRESS`, avec contrôle de
  `count`. Le verrou `balanceAppliedAt` est pris **avant** le débit, dans la même transaction.
- **Test** : `leave-circuit.test.ts`, « décision RH : un refus après accord est refusé… ».
- **Effort** : S. **Statut** : CORRIGÉ `865d85b`.

### RH-DOCUMENTS-COMMS-04 — `updateLeaveRequest` : auto-accord, hors entité, non atomique (HAUTE, sécurité)
- **Preuve** : `hr-actions.ts:566-623`. Seul `HR_REQUESTS:UPDATE` est exigé. Statut et jours sont réécrits sans
  condition. Le delta de solde est appliqué hors transaction.
- **Scénarios** :
  - Un membre des RH ouvre « Modifier » (`leave-edit.tsx`) sur **sa propre** demande, passe le statut à « Approuvé » :
    elle est accordée et débitée sans N+1.
  - La RH d'une société corrige un congé d'une autre société.
  - Un accord (`decideLeave`) passe entre la lecture et l'écriture : `oldDebit` est calculé sur l'état périmé, et le
    solde est débité deux fois.
- **Correctif (fait)** :
  - refus de l'auto-correction ;
  - contrôle `entitePermisePourFiche` ;
  - `updateMany` conditionné à `status/stage/type/days` lus, réajustement du solde dans la même transaction ;
  - validation du type et de `days` fini.
- **Reste PROPOSÉ** : cette action permet toujours aux RH de faire passer une demande **encore au stade MANAGER** à
  APPROVED, sans N+1 et avec le seul droit UPDATE (`decideLeave` exige VALIDATE). L'écran annonce « les RH peuvent
  corriger toute demande, même déjà décidée » : c'est voulu pour l'historique. Proposition : refuser
  `PENDING → APPROVED|REJECTED` ici et renvoyer vers `decideLeave`, la seule porte de décision. Décision Direction
  requise.
- **Test** : `leave-circuit.test.ts`, « correction RH : jamais sur sa propre demande… ».
- **Effort** : S (M pour le reste). **Statut** : CORRIGÉ `4c905d8` (partiel).

### RH-DOCUMENTS-COMMS-05 — SSRF via l'abonnement push (MOYENNE, sécurité)
- **Preuve** : `api/push/subscribe/route.ts:12-22` stocke `endpoint` tel quel. `push.ts:105`
  (`webpush.sendNotification`) POSTe vers cette adresse à chaque notification.
- **Scénario** : un utilisateur connecté enregistre `endpoint: "http://169.254.169.254/…"` ou
  `"http://localhost:…"`, puis s'envoie un message. Le serveur émet un POST vers le réseau interne, à volonté.
- **Correctif (fait)** : `notifications/endpoint-push.ts` (module pur). Seuls HTTPS, le port par défaut et les hôtes
  des services push (FCM, Mozilla, Apple, WNS) sont acceptés, avec une longueur bornée. La règle est lue à
  l'abonnement et **relue à l'envoi** pour les abonnements déjà enregistrés.
- **Test** : `endpoint-push.test.ts`. **Effort** : S. **Statut** : CORRIGÉ `3686deb`.

### RH-DOCUMENTS-COMMS-06 — Déplacement Drive vers un fichier, la corbeille, ou hors d'une catégorie (MOYENNE, intégrité)
- **Preuve** : `drive-actions.ts:157-193` (`moveNode`). La cible n'est contrôlée ni sur `type` ni sur `isTrashed`
  (contrairement à `copyNodes:606`). Avec `targetId` vide, le `spaceId` fourni par le client est appliqué à tout le
  sous-arbre.
- **Scénarios** :
  - Un élément déplacé sous un **fichier** n'apparaît plus dans aucune liste, corbeille comprise.
  - Un utilisateur qui n'a qu'un partage EDIT sur un contrat de la catégorie « RH » le « déplace à la racine » : il
    sort de la catégorie, et les gestionnaires RH perdent l'accès.
- **Correctif (fait)** : la cible doit être un `FOLDER` hors corbeille. Sortir d'une catégorie exige
  `canCreateInSpace` sur la catégorie d'origine (y entrer l'exigeait déjà).
- **Test** : `drive-deplacement.test.ts`. **Effort** : S. **Statut** : CORRIGÉ `2b83f23`.

### RH-DOCUMENTS-COMMS-07 — Repartage Drive par la messagerie avec le seul droit VIEW (HAUTE, sécurité)
- **Preuve** : `messaging-actions.ts:132` (`parseDriveRefs`) n'exige que `resolveDriveAccess !== "NONE"`.
  `grantDriveRefAccess` (`:200-216`) écrit un `DriveShare VIEW` pour chaque membre, et `accorderPiecesDuFil`
  (`:227-253`) en écrit un pour chaque nouvel arrivant (`joinChannel`, ouvert à tout porteur de `MESSAGING:VIEW`). Le
  Drive, lui, exige EDIT pour partager (`shareNode`, `drive-actions.ts:238-252`). `resolveDriveAccess` donne VIEW sur
  **tous** les nœuds à un périmètre `DRIVE`=`ALL` (`drive.ts:17`). Supprimer le message ne retire pas les partages :
  le commentaire `drive.ts:53-55` est inexact.
- **Scénario** : un manager au périmètre `ALL` joint un dossier personnel d'un collègue (ou un dossier de la catégorie
  RH dont il n'est que lecteur) dans le canal « Général ». Chaque membre, présent ou futur, reçoit un partage
  nominatif **permanent** sur tout le sous-arbre.
- **Correctif proposé** : ne jamais **écrire** de `DriveShare` depuis la messagerie. `partageParMessagerie`
  (`drive.ts`, déjà lu par `resolveDriveAccess`) donne la lecture tant qu'on est membre et que le message existe :
  c'est dynamique et révocable. Sinon, exiger EDIT (ou la propriété) pour accorder, et joindre la simple référence
  dans les autres cas.
- **Effort** : M. **Statut** : PROPOSÉ. Arbitrage Direction requis : le comportement « ranger dans son Drive » a été
  demandé le 27/10.

### RH-DOCUMENTS-COMMS-08 — Relier un compte à une autre fiche donne ses bulletins ; salaires dans le formulaire (HAUTE, sécurité)
- **Preuve** : `updateEmployee` (`hr-actions.ts:~189`) écrit `userId: fdStr(formData, "userId")` sans restriction.
  `/api/rh/document/[id]` sert la pièce à `doc.employee.userId === user.id && visibleToEmployee` (`route.ts:27`).
  `/rh/[id]` passe `baseSalary`, `iban`, `nationalId`… à `EmployeeForm` dès `EMPLOYEES:UPDATE` (KB §8.8), alors que la
  lecture est gardée par `voitLesSalaires` (`RH:UPDATE|VALIDATE`).
- **Scénario** : un titulaire de `EMPLOYEES:UPDATE` sans `voitLesSalaires` relie son compte à la fiche d'un collègue,
  ouvre `/mon-dossier`, puis télécharge ses bulletins. La garde S5 est contournée et seule l'audit en garde trace.
- **Correctif proposé** : exiger `voitLesSalaires` pour modifier `userId` et les champs de paie dans `updateEmployee`
  (sinon conserver les valeurs `before`). Ne pas sérialiser ces champs dans `EmployeeForm` sans `voitLesSalaires`.
  Ajouter un test sur la vraie porte.
- **Effort** : S/M. **Statut** : PROPOSÉ. Non corrigé ici, parce que le formulaire est partagé avec la création de
  fiche et que le contrat d'écran doit être revu avec les RH.

### RH-DOCUMENTS-COMMS-09 — La corbeille du Drive ne révoque rien (MOYENNE, sécurité)
- **Preuve** : `resolveDriveAccess` ignore `isTrashed`. `api/drive/[id]/raw/route.ts:25` lit `isTrashed` sans s'en
  servir. Même lacune dans `refusDepotDrive` (`drive/depot.ts:38`), `shareNode*`, `postDriveComment` et
  `/drive/[id]`. La route ZIP multiple (`api/drive/zip/route.ts:28`), elle, l'exclut.
- **Scénario** : le propriétaire met un fichier à la corbeille pour en cesser la diffusion. Les destinataires du
  partage l'ouvrent toujours par son URL, le repartagent, et y déposent une version.
- **Correctif proposé** : dans `resolveDriveAccess`, renvoyer `NONE` si un nœud du chemin est à la corbeille, sauf pour
  le propriétaire et le Super Admin (restauration). Ajouter un test qui couvre `raw`, `depot` et `share`.
- **Effort** : S. **Statut** : PROPOSÉ (règle métier à confirmer).

### RH-DOCUMENTS-COMMS-10 — OnlyOffice `/api/onlyoffice/file` : jeton porteur, droit jamais relu (MOYENNE, sécurité)
- **Preuve** : `api/onlyoffice/file/route.ts:20-63` sert le fichier sur la seule foi du jeton `lecture`/`doclecture`
  (24 h), placé dans `document.url` de la configuration envoyée **au navigateur**. Ni `userId` du jeton, ni
  `isTrashed`, ni le droit courant ne sont relus. Le rappel, lui, relit le droit (`peutEnregistrerOnlyoffice`).
- **Scénario** : un droit retiré, ou un fichier mis à la corbeille, reste téléchargeable pendant 24 h par quiconque
  détient l'URL (historique, journaux de proxy).
- **Correctif proposé** : relire le droit de `payload.userId` comme le fait `peutEnregistrerOnlyoffice` (version
  « lire »), refuser la corbeille, et ramener la durée de vie à 1 h (le Document Server lit le fichier dès
  l'ouverture).
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-11 — `/api/rh/upload` : demande non rattachée, statut et entité ignorés (MOYENNE, sécurité)
- **Preuve** : `api/rh/upload/route.ts:23-79`. Un `requestId` suffit à basculer le droit exigé sur
  `HR_REQUESTS:UPDATE`. Rien ne vérifie que la demande appartient à `employeeId`, ni son statut, ni sa `managerGate`,
  ni l'entité (`entitePermisePourFiche`). La demande passe ensuite `READY` et `synchroniserOrdreEmis` est appelé.
- **Scénario** : un titulaire de `HR_REQUESTS:UPDATE`, sans `EMPLOYEES:UPDATE`, dépose une pièce de catégorie
  PAYSLIP (visible par défaut) dans le dossier de n'importe quel salarié de n'importe quelle société, avec le
  `requestId` d'une demande quelconque. Un ordre de mission encore chez le N+1 est aussi marqué « émis ».
- **Correctif proposé** : charger `{ employeeId, status, managerGate }`. Exiger l'égalité des salariés, un statut
  ouvert et `!refusTraitementRh` (réutiliser `refusDecisionRh` de 03), plus `entitePermisePourFiche`.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-12 — Paie et pièces RH sans périmètre entité (MOYENNE, sécurité)
- **Preuve** : `payroll-hr-actions.ts` (`markSalaryPaid` :105, `unmarkSalaryPaid` :171, `updatePayrollEntry` :470)
  ne vérifie que `canRunPayroll`. `deleteEmployeeDocument` / `setEmployeeDocumentVisibility`
  (`hr-document-actions.ts:~950-1000`) ne vérifient que `EMPLOYEES:UPDATE`. Or `/rh/paie` filtre par
  `myCompanyWhere`, et `updateEmployee` / `rattacherSalariesAEntite` appliquent `entitePermisePourFiche`.
- **Scénario** : la RH de la société A annule un salaire, supprime un contrat, ou rend visible au salarié une pièce
  « RH seulement » (certificat médical) d'un salarié de la société B, en passant l'identifiant.
- **Correctif proposé** : une garde unique `exigerFicheDansPerimetre(user, employeeId)` (dans `lib/hr/`), appelée par
  toute action RH qui prend un `employeeId` ou un id dérivé. Ajouter un test-cliquet (§4).
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-13 — L'assistant crée des congés hors circuit (MOYENNE, correction)
- **Preuve** : `src/lib/assistant.ts:6787-6809` (`create_hr_request`) fait `prisma.hrDocumentRequest.create` pour
  `ANNUAL_LEAVE`, `SICK_LEAVE`… Le commentaire de `requestHrDocument` affirme qu'aucun congé ne doit plus naître ainsi.
- **Scénario** : « Adam, pose-moi un congé du 2 au 6 ». La demande échappe au N+1, à « Absents aujourd'hui » et à la
  file des congés, et la note de frais est créée sans montant ni justificatif.
- **Correctif proposé** : construire un `FormData` et appeler `requestHrDocument`, comme le fait déjà
  `create_sponsoring_request`.
- **Effort** : S. **Statut** : PROPOSÉ (hors des fichiers de ce périmètre : `assistant.ts` fait 7 000 lignes).

### RH-DOCUMENTS-COMMS-14 — Webmail IMAP retiré mais joignable (MOYENNE, sécurité)
- **Preuve** : `mail-actions.ts:19-26` (`connectMailbox`) accepte `imapHost`, `imapPort`, `smtpHost` et `smtpPort`
  libres, et `testImap` renvoie l'erreur brute (`friendlyMailError`). Aucun droit de module n'est exigé. Les routes
  `/api/mail/{messages,message,attachment,contacts}` sont toujours déployées alors que `/courrier` redirige.
- **Scénario** : tout utilisateur connecté sonde les ports du réseau interne (message d'erreur et temps de réponse),
  puis lit 500 adresses de collègues via `/api/mail/contacts`.
- **Correctif proposé** : supprimer le code mort (`lib/mail.ts`, `mail-actions.ts`, `/api/mail/{messages,…}`, la
  page de connexion). Sinon, figer l'hôte sur `mail.infomaniak.com`.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-15 — Destruction d'une entrée de corbeille non atomique (MOYENNE, intégrité)
- **Preuve** : `admin-delete-actions.ts:214-245` teste `rec.purgedAt` à la lecture, appelle `releaseBlob` pour chaque
  version, puis pose `purgedAt` à la fin. La restauration (`:152-170`) suit le même motif.
- **Scénario** : un double clic, ou deux Super Admin en même temps : le `refCount` descend deux fois.
  `releaseBlob` ignore les détenteurs JSON (lot d'une autre entrée de corbeille) : le blob est effacé alors qu'une
  autre entrée le tient, et la restauration de celle-ci échoue ensuite.
- **Correctif proposé** : prendre l'entrée d'abord
  (`updateMany({ where: { id, purgedAt: null, restoredAt: null } })`, puis `count === 1`), et ne libérer qu'ensuite.
  Faire de même pour la restauration.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-16 — Polling de la messagerie surdimensionné (MOYENNE, performance)
- **Preuve** : `components/layout/messages-indicator.tsx:155-167` appelle `/api/messaging/sync` toutes les 12 s, même
  onglet caché, et n'en lit que `totalUnread`. `getSync` → `getConversationSummaries` (`queries/messaging.ts:310-331`)
  charge toutes les conversations, **tous leurs membres** avec leur fiche, et le dernier message. Dans le fil ouvert,
  `getThreadRefresh` (`:506-522`) relit 120 messages avec réactions et pièces toutes les 3,5 s, plus les épinglés
  sans borne.
- **Scénario** : canal « Général » à 150 membres et 100 personnes connectées. Le badge seul lit environ
  150 × 100 / 12 ≈ 1 250 lignes `ConversationMember` par seconde. Ces appels déclenchent aussi `runScheduledJobs`.
- **Correctif proposé** :
  - `?badge=1` → `getTotalUnread` (déjà écrit) ;
  - `_count` des membres au lieu de leur chargement ;
  - curseur `since` pour le fil ;
  - `take` sur les épinglés ;
  - suspendre le badge quand l'onglet est caché, ou l'espacer à 60 s.
- **Effort** : M. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-17 — Membre retiré d'un canal : retour libre (MOYENNE, sécurité)
- **Preuve** : `removeMember` (`messaging-actions.ts:746`) pose `leftAt`. `joinChannel` (`:802-821`) remet
  `leftAt: null` sans distinguer un départ d'un retrait, et réaccorde les pièces du fil.
- **Scénario** : un administrateur de canal retire un prestataire. Celui-ci clique « Rejoindre », relit tout
  l'historique et récupère les partages Drive.
- **Correctif proposé** : ajouter `removedById`/`removedAt` sur `ConversationMember` (migration additive). Avec ce
  marqueur, `joinChannel` refuse le retour : seul un administrateur réintègre la personne.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-18 — Messagerie : contrôles incomplets (BASSE, sécurité)
- `removeMember` ne protège pas l'OWNER : un ADMIN l'exclut (`:753`). `setMemberRole`, lui, le protège.
- `editMessage` (`:546`) ne vérifie ni l'appartenance active ni `MESSAGING`. Un auteur parti réécrit ses messages.
- `attachment/[id]/route.ts:20` ne vérifie pas `MESSAGING:VIEW`.
- `getBookmarks` (`queries/messaging.ts:579`) ne filtre pas `leftAt`.
- **Correctif** : quatre gardes d'une ligne. **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-19 — OnlyOffice : deux clés pour une même pièce (BASSE, correction)
- **Preuve** : `documents/[id]/edit/page.tsx:86` utilise `doc_${id}_${version}`, alors que `sessionEditeur` utilise
  `doc_${id}_${version}_${size}`. `office-embed/[id]` passe encore par l'ancien `buildEditorSetup`.
- **Scénario** : la même pièce est ouverte depuis l'éditeur plein écran et depuis l'aperçu. Deux sessions
  indépendantes tournent sur le Document Server, et la dernière sauvegarde écrase l'autre (même `fileKey`).
- **Correctif proposé** : faire passer les deux pages par `sessionEditeur`, puis supprimer `buildEditorSetup`.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-20 — Restauration d'un nœud Drive orphelin (BASSE, intégrité)
- **Preuve** : `restaurerLot` (`suppression/lot.ts:426-450`) recrée le nœud avec son `parentId` d'origine. Le crochet
  `restored()` (`admin-delete-registry.ts:961`), qui prévoit « sinon à la racine », ne s'exécute qu'après la création.
- **Scénario** : on supprime le fichier F, puis son dossier P, puis on détruit P. La restauration de F échoue alors
  sur la clé étrangère, et ses octets sont irrécupérables par l'écran.
- **Correctif proposé** : pour `DriveNode`, remettre `parentId` / `spaceId` à `null` quand le parent ou la catégorie
  n'existe plus, avant le `create`.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-21 — Notifications RH vers des rôles codés en dur (BASSE, correction)
- **Preuve** : `notifyRoles(["DIRECTION", "SUPER_ADMIN"], …)` à six endroits (`hr-document-actions.ts:269, 363, 496,
  781, 818, 866`). L'annulation, elle, notifie `rolesWithModule("HR_REQUESTS","UPDATE")`.
- **Plus-value par rapport à KB §8.9** : le problème est toujours présent après la séparation en sous-modules du
  06/10. Un rôle à qui la console accorde `HR_REQUESTS:UPDATE` traite les demandes sans jamais en être prévenu.
- **Correctif proposé** : `const DESTINATAIRES_RH = () => rolesWithModule("HR_REQUESTS", "UPDATE")`, et un
  test-cliquet qui interdit `notifyRoles([` avec des littéraux dans `hr-document-actions.ts`.
- **Effort** : S. **Statut** : PROPOSÉ.

### RH-DOCUMENTS-COMMS-22 — Performance des listes et des arbres (BASSE, performance)
- `resolveDriveAccess` fait une requête par ancêtre. Il est appelé en boucle (`trashNodes`, `shareNodesWithMany`,
  `copyNodes`, `claim`, `filAccessible`), soit O(n × profondeur) requêtes.
- `collectFolder` (`drive-zip.ts:25`) est récursif, à une requête par dossier, sans plafond de nombre de nœuds.
- La racine personnelle d'un périmètre `ALL` (`queries/drive.ts:236`) fait un `findMany` sans borne.
- `/rh/paie/page.tsx:54` lit `payrollEntry.findMany({ where: { year } })` sans filtre d'entité.
- `/rh/[id]` charge tous les employés pour le sélecteur du manager.
- **Correctif proposé** : chemin d'ancêtres en une requête CTE récursive (`WITH RECURSIVE`, voir §3), `take` et
  pagination, filtre d'entité dans la requête.
- **Effort** : M. **Statut** : PROPOSÉ.

### À vérifier (non prouvé)
- **Courrier entrant** (`/api/mail/inbound`, `mail-smart.ts:205`) : avec Resend (en-têtes `svix-*`, secret `whsec_`,
  signature base64 sur `id.timestamp.body`), la vérification hexadécimale actuelle ne peut jamais réussir. Tout
  courrier serait donc rejeté (route fermée par défaut, donc pas de faille), sans garde anti-rejeu.
- **`Document.confidentiality`** (`RESTRICTED`/`CONFIDENTIAL`) n'est appliqué par aucune route de téléchargement.
  L'écran laisse croire à une protection.
- **`canAccessEntity("LEAVE_REQUEST"|"HR_REQUEST")`** retombe sur le module `HR_REQUESTS` sans périmètre entité : les
  justificatifs médicaux seraient lisibles par tout porteur de `HR_REQUESTS:VIEW`.
- **`finaliserDepotDirect`** : si `enregistrerFichierDrive` échoue après l'écriture de la `FileVersion`, la nouvelle
  tentative recrée un blob `direct:<clé>` (conflit d'unicité possible).
- **`blobSecret()`** (`messaging.ts:112`) et la clé maîtresse du coffre retombent sur des constantes si les secrets
  manquent. À confirmer sur Render (`DRIVE_ENCRYPTION_KEY` posé ?).
- **`deciderOrdreMissionN1`** n'utilise pas `auNomDeQui` : l'intérimaire du N+1 ne peut pas trancher un ordre de
  mission, alors qu'il le peut pour un congé.

### Vérifié sain
- Rappel OnlyOffice : jeton d'enregistrement, JWT obligatoire, hôte du Document Server, droit relu. **Le §8.1 de la KB
  est obsolète.**
- `purgeOrphanBlobs` dérive ses détenteurs du schéma.
- `/api/rh/document/[id]` est gardé par S5 et S6.
- `getMyHrDossier` ne renvoie aucun salaire.
- Pièces de messagerie : HMAC et appartenance.
- `markNotificationRead` et `/api/notifications/poll` sont limités à l'utilisateur.
- Enregistrement de réunion : organisateur seulement.
- Registre des courriers : `canAccessEntity`.
- `decideLeave`, `cancelLeave`, formations, recrutement : CAS et `canDecideChain`.

---

## 3. Restructuration proposée

### 3.1 Le problème de fond
Les règles existent et elles sont bonnes : `canAccessEntity`, `resolveDriveAccess`, `entitePermisePourFiche`,
`canDecideChain`, `refusTraitementRh`. Mais chaque **porte** (action, route, opération de l'assistant, API v1)
recompose sa garde à la main. 14 constats sur 22 sont des portes qui ont oublié une garde que leur voisine applique.
Les fichiers d'actions sont énormes : `hr-document-actions.ts` fait plus de 1 000 lignes, `messaging-actions.ts` près
de 900 et `assistant.ts` près de 7 000. Personne ne peut y vérifier d'un coup d'œil qu'une porte est complète.

### 3.2 Structure cible
```
src/lib/rh/
  gardes.ts            // exigerFicheDansPerimetre(user, employeeId) ; exigerDemandeRhOuverte(user, id) ; refusDecisionRh
  conges/
    regles.ts          // pur : jours, transitions autorisées, qui décide (≈ leave-workflow + approval-chain)
    service.ts         // createLeaveRequest, decider, corriger — SEULS écrivains de LeaveRequest et du solde
  demandes/
    regles.ts          // pur : hrNature, états ouverts, transitions
    service.ts         // creer, traiter, decider, joindrePiece — seuls écrivains de HrDocumentRequest
  paie/service.ts
src/lib/actions/rh/*.ts  // "use server" minces : FormData → service, revalidate. Aucun prisma.* direct.
src/lib/fichiers/
  acces.ts             // peutLire(user, cible) / peutEcrire / peutPartager — cible = {drive:id} | {document:id} | {rh:id}
  drive/…              // resolveDriveAccess (CTE), corbeille, déplacement
src/lib/messagerie/{regles.ts (pur), service.ts, sync.ts}
```

Contrats :
```ts
// lib/fichiers/acces.ts — UNE question, posée par toutes les routes qui servent des octets
export type Cible = { drive: string } | { document: string } | { pieceRh: string } | { pieceMessage: string };
export async function peutLire(user: SessionUser, cible: Cible): Promise<boolean>;
export async function peutPartager(user: SessionUser, cible: Cible): Promise<boolean>; // = EDIT, partout (07)

// lib/rh/gardes.ts
export async function exigerFicheDansPerimetre(user: SessionUser, employeeId: string): Promise<Employee>; // lève Refus
```
Chaque service écrit par transition conditionnée :
`updateMany({ where: { id, status: { in: depuis } } })`, puis `count === 1`. C'est le motif des constats 03 et 04,
généralisé.

### 3.3 Migration par petites étapes sûres
1. Créer `lib/rh/gardes.ts` (avec `refusDecisionRh` déplacé depuis 03 et `exigerFicheDansPerimetre`), puis l'appeler
   depuis les actions de 11 et 12. Une PR, des tests par porte.
2. Créer `lib/fichiers/acces.ts` comme **façade** des règles existantes, puis faire passer `/api/documents/[id]`,
   `/api/v1/…/content`, `/api/onlyoffice/file`, `/api/drive/[id]/raw` et `/api/rh/document/[id]` par `peutLire`.
   Corrige 09 et 10 au passage.
3. `resolveDriveAccess` : un seul `WITH RECURSIVE` qui ramène le chemin, les partages et `isTrashed`. Mêmes résultats,
   à vérifier par un test d'équivalence sur un arbre généré, en une requête au lieu de n.
4. Faire de `conges/service.ts` le seul écrivain du solde. Un test-cliquet interdit
   `leaveBalanceDays: { increment|decrement` ailleurs.
5. Messagerie : `sync.ts` séparé (badge léger / liste / fil incrémental), puis suppression des `DriveShare` écrits
   par la messagerie (07), sur arbitrage.
6. Supprimer le webmail IMAP (14) et `buildEditorSetup` (19).

**Gains** : une garde par question, lisible en un fichier ; les portes secondaires (assistant, API v1) héritent
automatiquement des règles ; les tests portent sur des services et non sur des pages ; le polling est divisé par
environ 10.

---

## 4. Bonnes pratiques à graver
1. **Test-cliquet « aucun octet sans `peutLire` »** : toute route qui appelle `getBlob` ou `readFileByKey` doit
   appeler `peutLire` (même méthode que `portee.test.ts`, par lecture du source).
2. **Test-cliquet « solde de congés »** : `leaveBalanceDays` n'est modifié que dans `rh/conges/service.ts`.
3. **Convention « transition conditionnée »** : une action qui change un `status` le fait par `updateMany` conditionné
   à l'état d'origine et vérifie `count`. Règle de lint maison ou test-cliquet sur
   `update({ where: { id }, data: { status`.
4. **Jamais un nombre métier venu du formulaire** quand le serveur peut le calculer (jours, montants dérivés). Le
   formulaire affiche, le serveur calcule (02).
5. **Pas d'auto-décision** : toute décision vérifie `demandeur !== décideur` via un helper unique, avec un test
   paramétré sur chaque action de décision RH.
6. **Pas de `notifyRoles([...littéraux])` dans le domaine RH** : destinataires dérivés des droits
   (`rolesWithModule`), avec un test-cliquet (21).
7. **URL sortante = liste d'hôtes autorisés** : toute adresse fournie par un utilisateur et appelée par le serveur
   (push, IMAP, webhooks) passe par un validateur pur testé (05).
8. **Le code retiré est supprimé** : une fonctionnalité retirée du menu (webmail IMAP) l'est aussi de ses routes et
   actions.
