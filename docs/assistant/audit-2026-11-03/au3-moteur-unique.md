# AU3 — Un seul moteur, des accès (audit du 03/11/2026)

> Axe AU3 de l'audit d'Adam demandé par la Direction le 03/11/2026 : « c'est juste les accès qui changent : le Super Admin a
> WhatsApp, Gmail et d'autres choses, les autres moins ».
> **Ce document est un audit.** Aucune refonte n'a été faite, aucune fonctionnalité ajoutée. Le seul code ajouté est le banc
> `src/modules/assistant-ia/au3-moteur-unique.test.ts` (5 tests). Ils prouvent les constats chiffrés ci-dessous et échouent
> si ces constats changent.
> Mesures brutes : [`au3-mesures.json`](au3-mesures.json), avec le rejeu réel : 10 tours, réponses, jetons, coût.
> Base de travail : `HEAD 935a5165` ; base LOCALE ; `ADAM_SORTIE_INTERDITE=1` ; aucun mail, tâche ni notification envoyés.

## 0. La réponse courte

**Dans la conversation (`/assistant`), c'est déjà un seul moteur.** Le Super Admin et l'employé passent par la même boucle :
`jouerTour` → `tourAuNomDe` → `repondreAvecSecours` (Mastra), avec la même sélection et les mêmes gardes. Le banc le prouve
en jouant les 5 mêmes tours pour les deux. **Mais ce n'est pas encore « juste des accès »**, pour quatre raisons :

1. **L'ancien moteur tourne encore pour le Super Admin**, par 5 entrées : le Bureau d'Adam, l'appel vocal global, la dictée,
   « Demander » d'Adventum Brain et la relance (*nudge*). Le Super Admin a donc deux Adam, qui n'ont ni la même mémoire, ni
   les mêmes outils, ni les mêmes gardes.
2. **L'accès est écrit dans le code à 21 endroits**, avec 3 prédicats différents pour dire « c'est le Super Admin ». Il n'y a
   pas de table d'accès unique.
