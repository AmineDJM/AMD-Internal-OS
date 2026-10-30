# 0030 — Formulaires générés depuis le contrat, dépôt de dossier, gros volumes (lot J11, 30/10/2026)

**Lot J11 du plan Jarvis** (architecture validée : <https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7>). Il s'appuie sur J1
(la Bibliothèque, [0014](0014-bibliotheque.md)), sur le glisser-déposer ([0015](0015-glisser-deposer.md)) et sur le registre
des capacités de J6 ([0020](0020-capacites.md)).

> Code : socle `src/platform/ia/capacites/schema.ts` (le schéma sorti du registre, pur), `formulaire.ts` (le formulaire) ;
> module `src/modules/assistant-ia/` — `ecrans/formulaire-carte.tsx`, `ecrans/action-confirmation-card.tsx`,
> `infra/capacites.ts` (`carteDe`, `corrigerCarteCapacite`, `chercherReferenceDeCarte`), `actions.ts` ;
> `domaine/lecture/depot-dossier.ts`, `infra/depot-dossier.ts`, `ecrans/depot-dossier.tsx`, route
> `app/api/assistant-ia/depot-dossier/` ; `domaine/ctd.ts`, `infra/lecture-dossier.ts` (`lire_dossier_depose`) ;
> Bibliothèque : `infra/ingestion.ts` (budget, parallélisme), `infra/recherche.ts` (`fichesDeDossier`) ;
> `lib/cibles/resoudre-entrees.ts` (`candidatsDuChamp`) ; `lib/scheduled.ts`. Migration additive
> `20270215140000_assistant_ia_depot_dossier` (une table). Banc : `npm run bench:dossier`.

## 1. La carte de confirmation est un FORMULAIRE généré depuis le contrat

Avant J11, la carte d'une capacité R1–R4 **montrait** ce que l'assistant avait rempli : signer ou ignorer. Désormais chaque
champ du **contrat** de l'action (`contrat.genere.json`, via la fiche du registre) devient un champ de formulaire :

