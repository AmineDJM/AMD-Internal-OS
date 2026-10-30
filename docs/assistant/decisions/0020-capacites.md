# 0020 — Le registre des capacités et l'appel générique : le « système d'exploitation » de l'assistant (lot J6, 30/10/2026)

**Lot J6 du plan Jarvis** (architecture validée : <https://claude.ai/artifact/34ig3QRV5X7LtanjyuX7U7> — « Capacités : 1 188
actions classées ; l'outil juste trouvé dans les 5 premiers pour 95 % de 300 demandes ; ≤ 4 000 jetons fixes par étape »).
Il ferme aussi la voie (c) de la décision [0013](0013-jarvis-architecture.md) §5 : le couplage « l'Assistant IA emprunte le
catalogue d'outils d'Adam » disparaît par le registre, pas par un déménagement d'Adam.

> Code : socle `src/platform/ia/capacites/` (`registre.ts`, `classement.ts`, `portes.ts`, `lexique.ts`, `familles.ts`,
> `types.ts`, `cliche.ts`, `classement.genere.json`) ; module `src/modules/assistant-ia/infra/{capacites,lectures-erp}.ts`,
> `domaine/capacites.ts`, `infra/operations/quotidien.ts` (`send_message`), `infra/operations/budget.ts` (`read_budget`),
> `infra/lectures.ts` (`read_hr_overview`, `finance_totals`) ; `actions.ts` (`confirmerIntentionAssistantIA`) ;
> `scripts/capacites-classement.ts` (`npm run capacites:classement`). Aucune migration.

## 1. Le registre — dérivé, jamais déclaré à la main

| Source | Ce qui devient une fiche | Exécutée par |
|---|---|---|
| `lib/actions/contrat.genere.json` (1 206 actions serveur, lues sur leur source par `npm run actions:contrat`) | chaque action : champs, types, références, gardes, modèles écrits, `illisible` | l'action elle-même (`lib/actions/executer.ts`) |
| les outils existants de l'Assistant IA (`OutilDecrit`, fournis par le module) | leur nom, leur libellé, leurs familles | l'outil (inchangé) |
| les commandes de l'Atelier (`artifact/atelier/gestes.ts`, 16) | une fiche par geste | `modifier_document` |

Chaque fiche porte : `id`, `source`, le **schéma d'entrée** (JSON pour le modèle, **zod** pour la validation), la **famille de
la console** (`acces-regles`, liste désormais au socle : `capacites/familles.ts`), un **libellé et une description en
français** (tirés du nom par un lexique — un VOCABULAIRE mot → mot, aucune action n'y est nommée), le **risque**, **simulable**
(préparé pour J7), **l'annulation** (la table de `lib/annulation/reversibilite.ts`, injectée), **contenu tiers**, la **porte
d'écran** (modules RBAC), et `appelable`.

**Le socle reste pur** : son plafond d'imports vers l'ERP (`SOCLE_IA_CEILING`, 177) ne se relève pas. Le registre reçoit les
contrats et trois **ports** (le refus générique `interdictionGenerique`, `classerGeste`, `MODULE_LABELS`) ; c'est le module
qui lit `contrat.genere.json` (`src/lib/actions/` n'est pas une dette pour un module). `ContratLu` est la forme structurelle
de `ContratAction` — le compilateur vérifie qu'elles se recouvrent.

### Le niveau de risque — lu sur les faits du contrat, le plus fort gagne

| Niveau | Règle (`classement.ts`) | Chemin |
|---|---|---|
| **R4** argent, droits, signature, décision, suppression | un modèle d'ARGENT écrit (`expenseOrder`, `financeTransaction`, `payment*`, `payroll*`, `pettyCash*`, `treasury*`…) ou un verbe de paiement ; un verbe de suppression ou `deletedRecord` ; un verbe de DÉCISION (valider, approuver, décider, signer, visa, accorder, rejeter, voter, lever…) | carte RENFORCÉE : ressaisie du montant s'il y en a un, sinon du verbe (« SUPPRIMER ») |
| **R3** effet externe | un fichier qui sort de la base (courrier, Microsoft, site public, fournisseur, agence, diffusion) ; publier / diffuser | carte renforcée |
| **R2** écriture qui prévient | `notification` écrit, ou un verbe de relance / d'envoi interne | carte « sensible » |
| **R1** écriture interne réversible | le reste des écritures — et toute action SANS écriture lue qui ne porte pas un verbe de lecture (prudence : `setMessageRead` change une boîte sans écrire en base) | carte |
| **R0** lecture | aucune écriture lue ET un verbe de lecture (lire, lister, chercher, aperçu, vérifier…) | exécutée pendant le tour |

Mesure (1 206 actions) : **R0 70 · R1 628 · R2 159 · R3 61 · R4 288** ; simulable **oui 809 · inconnu 247 · non 150** ;
annulation **retour 641 · compensation 336 · aucune 226 · délégation 3**. 1 042 fiches appelables (avant la porte d'écran).

### Jamais appelable génériquement

Une action **`illisible`** ; une action refusée au chemin générique (`generique.ts` : droits, réglages, garde-fous,
attestations — Mission Control, signature des BC, garde-fous d'Adam) ; un **fichier hors de l'assistant**
(`portes.ts` — `SURFACES_HORS_ASSISTANT` : les actions de l'Assistant IA lui-même — il ne confirme pas ses cartes —, Adam, la
connexion, la « Vue exacte », le portail fournisseur, la plomberie d'administration, la corbeille du Super Admin, l'intérim
des droits) ; une action dont l'objet est un **fichier binaire** (`file`, `scan`, `attachment`… : elle se fait à l'écran).
Elles restent des fiches, avec leur refus.

**Les exclusions écrites d'Adam ne lient pas l'Assistant IA** (565 décisions EXCLUDED de `lib/assistant/action-registry/`,
dont 437 portent sur des actions que le registre rend appelables : KPI, campagne budgétaire, tournées, coaching, site…). C'est
la doctrine déjà écrite (`domaine/operations/types.ts` : « ce sont deux produits ; les décisions prises pour Adam — en pause,
gestes exclus — ne lient pas l'Assistant IA »), et la raison de fond de la plupart de ces exclusions ne s'applique pas ici :
Adam agit dans ses missions, l'Assistant IA ne touche une action qu'après une CARTE confirmée par la personne, dans sa session
— un « clic dans une vraie session » (§118.15), renforcé par la ressaisie pour les décisions, les signatures, l'argent, les
suppressions et les effets externes. Ce qui doit rester à l'écran pour TOUS est refusé par le chemin générique lui-même
(`generique.ts` : signature des BC, Mission Control, garde-fous, droits, réglages) ou par `SURFACES_HORS_ASSISTANT`. Le banc
d'Adam qui tenait son op pour le « seul appelant » de l'exécuteur (`ops/exclusions-generique.test.ts`) nomme désormais le
second, et vérifie qu'il relit sa fiche (`appelable`) avant l'appel.

**Le contrat de `confirmerIntentionAssistantIA`** ne liste plus d'écritures (`ecrit: false`) : elles étaient celles de
`performAction` d'Adam, lues par le scanner ; ce sont désormais celles de l'action exécutée, appelée par son contrat — un
appel que le scanner ne suit pas. L'action reste hors de tout chemin générique (surface hors assistant, EXCLUDED chez Adam).

### 100 % classées, et le cliché qui le tient

`classement.genere.json` (réécrit par `npm run capacites:classement`) garde le classement **relu** de chaque action.
`platform/ia/capacites/registre.test.ts` échoue si une action du contrat n'y figure pas, si une action disparue y reste, ou
si un classement change sans revue — une action ajoutée à l'ERP se classe d'elle-même, et la revue lit le diff du cliché.

## 2. L'appel générique

- **Offerte** seulement si la **porte de l'écran** est ouverte (`porteOuverte` : un `userCan` sur l'un de ses modules — lu
  sur le contrat, sinon sur le module de son audit, sinon sur le préfixe de son fichier ; illisible → Super Admin seul).
  La porte n'autorise rien : l'action rejuge tout, sous la vraie session.
- **Préparée** (`infra/capacites.ts`) : la **famille de la console** rejugée ; les noms résolus sous la portée de la
  personne (`cibles/resoudre-entrees` ; un champ d'identifiant de PERSONNE sans modèle lu — `assignedToId` — se résout par
  l'annuaire ; un nom qui reste dans un champ d'identifiant est DEMANDÉ, jamais passé) ; l'entrée validée contre le contrat
  (`validerEntree` : champ inconnu, obligatoire manquant, valeur hors énuméré → INCOMPLET).
- **R0** : `executerAction` pendant le tour, **sous la session de la personne et d'elle seule** (`getCurrentUser` relu : une
  reprise de fond n'a pas de session → refus dit) ; sortie bornée à 6 000 caractères, **encadrée** si contenu tiers, puis le
  filtre de confidentialité (repères) comme toute sortie.
- **R1+** : une **carte** (intention `assistant_ia_capacite`, **une par tour**), avertissements = la raison du risque et
  l'annulation ; R2 « sensible » ; R3/R4 « critique » + `confirmText` (ressaisie vérifiée par le serveur, `executerIntention`).
- **À la confirmation** (`confirmerIntentionAssistantIA`, dans la requête de la personne) : `executerCapacite` rejuge
  l'**arrêt d'urgence**, la **porte**, la **famille relue en base**, puis appelle **l'action elle-même**. Une carte d'avant J6
  (charge d'Adam) ne s'exécute plus : elle se redemande (plus rien n'est exécuté par `performAction`).
- **Travaux (J2)** : les capacités n'entrent pas au catalogue d'un travail — un plan qui en nommerait une est refusé par
  `lirePlan` (hors catalogue), et un geste de capacité repasse par une carte. Le plan approuvé reste le seul chemin sans
  carte, et il ne contient que les opérations de l'Assistant IA. (Les ouvrir aux plans attend une session de fond — J8.)

## 3. La sélection sur tout l'ERP

Le registre est branché dans la sélection à la demande de J4 : les capacités offertes sont des **fiches** comme les outils
(`fichesOffertes` : mêmes droits, même configuration de rôle — un rôle qui autorisait un ancien outil, `create_task`,
autorise les capacités du même métier, `ANCIENS_OUTILS`). Leurs mots (libellé, module, synonymes) pèsent comme un libellé,
leur contexte (fichier, champs) comme une description. Deux règles de classement neuves, mesurées sur les deux corpus : le
**premier mot** de la demande (le geste) pèse ×1,4, et une fiche dont le **verbe du libellé** est ce geste ×1,2 ; l'infinitif
et l'impératif se rejoignent (« crée » / « créer », « renvoie » / « renvoyer »).

| Mesure | Résultat | Cible |
|---|---|---|
| Rappel@5 sur 300 demandes françaises (toutes familles, ≈ 1 000 capacités + outils — `infra/selection-capacites.test.ts`) | **96,0 %** (288 / 300) | ≥ 95 % |
| Jamais hors droits (assistante de direction, 300 demandes, présélection ET `trouver_outil`) | **0** capacité hors porte | 0 |
| Jetons fixes d'outils par étape (socle + présélection + `trouver_outil`, pire des 300) | **3 837** (estimation ÷ 3,2, calibrée J4) | ≤ 4 000 |
| Corpus J4 (65 demandes, top-8, catalogue avec capacités) | **65 / 65** | inchangé |
| Banc Jarvis, sélection au faux modèle (26 scénarios — `infra/banc-selection.test.ts`) | **26 / 26** | ≥ 22 / 26 |
| Coût d'un tour (Super Admin, 1 039 outils) | catalogue ~5–30 ms, sélection ~15 ms, adaptateur Mastra ~90–110 ms (à chaud ; ~0,5 s au premier tour d'un processus) | — |

Les définitions des capacités, leurs schémas zod et les poids de leurs fiches sont calculés une fois par processus.

## 4. Les résidus supprimés — Assistant IA → Adam = 0

| Emprunté à Adam | Remplacé par |
|---|---|
| écritures `create_task`, `update_task`, `create_hr_request`, `create_admin_request`, `update_regulatory_product`, `assign_regulatory_responsible`, `set_regulatory_step`, `request_regulatory_status_update` (`buildProposal`) ; outils de domaine `regulatory_/hr_/task_/drive_/request_operation` (`DOMAIN_TOOLS`) ; leur exécution (`performAction`) | les **capacités dérivées** des actions de l'écran (`task__createTask`, `regulatory__createRegulatoryProduct`, `hr__requestLeave`, `admin-request__createRequest`, `drive__moveNode`…) |
| `send_message` (Adam : un destinataire, une carte) | une **opération propre** `send_message` (`operations/quotidien.ts`) : aucune action serveur ne porte « écrire à une personne » en un geste — `createDirect` puis `sendMessage`, les actions de l'écran |
| lectures `list_my_tasks`, `list_my_requests`, `my_overview`, `search_products`, `read_workflow` (`executeReadTool`) ; `search_everything`, `read_calendar`, `list_pending_decisions` (`executePowerTool`) | **outils propres au module**, mêmes noms (`infra/lectures-erp.ts` ; `read_workflow` dans `outils-v1.ts`) : ces lectures n'ont pas d'action serveur, et un travail de fond les appelle sans session |
| `read_budget` ; `read_hr_overview`, `finance_totals` (`executePowerTool`) | outils propres (`operations/budget.ts` ; `lectures.ts`) — la masse salariale de la situation RH se lit par `lire_paie` (mois), sous « Salaires & paie » |
| `search_drive` | `search_everything` (le Drive y est) et la Bibliothèque (`chercher_documents`) |

`RESIDUS` de `platform/ia/frontieres.test.ts` est **vide** ; `limites.test.ts` prouve L3/L4 par l'exécuteur de l'Assistant
IA. **Cliquets** : la dette héritée du module (`modules/frontieres.test.ts`) perd 5 entrées (4 vers Adam, `outils-v1 →
hr/confidentialite`) et en gagne 5 (`annulation/reversibilite`, `cibles/resoudre-entrees`, `calendar`,
`queries/action-center`, `queries/search-everything`) — compte égal, aucun plafond relevé ; `SOCLE_IA_CEILING` 177 inchangé
(le registre n'importe rien de l'ERP) ; frontière Adam ↔ ERP, domaines, doublons (1 437 / 12 959), code mort : inchangés.

## 5. L'essai réel (un tour, `gpt-6.1-terra`, base locale `amd_bench`, `scripts/bench/capacites-essai.ts`)

« Crée une tâche pour Karim … : préparer le stand du congrès, échéance le 6 novembre 2026. » — Super Admin, comptes
synthétiques effacés après coup.

| Passage | Résultat | Appels · entrée | Coût |
|---|---|---|---|
| 1 (« pour vendredi ») | une question juste : « ce vendredi 30 octobre ou le 6 novembre ? » | 4 · 21 207 | 0,027 $ |
| 2, 3 | **défaut trouvé** : `assignedToId` (sans modèle lu au contrat) était décrit « identifiant » — le modèle demandait l'identifiant de Karim, sans appeler la capacité | 5 · 28 333 | 0,042 + 0,029 $ |
| 4 (correctif : la règle « un identifiant de PERSONNE se désigne par son nom » passe au registre, `avecPersonnes`) | **carte `Créer tâche`** — capacité présélectionnée, remplie du premier coup, Karim résolu par l'annuaire, aucune tâche créée ; 5,4 s | 2 · 9 823 | 0,013 $ |
| 5 (libellés des champs de la carte en français : « attribué à », « échéance date », « titre ») | idem | 2 | 0,013 $ |

Dépense totale de l'essai : **≈ 0,12 $** (plafond 0,50 $). Le banc complet se rejoue une fois, à la fin des lots.

## 6. Limites connues

- **Changer l'échéance ou la priorité d'une tâche** : Adam l'écrivait lui-même en base ; aucune action d'écran ne le fait
  (seuls `updateTaskStatus` et `reattribuerDemandeTache` existent). Le geste n'est pas repris — il viendra avec l'action de
  l'écran (J11, formulaires générés). Rien d'autre n'est perdu au banc.
- Les libellés sont tirés des noms de code : lisibles, pas toujours élégants (« Définir payé facture »). Ils ne servent qu'à
  la recherche et à la carte ; le contrat reste la vérité des champs.
- La porte d'écran lue sur le PRÉFIXE du fichier est un vocabulaire (`portes.ts`) : une action d'un fichier inconnu reste
  réservée au Super Admin jusqu'à ce que son préfixe y soit rangé.
- `simulable` est un PRONOSTIC (une notification part aussi en push, un fichier va au stockage) : J7 le vérifiera en
  exécutant dans une transaction annulée.
- Le banc réel (modèle, coût, premier mot) se rejoue une fois, à la fin des lots.

## 7. Les preuves

| Test | Ce qu'il prouve |
|---|---|
| `platform/ia/capacites/registre.test.ts` | une fiche par action ; 100 % classées ; le cliché relu recouvre la dérivation ; illisible / refusée / hors assistant / fichier binaire jamais appelable ; risques, familles, annulation sur des cas réels ; noms d'outils valides et uniques ; schéma JSON et zod tirés du contrat ; Atelier au registre |
| `modules/assistant-ia/capacites.test.ts` | carte R2 sans écriture, personne désignée par son nom, confirmée → l'action crée (idempotente) ; R4 sans ressaisie → rien ; une carte par tour ; entrée incomplète dite ; arrêt d'urgence et famille relus à la confirmation ; R0 sous la session seule ; jamais offerte hors porte ; carte d'avant J6 refusée |
| `infra/selection-capacites.test.ts` | 300 demandes : rappel@5 ≥ 95 % ; jamais hors droits ; ≤ 4 000 jetons fixes |
| `infra/banc-selection.test.ts` | les 26 scénarios du banc Jarvis au faux modèle (sélection) : ≥ 22 / 26 |
| `infra/selection.test.ts`, `droits-metier.test.ts`, `limites.test.ts`, `outils-v1.test.ts`, `routines.test.ts`, `contenu-non-fiable.test.ts` | le catalogue sans Adam ; les droits, les repères et les familles sur les capacités ; une routine n'a aucune capacité ; une capacité de lecture qui évoque un tiers est encadrée |
| `platform/ia/frontieres.test.ts` | Assistant IA → Adam = 0 (`RESIDUS` vide) |