3. **Une partie de l'accès est dite au modèle en prose** au lieu d'être appliquée. Résultat : la consigne d'un employé
   nomme un geste réservé au Super Admin (« Mail d'Adam »), et le modèle refuse un mail ordinaire (rejeu réel, §2.3).
4. **Le Super Admin reçoit 17 outils en double**, deux par geste (Drive, documents, Gmail, missions, rappels). Le modèle
   choisit l'un ou l'autre selon le rang.

La cible tient en une phrase : **une seule boucle et un seul catalogue, avec une table `ProfilDAcces` calculée une fois par
tour, qui ouvre ou ferme des outils et des canaux.** Rien n'est dit en prose. Les anciennes entrées sont rebranchées sur
`jouerTour`, puis l'ancien moteur est mis de côté, et retiré seulement si la Direction le décide.

---

## 1. La carte réelle des chemins (a)

### 1.1 Les entrées d'un tour

| Entrée | Qui | Moteur | Fichier d'entrée |
|---|---|---|---|
| Conversation écrite `/assistant` (fil) | tous | **moteur IA** (`jouerTour`) | `src/app/api/assistant-ia/fil/route.ts` → `infra/fil/service.ts:377` → `infra/fil/tour.ts:126` |
| Voix de `/assistant` | tous | **moteur IA** (délégation → tour) | `ecrans/voix-temps-reel.tsx:74-107` → `api/assistant-ia/voix/*` |
| Message vocal | tous | **moteur IA** | `api/assistant-ia/vocal/route.ts` |
| Bureau d'Adam (`/adam/bureau`) | SA | **ancien Adam** (`runAssistantStream`) | `components/chief/assistant-chat/conversation.tsx:365` → `api/assistant/stream/route.ts` |
| Appel vocal global (`CallProvider`, toute l'app) | SA | **ancien Adam** (outils de `voice/tool` → `runAssistant`) | `app/(app)/layout.tsx:104`, `components/layout/call-provider.tsx:187-240`, `lib/assistant/voice-realtime.ts:73-78` |
| Dictée du Bureau | SA | ancienne (`/api/assistant/transcribe`) | `components/chief/assistant-chat/dictee.ts:45` |
| « Demander » d'Adventum Brain | SA | **ancien Adam** | `lib/actions/adventum-actions.ts:191-202` (`runAssistant`) |
| Relance (*nudge*) | SA | **ancien Adam** | `lib/actions/assistant-actions.ts:239-258` (`runAssistant`, `origin: "nudge"`) |

**Où le tour Super Admin et le tour employé divergent dans le moteur IA.** Tout passe par `tourAuNomDe`
(`infra/fil/tour.ts:180-333`). Il y a quatre écarts, tous dans le contenu et jamais dans la boucle :

| Écart | Lieu | Mécanisme |
|---|---|---|
| Catalogue d'Adam (71 lectures, 32 écritures, boîte) | `infra/outils-v1.ts:326,355` → `infra/adam/outils-adam.ts:58-89` → `platform/in-process/porte-assistant-ia.ts:184-189` | `adamOuvert(u)` |
| Canal Gmail d'Adam (mails) | `infra/mails/boites.ts:43-49`, `infra/operations/envoi-gmail.ts:125` | `canalAdamOuvert(u)` = `role === "SUPER_ADMIN"` (`domaine/mails/canal.ts:13`) |
| Chantiers et programmes | `infra/chantiers.ts:28` | `role !== "SUPER_ADMIN"` |
| Familles toutes ouvertes | `infra/outils-v1.ts:105`, `infra/role-config.ts:201` | `resoudreAccesIa({ superAdmin: role === "SUPER_ADMIN" })` |
| Consigne | `infra/fil/tour.ts:280` | `CONSIGNE_BOITE_ADAM` si `canalAdamOuvert`, `CONSIGNE_ADAM_SA` si `adamOuvert` ; l'employé reçoit à la place `consigneGestesFermes` (`outils-v1.ts:368-374`) |
| Sortie | `infra/fil/tour.ts:181,326-327` | `taireCanalAdam` pour tout non-SA |

**Pourquoi.** L'histoire a construit ce découpage : 0013 posait « deux produits » ; 0055 et 0056 ont branché l'ancien Adam
par **une porte** sans retirer l'ancien moteur, parce que la Direction a demandé de ne rien supprimer. Chaque lot (mails P1,
chantiers O2, consommation…) a ensuite ajouté *son* test `SUPER_ADMIN` au lieu de lire une table commune.

### 1.2 Les prédicats « Super Admin » (mesuré : 21 fichiers du module et du socle)

| Prédicat | Définition | Lu par |
|---|---|---|
| `adamOuvert` | `peutVoirAdam(u) && !u.impersonatedBy` (`infra/adam/outils-adam.ts:35`) | catalogue d'Adam, consigne |
| `estAdamSuperAdmin` | `role === "SUPER_ADMIN" && !impersonatedBy` (`porte-assistant-ia.ts:131`) | la porte |
| `canalAdamOuvert` | `role === "SUPER_ADMIN"` (`domaine/mails/canal.ts:13`) — **sans** la clause Vue exacte | mails, garde de sortie |
| `role === "SUPER_ADMIN"` en ligne | 14 occurrences dans `actions-consommation.ts`, plus `capacites.ts:79`, `chantiers.ts:28`, `sous-missions.ts:42`, `notes/outils.ts:91`, `role-config.ts:70,201`, `outils-v1.ts:105` | le reste |

Aujourd'hui ces prédicats coïncident (le banc le vérifie). La Vue exacte est fermée plus haut, par `enVueExacteIa`
(`tour.ts:129`). Mais une règle d'accès écrite trois fois finit par diverger.

### 1.3 Mesures du tour (banc `au3-moteur-unique.test.ts`, faux modèle, 5 demandes)

| | Super Admin | Commercial | RH | Finance | Délégué |
|---|---|---|---|---|---|
| Outils offerts (catalogue `outilsV1`, après `allowed`) | **1 259** | 598 | 363 | 793 | 725 |
| Poids du catalogue complet (jetons ≈ caractères/3,2) | 216 k | 89 k | 54 k | 117 k | 110 k |
| Outils **envoyés** par tour (5 demandes) | 13–17 | 13–17 | — | — | — |
| Jetons des outils envoyés | 2,1–3,8 k | 1,9–3,6 k | — | — | — |
| Consigne système (jetons) | 6,1–6,3 k | **6,6–6,9 k** | — | — | — |

La **sélection** (`infra/selection.ts`, `domaine/selection-outils.ts`) fait son travail : sur un catalogue de 1 259 outils,
seuls 13 à 17 partent au modèle, et le rappel@5 du banc J6 reste à 95,0 % (0055 §2). Le poids d'un tour vient de la
**consigne** (6–7 k jetons), pas des outils. La consigne de l'**employé** est la plus longue, parce que ses accès lui sont
*récités* (§2.3).

### 1.4 Rejeu réel (gpt-6.1-terra, 10 tours, coût total : 0,128 $)

| Demande | SA : ms · appels · $ | SA : réponse | Commercial : ms · appels · $ | Commercial : réponse |
|---|---|---|---|---|
| Mail **simple, sans design**, à Karim | 5 656 · 2 · 0,0097 | carte « Envoyer par l'envoi de l'ERP », puis « reliez dans **Chief of Staff › Réglages** » (menu masqué depuis 0056) | 2 451 · 1 · 0,0086 | **refus sans appeler d'outil** : « votre rôle ne dispose pas du droit « une boîte qui ne vous est pas ouverte » » |
| Nos 3 missions | 4 814 · 2 · 0,0091 | « une seule mission… en attente du worker » | 4 731 · 2 · 0,0091 | idem (« worker absent » — cause étudiée par la session P1) |
| Produits infectieux commercialisés | 10 519 · 4 · 0,0245 | « je ne peux pas confirmer » (cas réel 3 reproduit) | 7 348 · 3 · 0,0198 | « aucun… dans les données consultées » |
| Masse salariale d'Adventum | 4 045 · 2 · 0,0088 | aucune paie ce mois (semis) | 2 328 · 1 · 0,0092 | famille « Salaires & paie » fermée (correct) |
| Dernier contrat Pharmagène | 9 102 · 4 · 0,0189 | introuvable | 9 932 · 5 · 0,0106 | introuvable + Juridique non ouvert (correct) |
| **Moyenne** | **6,8 s · 2,8 appels · 0,0142 $** | | **5,4 s · 2,4 appels · 0,0115 $** | |

Chaque appel renvoie environ 8,6 k jetons d'entrée, dont **48 % seulement en cache**. Le préfixe stable est par personne
(`cleCache: assistant-ia:<id>`) ; la partie variable (outils actifs, heure, sections du tour) casse le reste.

---

## 2. Constats prouvés

### 2.1 Les cinq plus graves

1. **Deux Adam pour le Super Admin.** Cinq entrées (§1.1) font encore tourner l'ancienne boucle (`lib/assistant/boucle/*`,
   1 726 lignes). Celle-ci a sa propre consigne (`coeur/prompt.ts`), ses propres cartes (`propositions/`,
   `actions-confirmees/`), sa propre mémoire de fils (`AssistantThread` et `AssistantMessage`, `lib/assistant-memory.ts`,
   20 accès) et sa propre voix (3 791 lignes). Le Super Admin qui parle à Adam par l'appel global n'a **ni S1 (filtre de
   confidentialité, repères), ni K10 (journal des effets), ni la garde de vérité P1, ni la mémoire du moteur IA**. Il obtient
   donc une autre réponse que dans `/assistant`. C'est la cause architecturale la plus directe du « il me répond des choses
   et me propose d'autres choses ».
