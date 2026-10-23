# 0004 — Configuration par rôle de l'Assistant IA (jalon 4)

> Date : 23/10/2026. Code : `src/lib/agent/role-config.ts`, `prisma/schema.prisma`, `prisma/migrations/20270126100000_assistant_role_config`.

## Décisions

- **Modèle `AssistantRoleConfig` & Migration idempotente** (Q4, Q12) :
  Table `AssistantRoleConfig` avec clé primaire sur `UserRole`.
  Champs :
  1. `assistantName` (nom personnalisé du bot par rôle) et `tone` (ton attendu).
  2. `customInstructions` (limité à ≤ 2 000 caractères).
  3. `allowedTools` (restriction seulement, tableau d'outils autorisés).
  4. `confirmationLevel` (défaut "CRITIQUE", ne descend jamais sous le minimum requis).
  5. `enforcedModel` (modèle spécifique optionnel).

- **Traçabilité stricte (`AssistantRoleConfigAudit`)** :
  Toute modification d'une configuration de rôle enregistre l'auteur (`actorId`), l'horodatage, l'ancienne valeur complète (`previousData`) et la nouvelle valeur (`newData`).

- **Le RBAC reste le plafond indépassable** :
  `filtrerOutilsParRole` et `outilsPour` appliquent la restriction de rôle comme un sous-ensemble des outils RBAC autorisés. Une configuration de rôle ne peut JAMAIS octroyer un outil interdit par les permissions utilisateur.

## Vérification

- Migration `20270126100000_assistant_role_config` appliquée via `prisma migrate deploy`.
- Client Prisma régénéré avec succès (`prisma generate`).
- Typecheck TypeScript (`tsc --noEmit -p tsconfig.build.json`) : 0 erreur.
- Tests unitaires de la suite agent : 24/24 tests verts.
