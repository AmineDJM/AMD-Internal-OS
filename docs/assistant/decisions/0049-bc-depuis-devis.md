# 0049 — « Crée un BC en PDF » depuis un devis : lecture fiable, flux sans friction, PDF rendu (lot B1, 02/11/2026)

> Construit sur la lecture des pièces commerciales (lot D2 : `lib/pieces-lues/service.ts`, une lecture par empreinte,
> en-têtes repérés par règles, contrôle en centimes), la fabrique de pièces (`platform/ia/artifact/factory`,
> `emettreDocumentDrive` : numérotation, papier de la société, .docx + PDF au Drive) et la réversibilité K10b
> ([0040](0040-reversibilite-communications.md) : une pièce numérotée est annulée, jamais effacée).

## Le constat de la Direction (02/11, « catastrophique »)

Pièce jointe « Devis matériel promotionnel INSIGNE.pdf ». « Crée un bc en pdf » → « Qui doit valider ce bon de
commande ? », un écart « 893 500 vs 794 500 », un fournisseur incertain, pas de PDF. « Crée-le et on verra plus tard qui
le valide » → refus (« ne peut pas être préparé sans validateur principal »). « moi » → « Au nom de quelle société ? » →
« adventum ». La carte : « Bon de commande — ADVENTUM PHARMA », **Fournisseur = ADVENTUM PHARMA** (c'est le client ;
l'émetteur est INSIGNE), des lignes manquantes (4-8, 11-13, 15, 18-20, 24-26), un bloc de trois lignes répété deux fois,
« ce nom provient du document… » ×3, « Contrôle des totaux » ×4, « Au-dessus du seuil de 0 DZD », l'enveloppe
« Regulatory » pour du matériel promotionnel, et un bouton « Créer la demande de validation » — pas de PDF.

## Les causes (mesurées sur un devis INSIGNE fabriqué fidèlement)

1. **Fournisseur inversé.** Le bloc client d'un devis (« Client : / ADVENTUM PHARMA / NIF : … / RC : … ») porte des
   étiquettes NIF et RC ; la lecture des étiquettes (`emetteur.ts`) n'écartait que la ligne qui commence par « Client » :
   elle prenait le NIF et le RC du CLIENT pour ceux de l'émetteur. Comme l'annuaire contient Adventum Pharma (un client,
   avec ce NIF), le rapprochement par NIF devenait « certain » → fournisseur = Adventum. Le nom venait du modèle, qui avait
   lu au même endroit.
2. **Lignes dupliquées et manquantes.** Le texte « à plat » d'un PDF met chaque CELLULE du tableau sur sa propre ligne
   (« 2 / Conception ADV / 1 / 145 000,00 / 145 000,00 »), l'en-tête des colonnes et le pied de page de l'émetteur se
   répètent à chaque page : le modèle qui recopiait ce texte a perdu des lignes et répété un bloc. Rien ne comparait la
   somme des lignes au HT imprimé avant de composer, sinon une phrase vague ; rien ne suivait la numérotation.
3. **Friction.** Le validateur était exigé pour CRÉER le BC (le geste créait le BC ET la demande de validation) ; la
   société n'était pas déduite du devis ; l'enveloppe était « la plus récente que vous voyez », quelle que soit la nature.
4. **Carte illisible.** Chaque doute du contrôle devenait un avertissement, le seuil était dit même à 0, la provenance
   répétée.

## L'architecture — ce que le CODE garantit (exigence de la Direction, 02/11 : « c'est l'architecture qui ne va pas »)

Aucune correction de B1 ne repose sur la consigne du modèle. Trois composants, chacun testé seul :

```
 fichier ──▶ (1) PIPELINE DE LECTURE (lib/pieces-lues, hors du modèle conversationnel)
              extraction : positions mupdf → tableau │ sinon modèle texte │ sinon VISION (schéma JSON strict)
              normalisation : émetteur / destinataire par règles (bloc client, pied de page, NIF/RC, groupe, annuaire),
                              dédoublonnage par numéro, numérotation
              validation par INVARIANTS (verdict.ts) :
                 I1 quantité × PU = montant de chaque ligne   I2 numérotation continue
                 I3 Σ lignes = HT imprimé (au dinar)          I4 émetteur nommé ET hors du groupe destinataire
                 (+ taxes recalculées depuis les lignes, comparées une fois au papier : controle.ts)
              VERDICT explicite FIABLE / A_VERIFIER (lignes NOMMÉES) / ILLISIBLE,
              gardé avec la lecture (LecturePiece.verdict, verdictDetail ; structure remplacée par une lecture qui réconcilie)
         ──▶ objet VALIDÉ (DevisLu) — le modèle conversationnel ne lit JAMAIS les lignes : il reçoit cet objet
         ──▶ (2) RÈGLES DE DÉRIVATION (domaine/operations/bc-devis.ts, pures) : société = destinataire du devis,
              enveloppe = natureDeLaCommande → choisirEnveloppe, fournisseur = émetteur ; le serveur répond `manque`
              avec LA seule question qui bloque — le modèle ne fait que la poser
         ──▶ (3) CYCLE DU BC (etatBCDevis / refusTransitionBC, pures ; vérifiées par l'opération à la proposition ET à l'exécution)
              (lu) ─CREER─▶ BROUILLON (numéroté, PDF au Drive, pré-validation, sans demande)
              BROUILLON ─ENVOYER_EN_VALIDATION─▶ EN_VALIDATION ─▶ VALIDE ─▶ SIGNE   (circuit existant des BC)
              * ─ANNULER (K10b)─▶ ANNULE (numéro consommé, fichiers gardés ; rétablissable)
              CREER n'exige PAS de validateur (exige : lecture non ILLISIBLE, fournisseur hors groupe) ;
              ENVOYER_EN_VALIDATION exige un BROUILLON et un validateur.
```

Garanti par le code : le fournisseur n'est jamais une société du groupe (`estDuGroupe` avant tout retenu, filtrage de
l'annuaire, I4, refus de la transition CREER) ; une ligne répétée n'est pas comptée deux fois ; un numéro absent est dit ;
un tableau qui ne réconcilie pas n'est pas présenté comme fiable ; une lecture faite n'est pas refaite (empreinte,
structure et verdict gardés ; vision jamais rappelée pour la même lecture) ; le brouillon naît sans validateur et ne part
en validation qu'avec un. Migration additive : `20270220950000_lecture_piece_verdict` (`LecturePiece.verdict`,
`verdictDetail`).

