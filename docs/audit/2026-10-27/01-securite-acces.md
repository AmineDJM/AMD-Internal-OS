# Audit 27/10/2026 — 01 · Sécurité et contrôle d'accès

Périmètre : authentification et sessions, RBAC (`rbac.ts`, `UserAccess`, `RowGrant`, rôle secondaire), cloisonnement
multi-société, `canAccessEntity`, API agent `/api/v1`, routes API et actions serveur, téléversements et service des
fichiers, données sensibles (paie, IBAN, NIN), en-têtes, injection, SSRF, « Vue exacte ».
Base : `claude/hopeful-goodall-phd0nb` @ `456c8f6`. Branche : `audit/securite-acces`. Méthode : lecture du code
guidée par `docs/knowledge-base/02-auth-rbac-security.md` (dont chaque risque R1–R14 a été re-vérifié), puis
chaque constat **rejoué par un test sur la vraie base Postgres** (rouge avant, vert après) quand il a été corrigé.

---

## 1. Synthèse

**Note du périmètre : 6/10.** Les fondations sont bonnes et souvent exemplaires : session révocable relue à chaque
requête, accès effectif recalculé depuis la base, une seule porte d'ajout implicite (`grantImplicit`), cliquets de
garde, service de fichiers sous bac à sable, SQL brut paramétré partout, OnlyOffice durci (R2 corrigé). Le défaut
dominant n'est pas l'absence de garde, c'est la **garde à moitié** : le droit du MODULE est vérifié, l'appartenance
de l'OBJET (entité/société, propriétaire, cercle) ne l'est pas — surtout sur les **écritures** et sur l'**API agent**.
Dix constats CRITIQUE/HAUTE corrigés dans cette branche (un commit et un test chacun).

Les 3 risques majeurs (avant correctifs) :
1. **API agent `/api/v1` plus large que l'écran** : `?q=` écrasait la portée « mes lignes », les pièces des types
   hors registre (demandes RH, CV…) se téléchargeaient sans contrôle, notifications et tâches de tout le monde, la paie
   par `related`/`history` (SA-02 à SA-05).
2. **Écritures sans porte d'entité** : dossier RH, paie, livre comptable d'une autre société modifiables par
   identifiant (SA-09, SA-10 ; reste : ordres de dépense, événements, rapports terrain, dossiers Legal).
3. **Identité figée** : un compte désactivé (via Adam) restait connecté 30 jours, un Super Admin rétrogradé gardait
   la Vue exacte (SA-07) ; un membre des RH tranchait ses propres demandes (SA-06).

---

## 2. Constats

Préfixe `SECURITE-ACCES-` abrégé en `SA-`.

