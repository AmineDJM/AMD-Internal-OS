# 0031 — L'analyse de données : chiffres exacts, tableaux, Excel, graphiques (lot K1, 31/10/2026)

**Lot K1 de l'Assistant IA / Adventum IA.** La Direction : « L'analyse de données, les chiffres, les tableaux, Excel, c'est
hyper important. Adam le fait très bien : inspire-toi de lui. » Objectif : l'Assistant IA calcule aussi bien qu'Adam, **avec
les droits de la personne**, dans l'ERP (`/assistant`) comme dans l'app Adventum IA (`/ia`).

> Code : socle `src/platform/ia/analyse/` (moteur, composeur, tableur, classeur, port SQL), `workspace/analyse.ts` (le bloc),
> `ecrans/blocks/analyse.tsx` (+ `analyse.css`, `export-graphique.ts`) ; module `src/modules/assistant-ia/` —
> `infra/analyse/outils.ts` (les quatre outils), `infra/analyse/classeur.ts`, `domaine/analyse/` (jeux du tour, colonnes
> confidentielles, chiffres non sourcés, intention), `domaine/ui/graphique.ts` (le `chart` du modèle) ; route
> `app/api/assistant-ia/analyse/classeur`. Aucune migration. Banc : `npm run bench:live -- scripts/bench/analyse-k1.ts`.

## 1. Le moteur d'Adam devient un PORT du socle — déplacé, pas copié

Le bac à sable d'Adam (`src/lib/sandbox/`) était un domaine de l'ERP que seul le pont d'Adam (`platform/in-process/sandbox`)
importait. Le socle IA est à **176 imports vers l'ERP pour un plafond de 177** (`SOCLE_IA_CEILING`, qui ne se relève pas) :
l'importer depuis le socle aurait coûté six franchissements. On a donc **déménagé** au socle tout ce qui est pur ou
seulement Node — `analyse.ts` (opérations), `pipeline.ts`, `viz.ts` (`recommanderGraphique`, `verifierGraphique`),
`porte.ts` (inspecter → exécuter → tester → valider), `js.ts` (worker isolé), `python.ts` (processus isolé, sondé) — avec
leurs tests (`git mv`) ; le pont d'Adam les **réexporte** du socle, comme avant. Ne reste dans `lib/sandbox/` que `sql.ts`
(Prisma, rôle `amd_sandbox_ro`), atteint par **une** porte du socle (`analyse/sql.ts`, +1) — compensée dans le même lot :
`teach/store.ts` réexporte des noms déjà importés au lieu d'importer deux fois `lib/teach/model` (−1). **Solde : 0.**
La lecture des tableurs (`cellule`, `entetesDe`, `lireCsv`, `versLignes`) quitte aussi le pont d'Adam pour
`analyse/tableur.ts` : une seule lecture des fichiers pour les deux assistants. Au passage, `regrouper` / `croiser` /
`cohortes` ne recopient plus leurs groupes à chaque ligne (quadratique sur 50 000 lignes).

## 2. Les outils de l'Assistant IA — toujours sous les droits de la personne

