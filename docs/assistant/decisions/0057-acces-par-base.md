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
- **Un port au socle, pas d'import de module** (`src/platform/donnees/contexte.ts`) : la session pose l'identité de la
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
