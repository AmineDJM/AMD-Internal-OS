# 0005 — Actions d'écriture sous confirmation (jalon 5)

> Date : 23/10/2026. Code : `src/lib/agent/ecritures.ts`, `src/lib/agent/ecritures.test.ts`.

## Décisions

- **Zéro écriture directe en base par le modèle** (Q7) :
  Les outils d'écriture du nouvel agent ne modifient jamais directement la base de données.
  L'exécution de l'outil génère une intention d'action persistée (`AssistantActionIntent`, état `PROPOSED`) qui se matérialise côté UI sous forme de carte de confirmation.

- **Tranche V1 : Deux écritures confirmées** (Q8) :
  1. `create_task` : prépare une tâche pour soi-même ou assignée à un collaborateur.
  2. `send_message` : prépare l'envoi d'un message direct dans la messagerie interne.

- **Exécution humaine protégée et idempotente (`executerActionConfirmee`)** :
  L'écriture effective en base n'a lieu qu'après confirmation explicite de l'utilisateur.
  Elle passe par le cœur métier existant :
  - `createTaskRecord` pour la création de tâche (mêmes notifications, même parcours de demande).
  - `findDirectConversation` + création du message pour la messagerie.
  - La machine d'état `executeIntentGuarded` protège contre les doubles-clics et les réexécutions intempestives.

## Vérification

- Typecheck TypeScript (`tsc --noEmit -p tsconfig.build.json`) : 0 erreur.
- Garde de bundle client (`client-bundle-guard.test.ts`) : 4/4 vert.
- Tests unitaires de la suite agent (`src/lib/agent/`) : 28/28 tests verts.
