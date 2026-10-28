## 📜 Scripts

| Commande | Description |
|---|---|
| `npm run dev` | Serveur de développement |
| `npm run build` | `prisma generate` + build de production |
| `npm run start` | Serveur de production |
| `npm run typecheck` | Vérification TypeScript (`tsc --noEmit`) |
| `npm run lint` | ESLint (next lint) |
| `npm run test` | Tests Vitest |
| `npm run test:architecture` | **Les cliquets d'architecture seuls** (~35 s) : frontières et carte des modules (`src/modules/`), couverture (`src/platform/couverture.test.ts`), domaines, frontière Adam ↔ ERP, contrat des actions, garde du bundle client. À lancer après tout déplacement de fichier — guide : `docs/architecture/MODULES.md`. |
| `npm run db:deploy` | Applique les migrations (prod) |
| `npm run db:migrate` | Migration de développement |
| `npm run db:bootstrap` | Crée le Super Admin initial |
| `npm run db:reset` | Réinitialise la base |
| `npx tsx scripts/gen-selection-pf-migration.ts` | Régénère la migration d'import du portefeuille « Sélection PF Produits » depuis `data/selection-pf-produits.xlsx` (le SQL est committé ; ne pas l'éditer à la main). |
| `npm run adam:doctor` | **Diagnostic de mise en service d'Adam** — base, migrations, chiffrement des jetons, config Google, connexion, droits accordés, veille Gmail, ingestion, politique d'envoi, coupe-circuits, planificateur, parité. Sans effet de bord, n'affiche AUCUN secret, sort en erreur s'il reste un ÉCHEC. |
| `npm run build:measure` | **Pic mémoire du build** — build propre, **avec le plafond de tas de `build:render`** (`BUILD_HEAP_MB`, 3072 Mo), échantillonnage du RSS de l'arbre node, échec au-delà du plafond (`BUILD_MEM_LIMIT_MB`, 4200 Mo par défaut). La garde contre le retour de l'OOM Render — elle ne vaut que parce qu'elle mesure la MÊME configuration que le déploiement. |
| `npm run bundle:plafond` | Même mesure, **en échec si la coque dépasse `PLAFOND_COQUE_KB`** (175 kB gzip, mesuré 166,1 kB le 2026-10-28) — lancé par la CI après `build:render`. |
| `node scripts/mesure-bundle.mjs` | **JS payé par chaque page** (gzip) après un build propre : coque (layout racine + `(app)`), page la plus légère, médiane, les plus lourdes, depuis `app-build-manifest.json`. `COQUE_MAX_KB=…` : sortie en erreur au-delà du plafond. |
| `npm run autotest` | **Auto-testeur** — audit de cohérence pages ↔ gardes ↔ menu ↔ matrice RBAC (déterministe, aucun serveur). Voir `scripts/auto-test/README.md`. |
| `npm run autotest:live -- --base-url=…` | Crawl **en direct** (Playwright) : passe anonyme (fuites d'accès) + passes par rôle (accès réel vs RBAC, uploads jetables). |

---

