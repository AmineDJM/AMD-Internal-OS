# 0067 — « Adam lit tout » : une lecture générique, des droits invariants, un seul jeu d'outils (lot I4, 04/11/2026)

**Statut** : appliquée · **Suite de** : [0065](0065-primitives-lire-produire-fichier.md) (primitives I3),
[0064](0064-moteur-unique-acces.md) (profil d'accès I2), [0063](0063-observation-et-mail-en-blocs.md) (Observation I1),
[0055](0055-adam-complet-super-admin.md) · **Amorce** : I5 (contrôle final sur l'Observation)

> Direction, 04/11 : « C'est toujours une histoire d'architecture, tu m'as dit qu'il avait accès à tout bordel ! » —
> « Ce que je veux, c'est souple, léger, flexible, créatif, robuste… pas feature par feature… Il fait ce que moi je lui
> dis, pas selon ce qu'il trouve dans le code. » — « absolument pas d'accès aux autres ».

## Le cas de production et ses quatre causes

Mission « Cartographie des chefs de service d'infectiologie en Algérie » (Super Admin) : un xlsx d'UNE ligne « Non
disponible » partout, alors que `MedicalDoctor` porte titre, spécialité, établissement, service, wilaya, téléphone, e-mail.

1. Une mission ne recevait pas les outils d'Adam : `travaux.ts` construisait sa propre liste (`outilsV1` sans capacités,
   moins `PAS_UNE_LECTURE`).
2. `lire` (I3) ne connaissait que 5 vues écrites à la main.
3. Le plan était quatre titres creux, sans requête, jamais éprouvé — le schéma de l'étape ne déclarait aucune propriété
   pour `entree` : le modèle ne pouvait écrire que `{}` (mesuré au rejeu : 7 plans de suite refusés avant la correction).
4. Le livrable vide a été déclaré « livré » : rien ne comparait le livré au lu.

## 1. `lire` lit TOUTE table (A)

- **Schéma** : le DMMF de Prisma (chaque modèle, colonnes, énumérations, relations) — `infra/primitives/tables.ts`. Une
  table se nomme par son modèle, son pluriel ou son libellé du **catalogue des bases** (D1, désormais généré avec
  `FICHES_TABLES` : libellé et sensibilité de chaque table).
- **Déclaration** (pur, `domaine/primitives/tables.ts`) : colonnes et colonnes des relations à UN niveau
  (`institutionRef.name`, `wilayaRef.nom`) ; énumérations avec leurs **libellés d'écran**, rapprochés automatiquement de
  `@/lib/labels` par leurs codes (`CHEF_DE_SERVICE` → « Chef de service »). Aucun registre à tenir.
- **Filtres** : la normalisation d'I3 (dates dites, choix par libellé, accents, racines), poussée à la base quand elle s'y
  calcule exactement (choix, nombres, dates, oui/non — `clauseDeFiltre`), revérifiée en mémoire (« contient » tolérant) ;
  tri, limite, `compter_par`, `compter` (essai à blanc, avec « élargir : sans tel filtre → N » quand c'est zéro). Au-delà de
  20 000 lignes sous les filtres : `tronque`, dit.
- **Presets** : les 5 vues d'I3 ne sont plus un registre à part. `taches` et `demandes` deviennent des presets GÉNÉRIQUES
  (des noms français sur les colonnes de `Task` / `AdministrativeRequest`, `enRetard` calculé) ; `produits`, `etablissements`,
  `missions` gardent leur lecteur (étape du cycle, « commercialisé », diagnostic) mais leur portée est celle de la TABLE.
- **Lignes vivantes** (`VIVANTES`) : une fiche archivée de l'annuaire ne sort pour personne, sauf filtre explicite.

## 2. Les droits sont des invariants, échec fermé (B) — `droitDeLire`

1. **Base** ouverte à la personne : modules de la base ET niveau réglé par la Direction (`droitDeLireTable`, module
   `acces-bases`, appliqué à Adam même hors du mode strict) ; le coffre ne se lit jamais ; une table **secrète** du catalogue
   (fiche salarié, paie, comptes, journal d'audit…) seulement par le Super Admin.
2. **Familles** de la console qui couvrent la base (salaires, contrats RH, budgets, Ad & Pro…) — sinon le refus nommé.
3. **Portée des lignes** : `PORTEES`, une ligne par table, la clause de son écran importée (`porteeProduits`,
   `porteeMedecins` = le panel/secteur du délégué, `voitEtablissements`, `scopeAdminRequests`, cercle de Mon espace,
   `scopeMedicalVisits`, `scopeRegulatory` + `regulatoryLockWhere`, ventes, BD, congrès, sponsoring, support, dossiers,
   info médicale, matériel promo). **Une table sans portée déclarée n'est lue que par le Super Admin.**
4. **Colonnes jamais rendues** : coffre (`champSensible`), `COLONNE_SECRETE` (mots de passe, jetons, secrets), noms de
   rémunération hors de la base Paie. Une relation suivie hors de la portée de la personne est réduite à ses colonnes de
   référence (nom, titre — décision n° 7), vérifiée ligne à ligne après coup (`bornerLesLiees`) ; jamais vers plusieurs.

Le Super Admin lit tout le reste. Banc S1 (`audit-assistant.test.ts`) : **0 passée**, avec 7 sondes `lire` génériques de plus
(tâches d'autrui, paie d'autrui, colonnes du coffre de `Employee`, `AuditLog`, `User.passwordHash`, pièces RH, coffre).

## 3. Un seul jeu d'outils, conversation = mission = routine (C)

`outilsV1(…, { seulementLectures: true })` : LE catalogue de la conversation réduit à ses lectures. La mission le reçoit avec
les capacités (`capacites: true`, `lignesLues: 2000`), la routine sans. `ECRITURES_DU_MOTEUR` devient la seule liste de « ce
n'est pas une lecture » (cartes, fichiers, exports) — retirées : `PAS_UNE_LECTURE` (travaux) et `ECRITURES` + le filtre
`preparer_` (routines). Seuls les GESTES restent soumis aux autorisations du plan.

## 4. Le plan s'éprouve avant de partir (D)

- Le schéma d'une étape déclare enfin la forme de sa requête (`entree.table / filtres / champs / query`).
- `proposerTravail` → `eprouverLectures` : chaque LECTURE `lire` est comptée à blanc (`persona.essayer`) ; une table, un champ
  ou un droit faux est une **faute du plan**, rendue au modèle (il corrige) ; le résultat est posé sur l'étape
  (`etape.essai`) et affiché sur la carte du plan (« Essai à blanc : Médecin : 4 ligne(s) ; wilaya : 3 valeur(s)… »).
- **Zéro** : le plan ne part PAS d'office ; l'outil rend `LECTURE_VIDE` avec les élargissements, avant tout lancement.

## 5. Le livrable vient des données (E)

`deposerLivrableTravail` (xlsx) construit le classeur DEPUIS les lignes des étapes LECTURE (`classeurDesLectures`) : une
feuille par jeu, colonne **Source (fiche)** = lien de l'écran (`/praticiens/<id>`…), colonne **Vérification** (à jour /
ancienne — plus d'un an / incomplète — colonnes vides nommées), puis une feuille « Synthèse » : le texte du modèle (sa
consigne lui dit qu'il n'écrit QUE la synthèse) et les **limites calculées** (lignes sans telle colonne, période des mises
à jour, fiches anciennes). Une colonne vide sur tout le jeu sort. Un Word rédigé sur des lectures reçoit les mêmes limites.

## 6. Le contrôle final refuse le vide (F)

`domaine/observation/controle.ts` (sur le contrat Observation d'I1) : chaque lecture de la mission devient une observation
(LU + lignes + filtres, ou ÉCHEC + raison) ; `controlerLivrable` refuse un tableur sans ligne lue, et tout livrable d'une
mission dont les lectures tabulaires n'ont rien rendu. Le refus est **définitif** (pas de reprise) et nommé : « Livrable
refusé : aucune ligne issue d'une lecture réussie — « Chefs » (lire) : 0 ligne(s) (filtres : …) ». Une lecture fermée
(`FERMEE`, `INCONNUE`, filtre faux) est désormais un ÉCHEC de l'étape, plus une « réussite » vide. La notification de fin
dit la raison de l'échec (l'étape et son erreur), plus « une étape n'a pas pu aboutir ».

## 7. Ce qui est retiré

- `list_my_tasks`, `list_my_requests`, `search_products` (`lectures-erp.ts`) : masqués depuis I3, désormais **supprimés** —
  `lire` les lit sur leurs tables, même portée d'écran.
- Le classeur « Markdown du modèle mis en cellules » (`classeur()` de `travaux-livrables.ts`) : c'était le chemin du xlsx
  « Non disponible » ; inatteignable désormais.
- `schemaDeVue`, `decrireChamp`, les `portee` propres à chaque vue, les lecteurs écrits à la main de `taches` et `demandes`.
- Les listes parallèles de travaux et de routines (§ 3).

## 8. Preuves

- `src/modules/assistant-ia/lire-tout-i4.test.ts` (8) : les bons praticiens (ni professeur, ni cardiologue, ni archivé) ;
  le délégué ne voit que son panel (espion de Prisma : la fiche hors panel ne sort pas de la base) ; tables sans portée,
  secrètes, coffre ; essai et élargissements ; un seul jeu d'outils ; tableur depuis les données ; refus du vide.
- `primitives-i3.test.ts` (12) et `audit-assistant.test.ts` verts.
- **Rejeu au vrai modèle** (`scripts/bench/i4-lire-tout/rejouer.ts`, `gpt-6.1-terra`, base `amd_bench` locale, annuaire
  fictif, `ADAM_SORTIE_INTERDITE=1`, aucun canal ni jeton dans les processus) — preuves `docs/assistant/preuves/i4/` :
  - **mission** : plan proposé avec `lire { table: MedicalDoctor, filtres: specialtyRef.name contient infectiologie, title
    contient chef de service }`, essai « 4 ligne(s) », démarrée d'office, conduite par le **worker réel**
    (`npm run worker`, `TACHES_DE_FOND=les-deux`) → **COMPLETED**, xlsx : **4/4 chefs de service, 0 intrus**, liens
    `/praticiens/…`, « ancienne (mise à jour le 2024-03-01) » pour la fiche datée, limites calculées — **0,069 $** ;
  - **conversation Super Admin** : 4/4 — **délégué** : 2/2 (son panel), **0 hors secteur** — 0,049 $.
  - Avant la correction du schéma d'`entree`, le même rejeu donnait 7 plans `{}` refusés puis le délai du tour : la faute
    était dite, le vide ne partait plus ; c'est la cause n° 3 mesurée.

## 9. Poids (mesure `wc -l`, code de production de `src/modules/assistant-ia`, `src/lib/missions/travaux`, `src/modules/acces-bases`, hors tests, fichiers générés et semis de banc)

| | Lignes | Caractères |
|---|---:|---:|
| Avant (`origin/claude/hopeful-goodall-phd0nb`) | 51 138 | 3 260 029 |
| Après | 51 786 | 3 307 511 |
| **Écart** | **+648** | +47 482 |

Ajouté : la lecture générique (schéma DMMF, normalisation vers Prisma, droits, `PORTEES`) ≈ 430 lignes, le contrôle final
≈ 55, le tableur depuis les données ≈ 50, l'essai à blanc ≈ 30. Retiré : 3 lectures écrites à la main (`list_my_tasks`,
`list_my_requests`, `search_products`), les lecteurs de `taches` / `demandes`, `schemaDeVue`, le chemin Markdown → xlsx, les
listes parallèles des travaux et des routines. **Le lot ajoute plus qu'il ne retire** : une lecture de 520 tables remplace des
lectures par fonctionnalité, mais les outils qu'elle rend inutiles ne sont pas encore tous supprimés (§ 10).

## 10. Reste ouvert

- `annuaire_terrain` (couverture, dernière visite, champs manquants) reste un outil à part : ses agrégats ne sont pas des
  colonnes ; à fondre quand `lire` saura joindre deux niveaux et compter des relations.
- **À retirer au prochain lot, mesuré ici** : `exporter_donnees` (133 lignes, masqué par `produire`) — il porte le masquage des
  colonnes confidentielles d'un jeu de paie (`lire_paie` y renvoie) : à reprendre dans `produire` avant suppression ;
  `modifier_document` / `convertir_document` (≈ 80 lignes, masqués par `fichier`) — câblés au registre des capacités
  (commandes de l'Atelier) et à la porte d'Adam ; les 17 exports d'écran (M4). L'interrupteur `ADAM_PRIMITIVES=0` ne rend
  plus les trois lectures supprimées.
- Le contrôle final ne juge que les lignes ; I5 confrontera le MESSAGE (« livré », chiffres) aux observations.
- La recherche web d'une mission n'est pas comptée à blanc (coûteuse, non déterministe).
