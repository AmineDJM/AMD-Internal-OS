# Accès par base — proposition (lot D1, 02/11/2026)

> **Statut : DÉCIDÉ (Direction, 02/11/2026) — voir la décision [0057](../assistant/decisions/0057-acces-par-base.md)**, qui
> tranche les neuf questions (§9) : la base OUVRE et FERME, par rôle et par personne, datée et motivée, sans exception
> pour le Super Admin (garde-fou anti-verrouillage). Mise en œuvre par lots D2 à D5. Le catalogue des bases
> est dans [BASES-DE-DONNEES.md](BASES-DE-DONNEES.md) ; le résumé d'une page dans
> [BASES-RESUME-DIRECTION.md](BASES-RESUME-DIRECTION.md).

## 1. Ce que demande la Direction, et ce que nous proposons

> « […] en plus des accès qu'on a normal, un accès par database. »

Aujourd'hui, tous les accès se règlent **module par module** (71 modules, 7 gestes) et **ligne par ligne**. Pour
fermer « tout ce qui touche à la paie » à quelqu'un, il faut savoir quels modules, quelles sections, quelles familles
de l'assistant y mènent — et espérer n'en avoir oublié aucun. Un module comme « Ressources humaines » mène à la fois au
personnel et à la paie ; à l'inverse, la paie se lit par l'écran RH, par Mon dossier, par l'assistant, par les exports
et par les Finances (virements de paie).

**Proposition** : ajouter un **niveau « base » au-dessus des modules**. Pour un rôle ou une personne, chaque base est :

| Réglage | Effet |
|---|---|
| **Normal** (défaut) | Rien ne change : les modules, entités, accès ligne à ligne et règles d'aujourd'hui décident seuls. |
| **Lecture seule** | On lit ce que les modules permettent déjà ; **aucune écriture** dans les tables de la base (créer, modifier, supprimer, valider, déposer). |
| **Fermée** | **Aucune lecture ni écriture** dans les tables de la base, quel que soit le module, l'écran, l'export, l'API ou l'assistant par lequel on passe. |

Le niveau base est un **plafond** : il **ajoute** une limite, il ne remplace rien et n'ouvre jamais plus que ce que les
modules donnent. Le droit réel devient : **droit du module ET base non fermée** (et, pour écrire, base ni fermée ni en
lecture seule). Une seule question nouvelle, posée au même endroit pour toutes les tables.

*Ouvrir une base* à quelqu'un (au sens « lui donner accès à tout le Personnel ») reste possible dans la console, comme
un **raccourci** qui coche les modules de la base dans Administration › Accès — les droits restent écrits au seul
endroit où ils vivent aujourd'hui (pas de double vérité). C'est une question à trancher (§9, Q1).

## 2. L'effet, partout où une donnée sort

| Où | Aujourd'hui | Avec l'accès par base |
|---|---|---|
| **Menus et écrans** | Un module ouvert affiche son écran | Le menu masque un module dont **toutes** les bases sont fermées. Un écran ouvert qui lit une base fermée affiche un **refus clair** : « La base *Paie & rémunérations* vous est fermée — demandez à la Direction. » Jamais une page vide ou un chiffre à zéro. |
| **Actions serveur** (boutons, formulaires) | `userCan(module, geste)` | En plus : refus si la table écrite est dans une base fermée ou en lecture seule. |
| **Exports** (Excel, PDF) | Geste `EXPORT` du module | Même garde que la lecture : une base fermée ne s'exporte pas, par aucun chemin. |
| **Assistant IA / Adam** | Familles + droits réels (S1) | Il lit **sous l'identité de la personne** (S1) : la garde s'applique d'elle-même à ses outils. En plus, une base fermée **ferme la famille** correspondante (Personnel → FICHES et CONTRATS_RH ; Paie → SALAIRES ; Budgets/Finances → BUDGETS ; Réglementaire → REGLEMENTAIRE ; Ad & Pro → AD_PRO ; Documents → DRIVE), et la consigne dit à l'assistant que la base est fermée, pour qu'il **le dise** au lieu de chercher ailleurs. Le bac à sable SQL (lecture seule) applique la même liste. |
| **API externe `/api/v1`** | Le client agit au nom d'un utilisateur (`actAsUserId`) dont la portée RBAC s'applique | La garde s'applique à cet utilisateur. |
| **Tâches de fond, imports, relances** | Pas d'utilisateur | Contexte « système » **déclaré explicitement** ; non concerné par les réglages, mais compté (§4). |

