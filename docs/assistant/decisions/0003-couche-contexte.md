# 0003 — Couche de contexte et filtre de confidentialité (jalon 3)

> Date : 23/10/2026. Code : `src/lib/agent/contexte.ts`, `src/lib/agent/filtre-confidentialite.ts`.

## Décisions

- **Couche de contexte déterministe (`contexte.ts`)** :
  `compileContext(options)` compile le `systemPrompt` et les messages récents dans un budget strict de ~8 000 tokens.
  Il intègre :
  1. Identité et portée RBAC (les modules autorisés uniquement, libellés en français).
  2. Horodatage local au fuseau horaire d'Alger (`Africa/Algiers`).
  3. L'écran actif et le résumé non-confidentiel de l'objet consulté (Dossier AMM, Fiche produit, Tâche).
  4. La mémoire active de l'utilisateur (`AssistantMemoryItem`).
  5. L'historique récent de la conversation (`AssistantMessage`).

- **Filtre de confidentialité strict (Décision Q14, `filtre-confidentialite.ts`)** :
  Avant toute transmission au modèle externe (MiMo ou autre), toutes les données sensibles sont censurées en `[CONFIDENTIEL]` :
  - Rémunérations (salaires de base, net à payer, brut, primes).
  - Coordonnées bancaires (IBAN, RIB, CCP).
  - Pièces d'identité (numéro de passeport, CNI, NIN 18 chiffres).
  - Filtrage récursif sur les objets et analyse textuelle par expressions régulières.

## Vérification

- Typecheck complet (`tsc --noEmit`) : vert (0 erreur).
- Garde de bundle client (`client-bundle-guard.test.ts`) : 4/4 vert.
- Tests unitaires de la suite agent (`src/lib/agent/`) : 17/17 tests verts.
