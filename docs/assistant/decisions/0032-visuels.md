# 0032 — Images, vidéos et vidéos de données générées (lot K2, 31/10/2026)

**Demande de la Direction** : « Graphiques, images, etc. générés à partir des données de l'ERP, dans la réponse et
exportables. Utilise les meilleurs modèles pour image et pour vidéos. » Les graphiques restent au lot K1 (moteur non
touché) ; K2 ajoute les **images**, les **vidéos** et les **vidéos de données**.

> Code : module `src/modules/assistant-ia/` — `domaine/visuels/regles.ts` (filtre de consigne, coûts, réglages, vue de la
> carte — pur), `domaine/visuels/video-donnees.ts` (spécification vérifiée, sous-titres calculés, image SVG à l'instant
> t — pur) ; `infra/visuels/fournisseurs.ts` (OpenAI images et vidéos, secours Gemini), `infra/visuels/service.ts`
> (portes, Drive, état, tâche de fond), `infra/visuels/rendu-donnees.ts` (sharp + ffmpeg), `infra/visuels/outils.ts`
> (4 outils) ; `infra/consommation.ts` (`journaliserVisuel`, `depenseVisuelsDuMois`, `refusSiIaCoupee`, `avertirPersonne`) ;
> `ecrans/reglages-visuels.tsx` + `actions-consommation.ts` (`enregistrerReglagesVisuels`). Socle IA : bloc `visuel`
> (`platform/ia/workspace/protocol.ts`), rendu `platform/ia/ecrans/blocks/visuel.tsx` (une ligne au registre de
> `blocks.tsx`), famille `VISUELS` (`platform/ia/capacites/familles.ts`). Routes `app/api/assistant-ia/visuels/[id]` (état)
> et `[id]/media` (fichier, requêtes partielles). Tâche `assistant.visuels` (`lib/scheduled.ts`). Migration additive
> `20270216110000_assistant_ia_visuels` (une table `AssistantIaVisuel`, huit colonnes de réglage).

## 1. Ce que la personne demande, ce qu'elle obtient