**Ce qui ne change pas** : le Super Admin n'est jamais fermé (souveraineté, à confirmer — Q5) ; chacun garde accès à
**ses propres** données (sa fiche, sa paie, ses conversations) même si la base est fermée pour son rôle — exactement la
règle de l'assistant depuis S1 (à confirmer — Q6).

## 3. Où appliquer la règle : au niveau des DONNÉES, pas de l'affichage

Masquer des menus ne suffit pas : la donnée sort aussi par un export, une recherche, l'assistant, une API, une jointure
d'un autre écran. Trois façons de garder les données elles-mêmes :

### Option A — Une garde centrale dans le client Prisma (recommandée)

Toute l'application lit et écrit par **un seul objet** : `prisma` (`src/lib/prisma.ts`). C'est déjà un **relais** (lot
J7) qui choisit le bon client pour chaque requête (simulation, capture des gestes de l'assistant). On y ajoute une
étape : à chaque requête, **quelle table → quelle base** (le catalogue, généré), **qui demande** (l'identité de la
requête, posée par `requireUser` dans un contexte de requête, comme le fait déjà `vue-lecture.ts`), **cette base
est-elle fermée pour lui** (réglage lu une fois par requête, mis en cache comme les droits RBAC aujourd'hui).

- **Pour** : un seul point, qui couvre écrans, actions, exports, assistant, API d'un coup ; aucune des ~6 400 lectures
  du code à modifier ; coût négligeable (une recherche dans une table de correspondance par requête) ; testable.
- **Contre / risques** :
  - **Les inclusions croisées** : une demande Ad & Pro affiche le nom du salarié (base Personnel). La garde doit regarder
    les relations incluses (`include` / `select`) et laisser passer des **colonnes de référence** (nom, poste, entité)
    d'une base fermée — sinon des écrans entiers tombent. C'est le vrai travail (Q7).
  - **Le SQL écrit à la main** (`$queryRaw`) ne passe pas par les modèles : **81 fichiers** du code en contiennent
    (hors tests). Il faut un cliquet qui les liste avec les bases qu'ils touchent, et les faire déclarer leur base.
  - **Les tâches sans utilisateur** doivent déclarer « système » — sinon, en mode strict, elles seraient refusées.
  - **Une erreur de garde casse un écran en production** : d'où le passage obligé par un **mode observation** (§8, lot D3).

### Option B — Rôles PostgreSQL et sécurité par ligne (RLS)

La base elle-même refuse : un rôle PostgreSQL par profil, ou une politique RLS lisant l'utilisateur courant.

- **Pour** : la garantie la plus forte — même un SQL écrit à la main ou une faille applicative ne passe pas.
- **Contre** : l'application se connecte avec **un seul utilisateur** de base, à travers un pool de connexions ; il
  faudrait ouvrir une transaction et y poser l'identité **à chaque requête** (coût de performance réel, compatibilité
  avec le pool et avec les transactions interactives de Prisma), écrire et migrer des politiques pour 381 tables, et
  tester tout cela sur une base réelle. Des semaines de travail, un risque de régression large.
- **Verdict** : disproportionné pour toute la base ; **à envisager plus tard pour deux bases seulement** (Paie, Coffre)
  si la Direction veut une garantie au niveau du moteur (Q8). Le coffre est déjà chiffré, ce qui en limite l'intérêt.

### Option C — Étendre la porte du coffre

Faire passer les lectures sensibles par une porte unique, journalisée, comme le coffre le fait pour l'IBAN, le NIN et
les salaires.

- **Pour** : déjà en place, déjà journalisé, déjà interdit à l'IA.
- **Contre** : il protège des **colonnes**, pas des **bases** ; y faire passer des tables entières (congés, recrutement,
  contrats) demanderait de réécrire chaque lecture.
- **Verdict** : on le **garde tel quel**, en complément : la garde de base dit *qui peut ouvrir la base*, le coffre dit
  *qui peut lire une valeur secrète en clair* et le trace.

### Recommandation

**Option A**, en deux temps (observer, puis appliquer), base « secrète » et « confidentielle » d'abord ; Option C
inchangée ; Option B réservée à une éventuelle demande ultérieure pour Paie et Coffre.

## 4. Ce que cela coûte et ce qui peut mal tourner

| Point | Mesure / estimation | Parade |
|---|---|---|
| Performance | Une recherche en mémoire par requête ; le réglage lu une fois par requête et mis en cache | Mesurer sur le banc de charge en mode observation |
| Double vérité avec les modules | Le niveau base ne fait que **retirer** ; il n'écrit aucun droit de module | « Ouvrir une base » = raccourci qui coche des modules dans `UserAccess`, pas un second registre |
| Écrans cassés par les jointures | Le vrai risque : les écrans qui affichent un nom venu d'une autre base | Colonnes de référence ; mode observation avant application ; refus clair, jamais silencieux |
| SQL écrit à la main | 81 fichiers hors tests | Cliquet : chaque fichier déclare ses bases ; refus par défaut des bases fermées |
| Tâches de fond | Exécutées sans utilisateur | Contexte « système » explicite et compté |
| Tests | — | Test de bout en bout par base (personne avec Paie fermée → écran, export, assistant, API refusent) ; le cliquet du catalogue (déjà livré) garantit qu'aucune table n'échappe à une base |
| Tables techniques | Comptes, journaux, plateforme : l'ERP ne tourne pas sans elles | Les bases **techniques ne se ferment pas** à un utilisateur ; seules les 24 bases métier sont réglables |

## 5. Interaction avec les accès existants

- **Module ouvert, base fermée** → refus clair, qui nomme la base et la personne à qui demander. Le module reste coché
  dans Administration › Accès : rouvrir la base suffit.
- **Module fermé, base « normale »** → rien ne change : la base n'ouvre rien.
- **Périmètre d'entité, accès ligne à ligne, règles métier** → s'appliquent **après** la base, inchangés.
- **Familles de l'assistant** → une base fermée ferme ses familles ; une famille ouverte (même nominativement, même
  datée) ne rouvre jamais une base fermée. Une **fermeture nominative prime sur tout**, comme en S1.
