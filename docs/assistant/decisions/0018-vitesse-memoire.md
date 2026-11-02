# 0018 — Vitesse et mémoire : outils à la demande, consigne stable, mémoire en 4 couches, le bon modèle (lot J4, 30/10/2026)

**Lot J4 du plan Jarvis** (décision [0013](0013-jarvis-architecture.md) §3 : « mémoire en 4 couches, assembleur de contexte,
choix du modèle et des outils » — critère : meilleure réussite, premier mot plus tôt, coût par tour stable ou en baisse).

> Code : `src/modules/assistant-ia/domaine/{selection-outils,assembleur}.ts`, `domaine/fil/resume.ts`,
> `infra/{selection,contexte,repondre,modele,generer}.ts`, `infra/fil/{tour,service,resume}.ts` ; socle
> `src/platform/ia/modeles-roles.ts`, `src/platform/ia/lectures/connaissance.ts` ; Bibliothèque `piecesOuvrables`.
> Migration additive `20270209100000_assistant_ia_resume_roulant`. Banc : [`docs/bench/assistant-jarvis-live.md`](../../bench/assistant-jarvis-live.md) § J4.

## 1. Le constat mesuré

Banc Jarvis (26 scénarios, `gpt-6.1-terra`, chemin produit), base `jarvis/j0-separation` :

- **~22 900 jetons d'entrée par appel** (Super Admin ~23 600, assistante de direction ~18 500), renvoyés à chaque étape d'outil ;
- premier mot **P50 5,7 s / P95 20,1 s** ;
- le poids n'était PAS la consigne (~1 750 jetons) mais les **définitions des 65 outils** (~18 700 jetons, `JSON` des
  schémas — `hr_operation` seul en pèse ~2 000) ;
- l'heure d'Alger (à la minute) était la **deuxième** section de la consigne : tout ce qui la suivait sortait du cache
  du fournisseur chaque minute ;
- la conversation = les 16 derniers tours mot pour mot, rien au-delà ; la Bibliothèque (J1) n'était pas branchée.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Quels outils part au modèle ? | Un **socle** de 10 outils légers toujours offerts (`trouver_outil`, annuaire, recherche fédérée, Bibliothèque ×2, ce qui m'attend, aperçu, tâches, lire un document, mémoire) + une **présélection** de 6 par la demande (et 3 au plus hérités de la question précédente : une relance courte —
« Au nom d'Adventum Pharma. » — n'a aucun mot du métier ; mesuré au banc, elle passait par `trouver_outil`) + **`trouver_outil(intention)`**, qui ajoute jusqu'à 8 outils pour la suite du tour. Tous les outils restent ENREGISTRÉS ; seuls les actifs partent (`prepareStep` → `activeTools`, relu avant chaque étape). | ~5 k jetons d'outils au lieu de ~19 k. Un outil non visible reste appelable par la même garde : rien n'est retiré à la sécurité, seulement au poids. |
| Présélection : modèle léger ou règles ? | **Règles** — plein texte français (plié, racine à 6 lettres, mots de la personne par outil, IDF, verbes de geste). | MESURÉ (30/10, Responses API) : classer une phrase coûte 1,8–2,5 s avec `gpt-6-luna`, 1,0–1,5 s avec `gpt-6.1-terra` — un aller-retour de plus AVANT le premier mot. La règle : 0 ms, et sur le corpus de référence (60 demandes, 68 outils) l'outil juste est **1ᵉʳ 56 fois sur 60, dans les 3 premiers 60 fois sur 60**. |
| Jamais hors droits | Les fiches de la sélection sont les outils que l'adaptateur offrirait (`allowed`, `config.allowedTools`) : un outil hors droits n'est pas une fiche, il ne peut être ni présélectionné ni trouvé. Les familles de la console restent jugées **à l'exécution** (l'outil refuse en nommant la famille). | Test sur le vrai catalogue de l'assistante de direction, les 60 demandes : 0 outil hors droits. `trouver_outil` sans résultat dit le DROIT qui manque, jamais « je n'ai pas l'outil ». |
| Consigne stable | Ordre : identité → règles → présentation → consignes générales (confidentialité, sélection, fond) → la personne (rôle, périmètre, consignes du rôle, familles, gestes fermés) → **partie variable** (indice de travail long, mémoire assemblée, résumé de la conversation) → **heure en dernier**. Les règles propres à une famille d'outils (agir, documents, routines, web) ne sont dites que si l'un de ses outils est offert ; `trouver_outil` rend celles des outils qu'il ajoute. Clé de cache du préfixe par personne (`promptCacheKey`). | Le cache du fournisseur ne sert qu'un PRÉFIXE identique ; l'heure en tête le cassait. |
| `previous_response_id` ? | **Non** dans ce lot. | Mastra renvoie l'historique complet à chaque étape ; chaîner la réponse précédente en plus doublerait le contexte. Le cache de préfixe (≈ 10 % du tarif, plus rapide) rend le même service sans toucher au moteur. À reconsidérer si Mastra expose une boucle « sans renvoi ». |
| Conversation (couche b) | Les **4 derniers échanges** mot pour mot ; au-delà de 4 + 3, les plus anciens passent au **résumé roulant** (`AssistantIaFil.resume`, `resumeJusquA`), régénéré par le modèle **rapide** APRÈS la réponse. Idempotent : sans échange nouveau, rien ne se refait. « Nouvelle conversation » l'efface. | Une longue conversation garde son début, en ~700 jetons au lieu de 16 tours entiers ; le résumé ne retarde aucun premier mot. |
| Aucune valeur sensible dans le résumé | Le texte confié au modèle passe `sansValeursRevelees` (une valeur révélée à l'écran redevient « [confidentiel] ») et `censurerTexte` ; le résumé rendu le repasse avant d'être gardé. | Test : un IBAN saisi, un salaire révélé — ni envoyés, ni gardés, même si le modèle les « recopie ». |
| Mémoire personnelle (couche c) | `AssistantMemoryItem`, inchangée — mais l'**assembleur** n'en garde que ce qui tient dans 500 jetons, les souvenirs **pertinents pour la question** d'abord. | Rien ne grossit avec le nombre de souvenirs. |
| Connaissance (couche d) | Outils `chercher_documents`, `ouvrir_documents` (Bibliothèque, **toujours `pourModele: true`** : ni confidentiel, ni sensible, extraits filtrés ; famille « Drive & documents » de la console), `faits_confirmes` (un fait confirmé n'est rendu qu'à qui peut ouvrir la pièce dont il vient ; un fait sensible jamais — règle de la Bibliothèque, `faitsConfirmesPourModele`). Au **socle IA** (`platform/ia/lectures/connaissance.ts`) : la Bibliothèque lit déjà l'Assistant IA (son filtre), un import inverse ferait un cycle de modules. Sorties **encadrées** comme contenu tiers (`contenu-non-fiable.ts`). | Les documents se retrouvent par leur contenu, sous les droits de la personne. |
| Carnet de travail (couche a) | Inchangé (J2) : relu par chaque étape d'un travail à la place de l'historique. | Déjà fait. |
| Assembleur | `domaine/assembleur.ts` : enveloppes fixes (mémoire 500, résumé 700, historique 3 500 jetons) ; obligatoires d'abord, puis priorité ; un morceau qui ne tient pas est écarté **entier** ; jamais une réponse orpheline en tête de l'historique. | Test : 200 tirages, l'enveloppe tient toujours. |
| Le bon modèle pour chaque geste | Passerelle de rôles **pure** au socle (`platform/ia/modeles-roles.ts`), OpenAI seul (décision 0010) : **rapide** `gpt-6-luna` (résumé roulant), **standard** `gpt-6.1-terra` effort `low` (conversation), **raisonnement** `gpt-6.1-terra` effort `medium` (analyse, comparaison, « toutes les… », plusieurs pièces). Variables : `ASSISTANT_IA_MODEL`, `ASSISTANT_IA_MODEL_RAPIDE`, `ASSISTANT_IA_EFFORT`, `ASSISTANT_IA_EFFORT_RAISONNEMENT`, `ASSISTANT_IA_EFFORT_RAPIDE`. | Mesuré : `low` 1,0 s contre 1,5 s en `medium` sur un geste court, même réponse. |

## 3. Limites connues

- Le coût d'un appel du modèle **rapide** est estimé au tarif de `gpt-6.1-terra` (le journal n'a qu'un tarif par
  fournisseur, `ASSISTANT_IA_PRICE_*`) : sur-estimé, jamais sous-estimé. Le résumé est rare (une fois tous les 3 échanges
  au-delà de la fenêtre).