| ID | Sév. | Catégorie | Constat | Effort | Statut |
|---|---|---|---|---|---|
| SA-01 | HAUTE | sécurité (XSS) | `/api/onlyoffice/file` sert en ligne avec le type déclaré au dépôt | S | CORRIGÉ `c7a4fc0` |
| SA-02 | HAUTE | sécurité (fuite) | API v1 : contenu d'une pièce sans contrôle si son porteur n'est pas au registre | S | CORRIGÉ `bca3bd3` |
| SA-03 | HAUTE | sécurité (fuite) | API v1 : `?q=` écrase la portée par ligne (`{OR}` étalé sur `{OR}`) | S | CORRIGÉ `89917d9` |
| SA-04 | HAUTE | sécurité (fuite) | API v1 : notifications et tâches de toute l'entreprise | S | CORRIGÉ `aa4d695` + `98a584b` |
| SA-05 | HAUTE | données sensibles | API v1 : paie exposée par `related` (bulletins) et `history` (ancien/nouveau salaire) | S | CORRIGÉ `e2177b4` |
| SA-06 | HAUTE | intégrité / fraude | RH : on tranchait sa propre avance, note de frais, congé ; on réécrivait son congé décidé | S | CORRIGÉ `5fd642a` |
| SA-07 | HAUTE | auth / sessions | Compte désactivé toujours connecté ; Super Admin rétrogradé garde la Vue exacte ; Adam visualisable | S | CORRIGÉ `4a81141` |
| SA-08 | HAUTE | sécurité (contournement) | Annuaire de praticiens fermé : levée de la restriction par qui n'y est pas | S | CORRIGÉ `7b88150` |
| SA-09 | HAUTE | multi-société | Dossier RH et paie d'une autre société modifiables par identifiant | S | CORRIGÉ `cdca0f9` |
| SA-10 | HAUTE | multi-société | Livre comptable d'une autre société modifiable/supprimable ; création au nom d'une autre | S | CORRIGÉ `727e1df` |
| SA-11 | HAUTE | multi-société | Ordres de dépense : `settle/defer/resumeExpenseOrder` sans porte d'entité | S | CORRIGÉ `9a1f97c` |
| SA-12 | MOYENNE | sécurité (XSS) | Aperçu Word/Excel : HTML de mammoth / `sheet_to_html` injecté sans assainissement | S | CORRIGÉ `86250dd` |
| SA-13 | MOYENNE | multi-société | Événements : inscriptions et suppression sans `canAccessEntity` sur l'événement | S | CORRIGÉ `c94ec0d` |
| SA-14 | MOYENNE | multi-société | Fiches `/consulting/[id]` et `/ad-pro/autres/[id]` sans porte d'entité ; types absents de `AD_PRO_TYPES` | S | CORRIGÉ `2cf2591` |
| SA-15 | MOYENNE | API | Portée `erp.admin` jamais exigée (`user`, `audit_log`) | S | CORRIGÉ `ddb3847` |
| SA-16 | MOYENNE | multi-société | Rapports terrain (`canEdit`) et dossiers Legal/Courrier sans porte d'entité en écriture | S | CORRIGÉ `fd09f5a` |
| SA-17 | MOYENNE | auth | Portail fournisseur sans verrouillage ; `changePassword` sans limite d'essais | S | CORRIGÉ `d331835` |
| SA-18 | BASSE | droits | Un administrateur délégué s'attribue un siège au centre de paiement | S | CORRIGÉ `bc4840f` |
| SA-19 | BASSE | sécurité | Exports `"use server"` sans garde : `runPettyCashRechargeReminders`, `nextRechargeFor`, `ensureCycle` | S | PROPOSÉ (déjà R10) |
| SA-20 | BASSE | API | Idempotence : vérifier-puis-agir, clé indépendante de l'opération | S | PROPOSÉ |
| SA-21 | BASSE | données sensibles | Bac à SQL : masquage par nom de colonne de sortie (`SELECT iban AS x`) | M | PROPOSÉ |

