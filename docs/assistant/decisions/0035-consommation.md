# 0035 — La consommation IA, au jeton et au micro-dollar près (lot K8, 31/10/2026)

**Demande de la Direction** : « Je veux que tu ajoutes de manière extrêmement précise, la consommation en token et du
coup aussi en dollars dans les paramètres de Adventum IA, ou la consommation en API en général. Ça doit être extrêmement
précis. »

> Code : grille `src/lib/models/tarifs.ts` (pure, navigateur compris ; vue du socle `platform/ia/telemetry/tarifs.ts`) ;
> coût d'une ligne `platform/ia/telemetry/cout-journal.ts` ; puits `platform/ia/telemetry/usage-sink.ts` ; imputation hors
> tour `lib/models/telemetry.ts` (`sousImputation`, `recordProviderCall`, file d'attente avant le puits) ; démarrage
> `src/instrumentation.ts` ; facture `platform/ia/telemetry/facture-openai.ts`. Module `assistant-ia` :
> `domaine/consommation-vue.ts` (périodes, usages, export — pur), `infra/consommation-detail.ts` (lecture du journal,
> périmètre), `infra/consommation-rapprochement.ts`, `actions-consommation.ts` (`lireConsommationIa`),
> `ecrans/consommation/tableau-consommation.tsx` (le composant, deux écrans), route
> `app/api/assistant-ia/consommation/export` (CSV, Excel). Migration additive `20270217100000_consommation_precise`.

## 1. Une seule source : le journal `ModelCallLog`, un appel payé = une ligne

Toutes les vues (Réglages d'Adventum IA, Administration › IA, export) lisent **le journal réel**, rien d'autre — aucune
donnée simulée, aucune estimation affichée comme un fait. Colonnes ajoutées (additives, défaut 0) :

| Colonne | Ce qu'elle porte |
|---|---|
| `audioInputTokens`, `cachedAudioInputTokens`, `audioOutputTokens` | la part AUDIO des jetons (voix temps réel, transcription, synthèse) |
| `imageInputTokens`, `cachedImageInputTokens`, `imageOutputTokens` | la part IMAGE (génération d'images, image en entrée) |
| `durationMs` | la durée FACTURÉE (Whisper, GPT-Live, vidéo) — distincte de `ms`, la durée de l'appel |
| `pages` | les pages d'OCR (Mistral) |
| `estimated` | VRAI quand les jetons sont estimés (l'API n'a rien rendu : `/audio/speech`, équivalents de durée) |
| `batch` | appel de l'API Batch (moitié prix) |
| `priceGrid` | la date de la grille qui a calculé `costUsd`, « env » pour un tarif posé, « appelant » sinon |

**Convention** : `inputTokens` = TOUTE l'entrée (texte + audio + image), `cachedInputTokens` = tout le cache lu ; les
colonnes audio/image en sont des **parts** ; le texte est ce qui reste. Même règle en sortie. `reasoningTokens` est une
part de `outputTokens` (facturé comme de la sortie, jamais ajouté deux fois).

## 2. La grille des tarifs — datée, vérifiée, par type de jeton

`src/lib/models/tarifs.ts` : une ligne par modèle (entrée, entrée en cache, sortie, audio entrée/cache/sortie, image
entrée/cache/sortie, par minute, par seconde, par page), avec **sa source et sa date de relevé**. Relevée le
**31/10/2026** sur la documentation publique : OpenAI (developers.openai.com/api/docs/pricing), Gemini
(ai.google.dev/gemini-api/docs/pricing, « Last updated 2026-10-30 »), Anthropic (platform.claude.com/docs/en/about-claude/pricing).
Recherche web : 10 $ les 1 000 appels.

- **Le coût est calculé en ENTIERS** (BigInt, au pico-dollar), arrondi une fois au micro-dollar (demi vers le haut),
  écrit en chaîne dans `costUsd Decimal(12,6)`. Les sommes de l'écran sont faites en base (`SUM` de `Decimal`) puis en
  BigInt : aucun flottant n'entre dans un montant.
- **Un modèle hors grille, ou un type de jeton consommé sans prix → `null`** : l'écran écrit « tarif inconnu », jamais 0 $.
  Absents faute de prix publié vérifiable : Mistral OCR (`mistral-ocr-latest`), MiMo (journaux d'avant le 28/10).
- **Un tarif posé dans l'environnement prime** (`ADAM_PRICE_<RÔLE>_*`, `ASSISTANT_IA_PRICE_*`) : `priceGrid = "env"`.
- Affichage : six décimales exactes (« 0,004900 $ ») et l'arrondi lisible à côté (« < 0,01 $ », « ≈ 12,35 $ »).

**Erreur corrigée** : l'Assistant IA facturait `gpt-6.1-terra` au défaut « openai » de 2 $ / 0,20 $ / 12 $ (le tarif de
`gpt-5.6-terra`). Le prix publié est **1 $ / 0,05 $ / 5 $** : les coûts journalisés avant K8 sont **surestimés** pour ce
modèle — ×2 sur l'entrée, ×4 sur le cache, ×2,4 sur la sortie, soit **≈ ×2,45 sur un tour type** (10 000 jetons d'entrée
dont 88 % en cache, 500 de sortie : 0,010160 $ journalisés contre 0,004140 $ réels). Ils ne sont pas réécrits (le journal est un registre) — voir § 7.

## 3. L'audit d'exhaustivité — les trous trouvés, et bouchés

| # | Chemin | Avant | Après |
|---|---|---|---|
| G1 | Plongements (`lunaEmbed`, `/embeddings`) — corpus réglementaire, Drive sémantique, connaissances | **aucune ligne** | une ligne, jetons RENDUS (`usage.prompt_tokens`) |
| G2 | Mistral OCR (`/v1/ocr`) — tout OCR de document | **aucune ligne** | une ligne, `pages` rendues (`usage_info.pages_processed`) ; coût inconnu (prix non vérifié) |
| G3 | Transcription des médias du Drive et des pièces d'Adam (`lib/media/stt.ts`) | **aucune ligne** | une ligne, usage RENDU (jetons audio pour `gpt-*-transcribe`, durée pour Whisper) |
| G4 | `transcribeAudio` (dictée, réunions, rapports terrain, bibliothèque) | `AiUsageLog` seul | une ligne `ModelCallLog`, usage rendu |
| G5/G6/G7 | `callLuna` (KPI, briefing, budgets, RH, devis, lecture de pièces, revue réglementaire…) | la moitié sans ligne, l'autre à la main | journalisé **dans `callLuna`** (point unique), raisonnement compris ; les 4 journaux manuels retirés (pas de double compte) |
| G8 | API Batch (revue réglementaire différée) | registre du dossier seul | une ligne `batch: true`, moitié prix |
| E1 | Transcription de l'Assistant IA | ESTIMÉE (durée × 10, nulle pour `gpt-transcribe`) | usage RENDU ; les équivalents ne servent plus qu'au plafond |
| E2 | Synthèse vocale (`/audio/speech`) | estimée, tarif générique | toujours estimée (l'API ne rend rien) mais **marquée `estimated`**, sortie comptée en AUDIO à la grille |
| E3 | GPT-Live | équivalents à 83,33 $/M, rôle « synthese » | **durée facturée** (0,05 $/min à la seconde), rôle « voix » |
| E4 | Voix temps réel d'Adam (`gpt-realtime-2.1`) | texte et audio fondus dans le total ; journal perdu à la fermeture de l'onglet | ventilation audio journalisée ; envoi `keepalive` |
| E5 | Assistant IA (Mastra) | un seul tarif pour tous les modèles | tarif **par modèle** à la grille (`gpt-6-luna` n'est plus facturé comme Terra) |
| E6 | Responses : relance sur `max_output_tokens` | le premier appel PAYÉ était oublié | journalisé |
| E7 | Chat Completions | raisonnement jamais lu | `completion_tokens_details.reasoning_tokens` |
| E8 | Anthropic (repli) | coût `null` ; cache hors du total | grille Claude ; lecture et écriture de cache rajoutées au total d'entrée |
| E9 | Appels de la passerelle lancés par l'Assistant IA hors tour d'Adam (recherche web…) | ligne sans personne ni usage | `sousImputation` : personne, conversation, `assistant_ia` |
| E10 | Appels partis avant le branchement du puits | **perdus en silence** | file d'attente (500) + puits branché au démarrage (`instrumentation.ts`, worker) |
| E11 | Vidéo (Sora) | secondes écrites dans `outputTokens` | `durationMs` |

Un banc (`consommation-precise.test.ts`) recense **tout fichier de `src/` qui appelle un point payant** et exige qu'il
écrive au journal, ou qu'il figure dans une liste d'exceptions **avec la raison** (le journal est écrit plus loin).

**Trous connus, non bouchés** (décisions § 7) : la recherche web de Mastra n'est pas comptée à l'appel (`webSearchCalls`
reste à 0 pour l'Assistant IA) ; une étape Mastra interrompue par délai perd son usage ; `/audio/speech` ne rend pas
d'usage (estimé) ; les totaux de la voix temps réel sont comptés par le navigateur.

## 4. L'écran « Consommation »

**Réglages d'Adventum IA › Consommation** (et le même composant dans **Administration › IA**) :

- Aujourd'hui, 7 jours, mois en cours, mois précédent (jours d'Alger), et une **période choisie** (du… au…, inclus).
- Ventilé **par type de jeton** (entrée, cache, sortie dont raisonnement, audio, image, recherches web, durée, pages —
  chaque poste à son prix), **par modèle**, **par usage** (conversation, voix, transcription, images, vidéos, analyse,
  travaux en arrière-plan, Adam, missions, traitements de fond), **par conversation**, et **appel par appel** (heure,
  modèle, jetons de chaque type, coût exact, durée), exportable **CSV** (« ; », BOM) et **Excel**.
- **Graphique jour par jour** (coût ; info-bulle, table équivalente).
- **Super Admin** : bascule « Toute l'entreprise » — toutes les personnes (Adam compris), tous les fournisseurs, le
  worker (« Système »), la ventilation **par personne**, le filtre par personne, les **plafonds en cours** et les
  plafonds atteints.

**RBAC** : « Ma consommation » ajoute `userId = <la personne connectée>` à **chaque** requête (l'écran, l'action, l'export) ;
un paramètre de personne y est ignoré. « Toute l'entreprise » est refusé à qui n'est pas Super Admin, côté serveur.

## 5. Le rapprochement avec la facture

Avec une **clé administrateur** OpenAI (`OPENAI_ADMIN_KEY`), l'écran entreprise lit l'API Costs
(`/v1/organization/costs`) sur la période et affiche **facturé · journalisé · écart (et %)**. Sans clé, il le dit :
« Rapprochement non configuré » — rien n'est inventé. Limites dites à l'écran : la facture est par jour UTC et couvre
toute l'organisation.

## 6. Vérifié

Captures sur serveur réel (iPhone 13, bureau, ERP) : `docs/assistant/captures/0035/`.

Tests : `src/lib/models/tarifs.test.ts` (chaque type de jeton calculé à la main, arrondis, inconnu ≠ 0),
`src/modules/assistant-ia/consommation-precise.test.ts` (RBAC contre la vraie base, exhaustivité, rapprochement, périodes,
CSV), `usage-sink.test.ts` (coût recalculé à la grille). Le crédit OpenAI étant épuisé (31/10 ~19:15 UTC), aucun appel
réel n'a servi à vérifier.

## 7. Décisions laissées à la Direction

1. **Poser `OPENAI_ADMIN_KEY`** (clé administrateur de l'organisation, Render) pour activer le rapprochement.
2. **Recalculer les coûts d'avant K8** ? Les lignes `gpt-6.1-terra` sont surestimées (≈ ×2,45 sur un tour type). Option : un script
   idempotent qui réécrit `costUsd` à la grille et pose `priceGrid` (le journal cesse alors d'être un registre brut).
3. **Mistral OCR** : confirmer le prix à la page sur le compte (non publié de façon vérifiable) — en attendant, « tarif inconnu ».
4. **Synthèse vocale** : passer `/audio/speech` en flux SSE pour obtenir l'usage RÉEL (aujourd'hui estimé).
5. **Voix temps réel** : faire compter l'usage par le serveur (webhook / sideband) plutôt que par le navigateur.
