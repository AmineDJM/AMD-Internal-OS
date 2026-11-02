# 0028 — Les recettes : la mémoire procédurale de la maison (lot J10, 30/10/2026)

**Lot J10 du plan Jarvis** (architecture « Noyau Jarvis », couche Mémoire et connaissance : « des Recettes : une prise en charge
Ad & Pro chez nous, c'est 7 étapes, ces pièces, la DG signe, 4 jours en médiane — proposées depuis les circuits réels et validées par
le responsable du processus » ; piège nommé : « laisser l'assistant apprendre en silence »). Critères : ≥ 10 recettes proposées
correctement sur le corpus semé ; ≥ 70 % des plans tirés d'une recette acceptés sans retouche ; aucune recette utilisée avant
validation ; une recette ne révèle rien qu'un utilisateur ne pourrait voir.

> Code : module `src/modules/recettes/` (`domaine/{processus,contenu,extraction,etats,plan,correspondance}.ts`,
> `infra/{sources,extraction,recettes}.ts`, `actions.ts`, `ecrans/recettes.tsx`), page `/recettes`, outil
> `src/modules/assistant-ia/infra/recettes.ts` (`recette_pour`), tâche `recettes.extraction` (`src/lib/scheduled.ts`).
> Migration additive `20270211090000_recettes`. Banc : `src/modules/assistant-ia/infra/recettes.test.ts` (base réelle, faux modèle) ;
> règles pures : `src/modules/recettes/domaine/domaine.test.ts`.

## 1. Ce qui existait

Le process mining (`lib/process/mining.ts` + `lib/queries/process-intelligence.ts`) mesure le temps passé à chaque étape des circuits
réels (Super Admin seul) ; `MissionPlanPattern` garde les formes de plans d'Adam qui ont réussi (OBSERVED → VALIDATED par répétition,
aucune validation humaine) ; les modèles opérationnels (`missions/templates/registry.ts`) et les leçons (`apprentissage/lecon.ts`)
posaient déjà la règle « seul l'approuvé fait autorité ». Rien ne disait à l'Assistant IA **comment on fait** chez nous.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Où ? | Un **module neuf `recettes`**, qui ne lit que Prisma (aucune dette vers `src/lib/`). L'Assistant IA le lit (`carte.ts` : `assistant-ia → recettes`). | Le process mining vit dans `src/lib/` : l'importer aurait ajouté une dette au module. Les sources sont relues directement (`infra/sources.ts`), avec la même lecture des journaux (un mouvement ferme un segment ; un commentaire ne ferme rien). |
| D'où viennent les recettes ? | Des circuits **lus où ils sont écrits** : `WorkflowInstance`/`WorkflowStepEvent` + la DÉFINITION (rôles, `autoSkipMaxAmount`) pour Ad & Pro ; `ValidationRequest`/`ValidationStep` par module ; `RecruitmentRequest`/`RecruitmentApproval` ; les travaux J2 **réussis** (`Mission` `TRAVAIL` `COMPLETED`, regroupés par forme de plan) ; les `MissionPlanPattern` **VALIDATED**. Pièces : `PieceLien` → `Piece.nature`. Fenêtre : 24 mois. | Aucun second registre, aucune donnée inventée. |
| Pas de recette sans occurrences | Une recette n'est proposée qu'à partir de **N dossiers clos ACCEPTÉS** (défaut 5, plancher 3, réglable par processus dans l'écran). En dessous : rien. | « Trois dossiers ne disent pas comment on fait. » |
| Le contenu | Étapes dans l'ordre (rang moyen), qui valide (rôles de la définition, sinon rôles observés ≥ 30 %), fréquence, durée médiane par étape, condition ; pièces habituelles (≥ 50 % des dossiers) ; décision finale ; **seuils** ; durée médiane et p90 ; **pièges** (taux de renvoi et étape, motifs de renvoi répétés sur ≥ 2 dossiers DISTINCTS, taux de refus, étape la plus lente) ; mots-clés du circuit. | Ce qu'on demande à un ancien de la maison. |
| Les seuils | D'abord le **réglage** du circuit (« franchie automatiquement jusqu'à X ; au-delà, la DG »). Sinon un seuil **observé** : l'étape n'apparaît qu'au-dessus d'un montant (≥ 2 dossiers de chaque côté, séparation nette) → **palier rond strictement entre** les deux groupes (`seuilRond` : 1,2 M entre 1,1 M et 1,5 M), dit « (observé) ». | Le banc a montré qu'arrondir le plus haut montant « sans » recopiait le montant d'un dossier précis : une fuite. |
| Rien n'est appris en silence | Statuts : version PROPOSEE → VALIDEE → REMPLACEE / RETIREE, ou REJETEE. L'extraction **propose** (idempotente : même signature = rien ; proposition en attente rafraîchie en place ; recette validée qui change → nouvelle version proposée, la validée reste en usage ; recette retirée → plus rien). Seul le **responsable du processus** valide, corrige (une version de plus, écrite par lui : l'originale reste lisible), rejette (motif exigé) ou retire. | Principe d'architecture ; `apprentissage/lecon.ts`, `missions/templates`. |
| Qui est responsable ? | La **Direction** (Super Admin, Direction) désigne, par processus (Ad & Pro, Réglementaire, RH, Finances, Marketing, autres validations, travaux de l'assistant), un **rôle** (ou une personne) et règle le seuil — table `RecetteResponsable`, écran `/recettes`. Personne d'autre ne tranche, pas même le Super Admin d'office ; et un responsable ne tranche que les circuits dont il **voit l'écran** (vérifié : le chef de promotion médicale, qui n'ouvre pas le sponsoring, ne valide pas la recette du sponsoring). | Décision 9 « les responsables de processus » de l'architecture. Aucune désignation par défaut : on n'invente pas un responsable. |
| L'usage par l'assistant | Outil **`recette_pour(intention, plan?)`** (fiche de la sélection `MOTS_CLES`, pas le socle ; règle 13 de la consigne) : la version **VALIDÉE** ou rien (`AUCUNE`), une **question** si deux recettes répondent (`AMBIGU`, jamais un choix), sinon la recette (étapes, validateurs en libellés de rôle, pièces, seuils, durée, pièges, note du responsable), la phrase **« selon la recette « … » (version n) validée par X le … »**, un **plan de travail** (J2) et les **écarts**. | Critère 3. |
| Le plan tiré d'une recette | Un gabarit qui passe tout catalogue : ANALYSE « préparer selon la recette » (pièces, pièges) → LIVRABLE « fiche de dépôt » (circuit, seuils) → ATTENTE minuterie à la durée médiane → LIVRABLE « point d'étape » (l'étape la plus lente à relancer). Aucun geste inventé : le dépôt reste une carte confirmée dans la conversation. Une recette de travaux rend la forme du plan qui a réussi (sans ses entrées). Une forme de mission d'Adam : une fiche, sans plan. | Un plan accepté tel quel ne doit jamais échouer à la validation (`lirePlan`). |
| Les écarts | De la demande : montant au-delà d'un seuil (« l'étape « DG » s'applique »), sous un seuil réglé (« franchie automatiquement »), délai demandé plus court que la médiane. D'un plan : `recette_pour` avec `plan` rend les étapes retirées, ajoutées, changées. L'écran montre les écarts des derniers plans retouchés. | « Écarts au plan signalés. » |
| Statistiques | `RecetteUsage` note chaque plan servi (signature du plan, version). L'acceptation se **lit au travail** : un travail de la même personne dans les deux heures, au même plan et **approuvé** = accepté sans retouche ; un autre plan = retouché. Écran : utilisations, taux d'acceptation sans retouche. | Mesuré sur ce qui se passe, sans toucher au moteur des travaux. |
| Les droits | Une recette ne se montre qu'à qui **voit l'écran** de son circuit (`voitLeCircuit` : module de la catégorie Ad & Pro, du module de validation — sinon `VALIDATIONS` —, `RECRUITMENT`, `ASSISTANT_IA` ; formes d'Adam : Super Admin seul) — à l'écran comme à l'assistant. Une famille **fermée** de la console retire ses processus (Ad & Pro → Ad & Pro et Marketing ; Réglementaire ; Budgets → Finances ; Fiches → RH). Le contenu ne porte **aucun** dossier, identifiant, nom de personne, ni montant d'un dossier : des rôles, des fréquences, des durées, des paliers ; les motifs de renvoi gardés sont répétés et masqués (chiffres, adresses). | Critère 4. |
| Actions | Clé `recettes-actions`, classées EXCLUDED au registre d'Adam (`exclusions-circuits.ts`) : une IA ne valide jamais sa propre mémoire procédurale. | Le contrat des actions reste à 24 illisibles (la correction passe en JSON). |

## 3. Mesures (banc `assistant-ia/infra/recettes.test.ts`, base locale, faux modèle, 30/10/2026)

Corpus semé, daté de 2031 (fenêtre close au 01/07/2031, à l'abri des dossiers des autres bancs) : 5 circuits Ad & Pro (5 à 8 dossiers
acceptés, DG seulement au-delà de 1,2 M, deux renvois au même motif, deux dossiers en cours), 4 validations (Réglementaire 2 niveaux,
RH, Finances avec second niveau au-delà de 500 000, Marketing), recrutement (2 niveaux, CV + diplôme), 3 travaux réussis de même
forme, 1 forme d'Adam validée ; témoins : Juridique (3 dossiers, sous le seuil), Budgets (6 dossiers non clos).

| Critère | Seuil | Mesuré |
|---|---|---|
| Recettes proposées correctement (étapes, validateurs, pièces, seuil, médiane, occurrences, piège) | ≥ 10 | **12/12** ; 0 sous le seuil ; seconde extraction : 0 création, 0 version |
| Plans tirés d'une recette acceptés sans retouche (14 demandes de référence, faux modèle qui suit la recette, la personne simulée approuve si la recette est la bonne et l'écart attendu est dit) | ≥ 70 % | **13/14 (93 %)** — l'échec : « prise en charge … nationale, ils prennent l'avion pour Tamanrasset » rend une QUESTION (nationale ou internationale ?) ; 2/2 témoins sans recette ; les statistiques de l'écran comptent les mêmes 13 |
| Aucune recette utilisée avant validation | 0 | **0** : `AUCUNE` tant que rien n'est validé ; Super Admin non désigné refusé ; recette rejetée, retirée ou forme d'Adam non validée jamais servies |
| Aucune recette hors droits (7 rôles, écran et assistant) | 0 | **0** ; famille Ad & Pro fermée → aucune recette Ad & Pro ; aucun identifiant, nom ni montant de dossier dans les contenus |

**Limite honnête** : le corpus et les demandes de référence ont été écrits avec l'extracteur ; ils mesurent la couverture des cas
voulus. La correspondance demande → recette est lexicale (mots du circuit, mot discriminant pesé double) : une demande qui mêle les
mots de deux circuits devient une question. À rejouer sur les dossiers réels de la production (lecture seule) avant d'annoncer un taux.

## 3bis. L'essai réel

Non fait dans ce lot (aucune dépense) : la recette n'existe en production qu'une fois des dossiers réels extraits **et** validés par
un responsable — rien à servir avant la désignation par la Direction.

## 4. Ce qui reste

- **Désigner les responsables** (Direction, écran `/recettes`) : aucune recette ne sera servie avant.
- Les demandes de paiement et d'achat ne sont pas encore des sources (journaux à lire comme le process mining) ; les circuits
  « sans journal » (`AuditLog`) non plus.
- L'écran `/recettes` n'est pas encore au menu (accès par l'adresse) ; le panneau « Travaux » ne montre pas encore la recette
  d'origine d'un plan.
- Correspondance sémantique (vecteurs) quand la Bibliothèque aura pgvector.
