## ✅ Tests & qualité

### Bancs LIVE dans un conteneur derrière un mandataire

`npm run bench:live -- scripts/bench/<banc>.ts`

Le `fetch` global de Node **n'honore pas** `HTTPS_PROXY` (contrairement à curl) : les appels de
modèle sortaient en direct et revenaient en `HTTP 401`, alors que le mandataire du conteneur sait
les signer. Le préchargement `scripts/proxy-dispatcher.cjs` pose le dispatcher et rien d'autre —
il ne touche ni à la vérification TLS (le magasin vient de `NODE_EXTRA_CA_CERTS`) ni aux variables
de mandataire, il les LIT, et sans `HTTPS_PROXY` il ne fait rien **en le disant**. Réservé aux
bancs : la production tourne sans mandataire, avec sa vraie clé.

Mesuré : `callOpenAi` rend `ok: true` par le chemin du produit, et `bench:intentions` passe
**10/10** avec vrai coût (0,0001–0,07 $/tour) et vraie latence (§118.84).


- **Suite d'évaluation (§33)** : `npm test` et `npm run test:e2e` déposent les mesures des cibles dans `bench-out/evals/` ; `npm run evals:report` imprime le tableau des dix-sept cibles (exigence, mesuré, verdict, où) et échoue sur une cible manquée ou non mesurée (`--souple` tolère les non mesurées).

- **Vitest** : tests RBAC (purs, CI-safe) + **tests d'intégration** des workflows critiques contre une vraie base
  Postgres (mock de session) — information médicale, dossiers, directives, support, OnlyOffice (JWT), stockage
  durable, validation des imports Drive, score d'adoption anti-gaming, atterrissage sûr, matériel promotionnel,
  assistant IA, courrier, réunions. **2 491 passés · 23 skip propres** sur **229 fichiers** (sans base,
  CI verte partout).
- **Porte de vérification** avant chaque push (jamais contournée) :

```bash
npm run typecheck && npm run build && npm test && npx next lint
```

- **Cliquets d'architecture** (`npm run test:architecture`, ~35 s) : un module (`src/modules/<m>/`) ne s'ouvre que par
  ses portes, sa carte (`carte.ts`) est sans cycle, aucun ancien chemin n'est importé ; six plafonds de couverture qui
  ne peuvent que baisser (`src/platform/couverture.test.ts`). Un nouveau test de structure lit le code par
  `lireSource()` / `sourceDuSymbole()` (`src/platform/source.ts`), jamais par un chemin figé.
- **Code mort et doublons** (`npm run qualite:mort`, `npm run qualite:doublons`, en CI) : knip exige zéro fichier,
  export, type ou dépendance inutilisé ; jscpd tient les clones de `src/` sous plafond. Cliquets dans
  `src/platform/qualite-code.test.ts` (plafonds dans `qualite-code.ts`, jamais relevés). Un export qu'on n'utilise plus
  se supprime avec sa déclaration ; une fonction recopiée se fusionne vers celle qui existe (`lib/utils.ts` pour les
  petites normalisations pures : `plier`, `arrondirAuCentime`, `arrondirAuMillieme`, `montantDzd`).

> Les tests d'intégration **skippent proprement** si aucune base n'est disponible (CI verte) et **s'exécutent
> tous** dès que Postgres est présent — on retombe alors sur le référentiel **2 491 passés / 23 skip**.

- **Écrans (Playwright, Chromium préinstallé)** : `npm run build && npm run test:e2e` rend quarante écrans
  représentatifs à 375 px et à 1440 px sur le build de production et tombe si un élément visible dépasse,
  si une page affiche un texte d'erreur, ou si le document répond 5xx (`e2e/ui-audit.spec.ts`). L'audit
  COMPLET (toutes les routes, liens vérifiés, captures) reste l'affaire du crawler :
  `npx tsx scripts/ui-audit/run.ts --shots` → `ui-audit-out/report.md`. Ce que le crawler trouve se
  corrige, puis se fige dans un garde statique (`src/lib/ui/`) — sinon tout revient au prochain écran.

---

