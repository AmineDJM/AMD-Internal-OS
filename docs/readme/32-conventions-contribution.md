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

---

<div align="center">

**© 2026 Adventum Pharma — AMD Internal OS**

*Un seul outil. Toute l'entreprise. 100 % digitalisé.*

</div>
