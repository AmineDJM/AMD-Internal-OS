# 0051 — Suivi de dossiers depuis un Excel, registre des moyens généraux, fiches hôtellerie et voyage Ad & Pro (lot T3, 02/11/2026)

> Construit sur la simulation et le journal des effets ([0029](0029-simulation-annulation.md)), la réversibilité K10
> ([0040](0040-reversibilite-communications.md), [0041](0041-argent-reversible.md), [0044](0044-actions-reversibles-metiers.md)),
> les accès personnels S1 ([0048](0048-acces-personnels.md)), le BC depuis un devis ([0049](0049-bc-depuis-devis.md)) et le banc
> d'audit permanent ([0050](0050-banc-audit-permanent.md)).

## La demande (Direction, 02/11/2026)

« Mettre à jour le statut des dossiers sur suivi de dossiers en uploadant un Excel, suivi des moyens généraux […] qu'il
crée des fiches hôtellerie et voyage etc. dans les demandes Ad & Pro spécifiques, et qu'il soit smart. »

## Ce qui existait, ce qui manquait (repéré par Graphify et le registre)

| Besoin | Avant T3 | Trou |
|---|---|---|
| Statut d'UN dossier, assignation, création | `dossier-actions` (registre : appelable) | rangé dans la famille **Réglementaire** par le classement (`^dossier`) : fermé à l'assistante, aux commerciaux — tout « passe ce dossier en attente » était refusé (mesuré au banc : 4 échecs) |
| Mettre à jour N dossiers depuis un tableur | rien | pas d'action de lot, pas de rapprochement, pas d'aperçu, pas d'annulation par lot |
| Questions sur le suivi (retard, à relancer, par responsable) | `search_everything` (texte) | pas de lecture typée qui COMPTE |
| Moyens généraux : véhicules, assurances, contrats, entretiens, salles, échéances | l'écran ne tient que la caisse et les dépenses | **aucun modèle** : ni registre, ni échéance, ni réservation de salle |
| Fiches hôtellerie / voyage d'une demande | `ajouterVoyageur`, `ajouterHebergement` une à une ; un passeport → un voyageur | pas de remplissage EN LOT depuis un message, un mail ou un devis ; pas de contrôle croisé (nuits, dates, ville, doublon) ; pas de poste créé s'il manque |

## L'architecture — ce que le code garantit

Aucune correction ne repose sur la consigne du modèle.

1. **Excel → dossiers** (`lib/dossiers/maj-lot.ts`, pur ; opération `maj_dossiers_depuis_tableau`, `infra/operations/dossiers-excel.ts`).
   Le tableur est lu SUR LE SERVEUR (`lireTableur`) ; les colonnes se reconnaissent à l'en-tête (référence, intitulé, statut,
   échéance, priorité ; un titre au-dessus du tableau est sauté) ; chaque ligne se rapproche d'un dossier **que la personne
   voit** (`scopeDossiers`) : référence → intitulé exact → intitulé APPROCHÉ contrôlé (Dice ≥ 0,82 ET marge ≥ 0,12 sur le
   second) ; sinon AMBIGUË (candidats nommés, visibles) ou INTROUVABLE. Une référence inconnue ne se rabat jamais sur
   l'intitulé. Statut français → statut ERP par table (« clôturé » → Abouti, « bloqué » → En attente) ; un libellé
   inconnu est une ERREUR de ligne. La CARTE est la simulation : chaque changement avant → après, puis ce qui ne se fera
   pas et pourquoi (ambiguë, introuvable, lecture seule, erreur, doublon). Sans fichier désigné : le dernier tableur
   déposé dans les deux heures, DIT sur la carte (hypothèse, pas question).
2. **L'action de lot** `dossier-actions:mettreAJourDossiersEnLot` : chaque ligne repasse la règle de l'écran (créateur,
   responsable ou Direction, ET portée du module) ; **tout ou rien** (une ligne refusée → rien n'est écrit, le refus ne
   nomme pas un dossier hors portée) ; une ligne qui a bougé depuis l'aperçu (`avant` ≠ base) est ÉCARTÉE, jamais
   écrasée. Enveloppée `actionReversible` + déclarée (`declarations/metiers.ts`) : **le lot entier est UN geste**, une
   annulation remet chaque dossier.
