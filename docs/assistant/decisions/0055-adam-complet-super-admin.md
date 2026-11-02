# 0055 — Un seul assistant : Adam complet pour le Super Admin, dans le moteur de l'Assistant IA (lot A2, 02/11/2026)

**Révise la décision [0013](0013-jarvis-architecture.md)** (« deux produits, un socle »).

**Demande de la Direction (02/11/2026, verbatim, extrait)** : « je veux merge Adam et l'assistant IA. L'assistant IA de la
plateforme, c'est Adam. (…) garde toutes les fonctionnalités d'Adam, tous, réellement tous, mais uniquement pour le super
admin. L'assistant IA pour les autres employés, tu les laisses comme ça. Donc le super admin, il aura (…) tout l'assistant IA
que les employés auront accès, avec un accès total de tout, plus (…) tout Adam. (…) ne supprime rien dans le code, quitte à
tout masquer. »

> Code : `src/platform/in-process/porte-assistant-ia.ts` (la porte d'Adam : classement, réserve, exécution),
> `src/modules/assistant-ia/infra/adam/outils-adam.ts` (le seul fichier du module qui la lit : lectures, cartes, exécution
> journalisée, consigne du Super Admin), `domaine/adam-sa.ts` (la charge `adam_sa_op`), `infra/outils-v1.ts` (catalogue de la
> conversation), `infra/confirmation.ts` (exécution de la carte), `infra/fil/tour.ts` (consigne), `infra/selection.ts` +
> `domaine/selection-outils.ts` (fiche courte, facteur de rang). Inventaire : [`../adam-inventaire.md`](../adam-inventaire.md).
> Bancs : `src/platform/in-process/porte-assistant-ia.test.ts`, `src/modules/assistant-ia/adam-super-admin.test.ts`,
> attaques `ADAM-SA-*` (`infra/testing/audit/attaques-adam-sa.ts`). Lot parallèle A1 : le nom, le menu, les routes, l'onglet
> « Bureau d'Adam » et les écrans de missions.

## 1. Ce que disait 0013, et ce qui change

0013 posait deux produits — Adam (Super Admin) et l'Assistant IA (chacun selon ses droits) — et un socle, avec trois règles :
l'Assistant IA n'importe pas Adam ; Adam n'importe pas l'Assistant IA ; le socle n'importe ni l'un ni l'autre.

La Direction fusionne les deux produits : **un seul moteur**, celui de l'Assistant IA (Mastra, sécurité S1) ; les capacités
de l'ancien Adam s'y branchent **pour le Super Admin seul**. La règle 1 ne peut donc plus être « zéro » : le moteur doit lire
le catalogue d'Adam (~140 outils, ~60 k lignes). Le déménager au socle reviendrait à le réécrire — la Direction demande de
réutiliser, pas de réécrire.

## 2. Les choix

| Question | Décision | Pourquoi |
|---|---|---|
| Par où le moteur lit Adam ? | **Une porte** : `platform/in-process/porte-assistant-ia.ts` (dans le pont d'Adam), lue par **un seul fichier** du module (`infra/adam/outils-adam.ts`). | Un franchissement unique, nommé, mesuré EXACTEMENT par `RESIDUS` de `platform/ia/frontieres.test.ts` et tenu par ESLint (override dédié). Adam → IA et le socle restent à **zéro**. La porte vit dans le pont (`in-process`) et non dans `lib/assistant` : la dette héritée du module vers `src/lib/` ne grossit pas. |
| Qui y a droit ? | Le **Super Admin en rôle principal, hors Vue exacte** (`peutVoirAdam` ; la porte relit la même règle). Ni DIRECTION (le « siège exécutif » d'Adam avant A2), ni un Super Admin en rôle secondaire, ni la Vue exacte. | La décision dit « uniquement pour le super admin ». La réserve est **architecturale** : `allowed` et `run`, relus à chaque appel, dans la porte ET dans le module — jamais une consigne. |
| Quelles fonctions ? | **Toutes**, classées une à une (`COUVERTS` (a), `LECTURES_SA` / `ECRITURES_SA` (b → branchées), `ECRAN_SEUL` (c)) ; un test échoue si un outil d'Adam n'est pas classé. | « Réellement tous » : l'exhaustivité est mesurée, pas déclarée. Ce qui existe déjà dans l'Assistant IA (même outil ou équivalent) n'est pas dupliqué. |
| Les lectures ? | Offertes telles quelles dans la **conversation** (pas les routines ni les travaux), passées au filtre de confidentialité du tour. | Même chemin que les autres lectures : jetons, provenance, preuves des chiffres. |
| Les écritures ? | **Jamais pendant le tour** : une **carte** (`kind: "adam_sa_op"`, une par tour) ; l'outil d'Adam ne s'exécute qu'à la confirmation (bouton ou oral), sous l'arrêt d'urgence et le **journal des effets** (K10) — valeur avant, « Ce que l'assistant a fait », Annuler. | Adam écrivait directement (rappels, surveillances, règles…) : dans le moteur unique, toute écriture passe par la carte et la réversibilité, comme le reste. Prouvé : un rappel créé par carte puis annulé disparaît. |
| Ce qui reste à l'écran ? | La planche du Bureau (`render_view`, `show_*`, `composer_planche`), la palette, les boutons de l'inbox, les réglages, l'écran Teach Adam, les skills dynamiques (§36) : onglet « Bureau d'Adam » (A1). | Ils parlent le protocole `_blocs` de l'écran d'Adam, ou exécutent du code tiers ; rien n'est supprimé. |
| Un employé en entend-il parler ? | **Non** : ni outil, ni nom, ni description, ni consigne (`CONSIGNE_ADAM_SA` n'est posée que si `adamOuvert`) ; les refus ne nomment ni Adam ni la fonction. | « Un employé n'entend jamais parler d'une fonction réservée. » |
| La sélection d'outils ? | Les fonctions d'Adam ont une **fiche courte** (première phrase) et un **facteur de rang 0,7** dans `trouver_outil`. | Mesuré : leurs longues descriptions faisaient tomber le rappel@5 du banc J6 (300 demandes ERP) de 95,0 % à 94,3 %. Avec la fiche courte : 95,0 %, exactement comme sans Adam ; le Super Admin trouve ses fonctions (10 demandes témoins, top 5). |

## 3. Ce qui reste interdit, et mesuré

- Tout autre import Assistant IA → Adam (un second fichier, ou ce fichier vers autre chose que la porte) : `frontieres.test.ts` + ESLint.
- Adam → Assistant IA, socle → l'un ou l'autre : zéro, inchangé.
- Le module vers `src/lib/` : `DETTE_HERITEE` inchangée.

## 4. Preuves

- `porte-assistant-ia.test.ts` : classement exhaustif ; porte fermée à DIRECTION, SA secondaire, Vue exacte, RH ; carte forgée refusée.
- `adam-super-admin.test.ts` (vraie base, chemin du produit) : le Super Admin reçoit exactement les 103 fonctions branchées et
  un résultat réel (boîte de réception par le tour) ; écriture = carte, rien avant ; confirmée = exécutée + journalisée ;
  annulée = défaite ; 12 personas du banc Q1 + un SA secondaire : aucun outil ; 12 personas qui se disent Super Admin et
  appellent l'outil (faux modèle attaquant) : refus, rien offert ni nommé au modèle, aucune carte ; la Vue exacte : fermée ;
  une carte `adam_sa_op` forgée en base au nom d'un employé : refusée sans nommer Adam.
- Banc Q1 : 13 attaques `ADAM-SA-*` (lecture directe, usurpation, ingénierie sociale, injection indirecte, détournée,
  escalade d'action, extraction du prompt, Vue exacte, voix) ; rejeu réel : `AUDIT_SEULEMENT=ADAM-SA- AUDIT_BUDGET_USD=3 npm run audit:assistant`.
