# Nos « bases » de données et l'accès par base — résumé pour la Direction (02/11/2026)

**Le constat.** L'ERP a une seule base PostgreSQL de **515 tables**. Nous les avons toutes rangées — chacune une fois,
contrôlé automatiquement à chaque test — en **29 « bases »** : 24 bases métier, que l'on pourra ouvrir ou fermer, et
5 bases techniques, dont l'ERP a besoin pour tourner. Détail table par table, en français : [BASES-DE-DONNEES.md](BASES-DE-DONNEES.md).

## Les bases métier (381 tables)

| Base | Tables | Sensibilité |
|---|---:|---|
| Personnel & dossiers RH | 8 | Confidentiel → secret (fiche salarié, contrats, avenants) |
| Paie & rémunérations | 3 | **Secret** |
| Recrutement | 8 | Confidentiel → secret (fourchettes de salaire) |
| Finances, paiements & trésorerie | 12 | Confidentiel → secret (RIB des comptes) |
| Budgets & caisses | 19 | Confidentiel |
| Juridique, contrats & courriers | 8 | Confidentiel |
| Sociétés du groupe & organisation interne | 5 | Restreint → secret (RIB/IBAN des sociétés) |
| Coffre des données sensibles | 2 | **Secret** |
| Annuaires, personnes & organisations | 20 | Restreint → secret (RIB des partenaires) |
| Ad & Pro, congrès & événements | 36 | Confidentiel |
| Matériel promotionnel | 19 | Restreint |
| Réglementaire | 44 | Restreint |
| Produits & gammes | 6 | Public interne → restreint (prix) |
| Développement & études de marché | 9 | Confidentiel |
| Marchés publics, ventes & logistique | 20 | Restreint |
| Stocks | 10 | Restreint |
| Force de vente, médecins & segmentation | 44 | Restreint → confidentiel (coaching, performance) |
| Information médicale & pharmacovigilance | 5 | Confidentiel → secret (données de santé) |
| Drive & documents | 27 | Restreint → confidentiel (contenu des fichiers, pièces) |
| Messagerie, courriels & agenda | 22 | Confidentiel |
| Tâches, demandes internes & validations | 19 | Restreint |
| Moyens généraux & demandes administratives | 9 | Restreint |
| Pilotage, KPI & intelligence de direction | 20 | Confidentiel → secret (évaluations) |
| Site web public | 6 | Public interne |

**Bases techniques (134 tables)** : Comptes, connexions & droits (17, secret) · Assistant IA — conversations et mémoire
personnelles (31, confidentiel) · IA — moteur et réglages (56, restreint → confidentiel) · Journaux & traçabilité
(8, confidentiel → secret) · Plateforme (22, restreint → secret).

## La proposition en 8 points ([détail](ACCES-PAR-BASE.md))

1. **Un niveau « base » au-dessus des modules**, en plus des accès actuels, jamais à leur place : pour un rôle ou une
   personne, chaque base métier est *Normale*, *En lecture seule* ou *Fermée*.
2. **Un plafond, pas un second registre** : une base fermée retire l'accès quel que soit le module ; elle n'ouvre jamais
   plus que les modules. « Ouvrir une base » serait un raccourci qui coche les bons modules.
3. **Appliquée aux données, pas seulement à l'affichage** : une garde unique dans le point de passage de toutes les
   lectures et écritures de l'ERP. Elle couvre d'un coup écrans, boutons, exports, recherche, API et l'assistant.
4. **L'assistant suit** : il lit déjà sous l'identité de la personne (S1) ; une base fermée ferme aussi ses familles
   (Paie → salaires, Personnel → fiches et contrats…), et il le dit au lieu de chercher ailleurs.
5. **Un refus clair** à l'écran — « La base *Paie* vous est fermée — demandez à la Direction » —, jamais une page vide.
6. **Le coffre reste tel quel** : même base ouverte, IBAN, NIN et salaires ne se lisent en clair que par le coffre,
   journalisé et interdit à l'IA.
7. **Une console « Par base »** : une grille bases × rôles (ou une personne), et un onglet « Qui voit cette base
   aujourd'hui ? » utile dès le premier jour ; chaque changement daté, motivé et journalisé, comme les droits de S1.
8. **Par étapes, sans risque pour la production** : d'abord l'écran « qui voit quoi » (rien n'est refusé), puis deux
   semaines où la garde **observe** sans refuser, puis l'application stricte aux bases secrètes et confidentielles
   (Paie, Personnel, Recrutement, Finances, Information médicale, Pilotage), puis le reste.

## À trancher par la Direction

Fermer seulement, ou aussi ouvrir ? · Le découpage des 24 bases convient-il ? · Par rôle, par personne, ou les deux ? ·
Droits datés avec motif obligatoires ? · Le Super Admin hors de portée ? · Garder l'accès à **ses propres** données
quand la base est fermée ? · Laisser visibles nom et poste d'un salarié dans les autres écrans ? · Faut-il, plus tard,
une garde au niveau du moteur PostgreSQL pour Paie et Coffre ? · Valider le classement des 35 tables « secret ».