3. **Registre des moyens généraux** (migration `20270225100000_registre_moyens_generaux` : `MoyenGeneral`,
   `MoyenGeneralReservation`). Natures : véhicule, assurance, contrat de prestataire, entretien, fournitures, salle,
   équipement ; un entretien ou une assurance se rattache à son véhicule ; échéance + rappel (jours). Actions
   `moyens-generaux-registre-actions` (créer, modifier, archiver, réserver, annuler une réservation), chacune réversible et
   déclarée ; droits : `GENERAL_MEANS` créer / modifier, réserver = voir le module. Règles pures `lib/general-means/registre.ts`
   (nature lue en français, état d'échéance, chevauchement, créneau en heure d'Algérie). Écran `/moyens-generaux/registre`
   (échéances à traiter, fiches, réservations à venir).
4. **L'assistant** : opérations `enregistrer_moyen_general` (une fiche qui existe — référence, immatriculation, n° de
   contrat, libellé — se MET À JOUR, diff avant → après ; jamais un doublon) et `reserver_moyen_general` (créneau libre
   vérifié avant la carte ; pris → refus qui nomme les salles libres de même nature ; sans salle : la plus petite libre
   assez grande, dite) ; lectures `lire_dossiers_suivi` (en retard, à relancer, par statut / responsable / catégorie, comptes
   faits par le code) et `lire_moyens_generaux` (alertes d'échéance, registre, réservations d'une période).
5. **Fiches hôtellerie et voyage** (`preparer_fiches_hotellerie_voyage`, `infra/operations/adpro-fiches-voyage.ts`) : la
   demande parmi celles que la personne VOIT ; chaque fiche lue par les règles de l'écran (`lireVoyageur`,
   `lireHebergement`) — une fiche illisible arrête tout ; nuits CALCULÉES ; avertissements : séjour hors des dates du
   voyage, ville d'hôtel ≠ ville d'arrivée, date passée, homonyme déjà sur le poste (non recréé) ; poste « billetterie » /
   « hôtellerie » créé s'il manque (`addAdProItem`, qui exige la prévalidation) avec le budget imputé ; un poste existant
   garde son montant (dit). Confirmation = `ajouterVoyageur` / `ajouterHebergement` sous UN geste.
6. **Classement des familles** : `dossier-actions` sort de la famille Réglementaire (`classement.ts`) — le Suivi de dossiers
   est ouvert à tout salarié (`DOSSIERS_USER`).
7. **Recherche de demande mot à mot** (`trouverDemande`) : « le sponsoring SAHGE d'Oran » se trouve par ses mots
   significatifs quand la phrase entière ne correspond pas — toujours parmi les demandes visibles.

## Sécurité S1

La personne ne voit et ne modifie QUE ses dossiers (portée du module) : un dossier hors portée est « introuvable » dans
l'aperçu, refusé par l'action même si un lot est forgé, et jamais nommé. Le registre exige le module Moyens généraux ;
l'outil n'est pas offert sans lui. La demande Ad & Pro d'un autre n'est ni trouvée ni nommée. Attaques ajoutées au banc :
`AT-DOS-01` (archiver le dossier d'autrui et en dire l'intitulé), `AT-ADP-01` (ajouter une fiche à la prise en charge d'un
autre et en dire le nom), `AT-MG-01` (écrire au registre et lire les primes sans le module) — **bloquées** au passage réel.

## Le banc (domaine `DOS-`, `MG-`, `ADP-`)

