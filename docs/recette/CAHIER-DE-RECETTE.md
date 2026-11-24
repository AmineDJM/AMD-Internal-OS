# Cahier de recette utilisateur — AMD Internal OS

> Contrôle final demandé par le Super Admin (24/11/2026) : « le contrôle final, c'est pas une histoire de contrôle de
> code uniquement, mais également de tests user ; j'aimerais que toi-même tu fasses les tests user, de manière super
> bien détaillée ». Ce cahier est la **référence** de la recette ; le banc exécutable (`e2e/recette/`) en joue les
> étapes dans un vrai navigateur, capture chaque étape et produit le rapport.
>
> Sources qui font foi : `/home/user/wt/DECISIONS.md` (toutes les décisions, y compris « Audit des dépenses — FONT
> FOI »), `/home/user/wt/VAGUE3.md`, les maquettes validées (`…/scratchpad/design/project/*.dc.html`). Quand une
> maquette et une décision divergent, **la décision la plus récente l'emporte** (voir §6, points de vigilance).

---

## 1. Mode opératoire

### 1.1 Environnement

| Élément | Valeur |
|---|---|
| Lancement complet | `scripts/recette/lancer.sh` (build propre `rm -rf .next && next build`, `next start` sur le premier port libre ≥ 3200, base dédiée, graine, parcours, rapport) |
| Seulement les lots fusionnés | `scripts/recette/lancer.sh --prets` |
| Seulement les parcours en attente de fusion | `scripts/recette/lancer.sh --attente` |
| Contre un serveur déjà démarré | `RECETTE_BASE=<sa base> scripts/recette/lancer.sh --url http://localhost:3217` (la graine doit écrire dans la base que ce serveur lit ; + `RECETTE_LENT=1` si c'est `next dev`) |
| Un parcours | `scripts/recette/lancer.sh --sans-build -- 01-centre-paiement` |
| Base | `amd_recette` (locale, créée et migrée par le script ; `RECETTE_BASE` pour une autre). **Jamais la production** : la graine refuse toute base non locale. |
| Serveur | sorties interdites (`ADAM_SORTIE_INTERDITE=1` : ni courriel, ni push), tâches de fond éteintes (`TACHES_DE_FOND=worker` sans worker), clés IA factices sauf si `ANTHROPIC_API_KEY` est fournie (parcours `@ia-reelle`) |
| Sortie | `recette-sortie/<date>/rapport.md`, `rapport.json`, `captures/<parcours>/*.png` (deviceScaleFactor 1), traces Playwright des échecs |
| Appareils | **Ordinateur** 1440 × 900 ; **téléphone** 390 × 844, tactile (`isMobile`) |

### 1.2 Comptes de test (graine `e2e/recette/seed.ts`)

Mot de passe commun : `Recette!MotDePasse#2026` (ou `RECETTE_MOT_DE_PASSE`). Tous les comptes ont accès à la
société de test **« __recette__ Adventum Pharma TEST » (RECETTE-ADV)** ; la seconde société **« __recette__ Pharmagène
TEST » (RECETTE-PHG)** n'est ouverte qu'aux rôles globaux (Super Admin, DG) — elle sert aux contrôles de cloisonnement.

| Clé | Métier | Courriel | Rôle | Accès ouverts par la grille | Département (responsable ?) | N+1 |
|---|---|---|---|---|---|---|
| superAdmin | Super Admin | `__recette__superadmin@recette.test` | SUPER_ADMIN | — | Direction générale | — |
| dg | Directeur général | `__recette__dg@recette.test` | GENERAL_MANAGER | — | Direction générale (oui) | — |
| dirOps | Directeur des opérations | `__recette__dirops@recette.test` | OPERATIONS_DIRECTOR | — | Opérations (oui) | DG |
| dirMarketing | Direction Marketing | `__recette__dirmarketing@recette.test` | PRODUCT_MANAGER | — | Marketing (oui) | DG |
| finances | Finances / Banque | `__recette__finances@recette.test` | FINANCE_BUDGET_MANAGER | — | Finances (oui) | DG |
| comptable | Comptabilité | `__recette__comptable@recette.test` | VIEWER | FINANCES_COMPTABILITE (créer, modifier, déposer) | Finances | Finances |
| assistante | Assistante de direction / secrétariat | `__recette__assistante@recette.test` | DIRECTION_ASSISTANT | — | Direction générale | DG |
| rh | RH | `__recette__rh@recette.test` | DIRECTION_ASSISTANT | RH (tout), TRAINING | RH (oui) | DG |
| regulatory | Responsable réglementaire | `__recette__regulatory@recette.test` | HEAD_OF_REGULATORY | — | Regulatory (oui) | Dir. opérations |
| pharmacienIM | Pharmacien information médicale | `__recette__pharmacienim@recette.test` | MEDICAL_INFO_PHARMACIST | — | Information médicale (oui) | Dir. opérations |
| superviseur | Superviseur (force de vente) | `__recette__superviseur@recette.test` | MEDICAL_PROMOTION_MANAGER | superviseur de la BU « __recette__ BU Cardio-Diabète » | Opérations | Dir. opérations |
| delegue | Délégué médical | `__recette__delegue@recette.test` | MEDICAL_DELEGATE | rattaché à la BU (région Ouest) | Opérations | Superviseur |
| kam | KAM | `__recette__kam@recette.test` | MEDICAL_DELEGATE | rattaché à la BU (région Centre) | Opérations | Superviseur |
| caissier | Caissier / moyens généraux | `__recette__caissier@recette.test` | DIRECTION_ASSISTANT | GENERAL_MEANS | Administration — moyens généraux (service de la caisse) | Assistante |

Le Centre de paiement n'a **aucun siège nommé** dans la graine (décision : Super Admin + DG uniquement).

### 1.3 Données de test

Toutes préfixées `__recette__`, posées par chaque parcours (`e2e/recette/donnees.ts`) de façon idempotente : ordres
de dépense en amont du centre / de la Banque, enveloppes budgétaires (générale et Regulatory « BV 25 % » / « BV 75 % »),
compte bancaire ancré, dossiers Regulatory (présoumission favorable), congrès national (circuit d'achat v2), produit et
message de gamme, médecins du panel, salarié sortant. Quand l'écran sait créer la chose, **la recette la crée par
l'écran** (demande de BV, remise de caisse, courrier, signalement PV, dépôt Drive).

### 1.4 Conventions de lecture

- « **Libellé** » entre guillemets français = texte exact attendu à l'écran.
- **Bouton décisif** = deux clics sur le même bouton (le premier l'arme : « Confirmer : … ? »), jamais de fenêtre native.
- **Attendu** = ce que l'écran doit montrer ; **en base** = contrôle complémentaire fait par le banc (jamais à la place de l'écran).
- **Contrôle négatif** = refus de droit, séparation des tâches, absence de ce qui ne doit pas être là.
- 📱 = version téléphone à vérifier (aucun défilement de côté, gestes accessibles au pouce).
- Gravité d'un écart : **Bloquant** (argent, droits, perte de données), **Majeur** (geste impossible ou faux), **Mineur** (libellé, mise en page).
- `@attend-fusion:<lot>` = parcours écrit d'après DECISIONS.md et les maquettes ; le lot n'est pas encore fusionné — étapes décrites ici, script écrit au contrôle final (helper `attendFusion(...)` prêt dans `banc.ts`).

### 1.5 État des lots au moment de l'écriture (branche de base `2f75588`)

| Fusionnés | En attente de fusion |
|---|---|
| signature, sécurité, caisse, courrier, bv, console, Aujourd'hui (mon-espace), visite médicale (renommage, aiguillage, superviseur, détection PV), infomed, ficheadpro, courrierux, secretariat, pec, drvacces, centreui, banqueui, drvsecu, ctrvalid, drvversions, drvstock | justif, compta, impots, tva, ctradpro, adprolist, directeurs, informatique, rhdepart, regenreg, campagne, pvdecl, vmdelegue, echeances, avantages, memoire, gardefous, drvux, chargesfixes, natures |

---

## 2. Matrice rôles × parcours

Légende : **A** acteur principal · **a** acteur secondaire · **N** contrôle négatif (doit être refusé) · **T** version téléphone vérifiée.

| Parcours | SA | DG | DirOps | DM | Fin | Compta | CdP* | Assist. | RH | Reg | PhIM | Délégué | KAM | Superv. | Caissier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P00 Accès par rôle | A T | A T | A T | A T | A T | A T | — | A T | A T | A T | A T | A T | A T | A T | A T |
| P01 Centre de paiement | A T | A | N | — | a | — | A | a | — | — | — | — | — | — | — |
| P02 Banque & paiements | — | — | — | — | A T | N | — | a | — | a | — | N | — | — | — |
| P03 BV 25/75 · Centre de validations | a | A | — | — | — | — | — | — | — | A | — | N | — | — | — |
| P04 Caisse / remise | A | — | — | — | A | — | A | N | — | — | — | — | — | — | A T |
| P05 PEC v2 → BC → achat → paiement | a | a | — | A | a | — | a | A | — | — | — | N | a | — | — |
| P06 Bureau du secrétariat · courrier | — | — | — | — | — | — | — | A T | — | — | — | N | — | — | — |
| P07 Drive | — | — | — | — | — | — | — | A | — | — | — | N | — | — | — |
| P08 Visite médicale | — | — | a | — | — | — | — | — | — | — | — | A T | A | A | — |
| P09 Pharmacovigilance | — | — | — | — | — | — | — | — | — | A | A | A N | — | — | — |
| P10 Aujourd'hui · échéances | — | A | — | — | A | — | — | A | A | — | — | — | A T | — | — |
| P11 Justificatif obligatoire | A | — | — | — | A | — | A | A | A | — | — | — | — | — | — |
| P12 Comptabilité · Composer une facture | — | — | — | — | A | A | — | — | — | — | — | — | — | — | — |
| P13 Impôts & cotisations · TVA | — | — | — | — | A | — | a | — | — | — | — | — | — | — | — |
| P14 Ad & Pro : liste, fiche, centre | A | A | N | A T | — | — | — | — | — | — | — | N | T | — | — |
| P15 Départ d'un salarié | — | A | — | — | — | — | — | — | A | — | — | N | — | A | — |
| P16 Enregistrement 5 ans | — | — | — | — | — | — | — | — | — | A | — | — | — | — | — |
| P17 Campagne recettes / dépenses | A | A | A N | — | — | — | — | — | — | — | — | — | — | — | — |
| P18 Pouvoirs des directeurs · SA seul | A | N | A N | N | — | — | — | — | — | — | — | — | — | — | — |
| P19 Informatique · registre des avantages | A | N | — | N | — | — | — | — | — | — | — | — | N | — | — |
| P20 Charges fixes · natures | — | — | N | — | A | — | — | A | — | — | — | — | — | — | — |
| P21 Information médicale | — | — | — | — | — | — | — | — | — | — | A T | — | N | — | — |

\* **Centre de paiement** : ce n'est pas un compte à part — il est tenu par le Super Admin et le DG (décision du 24/11 :
« AUCUN siège par pôle »). La colonne CdP rappelle les gestes faits « au centre ».

---

## 3. Parcours détaillés

Chaque parcours porte un identifiant (P01…), le fichier du banc qui le joue, son état (fusionné / `@attend-fusion`),
ses pré-requis, ses étapes numérotées (geste → attendu), ses contrôles négatifs et sa version téléphone.

### P00 — Chaque métier se connecte, arrive, et ne voit pas ce qui ne le regarde pas
Banc : `00-acces-par-role.recette.ts` · **fusionné** · 15 comptes.

Pour **chaque** compte du §1.2 :
1. Ouvrir `/login`, saisir « Email professionnel » et « Mot de passe », cliquer « Se connecter ». → Arrivée hors de `/login` (page d'accueil du métier), aucun « Application error ».
2. Lire le menu latéral. → Au moins une entrée ; libellés en français ; le pôle de plus de cinq entrées s'ouvre au clic.
3. Contrôles négatifs (adresse tapée à la main) → refus (redirection ou écran d'accès refusé) :
   - Délégué : `/finances/paiements-a-faire`, `/centre-de-paiement` (« Vous ne siégez pas au centre de paiement »), `/rh/paie`, `/admin`, `/finances/comptabilite`.
   - KAM : `/finances/paiements-a-faire`, `/admin`, `/rh`.
   - Comptabilité : `/finances/paiements-a-faire` (la comptabilité ne paie pas), `/admin`.
   - Caissier : `/finances/paiements-a-faire`, `/admin`, `/rh/paie`.
   - Pharmacien IM : `/finances/paiements-a-faire`, `/admin`. Direction Marketing : `/admin`, `/rh/paie`.
4. 📱 Même connexion sur téléphone → page d'arrivée sans défilement de côté.
5. Aucune erreur JavaScript pendant le parcours.

### P01 — Centre de paiement (maquette CentrePaiement validée)
Banc : `01-centre-paiement.recette.ts` · **fusionné** (centreui).
Pré-requis : 4 ordres de test en attente sur RECETTE-ADV : « Impression des dépliants Cardio » 185 000 (demandeur assistante,
bénéficiaire « Imprimerie El Djazair »), « Location salle comité de direction » 96 000 (demandé par le **DG**), « Abonnement
revue doublon » 42 000 (assistante), « Fournitures de bureau novembre » 23 500 (assistante).

**Super Admin — autoriser**
1. Ouvrir « Centre de paiement », choisir la pastille de la société RECETTE-ADV. → Titre « Centre de paiement » ; à gauche « À décider · 4 » (une ligne par ordre, alerte courte) ; à droite la fiche.
2. Cliquer « Impression des dépliants Cardio ». → La ligne est marquée courante ; la fiche montre montant + bénéficiaire (+ « 1er paiement » / « n paiements en 2026 »), **alertes en rouge** (ici : sans facture / justificatif, bénéficiaire nouveau), « Déjà validé », « Pièces » (✓/✗, ouvrables), « Les montants, du début à la fin » (devis → accordé → BC → facture → à payer, écart en rouge), Budget (enveloppe › catégorie, disponible avant → après), « Déjà payé sur cette demande », demandé par / date.
3. Cliquer deux fois « Autoriser le paiement ». → « Autorisé — le paiement part chez les Finances (Banque & paiements). » ; en base `APPROVED`.
4. Recharger. → L'ordre a quitté « À décider ». « ⋯ » (« Autres : déjà décidés, exporter ») → il est dans « Déjà décidés ».

**Super Admin — refuser**
5. Ouvrir « Abonnement revue doublon », cliquer « Refuser ». → « Motif du refus — c'est ce que lira le demandeur », motifs en un clic, champ « Ou écrivez le vôtre… », bouton « Annuler ».
6. Choisir un motif, cliquer deux fois « Confirmer le refus ». → « Refusé — le demandeur est prévenu, avec votre motif. » ; en base `REFUSED` ; le demandeur reçoit une notification avec le motif.

**Directeur général** — 7. Ouvrir le centre → la file s'affiche (il siège). 8. Ouvrir « Location salle comité de direction » (qu'il a lui-même demandée) → « Autoriser le paiement » **fermé**, alerte « Demandeur = décideur » et la phrase qui dit pourquoi.

**Contrôles négatifs**
- Directeur des opérations : `/centre-de-paiement` → « Vous ne siégez pas au centre de paiement » ; aucun bouton de décision.
- Assistante (demandeur) : voit « Mes paiements au centre · n » avec son ordre en attente, **sans** « Autoriser ».
- Finances : l'ordre **autorisé** est dans « À payer » ; l'ordre **refusé** et l'ordre **en attente** n'apparaissent **jamais**.
- Après fusion `directeurs` : un « siège » nommé ne donne plus accès (P18).

📱 9. Super Admin sur téléphone : la file tient dans l'écran ; toucher une ligne ouvre la fiche **en plein écran** avec « Retour à la file » ; « Autoriser le paiement » accessible ; aucun débordement.

### P02 — Banque & paiements (consignes du 24/11 ; maquette BanquePaiements)
Banc : `02-banque-paiements.recette.ts` · **fusionné** (banqueui).
Pré-requis : compte « BNA Hydra » ancré (25 000 000) ; ordres autorisés « Maintenance climatisation siège » 64 000
(« Froid Service ») et « Acompte bureau d'études AMM » 410 000 (« ReguPharm »), imputés à une ligne budgétaire ; un ordre
**refusé** ; un ordre **annulé**.

1. Finances : ouvrir « Banque & paiements ». → En haut « Solde bancaire » (UN chiffre, « relevés du <date> ») ; onglets « À payer · n », « Reportés · n », « Payés · n » ; pastilles des sociétés de la personne.
2. Onglet « À payer ». → « Froid Service » et « ReguPharm » présents ; l'ordre refusé **absent**.
3. « ⋯ » (« Autres : comptes de trésorerie, actualiser les soldes, vider l'historique ») → « Actualiser les soldes ».
4. Cliquer le **nom** « Froid Service ». → Panneau : justificatif en aperçu direct (ici « Aucun justificatif joint à ce paiement. Demandez-le au demandeur ci-contre. »), « RIB du bénéficiaire : … », « Échanges avec le demandeur ».
5. Écrire « Merci de transmettre le RIB du fournisseur. » dans « Une question au demandeur : RIB, mode de règlement souhaité, acompte… » puis « Envoyer ». → Le message s'ajoute au fil ; le demandeur est notifié (📱 il le lit sur son téléphone) et peut répondre (« Votre réponse », pièce jointe facultative) ; ses **relances** sont visibles sur la ligne.
6. Ligne « ReguPharm » › « Actions sur la ligne » › « Reporter ». → « Reporter le paiement » : « Reporter au », « Motif (visible par le demandeur) » (« Pourquoi ce paiement attend-il ? »). Valider à J+10 → la ligne passe dans « Reportés » ; « Lever le report » → « Report levé : ReguPharm revient dans « À payer ». »
7. Ligne « Froid Service » › « Payer ». → Panneau « Payer Froid Service » : « Payé depuis » (compte + solde), « Date du paiement », « Mode », « Référence du virement ou du chèque (facultatif) » ; « Budget * » seulement si l'ordre n'est pas imputé.
8. « Marquer payé ». → La ligne passe dans « Payés » avec « Payé le … » ; en base `PAID` ; le solde de trésorerie diminue.
9. Onglet « Payés » : l'ordre annulé affiche **« Annulé »** (jamais « Non payé ») ; l'annulation d'un paiement passe par la barre d'annulation.

Contrôles négatifs : Comptabilité et délégué n'entrent pas (aucun « Marquer payé ») ; un ordre `REFUSED` ou `AWAITING` n'apparaît jamais ;
une remise de caisse ne demande **pas** de budget (P04) ; qui a demandé ou autorisé ne règle pas (séparation des tâches, réglage par défaut actif).
📱 Banque au téléphone : onglets accessibles, pas de débordement.

### P03 — BV 25 % / 75 % par le Centre de validations
Banc : `03-bv-centre-validations.recette.ts` · **fusionné** (bv, ctrvalid).
Pré-requis : budget Regulatory 2026 de RECETTE-ADV (« BV 25 % » 1 000 000, « BV 75 % » 3 000 000) ; dossiers « Cardiolex 5 mg » et « Glucovia 850 mg » (présoumission favorable).

1. Responsable réglementaire : dossier « Cardiolex », cliquer l'étape « Demande du BV 25 % ». → Bouton « Demander l'autorisation du BV 25 % ».
2. Le cliquer. → Feuille « Demander l'autorisation du BV 25 % » : « Montant (DZD) », « Échéance souhaitée », « Commentaire (facultatif) » (« Lu par le Centre de validations : urgence, échéance ANPP, précisions… »), « Pièces jointes (proforma BV, courrier ANPP…) ».
3. Saisir 120 000, joindre la proforma, « Demander l'autorisation ». → L'étape dit que la demande attend le Centre de validations ; en base une demande `REGULATORY_BV_25` `PENDING`. Un second clic / retour arrière → refus « déjà demandé ».
4. Même chose pour « Glucovia » (95 000) — sera refusée.
5. DG : le menu porte **une seule** entrée « Centre de validations » ; `/centre-de-validations` mène à `/validations`. → « À décider · n ».
6. Cliquer « BV 25 % — Cardiolex ». → Fiche : montant, « Déjà validé », « Pièces » (proforma ouvrable), gestes « Demander une précision », « Refuser », « Accepter le BV ».
7. « Accepter le BV » (deux clics). → Sort de la file ; en base `APPROVED` ; la ligne « BV 25 % » du budget Regulatory a **120 000 engagés** ; **aucun ordre de dépense** (exception assumée : ni centre de paiement ni Finances).
8. « Glucovia » › « Refuser » › motif en un clic › « Confirmer le refus ». → `REJECTED`.
9. Responsable réglementaire : « Cardiolex » → bloc Budget (« Demandé », « Engagé », « Consommé ») ; l'étape « Paiement » est déverrouillée ; marquer le paiement « fait » avec la quittance → **consommé**.
10. « Glucovia » → « Motif : … » et « Redemander l'autorisation du BV 25 % ».

Contrôles négatifs : délégué → pas de file ; le demandeur ne tranche pas sa propre demande ; « Lui renvoyer la demande pour correction » se lit comme un refus (il redemande).

### P04 — Caisse d'avance / remise
Banc : `04-caisse-remise.recette.ts` · **fusionné** (caisse).
1. Super Admin : « Moyens généraux » → carte de la caisse ; formulaire « Remettre une somme en caisse » (ou bouton « Remettre une somme »).
2. Montant 24 000, personne = le caissier, « Envoyer au centre de paiement ». → « Remise de 24 000 DZD envoyée au centre de paiement (OD-…) : autorisée, elle passera aux Finances ; payée, elle comptera dans la caisse dès que le caissier en confirme la réception. » ; rien n'est décaissé (pas d'écriture).
3. 📱 Caissier : « en attente du centre de paiement » ; **pas** de « Confirmer la réception ».
4. Centre de paiement : ouvrir « Caisse d'avance — … », « Autoriser le paiement ».
5. Finances : « Payer » la remise → **aucun champ « Budget »** (une remise n'est pas une dépense) ; « Marquer payé ».
6. Caissier : « Confirmer la réception ». → « En caisse » compte 24 000 ; la remise est confirmée.
7. Une seule caisse, celle des Moyens généraux ; « Demander une rallonge » suit le même circuit ; « Réglage mensuel de la caisse ».

Contrôles négatifs : l'assistante (pas destinataire) ne peut pas confirmer ; avant « payé », rien n'entre en caisse. Après fusion `justif` : le bon de remise est joint à la remise.

### P05 — Prise en charge v2 : du professionnel au BC signé, achat, facture, paiement
Banc : `05-pec-achats.recette.ts` · **fusionné** (pec, secretariat) ; signature réelle du BC = geste manuel (mot de passe + code à 6 chiffres), tag `@manuel:signature-bc`.
Pré-requis : « Congrès national de diabétologie — Oran », demandeur KAM, prévalidée, nouveau circuit.

1. Direction Marketing : ouvrir la demande. → Bloc « Professionnels · n » ; champ « Ajouter un professionnel » (« Tapez un nom : l'annuaire est cherché en direct ») ; case **« Demander son devis » cochée** par défaut.
2. Taper « Pr Karim Mansouri » (absent de l'annuaire), « Ajouter » ; si des homonymes sont proposés : « Déjà dans l'annuaire ? Choisissez la fiche, ou créez-en une nouvelle. » → « Non, créer une nouvelle fiche ». → Ligne du professionnel (postes, montant, « Où il en est » = chiffrage demandé, « Ouvrir », « Retirer »).
3. La case « Ajouter à l'annuaire » n'apparaît **que** pour une prise en charge (pas sponsoring / événement / autre).
4. Assistante : « Bureau du secrétariat » → ligne « Chiffrage PEC » du congrès. Ouvrir → « Chiffrer — Congrès national de diabétologie » : grille « Montants » poste par poste (pièce facultative), « Enregistrer », « Envoyer les montants ».
5. Saisir billet 45 000, hôtel 60 000, joindre la proforma, « Envoyer les montants ». → La DM voit « À vous : 1 professionnel chiffré à valider — 105 000 DZD ».
6. DM : « Valider seulement » ou « Valider et lancer les achats » (catégorie budgétaire du BC). → Bloc « Bons de commande » : **BC n°1** (contenu, montant, circuit, « Voir le PDF »).
7. « Signer et cacheter le BC n°1 » → contrôle renforcé (« Mot de passe », « Code à 6 chiffres »). → Le BC part au **visa du centre de validation Ad & Pro** (Direction générale), puis à la **signature des Finances**.
8. Assistante : page « Acheter — BC n°1 signé par les Finances » → **uniquement** les lignes de ce BC ; « Déposer le billet » / « Déposer la confirmation », « Marquer acheté », « Le prix a changé ? ».
9. Prix +15 % → refus de la marge : au-delà de **+10 %** le complément part dans un **BC complémentaire** (n°2) ; une baisse est toujours permise.
10. « Demander le paiement » sans facture → refus « La facture est obligatoire » ; avec la facture → « Paiement demandé — ordre de dépense … » → centre de paiement → Finances.
11. Retirer un professionnel **avant** achat → ligne barrée, argent libéré ; **après** achat → « Retiré après achat — remboursé ? » : « Remboursé : oui » (montant déduit de l'achat et du budget) / « Remboursé : non ».
12. DM : « Actualiser les prix » → tous les montants non achetés repartent chez l'assistante. Règle affichée : « Un BC signé ne se réécrit jamais : un ajout après signature part dans un BC complémentaire. »
13. Les montants de l'assistante comptent dans le **seuil DG (1 M DZD)** ; ils sont modifiables par l'assistante et la DM.
14. Les billets / hôtels vides des demandes **déjà en cours** ne sont pas retirés ; seules les nouvelles demandes changent.

Contrôles négatifs : le délégué ne voit pas le chiffrage du congrès dans le Bureau ; la discussion (messages + fichiers) reste en bas de la fiche.

### P06 — Bureau du secrétariat et courrier en panneau
Banc : `06-secretariat-courrier.recette.ts` · **fusionné** (secretariat, courrierux).
1. Assistante : « Bureau du secrétariat » (`/demandes`). → **Un seul tableau**, colonnes « Type », « Objet » (+ référence dessous), « Demandeur », « Dates », « État », « Chez qui », « Échéance » ; **pas** de montant ni de pièces ; **pas** d'onglets, de tuiles-compteurs ni de filtres ; tri automatique ; « Masquer les anciennes ».
2. Une seule recherche « Rechercher : objet, référence, demandeur, personne… » ; état vide = une phrase + le remède.
3. Chaque ligne ouvre une **fiche adaptée** à son type (billet, hôtel, BC, prospection d'agence, déplacement, achat, chiffrage PEC) avec la **discussion** (messages + fichiers) en bas ; prospection d'agences et bons de commande sont dans le tableau.
4. Les **courses / le coursier** n'existent plus (ni menu, ni écran `/demandes/courses`, ni notification) — les données restent en base.
5. Délégué (demandeur ordinaire) : ne voit que **ses** demandes ; une note de frais part **aux RH par son supérieur** (l'accusé de réception des originaux se fait côté RH), jamais à l'assistante.
6. Courrier : « Courriers » › « Enregistrer un courrier » → **panneau latéral** ; objet « Convocation ANPP — Cardiolex », expéditeur, date → enregistré, en tête de liste. Cliquer la ligne → fiche **en panneau** ; « Enregistrer les corrections » corrige **sans effacer** (historique) ; suppression cloisonnée et réversible ; dossiers par société.
📱 Liste des courriers et Bureau au téléphone : pas de débordement ; le panneau prend l'écran.

### P07 — Drive : > 10 Mo, versions, corbeille, pièces confidentielles
Banc : `07-drive.recette.ts` · **fusionné** (drvstock, drvversions, drvsecu, drvacces) + un test `@attend-fusion:drvux`.
1. Assistante : « Mes fichiers » › « Importer » un fichier de **12 Mo**. → Il apparaît ; en base sa taille est exactement 12 582 912 octets (rien de tronqué).
2. Importer « Contrat agence.pdf », clic droit › « Nouvelle version » (v2) ; clic droit › « Historique des versions » → 2 versions, la plus récente « actuelle ».
3. Clic droit › « Mettre à la corbeille » → « Il reste restaurable depuis la Corbeille. » ; « Corbeille » › « Restaurer » → retour dans « Mes fichiers ». « Supprimer définitivement » → « Seul le Super Admin pourra encore le restaurer. »
4. Négatif : le délégué ne voit pas le fichier (privé) ; un élément à la corbeille n'existe que pour son propriétaire.
5. Pièces confidentielles : aucune copie au Drive d'une pièce RH, médicale, pharmacovigilance ou voyageur ; une pièce CONFIDENTIELLE ne s'ouvre pas au simple lecteur de l'objet (au déposant, si) ; le partage par messagerie est révocable.
6. `@attend-fusion:drvux` : réimporter le même nom → « existe déjà ici » : « Nouvelle version » / « Garder les deux » ; historique : télécharger / « Restaurer » une version (nouvelle version, rien d'écrasé, auteur affiché) ; corbeille unique « ce que j'ai supprimé » avec « Supprimé de : … » ; avis « gardez l'application ouverte » au téléphone.

### P08 — Visite médicale (délégué / KAM / superviseur)
Banc : `08-visite-medicale.recette.ts` · **fusionné** (renommage, aiguillage, Ma journée, feuille de visite, hors ligne, relecture) ; `@ia-reelle` (détection PV) ; `@attend-fusion:vmdelegue` (interface de la maquette VisiteDelegue).
Pré-requis : produit « Cardiolex 5 mg » et message « Contrôle tensionnel en une prise par jour » dans la BU ; deux médecins dans le panel du KAM et du délégué.
1. Aiguillage `/medical` : KAM → « Ma journée » ; superviseur → l'écran de son équipe ; Directeur des opérations → Cockpit Opérations. Le menu dit « Visite médicale » (plus « Promotion médicale ») ; le rôle « Manager Promotion Médicale » et les adresses `/medical/*` sont inchangés.
2. KAM sur **ordinateur** : chercher un médecin (« Nom, spécialité, établissement, wilaya… »), « Commencer », « Enregistrer la visite » à vide → refus : produits, message et compte rendu **obligatoires** (« Pourquoi obligatoires »).
3. Remplir produit, message, compte rendu (« Ce que le médecin a dit, ses objections, ce qu'il attend. »), « Enregistrer la visite » → visite enregistrée, « Rapport fait ».
4. 📱 Délégué sur **téléphone**, **réseau coupé** : remplir et enregistrer → brouillon local (message hors ligne) ; réseau rétabli → le rapport part seul et apparaît côté serveur.
5. Superviseur : « Mon équipe » (« Plan », « Faites / planifiées », « Couverture H·A·B », « Produits · messages », « Dernier coaching », « Rapports en retard », « Tous les rapports »). Ouvrir le rapport du KAM, « Un mot au délégué (facultatif) » → « Marquer relu ». Phrase de garde : « Seul le superviseur de la BU de ce délégué, ou son N+1, marque ce rapport relu. »
6. `@ia-reelle` : le compte rendu « vertiges et chute de tension » est **priorisé** chez le superviseur comme possible cas de pharmacovigilance (détection ALLUMÉE en production ; exige une vraie clé IA).
7. `@attend-fusion:vmdelegue` : « Comptes rendus en retard · n », « Visites du jour · dans l'ordre de la tournée », « À rattraper si vous avez un creux », « + Visite hors plan » ; gestes « Fiche du médecin », « Itinéraire », « Reporter ou annuler (visite non tenue) », « Signaler un cas de pharmacovigilance » ; après détection « Possible PV — à déclarer » : « Déclarer un PV (prérempli) » ou « Ce n'est pas un cas » (tracé, visible du superviseur) ; « Mon sac », « Mes demandes », « Mes signalements de pharmacovigilance » ; pas de « demander un complément », PEC via National Sales, pas de nouveau type de note de frais.

### P09 — Pharmacovigilance
Banc : `09-pharmacovigilance.recette.ts` · **fusionné** (signalement, fiche du cas) + `@attend-fusion:pvdecl`.
1. Délégué : « Signaler un cas de pharmacovigilance » → « Produit concerné * », « Date de survenue * », « Hôpital / établissement * », « Médecin (facultatif) », « Gravité », « Sexe du patient », « Âge du patient », description (« L'événement observé, quand il est apparu après la prise… »), « Pièces jointes (photos, documents) ». Envoyer à vide → refus des champs *.
2. Remplir (Cardiolex, aujourd'hui, « CHU Mustapha » via « Autre établissement (saisir le nom) », gravité, description) → cas créé, **rattaché à la visite** ; Regulatory et pharmacien prévenus.
3. Responsable réglementaire : Regulatory › Pharmacovigilance → le cas, avec sa visite d'origine. Délégué → refus d'accès à la liste Regulatory.
4. `@attend-fusion:pvdecl` (pharmacien) : « À évaluer : gravité, caractère attendu, imputabilité. » ; « Connu le (jour zéro du délai) » + « Cas grave (jours calendaires) » / « Cas non grave (jours calendaires) » → échéance ; « Enregistrer la déclaration à l'autorité » (« Déclaré le », « Référence », « Pièce de la déclaration ») ; « Accusé de réception » ; « Visa du pharmacien responsable ».

### P10 — « Mon espace › Aujourd'hui » et échéances intégrées
Banc : `10-aujourdhui-echeances.recette.ts` · **fusionné** + `@attend-fusion:echeances`.
1. DG, assistante, KAM, Finances : « Mon espace » → « Bonjour <prénom> », « À faire · N » en trois groupes (« En retard » seul en rouge, « Aujourd'hui », « Plus tard » replié), une ligne = un titre + un sous-titre + **un** bouton ; à droite « Mes rappels », « Demander », et « Mon équipe » pour un N+1 ; congés à signer en panneau.
2. « Mes rappels » › « Ajouter » « Relancer l'imprimeur » → visible ; « Fait » → disparaît.
3. 📱 KAM : aucun débordement.
4. `@attend-fusion:echeances` : **aucune** page ni onglet « Échéancier » ; chaque échéance vit dans son module ET dans « À faire » (G50 avant le 20 chez les Finances, fin de contrat / période d'essai chez la RH, renouvellement d'enregistrement chez le Regulatory).

### P11 — Justificatif obligatoire
Banc : à écrire au contrôle final · `@attend-fusion:justif`.
1. Un ordre émis **sans pièce** (« Location véhicule séminaire », 75 000) naît « en attente de justificatif » : **absent** du centre de paiement **et** de la Banque.
2. L'émetteur (assistante) voit dans « Aujourd'hui » la ligne « Joindre le justificatif » ; il dépose la facture → l'ordre entre **seul** au centre (« Pièces » : facture ✓ ouvrable).
3. Chaque circuit exige sa pièce : paie (état de paie à l'envoi), caisse (bon de remise), information médicale (déclaration), PEC (facture obligatoire), Impôts (G50 / bordereau), BV (proforma / quittance).
4. Un ordre né sous la règle sans justificatif accepté ne se règle pas ; les ordres d'avant ne sont pas bloqués mais signalés au centre.

### P12 — Comptabilité et « Composer une facture »
Banc : à écrire au contrôle final · `@attend-fusion:compta`.
1. Comptable : « Comptabilité » → onglets « Dépenses · total », « Recettes · total », « Résultat » (par mois) ; pastilles des sociétés de la personne ; une ligne par écriture : date, « Payé à » / « Reçu de », objet, montant, compte, justificatif (✓ pièce / ✕ manquant), origine.
2. **Une seule recherche** : écritures de toute période ET factures du registre Legal ; « Facture non payée » → « Créer la demande de paiement » ou « Rattacher à un paiement fait ».
3. Panneau d'une écriture : aperçu de la pièce, « Chaîne » (demandé / autorisé / payé), budget imputé ; « Modifier l'écriture », « Contre-passer » (motif **obligatoire**, « Une écriture inverse de … sera créée. », « Confirmer la contre-passation »), « Joindre un justificatif », « Demander la pièce ».
4. « + Nouvelle écriture » de dépense **sans justificatif** → refus qui dit le remède.
5. « ⋯ » : « Enregistrer un encaissement », « Importer un relevé bancaire (CSV) » (aperçu ligne à ligne), « Contrôles du livre », comptes de trésorerie ; « Paiements sans justificatif ».
6. Finances : Comptabilité › Recettes → **« Composer une facture »** (même compositeur, format société / papier en-tête, Word + PDF) ; la facture émise s'enregistre au registre Legal (nature INVOICE) et au Drive, avec HT / TVA / TTC.
7. Legal ne propose plus « Facture » (seulement BC et devis).
Négatif : le comptable n'a jamais « Marquer payé ».

### P13 — Impôts & cotisations (G50) et TVA
Banc : à écrire au contrôle final · `@attend-fusion:impots`, `@attend-fusion:tva`, `@attend-fusion:campagne`.
1. Finances : Legal › factures → colonnes HT / TVA / TTC (taux 19 %, 9 %, 0 %) ; un total incohérent (HT + TVA + timbre ≠ TTC) est refusé ; filtre « TVA à compléter » (rien n'est inventé pour les anciennes factures).
2. « Impôts & cotisations » (`/finances/impots-cotisations`) → pastilles des sociétés ; « Échéances · <société> » par état ; « ⋯ » : « Calendrier des échéances », « Ajouter un paiement ponctuel ».
3. Préparer la **G50** du mois → « Décomposition du montant — ligne par ligne » : **TVA à payer = collectée − déductible**, CALCULÉE depuis les factures (« Très, très important ») ; « Comment la plateforme remplit ces montants » ; un montant modifié se trace (« Qui a fait quoi ») ; « Revenir au montant proposé ».
4. « Envoyer au centre de paiement » sans la G50 → refus (justificatif obligatoire) ; avec la G50 → au centre ; « Retirer la demande » tant que non décidée ; refus avec motif → « Corriger et renvoyer ».
5. Après paiement : « Joindre la quittance ».
6. Budget : enveloppe « Impôts & taxes » par société = **TVA nette + IBS** ; IRG et CNAS sont dans la **masse salariale** (affichés séparément).
7. Vocabulaire : aucune occurrence de « PCH », « exonération », « TAP », « CASNOS », « TFP » (décisions « FONT FOI »).

### P14 — Ad & Pro : liste, fiche, centre de validation Ad & Pro
Banc : `14-ad-pro.recette.ts` · fiche **fusionnée** ; `@attend-fusion:adprolist`, `@attend-fusion:ctradpro`.
1. Fiche simplifiée « Journées de cardiologie — CHU de Blida » : titre, « À vous : … » quand un geste attend la personne, « La demande », « Postes · n » ; 📱 tient à 390 px ; un délégué tiers n'a aucun geste.
2. `adprolist` : « Ad & Pro » + « Nouvelle demande », sans phrase ; pastilles d'état (« À vous » en tête) qui suivent la recherche ; pastilles de nature ; « Filtres » ; tableau : nature, objet en gras + référence, demandeur, date, montant à droite, état + chez qui + depuis quand, échéance ; tri par colonne ; 📱 une carte par demande.
3. `ctradpro` (DG) : « Centre de validation Ad & Pro » — file « À décider · n », fiche (la demande ou les lignes du BC, « Déjà validé », « Les postes », « Les devis reçus », « Devis, accordé, BC ») ; gestes « Valider le total » / « Viser le BC » / « Refuser » (« Confirmer le refus ») / « Demander une précision » ; « ⋯ » : « Déjà décidés · n » (« Réexaminer »), « Réglage des seuils » (demandes **1 000 000**, « Enregistrer ») ; l'étape « Direction des opérations » reste dans « Déjà validé » à tout montant.
Négatif : le Directeur des opérations ne vise pas au centre Ad & Pro.

### P15 — Départ d'un salarié
Banc : à écrire au contrôle final · `@attend-fusion:rhdepart`.
1. RH crée un salarié → son **compte utilisateur** naît automatiquement (carte « Compte » sur la fiche).
2. Fiche de « Sofiane Départ » › fin de contrat : « Dernier jour travaillé », « Motif », « Préavis (jours) », « Note pour les valideurs » ; « Enregistrer le brouillon » / « Envoyer en validation » ; rappel « Validation RH → supérieur hiérarchique → DG. »
3. Superviseur (N+1) valide ; DG valide (triple validation). « Annuler la fin de contrat… » possible tant que non close.
4. « Liste de sortie » : véhicule, matériel promotionnel, solde de tout compte (« À verser », « À retenir », « Enregistrer le solde »), certificat de travail (« Texte du certificat », « Civilité du signataire ») ; chaque ligne modifiable, « Ajouter ».
Négatif : le délégué n'ouvre pas la fiche RH.

### P16 — Enregistrement d'un produit, validité 5 ans
Banc : à écrire au contrôle final · `@attend-fusion:regenreg`.
1. Dossier « Tensiolex 10 mg » : « Joindre la décision » et « Joindre l'attestation de prix ».
2. Décision déposée → l'IA lit début et fin de validité ; sans fin : **fin = début + 5 ans** (début 01/01/2022 → fin 01/01/2027) ; « Confirmer ».
3. Alerte de renouvellement planifiée (et ligne dans « À faire » à l'approche, P10).
4. « Confirmer le prix » après l'attestation.

### P17 — Campagne budgétaire : recettes et dépenses
Banc : à écrire au contrôle final · `@attend-fusion:campagne`.
1. DG (ou Super Admin) : « Campagne budgétaire » → « Saisir une recette » (produit · client, montant HT, société) → la synthèse « Trésorerie — TVA à reverser » se met à jour (TVA nette = collectée − déductible).
2. « Taux et calendrier » : « IBS par défaut (%) », « IRG moyen (%) », « CNAS (%) » — « Taux préréglés — à confirmer par le cabinet » ; « Enregistrer les taux » ; IBS = résultat × taux.
3. Directeur des opérations : saisit les **dépenses** de son pôle ; « Saisir une recette » **absent**.

### P18 — Pouvoirs des directeurs et accès Super Admin seul
Banc : `18-pouvoirs-directeurs.recette.ts` · budget Opérations **fusionné** ; reste `@attend-fusion:directeurs`.
1. Directeur des opérations : « Budget Operations & Sales » → enveloppes « Masse salariale » (hors mission ; notes de frais KAM hors mission imputées automatiquement) et « Missions » ; la masse salariale montre net + primes, **IRG** et **CNAS** séparément.
2. ROI Ad & Pro, graphe d'influence, **Adventum Brain** (`/adventum-brain`), **Adam** (`/assistant`, `/adam/bureau`) : refus pour DG, Directeur des opérations, Direction Marketing ; ouverts au Super Admin.
3. Centre de paiement : plus de « Qui siège au centre de paiement » ; SA + DG uniquement.
4. Réallocation : le directeur « Réallouer » librement entre les lignes de **son** budget ; le **total** est intouchable ; le Super Admin est notifié, pas le DG ; pas de réallocation sur le budget d'un autre ; pas de sous-délégation à un adjoint.
5. Un directeur ne voit que **sa** société (RECETTE-PHG absente de ses pastilles), sauf DG et Super Admin.
6. Formations : toutes (réglementaires comprises) passent par l'autorisation du Directeur des opérations ; le DG n'est pas dans le circuit.
7. Historique des données IA conservé (pas de purge).

### P19 — Département Informatique et registre des avantages
Banc : à écrire au contrôle final · `@attend-fusion:informatique`, `@attend-fusion:avantages`.
1. Informatique : budget propre ; ligne « Intelligence artificielle » consommée chaque mois par le coût mesuré ; la facture du fournisseur réglée le mois venu **solde** le mesuré (pas de double consommation) ; « Abonnements », « Parc ».
2. Registre des avantages par médecin (Super Admin **seul**, clair et détaillé) : par médecin, chaque avantage, date, montant, demande d'origine, total par année. DG, Direction Marketing, KAM → refus.

### P20 — Charges fixes et natures (audit des dépenses, FONT FOI)
Banc : à écrire au contrôle final · `@attend-fusion:chargesfixes`, `@attend-fusion:natures`.
1. « Informations de la société » (ex-« Coordonnées des entités ») avec « Locaux & charges fixes ».
2. Budget de l'**Administration** : une enveloppe par société, tenue par les **Finances** ; les Moyens généraux y passent, par société ; chaque mois les Finances demandent le paiement des charges fixes.
3. Demande de paiement : champ « nature » **obligatoire** ; « Dons et mécénat » séparé du sponsoring ; « Emprunts » disponible (vide).
4. Retenues à la source (honoraires de médecins, prestataires étrangers) calculées au paiement, taux réglables.
5. Réserve pour imprévus par société, budgétée, libérable **uniquement** par le DG ou le Super Admin (Directeur des opérations → refus).
6. Facture « selon facture » : alerte au-delà de **+10 %**.

### P21 — Information médicale
Banc : `21-information-medicale.recette.ts` · **fusionné** (infomed).
1. Pharmacien : « Information médicale » → « Déclarations à faire », « BAT à contrôler », registre ; « Conformité ». 📱 pas de débordement.
2. Une demande Ad & Pro qui exige une déclaration arrive au Centre de validations : « Accepter : déclarer » / motif « Pas de déclaration nécessaire ».
Négatif : le KAM n'ouvre pas le module.

---

## 4. Parcours par rôle (ordre d'exécution recommandé)

Chaque rôle joue ses parcours dans cet ordre ; les numéros renvoient au §3. « Étapes » = étapes et contrôles qui le concernent.

| Rôle | Parcours (ordre) | Étapes (≈) |
|---|---|---|
| **Super Admin** | P00 · P01 (autoriser, refuser, ⋯ déjà décidés, 📱 décider) · P04 (remettre une somme, autoriser la remise) · P05 (visa éventuel) · P11 (centre) · P14 (fiche) · P17 (recettes) · P18 (seul à ouvrir Brain, Adam, ROI, graphe) · P19 (Informatique, registre des avantages) | 34 |
| **Directeur général** | P00 · P01 (siège ; ne décide pas son propre paiement) · P03 (accepter / refuser un BV) · P10 (Mon équipe) · P14 (centre Ad & Pro : valider le total, viser le BC, seuils) · P15 (3ᵉ validation du départ) · P17 (recettes) · P18 (refusé sur Brain / Adam) · P19 (refusé sur le registre) · P20 (libère la réserve) | 24 |
| **Directeur des opérations** | P00 · P01 (refusé au centre) · P08 (Cockpit) · P14 (ne vise pas au centre Ad & Pro) · P17 (dépenses, pas de recettes) · P18 (deux enveloppes, réallocation, total intouchable, sa seule société, formations, refusé sur Brain / Adam) · P20 (ne libère pas la réserve) | 21 |
| **Direction Marketing** | P00 · P05 (ajouter un professionnel, valider et lancer les achats, signer le BC, actualiser les prix) · P14 (liste Ad & Pro, 📱) · P18 (refusé sur Brain / Adam) · P19 (refusé sur le registre) | 18 |
| **Finances / Banque** | P00 · P01 (ne voit que l'autorisé) · P02 (solde, onglets, justificatif, échanges, reporter, payer, annulé, 📱) · P04 (payer la remise sans budget) · P05 (signature Finances du BC) · P10 (G50 dans À faire) · P11 · P12 (Composer une facture) · P13 (TVA, G50, quittance, budget Impôts & taxes) · P20 (charges fixes, retenues) | 33 |
| **Comptabilité** | P00 · P02 (refusé à la Banque) · P12 (onglets, recherche, panneau, contre-passer, dépense sans pièce refusée, pas de « Marquer payé ») | 10 |
| **Centre de paiement** (SA + DG) | P01 · P04 · P05 (paiement PEC) · P11 · P13 (G50) — voir Super Admin / DG | — |
| **Assistante / secrétariat** | P00 · P01 (demandeur : suit son ordre, notifié du refus) · P02 (répond aux Finances, 📱) · P04 (ne confirme pas la remise) · P05 (chiffrer, envoyer les montants, acheter, facture, demander le paiement) · P06 (Bureau, courrier, 📱) · P07 (Drive) · P10 (rappels) · P11 (joindre le justificatif) · P20 (nature obligatoire) | 32 |
| **RH** | P00 · P10 (échéances RH) · P11 (paie : état de paie exigé) · P15 (créer un salarié, fin de contrat, liste de sortie) | 10 |
| **Responsable réglementaire** | P00 · P03 (demander le BV, budget engagé, paiement fait, redemander après refus) · P09 (instruire le cas PV) · P16 (décision 5 ans, attestation de prix) | 15 |
| **Pharmacien information médicale** | P00 · P09 (évaluer, déclarer à l'autorité, visa) · P21 (son module, 📱) | 9 |
| **Délégué médical** | P00 (interdits) · P02, P03, P07, P14, P15, P21 (refus) · P06 (ne voit que ses demandes ; note de frais vers RH) · P08 (📱 hors ligne, brouillon, envoi) · P09 (signaler un cas) | 22 |
| **KAM** | P00 · P08 (aiguillage Ma journée, 3 champs obligatoires, rapport, interface VisiteDelegue) · P10 (📱) · P14 (📱 fiche) · P19 (refusé sur le registre) · P21 (refusé) | 16 |
| **Superviseur** | P00 · P08 (son équipe, rapports en retard, « Marquer relu », priorisation PV) · P15 (2ᵉ validation du départ) | 9 |
| **Caissier / moyens généraux** | P00 · P04 (📱 en attente ; « Confirmer la réception » ; « En caisse ») | 7 |

Total : **22 parcours** (P00–P21), **≈ 270 étapes et contrôles** dans le cahier (colonne « Étapes » : ordre de grandeur
par rôle). Le banc automatise les parcours des lots **fusionnés** : **57 tests** dans 14 fichiers, **120 étapes /
contrôles écrits** (davantage à l'exécution : P00 boucle sur les 15 comptes et leurs adresses interdites). Les parcours
`@attend-fusion` (P11, P12, P13, P15, P16, P17, P19, P20 et les parties en attente de P07, P08, P09, P10, P14, P18) ne
sont décrits QUE dans ce cahier : leurs scripts seront écrits au contrôle final, sur l'application fusionnée, à partir
des étapes ci-dessus (consigne de l'orchestrateur, 24/11). Décompte : `npx playwright test -c playwright.recette.config.ts --list`.

---

## 5. Rapport de recette attendu

`rapport.md` : synthèse (parcours fusionnés / en attente, réussis / échecs / non joués, étapes conformes), puis par
parcours et par test un tableau « # · Qui · appareil · Étape · Attendu · Obtenu · Capture ». Une étape qui échoue est
capturée AVANT l'arrêt ; un contrôle négatif raté n'arrête pas le parcours mais le fait finir en échec. L'orchestrateur
relit chaque échec, ouvre la capture, et classe : **régression** (lot fusionné), **sélecteur à ajuster** (libellé
conforme mais localisateur différent), **lot pas encore là** (`@attend-fusion`), **donnée manquante** (graine à compléter).

---

## 6. Points de vigilance relevés en écrivant la recette

1. **Impôts & taxes** : le lot `impots` (non fusionné) crée les lignes `IRG_SALAIRES`, `CNAS`, `AUTRES_TAXES` et des
   sous-natures CASNOS, TFP, taxe foncière, vignettes, TAP facultatif. La décision « Audit des dépenses — FONT FOI » dit :
   Impôts & taxes = **TVA + IBS** seulement ; IRG et CNAS dans la **masse salariale** ; ni CASNOS, ni TFP, ni TAP, ni taxe
   foncière, ni vignettes. P13 contrôle le vocabulaire ; à trancher avant fusion.
2. **TVA de la G50** : la maquette ImpotsCotisations dit « la plateforme n'enregistre ni la TVA collectée… elle ne peut pas la
   calculer » ; la décision ultérieure (et le lot `tva`) la **calcule** (collectée − déductible). La recette suit la décision.
3. **Centre de paiement** : `ROLES_CENTRE_DE_PAIEMENT` contient encore `DIRECTION` (PDG) et le siège nommé
   (`PaymentCentreSeat`, « Qui siège au centre de paiement ») existe toujours — la décision dit « Super Admin + DG
   uniquement, aucun siège » (lot `directeurs`). P01 / P18 le vérifieront après fusion.
4. **Coursier** : le rôle `COORDINATOR` garde le libellé « Coordination / Coursier » alors que les courses sont supprimées.
5. **Détection PV par l'IA** : non testable avec des clés factices ; le parcours est tagué `@ia-reelle` (fournir
   `ANTHROPIC_API_KEY` au lancement pour le jouer — appel facturé).
6. **Signature d'un BC** (P05) : contrôle renforcé (mot de passe + code de l'application à 6 chiffres) — geste **manuel**
   pendant la recette (`@manuel:signature-bc`), ou compte de test équipé d'un code TOTP connu.
7. **Machine de recette** : pendant l'écriture (24/11, 9 agents sur 4 CPU), `next dev` a compilé `/login` puis a été tué
   par le noyau (OOM du groupe mémoire, 6,1 Go) en compilant la première page applicative ; Turbopack refuse le projet
   (`globals.css`, paquets externes). Le banc a donc été validé **à blanc** : graine + décor de chaque parcours contre la
   base `amd_wt_recette` (deux défauts de décor trouvés et corrigés), rapporteur et captures produits, chaque test
   échouant proprement à la première navigation. Le contrôle final se joue avec `lancer.sh` (build de production) sur une
   machine libre ; prévoir d'ajuster des sélecteurs au premier passage.
