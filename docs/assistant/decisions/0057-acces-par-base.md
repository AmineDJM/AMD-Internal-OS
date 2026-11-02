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
