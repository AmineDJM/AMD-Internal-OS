# 0008 — L'agent qui agit, la mémoire, les documents, les routines

> Date : 27/10/2026. Code : `src/lib/agent/` (`operations/`, `routines/`, `memoire*.ts`, `recherche-web.ts`,
> `generer.ts`), `src/lib/actions/assistant-ia-actions.ts`, `src/components/assistant-beta/`.

## Les limites (non négociables) — et où elles tiennent

| Limite | Où elle tient | Test |
|---|---|---|
| L'agent ne possède que ce que la personne voit | chaque outil s'exécute sous son `CurrentUser` (RBAC + droits par ligne) ; `trouverDemande` ne cherche que dans les portées (`scopeSponsoring`…) et ne nomme jamais une demande invisible | `limites.test.ts`, `adpro-autres.test.ts` |
| Aucune donnée personnelle d'un collègue au-delà de l'annuaire | lectures `mes_*` filtrées sur l'identifiant ; annuaire = celui de l'écran | `limites.test.ts` |
| Rien ne s'écrit sans confirmation ; droit revérifié à l'exécution | toute écriture = carte (`persistActionIntents`, kind `assistant_ia_op`) → `confirmerIntentionAssistantIA` → `executerOperationIA` (revérifie `ouverte`) → **action de l'écran** (jamais d'écriture directe) | chaque `*.test.ts` d'opération |
| Rémunérations, banque, identité ne partent jamais au modèle | `censurerSortie` sur chaque sortie d'outil ; documents : identité et bulletin de paie **refusés en entier** (`natureSensible`) ; traduction : masque réversible (`masquerSensible`/`restaurerSensible`) ; passeport : OCR local + MRZ décodée ici, valeurs sur la carte seulement ; formulaire PDF : champs sensibles ni montrés ni remplis ; recherche web : question censurée | `documents-ia.test.ts`, `documents-purs.test.ts` |
| Un test par limite sur un rôle restreint | assistante de direction (`DIRECTION_ASSISTANT`) | `limites.test.ts`, `bon-de-commande.test.ts`, `budget.test.ts`, `documents-ia.test.ts`, `routines.test.ts` |

## 1. L'agent qui agit — le registre `OPERATIONS_IA`

