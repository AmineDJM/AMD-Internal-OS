# Module `acces-bases` — l'accès par base (lots D1-D5, décision 0057)

Un niveau **au-dessus des modules** : pour un rôle ou une personne, une base (famille de tables du catalogue
`docs/architecture/BASES-DE-DONNEES.md`) est *Normale*, *En lecture seule*, *Fermée* ou *Ouverte*. Daté, motivé,
journalisé, révocable ; la personne prime sur son rôle ; aucune exception (le Super Admin aussi), avec un garde-fou
anti-verrouillage sur « Comptes & droits ».

| Porte | Rôle | Qui l'importe |
|---|---|---|
| `partage.ts` | Porte pure : catalogue généré (`domaine/catalogue.genere.ts`), règle (`niveauPour`, `droitEffectif`, garde-fous) | partout, navigateur compris |
| `api.ts` | Porte serveur : réglages (`poserReglage`, `revoquerReglage`), paramètres, « qui voit cette base ? » | page `/admin/access/bases`, actions |
| `actions.ts` | Clé `acces-bases-actions` : poser / révoquer un réglage, ses propres données — Super Admin réel, réversibles | console |
| `ecrans/console-bases.tsx` | La console | page `/admin/access/bases` |

- **Tables** : `AccesBase` (réglages datés), `AccesBaseParametre` (ses propres données quand la base est fermée).
- **Catalogue** : généré par `npm run bases:generer` depuis `scripts/bases-de-donnees/` ; le cliquet
  `src/platform/bases-de-donnees.test.ts` exige que chaque table du schéma soit rangée exactement une fois.
- **Une IA ne règle jamais les accès** : `accesBase` et `accesBaseParametre` sont des modèles interdits au chemin générique.
- **La garde (D3)** : `infra/garde.ts` (évaluateur synchrone, branché au démarrage par `src/instrumentation.ts`) sur le
  port du socle `src/platform/donnees/` (contexte de la requête, extension Prisma posée dans `src/lib/prisma.ts`).
  En OBSERVATION : elle compte ce qu'elle aurait refusé (`ObservationAccesBase`, `infra/observations.ts`), ne refuse rien.
- **SQL brut** : cliquet `sql-brut.test.ts` — la liste des fichiers qui touchent une base métier hors de la garde rétrécit.
- **Application stricte (D4)** : `AppSetting.accesBasesStrict` (AUCUNE par défaut / SENSIBLES / TOUTES), console + action
  `reglerAccesBasesStrict`. Le plan (refus avec empreinte, colonnes de référence, ses propres données) est calculé par
  `platform/donnees/garde.ts` et appliqué dans `lib/prisma.ts` ; l'écran d'erreur `(app)/error.tsx` lit l'empreinte.
