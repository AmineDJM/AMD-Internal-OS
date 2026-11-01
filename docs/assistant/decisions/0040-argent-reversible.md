# 0040 — L'argent réversible : journal J7 ouvert à l'écran, contre-passation, « à récupérer », rétablir (lot K10a, 31/10/2026)

Demande de la Direction (31/10/2026, verbatim) : « Je veux que toutes les actions soient réversibles. Même celles qui ne
le sont pas : tu dois modifier l'ERP pour qu'elles le soient. Toute action qui a été faite peut être réversible. Ça doit
être dans n'importe quelle action du registre. » Contexte : la voix exécute une action sur un simple « vas-y » (K9) ; la
sécurité vient de la réversibilité. K10 est découpé en trois : **K10a l'argent** (cette décision), K10b communications,
effets sortants et suppressions, K10c le reste. Suit [0029](0029-simulation-annulation.md) (journal des effets,
annulation honnête) — **aucun second mécanisme** : tout passe par `annulerGeste`.

> Code : `src/lib/effets/argent.ts` (politique d'argent, rétablissement d'une écriture compensée),
> `declarations/argent.ts` (la table du périmètre, fusionnée dans `declarations.ts` de K10b), `ecran.ts` (`annulable`,
> fine enveloppe de session sur `gesteReversible` de K10b), `annulation.ts` (levées K10a, enfants d'abord, séries et
> file d'indexation « sans objet »), `retablissement.ts` (crochet argent, parent d'abord), `capture.ts` (`updateMany` en
> transaction). Migration additive et idempotente `20270217120000_k10a_compensation_ecritures` :
> `FinanceTransaction.compensationDeId` (lien, `SET NULL`) et `FinanceTransaction.compensation`
> (`CONTRE_PASSATION` | `A_RECUPERER`). Réconcilié avec K10b (décision 0038 : fenêtre d'annulation, barre « Annuler »,
> rétablir, déclarations par périmètre) : un seul mécanisme.

## 1. La définition tenue

Une action est réversible quand la personne qui l'a faite (ou le Super Admin — RBAC inchangé) peut l'annuler d'un geste
et que l'ERP revient à l'état d'avant (**retour**) ou applique une **compensation** tracée quand l'effacement serait faux.
Pour l'argent : **jamais d'effacement d'une écriture de trésorerie**. Une lecture (R0) n'a rien à défaire.

## 2. Le journal J7, ouvert aux gestes de l'écran (avec K10b)

`gesteReversible(user, { capaciteId, libelle }, corps)` (K10b) exécute le corps sous le journal des effets (origine
`ecran`). Les actions d'argent lisent la personne DANS leur corps (`requireUser`) : `annulable("fichier:fonction",
libellé, corps)` lit la session et appelle `gesteReversible` — enrobage posé **sur la ligne de la signature** (aucune
ligne ajoutée : `actions-demandes.ts` est à 997/1000). Sous une carte ou un travail de l'assistant, le geste se fond dans
celui qui le contient ; sans session (tâche planifiée, `runPettyCashRechargeReminders`), l'action s'exécute telle quelle.

La **déclaration** est une ligne de `declarations/argent.ts` (`retour`/journal, ou `compensation`/compensation-metier ;
`nextRechargeFor`, lecture déguisée classée « argent » par son nom, est `sans-effet` et n'est pas enrobée) : le registre
la lit par le port `annulationDeclaree`. Le cliquet exige, pour chaque action écrivante du périmètre, la ligne de la table
ET l'enrobage sous son propre identifiant.

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

## 4. Rétablir

Rétablir est `retablirGeste` (K10b) : le compte rendu de l'annulation est rejoué, chaque effet sous verrou. Pour l'argent,
un crochet (`retablirEcritureTresorerie`) écrit encore **une ligne de plus** : l'écriture prévue retrouve son statut,
l'« à récupérer » encore prévu passe à `CANCELLED`, la contre-passation est contre-passée ; le statut « payé » de l'ordre
revient par la règle générale. Les créations se refont **parent d'abord** (l'ordre avant la remise de caisse qui le
pointe). Le geste rétabli se ré-annule ; l'audit garde annulation et rétablissement.

## 5. Cascades

- **Enfants d'abord** (`enfantsDAbord`) : une ligne créée vers laquelle une autre ligne créée du même geste renvoie se
  défait après elle (la remise de caisse naît avant son ordre, puis le pointe) — l'ordre est retiré, pas seulement annulé.
- Un dépendant né d'un AUTRE geste depuis (l'ordre autorisé par le centre après la demande ; la remise versée) : la ligne
  touchée est **compensée** (`CANCELLED`, plus payable) ou **refusée avec la raison** (« modifiée depuis : … ») — jamais
  écrasée, jamais d'état incohérent (tests « CASCADE »).

## 6. La barre « Annuler » et l'assistant

La barre « Annuler » de l'ERP et l'historique de la fiche sont ceux de K10b (`barre-annulation.tsx`, `HistoriqueAnnulable`,
actions `annulerMonGeste` / `retablirMonGeste`) : chaque action d'argent y apparaît avec sa phrase (`capaciteId`,
libellé). Les notifications poussées attendent la **fenêtre d'annulation** de K10b : annulées dans la fenêtre, rien n'est
parti (vérifié par le test « reporter un ordre »).

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

1. **Effets sortants** : aucune action du périmètre n'appelle un canal sortant directement ; leurs notifications passent
   par la fenêtre d'annulation de K10b (annulée dans la fenêtre : rien n'est parti ; après : la compensation dite).
2. **Payé par erreur ou réellement payé ?** L'ERP ne le sait pas. Choix tenu : « à récupérer » (ce que la Direction a
   demandé) ; si rien n'était parti, passer l'« à récupérer » à « réalisé » le neutralise. À confirmer.
3. **Fenêtre et barre** : celles de K10b (réglables par le Super Admin, défaut 2 min) ; l'historique garde 180 jours.
4. **Annuler par l'assistant** (écrit/oral) : la doctrine J7 « un assistant n'annule pas ses propres gestes » tient
   encore (`annulerMonGeste` exclu). Lever l'exclusion — ou donner à la voix un outil « annule ce que je viens de
   faire » — est une décision Direction / K9.
5. **Tâches sans session** (`runPettyCashRechargeReminders`) : non journalisées (pas de principal). Leur effet (plan
   « rappelé », notifications) se défait à la main.
6. **Contre-passation par montant négatif** : la ligne inverse porte un montant < 0 (même sens) ; les soldes et totaux
   par catégorie l'additionnent juste. Un écran qui supposerait `amount > 0` l'afficherait en négatif — voulu.
