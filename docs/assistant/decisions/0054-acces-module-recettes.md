# 0054 — « Recettes » se masque et se gère comme les autres modules (lot R1, 02/11/2026)

**Demande de la Direction (02/11/2026, verbatim)** : « Par la même occasion, permets-moi de masquer ou gérer les accès au
module 'Recettes'. »

> Code : `src/lib/rbac/modules.ts` (clé `RECETTES`), `src/lib/rbac/permissions.ts` (`RECETTES_PAR_DEFAUT`),
> `src/lib/labels/navigation.ts` (libellé + entrée de menu), `src/modules/recettes/infra/recettes.ts` (`ouvreLesRecettes`),
> `src/modules/recettes/actions.ts`, `src/app/(app)/recettes/page.tsx` (`requireModule("RECETTES")`),
> `src/modules/assistant-ia/infra/recettes.ts` (`recette_pour`). Aucune migration : un module RBAC vit dans le code
> (`UserAccess.module` est une chaîne). Bancs : `src/modules/recettes/acces.test.ts` (base locale, console réelle),
> `src/modules/assistant-ia/infra/recettes.test.ts` § 5.

## 1. Ce qui existait

La visibilité de Recettes (J10, décision 0028) était **dérivée, sans réglage** : l'entrée de menu portait le module
`WORKSPACE` (ouvert à tous) et une garde `recettes` — `peutDesigner(user)`, ou responsable désigné d'un processus, ou une
recette PROPOSÉE/VALIDÉE sur un circuit que la personne voit. La page n'exigeait qu'une session. Aucune case de la console ne
la fermait ni ne l'ouvrait.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Quel mécanisme ? | Le **contrôle d'accès standard** : une clé `RECETTES` dans `MODULES`, des défauts dans `PERMISSIONS`, les surcharges `UserAccess` posées par la console Administration › Accès (`saveModuleAccess`), le masquage plateforme `hiddenModules` (Réglages). | Aucun second système : la feuille d'accès, le menu, `requireModule`, le contrat d'actions et le registre des capacités se déduisent tout seuls. |
| Que veulent dire les gestes ? | **Voir** = l'écran, l'entrée de menu, l'outil `recette_pour` ; **Valider** = trancher (valider, corriger, rejeter, retirer) ; **Modifier** = désigner les responsables. | Ce sont les trois gestes du module ; les autres colonnes (Créer, Supprimer…) n'ouvrent rien de plus. |
| La règle dérivée ? | Elle reste, **derrière** la porte : `ouvreLesRecettes(user, geste)` d'abord, puis le circuit visible (`voitLeCircuit`), le responsable désigné (`estResponsable`), `peutDesigner`. Le menu garde aussi la garde `recettes` (jamais une page vide). | Le module ajoute une clé ; il n'élargit personne. Valider sans être responsable désigné ne tranche rien ; désigner reste à la Direction. |
| Où la porte est-elle jugée ? | Partout côté serveur : `requireModule("RECETTES")` (page, adresse masquée comprise), `userCan` en tête de chaque action (`actions.ts`), puis rejugée dans le service (`lireEcranRecettes` vide, `versionPourResponsable`, `designerResponsable`, `recettePour`, `voitDesRecettes`). | RBAC à l'action, pas seulement à l'affichage ; une action forgée ne passe pas. |

## 3. Les défauts — personne ne perd Recettes le jour de la mise en service

| Rôle | Défaut `RECETTES` |
|---|---|
| Super Admin | tout (comme tous les modules) |
| Direction | Voir + Modifier + Valider |
| tous les autres rôles | Voir + Valider |

Hier, l'écran était ouvert à **tous les rôles** sous la règle dérivée ; un responsable désigné peut être **n'importe quel
rôle ou n'importe quelle personne** (`RecetteResponsable.role` / `userId`). Donner le module à moins de rôles aurait fait
disparaître l'écran à un responsable désigné ou à qui voit le circuit d'une recette. Avec ces défauts, l'ensemble de ceux
qui voient Recettes est **exactement** celui d'hier : la règle dérivée décide comme avant, le module ne retire rien tant que
la Direction ne l'a pas réglé.

## 4. Ce que la Direction peut faire

- **Masquer à une personne** : Administration › Accès › module « Recettes » → « Bloqué » sur sa ligne. Effet immédiat : ni
  menu, ni adresse `/recettes`, ni geste, ni recette servie par l'Assistant IA. Un blocage prime sur le rôle principal ET le
  rôle secondaire (`accesAttribue`).
- **Masquer à un rôle** : la même console, « Bloqué » sur chaque personne de ce rôle (un seul enregistrement). Il n'existe
  pas de surcharge « par rôle » dans l'ERP : on n'en invente pas une pour ce module.
- **Masquer à tous** : Administration › Réglages › modules masqués (`hiddenModules`) — le Super Admin le voit encore, signalé.
- **Ouvrir en lecture seule** : « Personnalisé » sans « Valider » — on lit, on ne tranche pas, même désigné.
- **Rétablir** : « Par défaut » efface la ligne : réversible en un geste, rien n'est perdu (les recettes, versions,
  désignations et usages restent en base). Aucune action nouvelle n'écrit : le cliquet K10
  (`src/lib/effets/reversibilite-globale.test.ts`) ne bouge pas — le geste de la console existait.

## 5. La frontière de l'Assistant IA

- **Avec le module** (le cas par défaut, tous les rôles) : rien ne change — `recette_pour` sert la version VALIDÉE, son plan,
  la phrase « selon la recette validée par … », les écarts ; l'usage est compté (J10 intact).
- **Sans le module** : `recette_pour` **n'est pas offert** (`allowed` lit `ouvreLesRecettes`), et `recettePour` rend `AUCUNE`
  sans compter d'usage si on l'appelle quand même. L'assistant prépare alors son plan lui-même, sans « selon la recette »
  — comme avant J10. Il ne peut ni lire une recette ni en trancher une (les gestes du module sont des actions d'écran que le
  registre des capacités porte désormais sous `RECETTES` : contrat `porte.module = "RECETTES"`, préfixe `recettes` →
  `RECETTES` dans `platform/ia/capacites/portes.ts`).
- **L'usage interne** qui ne sert personne — l'extraction de fond (`recettes.extraction`), les statistiques d'usage — n'est
  pas gardé par le module : il propose, il ne montre rien.
- Pas de famille d'accès de l'assistant en plus : le module suffit, et une famille aurait été une seconde porte réglée
  ailleurs. Les familles FERMÉES continuent de retirer les recettes de leurs processus (J10).

## 6. Bancs

`src/modules/recettes/acces.test.ts` (base locale, console réelle `saveModuleAccess`, menu réel `navigationFor`) :
défauts conservés (chaque rôle) ; un profil d'aujourd'hui voit menu et écran, sans trancher s'il n'est pas responsable ;
**Bloqué** → menu absent, porte de page fermée, écran vide, valider/rejeter refusés (rien d'écrit), assistant `AUCUNE`
sans usage ; la Direction bloquée ne désigne plus ; **Par défaut** → tout revient ; **Personnalisé** sans Valider → visible,
on ne tranche pas. `assistant-ia/infra/recettes.test.ts` § 5 : l'outil `recette_pour` n'est pas offert sans le module.