- La présélection est lexicale : une demande sans aucun mot du métier, et dont la question précédente n'en avait pas non
  plus, ne présélectionne que le socle ; le modèle passe alors par `trouver_outil` (une étape de plus).
- **Le cache et les outils, MESURÉ** (30/10, Responses API, 7 300 jetons dont 10 outils) : même requête → 7 307 en cache ;
  un outil AJOUTÉ à la fin, ou le premier remplacé → **0 en cache**. Les définitions précèdent la consigne dans le préfixe,
  et toute variation de la liste l'invalide entier. Le cache sert donc les étapes d'un même tour (tant que `trouver_outil`
  n'ajoute rien) et deux tours de même présélection ; le taux de cache du banc passe de 89 % à ~47 %. Assumé : l'entrée
  est 4 fois plus petite, le coût par tour BAISSE malgré tout (mesuré), et le premier mot arrive plus tôt.

## 4. Les preuves

| Test | Ce qu'il prouve |
|---|---|
| `infra/selection.test.ts` | corpus de 60 demandes : l'outil juste dans les 8 premiers (vrai catalogue Super Admin) ; jamais hors droits (assistante de direction, 60 demandes, présélection ET `trouver_outil`) ; configuration de rôle respectée ; présélection petite et stable |
| `infra/repondre.test.ts` | au faux modèle : seuls les actifs partent ; un outil trouvé part à l'étape suivante ; sans sélection, tout part (routines) |
| `domaine/assembleur.test.ts` | enveloppe respectée (200 tirages), obligatoires d'abord, souvenirs pertinents d'abord, pas de réponse orpheline |
| `domaine/fil/resume.test.ts`, `infra/fil/resume.test.ts` | quand résumer, jusqu'où ; idempotence (deux passages, un appel) ; ni IBAN ni salaire révélé envoyés ou gardés ; « nouvelle conversation » efface |
| `platform/ia/lectures/connaissance.test.ts` | Bibliothèque : retrouvé par le contenu ; refus par droit (sans dire que la pièce existe) ; bulletin CONFIDENTIEL exclu même pour son propriétaire ; faits confirmés suivent la pièce, sensibles jamais |
| `platform/ia/modeles-roles.test.ts` | rôles, variables, effort adaptatif |

Frontières : `RESIDUS` de `src/platform/ia/frontieres.test.ts` inchangé ; aucun import d'Adam. Le socle IA gagne un
import vers l'ERP (la porte `modules/bibliotheque/api` ; la lecture des faits confirmés vit dans la Bibliothèque,
`infra/faits.ts`) et en perd deux (le type de la personne se lit sur `outil.ts`, `UtilisateurOutil`) : `SOCLE_IA_CEILING`
**180 → 179**, resserré, jamais relevé.
