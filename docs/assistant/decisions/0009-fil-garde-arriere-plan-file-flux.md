# 0009 — Le fil gardé : conversation persistante, arrière-plan, file de messages, réponse en flux

> Date : 27/10/2026. Code : `src/lib/agent/fil/` (`service.ts`, `tour.ts`, `partiel.ts`),
> `src/app/api/assistant-ia/fil/route.ts`, `src/lib/actions/assistant-ia-actions.ts` (`envoyerAuFil`,
> `repartirDeZero`), `src/components/assistant-beta/assistant-workspace.tsx`. Tables `AssistantIaFil`,
> `AssistantIaTour` (migration `20270130120000_assistant_ia_fil`, additive et idempotente).

## La demande (Direction, 27/10)

« Je ne veux pas qu'à chaque fois que je sors de l'assistant ça efface tout » ; « je lui donne des choses à faire,
je vais faire autre chose et ça me notifie quand c'est fait » ; des tâches longues, à plusieurs étapes ;
« un deuxième message avant qu'il réponde au premier ne doit pas annuler le premier » ; plus rapide au premier mot.

## Ce qui est fait

| Besoin | Mécanisme | Test |
|---|---|---|
| Rien ne s'efface | Un fil par personne en base ; chaque message et chaque réponse est un tour. L'écran relit le fil (`GET /api/assistant-ia/fil`). « Nouvelle conversation » déplace `depuisLe` : rien n'est supprimé, le contexte repart de zéro. | `fil.test.ts` |
| Arrière-plan | `envoyerAuFil` dépose le tour (`EN_ATTENTE`) et lance `traiterFil` **sans l'attendre** : la requête rend la main tout de suite, le tour se joue sur le serveur. | `fil.test.ts` |
| File de messages | Une seule prise par fil (`traitementLe`) ; les messages se jouent dans l'ordre d'arrivée ; la réponse au second voit le premier échange. Chaque réponse s'affiche après SA question (`ordonner`), à l'écran comme dans le contexte. 10 messages en file au plus. | `fil.test.ts` (« deux messages d'affilée ») |
| Notification | L'écran relit le fil toutes les 0,9 s pendant un tour (`consulteLe`) ; six secondes sans lecture = la personne est ailleurs → notification (cloche + téléphone) vers `/assistant`. | `fil.test.ts` ; mesuré en local |
| Tâches longues | En arrière-plan : 24 étapes d'outils, 4 min (`ASSISTANT_FOND_TIMEOUT_MS`), consigne « tâches longues » ajoutée au contexte. | — |
| Premier mot plus tôt | `repondreAvecSecours` en flux (`agent.stream`) quand on lui passe `surTexte`/`surOutil` : le texte partiel (extrait du JSON `{message, components}` par `messagePartiel`) et les étapes (« Demandes en attente consultées ») s'écrivent dans le tour toutes les 350 ms au plus. | `partiel.test.ts` |
| Reprise après redémarrage | `reprendreLesFils` (battement `runScheduledJobs`) : prise perdue (> 10 min) → réponse partielle close et dite, message remis en file. | `fil.test.ts` |

## Les limites ne bougent pas

Droits **relus à chaque tour** (`proprietaire`) ; assistant retiré → le tour échoue et le dit, sans appeler le
modèle. Écritures = cartes à confirmer (l'état d'une carte est relu sur l'intention à chaque lecture du fil).
« Vue exacte » : rien n'est écrit dans le fil de la personne regardée ; l'écran rejoue l'ancien tour dans la
requête (`envoyerMessageBeta`, qui délègue désormais à `jouerTour` — une seule règle de tour).

## Mesures (local, gpt-4.1-mini derrière l'interface MiMo)

Deux messages d'affilée : premier signe de réponse à 1,4 s ; réponses en 5,7 s puis 11,2 s, dans l'ordre ; écran
quitté puis rouvert : tout est là ; rechargement : tout est là. Demande longue puis départ de l'écran :
notification « Assistant IA : réponse prête — … » reçue.

## Ouvert

- Annuler un message encore en file (aujourd'hui : il sera traité).
- Plusieurs fils (sujets séparés) — volontairement un seul pour l'instant, comme demandé.
