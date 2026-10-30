# 0019 — Conversions haute fidélité sur le worker, et le worker « en un clic » (30/10/2026)

**Demande de la Direction (30/10)** — « pas de limitations ; c'est notre différenciation » :
A. des conversions **fidèles**, PDF → Word d'abord (images, mise en page, polices, caractères exacts, arabe parfait, scans) ;
B. le worker Render créé ET au travail en cliquant seulement **Sync** ; C. l'état du worker visible au Super Admin.

## Le constat (vérifié dans le code)

- PDF → Word était la voie **MAISON** de J3 : le texte page par page, sans images, sans tableaux, sans mise en page
  (`pdfEnWord`, `src/lib/office/conversions-atelier.ts`) — et c'était dit.
- Le worker (J2) embarquait LibreOffice et tesseract, mais **rien** pour lire un PDF en Word ; ses variables se recopiaient
  à la main ; il démarrait en attente (`TACHES_DE_FOND=web`).

## A. Le moteur — choix MESURÉ

| Candidat (PDF → Word) | Images | Tableaux | Texte qui se reflue | Arabe | Retenu |
|---|---|---|---|---|---|
| LibreOffice `--infilter=writer_pdf_import` | oui | non (cadres de dessin) | **non** (une zone de dessin par ligne) | ordre visuel | non |
| Composition maison (J3) | non | non | oui | ordre du flux | secours seulement |
| **pdf2docx 0.5.13 (PyMuPDF 2.0)** | **oui, à leur taille** | **oui (traits)** | oui | **faux en l'état** (voir ci-dessous) | **oui, corrigé** |

pdf2docx brut sur le corpus (mesuré) : arabe en ordre mélangé (`.تعمل…`, `ملفAmoxicilline`), dates cassées (`15092026` :
les `/` perdus), puces Symbol en zone privée (`U+F0B7`), un paragraphe de cinq lignes = cinq morceaux à retours forcés,
aucun `w:bidi`/`w:rtl`/`w:cs`, retraits LTR qui jettent la 1ʳᵉ ligne arabe hors de la page. **D'où nos correctifs**
(`scripts/conversions/amd_conversions/`), branchés dans pdf2docx le temps d'une conversion :

1. **Le texte remis à l'endroit** (`texte_pdf.py`, `normaliser.py`) — on ne croit pas l'ordre du flux : les lignes d'une même
   rangée sont fusionnées, chaque caractère normalisé (NFKC **ciblé** sur les formes de présentation arabes et les ligatures
   ﬁ/ﬂ ; contrôles bidi retirés ; mojibake réparé ; puces Symbol → « • » ; NFC pour recomposer les harakat), les **grappes**
   (base + marques, ligature) rangées par position, puis l'**inverse de l'algorithme bidi** selon la direction de la ligne :
   en RTL on retourne la ligne puis on remet à l'endroit le latin et les nombres — `21-82` reste deux nombres (UBA W4 : un
   séparateur européen ne lie pas deux nombres arabes, LibreOffice l'affiche `82-21`), `DZ-2026-114`, `Amoxicilline 1 g` et
   `15/09/2026` restent entiers. Marques : rattachées à la base qui **partage leur origine** (LibreOffice pose des boîtes
   nulles), doublons de base (« طَط ») fusionnés. Espaces : celles du PDF quand il en pose (sinon PyMuPDF en invente au milieu
   des mots vocalisés), synthétisées sinon (pdfTeX).
2. **Les retours voulus seulement** — un retour n'est gardé que si le premier mot de la ligne suivante tenait dans la place
   libre (fin de paragraphe, adresse, puce) ou si la taille change (titre) ; sinon une espace de couture : Word reflue.
3. **Le Word relu** (`docx_post.py`) — `w:bidi` sur chaque paragraphe arabe (à sa place dans le schéma), `w:jc` inversé
   (mesuré : LibreOffice, comme Word, lit `left`/`right` comme début/fin en bidi), retraits LTR retirés ; runs coupés par
   écriture, `w:rtl` + `w:cs` (Noto Naskh Arabic, ou la police arabe du PDF ramenée à sa famille installée) + `w:bCs`/`w:iCs`/
   `w:szCs` ; runs morcelés refusionnés ; vraies listes (`ListBullet`) ; tableau arabe en `w:bidiVisual`, cellules dans
   l'ordre logique ; marges de cellule.
