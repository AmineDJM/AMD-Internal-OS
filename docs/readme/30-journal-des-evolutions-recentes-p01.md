## 🧾 Journal des évolutions récentes

### K7 : L'ASSISTANT FAIT CE QUE FONT LES ÉCRANS — EXPORTS DE L'ERP, ENVOI D'UN FICHIER À UN COLLÈGUE (2026-10-31)

Lot K7 — `docs/assistant/decisions/0037-exports-et-gestes-d-ecran.md`. Constat de la Direction : « Envoie à Amine
Djouamai l'Excel du suivi Regulatory » → « je ne peux pas ». Les exports étaient des ROUTES, invisibles pour l'assistant.
**Chaque export** (14 : suivi Regulatory, budgets, pilotage, appel d'offres PCH, segmentation, demande de stocks,
inscrits, étude de marché et sa présentation, coaching, annuaire, PDF du plan de tournée) est une fonction de la façade
`src/lib/exports/`, appelée par la route de l'écran ET par l'outil `exporter_*` de l'assistant (même portée, mêmes
droits, même audit). Le fichier va au Drive de la personne (« Exports ») et revient en bloc fichier + lien de
téléchargement ; **`send_message` joint une pièce** (carte à confirmer ; la messagerie rejuge le droit de partager).
La consigne ne dit plus « je ne peux pas » sans avoir cherché, ni sans nommer l'écran. **Inventaire** des 132 routes
(`modules/assistant-ia/gestes-ecran.test.ts`) : une route nouvelle non classée fait échouer `npm test`. Banc réel
(`scripts/bench/k7-exports.ts`, `amd_bench`) : le scénario de la Direction de bout en bout en 11 s, 0,023 $.
### K2 : L'ASSISTANT IA GÉNÈRE DES IMAGES ET DES VIDÉOS DE DONNÉES — DANS LA RÉPONSE, AU DRIVE, TÉLÉCHARGEABLES (2026-10-31)

Lot K2 — `docs/assistant/decisions/0032-visuels.md`. Quatre outils dans l'Assistant IA de l'ERP et l'app Adventum IA :
**générer une image** (`gpt-image-2.5-sunburst`, charte Adventum et logo officiel sur demande), **modifier une image**
(pièce jointe ou Drive), **vidéo de données** (graphique animé de 8 s, sous-titré en français, chiffres EXIGÉS dans les
données lues par les outils — jamais ceux du modèle ; rendu sharp + ffmpeg, sur le worker en production), **vidéo
générée** (pipeline en arrière-plan prêt, mais **Sora est arrêté chez le fournisseur depuis le 24/09/2026** : l'outil le
vérifie et refuse sans rien facturer). Chaque visuel s'affiche dans la réponse (plein écran au toucher, lecteur natif
iPhone), va au Drive (« Visuels de l'assistant ») et se télécharge ; une vidéo affiche une carte « en cours » qui se met à
jour, la conversation continue, une notification part à la fin. **Gouvernance** : Administration › IA (interrupteurs,
plafonds mensuels, modèles, durée max), coût réel journalisé, famille « Images & vidéos générées » de la console des accès,
fermée par défaut. Coût mesuré : **0,0135 $ l'image** (medium 1024²) ; une vidéo de données ne coûte aucun appel de modèle.

### JARVIS INTÉGRÉ : LE TEST RÉEL UNIQUE DE FIN, ET LES DEUX DÉFAUTS QU'IL A TROUVÉS (2026-10-31)

Tous les lots Jarvis (J0 → J14, conversions, « Mes notes », app Adventum IA) sont sur `claude/hopeful-goodall-phd0nb`.
Un seul passage réel (API OpenAI, base de banc locale `amd_bench`, ≈ 1,4 $) :

- **Banc programmé** (J5) : 24/30 — Atelier PowerPoint et Word conformes ; Bibliothèque 2 000 pièces, p95 64 ms, rappel@10
  100 %, 0 hors droits ; un travail long jusqu'au livrable. Jarvis 20/26 : les six écarts lus un à un ne sont pas des
  défauts (précision demandée sur l'entité, motif exact absent d'une réponse juste, notes `.txt` hors de l'Atelier).
- **Simulation (J7)** : carte avec effets, rien en base avant confirmation, annulation 2/2 — 0,013 $.
- **Conversions** : 20/20 avec les modèles tesseract « best » ET l'OCR vision ; **sans l'OCR vision, les quatre scans
  arabes échouent** (1,3 → 58 %) — il est coupé par défaut : **Administration › IA** pour l'activer (plafond mensuel).
- **Voix** : `gpt-live-1` ouvre la session par `ouvrirSessionLive` (réponse SDP reçue).

Deux défauts corrigés (`platform/ia/travaux/outil.ts`, `infra/travaux.ts`) : les objets d'une étape (`lots`,
`pourChaque`, `attente`, `demande`, `si`) déclarent leurs propriétés — le modèle ne pouvait écrire que `{}` et chaque
plan par lots était refusé ; et **un tour, un plan** : un nouvel appel à `lancer_un_travail` dans le même tour remplace
le plan encore en attente (cinq plans pour une seule demande au banc). Tests : `outil.test.ts`,
`travaux-un-plan-par-tour.test.ts`. Le banc des recettes sème son circuit par le moteur (`getDefinition`) — sa copie
simplifiée devenait, en CI, le circuit des tests Ad & Pro voisins.

### J11 : LA CARTE SE CORRIGE AVANT DE SE SIGNER — ET UN DOSSIER DE 300 FICHIERS SE DÉPOSE, SE LIT ET SE CLASSE (2026-10-30)

Lot J11 — `docs/assistant/decisions/0030-formulaires-dossiers.md`. **La carte de confirmation de toute action de l'ERP**
(R1 → R4) est désormais un **formulaire généré depuis le contrat** de l'action : chaque champ selon son type (liste de choix,
date, nombre, case, texte long), les **références** vers d'autres fiches choisies dans un sélecteur qui ne propose que ce
que la personne voit, les valeurs proposées par l'assistant pré-remplies et surlignées. La personne **corrige, puis signe** :
la correction repasse par les mêmes contrôles que la proposition (schéma du registre, familles, droits), et une carte
renforcée se ressaisit sur la valeur corrigée. Banc : les 1 157 capacités R1–R4, **0 écart de schéma**.
**Un dossier glissé dans l'Assistant IA recrée son arborescence** dans le Drive de la personne (dossier nommé,
sous-dossiers, une pièce de la Bibliothèque par fichier) ; au-delà de 10 fichiers, il passe en **mode « dépôt de dossier »**
(une puce, jusqu'à 1 000 fichiers et 2 Go — bornes réglables), téléversé en arrière-plan par le gestionnaire d'envois
(envoi direct par morceaux, **reprise** : redéposer ne renvoie que ce qui manque), suivi sous la conversation (fichiers, lus,
échoués, en file). La Bibliothèque **vide sa file dans un budget** (deux lecteurs) : **300 fichiers** (PDF, Word, images,
scans) **lus en ≈ 2 min** sur le banc local. L'assistant **classe le dossier par module CTD** et nomme les **pièces
manquantes** à partir de ce que la Bibliothèque a déjà lu — sans relire les fichiers (`lire_dossier_depose`). Migration
additive `20270215140000_assistant_ia_depot_dossier`.

### OCR VISION DES CONVERSIONS — LES SCANS ARABES VOCALISÉS SOUS 1 % (2026-10-30)

Une page scannée que tesseract lit mal (arabe vocalisé, scan dégradé) est transcrite par le modèle de vision de
l'Assistant IA, au nom du demandeur, puis vérifiée contre tesseract — **jamais** pour une pièce confidentielle, du coffre,
d'un dossier RH ou un contrat (la lecture locale reste, et l'écran dit pourquoi). Réglage Super Admin (coupé par défaut) et
plafond mensuel en dollars : **Administration › IA**. Banc : scans vocalisés 13,6 / 58,1 / 25,7 % → 0,20 / 0,40 / 0,00 % ;
un passage réel 0,060 $. Aller-retour Word vocalisé (LibreOffice 7.4) : 2,0 → 0,40 % (Naskh). Décision
[0019](../assistant/decisions/0019-conversions-haute-fidelite.md) ; migration `20270215130000_ocr_vision`.

### CONVERSIONS HAUTE FIDÉLITÉ SUR LE WORKER, ET LE WORKER « CLIQUEZ SYNC, C'EST TOUT » (2026-10-30)

« Pas de limitations ; c'est notre différenciation. » **PDF → Word** garde désormais images (nombre et taille), tableaux,
colonnes, en-têtes et pieds (dans les vraies zones, numéro de page en champ), listes, polices/tailles/gras/couleurs, et
rend l'**arabe** juste : ordre logique retrouvé par la géométrie, `w:bidi`/`w:rtl`/`w:cs`, chiffres et mélange arabe-français,
aucune forme de présentation, aucun U+FFFD, aucun mojibake ; les **pages scannées** passent par l'OCR (tesseract ara+fra+eng
« best », deux passages) et sont recomposées (tableaux depuis les traits, illustrations découpées) — l'image est gardée si
la lecture est trop incertaine. Plus : PDF → Excel, image → PDF/Word, PowerPoint → images ; Office → PDF avec polices arabes
et Carlito/Caladea. Le moteur (`scripts/conversions/`, pdf2docx + PyMuPDF corrigés) vit dans l'image du worker ; le web ne
convertit jamais quand le worker bat. Banc `npm run conversions:bench` dans l'image : CER 0–0,26 % sur les PDF numériques
(FR, AR, mixte, deux colonnes, Chromium), 0,59 % sur le scan français, **2,95 % sur le scan arabe vocalisé** (limite de
tesseract, dite) ; 100 % des images, 0 caractère interdit, 100 % des paragraphes arabes en RTL. **Render** : *Sync* crée le
worker, lui relie ses variables (`fromService`) et il travaille (`TACHES_DE_FOND=les-deux` partout) ; il contrôle ses
variables et son moteur au démarrage et l'écrit — journal et **Administration › Diagnostic › Worker et conversions**.
Décision [0019](../assistant/decisions/0019-conversions-haute-fidelite.md) ; migration `20270215120000_controle_worker`.

### J6 : L'ASSISTANT IA PEUT AGIR PARTOUT DANS L'ERP — LE REGISTRE DES CAPACITÉS (2026-10-30)

Lot J6 — `docs/assistant/decisions/0020-capacites.md`. Chaque action serveur de l'ERP (1 206, lues sur leur source) devient une
**capacité** de l'Assistant IA, sans une ligne déclarée à la main : son schéma, sa famille de la console, son niveau de risque
(R0 lecture → R4 argent, droits, signature, suppression), sa simulabilité (préparée pour J7) et son annulation. L'assistant
**trouve** les 3 à 8 utiles parmi toutes celles que l'écran ouvre à la personne (96 % de rappel dans les 5 premières sur 300
demandes, moins de 4 000 jetons d'outils par étape), les **exécute par l'action elle-même** sous la vraie session — une lecture
directement, une écriture par la carte de confirmation, renforcée (ressaisie) pour l'argent, les décisions, les suppressions
et les effets externes. Il **n'emprunte plus rien à Adam** : la frontière Assistant IA → Adam est à zéro — **sans rien perdre** :
les 123 gestes qu'Adam lui prêtait ont chacun leur équivalent (inventaire généré et rejoué par un test) ; changer l'échéance,
la priorité ou le responsable d'une tâche est désormais une action d'écran (`modifierTache`).

### J10 : LES RECETTES — « COMMENT ON FAIT ÇA CHEZ NOUS ? », TIRÉ DES DOSSIERS RÉELS, VALIDÉ PAR LE RESPONSABLE (2026-10-30)

Une **recette** décrit un circuit réel : étapes dans l'ordre, qui valide, pièces habituelles, seuils (« la DG signe au-delà
d'environ 1,2 M DZD (observé) »), durée médiane, pièges (renvois répétés, étape la plus lente). Elle est **proposée** par
l'extraction (tâche quotidienne `recettes.extraction`, jamais sous le seuil d'occurrences : 5 dossiers clos acceptés par défaut),
puis **validée, corrigée (nouvelle version), rejetée ou retirée** par le responsable du processus que la Direction désigne dans
l'écran `/recettes`. L'Assistant IA ne sert que la version validée (`recette_pour`) : il propose le plan tiré de la recette en
disant « selon la recette … validée par X le … », et signale les écarts (seuil franchi, délai court, plan retouché). Statistiques :
utilisations et taux de plans acceptés sans retouche. Une recette ne se montre qu'à qui voit l'écran du circuit ; elle ne porte ni
dossier, ni nom, ni montant d'un dossier. Banc : 12/12 recettes justes sur le corpus semé, 13/14 plans acceptés sans retouche
(93 %), zéro recette servie avant validation, zéro hors droits. Décision [0028](../assistant/decisions/0028-recettes.md) ;
migration `20270211090000_recettes`.


### ADVENTUM IA : L'APP DE L'ASSISTANT IA — PLUSIEURS CONVERSATIONS, MÉMOIRE COMMUNE, PRIVÉE, DOSSIERS, VOCAUX, SON PROPRE SITE (2026-10-30)

La maquette validée par la Direction devient une app : **`/ia`**, et son propre site **adventum-ia.onrender.com** (service
Render `adventum-ia`, créé par « Sync », même dépôt et même build, `APP_MODE=adventum-ia`). Le MÊME assistant que l'ERP
(outils, droits, console, repères, travaux sur le worker). **Plusieurs conversations par personne** (le fil unique devient
la première — migration additive `20270215160000_adventum_ia_conversations`) : titre proposé par le modèle rapide, renommer,
épingler, rechercher (titres et contenu), archiver, supprimer, groupées par date ; l'écran `/assistant` de l'ERP a la même
liste. **Mémoire commune** + recherche dans ses conversations passées (`chercher_conversations`), « Mémoire mise à jour ».
**Conversation privée** : choisie avant le premier message, verrouillée ensuite, sans mémoire, supprimée à 30 jours.
**Dossiers** (consignes + documents de référence, droits relus à chaque tour). **Vocaux** : réécoute avant envoi ; file hors
ligne. Voix en direct `gpt-live-1` : celle de J13, dans la conversation ouverte. Bloc-notes : point d'accroche, en attente du lot Notes. Thème
« bleu pharma » clair/sombre dans un seul fichier ; PWA iPhone (manifeste, icônes, écran de démarrage, Web Push qui ouvre la
bonne conversation) ; déconnexion à distance de ses appareils. Décision [0027](../assistant/decisions/0027-adventum-ia.md).
### J9 : LE GRAPHE DE L'ENTREPRISE ET LES FAITS DATÉS — « QU'EST-CE QUI DÉPEND DE CE FOURNISSEUR ? » (2026-10-30)

L'Assistant IA suit désormais les **relations** de l'entreprise : `explorer_relations` (« qu'est-ce qui dépend de Saidal ? »,
« qui a travaillé sur ce dossier ? », « quels documents parlent du sofosbuvir ? »), `etat_a_une_date` (la valeur d'alors,
jamais celle d'aujourd'hui ; et ce qu'on en savait à une autre date) et `d_ou_vient` (pièce, extraction, qui a confirmé,
ce qui a été remplacé). Module `graphe-entreprise` : une vue sur les fiches canoniques et les liens déjà écrits, sans second
registre ; les droits jugent chaque nœud AVANT le parcours ; une famille fermée retire ses types. La résolution lit l'arabe
(« مجمع صيدال » = Groupe Saidal), les fautes, les sigles et les NIF/RC. Un fait périmé se ferme (`fermeLe`, `fermeParId`,
`remplaceParId`), il n'est jamais écrasé ; chaque chiffre rendu porte sa source. Banc : résolution 101/101 sur un corpus
semé, 239/239 chiffres sourcés, p95 ≈ 120 ms sur 50 000 arêtes, zéro résultat hors droits par rôle. Décision
[0021](../assistant/decisions/0021-graphe.md) ; migration `20270210090000_graphe_faits_dates`.
### « MES NOTES » — UN BLOC-NOTES PRIVÉ DANS L'ASSISTANT IA, QUE L'IA NE MODIFIE QU'AVEC L'ACCORD DE LA PERSONNE (2026-10-30)

Une icône bloc-notes en haut de la conversation ouvre « Mes notes » (plein écran sur téléphone) : des **pages** que chacun
crée, nomme et réordonne ; texte, titres, puces, cases à cocher, listes imbriquées, raccourcis « - » / « [] » / « # », glisser
une ligne ; enregistrement automatique, historique des versions, corbeille de 30 jours. **Privé** : personne d'autre ne les
voit, Super Admin compris (« Vue exacte » refusée). L'assistant lit les notes quand la question s'y rapporte et **propose**
d'ajouter, modifier, cocher, déplacer, supprimer une ligne ou de créer / renommer une page : la proposition s'affiche
**surlignée** dans la page et sur une carte de la conversation — Accepter / Refuser / Tout accepter, puis Annuler ; **rien
n'est écrit avant l'acceptation** (décision de la Direction). Un montant de paie noté reste en repère vers le modèle.
Décision [0026](../assistant/decisions/0026-notes.md) ; migration `20270215150000_assistant_ia_notes`.

### J7 : SIMULATION, JOURNAL DES EFFETS, ANNULATION HONNÊTE (2026-10-30)

Lot J7 — `docs/assistant/decisions/0029-simulation-annulation.md` ; migration additive `20270215170000_journal_des_effets`.
- **La carte montre ce qui sera écrit** : une capacité R1–R4 simulable est jouée pour de vrai dans une transaction
  annulée, et la carte dit « 3 champs modifiés sur la demande X, 1 notification à Karim, 1 pièce déposée » — courriel,
  poussée, stockage, site et webhooks neutralisés (0 effet sorti, un test par port). 92,5 % des capacités R1–R2 se simulent.
- **Rien ne s'exécute qui ne ressemble plus à la carte** : la simulation est rejouée à la confirmation, son empreinte
  comparée ; un écart, et la carte se remontre avec le nouveau diff.
- **Journal des effets** : chaque geste de l'assistant (carte, étape de travail, mandat) garde la valeur AVANT de ce qu'il
  touche (durée de garde réglable à la console).
- **« Ce que l'assistant a fait »** (`/assistant/gestes`) : « Annuler » défait ce qui est encore tel que l'assistant l'a
  laissé, compense ce qui se compense, dit ce qui est impossible et pourquoi — jamais d'écrasement du travail d'un autre
  (50 cas réels justes, 0 écrasement).

### J8 : LES TRAVAUX POUR TOUS, SUITE — DÉLÉGATION, ATTENTES MÉTIER, ÉQUIPE, LIVRABLES AU DRIVE (2026-10-30)

Lot J8 — `docs/assistant/decisions/0023-delegation.md` ; migration additive `20270214100000_travaux_delegation`.
- **« Demander à »** : un travail dépose une demande précise (question, pièces attendues, échéance, pièces partagées en
  lecture) chez un collègue — notification et carte dans **son** Assistant IA ; il répond avec ses pièces ou décline ;
  le travail reprend. Relance, escalade au responsable, abandon. Il ne voit jamais le carnet de l'autre.
- **Attentes métier** sur les 34 types de faits (prédicat), relance et escalade ; **reprise mesurée** après l'événement :
  médiane 7,5 s, p95 10 s (boucle courte des réveils, 10 s).
- **Plusieurs travaux par personne** avec priorités ; **vue « Mon équipe »** pour un responsable si la console l'autorise
  (défaut : non), chaque consultation à l'audit.
- **Livrables = vrais documents** (Word, PDF, Excel) déposés dans le Drive de la personne et inscrits à la Bibliothèque.
- **Robustesse** : un travail de 3 semaines traverse 10 arrêts brutaux (`SIGKILL`) de vrais processus sans doublon ;
  web + worker simultanés : un seul exécute.

### J3 : L'ATELIER — LES DOCUMENTS À CÔTÉ DE LA CONVERSATION, MODIFIÉS EN DIRECT, ACCEPTÉS OU REFUSÉS UN PAR UN (2026-10-30)

« Afficher un ou plusieurs documents et surtout les modifier, en live, avec un côté magique. » L'Assistant IA ouvre les
pièces (jointes, renvoyées, trouvées) dans un **Atelier à onglets** à droite de la conversation (redimensionnable, plein
écran, panneau plein écran sur téléphone), rendu fidèle par format. **Il modifie EN PLACE** (`modifier_document` :
remplacer un texte, réécrire un paragraphe, ajouter une diapositive, modifier une cellule, insérer un tableau, ajuster un
titre…) sur le fichier d'origine — styles, tableaux, mise en page conservés — et chaque modification **apparaît pendant qu'il
travaille**, surlignée, le texte qui s'écrit, la diapositive qui apparaît. La personne **accepte ou refuse** chaque ligne,
compare avant / après, **enregistre une nouvelle version** (jamais d'écrasement ; carte de confirmation pour un document
rattaché à un objet métier ; inscrite à la Bibliothèque) et **convertit** (Word/PowerPoint → PDF par LibreOffice du worker
quand il bat, tableau → Excel, PDF → Word) — l'écran dit la voie. « Demander une modification » passe par l'Atelier ;
`preparer_document` ne sert plus qu'à créer. Banc live : 0,09 $ pour un deck (titre + synthèse) et un contrat (essai à
6 mois, styles gardés). Décision [0017](../assistant/decisions/0017-atelier.md) ; migration `20270209110000_atelier`.

### J0 : ADAM ET L'ASSISTANT IA SÉPARÉS — UN SOCLE COMMUN `src/platform/ia/`, ZÉRO IMPORT DU SOCLE VERS L'UN OU L'AUTRE (2026-10-29)

Premier lot du plan « Jarvis » validé par la Direction le 29/10 (décision `docs/assistant/decisions/0013-jarvis-architecture.md`).
Aucun écran, aucune URL, aucune donnée ne change ; aucune migration.
- **Deux produits, un socle.** Adam (Super Admin, `/chief-of-staff`) et l'Assistant IA (chacun selon ses droits,
  `/assistant`) ne s'importent plus : ce qu'ils partagent — la forme d'un outil, les intentions, les lectures annuaire/Regulatory, la
  résolution d'un fichier du Drive, la recherche web, les médias, la fabrique de documents, les blocs de l'espace de
  travail — vit au **socle IA** `src/platform/ia/`, qui n'importe ni l'un ni l'autre.
- **L'écran d'Adam** (conversation, appel vocal) quitte `src/app/(app)/assistant/` pour `src/components/chief/` : le dossier
  `/assistant` ne porte plus que l'Assistant IA.
- **Mesure** : 38 imports de l'Assistant IA vers Adam (24 fichiers) → 4, nommés pour la phase B : le catalogue d'outils
  d'Adam qu'empruntent les droits métier (`outils-v1.ts`, décision 0012) et l'action `confirmerIntentionAssistantIA`, qui
  vit dans le fichier d'actions d'Adam (la déplacer changerait le contrat des actions). Garde-fous :
  `src/platform/ia/frontieres.test.ts` et une règle ESLint dans les trois sens.
- **Phase B (30/10)** : `src/lib/agent/` devient le module `src/modules/assistant-ia/` (moteur, écrans ex-`assistant-beta`,
  actions sous leurs clés) ; la confirmation d'une carte de l'IA (`confirmerIntentionAssistantIA`) quitte le fichier d'Adam —
  seule clé du contrat qui change (`assistant-ia-actions:`) ; Adam n'importe plus rien de l'Assistant IA. Reste, nommé et
  cliqueté jusqu'à J6 : le catalogue d'outils d'Adam qu'emprunte l'Assistant IA.
- **Contrat des actions identique octet pour octet.** Frontière Adam → ERP 417 → 393 (le code partagé emporte sa dette au
  socle, plafonné à part : 180) ; traversées entre domaines −4 par rapport à la base (62 → 58). Aucun plafond relevé.

### J12 : L'ASSISTANT IA PROACTIF — VEILLEURS, BUDGET D'INTERRUPTIONS, MANDATS (2026-10-30)

Lot J12 — `docs/assistant/decisions/0024-proactivite.md`.
- **12 veilleurs par rôle** (Ad & Pro, Réglementaire, RH, Finances, Terrain, pour tous) : des règles de code sur ce qui est
  à la personne — demande bloquée, budget à 90 %, BC non signé, échéance ANPP, réserve non levée, fin d'essai, CDD,
  paiement en retard, facture en double, visite non rapportée, validation qui traîne, réunion dans l'heure. Dit une fois.
- **Budget d'interruptions** : heures calmes (heure d'Alger), week-end vendredi-samedi, regroupement, **5 par jour au plus** ;
  au-delà, le journal. Point du matin (ce qui a attendu, ce qui a été fait sous mandat). Retour « utile / pas utile » en un clic,
  mesuré (cible 60 %), qui ajuste le veilleur.
- **Mandats** : une approbation durable, bornée et révocable — « relance le validateur de mes demandes qui traînent »
  (R1). Le geste passe par l'action de l'écran, dans la session de la personne ; tout va à l'audit.
- **Écrans** : « Ce que mon assistant surveille » (`/assistant`), suggestions à l'ouverture d'un dossier, console
  (`/admin/ai/acces` : plafond, interrupteur, mesure, mandats).
### J13 : TERRAIN ET VOIX — LE VOCAL D'UN DÉLÉGUÉ DEVIENT UN COMPTE RENDU PRÊT, HORS LIGNE COMPRIS (2026-10-30)

Lot J13 — `docs/assistant/decisions/0025-terrain-voix.md` ; banc STT `scripts/banc-stt-terrain.mjs`.
- **Compte rendu vocal** : écran `/medical/terrain` (mobile, 390 px) ; transcription `gpt-transcribe` + indice (banc :
  WER 0,229, 11 entités sur 12, ~1 s — devant whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe) ; compte rendu
  structuré, médecin résolu dans l'annuaire du délégué ; cartes compte rendu / échantillons / tournée de demain ; rien
  d'écrit sans confirmation.
- **Photos de terrain** → faits proposés (ordonnance : jamais le patient) → photo rattachée au compte rendu par carte.
- **Hors ligne** : file IndexedDB, envoi automatique au retour du réseau, état visible, aucune perte (50 éléments sur
  réseau intermittent au banc ; E2E 390 px).
- **Voix temps réel de l'Assistant IA** : GPT-Live (`gpt-live-1` seul, réglable par le Super Admin), délégation au
  même assistant que le texte, dans le même fil ; valeurs sensibles jamais lues ; écritures confirmées à l'écran
  seulement. Adam inchangé.
- Migration additive `20270210110000_terrain_voix`. Aucun cliquet relevé.

### J5 + J14 : LA QUALITÉ CONTINUE DE L'ASSISTANT IA — BANC PROGRAMMÉ, TRACES REJOUABLES, CARTES QUI DISENT LEUR SOURCE, A/B DES MODÈLES (2026-10-30)

Lots J5 et J14 — `docs/assistant/decisions/0022-qualite-continue.md`.

- **Banc programmé** (Administration › Qualité IA, `/admin/ai/qualite`) : le banc « Jarvis » (26 scénarios) + Atelier, Travaux,
  Bibliothèque, rejoué SUR LE WORKER selon le calendrier du Super Admin (défaut : chaque vendredi à 3 h, 1 $ par passage),
  contre une base d'essai SÉPARÉE (`BANC_ESSAI_DATABASE_URL`, marqueur `BancBaseEssai`) — jamais la production : sans base
  d'essai, il le dit et ne tourne pas. Historique (réussite, latence P50/P95, jetons, coût, par scénario) ; une régression
  (réussite en baisse, latence ou coût +30 %) notifie le Super Admin.
- **Traces rejouables** : chaque tour du fil se rejoue à l'identique sans rappeler le modèle (`npm run assistant:rejouer`).
- **Cartes qui disent leur source** : une valeur reprise d'un document tiers (RIB, adresse, montant, destinataire…) est
  signalée sur la carte (« ce RIB provient du document X, à vérifier ») ; consignes cachées (français, arabe) repérées.
  240 contenus piégés : 0 carte trompeuse non signalée.
- **A/B des modèles** : le modèle d'un rôle (rapide, standard, raisonnement) ne change à l'écran qu'avec un banc vert.

### J4 : L'ASSISTANT IA PLUS RAPIDE, AVEC UNE MÉMOIRE — OUTILS À LA DEMANDE, RÉSUMÉ ROULANT, BIBLIOTHÈQUE BRANCHÉE (2026-10-30)

Lot J4 — `docs/assistant/decisions/0018-vitesse-memoire.md` ; banc `docs/bench/assistant-jarvis-live.md` § J4.
- **Outils à la demande** : le modèle ne reçoit plus les 65 définitions d'outils à chaque étape (~18 700 jetons), mais un
  socle de 10, une présélection de 6 par la demande (plein texte français, 0 ms) et `trouver_outil` pour le reste — jamais
  un outil hors des droits de la personne. Entrée par appel : **~22 900 → ~6 100 jetons**.