| Contrat | Champ rendu |
|---|---|
| `texte` (valeurs admises) | liste de choix |
| `texte` (nom d'un texte long : description, motif, notes…) | zone de plusieurs lignes |
| `texte` | ligne |
| `nombre` | champ décimal (« 12 500,5 » accepté) |
| `date` | sélecteur de date (AAAA-MM-JJ) |
| `booleen` | case |
| `reference` + modèle | **sélecteur** : le serveur ne propose que les fiches que la personne VOIT (`candidatsDuChamp` : l'annuaire pour une personne, `resoudreCible` sous `porteeEntite` pour le reste), et seulement pour un champ de SA carte |
| `reference` sans modèle | identifiant saisi (l'action le rejuge) |
| `liste` + modèle / valeurs / libre | sélecteur multiple / cases / une valeur par ligne |

- **La proposition pré-remplie et surlignée** (« Proposé ») ; une valeur changée par la personne passe « Corrigé » ; une
  référence garde le **nom** résolu, jamais l'identifiant nu. Le bouton dit « Signer » ou « Signer avec mes corrections ».
- **Une seule validation, de bout en bout** : `zodDe` (le schéma zod du registre J6, celui que l'adaptateur applique au
  modèle), rejoué dans l'onglet (`verifierFormulaire`, messages en français reliés au champ) **et** au serveur.
- **La correction repasse par les portes de la proposition** (`corrigerCarteCapacite`, appelée par
  `confirmerIntentionAssistantIA(intentId, ressaisie, corrections)` AVANT la confirmation ordinaire) : champs du contrat
  seuls, schéma zod, familles de la console (un champ de rémunération exige « Salaires & paie »), noms résolus sous la
  portée de la personne, `validerEntree`. La carte est **réécrite** (charge, résumé, événement `CORRECTED` avec les champs
  changés) seulement si elle est encore `PROPOSED` ; puis `executerIntention` l'exécute comme toute carte (arrêt d'urgence,
  porte, famille relue, action elle-même sous la session). **Une carte renforcée se ressaisit sur la valeur corrigée** (un
  montant changé se relit changé) : la carte et le serveur calculent la ressaisie par la même règle (`texteARessaisir`).
- **Accessibilité et mobile** (mêmes règles que le reste) : `label` relié, `aria-required`, `aria-invalid`, erreur reliée
  par `aria-describedby`, combobox au clavier (↑ ↓ Entrée Échap, `aria-activedescendant`), focus sur le premier champ
  fautif ; une colonne sur téléphone, champs de 44 px, texte à 16 px (pas de zoom forcé), `role="alert"` sur l'erreur.
- **Critère tenu — 0 écart de schéma** : `modules/assistant-ia/formulaires.test.ts` génère le formulaire de **chacune des
  1 157 capacités R1–R4** (960 appelables), vérifie qu'il porte exactement les champs du contrat (nom, type, obligation,
  valeurs, modèle) et le même schéma JSON, le remplit comme une personne et le valide par `zodDe`, rejoue la proposition
  sans correction (entrée identique, rien de « corrigé »), et vérifie que vide il nomme exactement les champs obligatoires.
  `formulaire-carte.test.ts` (vraie base) : corrigée puis signée, la tâche créée porte la correction ; une correction hors
  schéma n'exécute rien ; le sélecteur refuse un autre compte et un champ qui n'est pas une référence ; la ressaisie
  renforcée tient.
- Le schéma (`libelleChamp`, `schemaDe`, `zodDe`) est **sorti du registre** dans `capacites/schema.ts` (zod + lexique) :
  l'onglet le charge sans le registre ; `registre.ts` le réexporte. Le socle n'importe rien de neuf de l'ERP.

## 2. Bibliothèque complète — les dossiers glissés recréent leur arborescence

- **Un dossier glissé RECRÉE son arborescence** dans le Drive **personnel** : une racine au nom du dossier (« Congrès
  Oran », « (2) » si le nom est pris ; plusieurs dossiers mêlés → « Dépôt du 30-10-2026 21h50 »), ses sous-dossiers
  (`creerArborescenceDrive`, la même boucle que le Drive et la messagerie), **une pièce par fichier** dans SON dossier, par
  le dépôt ordinaire du Drive (droits, quotas, chiffrement) — donc par `inscrireFichierDrive` → `inscrirePiece` : chaque
  fichier entre à la Bibliothèque et dans sa file d'ingestion. Vaut aussi pour un petit dossier (≤ 10 pièces, en puces).
- **Le mode « dépôt de dossier »** : au-delà de **10 pièces** (la borne d'un message, inchangée) un DOSSIER devient **une
  puce** (« Dossier « X » — 300 fichiers · 1,2 Go »). Plus de limite de 10 : une **borne réglable**
  (`ASSISTANT_DEPOT_DOSSIER_FICHIERS`, défaut **1 000** fichiers ; `ASSISTANT_DEPOT_DOSSIER_MO`, défaut **2 Go**) ; le
  parcours d'un dossier va jusqu'à la borne (+ la marge des sous-dossiers). Des fichiers en vrac au-delà de 10 restent
  refusés un à un. Chaque fichier écarté est nommé avec sa raison (vide, doublon, borne).
- **Rien ne part avant Entrée** (décision 0015) : à l'envoi, `POST /api/assistant-ia/depot-dossier` (chemins et tailles
  seulement) ouvre le lot — table `AssistantIaDepotDossier` : racine, fichiers et octets annoncés, empreinte de la liste,
  statut — et rend la carte « chemin → dossier ». Les octets partent par le **gestionnaire d'envois de l'application** (le
  même que l'import de dossier du Drive : six en parallèle, retentes, **envoi direct au stockage par morceaux** au-delà du
  seuil — parties signées de 32 Mo (`S3_DIRECT_PART_MB`), **reprise des seules parties manquantes** —, contenu déjà connu non retransféré) ; la
  pastille d'envoi suit la personne dans toute l'application. Le message part aussitôt avec la ligne « Dossier déposé : … ».
- **Reprise si coupure** : la même liste redéposée (même **empreinte** FNV-1a des chemins et tailles) retrouve son lot ;
  le serveur rend ce qui est **déjà dans le Drive** (même chemin, même taille, sous la racine) et seuls les absents
  repartent. Un gros fichier coupé reprend ses parties (sessions `DirectUpload`).
- **Le lot suivi** (`GET /api/assistant-ia/depot-dossier`, bandeau `SuiviDepots` au-dessus de la saisie, interrogé toutes
  les 4 s tant qu'il n'est pas fini) : **n fichiers, arrivés, lus, sans texte, échoués, en file** — le Drive dit ce qui est
  arrivé (parcours récursif sous la racine), la Bibliothèque ce qui est lu (fiche portant la clé `DRIVE_NODE:<id>`, index
  GIN). Barre de progression accessible, lien vers le dossier du Drive.

## 3. Gros volumes — 300 fichiers en ≤ 15 min sur le worker

La tâche `bibliotheque.ingestion` prenait **10 fiches par battement** (60 s) : 300 fichiers = 30 battements = 30 min. Elle
**vide désormais la file dans un budget** (`traiterFile({ budgetMs, parallele })` : lot après lot tant qu'il reste des
fiches dues et du temps) avec **deux lecteurs en même temps** — réglables : `BIBLIOTHEQUE_BUDGET_S` (défaut 45 s, sous le
bail de 2 min et avant le battement suivant), `BIBLIOTHEQUE_PARALLELE` (défaut 2, plafond 6 : un OCR tient de la mémoire).
Sans budget, `traiterFile` garde son comportement d'avant (un lot).

**Mesure** (`npm run bench:dossier`, base locale `amd_bench`, embedder FAUX déterministe — aucun réseau, aucun coût ;
conteneur 4 vCPU) : 300 fichiers **uniques** déposés par les vraies portes (lot, `putBlob`, `enregistrerFichierDrive`) —
120 PDF texte (1 à 4 pages), 90 Word, 60 images (OCR local), 30 scans PDF sans couche texte (OCR local) :

| Configuration | Dépôt (lot + 300 pièces inscrites) | Lecture complète (calcul) | Passages de 45 s | Projection worker (battement 60 s) | Résultat |
|---|---|---|---|---|---|
| 4 vCPU, 2 lecteurs (défaut) | 7,5 s | **111 s** | 3 (47,6 + 48,6 + 14,3 s) | **≈ 2,2 min** | 300 lus, 0 échec : 120 PDF texte, 90 Word, 60 images OCR, 30 scans OCR ; 559 passages |
| 1 vCPU (`taskset -c 0`), 1 lecteur | 7 s | **69 s** | 2 (46,1 + 22,7 s) | **≈ 1,4 min** | idem |
| Avant J11 (10 fiches par battement) | — | — | 30 | ≈ 30 min | — |

L'OCR local passe par UN moteur Tesseract par processus : deux lecteurs recouvrent surtout les entrées-sorties (blob,
base) ; sur un cœur, un lecteur suffit (`BIBLIOTHEQUE_PARALLELE=1` sur un worker de 512 Mo). L'écart entre les deux lignes
est celui du moteur partagé et du bruit du conteneur, pas une règle.