4. **En-têtes et pieds** — une ligne de la marge haute (basse) répétée sur la majorité des pages (chiffres masqués) quitte le
   corps et va dans les **vraies** zones d'en-tête/pied ; un numéro de page devient un champ `PAGE`.
5. **Les scans** (`ocr.py`) — une page sans texte (ou à plus de 5 % de glyphes inconnus) est lue par tesseract en **deux
   passages** (`ara`, puis `fra+eng`) fusionnés **ligne par ligne** (mesuré : `ara+fra+eng` d'un bloc prend « لدى » pour
   « ça) »), modèles **tessdata_best 4.1.0** (mesuré : « للريع » → « للربع », « الوظنية » → « الوطنية »). La page est
   **composée dans le Word** à la place de l'image : paragraphes (même règle de retour), **tableaux** reconstruits depuis les
   traits (OpenCV), **illustrations** découpées de l'image, en-têtes/pieds répétés. Lecture trop incertaine (confiance
   < 55) : l'**image de la page est gardée**, le texte reconnu suit. (Essayé et abandonné : recomposer une page PDF texte
   pour pdf2docx — les polices de MuPDF Story relisent mal l'arabe, « ل » rendu « Ǆ ».)

Les autres conversions : **Office → PDF** par LibreOffice (filtre par application, images sans perte, polices embarquées ;
polices Noto Naskh Arabic, Amiri, Noto, DejaVu, Liberation, **Carlito/Caladea** pour Calibri/Cambria) ; **PDF → Excel** par
le Word reconstruit (mêmes tableaux, OCR compris) → une feuille par tableau, nombres à virgule reconnus, feuille de droite
à gauche si arabe ; **image → PDF** (renderer PDF de tesseract : l'image + calque texte cherchable) ; **image → Word** (le
moteur PDF → Word) ; **PowerPoint → images** (PNG 150 ppp dans un ZIP). `ocrmypdf` n'est pas retenu : le renderer de
tesseract donne le même calque sans Ghostscript.

### Où ça tourne

`scripts/conversions/convertir.py` (une ligne JSON en sortie) ← `src/lib/office/conversions-haute-fidelite.ts` ← la voie
**WORKER** de `conversions-atelier.ts` (file `AtelierConversion`, tâche `atelier.conversions`). **Le web ne convertit jamais
lui-même quand le worker bat** (`choisirVoie`) ; sinon LOCAL si le moteur est complet ici, sinon le secours d'avant (texte
seul, DIT « secours »), ou un refus motivé. L'API ne change pas pour l'appelant : `demanderConversion`, `convertir_document`
(`vers` gagne `IMAGES`, une image désignée par son identifiant se convertit directement), menu « Convertir » de l'Atelier.
Le web fait aussi échouer, en le disant, une demande que le worker n'a pas prise en 15 min (`expirerConversionsEnFile`).

## Mesures (critères de fin)

Corpus versionné `scripts/conversions/corpus/` (généré par `generer_corpus.py` : Word → PDF par LibreOffice, HTML → PDF par
Chromium, scans à 200 ppp bruités) ; `attendu.json` = la vérité. Banc `npm run conversions:bench` (dans l'**image du
worker**, résultat : `scripts/bench/resultats/conversions.json`) :

| PDF | CER | Images (nb + dim.) | Interdits | RTL | Tableaux |
|---|---|---|---|---|---|
| fr-rapport (2 p., en-tête, liste, tableau, 2 images) | **0,00 %** | 2/2 | 0 | — | 1/1 |
| ar-note (2 p., arabe, vocalisé, tableau RTL) | **0,26 %** | 1/1 | 0 | **23/23** | 1/1 |
| mixte-ar-fr | **0,00 %** | 1/1 | 0 | 2/2 | — |
| fr-deux-colonnes | **0,00 %** | — | 0 | — | — |
| ar-chromium (autre producteur) | **0,00 %** | 1/1 | 0 | 16/16 | 1/1 |
| scan-fr (OCR) | **0,59 %** | — | 0 | — | 1/1 |
| scan-ar (OCR, paragraphe entièrement vocalisé) | **2,95 %** ✗ | — | 0 | 24/24 | 1/1 |