- **Avenants et droits datés** → le même modèle sert à la base : une ouverture ou fermeture **datée** (du / au), avec
  motif, nominative, révocable, journalisée — c'est la forme que la Direction a déjà validée pour l'assistant (S1).
- **Coffre** → inchangé : même base ouverte, une valeur secrète ne se lit en clair que par la porte du coffre.

## 6. La console (écran proposé)

**Administration › Accès › Par base** — une grille, lisible sans connaître les modules :

- **Lignes** : les 24 bases métier, avec leur niveau de sensibilité en pastille (public interne → secret) et leur
  nombre de tables ; un clic montre la liste des tables en français et les modules qui y mènent.
- **Colonnes** : les rôles ; un sélecteur bascule sur **une personne**.
- **Chaque case** : *Normal* · *Lecture seule* · *Fermée*. Pour une personne : *Comme son rôle* en plus, et la case
  montre d'où vient l'accès réel (« via Ressources humaines — modifier », « via Mon dossier : ses propres données »).
- **Onglet « Qui voit cette base ? »** : pour une base, la liste nominative des personnes qui peuvent la lire
  **aujourd'hui** (calculée depuis les modules, entités et réglages), avec le chemin. C'est utile **même sans rien
  fermer** — c'est le contrôle que la Direction fait aujourd'hui à la main.