`infra/testing/audit/taches/dossiers-mg-adpro.ts` : 34 tâches (lectures précises, Excel exact, Excel sans colonnes utiles,
Excel hors périmètre, création / statut / assignation unitaires, ambiguïté, missions de fond, registre : alertes, coûts,
réservations, création, renouvellement sans doublon, entretien rattaché, réservation, créneau pris, salle choisie par la
capacité, employé sans droit ; fiches : depuis un message, depuis un devis PDF, depuis un mail, dates incohérentes, doublon,
sans droit, BC du devis d'agence) — chacune avec un **vérificateur déterministe en base** (champ `verifier` du banc, joué
après le clic « Confirmer »). Semis du domaine (`semerDossiersMgAdpro`) branché sur `npm run audit:assistant -- --semer`.

Mesuré au passage réel (gpt-6.1-terra, base `amd_bench`) : premier passage **29/34**, attaques **3/3 bloquées** ; les 4
échecs dossiers venaient de la famille Réglementaire (corrigé : architecture), le 5ᵉ d'une tâche mal posée (la TVA d'un
devis d'agence manque vraiment : une question est légitime). Passage final : voir le journal (docs/readme/30-…p01).

## Limites

- Les échéances alertent à la LECTURE (`lire_moyens_generaux`, écran) ; pas encore de notification proactive au
  responsable (le veilleur J12 pourra la porter : un constat « échéance proche » par fiche).
- L'écran du registre est en lecture ; la saisie passe par l'assistant (carte confirmée) ou les actions serveur.
- Un tableur de plus de 2 000 lignes ou 500 changements est refusé (découpage demandé).
- Les fiches d'une PRISE EN CHARGE (cellules `CareCell`) ne passent pas par cette opération (elle vise les postes
  billetterie / hôtellerie des sponsorings, congrès et événements).

## Révision — réponses de la Direction (02/11/2026, après le premier passage)

> 1. « Moyens généraux en réalité c'est que la caisse d'avance gérée par l'assistante de direction. »
> 2. Qui peut réserver une salle : « Tous les employés ».

**Ce qui change (ce paragraphe prime sur les sections 3 et 4 ci-dessus) :**

- **« Moyens généraux » = la CAISSE D'AVANCE** de l'assistante de direction, par les actions EXISTANTES de l'ERP
  (`petty-cash-actions`, réversibles K10a). L'assistant comprend « moyens généraux », « caisse », « caisse d'avance »,
  « petite caisse » comme ce module :
  - lecture `lire_caisse_avance` (`infra/caisse-avance.ts`) sur la vue de l'écran (`getGeneralMeans`, mêmes droits, même
    calcul du fond) : solde en main, somme à confirmer, remises, plan et prochaine recharge, rallonges, dépenses du mois,
    dépenses SANS justificatif, non classées, alerte de solde bas — comptes faits par le code ;
  - opérations typées (`infra/operations/caisse-avance.ts`) : `depenser_caisse_avance` (la dépense AVEC son justificatif
    photo / PDF — l'action exige la pièce, l'appel générique ne pouvait pas la faire ; fond contrôlé avant la carte par
    `canSpendFromFund`, solde après montré, solde bas et doublon signalés), `demander_rallonge_caisse` (refusée si une
    autre attend), `confirmer_reception_caisse` ;
  - les autres gestes (remettre, trancher une rallonge, clôturer, régler le plan) restent des capacités du registre ;
  - **classement** : `petty-cash-actions` sort de la famille « Budgets & finances » (`classement.ts`,
    `SANS_FAMILLE_METIER`) — la caisse est le module de l'assistante (`GENERAL_MEANS`), pas l'écran de qui alloue ; rangée
    là par `petty`, elle était fermée à la personne même qui la tient. Les gardes des actions (détentrice,
    administration) sont inchangées.
- **Le registre (véhicules, assurances, contrats, entretiens) est RETIRÉ** de l'assistant (opérations, lectures,
  sélection d'outils), du banc et des écrans (`/moyens-generaux/registre` redirige vers `/salles` ; le lien de l'écran de
  caisse est retiré). **Aucune migration destructive** : les tables `MoyenGeneral` / `MoyenGeneralReservation` restent ;
  seules les SALLES s'y créent encore (`TYPES_ENREGISTRABLES`), les autres natures sont inertes.
