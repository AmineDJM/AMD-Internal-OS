# 0066 — Les missions qui ne s'exécutaient pas, et la vérité sur l'exécutant (lot P1 ter)

**Date** : 2026-11-03 · **Statut** : appliquée (cause, diagnostic, nom) ; contenu et cartes cliquables EN ATTENTE du
contrat `Observation` (session I1) · **Suite de** : [0047](0047-pilotage-missions-mails-verite.md)

## Ce que la Direction a vécu (03/11, en production)

- Missions approuvées, « Démarré d'office : plan sans geste », puis RIEN : 4 étapes « En file », coût 0, 16 min et plus ;
  amd-worker vivant ; web et worker en `TACHES_DE_FOND=les-deux`.
- Adam : « prête : la prochaine étape part au prochain battement (moins d'une minute) », puis au tour suivant « worker
  absent : aucun battement enregistré » — deux phrases pour un même état.
- Le journal disait « Plan proposé par Assistant IA » (décision A1 : « Adam » partout).
- « Y'a quoi dedans, elles ne sont pas cliquables » — voir « En attente » plus bas.

## 1. La cause des missions à 0 % — et son correctif (poussé seul, 68313b90)

Le web et le worker jouent le MÊME passage de 68 tâches, une à une. Le web atteint `travaux.balayage` (n° 61) en
quelques secondes — ses autres tâches sont « occupées » — et **prenait le bail** pour s'abstenir aussitôt (le worker
bat). Prendre le bail marque `dernierDebutA` : l'intervalle minimal de 45 s entre deux départs s'ouvrait. Le worker,
qui fait le vrai travail des tâches 1 à 60, atteignait la tâche plus tard et la trouvait **« occupée »**, à chaque
passage. Personne ne conduisait. Le chemin de la mission lui-même est sain (proposée → démarrée d'office → candidate →
conduite, vérifié en local). Aggravant : le battement web armé au démarrage (lot P1, `src/instrumentation.ts`) rendait
le cas systématique. Même défaut latent pour `atelier.conversions`.

**Correctif** : `TachePlanifiee.sAbstenir` (`lib/taches-de-fond/executer.ts`) — l'abstention se décide AVANT le bail, sans
toucher ni bail ni départ (issue « abstenue ») ; appliquée aux travaux et aux conversions (`scheduled.ts
abstentionDuWeb`). Banc `src/lib/taches-de-fond/abstention.test.ts` : web puis worker sur la VRAIE entrée de la table —
échoue sans le correctif (le worker trouve « occupee »), passe avec.

## 2. Le diagnostic lisible (ce push)

- **Une seule fonction pour toutes les vues** (`domaine/missions/pilotage.ts silenceDesExecutants`, `diagnosticDuTableau`
  partagé par `mes_missions`, l'écran Missions et la carte de fusion) : un même état donne la même phrase.
- **« Prête : moins d'une minute »** seulement après un passage EFFECTIF du balayage dans les 3 dernières minutes ET si
  le balayage prendra la mission — la requête même du moteur (`travauxAFaireAvancer`, bornée à la personne). Sinon la
  vraie raison : plan à approuver, attente, en pause, aucune étape prête ; balayage arrêté (`TRAVAUX_SWEEP=off`, dit tel
  quel, remède « rétablir le balayage ») ; web qui s'abstient pour un worker muet ; aucun exécutant jamais vu.
- **`mes_missions`** rend, pour chaque mission, `pris_par_le_balayage` (oui / non — pourquoi) et `etape_suivante`, et
  `dernier_balayage` : qui (web / worker), quand, bilan « examinés N, conduits M » — écrit sur la ligne de la tâche par
  `bilan()` à chaque passage réussi.
- **La carte de fusion** porte la même alerte que `mes_missions`.
- **Le nom** : la persona des travaux porte `NOM_ASSISTANT` — « Plan proposé par Adam ».

## En attente — le contenu des missions et leurs cartes cliquables

Le contenu (objectif, étapes avec résultat, jalons, livrables, lien) et les cartes `mission` posées par le serveur
(« Ouvrir » `/missions/<id>`, pause / reprendre / arrêter) seront branchés sur le contrat `Observation {objet, id, lien,
état, projection}` publié par la session I1 (audit AU1) : la vue de la mission (`vueMission`) en sera le projecteur
« mission », pas un chemin à part. Le travail est prêt hors de la branche (bornage, cartes, lien interne, banc MS-).

## Invariants

1. Une abstention ne prend jamais le bail d'une tâche planifiée.
2. Un même état d'exécutant donne la même phrase partout.
3. « Prête » n'est jamais dit d'une mission que le balayage ne prendra pas.

## Tests

`lib/taches-de-fond/abstention.test.ts` (la cause) ; `domaine/missions/executant.test.ts` (vérité sur l'exécutant,
candidature, dernier balayage) ; `missions-mails.test.ts` (contre la base : candidature, étape suivante, dernier balayage,
`TRAVAUX_SWEEP=off` dit tel quel, carte de fusion = même alerte, passage récent → « prête »).
