# 0061 — Doublons de médecins proposés au Super Admin, demande de stock réservée, relevé du délégué (lot T2 bis, 03/11/2026)

Suite de la [décision 0052](0052-annuaires-marketing-terrain.md). La Direction a répondu le 03/11 à trois questions
du lot T2. Ses réponses sont devenues des règles du **code**, pas des phrases de consigne.

## 1. Les fiches médecins en double — Adam propose, le Super Admin décide

> « Oui, on fusionne les fiches médecins en double, mais c'est à moi de le faire, pas à toi. […] tu proposes ça que à
> l'administrateur. Et après, moi, j'ai juste à cliquer une croix ou une validation et ça valide. »

- **Détection** : une règle pure, `src/modules/referentiels/domaine/medecins/doublons.ts` (`proposerFusionsMedecins`).
  Deux fiches sont rapprochées si elles ont la même clé de nom (sans accents, sans « Dr », mots triés), le même
  téléphone (au moins 8 chiffres) ou le même e-mail. Deux wilayas renseignées et différentes, ou deux spécialités
  différentes, écartent la paire. Un téléphone identique l'emporte sur cette différence. La fiche **gardée** est la plus
  complète, puis celle qui porte le plus de rattachements (visites, comptes rendus, Ad & Pro…). La proposition dit :
  la fiche gardée, la fiche absorbée, les raisons, les champs que la fiche gardée **reçoit** et ce qui est rattaché.
- **Visibilité** : `propositionsFusionMedecins(user)` (`referentiels/infra/medecins/doublons.ts`) renvoie `[]` à tout
  autre compte que le Super Admin réel. Un Super Admin qui incarne un autre compte est exclu. Pour Adam, la lecture
  `doublons_medecins` n'est ouverte qu'au Super Admin (`allowed`). Elle est absente du catalogue des autres comptes :
  l'assistant d'un employé ne peut pas en révéler l'existence. La tâche ANN-20 le vérifie au mot près.
- **Décision** : la page `/annuaires/medecins/doublons` (Super Admin seul, sinon `notFound()`) liste les propositions.
  - **✓ Fusionner** (`fusionnerMedecinsEnDouble`) :
    - complète les champs vides de la fiche gardée par `updateDoctor` ;
    - déplace les visites, les comptes rendus (y compris le tableau `doctorIds`), les mouvements d'échantillons, les
      observations, les dérogations de segmentation, les lignes Ad & Pro, les fiches de segmentation et les styles de
      cellule (sans doublon) ;
    - **archive** la fiche absorbée (jamais supprimée) ;
    - est annulable K10 (`actionReversible`), testé dans `reversibles-annuaire.test.ts` (fusion → annulation → rétablir).
  - **✗ Écarter** (`ecarterFusionMedecin`) enregistre une `DecisionFusionMedecin` ECARTEE avec l'**empreinte** des deux
    fiches. La proposition ne revient que si l'une des fiches change.
- **Le référentiel des personnes** : le banc réel (ANN-20) a montré au marketing la fusion d'un doublon de **personne**
  (`personnes-actions:fusionnerDoublonPersonne`), refusée au clic, mais l'assistant révélait « réservée au Super Admin ».
  Le fichier `personnes-actions` entre dans `SURFACES_HUMAINES` : ce sont des décisions prises sur l'écran de revue.
- **Adam ne fusionne jamais** : les deux actions sont marquées `ACTIONS_HUMAINES` (`src/lib/actions/generique.ts`). Elles
  sont donc non appelables par la capacité générique, même pour le Super Admin (classement : `appelable: false`). Elles
  sont aussi exclues de la parité des circuits. La lecture ne renvoie qu'un lien vers la page et la consigne « tu
  proposes, tu ne fusionnes jamais ».
- La fusion des **pharmacies et établissements** (`fusionner_doublons_annuaire`, décision 0052) est inchangée : la
  réponse de la Direction porte sur les fiches médecins.

Modèle : `DecisionFusionMedecin` (migration additive `20270224100000_t2_decisions_fusion_medecins`, sans clé étrangère).

## 2. La demande formelle d'état de stock — marketing, opérations, National Sales ; jamais le délégué

> « ça peut être le marketing, ça peut être les opérations, ça peut être le National Sales Manager. Évidemment, ça peut
> pas être le délégué. Par contre, le délégué peut enregistrer de lui-même des stocks. »

- **Règle unique** : `regleDemandeEtatStock`, au socle des droits (`src/lib/rbac/roles.ts`). Sur l'accès résolu, c'est `peutDemanderEtatStock` ; `canRequestStockState` (`lib/stocks/scopes.ts`) n'en est que l'alias historique. Le module assistant la lit ainsi sans dépendre de `lib/stocks`. Elle autorise :
  - le Super Admin ;
  - la vue chaîne d'approvisionnement (PCH) ou la vue globale ;
  - les rôles `ROLES_DEMANDE_STOCK` = `OPERATIONS_DIRECTOR`, `NATIONAL_SALES` et les rôles marketing
    `MEDICAL_PROMOTION_MANAGER` et `PRODUCT_MANAGER`.

  Un compte dont le rôle principal est `MEDICAL_DELEGATE` est refusé, même avec une vue étendue.
