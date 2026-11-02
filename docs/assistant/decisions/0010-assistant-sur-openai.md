# 0010 — L'Assistant IA tourne sur OpenAI `gpt-6.1-terra` (28/10/2026)

**Décision (Direction, 28/10/2026)** : « L'API de l'assistant IA doit être celle d'OpenAI qu'on a déjà — OpenAI GPT 6.1 terra. »
Elle remplace MiMo (décisions [0006](0006-correctif-urgence-et-ui-generative.md) et [0007](0007-r4-moteur-mastra-mimo.md)).

## Pourquoi
- La clé MiMo n'avait jamais été posée en production : l'assistant y répondait « L'IA n'est pas configurée sur ce serveur »,
  alors que la clé OpenAI (`OPENAI_API_KEY`) sert déjà tout le reste de l'ERP.
- Un seul fournisseur à payer, à surveiller et à régler.

## Ce qui change
- `src/lib/agent/modele.ts` : `modeleOpenAi()` lit `OPENAI_API_KEY` ; modèle `gpt-6.1-terra` (surchargeable par
  `ASSISTANT_IA_MODEL`), délai `ASSISTANT_IA_TIMEOUT_MS`. Toujours **un seul** modèle, sans secours vers un autre fournisseur.
- **API Responses, pas chat/completions** : mesuré le 28/10, `/v1/chat/completions` refuse les outils avec raisonnement sur
  `gpt-6.1-terra` (« use /v1/responses or set reasoning_effort to 'none' »). `pourMastra()` donne donc à Mastra le routeur
  `openai/<modèle>`, qui parle Responses ; essai réel : un appel d'outil puis une réponse en français, ~6 s.
- Coût estimé : `ASSISTANT_IA_PRICE_IN` / `_OUT` (dollars par million de jetons) ; absent → « inconnu ».
- Ce qui ne change pas : filtre de la saisie (IBAN, rémunérations) avant le modèle, plafonds par personne et par jour,
  écritures jamais faites par le modèle (intention → carte → confirmation), interrupteur général.
