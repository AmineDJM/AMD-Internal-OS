## 🤝 Conventions & contribution

- Développement sur la branche **`claude/hopeful-goodall-phd0nb`**.
- Tout doit être **réel et vérifié** : `typecheck` + `build` + `tests` + `npx next lint` **verts** avant de pousser (Render lance le lint AVANT le build, §118.155). **Aucune donnée simulée.**
- Les fichiers `"use server"` n'exportent **que** des fonctions `async`.
- Migrations : SQL manuel dans `prisma/migrations/<ts>_<nom>/migration.sql` + `prisma migrate deploy` (idempotent).
- Références séquentielles via `src/lib/refs.ts` (`buildRef` + `createWithRetry`) — **jamais** `count()+1`.
- `PERMISSIONS` (rbac.ts) est **exhaustif** : tout nouveau rôle impose une entrée (le typecheck l'exige).
- Secrets **toujours côté serveur**, jamais committés ni exposés au client.
- Écrans (V3-B) : une action serveur s'appelle par `useAction` / `useKeyedAction` / `useFormAction`
  (`components/shared/use-action.ts`) ; une confirmation par `BoutonDecisif` (argent, décision, signature) ou
  `useConfirmer()` / `useSaisir()` (`components/ui/dialogue.tsx`) ; un retour par `<Retour>` / `useRetours()`
  (`components/ui/retour.tsx`). **Jamais** `window.confirm/alert/prompt`, `router.refresh()` à la main, ni
  `?? "Échec."` — cliquets à zéro.
- **Un `catch` ne tait pas son erreur** (lot V3-E, [`src/lib/journal.ts`](../../src/lib/journal.ts)). Jamais `.catch(() => [])` :
  - `.catch(sansBloquer("domaine.ce-qui-a-echoue", repli))` — une **panne tolérée** : l'écran garde son repli, l'échec part
    au journal (une ligne JSON : `ts`, `niveau`, `evenement`, contexte, `erreur` tronquée, `repetitions` tues), il est
    **compté**, et 5 échecs dans l'heure alertent le Super Admin (notification agrégée, `src/lib/incidents-repetes.ts`) ;
  - `.catch(attendu("raison", repli))` — un **rejet normal** (corps de requête illisible envoyé par un client, fichier
    facultatif, fermeture au mieux) : rien n'est journalisé, la raison est écrite là où on la lit ;
  - `journal.erreur / .avertissement / .info(evenement, contexte?, erreur?)` pour le reste.
  Le cliquet `src/lib/journal-catch-muets.test.ts` exige **zéro** `catch` muet côté serveur (exceptions nommées et
  motivées dans le test) et ne laisse que baisser le reliquat client.

---

<div align="center">

**© 2026 Adventum Pharma — AMD Internal OS**

*Un seul outil. Toute l'entreprise. 100 % digitalisé.*

</div>
