# 0013 — L'Assistant IA en « Jarvis » : décisions de la Direction et lot J0 (29/10/2026)

**Décision (Direction, 29/10/2026)** : la proposition d'architecture « L'Assistant IA en Jarvis : travaux longs, mémoire,
documents en direct » est validée (lien : <https://claude.ai/artifact/8TCDJTz6Nxow3qUtjb2hRS>, inventaire au commit
`ed81866f`). Ce document en garde les cinq décisions, le plan J0 → J5, et ce que le lot J0 a livré.

> Code du lot J0 : `src/platform/ia/` (le socle commun, son `README.md`), `src/platform/ia/frontieres.test.ts` (la frontière),
> `src/platform/boundary-scan.ts` · `boundary.test.ts` (`SOCLE_IA_PATHS`, `SOCLE_IA_CEILING`), `src/platform/domains.ts`
> (couche « socle IA »), `.eslintrc.json` (`@typescript-eslint/no-restricted-imports`), `src/components/chief/` (l'écran
> d'Adam), `tsconfig.json` (adresses de réexpédition). Carte : `docs/architecture/MODULES.md` §8.

## 1. Deux produits, un socle

| | **Adam** | **Assistant IA** (« Adventum Brain ») | **Socle IA** |
|---|---|---|---|
| Pour qui | le Super Admin (« Chief of Staff », §118.153) | chacun, selon ses droits (module `ASSISTANT_IA`, console) | les deux |
| Moteur | boucle maison, passerelle `lib/models/` | Mastra + `gpt-6.1-terra` | — |
| Code | `lib/assistant.ts`, `lib/assistant/**`, `lib/assistant-*.ts`, le pont `platform/in-process/`, `lib/actions/assistant-actions.ts` | `lib/agent/**`, `lib/actions/assistant-ia-*.ts` | `src/platform/ia/**` |
| Écran | `/chief-of-staff` — `app/(app)/chief-of-staff/`, `components/chief/` (dont la conversation, `assistant-chat*`, l'appel vocal `voice-mode` / `realtime-voice*`) | `/assistant` — `app/(app)/assistant/` (`page.tsx`, `beta/`), `components/assistant-beta/`, `/api/assistant-ia/` | les blocs de l'espace de travail (`ecrans/`) |

Règles, tenues par ESLint et par `src/platform/ia/frontieres.test.ts` (imports relatifs et tests compris) :

1. l'Assistant IA n'importe jamais Adam ;
2. Adam n'importe jamais l'Assistant IA ;
3. le socle n'importe ni l'un ni l'autre.

## 2. Les cinq décisions

1. **Worker Render toujours allumé.** Un travail long ne vit pas dans une requête web : il tourne sur le worker (instance
   payante, continue). Sans lui, rien ne dure au-delà de la vie d'une requête.
2. **pgvector en production.** Extension Postgres activée sur la base de production, par migration additive : les vecteurs
   de la Bibliothèque sont comparés dans la base, plus en JSON dans le serveur.
3. **Le worker en image Docker**, avec LibreOffice (conversions fidèles Word / PowerPoint → PDF) et ffmpeg (vidéo).
4. **Plafonds de dépense IA** : par personne et par mois, et **par travail — 20 $ par défaut**, réglables dans la console
   (à côté des plafonds par tour et par jour d'aujourd'hui, `AssistantIaReglage`). Atteint, le travail se suspend proprement.
5. **Écritures pendant un travail long** : un **plan approuvé une fois**, avec la liste des gestes autorisés, au lieu d'une
   carte à chaque écriture — **limité aux familles d'opérations ouvertes dans la console** pour la personne. Les droits sont
   relus à chaque écriture (un accès retiré s'applique au travail en cours) ; un geste hors de la liste repasse par une carte.

## 3. Le plan J0 → J5

| Lot | Contenu | Critère de fin | Dépend de |
|---|---|---|---|
| **J0** | Séparation Adam / Assistant IA, socle `platform/ia`, règle ESLint et test | Zéro import croisé ; contrat des actions identique | — |
| **J1** | Bibliothèque : registre unique des pièces, porte d'inscription obligatoire, ingestion (worker), index hybride plein texte français + pgvector, droits dans l'index, rattrapage | Un document retrouvé par son contenu en moins d'une seconde, quel que soit son point d'entrée ; aucun résultat hors droits | J0 |
| **J2** | Moteur de travaux (généralisation du Mission Runtime), worker activé, panneau « Travaux », attentes, carnet de travail | Un travail de 2 heures survit à 3 redémarrages forcés sans refaire une étape | J0 |
| **J3** | Atelier : onglets, rendu des formats, édition en direct par commandes Live Office, historique, versions, conversions | Une diapositive et un paragraphe modifiés en direct, refusés puis acceptés, enregistrés en nouvelle version | J1, J2 |
| **J4** | Mémoire en 4 couches (carnet, conversation + résumé roulant, mémoire personnelle, connaissance de l'entreprise), assembleur de contexte, choix du modèle et des outils | Banc Jarvis : meilleure réussite, premier mot plus tôt, coût par tour stable ou en baisse | J1 |
| **J5** | Banc Jarvis chaque nuit, tableau de bord qualité, alertes | Une régression fait échouer la nuit et le dit | banc en cours |

J1 et J2 avancent en parallèle après J0. Chaque lot : migration additive, tests complets, build propre, puis production.

## 4. Ce que le lot J0 a livré

**Mesures** (après fusion de la base `b42a952c`, qui apporte les droits métier V4-G — décision 0012 — et le module
Finances ; non-tests, « tests compris » entre parenthèses) :

| | Base `b42a952c` | Après J0 |
|---|---|---|
| Imports de l'Assistant IA vers Adam | 38 dans 24 fichiers (45) | **4**, nommés (5 avec le test `limites.test.ts`) |
| Imports d'Adam vers l'Assistant IA | 2 (`lib/actions/assistant-actions.ts`) | 2 — les mêmes, nommés |
| Imports du socle vers l'un ou l'autre | — | **0** |
| Frontière Adam → ERP (`boundary.test.ts`) | plafond 419 | **393** + socle IA **179** (plafond propre) |
| Domaines (`domains.test.ts`) : traversées / fournisseurs | plafonds 67 / 42 | 57 / 40 |
| Contrat des actions (`npm run actions:contrat`) | — | **identique, octet pour octet** |

**Ce qui est allé au socle** (`git mv` quand c'était un fichier entier ; extrait sinon) : la forme d'un outil (`outil.ts`,
`PowerTool`) ; les lectures annuaire et Regulatory, les circuits, les résultats vides (`lectures/`) ; la lecture des
arguments et la résolution de personne (`outils/arguments.ts`) ; les intentions et leur persistance (`intentions/`) ; la
résolution d'un fichier du Drive (`drive.ts`) ; la recherche web (`web-research.ts`) ; ffmpeg et les pièces jointes
(`media/`) ; la fabrique de documents et les artefacts (`artifact/`) ; les standards documentaires appris
(`teach/store.ts`) ; le propriétaire d'un travail (`proprietaire.ts`) ; le puits d'usage des modèles (`telemetry/`) ; le
protocole et les blocs de l'espace de travail (`workspace/`, `ecrans/`). Adam les importe au socle : il n'y a qu'une
version de chaque chose. La règle d'accès de l'Assistant IA se lit dans `@/lib/rbac` (plus par le pont d'Adam).

**Ce qui n'a pas changé** : aucune URL ; aucun comportement. Point vérifié à la main parce qu'il aurait pu bouger : *le
puits d'usage* était branché au chargement d'`assistant.ts` ; l'Assistant IA, qui chargeait Adam, en profitait. Les deux
modules du socle qui appellent un modèle (`web-research.ts`, `media/assistant-files.ts`) le branchent eux-mêmes.

**Ce qui reste — la phase B** (déménagement de l'Assistant IA en module `src/modules/assistant-ia/`, après la suite de V4-G) :
- **le catalogue d'outils d'Adam**, que les droits métier de l'Assistant IA (décision 0012) empruntent tel quel dans
  `lib/agent/outils-v1.ts` : `assistantToolsFor`, `executeReadTool`, `buildProposal` (`@/lib/assistant`),
  `executePowerTool` (`power-tools`), `DOMAIN_TOOLS` (`ops`). Les sortir, c'est sortir au socle les schémas, l'exécution des
  lectures, la construction des cartes et le catalogue des opérations — le gros morceau de la phase B. (Un premier essai
  de J0 sortait les cinq outils de la V1 ; V4-G, fusionné entre-temps, en emprunte une trentaine : l'essai a été retiré
  plutôt que de couvrir un sixième du besoin.) ;
- `confirmerIntentionAssistantIA` — l'action qui exécute une carte de l'Assistant IA — vit dans `lib/actions/assistant-actions.ts`
  (le fichier d'Adam) : la page `/assistant` l'importe, et elle importe le registre d'opérations de l'IA ; pour les écritures
  métier, elle exécute par `performAction` d'Adam. La déplacer change son identifiant dans le contrat des actions ;
- `lib/agent/limites.test.ts` vérifie ce chemin de bout en bout et importe donc `performAction` ;
- `src/lib/agent/` reste où il est ; ses imports pointent déjà le socle pour tout le reste.

Les adresses de réexpédition (`tsconfig.json`, une par fichier déplacé) servent aux branches ouvertes avant J0 ;
`src/modules/frontieres.test.ts` (règle 5) et ESLint disent au code qui arrive quelle adresse écrire.