| Outil | Ce qu'il fait | Droit |
|---|---|---|
| `lire_tableur` | Excel (toutes les feuilles) / CSV joint ou du Drive, **typé** : ligne d'en-tête trouvée (un titre au-dessus est sauté), types, formules → leur valeur (celles sans valeur enregistrée sont comptées et dites), « 12 345,50 » → 12345,5, une date FR → ISO, un code à zéro de tête reste un texte | `canViewDrive` (socle `drive.ts`) ; famille « Drive & documents » |
| `analyser_donnees` | le pipeline fermé (filtrer, regrouper, croiser, trier, limiter, série, moyenne mobile, croissance, cumul, tendance, rang, anomalies, cohortes, scénario) sur un **jeu du tour** | celui de la source |
| `calculer_code` | JavaScript isolé (toujours), Python s'il est présent (sondé, sinon dit) — porte de qualité du socle | aucun propre ; **chaque nombre** de `params` et du code vient de la demande (ou est une constante : 100, 12, une puissance de dix…) |
| `requete_sql` | lecture seule, 500 lignes, 5 s, audit | **vue globale seulement** (la règle d'Adam : le SQL libre traverse le cloisonnement par société) |

**Les jeux du tour** (`domaine/analyse/jeux.ts`) : la sortie de chaque LECTURE du tour (après le filtre de confidentialité —
une rémunération y est déjà un repère ⟦Sn⟧) devient un jeu nommé par l'outil (« read_budget », « demandes_adpro »,
« demandes_adpro.demandes ») ; une feuille de tableur « Fichier.xlsx#Feuille » ; un résultat « sql:<titre> » ou
« analyse:<titre> » (une analyse s'enchaîne sur la précédente). Le modèle **nomme** un jeu, il ne recopie jamais de lignes.

**Les colonnes confidentielles** (`domaine/analyse/confidentialite.ts`) : un en-tête qui CONTIENT un mot sensible
(« Salaire de base (DZD) », « N° IBAN », « Rémunération brute », « Net à payer »…) est masqué **avant le calcul** — une
somme de salaires est un salaire ; les mots courts (RIB, NIN, CNI) ne valent qu'en mot entier (« Attribution » passe). Les
cellules passent ensuite le coffret du tour (IBAN dans un texte → repère). Le SQL garde ses `COLONNES_MASQUEES`.

**Registre et sélection** : les quatre outils sont des fiches du module (registre J6 : `outil:<nom>`, R0) ; `MOTS_CLES` de
la sélection ; règle 15 de la consigne (`contexte.ts`, dite seulement quand un outil d'analyse est offert). **Mesuré au
premier passage réel** : la présélection plein texte ne gardait pas `analyser_donnees` dans le budget fixe de 3 800 jetons
d'outils, et le modèle additionnait de tête. Une demande chiffrée (`domaine/analyse/intention.ts` : total, par mois,
évolution, part, classement, Excel joint…) met désormais les outils d'analyse **en tête des candidats** (`preselectionner`,
`prioritaires`) — ils entrent dans le budget avant les autres, sans le dépasser.

## 3. Chiffres exacts — le code calcule, le modèle cite

- Le résultat devient un **bloc `analyse`** composé par le socle (`analyse/bloc.ts`) et posé SOUS la réponse (pas un
  composant du modèle) : cellules TYPÉES (un nombre reste un nombre), formats lus sur le pipeline (« somme(montant) » est en
  DZD, un compte un entier, une croissance un %), totaux = somme exacte de **toutes** les lignes (pas des moyennes ni des
  taux), graphiques construits depuis les lignes. `provenance: "Calculé par le code"`.
- Le modèle reçoit un **aperçu aux chiffres déjà formatés** (« 12 345 678 DZD », « 12,5 % » — la même fonction
  `affichage.ts` que l'écran) et la consigne de les citer tels quels.
- **« Comment c'est calculé »** (sous le tableau) : sources, moteur, chaque étape avec sa **formule** en clair
  (`analyse/journal.ts` : « par societe : somme(montant) → sum_montant », « (valeur − valeur précédente) ÷ |valeur
  précédente| × 100 »), lignes avant → après, résultats (tendance, scénario), ce qui a été ignoré, refusé, masqué.
- **Le garde-fou du message** (`domaine/analyse/chiffres.ts`) : après une analyse, chaque nombre du texte doit se retrouver
  dans les sorties d'outils du tour à l'arrondi d'affichage près ; sinon une note « À vérifier » le dit sous la réponse (et
  le banc la compte).

## 4. Excel

- **Lecture** typée : § 2.
- **Production** (`analyse/classeur.ts`) : feuille « Analyse » (en-tête figé, filtre automatique — `SpecFeuille.filtre`
  ajouté au constructeur, formats `#,##0.00 "DZD"`, `0.0" %"`, `#,##0`, `dd/mm/yyyy`, largeurs lues sur le contenu, ligne
  **Total en vraies formules `=SUM()`**), une feuille par graphique (ses catégories et séries), feuille « Méthode ». Le
  classeur passe par le **constructeur vérifié** du socle (recalcul + audit : un total faux ne part pas).
