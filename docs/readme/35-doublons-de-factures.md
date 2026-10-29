## Factures — « pas deux factures » : blocage des doublons, relance unifiée, recensement (Direction, 14/10/2026)

> « S'il y a une facture déjà identique, déjà en paiement, on bloque : on dit que cette facture existe déjà et qu'elle est
> en cours de traitement, et on propose UNIQUEMENT de la relancer. […] C'est Luna qui s'en occupe. Pas de double source
> de vérité, pas deux factures. »

### L'identité d'une facture — la lecture vient de Luna, la comparaison du code

`src/lib/factures/identite.ts` (module pur). Une facture se décrit par : les **empreintes** SHA-256 de ses fichiers
(le format de `FileBlob.sha256`) ; le **fournisseur** (NIF, RC, raison sociale normalisée par `cleSociete`) ; le
**numéro** normalisé (`cleNumero` : groupes lettres/chiffres, zéros de tête retirés) ; la **date** ; le **TTC** ; la
**nature** (facture, pro forma, avoir, acompte). Garde-fous, rien d'inventé :

- le numéro repéré sur le papier ; celui du modèle seulement s'il est imprimé **sur une ligne de numéro**
  (`imprimeCommeNumero` — « 145 » pris dans « 145 000,00 » est écarté) ;
- le NIF étiqueté de l'émetteur, sinon l'unique NIF repéré hors du groupe (le client n'est jamais l'émetteur), sinon
  celui du modèle s'il est imprimé ;
- le TTC imprimé (« Total TTC », « Net à payer ») ; celui du modèle seulement en dinars, pas inférieur au HT, et avec
  une TVA corroborée par le papier (`tvaCorroboree`) — une TVA hallucinée ou un TTC égal au HT sous TVA sont écartés ;