Word → PDF en aller-retour (le PDF produit, relu par le moteur) : CER 0,00 % / 0,26 % / 0,00 % / 0,00 %, polices arabes
réelles embarquées (`NotoNaskhArabic-Regular/Bold`) ; PDF → Excel : 1 feuille par tableau attendu. **12/13 conformes.**

**Ce qui ne passe pas, et pourquoi** : le scan arabe. Les 0,26 % du PDF arabe natif sont les deux harakat de « الصَّ »
qu'**aucune** lecture ne peut rendre (LibreOffice ne les a pas mis dans la table Unicode du PDF). Le scan arabe perd, avec
tesseract 5.5 de l'image Debian 13, une ligne courte entière (« الاستعجالية. » — l'analyse de mise en page la saute, en
psm 3, 4, 6 et 11, mesuré) et une partie des harakat du paragraphe vocalisé ; avec tesseract 5.3 (poste) : 1,28 %. Tentés et
abandonnés (mesurés pires) : agrandir l'image du passage arabe (×1,5 et ×1,67 : 30–35 %), relire seule l'encre non couverte
(bruit ajouté au scan français, ligne toujours manquée). Le texte courant arabe sans vocalisation, lui, sort juste.

Tests rapides (vitest) : `conversions-haute-fidelite.test.ts` (ar-note et mixte par le moteur, + tests Python purs de
`scripts/conversions/tests/`) — sautés en le disant là où le moteur manque ; `conversions-mesure.test.ts` (la mesure ne ment
pas : le Word source du corpus passe tous les critères) ; `atelier.test.ts` (PDF → Word par la file : images, tableau 4×4,
paragraphes bidi — ou le secours, dit) ; `controle.test.ts`.

## Suite (30/10, soir) — l'arabe VOCALISÉ

Demande : le scan arabe vocalisé sous 1 % ; trois scans vocalisés ajoutés au corpus (Naskh 300 ppp, Amiri 200 ppp,
**mauvais** : 150 ppp, flou, bruit dense, page de travers, JPEG 45), et leurs PDF natifs.

**Les PDF NATIFS vocalisés étaient le vrai trou** (mesuré : 14 % en Naskh, 41 % en Amiri). Cause : LibreOffice entoure
chaque lettre vocalisée d'un `/ActualText` couvrant deux glyphes, PyMuPDF en rend le texte deux fois. Corrigé dans
`normaliser.py` / `pdf_docx.py` : les **échos** (répétition de largeur nulle) sont retirés ; la **convention du producteur**
est reconnue ligne par ligne (LibreOffice 24.x [marque, base] avec échos ; LibreOffice 7.4 [base, marque] sans écho — la
marque posée sur la jointure de deux lettres, seule l'ordre du flux tranche) ; une marque ne se pose jamais sur un point
quand une lettre arabe la réclame ; une base orpheline posée dans la boîte d'une autre lettre est replacée par le flux ; la
grappe de fin de ligne que la lecture `/ActualText` perd est reprise de la lecture glyphe par glyphe.

**L'image passe sur Debian 12 « bookworm » pour TESSERACT 5.3** (mesuré : 5.5 lit moins bien l'arabe).