- **Téléchargeable d'un clic** depuis la réponse (route `POST /api/assistant-ia/analyse/classeur` : l'écran envoie les
  lignes qu'il montre, filtrées — relues et bornées par `analyse/lecture.ts`, totaux recalculés par les formules, rien lu
  de la base) ; **« Enregistrer dans mon Drive »** (dossier « Analyses », inscrit à la Bibliothèque) **sur le geste de la
  personne seulement** — l'assistant n'écrit rien de lui-même (doctrine : une écriture est une carte ou un geste) ; refusé
  en « Vue exacte ».

## 5. Tableaux

Tri par colonne (nombres comme nombres, vide à la fin), filtre texte (sans accents) et filtre par valeur (la première
colonne de libellés à ≤ 30 valeurs), totaux recalculés sur les lignes visibles (« Total (filtré) »), export CSV (`;`, BOM,
virgule décimale) et Excel. iPhone : le tableau défile **dans sa boîte** (`overflow-x: auto`), la page jamais ; première
colonne et en-tête figés ; cibles de 44 px ; champ à 16 px. Charte Adventum (`--aia-*`, clair et sombre) dans l'app, jetons
de l'espace de travail ailleurs.

## 6. Graphiques

- Le bloc `analyse` et le composant `chart` du modèle (`domaine/ui/graphique.ts`, une ligne d'enregistrement dans
  `composants.ts`) savent : barres, **barres groupées**, barres empilées, courbe **multi-séries**, **aires**, secteurs,
  **anneau**, **nuage**, **heatmap**, **cascade**, histogramme (les formes de `VIZ_TYPES`).
- **Choix automatique** (`recommanderGraphique`) quand le modèle n'en demande pas ; **garde anti-trompeur**
  (`verifierGraphique`, étendue aux aires : axe tronqué, aire sans axe de temps) : une forme TROMPEUSE demandée (huit parts
  en secteurs, une courbe sans temps) est **remplacée** et la note le dit ; les alertes « À vérifier » restent affichées.
- **Export** de chaque graphique en **PNG** (2×) et **SVG** autonomes — rendu côté navigateur depuis le dessin, styles
  calculés posés (les jetons du thème ne survivent pas hors de la page), fond blanc — et **ses données en Excel**.
- Images et vidéos (lot K2) : non touchées.

## 7. Preuves

- Tests : `platform/ia/analyse/bloc.test.ts` (composeur, formats, totaux, garde, journal, tableur xlsx/CSV, classeur :
  formule `SUM(B2:B4)` recalculée à 2 850 000, filtre, volets figés ; relecture bornée), `modules/assistant-ia/analyse.test.ts`
  (colonnes confidentielles, chiffres non sourcés, jeux, `chart` étendu, outils de bout en bout, SQL fermé sans vue globale).
- **Banc réel** (`scripts/bench/analyse-k1.ts`, amd_bench, Super Admin) : 16 demandes (ventes ×6, budgets ×2, Ad & Pro ×2,
  RH ×1, Excel joint ×3, projection ×1, pilotage ×1) ; chaque chiffre attendu recalculé **indépendamment** (SQL brut sur la
  base, TypeScript sur les lignes semées). Résultats : voir `docs/readme` (journal K1) et le rapport du lot.

## 8. Ce qui n'est pas fait / à décider

- Le tableau affiche 200 lignes au plus (le calcul vaut pour toutes, l'aperçu du modèle en porte 40) ; au-delà, c'est
  l'agrégation ou le classeur.
- Le dépôt automatique d'un classeur au Drive par l'assistant (sans geste) n'est **pas** fait : à décider par la Direction
  (doctrine des écritures).
- `requete_sql` reste réservé à la vue globale (même règle qu'Adam) ; un SQL « sous la portée de la personne » demanderait
  un filtrage ligne à ligne par société — hors lot.
