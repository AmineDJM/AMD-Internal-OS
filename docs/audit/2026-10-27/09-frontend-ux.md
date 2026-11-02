# 09 — Audit Frontend, UX, accessibilité, mobile, design system

> Audit du 27/10/2026 · branche `audit/frontend-ux` (base `claude/hopeful-goodall-phd0nb`, `456c8f6`).
> Périmètre : `src/components/*`, `src/app/(app)/*` — design system (`src/components/ui`), formulaires,
> accessibilité, mobile, états vides, messages d'erreur, performance côté client.
> Méthode : lecture ciblée (après `docs/knowledge-base/05-frontend-ui-ux.md`, qui n'est pas répété ici),
> scans de source scriptés, et **application réellement lancée** (build de production propre, base Postgres
> locale, compte Super Admin issu de `prisma/bootstrap.ts`) pilotée par Playwright/Chromium en 1366×860 et
> 375×812. Captures et mesures brutes : [`captures/`](captures/) (script : `captures/audit-playwright.js`,
> mesures : `captures/mesures-playwright.json`).

---

## 1. Synthèse

**Note du périmètre : 6,5 / 10.** L'UI est sobre, cohérente et vraiment pensée pour le téléphone : sur les
7 écrans clés mesurés (Ad & Pro, centre de paiement, Drive, RH, Assistant IA, Mon espace, Sponsoring), **zéro
débordement horizontal à 375 px, zéro erreur console, zéro champ visible sans libellé**, rendu serveur en
0,7–0,95 s. Les doctrines maison (`BoutonDecisif`, `useAction`, `useRafraichir`, cliquets de source) sont
excellentes — mais **appliquées à une minorité du parc**, et c'est là que sont les risques :

1. **Les actions serveur appelées sans garde (318 points d'appel)** — mesuré au navigateur : une coupure
   réseau fige le bouton pour toujours (appel en `onClick`) ou **remplace la page entière par l'écran d'erreur
   en perdant la saisie** (appel en `<form action>`). Corrigé sur les écrans de décision d'argent ; cliquet posé.
2. **La couche modale `Sheet` (128 importeurs) ne gérait pas le focus** — mesuré : 43 Tab sur 60 parcouraient
   la page *derrière* le voile. Corrigé.
3. **Pas de primitive de retour (toast / bandeau) ni de dialogue** : 125 `confirm()`, 45 `alert()`,
   161 « Échec. » génériques, 22 surcouches ad hoc dont 12 sans `role="dialog"` — chaque écran réinvente.

---

## 2. Constats

| ID | Sévérité | Catégorie | Titre | Effort | Statut |
|---|---|---|---|---|---|
| FRONTEND-UX-01 | HAUTE | Correction / UX | Actions serveur non gardées : bouton figé ou page entière remplacée | M (parc) | CORRIGÉ sur les écrans de décision (`e57809c`, `560ea7e`) + cliquet ; reste PROPOSÉ |
| FRONTEND-UX-02 | HAUTE | Accessibilité | `Sheet` : `aria-modal` sans gestion du focus | S | CORRIGÉ (`aa7f91e`) |
| FRONTEND-UX-03 | MOYENNE | Accessibilité | `DataTable` : tri, lignes et pagination inutilisables au clavier | S | CORRIGÉ (`6d8a16d`) |
| FRONTEND-UX-04 | MOYENNE | Correction / UX | « Analyser le contrat » (IA) peut tourner indéfiniment | S | PROPOSÉ |
| FRONTEND-UX-05 | MOYENNE | UX / design system | Retours d'erreur et confirmations hétérogènes, sans primitive | M | PROPOSÉ |
| FRONTEND-UX-06 | MOYENNE | Accessibilité | Surcouches ad hoc (menus mobiles, tiroirs) sans rôle, sans Échap, sans focus | M | PROPOSÉ |
| FRONTEND-UX-07 | BASSE | Accessibilité | L'Assistant IA n'a pas de titre `<h1>` | S | PROPOSÉ |
| FRONTEND-UX-08 | BASSE | UX mobile | Drive au téléphone : « faites un clic droit », et 5 boutons avant le contenu | S | PROPOSÉ |
| FRONTEND-UX-09 | BASSE | Copie | Réglages : « jusqu'à 2 048 Mo » alors que le champ accepte 10 240 | S | PROPOSÉ |

### FRONTEND-UX-01 — Actions serveur non gardées : bouton figé ou page entière remplacée (HAUTE)

- **Preuve.** Le patron que `src/components/shared/use-action.ts` et `src/lib/action-outcome.ts` ont été écrits
  pour tuer est encore présent dans **318 points d'appel** (scan : `const r = await f(…)` sans `try` dans les 12
  lignes précédentes, suivi d'un `setX(false|null)` ; échantillon de 6 relu à la main, 6 vrais positifs). Avant
  correctif, au centre de paiement :
  ```tsx
  // src/app/(app)/centre-de-paiement/centre-board.tsx:321-332 (base)
  <form action={async (fd) => {
    setBusy(true); setErr(null);
    …
    const r = await decidePayment(fd);
    setBusy(false);
  ```
  et `src/app/(app)/ad-pro/autres/[id]/decision-panel.tsx:43` (`const r = await fn(fd); setBusy(null);`).
  Répartition : `admin` 36, `regulatory` 30, `rh` 15, `medical` 13, `drive` 12, `validations` 11, `stocks` 11…
  dont `drive-table.tsx` (corbeille, déplacement, partage), `rh/demandes/file-demandes-rh.tsx` (5 décisions RH),
  `finances/paiements-a-faire/orders-table.tsx` (régler, différer un ordre).
- **Scénario réel — mesuré au navigateur** (requête d'action serveur coupée par Playwright, `internetdisconnected`) :
  - appel en `onClick` (`/admin/versions`, « Activer le mode test ») : 8 s plus tard le bouton est toujours
    `disabled` avec sa roue, aucun message → [`captures/action-onclick-bloquee.png`](captures/action-onclick-bloquee.png).
    Même sort pour « Valider / Refuser / Terminée / Annuler » d'une demande Ad & Pro « autres ».
  - appel en `<form action>` (`/admin/settings`, « Enregistrer les limites ») : la levée remonte à
    `src/app/(app)/error.tsx`, **la page entière devient « Cette page n'a pas pu s'afficher… Réessayez »** et la
    saisie est perdue → [`captures/action-non-gardee-bloquee.png`](captures/action-non-gardee-bloquee.png).
    Au centre de paiement, c'est le motif de refus qui disparaît, sans savoir si la décision est partie — et
    l'écran conseille « Réessayez », exactement ce que la doctrine interdit (doublons).
  - requête suspendue (conteneur Render redémarré) : `busy` reste vrai et la feuille du centre de paiement ne
    peut même plus se fermer (`onClose={() => !busy && setActing(null)}`).
  Qui : un délégué en 4G, ou n'importe qui pendant un redéploiement (« Failed to find Server Action »).
- **Correctif appliqué.** Centre de paiement → `useAction()` (attrape, chronomètre 45 s, message « vérifiez
  d'abord la liste », rafraîchissement suivi §118.172) ; panneau Ad & Pro « autres » → `try/catch/finally` +
  `actionFailureMessage("THROWN")`. Cliquet `src/lib/ui/action-gardee.test.ts` : ces écrans à zéro, parc
  plafonné à **315** (mesuré après correctif) — il ne peut que baisser. `rafraichir.test.ts` accepte désormais
  `useAction()`/`useKeyedAction()` comme preuve de rafraîchissement suivi (ils passent par `useRafraichir`).
- **Correctif proposé pour le reste.** Convertir par lots de domaine, dans l'ordre du risque : décisions d'argent
  (`finances/paiements-a-faire`, `rh/demandes`, `validations`), puis Drive, puis l'administration ; descendre le
  plafond à chaque lot. Voir § 3 (`useFormAction`).
- **Effort** S par écran, M pour le parc. **Statut** CORRIGÉ (`e57809c`, `560ea7e`) pour les deux écrans de
  décision ; PROPOSÉ pour les 315 restants.

### FRONTEND-UX-02 — `Sheet` : `aria-modal` sans gestion du focus (HAUTE)

- **Preuve.** `src/components/ui/sheet.tsx` (base) : `role="dialog" aria-modal="true"`, Échap géré, mais aucun
  `focus()`, aucun piège de tabulation, aucune restitution. 128 fichiers l'importent (toutes les créations par
  `CreateRecordButton`, les décisions du centre de paiement, les fiches RH…).
- **Scénario réel — mesuré** (`/sponsoring`, « Nouvelle demande » ouvert au clavier, 60 × Tab) :
  avant : focus à l'ouverture **hors** de la feuille (sur le bouton derrière le voile), **43 Tab sur 60 hors de la
  feuille**, et après Échap le focus atterrit sur un lien sans rapport (« Direction artistique »).
  Après : focus sur le premier champ, **0 Tab sur 60 hors de la feuille**, focus rendu à « Nouvelle demande »
  ([`captures/sheet-focus-avant.png`](captures/sheet-focus-avant.png), [`sheet-focus-apres.png`](captures/sheet-focus-apres.png)).
  Un utilisateur de lecteur d'écran entend la page masquée ; un utilisateur clavier remplit… la recherche globale.
- **Correctif appliqué.** Règle pure `src/components/ui/sheet-focus-regle.ts` (`sautDeFocus`) + câblage dans
  `sheet.tsx` : premier champ focalisé (le panneau lui-même sur écran tactile, pour ne pas faire monter le clavier
  virtuel), Tab/Maj+Tab bouclés, une modale ouverte par-dessus garde son propre focus, focus rendu à l'ouvreur.
  Test `sheet-focus.test.ts`.
- **Effort** S. **Statut** CORRIGÉ (`aa7f91e`).

### FRONTEND-UX-03 — `DataTable` : tri, lignes et pagination inutilisables au clavier (MOYENNE)

- **Preuve.** `src/components/shared/data-table.tsx` (base) : tri sur `<TableHead onClick>` (pas focalisable, pas
  d'`aria-sort`) ; `<TableRow onClick={() => router.push(href)}>` sans `tabIndex` ni touche ; recherche sans nom
  accessible (placeholder seul) ; flèches de pagination `size="icon"` sans `aria-label`.
- **Scénario réel.** Sur `/sponsoring` ou `/logistics` (`getRowHref`), une personne au clavier ne peut ni trier ni
  ouvrir une demande ; un lecteur d'écran annonce « bouton » deux fois sans dire lequel.
- **Correctif appliqué.** Bouton dans l'en-tête + `aria-sort`, ligne `tabIndex=0` ouverte par Entrée,
  `aria-label` sur recherche et pagination. Test de rendu React `data-table-a11y.test.ts` (4 échecs avant, 0 après).
- **Effort** S. **Statut** CORRIGÉ (`6d8a16d`).

### FRONTEND-UX-04 — « Analyser le contrat » (IA) peut tourner indéfiniment (MOYENNE)

- **Preuve.** `src/components/shared/create-record-button.tsx:453` (`runAnalyze`) et
  `src/app/(app)/rh/[id]/employee-form.tsx:119` : `setAnalyzing(true); const r = await analyze…(fd); setAnalyzing(false);`
  — ni `try`, ni chronomètre. Le formulaire principal du même fichier, lui, est gardé (commentaire « LE BOUTON
  NE PEUT PLUS TOURNER INDÉFINIMENT »).
- **Scénario.** RH → « Nouvel employé » → « Analyser le contrat » sur un PDF scanné de 20 pages (OCR Mistral + LLM) ;
  la connexion tombe → roue infinie, bouton grisé, aucun message ; la personne ferme la feuille et perd sa saisie.
- **Correctif proposé.** `try { … } catch { setAnalyzeMsg({ ok: false, text: "L'analyse n'a pas abouti (connexion ou serveur). Rien n'a été enregistré : vous pouvez relancer." }) } finally { setAnalyzing(false) }`
  — ici relancer est sûr (l'analyse n'écrit rien d'autre qu'un journal). Les deux sites sont dans le cliquet.
- **Effort** S. **Statut** PROPOSÉ.

### FRONTEND-UX-05 — Retours d'erreur et confirmations hétérogènes, sans primitive (MOYENNE)

- **Preuve (mesures sur `src/**/*.tsx`).** `confirm(` 125 ; `alert(` 45 (ex. `components/documents/document-preview.tsx:91`
  `window.alert(r.error ?? "Suppression impossible.")`) ; repli `?? "Échec."` **161**, `?? "Erreur."` 49,
  `?? "Action impossible."` 34 ; `aria-live` 25 occurrences seulement ; aucune primitive toast/bandeau.
- **Scénario.** Supprimer un document échoue → boîte `alert()` grise du navigateur (bloquante, non stylée, non
  annoncée comme le reste) ; ailleurs un « Échec. » qui ne dit ni quoi ni que faire — contraire à la doctrine
  de copie (« expliquer la conséquence, jamais réessayer à l'aveugle »).
- **Correctif proposé.** Primitive `ui/retour.tsx` (`<Retour ton="erreur|succes|info">`, `role="status"`/`"alert"`,
  `aria-live`) + bannir `alert(`/`confirm(` par cliquet ; remplacer le repli générique par
  `actionFailureMessage` ou un message par geste. Voir § 3 et § 4.
- **Effort** M. **Statut** PROPOSÉ.

### FRONTEND-UX-06 — Surcouches ad hoc sans rôle, sans Échap, sans focus (MOYENNE)

- **Preuve.** 22 fichiers posent un `fixed inset-0`, 10 seulement déclarent `role="dialog"`. Exemples relus :
  `src/components/layout/topbar.tsx:134` (menu de navigation mobile) et `src/components/layout/mobile-tabbar.tsx:220`
  (grille « Tout ») — ni `role`, ni Échap, ni focus ; `drive/drive-toolbar.tsx`, `drive/upload-button.tsx`,
  `messages/my-status.tsx`, `reminders/reminder-button.tsx`, `regulatory/regulatory-table.tsx` idem.
- **Scénario.** Tablette avec clavier (largeur < `lg`) : « Ouvrir le menu » → impossible de le refermer au clavier,
  Tab parcourt la page masquée ; le lecteur d'écran ne sait pas qu'un menu est ouvert.
- **Correctif proposé.** Extraire de `Sheet` une primitive `ui/couche.tsx` (`<Couche onClose label côté="gauche|droite|bas|plein">`)
  qui porte voile, z-index ≥ 50, `useScrollLock`, Échap, focus (la règle de FRONTEND-UX-02) ; `Sheet` et les
  tiroirs la composent. Cliquet : un `fixed inset-0` hors de `ui/` doit passer par elle.
- **Effort** M. **Statut** PROPOSÉ.

### FRONTEND-UX-07 — L'Assistant IA n'a pas de `<h1>` (BASSE)

- **Preuve.** Mesuré : `document.querySelector("h1")` est `null` sur `/assistant` (desktop et mobile), alors que les
  6 autres écrans clés en ont un (`PageHeader`). Capture [`assistant-desktop.png`](captures/assistant-desktop.png).
- **Correctif proposé.** `<h1 className="sr-only">Assistant IA</h1>` dans `src/app/(app)/assistant/page.tsx`.
- **Effort** S. **Statut** PROPOSÉ.

### FRONTEND-UX-08 — Drive au téléphone (BASSE)

- **Preuve.** `src/app/(app)/drive/page.tsx:237` : « Importez des fichiers, ou faites un clic droit ici pour créer un
  dossier. » affiché aussi au doigt (iOS ne déclenche pas `contextmenu`). À 375 px, les 5 boutons d'en-tête
  (Nouveau dossier, Nouveau document, Importer, Nouvelle catégorie, …) occupent ~40 % du premier écran
  ([`drive-mobile.png`](captures/drive-mobile.png)).
- **Correctif proposé.** Phrase neutre (« Importez des fichiers ou créez un dossier avec les boutons ci-dessus ») ;
  au téléphone, regrouper les créations derrière un seul bouton « Nouveau ».
- **Effort** S. **Statut** PROPOSÉ.

### FRONTEND-UX-09 — Réglages : texte et borne contradictoires (BASSE)

- **Preuve.** `src/app/(app)/admin/settings/admin-settings-forms.tsx` : `<Input id="maxDriveUploadMb" … max="10240">`
  et juste dessous « Fichiers du Drive (gros transferts en flux), jusqu'à 2 048 Mo. »
- **Correctif proposé.** Aligner la phrase sur la borne réelle (lue d'une constante partagée, pas écrite deux fois).
- **Effort** S. **Statut** PROPOSÉ.

### Mesures positives (vérifiées, pour ne pas les casser)

- 7 écrans × 2 largeurs : 0 débordement horizontal, 0 erreur console, 0 champ visible sans libellé, 0 bouton sans
  nom accessible (les seuls « champs sans libellé » sont des `<input type=file>` cachés).
- First Load JS (build propre) : `/assistant` 202 kB, `/centre-de-paiement` 279 kB, `/sponsoring` 299 kB,
  `/drive` 326 kB, `/ad-pro` 337 kB ; tronc partagé 87,9 kB. Les plus lourds : `/congress-*/[id]` 449 kB,
  `/events/[id]` 448 kB, `/sponsoring/[id]` 429 kB.

### À vérifier (soupçons non prouvés — hors constats)

- `DataTable` indexe ses lignes par position (`key={i}`) alors qu'il trie et pagine : une cellule à état local
  (case cochée, menu ouvert) passerait d'une ligne à l'autre après un tri. Aucun appelant actuel n'a été trouvé
  avec un tel état — à revérifier si on en ajoute.
- Les pages détail à ~450 kB (`/congress-*/[id]`, `/events/[id]`) : identifier le module lourd (soupçon : Recharts
  ou le tableau `lucide` complet via `Icon`, cf. KB 05 § 7) avec `@next/bundle-analyzer`.
- Une erreur d'hydratation React #418 vue sur `/sponsoring` lors d'un premier build **s'est révélée un artefact**
  (fichiers modifiés pendant la compilation) : absente du build propre, 0 erreur sur 8 écrans. Non retenue.
- Dates (`formatDate` sans fuseau) et charge des sondages (20 s / 15 s / 12 s par onglet) : déjà documentés dans
  `docs/knowledge-base/05-frontend-ui-ux.md` § 8 — non répétés.

---

## 3. Restructuration proposée

### Structure cible

```
src/components/ui/                 ← primitives SANS métier, testées, seules autorisées à poser une couche
  button.tsx  input.tsx  badge.tsx  card.tsx  table.tsx
  couche.tsx         (nouveau) voile + z≥50 + scroll-lock + Échap + focus (règle sheet-focus-regle.ts)
  sheet.tsx          compose <Couche côté="droite|bas">
  dialogue.tsx       (nouveau) remplace confirm()/alert() hors gestes décisifs : <Dialogue titre actions>
  retour.tsx         (nouveau) bandeau d'état inline : <Retour ton="erreur|succes|info"> (role=alert|status)
  bouton-decisif.tsx
src/components/shared/             ← assemblages réutilisables
  use-action.ts      useAction / useKeyedAction  (existant)
  use-form-action.ts (nouveau) la variante <form action> : (fd) => Promise<ActionResult>
  data-table.tsx  create-record-button.tsx  page-header.tsx  empty-state.tsx …
src/app/(app)/<module>/            ← écrans : RSC + îlots clients co-localisés (inchangé)
```

### Contrat : `useFormAction`

```ts
// src/components/shared/use-form-action.ts
export function useFormAction(
  fn: (fd: FormData) => Promise<ActionResult>,
  opts?: { onOk?: (r: ActionResult) => void; prepare?: (fd: FormData) => void },
): { action: (fd: FormData) => Promise<void>; busy: boolean; err: string | null; setErr: (e: string | null) => void };

// usage — remplace les 99 `action={async (fd) => { setBusy(true) … }}`
const decision = useFormAction(decidePayment, { prepare: (fd) => fd.set("id", order.id), onOk: () => setActing(null) });
<form action={decision.action}> … <Retour ton="erreur">{decision.err}</Retour>
```

Il se construit en quelques lignes sur `useAction().run` (verrou synchrone anti double-envoi en plus, comme
`RecordForm`). Une seule implémentation du « jamais figé, jamais réessayer à l'aveugle ».

### Chemin de migration (petites étapes sûres)

1. Ajouter `use-form-action.ts` + test ; convertir les décisions d'argent (`finances/paiements-a-faire`,
   `rh/demandes`, `validations`) ; descendre `PLAFOND_APPELS_NON_GARDES`.
2. Ajouter `ui/retour.tsx` ; l'utiliser dans `useFormAction` et `RecordForm` ; cliquet sur `alert(`.
3. Extraire `ui/couche.tsx` de `sheet.tsx` (même comportement, testé) ; y passer `topbar` et `mobile-tabbar`.
4. Ajouter `ui/dialogue.tsx` ; migrer les `confirm()` non décisifs par domaine (les décisifs vont à `BoutonDecisif`).
5. Un domaine par PR, plafonds descendus à chaque fois — jamais de grande refonte.

**Gain.** Une panne réseau ne fige plus ni ne vide un écran ; l'UI devient utilisable au clavier et au lecteur
d'écran sans effort par écran ; un nouvel écran n'a plus le choix de mal faire (il compose des primitives qui
portent la règle) ; le code par écran raccourcit (≈ 6 lignes d'état/garde en moins par formulaire).

---

## 4. Bonnes pratiques à graver

| Règle | Mécanisme | État |
|---|---|---|
| Toute action serveur appelée d'un îlot client passe par `useAction` / `useKeyedAction` / (`useFormAction`) ou un `try/finally` | Cliquet `src/lib/ui/action-gardee.test.ts` (plafond 315, ne peut que baisser) | **posé** |
| Toute couche modale gère le focus (entrer, rester, revenir) | `sheet-focus.test.ts` ; à étendre : « `fixed inset-0` hors de `components/ui/` interdit » | posé pour `Sheet` ; à étendre |
| Pas de `alert(` / `confirm(` dans `src/**/*.tsx` | Cliquet par comptage (125 / 45 aujourd'hui), plafond décroissant | proposé |
| Pas de repli d'erreur générique (`?? "Échec."`) | Cliquet par comptage (161) + `actionFailureMessage` / message par geste | proposé |
| Élément interactif = élément interactif (`button`, `a`) : pas de `onClick` sur `th`/`tr`/`div` sans `tabIndex` + touche | `eslint-plugin-jsx-a11y` (`click-events-have-key-events`, `no-static-element-interactions`, `control-has-associated-label`) en *warn*, puis *error* par dossier migré | proposé |
| Chaque page a un `<h1>` | Banc Playwright des écrans clés (`captures/audit-playwright.js`, à intégrer en CI : h1, débordement 375 px, champs sans libellé, erreurs console) | proposé |
| Ne pas modifier les sources pendant un `next build` qu'on va inspecter | Note de méthode : le serveur et le client compilés à des instants différents produisent de fausses erreurs d'hydratation (#418) | constaté |