| Banc (dans l'image) | Avant (trixie, tesseract 5.5) | Après (bookworm, tesseract 5.3) |
|---|---|---|
| PDF natif vocalisé Naskh | 13,97 % | **0,81 %** ✓ |
| PDF natif vocalisé Amiri | 40,89 % | **0,81 %** ✓ |
| Word vocalisé → PDF (LibreOffice 7.4) → Word | — (≈ 48 % avant les correctifs) | 2,02 % / 2,63 % |
| ar-note Word → PDF → Word | 0,26 % | 0,13 % |
| scan arabe (texte courant) | 2,95 % | **1,28 %** |
| scan vocalisé Naskh 300 ppp | 23,48 % | 13,56 % ✗ |
| scan vocalisé Amiri 200 ppp | 64,37 % | 58,10 % ✗ |
| mauvais scan vocalisé | 25,71 % | 25,71 % ✗ |
| tous les autres (FR, mixte, colonnes, Chromium, scan FR) | conformes | conformes |

**L'OCR de l'arabe entièrement vocalisé reste hors d'atteinte localement**, mesures à l'appui :
- tesseract 5.3, modèles « best » : prétraitements essayés — médiane, binarisation de Sauvola, rendu à 400 et 500 ppp,
  psm 3/6 — **meilleur 12,5 %** (Naskh), 50,8 % (Amiri) : le modèle confond les points des lettres sous les harakat ;
- **EasyOCR** (`ar`) : ne rend **aucun** harakat (sauf le tanwin), lignes fragmentées — écarté ;
- **Surya 0.23** : c'est désormais un modèle vision-langage servi par `llama.cpp` (plusieurs Go) — impossible sur le worker
  `starter` (512 Mo), non mesuré ;
- **Kraken** : installation abandonnée après 20 min de résolution de dépendances (torch), non mesuré ;
- PaddleOCR (arabe) : modèle entraîné sans vocalisation, non retenu pour l'essai.
Aucun envoi à un service externe (documents confidentiels). La voie restante est un **modèle OCR arabe vocalisé entraîné**
(Kraken/Calamari sur un corpus vocalisé, ou un VLM sur un worker plus gros) : un lot à part, avec un plan Render plus grand.
Le texte arabe courant (non vocalisé, le cas des documents de l'entreprise) sort à 1,28 % en scan, 0–0,26 % en natif.

## Suite 2 (30/10, nuit) — l'OCR VISION, et l'aller-retour Word vocalisé

Demande : « toutes les technologies nécessaires » pour les scans arabes, sans jamais envoyer une pièce sensible.

**Le circuit** (`scripts/conversions/amd_conversions/vision.py`, `src/lib/office/conversions-haute-fidelite.ts`,
`src/modules/assistant-ia/infra/atelier/ocr-vision.ts`, garde `gardeOcrVision` dans `src/platform/ia/artifact/ports.ts`) :
1. **Passage 1** du moteur : chaque page scannée est lue localement ; celles que tesseract lit mal sont DÉSIGNÉES (arabe
   vocalisé — une lettre sur cinq porte une marque —, arabe à confiance < 85, confiance de page < 80), image et lecture
   tesseract à l'appui. Aucune ne part d'elle-même.
2. **La garde** (le socle, avant tout appel) : jamais une pièce CONFIDENTIELLE (Bibliothèque ou `Piece`), du coffre
   (`sensible`), de nature identité/paie/RIB/contrat, d'un dossier RH (clé `RH_DOCUMENT`, famille fermée), une pièce
   juridique ou un courrier enregistré, un nom qui l'annonce. Refusée : la lecture locale reste et la note le DIT
   (« OCR vision non utilisé : la pièce est classée CONFIDENTIELLE »).
3. **Le lecteur** (Assistant IA) : réglage Super Admin **Administration › IA** — une bascule du Centre de contrôle (lue par l'action, offerte par l'écran, rejouée par l'op d'Adam), COUPÉE par
   défaut, migration `20270211100000_ocr_vision`) et **plafond mensuel en dollars** (somme des appels au rôle « ocr »,
   vérifiée avant chaque page) ; appel par la porte `genererTexte` — modèle du rôle « standard » de la passerelle
   `modeles-roles.ts` (`gpt-6.1-terra`), interrupteur général, budget et **journal au nom du demandeur** (`auNomDe`,
   `AiUsageLog`/`ModelCallLog`, route « ocr »). Consigne : transcription exacte, ordre logique, harakat tels qu'imprimés,
   aucune reformulation, tableaux en `| … |`.
4. **Passage 2** : la page est composée depuis la transcription (paragraphes, tableaux, illustrations à leur hauteur),
   **vérifiée contre tesseract** (lettres de base alignées ligne à ligne : une ligne vue d'un seul côté est comptée et
   dite dans la note). **Arbitrage** : le modèle ajoute systématiquement un soukoun sur le lam de l'article (« الْ »),
   non imprimé (mesuré sur les trois scans) — il n'est gardé que si tesseract le voit aussi.

**Mesure** — UN passage réel du banc (`npm run conversions:bench -- --vision`, poste avec tesseract 5.3, base de banc,
réglage actif) : **0,060 $** pour 4 pages. Dépense totale des essais : **0,119 $** (3 passages : une page, puis tous les
scans avant et après l'arbitrage du soukoun), journalisée au rôle « ocr ».

| Scan | Local seul (tesseract 5.3) | Avec OCR vision |
|---|---|---|
| scan arabe courant (page 2 vocalisée désignée) | 1,28 % | **0,64 %** ✓ |
| scan vocalisé Naskh 300 ppp | 13,56 % | **0,20 %** ✓ |
| scan vocalisé Amiri 200 ppp | 58,10 % | **0,40 %** ✓ |
| mauvais scan vocalisé (150 ppp, flou, bruit, de travers) | 25,71 % | **0,00 %** ✓ |
| scan français (non désigné : lu localement) | 0,59 % | 0,59 % ✓ |

**L'aller-retour Word vocalisé → PDF (LibreOffice 7.4) → Word** : cause trouvée — LibreOffice 7.4 n'émet d'écho que pour
les lettres porteuses de hamza (« لأ ») et pose la marque sur la jointure de deux lettres ; corrigé localement : l'écho
désigne la base de ses marques (lien prioritaire), une marque ne va jamais sur un point. **Naskh 2,02 % → 0,40 % ✓,
Amiri 2,63 % → 1,01 %** (une erreur de trop : « اِقْرَأْ » final, fatha et soukoun posés au même point, aucune lecture ne
les départage). Les illustrations d'un scan : les « figures » faites de texte mal lu ou de bruit sont écartées
(composantes de la taille d'une lettre, encre résiduelle < 2 %).

## B. Le worker « cliquez Sync, c'est tout »

`render.yaml` : `TACHES_DE_FOND=les-deux` sur le web ET le worker (le bail par tâche départage ; tant que le worker n'a pas
battu, le web fait tout comme avant ; dès qu'il bat, le web lui laisse travaux longs et conversions) ; `APP_URL` littérale ;
`DATABASE_URL` par `fromDatabase` ; `AUTH_SECRET`, `OPENAI_API_KEY`, `S3_*`, `VAPID_*`, `ADVENTUM_*` par **`fromService`**
depuis le web. Render ne documente pas le sort d'un `fromService` vers une clé **absente** du web : ne sont reliées que des
clés que le bloc web déclare (`OPENAI_API_KEY` y est ajoutée en `sync: false`, ce qui ne touche pas une valeur posée). Les
autres (Google, Microsoft, Mistral, courriel) : le **contrôle au démarrage** les dit absentes. Plans : base et web
inchangés (décision en attente) ; worker `starter`.

**Contrôle au démarrage** (`src/lib/taches-de-fond/sante.ts`, appelé par `scripts/worker.ts` une fois la base à jour) :
chaque variable recensée dans le code du worker (critique / importante / facultative, avec ce qui ne marche pas sans elle)
et le moteur (`convertir.py --verifier` : paquets, tesseract ara/fra/eng, LibreOffice, polices) ; une ligne de journal par
manque (`worker.controle.manque`) et le rapport en base (table `ControleWorker`, migration `20270211090000_controle_worker`,
additive) — jamais une valeur. L'image elle-même refuse de se construire si le moteur ne se déclare pas complet.

## C. L'écran

Administration › Diagnostic › **« Worker et conversions »** (Super Admin) : worker vivant ou silencieux, dernier battement,
contrôle au démarrage (prêt / incomplet, chaque manque en clair), moteur complet ou non, file des conversions (en file, en
cours, faites et échouées sur 24 h, la plus ancienne en file), cinq derniers échecs avec leur motif.

## Ce qui reste

- Le scan arabe entièrement vocalisé (ci-dessus) : un modèle OCR arabe plus fort (service externe, ou tesseract entraîné)
  serait un lot à part — et une dépense.
- Gras/italique d'une page **scannée** ne sont pas reconnus (tesseract ne les rend pas).
- Une page mi-numérique mi-scannée (texte + tampon scanné) suit la voie numérique : le tampon reste une image.