### SA-01 — `/api/onlyoffice/file` : XSS stockée par le type déclaré (HAUTE) — CORRIGÉ `c7a4fc0`
- **Preuve** : `src/app/api/onlyoffice/file/route.ts:26-31,57-62` (avant) — `"Content-Type": doc.mimeType`, ni
  `Content-Disposition`, ni `entetesAntiExecution`. Le type stocké est le `file.type` du navigateur
  (`drive/upload/route.ts:83`, `attach-files.ts:96`). Le jeton de lecture (24 h) est remis au navigateur dans
  `document.url` (`onlyoffice-session.ts:73,90`). Toutes les autres routes de fichiers passent déjà par
  `repondreFichier`/`entetesAntiExecution` — celle-ci avait été oubliée (§118.71 : porte gardée à côté d'une porte ouverte).
- **Scénario** : un salarié dépose `rapport.docx` avec un type multipart forgé `text/html`, l'ouvre dans l'éditeur,
  copie `document.url` et l'envoie à un Super Admin → la page s'exécute dans l'origine de l'ERP (pas de `script-src`),
  avec sa session : actions serveur appelables.
- **Correctif** : `entetesServis()` — `Content-Disposition: attachment`, `nosniff`, et `CSP sandbox` pour un type actif.
  Test : `src/app/api/onlyoffice/file/fichier-actif.test.ts`.

### SA-02 — API v1 : pièces hors registre téléchargées sans contrôle (HAUTE) — CORRIGÉ `bca3bd3`
- **Preuve** : `src/app/api/v1/documents/[id]/content/route.ts:28-34` (avant) : `const def = ENTITIES.find(...); if (def) { …portée… }`
  — pas de `else`. Le registre connaît ~20 `EntityType` sur ~60.
- **Scénario** : une clé `erp.documents.read` au nom d'un délégué liste `entities/document?entityType=HR_REQUEST`
  puis télécharge attestations de salaire et arrêts maladie des collègues (idem CV de candidats, RIB de sociétés,
  pièces de validation).
- **Correctif** : `canAccessEntity(user, entityType, entityId, "VIEW")` exigé pour toute pièce, la portée du registre
  s'y ajoute. Test : `src/app/api/v1/documents/[id]/content/hors-registre.test.ts`.

### SA-03 — API v1 : la recherche `q` remplace la portée (HAUTE) — CORRIGÉ `89917d9`
- **Preuve** : `src/app/api/v1/entities/[entity]/route.ts:29-33` et `search/route.ts:46` (avant) :
  `{ ...porteeEntite(), ...parseFilters(), ...textSearchWhere() }`. `scopeMedicalVisits` rend `{ OR: [...] }`
  (`rbac.ts:2010`), `textSearchWhere` aussi (`query.ts:91`) → le second écrase le premier. C'est exactement le piège
  déjà documenté pour `companyScopedWhere` (§118.133/§118.184) ; `cibles/resoudre.ts` et `relire.ts` composaient déjà en `AND`.
- **Scénario mesuré** : clé au nom d'un délégué, `GET /api/v1/entities/medical_visit?q=e` → les comptes rendus de
  visite de tous les délégués (idem `sale`, `doctor`, `admin_request`, `/search`).
- **Correctif** : `{ AND: [portée, filtres, recherche] }` dans les 5 routes v1. Test : `src/app/api/v1/portee-recherche.test.ts`.

### SA-04 — API v1 : notifications et tâches de tout le monde (HAUTE) — CORRIGÉ `aa4d695`, `98a584b` (clause tâche déplacée dans `portee.ts` : le socle ne connaît pas les domaines)
- **Preuve** : `src/lib/api/registry/entities.ts` — `notification` et `task` en `scope: moduleOnly`, alors que tous les
  rôles ont `NOTIFICATIONS` et `WORKSPACE`.
- **Scénario** : `GET /api/v1/entities/notification?limit=500` → titres, corps et liens des notifications de toute
  l'entreprise (validations attendues, décisions RH…).
- **Correctif** : notification → `{ userId: user.id }` ; tâche → `clauseTachesVisibles` (la clause de la recherche
  globale, jumelle de `canSee`). Test : `src/app/api/v1/objets-personnels.test.ts`.

### SA-05 — API v1 : la paie par les relations et l'historique (HAUTE) — CORRIGÉ `e2177b4`
- **Preuve** : `CHAMPS_JAMAIS_EXPOSES` (`query.ts:109`) ne couvrait que le salaire de base ; `employee.related.payrolls`
  rendait `gross/net/bonuses/deductions` ; la fiche rendait `retIrg/retSS9/retSS35/tfp` (assez pour recalculer le
  salaire) et `birthDate` ; `history` rendait `oldValue/newValue` des changements de `baseSalary`
  (journalisés par `recordFieldChanges`, `hr-actions.ts:211-215`). À l'écran, la paie est réservée à `voitLesSalaires`.
- **Correctif** : liste fermée étendue (noms vérifiés uniques aux modèles de paie) ; valeurs d'audit masquées quand
  `champJamaisExpose(field)`. Test : `src/app/api/v1/paie-jamais-exposee.test.ts`.
- **Reste** (PROPOSÉ) : `department/:id/related → members` rend encore `address`/`phone` des salariés — donner à
  `related` une projection par relation (voir §3).

### SA-06 — RH : décider sa propre demande (HAUTE) — CORRIGÉ `5fd642a`
- **Preuve** : `decideAdvance` (`hr-actions.ts:659`), `decideExpenseReport` / `decideHrLeave`
  (`hr-document-actions.ts:631,680`), `updateLeaveRequest` (`hr-actions.ts:571`) : seul le droit RH était lu. La règle
  existait pour le circuit de congé (`approval-chain.ts:73`).
- **Scénario** : un membre des RH demande une avance (libre-service) et l'accorde → ordre de dépense émis sans second
  regard ; ou il remet un congé annuel déjà accordé à `days=0` → solde recrédité.
- **Correctif** : règle pure `src/lib/hr/decision-sur-soi.ts` appliquée aux 4 actions. Test : `src/lib/hr/decision-sur-soi-flow.test.ts`.

### SA-07 — Session : compte désactivé, Super Admin rétrogradé, compte système (HAUTE) — CORRIGÉ `4a81141`
- **Preuve** : `build()` (`session.ts:117-123`) ne relisait que `revokedAt/expiresAt` ; `toggleUserActive`
  (`admin-actions.ts:62-85`, opération d'Adam `set_account_active`) ne révoque rien ; la Vue exacte se décidait sur
  `session.user.role` (JWT figé au login, `session.ts:154`, `impersonation-actions.ts:16`) ; aucune garde sur
  `isSystem`. (KB R4, R5 — toujours ouverts au 27/10.)
- **Scénario** : un salarié désactivé par Adam reste connecté jusqu'à 30 jours ; un ex-Super Admin lit l'OS comme
  n'importe quel compte et crée des demandes en son nom.
- **Correctif** : le compte est relu dans la même requête que la session (jointure `user{isActive, role}`) ; inactif →
  pas de session ; Vue exacte sur le rôle en base ; `startImpersonation` lit `getCurrentUserPourEcrire()` et refuse
  `isSystem`. Test : `src/lib/session-compte-vivant.test.ts`. Coût : zéro requête de plus.

### SA-08 — Annuaire de praticiens fermé (HAUTE) — CORRIGÉ `7b88150`
- **Preuve** : `setDirectoryAccess` (`medical-directory-crud-actions.ts:149`) et 6 autres écritures : seul
  `MEDICAL:UPDATE` ; la règle de lecture `ouvreAnnuaireNomme` (`queries/annuaires.ts:46`) n'était pas appliquée.
- **Scénario** : un NATIONAL_SALES absent de la liste « Infectiologues » envoie une liste vide → restriction levée,
  il lit tous les praticiens ; ou il s'y met seul et en ferme la porte aux autres.
- **Correctif** : `annuaireOuvert()` (règle de la feuille + entité) devant toute écriture. Test : `src/lib/medical/annuaire-ferme-ecriture.test.ts`.

### SA-09 — Dossier RH et paie d'une autre société (HAUTE) — CORRIGÉ `cdca0f9`
- **Preuve** : `deleteEmployeeDocument`, `setEmployeeDocumentVisibility` (`hr-document-actions.ts:928,953`),
  `markSalaryPaid`, `unmarkSalaryPaid`, `updatePayrollEntry` (`payroll-hr-actions.ts:105,171,470`),
  `POST /api/rh/upload` : aucun `entitePermisePourFiche`, alors que la fiche, `updateEmployee` et le téléchargement
  l'appliquent (et que le même fichier l'applique déjà à `:398`). L'upload ne vérifiait pas non plus que `requestId`
  appartient au salarié.
- **Correctif** : porte de la fiche sur les 6 points d'entrée. Test : `src/lib/hr/fiche-rh-entite-ecriture.test.ts`.
  Le banc `centre-paie-caisse-flow.test.ts` faisait saisir par la RH de A la paie d'un salarié de B (témoin) : la
  ligne est désormais posée en base et le refus vérifié.

### SA-10 — Livre comptable d'une autre société (HAUTE) — CORRIGÉ `727e1df`
- **Preuve** : `updateTransactionStatus`, `updateTransaction`, `deleteTransaction` (`finance-actions.ts:79,99,139`)
  écrivent `where: { id }` ; `createTransaction` prend `companyId` du formulaire sans `entiteOuverte` (que
  `createTreasuryAccount` applique). `deleteTransaction` délie en plus la paie liée.
- **Correctif** : `ecritureVisible()` (porte de la fiche) et `entiteOuverte` à la création. Test :
  `src/lib/finance/ecriture-entite-ecriture.test.ts`.

### SA-11 — Ordres de dépense sans porte d'entité (HAUTE) — CORRIGÉ `9a1f97c`
- **Preuve** : `expense-actions.ts:71` `settleExpenseOrder`, `:437` `deferExpenseOrder`, `:486` `resumeExpenseOrder` :
  `userCan(FINANCES, UPDATE)` puis écriture par id. Le centre de paiement liste avec `ficheScopedWhere`.
- **Correctif** : même `entitePermisePourFiche(user.id, order.companyId)` que SA-10. Non fait ici : ces fonctions
  sont au cœur du circuit d'argent (§118.176) et méritent leur propre banc multi-société.

### SA-12 — Aperçu Office : HTML non assaini (MOYENNE) — CORRIGÉ `86250dd`
- **Preuve** : `src/components/documents/office-viewers.tsx:49,60,78,98` — `mammoth.convertToHtml` et
  `XLSX.utils.sheet_to_html` → `dangerouslySetInnerHTML`, sans assainisseur (mammoth le documente) ; pas de `script-src`.
- **Scénario** : un `.docx` porte un lien `javascript:` ; un collègue l'ouvre en aperçu et clique.
- **Correctif** : DOMPurify (`ALLOWED_URI_REGEXP` http/https/mailto) avant injection, ou rendu dans un `<iframe sandbox>`.

### SA-13 — Événements (MOYENNE) — CORRIGÉ `c94ec0d`
- **Preuve** : `event-actions.ts:434` `addRegistration`, `:456` `setRegistrationStatus`, `:488` `deleteRegistration`,
  `:298` `deleteEvent` — `userCan(EVENTS, …)` seul ; `updateEvent` (`:214`) applique `canAccessEntity`.
- **Correctif** : résoudre `eventId` et exiger `canAccessEntity(user, "EVENT", eventId, "UPDATE"|"DELETE")`.

### SA-14 — Fiches consulting / Ad & Pro « autres » d'une autre société (MOYENNE) — CORRIGÉ `2cf2591`
- **Preuve** : `src/app/(app)/consulting/[id]/page.tsx:59-70` et `ad-pro/autres/[id]/page.tsx:41-45` :
  `findUnique({ where: { id } })` après `requireModule`, listes filtrées par entité. `AD_PRO_TYPES`
  (`entity-access.ts:150`) n'inclut ni `AD_PRO_OTHER` ni `CONSULTING_CONTRACT` → leurs pièces aussi.
- **Correctif** : `ficheScopedWhere` dans les deux pages ; ajouter les deux types au contrôle d'entité de `canAccessEntity`.

### SA-15 — `erp.admin` jamais exigé (MOYENNE) — CORRIGÉ `ddb3847`
- **Preuve** : `grep erp.admin src` ne trouve que `scopes.ts` et des commentaires ; `entities.ts:437` dit « l'exposer
  demande la portée `erp.admin` ». Une clé `erp.read` au nom d'un détenteur d'`ADMIN:VIEW` liste comptes et journal d'audit.
- **Correctif** : champ `porteeRequise?: Scope` sur `EntityDef` (`"erp.admin"` pour `user`/`audit_log`), lu par les
  4 routes de lecture via `requireScopes`.

### SA-16 — Rapports terrain, dossiers Legal/Courrier (MOYENNE) — CORRIGÉ `fd09f5a`
- **Preuve** : `field-report-actions.ts:32` `canEdit` (managers : `FIELD_REPORTS:VIEW` suffit, toute société) ;
  `legal-folder-actions.ts:62,108`, `mail-folder-actions.ts:63,106` (création vérifie l'entité, modification/suppression non).
- **Correctif** : `entitePermisePourFiche` / `companyAllowed` sur l'objet relu.

### SA-17 à SA-21 (BASSE/MOYENNE, déjà connus ou mineurs) — SA-17 CORRIGÉ `d331835`, SA-18 CORRIGÉ `bc4840f` ; SA-19 à SA-21 PROPOSÉ (BASSE)
- **SA-17** (R6/R14) : `supplierLogin` (`supplier-portal-actions.ts:10-27`) sans `checkLockout`/`recordFailure` ;
  `changePassword` (`auth-actions.ts:51`) sans limite et sur `auth()` brut. Réutiliser `login-throttle.ts` avec une clé
  `portail:<email>` / `mdp:<userId>`.
- **SA-18** (R7) : `grant/revokePaymentCentreSeat` (`payment-centre-seat-actions.ts:49-122`) sans `refusAdministration`.
- **SA-19** (R10) : `petty-cash-actions.ts:631,656`, `sales-planning-actions.ts:48` — sortir dans un module sans `"use server"`.
- **SA-20** : `lib/api/http.ts:63-92` — inclure l'opération dans `requestHash` ; réserver la clé par `create` avant d'exécuter.
- **SA-21** : `lib/sandbox/sql.ts:119-122` — retirer `Employee` des tables autorisées ou passer par une vue sans colonnes sensibles.

### Recoupements avec les autres audits du 27/10 (fusion de la base `2562b38`)
- **SA-02** : la base a corrigé le même défaut en parallèle (`api/registry/document-lisible.ts`). La fusion garde
  sa fonction, composée en `AND` comme SA-03 l'exige (elle étalait encore la portée).
- **SA-06** : l'audit RH-DOCUMENTS-COMMS-03/04 a posé sa propre garde « sur soi » (et d'entité) sur
  `decideExpenseReport`, `decideHrLeave` et `updateLeaveRequest` ; la fusion la retient et retire le doublon.
  `decideAdvance` (avance sur salaire → ordre de dépense) n'était couvert que par SA-06 : il garde `refusDecisionSurSoi`.
- **SA-10** : la base a ajouté un verrou de règlement (`reglementPorte`) aux mêmes écritures ; les deux s'appliquent
  (porte d'entité d'abord).

### Re-vérification des risques de la base de connaissances (02 §8.3)

| KB | Statut au 27/10 |
|---|---|
| R1 XSS par téléversement | Corrigé sur `/api/documents`, Drive, pièces (via `types-actifs.ts`) — **sauf** `/api/onlyoffice/file` → SA-01 |
| R2 OnlyOffice callback/SSRF | **Corrigé** (`lireRappelOnlyoffice` : jeton dédié, corps signé obligatoire, hôte = `ONLYOFFICE_URL`) |
| R3 API v1 pièces hors registre | Ouvert → **SA-02 corrigé** |
| R4 Super Admin rétrogradé | Ouvert → **SA-07 corrigé** |
| R5 `toggleUserActive` | Ouvert → **SA-07 corrigé** (par `build()`, quel que soit l'écrivain) |
| R6 portail sans verrouillage | Ouvert → SA-17 |
| R7 siège auto-attribué | Ouvert → SA-18 |
| R8 middleware mort | Inchangé (voir §3) |
| R9 verrouillage par e-mail seul | Inchangé |
| R13 modules masqués | Pages corrigées ; actions/API non (choix assumé : masquer ≠ interdire) |
| R14 | Inchangé → SA-17 |

### À vérifier (soupçons non confirmés)
- `microsoft-mail-actions.ts:273` `linkMessageToEntity` : lien posé sur n'importe quel `entityType/entityId` sans `canAccessEntity` (lecteurs de `mailLink` non tracés).
- `processHrRequest` (`hr-document-actions.ts:584`) : statut libre du formulaire, sans contrôle « sur soi » ni entité.
- `deleteDoctor` (`medical-actions.ts:490`) : `MEDICAL:DELETE` sans `scopeMedicalDoctors` (seul un DELETE accordé en console avec portée ASSIGNED l'expose).
- `deciderVisaCentreAdPro` (`ad-pro-centre-actions.ts:41`) : auto-décision d'un membre du centre non confirmée.
- `api/artifact/[id]/image` : type `r.mime` servi en ligne sans `entetesAntiExecution` — origine du type (`lireImage` lit l'en-tête binaire) à confirmer.
- `api/replay` : `sessionId` choisi par le client (injection d'événements dans le replay d'une autre session).
- Coexistence d'une CSP de route (`sandbox`) avec la CSP globale de `next.config.mjs` (deux en-têtes → intersection, ce qui est sûr, mais non mesuré en production).

---

## 3. Restructuration proposée

### 3.1 Le défaut à éliminer : « droit du module » ≠ « droit sur l'objet »
Neuf des dix corrections sont la même faute : une action relit `userCan(module)` puis écrit `where: { id }`. La base a
déjà les bonnes briques (`canAccessEntity`, `entitePermisePourFiche`, `scope*`, `clauseTachesVisibles`), mais rien
n'oblige à les appeler. Cible : **une seule porte d'écriture par objet**, impossible à contourner par oubli.

```
src/lib/acces/
  objet.ts          // ouvrirPourEcrire(user, type, id, action) → { ok, ligne } | { ok:false, error }
                    //   = userCan(module) ∧ canAccessEntity ∧ entitePermisePourFiche(ligne.companyId)
  regles/           // une règle PURE par famille (sans import) : decision-sur-soi.ts, annuaire.ts, …
  compose.ts        // et(...clauses) : composition AND — l'étalement de clauses Prisma est interdit
```

Signature :
```ts
export async function ouvrirPourEcrire<T extends EntityType>(
  user: SessionUser, type: T, id: string, action: "UPDATE" | "DELETE" | "VALIDATE",
): Promise<{ ok: true; companyId: string | null } | { ok: false; error: string }>;

// dans une action :
const porte = await ouvrirPourEcrire(user, "FINANCE_TRANSACTION", id, "UPDATE");
if (!porte.ok) return porte;
```

### 3.2 API agent : le registre décrit la sécurité, il ne la suppose pas
- `EntityDef.scope` devient **obligatoire** : `moduleOnly` disparaît au profit de `portee: "module-assume"` explicite,
  justifié par un commentaire, et listé par un test (aujourd’hui 20 entités).
- `EntityDef.porteeRequise?: Scope` (SA-15), `EntityDef.champs: { liste, fiche, relations: Record<string, string[]> }`
  (projection par relation, SA-05 reste).
- Une seule fonction `whereApi(user, def, ...clauses)` qui compose en `AND` — les routes n'écrivent plus de `where`.

### 3.3 Le middleware mort (R8)
Ne **pas** le déplacer tel quel dans `src/` (casserait `/api/v1`, `/invite`, `/api/mail/inbound`, `/api/google/pubsub`,
`/api/events/inbound`). Étapes : (1) compléter la liste publique d'`auth.config.ts` avec ces 5 préfixes + un cliquet
qui la compare aux routes sans session ; (2) mettre le middleware en mode « journal seulement » une semaine ;
(3) l'activer. Gain : une défense en profondeur pour toute nouvelle page/route oubliée.

### Chemin de migration (petites étapes sûres)
1. `compose.ts` + règle ESLint (ci-dessous) — aucun changement de comportement.
2. `ouvrirPourEcrire` + migration domaine par domaine, en commençant par l'argent (SA-11), puis événements, rapports terrain, Legal.
3. Registre API à portée obligatoire ; projections par relation.
4. Middleware (3.3).

Gain : la question « cette action vérifie-t-elle l'objet ? » se lit en une ligne, et un cliquet peut la poser à 1 166 actions.

---

## 4. Bonnes pratiques à graver

1. **Cliquet « écriture par identifiant »** (test à la manière de `client-bundle-guard`) : dans tout fichier
   `"use server"`, un `prisma.<m>.(update|delete|updateMany|deleteMany)({ where: { id` doit être précédé, dans la
   même fonction, d'un appel à `ouvrirPourEcrire`/`canAccessEntity`/`entitePermisePourFiche`/`scope*`/garde locale
   déclarée. Liste d'exceptions versionnée et commentée.
2. **Lint « pas d'étalement de clause »** : `no-restricted-syntax` sur `SpreadElement` dont l'argument est un appel à
   `scope*`, `porteeEntite`, `textSearchWhere`, `companyScopedWhere` dans un objet `where` — imposer `{ AND: [...] }`.
3. **Toute réponse binaire passe par `repondreFichier`** : cliquet qui interdit `new NextResponse(<octets>` dans
   `src/app/api/**` hors d'une liste de routes à type fixe (exports xlsx/pdf générés).
4. **API : registre testé contre le schéma** — test qui échoue si un modèle portant `userId`/`assignedToId`/
   `companyId` est déclaré `module-assume` sans justification, et qui vérifie que chaque champ de `CHAMPS_JAMAIS_EXPOSES`
   existe encore dans `schema.prisma` (une liste de noms qui ne vérifie rien ne protège rien).
5. **« On ne tranche pas sa propre demande »** : toute action `decide*`/`approve*`/`validate*` lit `refusDecisionSurSoi`
   (ou `canDecideChain`) — cliquet textuel sur les noms d'actions.
6. **Identité vivante** : interdiction d'`auth()` brut hors `session.ts`, `auth-actions.ts` (login/logout) et des
   routes de télémétrie listées — tout le reste passe par `getCurrentUser*` (cliquet).
7. **Bancs multi-société** : un test d'écriture ajoute toujours une société B et un acteur limité à A (modèle :
   `fiche-rh-entite-ecriture.test.ts`), avec un « témoin » qui prouve que l'acteur a bien le droit du module.
