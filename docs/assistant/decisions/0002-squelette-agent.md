# 0002 — Squelette de l'agent (jalon 2)

> Date : 23/10/2026. Code : `src/lib/agent/`.

## Décisions

- **Faux modèle écrit à la main** (`testing/modele-factice.ts`). Le mock fourni par Mastra
  (`test-utils/llm-mock`) ne sait rendre que du texte, pas un appel d'outil. Le nôtre parle le format
  AI SDK v2 que Mastra consomme pour un vrai fournisseur : la boucle d'agent tourne pour de bon.
- **Conversion JSON Schema → zod** (`schema.ts`) plutôt que réécrire les schémas des `PowerTool` :
  une seule source de vérité. Ce qui n'est pas convertible devient `z.any()` ; `run` garde son contrôle.
- **Agent construit par requête**, outils fermés sur l'utilisateur : rien ne fuit d'un compte à l'autre,
  pas besoin du `RequestContext` de Mastra à ce stade.
- **Double contrôle du droit** : l'outil n'est pas montré au modèle si `allowed(user)` est faux
  (`outilsPour`), et l'adaptateur refuse quand même avant `run` s'il est appelé.
- `@mastra/core` ajouté aux paquets Node-only de `client-bundle-guard.test.ts` et à
  `serverComponentsExternalPackages`.

## Vérification

- Typecheck complet, build propre (mode Render), lint : verts.
- Tests de l'agent 7/7, garde de bundle 4/4.
- Essai réel : `directory_lookup` sur `amd_dev` (Super Admin, VIEWER) via le faux modèle.
- Suite complète : 25 fichiers en échec. 17 = échecs connus de la branche ; 5 passent en série
  (interférences parallèles) ; 1 (`aujourdhui-espace-flow`) échoue aussi **sans** ce jalon.

## Pièges rencontrés

- Graphify indisponible (Python absent) : lecture ciblée à la place.
- `npm install --no-save` sur un état antérieur retire Mastra de `node_modules` : refaire `npm install`.
