# 0027 — Adventum IA : l'app de l'Assistant IA, conversations multiples, mémoire commune, privée, dossiers (30/10/2026)

**Décision (Direction, 30/10/2026)** : la maquette « Adventum IA » est validée
(<https://claude.ai/artifact/D6GRRymo4bU61j8UWQPXFm>), avec les onze décisions ci-dessous. Ce document dit ce qui a été
livré, où, et ce qui reste branché sur d'autres lots.

> Code : `src/modules/assistant-ia/` — `domaine/{conversations,dossiers}.ts`, `infra/conversations/{service,dossiers,outil}.ts`,
> `actions-conversations.ts` (clé `assistant-ia-conversations-actions`), `ecrans/{use-fil,use-pieces,use-echap,zone-depot}.ts(x)`,
> `ecrans/conversations/`, `ecrans/app/` (l'app, son thème) ; `src/app/ia/` (la page), `src/platform/app-mode.ts` (le mode
> d'application, lu par le middleware via `src/auth.config.ts`), `public/adventum-ia/` (logo, icônes, manifeste, écrans de
> démarrage), `public/ia-sw.js` ; migration additive `20270215110000_adventum_ia_conversations` ; service Render `adventum-ia`.

## 1. Les onze décisions et ce qui les tient

| # | Décision | Livré |
|---|---|---|
| 1 | App « Adventum IA », type ChatGPT, **même assistant** que l'ERP | `/ia` rend `AdventumIaApp` : le fil (`use-fil`), les pièces (`use-pieces`), les cartes, la mémoire, les travaux, l'Atelier sont ceux du module. Mêmes outils, droits, console, repères ⟦Sn⟧ ; les tours se jouent sur le serveur (et les travaux sur le worker), app fermée comprise. |
| 2 | **Conversations multiples** | L'unicité `AssistantIaFil.userId` est levée par migration additive : le fil existant devient la première conversation (titre « Ma conversation », tours, résumé roulant conservés). Nouvelle conversation, titre provisoire (premier message) puis proposé par le modèle **rapide** après la première réponse (`proposerTitre`, jamais sur un titre choisi), renommer, épingler, rechercher (titres **et** contenu, `ILIKE`), archiver, supprimer ; groupes Épinglées / Aujourd'hui (jour d'Alger) / 7 derniers jours / Plus ancien. Reprise : chaque conversation garde son résumé roulant (J4). L'écran `/assistant` de l'ERP a la même liste (une seule implémentation). |
| 3 | **Mémoire commune** | `AssistantMemoryItem` inchangée, lue par toutes les conversations ordinaires ; outil `chercher_conversations` (les conversations passées de la personne, jamais une privée ni celle en cours, extraits filtrés et encadrés comme contenu tiers). « Mémoire mise à jour » s'affiche sur la carte confirmée ; l'écran « Ce que l'assistant retient » est le panneau Mémoire (lire, corriger, effacer). |
| 4 | **Conversation privée** | Choisie à la création seulement (`reglerPrive` refuse dès qu'un tour existe, garde contre la course en base). Ni mémoire lue (`compileContext({ sansMemoire })`), ni `proposer_memoire`, ni `chercher_conversations` ; consigne « CONVERSATION PRIVÉE » dans la partie variable (le préfixe stable du cache ne bouge pas). Supprimée 30 jours après sa création (tâche `assistant.conversations-privees`). |
| 5 | **Dossiers** | `AssistantIaDossier` : nom, consignes (≤ 4 000 car.), documents (≤ 20, fichiers du Drive / de la Bibliothèque). Ajout : seuls les documents que la personne peut ouvrir ; **à chaque tour** les droits sont relus (`sectionDossierDuTour`) — un document retiré n'est plus nommé. La section dit au modèle que les consignes ne lèvent aucune règle. |
| 6 | **Pas de partage** | Aucun geste de partage ; chaque service met la personne dans son `where`. |
| 7 | **Trois façons de parler** | (a) texte (flux, Markdown sûr, glisser-déposer du lot 0015) ; (b) voix en direct `gpt-live-1` : le bouton et le panneau du **lot J13** (`ecrans/voix-temps-reel.tsx`, routes `/api/assistant-ia/voix/*`), branchés sur la conversation OUVERTE — délégations et transcription s'y écrivent ; une « nouvelle conversation » naît quand on parle ; (c) messages vocaux : maintenir, glisser pour annuler, verrouiller, onde, durée, **réécoute avant envoi** (nouveau, « ■ »), transcription sous la bulle (lot 0011), dans la conversation ouverte. |
| 8 | **Panneaux** | Tiroir Notes / Travaux / Documents. Notes : **point d'accroche** `PanneauNotes` (lot `jarvis/notes` absent de la base au 30/10). Travaux : liste J2 + panneau complet. Documents : pièces de la conversation et du dossier (aperçu, Atelier J3), Bibliothèque par l'assistant (`chercher_documents`). |
| 9 | **Charte** | La **charte Adventum Pharma** reçue le 30/10 (`docs/charte/adventum-pharma.md`) : bleu Adventum `#2C59A7` (boutons, bulle, `theme_color`), indigo `#324BA6` (survol), sarcelle `#2B6E82` / cyan `#57C8DD` (voix, états), Helvetica Neue ; sombre aux bleus éclaircis ; **pas de vert**. Un seul fichier de thème : `src/modules/assistant-ia/ecrans/app/theme.css` (jetons `--aia-*`). Logo complet dans la barre latérale, symbole pour les petits formats, icônes et écrans de démarrage dans `public/adventum-ia/` (le logo provisoire « A » est retiré). |
| 10 | **Site propre** | Service `adventum-ia` dans `render.yaml` (starter), créé par « Sync » : même dépôt, même build (sans migration ni bootstrap), `APP_MODE=adventum-ia`, même base (`fromDatabase`), `AUTH_SECRET`, clés S3 / VAPID / OpenAI par `fromService` depuis `amd-internal-os`, `AUTH_URL` = `APP_URL` = `https://adventum-ia.onrender.com`, `ERP_URL`, `TACHES_DE_FOND=worker` (il ne bat pas). Middleware : la racine et les pages d'atterrissage → `/ia` ; `/assistant?c=` → `/ia?c=` ; toute autre page → l'ERP ; une API de l'ERP → 404. Mêmes comptes ; session de 30 jours ; **déconnexion à distance** de ses appareils (Réglages). |
| 11 | **PWA iPhone** | Manifeste « Adventum IA » (`start_url` `/ia`, `display` standalone, `theme_color` bleu), `apple-touch-icon`, `apple-mobile-web-app-capable`, barre d'état `black-translucent`, écrans de démarrage (iPhone 12-15). Service worker `/ia-sw.js` (portée `/ia`) : Web Push (VAPID existant) — une notification de réponse ouvre **la bonne conversation** (`/assistant?c=…` → `/ia?c=…`) ; hors ligne minimal : coquille en cache, **vocaux en file** (IndexedDB) envoyés au retour du réseau. Les notes hors ligne viendront avec le lot Notes. |

## 2. Ce qui a changé dans le fil

- `deposerMessage(…, conversation?)`, `lireFil(…, conversation?)`, `traiterFil(userId, conversation?)` : sans conversation, la
  **conversation courante** (la plus récente, ni archivée ni privée) — les anciens écrans et liens marchent tels quels.
- « Nouvelle conversation » crée une conversation au lieu de remettre `depuisLe` à zéro : l'ancienne reste reprenable.
- La notification d'une réponse porte `/assistant?c=<conversation>`.
- L'option « réponse vocale » est un réglage de la personne (toutes ses conversations).

## 3. Limites connues

- Le bloc-notes attend le lot Notes (`jarvis/notes`) : le point d'accroche `PanneauNotes` est posé, rien n'est simulé. La voix en direct est celle de J13 (fusionné le 30/10, base a087ee19).
- La recherche est par sous-chaîne (insensible à la casse), sans racinisation ; `chercher_conversations` cherche mot par mot.
- `fromService` d'une variable posée à la main sur le web (OpenAI) : si Render ne la résout pas au « Sync », la poser à la main
  sur `adventum-ia` (procédure `docs/readme/24-deploiement-render.md`).
- L'adresse `adventum-ia.onrender.com` peut être prise : Render donne alors le nom libre le plus proche — le reporter dans
  `AUTH_URL` / `APP_URL`.

## 4. Les preuves

| Test | Ce qu'il prouve |
|---|---|
| `infra/conversations/conversations.test.ts` | conversations séparées, titre provisoire puis proposé ; renommer / épingler / archiver / rechercher (contenu) / supprimer, jamais chez un collègue ; privée verrouillée après le 1er message, sans mémoire ni « Retenir » ni conversations passées, une ordinaire lit la mémoire ; purge à 30 jours ; dossier : consignes et documents appliqués, document hors droits refusé, droits relus à chaque tour ; **migration rejouée : le fil existant conservé** |
| `domaine/conversations.test.ts` | groupes par date (jour d'Alger), titres, privée, extraits, section de dossier |
| `src/platform/app-mode.test.ts` | le middleware du mode app : racine, `/assistant?c=`, pages et API permises, renvoi vers l'ERP, refus |
| `infra/fil/{fil,resume}.test.ts` | le fil reste juste avec plusieurs conversations ; lien de notification vers la conversation |
| `e2e/adventum-ia.spec.ts` | bureau 1440 px et iPhone 390 px : créer une conversation, privée, dossier, vocal enregistré (micro simulé) avec réécoute, panneau Notes, recherche ; `/assistant` montre les mêmes conversations |

## 5. Essai réel (30/10/2026) et captures

Un tour réel (`gpt-6.1-terra`, compte d'essai assistante de direction, effacé ensuite) : « Peux-tu me rappeler… préparer un
congrès médical à Oran ? » → réponse en **6,4 s**, famille Ad & Pro fermée **dite** (droits respectés) ; titre proposé par le
modèle rapide : **« Préparation du congrès médical d'Oran »** (`titreSource = auto`). Coût mesuré : **≈ 0,015 $**.

Captures (Playwright, build de production) : [`docs/assistant/captures/0027/`](../captures/0027/) — bureau 1440 px
(`bureau-*.png`), iPhone 390 px (`iphone-*.png`), et l'écran `/assistant` de l'ERP avec la même liste (`erp-assistant.png`).