- **Consigne stable** (l'heure en dernier, règles chargées selon les outils offerts) et **effort de raisonnement adaptatif**
  (bas pour une question, moyen pour une analyse). Premier mot **P50 5,3 → 3,4–3,7 s, P95 15,4 → 7,1–8,2 s** ; coût par tour −24 %.
- **Mémoire en 4 couches** : carnet de travail (J2), conversation = 4 échanges mot pour mot + **résumé roulant** (modèle
  rapide, après la réponse, jamais une valeur sensible), mémoire personnelle triée par pertinence, **Bibliothèque branchée**
  (`chercher_documents`, `ouvrir_documents`, `faits_confirmes` — sous les droits, jamais une pièce confidentielle).
- Migration additive `20270209100000_assistant_ia_resume_roulant` (3 colonnes nullables sur `AssistantIaFil`).

### J2 : LES TRAVAUX LONGS — L'ASSISTANT IA TRAVAILLE DES HEURES OU DES SEMAINES, SUR LE MOTEUR DES MISSIONS (2026-10-30)

Décision de la Direction (29/10, lot J2) — `docs/assistant/decisions/0016-travaux.md`.
- **Un travail** = une `Mission` `kind = "TRAVAIL"` conduite par le même moteur qu'Adam, pour **n'importe quel
  collaborateur** (`principalId`, `persona`) ; migration additive `20270208100000_travaux` (aucune mission d'Adam réécrite).
- **L'Assistant IA l'ouvre** quand la demande dépasse un tour (`lancer_un_travail`, plan proposé) ; la personne
  **approuve le plan une fois** (gestes autorisés bornés à la console, plafond) dans le nouveau **panneau « Travaux »**.
- **Reprise exacte** : chaque étape écrit son reçu ; un redémarrage reprend la dernière étape, rien n'est refait, aucun geste
  n'est doublé (`TravailEcriture`). Carnet de travail ; lots bornés ; attentes sur fait métier (prédicat, échéance,
  relance) et minuteries ; droits relus à chaque étape et à chaque écriture.
- **Plafonds** (console) : 20 $ par travail et 50 $ par personne et par mois par défaut — atteint, le travail **dort**
  (`BUDGET_HOLD`) et repart seul. Notification de fin, point quotidien.
- **Worker** en image Docker (`Dockerfile.worker` : LibreOffice, ffmpeg, Tesseract fra/ara/eng, non root) ;
  `TACHES_DE_FOND=web` gardé — la Direction bascule (procédure au déploiement).
- **Mesuré** : un travail de 2 h (horloge factice) traverse 3 redémarrages forcés sans refaire une étape ni doubler un
  geste ; banc live : le modèle propose lui-même le travail, livré jusqu'au rapport (0,12 $).

### ASSISTANT IA : GLISSER-DÉPOSER DE FICHIERS ET DE DOSSIERS, APERÇU DES PIÈCES (2026-10-29)

- **Déposer** (Direction) : sur `/assistant`, des fichiers ou des **dossiers** glissés n'importe où sur la conversation font
  apparaître « Déposez vos fichiers ou dossiers » ; un dossier est parcouru en entier, le chemin relatif affiché
  (« Congrès Oran/devis/imprimeur.pdf »), les fichiers système ignorés et comptés. Aussi : Ctrl+V d'une image, trombone
  « Des fichiers… / Un dossier… » (téléphone : fichiers).
- **Rien ne part avant Entrée** : chaque fichier est une puce (taille, icône, miniature) qu'on retire (croix, Suppr sur la
  sélection, « Tout retirer ») sans rien laisser dans le Drive — le téléversement n'a lieu qu'à l'envoi, avec sa progression.
- **Ouvrir** : pièces envoyées et fichiers renvoyés par l'assistant s'ouvrent dans un aperçu latéral (Échap ferme) ;
  « Demander une modification » sur un Word. Décision [0015](../assistant/decisions/0015-glisser-deposer.md).

### J1 : LA BIBLIOTHÈQUE — TOUTE PIÈCE INSCRITE, LUE UNE FOIS, RETROUVÉE PAR SON CONTENU SOUS LES DROITS (2026-10-29)

Décision de la Direction (lot J1, pgvector approuvé) — `docs/assistant/decisions/0014-bibliotheque.md`.
- **Une porte d'inscription** (`@/modules/bibliotheque/api-inscription`) branchée sur ≈ 45 points d'entrée : Drive (dépôts,
  versions, éditeurs, copies, miroirs, exports, fabrique), pièces de module, messagerie, sujets, réunions, rapports terrain,
  RH, courriels Microsoft 365, retours, KPI, candidatures, Assistant IA. Registre R5 réutilisé (`Piece`/`PieceLien`) +
  `BibliothequeFiche`/`BibliothequePassage`. Cliquet `inscription-cliquet.test.ts` (9 exceptions nommées).
- **Lue une fois** par empreinte (tâches `bibliotheque.ingestion` et `.rattrapage`, sous bail), par les lecteurs existants
  (texte, OCR local, PowerPoint, transcription), découpée en passages ~800 jetons, vectorisée (text-embedding-3-small, 512 d)
  quand la pièce n'est ni confidentielle ni sensible.
- **Index hybride** : `tsvector` français replié + trigrammes + `vector` HNSW si pgvector (migration idempotente qui passe
  sans l'extension ; repli détecté), fusion RRF, extraits surlignés. CI : tests sur `pgvector/pgvector:pg16`, migrations
  sur Postgres nu.
- **Droits** : la règle de la route qui sert chaque fichier, appelée telle quelle (règles des routes sorties dans
  `entity-access/ouverture-pieces.ts`) ; `pourModele` écarte le confidentiel et le coffre. Écran de vérification `/bibliotheque`.
- **Mesuré** (2 000 pièces) : p50 23 ms / p95 115 ms, rappel@10 30/30, 0 résultat hors droits ; avec le vrai fournisseur
  d'embeddings, p95 ≈ 360–400 ms (l'appel au fournisseur, ≈ 280 ms, borné et mis en cache).

### ASSISTANT IA : LES DROITS DE LA PERSONNE, ET LES DONNÉES SENSIBLES EN REPÈRES (2026-10-28)

- **Retour de la Direction** (Super Admin) : « le salaire d'Assia », « son contrat », « crée un dossier pour daclatasvir »
  étaient refusés — faute d'outil, et parce que toute rémunération était masquée pour tout le monde.