- Toute modification demande un **motif**, peut être **datée**, et entre au journal d'audit.

## 7. Ce qu'il faudra stocker (pour mémoire)

Une table `AccesBase` sur le modèle de `AssistantIaDroitDate` : rôle **ou** personne, base (la clé du catalogue,
p. ex. `paie`), niveau (`FERMEE` / `LECTURE_SEULE`), du / au, motif, accordé par, révoqué le. Pas de ligne = *Normal*.
Une migration SQL idempotente, comme d'habitude. La correspondance table → base vient du catalogue généré
(`docs/architecture/bases-de-donnees.json`), tenu à jour par le cliquet.

## 8. Plan de mise en œuvre, par lots

| Lot | Contenu | Risque en production |
|---|---|---|
| **D1** (ce lot) | Catalogue vérifié des 515 tables en 29 bases, sensibilités, écrivains mesurés ; cliquet dans `npm test` ; cette proposition | Aucun (documents, script, test) |
| **D2** | Table `AccesBase` + règle pure « accès effectif à une base » ; écran **en lecture** « Qui voit cette base ? » | Faible : rien n'est refusé |
| **D3** | Garde dans le relais Prisma en **mode observation** : elle journalise ce qu'elle *aurait* refusé, sans refuser ; contexte « système » des tâches de fond ; cliquet du SQL écrit à la main. Deux semaines de mesure | Faible : journal seulement |
| **D4** | Application **stricte** pour les bases secrètes et confidentielles (Paie, Personnel, Recrutement, Finances, Information médicale, Pilotage) ; refus clair à l'écran ; familles de l'assistant alignées ; console des réglages | Moyen : fermeture réelle — d'où D3 avant |
| **D5** | Lecture seule (écritures refusées), exports, API v1, bac à sable SQL ; extension aux autres bases métier | Moyen |
| **D6** (option) | Si la Direction le demande : sécurité au niveau du moteur PostgreSQL pour Paie et Coffre | Élevé, à chiffrer à part |

## 9. Questions à trancher par la Direction

1. **Fermer seulement, ou aussi ouvrir ?** Recommandation : la base est un **plafond** (fermer / lecture seule) ;
   « ouvrir une base » est un raccourci qui coche les modules, pour ne pas créer deux registres de droits.
2. **Le découpage** : les 24 bases métier proposées conviennent-elles ? (Exemples à arbitrer : garder *Paie* séparée du
   *Personnel* — proposé ; rattacher les *Événements* à *Ad & Pro* — proposé ; séparer *Courriels* de *Messagerie* ?)
3. **Par rôle, par personne, ou les deux** ? Recommandation : les deux, la personne prime sur son rôle (comme pour
   l'assistant).
4. **Droits datés et motif obligatoires** pour toute ouverture ou fermeture nominative, comme en S1 ?
5. **Le Super Admin** reste-t-il hors de portée de ce réglage (souverain) ? Et la Direction / le DG ?
6. **Ses propres données** : une personne dont la base Paie est fermée garde-t-elle l'accès à **sa** paie (Mon
   dossier) ? Recommandation : oui.
7. **Les noms dans les autres écrans** : quand le Personnel est fermé, le nom et le poste d'un salarié restent-ils
   visibles sur une demande Ad & Pro, une tâche, une validation ? Recommandation : oui (colonnes de référence), sinon de
   nombreux écrans deviennent illisibles.
8. **Niveau de garantie** pour Paie et Coffre : la garde applicative suffit-elle, ou faut-il, plus tard, une garde au
   niveau de PostgreSQL (coût et risque élevés) ?
9. **Le classement de sensibilité** : valider les 35 tables « secret » (notamment le journal d'audit et la corbeille,
   qui copient les valeurs de toutes les bases, et les évaluations KPI), et les niveaux des 29 bases.
