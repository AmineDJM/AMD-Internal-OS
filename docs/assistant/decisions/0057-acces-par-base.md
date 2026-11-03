# 0057 — L'accès par base (lots D1 à D5, 02/11/2026)

**Demande de la Direction (02/11, mot pour mot)** : « pourquoi ne pas avoir aussi un accès par database ? […] en plus des
accès qu'on a normal, un accès par database. » Le lot D1 a livré le catalogue (515 tables → 29 bases, 24 métier et
5 techniques ; `docs/architecture/BASES-DE-DONNEES.md`) et la proposition (`docs/architecture/ACCES-PAR-BASE.md`).

## Réponses de la Direction aux neuf questions (02/11, verbatim)

« 1- ouvrir et fermer · 2- Why not · 3- Les 2 · 4- Oui · 5- Non tous · 6- Oui ou non (réglable) · 7- oui · 8- ok plus tard · 9- oui »

| # | Question | Décision |
|---|---|---|
| 1 | Fermer seulement, ou aussi ouvrir ? | **Les deux.** Niveaux : Normal / Lecture seule / Fermée / **Ouverte** (lecture de toute la base même sans les modules, et l'écriture si demandé) — sous les gardes par ligne d'aujourd'hui : périmètre d'entité, et S1 (ouvrir une base n'ouvre PAS les valeurs sensibles d'autrui, sauf la base Paie ouverte nommément, journalisé). |
| 2 | Le découpage en 24 + 5 bases | **Validé.** |
| 3 | Par rôle, par personne ? | **Les deux** ; la personne prime sur son rôle ; entre deux rôles, le plus restrictif. |
| 4 | Droits datés, motif obligatoire ? | **Oui**, comme S1 (`AssistantIaDroitDate`, `AvenantContrat`) ; journalisés ; révocables, jamais supprimés. |
| 5 | Le Super Admin hors de portée ? | **Non, aucune exception.** Garde-fou anti-verrouillage : on ne peut pas fermer « Comptes & droits » (la console d'accès) au dernier Super Admin actif ; tout réglage restrictif qui touche un Super Admin exige une confirmation explicite et se défait en un geste. |
| 6 | Ses propres données quand la base est fermée ? | **Réglable par base** (oui / non). Défaut : oui pour Personnel, Paie, Recrutement (son dossier), non ailleurs. |
| 7 | Nom et poste d'un salarié visibles ailleurs ? | **Oui** (colonnes de référence). |
| 8 | Garde PostgreSQL (RLS) pour Paie et Coffre ? | **Plus tard**, pas maintenant. |
| 9 | Les 35 tables « secret » | **Validées.** |

## D2 — le modèle, la règle, la console (ce lot)

- **Tables** : `AccesBase` (base, personne **ou** rôle — contrainte en base —, niveau, écriture, du / au, motif, accordé par,
  révoqué le / par) et `AccesBaseParametre` (ses propres données, par base). Migration additive et idempotente
  `20270231000000_d2_acces_par_base`.
- **Module `src/modules/acces-bases/`** : `partage.ts` (catalogue généré + règle pure), `api.ts` (réglages, « qui voit »),
  `actions.ts` (clé `acces-bases-actions`), `ecrans/console-bases.tsx`. Le catalogue applicatif
  (`domaine/catalogue.genere.ts`) est produit par `npm run bases:generer` avec le JSON ; le cliquet
  `src/platform/bases-de-donnees.test.ts` vérifie que les deux disent la même chose.
- **La règle** (`domaine/regle.ts`) : `niveauPour` (réglage nominatif en vigueur > réglage de rôle le plus restrictif >
  Normal ; un réglage vaut du `du` à la fin du jour `au`, s'il n'est pas révoqué), `droitEffectif` (modules ET base),
  `refusVerrouillage`, `touchePlusRestrictifSuperAdmin`.
- **La console** : Administration › Accès › **Par base** (`/admin/access/bases`), Super Admin réel seulement : la liste des
  bases (sensibilité, tables, réglages en vigueur) ; pour une base, ses réglages (poser, révoquer), ses propres données,
  et **« Qui voit cette base aujourd'hui ? »**, calculé personne par personne depuis ses droits réels (`getAccess`) et le
  niveau de la base, avec le chemin (« Par ses modules », « Base ouverte en lecture (réglage nominatif) »…).
- **Journal et réversibilité (K10)** : chaque geste écrit l'audit (module « Accès par base ») et passe par
  `actionReversible` — l'annulation retire un réglage posé, rétablit un réglage révoqué, remet le paramètre d'avant.
- **Une IA ne règle jamais les accès** : `accesBase` et `accesBaseParametre` sont des modèles interdits au chemin
  générique (`MODELES_INTERDITS`) ; les trois actions sont exclues du registre de l'assistant.
- **Rien n'est encore appliqué aux données** : D2 règle et montre. La garde centrale vient au lot D3 (en observation).

## Attaques tenues (banc `src/lib/effets/reversibles-acces-bases.test.ts`, au rang des bancs K10)

Un employé qui tente de s'ouvrir une base (ou de révoquer, ou de régler ses propres données) est refusé et rien n'est
écrit ; un droit expiré n'ouvre plus rien ; fermer la console au rôle Super Admin (donc à tous) est refusé même confirmé ;
un réglage restrictif sur un Super Admin sans confirmation est refusé avec la demande de confirmation.

## D3 — la garde centrale, en OBSERVATION

- **Où** : dans le relais `prisma` (`src/lib/prisma.ts`) — le client de base reçoit une extension de requête
  (`src/platform/donnees/garde.ts`). Toute l'application lit par `prisma` : écrans, actions, exports, recherche, API,
  assistant. Pendant un geste d'agent, c'est le client du geste qui parle (journal des effets), comme avant.
- **Un port au socle, pas d'import de module** (`src/platform/donnees/contexte.ts`, `garde.ts` — sans dépendance ERP ; l'extension Prisma elle-même est dans `src/lib/prisma.ts`) : la session pose l'identité de la
  requête (`poserIdentiteDonnees`, une case par requête via `cache()` — la personne à l'écran pendant un rendu en Vue
  exacte, le Super Admin réel dans le corps d'une écriture : la règle de l'écran) ; le module `acces-bases` branche son
  évaluateur au démarrage (`src/instrumentation.ts`). Sans évaluateur ou sans identité, la garde ne juge RIEN.
  `enSysteme(raison, …)` déclare une tâche de fond ; `avecIdentiteDonnees(identité, …)` pose une identité hors rendu
  (route d'API, banc) — les deux ATTENDENT à l'intérieur, car une requête Prisma part à l'`await`.
- **Les jointures comptent** : `include` / `select` d'une relation (lue dans `Prisma.dmmf`, profondeur 3) font juger le
  modèle lié — lire un salarié en incluant sa paie touche la base Paie.
- **L'évaluateur** (`infra/garde.ts`) est synchrone : un instantané des réglages en mémoire, rafraîchi toutes les 30 s
  en arrière-plan. Bases techniques jamais jugées (l'ERP ne tourne pas sans elles). Il juge modules ET base
  (`droitEffectif`) et, s'il aurait refusé, il COMPTE (`ObservationAccesBase` : jour, base, personne, geste, niveau,
  tables en cause, nombre), écrit par paquets toutes les 30 s par le client BRUT, en contexte système.
- **Rien n'est refusé en D3.** La console (Administration › Accès › Par base) montre, pour chaque base, « ce que la garde
  aurait refusé » sur 14 jours.
- **Surcoût mesuré** (banc `src/modules/acces-bases/garde.test.ts`) : ~15 µs par requête (trois modèles joints,
  40 réglages en vigueur), contre ~1 ms pour une requête en base. Négligeable.
- **Le SQL écrit à la main** passe à côté de la garde : cliquet `src/modules/acces-bases/sql-brut.test.ts` — 47 fichiers
  de production nomment une table d'une base métier en SQL brut (sur 81 qui en contiennent) ; la liste ne fait que
  rétrécir, un fichier neuf ou une base de plus fait échouer la suite.
- **Limite connue, à mesurer** : la case par requête repose sur `cache()` de React ; une route d'API (hors rendu) qui ne
  pose pas son identité par `avecIdentiteDonnees` n'est pas jugée. Le lot D5 la pose pour l'API v1.

## D4 — l'application stricte, DÉSACTIVÉE par défaut

- **L'interrupteur** : `AppSetting.accesBasesStrict` (migration `20270233000000_d4_acces_base_strict`) — `AUCUNE` (défaut :
  la garde observe et compte, rien n'est refusé), `SENSIBLES` (bases métier secrètes et confidentielles : Paie, Personnel,
  Recrutement, Finances, Budgets, Juridique, Coffre, Ad & Pro, Développement, Information médicale, Messagerie, Pilotage),
  `TOUTES` (toutes les bases métier). Réglé dans la console (Administration › Accès › Par base) par le Super Admin réel
  seulement ; activer exige une confirmation explicite, désactiver jamais ; journalisé ; annulable en un geste (K10) ;
  modèle interdit au chemin générique de l'assistant. **La Direction fixera la date d'activation après les deux semaines
  d'observation — rien n'est activé par ce lot.**
- **Le plan de la garde** (`src/platform/donnees/garde.ts`, appliqué par `src/lib/prisma.ts`), quand le refus est appliqué :
  - la table DEMANDÉE est fermée → la requête est refusée par une erreur `AccesBaseRefuse` qui porte l'empreinte
    `ACCES_BASE:<base>:<niveau>` ; Next la garde en production, et l'écran d'erreur (`src/app/(app)/error.tsx`) dit
    « La base « Paie & rémunérations » vous est fermée. Demandez à la Direction » au lieu d'une panne ;
  - **nom et poste toujours visibles** (décision n° 7) : une lecture qui ne demande QUE des colonnes de référence (nom,
    poste, titre, référence, département, entité…) passe ; une table JOINTE fermée (`include` / `select`) ne fait pas
    tomber l'écran : ses lignes sont réduites à ces colonnes (la demande Ad & Pro garde le nom du salarié, jamais son IBAN) ;
  - **ses propres données** (décision n° 6, paramètre de la base) : la requête est restreinte à SES lignes (son compte, sa
    fiche RH — filtre ajouté au `where`, colonnes d'appartenance lues puis retirées) ; une ligne d'autrui demandée par son
    identifiant est refusée ; un agrégat (`count`, `aggregate`, `groupBy`) sur une base fermée est refusé ;
  - lecture seule → toute écriture dans la base est refusée.
- **Aucune exception, sans verrouillage possible** : le Super Admin est jugé comme les autres, mais les bases techniques
  (comptes et droits, journaux, plateforme, IA) ne sont jamais appliquées — la connexion et la console d'accès restent
  ouvertes, et le garde-fou de D2 empêche de fermer « Comptes & droits » au dernier Super Admin.
- **Bancs** : `src/modules/acces-bases/garde.test.ts` (refus réel, empreinte, propres données, jointure réduite, lecture
  seule, portée SENSIBLES / TOUTES, base technique jamais bloquée, système et autrui non touchés) ;
  `src/lib/effets/reversibles-acces-bases.test.ts` (l'interrupteur : employé refusé, confirmation, annulation).
- **Limites connues** : une action serveur refusée affiche encore le message générique « n'a pas abouti » (le lot D5
  porte le refus clair dans les actions) ; après l'annulation d'un réglage, la garde le voit au plus tard 30 s après.

## D5 — partout où une donnée sort : modules, assistant, API v1, SQL libre

Tout ce qui suit ne vaut que **sous l'application stricte** (D4, désactivée par défaut) : sans elle, fermetures ET
ouvertures sont mesurées, rien n'est appliqué.

- **Écrans et menus** (`rbac.getAccess`, par le port `platform/donnees/contexte.ts` — `poserModulesParBase`) : une base
  OUVERTE ouvre ses modules (lecture ; créer / modifier si l'écriture est accordée), jamais par-dessus un blocage
  explicite de la console ; un module dont TOUTES les bases métier sont FERMÉES est masqué (le menu ne mène plus à un
  écran vide). Les modules des bases techniques (Administration…) ne sont jamais masqués.
- **Lecture seule, exports** : un export lit par `prisma` — la garde l'a déjà ; une écriture dans une base en lecture
  seule est refusée (D4).
- **L'Assistant IA** (`accesAssistantIa` → `appliquerBases`, `domaine/acces-regles.ts`) : une base fermée ferme ses
  familles — Super Admin compris (il garde le reste de sa souveraineté) ; une base ouverte les ouvre ; une ouverture
  NOMINATIVE d'une base porteuse d'une famille sensible (Paie → salaires) devient un périmètre nommé d'origine « Base
  ouverte nommément », journalisé à chaque révélation comme les droits datés de S1 ; une ouverture de RÔLE n'ouvre jamais
  les valeurs sensibles d'autrui ; une fermeture nominative de la console de l'assistant prime toujours. Ses outils
  lisent sous l'identité de la personne : la garde les juge aussi.
- **API v1** (`lib/api/http.ts`) : l'identité de l'utilisateur au nom duquel l'agent agit est posée autour du
  traitement (`avecIdentiteDonnees`) ; un refus devient un **403** qui nomme la base.
- **Bac à sable SQL** (`lib/sandbox/sql.ts`) : les tables du plan d'exécution passent devant la garde
  (`refusPourTables`) ; une table d'une base fermée refuse la requête, avec la phrase de la garde.
- **Bancs** : `garde.test.ts` (modules ouverts / masqués, familles, SQL libre, API v1 403 / 200) ;
  `assistant-ia/domaine/acces-par-base.test.ts` (règle pure des familles). Les attaques S1 restent bloquées (suite complète).
- **Limite** : une ACTION serveur refusée affiche encore le message générique « n'a pas abouti » côté écran (l'empreinte
  est dans l'erreur ; chaque écran la lira à son tour) ; une page refusée, elle, dit la base.
