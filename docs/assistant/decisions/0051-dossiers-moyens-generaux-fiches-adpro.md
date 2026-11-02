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