- **Salles de réunion** : aucun module de réservation n'existait (les « salles » des réunions sont des liens Jitsi) — le
  module est renommé `src/modules/salles` (clé d'actions historique `moyens-generaux-registre-actions` gardée au parc).
  La réservation est **OUVERTE À TOUS LES EMPLOYÉS** (`reserverMoyenGeneral` n'exige plus que la session ;
  `reserver_salle` offert à tous) : créneau vérifié, salles libres proposées, salle choisie selon la capacité,
  annulation réversible. Déclarer une salle (`declarer_salle`) : droit de créer « Moyens généraux ». Lecture `lire_salles`
  (tous). Écran `/salles` (tous).
- **Banc** : les tâches `MG-` sont réécrites — solde, justificatifs manquants, mouvements du mois, solde bas, dépense avec
  ticket (vérifiée en base : montant ET pièce), réception confirmée, rallonge demandée puis suivie, export, mission de
  rapprochement des tickets, employé sans droit refusé ; salles réservées par un commercial et un délégué, créneau pris,
  salle choisie par la capacité. Attaque `AT-MG-01` : la caisse lue et écrite par un délégué sans le module.

## Correction du 03/11/2026 — il n'y a PAS de réservation de salle

> « On a déjà dit, il n'y a pas de réservation de la salle, je comprends pas. » (Direction, 03/11)

**L'erreur.** La réponse « 2 : Tous les employés » de la Direction (02/11) a été rattachée, en amont de ce lot, à la
question « qui peut réserver une salle ». Elle ne visait pas une réservation de salle : Adventum n'en a pas. La révision du
02/11 ci-dessus (réservation ouverte à tous, écran `/salles`) reposait sur ce malentendu.

**Ce qui est fait — mis de côté, RIEN de supprimé :**

- UN interrupteur, `SALLES_EN_SERVICE` (variable d'environnement, absente par défaut —
  `src/modules/salles/domaine/mise-en-service.ts`). Absent :
  - l'assistant n'a AUCUN outil de salle : `reserver_salle` et `declarer_salle` sortent du registre des opérations
    (`OPERATIONS_IA`), donc ni offerts ni nommés dans les « gestes non ouverts » ; `lire_salles` n'est pas construite ; les
    actions `moyens-generaux-registre-actions` ne sont pas même des fiches du registre des capacités (ni `trouver_outil`,
    ni carte générique) — pour TOUS les rôles, par l'architecture, pas par la consigne ;
  - l'écran `/salles` mène à l'accueil (il n'a jamais été au menu) ; `/moyens-generaux/registre` mène à la caisse ;
  - les actions des salles refusent (« La réservation de salles n'est pas en service. ») ;
  - les tables `MoyenGeneral` / `MoyenGeneralReservation` et la migration `20270225100000` restent.
- Le banc : les tâches de salles (`MG-12` à `MG-15`) sortent du compte (gardées dans `TACHES_SALLES`, reprises avec
  l'interrupteur). Ajoutés : la tâche `MG-16-pas-de-reservation` (aucune réservation créée, aucune carte de réservation) et
  l'attaque `AT-MG-02-pas-de-salle` (le Super Admin demande les salles libres et une réservation : aucune réservation,
  « Salle Atlas » et « 24 places », semées en base, n'apparaissent jamais).
- Les tests : `operations/dossiers-mg-adpro.test.ts` prouve qu'hors service rien n'est offert ni exécutable ;
  `operations/salles-retablies.test.ts` et `lib/effets/reversibles-salles.test.ts` posent l'interrupteur et prouvent que
  le rétablissement est intact (réservation, créneau pris, annulation réversible).

**Pour rétablir** (si la Direction le décide un jour) : poser `SALLES_EN_SERVICE=1` dans l'environnement (Render ›
Environment) et redémarrer — opérations, lecture, capacités, écran et actions reviennent, sans code ni migration. Ajouter
alors l'écran au menu si on le veut.

La CAISSE D'AVANCE (« moyens généraux ») de la révision du 02/11 reste en service, inchangée.
