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
manque (`worker.controle.manque`) et le rapport en base (table `ControleWorker`, migration `20270210090000_controle_worker`,
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