## Ce qui est décidé

### 1. Lire le tableau par ses positions, avant tout modèle (`pieces-lues/positions.ts`, `tableau.ts`)

- mupdf rend chaque caractère avec sa position : regroupés par ligne de base (rangées), coupés en cellules aux écarts de
  colonne (`rangeesDesGlyphes`). Lu comme un humain : l'en-tête « Désignation / Qté / P.U. / Montant » fixe les colonnes ;
  une ligne = une rangée qui commence par son numéro et porte ses chiffres ; une rangée de texte seul juste dessous = la
  suite de la désignation ; titres de section, en-têtes répétés, « À reporter / Report », sous-totaux et totaux ne sont
  JAMAIS des lignes ; « 5.000 » dans une colonne de dinars = 5 000.
- **Dédoublonnage** par numéro (`consolider`) : une ligne imprimée deux fois à l'identique n'en fait qu'une (compté) ;
  un même numéro à deux contenus reste, douteux et nommé. **Numérotation suivie** : les numéros absents sont des lignes
  non lues (« lignes 4 à 8 et 11 à 13 non lues »). Chaque ligne se **recoupe** (quantité × prix = montant).
- **Réconciliation** (`reconcilier`) : la somme des lignes doit faire le HT imprimé. Juste (lignes recoupées, aucun trou,
  somme = HT) → c'est CETTE lecture qui fait les lignes (`methodeLignes: "positions"`) — locale, gratuite, valable même
  pour une pièce confidentielle — et le modèle n'est pas appelé. Elle remplace une structure gardée qui ne réconciliait
  pas (« la première fait foi » vaut entre lectures d'égale valeur).

### 2. Seconde passe : la vision (`pieces-lues/vision-lignes.ts`)

Quand le tableau ne peut pas se lire par positions (un scan) ou que la lecture ne réconcilie pas, chaque page est rendue
en image et le modèle de vision (Luna) recopie le tableau dans un **schéma JSON strict** (numéro, désignation, quantité,
PU, montant — chaque nombre EN TEXTE, lu par `montants.ts`), puis les mêmes règles (dédoublonnage, numérotation,
recoupement). La meilleure lecture (score : juste d'abord, puis trous, lignes douteuses, écart) est gardée
(`structureePar: "vision:<modèle>"`, jamais rappelée pour la même lecture). Mêmes portes que la lecture par le modèle
(interrupteur, bascule « lecture des pièces », clé) ; jamais pour une pièce confidentielle. Si l'écart persiste, la carte
dit **en une phrase** l'écart et les lignes douteuses NOMMÉES (`phraseReconciliation`) — jamais « une ligne est mal lue ».

### 3. L'émetteur est le fournisseur ; le client est la société du groupe (`pieces-lues/emetteur-destinataire.ts`)

- Le **bloc client** (« Client », « Doit », « Facturé à », « À l'attention de »… et ses six lignes suivantes, jusqu'à une
  ligne vide ou une autre rubrique) n'est jamais lu comme l'émetteur — ni son nom, ni son NIF, ni son RC (`zoneDuClient`,
  appliquée aussi à `identiteEmetteurDuTexte`).
- Le nom de l'émetteur : la raison sociale étiquetée, le **pied de page** « NOM — RC … — NIF … », l'en-tête en capitales,
  le modèle, le **nom du fichier** (« Devis … INSIGNE.pdf ») — le premier qui n'est PAS une société du groupe (nom d'usage,
  libellé court, dénomination légale) ; le nom du fichier confirme un candidat de l'en-tête. Ses NIF / RC / NIS / AI : hors
  du bloc client et hors des identifiants du groupe ; le RC est rendu tel qu'imprimé.
- Le **destinataire** : la société du groupe que le papier nomme (bloc client d'abord) — par NIF, puis RC, puis nom.
- L'annuaire se cherche par le nom et les identifiants DE L'ÉMETTEUR, sans les fiches qui sont des sociétés du groupe ;
  absent, la carte propose de **créer sa fiche** (avec SON NIF / RC), faite à la confirmation si la personne a le droit
  d'écrire l'annuaire des partenaires (`creer_fiche: false` pour s'en passer).

### 4. Le flux : « Crée un BC en PDF » → une carte, un geste, un PDF

- `preparer_bc_depuis_devis` compose avec ce que l'ERP **sait** : la société = le client du devis (demandée seulement si
  le papier n'en nomme aucune et que la personne en a plusieurs), le **validateur n'est plus demandé** (« plus tard » est
  une réponse), l'**enveloppe** est proposée selon la NATURE de la commande (`natureDeLaCommande` : matériel promotionnel →
  enveloppe promo / marketing — module `PROMO_MATERIAL`, pôle MARKETING — jamais une enveloppe Regulatory ou Opérations ;
  événement → EVENTS / congrès ; rien qui couvre la nature → rien n'est proposé), changeable (`enveloppe`). Une seule
  question à la fois, et seulement si elle bloque : un chiffre illisible, une TVA que le papier n'imprime pas, un
  fournisseur que rien ne nomme.
- Le geste principal est **« Créer le BC (PDF) »** : la fabrique émet le BC (numéroté selon la règle des pièces, papier
  en-tête de la société, mentions, lignes, totaux, référence du devis), en **pré-validation** — c'est le brouillon : aucun
  centre ne le prend, aucune demande n'existe — avec son .docx et son **PDF au Drive** (« Bons de commande émis ») ; le
  lien du PDF revient dans la conversation (« Ouvrir le PDF »). Le devis lu, l'enveloppe et le validateur déjà nommé sont
  gardés sur la pièce (`custom.bcAssistant`).
- **« Envoyer en validation »** est un geste séparé (`envoyer_bc_en_validation`) : c'est LÀ que le validateur se demande ;
  la demande joint le devis ; le circuit (centre puis Finances) n'est dit que si un seuil est réglé — « au-dessus du seuil
  de 0 DZD » ne se dit plus.
- **Réversible** (K10b) : annuler « Créer le BC (PDF) » passe la pièce à ANNULÉE — numéro consommé, fichiers au Drive
  comme trace — par le journal des effets des cartes ; rétablir lui rend son statut.

### 4 bis. Qui y a accès (audit Q1, 02/11)

Les trois opérations de BC (`preparer_bon_de_commande`, `preparer_bc_depuis_devis`, `envoyer_bc_en_validation`) ne sont
plus dans la famille IA « Ad & Pro » : un BC se crée aussi aux Finances et au Legal, et la famille exigée en plus fermait
l'outil à qui peut le faire à l'écran. La porte est celle du geste (`ouverte` : VALIDATIONS + droit de créer un BC),
la famille celle des écritures. La lecture des lignes d'un PDF à couche texte ne dépend plus de la bascule « lecture des
pièces par l'IA » (positions, locales) ; un scan, si.

### 4 ter. Le BC dicté, et l'enveloppe nommée (audit Q1, rejeu du 02/11)

- **BC sans pièce** (`composer_bon_de_commande`, `infra/operations/bc-compose.ts`) : « fais un BC à l'Imprimerie Atlas :
  500 kakémonos à 2 000 DZD » ne demande plus de fichier. Les lignes sont celles DICTÉES (rien n'est complété : une
  quantité ou un prix manquant se demande), le fournisseur celui de l'annuaire ou son seul nom (dit sur la carte), la
  TVA 19 % par défaut, affichée. Même geste et même cycle : « Créer le BC (PDF) » → brouillon + PDF, sans validateur.
  `preparer_bon_de_commande` reste le chemin d'un BC qui existe DÉJÀ en fichier.
- **Enveloppe nommée invisible** (`enveloppeDuBC`) : « imputé au budget Marketing » par quelqu'un qui ne lit pas les
  Budgets ne bloque plus la carte — l'enveloppe est gardée telle que dite, « à confirmer à la validation »
  (`custom.bcAssistant.enveloppe` sans identifiant, note de la pièce).

### 5. La carte : un résumé, le détail au panneau, chaque chose dite une fois

Résumé : fournisseur (NIF, annuaire ou fiche créée), société (« client du devis »), devis, nombre de lignes, HT, TVA et
taxe, TTC, enveloppe proposée, validateur (« à désigner à l'envoi en validation »). Le **détail des lignes** s'ouvre dans
le panneau latéral (un champ de plus de quatre lignes y va, `separerChampsLongs`). Avertissements sans redite
(`sansRedite`) : la provenance UNE fois (« Lignes et montants lus sur le tableau du PDF, à vérifier contre le papier »),
l'écart en une phrase avec les lignes nommées, les **taxes recalculées depuis les lignes et comparées une fois** au
papier (`phraseTaxes` : rien quand elles concordent), un dépassement d'enveloppe seulement s'il existe.

## Mesures (banc)

- Banc fabriqué (`lib/pieces-lues/banc/devis-fabriques.ts`) : INSIGNE (27 lignes, 3 blocs, 3 pages, 794 500 HT, TVA 19 %,
  taxe publicitaire 2 %), une imprimerie (milliers à points), une agence événementielle (34 lignes, 3 pages, reports), un
  fournisseur d'objets (colonnes Réf. / Unité, désignations sur deux lignes), un **scan** image.
- Lecture par positions : **76/76 lignes justes** sur les quatre PDF texte, totaux HT / TVA / taxe / TTC justes, émetteur
  et destinataire justes, **0 appel modèle**. Vision réelle (`gpt-5.6-luna`, 2 appels) : **scan 5/5** (4,6 s), **INSIGNE
  27/27** (10,8 s) — `scripts/banc-b1-devis.ts` (`B1_VISION=1`).
- Scénario de la Direction contre la vraie base (`bc-devis-direction.test.ts`) : le modèle rendant la lecture fautive du
  02/11 et l'annuaire contenant Adventum avec son NIF → fournisseur INSIGNE, société Adventum (client du devis), 27 lignes
  justes, 794 500 HT / 961 345 TTC, enveloppe Marketing (pas Regulatory), un seul avertissement, **aucune question** ;
  « Créer le BC (PDF) » → BC numéroté en brouillon, PDF au Drive, fiche INSIGNE créée avec SON NIF ; annulé → ANNULÉ.
- Playwright, serveur de production (`e2e/bc-devis.spec.ts`, décor `scripts/e2e/carte-bc-devis.ts` : vrai PDF au Drive,
  carte préparée par l'outil réel sans validateur ni société), bureau 1440 px et iPhone 13 : carte « Bon de commande —
  INSIGNE → Adventum Pharma », lecture « fiable », 27 lignes au panneau, aucun « seuil », aucune « Regulatory » ;
  « Créer le BC (PDF) » → « BC 040/DG/2026 créé en brouillon sur le papier de Adventum Pharma (961 345 DZD TTC) — PDF
  déposé au Drive », « Ouvrir le PDF » sert `application/pdf`, barre « Annuler » ; aucun défilement horizontal. 2/2.
- Suite complète (`npm test`) : 16 901 tests ; les 11 échecs de la passe parallèle (dont 2 cliquets et 1 test de lecture
  promo rattrapés par ce lot) repassent tous isolément ; `build:render` sur `.next` vide : OK.

Code : `src/lib/pieces-lues/{positions,tableau,tableau-piece,emetteur-destinataire,vision-lignes}.ts`, `service.ts`
(étages positions → modèle → vision), `src/modules/assistant-ia/infra/operations/{devis-lu,bc-depuis-devis}.ts`,
`src/modules/assistant-ia/domaine/operations/bc-devis.ts`, `ecrans/action-confirmation-card.tsx` (panneau du détail,
« Ouvrir le PDF »), `src/lib/pieces-lues/verdict.ts`.
