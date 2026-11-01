# 0039 — L'argent réversible : journal J7 ouvert à l'écran, contre-passation, « à récupérer », rétablir (lot K10a, 31/10/2026)

Demande de la Direction (31/10/2026, verbatim) : « Je veux que toutes les actions soient réversibles. Même celles qui ne
le sont pas : tu dois modifier l'ERP pour qu'elles le soient. Toute action qui a été faite peut être réversible. Ça doit
être dans n'importe quelle action du registre. » Contexte : la voix exécute une action sur un simple « vas-y » (K9) ; la
sécurité vient de la réversibilité. K10 est découpé en trois : **K10a l'argent** (cette décision), K10b communications,
effets sortants et suppressions, K10c le reste. Suit [0029](0029-simulation-annulation.md) (journal des effets,
annulation honnête) — **aucun second mécanisme** : tout passe par `annulerGeste`.

> Code : `src/lib/effets/ecran.ts` (`annulable`), `ecran-ui.ts` (témoin du bandeau, pur), `argent.ts` (politique
> d'argent), `annulation.ts` (levées K10a, notes, enfants d'abord), `journal.ts` (`inscrireAnnulation`,
> `seulementSiEcrit`), `capture.ts` (`updateMany` en transaction) ; contrat `annulable` (`lib/actions/contrat.ts`,
> `contrat/types.ts`), registre (`platform/ia/capacites/{types,classement,registre}.ts`) ; bandeau
> `components/layout/geste-annulable.tsx` (monté dans `app/(app)/layout.tsx`) ; action `annulerMonGeste`
> (`modules/assistant-ia/actions-gestes.ts`, porte `porteDeLaPersonne`). Migration additive et idempotente
> `20270217110000_k10a_compensation_ecritures` : `FinanceTransaction.compensationDeId` (lien, `SET NULL`) et
> `FinanceTransaction.compensation` (`CONTRE_PASSATION` | `A_RECUPERER`).

## 1. La définition tenue

Une action est réversible quand la personne qui l'a faite (ou le Super Admin — RBAC inchangé) peut l'annuler d'un geste
et que l'ERP revient à l'état d'avant (**retour**) ou applique une **compensation** tracée quand l'effacement serait faux.
Pour l'argent : **jamais d'effacement d'une écriture de trésorerie**. Une lecture (R0) n'a rien à défaire.

## 2. Le journal J7, ouvert aux gestes de l'écran

J7 journalisait les gestes de l'ASSISTANT ; un bouton de l'ERP ne laissait que son audit. `annulable(mode, libellé,
corps)` enrobe le corps de l'action, **sur la ligne de sa signature** (aucune ligne ajoutée : `actions-demandes.ts` est à
997/1000) :

- appelée par l'assistant (carte, travail, mandat, simulation) : déjà sous un geste capturé, elle s'y fond ;
- appelée par l'écran : `journaliserGeste(origine "ecran")` au nom de la personne de la session ; un geste qui n'a rien
  écrit (formulaire refusé) n'entre pas au journal (`seulementSiEcrit`) ; un témoin court (`amd-geste-annulable`, 120 s)
  porte l'identifiant au bandeau ;
- sans session (tâche planifiée, `runPettyCashRechargeReminders`) : exécutée telle quelle, sans journal (limite §6).

Le **mode** est une déclaration lue par `actions:contrat` (champ `annulable`, regex sur le corps) : le registre classe
l'action `retour` ou `compensation` (`annulationDeclaree`) au lieu de la déduire de sa nature (« argent » → « paiement
exécuté » → « aucune »). L'enrobage EST la déclaration : une action ne peut pas se dire réversible sans être journalisée.

## 3. La politique d'argent (`argent.ts`)

| Ce que le geste avait fait | Ce que l'annulation écrit |
|---|---|
| écriture de trésorerie créée, **prévue** (`PENDING`) | passée à `CANCELLED` — le solde n'avait pas bougé, la trace reste |
| écriture créée **réalisée** par une saisie (saisie, encaissement, import, facture) | **contre-passation** : même sens, montant opposé, datée du jour, `compensationDeId` → l'originale ; le solde revient, les deux lignes restent |
| décaissement créé par un **paiement** (un modèle d'argent passé à « payé » dans le même geste : ordre réglé, facture payée, paie) | le décaissement **reste** ; une écriture **« à récupérer »** naît (encaissement prévu, même compte, même montant, liée). Recouvrée — ou si rien n'était parti — on la passe à « réalisé » : elle le neutralise |
| statut « payé » d'un modèle d'argent (`MODELES_ARGENT`) dans un geste de paiement | remis à sa valeur d'avant (l'ordre redevient dû) : levée du refus `PAIEMENT_EXECUTE` de J7 pour ces seuls modèles |
| `SUBMITTED` d'un modèle d'argent (transmission au centre de paiement) | remis comme un champ : c'est un circuit interne, pas un dépôt à une autorité |
| numéro de série consommé (`SerieReference`) | **sans objet** : une série garde ses trous |

