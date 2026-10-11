# AMD Internal OS â€” instructions projet

ERP interne Adventum Pharma. Next.js 14 (App Router) + Prisma + PostgreSQL, UI en franÃ§ais, devise DZD. Aucune donnÃ©e simulÃ©e. VÃ©rification avant commit : `npm run typecheck && npm run build && npm test`, puis `npx next lint` â€” Render le lance AVANT le build (`build:render`) alors qu'ici `next build` l'ignore : une seule erreur de lint bloque tout dÃ©ploiement, sans rien signaler de notre cÃ´tÃ© (Â§118.155) (Postgres local : `pg_ctlcluster 16 main start` si down). Migrations : SQL manuel idempotent dans `prisma/migrations/` + `db:deploy`.

âš ï¸ **`npm run build` rÃ©utilise le cache `.next`** et peut donc rater une erreur que le serveur de dÃ©ploiement, lui, verra (il part d'un dossier vide). AprÃ¨s avoir touchÃ© aux **imports d'un composant client**, vÃ©rifier sur un build propre : `rm -rf .next && npm run build`.

## FrontiÃ¨re client / serveur â€” la rÃ¨gle qui casse les dÃ©ploiements

Un composant `"use client"` est compilÃ© **pour le navigateur**. S'il importe â€” mÃªme indirectement, Ã  dix modules de distance â€” un module qui lit des fichiers (`fs`, `zlib`, `child_process`â€¦), la compilation de production Ã©choue avec **Â« Module not found: Can't resolve 'fs' Â»**. Le typecheck ne le voit pas.

- Les **actions serveur** (`"use server"`) ne comptent pas : Next.js les remplace par un appel distant. Un composant client peut les appeler librement.
- Ce sont les imports **ordinaires** (constantes, types *avec valeur*, fonctions utilitaires) qui posent problÃ¨me.
- Pattern Ã  suivre : sortir les fonctions **pures** dans un module dÃ©diÃ© qui n'importe rien de lourd (ex. `src/lib/market/galenic.ts` et `text.ts` pour les normalisations pharma ; `molecule.ts` garde l'analyse qui lit les donnÃ©es et les **rÃ©exporte** pour le serveur).
- **`src/lib/client-bundle-guard.test.ts`** remonte les chaÃ®nes d'import â€” statiques ET dynamiques (`import("â€¦")`), modules natifs ET paquets Node-only (`web-push`, `nodemailer`, `sharp`, `mupdf`â€¦) â€” et fait Ã©chouer `npm test` en affichant le chemin fautif. Ne pas le dÃ©sactiver : il existe parce que l'erreur est dÃ©jÃ  passÃ©e en production, deux fois (`market/data.ts` par `fs`, puis `messaging.ts` par `web-push` via le registre d'Ã©vÃ©nements). Un module serveur qui porte aussi des constantes d'Ã©cran se scinde : la part pure dans un fichier sans import (`messaging-ui.ts`), rÃ©exportÃ©e cÃ´tÃ© serveur.

## Doctrines dÃ©taillÃ©es â€” dÃ©placÃ©es sous `docs/claude-md/`

Ce fichier est volontairement court (il est chargÃ© Ã  chaque session). Le texte intÃ©gral de l'ancien `CLAUDE.md` est dÃ©coupÃ© sans perte dans `docs/claude-md/` (index : [docs/claude-md/INDEX.md](docs/claude-md/INDEX.md)). Ne le lire qu'Ã  la demande, par section, avec `rg -n -m 20` puis `sed -n` sur une plage courte.

- **Mission Runtime â€” la doctrine (Â§118)** â€” [01](docs/claude-md/03-mission-runtime-la-doctrine-118-p01.md), [02](docs/claude-md/03-mission-runtime-la-doctrine-118-p02.md), [03](docs/claude-md/03-mission-runtime-la-doctrine-118-p03.md)
- **Live Office â€” la doctrine (Â§104)** â€” [texte](docs/claude-md/04-live-office-la-doctrine-104.md)
- **Versionnement Graphify** â€” [01](docs/claude-md/08-versionnement-graphify-p01.md), [02](docs/claude-md/08-versionnement-graphify-p02.md), [03](docs/claude-md/08-versionnement-graphify-p03.md), [04](docs/claude-md/08-versionnement-graphify-p04.md), [05](docs/claude-md/08-versionnement-graphify-p05.md), [06](docs/claude-md/08-versionnement-graphify-p06.md)

## Ordre de consultation (Ã©conomie de tokens)

1. **`docs/readme/`** (ex-`README.md`, index : `docs/readme/INDEX.md`) = carte FONCTIONNELLE de rÃ©fÃ©rence : section Â« RÃ©fÃ©rence dÃ©taillÃ©e des circuits & mÃ©canismes transverses Â» (rÃ¨gles exactes de chaque flux + gardes RBAC + modÃ¨les + chemins de fichiers) et Â« Carte du code â€” fichiers clÃ©s par domaine Â». La consulter AVANT toute exploration : la plupart des questions Â« comment marche X / oÃ¹ est codÃ© X Â» y sont dÃ©jÃ  rÃ©pondues.
2. **Graphify** (ci-dessous) = carte STRUCTURELLE (symboles, dÃ©pendances) pour localiser prÃ©cisÃ©ment avant de lire.
3. **Lecture de code** ciblÃ©e en dernier.

AprÃ¨s un gros lot fonctionnel : mettre Ã  jour le README (panorama, circuits, journal) EN MÃŠME TEMPS que le refresh Graphify â€” les deux cartes doivent rester exactes.

## Graphify = couche de comprÃ©hension principale (OBLIGATOIRE)

Le graphe de connaissance du code (`graphify-out/graph.json`, ~28 700 nÅ“uds / ~3 770 fichiers) est la **carte d'architecture** du projet. Objectif : rÃ©duire les tokens et garder la cohÃ©rence â€” on interroge la carte AVANT d'ouvrir le code.

RÃ¨gles :
1. **Avant toute tÃ¢che structurelle ou modification non triviale**, interroger d'abord Graphify :
   - `npm run graphify:query -- "<nÅ“ud>"` â†’ explication d'un symbole + ses voisins (ex. `"userCan"`, `"createExpenseOrder"`) ;
   - `npm run graphify:query -- path "A" "B"` â†’ chaÃ®ne reliant deux symboles ;
   - `npm run graphify:report` â†’ hubs et communautÃ©s (vue d'ensemble).
2. **Lire les fichiers source seulement aprÃ¨s** avoir identifiÃ© les fichiers pertinents via Graphify.
3. **Pas de recherche large** (grep exploratoire, lectures massives en Ã©ventail) avant la requÃªte Graphify. Un grep **ciblÃ©** sur un symbole dÃ©jÃ  localisÃ© par le graphe reste permis.
4. **RafraÃ®chir aprÃ¨s chaque gros lot fonctionnel** (nouveau module, refonte) : `npm run graphify:refresh`, puis committer `graph.json` / `graph.html` / `GRAPH_REPORT.md`. **Jamais Ã  chaque micro-commit** (~8 Mo d'artefacts par refresh).
5. FraÃ®cheur : `GRAPH_REPORT.md` indique `Built from commit`. Si le graphe a plusieurs gros lots de retard sur `HEAD`, le rafraÃ®chir avant de s'y fier.

Fallback autorisÃ© (le graphe ne couvre pas tout) : contenu exact d'un fichier dÃ©jÃ  identifiÃ©, chaÃ®nes littÃ©rales / libellÃ©s UI, fichiers hors `src/` (`prisma/`, `scripts/`), ou graphe indisponible.

## Scripts Graphify
- `npm run graphify:refresh` â€” auto-installe le CLI si absent (conteneur Ã©phÃ©mÃ¨re), rÃ©-extrait `src/` (AST, sans LLM, ~1 min), replace les sorties dans `graphify-out/`. AprÃ¨s une grosse suppression de code : `GRAPHIFY_FORCE=1 npm run graphify:refresh`.
- `npm run graphify:report` â€” affiche le rapport.
- `npm run graphify:query -- â€¦` â€” interroge le graphe versionnÃ© sans le rÃ©gÃ©nÃ©rer.

## Versionnement Graphify
VersionnÃ©s : `graphify-out/{graph.json, graph.html, GRAPH_REPORT.md, .graphify_labels.json, README.md}`. IgnorÃ©s (cache local) : `graphify-out/{cache/, manifest.json, .graphify_root}`.

Les rÃ¨gles numÃ©rotÃ©es qui suivaient (Â§118.x) sont dans `docs/claude-md/08-versionnement-graphify-p0*.md`.
