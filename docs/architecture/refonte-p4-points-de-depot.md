# Refonte P4 — les points de dépôt (étape 1 « Dépôt » du moteur d'enrichissement)

> Inventaire de **tous** les endroits où un fichier entre dans l'ERP, et de l'endroit exact où émettre
> `PIECE_DEPOSEE` (`src/lib/enrichissement/evenements.ts`). Cadrage : `refonte-donnees-et-monolithe-modulaire.md`
> §3-E étape 1. Lignes vérifiées au commit `6293c32` (2026-10-27). **Rien n'est branché** : ce document
> prépare le lot qui branchera.

## 1. Ce qui existe déjà — et pourquoi ça ne suffit pas

- **`DOCUMENT_UPLOADED` existe** : toute `recordAudit({ action: "UPLOAD" })` devient un fait au registre
  (`src/lib/audit.ts:63-85` → `faitDepuisAudit`, `src/lib/events/from-audit.ts:92` → `recordEvent`).
  Sa charge est `{ module, resume, cible }` : **ni blob, ni empreinte, ni MIME, ni taille, ni identifiant de pièce**,
  et le `resume` contient le **nom du fichier en clair** (fuite pour la paie, les congés maladie, les passeports).
  Une audit `CREATE` / `IMPORT` n'émet aucun fait de dépôt.
- **L'empreinte est calculée partout mais perdue presque partout.** `putBlob` (`src/lib/drive-storage.ts:192`,
  SHA-256 à `:193`) rend `PutBlobResult { blobId, sha256, size, deduplicated }` (`:145`). Mais :
  - `saveFile` (`src/lib/storage.ts:27`) l'appelle et **jette le résultat** (`Promise<void>`) : toute pièce de
    module (`Document`) perd son empreinte. On la retrouve après coup par `StoredFile(key).blobId → FileBlob.sha256`.
  - Les appelants directs de `putBlob` ne déstructurent que `blobId`.
  - Le **dépôt direct au bucket** n'a **pas** d'empreinte : `sha256 = "direct:<objectKey>"`
    (`src/lib/drive/depot-direct.ts:169`, `src/lib/documents-depot-direct.ts:170`). `emettrePieceDeposee` le refuse
    (`REJETE`) : il faut calculer le SHA-256 (lecture en flux du bucket, au worker) avant d'émettre.
- **La confidentialité n'est connue que pour `Document.confidentiality`** (`INTERNAL | RESTRICTED | CONFIDENTIAL`).
  `DriveNode`, `MessageAttachment`, `EmailAttachmentRecord` n'en portent aucune ; `EmployeeDocument` a
  `visibleToEmployee` ; `LegalDocument` passe par `LegalDocumentReader`.

## 2. Les trois goulots — brancher ici couvre ~80 % des dépôts