Une écriture déjà compensée, ou dont le statut a bougé sous le verrou, n'est pas recompensée (IMPOSSIBLE, rien d'écrit).

## 4. Rétablir : l'annulation est un geste

Ce que l'annulation écrit (valeurs remises, lignes retirées ou recréées, contre-passations) est noté comme une capture et
entre au journal (`inscrireAnnulation`, origine `annulation`). Le compte rendu porte `retablirGesteId` ; l'annuler,
c'est **rétablir** par la même mécanique : la contre-passation est contre-passée, l'« à récupérer » annulé, « payé »
remis, la ligne retirée recréée (même identifiant). On n'écrit jamais qu'une ligne de plus. L'audit garde chaque
annulation (`ASSISTANT_IA`, qui, quand, résumé) et le geste son compte rendu.

## 5. Cascades

- **Enfants d'abord** (`enfantsDAbord`) : une ligne créée vers laquelle une autre ligne créée du même geste renvoie se
  défait après elle (la remise de caisse naît avant son ordre, puis le pointe) — l'ordre est retiré, pas seulement annulé.
- Un dépendant né d'un AUTRE geste depuis (l'ordre autorisé par le centre après la demande ; la remise versée) : la ligne
  touchée est **compensée** (`CANCELLED`, plus payable) ou **refusée avec la raison** (« modifiée depuis : … ») — jamais
  écrasée, jamais d'état incohérent (tests « CASCADE »).

## 6. Le bandeau « Annuler » et l'assistant

Le bandeau (`GesteAnnulable`) lit le témoin chaque seconde, offre « Annuler » deux minutes, montre le compte rendu effet
par effet (compensé / impossible + pourquoi), puis « Rétablir » ; « Historique » ouvre `/assistant/gestes` (les gestes
d'écran y figurent, origine `ecran`). `annulerMonGeste` n'exige pas le module Assistant IA : la personne défait SON geste.
Il est **hors assistant** (comme les autres actions de `assistant-ia-gestes-actions`) — voir §8.

## 7. Le périmètre et sa mesure

- **62** actions classées « aucune » au 31/10 (`2008b9a9`) → **0** : 17 `compensation`, 45 `retour`.
- **45** actions écrivantes des mêmes fichiers, déjà classées réversibles par nature mais non journalisées à l'écran,
  enrobées aussi : l'annulation depuis l'ERP couvre **107** actions d'argent.
- Cliquet `src/lib/effets/argent-cliquet.test.ts` : aucune action écrivante du périmètre (15 fichiers d'actions) classée
  « aucune », chacune déclare son mode, l'argent qui se crée déclare « compensation ».
- Tests exécuter-puis-annuler sur la base locale : `modules/finances/reversibilite-{argent,demandes,caisse-budget}-flow.test.ts`
  — **29 cas**, chacune des 62 actions exécutée par son vrai point d'entrée puis annulée (données, solde, journal, audit),
  3 « rétablir », 2 cascades. Classement : annulation `aucune` 246 → 184 sur 1 288 actions.

## 8. Limites et décisions à rappeler à la Direction

1. **Effets sortants** : la notification POUSSÉE partie sur le téléphone ne se reprend pas — le compte rendu le dit
   (« impossible : envoyer un rectificatif »). Aucune action du périmètre n'appelle un canal sortant directement : la
   fenêtre d'envoi différé de K10b (sur les ports `push`/`mail`) s'appliquera sans changement ici.
2. **Payé par erreur ou réellement payé ?** L'ERP ne le sait pas. Choix tenu : « à récupérer » (ce que la Direction a
   demandé) ; si rien n'était parti, passer l'« à récupérer » à « réalisé » le neutralise. À confirmer.
3. **Durée du bandeau** : 2 minutes, constante (`DUREE_BANDEAU_SECONDES`) ; l'historique garde 180 jours. La fenêtre
   d'annulation des effets sortants (réglable par le Super Admin) est celle de K10b.
4. **Annuler par l'assistant** (écrit/oral) : la doctrine J7 « un assistant n'annule pas ses propres gestes » tient
   encore (`annulerMonGeste` exclu). Lever l'exclusion — ou donner à la voix un outil « annule ce que je viens de
   faire » — est une décision Direction / K9.
5. **Tâches sans session** (`runPettyCashRechargeReminders`) : non journalisées (pas de principal). Leur effet (plan
   « rappelé », notifications) se défait à la main.
6. **Contre-passation par montant négatif** : la ligne inverse porte un montant < 0 (même sens) ; les soldes et totaux
   par catégorie l'additionnent juste. Un écran qui supposerait `amount > 0` l'afficherait en négatif — voulu.