- la nature lue au **titre** de la pièce (« Facture proforma N° … », « Avoir N° … », « Facture d'acompte … ») — « suivant
  facture proforma », « acompte versé » plus bas ne changent rien ;
- un champ SAISI dans un formulaire (n° de facture, bénéficiaire) ne fait jamais un CERTAIN.

`comparerFactures` (déterministe, symétrique) :

| Niveau | Règle | Effet |
|---|---|---|
| **CERTAIN** | même fichier ; ou même fournisseur (NIF › RC › nom) + même numéro, **lus** des deux côtés, même nature, TTC et date non contradictoires | **bloque** le dépôt |
| **PROBABLE** | même numéro mais un doute (NIF à un caractère près, saisie, nature inconnue, TTC/date contradictoires) ; ou, sans numéro, même fournisseur + même TTC + même date | passe, **avertissement** + marque « doublon possible » |
| **AUCUN** | natures différentes (pro forma / facture finale, avoir), deux acomptes sans numéro commun, même numéro chez deux fournisseurs | — |

Le banc `src/lib/factures/identite.banc.test.ts` rejoue les pièges réels avec des sorties de Luna simulées (papier
rescanné, photo floue, numéro inventé, pro forma, avoir, acomptes, même n° chez deux fournisseurs, NIF mal lu, TVA
hallucinée, TTC pris pour HT) et exige **zéro faux CERTAIN** sur toutes les paires.

### Les maisons de factures — une seule lecture

`src/lib/factures/connues.ts` · `chargerFacturesConnues()` lit, en lot : le **registre** (`LegalDocument` INVOICE non
annulés — Ad & Pro, Legal, Budget Marketing ; le premier fichier est la facture, les suivants ses annexes), les pièces
« Facture » des **demandes de paiement** vivantes (ni brouillon, ni retirée, ni refusée ; non remplacées), et les
**fichiers** « Facture » des dossiers qui paient (`MAISONS_FICHIER` : ordre de dépense, demande au secrétariat, poste,
demande de paiement). L'identité d'une facture déjà déposée est sa **lecture gardée** par empreinte (`LecturePiece` —
aucun rappel de Luna), complétée par la saisie. Chaque facture porte son paiement (ordre de dépense, sinon demande),
son état (`etatDuPaiement` : centre / Finances / demandeur / payée / close / hors paiement) et ses **clés d'instance**
(la facture d'un poste et sa copie dans le dossier compagnon de son ordre sont la même facture, pas un doublon).

### Les portes de dépôt — refus AVANT toute écriture

`verifierFacturesAvantDepot(user, fichiers, { instances })` : le même fichier d'abord (sans lecture), puis la lecture
par Luna (`proposerLecture`, gardée par empreinte) et la comparaison à toutes les maisons, **hors du dossier où l'on
dépose**. Une panne de la garde ne bloque jamais un dépôt. Portes couvertes :

- demandes de paiement : `createPaymentRequest` (pièces « Facture »), `addPaymentPiece` ;
- Ad & Pro : `deposerFactureSurPoste` (dépôt de la facture d'un poste à BC, et facture jointe à la demande de paiement),
  facture facultative d'un sponsoring direct / prise en charge (`demanderPaiementPoste`), facture de consommation
  Budget Marketing (`consommerDepensePoste`) ;
- registre Legal : `createLegalDocument` (facture reçue), `createInvoice`, et l'ajout du premier fichier d'une facture
  (`/api/documents/upload`, qui garde aussi les fichiers « Facture » posés sur un dossier qui paie) ;
- secrétariat : la facture jointe à « Terminer » (`joindreFactureALaDemande`).

**CERTAIN** → refus ; la phrase est construite par le code (`factures/blocage-vue.ts`) : « Cette facture existe déjà
(n° …, fournisseur, montant) — elle est en cours de traitement — au centre de paiement / chez les Finances » (ou « déjà
payée »). Le dossier n'est nommé (titre, montant, lien, chef du département) qu'à qui y a accès (`canAccessEntity`) ;
sinon « Elle est dans un dossier <module> ». Un seul geste : **Relancer** (un clic, commentaire facultatif), avec un
jeton signé (`factures/jeton-relance.ts`) qui ouvre la relance à la personne arrêtée, pour ce paiement-là, 24 h.
**PROBABLE** → le dépôt passe, l'avertissement s'affiche, la marque « doublon possible » (référence de l'autre pièce)
est posée sur la pièce du registre / l'ordre (`custom.doublonPossible`) et dans le fil de la demande
(`DOUBLON_POSSIBLE`) ; le centre de paiement et « Banque & paiements » la lisent (`marquesDesOrdres`).

### La relance unifiée

`relancerPaiement` (`src/modules/finances/actions-relances.ts`) — cible : une demande de paiement OU un ordre de
dépense. Règle pure `finance/relance-paiement.ts` : rien à relancer sur un paiement payé, clos ou pas encore demandé ; le
demandeur ne se relance pas quand le dossier lui est renvoyé ; une relance par heure et par personne (le délai de
`canNudge`, extrait en `refusDelaiDeCourtoisie`). Ouverte au demandeur, à la vue globale, et à la personne bloquée
(jeton). Trace : événement `NUDGE` dans le fil du dossier (qui, pourquoi, commentaire), message au centre quand c'est
lui qui a la main. Destinataires = **qui a la main** (`payments/relance-destinataires.ts`, partagé avec
`nudgePaymentRequest`) : le centre (PDG, Super Admin, sièges nommés) tant qu'il n'a pas autorisé, les Finances ensuite,
le demandeur quand le dossier lui est renvoyé ; le demandeur est informé quand un tiers relance. Boutons : poste Ad & Pro
(case Paiement, `PaiementDemande`), dossier de paiement (le panneau existant), message de blocage.

### Le recensement unique des doublons existants

`src/lib/factures/recensement.ts` · `recenserDoublonsFactures()` groupe toutes les factures connues
(`groupesDeDoublons` : CERTAINS puis PROBABLES). **Lecture seule**, sans appel à Luna, sans lire les écritures du livre.

- Script : `npm run factures:doublons` (`-- --json`) — une connexion unique mise en `READ ONLY` avant toute requête.
- Écran : **Finances › Doublons de factures** (`/finances/doublons-factures`, droit Finances VIEW) — pièces, modules,
  montants, états de paiement, liens (seulement vers ce que la personne peut ouvrir). Colonne « à examiner / examiné »
  sans migration : `marquerExamenDoublon` écrit au journal d'audit (module « Finances — doublons de factures »), réservé
  à Finances UPDATE. Rien n'est corrigé ici : chaque pièce se corrige dans son module.

### Fichiers clés

`src/lib/factures/{identite,connues,blocage-vue,jeton-relance,recensement}.ts`, `src/modules/finances/domaine/relance-paiement.ts`,
`src/modules/finances/infra/relance-destinataires.ts`, `src/lib/actions/{relance-paiement,doublons-factures}-actions.ts`,
`src/components/factures/facture-deja-connue.tsx`, `src/app/(app)/finances/doublons-factures/`,
`scripts/recenser-doublons-factures.ts`. Tests : `identite.banc.test.ts`, `doublons-factures-flow.test.ts`,
`finance/relance-paiement.test.ts`.
