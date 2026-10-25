# 0007 — R4 : moteur Mastra sur MiMo

> Date : 25/10/2026. Code : `src/lib/agent/` et `src/app/(app)/assistant/beta/actions.ts`.

## Ce qui change

- `/assistant` (interface `assistant-beta/`) répond par le **moteur Mastra**, sur **MiMo seul**
  (`mimo-v2.6-flash`, `https://token-plan-ams.xiaomimimo.com/v1`). Clé : `MIMO_API_KEY` ou `mimo`.
  Aucun appel OpenAI. Délai d'un tour : 45 s (`MIMO_TIMEOUT_MS`).
- Mastra parle à MiMo nativement (`{ providerId, modelId, url, apiKey }`) : **aucun paquet ajouté**.
- **Outils V1** (`outils-v1.ts`) — tous existants : `directory_lookup`, `directory_list`, `regulatory_portfolio`,
  `regulatory_workload`, `regulatory_knowledge`, `list_my_tasks`, `search_products`, plus `create_task` et `send_message`.
- **Écritures** : `buildProposal` (destinataire par son nom, refus s'il est introuvable, ambigu ou collectif)
  → `persistActionIntents` (intention PROPOSED, rien d'écrit) → `executeAssistantAction` à la confirmation
  (droit revérifié, `envoyerMessageDirect`, notification, audit). `ecritures.ts` (Gemini, écriture directe en base)
  et `integration.test.ts` (Prisma simulé) supprimés ; `scripts/chat-agent.ts` aussi (appel MiMo non filtré).
- **Filtre** : chaque résultat d'outil passe `censurerSortie` avant le modèle (JSON gardé JSON).
- **Contexte** : plus d'e-mail ; page réduite à son adresse (validée) ; plus de `donneesObjet` ; erreur de base →
  refus « service indisponible » ; règles du prompt « Generative UI » en français.
- Plus d'« Adam » : l'assistant se présente comme l'assistant d'Adventum Pharma.

## Pièges mesurés

- Mastra ne lève **pas** sur un délai dépassé (`finishReason: "aborted"`, texte vide) ni sur une panne survenue
  après un outil : `repondre.ts` traite les deux comme un échec.
- `generate` utilise `doGenerate` du modèle, pas `doStream`.
- MiMo a épuisé 5 étapes sans rédiger (« mes dossiers en cours ») : limite portée à 8 ; une réponse vide sans
  proposition est un échec, jamais une bulle vide.
- Le motif IBAN du filtre a été testé sur 133 identifiants et codes réels : aucun abîmé.

## Mesure (amd_dev, Super Admin, 5 questions)

| Question | Ancien moteur (OpenAI) | R4 (MiMo) |
|---|---|---|
| Bonjour | 1,7 s | 3,7 s |
| Qui est Raihana ? | 2,0 s | 16,2 s |
| Mes dossiers réglementaires | 12,9 s | 21,1 s |
| Mes tâches | 4,1 s | 11,5 s |
| Crée une tâche (proposition) | 2,0 s | 9,7 s |

## Ouvert

- **Lenteur** : l'interface attend la réponse complète. Affichage au fil de l'eau = R4b.
- **Qualité** : « mes dossiers » → MiMo lit la charge personnelle (`regulatory_workload`, 0) au lieu du
  périmètre (`regulatory_portfolio`, 144 selon l'ancien moteur). À traiter en R7.
- Une seule carte de confirmation affichée par réponse ; les actions CRITIQUES (ressaisie) échouent proprement.