**Projection** : sur le worker, un passage part à chaque battement ; le calcul ci-dessus se répartit en passages de 45 s.
Le coût dominant est l'**OCR local** (images, scans) ; le texte natif (PDF, Word) et le découpage sont négligeables, les
vecteurs sont calculés par lots de 100 (le vrai `text-embedding-3-small` répond en ~0,5–1 s par lot : ≈ 4 lots pour 300
fichiers, < 10 s ajoutées). Sur un worker Render d'un demi-vCPU (offre Starter), compter le double du temps « 1 vCPU » : **≈ 2,5 à 4,5 min**
pour ce dossier, vecteurs réels compris — **la cible de 15 min est tenue avec une marge de 3 à 6**. Ce qui la ferait
dépasser : un dossier presque entièrement SCANNÉ et long (300 scans de 10 pages = 3 000 pages d'OCR, ≈ 0,4 s la page ici) —
le suivi le montre alors « en file », sans rien perdre.

## 4. L'Assistant IA répond sur le dossier déposé — sans relire les fichiers

`lire_dossier_depose` (lecture, famille « Drive & documents ») : « classe ces 300 fichiers par module CTD », « quelles pièces
manquent », « où en est la lecture ». Une passe : les fichiers sous la racine du lot, puis leurs **fiches de la
Bibliothèque en lot** (`fichesDeDossier` : titre, nature, état, début du premier passage — mêmes droits que
`ouvrirDocuments`, coffre et confidentiel **sans texte**). Le **classement CTD** est fait par règles (`domaine/ctd.ts`,
ICH M4 + exigences d'un générique à l'ANPP) : un numéro de section écrit dans le chemin (« 3.2.P.5 », « 32p5 »,
« Module 3 ») désigne la section (le plus profond gagne ; un dosage « 2.5 mg » n'en est pas un) ; sinon les mots (français
et anglais) pèsent, trois fois plus dans le chemin que dans le texte lu, la substance active et le produit fini départagés
par leurs indices ; sous le seuil, « non classé » — **dit**, jamais rangé au hasard. Les **pièces manquantes** sont les
sections attendues d'un générique sans aucune pièce. Sortie bornée (25 chemins par section). Aucun fichier relu, aucun appel
de modèle par fichier : 300 fichiers se classent en **≈ 0,1 s**. Règle du contexte : « un DOSSIER déposé → `lire_dossier_depose`,
jamais `lire_document` fichier par fichier » ; noms et chemins encadrés comme contenu tiers.

Mesure : 35 gabarits de dossier (numéros, noms seuls, scans muets au texte parlant, dosages, images muettes) déclinés en
300 fichiers → **≥ 95 % bien rangés** (`domaine/ctd.test.ts`) ; un dossier sans stabilité du produit fini → « 3.2.P.8 »
nommé manquant.

## 5. Ce qui n'a pas changé — sécurité

Droits du Drive à chaque fichier (le dépôt ordinaire), droits de la Bibliothèque à chaque fiche, coffre et confidentiel
jamais au modèle, carte confirmée par la personne pour toute écriture, aucun relèvement de cliquet : frontières des modules
(la route `app/api/assistant-ia/depot-dossier` porte les imports du Drive ; le module reçoit l'arborescence par un **port**),
`SOCLE_IA_CEILING`, frontière client/serveur (le formulaire et les règles du dépôt sont purs).

## 6. Limites connues

- Le classement CTD est une **aide à la relecture**, pas un avis réglementaire — l'outil le dit. Les sections attendues sont
  celles d'un générique ; un dossier de nouveau principe actif (modules 4 et 5 complets) n'est pas encore modélisé.
- Le sélecteur ne cherche que les objets dont le registre déclare la portée de lecture (comme la résolution d'un nom) ;
  ailleurs, l'identifiant se saisit.
- La reprise après fermeture de l'onglet exige de **redéposer** le dossier (le navigateur ne garde pas les fichiers) : seuls
  les absents repartent.
- Un formulaire corrigé puis non signé n'est pas gardé : au rechargement, la carte revient à la proposition.
- Compatible J7 (simulation, autre session) : la carte générée accueille son diff ; rien du chemin de confirmation n'est
  propre au formulaire hors `corrections`.