Une opération = `{ nom, module, ouverte(user), proposer(entrée, user), executer(args, user) }`.
`proposer` répond `manque` (l'agent pose **une** question), `erreur`, ou une **carte** + `args` stockés côté
serveur (le modèle ne peut pas les modifier). Opérations : sponsoring, prise en charge, événement (créé **et**
soumis), matériel promotionnel, demande « autre », poste de coût, bon de commande (+ « Créer la demande de
validation », société par défaut = celle de l'employé, seuil du centre et signature des Finances dits avant),
BC **depuis un devis**, voyageur **depuis un passeport**, relance d'un valideur, dépôt d'une pièce, rendez-vous,
réponse à un message, document depuis un modèle, traduction, formulaire PDF, routines.
Contrôles **avant** de remplir : doublons (dans la portée), budget (aucun chiffre sans le module Budgets),
pièces exigées, seuil DG / centre.

## 2. Mémoire personnelle

`AssistantMemoryItem` (déjà scopé par personne). Proposée par l'agent (`proposer_memoire`), **retenue par le
geste** de la personne ; panneau « Ma mémoire » : voir, corriger, effacer, tout effacer. Refuse tout contenu
sensible. Jamais partagée ; indisponible en « Vue exacte ».

## 3. Documents

- **Modèle** (lettre, note, compte rendu) sur le papier en-tête de la société (`profilDocumentaire` + `composerDocx`).
- **Devis/facture → BC** : lecture par le service de l'ERP (`proposerLecture`, Luna si la Direction l'a ouvert,
  moteur local sinon) ; les lignes du BC viennent **de la lecture**, jamais du modèle ; TVA non imprimée demandée ;
  BC composé en pré-validation (`emettreDocumentDrive`) puis demande de validation (source COMPOSER), devis joint ;
  l'empreinte du devis est revérifiée à la confirmation.
- **Passeport** : OCR local (`cloud: false`), MRZ ICAO 9303 avec chiffres de contrôle (`mrz.ts`), fiche voyageur
  du poste billetterie + passeport en pièce d'identité. Le modèle ne reçoit ni nom, ni numéro, ni date.
- **Résumer** un long PDF (parties résumées puis synthèse), **comparer** deux versions (LCS ligne à ligne),
  **traduire** FR/EN/AR (Word et PowerPoint en place, arabe en RTL ; PDF → Word, dit sur la carte),
  **remplir** un formulaire PDF (AcroForm, mupdf, copie dans le Drive).

## 4. Routines (façon « Tâches planifiées » de ChatGPT — en mieux)

Benchmark : `scratchpad/research/chatgpt-tasks-benchmark.md` (session). Ce qui est repris, et ce qui est mieux :

- **Créées par la personne seulement**, par la conversation (`programmer_routine`) et une carte : titre, consigne
  réécrite, « chaque dimanche à 08:00 (heure d'Alger) », **trois prochains passages**. L'heure et le jour ne sont
  **jamais devinés** (ChatGPT « make a best guess ») : ils se demandent.
- Calendrier lisible (`calendrier.ts`) : une fois, chaque jour, jours choisis (dont « du dimanche au jeudi »),
  chaque mois (dont « le dernier jour »), intervalle, date de fin, nombre de passages. **Heure d'Alger** fixe.
- Chaque passage : droits **relus** (`proprietaire`) ; assistant retiré → passage ignoré, routine **en pause**,
  et c'est dit. **Lecture seule** : aucun outil d'écriture ni opération du registre n'est offert (test).
  Une consigne « envoie / relance / crée… » est refusée à la création.
- **État entre passages** : le tour vérifie tout à neuf (mesuré : quand il voyait le rapport précédent, le modèle
  le redisait sans chercher), puis un second appel compare et rend « Ce qui change » ou « Rien de nouveau ».
- **Sources web** ajoutées par le serveur depuis la sortie de `web_research` (URL https seulement).
- **Jamais d'échec muet** : chaque passage laisse une ligne (rapport, rien de nouveau, échec + cause, ignoré) et
  une notification ; trois échecs d'affilée le disent plus fort ; jamais désactivée en douce. Rattrapage d'un
  passage manqué dit comme tel. Prise atomique (`priseLe`), prise perdue libérée après 15 min.
- Onglet « Routines » (non lus, rapport complet, pause, reprise, exécuter maintenant, supprimer) ; la notification
  mène au dernier passage (`/assistant?routine=…`). 10 routines actives au plus par personne.
- Tables : `AssistantRoutine`, `AssistantRoutineRun` (migration `20270128100000_assistant_routines`, idempotente).
  Balayage : `runScheduledJobs` (battement du serveur), chargé à l'appel.

## Écart assumé avec 0007

`web_research` passe par la passerelle de l'ERP (`callModel`, fournisseur OpenAI), pas par MiMo. Seule la
**question** part (censurée) ; aucune donnée de l'ERP n'est jointe. À revoir si la Direction veut un fournisseur
unique.

## Mesures (local, gpt-4.1-mini derrière l'interface MiMo)

- Sponsoring de bout en bout sur téléphone : 5 tours, PDF joint, carte, SPO créé avec sa pièce et son poste.
- Routine « briefing marché pharma DZ » : heure demandée, carte, programmée ; « exécuter maintenant » : 72 s,
  rapport sourcé (APS, Radio Algérienne, OMS, ANPP…).

## Ouvert

- Déclencheurs sur événement de l'ERP (stock, AMM qui expire) : hors périmètre (pas de veille).
- Livraison par e-mail des rapports de routine ; modèles de routines partageables.
