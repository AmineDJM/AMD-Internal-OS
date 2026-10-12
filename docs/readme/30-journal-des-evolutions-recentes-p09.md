### BC et factures — titre centré, bleu canard, premier numéro, taxes, Excel, aperçu (2026-10)

Ajustements de la Direction sur les bons de commande et les factures (§118.203) :

- **Titre** « BON DE COMMANDE » (« DEVIS » pour un devis), centré, en gras, à l'accent, sous l'en-tête et avant « B.C : N° … ».
- **Bleu canard** `#087084` (R 8, V 112, B 132) à la place du rouge : accent par défaut du Word, du PDF et du classeur Excel.
  La charte tranche *marque > bleu canard* ; **la pastille de la société** (`Company.color`, une couleur d'écran) **ne colore plus
  aucune pièce**. Une pièce déjà émise garde sa couleur (un document émis ne se repeint pas) ; une **révision** repeint l'accent
  d'après la charte du jour. Un accent rouge réglé dans **Administration › Marque** l'emporte encore : il se change là.
- **Premier numéro de la série** : Legal › Composer un bon de commande › Numérotation › « Premier numéro de 2026 » (par nature et par
  année). C'est un **plancher** : le numéro attribué vaut `max(dernier + 1, départ)`, le compteur ne recule jamais, une autre année
  repart à 001. La migration `20270105090000` pose 32 pour 2026 sur les profils dont le motif des BC porte `/DG/` (le BC
  `032/DG/2026` est donc le premier) ; une société sans motif règle motif et premier numéro ensemble.
- **Taxes supplémentaires** : une ligne « libellé + taux » toujours visible (composeur, génération et modification du BC d'un
  dossier promotionnel) ; « Taxe Pub 2 % » en un clic ; calculée sur le HT, **hors base de TVA**.
- **Aperçu avant impression** : le PDF à blanc dans la page, avec le numéro prévu — aucun numéro consommé, rien d'écrit.
- **Générer sur Excel** : la pièce rendue en classeur à formules vivantes (fiche Legal, résultat du composeur, ligne du BC d'un
  dossier promotionnel) ; comparé au centime au calcul du Word, non livré s'il s'en écarte ; même porte que le Word. La somme en
  lettres est un texte arrêté à l'émission (le classeur le dit).
- **Devis déposés → devis de la plateforme** : déjà en place (lecture par Luna, tableau par devis, validation d'un devis entier ou de
  lignes de plusieurs devis, génération des BC d'après ce qui est validé, BC modifiable en natif, révisions). Un scan par
  « Retranscrire un devis ».

**Regulatory — la « CTD initiale » (§118.213)** : à la création d'un dossier, un champ facultatif « CTD initiale » prend un
**.zip complet ou un dossier entier** (arborescence conservée) ; il part, **une fois le dossier créé**, vers l'**étape 1** du
processus (« Réception du CTD complet ») par le gestionnaire d'envois d'arrière-plan (dépôt direct au bucket pour les gros
fichiers, « Réessayer » dans la pastille en cas d'échec) sans retenir la création. Sur la fiche, l'étape 1 porte un bloc bien visible
**« CTD initiale »** (même importance que « Réserves & réponses (ANPP) ») : contenu en dossiers dépliables, un .zip se parcourt
sans être téléchargé, **ajouter** des fichiers ou un dossier dans un sous-dossier choisi (existant ou nouveau), **remplacer** la CTD,
**supprimer** la CTD (aperçu + double confirmation), **renommer** un dossier. Remplacer et supprimer mettent la CTD à la
**corbeille** d'un bloc (type `REGULATORY_CTD`, fichiers conservés) : le Super Admin la restaure depuis Administration › Corbeille,
sauf si une autre CTD vit déjà sur le dossier. Une CTD est **reconnue par un fait** — pièce du dossier, étape 1, catégorie « CTD
complet » (`lib/regulatory/ctd-initiale.ts`) —, donc les dossiers d'avant en ont déjà une. Droits : ceux du dépôt de documents du
dossier (`canAccessEntity` UPLOAD, portée de ligne, gamme, verrou) ; retirer, remplacer et renommer exigent en plus de pouvoir
**modifier** le dossier. Un dépôt « CTD complet » sur l'étape 1 qui ne vient pas du bloc est refusé, avec le geste qui existe.

---


### Matériel promotionnel — « Commandes » : une ligne par BC, un bouton, clôture automatique (2026-10)

Étape 4 de la maquette validée (« Commande, livraison, paiement ») : la carte « Bons de commande, réception, factures » devient
**« Commandes »**, pleine largeur ; la carte « Visa / déclaration » disparaît (sa colonne entre dans le tableau). Une ligne par BC :
Fournisseur (figé, avec les articles commandés) · BC (NNN/DG/AAAA, le PDF) · TTC · Livraison · Facture · Paiement · Visa /
déclaration IM, chaque état en une pastille, et **un seul bouton** — le prochain geste de qui regarde : « Joindre la facture »,
« J'ai reçu » (la réception se coche sur les lignes de la facture, ce qui entre au stock), « Demander le paiement ». Le reste
(aperçu, fichiers, envoi, modification, suppression, détail, renoncement, rattrapage du visa) reste dans « ⋯ ». Total en pied.
La demande de visa / déclaration part avec chaque paiement (formalité proposée : celle de la demande précédente du dossier).
**Clôture automatique** (`lib/promo-cloture.ts`) : quand chaque BC est signé, entièrement facturé, reçu, réglé et visé, le dossier
passe « terminé » — au règlement de l'ordre (`settleExpenseOrder`) ou au rattrapage du visa ; mêmes vérifications que
`completePromoTrack` (extraites, inchangées) ; « Clore le dossier » reste offert aux pilotes en repli. Règles pures :
`promo-material/fiche.ts` (`pastillesDeLaCommande`, `gesteDeLaCommande`, `totalDesCommandes`, `commandesSoldees`,
`formaliteDuDossier`), testées dans `commandes.test.ts`.

---


### Éditeur Office — « Tester l'éditeur Office » et aperçu de secours (2026-10)

**Administration › carte « Éditeur Office (OnlyOffice) »** (Super Admin, sous « Stockage objet », ancre `#editeur-office`) :
« Tester l'éditeur Office » (`onlyoffice-diagnostic-actions:testerEditeurOffice`, lecture seule) rend ✓ / ⚠ / ✗ + correctif pour
les variables (`ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET` — « défini, N caractères », jamais la valeur —, `APP_URL` ou son repli),
la forme des adresses (https, barre finale, adresse interne), `/healthcheck` et `api.js` vus de notre serveur (DNS, refus,
certificat, délai, 502/503 « endormi » distingués), la même adresse en https si elle est en http, `{APP_URL}/api/onlyoffice/file`
(401 attendu), puis le chargement d'`api.js` **dans le navigateur** (contenu mixte, réseau interne). Interprétation pure :
`lib/onlyoffice-diagnostic.ts` (testée). **Écran d'édition** : quand l'éditeur ne se charge pas, une ligne « Éditeur indisponible
— aperçu en lecture seule » (Réessayer, Télécharger, Diagnostiquer pour le Super Admin) au-dessus de l'aperçu du navigateur
(Word, Excel, PowerPoint, PDF, texte) ; un document neuf jamais enregistré dit « Document vierge » (`estDocumentVierge`).
**Correctif** : `/api/onlyoffice/file` et `/callback` étaient derrière la connexion (middleware) — le Document Server, sans
session, recevait `/login` ; ils sont exemptés (chemins exacts, jeton signé vérifié par chaque route).

---