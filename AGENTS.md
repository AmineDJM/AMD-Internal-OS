# Règles pour tout agent de code (Claude Code, Gemini / Antigravity, Codex…)

Ce dépôt est l'ERP interne d'Adventum Pharma, **en production sur Render**. Le détail du projet est dans
`CLAUDE.md` ; ces règles s'y ajoutent et valent pour TOUS les agents.

## Branches — la règle qui protège la production

- Travailler **uniquement sur `dy`**. Faire `git pull` avant de commencer.
- **Ne jamais pousser sur `claude/hopeful-goodall-phd0nb`** sans demande explicite de l'utilisateur :
  Render déploie automatiquement cette branche. Un push = une mise en production.
- **Un seul agent à la fois** sur ce dépôt.
- Push en HTTPS (le SSH est bloqué sur ce réseau) :
  `git push https://github.com/AmineDJM/Regulatory-Affairs.git dy`. Pas de pull request.
- Aucune ligne `Co-Authored-By` dans les commits.

## Avant chaque commit de code

```bash
NODE_OPTIONS=--max-old-space-size=9216 npx tsc --noEmit
rm -rf .next && TYPECHECK_SEPARE=1 NODE_OPTIONS=--max-old-space-size=3072 npm run build
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/amd_test" OPENAI_API_KEY= ANTHROPIC_API_KEY= MISTRAL_API_KEY= MIMO_API_KEY= npx vitest run
npx next lint
```

- Sous Windows, `npm test` ne marche pas (syntaxe POSIX) : lancer `vitest` directement comme ci-dessus.
- Les clés d'IA sont VIDÉES pour les tests : Prisma charge `.env`, et une clé présente fait tenter de vrais appels.
- **Les tests ne visent jamais `amd_dev`** (copie des données réelles) : toujours `amd_test`.
- La branche a déjà des échecs de tests connus : un commit ne doit en ajouter **aucun**.

## Assistant IA — chantier en cours

- Le cadrage et toutes les décisions sont dans `docs/assistant/decisions/` : **les lire avant de toucher
  à `src/modules/assistant-ia/` (ex-`src/lib/agent/`) ou `src/app/(app)/assistant/`**. Elles font office de spécification.
- Le faux modèle (`src/modules/assistant-ia/infra/testing/`) sert **uniquement aux tests**, jamais à une réponse réelle.
- Tout ce qui part au modèle (MiMo ou autre) passe par le filtre de confidentialité
  (`src/modules/assistant-ia/domaine/filtre-confidentialite.ts`) : aucune rémunération, coordonnée bancaire ni pièce d'identité.
- Aucune écriture en base depuis le modèle : un outil prépare une intention, l'utilisateur confirme,
  l'action métier existante l'exécute. Le RBAC est le plafond.
- Ne pas modifier une migration déjà appliquée : en ajouter une nouvelle, idempotente.
- Clés (MiMo, Render…) : seulement dans `.env` (ignoré par git) ou sur Render. Jamais dans le code.