| Goulot | Persiste | Connu au dépôt | Émettre après | Fait existant |
|---|---|---|---|---|
| `enregistrerFichierDrive` `src/lib/drive/depot.ts:54` | version `fileVersion.create` :64 ; fichier `driveNode.create` :73 | `user.id`, `blobId` (l'empreinte est chez l'appelant : `ecrit.sha256`), `mimeType`, `size`, `name`, `cible.parentId/spaceId/category` | version : **:66** (après l'audit) ; nouveau fichier : **:96** | audit UPLOAD :66 / :96 |
| `persistUploadedDocument` `src/lib/documents.ts:52` | `saveFile` :82, `document.create` :100, `documentId` :117 | `entityType`, `entityId`, `userId`, `confidentiality`, `category`, `stepKey`, `key`, `file.name/type/size`, `content` (Buffer) | **:133** (après l'audit, hors `try`) | audit UPLOAD :126 |
| `inscrireDocumentDirect` `src/lib/documents.ts:156` | `document.create` :173 | idem + `blobId`, mais empreinte `direct:` | :181 — **à reporter** au calcul d'empreinte | audit UPLOAD :181 |
| `attachFiles` `src/lib/attach-files.ts:58` | `saveFile` :81, `document.create` :88 (sans `select id`) | `entityType/entityId/uploadedById`, `category`, `stepKey`, `key`, `file.*`, `content` ; confidentialité **figée `INTERNAL`** :98 | **:108** (`saved++`), par fichier | **aucun** |

Prérequis du branchement : `saveFile` doit rendre le `PutBlobResult` (ou `{ blobId, sha256 }`) — changement de
signature rétro-compatible (`void` → objet). Sans lui, il faut relire `StoredFile` par clé.

**Double émission.** `PIECE_DEPOSEE` ne remplace pas `DOCUMENT_UPLOADED` (les tâches et engagements l'attendent,
`src/lib/tasks/evidence.ts:47`, `src/lib/missions/commitments/satisfy.ts`) : les deux coexistent, avec des
consommateurs différents. Émettre `PIECE_DEPOSEE` **au goulot seulement**, jamais aussi chez l'appelant ; l'appelant
qui connaît un rattachement de plus (le voyageur, le poste) émet un second appel avec ce seul rattachement —
l'idempotence par (empreinte, rattachement) ne réémet pas le premier.

## 3. Inventaire par domaine

Colonnes : **Entité** = rattachement (`type:id`, rôle) ; **Dépos.** = déposant ; **Conf.** = confidentialité
connue ; **Empr.** = empreinte disponible ; **Émettre** = ligne après laquelle appeler `emettrePieceDeposee`.
« Goulot » = couvert par la §2.

### 3.1 Drive (`source: DRIVE` / `DRIVE_VERSION`)

| Point d'entrée | Persiste | Entité | Dépos. | Conf. | Empr. | Émettre |
|---|---|---|---|---|---|---|
| `POST /api/drive/upload` `src/app/api/drive/upload/route.ts:16` (`putBlob` :73) | goulot `enregistrerFichierDrive` :85 | `DRIVE_NODE:<id>` « fichier » / « version » | `user.id` | non (→ `INTERNAL`) | `ecrit.sha256` (:78) | goulot |
| Dépôt direct, ouverture `src/lib/drive/depot-direct.ts:52` | session seule (`directUpload.create` :97) | — | — | — | — | rien |
| Dépôt direct, finalisation `depot-direct.ts:128` (`fileBlob.create` :166) | goulot :173 | `DRIVE_NODE` | `user.id` | non | **non** (`direct:`) | après :174, **une fois l'empreinte calculée** |
| Dépôt instantané (contenu déjà présent) `src/app/api/drive/upload/claim/route.ts:34` | `driveNode.create` :89 | `DRIVE_NODE:node.id` | `user.id` | non | `hash` du client, vérifié contre le blob (:45) | :115 (après l'audit) |
| Nouvelle version (éditeur texte) `src/app/api/drive/[id]/texte/enregistrer/route.ts:21` | `putBlob` :42, `fileVersion.create` :46 | `DRIVE_NODE:params.id` « version » | `user.id` | non | `putBlob().sha256` | :51 |
| Nouvelle version OnlyOffice `src/app/api/onlyoffice/callback/route.ts:18` — branche Drive | `putBlob` :69, `fileVersion.create` :72 | `DRIVE_NODE:id` « version » | `userId` (jeton) | non | oui | :76 |
| OnlyOffice — branche `Document` | `saveFile` :62, `document.update` :63 | `doc.entityType:doc.entityId` « version » | `userId` | `doc.confidentiality` | non (`saveFile`) | :64 |
| Live Office / agent — version `src/platform/in-process/artifact/ports.ts:99` (`ecrireVersion`) | `putBlob` :115, `fileVersion.create` :119 | `DRIVE_NODE:nodeId` « version » | `userId` | non | oui | :122 — **aucun fait aujourd'hui** |
| Live Office / agent — fichier `ports.ts:126` (`creerFichier`) | `driveNode.create` :140 | `DRIVE_NODE` | `userId` | non | oui | :147 — **aucun fait** |

Générés, pas déposés (audit `CREATE`) : `createOfficeNode` `src/lib/actions/drive-actions.ts:337`, `convertNodeToPdf`
`:424`. Copies `copyNodes` `:646-656` (dans une transaction ; même empreinte, nouveau rattachement — à émettre après
la transaction si l'on veut le lien). Miroirs (`src/lib/drive/mirror.ts`, `hr-drive-mirror.ts`,
`regulatory-drive-mirror.ts`) : **ne pas émettre** — la pièce l'a déjà été à sa source.

### 3.2 Messagerie interne (`MESSAGERIE`)

| Point d'entrée | Persiste | Entité | Dépos. | Conf. | Empr. | Émettre |
|---|---|---|---|---|---|---|
| `POST /api/messaging/upload` `src/app/api/messaging/upload/route.ts:16` | `putBlob` :40, blob **orphelin** (signé, sans ligne) | — | `user.id` | — | oui | **pas ici** : rien ne prouve encore l'envoi |
| `sendMessage` `src/lib/actions/messaging-actions.ts:378` | `message.create` :411 avec `attachments.create` :422 | `CONVERSATION:conversationId` « pièce-jointe » (+ `MESSAGE:created.id`) — hors `EntityType`, donc `relatedRefs` | `user.id` | non (la conversation est privée → `RESTRICTED`) | **non** : le blob signé ne porte que `blobId` → relire `FileBlob.sha256` | après :438 (`grantDriveRefAccess`) ; fait existant `emettreMessageRecu` :448 (`hasAttachments` seul) |
| Gros fichiers / dossiers `preparerDepotMessagerie` :469 | dossier de lot :500 | les fichiers passent par `/api/drive/upload` | — | — | — | goulot Drive |

### 3.3 E-mails entrants (`EMAIL_GMAIL` / `EMAIL_M365`)

| Point d'entrée | Persiste | Entité | Dépos. | Conf. | Empr. | Émettre |
|---|---|---|---|---|---|---|
| Gmail `ingestMessage` `src/lib/google/gmail/ingest.ts:146` → `ingestAttachments` :94 | `emailAttachmentRecord.create` :125 — **octets non conservés** (lus :111 pour le texte) | `EMAIL:record.id` | `null` (système ; `sender.userId` éventuel) | non | **non** | **rien à émettre tant que l'octet n'est pas stocké** ; `EmailAttachmentRecord.driveNodeId/documentId` ne sont jamais remplis. Le lot qui stockera la PJ émettra après l'écriture, hors de la boucle :238. Fait existant `EMAIL_RECEIVED` :265 (noms des PJ dans la charge) |
| Microsoft 365 — enregistrer une PJ au Drive `saveAttachmentToDrive` `src/lib/actions/microsoft-mail-actions.ts:217` | `putBlob` :239, `driveNode.create` :241, `mailLink.create` :252 | `DRIVE_NODE:node.id` « pièce-jointe-email » + `entityType:entityId` du formulaire (:223) | `ctx.userId` | non | `putBlob().sha256` | :265 (après l'audit `CREATE`, qui n'émet **pas** `DOCUMENT_UPLOADED`) |

Pas de synchronisation M365 qui stocke les PJ ; `src/app/api/mail/ms/attachment/route.ts` et `src/app/api/mail/attachment/route.ts` ne font que télécharger.

### 3.4 Portail fournisseur (`PORTAIL_FOURNISSEUR`)

**Aucun point de dépôt aujourd'hui** : `src/app/(portal)/portail/page.tsx` est en lecture, `src/lib/actions/supplier-portal-actions.ts`
ne fait que la connexion. Le jour où le portail recevra une facture : `deposeParId: null`, rattachement `SUPPLIER:<id>`
« facture », émission après l'écriture de la pièce.

### 3.5 Ad & Pro (`ADPRO`) — `src/lib/actions/ad-pro-item-actions.ts` sauf mention

| Point d'entrée | Persiste | Entité | Conf. | Émettre (rattachement **en plus** du goulot) |
|---|---|---|---|---|
| Devis de poste `ajouterDevisPoste` :1130 | `legalDocument.create` :1175, `attachFormFiles` :1195/:1197 (goulot) | `LEGAL_DOCUMENT:doc.id` « devis » + `AD_PRO_ITEM:itemId` « devis » | `INTERNAL` | après :1202 (`rattacherPieceAuPoste` :1201) |
| Devis voyageur `ajouterDevisVoyageur` :3578 | via `ajouterDevisPoste` :3614 | + voyageur (`stepKey`) « devis-voyageur » | `INTERNAL` | après :3625 ; la branche « même fichier » :3601 n'ajoute qu'un lien → émettre ce seul lien |
| Passeport / pièces du voyageur `ajouterVoyageur` :3172 | `persistUploadedDocument` :3206 | `AD_PRO_ITEM:itemId` « passeport », `stepKey = cree.id` | **forcer `CONFIDENTIAL`** pour `ID_DOCUMENT` (aujourd'hui `INTERNAL`) | après :3213 |
| Pièce d'hébergement `ajouterHebergement` :3310 | :3341 | `AD_PRO_ITEM:itemId` | idem si pièce d'identité | après :3348 |
| Poste créé avec fiches `creerPosteEtFiches` `src/lib/ad-pro/fiches-poste.ts:106` (`joindrePiecesDeFiche` :46) | :46 | `AD_PRO_ITEM:itemId`, `stepKey: ficheId` | `INTERNAL` | **:138 seulement** : l'échec :131-137 efface pièces et poste — un fait émis au goulot survivrait à un rollback (voir §4) |
| Facture sur poste `deposerFactureSurPoste` :1480 | `legalDocument.create` :1520, `persistUploadedDocument` :1536, annexes :1546 | `LEGAL_DOCUMENT:facture.id` « facture » + `AD_PRO_ITEM` | `INTERNAL` | après :1551 |
| Paiement d'un poste `demanderPaiementPoste` :1285 | `legalDocument.create` :1390/:1412, `attachFormFiles` :1405/:1429 | `LEGAL_DOCUMENT` « justificatif » / « facture » | `INTERNAL` | après la réussite de `createExpenseOrder` (~:1440) — bloc à rollback manuel :1383 |
| Autre demande `createAdProOtherRequest` `src/lib/actions/ad-pro-other-actions.ts:52` | `attachFiles` :123 | `AD_PRO_OTHER:req.id` | `INTERNAL` | goulot `attachFiles` (sinon :125) — **aucun fait aujourd'hui** |
| Discussion de poste `addAdProComment` `src/lib/actions/ad-pro-discussion-actions.ts:83` | `attachFiles` :104 | `entite:id`, `stepKey = clePieceMessage(message.id)` | `INTERNAL` | goulot (sinon :106) — **aucun fait** |
| Contrat de consultant `createConsultingContract` `src/lib/actions/consulting-actions.ts:116` | `attachFiles` :192 | `CONSULTING_CONTRACT:contract.id` « contrat » | `RESTRICTED` (rémunération) | goulot (sinon :195) ; seul `CONTRACT_SIGNED` existe (:207) |
| Intégration Ad & Pro (import) `src/lib/actions/integration-adpro-actions.ts:191`, `:330` | `attachFiles` | `BUDGET:env.id` | `INTERNAL` | goulot (sinon :195) ; `lu.sha256` disponible |

### 3.6 RH (`RH`)

| Point d'entrée | Persiste | Entité | Conf. | Empr. | Émettre |
|---|---|---|---|---|---|
| `POST /api/rh/upload` `src/app/api/rh/upload/route.ts:19` | `putBlob` :52, `employeeDocument.create` :54 | `EMPLOYEE:employeeId` « category » (+ `HR_REQUEST:requestId`) | `CONFIDENTIAL` (pièce RH) | `putBlob().sha256` | après :91 (audit UPLOAD existant, nom en clair dans `resume`) |
| Fiche de paie `deposerFicheDePaie` `src/lib/actions/payroll-hr-actions.ts:62` (appelants :135, :501) | `putBlob` :73, `employeeDocument.create` :74 | `EMPLOYEE:employeeId` « bulletin-paie » | `CONFIDENTIAL` (nature locale) | oui | après :90 / :96 — **aucun fait** |
| Pièces d'une demande RH `attachRequestFiles` `src/lib/actions/hr-document-actions.ts:174` | `saveFile` :182, `document.create` :188 | `HR_REQUEST:requestId` | `INTERNAL` | non (`saveFile`) | après :193 — **la ligne est créée même si `saveFile` a échoué** (:183-187) : ne pas émettre dans ce cas |
| Justificatifs de congé `attachLeaveFiles` `src/lib/hr/leave-core.ts:129` | `saveFile` :136, `document.create` :140 | `LEAVE_REQUEST:leaveId` « justificatif » | `CONFIDENTIAL` | non | après :146 — même réserve |
| Fiche de poste `src/lib/actions/recruitment-actions.ts:176` | `attachFormFiles` (goulot) | `RECRUITMENT_REQUEST:created.id` | `INTERNAL` | — | goulot |
| CV manuel `addRecruitmentCandidate` `recruitment-actions.ts:612` → :639 | goulot | `RECRUITMENT_CANDIDATE:candidate.id` « cv » | `RESTRICTED` | — | goulot |
| CV du site web `recevoirLue` `src/lib/site-web/candidatures.ts:204` | `saveFile` :215, `tx.document.create` :242 (transaction :230) | `RECRUITMENT_CANDIDATE:cand.id` « cv » | `RESTRICTED` | `c.cv.empreinte` (:154) | après la transaction, :272 ; `deposeParId: null` |
| Rattachement d'une candidature `rattacherCandidature` `candidatures.ts:306` | `tx.document.create` :340 (blob réemployé) | `RECRUITMENT_CANDIDATE:candidateId` | `RESTRICTED` | via blob | après :350 (nouveau lien seul) |

`analyzeEmployeeContract` (`src/lib/actions/hr-actions.ts:249`) lit sans persister : rien.

### 3.7 Legal (`LEGAL`) — `src/lib/actions/legal-actions.ts`

| Point d'entrée | Persiste | Entité | Émettre |
|---|---|---|---|
| `createLegalDocument` :173 | `legalDocument.create` :252, `attachFormFiles` :302 | `LEGAL_DOCUMENT:id` | goulot ; confidentialité : `RESTRICTED` si des lecteurs sont posés (:280) |
| `updateLegalDocument` :320 | `attachFormFiles` :465 | idem | goulot |
| `attachDriveNodeToLegal` :515 | `legalDocument.create` :563 (référence `driveNodeId`, pas de fichier neuf) | `LEGAL_DOCUMENT` + `DRIVE_NODE` | après :577 — nouveau **lien** d'une pièce déjà émise (empreinte via le blob de la dernière version) |
| Factures `createInvoice` `src/lib/actions/invoice-actions.ts:72` | `attachFormFiles` :135 | `INVOICE`/`LEGAL_DOCUMENT` | goulot |
| Devis / BC du secrétariat `src/lib/actions/secretariat-devis-actions.ts:132`, `:390` | `persistUploadedDocument` | — | goulot |
| Copie signée d'un BC `signerBonDeCommande` `src/lib/actions/bc-signature-actions.ts:93` | goulot | `LEGAL_DOCUMENT:id` « copie-signée » | après :99 (après le contrôle `!depot.ok`) |

### 3.8 Regulatory (`REGULATORY`)

| Point d'entrée | Persiste | Entité | Empr. | Émettre |
|---|---|---|---|---|
| Pièces de produit / CTD — `/api/documents/upload` et sa variante directe | goulot | `REGULATORY_PRODUCT` | — | goulot |
| Dossier d'intelligence (ZIP) `ingestCore` `src/lib/regulatory/intelligence/ingest/ingest-dossier.ts:126` (route `src/app/api/regulatory/intelligence/upload/route.ts:70`, session `upload/session.ts:412`, `:660`) | `$transaction` :257 (`regulatoryDossierVersion.create` :259) | **aucun `EntityType`** pour un dossier réglementaire → `REGULATORY_DOSSIER:dossierId` en `relatedRefs` seulement | `originalSha256` (:208/:211) | après :298, avant le `return` :307 |
| Sources du corpus `ingestCorpusFile` `src/lib/regulatory/intelligence/corpus/ingest-file.ts:62` (action `corpus/actions.ts:73`) | `regulatorySourceVersion.create` :134 — **pas de blob conservé** | `REGULATORY_SOURCE:source.id` | `hash` = SHA-256 **du texte**, pas du fichier | ne pas émettre tant que le fichier n'est pas stocké |
| Demande de BV `requestBV` `src/lib/actions/regulatory-actions.ts:1125` | `saveFile` :1213, `document.create` :1217 | `EXPENSE_ORDER:order.id` « proforma » | non | après :1222 |
| Quittance BV `deposerQuittanceBv` `src/lib/regulatory/bv-reglement.ts:69` (appelant `expense-actions.ts:192`) | `saveFile` :73, `document.create` :74 | `REGULATORY_PRODUCT:o.sourceId` « quittance-bv » | non | après :81 |

### 3.9 PCH (`PCH`)

| Point d'entrée | Persiste | Entité | Émettre |
|---|---|---|---|
| `createTender`, champ `tenderDoc` `src/lib/actions/pch-actions.ts:75` | goulot (dans une boucle) | `PCH_TENDER:created.id` « cahier-des-charges » | goulot |
| `analyzeTenderDocument` `src/lib/actions/pch-tender-line-actions.ts:335` | goulot (si droit UPLOAD) | `PCH_TENDER:tenderId` | goulot |
| Onglet Documents `src/app/(app)/pch/[id]/page.tsx:215` | `/api/documents/upload` | `PCH_TENDER` | goulot |
| Relevé de stock `enregistrerStockPch` `src/lib/actions/stock-pch-actions.ts:96` | goulot | `STOCK_PCH_RELEVE:cle` | goulot |
| Facture de marché `order-execution.tsx:167` | `createInvoice` (Legal) | `PCH_ORDER` | voir §3.7 |

### 3.10 Matériel promotionnel (`MATERIEL_PROMO`)

| Point d'entrée | Persiste | Entité | Émettre |
|---|---|---|---|
| `chooseAgency` `src/lib/actions/promo-material-actions.ts:412` | goulot, **avant** la transaction :423-433 | `PROMO_MATERIAL:id` « devis-agence » | :438 — le goulot émettrait avant un rollback (`retirerPieces` :435) |
| `submitBcForFinance` :465 | goulot | `PROMO_MATERIAL` « bc » | :487 (rollback :484) |
| `enregistrerDevisPromo` `src/lib/actions/promo-devis-actions.ts:400` | goulot | `PROMO_MATERIAL:pm.id` « devis » | :487 (compensation :471) |
| `deposerFacturePromo` `src/lib/actions/promo-execution-actions.ts:639` | goulot | `LEGAL_DOCUMENT:facture.id` + `PROMO_MATERIAL` (via `sourceId`) | :646 |
| Visuels / BAT `src/app/(app)/promo-material/[id]/page.tsx:577`, `:682` | `/api/documents/upload` | `PROMO_MATERIAL` | goulot |

`lireScanDevisPromo` (:291) et `lireFacturePromo` (:474) lisent sans persister : rien.

### 3.11 Assistants (`ASSISTANT_ADAM` / `ASSISTANT_IA`)

| Point d'entrée | Persiste | Entité | Émettre |
|---|---|---|---|
| Adam — pièce jointe à la conversation `resolveAttachment` `src/lib/actions/assistant-actions.ts:51` | **rien** (base64 décodé :55, texte extrait, fichier jeté) | — | rien |
| Assistant IA — pièce jointe `src/components/assistant-beta/pieces-jointes.tsx:26` → `/api/drive/upload` | goulot Drive | `DRIVE_NODE` | goulot (`source: DRIVE`) |
| Livrables générés `depositBufferToDrive` `src/lib/assistant/exports.ts:233` (`putBlob` :238 ; version :247 / nœud :253) — appelants `exportDatasetToDrive` :315, `deliverables.ts:352`, `executive-brief-tools.ts:321` | Drive, sans audit UPLOAD | `DRIVE_NODE` « livrable » (+ `ASSISTANT_ARTIFACT`) | :251 / :260 — **aucun fait aujourd'hui** |
| Livrables de mission `depotDrive` `src/platform/in-process/missions/sink.ts:28` ← `executerArtefact` `src/lib/missions/artifacts/build.ts:146` | Drive | `DRIVE_NODE` + `MISSION:<id>` | :175 |
| Opérations de l'agent (traduction, document modèle, formulaire PDF — `src/lib/agent/operations/**`) | `putBlob` + goulot Drive | `DRIVE_NODE` | goulot — `src/lib/agent/**` n'est **pas** à modifier |

Une pièce **générée** par l'ERP n'a rien à enrichir (ses faits viennent de l'ERP) : le consommateur la classe
`AUTRE` et s'arrête. L'émettre garde la pièce traçable et dédoublonnable.

### 3.12 Imports Excel / CSV (`IMPORT_EXCEL`)

| Point d'entrée | Fichier conservé ? | Empr. | Émettre |
|---|---|---|---|
| Ventes PCH `appliquerFichiersVentesPch` `src/lib/actions/ventes-pch-actions.ts:84` → `ventes-pch/service.ts:304` | oui, **octets en base** (`pchVenteImport.fichier`, transaction) | `empreinte` | après :91, rattachement `PCH_VENTE_IMPORT:r.importId` ; `blobId` = l'identifiant de l'import (pas de `FileBlob`) |
| Consommation `importerFichierConsommation` `consommation-actions.ts:31` → `consommation/service.ts:102` | oui, colonne `fichier` | oui | après :32 |
| Segmentation `segmentation-actions.ts:171`, `:212` | **non** (métadonnées seules) | oui | rien (pas de blob) |
| KPI `importerKpi` `kpi-actions.ts:438` | oui (`putBlob`, `kpiImport.blobId`) | oui | après :449 (audit UPLOAD existant, sans entité) |
| Intégration Ad & Pro | `attachFiles` | `lu.sha256` | §3.5 |
| Annuaire médical, aperçus, `importSales` / `importTransactions` (texte collé), op Adam `import_transactions` | non | — | rien |

### 3.13 Autres routes de dépôt

| Point d'entrée | Persiste | Émettre |
|---|---|---|
| Enregistrement de réunion `src/app/api/meetings/[id]/recording/route.ts:36` | `putBlob`, `meeting.audioBlobId` :38 | après :38, `MEETING:id` « enregistrement », `CONFIDENTIAL` |
| Rapport de terrain `src/app/api/field-reports/[id]/upload/route.ts:29` | `putBlob`, `fieldReportAttachment.create` :33 | après :33 |
| Pièces de congrès `deposerPiece` `src/lib/actions/mission-actions.ts:825` | goulot | `MISSION_ASSIGNMENT` — goulot |
| Sujets (Dossier) `postDossierMessage` `src/lib/actions/dossier-actions.ts:114` | `putBlob` :136, `dossierMessageAttachment` :137 | après :137, `DOSSIER:id` — **aucun fait** |
| Info médicale `src/lib/actions/medical-info-actions.ts` (~:223) | goulot | `MEDICAL_INFO_DECLARATION` — goulot |

## 4. Règles de branchement (pour le lot suivant)

1. **Après l'écriture acquise, hors transaction** — jamais dans un `$transaction` ni avant une étape qui peut
   annuler (promo, fiches de poste, paiement de poste : émettre à la ligne indiquée, après la réussite).
2. **Une fois par pièce et par lien** — au goulot ; l'appelant n'émet que les rattachements que le goulot ignore.
3. **Jamais sans empreinte réelle** — `direct:` est refusé ; le dépôt direct émettra après calcul au worker.
4. **Confidentialité** : celle du `Document` ; `CONFIDENTIAL` d'office pour RH, paie, congés, pièces d'identité,
   enregistrements ; `RESTRICTED` pour messagerie, contrats, CV ; `INTERNAL` sinon. Une pièce `CONFIDENTIAL` ne porte
   au registre que l'extension de son nom.
5. **Ne pas émettre** pour un miroir Drive, une lecture sans persistance, une ligne créée après un `saveFile` en échec.

## 5. Le helper et l'abonnement prévu

- `src/lib/enrichissement/depot.ts` (pur) : validation, clés `empreinte|TYPE:id|rôle`, charge
  `{ v, blobId, empreinte, nomFichier, mime, taille, source, confidentialite, rattachements, cles }`.
- `src/lib/enrichissement/evenements.ts` : `emettrePieceDeposee(input)` → `recordEvent({ type: "PIECE_DEPOSEE",
  sourceDomain: "ENRICHISSEMENT", correlationId: "piece:<empreinte>", entityType/entityId: premier rattachement
  `EntityType`, relatedRefs: tous })`. Idempotent : relit les clés déjà inscrites sous la corrélation (indexée) et
  n'émet que les nouvelles ; rend `EMIS | DEJA_EMIS | REJETE | ECHEC`, ne lève jamais.
- `ABONNEMENT_PIECE_DEPOSEE` : consommateur `enrichissement.classement`, exécution au worker, idempotent par
  empreinte + rattachement, **non branché**. À brancher : la création `Piece` / `PieceLien` (R5) puis la file de
  classement. `PIECE_DEPOSEE` n'est pas encore au `CATALOGUE` (`src/lib/events/catalogue.ts`) : l'y inscrire au
  branchement (il deviendra alors attendable par `WAIT_EVENT`).