| Outil | Ce qu'il fait | Où ça tourne |
|---|---|---|
| `generer_image` | une image depuis une description ; charte Adventum et **logo officiel** (fourni par l'application, jamais redessiné) sur demande | dans le tour (10–30 s) |
| `modifier_image` | une NOUVELLE image depuis une pièce jointe ou un fichier image du Drive (droits relus), l'originale intacte | dans le tour |
| `generer_video` | une vidéo du modèle vidéo (4/8/12 s) | **arrière-plan** (tâche `assistant.visuels`) |
| `video_de_donnees` | un graphique **animé** (barres, courbe, classement) des chiffres lus, 8 s, MP4 1080², sous-titré | arrière-plan (ffmpeg : worker, ou le web s'il l'a) |

Chaque visuel : **dans la réponse** (bloc `visuel` : image pleine largeur, plein écran au toucher ; vidéo au lecteur natif,
`playsInline`, plein écran du système), **au Drive** de la personne (dossier « Visuels de l'assistant », inscrit à la
Bibliothèque), **téléchargeable** (`?dl=1`, journalisé). Une vidéo affiche une carte « Vidéo en cours » qui relit son état
toutes les 4 s et devient le lecteur ; la conversation continue ; une **notification** part à la fin (cloche + téléphone).

## 2. Les modèles — mesurés, pas supposés

- **Images** : 3 essais par modèle le 31/10/2026 (même consigne, `medium`, 1024²) : `gpt-image-2.5-sunburst` et
  `gpt-image-2.5-flare` rendent le même nombre de jetons (75 en entrée, 439 en sortie) donc le **même coût, 0,0135 $** ;
  sunburst est plus riche en détails (photo d'équipe), flare plus rapide (9–13 s contre 14–18 s), texte français parfait
  pour les deux. **Défaut : sunburst** ; flare réglable. `gemini-3-pro-image` n'est appelé **que si OpenAI échoue ou refuse** —
  la réponse et la carte le disent (« secours : OpenAI a refusé »).
- **Vidéos** : `sora-2-pro` / `sora-2` sont listés sur la clé avec **`shutdown_date: 2026-09-24`**, et `/v1/videos` répond
  **404**. Côté Gemini : aucun Veo. **Aucune vidéo générative n'est donc disponible aujourd'hui.** Le pipeline complet est en
  place (lancement, suivi, téléchargement, Drive, coût à la seconde, avis) mais l'outil **vérifie d'abord** la fiche du modèle
  (`etatModeleVideo`) et refuse sans rien lancer ni facturer, en proposant une vidéo de données ou une image. La console le
  dit aussi (« Indisponible chez le fournisseur »). Interrupteur **coupé par défaut**. → **Décision à prendre par la Direction**
  (§ 7).
- **L'API Claude ne génère ni image ni vidéo** : rien n'est promis de ce côté.

## 3. Les chiffres d'une vidéo de données viennent du code

- Le modèle désigne la forme, le titre, les libellés et les valeurs ; **chaque valeur doit figurer dans les sorties d'outils
  du tour** (journal du tour, déjà jetonné : une rémunération n'y est qu'un repère, donc jamais animable). Une seule valeur
  absente : refus qui la nomme. Aucun outil appelé : refus (« lis d'abord »). Un chiffre dans le titre : refus.
- Les **sous-titres sont calculés** (`sousTitres`) : titre ; « En tête : … » ou « Point le plus haut : … » ; « Total : … »
  ou « De … à … : +x % » ; « Source : … ». Nombres en français (espaces fines, virgule, M / Md).
- Rendu : 192 images SVG (24 i/s × 8 s) rastérisées par sharp, encodées par ffmpeg en **H.264 High, yuv420p, faststart**
  (lecture directe sur iPhone). Mesuré : ~3,8 s de rendu, 170–245 Ko.
- ffmpeg n'est pas sur le web Render : la vidéo reste « en file » et le **worker** (Dockerfile.worker installe déjà ffmpeg)
  la rend au battement suivant. Une file non prise en 20 min ou un rendu interrompu passe en **échec dit** (avis), jamais
  « en cours » pour toujours.

## 4. Confidentialité

La consigne d'une image ou d'une vidéo passe `filtrerConsigne` : le filtre de texte (IBAN, RIB, NIN, n° de pièce, montants
de salaire), les repères `⟦Sn⟧`, et les **mots** d'un dossier confidentiel (salaire, rémunération, paie, bulletin, passeport,
CNI…). Un seul : **rien ne part**, refus dit. Le modèle ne reçoit jamais l'image produite, seulement son état.

## 5. Gouvernance

- **Console du Super Admin** (Administration › IA, carte « Images et vidéos générées », à côté de l'OCR vision) :
  interrupteurs images (défaut : actif), vidéos du modèle (défaut : **coupé**), vidéos de données (défaut : actif) ; plafond
  **mensuel** en dollars (images 20 $, vidéos 30 $) ; modèle d'image, modèle vidéo, durée max (8 s) ; dépense du mois affichée.
  Action `enregistrerReglagesVisuels` (Super Admin seul, à l'audit avant/après ; exclue du registre d'Adam : une IA ne règle
  pas ses propres plafonds).
- **Portes, dans l'ordre, avant toute dépense** : interrupteur de la nature → interrupteur général de l'IA → filtre de la
  consigne → plafond du mois (somme des `AiUsageLog` route `image` / `video`, coût réel). Refus clair au-delà.
- **Coût réel journalisé** par génération : `ModelCallLog` (rôle `image` / `video`) et `AiUsageLog` — jetons rendus par le
  fournisseur × grille publique (gpt-image 2.5 : 5 $ / M texte, 8 $ / M image en entrée, 30 $ / M image en sortie ;
  gemini-3-pro-image : 2 $ / 120 $) ; vidéo : secondes × 0,30 $ (sora-2-pro) ou 0,10 $ (sora-2).
- **Droits** : famille **« Images & vidéos générées »** (`VISUELS`) de la console `/admin/ai/acces`, **fermée par défaut**
  (aucun écran ne l'ouvre) — la Direction l'ouvre par rôle ou par personne ; le Super Admin l'a toujours. Les outils ne sont
  offerts qu'à la conversation : ni routines ni travaux (`ECRITURES_DU_MOTEUR`).

## 6. Ce qui reste à K1

Le moteur des graphiques (`viz`, composants `chart`) n'est pas touché. K2 ajoute un type de bloc (`visuel`, une ligne au
registre des rendus) et garde tout le reste dans ses propres fichiers.

## 7. Décisions à prendre par la Direction

1. **Vidéo générative** : le fournisseur a arrêté Sora le 24/09/2026 et aucun modèle vidéo n'est servi sur nos clés. Options :
   (a) attendre un successeur OpenAI (le pipeline le prendra en changeant le nom du modèle dans la console) ; (b) ouvrir un
   autre fournisseur (Veo via Vertex AI, Runway, Kling…) — nouvelle clé, nouveau contrat de données ; (c) s'en tenir aux
   vidéos de données.
2. **Famille fermée par défaut** : l'ouvrir à quels rôles (Marketing, Direction) ?
3. **Plafonds** : 20 $ / mois d'images ≈ 1 500 images moyennes ; à confirmer.

## 8. Preuves sur serveur réel et coûts mesurés (31/10/2026)

Build propre en mode app (`APP_MODE=adventum-ia RENDER=1 npm run build:render`), `next start` sur la base de banc `amd_bench`
(Super Admin du banc), Playwright iPhone 13 (390 px) et bureau 1280 px. Captures : [`docs/assistant/preuves/k2/`](../preuves/k2/).

| Preuve | iPhone 13 | Bureau |
|---|---|---|
| Image générée, dans la réponse, enregistrée au Drive, téléchargée (200, `attachment`) | `iphone-1`, `iphone-2` (plein écran) | `bureau-1`, `bureau-2` |
| Vidéo de données : carte « en cours », on continue à discuter, lecteur prêt, lecture (206 sur `Range`, 8 s, 1080²) | `iphone-3` → `iphone-5` | `bureau-3` → `bureau-5` |
| Vidéo du modèle : coupée (refus de l'interrupteur) puis active (refus « Sora arrêté le 24/09/2026 », rien facturé) | `iphone-6` | `bureau-6` |

`scrollWidth == largeur` à chaque étape (390 / 1280). Console : seulement deux 404 de `/api/uploads/limites`, route du lot
J11 absente de l'allowlist du mode app — corrigé dans ce lot (`platform/app-mode.ts`).

**Coûts réels** (journal `AiUsageLog`) : génération d'image **0,0140 $** et **0,0139 $** (gpt-image-2.5-sunburst, medium
1024², 16 s) ; modification d'image (une image source de 1 024 jetons) **0,0216 $** (19 s) ; vidéo de données **0 $** de
modèle (~4 s de rendu, 155–245 Ko) ; vidéo du modèle : **aucune mesurable** (non servie). Total du lot, essais compris
(5 images d'essai, 2 images de preuve, 1 modification, ~10 tours de conversation) : **≈ 0,2 $**.
Le banc n'ayant aucune écriture financière, six décaissements réglés ont été ajoutés à `amd_bench` (seulement) pour que
`finance_totals` rende des montants à animer.
