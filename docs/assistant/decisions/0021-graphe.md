# 0021 — Le graphe de l'entreprise et les faits datés (lot J9, 30/10/2026)

**Lot J9 du plan Jarvis** (architecture « Noyau Jarvis », principe 6 : « tout ce qu'on sait a une source et une date ; rien n'est
écrasé, un fait périmé se ferme »). Critères : ≥ 95 % d'entités bien reconnues ; 100 % des chiffres servis avec leur source ;
requête de chemin p95 < 300 ms sur 50 000 arêtes ; aucun résultat hors droits.

> Code : module `src/modules/graphe-entreprise/` (`domaine/{noeuds,translitteration,resolution,parcours,faits-dates,sources}.ts`,
> `infra/{perimetre,canon,aretes,noeuds,index-entites,explorer,faits}.ts`) ; outils au socle IA `src/platform/ia/lectures/graphe.ts` ;
> fermeture bitemporelle dans `src/lib/enrichissement/confirmation.ts`. Migration additive `20270210090000_graphe_faits_dates`.
> Banc : `src/modules/graphe-entreprise/graphe.test.ts` (base réelle, sans modèle).

## 1. Ce qui existait

`Piece`/`PieceLien` (le registre des pièces, J1), `FaitPropose → FaitConfirme` (`valideDu`/`valideAu`, `actif`) et `ConflitDeFait`,
`KnowledgeEntity`/`KnowledgeAlias`, `EntityLink` (« Relier à… »), `EntityMention` (un fichier du Drive mentionne un dossier, une
personne), les référentiels `Personne`/`Organisation` (identifiants NIF, RC…, doublons proposés), un graphe PUR en mémoire
(`src/lib/graphe/`, mandat 5) et un modèle du monde pur (`src/lib/monde/faits.ts`). Trois résolveurs d'entités, aucun ne lisait
l'arabe. L'Assistant IA ne lisait que `faits_confirmes`.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Un module ou le socle ? | Un **module dédié `graphe-entreprise`** (le nom `graphe` est pris par `src/lib/graphe`, que le test des modules lirait comme un demi-déménagement). Carte : lit `referentiels` (normaliser un nom) et `bibliotheque` (ouvrir une pièce, lire un fait). | Une seule règle par chose : la normalisation des noms reste celle des référentiels, la règle d'ouverture d'une pièce celle de la Bibliothèque. |
| Un registre de plus ? | **Non.** Un nœud est une RÉFÉRENCE `TYPE:id` vers la fiche canonique (`Personne`, `Organisation`, `Product`, `RegulatoryProduct`, sponsoring/événement/« autre », congrès, `Piece`). Une ligne sans fiche canonique garde un nœud de repli préfixé (`u:`, `e:`, `f:`, `c:`), jamais présenté comme canonique. L'index de résolution est une projection en mémoire, jetable, rechargée toutes les 5 minutes. | Le piège nommé par l'architecture : « chaque doublon devient une vérité en retard ». |
| Les arêtes | Lues là où elles sont écrites : `EntityLink` (`lie_a`, datée de sa pose, qui l'a posée), `PieceLien` (`concerne`, rôle en note), `FaitConfirme` (`atteste`, valide de `valideDu` à `valideAu`, jamais un fait sensible), `EntityMention` (`mentionne`), clés métier (affiliation datée, emploi, dossier → produit / fournisseur / société / responsable / assistant, demande ou congrès → organisation / demandeur / chef de produit / responsable). Une clé étrangère dit l'état ACTUEL : l'arête le dit en note (« valeur actuelle de la fiche (non historisée) »), sans période inventée. | Honnêteté de couverture (le modèle du monde le disait déjà : ne pas rétro-projeter l'état actuel). |
| Les droits | **Avant le parcours, pas après.** Deux étages, appelés avant qu'un nœud n'entre dans la frontière : (1) les TYPES — un type dont l'écran est fermé, ou dont la famille de la console est fermée, n'est même pas lu ; (2) les LIGNES — `scopeRegulatory` (verrou du pipeline compris), `scopeSponsoring`, `scopeCongress*`, `scopeAdProOther`, portée du module Événements, `piecesOuvrables` (la route qui sert le fichier). Un nœud refusé n'est ni rendu ni TRAVERSÉ. Pour un modèle (`pourModele`), une pièce confidentielle ou du coffre n'est pas un nœud. La résolution juge les candidats AVANT de trancher : un homonyme invisible ne rend pas la question ambiguë. | « Garder les droits en cache, ou filtrer les résultats après coup » est un piège nommé. |
| Familles de la console | Une famille fermée **retire ses types** (Réglementaire → dossiers ; Ad & Pro → demandes et congrès ; Drive & documents → documents) au lieu de refuser l'outil entier. | « Qui travaille chez Saidal ? » n'a pas à être refusé parce que la famille Réglementaire est fermée. |
| Résolution d'entités | Pure (`domaine/resolution.ts`) : identifiant (NIF/RC/NIS, préfixe « NIF » toléré) → graphie exacte → mêmes mots dans un autre ordre → même clé phonétique (référentiels) → **même squelette consonantique** (le pont arabe ↔ latin) → sigle → faute (1 à 2 lettres) → partiel. Translittération arabe → latin : lexique des prénoms et mots courants, puis lettre à lettre (ج → dj, ش → ch, و → w en tête / ou ailleurs), formes de présentation normalisées (NFKC). Les nombres d'un code (`PRD-2026-002`) doivent concorder. Un produit absorbe son dossier quand les deux répondent. Verdict : CERTAIN / PROBABLE / AMBIGU (question, jamais un choix) / INCONNU. | Aucun modèle : un index sait faire. |
| Parcours | Largeur d'abord, profondeur ≤ 3, 200 nœuds par saut, 2 000 arêtes ; un parcours borné le dit (`tronque`). Option « le graphe tel qu'il était à telle date ». | Mesuré : p95 ≈ 120 ms sur 50 000 arêtes. |
| Faits bitemporels | Deux temps : VALIDITÉ (`valideDu`/`valideAu`) et CONSTAT (`confirmeLe`/**`fermeLe`**). Migration : `fermeLe`, `fermeParId`, `remplaceParId`. La confirmation ferme la valeur précédente par `fermeture()` (fin de validité, temps de constat, qui, par quoi). `etatA(faits, date, { connuLe })` : la valeur d'alors, ou ce qu'on en savait à une autre date ; un attribut sans valeur à la date est « inconnu », jamais la valeur d'aujourd'hui. Les fermetures anciennes gardent `fermeLe = NULL` (on n'invente pas leur temps de constat). | Rien n'est écrasé. |
| Chaque chiffre porte sa source | Toute sortie des outils est une liste d'objets données ; chaque objet qui porte une valeur chiffrée porte sa `source` (`Table#id · pièce · par · le`). `chiffresSansSource` le vérifie au banc ; la consigne (règle 12) demande de citer la source entre parenthèses. | Critère mesuré, pas souhaité. |
| Outils | `explorer_relations(entité, profondeur ≤ 3, types, relations, date)`, `etat_a_une_date(entité, date, connu_le)`, `d_ou_vient(fait | entité + attribut)`. Au **socle IA** (comme `connaissance.ts`) : l'Assistant IA ne peut pas lire `graphe-entreprise` qui lit `bibliotheque`, qui lit l'Assistant IA (cycle). Ajoutés comme **fiches** (`MOTS_CLES`), pas au socle de la sélection (J6 y travaille). Plafond du socle IA tenu à 177 : +1 (porte du module), −1 (`directory-tools` n'importe plus l'énumération `DirectoryChannel`). | Frontières et cliquets inchangés. |

## 3. Mesures (banc `graphe.test.ts`, base locale, 30/10/2026)

| Critère | Seuil | Mesuré |
|---|---|---|
| Résolution juste sur le corpus semé (101 mentions : 20 personnes, 12 organisations, 3 produits, 1 dossier ; arabe/latin, fautes, sigles, NIF/RC, homonyme, inconnus) | ≥ 95 % | **101/101** |
| Chiffres servis avec leur source (10 appels des trois outils, 4 rôles) | 100 % | **202/202** |
| Parcours profondeur 3, 50 000 arêtes (5 000 personnes × 1 000 organisations), 40 départs | p95 < 300 ms | **Super Admin p95 ≈ 120 ms, lecteur ≈ 125 ms** (p50 ≈ 100 ms) |
| Aucun résultat hors droits (lecteur, deux délégués, responsable réglementaire, Super Admin) | 0 | **0** — chaque nœud rejugé par la règle de l'écran ; rien atteint à travers un dossier interdit ; pièce du coffre jamais rendue |

**Limite honnête** : le corpus de résolution a été écrit en même temps que le résolveur ; il mesure la couverture des cas voulus
(graphies arabes, particules, fautes, sigles) plus qu'un taux sur des données réelles. À rejouer sur un échantillon de la base de
production (mentions réelles des pièces) avant d'annoncer un taux.

## 4. Ce qui reste

- Les clés étrangères métier ne portent que l'état actuel : l'histoire d'un responsable de dossier se lira par `AuditLog`
  (`lib/monde/faits.ts`) dans un lot suivant.
- `EntityMention` ORGANISATION (`lab:<nom>`) n'a pas d'identifiant canonique : non relié.
- Le résolveur ne remplace pas encore les trois résolveurs existants ; les unifier est un lot à part (J6/J11).
