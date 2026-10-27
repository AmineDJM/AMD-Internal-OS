# Module `consommation` — Consumption Intelligence (module pilote)

Premier module migré vers la structure cible du monolithe modulaire
(`docs/audit/2026-10-27/08-architecture-code.md`, §3).

| Dossier / fichier | Rôle | Peut importer |
|---|---|---|
| `api.ts` | **Seule porte serveur** : commandes, requêtes, types publics | `domaine/`, `infra/` |
| `domaine/` | Règles pures : lecture d'un classeur, résolution, affinité, regroupement de la revue | `domaine/`, socle pur |
| `infra/` | Prisma et fichiers : pipeline d'import, lectures des écrans, lignes du marché | `domaine/`, socle |
| `ecrans/` | Composants React (téléversement, revue, réglage d'affinité) | `domaine/`, actions serveur, `components/ui` |

- Pages : `src/app/(app)/consommation/**` — minces, elles gardent les droits puis appellent `api.ts`.
- Actions serveur : `src/lib/actions/consommation-actions.ts` (le contrat des actions est indexé par
  nom de fichier ; elles rejoindront `actions.ts` ici quand il ne le sera plus — ARCH-03).
- Tables : `ConsommationImport`, `ConsommationLigne`, `ConsommationMemoire`, `AffiniteConfig`.
- Consommateurs : `lib/segmentation/service.ts`, `lib/queries/vue-360.ts` (par `api.ts`).
- Frontières tenues par `src/modules/frontieres.test.ts` et ESLint (`no-restricted-imports`).