- La page Stocks, la récurrence (`stock-recurrence-actions`, `recurrence-runner`), le pilotage (`peutPiloterDemandesStocks`)
  et les actions (`demande-stocks-actions`, `stock-snapshot-actions`) passent par cette règle, avec le rôle principal et
  le rôle secondaire. Tous les refus disent le même texte, `REFUS_DEMANDE_STOCK`, qui oriente le délégué vers son relevé.
- **Droit ajouté** : `STOCKS: READ` pour `MEDICAL_PROMOTION_MANAGER` et `PRODUCT_MANAGER` (`src/lib/rbac/permissions.ts`).
  Sans lui, le marketing ne voyait pas le module où la demande se lance. C'est le droit minimal qui rend la réponse 2
  vraie. Il n'ouvre aucune écriture de stock.
- **Le délégué relève son stock** : nouveau geste `releve_stock` (`assistant-ia/infra/operations/stocks-terrain.ts`).
  La capacité générique `recordStockSnapshot` attend l'identifiant d'un dossier réglementaire, que le délégué ne peut
  pas désigner. Le geste résout donc le produit dans **sa gamme** (produits promotionnels de sa BU) et le lieu dans **ses
  secteurs**. Il montre une carte, puis appelle l'action de l'écran, qui rejuge la portée. Un lieu hors secteur n'est
  jamais proposé.
- **La demande lancée par Adam** : nouveau geste `demande_etat_stock`, dans le même fichier. Au banc réel, la capacité
  générique attendait des identifiants : le modèle demandait « à qui », ou se rabattait sur une tâche. Le geste résout
  les produits (dossier réglementaire au statut terminé) et les établissements par leurs noms. Sa carte nomme les KAM qui
  couvrent. Il appelle ensuite `creerDemandeStocks`, qui rejuge le droit.
- **Le contournement fermé** : au banc réel, le délégué refusé obtenait la même chose par `demander_au_terrain`
  (« demande à Sofiane l'état de stock »). Une question d'état de stock (`DEMANDE_D_ETAT_DE_STOCK`) posée par qui n'a pas
  le droit reçoit maintenant le même refus.

## 3. L'annuaire en production — par le marketing, dans les droits existants

> Le marketing tient l'annuaire en production, dans les droits RBAC existants ; un droit manquant se signale.

- `MEDICAL_PROMOTION_MANAGER` a `MEDICAL: MANAGE` (portée ALL) : l'annuaire lui est ouvert en écriture.
- **Droit manquant signalé, non ouvert** : `PRODUCT_MANAGER` n'a que `MEDICAL: READ`. Un chef de produit ne peut donc
  pas corriger l'annuaire, ni à l'écran ni par Adam. L'ouvrir est une décision de la Direction.

## Preuves

- Base locale : `src/modules/assistant-ia/annuaire-terrain.test.ts` (doublons proposés au seul Super Admin, aucune
  fiche archivée par la lecture, aucun geste de fusion de médecins offert ; demande de stock marketing oui / délégué
  refusé par le serveur ; relevé du délégué 40 unités à Ibn Sina ; lieu hors secteur refusé ; règle des rôles) et
  `src/lib/effets/reversibles-annuaire.test.ts` (✓ puis annulation puis rétablir ; ✗ puis retour après modification ;
  délégué refusé).
- Banc : ANN-19 (Super Admin : propositions, rien fusionné), ANN-20 (marketing demande à fusionner : refusé sans
  révéler la fonction), TER-08 (délégué lance une demande : refusé), TER-09 (délégué relève son stock : fait), TER-10
  (marketing lance la demande : faite).
- Rejeu réel ciblé, base de banc locale, `ADAM_SORTIE_INTERDITE=1`, aucun envoi :

  | Passage | Résultat | Coût |
  |---|---|---|
  | `t2/bis/` | 4 / 7. ANN-20 : fusion des personnes offerte au marketing. TER-08 : contournement par `demander_au_terrain`. TER-10 : pas de geste typé. | 0,27 $ |
  | `t2/bis2/`, après correctifs | TER-08, TER-09 et TER-10 réussies. ANN-20 se comporte bien (refus, rien révélé, rien fusionné), mais son motif `contient` ne lisait pas « je n'ai pas pu » ; le motif est élargi. | 0,11 $ |
  | `t2/bis3/` | ANN-19 et ANN-20 réussies. | 0,08 $ |

  Total : environ 0,46 $. ANN-15 et MKT-06 (non-régression) ont réussi au premier passage.
