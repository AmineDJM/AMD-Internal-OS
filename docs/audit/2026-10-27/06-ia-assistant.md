# Audit 27/10/2026 — 06 · IA : Assistant IA, Adam, agents, missions, plateforme

Périmètre : `src/lib/agent/**` (Assistant IA, Mastra sur MiMo), `src/app/(app)/assistant/**`, `src/app/api/assistant-ia/**`,
`src/lib/actions/assistant-ia-actions.ts`, `src/lib/assistant.ts` + `src/lib/assistant/**` (Adam), Mission Runtime
(`src/lib/missions`, `src/platform/in-process/missions`), `src/platform/*` (frontière, contrat, carte des domaines).
Base : `claude/hopeful-goodall-phd0nb` @ `456c8f6`. Branche : `audit/ia-assistant`.
Méthode : lecture du code, scanner de frontière (`npm run adam:boundary`), tests locaux sur Postgres local
(`amd_internal_os`). **Aucun modèle payant n'a été appelé** : les bancs utilisent le faux modèle (`agent/testing/modele-factice.ts`)
et des lecteurs d'interrupteur injectés.

---

## 1. Synthèse

**Note du périmètre : 6,5 / 10.** Le *mécanisme* est de très bonne facture : écritures jamais exécutées par le modèle
(intention persistée → carte → confirmation → action de l'écran, réclamation atomique, reçu), RBAC à trois verrous, filtre de
confidentialité appliqué avant le modèle (y compris sur les documents résumés par parties), routines sans aucun outil
d'écriture, fil gardé avec prise exclusive et reprise. Ce qui coûte des points, c'est que **l'Assistant IA — le produit ouvert
à d'autres personnes que le Super Admin — vit hors de toutes les protections d'exploitation que l'ERP a construites pour Adam** :

1. **Interrupteurs ignorés** (corrigé) — l'interrupteur général et l'arrêt d'urgence ne coupaient pas l'Assistant IA : des
   données partaient chez MiMo (fournisseur tiers) et des actions confirmées s'exécutaient sous un « tout est coupé ».
2. **Zéro observabilité et zéro plafond de coût** — aucun appel MiMo n'est journalisé (`AiUsageLog`/`ModelCallLog`), et un seul
   message en arrière-plan peut consommer ≈ 220 k jetons d'entrée (24 étapes × ≈ 9 k jetons fixes), dix en file par personne.
3. **Un produit sans frontière mesurée** — `src/lib/agent/` n'est ni dans `ADAM_PATHS` ni dans la carte des domaines : il importe
   le god-file d'Adam (`assistant.ts`, 7 310 lignes, « en pause ») et ses ops sans qu'aucun cliquet ne le voie, pendant que les
   cliquets existants sont rouges (frontière 430 > 425, domaines 71 > 68).

Constats : **0 critique · 4 hautes · 6 moyennes · 3 basses.** Correctifs commités : 3 (IA-ASSISTANT-01, -02, -04).

---

## 2. Constats

| ID | Sév. | Catégorie | Titre | Effort | Statut |
|---|---|---|---|---|---|
| IA-ASSISTANT-01 | HAUTE | sécurité / conformité | L'interrupteur général de l'IA ne coupe pas l'Assistant IA (MiMo) | S | **CORRIGÉ** `8260089` |
| IA-ASSISTANT-02 | HAUTE | sécurité | L'arrêt d'urgence des actions de l'IA n'arrête pas le registre de l'Assistant IA | S | **CORRIGÉ** `e4b3c8c` |
| IA-ASSISTANT-03 | HAUTE | coûts / observabilité | Aucun journal d'usage ni plafond pour MiMo ; un message peut coûter ≈ 220 k jetons | M | **CORRIGÉ** (V3-D) |
| IA-ASSISTANT-04 | MOYENNE | intégrité / UX | Plusieurs cartes préparées dans un tour : une seule visible, les autres orphelines | S | **CORRIGÉ** `d171883` |
| IA-ASSISTANT-05 | HAUTE | maintenabilité / architecture | L'Assistant IA n'est couvert par aucun cliquet d'architecture et dépend du god-file d'Adam | M | PROPOSÉ |
| IA-ASSISTANT-06 | MOYENNE | robustesse | Fil gardé : un tour qui lève est rejoué à chaque battement, sans compteur d'essais | S | **CORRIGÉ** (V3-D) |
| IA-ASSISTANT-07 | MOYENNE | intégrité | Une intention `EXECUTING` interrompue reste bloquée pour toujours ; `EXPIRED` n'est jamais écrit | M | **CORRIGÉ** (V3-D) |
| IA-ASSISTANT-08 | BASSE | maintenabilité | `agent.ts` (`creerAgent`, `repondre`) n'a aucun appelant de production (§118.14) | S | **CORRIGÉ** (V3-D) |
| IA-ASSISTANT-09 | MOYENNE | confidentialité | Le message saisi et l'historique du fil partent à MiMo sans le filtre de confidentialité | S | **CORRIGÉ** (V3-D, option prudente, réglable) |
| IA-ASSISTANT-10 | MOYENNE | intégrité | Le retrait des cartes caduques (défaut mesuré chez Adam) n'existe pas dans l'Assistant IA | S | **CORRIGÉ** (V3-D, option prudente, réglable) |
| IA-ASSISTANT-11 | MOYENNE | architecture | Frontière Adam ↔ ERP à 430 (> 425) et domaines à 71 (> 68) : chemin chiffré pour repasser sous les plafonds | M | PROPOSÉ |
| IA-ASSISTANT-12 | BASSE | observabilité | Le journal d'usage d'Adam écrit `provider: "openai"` en dur | S | **CORRIGÉ** (V3-D) |
| IA-ASSISTANT-13 | BASSE | maintenabilité | Clé MiMo lue aussi sous le nom `mimo` (minuscules) | S | **CORRIGÉ** (V3-D) |

---

### IA-ASSISTANT-01 — L'interrupteur général de l'IA ne coupe pas l'Assistant IA · HAUTE · **CORRIGÉ `8260089`**

- **Preuve** : avant correctif, aucun fichier de `src/lib/agent/` ni de `src/app/(app)/assistant/` ne lisait `interrupteurIaCoupe`
  ni `aiFeatureEnabled` (`rg "interrupteurIaCoupe|aiFeatureEnabled" src/lib/agent` → vide). Les deux seules portes vers MiMo :
  `src/lib/agent/repondre.ts` (`repondreAvecSecours`, `new Agent(…)` puis `agent.generate/stream`) et `src/lib/agent/generer.ts`
  (`genererTexte`). L'en-tête de `src/lib/ai-settings.ts` liste ce que l'interrupteur « ne coupe pas encore » sans même nommer l'Assistant IA.
- **Scénario** : la Direction coupe l'IA (Administration › Contrôle de l'IA — « Toute l'IA est coupée »). Une assistante de direction
  dépose un PDF de contrat et demande un résumé : `envoyerAuFil` → `traiterFil` → `jouerTour` → `repondreAvecSecours` → le texte part
  chez MiMo. Les routines programmées continuent à tourner chaque matin (`executerRoutinesDues` → `passageDeRoutine`).
- **Correctif** : `repondreAvecSecours` lit `interrupteurIaCoupe()` avant toute construction d'agent et lève `IaCoupee`
  (message = `REFUS_IA_COUPEE`), que `jouerTour` rend tel quel ; `genererTexte` rend `{ ok:false, raison: REFUS_IA_COUPEE }`.
  Banc `src/lib/agent/interrupteur.test.ts` : coupé → modèle jamais appelé ; rallumé → passe et l'interrupteur a été lu ; **cliquet** :
  tout fichier de l'Assistant IA qui contient `new Agent(` doit lire l'interrupteur (seule exception nommée : `agent.ts`, cf. -08).
  Échoue avant (4/4), passe après.

### IA-ASSISTANT-02 — L'arrêt d'urgence n'arrête pas les opérations de l'Assistant IA · HAUTE · **CORRIGÉ `e4b3c8c`**

- **Preuve** : `src/lib/assistant.ts:6107-6118` — `performAction` refuse toute action `external` quand
  `AppSetting.aiExternalActionsDisabled`. `src/lib/agent/operations/index.ts` (`executerOperationIA`) n'en lisait rien, alors que
  `confirmerIntentionAssistantIA` (`src/lib/actions/assistant-actions.ts:323`) y aiguille toute charge `assistant_ia_op`.
- **Scénario** : incident (l'IA prépare des demandes erronées) → le Super Admin lève l'arrêt d'urgence. Un délégué clique « Confirmer »
  sur une carte « Créer la demande de sponsoring » ou « Envoyer la relance » préparée plus tôt : la demande est créée, le valideur relancé,
  le rendez-vous envoyé aux invités. L'arrêt d'urgence ne valait que pour Adam (Super Admin seul).
- **Correctif** : `executerOperationIA` lit `getAppSettings()` (même lecture que `performAction`) avant d'exécuter et rend
  `REFUS_ARRET_URGENCE`. Les écritures V1 (`create_task`, `send_message`) passaient déjà par `performAction`. Banc
  `src/lib/agent/operations/arret-urgence.test.ts` (réglages simulés, la ligne `AppSetting` n'est jamais touchée) : échoue avant, passe après.

### IA-ASSISTANT-03 — Aucun journal d'usage ni plafond de coût pour MiMo · HAUTE · PROPOSÉ (M)

- **Preuve** : `rg "logAiUsage|recordModelCall" src/lib/agent` → vide ; MiMo est appelé par Mastra en direct (`modele.ts`, `repondre.ts`),
  hors passerelle (`src/lib/models/gateway.ts`) donc hors `ModelCallLog`. Bornes actuelles : `ETAPES_FOND = 24`,
  `DELAI_FOND_MS = 240 000`, `MAX_EN_FILE = 10` (`fil/service.ts:39-44`), routines 10 actives × `maxEtapes: 10`
  (`routines/passage.ts`), résumé de document jusqu'à 14 appels `genererTexte` séquentiels (`documents-lus.ts:88-111`).
  **Mesuré** (Super Admin, base locale) : 38 outils offerts, schémas = 30 079 caractères, prompt système = 6 101 caractères →
  ≈ 9 000 jetons d'entrée **fixes** renvoyés à chaque étape.
- **Scénario** : « fais le point complet sur mes dossiers » en arrière-plan → 24 étapes × ≥ 9 k = **≥ 216 k jetons d'entrée** pour un
  message (plus les sorties d'outils qui s'accumulent) ; dix messages en file = > 2 M jetons, sans qu'aucune ligne n'en garde trace et sans
  plafond journalier par personne. L'écran « Contrôle de l'IA » montre la consommation d'Adam, jamais celle de l'Assistant IA.
- **Correctif proposé** :
  1. `src/lib/agent/repondre.ts` : lire `r.usage`/`steps[].usage` de Mastra et appeler `logAiUsage({ feature: "assistant_ia", provider: "mimo", model, userId, inputTokens, outputTokens, ok, ms })`
     (élargir `AiUsageInput.provider` et ajouter la fonction `assistant_ia` à `AiFeature` + sa bascule à l'écran, cliquet `ai-settings.test.ts`).
  2. Plafond par personne et par jour (`AI_ASSISTANT_IA_TOKENS_JOUR`, défaut prudent) lu dans `repondreAvecSecours` — même place que
     l'interrupteur — avec un refus qui nomme le remède (§118.30).
  3. Réduire le fixe : offrir les outils par intention (`fitToolBudget` d'Adam existe déjà) au lieu des 38 à chaque étape.

### IA-ASSISTANT-04 — Plusieurs cartes dans un tour : une seule visible · MOYENNE · **CORRIGÉ `d171883`**

- **Preuve** : `src/lib/agent/fil/tour.ts` — `const p = propositions[0]` ; seule celle-ci est rendue (`intent`) et gardée sur le tour du fil.
  Les outils `create_task`/`send_message` (`outils-v1.ts`), toutes les opérations (`operations/index.ts`) et `mes_brouillons › reprendre`
  (`lectures.ts`) poussent chacun dans `propositions` et persistent une intention `PROPOSED`.
- **Scénario** : « relance Karim sur la demande SP-0142 et prends rendez-vous avec le Dr Benali jeudi » → deux appels `preparer_*` dans le
  même tour (la consigne du fil pousse à « enchaîner ») → deux intentions en base, une carte à l'écran ; le modèle annonce les deux.
  La seconde n'a jamais d'identifiant côté écran : elle ne se confirme pas, ne s'annule pas, et ressort plus tard dans « mes brouillons ».
- **Correctif** : `REFUS_SECONDE_CARTE` — le second geste est refusé **avant** d'être préparé (rien n'est écrit), avec la consigne de le
  reporter au tour suivant. Banc `operations/une-carte-par-tour.test.ts` : échoue avant (2 cas clés), passe après.
  *Alternative ultérieure* : rendre `intents[]` (UI multi-cartes) ; le refus reste le garde-fou tant que l'écran n'en montre qu'une.

### IA-ASSISTANT-05 — L'Assistant IA hors de tout cliquet, adossé au god-file d'Adam · HAUTE · PROPOSÉ (M)

- **Preuve** : `src/platform/boundary-scan.ts:33-51` (`ADAM_PATHS`) et `src/platform/domains.ts:71` (domaine `adam`) ignorent
  `src/lib/agent/`. Pourtant `src/lib/agent` importe Adam dans 17 fichiers : `@/lib/assistant` (`assistantToolsFor`, `buildProposal`,
  `executeReadTool` — `outils-v1.ts:5`), `@/lib/assistant/ops/impl-wave8-files` (`operations/pieces.ts:7`, avec un `import "@/lib/assistant"`
  d'ordre de chargement), `power-tools` ×15, `action-intents` ×2, `workspace/protocol` ×4. Seuls `beta/actions.ts` (4) et `page.tsx` (2) sont
  comptés — comme des dettes *d'Adam*, alors qu'ils sont l'Assistant IA.
- **Scénario** : la propriété que la frontière protège — « arracher Adam = supprimer `assistant/`, `models/`, `in-process/` » — est fausse :
  l'Assistant IA (produit actif, multi-utilisateur) casserait. Inversement, une modification d'Adam « en pause » (ex. `buildProposal`,
  `assistantToolsFor`) change le comportement de l'Assistant IA sans qu'aucun test d'architecture ne s'allume.
- **Correctif proposé** : voir §3 (déclarer le domaine `assistant-ia`, extraire le noyau partagé `intentions/` hors d'Adam, cliquet de
  couplage inverse).

### IA-ASSISTANT-06 — Fil gardé : rejeu infini d'un tour qui lève · MOYENNE · PROPOSÉ (S)

- **Preuve** : `src/lib/agent/fil/service.ts` — `jouerTourDuFil` passe le message en `EN_COURS` puis appelle `jouerTour` ; une exception
  hors du `try` de `jouerTour` (ex. `piecesDuMessage` → Prisma, `findUniqueOrThrow`, `finir`) remonte, `traiterFil` relâche la prise
  (`finally`) et avale l'erreur. Au battement suivant, `reprendreLesFils` trouve un tour `EN_COURS` sous une prise nulle, le remet
  `EN_ATTENTE` et relance — **sans compteur d'essais**, chaque minute, en créant une nouvelle réponse `ECHEC` à chaque passage, et en
  rappelant le modèle si l'exception survient après lui.
- **Correctif** : colonne additive `AssistantIaTour.essais INT DEFAULT 0` (migration SQL idempotente), incrémentée dans `jouerTourDuFil` ;
  au-delà de 3, le tour passe `ECHEC` avec « La demande a échoué trois fois — reformulez-la » et le fil continue au suivant.
  Test : un `jouerTour` qui lève → après 3 battements, plus aucune relance.

### IA-ASSISTANT-07 — `EXECUTING` bloqué pour toujours ; `EXPIRED` jamais écrit · MOYENNE · PROPOSÉ (M)

- **Preuve** : `src/lib/assistant/action-intents.ts:243-273` — réclamation `PROPOSED|CONFIRMED|FAILED → EXECUTING`, reçu écrit après
  `run`. Rien dans `src/` ne récupère une intention restée `EXECUTING` (redémarrage pendant l'action) : chaque clic répond « déjà en
  cours » indéfiniment. L'état `EXPIRED` est déclaré (`:23`, `:32`, `:236`) mais **aucun code ne l'écrit** (§118.45 inversé) : une carte
  `PROPOSED` reste exécutable sans limite d'âge — le fil en affiche 80 tours, `mes_brouillons` en réaffiche jusqu'à 30 jours.
- **Scénario** : un BC préparé depuis un devis il y a trois semaines est confirmé aujourd'hui depuis l'historique du fil ; l'action de
  l'écran revalide les droits, mais pas que la personne veut encore *ce* devis à *ce* prix.
- **Correctif** : (a) balayage dans `runScheduledJobs` : `EXECUTING` depuis > 15 min → `FAILED` avec « interrompue — vérifiez le résultat
  avant de relancer » (jamais de rejeu automatique) ; (b) `PROPOSED` de plus de 24 h → `EXPIRED` (l'état existe déjà), refus dit dans
  `executeIntentGuarded`. Tests : horloge injectée.

### IA-ASSISTANT-08 — `agent.ts` sans appelant de production · BASSE · PROPOSÉ (S)

- **Preuve** : `rg "creerAgent|@/lib/agent/agent\"" src` → seulement `agent.test.ts`. Le vrai tour construit son agent dans
  `repondre.ts`. Deux constructions d'agent divergent (`maxSteps` 5 vs 8, pas de délai dans `repondre()` d'`agent.ts`).
- **Correctif** : supprimer `agent.ts` ou faire de `repondreAvecSecours` son unique utilisateur ; retirer alors l'exception du cliquet de -01.

### IA-ASSISTANT-09 — Le message et l'historique du fil ne passent pas le filtre de confidentialité · MOYENNE · PROPOSÉ (décision)

- **Preuve** : `fil/service.ts` (`pourHistorique`, `precedents`) et `fil/tour.ts` (`message`) transmettent le texte brut à
  `repondreAvecSecours`. L'ancienne couche de contexte censurait l'historique (`contexte.ts`, `chargerMessagesConversation` → `censurerTexte`),
  et l'en-tête du fil promet « aucune donnée sensible au modèle ».
- **Scénario** : une comptable colle le corps d'un e-mail fournisseur contenant un RIB/IBAN et demande « prépare le BC » : l'IBAN part à
  MiMo, puis repart à chaque tour suivant via l'historique (16 tours).
- **Correctif** : `censurerTexte` sur `message` et sur chaque entrée de `historique` dans `jouerTour` (un point unique). **Décision Direction
  requise** : cela empêche aussi la personne de dicter volontairement une donnée sensible à l'assistant (comportement voulu par Q12, à confirmer).

### IA-ASSISTANT-10 — Pas de retrait des cartes caduques dans l'Assistant IA · MOYENNE · PROPOSÉ (décision)

- **Preuve** : Adam appelle `retirerCaduquesAvantLeTour` avant chaque tour (`assistant.ts:4877`, `:5491`) — remède au défaut **mesuré** en banc
  live (carte « Raihana, vendredi » cliquée après « non, finalement Amel, lundi » → mauvaise tâche créée). `jouerTour` ne l'appelle pas ;
  `persistActionIntents` ne retire que les cartes *remplacées par une nouvelle proposition* (`retirerPerimees`).
- **Scénario** : même scène dans le fil : le tour 2 répond en texte, la carte du tour 1 reste cliquable dans l'historique.
- **Correctif** : appeler `retirerCaduquesAvantLeTour(user.id, texteSaisi)` en tête de `jouerTour`. **À arbitrer** : tous les gestes de
  l'Assistant IA partagent le `kind` `assistant_ia_op` ; la règle « même nature + deux mots communs » serait plus large que chez Adam →
  comparer sur `payload.op` (adapter `PropositionComparable.kind`) avant de l'activer.

### IA-ASSISTANT-11 — Frontière 430 > 425, domaines 71 > 68 : le chemin chiffré · MOYENNE · PROPOSÉ

- **Preuve** : `npm run adam:boundary` → 430 traversées (288 fichiers, 178 cibles) ; `domains.test.ts` → 71 (`adam → mail` 13,
  `adam → regulatory` 9, `adam → google` 8, `adam → drive` 7…). **44 traversées sont des imports de type seul**, dont **32** fichiers dont la
  seule raison d'importer `@/lib/session` est `import type { CurrentUser }` (mesure : script sur `scanBoundary()`).
- **Chemin, par petites étapes sûres** (détail au §3.3) : (1) `src/platform/in-process/acteur.ts` réexporte le type d'acteur ; les 32 fichiers
  l'importent de là → −32 (430 → 398), **et le plafond descend dans le même commit à 398** (un cliquet qui descend, jamais remonté — c'est
  ce qui distingue un vrai désendettement d'un blanchiment) ; (2) les 2 fichiers dont c'est l'unique traversée (`capability-surface.ts`,
  `ops/types.ts`) sortent alors de la liste ; (3) `adam → mail` (13) : faire passer les envois d'Adam par une commande du contrat
  (`PlatformCommand` « mail.send »), servie par l'adaptateur — −13 côté domaines (71 → 58 ≤ 68).

### IA-ASSISTANT-12 — `provider: "openai"` en dur dans le journal d'Adam · BASSE · PROPOSÉ (S)

- **Preuve** : `src/app/api/assistant/stream/route.ts:88`. Sous `ADAM_MODEL_PROVIDER=anthropic`, `AiUsageLog` attribue les coûts au mauvais
  fournisseur. **Correctif** : `provider: bindingFor("worker").provider` (registre).

### IA-ASSISTANT-13 — Clé MiMo lue sous `mimo` · BASSE · PROPOSÉ (S)

- **Preuve** : `src/lib/agent/modele.ts` — `process.env.MIMO_API_KEY ?? process.env.mimo`. Une variable en minuscules échappe aux inventaires
  (`.env.example`, chapitre 10 : ~200 variables en majuscules) et à `cleModeleRequise()`. **Correctif** : ne garder que `MIMO_API_KEY`,
  avertir au démarrage si `mimo` est encore posée.

---

## Lot V3-D « IA en exploitation » (28/10/2026, branche `v3/ia-exploitation`)

Livré : IA-03 (journal `ModelCallLog`/`AiUsageLog` à chaque appel, plafonds par tour et par personne/jour, avis au Super
Admin, écran `/admin/ai/consommation`), IA-06, IA-07, IA-08, IA-09, IA-10, IA-12, IA-13, et l'**injection par documents /
web** (sorties d'outils à contenu tiers encadrées et désamorcées, règle dans le prompt, cliquet sur les noms d'outils).
Point 3 de IA-03 (offrir les outils par intention pour réduire le fixe de ≈ 9 k jetons par étape) : **non fait** — il change
le comportement du modèle et demande une mesure sur MiMo réel ; les plafonds bornent la dépense en attendant.
**Non traités ici** (architecture, chantier 2 de la synthèse) : IA-05 (domaine `assistant-ia` + cliquet de couplage inverse)
et IA-11 (frontière 430 → 398).

**Décisions de Direction — l'option la plus prudente est active, derrière un réglage de l'écran Consommation IA :**

| Décision | Option active par défaut | Revers assumé | Réglage |
|---|---|---|---|
| IA-09 — filtrer ce que la personne écrit | Message saisi ET historique passent `censurerTexte` | La personne ne peut plus dicter volontairement un IBAN/salaire/numéro d'identité à l'assistant (Q12) | `censurerSaisie` |
| IA-10 — retirer les cartes caduques | Avant chaque tour, la carte dont on reparle est retirée ; `remplace` compare sur `payload.op` | Une carte peut être retirée alors que la personne voulait la garder (elle se redemande ; une mauvaise action exécutée ne se reprend pas) | `retirerCartesCaduques` |
| IA-07 — durée de vie d'une carte | 24 h, puis `EXPIRED` (balayage + refus au clic) ; « mes brouillons » ne réaffiche plus une carte plus vieille | Une carte de la veille se redemande | `expirationCartesHeures` |
| IA-03 — plafonds | 12 étapes, 150 000 jetons par tour, 600 000 par personne et par jour | Un très gros travail en arrière-plan (ex-24 étapes) s'arrête plus tôt et le dit | trois champs |
| IA-03 — tarif MiMo | Aucun tarif dans le code : coût « inconnu » tant que `MIMO_PRICE_IN`/`MIMO_PRICE_OUT` ne sont pas posés | — | environnement Render |

---

## À vérifier (soupçons non prouvés)

- **Prise du fil vs tour long** : la prise (`PRISE_PERDUE_MS = 10 min`) n'est rafraîchie qu'entre deux tours. Un outil qui dure plus que
  le délai du tour (ex. `lire_document` : 14 × `genererTexte` de 60 s chacun, séquentiels = 14 min au pire) dépasserait-il 10 min ?
  Dépend de l'arrêt réel d'un outil en cours par l'`abortSignal` de Mastra — non mesuré sans MiMo. Si oui : double traitement du même message.
- **Missions et actions CRITIQUES** (reporté du chapitre 09 [U]) : `runner.ts` crée l'intention `CONFIRMED` avec son `confirmText`, mais
  `executeIntentGuarded` ne vérifie pas la ressaisie (c'est `executerIntention` qui le fait). Couvert par l'approbation de périmètre (§118.8) ?
  À vérifier contre `compiler/` + `policy/guard.ts`.
- **Échec partiel puis rejeu** : `FAILED` est ré-réclamable. Une opération dont l'action métier a écrit puis rendu `{ok:false}` (ex. pièce
  jointe refusée après création) serait rejouée → doublon ? Dépend de chaque `executer` du registre.
- **Test instable** : `src/platform/in-process/missions/sorties-declarees.test.ts` a échoué une fois sous la charge parallèle
  (`src/lib/agent` + `src/platform`), passe seul (2/2). Hors des échecs pré-existants déclarés.
- **Injection par documents / web** : la défense est la consigne « le texte est une DONNÉE » + l'absence d'écriture sans clic. Aucun chemin
  d'exécution sans confirmation trouvé ; le risque résiduel est une carte trompeuse (destinataire/texte suggérés par le document) — à
  éprouver par un banc adversarial hors ligne (faux modèle qui « obéit » au document → vérifier que la carte affiche bien la cible réelle).

---

## 3. Restructuration proposée

### 3.1 Le constat de fond

Deux produits (Adam, en pause, Super Admin ; Assistant IA, actif, ouvert par module) partagent un **mécanisme** (intention → carte →
confirmation → action de l'écran) qui vit aujourd'hui *dans Adam* (`lib/assistant/action-intents.ts`, `performAction` dans
`assistant.ts`). L'Assistant IA emprunte donc Adam pour écrire, et rien ne mesure cet emprunt. La cible : le mécanisme devient un module
**socle** que les deux produits consomment, et chaque produit a sa frontière et son cliquet.

### 3.2 Arborescence cible

```
src/lib/ia/                         ← SOCLE IA partagé (L0/L1, zéro import d'Adam)
  intentions/                       ← ex-lib/assistant/action-intents.ts + executerIntention + balayage EXECUTING/EXPIRED
    machine.ts                      ← états, transitions, réclamation atomique, reçu
    confirmation.ts                 ← ressaisie CRITIQUE (ex-assistant-actions.ts:282-309)
    garde-exploitation.ts           ← interrupteur général + arrêt d'urgence + plafond, UNE fonction pour tous les produits
  usage.ts                          ← journal d'usage unique (Adam, Assistant IA, missions)
src/lib/agent/                      ← PRODUIT « Assistant IA » (domaine `assistant-ia`)
  moteur/   repondre.ts generer.ts modele.ts          ← SEULES portes vers le modèle (cliquet -01)
  tour/     tour.ts fil/                              ← un tour, le fil gardé
  outils/   outils-v1.ts lectures.ts recherche-web.ts ← lectures (adaptateurs minces des PowerTools)
  operations/                                         ← registre des gestes (inchangé)
  ui/  routines/  memoire*.ts  filtre-confidentialite.ts
src/lib/assistant/ , src/lib/assistant.ts            ← PRODUIT « Adam » (inchangé, en pause)
```

Contrat d'un geste, unique pour les deux produits :

```ts
// src/lib/ia/intentions/machine.ts
export interface Geste<A> {
  nom: string; module: Module; niveau?: "SENSITIVE" | "CRITICAL"; externe: boolean;
  ouvert(u: CurrentUser): boolean;
  proposer(e: Record<string, unknown>, u: CurrentUser): Promise<{ carte: CarteOperation; args: A } | { manque: string[] } | { erreur: string }>;
  executer(args: A, u: CurrentUser): Promise<ResultatOperation>; // = l'action serveur de l'écran
}
export async function executerGeste(u: CurrentUser, intentId: string, confirmTyped?: string): Promise<ResultatOperation>;
//   1. garde-exploitation (interrupteur, arrêt d'urgence si `externe`)  2. ressaisie CRITICAL  3. réclamation atomique
//   4. `ouvert(u)` relu  5. `executer`  6. reçu  — dans CET ordre, testé une fois.
```

Gain : `confirmerIntentionAssistantIA` et `executeAssistantAction` deviennent deux lignes ; l'arrêt d'urgence et l'interrupteur ne peuvent
plus être oubliés par un troisième produit (ils sont DANS le chemin d'exécution, pas à côté) ; Adam peut être retiré sans toucher l'Assistant IA.

### 3.3 Migration par petites étapes (chacune verte, chacune réversible)

1. **Mesurer avant de bouger** — ajouter `{ name: "assistant-ia", paths: ["src/lib/agent/", "src/app/(app)/assistant/beta/", "src/app/api/assistant-ia/"] }`
   à `domains.ts`, et un cliquet *couplage inverse* (`assistant-ia → adam` : plafond = mesure actuelle, 17 fichiers / ~28 imports).
   Rien ne change au code ; la dette devient visible et ne peut plus monter.
2. **Frontière Adam sous son plafond** — `src/platform/in-process/acteur.ts` : `export type { CurrentUser as Acteur } from "@/lib/session";`
   remplacer `import type { CurrentUser } from "@/lib/session"` dans les 32 fichiers listés (script `sed` + typecheck) → 430 → 398,
   `DEBT_CEILING` 425 → 398 dans le même commit.
3. **Sortir le mécanisme d'intention** — déplacer `action-intents.ts` vers `src/lib/ia/intentions/machine.ts`, réexporté depuis l'ancien chemin
   (zéro changement d'appelant) ; puis migrer les appelants un par un ; supprimer la réexportation quand elle n'a plus d'appelant.
4. **Garde d'exploitation unique** — `garde-exploitation.ts` absorbe la lecture de l'interrupteur (aujourd'hui dans `repondre.ts`/`generer.ts`)
   et de l'arrêt d'urgence (aujourd'hui dans `performAction` et `executerOperationIA`) ; les quatre sites l'appellent ; cliquet : aucun
   `getAppSettings().aiExternalActionsDisabled` hors de ce fichier.
5. **Journal d'usage MiMo + plafond journalier** (IA-ASSISTANT-03) dans `repondre.ts`/`generer.ts`.
6. **Couper les emprunts restants à Adam** : `outils-v1.ts` ne prend plus `assistantToolsFor`/`buildProposal` du god-file mais les deux gestes
   V1 (`create_task`, `send_message`) réécrits comme `Geste` du registre (ils appellent `createTaskRecord` / `envoyerMessageDirect`, comme
   l'écran) ; `pieces.ts` reçoit `driveNodeToFile` d'un module Drive de l'ERP (L2) au lieu de `ops/impl-wave8-files`.
7. **Supprimer `agent.ts`** (IA-ASSISTANT-08) et retirer l'exception du cliquet.

### 3.4 L'agent exemplaire, en une page (ce que le code doit rendre impossible d'oublier)

| Propriété | Où elle vit | Garantie |
|---|---|---|
| Un seul endroit parle au modèle | `agent/moteur/` | cliquet `new Agent(` (fait, -01) |
| Interrupteurs et plafonds lus avant tout appel | `ia/intentions/garde-exploitation.ts` | banc deux sens + cliquet |
| Le modèle propose, le code dispose | `Geste.proposer` → intention → `executerGeste` | aucune action serveur appelée depuis un outil (cliquet d'import dans `operations/`) |
| Une carte par tour, jamais orpheline | outils | `REFUS_SECONDE_CARTE` (fait, -04) |
| Tout appel compté | `ia/usage.ts` | test : chaque porte appelle `journaliser` |
| Toute donnée vers le modèle filtrée | `jouerTour` (entrée) + `filtre` (sorties d'outils) | test sur message + historique + sorties |
| Toute boucle bornée par le **progrès** et par le **budget** | `repondreAvecSecours` (`maxEtapes`, délai, jetons/jour) ; fil (`essais`) | bancs au faux modèle |
| Toute attente reprise, jamais rejouée à l'aveugle | fil (`essais`), intentions (`EXECUTING` → `FAILED` dit) | balayage + test horloge |

---

## 4. Bonnes pratiques à graver

1. **Cliquet « portes vers le modèle »** (posé, `agent/interrupteur.test.ts`) : à étendre à tout `src/` — tout fichier qui construit un
   client de modèle (`new Agent(`, `fetch(` vers une URL de fournisseur, SDK) est dans une liste fermée, et chacun lit l'interrupteur.
2. **Cliquet « une écriture IA = un chemin »** : `rg "aiExternalActionsDisabled"` ne doit trouver que le module de garde ; tout exécuteur
   d'intention passe par lui (test d'import).
3. **Tout nouveau produit IA déclare son domaine** dans `domains.ts` le jour de sa création, avec un plafond = mesure ; un dossier
   `src/lib/<produit>/` non déclaré fait échouer `domains.test.ts` (ajouter un test « tout dossier de `src/lib` qui importe `@/lib/models`
   ou `@mastra/*` appartient à un domaine déclaré »).
4. **Les cliquets descendent dans le commit qui désendette** — jamais un plafond relevé, jamais une baisse non verrouillée.
5. **Tout état déclaré est écrit et lu** (§118.45) : test qui vérifie que chaque valeur de `IntentStatus` apparaît dans au moins une écriture
   (`status: "<X>"`) hors test — aurait attrapé `EXPIRED`.
6. **Tout appel de modèle est journalisé** : test « chaque porte appelle `logAiUsage` » (même détecteur que le cliquet 1).
7. **Toute file de travail a un compteur d'essais** : convention pour les tables à états (`EN_ATTENTE/EN_COURS`) — colonne `essais` +
   plafond, revue à chaque nouvelle file (fil, routines, missions).
8. **Les tests d'interrupteurs injectent leurs lecteurs** (§118.115) : le patron `remplacerLecteurInterrupteurIaPourTests` / `vi.mock("@/lib/settings")`
   utilisé ici, jamais la ligne globale.

---

## Annexe — vérifications exécutées

- `npm run adam:boundary` → 430 traversées (pré-existant, consigne : à ignorer pour l'échec du test).
- `npx vitest run src/lib/agent src/lib/client-bundle-guard.test.ts src/lib/ai-interrupteur.test.ts src/lib/models/passerelle-unique.test.ts`
  → 32 fichiers, 198 tests verts après correctifs.
- `npx vitest run src/lib/agent src/platform …` (avant correctifs) → seuls `boundary.test.ts` (430 > 425) et `domains.test.ts` (71 > 68)
  rouges, plus `sorties-declarees.test.ts` instable sous charge (vert seul).
- `npx tsc --noEmit` (avec `NODE_OPTIONS=--max-old-space-size=8192` : `npm run typecheck` tel quel manque de mémoire dans ce conteneur) et `npx next lint` sur les fichiers touchés → propres.
- Aucune server action ajoutée ni modifiée (pas de `actions:contrat` requis).
