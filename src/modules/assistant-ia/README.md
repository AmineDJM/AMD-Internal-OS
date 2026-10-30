# Module `assistant-ia` — l'Assistant IA (« Adventum Brain »), ouvert à chacun selon ses droits

Le second produit d'IA du dépôt, à côté d'Adam (le Chief of Staff du Super Admin). Moteur Mastra + `gpt-6.1-terra`,
page `/assistant`, accès par le module RBAC `ASSISTANT_IA` et la console `/admin/ai/acces`. Décisions :
[`docs/assistant/decisions/`](../../../docs/assistant/decisions/) (0001 → 0013 ; 0013 : la séparation d'Adam et le socle IA).

| Porte / dossier | Rôle |
|---|---|
| `api.ts` | **Porte serveur** : le fil (`deposerMessage`, `traiterFil`, `lireFil`, `reprendreLesFils`, `jouerTour`), vocaux, mémoire, routines, opérations, accès, consommation |
| `partage.ts` | **Porte pure** : familles d'accès, plafonds, filtre de confidentialité, règles de lecture et de dépôt, MRZ |
| `actions.ts` | clé `assistant-ia-actions` : mémoire, routines, fil, et `confirmerIntentionAssistantIA` (l'exécution d'une carte) |
| `actions-consommation.ts` | clé `assistant-ia-consommation-actions` : réglages de consommation et d'accès (Super Admin) |
| `domaine/` | règles pures (accès, plafonds, confidentialité, lecture, dépôt, mémoire affichée, MRZ, UI générative) |
| `infra/` | le moteur : fil, tour, outils, opérations, lecture des pièces, voix, mémoire, routines, consommation, modèle ; `testing/` (faux modèle, tests seulement) |
| `ecrans/` | l'interface de `/assistant` (ex-`components/assistant-beta/`) |

- **Tables** : `AssistantIaFil`, `AssistantIaTour`, `AssistantMemoryItem`, `AssistantRoutine`, `AssistantRoutineRun`,
  `AssistantRoleConfig`, `AssistantIaAcces`, `AssistantIaReglage`, `AssistantIaPlafondAtteint`. Les intentions
  (`AssistantActionIntent`) sont au socle IA (`src/platform/ia/intentions/`), partagées avec Adam.
- **Tâches de fond** : `assistant.routines`, `assistant.fils` (`src/lib/scheduled.ts`).
- **Frontière** : le module n'importe pas Adam, sauf le catalogue d'outils nommé dans `src/platform/ia/frontieres.test.ts` ;
  ce que les deux partagent vit au socle `src/platform/ia/`.