- **Les droits de la personne, rien de plus, rien de moins** : fiche RH, paie (qui gère les RH, ou soi), documents RH (lien de
  téléchargement, lecture d'un contrat), situation RH, recherche fédérée, agenda, Drive ; écritures en cartes à confirmer :
  dossier réglementaire, gestes RH, tâches, demandes RH et administratives, Drive. Chaque garde rejugée à l'exécution ;
  un KAM est refusé sur la paie et les documents d'autrui, et n'a pas la création de dossier réglementaire.
- **Repères** : le modèle ne reçoit jamais un salaire, un IBAN, un n° de pièce — il écrit `⟦S1⟧`, et le serveur l'affiche à
  qui a le droit (politique du coffre, journal des accès), « [confidentiel] » sinon. Rien ne repart (historique, voix,
  notification).
- **Filtre de la saisie** : « C'est quoi le salaire d'Assia ? » devenait « C'est quoi le [CONFIDENTIEL]d'Assia ? » (l'espace
  passait pour un montant) — un montant commence désormais par un chiffre.
- **Console « Assistant IA — accès »** (précision de la Direction, 29/10) : `/admin/ai/acces`, par rôle et par personne,
  huit familles cochables (défaut / ouverte / fermée). Le Super Admin a tout ; salaires et contrats fermés par défaut pour
  les autres ; relu à chaque tour ; audit de chaque changement. Table `AssistantIaAcces` (migration additive).
- **Suite (réponses de la Direction, 29/10)** : ouverture explicite au-delà des droits pour Budgets, Drive, Réglementaire,
  Ad & Pro (lectures) ; repère `⟦Sn⟧` accepté dans une carte (valeur substituée par le serveur, rejugée à la confirmation,
  tracée) ; toute valeur sensible hors colonne du coffre journalisée avec l'outil ; route des documents RH ouverte par la
  famille « Contrats & documents RH ».
- **Manques du banc « Jarvis » (V4-H)** : l'annuaire rend le N+1 ; « qu'ai-je à valider ? » (`list_pending_decisions`) ; demandes
  Ad & Pro par année / état / nature (`demandes_adpro`) ; état d'un dossier réglementaire du périmètre avec réserves, échéances
  et commentaires (`etat_dossier_reglementaire`) ; congés de l'année sur la fiche ; coût du cache à son tarif et tarif par
  défaut documenté de `gpt-6.1-terra` ; refus formulés par le droit.
  Décision [0012](../assistant/decisions/0012-droits-de-la-personne-et-reperes-sensibles.md).

### V4 : PLUS AUCUN FICHIER GÉANT — 49 FICHIERS > 1 000 LIGNES → 1, ET UN CLIQUET DE TAILLE (2026-10-28)

Aucun écran ne change, aucune donnée, aucune migration : du code DÉPLACÉ, tel quel (audit 08, ARCH-04 — « hyper
structuré, que n'importe quel développeur comprenne »).
- **Mesure** : 49 fichiers de production > 1 000 lignes avant, **1 après** (avec les lots RH et Ad & Pro, qui ont découpé
  les leurs) : `payment-request-actions.ts`, confié au chantier des paiements. `assistant.ts` 7 314 → porte de 41
  lignes ; `assistant/ops/catalog.ts` 5 399 → 81 ; `labels.ts` 2 289 → 21 ; `rbac.ts` 2 212 → 28 ; 45 fichiers découpés.
- **Une règle unique** : un dossier au nom du fichier (`src/lib/rbac/`, `src/lib/labels/`, `src/lib/assistant/{coeur,
  outils,propositions,actions-confirmees,boucle}/`, `ops/catalogue/`, `ops/impl/<vague>/`…), un fichier par
  responsabilité ; l'ancien fichier reste la **porte** qui réexporte — aucun import à changer.
- **Contrat des actions identique octet pour octet** (identique à celui de la base) : les actions restent dans leur fichier ; leurs
  aides vivent dans `src/lib/actions/internes/<domaine>/`, que le lecteur de contrat lit comme du code local.
- **Cliquet** `src/platform/taille-fichiers.test.ts` (dans `npm run test:architecture`) : 1 000 lignes au plus pour
  tout fichier ; le seul hérité figé, la liste ne fait que rétrécir. Aucun autre cliquet relevé (frontière 422,
  traversées 67) ; hors carte −9, tests de texte au plus bas mesuré.

### REFONTE V3-B : PRIMITIVES UI — DIALOGUE ET RETOUR ACCESSIBLES, UN SEUL CROCHET D'ACTION, PARC MIGRÉ (2026-10-28)

Suite de l'audit 09 (FRONTEND-UX-01 et -05). Deux primitives dans `src/components/ui/`, montées une fois dans
la coque `app/(app)/layout.tsx` et le portail (`PrimitivesUI`) — pas à la racine, autre entrée de build qui les
aurait recopiées dans le JS de chaque page. La fenêtre et le dessin des avis se téléchargent au premier moment
libre (`differe.ts`) ; la palette ⌘K et la fenêtre d'annonce suivent la même voie, pour tenir le plafond de la
coque sans le relever :
- **Dialogue de confirmation** (`dialogue.tsx`, règle pure `dialogue-regle.ts`) : `useConfirmer()` remplace
  `window.confirm`, `useSaisir()` remplace `window.prompt`. `role="alertdialog"`, focus piégé et rendu, Échap qui ne
  ferme que la fenêtre (pas la feuille dessous), bouton au verbe du geste (« Supprimer »), « Retour » focalisé sur un
  geste à risque.
- **Retour** (`retour.tsx`, règle `retour-regle.ts`) : `<Retour ton>` (bandeau près du geste) et `useRetours()` (avis
  flottants, régions `aria-live`) remplacent `window.alert`. Une erreur ne s'efface jamais seule.
- **Un seul crochet d'action** (`components/shared/use-action.ts`) : `useAction` / `useKeyedAction` gagnent
  `run(fn, onOk, { confirmer, succes })` et `signalerErreurs` ; nouveau `useFormAction` pour `<form action>` (verrou
  anti double envoi). Tous attrapent la levée, coupent à 45 s et rafraîchissent par `useRafraichir`.

**Parc migré** (≈ 340 fichiers, en 5 lots : argent et décisions d'abord) — aucune règle métier changée ; des refus
autrefois muets s'affichent désormais. Cliquets abaissés au chiffre mesuré : `confirm(` 125 → **0**, `alert(` 46 →
**0**, `prompt(` 6 → **0**, repli « Échec. / Erreur. / Action impossible. » 259 → **0** (`src/lib/ui/dialogues-natifs.test.ts`),
appels d'action non gardés 315 → **0** (`action-gardee.test.ts`), `router.refresh()` nus 326 → **1**, le crochet lui-même
(`rafraichir.test.ts`). Carte : [KB 05 § 4.2, 4.7](../knowledge-base/05-frontend-ui-ux.md).

### MODULE AD & PRO — LE MÉTIER RANGÉ DANS `src/modules/ad-pro/` (2026-10-28, lot V4)

- **Aucun changement de comportement ni de nom d'action** : `contrat.genere.json` (1 185 actions) est identique octet pour
  octet ; seules les adresses changent. Les anciens chemins (`@/lib/ad-pro/*`, `@/lib/ad-pro-items`, `@/lib/care*`,
  `@/lib/queries/ad-pro*`, `@/lib/actions/ad-pro-*`, `@/components/ad-pro/*`, `@/components/care/*`…) restent des adresses
  de réexpédition (`tsconfig.json`) pour les branches ouvertes ; le code du dépôt importe les portes (`api`, `partage`,
  `actions-*`, `ecrans/*`).
- **Découpage par responsabilité** : `ad-pro-item-actions` (4 409 lignes) devient six morceaux sous la MÊME clé
  (`actions-postes{,-decision,-paiement,-materiel,-voyageurs,-lignes}.ts`, déclarés ensemble dans `parc.ts`) ;
  `care-actions` deux (`actions-prise-en-charge{,-logistique}.ts`) ; la carte d'un poste (`items-panel`, 2 149 lignes)
  quatre (`ecrans/items-panel.tsx` + `ecrans/postes/`). Plus aucun fichier du métier au-delà de 1 000 lignes.
- **Les pièces liées sortent du kit** : `linked-records`, `attach-to-source`, `attacher-legal-existant` vivent dans
  `components/pieces/` (le socle n'importe aucun module) ; le parent d'un poste (`parentDuPoste`) rejoint les adresses
  `lib/chemins/ad-pro.ts` (le référentiel des personnes le lit sans lire un métier).
- Mesures et dette restante : rapport d'audit 08 (suite V4) et `docs/architecture/MODULES.md`.
### ASSISTANT IA : VOCAUX « COMME WHATSAPP » ET LECTURE DE TOUTE PIÈCE JOINTE (2026-10-28)

- **Messages vocaux** (Direction) : sur `/assistant`, maintenir le micro enregistre (minuterie, onde), relâcher envoie, glisser à
  gauche annule, glisser vers le haut ou un appui bref verrouille. Le vocal est un **message du fil** : fichier du Drive personnel
  (« Assistant IA — vocaux »), transcrit en arrière-plan, la transcription **sous le lecteur** ; l'assistant répond à son contenu.
- **Réponse vocale** (option ⋯ › « Réponses vocales ») : la réponse texte est aussi lue à voix haute (synthèse OpenAI, fichier du
  Drive, 1 500 caractères au plus — la coupe dite).
- **L'assistant LIT les pièces** au lieu de les nommer : Word, Excel, PowerPoint, CSV, texte, PDF (texte, ou **scan par vision**,
  6 pages), **images par vision** (photo de facture, capture, tableau photographié), audio, **vidéo** (piste transcrite + 4 images
  clés si `ffmpeg`). Coffre refusé avant tout envoi (nature locale, pièce confidentielle, nom évocateur, OCR local qui reconnaît une
  pièce d'identité ou une fiche de paie), données sensibles masquées, contenu encadré comme non fiable, **chaque limite dite sous la
  pièce** (lue, partielle, refusée, illisible). Transcription, vision et synthèse comptées dans les plafonds et le journal.
- **Filtre de confidentialité** : un IBAN imprimé par groupes de quatre est désormais masqué (il passait en clair).
  Décision [0011](../assistant/decisions/0011-vocaux-et-lecture-de-toute-piece.md).

### CODE MORT ET DOUBLONS — MESURÉS PAR KNIP ET JSCPD, TENUS PAR LA CI (lot V4, 2026-10-28)

- **Zéro code mort, mesuré par un outil** : knip (`knip.json`, entrées App Router, actions, ponts in-process, scripts,
  prisma, tests) passe de 29 fichiers / 312 exports / 115 types / 7 dépendances inutilisés à **0**. 41 fichiers de
  production supprimés (29 orphelins, 12 fonctionnalités jamais branchées) avec leurs tests ; −11 474 lignes au total.
  `date-fns` et `docxtemplater` désinstallés, `fflate` déclaré. Deux fichiers atteints par les seuls tests restent,
  nommés avec leur raison (`src/platform/qualite-code.ts`).
- **Doublons fusionnés** (jscpd : 1 506 → 1 473 clones) : `OPENAI_BASE_URL` lue à un seul endroit
  (`models/openai-acces.ts`, accepte `…` et `…/v1` — la transcription et la passerelle attendaient l'inverse l'une de
  l'autre) ; réponses d'échec des fournisseurs ; porte Luna ; `state`/PKCE OAuth ; `plier`, `arrondirAuCentime`,
  `arrondirAuMillieme`, `montantDzd` (`lib/utils.ts`).
- **Garde** : `npm run qualite:mort`, `npm run qualite:doublons` (CI, job `verifier`) et `src/platform/qualite-code.test.ts`
  (cliquets décroissants). Détail et mesures : rapport 08, ARCH-06.

### MODULE RH — LE MÉTIER RH RANGÉ DANS `src/modules/rh/` (lot V4, 2026-10-28)

- **Aucun changement de comportement** : congés, paie, avances, notes de frais, demandes et documents RH, attestation
  de travail, ordre de mission et lectures des écrans déménagent (`git mv`) dans `src/modules/rh/` (`domaine/` pur,
  `infra/`, `ecrans/`), derrière deux portes : `partage.ts` (pur, navigateur compris) et `api.ts` (serveur).
- **Les actions gardent leur clé** (`hr-actions`, `hr-document-actions`, `payroll-hr-actions`, `stand-in-actions`,
  `conge-discussion-actions` — `src/lib/actions/parc.ts`) : `contrat.genere.json` identique octet pour octet.
- **La paie passe toujours par le centre de paiement** (Finances, `lib/expense-orders`) — lien déclaré en dette nommée,
  cible `@/modules/finances/api`. Les données sensibles restent écrites par le coffre et déchiffrées par les seules pages RH.
- Restent au socle des droits (lus par `rbac.ts` et le coffre) : `lib/hr/stand-in`, `stand-in-resolve`, `confidentialite`.
  Les anciens chemins sont des adresses de réexpédition (`tsconfig.json`). Mesures : rapport 08, « Suite — lot V4 ».

### ASSISTANT IA SUR OPENAI, CAISSE D'AVANCE CRÉDITÉE À L'AUTORISATION, BUILD RENDER SOUS 8 GO (2026-10-28)

- **Assistant IA → OpenAI `gpt-6.1-terra`** (Direction) : il utilise la clé `OPENAI_API_KEY` déjà en service, par l'API
  Responses (décision [0010](../assistant/decisions/0010-assistant-sur-openai.md)). Sans clé, il dit la variable exacte à poser.
- **Le circuit expliqué par l'assistant** ne récite plus « Validation du DG » comme une étape : le DG valide le TOTAL à la fin,
  au-dessus du seuil ; la réponse dit les branches réelles (`parcoursAdPro`) et ce qui suit la prévalidation.
- **Caisse d'avance** (Direction) : une remise ou une rallonge autorisée par le **centre de paiement** entre **directement**
  dans la caisse des moyens généraux — ordre réglé, sortie en liquide non classée, remise en main — sans passer par
  « Banque & paiements » ni par une confirmation de réception. Un seul écrivain : `src/lib/finance/verser-remise.ts`.
- **Build Render** : plus de cache webpack persistant au build de production (`next.config.mjs`) — le worker serveur de
  Next 15 mourait en OOM et le conteneur dépassait 8 Go ; mesuré : pic 4985 Mo (contre 5532 et OOM), `.next` 315 Mo.

### V3-G : LE MONOLITHE MODULAIRE DEVIENT EXÉCUTABLE — LIEUX, COFFRE ET RÉFÉRENTIELS DANS `src/modules/` (2026-10-28)

Aucun écran ne change, aucune donnée n'est touchée, aucune migration. La structure cible du rapport d'audit 08 est
désormais **tenue par les outils** et trois modules du socle métier y vivent. Guide : [`docs/architecture/MODULES.md`](../architecture/MODULES.md).
- **Modules migrés** : `src/modules/lieux/`, `src/modules/coffre/`, `src/modules/referentiels/` (91 fichiers déménagés par
  `git mv`, 46 importeurs réécrits). Chacun s'ouvre par ses **portes** : `api.ts` (serveur), `partage.ts` (pur,
  navigateur compris) ; le coffre en a une troisième, `api-lecture.ts` — `api.ts` écrit sans jamais déchiffrer (c'est
  celle des actions, atteignables par l'assistant), `api-lecture.ts` déchiffre (écrans RH, Legal, administration).
- **Carte des modules** `src/modules/carte.ts` (qui lit qui, sans cycle) et `frontieres.test.ts` étendu : portes seules,
  `domaine/` pur, liens déclarés, aucun ancien chemin importé, dette héritée nommée. ESLint dit les mêmes règles dans
  l'éditeur (et bloque `build:render`).
- **Une action a une clé, pas une adresse** (`src/lib/actions/parc.ts`) : `coffre-actions`, `consommation-actions`,
  `personnes-actions`, `organisation-actions` et `refonte-reprise-actions` vivent dans leur module (`actions.ts`,
  `actions-<cas>.ts`) sous leur clé historique ; contrat régénéré **identique** (1 184 actions).
- **Adresses de réexpédition** : chaque ancien chemin (`@/lib/coffre/cle`…) est une entrée exacte de `tsconfig.json`
  `paths`, pour les branches ouvertes en parallèle ; aucun fichier relais (git suit les déplacements).
- **Nouveaux cliquets** (`src/platform/couverture.test.ts`) : fichiers de `src/lib/` hors carte 828 → 766 (768 après fusion des lots V3-C/D/E, qui en ont ajouté), pages qui
  importent Prisma 129 → 126 (les écrans de revue des doublons lisent par `@/modules/referentiels/api`), routes Prisma
  53, composants → `src/app` 12, kit d'interface → métier 6, tests qui lisent le source par chemin 128.
- `npm run test:architecture` : frontières, carte, couverture, contrat, garde client — 40 fichiers en ~35 s.
### V3-A : DÉPENDANCES — NEXT 15, REACT 19, NEXT-AUTH BETA.32, XLSX 0.20.3 ; ZÉRO AVIS CRITIQUE/HAUT EN PRODUCTION (2026-10-28)

`npm audit --omit=dev` : **23 avis (3 critiques, 16 hauts) → 2 modérés** (`exceljs` → `uuid`, correctif = régression
majeure d'exceljs, laissé). Audit INFRA-03 ([rapport](../audit/2026-10-27/10-infra-ci-observabilite.md)).
- **Next 14.2.35 → 15.5.28** (ligne 15 encore corrigée ; tous les avis Next fermés) + **React 19.2**. Guide de migration
  suivi : codemod officiel `next-async-request-api` (214 fichiers : `params`, `searchParams`, `cookies()`, `headers()`
  deviennent asynchrones), puis les 13 accès qu'il forçait en synchrone réécrits à la main — `getCompanyScope`,
  `getBudgetScope`, `resolveBudgetEnvelope`, `poserVueExacte`/`effacerVueExacte`, `set`/`clearSupplierSession`
  deviennent `async`. `useFormState` → `useActionState` (React 19). Cache `fetch` : aucun usage explicite, le
  « no-store par défaut » de Next 15 ne change rien. Le middleware racine reste non compilé (règle de Next inchangée,
  INFRA-12, hors lot).
- **next-auth 5.0.0-beta.32** : aucune v5 stable n'existe (la `latest` npm est la v4, API incompatible) ; beta.32
  ferme les deux critiques (contrôle d'existence d'`auth` en échec ouvert, normalisation d'e-mail) et deux hauts.
- **xlsx 0.20.3 depuis le CDN officiel SheetJS** (même API ; prototype pollution et ReDoS corrigés) — le builder
  Render doit joindre `cdn.sheetjs.com` ([24-deploiement-render.md](24-deploiement-render.md)).
- **Reste de l'audit** : `npm audit fix` (sans `--force`), `nodemailer` 10.2, `zod` 4.6.7, `recharts` 2.15.4,
  `postcss` 8.5.32 imposé à Next par `overrides`, `image-size` 2.0.4 (déclaré mais jamais chargé par pptxgenjs),
  `vitest` 2.1.9 et `tsx` 4.23.15.
- **Mémoire de build** : Next 15 a supprimé `outputFileTracing: false` — le plugin de traçage par page est retiré du
  compilateur serveur par le hook `webpack` (−250 Mo, −33 s) ; tas de compilation **3072 → 3584 Mo**
  (`TAS_DU_BUILD_MO`) car Next 15 meurt en OOM à 3072. Pic sur build propre : Next 14 @3072 = 4542 Mo, Next 15 @3584
  = 5150 Mo.
- **Restent** (outillage de test seulement, jamais déployé) : la chaîne `vitest` 2.x (tinypool, vite) n'est corrigée
  qu'en vitest 5 — montée majeure du lanceur de 15 800 tests, à faire dans son propre lot.

### V3-D — L'ASSISTANT IA EN EXPLOITATION : CHAQUE APPEL COMPTÉ, CHAQUE TOUR BORNÉ (2026-10-28)

Audit 27/10, rapport 06 (IA-ASSISTANT-03, -06, -07, -08, -09, -10, -12, -13 et l'injection par documents). **Journal** :
les deux seules portes de l'Assistant IA vers MiMo (`repondreAvecSecours`, `genererTexte`) ouvrent un budget, comptent
chaque étape de Mastra (`onStepFinish`) et écrivent une ligne `ModelCallLog` par appel (personne, conversation, modèle,
jetons, durée, coût estimé) et une `AiUsageLog` par tour (`src/lib/agent/consommation.ts`). **Plafonds** (table
`AssistantIaReglage`, réglage Super Admin, défauts 12 étapes / 150 000 jetons par tour / 600 000 par personne et par
jour, heure d'Alger) : refus clair qui nomme le remède, avis au Super Admin une fois par jour (`AssistantIaPlafondAtteint`).
**Écran** `/admin/ai/consommation` : par personne, par jour, par modèle, plafonds atteints, réglages. **Injection** :
sorties d'outils à contenu tiers encadrées et désamorcées (`contenu-non-fiable.ts`, cliquet sur les noms d'outils).
**Robustesse** : trois essais par message du fil (`AssistantIaTour.essais`), balayage `assistant.intentions` (action
interrompue → échec dit, carte non confirmée → `EXPIRED` après 24 h, refus aussi au clic), cartes caduques retirées avant
le tour et comparées sur `payload.op`. `agent.ts` (sans appelant) supprimé ; clé MiMo lue sous `MIMO_API_KEY` seul ;
fournisseur réel dans le journal d'Adam. Migration `20270202090000_assistant_ia_exploitation`. Bancs au faux modèle :
`consommation.test.ts`, `exploitation.test.ts`, `contenu-non-fiable.test.ts`.

### V3-C PERFORMANCE : SONDAGES LÉGERS, ICÔNES À L'UNITÉ, LECTURES EN PARALLÈLE (2026-10-28)

Suite du rapport d'audit [07 — performance](../audit/2026-10-27/07-performance-runtime.md), mesurée avant/après.
- **Session légère des sondages (PERF-06)** — `src/lib/session-legere.ts` : `identiteDuSondage()` (jeton + session
  révocable + compte actif + rôle en base + « Vue exacte », **sans** la matrice des droits) et `peutVoirLaMessagerie()`
  (accès attribué, repli exact sur `getAccess`). `/api/messaging/sync` et `/api/notifications/poll` l'utilisent :
  **13 → 2** et **14 → 3** requêtes SQL par appel. La révocation et la vue sont écrites une fois dans
  `src/lib/session-compte.ts`, lues aussi par `session.ts` (session révocable en **une** requête jointe au lieu de deux).
  Cliquet : une route sondée par la coque lit `identiteDuSondage` (`notifications-sondage-unique.test.ts`).
- **Icônes de la coque à l'unité (PERF-05)** — `src/components/ui/icones-coque.ts` (imports nommés) +
  `IconeCoque` ; le jeu complet de Lucide n'est plus chargé que pour un nom absent (chargement différé). Cliquet
  `icones-coque.test.ts`. Mesure : `node scripts/mesure-bundle.mjs` après un build propre.
- **Lectures indépendantes en un aller-retour (PERF-10, PERF-11)** — coque `(app)/layout.tsx`, utilisateur à l'écran
  calculé une fois par rendu (`cache`), `finances/paiements-a-faire`, `marketing-cockpit`.
- **`take` imbriqué (PERF-08)** — Adam « Conversations consultées » borné en SQL (`derniersMessagesParConversation`) ;
  cliquet `src/lib/prisma-take-imbrique.test.ts` (plafond 33, décroissant).
- **Classeurs (PERF-07, part sûre)** — l'ingestion n'analyse que les lignes indexées (`sheetRows`) : 2,7 s → 0,16 s
  de gel sur 100 000 lignes.
Aucune migration : les index des chemins mesurés sont en place (`EXPLAIN`).

| Mesure (avant → après) | Avant | Après |
|---|---|---|
| SQL par appel, badge messagerie (banc journalisé) | 13 | 2 |
| SQL par appel, `/api/notifications/poll` | 14 | 3 |
| SQL / min / onglet, sondages de la coque | ~121 | ~22 |
| Temps médian d'un sondage (serveur de prod local) | 18–19 ms | 10–12 ms |
| JS de la coque (gzip, toutes les pages) | 315,4 kB | 166,1 kB |
| Médiane du First Load JS par page | 324,5 kB | 176,4 kB |
| Gel d'ingestion d'un classeur de 100 000 lignes | 2,7 s | 0,16 s |
### REFONTE V2-F : LES TÂCHES DE FOND PEUVENT QUITTER LE WEB — WORKER, BAIL PAR TÂCHE, BATTEMENT VISIBLE (2026-10-27)

Le passage de `runScheduledJobs` devient une **table** (`TACHES_PLANIFIEES`, `src/lib/scheduled.ts`) : une ligne par
tâche, chacune sous un **bail en base** (table `TacheDeFond`, `src/lib/taches-de-fond/bail.ts`) — un seul exécutant la
tient, même si deux processus battent ; un bail expiré (processus tué) se reprend. Une tâche qui lève est comptée en
échec et **le passage continue** (cinq étapes sans filet faisaient sauter tout le reste). Nouveau point d'entrée
**`npm run worker`** (`scripts/worker.ts`) : même passage, arrêt propre sur SIGTERM, attente des migrations de son
commit, journal JSON. Interrupteur **`TACHES_DE_FOND=web|worker|les-deux`**, défaut `web` : rien ne change en production
tant que le service n'est pas créé (bloc commenté dans `render.yaml`). Santé : `/api/health/worker` et Diagnostic ›
Tâches de fond. Place prévue pour la file d'enrichissement V2-A (`enrichissement.file`, « ignorée » d'ici là).
Migration `20270201100000_taches_de_fond`. Procédure d'activation : [24-deploiement-render.md](24-deploiement-render.md).
### REFONTE V2-C : LES ORGANISATIONS EN SERVICE — REPRISE, DOUBLONS PROPOSÉS, DOUBLE ÉCRITURE, FICHE 360° (2026-10-27)

Migration `20270131170000_organisations_reprise` (une table `PropositionDoublonOrganisation`, une colonne
`AppSetting.doubleEcritureOrganisations`, fausse par défaut) — elle n'écrit AUCUNE donnée.
- **Administration › Refonte des données** (`/admin/refonte-donnees`, Super Admin seul) : une carte par reprise — aperçu
  à blanc, un lot (200 lignes) ou tous les lots, journal (lignes d'audit « Refonte des données »). Contrat commun
  `referentiels/reprises/types.ts`, liste `reprises/index.ts`, action unique `actions/refonte-reprise-actions.ts`.
- **Quatre reprises, dans l'ordre** : `organisations` (sociétés du groupe, partenaires, fournisseurs Regulatory,
  établissements → une `Organisation` chacun, rôles, NIF/NIS/RC/AI normalisés, `organisationId` posé) ;
  `organisations-textes` (institution d'un sponsoring, établissement hôte d'un congrès national : rattachés à la seule
  organisation de même nom, ou à une organisation née du texte ; le texte saisi reste) ; `organisations-affiliations`
  (salarié ↔ sa société, praticien ↔ son établissement… quand la Personne existe — aucune personne créée) ;
  `organisations-doublons` (paires proposées avec leurs raisons). Rejouées, elles ne refont rien (ids déterministes).
- **Un NIF identifie un tiers** : unique par (type, valeur normalisée). Deux fiches au même NIF → le second n'est pas
  recopié, la paire est proposée « certaine » ; le NIF d'une société du groupe recopié sur un tiers ne compte pas.
- **Doublons à trancher** (`/admin/refonte-donnees/organisations`) : garder l'une, garder l'autre, ou « pas les
  mêmes ». Une fusion n'efface rien (`fusionneeDansId`) et se défait ; une paire écartée n'est jamais reproposée.
- **Double écriture** (interrupteur sur l'écran) à la création d'un fournisseur (3 portes), d'un partenaire, d'un
  établissement : même code que la reprise, non bloquante.
- **Fiche Organisation 360°** `/organisations/[id]` : identifiants, rôles, coordonnées relevées sur les fiches,
  personnes affiliées, fiches d'origine, devis/BC/factures (`LegalDocument`), demandes Ad & Pro — chaque bloc avec la
  porte de son écran d'origine. Ni RIB ni IBAN (lot coffre).
- Code : `src/lib/referentiels/organisations/*` ; bancs `candidats.test.ts`, `reprises/lots.test.ts`, `reprise.test.ts`.
### REFONTE DES DONNÉES, LOT V2-A : LE DÉPÔT NOURRIT LES FICHES (2026-10-27)

Migration `20270131170000_enrichissement_file` (table `TacheEnrichissement`, colonne `AppSetting.enrichissementActif`
fausse par défaut). Les trois goulots de dépôt émettent `PIECE_DEPOSEE` et mettent la pièce en file ; le battement la
lit EN LOCAL, la classe, en extrait les faits, les rattache à la Personne de la fiche où elle est déposée (ou à
l'Organisation de son NIF), confirme d'office ce qui peut l'être, range au coffre ce qui est sensible, et laisse le reste
à l'écran « À confirmer ». Rien n'est actif avant que le Super Admin ouvre l'interrupteur (Administration › Refonte des
données), qui porte aussi la reprise « Rattrapage des pièces existantes ». Détail : référence des circuits, p04.

### LEGAL : « NOUVEAU DOCUMENT » ET « NOUVELLE FACTURE » SE REMPLISSENT DEPUIS LA PIÈCE (2026-10-27)

Migration `20270129100000_synthese_legale` (deux colonnes nullables sur `LecturePiece`). On dépose d'abord le fichier (ou
on le désigne dans le Drive) ; il est lu, et le formulaire s'ouvre avec ce que la pièce DIT — chaque champ rempli en
violet (`--luna`) avec sa preuve au survol, le reste vide ; touché, un champ redevient celui de la personne. Le fichier
lu est déjà joint. Enregistrer reste le seul geste qui écrit (`createLegalDocument`, toutes ses gardes).
- **Trois sources, dites champ par champ** (`pieces-lues/prerempli-document-legal.ts`, pur) : les RÈGLES (`entetes.ts` :
  n°, date d'une pièce commerciale, NIF/RC, totaux — la ligne en preuve), LUNA (nature d'un contrat, titre, prise
  d'effet, résumé — la phrase en preuve), le CALCUL (fin tirée d'une durée lue, « calculée »). Le montant vient des
  règles seules ; des totaux en désaccord le laissent vide et le disent.
- **Luna lit un document légal** par `synthetiserDocumentLegal` (`lecture-pieces-ia.ts`, même bascule « lecture des
  pièces », mêmes portes) avec son schéma (`pieces-lues/synthese-legale.ts`) — gardée sur la lecture, une fois par
  empreinte. Service `pieces-lues/document-legal.ts`, action `actions/legal-lecture-actions.ts`.
- **Décisions Direction (27/10)** : lecture coupée → lecture locale quand même ; la pièce d'abord, « Saisir sans
  fichier » en recours ; un fichier du Drive se lit aussi ; « Document confidentiel » se coche AVANT la lecture (rien ne
  part, lecteurs exigés) ; plusieurs fichiers → le premier est lu, « Lire plutôt celle-ci » ; changer de pièce ne
  remplace que les champs non touchés ; partie retenue CERTAINE seulement (sinon proposée, ou « Créer un contact »
  prérempli du NIF/RC lus) ; sens d'une facture posé seulement si le NIF de l'émetteur le prouve, sinon à choisir
  (`sensExige`, refus serveur) ; le BC cité par une facture remplit « Fait suite à » quand un seul porte ce numéro ;
  Notes = résumé + « À surveiller » (préavis, reconduction, pénalités).
- Écran : `app/(app)/legal/nouveau-document-legal.tsx`, `champs-preremplis.ts` ; `RecordForm` gagne `marques`,
  `fichiersInitiaux`, `drivesInitiaux`, `entete` ; `PartyPicker` gagne `propose`. Formats lus : `pieces-lues/formats.ts`
  (pur, réexporté par le service).
- Bancs : `pieces-lues/synthese-legale.test.ts`, `pieces-lues/prerempli-document-legal.test.ts`,
  `app/(app)/legal/champs-preremplis.test.ts`.

### SÉCURITÉ : L'ÉDITEUR OFFICE N'ENREGISTRE QUE SIGNÉ, UN FICHIER DÉPOSÉ NE S'EXÉCUTE PLUS, UN PAIEMENT NE SORT QU'UNE FOIS (2026-10-24)

Aucune migration. Trois défauts relevés par l'audit d'architecture (`docs/knowledge-base/01-system-overview.md`, R1 · R2 · R4).
- **Éditeur Office — lire n'est plus enregistrer** : un seul jeton servait à `document.url` (envoyé au NAVIGATEUR, même en
  lecture) et au rappel ; le rappel acceptait un corps non signé, téléchargeait `body.url` n'importe où et écrivait sans
  relire le droit — un lecteur pouvait remplacer le fichier (et faire appeler au serveur l'adresse de son choix).
  Désormais : jeton de LECTURE (`makeFileReadToken` / `makeDocReadToken`) pour `/api/onlyoffice/file` et les conversions ;
  jeton d'ENREGISTREMENT (`makeSaveToken`) émis en mode édition seulement, dans `callbackUrl` ; décision pure
  `lireRappelOnlyoffice` (corps SIGNÉ par le Document Server obligatoire, valeurs lues dans la partie signée, adresse chez
  le Document Server) ; droit relu au rappel (`peutEnregistrerOnlyoffice` : « modifier » Drive / « téléverser » entité,
  compte actif). Les jetons d'avant restent lus 24 h au plus (transition, mêmes contrôles). ⚠️ Le Document Server doit
  tourner avec `JWT_ENABLED=true` et le même secret (c'est la configuration documentée, `docs/ONLYOFFICE_SETUP.md`) :
  sinon ses enregistrements sont refusés, avec la raison au journal serveur (`[onlyoffice] rappel refusé : …`).
- **Fichiers déposés — rien ne s'exécute dans l'ERP** : HTML, XHTML, SVG et tout XML étaient servis « en ligne » avec le type
  déclaré au dépôt, sous une CSP qui ne restreint pas les scripts. Règle pure `lib/http/types-actifs.ts` : un type actif part
  avec `Content-Security-Policy: … sandbox` + `nosniff` (il s'affiche, sans script ni session) ; vers le bucket (adresse
  signée, pas de CSP possible) il se télécharge (`dispositionPourBucket`). Appliqué dans la porte `repondreFichier`, dans
  les dix routes de pièces jointes servies en ligne et aux trois adresses signées vers le bucket ; cliquet : toute nouvelle route « inline » doit passer par la règle.
  PDF, images, vidéo et Office ne changent pas (le bac à sable bloquerait la visionneuse PDF).
- **Règlement d'un ordre — une seule sortie d'argent** : `settleExpenseOrder` lisait le statut puis écrivait l'écriture de
  trésorerie plusieurs `await` plus loin ; deux règlements simultanés posaient DEUX sorties pour un ordre (reproduit en
  banc). L'ordre se réserve d'abord (`updateMany` PENDING → PAID sous l'autorisation du centre lue, §118.151) et l'écriture
  naît dans la même transaction ; le perdant ne touche à rien (et reçoit « réglé » si l'autre a réglé).
  `decidePaymentRequest` écrit de même sous condition du statut jugé : deux « bon à payer » ne créent plus deux ordres.
- Bancs : `onlyoffice.test.ts`, `onlyoffice-session.test.ts`, `onlyoffice-diagnostic.test.ts` (cliquet du rappel),
  `http/types-actifs.test.ts`, `actions/reglement-concurrent-flow.test.ts` (rouge sur l'ancien code, vert sur le nouveau).

### DEMANDES DE PAIEMENT : LE MONTANT EST CELUI DE LA FACTURE — RETIRÉE, ELLE QUITTE LE CENTRE ET SE SUPPRIME (2026-10-19)

Aucune migration.
- **Montant divergent — la cause** : « Demander un paiement » (Demandes de validations) envoyait au centre le montant
  SAISI, jamais comparé à la facture ; Luna lisait pourtant le TTC au dépôt (garde des doublons) et le jetait. Règle pure
  `lib/finance/montant-facture.ts` : le montant se confronte au TTC lu des factures EN VIGUEUR (remplacées exclues,
  plusieurs additionnées, 1 DZD de tolérance). Écart → refus avec les deux chiffres (`ActionResult.ecartMontant`) : on
  reprend le TTC (« Prendre … DZD »), ou on explique ET coche la confirmation — l'explication est écrite dans l'ordre
  (`ÉCART ASSUMÉ…`) et au fil (`ECART_ASSUME`). Appliqué à la création, à la transmission d'un brouillon ou d'un dossier
  renvoyé (`submitPaymentRequest`, lecture gardée `ttcDesFacturesStockees`) ; signalé (`ECART_MONTANT`, bandeau) au dépôt
  d'une facture de remplacement et à une correction de montant. Facture illisible : rien n'est bloqué, le fil dit
  « montant non vérifié ». Écran : `components/finance/ecart-montant.tsx`.
- **Retrait** : l'ordre annulé gardait une autorisation « en attente » — le centre le listait, le comptait et pouvait
  l'autoriser. `ORDRE_NON_ANNULE` filtre `chargerCentre` et tous les compteurs « en attente du centre » (cliquet
  `payments/centre-ordres-annules.test.ts`) ; `refusOrdreFerme` garde `decidePayment` et `respondToPaymentCentre`.
- **Suppression définitive** : `supprimerDemandePaiement` (demandeur ou Super Admin), type `PAYMENT_REQUEST` du registre,
  EN LOT avec son ordre annulé, restaurable depuis la corbeille, audité. Refus (`refusDeSuppression`) : dossier vivant
  (le retirer d'abord), compagnon, paiement sorti. Bouton sur la fiche, fenêtre commune `ConfirmationSuppression`.
- Bancs : `finance/montant-facture.test.ts`, `finance/suppression-demande.test.ts`, `actions/paiement-montant-retrait-flow.test.ts`.

### « À IMPUTER » SEULEMENT DANS BUDGETS, PAR ENVELOPPE (2026-10-19)

Aucune migration. « Ça doit être que dans le module Budgets, par Budget Marketing etc. » La liste des écritures à ranger
(`BudgetExpenses`) ne s'affiche plus que dans `/budgets/depenses`, pour l'enveloppe choisie et avec ses catégories. Les
onglets Dépenses de Budget Marketing, Regulatory et Operations & Sales n'en gardent que le compte et un lien « Dans
Budgets » (`renvoiAImputer`) ; les alertes de leurs vues d'ensemble mènent là (`lienAImputerBudgets`, sans lien si la
personne n'entre pas dans Budgets — `alerte-a-imputer.tsx`). Le retrait par le Rapprochement Ad & Pro et les étiquettes
(« Pas Ad & Pro », « Force de vente ») suivent l'enveloppe dans Budgets (`aImputerDeLEnveloppe`). L'imputation elle-même
(`attributeTransaction`) est inchangée. Banc : `lib/budget/a-imputer-seulement-budgets.test.ts`.
### AGENDA : LES ÉVÉNEMENTS AD & PRO S'Y AFFICHENT, LUS SUR LEUR DEMANDE (2026-10-19)

Aucune migration, aucune copie. Les prises en charge internationales et nationales et les événements (congrès,
symposiums, tables rondes, staffs, journées…) apparaissent dans `/calendar`, « À venir », l'onglet Aujourd'hui et
l'agenda d'Adam : intitulé, nature, début → fin, lieu, demandeur, **« Ouvrir la demande »**. L'agenda relit la source à
chaque affichage (`lib/calendar-ad-pro.ts`, `getAdProEventsAsCalendar`) : date déplacée → l'agenda suit ; demande
annulée (`status` CANCELLED), refusée ou annulée au circuit (`requestStatus` REJECTED / CANCELLED) ou supprimée → elle
disparaît. **Portée = celle de la liste « Toutes les demandes »** : module de la nature en lecture, portée de ligne (un
délégué ne voit que SES congrès ; les événements n'en ont pas, comme leur liste), entité de l'en-tête ; sans matrice de
droits, rien. Date sans heure = journée entière ; plusieurs jours = une case par jour (`endYmd`, `joursCouverts`) ; un
congrès en cours reste en tête de « À venir ». Le sponsoring et les « autres demandes » n'ont pas de date : rien à
placer. Aucune modification depuis l'agenda (ni réponse, ni suppression). Banc : `calendar-ad-pro.test.ts` (jours,
droits, entité, agenda ⊆ fiche, annulation, suppression, date modifiée).
### AD & PRO : LUNA LIT LA DESCRIPTION ET PROPOSE LES POSTES (2026-10-19)

Aucune migration. Maquette « luna-postes » : à la création d'un **événement**, la description passe en tête ; on y colle le
mail d'organisation et, en quittant le champ, Luna propose l'événement (nom, type, dates, lieu, wilaya, spécialité,
capacité) et ses **postes** — salle (+ cocktail, pause-café), repas (convives par repas), hôtellerie (une fiche par
personne : prénom / nom, hôtel, nuits, chambre), billetterie (une fiche par voyageur ; un trajet par sens → aller simple,
aller-retour ou plusieurs destinations ; créneaux « matin », « 21h00 » en notes) et les pièces annoncées (« PI à
joindre »). **Rien ne s'écrit** avant « Reprendre » : les champs VIDES se remplissent (marqués), les postes gardés se créent
après la demande par l'action ordinaire `addAdProItem` (mêmes gardes et fiches). Sans IA (coupée, non configurée), la carte
n'apparaît pas. L'écran suit la maquette au détail près (2026-10-20) : teinte **Luna** (`--luna`, `luna` dans Tailwind —
réservée à ce que Luna propose), étiquette « Luna » et fond violet sur chaque champ rempli jusqu'au premier geste
(`[data-luna]`, `globals.css`), lignes « NOM Prénom », hôtellerie « hôtel · chambre · nuits », billetterie « transport ·
trajet », convives par repas (« 2 + 9 », champ `repas` du contrat) et **Annuler** après « Reprendre » (vide les champs
encore marqués, retire les postes, la proposition revient). Pur : `lib/ad-pro/postes-luna.ts` (schéma strict, consigne, relecture : nom absent de la description
écarté, nature hors liste écartée, fiche relue par `lireVoyageur` / `lireHebergement`, `versFormulairePoste`) ; serveur :
`lib/postes-luna-ia.ts` (passerelle `askModelJson`, rôle `worker`, journal `postes_luna`, bascule de l'assistant) ;
action `actions/ad-pro-postes-luna-actions.ts` ; écran `components/ad-pro/description-luna.tsx`, `events/event-form.tsx`.
Banc : `postes-luna-ia.test.ts` (modèle simulé à la passerelle : l'Advisory Board de la Direction, une personne, dates en
toutes lettres, sans billetterie ; abstentions).
### DRIVE : UN CLIC, ON EST DANS LE FICHIER — PARTAGE · COMMENTAIRES · ⋯ (2026-10-20)

Aucune migration. Demande de la Direction (« comme Google Drive »), maquette validée.

- **Ouverture directe** : `/drive/[id]` n'est plus une page intermédiaire (boutons + panneau d'informations) mais le
  fichier lui-même (`drive/[id]/fichier-ouvert.tsx`) : éditeur Office plein hauteur (édition / lecture selon le droit),
  aperçu pour le reste. `/drive/[id]/edit` redirige ; création d'un document → ouverture directe.
- **Plus rapide** : la page ne lit que le fichier + trois compteurs (`_count` partages / commentaires / versions) et
  prépare la configuration de l'éditeur côté serveur (`sessionEditeur(…, dejaLu)` ne relit rien ; plus d'appel
  `/api/onlyoffice/session` après l'affichage) ; squelette instantané (`drive/[id]/loading.tsx`) ; script de l'éditeur
  préchargé au survol du nom (`prechargerEditeur`). Partages, versions, commentaires : lus à l'ouverture de leur
  panneau (`getDriveNodeShares(id, withUsers)`, `getDriveNodeVersions`, `listDriveComments`).
- **Trois icônes** à côté de chaque fichier, dans la liste ET le fichier ouvert (`NodeActions`) : Partage (rôles
  existants Lecture / Éditeur / Aucun accès), Commentaires (pastille), « ⋯ » : informations en tête, Convertir en PDF,
  Nouvelle version, Historique des versions, Télécharger, Renommer, Déplacer, Partager par messagerie, Legal, Courrier,
  **Mettre à la corbeille avec confirmation** (aussi « Supprimer définitivement »). Règles pures : `lib/drive/menu-fichier.ts`.
- **Toujours récupérable** : « Supprimer définitivement » depuis la corbeille du Drive n'efface plus rien — l'élément
  (et tout son contenu, versions, partages, commentaires) passe dans **Administration → Corbeille** (type `DRIVE_NODE`
  du registre, en lot), d'où le Super Admin le restaure dans le Drive ; seule « Détruire » libère les octets.
  Phrases corrigées à l'écran et dans la carte d'Adam (« irréversible » était devenu faux).

### BC : CHANGER LE SEUL NUMÉRO NE RELANCE PAS LE CIRCUIT (2026-10-14)

Aucune migration. Décision de la Direction : une révision dont la SEULE différence est le numéro garde l'état du BC — aucun
réaiguillage, étapes de validation, visas, signature des Finances et envoi au fournisseur conservés. Décidé au serveur en
comparant l'enregistré et le soumis (PUR `lib/bons-de-commande/numero-seul.ts`, `changementDeNumeroSeul` / `champsDifferents`,
jamais un drapeau de l'écran) ; la pièce est régénérée TELLE QU'ENREGISTRÉE au nouveau numéro, version marquée « numéro seul »
(`historique[].numeroSeul`), audit `field = numero`. Unicité, compteur et droits inchangés ; le moindre autre champ → la règle
d'avant. La signature n'est pas incrustée dans le PDF généré (c'est la copie signée téléversée) : elle est conservée, la copie
garde l'ancien numéro (dit à l'écran et tracé). Signé, un BC de poste Ad & Pro ou de demande au secrétariat ne se modifie
plus que par son numéro (« Modifier le n° de référence », `components/references/modifier-numero-bc.tsx`,
`reviserNumeroDuBc`, `estRevisionDeNumeroSeul`). BC déposés : `updateLegalDocument` (numéro seul = aucun autre champ ni
fichier). Bancs : `numero-seul.test.ts`, `bc-numero-reference-flow`, `bc-apercu-complet-flow`, `secretariat/devis-bc-flow`,
`promo-circuit-v2-flow`, `prevalidation-flow` (outil `bons-de-commande/etat-bc-test-outils.ts`).

### MON ESPACE : L'ONGLET « AUJOURD'HUI » REMPLACE « MON ESPACE » (2026-10-14)

Aucune migration. Décision de la Direction : « Je valide l'onglet Aujourd'hui qui va remplacer l'onglet Mon espace.
Les autres onglets de l'ERP restent tels quels. » — voir « Mon espace › Aujourd'hui » dans la référence des circuits.

- `/mon-espace` : « Votre journée » (phrase calculée + 3 à 4 chiffres du MÉTIER), « À faire maintenant » groupé par lot
  et trié par urgence (règles pures `lib/espace/aujourdhui.ts`), « Ma semaine », encart « Mon équipe » pour un N+1,
  rappels avec ajout rapide, raccourcis du métier, bloc « Moi » (remplace les deux boutons de l'en-tête).
- `ActionItem` gagne `montant`, `famille`, `statut` ; l'écran des paiements met en évidence plusieurs ordres
  (`?focus=a,b,c`). L'onglet `/aujourdhui` quitte la barre de l'espace (la page reste servie).

### INTÉGRATION AD & PRO 2026 : « EN SORTIR » NE FAIT PLUS QUITTER L'ÉTAPE 4 — ET LE N° DE RÉFÉRENCE DES BC MODIFIABLE (2026-10-14)

Aucune migration.

- **« Garder / En sortir » avant la validation** (`budget-marketing/integration/assistant-integration.tsx`). Cause : chaque
  choix faisait `setApercu(null)` — la table avant → après, la liste et la validation disparaissaient, et il fallait renvoyer
  et relire le fichier. Le choix est désormais LOCAL : l'aperçu reste et se recalcule à l'écran (PUR
  `lib/budget-marketing/integration-absentes.ts`, `appliquerDecisionsLocales` — chaque absente porte `categoryId` et `effet`
  consommé/engagé). « Tout sortir », « Tout garder », et la **sélection proposée** : un élément au même libellé normalisé
  qu'une ligne du fichier, ou au même montant (±1 DZD) dans la même catégorie, est pré-réglé « En sortir » avec « doublon
  probable de la ligne Lnn » (`doublonsProbables`). Les choix partent avec la validation et s'écrivent dans la transaction du
  lot (libellé et montant compris) ; l'empreinte du fichier lu est renvoyée et un fichier remplacé est refusé. Après
  validation (`lot-integre.tsx`) : mise à jour optimiste, relecture en arrière-plan, même écran. Écriture du lot sous
  `enSerie` + `createWithRetry` (références SPO/FORM/MP/DIM). Bancs : `integration-absentes.test.ts`, `integration-flow.test.ts`.
- **Le N° de référence d'un BC se modifie** (Direction : « écrit manuellement, ou modifié quand on modifie ou qu'on révise
  n'importe quel bon de commande »). Règle PURE `lib/bons-de-commande/numero-reference.ts` ; fabrique : `ModificationsDocument.numero`
  jugé par `jugerNumeroRevise`, unicité `porteurDuNumero` (registre commun NNN/DG/AAAA tous documents, ou BC de la société),
  écrit sous verrou avec la révision (`appliquerNumeroRevise` : entrée du registre déplacée, compteur porté AU MOINS au
  numéro — jamais en arrière), Word/PDF/fiche/titre au nouveau numéro, audit `field = numero` (ancien → nouveau). Hors
  registre, un BC se compose aussi avec un numéro écrit à la main (série verrouillée, compteur porté à sa séquence).
  Composeur : champ « N° de référence » (`components/references/champ-numero-piece.tsx`, vérifié en direct par
  `verifierNumeroPiece`) en révision (fiche Legal, demande au secrétariat, poste Ad & Pro), sur l'aperçu d'un BC à
  régénérer, et à la composition hors registre ; BC promotionnel : « Modifier » et aperçu prérempli du prochain numéro ;
  BC déposés (fiche Legal, secrétariat) : unicité + registre + trace (`lib/bons-de-commande/numero-depose.ts`). Les circuits
  de validation et de signature ne changent pas. Bancs : `actions/bc-numero-reference-flow.test.ts`,
  `numero-reference.test.ts`, et un cas dans `bc-apercu-complet-flow`, `secretariat/devis-bc-flow`, `promo-circuit-v2-flow`.

### BONS DE COMMANDE : L'APERÇU OBLIGATOIRE, ET TOUT S'Y CORRIGE (2026-10-14)

Aucune migration (le brouillon reste le JSON `AdProDevis.bcBrouillon`). Décision de la Direction : « Je veux l'aperçu
obligatoire ; modification et révision possibles du BC ultra complètes, chaque détail peut être modifié dans le BC. »

- **Un seul chemin** : Générer → aperçu → relecture/correction → Valider et envoyer. Le geste « en un clic » du poste
  (`genererEtEnvoyerBcPoste`) est retiré ; le clic ouvre l'aperçu prêt à relire (PDF à blanc, sans numéro). Le Bureau du
  secrétariat passe aussi par l'aperçu (rien n'est écrit avant la validation) ; le matériel promotionnel y passait déjà.
- **L'aperçu est le composeur de la révision** (mode brouillon) : fournisseur complet, lignes (unité, détails, sections,
  remise, TVA), dates, références amont, paiement, TVA, remise globale, taxes, livraison (avec sa date), contact, notes,
  papier en-tête, coordonnées de l'émetteur, signataire, mentions — gardés sur le brouillon et appliqués à l'émission.
- **Plafond de l'accordé en TTC partout** (audit M-03 corrigé) ; brouillon périmé si les lignes validées changent ; BC
  signé non modifiable depuis le poste. Le BC d'une demande au secrétariat se modifie depuis la demande tant qu'il n'est
  pas signé. Le composeur gagne l'**unité** des lignes et la **date de livraison** (Legal compris).

### INFORMATION MÉDICALE : CE QUE LE PRIM FAIT VALIDER VA AU DIRECTEUR DES OPÉRATIONS (2026-10-14)

Aucune migration. Règle pure `lib/medical-info/decideur.ts` (testée) — voir « Information médicale » dans les workflows.

- **Un seul décideur** : la lecture « à déclarer ? », le dépôt des bons de versement et la validation finale partent
  automatiquement au **Directeur des Opérations** (`OPERATIONS_DIRECTOR`, principal ou secondaire). Avant : N+1 →
  référent Direction Marketing → centre (DG) en série pour les deux premières, Direction des opérations / Super Admin
  (vue globale) pour la finale. Plusieurs directeurs actifs : tous saisis et notifiés, **le premier qui tranche décide**
  (nature `INFO_MED_DIRECTEUR_OPS`, `validations/decision.ts:unSeulSuffit`). Aucun : le **Super Admin**, et la
  confirmation du pharmacien le dit. Le Super Admin reste souverain.
- **Refus de la validation finale** (`refuseDeclarationByDirection`, motif exigé) : le dossier revient au pharmacien,
  le motif lui est notifié, versé dans la discussion et affiché sur la fiche.
- **Course corrigée** : deux validations finales simultanées n'émettent plus deux ordres de dépense (passage à « validée »
  conditionnel, l'ordre au seul gagnant ; ordre raté → le dossier revient en attente). Double clic sur « faire valider »
  : la seconde demande est retirée. Une pièce déposée pendant la validation finale ne sort plus le dossier de la file.
- **Accès** : le Directeur des Opérations lit l'Information médicale en entier (registre, fiche, pièces de la source).
  Les demandes déjà en cours sous l'ancienne chaîne finissent leur circuit.
- **L'argent (audit)** : un bon de versement ne fait qu'UNE demande de paiement même à deux clics (prise
  conditionnelle du bon, jeton `prise:` — `requestSlipPayment`) ; un bon dont l'ordre est annulé ou la demande refusée
  passe « Paiement annulé — à redemander » (`slips.ts`, étape `ANNULE`) et se redemande, se retire ou laisse déclarer
  le dossier « sans versement » ; le rattachement d'une demande de paiement à une déclaration (exemption de facture)
  se PROUVE (`bonDeVersementRattache`) ; plus d'ordre global à la validation finale d'un dossier ouvert par le PRIM,
  d'un MIP, d'un visa ou du circuit matériel (`circuits.ts:ordreGlobalALaValidation`) ; pharmacien assigné
  déterministe (le plus ancien actif, `pharmacienAssigne`), notifié seul ; sans pharmacien, la déclaration naît
  QUAND MÊME, non assignée, portant l'ordre déjà parti ; un visa publicitaire se valide avec son numéro ; le dossier
  promotionnel ne se clôt « payé et visé » qu'à la déclaration VALIDÉE ; une révision de poste Ad & Pro se reporte
  sur la déclaration non validée (`engine.ts:reporterLesPostesSurLaDeclaration`).
### FICHES DE VOYAGE CHEZ L'ASSISTANTE : UNE PAR UNE, SUIVIES JUSQU'AU BILLET (2026-10-14)

Migration `20270122090000_demandes_reservation_fiche` (idempotente) : table `DemandeReservation`, enums
`EtatDemandeReservation` / `NatureFicheReservation`, contrainte `DemandeReservation_une_fiche`, reprise des envois en bloc.
Règles : `lib/reservation-fiche/etat.ts` (pur, testé) — voir « Fiches de voyage chez l'assistante » dans la référence des circuits.

- **Chaque fiche part seule** (voyageur d'une billetterie, fiche hôtellerie, billet / hôtel d'une prise en charge) : pastille
  d'état et sous-état (« depuis 2 j · relancée 1 fois ») sur la fiche, bandeau du poste, « Envoyer les fiches prêtes (n) »
  (un raccourci : fiche par fiche). L'ancien « Demander la réservation » (en bloc) et « Retirer la demande de réservation »
  disparaissent des écrans ; leurs actions restent (compatibilité).
- **Relance** une fois par 24 h ; elle prévient celle qui a pris la fiche, sinon toutes les assistantes actives.
- **Bureau du secrétariat** : onglets « Général » (inchangé) et « Ad & Pro » (`?onglet=adpro`) — tuiles, filtre, file groupée
  par opération, panneau de fiche (prendre, signaler un manque, joindre le devis de l'agence, déposer le billet, pièces, fil).
- **Une fiche modifiée après l'envoi** passe « à renvoyer » ; l'assistante voit les champs changés et ne réserve pas avant le renvoi.
- **Réservation après l'accord** du poste (ou de la personne) ; l'envoi pour devis est possible avant.
### ÉQUIPE ADVENTUM : LES FRAIS DE L'ÉQUIPE INTERNE AU BUDGET OPERATIONS & SALES (2026-10-14)

Aucune migration. « Ici le budget à imputer, ce n'est pas Ad & Pro, c'est Operations & Sales. »

- Colonne **Imputation** de la carte « Équipe Adventum » et carte « Imputation des frais » de la mission : catégories du
  budget Operations & Sales de l'année (enveloppe ouverte d'office), « Frais de déplacement terrain » par défaut, posée
  dès l'invitation ; plus aucune ligne Ad & Pro proposée. Choix : Direction Marketing, Direction des opérations, Super Admin.
- **Frais de l'équipe à la clôture** : une ligne de dépense Operations & Sales au lieu d'un poste Ad & Pro.
- **Budget Operations & Sales** : compte aussi la note de frais de mission (engagée puis consommée) ; Ad & Pro ne voit
  plus rien de l'équipe interne. Les anciennes imputations / anciens postes Ad & Pro restent lisibles tels quels.

### PRISES EN CHARGE : LIVRETS DE SÉJOUR EN PDF, SELON LA CHARTE ADVENTUM (2026-10-11)

Aucune migration. Règles : `lib/livret/modele.ts` (pur, testé) — voir « Fiches voyageur » dans la référence des circuits.

- **Livret individuel** (bouton « Livret » de la fiche voyageur, et sur `…/billets`) : couverture, lettre d'invitation
  sur le papier à en-tête (mentions légales), voyage (vols, n°, heures, PNR, transferts), hébergement (hôtel, nuits,
  chambre, confirmation, repas, accès), planning jour par jour trié, contacts (équipe sur place, assistante de direction),
  à emporter. **Livret général** (« Livret général » sur la demande) : délégation et vols, chambres et repas du groupe,
  programme commun, équipe Adventum (dates convenues, billet), dos.
- **Charte** : logo horizontal officiel (le vertical est retiré), jamais déformé ; bleu 2945 C pour les titres, teal
  7714 C pour les sous-titres ; Calibri embarquée en Carlito (OFL) + Helvetica ; puces carrées, mosaïque de carrés, pied
  du papier à en-tête. Absent → « à confirmer » ; aucun montant, devis ni passeport.
- Rangé dans les pièces de la demande (SUPPORTING_DOC, nouvelle version à chaque génération) ; la page de mission d'un
  membre de l'équipe lie le dernier « Livret de la délégation ».
- **Assistante de direction** : passeports (depuis son sujet de réservation), billets émis, vouchers et livrets
  s'ouvrent désormais pour elle (`peutLirePieceDePriseEnCharge`, miroir de la porte du sponsoring).
- Fiche voyageur : le ⋯ d'un « autre poste » rattache de nouveau un **support promotionnel**.

### BUDGET MARKETING : VUE D'ENSEMBLE REFAITE — DISPONIBLE, À TRAITER, SIX GRAPHIQUES FILTRABLES, EXPORTS, RÉALLOUER ; ENGAGÉ ET DATES CORRIGÉS (2026-10-11)

- **Un disponible** (enveloppe − payé − engagé), son rythme face à l'année, une barre payé / engagé / disponible avec le
  repère du jour ; « À traiter » (dépassement → Réallouer, sans catégorie → Les imputer, répartition > enveloppe → Ajuster) ;
  filtres période / catégorie / N-1 appliqués aux six graphiques et aux exports (Excel 5 feuilles, PDF, CSV, PowerPoint,
  PNG par graphique) ; tableau « Par catégorie » et détail par demande. Calculs purs : `lib/budget/marketing-vue.ts`.
- **Engagé = 0 corrigé à la source** (`queries/budget-sources.ts`, règle `lib/budget/engage.ts`) : ordres de dépense émis
  non réglés + BC émis des postes accordés, moins le déjà payé — l'ancien calcul ne lisait que des écritures `PENDING`
  que le circuit n'écrit jamais. **Courbe datée par la dépense** (date saisie, sinon règlement / date de la facture).
- **Réallouer** (`reallouerCategorie`) : Direction Marketing / Super Admin, motif obligatoire, journal de l'enveloppe.

### BUREAU DU SECRÉTARIAT : DIRECTEMENT À L'ASSISTANTE, DEUX GESTES, PLUS DE MISSION CHAUFFEUR NI DE DEMANDE MULTIPLE (2026-10-11)

Aucune migration : les valeurs retirées restent dans l'énumération pour relire l'existant. Règles :
`lib/secretariat/traitement.ts` (pur, testé) — voir « Bureau du secrétariat — flux par demande ».

- **Nouvelle demande** : plus de « Personne concernée » ni de « Responsable » — elle va directement aux assistantes de
  direction (notifiées ; celle qui commence en devient responsable). Le demandeur peut ajouter des **participants**
  (`fields.participantIds`), qui lisent la demande.
- **Deux gestes** : « Commencer le traitement » → le demandeur lit « En cours — chez l'assistante de direction »,
  « Fin du traitement » → « Traitée » ; il est notifié aux deux pas (lien vers la demande). Retirés de la fiche : en
  attente d'un tiers / d'un document, bloquer, reprendre, validation Finances / interne, mission chauffeur. Restent
  « Annuler la demande… », « Rouvrir… » (demande traitée) et « Supprimer la demande ».
- **Anciennes demandes** : « en attente d'un tiers / d'un document » et « bloquée » à la main se lisent « En cours » et
  se terminent par « Fin du traitement ». « Mission chauffeur » se relit, ne se crée plus (formulaire, assistant) ;
  `createMission` et `createRequestBatch` (demande multiple) sont retirées, les courses déjà posées se mènent encore.

### MISSIONS DE L'ÉQUIPE ADVENTUM : DEMANDE DE PARTICIPATION, CONTRE-PROPOSITIONS, OM EN UN CLIC, BILLET / HÔTEL PAR MEMBRE, NOTES DE FRAIS ET CLÔTURE (2026-10-11)

Migration additive et idempotente `20270120090000_mission_equipe_participation` (`MissionParticipationVersion`,
`MissionExpenseLine` ; accord, billet, hôtel, réservation, imputation, rapport et clôture sur `MissionAssignment`).
Règles : `lib/missions-equipe/participation.ts` — voir « Demande de participation » dans la référence des circuits.

- **Équipe Adventum** : « Inviter à participer » ; colonnes Où en est-on (« état — chez qui ») · Transport · Hébergement ·
  Ordre de mission · Imputation (Direction Marketing) ; « Répondre » quand la balle est chez Adventum.
- **Fiche de participation** puis versions négociées (accepter, refuser motivé, modifier et contre-proposer), changements
  surlignés, fil de commentaires jusqu'à la clôture ; arbitres : organisateur, Direction Marketing, Super Admin.
- **Accord → ordre de mission en un clic**, pré-rempli ; à l'émission, réservation à l'assistante de direction et dépôt du
  billet émis / de la confirmation d'hôtel par membre.
- **Ma mission** (`/mon-espace/missions/[id]`) : avant le départ (OM, billet, hôtel, rôle et professionnels accompagnés),
  après (dépenses USD hors billet au taux figé, justificatifs, rapport), clôture → note de frais N+1 puis RH, rapport à
  l'organisateur.

### PRISES EN CHARGE : FICHES VOYAGEUR, MODE INDIVIDUEL / DE GROUPE, DOLLAR À L'INTERNATIONAL, BILLETS ÉMIS (2026-10-11)

Migration additive et idempotente `20270119090000_fiches_voyageur_prise_en_charge` (`CareMode`, `CareCurrency`,
`CareGroupPoste` ; colonnes de détail, de montant saisi et de billet émis sur `CareCell` ; montant, devise, catégorie,
retenu et BC demandé sur `CareQuote` ; `careMode`, `usdDzdRate`, `initiativeDoctorIds`, `careReservationDossierId` sur
les deux congrès). Règles : `lib/care-fiches.ts` — voir « Fiches voyageur » dans la référence des circuits.

- **Création** : l'événement seul (ville et pays séparés), le mode de prise en charge, et pour « Initiative du médecin »
  le ou les médecins d'origine ; on atterrit sur les professionnels de la demande.
- **Liste « Professionnels pris en charge »** : un tableau (colonne du nom fixe au téléphone), une ligne par personne
  — billetterie, hôtellerie, autres postes, estimé, décision ; « Demander la réservation (N prêtes) », « Demander le BC ».
- **Fiche voyageur** : billet (aller / aller-retour / multi-destinations), hôtel pré-rempli (ville de l'événement, dates du
  billet), « sans billet / sans hôtel », un « + » par catégorie, prochain geste, documents, décision, total.
- **International** : tout sauf la billetterie en dollars, converti au taux figé de la demande (1 USD = 240 DZD).
- **Billet émis / confirmation d'hôtel** : e-billet ou voucher, PNR / n° de confirmation, n° de vol et horaires par trajet ;
  heure et lieu des autres postes — page `…/[id]/billets` ouverte à l'assistante de direction.

### MANQUES COMBLÉS : LIENS DE NOTIFICATION EXACTS, KPI DEMANDES TRAITÉES / PCH / CIBLE LUNA, STOCKS PCH CENTRAL + DR, INFO MÉDICALE PAR PRODUIT, DATE DE BESOIN DU MATÉRIEL PROMO (2026-10-10)

Commit `4d3e3325`. Migrations additives et idempotentes : `20270118150000_kpi_complements`
(`SupportRequest.resolvedAt`, `HrDocumentRequest.handledAt`, rattrapage sans estimation) et
`20270118150000_complements_stocks_infomed` (`StockSnapshot.drCode`, `MedicalInfoDeclaration.productId`,
`PromoMaterial.neededBy`) — tables distinctes, même horodatage, noms distincts.

- **Notifications / tâches / rapports / absences** : liens de notification menant à l'ancre exacte
  (`lib/chemins/*`, `components/shared/surligner-cible.tsx`), invitations de mission visibles dans Tâches, rapports de
  terrain par délégué, et **absences : un encadrant lit « Congé » (annuel, sans solde, récupération) ou « Absent »,
  jamais la nature médicale** ; le type précis reste aux RH (`natureDeLAbsence`, `voitLeTypeDesAbsences`,
  `lib/hr/confidentialite.ts`).
- **KPI** : briques `DEMANDES_TRAITEES` et `DELAI_DEMANDES` (support, demandes RH, demandes administratives, datées
  par `resolvedAt` / `handledAt` / `completedAt`), `LIVRE_PCH`, `NON_SERVI_PCH`, `EXECUTION_MARCHES`
  (`lib/kpi/briques.ts`, `briques-pch.ts`) ; cible Luna (`kpi/luna-cible.ts`) ; alertes de la force de vente sur le requis.
- **Stocks** : sources = **PCH central + DR** (`StockSnapshot.drCode`, scope ANNEX) et relevés des hôpitaux — **pas de
  stock propre Adventum** ; relevé PCH lu depuis un fichier (`lireReleveStockPch`, lecture seule) ; Logistique retiré du
  cockpit des opérations ; **part de nos lots** dans l'Intelligence terrain (`lib/influence/parts-lots.ts`).
- **Information médicale** : `MedicalInfoDeclaration.productId` (corrigé par `changerProduitDeclaration`).
- **Matériel promotionnel** : date de besoin du demandeur `PromoMaterial.neededBy` (`modifierDateBesoinPromo`).

### WILAYA PIVOT, BC EN BROUILLON ET REGISTRE NNN/DG/AAAA, NOTIFICATIONS À L'ACTION EXACTE, COCKPITS « TERRAIN », PRODUITS 360 V2, CAMPAGNE BUDGÉTAIRE, ORGANIGRAMME SOURCE UNIQUE, INTELLIGENCE TERRAIN (2026-10-09)

Commits `b06dcfb1`, `e8928d0b`, `3af65afa`, `c149c5ed`, `ae1e4fdf`, `4d950789`, `9ddcc340`, `1ebbd379`, `fd90e82e`.
Migrations additives et idempotentes : `20270117110500_wilaya_pivot`, `20270117120500_ventes_pch_periode`,
`20270117130500_bc_numerotation`, `20270117131000_bc_brouillon`, `20270117140000_bc_numerotation_040`,
`20270117150000_promo_bc_brouillon_article_libre`, `20270117160000_registre_dg`, `20270117183000_besoins_services`,
`20270118100000_campagne_budgetaire`, `20270118120000_intelligence_terrain`.

- **Territoires** : **wilaya pivot** choisie par territoire KAM (menu des 58 wilayas, `SalesSector.wilayaPivot`) — elle
  décide l'In / Out de la segmentation (`lib/segmentation/in-out.ts`) ; un nom occupé seulement par un ancien secteur
  désactivé est libéré (l'ancien devient « … (ancien) »).
- **Médecins concernés des demandes Ad & Pro** (`AdProMedecin`) : sponsoring, événements, congrès, matériel, autres
  demandes reliés aux praticiens de l'annuaire — lus par le Marketing cockpit, la fiche praticien, Produits 360, le ROI.
- **Terrain** : plans de tournée **brouillons supprimables** (jamais si une visite est rapportée) ; Ma journée : CTA
  « rapport terrain » ; **Ventes PCH** : mois / année choisis par fichier à l'import ; **masse salariale** Operations &
  Sales : la Direction des opérations s'ajoute aux BU.
- **Bons de commande** : générer dépose un **brouillon à vérifier par le demandeur** (aucun numéro, rien aux Finances) ;
  « Valider et envoyer aux Finances » attribue le numéro ; **registre commun NNN/DG/AAAA** (BC, ordres de mission,
  lettres de demande de devis, pièces au motif /DG/) — un compteur par société et par an, numéro **modifiable**,
  2026 démarre à **040/DG/2026** pour Adventum, Pharmagène et AMD ; devis téléversés cliquables.
- **Notifications** : 82 liens corrigés à la source vers l'action exacte ; les anciennes notifications sont réécrites
  à l'affichage (`lib/notifications/lien-actuel.ts`) — plus de 404.
- **Matériel promotionnel** : fiche refondue (frise de huit étapes, cinq chiffres, une chose à faire, devis côte à
  côte), BC en brouillon automatique à la dernière validation, « Autre article » hors catalogue.
- **Marketing cockpit — « Ce qui dépend vraiment du terrain »** : décideurs engagés, conversions B → A, affinité Q2/Q1,
  nos lots chez les hôpitaux, **besoins annuels des services** (`BesoinAnnuelService`), **voix du terrain** (Luna,
  citations mot pour mot). **Cockpit Opérations** : l'équipe aujourd'hui, visites du jour, ruptures signalées, stocks
  relevés dans les hôpitaux, score KPI, semaine.
- **Retours & réclamations retiré** (module, écran, actions, règles ; la table `Reclamation` reste).
- **Budget Regulatory** (4 chiffres, graphiques, Prochains BV) et **Moyens généraux** (3 chiffres, dépenses par mois,
  panneau) allégés.
- **Produits 360 v2** : **note de santé /100** (Stock 25 · Terrain 25 · Prescripteurs 20 · Réglementaire 15 · Qualité
  15, composante sans donnée exclue et renormalisée), anneau cliquable, portefeuille trié par santé, comparer 2 à 4
  produits, « Luna — l'essentiel ce mois ».
- **Campagne budgétaire** (`/budget-campagne`, `BUDGET_CAMPAIGN`) : propositions par pôle pré-remplies, examen ligne
  par ligne, allers-retours versionnés, **cadrage DG privé**, **validation DG + Super Admin**, pas de révision sans
  autorisation du Super Admin, enveloppes ouvertes automatiquement (idempotent).
- **Organigramme, seule source** : le département de la fiche salarié fait foi (libellé et compte dérivés) ;
  **contrôle de cohérence** Super Admin avec corrections d'un clic.
- **Intelligence terrain** (`/admin/intelligence-terrain`, **Super Admin seul**) : graphe d'influence hospitalière
  (liens structurels + liens proposés par Luna, confirmés à la main ; score 0–100 explicable ; analyse quotidienne) et
  **ROI Ad & Pro** (différence des différences contre des médecins semblables, fourchette, seuil de données).

Documentation : panorama, rôles, sommaire, référence des circuits (nouvelles sections Campagne budgétaire,
Organigramme source unique, Intelligence terrain, Notifications ; Produits 360, Operations & Sales, Business Units,
Marketing cockpit, Fabrique de documents, Budgets des pôles, Moyens généraux réécrits), carte du code, modèle de données.

### OPERATIONS & SALES, MARKETING SÉPARÉ, CATALOGUE UNIQUE, IMPORT DE SEGMENTATION EN UN FICHIER, BUSINESS UNITS, BUDGETS DES PÔLES, KPI SANS CODE, MISSIONS RELIÉES AU PROFIL (2026-10-08/09)

Commits `2fd508ad`, `88c1a130`, `ac6565ec`, `f5a34ea0`. Migrations additives et idempotentes :
`20270115203000_acces_pipeline`, `20270116090000_budget_marketing`, `20270116100000_module_business_units`,
`20270116143000_retours_reclamations`, `20270116160000_ventes_pch`, `20270116170000_missions_profil`,
`20270117090000_kpi`, `20270117100000_budget_regulatory_operations`.

- **Menu en pôles** : « Sales & Marketing » scindé en **Marketing** (Marketing cockpit, Segmentation, Produits 360, Ad &
  Pro, Budget Marketing, Stock promotionnel, **Site web** — venu de l'Administration) et **Operations & Sales** ; le pôle
  **Supply Chain & Logistics disparaît** (Stocks et Logistique rejoignent Operations & Sales) ; **Consommation** n'a plus
  d'entrée de menu (écrans et données gardés). `NAV_POLES`, `lib/navigation.ts`.
- **Force de vente** : « ⋯ › Business units / Secteurs » ne plante plus (2fd508ad — les étapes vivaient dans un module
  client lu côté serveur : `business-units/etapes.ts`, neutre) ; puis le « ⋯ Réglages » disparaît : module **Business
  Units** (`/business-units` : BU, Secteurs — territoires **nommables** sur place, `renommerSecteur` —, Paramètres),
  défaut recopié de qui modifiait la Force de vente. **Mon Équipe** : colonne « Personne » réduite de moitié.
- **Catalogue unique** (88c1a130) : **un dossier réglementaire = un produit**, créé ou mis à jour automatiquement
  (création, modification, ouverture du cadenas, passage au démarrage ; identité incomplète = indication, jamais
  blocage ; aucun produit partagé scindé d'office) ; « **Vérifier le catalogue** » (Super Admin) ; l'écran « Rattachement
  au catalogue » est retiré (`/regulatory/catalogue` → `/produits`), il ne reste que **« Rapprocher un produit BD / BU »**
  (`/produits/rapprocher`). `lib/products/produit-du-dossier.ts`.
- **Segmentation** : **import en un fichier** du classeur de la Direction (`/segmentation/import` — règles lues et
  publiées, annuaires reliés : établissement par clé souple, wilaya lue dans le nom, spécialités dédoublées ; la lettre
  du fichier fait foi, en dérogation motivée ; même fichier = rien) ; **affinité Q2 ÷ Q1** ; potentiel 0 → NA
  (`potentielNulNA`) ; **tableau Praticiens éditable** (tri, filtres dans l'URL, effacer une réponse, retirer de la
  segmentation ou de l'annuaire).
- **Pipeline réglementaire** : module à part `REGULATORY_PIPELINE` (deux clés : module + confidence ; mêmes gestes que
  Regulatory par défaut, accès personnalisés recopiés).
- **Operations & Sales** (f5a34ea0) : **Cockpit Opérations** (`/operations`, lecture seule, un seul client : la PCH) ;
  **Ventes PCH** remplace la saisie Ventes (`/sales` : imports des fichiers mensuels des DR `VENTEDR*` et des réceptions
  PCH annuelles ou mensuelles, remplacement par tranche, mémoire des postes `PchPoste` et des établissements, contrats et
  **avenants** `PchOrder.estAvenant`, non servi, territoires, historique en lecture seule) ; **Stocks de la chaîne**
  (couverture par BU) et **stock PCH central saisi** depuis le mail ; **Retours & réclamations** (`Reclamation`, déclarée
  par le KAM, instruite jusqu'à la clôture) ; **directeur des opérations** : Force de vente et Business Units en gestion,
  Adventum Brain **borné à son périmètre** (`lib/adventum/perimetre.ts`).
- **Budgets des pôles** : **Budget Marketing** (ac6565ec), **Budget Regulatory** (BV 25 % en préparation / 75 % avant
  dépôt, par dossier) et **Budget Operations & Sales** (masse salariale agrégée de la force de vente, dépenses hors Ad &
  Pro) — mêmes enveloppes que Budgets, marquées `domaine` ; Budgets les lit sans les régler. `lib/budget/domaines.ts`.
- **KPI sans code** : module `KPI` ouvert à tous, périmètre = l'arbre de Mon équipe ; briques écrites une fois,
  définitions créées à l'écran avec Luna (aperçu sur 3 mois réels), score pondéré plafonné à 120, KPI évalués / déclarés,
  revue signée ; **Mon équipe › KPI**, **Mon espace › Mon bilan**, **Administration › KPI & modèles** (modèle KAM, 6
  KPI) ; « Proposer une nouvelle mesure » remonte au Super Admin.
- **Missions Ad & Pro reliées au profil** : assigner = **inviter** (confirmer / décliner avec motif), carte « Équipe
  Adventum », **Mon espace › Mes missions** (`/missions` y renvoie) — l'ordre de mission passe par le **N+1** puis les RH,
  transport / hébergement / matériel / note de frais seulement à la demande ; « Frais de l'équipe » intégrés au budget à
  la clôture, à la main.
- Puis (lot suivant) : **Produits 360 › Ventes & marchés lit les données Ventes PCH** (réceptions PCH, distribution
  DR, part de marché fournisseurs, chaîne contrat).

Documentation : panorama, rôles (directeur des opérations, Direction Marketing, Regulatory), référence des circuits
(nouvelles sections Business Units, Operations & Sales, KPI & bilans, Missions, Budgets des pôles ; Produits 360,
pipeline, Force de vente réécrits — la référence passe à **quatre parties**, `12-…-p04.md`), carte du code, Segmentation
Studio, Brain, modèle de données.

### REFONTES VALIDÉES PAR LA DIRECTION — SEGMENTATION PAR BU, FORCE DE VENTE, MARKETING COCKPIT, MON ÉQUIPE, RECRUTEMENT, AUDIENCE, RAPPORTS TERRAIN, TÂCHES, INFORMATION MÉDICALE, PRODUITS 360, BRAIN & PROCESS INTELLIGENCE (2026-10-07/08)

Commit `28b1988e` (maquettes validées). Migrations additives et idempotentes : `20270115100000_recrutement_suivi_canaux`,
`20270115110000_site_audience`, `20270115120000_segmentation_secteurs`, `20270115140000_cockpit_marketing_auteurs`,
`20270115180000_brain_process`, `20270115183000_prix_produit`.

- **Segmentation par BU** : Synthèse par secteur (H→NA × In/Out, charge vs capacité), Praticiens aux colonnes du fichier
  (Q1/Q2/statut en ligne), Règles versionnées (22 patients/sem, affinité > 10 %, exceptions par secteur, fréquences H à
  part) ; `SegmentationFiche.secteurId` ; **forcer une lettre** = droit `SEGMENTATION_POTENTIEL`, accordé par le Super
  Admin personne par personne. → [Segmentation Studio](#segmentation-studio-module-segmentation-segmentation)
- **La lettre partout, un seul « requis »** (`lib/segmentation/lettre-requise.ts`) : Force de vente, Marketing cockpit,
  Ma journée, plan de tournée et son PDF.
- **Force de vente** : onglets Pilotage · Territoires · Produits (`SALES_PLANNING_TABS`), fiche délégué, cibles H/A hors
  panel affectées en un clic, réglages sous « ⋯ » ; lecteur de pilotage en lecture seule (`resolveRepScope`).
- **Marketing cockpit** : Vue d'ensemble · Leaders d'opinion · Messages · Marché · Investissements ; message porté
  **archivé** ; Direction Marketing (`PRODUCT_MANAGER`) autrice par défaut ; **Spécialités → Annuaires** (porte unique).
- **Mon Équipe** : vue d'ensemble, équipe, calendrier, panneau personne (`queries/my-team-overview.ts`).
- **Recrutement** : module RH à part ; **tout le monde demande** ; chaîne jusqu'au DG ; le DG désigne le N+1 et le suivi ;
  diffusion site / LinkedIn (post Luna, publié à la main) / Emploitic (à brancher).
- **Audience du site** : `audience.js` → `POST /api/site-web/v1/audience`, sans cookie, tableau `/site-web/audience`.
- **Rapports terrain** : onglet « Rapports » de la Promotion médicale (`/medical/rapports`), rapport fait depuis le
  planning ; `/field-reports…` redirige.
- **Mon espace** : onglet **Tâches** (à accepter / à faire / demandées / partagées / terminées, réattribution) ; onglet
  Directives et « Mes demandes d'achat » **retirés** (achats via le Bureau du secrétariat).
- **Information médicale** : liste « état — chez qui » + produit, frise + une action, relance des pièces (4 h).
- **Produits 360** : catalogue unique (produit = dossier), fiche à onglets, prix manuels historisés (`ProductPrice`) ;
  `/regulatory/catalogue` = « Rattachement au catalogue », sa fiche redirige.
- **Adventum Brain** : Ce matin (briefing 7 h gardé et sourcé) · Risques à cycle de vie (`BrainRisk`) · Demander
  (`BrainQuestion`) · Historique ; 8 détecteurs ajoutés. **Process Intelligence** : temps réel par étape (journaux),
  délais cibles (`ProcessStepSla`), vues Circuits · Personnes · Plateforme. Anciens War Room / Feed / Relations retirés.
- **Annuaire médical** (08/10) : chaque ligne mène à la fiche `/praticiens/[id]`.

Références : panorama, [Force de vente — pilotage, territoires, produits](#force-de-vente--pilotage-territoires-produits-refonte-du-0710),
[Marketing cockpit](#marketing-cockpit--le-tableau-de-la-direction-marketing-refonte-du-0710),
[Produits 360](#produits-360--un-seul-catalogue-le-produit--son-dossier-0710), [Adventum Brain](#-adventum-brain-cockpit-super-admin).

### INTÉGRATION DU 05/10 — MOYENS GÉNÉRAUX RESTAURÉS, STOCKAGE DES GROS FICHIERS, COUCHE DE CONNAISSANCE, DOUBLE CONFIRMATION (2026-10-05)

- **Moyens généraux** : la page redevient exactement ce qu'elle était (caisse, dépenses, rallonges, service) ; seul le **catalogue d'articles** reste dans l'en-tête, il n'y a plus de vue par département.
- **Pièces Legal** rattachées à une demande Ad & Pro : de nouveau affichées sur sa fiche. Luna conseille le rangement depuis « + Pièce jointe ». La création des spécialités revient à la Direction des opérations et au Directeur des Opérations.
- **Annulations** : retrait d'une demande de devis du matériel promotionnel, « Annuler la demande de BC » (annule le BC non signé puis la demande), retrait d'une demande de réservation.
- **Double confirmation** sur les boutons décisifs (composant partagé `bouton-decisif`).
- **Stockage** : plus de fiche sans fichier ; purge des orphelins gardée par le schéma ; envoi **direct au bucket** (parties de 32 Mo, reprise) pour les gros fichiers ; CTD lu en flux ; une seule politique de types (blocage des programmes et scripts). Mode d'emploi : `docs/stockage-gros-fichiers.md`.
- **Couche de connaissance** : une panne temporaire n'est plus un échec ; la boîte morte se lit par cause et se relance ; rattrapage de la vectorisation.
- Détails et leçons : `CLAUDE.md` §118.205.

### POSTES AD & PRO EN DEUX TEMPS, CHAÎNE DEVIS → BC → FACTURE SUR LE POSTE, TERRITOIRES DES KAM, PAIE PAR ENTITÉ, ANNULER SA DEMANDE (2026-10-04)

- **Validation d'un poste en deux temps** (`lib/ad-pro/validation-poste.ts`) : Direction des opérations (`DIRECTION`) puis Direction Marketing (`PRODUCT_MANAGER`), qui fixe le montant ET choisit le budget (exigé). Demande déposée par la Direction Marketing → la Direction des opérations tient aussi le second temps ; déposée par la Direction des opérations → premier temps franchi à la soumission. Un brouillon ne s'accorde pas ; un refus au premier temps se revoit par la Direction des opérations. Mon espace ne montre à chacun que le temps qu'il tient (lu par lots, sans coupe silencieuse).
- **Pièces d'achat SUR le poste** (`AdProItemPiece`, `lib/ad-pro/pieces-poste.ts`) : devis / pro forma (un même devis peut couvrir plusieurs postes de la demande, `ajouterDevisPoste`) → bon de commande → facture. Le BC se demande à une **assistante de direction** par une demande de pièce (`/pieces`) ; déposé puis accepté par le demandeur, il revient au poste (`classerDansLegal` → `rattacherPieceAuPoste`, société de la demande, sans restriction de lecteurs pour que la signature des Finances le voie). Au-dessus du seuil, le centre Ad & Pro le vise en parallèle. La **facture est obligatoire** pour demander le paiement (`demanderPaiementPoste`, ≤ montant accordé, après signature du BC) ; « Émettre le bon de commande » (`emitItemExpenseOrder`) est supprimé. **Sponsoring direct** : pas de BC, pro forma facultative, facture → paiement. Le demandeur annule sa demande de paiement tant qu'elle n'est pas réglée (sa facture est annulée avec l'ordre). Qui voit la demande lit les pièces de ses postes (`accesAuxPiecesLegalDetaille`).
- **Écran** : carte de poste épurée (un seul geste, trois cases Devis → BC → Facture, le reste dans « ⋯ ») ; bloc « Pièces liées » retiré des fiches Sponsoring/Congrès/Événements, remplacé par « + Pièce jointe » dans les Détails de la demande ; échanges des personnes impliquées dans la Discussion.
- **Luna conseille où ranger une pièce** (`lib/conseil-pieces-ia.ts`, `ad-pro-conseil-actions.ts`, `conseil-luna.tsx`) : consultatif, une lecture après un dépôt, bascule `conseilPiecesEnabled`.
- **Voyageurs de billetterie** : aller simple / aller-retour, avion/train/bus/taxi, passeport, devis par voyageur (`AdProVoyageurDevis`), devis retenu puis demande de BC.
- **Territoire de chaque KAM** (BU hospitalière) : établissements et services sur la ligne du KAM (`SalesSector.repId`), « Secteurs de la BU » retiré ; un panel vide dit sa vraie cause (`sfe/panel-diagnostic.ts`).
- **Rapport terrain** : bloc « Matériel remis » (déduit du stock du KAM, `PromoStockMovement.fieldReportId`). **Moyens généraux** : seul le catalogue d'articles est montré.
- **Paie** : masse mensuelle et annuelle par entité, salariés sans entité nommés et rattachables (fiche salarié). **Comptabilité** : la paie compte dans son MOIS de paie ; période 1/3/6 mois, 1 an ou du… au….
- **Prises en charge** : « Professionnels proposés pour la prise en charge » (une seule liste), pièces (passeport, visa) suivies par personne ; Pays/Délégués/Spécialité/Produits retirés de la saisie.
- **Annuler sa demande tant qu'elle n'est pas exécutée** : paiement validé non réglé, tâche demandée, validation en cours, recrutement jusqu'à l'embauche, document RH, formation, rallonges, ordre de mission, achat validé ; une pièce DÉPOSÉE ne s'annule plus (elle se juge).
- Migrations : `20270106090000_postes_chaine_pieces`, `20270106093000_territoire_kam`, `20270106100000_conseil_pieces`, `20270106110000_remises_rapport_terrain`, `20270107090000_prise_en_charge_professionnels`, `20270107090000_promo_devis_automatiques`, `20270107100000_voyageurs_trajet_devis`, `20270107140000_annuler_sa_demande`.

### POSTES AD & PRO : CEUX QUI DÉCIDENT SONT PRÉVENUS ; LECTURE DES PIÈCES PAR LUNA ET DEVIS PRÉREMPLI (2026-10)

- **Notifications des postes** (`ad-pro-item-actions.ts:valideursDuPoste`) : la soumission et la demande de révision d'un poste préviennent les rôles que la MATRICE laisse décider (`rolesWithModule(module, "VALIDATE")` + Direction + Super Admin) — la Direction Marketing sur un congrès comprise ; un poste ajouté hors budget ou après la décision est signalé en lecture aux mêmes personnes. Banc `ad-pro/postes-notifications.test.ts`.
- **Lecture des pièces (lot D2-D/E)** : service `pieces-lues/service.ts` (`proposerLecture`, confirmation obligatoire avant écriture), devis promo prérempli depuis le scan (`lireScanDevisPromo`, `quotes-card.tsx`). Un scan est lu par **Luna** (`pieces-lues/moteur-luna.ts`) quand la pièce peut sortir et que la bascule « lecture des pièces » est ouverte ; sinon moteur local, jamais d'OCR externe ; une pièce confidentielle ne part jamais.

### VAGUE « RESTES 2 » : UNE PIÈCE VALIDÉE RELIT SA DEMANDE, UNE SEULE RÈGLE DE DÉPART DES COMPTAGES, UN LIVRABLE REPRIS N'EST PLUS VÉRIFIÉ (2026-10)

Quatre défauts que la vague « restes » avait nommés sans les réparer. Doctrine : `CLAUDE.md` §118.199.

- **Secrétariat** (`actions/validation-actions.ts` : `decideValidation`) : une pièce validée n'émet plus de paiement
  pour une demande annulée ou supprimée — la demande est relue avant l'émission et après (l'ordre né pendant une
  annulation est annulé par la porte unique) ; l'accord sur la pièce reste enregistré, et la phrase le dit.
- **Comptages récurrents** (`promo-stock-comptages.ts` : `peutDeclencherRecurrence`) : le battement et la reprise lisent
  la même règle de départ, avec le même motif ; une récurrence qui a perdu sa personne ne nomme plus « le magasin
  central ».
- **Réglages de l'IA** (`ai-settings.test.ts`) : le banc n'écrit plus la ligne `AiSetting` que toute la suite lit.
- **Missions** (`missions/artifacts/build.ts`) : un livrable repris sur d'autres données repart à « en attente » — il ne
  compte plus comme produit si sa recomposition échoue.

### VAGUE « RESTES » + LOT D2 (FONDATIONS) : CE QUE LA VAGUE PRÉCÉDENTE AVAIT NOMMÉ, ET LIRE UNE PIÈCE UNE SEULE FOIS (2026-10)

Les défauts nommés sans être réparés par la vague précédente, et les fondations de la lecture des pièces commerciales
(rapport 19, plan du lot D2). Cinq agents sur des fichiers disjoints. Doctrine : `CLAUDE.md` §118.198.

- **Matériel promotionnel** (`actions/promo-material-actions.ts`, `promo-circuit-actions.ts`, `promo-execution-actions.ts`,
  `promo-comptage-actions.ts`) : l'annulation d'un dossier passe par l'annulation commune de sa demande au secrétariat
  (une demande au paiement réglé reste ouverte, et la phrase le dit) et annule les ordres non réglés de l'ancien
  parcours ; elle compte les BC ACTIFS dans la file de la génération ; les quatorze marches de l'ancien parcours, la
  réception du devis, l'initiation du paiement et le règlement s'écrivent sur l'état lu ; la reprise d'une récurrence
  de comptage relit la personne visée.
- **Secrétariat** (`secretariat/annulation.ts`) : les ordres à annuler se relisent APRÈS l'écriture conditionnelle.
- **Legal** (`queries/legal-chain.ts` : `loadLegalChain(docId, user)`) : un maillon de la chaîne que la personne ne lit
  pas garde sa place et sa nature, sous un libellé neutre, sans titre, montant ni validateurs.
- **PCH** (`actions/pch-tender-line-actions.ts`, `admin-delete-registry.ts` : `PCH_TENDER_LINE`) : un lot d'AO part à
  la corbeille, avec ses affectations aux BU, et refuse quand un BC, un contrat, une vente sous marché ou une répartition
  Ad & Pro en découle (« Lot annulé ») ; modifier un lot n'écrit plus ce que le formulaire ne porte pas ; la case
  « Nous l'avons » se décoche.
- **Missions — livrables frères** (`missions/artifacts/build.ts`) : réserver et désigner l'auteur sous verrou
  consultatif ; un suiveur n'attend que la base de SES données.
- **Information médicale** (`actions/medical-info-actions.ts`) : le centre qui signe est le plus ancien siège, jamais
  le demandeur (`validations/siege-du-centre.test.ts`).
- **Étape `final` du moteur Ad & Pro** (`workflow/defaults.ts`, migration `20270104091000`) : sa description dit les
  deux routes.
- **Lot D2, fondations — sans appelant de production à ce jour** : le lecteur commun dit ce qu'il a fait et lit en
  local seulement sur demande (`extract/texte-ou-ocr.ts`, `ocr/ocr-engine.ts` : `cloud: false`) ; `LecturePiece`
  (migration `20270104090000`) lit une pièce une seule fois par empreinte (`pieces-lues/lecture-fichier.ts`) ; les
  règles pures de la lecture (`pieces-lues/`) ; les lignes par un modèle (`lecture-pieces-ia.ts`), coupées par défaut
  (bascule « Lecture des pièces déposées » du Contrôle de l'IA). Le service et les écrans suivent (D2-D à G2).
- **Intégration** : la carte d'Adam qui annule un dossier promo envoie le motif exigé ; le Centre de contrôle IA nomme
  toutes ses fonctions.

### AUDIT 360° — VAGUE E2–E5 + D1b + D1c + H : DÉCIDER EN UN ENDROIT, UNE ÉQUIPE ACTIONNABLE, UN INTÉRIM QUI NE PRÊTE QUE CE QU'ON DÉTIENT, UNE ROUTE COUPÉE QUI RETROUVE SON ARGENT (2026-10)

Rapport des managers (M09–M21, N2), rapport 19 (F1, F2) et deux défauts du moteur Ad & Pro trouvés en relisant le
circuit. Huit lots écrits en parallèle sur des fichiers disjoints. Doctrine : `CLAUDE.md` §118.197.

- **Mon espace, lieu de décision** (`queries/mes-decisions.ts`, `queries/action-center.ts`) : une ligne par objet ; un
  achat décidé ne reste plus « à traiter » ; les congés d'intérim ne s'affichent plus deux fois ; « À valider » compte les
  congés à signer ; la file du réviseur et du N+2 d'un plan de tournée (`sfe/tournee.ts` : `clausePlansADecider`) ;
  « En attente depuis … » daté à l'arrivée chez la personne.
- **Mon Équipe actionnable** (`queries/my-team.ts`, `queries/lien-ouvrable.ts`, `hr/absences.ts`) : cinq natures à
  décider (recrutement, plans de tournée compris) ; chaque chiffre mène à une page que la personne peut ouvrir — sinon
  la ligne disparaît ou nomme le remède ; « qui est là » au jour d'Alger ; chevauchements de congés sur 30 jours.
- **Intérim** (`rbac.ts` : `accesAttribue`, `hr/stand-in.ts` : `modulesPretables`) : on ne prête que ce que l'absent
  détient (matrice du rôle principal ∩ accès attribué) ; décision conditionnelle ; notification vers Mon espace ; bandeau
  d'intérim dans la coque (`components/layout/interim-banner.tsx`).
- **Approbations d'achat** (`secretariat/decision-approbation.ts`, migration `20270103090500`) : qui a tranché
  (`decidedById`) et pourquoi (`decisionNote`, exigé pour refuser ou faire modifier) ; jamais sa propre demande sauf le
  sommet ; écriture conditionnelle ; l'ordre émis est annulé si la demande l'a été pendant la décision ; la facture
  chaînée ne compte que si elle suit un devis ou un BC de la même fiche.
- **Matériel promotionnel — circuit 2** : la validation juge la sélection qu'elle a vue (`lignesVues`, relue sous
  `FOR UPDATE`) ; choix, correction, clôture et réouverture de la demande au secrétariat sous condition ; `servirDemande`
  prend la demande avant tout mouvement de stock.
- **PCH — lecture d'un AO tracée** (`pch/extraction.ts`, `pch/lecture-ao.ts`, `PchTenderExtraction`, migration
  `20270103094500`) : texte natif d'abord, coupe dite, fichier gardé ; une relecture ne remplace que les lignes que
  personne n'a touchées. Le compositeur chaîne un BC à son devis (`chainFromId`).
- **Moteur Ad & Pro** (`workflow/pouvoirs-argent.ts` : `argentEffectif`, `engine.ts` : `lectureDeLApprobation`) : une
  demande de la Direction Marketing ou du Manager Promotion médicale (route close à `final`) était approuvée sans
  montant ni ordre de dépense (12 sur 12 mesurées) ; l'étape qui conclut hérite désormais des pouvoirs d'argent des
  étapes non atteintes, et l'écran lit la même étape que le moteur. La signature de l'information médicale d'un
  sponsoring retrouve son référent.
- **README** : 124 corrections de la carte fonctionnelle, plus les lignes de chaque lot de cette vague.

### AUDIT 360° — LOT D1 (+ E1) : DES GARDES DÉTERMINISTES SUR LES PIÈCES, UN INTERRUPTEUR D'IA QUI COUPE ENFIN, UNE FILE DE CONGÉS QUI MONTRE CE QUE L'ACTION ACCEPTE (2026-10)

Rapport 19 de l'audit (F3, F5, F6, F7, F8, plus trois défauts manqués) et rapport des managers (M08, N1). Doctrine :
`CLAUDE.md` §118.196.

- **Doublon de factures : le même émetteur, pas le même numéro** (`lib/quality/model.ts` : `groupeReferenceFacture`,
  `memeEmetteur`, `jumellesDeReference`). « FA-2026-001 » existe chez chaque fournisseur : deux factures ne sont un
  doublon que reçues du même émetteur (partie de l'annuaire, puis nom plié) ou émises par la même société ; sans
  émetteur lisible d'un côté, 0,6 « émetteur à vérifier », avec le geste qui lève le doute.
- **BC contre factures : le CUMUL** (`depassementDuCumul`) : les factures d'une pièce amont, nettes de leurs avoirs,
  se cumulent par date ; le constat se pose sur la facture qui franchit le montant du BC, une fois. Facturer moins
  n'est pas une contradiction.
- **La réserve nocturne des clauses n'écrit que sa clé** (`ecrireCacheIntelligence`, `jsonb_set` sur
  `custom.intelligence`, sans dater la pièce) : elle recopiait un `custom` lu soixante pièces plus tôt et défaisait
  une révision de la fabrique validée entre-temps (version N+1 revenue à N, numéro de version réémis).
- **Moyens généraux : la pièce se juge avant la dépense** (`addDepartmentExpense`, `spendFromPettyCash`) : un fichier
  refusé laissait la dépense en base, imputée et sortie de la caisse, et la seconde tentative en créait une deuxième.
- **Devis du matériel promotionnel** : enregistrer, supprimer et terminer la retranscription s'écrivent sur l'étape
  LUE (écriture conditionnelle, verrou du dossier) ; le perdant d'une course reçoit « Ce dossier vient de changer
  d'étape — rechargez la fiche » et son scan déposé est retiré. **Le total imprimé est exigé pour terminer la
  retranscription** : sans lui, le contrôle à un dinar près ne comparait rien.
- **L'interrupteur général de l'IA** (« Contrôle de l'IA ») est lu par chaque porte qui parle à un fournisseur :
  `lib/ai.ts`, l'OCR (repli local Tesseract), le client Luna de l'intelligence réglementaire et la transcription des
  médias du Drive. Coupé, rien ne part (« L'IA est coupée par l'interrupteur général… »). **Effet en production** :
  si la ligne `AiSetting` porte déjà l'interrupteur coupé, ces analyses s'arrêtent au déploiement — le remède est de
  le rallumer sur ce même écran.
- **Le nom de la clé d'IA** n'est plus écrit en dur dans les refus (seize refus de PCH, RH, réunions, marché,
  Adventum, Regulatory, audit de plateforme, et deux de `lib/ai.ts`) : il se lit par `cleModeleRequise()`.
- **Petites choses vraies** : « contrat de travail » au lieu de « CV » sur deux écrans RH ; quatre montants qui
  avançaient par 1 000 DZD acceptent les centimes ; l'import d'un relevé bancaire ne compte que ce qu'il écrit, nomme
  chaque ligne écartée avec sa raison, lit 06/01 comme le 6 janvier et refuse une date ou un montant vides.
- **File des congés du N+1** (`lib/hr/file-conges.ts`) : le N+1 enregistré ET le N+1 actuel (un salarié muté envoyait
  sa demande dans une file où son nouveau responsable ne la voyait pas), filtre dans la requête ; **un congé ou une
  formation ne se décide qu'une fois** (écriture conditionnelle, solde débité dans la même transaction — deux accords
  simultanés débitaient le solde deux fois).
- **Ce qui reste, nommé** : le plafond « factures ≤ BC » au règlement pour tous les BC (D2) est une décision de la
  Direction ; les images HEIC/TIFF ne sont pas acceptées en pièce des moyens généraux (décision) ; Adam, ses missions
  et la recherche web ne lisent pas l'interrupteur général (Adam a ses propres interrupteurs) ; `choisirLignesPromo`
  et `demanderCorrectionDevisPromo` écrivent encore sans condition (lot suivant).

### AUDIT 360° — LOT C4d2b2 : UNE FACTURE ÉMISE SE CORRIGE PAR UN AVOIR, LE RÈGLEMENT ENCAISSE LE NET (2026-10)

Rapport 17 de l'audit (R15, seconde moitié). Doctrine : `CLAUDE.md` §118.195. Avec la pièce révisable du lot C4d2b1
(§118.194), R15 est livré.

- **« Émettre un avoir »** sur la fiche d'une facture émise par la plateforme (`emettreAvoir`, panneau
  `legal/[id]/emettre-avoir.tsx`) : le panneau part des lignes de la facture — on garde ce qui est crédité, en
  totalité ou en partie —, et le motif est exigé : c'est ce que l'avoir imprime. L'avoir est une pièce du registre
  (nature `CREDIT_NOTE`, type de fabrique `AVOIR`, préfixe `AV`), sous son propre numéro ; le client, la TVA, la
  remise et les taxes sont repris de la facture par la fabrique, jamais de l'écran. La fiche de la facture liste ses
  avoirs et affiche son net.
- **Le Word est la facture « à l'envers »** : « Numéro d'avoir », « Facture d'origine », « Motif », « MONTANT
  CRÉDITÉ », « Arrêté le présent avoir à la somme de » ; jamais « SOMME À PAYER » ni mode de paiement.
- **La facture d'origine** est émise par la plateforme (une facture déposée se corrige par la pièce que son émetteur
  envoie), de la même société, non annulée — ces refus passent avant le motif. Sans facture, la fabrique refuse :
  « Un avoir corrige UNE facture : émettez-le depuis la fiche de la facture ».
- **Le plafond, au centime** (`lib/lecteurs/avoir.ts`, pur, au socle ; « avoir actif » lu une fois par `lib/lecteurs/avoirs-actifs.ts`) : un avoir ne crédite jamais plus que le TTC moins les
  avoirs actifs ; le refus dit les deux nombres, et une facture entièrement créditée a sa phrase. Contrôlé après
  l'essai à blanc, puis revérifié dans la transaction d'émission sous le verrou de la facture
  (`SELECT … FOR UPDATE`) : deux avoirs simultanés de 35 700 DZD TTC sur une facture de 51 170 DZD, un seul passe —
  entre deux processus aussi. Un avoir annulé libère le plafond.
- **Le règlement encaisse le net** : une facture réglée inscrit son TTC moins ses avoirs actifs. Un avoir émis
  **après** le règlement : la somme est due au client, la phrase le dit et nomme où le remboursement se demande
  (« Demandes de validations », « Demande de paiement ») — il n'est pas automatisé (décision à prendre).
- **Une facture ne s'annule pas sous ses avoirs** : refusé avant le motif — annulez d'abord l'avoir. **Un avoir ne
  se révise pas**, comme la facture ; le refus de révision d'une facture nomme désormais « Émettre un avoir », et
  celui du formulaire générique s'accorde (« Cet avoir a été émis »).
- **Pas d'avoir par le formulaire générique** : `CREDIT_NOTE` n'est pas une nature créable, comme l'avenant — un
  avoir naît de sa facture. Les Finances lisent et écrivent les avoirs (chaîne d'achat).
- **Trois lecteurs du montant dû**, trouvés en cherchant qui lit ce qu'une facture doit : le compte « à régler » de
  la liste Legal, son total et son filtre lisent le net (une facture entièrement créditée sort de « à régler ») ; la
  règle qualité `montant_contradictoire` compare le règlement au net (au TTC, elle aurait dénoncé chaque facture
  créditée réglée juste) ; « Envoyer au règlement » refuse une facture émise par la société (sens `IN`) — elle
  ouvrait un ordre de dépense pour de l'argent qui doit entrer —, et la fiche dit pourquoi avec la même phrase.
- **Au socle, pas sous Legal** : la règle et ses lecteurs vivaient d'abord sous `lib/legal/` ; le règlement (domaine
  finance) les lisait, et le cliquet des traversées a compté 70 pour 68. Une règle pure que plusieurs domaines lisent
  vit au socle : retour à 68, sans relever le plafond.
- **Un avoir total resoumis rend la pièce, une émission interrompue se reprend** : le plafond se lit APRÈS la
  reconnaissance du doublon. Avant, l'avoir identique déjà inscrit comptait contre lui-même — un double clic sur un
  avoir total était refusé « entièrement créditée », et une émission interrompue ne se reprenait jamais (trouvé en
  écrivant la liste des sabotages, avant d'en jouer un).
- **Ce qui reste, nommé** : le remboursement d'un avoir émis après règlement n'est pas automatisé ; l'outil de
  pièces d'Adam (en pause) ne connaît pas l'avoir ; le préfixe `AV` n'est pas réglable ; un avoir ne porte pas le
  timbre fiscal d'une facture payée en espèces (le rembourser ou non est une décision fiscale).

### AUDIT 360° — LOT C4d2b1 : UNE PIÈCE ÉMISE SE RÉVISE DEPUIS SA FICHE, LE FORMULAIRE NE RÉÉCRIT PLUS SON FICHIER (2026-10)

Rapport 17 de l'audit (R15, première moitié). Doctrine : `CLAUDE.md` §118.194. L'avoir passe au lot C4d2b2.

- **« Réviser la pièce »** sur la fiche d'un devis ou d'un bon de commande émis par la plateforme
  (`reviserPieceCommerciale`, panneau `legal/[id]/reviser-piece.tsx`) : lignes, objet, notes, validité, livraison,
  contact ; même numéro, version suivante du Word et du PDF, la fiche suit (montant, partie, échéance). La fiche
  affiche la version. « Ce qui change » est exigé — c'est l'historique — et demandé après l'état.
- **Une version à la fois** : la révision part de la version affichée ; si quelqu'un a révisé entre-temps, elle est
  refusée au lieu d'écrire par-dessus. Deux révisions simultanées : une seule passe, la perdante n'écrit rien (file
  par pièce) ; entre deux processus, l'écriture au registre exige la version lue.
- **Ce qui découle fige** : un BC facturé, un devis commandé ou facturé ne se révisent plus — la phrase nomme la
  pièce aval et le geste qui libère (l'annuler). La règle vit chez la fabrique pour tous ses appelants : le dossier
  promotionnel n'en a plus de copie. Un courrier rattaché « faisant suite » ne fige rien.
- **Le formulaire « Modifier »** d'une pièce émise ne propose plus le montant, le numéro, la nature, les dates, le
  sens ni la partie, le dit en tête, et l'action refuse de les changer (en les nommant, avec le geste qui corrige) ;
  renvoyés à l'identique, ils passent. La date de règlement d'une facture émise est désormais lue (elle était
  ignorée puis effacée, la nature n'étant plus envoyée).
- **Les Finances révisent un BC qu'un autre a émis** : le droit sur la pièce couvre son fichier, et lui seul.
- **La dérivation des contrats** : un appel imbriqué n'était pas reconnu comme une délégation, et un test de
  présence écrasait le type lu par un délégué (date, liste) — corrigés, l'artefact ne bouge que de l'action neuve.

### AUDIT 360° — LOT C4d2a : UN PLAN VALIDÉ SE RÉVISE, UNE VISITE SE DIT NON TENUE, UN GESTE À LA FOIS (2026-10)

Rapport 18 de l'audit (R13) et parcours du KAM (M5). Doctrine : `CLAUDE.md` §118.193. La pièce Legal révisée et
l'avoir (R15) passent au lot C4d2b.

- **Demander une révision** (`demanderRevisionPlanTournee`, bouton sur un plan validé) : motif exigé, demandé
  après l'état ; le plan passe **« En révision — à resoumettre »** (`REVISION`), se modifie, et se resoumet sous
  **48 h** comme un rejet. Le validateur lit le motif dans sa notification et sur le plan ; sa décision clôt la
  révision. Prévenus : la personne qui a validé quand le KAM rouvre, le KAM quand quelqu'un d'autre rouvre.
- **Le passé reste** (`retraitInterditApresRevision`) : sur un plan déjà validé, une visite planifiée dont l'heure
  est passée ne se retire ni par la grille, ni par la suppression — elle se rapporte, ou se dit non tenue dans ses
  48 h. L'écran la grise en disant pourquoi.
- **« N'a pas eu lieu »** (`direVisiteNonTenue`, « Ma journée ») : reportée ou annulée, motif exigé, dans la même
  fenêtre de 48 h que le rapport ; le KAM est prévenu quand quelqu'un d'autre le dit. La ligne montre le motif.
  `updateVisit` refuse désormais ce changement (et l'op d'Adam aussi, avant la carte).
- **La phrase des 48 h est vraie** : elle promettait une régularisation par le superviseur que rien ne permettait ;
  elle dit maintenant que, passé ce délai, la visite ne se rapporte plus ni ne se dit non tenue, et qu'un rapport
  fait foi.
- **Un geste à la fois** : décider, soumettre, escalader, réviser et la grille écrivent sous la condition de l'état
  lu ; la grille ne retire plus une visite rapportée pendant son enregistrement ; `updateVisit` ne ramène plus à
  « planifiée » une visite rapportée pendant la modification, et `deleteVisit` ne la supprime plus.
- **Les portes d'à côté** : une visite d'un plan soumis ou validé ne change plus de jour, de praticien ni de KAM
  par la modification, et ne sort plus du plan par la suppression ; une visite rapportée ne se supprime plus.
- **« Mon espace › À corriger »** liste les plans rejetés ou en révision, avec leur échéance de resoumission.
- **Le contrat** : un rejet sans commentaire est refusé par `=== null` — la validation ne demande plus de
  commentaire au chemin générique.

### AUDIT 360° — LOT C4d1 : LE RECRUTEMENT SE CORRIGE, SE ROUVRE, ET UN GESTE À LA FOIS (2026-10)

Rapport 18 de l'audit (R14). Doctrine : `CLAUDE.md` §118.192. Le plan de tournée (R13) et la pièce Legal (R15)
passent au lot C4d2.

- **Renvoyer pour correction** (`renvoyerDemandeRecrutement`, bouton « Renvoyer pour correction » à côté de
  Valider et Refuser) : la troisième issue, ouverte à qui peut trancher la marche active, et aux RH quand la
  demande est chez eux ; motif exigé. La demande passe à l'étape neuve **« À corriger »** (`RETURNED`), garde
  d'où elle vient (`returnedFrom`), et personne ne tranche en attendant.
- **Corriger et renvoyer** (`resoumettreDemandeRecrutement`, panneau du demandeur, formulaire **pré-rempli**) :
  « ce qui a changé » exigé ; ce que le formulaire ne porte pas ne s'écrit pas. Une correction qui ne touche rien
  de ce que les validateurs ont pesé revient à la **même** marche (ou aux RH) ; une correction **matérielle** —
  autre poste, autre contrat, plus de postes, rémunération relevée ou plafond retiré, contrat plus long — fait
  **repartir la chaîne de sa première marche** (`changementsMateriels`). Une demande renvoyée se **retire** aussi.
- **Rouvrir** (`rouvrirDemandeRecrutement`, RH ou sommet, motif) : refusée dans la chaîne → à la marche qui a
  refusé, et à elle seule ; refusée par les RH → chez les RH ; close sans recrutement → poste rouvert ; retirée
  par son auteur ou close après un recrutement → non, et le refus dit le geste qui reste (`reouverture`).
- **Annuler l'embauche** (`annulerEmbaucheRecrutement`, RH ou sommet, motif) avant la fiche employé : le
  candidat redevient retenu, le poste se rouvre.
- **Motifs exigés côté serveur** (refus dans la chaîne, refus et clôture sans suite par les RH) — l'écran les
  exigeait, pas l'action ; et une **décision illisible** n'est plus un accord (`« REJECTED », sinon APPROVED`).
- **Un geste à la fois** : les treize écritures d'étape sont conditionnelles sur l'étape lue (cliquet
  `recruitment/etape-conditionnelle.test.ts`), et les marches s'apparient par leur **rang** (`marchesChangees`).
- **Historique de la demande** sur la fiche (refus, renvois, corrections, réouvertures, embauches annulées).
- **Mon espace › À corriger** liste désormais les recrutements renvoyés et les demandes de paiement renvoyées
  par les Finances.

### AUDIT 360° — LOT C4c : LA DEMANDE DE PAIEMENT SE CORRIGE, LE SECRÉTARIAT A DES GESTES NOMMÉS (2026-10)

Rapport 18 de l'audit (R04, R12). Doctrine : `CLAUDE.md` §118.191. Le recrutement (R14) passe au lot C4d.

- **Corriger sa demande de paiement** (`corrigerDemandePaiement`, bouton « Corriger la demande » de la fiche) :
  l'objet, le bénéficiaire, le montant, le contexte, l'échéance — et, tant qu'elle n'a jamais été transmise,
  l'entité et l'urgence. Rien de tout cela ne se corrigeait, pas même en brouillon. Seulement chez le demandeur
  (brouillon, ou renvoyée par les Finances) : chez les Finances, le refus nomme le chemin (« elles vous le
  renvoient ») ; un dossier compagnon se corrige dans son circuit d'origine ; un paiement réglé ou refusé ne se
  corrige plus. Après transmission, « ce qui a changé » est exigé et va au fil du dossier. La règle vit dans
  `finance/correction-demande.ts`, lue par l'écran et par l'action.
- **L'ordre de dépense suit, par l'UNIQUE réviseur** (`payments/revision-ordre.ts:reviserOrdreNonRegle`) : relever
  le montant ou changer de bénéficiaire rouvre une autorisation donnée (`statutApresRevision`), baisser ne rouvre
  rien ; l'échéance de l'ordre ne suit la demande que s'il attend le centre ; la raison va au fil du centre et la
  Direction est prévenue. L'écriture est conditionnelle sur ce qu'elle a lu (statut, autorisation, montant,
  bénéficiaire) et relue sur fait nouveau ; la demande et l'ordre s'écrivent dans la même transaction — un
  règlement passé entre-temps annule toute la correction, jamais la moitié.
- **Le budget accordé d'un congrès passe par le même réviseur** : il écrivait l'ordre sans condition, si bien
  qu'un règlement passé entre la lecture et l'écriture voyait un ordre PAYÉ changer de montant et son
  autorisation rouverte. Un ordre réglé ou refusé ne suit pas le nouveau budget, et la phrase le dit ; la
  déclaration d'information médicale non validée suit (`medical-info.ts:repercuterMontantSurDeclaration`).
- **Le centre de paiement décide sur ce qu'il a lu** : l'écran renvoie le montant et le bénéficiaire affichés,
  un écart se dit avec les deux valeurs ; la décision est conditionnelle (autorisation, montant, bénéficiaire,
  statut) — deux sièges à la même seconde, un montant corrigé ou un ordre annulé pendant la lecture : rien n'est
  écrit, pas même le message.
- **Les pièces** : au brouillon, le demandeur remplace une pièce que personne n'a mise en cause, sans la déclarer
  acceptée ; une pièce remplacée sort du décompte du bon à payer et ne s'examine plus ; les Finances n'examinent
  plus les pièces d'un brouillon (le verdict le faisait passer « transmis » de lui-même) ; remplacer la dernière
  pièce en cause garde le dossier chez le demandeur, qui le renvoie quand sa correction est complète.
- **Secrétariat — plus de menu de statut libre** (`secretariat/statut-manuel.ts`) : il terminait sans les gardes
  de la fin (et c'était le SEUL chemin qui archivait), annulait sans retirer ce qui en dépendait, ressuscitait
  une demande annulée et envoyait l'énumération brute au demandeur. Restent des gestes nommés : « En attente
  d'un tiers », « En attente d'un document », « Reprendre », « Bloquer… » (motif exigé, lu par le demandeur,
  effacé à la reprise), « Rouvrir… » une demande terminée (`rouvrirDemande`, motif), « Annuler la demande… »
  par l'annulation commune (`annulerDemandeAuSecretariat`, motif ; validation, approbation et paiement en
  attente retirés ; demandeur prévenu) — non offerte pour la demande de BC d'un poste, dont la raison se lit à
  sa place. « Fin de la demande » archive désormais dans le Drive ; une demande restaurée revient dans l'état où
  on l'a supprimée (seule la suppression discrète du demandeur revient « nouvelle »).
- Adam (en pause) : `update_request` ne propose plus que les trois statuts qui n'ont ni geste ni motif.

### AUDIT 360° — LOT C4b : LE MATÉRIEL PROMOTIONNEL ET LE COMPTAGE SE CORRIGENT (2026-10)

Rapport 17 de l'audit (R05, R06, R07) et rapport 18 (R19). Doctrine : `CLAUDE.md` §118.190.

- **Renvoyer pour correction** un dossier de matériel promotionnel (`renvoyerPromoStep`, motif obligatoire) : la
  troisième issue, à côté de valider et refuser, là où un autre que le demandeur tranche. À la validation de la
  DEMANDE, le dossier reste à son étape, marqué (`returnedAt`, `returnedById`, `returnNote`, `returnedFrom` —
  migration `20261230090000_promo_renvoi_comptage_corrige`) : le validateur n'a plus rien à trancher tant que la
  marque est posée. À la validation du CHOIX (Direction Marketing, DG), il revient au choix des lignes, et le
  revalider repasse par toutes les validations. « À corriger » sur la fiche, dans la liste Ad & Pro et dans la file
  de Mon espace (le tour passe au demandeur).
- **Resoumettre** la demande corrigée (`resoumettrePromoDemande`) : son demandeur (ou la Direction), en disant ce
  qui a changé ; la marque s'efface, le renvoi et la correction vont au fil, la personne qui a renvoyé est prévenue.
- **Le demandeur ne refuse pas sa propre demande** au choix des lignes : le refus le dit, avant tout motif, et nomme
  les deux remèdes (redemander des devis, annuler) ; l'écran ne lui offre plus « Refuser ».
- **Redemander des devis** (`redemanderDevisPromo`) : une nouvelle demande au secrétariat, ce qu'on cherche exigé ;
  les devis reçus et la sélection restent ; un double clic n'en crée pas deux (la demande en trop est retirée).
- **La liste des articles** se modifie tant que le choix n'est pas en validation : au choix des lignes, un article
  ajouté ou corrigé renvoie le dossier à la retranscription et rouvre la demande au secrétariat ; l'assistante est
  prévenue de chaque changement.
- **Demander une correction de la retranscription rouvre la demande au secrétariat**
  (`promo-material/demande-secretariat.ts:rouvrirDemandeAuSecretariat`) — seulement une demande terminée, jamais
  une demande annulée, la date de fin effacée, la raison écrite sur la demande.
- **Corriger un comptage saisi** (`corrigerComptage`, `promo/comptages-ecriture.ts:corrigerSaisieComptage`) : son
  détenteur seul, motif exigé ; l'écart corrigé s'applique au solde du jour (une sortie faite depuis reste vraie),
  tout ou rien, refusé quand un comptage plus récent du même détenteur a recompté l'article ; la personne qui l'a
  demandé est prévenue, et la fiche dit « Corrigé le … par … : « motif » ».

### AUDIT 360° — LOT C4a : LE CONSULTING ET L'« AUTRE DEMANDE » SE CORRIGENT (2026-10)

Rapport 17 de l'audit (R11, R13, R14, R16, R17, R18). Doctrine : `CLAUDE.md` §118.189.

- **Corriger** un contrat de consulting ou une « autre demande » : la même porte que les cinq autres natures du
  pôle (`updateAdProRequest`, `ad-pro-edit.ts`) — champs **obligatoires** déclarés (`requis`) et **menus**
  revérifiés côté serveur, période cohérente, historique qui dit les **libellés** (« Rythme : Forfait unique →
  Mensuel »). Un contrat RH se corrige par le module RH (`MODULE_DU_POLE`). Un contrat actif, une demande tranchée
  ne se corrigent plus en silence.
- **Renvoyer pour correction** un contrat (`decideConsultingContract`, décision `RENVOYER`, motif obligatoire) : il
  revient en brouillon chez son porteur (`returnedAt`, `returnedById`, `returnNote` — migration
  `20261229090000_consulting_renvoi`), « À corriger » dans la liste Ad & Pro et dans Mon espace ; la fiche montre
  le motif. **Resoumis**, le renvoi s'efface et va au fil, et le **validateur qui l'a demandé** reste désigné
  (présélectionné à l'écran, gardé par l'action quand le formulaire ne le porte pas).
- **Resoumettre** une « autre demande » refusée (`resoumettreAdProOtherRequest`) : son demandeur seul, en disant ce
  qui a changé ; description et montant se corrigent au passage ; le refus et la correction vont au fil.
- **La porte du centre Ad & Pro suit le montant corrigé** (`ad-pro/visa.ts:ajusterVisaAuMontant`) : elle s'ouvre
  au-dessus du seuil, se met à jour ou se retire en dessous, et une autorisation se **rouvre** si le montant la
  dépasse ; resoumise sous un refus du centre, la demande va au **centre** (seul un siège réexamine), pas au
  validateur qu'il bloque. La phrase de ce qui s'est passé est dite à l'écran (`phraseGesteVisa`).
- **Prolonger** un contrat en cours (`prolongerConsultingContract`) : qui peut le valider, une fin qui suit
  l'actuelle, ce qui la fonde ; au fil, et le porteur prévenu.
- **Motifs exigés** pour annuler un contrat, une « autre demande », un dossier promotionnel, une facture promo, une
  pièce Legal, un mouvement de stock, une réception, et pour renoncer à des lignes au paiement — **toujours après**
  les refus d'état : on ne demande pas pourquoi annuler ce qui ne s'annule pas d'ici.
- **Les Finances** annulent, rétablissent et renouvellent leurs factures et bons de commande depuis la liste Legal
  (la porte de la fiche est la règle d'écriture par nature) ; un contrat leur reste fermé.
- **Annulé n'est pas refusé** : un dossier promotionnel annulé s'affiche « Annulé ».
- Clôtures conditionnelles (contrat, « autre demande », dossier promotionnel) : deux annulations simultanées n'en
  écrivent qu'une.

### AUDIT 360° — LOT C3 : LES TROIS CENTRES SAVENT FAIRE CORRIGER (2026-10)

**Demande** (dirigeant, 02/10). Corriger tous les constats de l'audit 360° ; C3 porte la règle « valider /
renvoyer pour correction / refuser » sur les **centres** : centre de validations, centre de validation Ad & Pro,
signature des bons de commande, et la prose du centre de paiement (rapport 18 : R03, R08, R09, R10, R20 ;
rapport 17 : R07).

**Ce qui change — centre de validations.**
- **« Modification demandée » devient « À corriger », et la demande se RESOUMET sur elle-même.** Le demandeur
  corrige le texte, le montant, ajoute des pièces, dit ce qu'il a corrigé (obligatoire) ; la demande reprend
  **à l'étape qui l'a renvoyée** — l'accord donné avant reste acquis, sauf si le montant monte : alors toutes les
  étapes déjà validées repartent. La fiche montre la version et l'historique (motif du renvoi, correction).
- **Le motif est obligatoire** pour renvoyer et pour refuser (pas pour valider).
- **Abandonner** une demande renvoyée la clôt (« Annulée ») sans effacer ce que les validateurs ont dit.
- **Une demande née d'un autre circuit** (pièce du secrétariat, BC, information médicale) se corrige depuis
  son objet d'origine, pas d'ici.
- **Un geste à la fois** : deux validateurs d'un circuit parallèle qui approuvaient à la même seconde
  laissaient la demande en attente pour toujours ; un double clic sur la dernière étape décidait deux fois.
  Corrigé (verrou de la demande, écriture conditionnelle, étapes relues).
- **Les pièces d'une demande ne s'ouvrent plus à tout porteur du module** : seuls le demandeur, les
  validateurs et leur intérimaire les lisent ; seul le demandeur en ajoute.

**Ce qui change — centre de validation Ad & Pro.**
- **Trois issues** : valider, **renvoyer pour correction** (ce qu'il faut corriger est obligatoire), refuser
  (motif obligatoire). Un refus se **réexamine** par un siège, motif à l'appui.
- **Consulting et « autres demandes »** : la fiche dit l'état du centre (en attente, autorisée, refusée,
  à corriger) ; une demande renvoyée se **resoumet au centre** depuis sa fiche, **avec son montant corrigé**
  (ces deux natures n'ont pas encore d'écran d'édition) — corrigée sous le seuil, elle ne repasse pas par le
  centre et poursuit son circuit.
- **Un BC du registre Legal renvoyé** est « à revoir » : sa modification dans Legal le renvoie au centre.
- **Deux sièges qui tranchent à la même seconde** : une seule décision compte.
- **Une demande annulée** pendant qu'elle attendait le centre n'y reste plus : sa porte est retirée, et un
  refus ne se réexamine pas sur une demande close.

**Ce qui change — bons de commande.**
- **« Renvoyer à l'émetteur »** (motif obligatoire), à côté de « Signer », dans le module Bons de commande et
  sur la fiche Legal du BC : le BC quitte la file « À signer » (une carte « Renvoyés à l'émetteur » garde ce
  qui a été demandé), son émetteur est prévenu, et **toute modification** de la pièce le rend à la signature —
  ou d'abord à son centre si son montant monte.

**Ce qui change — centre de paiement.**
- **La décision de la Direction du 02/09 (deux issues : autoriser, refuser) reste** ; l'écran, la
  documentation et la boîte de décision promettaient encore « une révision du montant ou une argumentation » :
  corrigé partout. La fiche d'une demande de paiement dit maintenant où en est son autorisation au centre,
  qui a tranché, et le motif d'un refus.

**À décider par la Direction.** L'audit recommande de rétablir « Demander une révision » au centre de
paiement (R03) : c'est votre décision du 02/09, elle n'a pas été changée.

**Migrations** : `20261227090000_validation_version`, `20261228090000_bc_signature_renvoyee` (idempotentes).

### AUDIT 360° — LOT C2 : LES POSTES ET LE SECRÉTARIAT NE SE FIGENT PLUS (2026-10)

**Demande** (dirigeant, 02/10). Corriger tous les constats de l'audit 360° ; C2 porte la règle « valider /
renvoyer pour correction / refuser » sur les **postes** d'une demande Ad & Pro (et leurs bons de commande) et
sur les **demandes au secrétariat** (rapport 17 : R05, R06 et R08 à R12 — le R07, le centre Ad & Pro, relève du lot C3).

**Ce qui change — postes Ad & Pro.**
- **Le visa d'un BC ne couvre que ce qu'il a vu.** Le centre de validation Ad & Pro retient le montant et le
  prestataire qu'il a validés. Si l'on relève le montant au-delà, ou si l'on change le prestataire (« Payé à »),
  la demande de BC **repart au centre** et les Finances sont prévenues de ne pas l'émettre. Baisser le montant
  ne rouvre rien. Un BC passé sous le seuil puis porté au-dessus part au centre ; un BC en attente que le
  montant fait passer sous le seuil passe directement aux Finances. Les Finances ne peuvent plus émettre un
  ordre plus élevé, ou pour un autre fournisseur, que ce que le centre a vu.
- **La demande de BC se modifie et se retire.** « Modifier la demande de BC » (sa demande au secrétariat suit),
  « Retirer la demande de BC ». Tant qu'un BC établi dans Legal en découle, ces gestes sont refusés et la carte
  le dit : il faut d'abord l'annuler dans Legal.
- **Un ordre émis se réémet.** Les Finances annulent un ordre non réglé (motif) et le réémettent ; le visa tient
  pour ce qu'il a vu.
- **Une décision se revoit.** « Revoir la décision » sur un poste accordé, refusé ou à revoir (motif exigé pour
  un refus ou un renvoi). « Demander une révision » rend à la Direction un poste déjà accordé.
- **Retirer un poste passe par la corbeille.** Ses décisions, ses voyageurs, ses pièces, ses demandes au
  secrétariat (l'assistante est prévenue) et son ordre non réglé partent avec lui et reviennent avec lui. Un
  ordre déjà réglé, une pièce signée par les Finances ou du matériel déjà sorti du stock bloquent le retrait, et
  la fenêtre dit pourquoi.
- **Une demande refusée ou annulée** ne fait plus partir ses postes (ni soumission, ni accord, ni bon de
  commande) ; les refuser reste possible.

**Ce qui change — demandes au secrétariat.**
- **Trente minutes ne figent plus rien.** Dans la première demi-heure, tant que l'assistante n'a pas commencé,
  le demandeur corrige ou supprime sans déranger personne. Au-delà, tant que la demande n'est ni terminée ni
  annulée, il la **corrige** (l'assistante est prévenue et la discussion garde ce qui a changé) ou l'**annule**
  avec un motif (elle reste visible, close). Fermé, avec son remède : une demande terminée, une correction
  pendant une validation, une correction quand un paiement est émis.
- **Ce que le formulaire ne porte pas ne s'efface plus** (les lignes d'une demande d'achat survivaient mal à une
  correction).
- **Une annulation retire tout ce qui attendait** : validations, approbations, ordres non réglés. Une
  approbation tranchée après coup ne paie plus une demande annulée ; une validation tranchée après la fin ne la
  fait plus revenir « en cours ».
- **Un geste à la fois.** Une demande annulée ou terminée au même instant qu'on la commence, qu'on la termine
  ou qu'on la corrige : le second geste est refusé et le dit.

**À faire de votre côté.** Rien.

**Décision à prendre.** Les Finances n'ont pas accès aux pages des événements et des congrès : elles ne
peuvent ni ouvrir ces demandes, ni émettre ou annuler l'ordre d'un de leurs postes, alors qu'elles reçoivent
« BC validé — à émettre ». Deux options : leur donner la lecture de ces modules, ou un écran « BC à émettre »
dans Bons de commande.

**Ce qui reste.** Un poste refusé puis réaccordé ne rouvre pas les demandes au secrétariat closes avec son
refus ; une approbation au secrétariat décidée après la fin de la demande émet encore son ordre (décision : la
fin doit-elle attendre les approbations ?) ; le matériel promotionnel clôt sa demande au secrétariat sans
passer par l'annulation commune (lot C4) ; les centres (lot C3) et les autres circuits (lot C4).

### AUDIT 360° — LOT C1 : FAIRE CORRIGER AU LIEU DE REFUSER (2026-10)

**Demande** (dirigeant, 02/10). Corriger tous les constats de l'audit 360° ; le lot C porte la règle commune
« valider / renvoyer pour correction / refuser » (rapport 17). C1 la pose dans le **moteur des circuits Ad & Pro**
(sponsoring, congrès international et national, événements) ; les postes, les centres et les autres circuits
suivent (C2, C3, C4).

**Ce qui change.**
- **Renvoyer pour correction.** À toute étape qui peut refuser, un troisième bouton : « Renvoyer pour
  correction », motif obligatoire. La demande passe **« À corriger »** chez son demandeur (fiche, listes, Mon
  espace), qui reçoit le motif ; il corrige, puis **« Resoumettre »** — autant de fois qu'il faut. La demande
  revient à l'étape qui l'a renvoyée. **Exception** : si la correction fait passer le montant au-dessus du seuil
  du Directeur Général alors que sa porte avait été franchie sous le seuil, la demande **repasse par le DG**.
- **Le motif se lit.** Le demandeur voit le motif d'un renvoi ou d'un refus sur sa fiche (les avis
  intermédiaires confidentiels restent confidentiels).
- **Événement refusé : nouvelle demande.** Un événement refusé ou annulé peut repartir, en disant ce qui a
  changé ; la fiche n'affiche plus le refus d'hier au-dessus de la demande d'aujourd'hui (l'historique le garde).
  Un collègue ne soumet plus l'événement d'un autre.
- **L'appel** d'un sponsoring revient à l'étape qui a **tranché** (et non à la porte du DG), qui est prévenue ;
  la Direction reste informée.
- **Retirer sa demande** (motif obligatoire) tant qu'elle n'est pas tranchée et qu'aucun poste n'engage la
  dépense. **Annuler un congrès** ou **transférer** une demande **ferme maintenant son circuit** : avant, le
  bouton « Approuver » restait ouvert sur une demande annulée — et l'approuver aurait émis l'argent.
- **Modifier après un avis** : ceux qui ont déjà donné leur avis sont prévenus, et la porte du DG se rouvre si
  le montant la dépasse désormais.
- **Un geste à la fois.** Deux clics sur « Approuver » (ou deux validateurs au même instant) ne s'appliquent
  plus deux fois : avant, l'étape qui tranche pouvait émettre **deux ordres de dépense**. Le second geste est
  refusé et le dit (« quelqu'un agit dessus au même instant »).

**À faire de votre côté.** Rien.

**Ce qui reste.** Le renvoi pour correction des **postes**, des **centres** (Ad & Pro, paiement, validations)
et des autres circuits (consulting, autre demande, matériel promotionnel, secrétariat) arrive avec C2, C3 et C4.

### AUDIT 360° — LOT B : LES IMPASSES (2026-10)

**Demande** (dirigeant, 02/10). Corriger tous les constats de l'audit 360° ; après le lot A (sécurité), les
dix-huit « impasses » — un geste attendu que personne ne pouvait faire (`docs/audit-360/README.md`, I1 à I18 ;
I1 à I3 corrigés avec le lot A).

**Ce qui change.**
- **Paiements et factures.** « Facture obligatoire » voit enfin la facture où qu'elle soit rangée (registre
  Legal, poste, dossier compagnon et ses pièces) ; l'écran, le règlement et l'intelligence financière lisent la
  même règle. Retirer ou voir refuser une demande de paiement, ou annuler sa facture, **annule l'ordre de
  dépense** s'il n'est pas réglé (et refuse sinon, en le disant). Une facture refusée au centre de paiement
  **peut repartir** au règlement.
- **Information médicale.** Après « Modification », le pharmacien **resoumet** sa lecture ; la demande
  précédente est close. Une validation retirée ne laisse plus le dossier « en validation » à vie. Les Finances
  ouvrent la fiche dès qu'un bon est parti au paiement, et y remettent la quittance.
- **Assistante de direction.** Son bureau charge **toutes les demandes ouvertes** (et les dernières terminées),
  avec les totaux réels ; une demande sans responsable, ou validée sans responsable, lui est **signalée** et
  apparaît « à prendre en charge » dans Mon espace ; la demande d'émission d'un bon de commande mène à une page
  qu'elle peut ouvrir ; le **passeport** d'un voyageur s'ouvre aux personnes du sujet de réservation (et rien
  d'autre du poste).
- **Direction Marketing.** Elle lit les **messages pré-définis** (l'écriture reste une liste que le Super Admin
  coche dans Administration › Réglages) ; tout ce qui attend **son étape** — sponsoring, événement, congrès,
  consulting, autre demande — apparaît dans Mon espace, sous « À arbitrer » ; elle **ouvre en lecture les devis,
  bons de commande et factures** des demandes qu'elle tranche (pas les conventions ni les contrats ; jamais une
  pièce restreinte à d'autres lecteurs). Le titre d'une pièce dont la fiche Legal ne s'ouvre pas n'est plus un
  lien vers une page refusée.
- **KAM et National Sales.** Le KAM **dépose ses sponsorings** (il ne voit que les siens) ; KAM et National Sales
  ont le module **Stocks** que leur écran supposait.
- **Formations, Mon Équipe, Regulatory, PCH, force de vente.** Le responsable de département tranche la marche
  N+1 d'une formation et le Directeur Général la marche DG ; « Traiter » dans Mon Équipe mène où l'on peut agir ;
  la date cible de dépôt d'un dossier réglementaire ne s'efface plus à chaque modification ; un lot PCH reçoit
  son produit canonique quand il n'y en a qu'un possible, et supprimer un appel d'offres passe par la corbeille ;
  la revue mensuelle de la force de vente ne part plus qu'**une fois**.
- **Demandes d'achat.** Leurs **articles** apparaissent sur la fiche (table, prix indicatifs, total) et sur la
  carte de validation (la liste entière).
- **Intérim.** L'intérimaire validé par les RH **tranche ce qui attend l'absent** en personne — congés,
  formations, achats, plans de tournée, validations — le voit dans ses listes (« Intérim pour … ») et dans Mon
  espace ; **jamais sa propre demande** ; l'intérim s'éteint avec le congé.

**À faire de votre côté.** Si la Direction Marketing doit **écrire** les messages pré-définis : Super Admin →
Administration › Réglages → « Messages Direction Marketing », cocher son rôle.

**Ce qui reste.** La file des approbations du secrétariat n'est pas cloisonnée par société pour qui valide le
module ; l'écran Validations ne liste pas encore les arbitrages Ad & Pro (Mon espace oui) ; les notifications de
l'étape Direction Marketing partent à tout le rôle (pas de filtre de gamme) ; les étapes adressées à un rôle
(RH, Direction) ne se délèguent pas par l'intérim.

### AUDIT 360° — LOT A : SÉCURITÉ ET CONFIDENTIALITÉ (2026-10)

**Demande** (dirigeant, 02/10). Corriger tous les constats de l'audit 360°, en commençant par les seize
constats « sécurité et confidentialité » (`docs/audit-360/README.md`, S1 à S16).

**Ce qui change.**
- **Une fiche ouverte par son lien ne s'ouvre plus plus large que sa liste.** Dossier réglementaire (société et
  gamme), marché PCH et ses bons, demande au secrétariat (et ses commentaires), pièces d'une déclaration
  d'information médicale, fiche salarié, formation, plan de tournée d'un collègue : chaque fiche — et chaque
  geste qu'elle porte — lit désormais la même règle que sa liste. La fiche s'ouvre sur toutes les sociétés
  auxquelles la personne a droit (pour qu'un validateur ne perde pas ce qu'on lui demande de trancher) ; la
  liste suit le sélecteur de l'en-tête.
- **Plan de tournée.** Le plan d'un collègue ne s'ouvre plus par son lien ; le N+2 d'un plan escaladé a ses
  boutons ; le circuit prévient (soumission, escalade, validation, rejet — les 48 h de correction courent dès
  la notification) ; le validateur voit la grille des visites avant de trancher.
- **Événements et demandes Ad & Pro.** Un délégué ne réécrit plus l'événement d'un collègue : le formulaire
  complet est réservé à qui tranche (avant la décision) et à la vue globale ; après la décision, seule
  l'organisation se modifie (lien de connexion, capacité, responsable, description). La correction d'une
  demande Ad & Pro respecte la portée de la fiche.
- **RH.** Salaires, nets, NIN et pièces RH ne sont plus montrés aux rôles qui n'ont des RH que la lecture ; les
  listes (demandes, congés, avances, intérims) s'arrêtent à la société ; la RH d'une société ne modifie plus un
  salarié d'une autre. **Désactiver une fiche salarié ferme son compte et déconnecte ses sessions** — sauf le
  compte d'un Super Admin (seul un Super Admin le ferme) et le sien ; une réactivation ne rouvre pas le compte
  (l'écran le dit, avec l'endroit où le rouvrir).
- **Formations.** Chacun ne voit que ses demandes, celles de son équipe et ce qu'il doit trancher. Les pièces
  d'une formation se téléchargent enfin : elles étaient rangées sous le mauvais type et refusées à tout le
  monde (migration qui les requalifie).
- **Juridique.** Renouveler un contrat restreint garde ses lecteurs désignés ; les rappels d'échéance ne nomment
  plus une pièce restreinte ou d'une autre société ; la boîte « Motif de l'annulation » n'annule plus le
  contrat quand on clique sur « Annuler ».
- **Vue exacte.** Ce que le Super Admin FAIT en visualisant quelqu'un part à son propre nom, comme le bandeau
  l'annonce — au journal comme dans les notifications.
- **Administration déléguée.** Un compte qui reçoit l'Administration ne peut plus nommer un Super Admin, toucher
  au compte d'un Super Admin, ni s'accorder lui-même des droits.
- **Force de vente.** Un KAM qui change de BU, ou qui en est retiré, perd ses secteurs de l'ancienne (l'écran le
  dit) ; on n'affecte à un secteur que des KAM de la BU. Le pilotage ne montre plus le chiffre d'affaires de
  toutes les sociétés à un délégué : il se lit à la maille d'une BU (superviseur) ou de la Direction, dans les
  sociétés que la personne voit.
- **PCH.** La création, la modification et la suppression d'un appel d'offres, de ses lots, bons, livraisons et
  soumissions passent par la porte du marché, lue en base ; corriger la caution n'efface plus la date limite ;
  le rappel de dépôt ne part plus aux gestionnaires des autres sociétés.

**Ce qui reste, nommé.** Les fiches d'un sponsoring et des deux prises en charge se chargent encore par leur
identifiant seul, sans la porte de société (relevé de la phase 0) — décision de périmètre à prendre pour les
validateurs d'une autre société. `SalesRepProfile.repId` n'a pas de relation : un compte supprimé y laisse une
ligne orpheline (douze purgées dans la base de développement, aucune en production). Les « routes sans garde »
du scanner (S16) sont des faux positifs, que le scanner doit apprendre à reconnaître.

### GRAPHE AMD — PHASE 2 : UNE BUSINESS UNIT VISE PLUSIEURS SPÉCIALITÉS (2026-10)

**Demande** (cahier des charges, §4, §5, §19, §20). « BU ≠ spécialité » : la BU Specialty Care vise la
neurologie, la dermatologie et l'urologie. Une spécialité principale est facultative ; elle sert
l'affichage et ne restreint rien.

**Ce qui change.**
- **Force de vente › Business Units** : chaque carte a une section **Spécialités visées** — choisir
  dans le référentiel (avec un filtre), marquer une principale d'une étoile, décocher pour retirer.
  La carte fermée nomme ce que la BU vise (« Neurologie ★ · Dermatologie · Urologie »).
- **La création d'une BU** demande ses spécialités dès le départ ; elles se règlent aussi plus tard.
- **Une étape de montage de plus** : « Choisir les spécialités », après le terrain. Une BU qui vise
  des spécialités sans en désigner une principale est montée ; une BU sans spécialité ne l'est pas.
- **Le référentiel des spécialités** dit quelles BU visent chacune ; retirer une spécialité visée est
  refusé en nommant les BU (la retirer de ces BU, ou la fusionner) ; la fusion fait suivre les BU
  et garde leur principale.
- **Modifier une BU ne réécrit plus ce que le formulaire ne porte pas** : renommer une BU par un
  formulaire partiel ou par l'assistant effaçait son code, sa couleur, son entité, son chef et son
  superviseur.
- **L'historique** dit ce qui entre, ce qui sort et la principale quand elle change.

**Ce qui reste, nommé.** Le Directeur des Opérations (rôle à part) lit la Force de vente par défaut ;
la lui ouvrir en écriture est une ligne de console. Les spécialités cibles d'un PRODUIT dans sa BU
viennent en phase 3.

### GRAPHE AMD — PHASE 1B : UN PANEL, UNE SPÉCIALITÉ, UN HISTORIQUE (2026-10)

**Demande** (Direction, 01/10, chantier « graphe AMD », phase 1 suite). Une identité par objet, des liens par
identifiant : un seul panel par KAM, la spécialité d'un praticien comme lien vers le référentiel, et un
historique qu'on relit par objet.

**Ce qui change.**
- **Un seul panel du KAM — son secteur ET ses rattachements — pour tous ceux qui le lisent.** Le plan de tournée le
  calculait ainsi ; la fiche d'un praticien, la saisie rapide, la visite imprévue, « Ma journée », la carte
  d'équipe, le cockpit et l'alerte « médecin stratégique non visité » ne comptaient que les praticiens rattachés à
  la main. Un KAM affecté à un secteur hospitalier sans rattachement direct était déclaré « non armé » au cockpit,
  ne pouvait pas ouvrir la fiche d'un praticien que son plan validé lui faisait visiter, et l'alerte KOL partait
  vers la Promotion médicale pour un CHU que son secteur couvre. Une seule clause (`clausePanelDuKam`) : les
  rattachés, les établissements couverts en entier, les services couverts par un secteur restreint — un secteur
  désactivé ne compte pas. Le délégué peut aussi **mettre à jour** la fiche d'un praticien de son secteur
  (« CAM : son portefeuille + mises à jour terrain »).
- **L'alerte KOL nomme chaque KAM qui couvre le médecin** (une relance par personne) au lieu de prévenir la
  Promotion médicale ; elle ne choisit jamais l'un d'eux. La liste se lit les plus en retard d'abord.
- **Annuaires › Spécialités** : le référentiel des spécialités, enfin à l'écran — ajouter, renommer (couleur et
  notes conservées), fusionner deux doublons (les fiches suivent), retirer (les fiches gardent leur spécialité
  écrite). Les **libellés hérités** (une spécialité écrite en texte sur une fiche) sont regroupés par écriture et
  comptés dans ce que la personne voit ; un clic les rattache à une spécialité du référentiel.
- **Force de vente › Spécialités** (§118.209) : la **Direction Marketing** gère le référentiel (ajouter, renommer,
  fusionner, retirer) dans un onglet à part de la force de vente — le MÊME composant (`EcranSpecialites`), le même
  chargeur et les mêmes actions qu'Annuaires › Spécialités. Elle n'a de la Promotion médicale et de la Force de vente
  que la lecture : la règle `peutGererSpecialites` (rôle `PRODUCT_MANAGER`, principal ou secondaire) lui donne les
  quatre gestes sur le référentiel seul, sans élargir un module. Chaque écriture revalide les deux écrans
  (`CHEMINS_SPECIALITES`) ; les ops d'Adam lisent la même règle.
- **La feuille de l'annuaire écrit un LIEN.** Taper une spécialité dans une cellule, l'ajouter à une ligne, l'importer
  d'un classeur ou la saisir sur la fiche : si le texte désigne une spécialité du référentiel (casse, accents et
  espaces mis à part), la fiche y est rattachée et porte son nom ; sinon le texte reste, signalé « à rattacher », et
  le bilan d'import nomme les spécialités hors référentiel. Deux entrées du référentiel qui ne diffèrent que par un
  accent ne sont jamais départagées : le refus dit de les fusionner. « Rattacher les spécialités » relie en lot ce
  qui est sûr.
- **Un texte plus récent que son lien l'emporte.** L'ancien import remplaçait la spécialité écrite sans toucher au
  lien : une fiche liée à « Cardiologie » qui dit « Cardio interventionnelle » porte la saisie la plus récente. La
  feuille la montre telle quelle, « à rattacher » ; un renommage ou un retrait du référentiel ne l'écrase plus.
- **L'historique se relit par objet.** Une Business Unit, un secteur, un établissement et une spécialité
  s'auditaient sans type, et un plan de tournée sous le type d'une visite : chacun a désormais le sien, l'historique
  des plans est requalifié par la migration (par l'identifiant, jamais par le texte), et la modification d'un
  établissement ou d'une BU — qui n'était pas auditée — l'est.

- **Deux paiements demandés à la même seconde ne se bloquent plus.** La création d'un ordre de dépense — le passage
  de tout paiement — n'avait pas de filet contre la collision de numéros : le second échouait après le clic, et le
  dossier qui accompagne l'ordre pouvait manquer en silence. Les deux créations passent désormais en file et
  réessaient, la demande de paiement déposée à la main partageant la même file que le dossier compagnon.

**Ce qui reste, nommé.** La demande de pièce et les créations Legal, facture et courrier depuis une fiche n'exigent
pas que l'auteur puisse lire l'objet visé (décision de permission, à trancher). Le formulaire des BU réécrit les
champs qu'il ne porte pas (repris en phase 2). Les liens de spécialité contredits par leur texte restent en base,
neutralisés à la lecture, jusqu'à la phase 4.

### GRAPHE AMD — PHASE 1A : LE PRODUIT CANONIQUE BRANCHÉ (2026-10)

**Demande** (Direction, 01/10, chantier « graphe AMD »). Une identité par médicament, référencée partout —
« créer RAL, l'utiliser dans Regulatory, une BU, un appel d'offres, la consommation : le même identifiant ».

**Ce qui existait.** `Product`, sa clé d'identité (DCI, dosage, forme, conditionnement), sa résolution par degrés
et trois profils (dossier Regulatory, produit de BU, produit BD) avec un lien `productId` — et rien dans
l'application ne créait ni ne liait un produit : seul un script manuel. Base de travail : zéro produit canonique.

**Ce qui change.**
- **Un dossier à l'identité complète rejoint son produit** à sa création et à chaque modification : le produit est
  retrouvé s'il existe, créé sinon, avec un nom qui porte ce qui le distingue (« LEVETIRACETAM 500 mg · Comprimé
  pelliculé · B/60 »). Quand l'identité d'un dossier change, le lien suit : un produit qui porte déjà la nouvelle
  identité est rejoint ; sinon l'ancien produit, s'il n'a pas d'autre dossier, est corrigé sur place (c'était une
  coquille) ; sinon un nouveau produit est créé. Une identité devenue incomplète ne défait rien.
- **L'identité complète, ou rien.** DCI, dosage avec son unité, forme (« Autre » n'en est pas une) et
  conditionnement. Un dossier incomplet ne rejoint aucun produit — donc aucune Business Unit — et sa fiche dit ce
  qui manque.
- **La clé ne fusionne plus ce qui est distinct.** Mesuré sur le portefeuille réel : Lévétiracétam en flacon de
  120 ml et de 300 ml avaient la même clé ; idem pour deux associations de dosages différents, deux concentrations,
  une solution et une poudre injectables, une crème et un gel ; « A + B » et « B + A » en avaient deux. La forme se
  lit désormais dans le menu des dossiers, pas dans les familles de l'analyse de marché.
- **« 4 µg » se lisait « 4 G »** dans la normalisation pharma de tout le dépôt (le signe micro tombait) : corrigé à
  la source. « 5 000 UI » se lisait « 5 » : corrigé.
- **Le produit de BU porte le produit canonique de son dossier** : sans lui, il était refusé dans chaque rapport de
  visite. Un dossier du pipeline, deviné par son identifiant, n'entre plus au catalogue promotionnel ; « Rattacher
  un produit existant » n'efface plus le code, le référent ni le canal.
- **Regulatory › Catalogue produits** (bouton depuis Regulatory) : les produits canoniques, les dossiers à rattacher
  (un clic), les dossiers à compléter (ce qui manque), les produits de BU sans produit (et pourquoi), puis le
  rapprochement des catalogues existant. Le Super Admin rattache tout l'existant d'un geste, après un aperçu qui
  n'écrit rien. Une fiche par produit : identité, dossiers, Business Units, nom, alias, historique. Un produit se
  voit par ses dossiers : celui d'un dossier verrouillé au pipeline reste invisible à qui ne voit pas ce dossier.
- **Trois lecteurs de la liste Regulatory la recomposaient avec le défaut corrigé en phase 0** — le rapprochement
  des catalogues (qui proposait des dossiers verrouillés), la relance des dossiers et l'export Excel (sans la gamme).
  Ils lisent la clause de l'écran ; la forme fautive est interdite dans tout le dépôt.
- **Numérotation** : deux créations simultanées de produits ou de dossiers se percutaient sur leur référence ;
  passé 999, plus aucun produit ne se serait créé de l'année (maximum lu par ordre alphabétique). Réparé.

**Après le déploiement** : sur Regulatory › Catalogue produits, le Super Admin clique « Simuler » puis « Appliquer »
pour rattacher les dossiers existants ; la liste « Dossiers à compléter » dit lesquels ne s'identifient pas encore.

**Ce qui reste, nommé.** Lignes d'appels d'offres et ventes : phase 11. Le changement d'identité d'un dossier par
Adam (en pause) n'est rattrapé que par le rattachement global.

### GRAPHE AMD — PHASE 0 : L'AUDIT, ET CE QUI FUYAIT DÉJÀ (2026-10)

**Demande** (Direction, 01/10). Le chantier « graphe AMD » : une donnée créée une fois, une identité unique,
réutilisée partout — Business Units multi-spécialité, produit canonique, annuaire maître, consommation
hospitalière, affinité, potentiel, segmentation, priorités, cycles, coûts, vues 360°, cockpits. Phase 0 : auditer
le dépôt avant de construire, pour ne rien recréer sous un autre nom.

**L'audit** (carte complète : `docs/graphe-amd/PHASE0.md` ; le cahier des charges : `docs/graphe-amd/SPEC.md`). Ce qui existe et sera réutilisé : le produit canonique
(`Product`, `ProductAlias`, clé d'identité DCI + dosage + unité + forme + conditionnement) et ses profils
(Regulatory, promotion, BD) ; `PromoProduct`, l'affectation de fait d'un produit à une Business Unit ;
`PromotionAssignment` (le classement P1-P3 par KAM et par cycle) ; `BusinessUnit` ; `MedicalSpecialty` ;
`MedicalDoctor`, `MedicalInstitution` et ses services ; `SalesSector` ; `PromoCycle` et le plan de tournée ;
`MedicalVisit` et ses produits liés ; les réglages SFE ; les motifs de versions (grille de coaching, définitions de
circuit) ; les données de marché ; les imports à lot et empreinte ; la chaîne des marchés PCH ; les finances.
Ce qui manque est rangé par phase (produit canonique jamais créé ni lié par l'application, panel du KAM à deux
définitions, spécialité écrite en texte, types d'entité d'audit, budget des BU, cycles jamais clos, doublons
d'import des ventes, indicateurs PCH). Le **fichier de segmentation Adventum n'est pas dans le dépôt** : les tests
du cahier des charges seront écrits sur ses exemples, et l'import branché quand il sera fourni.

**Corrigé tout de suite, parce que ça fuyait déjà.**
- **La recherche globale montrait les lignes des autres sociétés.** Sur vingt-trois familles, quinze ignoraient le
  cloisonnement par entité que leur écran de liste applique — sponsorings, écritures, salariés, praticiens,
  marchés, contrats, courriers… —, et la moitié des fiches s'ouvraient ensuite. S'y ajoutaient les dossiers CTD
  sans la permission du module ni l'entité activée, les directives non publiées ou destinées à un autre rôle, les
  messages des groupes qu'on avait quittés, les noms des documents de modules qu'on ne voit pas, les praticiens
  des annuaires fermés et les produits hors gamme. Chaque liste a désormais **une** clause
  (`queries/visibilite-listes.ts`), que l'écran appelle pour charger et la recherche pour chercher dedans : la
  palette ⌘K ne trouve que ce que l'écran montre, ni plus ni moins.
- **L'analyse CTD faisait confiance au cookie d'entité.** Écrire l'identifiant d'une autre société dans son cookie
  ouvrait son espace CTD, téléversement compris ; sans cookie, « toutes les entités » désignait l'unique
  organisation activée, même d'une autre société. La portée est maintenant validée contre les droits, à chacun des
  trente-trois endroits qui la lisaient, et la carte qui demande de choisir une entité ne nomme plus que des
  entités qu'on peut sélectionner. L'écran des départements (RH) lisait le même cookie brut : réparé de même.
- **Le tableau Regulatory perdait sa portée** pour quiconque est rattaché à une gamme sans voir tous les dossiers :
  la clause de gamme écrasait celle de la portée par ligne et du verrou du pipeline.
- **Une visite faite passait par une porte non gardée.** La saisie rapide de « Ma journée » (et l'opération
  d'Adam qui l'appelle) acceptait une visite datée de trois semaines et n'importe quel produit, là où le rapport
  et la visite imprévue appliquent la fenêtre de 48 h et la gamme de la Business Unit ; la planification
  acceptait le statut « réalisée ». Une seule règle désormais, aux quatre portes.
- **L'import de l'annuaire lisait « D » comme « Moyen »** (et tout niveau illisible aussi, en écrasant le niveau
  connu) ; « A+ » ne se lisait jamais. Un niveau illisible n'écrit plus rien et il est signalé dans le bilan.

**Ce qui reste, nommé.** Huit fiches de détail n'appliquent pas encore le cloisonnement d'entité (un identifiant
qui fuirait par un autre chemin ouvrirait la fiche) : les fermer suppose de décider qui valide d'une entité à
l'autre — un point à trancher par la Direction. La recherche fédérée d'Adam garde ses propres familles (Adam est
en pause, Super Admin seul).

**Vérification.** Banc en base `recherche-perimetre.test.ts` (13 cas, lecteurs cloisonnés : Directeur Général
d'une seule entité, assistante réglementaire à gamme, lecteur des Documents, ancien membre d'un groupe, vue globale
prêtée par un rôle secondaire), cliquet `visibilite-listes.test.ts` (8 cas : points d'appel des deux côtés,
aucune portée recomposée dans la recherche, lecteurs du cookie déclarés), banc des portes de visite (6 cas par les
vraies actions) et lecture des niveaux d'import ; **31 sabotages, 31 chutes** — dont un d'abord passé au vert, qui
a fait écrire le cas d'une personne à deux entités.

### LES FINANCES DU 01/10 — COMPTES ANCRÉS, SOLDE DE TRÉSORERIE, PAIE ET CAISSE PAR LE CENTRE, BONS DE COMMANDE À PART, « À IMPUTER » SUPPRIMABLE (2026-10)

**Demande** (Direction, 01/10). « Le compte bancaire doit être ancré, non réécrit à chaque fois — SGA Birkhadem,
RIB 02100012113006233628, compte Adventum, 2 966 153 DZD au 28 sept. 2026 — et on peut avoir plusieurs comptes. Ce
qu'il y a dans les comptes moins les paiements autorisés, c'est le Solde trésorerie. La caisse donnée
mensuellement aux moyens généraux et la paie passent désormais par le centre de paiement et attendent la
validation ; pour la paie, un bouton pour toute la paie avec la somme des salaires à virer, un bouton par entité.
Le module Bons de commande doit être à part, et le Super Admin donne les accès à qui il veut. Donne-moi la main
pour supprimer, une ou plusieurs, les écritures « à imputer ». »

**Ce qui change.**
- **Comptes ancrés** (Finances › Comptabilité › *Comptes de trésorerie*). Un compte porte sa banque, son RIB, son
  entité titulaire, et un **ancrage** : le solde d'un relevé à une date, en fin de journée. Son solde d'aujourd'hui,
  c'est cet ancrage plus les écritures **réglées postérieures** — jamais celles d'avant, déjà dans le relevé. Ouvrir
  un compte ne réécrit plus rien (l'ancien « solde d'ouverture » s'écrasait par son nom) ; corriger l'ancrage est un
  geste à part, qui dit ce qu'il change. Chaque écriture neuve **fige son compte** en s'écrivant ; l'historique se
  rattache par son libellé de compte, puis par le compte principal de son entité. Plusieurs comptes : autant qu'il
  en faut.
- **Solde trésorerie** = **somme des comptes − paiements autorisés à régler** (Finances › Banque & paiements, avec
  le détail sous le chiffre). Une paie ou une remise de caisse autorisée par le centre s'y retranche aussitôt.
- **La paie passe par le centre de paiement** (RH › Paie, panneau *Virement de la paie*). Une carte **par entité** et
  par mois : les salaires saisis, la **somme des salaires à virer** — obligatoire, jamais pré-remplie, l'écart avec
  la somme des nets affiché en direct — et le bouton *Envoyer la paie au centre*. Le centre autorise, les Finances
  virent : **une seule écriture**, de la somme déclarée, posée au règlement. Les salariés ne sont prévenus
  (« votre salaire a été versé ») qu'une fois la paie **virée**. Un salaire saisi après l'envoi part dans un
  **complément** ; une paie refusée libère ses salaires. La matrice dit *Saisi* / *Envoyé* / *Viré*.
- **La caisse d'avance passe par le centre de paiement** (Moyens généraux). Remettre une somme crée un ordre en
  attente du centre, avec sa référence ; l'argent ne sort qu'au **versement** par les Finances (sans catégorie
  budgétaire : ce n'est pas une dépense, ce sont les achats faits sur la caisse qui s'imputent). La détentrice ne
  confirme la réception qu'après le versement ; une remise refusée se ferme, avec son motif, et elle est prévenue.
- **Bons de commande** est un **module à part** (Administration › Bons de commande, `/bons-de-commande`), ouvert
  personne par personne dans Administration › Accès ; l'ancienne adresse y mène. « À signer » prévient ceux dont la
  signature est effective — par leur métier, ou parce que la console les a désignés.
- **« À imputer » se nettoie** (Budgets › Dépenses, Super Admin) : cocher une ou plusieurs écritures, lire ce que
  la suppression va détacher, confirmer — restaurables depuis la Corbeille. Les **remises de caisse n'y figurent
  plus** : ce sont des changements de tiroir, pas des dépenses (les achats faits sur la caisse s'imputent un par un).

**Trouvé en chemin, et réparé.** (0) **Le plus important.** Avant cette règle, « marquer payé » un salaire voulait
dire qu'il était **versé** (le salarié recevait « votre salaire a été versé »). La première version de l'envoi ne
regardait que le « transfert au budget » : tout salaire marqué payé sans transfert serait ressorti « à envoyer » au
centre — donc **payable une seconde fois**. L'instant de la bascule est désormais posé une fois par la migration :
tout salaire marqué payé avant lui est **viré**, ne repart jamais au centre, et s'annonce comme avant.
(a) « Régler la paie » d'un bulletin existait encore côté Finances : il inscrivait
l'écriture SALAIRE **sans passer par le centre**. Aucun écran ne l'appelait, seule une opération d'Adam ; les deux
sont retirées. (b) La phrase après l'envoi disait « Paie de octobre … envoyé·e » : elle dit « La paie d'octobre …
est envoyée ». (c) Après une remise, l'écran affichait un texte générique : il affiche la phrase de l'action, avec
la **référence** de l'ordre à suivre au centre. (d) Le rappel « rechargement dans 48 h » dit désormais d'envoyer la
remise au centre tout de suite, pour qu'elle soit autorisée et versée à temps. (e) La fiche du centre de paiement
du README annonçait quatre issues ; il n'y en a plus que deux (autoriser, refuser) depuis le retrait de la révision
et de l'argumentation.

**Points d'attention au déploiement.** (1) Le compte SGA Birkhadem se crée en trente secondes depuis l'écran :
Finances › Comptabilité › *Comptes de trésorerie* › *Ouvrir un compte* (nom, banque, RIB, solde du relevé
2 966 153, date 28/09/2026, entité Adventum) — ou, si un compte « Banque » existe déjà, *Modifier* puis *Corriger
l'ancrage*. (2) Les salaires **déjà marqués payés** avant le déploiement apparaissent **Virés** : ils ont été versés
par l'ancien circuit, et rien ne les renvoie au centre. Seules les saisies faites **après** le déploiement partent
au centre. (3) La **rallonge** de caisse reste hors centre : la Direction l'avait assumée le
28/09 et ne l'a pas citée le 01/10 — à trancher si elle doit suivre. Détail : CLAUDE.md §118.176.

### LES POSTES AD & PRO, PLUS SIMPLES — RÉPARTITION, BILLETTERIE, SUPPRESSION, DEVIS (2026-10)

**Constat.** « Ici c'est trop complexe » (Direction, 01/10) : une carte de poste affichait jusqu'à neuf commandes,
dont plusieurs désactivées avec leur raison collée à côté, et le geste qu'on y cherchait était noyé. Un sponsoring
indirect restait UN poste qu'on ne pouvait payer qu'à un seul fournisseur ; un médecin absent de l'annuaire ne
pouvait pas être nommé ; la billetterie n'avait ni voyageurs ni réservation ; seul le Super Admin supprimait une
demande ; et un devis exigeait un fournisseur choisi dans l'annuaire.

**Ce qui change.** (1) Chaque carte de poste montre ce qu'il est, ce qu'il coûte, où il en est (frise) et UN geste
— celui de la personne qui regarde — ou ce qu'on attend et de qui ; le reste vit dans un menu « ⋯ ». (2) Le
sponsoring indirect se **répartit par nature** (« 400 000 d'imprimerie + 600 000 d'hôtellerie ») : chaque nature
devient un poste qui se valide, se commande et se paie à part ; non réparti, il ne se soumet ni ne s'accorde.
Nouvelle nature « Imprimerie ». (3) À la création d'une demande, « Médecin non présent dans l'annuaire » ouvre une
saisie libre dont les noms **s'ajoutent** aux médecins cochés. (4) Un poste de billetterie porte ses **voyageurs**
(nom, trajet, dates, passeport — tout sauf le nom peut venir plus tard) et « Demander la réservation » ouvre un
**sujet** pour l'assistante de direction, en bas de la fiche ; tout changement ensuite s'y écrit. (5) **Supprimer
une demande Ad & Pro** est ouvert au directeur des opérations et à la directrice marketing (lue sur
l'organigramme), en plus du Super Admin — réversible, devant l'aperçu de ce qui part avec. (6) Un **devis** ne
demande que son titre et son PDF. Migration `20261217090000_ad_pro_postes_simples` (nature « Imprimerie », lien de
répartition, voyageurs, sujet de réservation).

**Trouvé en chemin, et réparé.** (a) Les gestes sur les postes ne vérifiaient que le droit du module : sur un
congrès, un délégué pouvait agir sur les postes de la demande d'un collègue par un identifiant forgé (et, avec les
gestes neufs, y inscrire des voyageurs ou ouvrir une réservation). Ils lisent désormais la porte de la fiche ; hors
de portée, le poste est « introuvable ». (b) Deux sponsorings déposés à la même seconde faisaient échouer le second
sur la contrainte d'unicité de sa référence ; idem pour un sujet et une demande de pièce d'un poste. Les trois
recalculent leur référence sous collision, et un cliquet (`refs-filet.test.ts`) interdit à tout fichier neuf de
numéroter sans filet — douze fichiers existants restent une dette nommée, qui ne peut que baisser.

**Point d'attention.** Un sponsoring indirect DÉJÀ accordé avant ce lot continue sa route tel quel ; un indirect
encore en brouillon doit être réparti avant d'être soumis. Le Directeur des Opérations (rôle à part) n'a pas les
modules Ad & Pro par défaut : il ne supprime que ce qu'un accès personnalisé lui ouvre.

### LES NOTIFICATIONS SE LISENT SANS PARCOURIR TOUTE LA TABLE (2026-10)

**Constat.** Un test de performance — la boîte de décision, qui doit se composer en moins de 1,5 s — est passé de
1,2 s à 2 s sur la base de développement. La cause n'était pas la machine : la lecture « mes notifications non
lues, les plus récentes d'abord » (centre d'actions, chaque page) et la page **Notifications** (« toutes, les plus
récentes d'abord ») n'avaient pas d'index qui serve leur TRI. Pour une personne qui a peu de notifications, la base
remontait la table entière par date : **4,7 millions de lignes lues pour un résultat vide, 1,8 s**.

**Ce qui change.** Deux index — (personne, lue, date décroissante) et (personne, date décroissante) — remplacent
l'ancien (personne, lue), dont le premier est une extension. La même lecture prend désormais **0,07 ms** ; la boîte
de décision se compose en **53 ms** (médiane) au lieu de 1 964 ms. Aucune donnée n'est supprimée et aucun écran ne
change. Migration `20261216090000_notification_non_lues_index`. **Point d'attention au déploiement** : la création
d'un index bloque les écritures dans la table le temps de la construire (12 s ici pour 4,7 millions de lignes) ; la
taille de la table de production ne se lit pas depuis l'environnement de développement. Détail : CLAUDE.md §118.174.

### LE STOCK PROMOTIONNEL DEVIENT UN SOUS-MODULE À PART, SON CATALOGUE EST LA LISTE DES SUPPORTS, ET LE MATÉRIEL REMIS AUX MÉDECINS N'A QUE DEUX PORTES (2026-10)

**Demandes.** (1) « Le catalogue du matériel promotionnel doit être plus simple : ce sont les supports déjà créés qui
sont le catalogue, triés en trois familles ; on peut en ajouter par la suite. Corrige tout ce qui est lié à ça. »
(2) « Le stock du matériel promotionnel et le catalogue doivent être un sous-module à part de Sales & Marketing,
totalement à part — évidemment lié aux autres modules en cas d'achat. » (3) « Les MP remis aux médecins doivent être
mentionnés soit depuis les postes des événements, sponsorings, prises en charge…, soit lors des tournées des KAM,
donc dans les rapports terrain. »

**Ce qui change.** (1) **Le catalogue, ce sont les dix-huit supports** — fiche POSO, ADV, fiche conseils, fiche
gamme, carnet bilan, bloc-notes, sous-mains, porte-carte RDV, stylos, clé USB, sac à dos, poster, cartes
d'invitations, cadeaux de fin d'année, présentoir, stand, banner, vidéo —, posés une fois par une migration et
rangés en **Consommables / Durables / Numériques**, chacun sous sa référence `CAT-NNNN`. Ajouter un support ne
demande plus que trois choses : le **nom**, la **famille**, et s'il **existe par produit** (la fiche POSO et l'ADV, oui).
Rien n'est doublé : un article déjà créé sous le même nom (majuscules et accents mis à part), ou déclaré à la main de
la même nature, reste seul. (2) **« Stock promotionnel »** a sa propre entrée de menu dans Sales & Marketing (onglets
**Stock** et **Catalogue**), à `/stock-promotionnel` — ce ne sont plus des onglets d'Ad & Pro. Les anciennes adresses
mènent au bon écran, la vue demandée comprise. Les liens avec les achats ne bougent pas : une facture réceptionnée
entre au magasin, un poste Ad & Pro y réserve son matériel. (3) **« Remis aux médecins »** a deux sections dans le
stock : **par les visites** (les rapports terrain des tournées) et **par les opérations Ad & Pro** (ce qu'un poste
« Matériel du stock » a confirmé remis après l'événement ; un durable prêté n'y figure pas — il revient). Il n'existe
pas de troisième porte, et un contrôle automatique refuse qu'on en ajoute une.

**Trouvé en chemin.** (a) Corriger un support effaçait ce que le formulaire ne montrait plus — sa nature, sa
description — et remettait son unité à « pièce » : la correction n'écrit plus que ce que le formulaire porte. Et la
case « existe par produit », une fois cochée, ne pouvait plus se décocher (une case décochée n'envoie rien) : un
témoin caché lui permet de dire non. (b) La liste des demandes de matériel affichait encore une colonne « Type » que
les nouvelles demandes ne portent plus : elle montre leurs articles (trois noms, le reste compté), et la correction
d'une demande ne propose plus ce champ. (c) Les tests dans un vrai navigateur ont trouvé que le nom d'un support,
collé à son étiquette « Par produit », ne se désignait plus seul. (d) Une vérification de la migration — les
majuscules accentuées — ne pouvait pas échouer sur notre base, dont la langue plie déjà les accents : elle est
rejouée dans la langue qui en a besoin, et un défaut volontaire la fait désormais tomber. Détail : CLAUDE.md §118.173.

### L'ANNUAIRE DES ÉTABLISSEMENTS — LE BOUTON « RENDRE ACTIF » RÉPARÉ, LES SERVICES, LES SECTEURS PAR BU ET LES LIENS DES PRATICIENS (2026-10)

**Demande.** « Répare le bouton pour rendre actif un établissement hospitalier, teste bien l'affichage de cet
annuaire » ; chaque établissement porte ses services (ajouter, renommer, supprimer) ; les secteurs ne se renseignent
plus dans l'annuaire — chaque Business Unit a son propre découpage, fait d'établissements et d'un, de certains ou de
tous leurs services ; les annuaires des médecins et des pharmaciens se relient à cet annuaire pour les colonnes
Établissement et Service ; « fais pas mal de tests pour identifier des bugs, des disparitions, des boutons qui ne
marchent pas ».

**Ce qui change.** (1) **Le bouton** : désactiver puis réactiver un établissement marche, depuis la ligne comme
depuis la fiche. (2) **Les services** : un panneau par établissement — une liste collée s'ajoute d'un coup, les
répétitions sont dites, un renommage vers un nom existant est refusé, supprimer un service laisse le praticien dans
son établissement (sans service) et le dit. (3) **La feuille des praticiens** : Établissement et Service se
choisissent dans l'annuaire (le nom proche du texte d'avant est proposé en tête) ; changer d'établissement retire le
service ; une fiche d'avant se dit « à rattacher », et « Rattacher les établissements » relie d'un coup celles dont
le nom désigne un seul établissement actif — les autres sont nommées. (4) **Les secteurs** vivent dans la
configuration de chaque BU : un établissement entier, ou certains de ses services ; le panel du KAM suit exactement
ce découpage.

**Trouvé en chemin.** Le bouton avait une seule cause — une case précédée d'un champ caché que l'action lisait en
premier — et elle se tenait aussi dans quatre autres écrans (gammes, contacts, messages pré-définis, rechargement de
caisse) ; la même lecture fautive, sur des formulaires sans case, réactivait un secteur et effaçait sa couleur à
chaque enregistrement. L'import des praticiens, relu à cette occasion, remettait à zéro les colonnes absentes du
fichier, créait des doublons des praticiens hospitaliers, modifiait la fiche d'un collègue, et rendait invisibles
les fiches qu'un délégué importait — les quatre corrigés. Les tests dans un **vrai navigateur** ont trouvé quatre
défauts que les tests de logique ne pouvaient pas voir : une fiche rouverte juste après un enregistrement montrait
l'état d'avant (et l'enregistrer défaisait ce qu'on venait de faire) ; deux choix rapides dans la même cellule
perdaient le second ; le double-clic ouvrait la ligne du dessus, parce que la barre de sélection apparaissait
au-dessus du tableau et le poussait ; et ma première correction de ce dernier — la barre collée au bas de l'écran —
recouvrait la dernière ligne visible. La barre vit désormais sous le tableau, là où elle ne pousse ni ne
recouvre rien. **Et le contrôle écrit pour ce défaut ne le voyait pas** : rejoué contre la barre collée en bas, il est
resté vert — une barre collée s'arrête 40 px au-dessus du bord de l'écran, et le contrôle regardait précisément dans
ces 40 px. Il vérifie maintenant la cellule à dix hauteurs, et deux cas prouvent à chaque passage qu'il sait échouer.
**Le plan de tournée** acceptait, par une requête forgée, un médecin hors du territoire du délégué (l'écran ne le
proposait pas, l'action ne vérifiait pas) : seul ce qu'on ajoute est maintenant vérifié contre le panel, et ce qui était
déjà planifié reste. Détail : CLAUDE.md §118.172.

### TROIS DEMANDES DU 01/10 — LA DEMANDE DE MATÉRIEL NAÎT AVEC SES LIGNES, AD & PRO MONTRE SES ONGLETS, LES MOYENS GÉNÉRAUX N'ONT PLUS QU'UN SERVICE (2026-10)

**Demandes.** (1) « Où se trouvent le stock et le catalogue promotionnels ? Je ne les trouve pas. » (2) Moyens
généraux : « enlève les autres départements, laisse que l'Administration ». (3) « C'est directement ici que le
demandeur ajoute les lignes de matériel qu'il cherche, selon les trois familles, avec la quantité et les actions » —
sans budget estimé, sans assistante, sans Business Unit, l'entité étant automatique.

**Ce qui change.** (1) La page d'accueil d'Ad & Pro (« Toutes les demandes ») montre enfin la barre d'onglets du pôle
— Stock promotionnel et Catalogue promotionnel y sont, à un clic ; un cliquet vérifie désormais, pour toute entrée de
menu à onglets, que sa page d'accueil les montre. (2) Moyens généraux : un seul service à l'écran, Super Admin
compris ; le Super Admin garde la **désignation** du service (« Changer de service… »), proposée d'office quand aucun
service n'est désigné. Le budget compte toujours toutes les dépenses, mais « Voir la dépense » ne mène qu'à celles
que l'écran montre. (3) La demande de matériel promotionnel se compose de lignes dès sa création, au bureau comme au
téléphone ; l'entité est celle où le demandeur travaille.

**Trouvé en chemin.** Retirer le sélecteur retirait aussi le seul chemin qui écrivait le réglage : une fois le service
désigné, plus personne n'aurait pu le changer, et un Super Admin sans département restait devant « aucun département
rattaché » sans issue — d'où « Changer de service… ». L'outil d'Adam qui créait une demande de matériel la créait
sans ligne : il le dit maintenant, avant toute carte, et nomme l'écran. Et mon propre banc lisait « le premier produit
actif » de la base partagée : il est tombé sur celui d'un banc voisin, dont le nettoyage a échoué — chaque banc
possède désormais ses lignes. La suite complète a encore attrapé deux défauts du lot, que les bancs touchés ne
voyaient pas : un type importé « à l'envers » (du domaine vers la couche de lecture) et un banc devenu trop séquentiel. **À savoir** : « Budget par Business Unit » additionnait le budget ESTIMÉ des demandes de
matériel par gamme ; les nouvelles demandes n'ayant plus ni gamme ni estimation, elles n'y figurent plus. Détail :
CLAUDE.md §118.169–171.

### STOCK PROMOTIONNEL, ÉTAPES 2 À 5 — LES ACHATS ENTRENT PAR LEUR FACTURE, LES VISITES ET LES ÉVÉNEMENTS EN SORTENT, ET LE DIRECTEUR DES OPÉRATIONS FAIT COMPTER (2026-10)

**Demande.** Terminer le stock promotionnel, « toutes les étapes, entièrement » : la demande d'achat piochée dans
le catalogue avec plusieurs actions par ligne (conception, impression…) et le paiement après réception ; le
matériel remis en visite, bloqué au-delà du stock ; le matériel des événements Ad & Pro, réservé avant et
confirmé après ; les comptages demandés par le directeur des opérations, les alertes, le tableau de bord et les
propositions de refonte des durables.

**Ce qui change.** (1) **Achats** : la facture reprend les lignes du BC, le demandeur coche ce qui est reçu et
c'est cela qui entre au magasin ; l'action de chaque ligne décide ce qui se compte ; le paiement attend la
réception, sauf renoncement écrit et définitif. (2) **Visites** : un bloc « Matériel remis » dans les trois façons
d'enregistrer une visite, déduit du stock du délégué, bloqué au-delà de son solde, corrigé dans les 48 h sans
double compte ; historique par médecin. (3) **Événements Ad & Pro** : un poste « Matériel du stock », sans argent,
réservé à l'accord, confirmé après (un durable est prêté : rendu, abîmé ou perdu), le reste revenant seul au
magasin ; du matériel encore dehors bloque la clôture. (4) **Comptages** ponctuels ou réguliers, saisis par
celui qui détient le matériel ; **alertes** une fois, à la bonne personne ; **tableau de bord** ; **refontes**
proposées et tranchées.

**Trouvé en chemin.** En relisant l'étape 5 avant de la saboter : une refonte pouvait être tranchée, par son
identifiant, hors de l'entité de qui tranche, et un double clic ouvrait deux propositions identiques — les deux
fermés (périmètre relu dans l'action, index partiel). Les dormants du tableau de bord étaient coupés à cinquante
sans le dire — le total est désormais affiché. La suite complète a ensuite rendu deux rouges hors du stock : la
découverte d'actions d'Adam ne listait plus que des gestes refusés (les nouvelles actions du stock, refusées à
raison, prenaient les six places à égalité de score) — elle sépare maintenant ouvertes et refusées et compte ce
qu'elle ne montre pas ; et un banc des devis demandait des devis sur un dossier sans article, ce que l'étape 2
refuse désormais. Les écrans des étapes 2 à 4 n'avaient jamais été ouverts dans un navigateur : en écrivant leurs
parcours, la saisie d'un comptage se fermait sans rien dire (elle annonce maintenant son résumé), et cinq refus
nommaient des chemins de menu qui n'existent pas. Enfin, le parcours de la réception a trouvé un défaut de
**Legal** : l'écran de modification ne proposait que les cent devis et BC les plus récents, si bien qu'enregistrer
une facture chaînée à un BC plus ancien la **détachait** de son BC sans un mot — corrigé (la pièce actuelle est
toujours proposée, et une facture saisie ligne à ligne sur un dossier promotionnel ne change pas de BC). Détail :
CLAUDE.md §118.165–168.

### STOCK PROMOTIONNEL, ÉTAPE 1 — LE CATALOGUE, LE MAGASIN, ET DES DOTATIONS QUE LE DÉLÉGUÉ CONFIRME (2026-10)

**Demande.** Un catalogue tenu par le Super Admin, ouvert en lecture ou en écriture à qui il veut ; un stock
de matériel promotionnel à trois familles ; le magasin central géré par la directrice marketing ; le délégué
qui confirme ce qu'il reçoit ; le directeur des opérations avec la vue globale et la gestion du matériel de
ses équipes. C'est l'étape 1 d'un plan en cinq (achats et réceptions, visites, postes Ad & Pro, comptages
suivront).

**Ce qui change.** (1) **Catalogue promotionnel** (`/promo-material/catalogue`) : références fixes `CAT-0001`,
familles consommable / durable / numérique, archivage au lieu de suppression pour un article qui a servi.
(2) **Stock promotionnel** (`/promo-material/stock`) refait : une quantité est la somme des mouvements, par
**lot** (le plus tôt périmé sort d'abord, un lot périmé ne se distribue plus) et par **détenteur** (le
magasin, chaque personne) ; dotations, transferts et retours restent **en route** jusqu'à la confirmation de
celui qui reçoit — reçu en partie avec motif, refus avec motif, relance unique au troisième jour ; demandes
au magasin servies ou refusées avec motif ; annulation d'un mouvement par son inverse, jamais par
effacement. (3) **Quatre vues** — Mon stock, Mon équipe, Magasin, Vue générale — ouvertes par la règle, pas
par le rôle. L'historique de l'ancien écran est repris tel quel, solde pour solde.

**Trouvé en chemin.** L'ancien écran additionnait ses soldes en mémoire sur les cent derniers mouvements ; et
sous `/promo-material/stock`, deux onglets s'allumaient à la fois (« Matériel promotionnel » et « Stock ») —
désormais seul le plus précis, et il est annoncé aux lecteurs d'écran. Détail : CLAUDE.md §118.164.

### « RÉDIGER AVEC L'IA », LES CONTENUS DU SITE REPRIS DANS L'ERP, ET LA LIAISON DANS LA CONSOLE (2026-10)

**Demande.** La connexion au site dans la console d'administration, Super Admin seul ; les articles et offres déjà
présents sur le site présents dans l'ERP pour qu'on les modifie et les supprime ; l'IA pour écrire un article ou une
offre, en remplissant les champs exacts, modifiable ensuite.

**Ce qui change.** (1) **Administration › Site web** porte la clé, la vérification, le rapprochement à la demande et
le blocage — un seul prédicat, le Super Admin ; `/site-web` garde les contenus. (2) Le rapprochement **reprend** les
articles du dépôt du site, ses offres d'exemple (en brouillon) et les offres saisies dans son administration :
ils deviennent des contenus de l'ERP, poussés aux mêmes adresses ; un article repris puis supprimé ne revient pas,
même après un redémarrage du site sur un disque vide. (3) **« Rédiger avec l'IA »** remplit le formulaire d'un article
ou d'une offre ; rien n'est enregistré ni publié avant que la personne relise ; ni la rémunération ni la justification
ne partent au modèle ; bascule « Rédaction du site » dans le Centre de contrôle IA.

**Trouvé en chemin.** La liste des articles du site omettait leur corps : chaque rapprochement repoussait les cinq
articles repris, « écart sur body » — réparé côté site, tenu par le banc à deux serveurs (un second rapprochement :
0 repoussé). Le journal d'usage de l'IA comptait une réponse inexploitable comme un succès, et inscrivait une panne au
nom du mauvais fournisseur. Détail : CLAUDE.md §118.160.

### Ad & PRO — LES PIÈCES LIÉES EN CHAÎNE, ET UNE DEMANDE SUPPRIMÉE EMPORTE TOUTES SES BRANCHES (2026-10)

**Pièces liées (§118.161).** Le bloc « Documents » générique disparaît des sept natures : Devis → Bon de commande →
Facture, puis Engagements (sans BC) et courriers, chaque maillon avec son bouton. Le bouton « Engagement » créait un
BC par défaut — retiré. Les fichiers déjà déposés se rangent dans leur fiche (« Créer sa fiche ») sans être
téléversés une seconde fois. Les droits se lisent pièce par pièce : un document restreint ne montre plus ses fichiers
à tout lecteur de Legal.

**Suppression en cascade (§118.162).** Supprimer une demande emporte, dans une seule transaction et une seule entrée
de corbeille, sa déclaration d'information médicale, ses demandes au secrétariat, son circuit, ses postes, ses pièces
au registre — et tout revient à la restauration. Un fait qui a quitté l'ERP (règlement, pièce signée, déclaration
déposée) bloque la suppression en le disant. Les événements ne se suppriment plus par un chemin irréversible ;
consulting et « autre demande » ont enfin une suppression.

### SUJETS, PROJETS ET ENTITÉS (2026-10)

« Projets » de Pilotage s'appelle **Sujets** ; chaque sujet a son entité (sans perdre les sujets d'avant). Le registre
**Business Development › Projets** devient un module à part (`BD_PROJECTS`), réglé par le Super Admin dans la console,
et chaque projet appartient à une entité. Trouvé en renommant : l'accès temporaire d'un validateur se déduisait du
LIBELLÉ de menu de la demande — après le renommage, une validation libellée « Projets » aurait ouvert le registre BD à
treize rôles qui ne l'ont pas ; le lien stocké l'emporte désormais sur le libellé. Détail : CLAUDE.md §118.163.

### LE SITE ET L'ERP SE PARLENT DANS LES DEUX SENS — la clé se génère en un clic, les candidatures arrivent dans le recrutement (2026-09)

Demande du dirigeant, qui n'est pas développeur : « plus de limites, tout connecté, les clés générées toutes seules,
je veux quasiment rien faire ». La mise en service tient désormais en **un geste** : « Générer la clé » sur
`/site-web`, puis coller le bloc de trois lignes dans l'environnement du site sur Render (*Environment* →
*Add from .env* → *Save, rebuild, and deploy*). L'écran passe à « Relié » de lui-même.

- **Les candidatures du site entrent dans l'ERP** : chaque offre porte un formulaire (CV PDF/Word/ODT ≤ 5 Mo,
  consentement), `/carrieres` un formulaire de candidature spontanée. Une candidature pour un poste ouvert devient
  directement un **candidat** du recrutement, CV en pièce ; les autres attendent dans **Recrutement › Candidatures du
  site**, avec leur raison, pour être rattachées, classées ou effacées (ligne ET fichier).
- **La clé est fabriquée par l'ERP** et ne devient active que lorsque le site l'a réellement (il l'accepte, ou
  s'en sert) ; l'ancienne continue de publier jusque-là — aucune coupure.
- **Le site ne perd plus rien à un redémarrage** : il recharge ses offres et ses articles depuis l'ERP à chaque
  démarrage. Le disque payant n'est plus une condition de mise en service.
- **Une règle de signature, dans les deux sens** : le site vérifie la signature sur toute requête, lectures
  comprises (sa documentation disait l'inverse — corrigée) ; l'ERP signe tout, et exige la même chose du site.
- **La concurrence « une seule alerte »**, que le lot précédent déclarait non éprouvée, est jouée : huit passages
  lancés ensemble, un passage bloqué repris par un autre — une alerte à chaque fois, chaque garde sabotée seule
  faisant tomber son cas.
- **La consigne Render est celle qui reconstruit** : *Save, rebuild, and deploy*. « Save and deploy » redémarre la
  version déjà construite — peut-être l'ancienne, qui reconnaîtrait la clé sans jamais recevoir une candidature. L'écran
  le détecte (la santé du site n'annonce pas `applications`) et nomme le geste qui rattrape.
- **Un banc à deux serveurs** (`npm run bench:site-web`) lance l'ERP et le site ensemble, lit le bloc sur l'écran
  et joue le parcours entier dans un vrai navigateur : **8 étapes sur 8 en 16 s**, et le bloc collé en partie le
  fait tomber.

**Mesure** : typecheck 0 ; 9 500 tests verts sur 823 fichiers, 0 rouge ; build propre depuis un dossier vide ; `next lint` 0 erreur ; 39 sabotages, 39 chutes ; artefact des contrats 784 / 761 / 23 (6 actions ajoutées, rien perdu) ; plafonds d'architecture inchangés (frontière 427, traversées 68, fournisseurs 42, inversions, fuites du socle et cycles à 0). Côté site : typecheck 0 et build propre. Détail au §118.159 de `CLAUDE.md`.

### LE SITE ADVENTUM REÇOIT SES OFFRES D'EMPLOI ET SES ARTICLES DE L'ERP — et Adam ne peut plus publier à la place de personne (2026-09)

Le site public **adventumdz.com** reçoit désormais ses **offres d'emploi** et ses **articles de blog** de l'ERP, qui
en devient la source de vérité (module **Site web**, pôle Administration). Chaque envoi est un `PUT` rejouable sans
doublon, identifié par l'identifiant de l'ERP ; une **file** réessaie les échecs réseau et les `503` (1 s, 5 s,
30 s, 2 min, 10 min) et ne rejoue jamais un contenu que le site a refusé ; un `401` coupe tout et prévient les Super
Admins ; un **rapprochement quotidien** relit ce que le site détient, renvoie ce qu'il a perdu, rejoue une
suppression perdue — et **nomme sans le supprimer** ce qu'il détient et que l'ERP ne connaît pas.

- **Les offres** se préparent depuis une demande de recrutement, sans jamais la rémunération ni la justification ;
  elles ne sont visibles **que tant que le poste est ouvert**, et repassent en brouillon sur le site dès qu'il est
  pourvu ou clos. La demande n'est lue que **sous la portée du recrutement** : publier des offres ne donne pas le
  droit d'ouvrir un poste qu'on ne voit pas.
- **Les articles** s'écrivent en Markdown avec aperçu : un `# Titre` est refusé avant l'envoi, en nommant sa ligne.
- **Ce que le lot a trouvé ailleurs, et fermé** : le chemin générique d'Adam ne lisait pas les décisions « ce geste
  n'est pas offert à Adam » du registre — **95 actions exclues sur 125** lui restaient appelables, dont l'usurpation
  d'identité, la purge des règlements, les fiches de coaching et la publication sur le site. Il les refuse
  désormais, en citant la raison écrite. Et 33 actions déléguant leur écriture se déclaraient à tort sans écriture.

**Mesure** : 91 cas dédiés (contrat 36, Markdown 18, transport contre un `fetch` bouché 12, file et rapprochement
par les vraies actions 20, branchements du recrutement, de la portée et du battement 5) + 7 sur la décision EXCLUDED
+ 1 sur la dérivation des contrats ; 37 sabotages, 37 détectés (dont un sur le banc navigateur) ; banc navigateur **5 parcours
sur 5** contre le build de production (Direction, article, offre préparée depuis la demande, délégué refusé, téléphone). Aucun échange réel avec le site n'a été joué depuis ce
conteneur (pas de clé, sorties interdites en test) : le premier aura lieu à la mise en service. Détail au §118.158 de
`CLAUDE.md`. **Déploiement** : la migration `20261202090000_site_web_adventum` crée cinq tables et s'applique au
déploiement ; rien ne part vers le site tant que `ADVENTUM_API_KEY` n'est pas posée.

### LA FICHE DE COACHING « TOURNÉE EN DOUBLE » EN NATIF — administrée par le directeur des opérations (2026-09)

Le classeur de la Direction (« Fiche_Coaching.xlsx ») devient un écran de la **Promotion médicale** : onglet
**Coaching** (`/medical/coaching`), juste après « Plan de tournée », donc aussi dans le menu latéral. Le contenu est
celui du classeur, cellule par cellule — cinq axes, quatre niveaux de maîtrise (MB, MP, MA, PM = 1 à 4), un critère
par niveau, le total des points et le bilan ; son exemple (MA, MA, MA, MP, MP) fait **13 / 20** à l'écran comme dans
sa cellule D16.

- **Le directeur des opérations administre** (avec la Direction des opérations et le Super Admin) : il modifie la
  **grille** — chaque publication crée une **version**, et une fiche garde la sienne —, voit toutes les fiches,
  brouillons compris, **corrige une fiche finalisée** (le collaborateur en est prévenu), la retire, et coache toute la
  force de vente.
- **Le superviseur remplit** la fiche après la tournée : il clique un niveau par axe, le total se calcule sous ses
  yeux, il écrit les points forts et les points à améliorer, enregistre un brouillon ou **finalise** — ce qui partage
  la fiche avec le collaborateur et le prévient. Un KAM ne remplit pas de fiche ; personne ne se coache soi-même.
- **Le collaborateur lit SES fiches** ; un collègue ne les trouve pas, même par l'adresse.
- **Téléchargeable** : le classeur Excel de la fiche au format du modèle (total en **formule**), un classeur de suivi
  de l'équipe (une ligne par fiche + la synthèse), et une **version imprimable / PDF**.
- **Synthèse** : par collaborateur (dernière fiche, moyenne, tendance) et par axe.

**Ce que les bancs ont trouvé** : un défaut réel — ajouter un axe après en avoir retiré un réutilisait la clé de
l'axe retiré, et l'axe neuf héritait de l'historique d'un autre critère dans la synthèse ; corrigé, la clé est
attribuée par le serveur. Au téléphone, la barre d'actions masquait près d'un quart de l'écran et le total n'était
pas visible pendant la saisie ; elle tient maintenant sur une ligne et affiche le total. Et une pastille du menu
s'affichait au mauvais endroit : toute notification de la Promotion médicale (dont la fiche finalisée) allumait
aussi « Annuaires », qui porte des onglets médicaux — elle se compte désormais là où son module vit, une seule fois.

**Mesure** : 64 cas dédiés (règles pures, classeur dont les formules sont recalculées, vraies actions jouées par des
comptes sans vue globale) et 6 parcours navigateur contre le build de production (directeur des opérations,
superviseur, KAM, collègue, impression, téléphone) ; 40 sabotages, 40 détectés ; suite complète 9 352 tests verts,
0 rouge ; build propre et `next lint` sans erreur. Détail au §118.157 de `CLAUDE.md`. **Déploiement** : la migration
`20261201090000_fiche_coaching` crée deux tables et s'applique d'elle-même au déploiement (`prisma migrate deploy`
dans la commande de build de Render) ; la grille d'origine s'écrit à la première ouverture de l'écran.