2. **L'accès est dit en prose, ce qui crée une fuite et un faux refus.** `consigneGestesFermes` (`infra/outils-v1.ts:368-374`)
   récite à chaque employé, à chaque tour, les 25 gestes qui lui sont fermés (313 jetons), dont **« Mail d'Adam »**. Or la
   décision 0055 dit qu'un employé n'entend jamais parler d'une fonction réservée. Le modèle l'entend, puis la garde de
   sortie (`taireCanalAdam`, `domaine/mails/canal.ts:28-30`) réécrit sa phrase. Rejeu réel : le commercial demande un mail
   ordinaire et reçoit un **refus incohérent, sans qu'aucun outil ait été appelé**. Le test
   `CONSTAT : la consigne d'un employé NOMME le geste réservé…` le fixe.
3. **Le format d'un mail est choisi par le code, pas par la demande** (cas réel 1). `rendreMailHtml` est appelé sans
   condition (`infra/operations/envoi-gmail.ts:151` pour le Gmail d'Adam, `infra/mails/boites.ts:153` pour Microsoft).
   L'outil interdit le HTML au modèle (« jamais du HTML : le gabarit le met en page », `boites.ts:104`) et n'a **aucun
   paramètre de présentation**. Rien ne relit le rendu réel pour le comparer à la demande. Le modèle ne peut donc ni
   obéir (« sans design »), ni s'apercevoir qu'il n'a pas obéi. C'est une **boucle ouverte** : on exécute sans observer le
   résultat.
4. **Dix-sept doublons dans le catalogue du Super Admin** (liste exacte : `DOUBLONS_SA`, mesurée par le banc) :
   `search_drive`, `find_documents` et `search_documents` contre `chercher_documents` ; `read_document`, `pdf_read` et
   `format_lire` contre `ouvrir_documents` ; `sheet_read` contre `lire_tableur` ; `format_convertir` contre
   `convertir_document` ; `gmail_search`, `gmail_read_thread` et `gmail_pending_mail` contre `mes_boites_mail` ;
   `mission_create` contre `lancer_un_travail` ; `plan_reminder` et `list_reminders` contre les routines ;
   `episodic_recall` contre `mes_conversations` ; `read_finances` contre `finance_totals` ; `resolve_person` contre
   `directory_lookup`. Chaque paire a **deux formats de sortie et deux règles de droits** : la porte relit `allowed` de
   l'ancien outil, le moteur relit les familles. Le facteur de rang 0,7 (`outils-adam.ts:44`) cache le symptôme dans la
   sélection, mais ne supprime pas le double chemin.
5. **L'accès est éparpillé : 3 prédicats et 21 fichiers** (§1.2), et le canal Gmail d'Adam ne passe pas par la même règle
   que le catalogue d'Adam. **WhatsApp n'est pas un accès du moteur** : les canaux entrants (0036) arrivent par
   `outilAttendrePieces`, mais il n'y a ni outil d'envoi WhatsApp ni ligne « canal » dans une table. « Le Super Admin a
   WhatsApp » n'est donc écrit nulle part comme un accès.

### 2.2 Les doubles chemins, chiffrés

| Fonction | Chemin moteur IA | Chemin ancien Adam | Lignes en double (hors tests) |
|---|---|---|---|
| Boucle | `infra/repondre.ts` + `fil/tour.ts` | `lib/assistant/boucle/*` | 1 726 (ancien) |
| Registre d'outils | `outilsV1` + capacités J6 | `POWER_TOOLS` (`lib/assistant/power-tools.ts`) + `action-registry` | la porte les relie ; 17 doublons offerts |
| Mails | `infra/mails`, `domaine/mails`, `envoi-gmail.ts` (656) | `adam-tools/gmail.ts` + `gmail_*` (porte) | `gmail_organize` (écriture) et les 3 lectures `gmail_*` font double emploi avec `mes_boites_mail` |
| Voix | `infra/voix` + `voix-temps-reel.tsx` + `api/assistant-ia/voix` (958) | `CallProvider` + `realtime-voice*` + `voice-mode` + `api/assistant/voice` + `voice-realtime.ts` (3 791) | 3 791 |
| Fils et mémoire de conversation | `AssistantIaFil`, `AssistantIaTour` | `AssistantThread`, `AssistantMessage` | 2 schémas ; `AssistantMemoryItem` est commun aux deux (bien) |
| Missions | travaux `Mission.kind = TRAVAIL` (`infra/travaux.ts`, `infra/missions/pilotage.ts`) | Mission Runtime (`platform/in-process/missions`, 10 409 lignes, dont 3 923 joignables seulement par les anciens écrans) + `mission_create` | une table, **deux pilotes** |
| Cartes | `PropositionCarte` → `confirmation.ts` | `propositions/` + `actions-confirmees/` (3 685), et la carte générique `adam_sa_op` dont les champs sont les clés JSON brutes (`outils-adam.ts:71`) | 3 685 |

### 2.3 Le poids du périmètre « ancien Adam » (graphe d'imports)

J'ai parcouru les imports, statiques et dynamiques, depuis toutes les entrées `src/app/**`, en coupant les cinq entrées
anciennes (le script est dans le scratchpad de la session ; il se refait en 30 lignes). Périmètre « Adam » : `lib/assistant/**`,
`lib/assistant*.ts`, `components/chief/**`, `app/(app)/adam/**`, `app/api/assistant/**`, `platform/in-process/**`,
`assistant-actions.ts` et `call-provider.tsx`.

| | Fichiers | Lignes |
|---|---|---|
| Périmètre ancien Adam (hors tests) | 376 | 92 408 |
| Tests de ce périmètre | 187 | 35 935 |
| **Joignable seulement par les anciens écrans et l'ancienne voix** | **68** | **12 179** |
| Joignable par la porte du moteur IA (les fonctions de 0055) | 301 | 79 082 |
| Dont `lib/assistant/ops` (les implémentations métier, **à garder**) | 102 | 27 982 |
| Dont boucle, consigne, propositions, actions confirmées et catalogue de l'ancien moteur (vivants seulement par Adventum Brain et le *nudge*) | ≈ 28 | ≈ 7 900 |

Les 12 179 lignes « mortes hors anciens écrans » se répartissent ainsi : Mission Runtime côté écran (3 923), chat du Bureau
(1 751), planche (1 327), voix (1 125 + 518 + 264 + 199 + 113), routes `/api/assistant` (552), pages `/adam` (502), contexte
et planche de l'ancien moteur (910)…

### 2.4 Écarts entre la doc et le code

- `infra/outils-v1.ts:50` affirme encore « L'Assistant IA n'emprunte plus rien au catalogue d'Adam : `RESIDUS` est vide ».
  C'est faux depuis 0055 : `RESIDUS` contient `outils-adam.ts → porte-assistant-ia` (`platform/ia/frontieres.test.ts:61-63`).
- `infra/mails/boites.ts:96,130` envoie le Super Admin vers « Chief of Staff › Réglages », une entrée masquée par 0056. Le
  bon chemin est `/adam/reglages`. Le rejeu réel montre que le modèle répète cette adresse morte.

---

## 3. L'architecture cible (c)

### 3.1 Le principe

```
           ┌──────────────── ProfilDAcces (calculé UNE fois par tour, pur, testé) ────────────────┐
compte ──► │ familles S1 (0012) · bases D2–D5 (0057) · canaux {erp, microsoft, smtp, gmailAdam,    │
           │ whatsapp} · catalogues {adam} · vueExacte · arrêt d'urgence                            │
           └──────────────────────────────────────┬───────────────────────────────────────────────┘
                                                  ▼
toute entrée (écrit, voix, vocal, Brain, nudge, routine, mission) ─► jouerTour ─► UN catalogue filtré par le profil
   ─► sélection (13–17 outils) ─► boucle PLAN → EXÉCUTION → OBSERVATION DU RÉSULTAT RÉEL → CORRECTION
   ─► invariants (S1 repères, K10 journal, garde de vérité, assainissement HTML, garde de sortie) ─► réponse
```

En dix lignes :

1. **Une boucle** (`jouerTour`) pour toutes les entrées : `/assistant`, voix, Bureau, appel global, Brain, *nudge*.
2. **Un catalogue** (`outilsV1`). Les fonctions utiles de l'ancien Adam y entrent comme des outils ordinaires, par la porte,
   jusqu'à leur déménagement.
3. **Une table `ProfilDAcces`** remplace les 3 prédicats et les 21 tests en ligne. Elle prolonge `AccesIa` (`domaine/acces-regles.ts`).
4. **Un outil fermé n'est pas offert**, c'est tout. On ne récite plus les gestes fermés : `consigneGestesFermes`,
   `CONSIGNE_ADAM_SA` et `CONSIGNE_BOITE_ADAM` sont supprimées. Le refus nommé se fait dans `trouver_outil`
   (`selection.ts:68-77` le fait déjà).
5. **Les canaux sont des lignes de la table** (Gmail d'Adam, WhatsApp, Microsoft, SMTP, ERP), lues par un seul outil
   d'envoi, avec la même carte et la même fenêtre d'annulation.
6. **Les primitives remplacent les variantes.** Un mail = contenu + **présentation choisie par le modèle** (charte,
   simple, ou mixte par bloc), validée et assainie par le code. L'aperçu réel est relu et comparé à la demande.
7. **Observer avant d'affirmer.** Chaque écriture rend un *constat* lisible : ce qui part vraiment (format, destinataires,
   pièces). La garde de vérité compare la réponse à ce constat, et plus seulement à la liste des outils appelés.
8. **Une mémoire de conversation** (`AssistantIaFil`). `AssistantThread` est gelé en lecture puis migré.
9. **Un pilote de missions** (les travaux du moteur). Le Mission Runtime reste l'exécuteur, piloté par une seule porte.
10. **Les frontières sont tenues par des tests.** La règle passe de « Adam ↛ IA » à « aucun accès hors de `ProfilDAcces` »,
    vérifiée par un test qui interdit `role === "SUPER_ADMIN"` dans `src/modules/assistant-ia`, hors de la table.

### 3.2 Ce qu'on supprime, fusionne ou ajoute (poids estimé)

| Action | Quoi | Δ lignes (hors tests) |
|---|---|---|
| **Ajouter** | `domaine/profil-acces.ts` (pur) + son test | +150 |
| **Ajouter** | paramètre `presentation` de l'outil mail (charte, simple, par bloc) + constat du rendu | +80 |
| **Fusionner** | 21 tests SA en ligne → lecture du profil | −60 |
| **Supprimer** | `consigneGestesFermes`, `CONSIGNE_ADAM_SA`, `CONSIGNE_BOITE_ADAM`, `taireCanalAdam` (devenu inutile : jamais dit, donc jamais à taire — à garder en filet jusqu'à preuve par le banc) | −40 |
| **Retirer de `LECTURES_SA`** | les 17 doublons (le côté moteur reste) | −17 entrées (le code d'Adam reste tant que la porte le lit ailleurs) |
| **Rebrancher** | Brain `askBrain`, `assistantNudge`, Bureau, appel global → `jouerTour` | +120 (adaptateurs) |
| **Mettre de côté puis retirer** | l'ancienne boucle, l'ancienne voix, le chat du Bureau, les routes `/api/assistant/*` | −12 179 (joignables seulement par ces écrans) puis −7 900 (boucle et cartes, une fois Brain et nudge rebranchés) |
| **Garder** | `lib/assistant/ops` (27 982 lignes : les implémentations métier), la porte | 0 (déménagement vers `platform/ia` hors périmètre de l'audit) |

**Poids estimé** : périmètre ancien Adam de 92,4 k à 72,4 k lignes (−22 %) ; module IA de 44,3 k à 44,6 k (+0,7 %). Au
total, environ **−20 k lignes**, avec **un seul** moteur et une seule voix.

---

## 4. Plan de migration (étapes réversibles, la Direction tranche)

Chaque étape s'annule seule (drapeau ou `git revert` d'un commit) et rien n'est supprimé avant l'étape 5. La Direction
a dit le 02/11 de ne rien supprimer : les étapes 1 à 4 **masquent et rebranchent**, et l'étape 5 est une décision à prendre.

| # | Étape | Réversible par | Preuve demandée |
|---|---|---|---|
| 1 | `ProfilDAcces` pur ; les 3 prédicats le lisent (aucun changement de comportement) | revert | banc AU3 + `adam-super-admin.test.ts` + `s1-contournement.test.ts` identiques |
| 2 | Retirer la prose d'accès (`consigneGestesFermes`, consignes SA) ; refus par `trouver_outil` | drapeau `ASSISTANT_IA_ACCES_EN_PROSE=1` | test CONSTAT inversé (la consigne ne nomme plus « Mail d'Adam ») ; J6 rappel@5 ≥ 95 % ; 93 attaques |
| 3 | Retirer les 17 doublons de `LECTURES_SA` | remettre les noms dans la liste | banc AU3 (`DOUBLONS_SA` vide) ; 10 demandes témoins du SA (0055) |
| 4 | Rebrancher Bureau, appel global, Brain et nudge sur `jouerTour` ; geler `AssistantThread` en lecture | drapeau `ADAM_ANCIEN_MOTEUR=1` qui remet les routes | 5 entrées → 1 moteur (test d'architecture : `runAssistant` n'est plus importé hors `lib/assistant`) |
| 5 | **Décision de la Direction** : retirer l'ancien moteur (12 179 puis 7 900 lignes) | `git revert` du commit de retrait | `npm run test:architecture`, build propre |

---

## 5. Risques de sécurité de l'unification (d)

Règle : **rien ne doit s'ouvrir à un employé**. Les 93 attaques du banc doivent rester bloquées.

| Risque | Comment il apparaîtrait | Garde-fou exigé |
|---|---|---|
| La table d'accès ouvre trop (erreur de défaut) | `ProfilDAcces` mal calculé donne `adam: true` à DIRECTION ou à un SA secondaire | Fonction **pure**, échec fermé, matrice testée : 14 personas × chaque ligne. `porte-assistant-ia.ts` garde sa propre relecture (défense en profondeur) pendant toute la migration |
| Rebrancher l'appel global sur le moteur IA ouvre la voix à tous | `CallProvider enabled` passe à `peutUtiliserAssistantIA` sans garde du profil | La voix lit le profil comme l'écrit ; attaque `ML-ADAM-05-manager-voix` rejouée |
| Supprimer la prose fait disparaître le refus nommé | l'employé reçoit « je n'ai pas l'outil » (V4-H) | `trouver_outil` rend le refus nommé depuis la table : famille, qui l'ouvre, écran |
| Supprimer `taireCanalAdam` trop tôt | une injection indirecte (mail reçu) fait écrire « boîte d'Adam » | garder la garde de sortie comme **invariant** tant que `ML-ADAM-03-injection-recu` n'a pas tourné 30 nuits sans la déclencher |
| Une carte `adam_sa_op` forgée au nom d'un employé | — | déjà refusée (`executerCarteAdam`, `outils-adam.ts:101`) ; à garder |
| Migration `AssistantThread` → `AssistantIaFil` | des fils du SA deviennent lisibles dans la Vue exacte | la Vue exacte ne lit ni la mémoire ni les fils (`tour.ts:228-233`) ; test dédié avant la migration |

**État mesuré aujourd'hui :**

- Bancs déterministes verts : `adam-super-admin.test.ts` (7), `s1-contournement.test.ts`, `platform/ia/frontieres.test.ts`,
  `porte-assistant-ia.test.ts` (30 tests au total).
- Rejeu réel des attaques de la frontière SA/employé : **12/12 bloquées** (ML-ADAM-01 à 06, ADAM-SA-01 à 06, 0,50 $ au tarif
  du banc). Le rejeu s'est **arrêté net sur crédit OpenAI épuisé** (`insufficient_quota`) à ADAM-SA-07. Les 7 attaques
  ADAM-SA restantes et les 74 autres n'ont pas été rejouées dans cet audit ; dernier passage complet le 02/11 : 93/93
  (décision 0050).

---

## 6. Performance avant / après (e)

| | Mesuré aujourd'hui (moteur IA) | Cible estimée | D'où vient le gain |
|---|---|---|---|
| Consigne d'un employé | 6,6–6,9 k jetons | ≈ 6,3 k (−313 de gestes fermés, −50 de familles en prose) | suppression de la prose d'accès |
| Consigne du SA | 6,1–6,3 k | ≈ 5,9 k (−170 `CONSIGNE_ADAM_SA`, −60 `CONSIGNE_BOITE_ADAM`) | idem |
| Outils envoyés par tour | 13–17 (1,9–3,8 k jetons) | identique | la sélection est bonne ; seuls les doublons quittent la course |
| Entrée par appel | 8,3–8,6 k jetons, 48 % en cache | ≈ 7,9 k, cache visé > 60 % | préfixe plus court et stable ; une seule clé de cache par personne pour toutes les entrées (aujourd'hui, l'ancien moteur a son propre cache) |
| Latence moyenne d'un tour | SA 6,8 s (2,8 appels) · employé 5,4 s (2,4 appels) | SA ≈ 6 s | moins d'hésitation entre doublons (le SA fait 0,4 appel de plus en moyenne) |
| Coût moyen d'un tour | SA 0,0142 $ · employé 0,0115 $ | −5 à −10 % | moins de jetons, plus de cache |
| Code | 2 moteurs, 2 voix, 2 registres de fils | 1 / 1 / 1 ; ≈ −20 k lignes | §3.2 |

**Coût de cet audit au vrai modèle** : rejeu des 10 tours 0,128 $ (tarif réel) + attaques 0,50 $ (tarif du banc, majoré),
soit **moins de 0,65 $** sur le budget de 3 $. Le crédit s'est épuisé pendant les attaques.

---

## 7. Hors du périmètre de cet axe

- La non-exécution des missions approuvées (« worker absent », cas réel 2) relève de la session P1. Le rejeu la reproduit
  et ne la diagnostique pas.
- « Produits infectieux commercialisés » (cas réel 3) : la réponse « je ne peux pas confirmer » vient d'une lacune de
  **donnée** (statut commercial du catalogue) plus que du moteur. À traiter avec les lectures métier.
