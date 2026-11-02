# 0045 — Une vraie mémoire pour Adventum IA (lot M1, 01/11/2026)

Constat de la Direction (verbatim) : « J'ai fait une longue conversation avec Adventum IA, j'ai parlé de moi, de ma
famille, de mes voyages, de mes études… J'aurais voulu qu'il les retienne dans sa mémoire, mais quand je suis allé
cliquer sur ce qu'il retient, je n'ai rien trouvé. Pourtant il doit avoir une super mémoire. C'est hyper important. »

Suit [0013](0013-jarvis-architecture.md) (mémoire personnelle, à la personne seule), [0018](0018-vitesse-memoire.md)
(assembleur, enveloppes), [0027](0027-adventum-ia.md) (conversations privées : ni mémoire lue ni écrite).

> Code : `domaine/memoire-ui.ts` (sortes, groupes, libellés), `domaine/memoire/capture.ts` (filtre, consigne, lecture,
> garde), `domaine/memoire/rappel.ts` (BM25, profil, enveloppes), `infra/memoire.ts` (stockage, historique, annulation,
> réglage), `infra/memoire-capture.ts` (capture après tour, rappel du tour, voix), `infra/generer.ts` (`plongerTextes`) ;
> écran : `ecrans/memoire-panel.tsx`, `ecrans/memoires-retenues.tsx`. Migration `20270219100000_assistant_ia_memoire_auto`.

## 1. Les causes, confirmées dans le code

1. **Rien ne s'écrivait sans un clic.** La seule porte d'écriture était l'outil `proposer_memoire` → carte « Retenir » ;
   la règle 11 disait « rien n'est retenu avant son geste ». Une carte non cliquée = rien en base.
2. **La règle ne visait que le travail** (« sa société, ses produits, une préférence, une habitude ») et les sortes
   (`SORTES_MEMOIRE`) n'avaient aucune place pour la famille, les voyages, les études.
3. **L'outil n'était presque jamais offert** : la présélection (J4) ne le proposait que sur « retiens / souviens /
   mémoire / rappelle-toi ».
4. **À l'oral**, aucune carte « Retenir » n'est montrée ni confirmée : une conversation vocale ne pouvait rien retenir.
5. **Le rappel** prenait les 30 plus récents et les triait par mots partagés dans 500 jetons : « mon voyage » ne
   trouvait pas « Part à Lyon le 12 » (aucun mot commun).

## 2. Ce qui est décidé

**Capture automatique, visible et réversible.** Après chaque tour (et à la fin d'une conversation vocale), le dernier
message de la personne passe trois portes, la moins chère d'abord :

| Porte | Ce qu'elle fait | Coût |
|---|---|---|
| Filtre déterministe (`faitDurablePossible`) | première personne + un thème de vie ou de travail durable ; une demande sur l'ERP, « merci », « tu te souviens… ? » s'arrêtent là | 0 |
| Extracteur (modèle `rapide`, JSON strict) | lit le SEUL message de la personne (≤ 1 500 car.) et ≤ 12 souvenirs proches (pour remplacer plutôt qu'ajouter) | ≈ 0,0002 $ |
| Garde (`garderCandidat`) | un chiffre ou un nom propre absent du message est refusé ; salaire, prime, IBAN, matricule, pièce d'identité, évaluation : jamais | 0 |

La **réponse de l'assistant n'entre pas** chez l'extracteur : elle porte des données de l'ERP (un salaire lu pour la
personne, un tiers). La mémoire porte sur la personne et sur ce qu'ELLE dit.

Les souvenirs sont **enregistrés d'office** (la Direction veut qu'il retienne). Sous la réponse, une ligne discrète :
« Retenu : Part à Lyon le 12 novembre avec sa fille Lina — annuler · voir ». **Annuler** défait exactement l'ajout ; s'il
remplaçait un fait, l'ancien revient (`annulerSouvenir`). Une annulation propre à la mémoire plutôt que le journal des
effets J7 : la mémoire n'est pas une écriture métier, elle est à la personne seule, et l'annulation doit restaurer
l'ancienne version du fait — ce que la chaîne `remplaceId` porte directement.

**Mise à jour, pas d'empilement.** Un fait qui change (désigné `remplace` par l'extracteur, ou de même `sujet`, ex.
`voyage:lyon`) passe l'ancien à l'historique (`active = false`, `remplaceLe`), le nouveau porte `remplaceId`. Un doublon
(même phrase, ou Jaccard des racines ≥ 0,8) n'écrit rien. Chaque souvenir garde sa date, sa conversation et son message
d'origine (`sourceThreadId`, `sourceTourId`), son origine (`manuel`, `propose`, `auto`, `voix`).

**Sortes de la vie personnelle** : `PERSONNEL_IDENTITE`, `FAMILLE`, `ETUDES_PARCOURS`, `SANTE_DECLAREE`, `VOYAGES`,
`GOUTS_LOISIRS`, `PROJETS`, `CONTRAINTES`, `PERSONNES_CITEES` — à côté des sortes du travail. Le panneau les groupe :
Moi, Ma vie, Mon travail, Comment me répondre.

**Rappel par pertinence.** À chaque tour : un **profil** stable (identité, famille, préférences de réponse ; 250 jetons)
toujours présent, puis les **souvenirs pertinents** (600 jetons) — BM25 sur les racines du souvenir ET les mots de sa
sorte (« voyage » trouve un souvenir rangé sous VOYAGES), mêlé au cosinus des plongements (text-embedding-3-small, 512,
calculés à l'écriture) **seulement si la mémoire ne tient pas entière** : sinon aucun appel. La voix reçoit le même
profil dans sa consigne de session et dit, une fois, « je le retiens ».

**Ce qui ne change pas.** Conversation privée : rien n'est lu, rien n'est retenu (dit au modèle et dans l'écran). La
mémoire est à la personne seule : chaque lecture et écriture filtre sur l'identité de la session — Super Admin compris
(aucun outil d'admin ne lit la mémoire d'autrui ; Adam garde son propre `forgetMyAssistantMemory`). Rien de sensible
(filtre de confidentialité à l'écriture et à la relecture).

**Réglage par personne** : « Mémoire automatique » (`AssistantIaPreference.memoireAuto`, défaut oui) dans le panneau.
Coupée, l'outil `proposer_memoire` et sa carte reviennent (`CONSIGNE_MEMOIRE_A_LA_CARTE`). « Tout effacer » efface tout,
historique compris.

## 3. Coût mesuré (serveur réel, 01/11/2026)

Une capture qui retient : 1 appel `gpt-6-luna` (≈ 570 jetons d'entrée, ≈ 220 de sortie) = **0,000168 $**, + 1
plongement (≈ 150 jetons) = **0,000003 $**. Un tour sans fait durable : **0 $** (filtre). Le journal K8 la range sous
l'usage « Mémoire (capture automatique) » (`role = memoire`). Ordre de grandeur : < 1 % du tour qu'elle suit
(≈ 0,0066 $ pour un tour `gpt-6.1-terra`).

## 4. Décisions de la Direction (01/11/2026) — appliquées

Verbatim : « L'historique des souvenirs remplacés : on les garde 12 mois. La santé : il retient d'office. Le plafond de
300 souvenirs, ok, mais il faut une très bonne gestion, efficiente et efficace en termes de tokens surtout. Ce n'est pas
une histoire de nombre de souvenirs, plutôt un nombre de tokens. Le plafond quotidien : pas de plafond tout court. »

**Historique 12 mois.** Un fait remplacé (un fait qui change) ou repris par une consolidation reste, inactif, 12 mois
(`remplaceLe`), puis la tâche `assistant.memoire` le purge (`purgerHistoriqueMemoire`, idempotente, testée). Un fait
ACTIF n'est jamais purgé par l'âge.

**Santé d'office.** C'était déjà le comportement (filtre, consigne, garde) ; un test le fixe (« Je suis allergique à la
pénicilline » → `SANTE_DECLAREE` retenu sans carte).

**La mémoire en JETONS.**
- *Compteur* : calibré sur le modèle — une section mémoire de 820 caractères a coûté 229 jetons d'entrée réels (mesurés
  avec et sans elle, `usage.input_tokens`, gpt-6-luna) : 3,58 caractères/jeton ; 3,5 retenu (surestime de ~2 %).
  `domaine/memoire/rappel.ts` (`jetonsMemoire`, `jetonsLigne`).
- *Injection* : profil 250 + pertinents 600 + en-têtes ≤ 70 — la section entière est testée au jeton près de ce compteur.
- *Stockage* : un budget par personne, `AssistantIaReglage.memoireJetonsBudget`, **défaut 8 000 jetons** (≈ 300 faits
  courts, ≈ 9 fois la section injectée), réglable dans Administration › IA › Consommation. Le panneau affiche « X jetons
  sur Y ». Les 300 éléments restent un garde-fou haut.
- *Consolidation* (`domaine/memoire/consolidation.ts`, `infra/memoire-consolidation.ts`) : à 85 % du budget, UN appel du
  modèle rapide en lot (après la capture qui franchit le seuil, ou par la tâche quotidienne), au plus une fois par jour et
  par personne : fusion des faits proches, réécriture concise, regroupement par sujet, anciens jamais rappelés résumés,
  vers 60 % du budget. La règle garde le dernier mot (le groupe économise des jetons, n'invente aucun chiffre ni nom).
  Chaque fait repris passe à l'historique (`consolideDans`) : « annuler » sur le fait consolidé les rend actifs.
  Journal K8 : usage « memoire ».
- *Mesuré* (banc, 123 faits redondants comme après des semaines de conversations, vrai modèle) : stockage **1 688 → 402
  jetons** (123 → 9 faits, aucun refusé, rien de perdu : enfants, âges, école, voyages et dates, goûts, santé, parcours,
  contraintes) ; **injecté par tour 892 → 467 jetons** ; coût de la consolidation **0,00097 $** (4 335 jetons
  d'entrée, 1 080 de sortie, 10 s). [`preuves/m1/jetons.json`](../preuves/m1/jetons.json).

**Pas de plafond quotidien.** `plafondJetonsJour` vaut **0 = sans plafond** par défaut (migration
`20270219300000_memoire_jetons_sans_plafond` : la ligne restée au défaut de 600 000 passe à 0), réglable en console si un
jour on le veut ; l'écran Consommation (« Sans plafond par jour ») et Administration › IA › Consommation (« Sans plafond »,
plus de pourcentage) le disent. **Inchangés**, et c'est voulu : le plafond **par tour** (150 000 jetons, garde-fou
contre une boucle), les plafonds des travaux en arrière-plan (20 $/travail, mensuel), ceux des chantiers et des visuels.

## 5. Direction (02/11/2026) — textes longs jamais coupés, mémoire « légèrement plus »

Verbatim : « Enlève la limite de tokens par chat : quand j'envoie des textes trop longs, ça les coupe car il y aurait une
limite. De plus, pour la mémoire, je veux qu'il retienne un peu plus — c'est parfait maintenant, mais légèrement plus. »

**Textes longs.** Toutes les coupes du texte de la PERSONNE sont retirées : `deposerMessage` (8 000), l'orchestrateur
écrit O1 (`ecrit.ts`, `agenda.ts` : 8 000), la voix (`oral.ts` 8 000, route de délégation 4 000 / 2 000, client temps réel
4 000 / 2 000, transcription de fin de session 7 900), le résumé roulant (1 500 par échange — la réponse de l'assistant reste
abrégée). Jusqu'à 200 000 caractères (≈ 57 000 jetons), le texte part ENTIER au modèle ; au-delà, il devient une pièce
`.txt` déposée en entier dans le Drive de la personne (« Assistant IA — textes longs », quota vérifié ; refus de quota : le
texte reste entier dans le message), lue par la lecture de documents, et le message le dit (`domaine/fil/texte-long.ts`,
`infra/fil/texte-long.ts`). Le **plafond par tour** (150 000) reste, mais compte le message de la personne UNE fois et non à
chaque étape de la boucle (`Budget.franchiseParAppel`) : un long texte légitime ne le déclenche plus ; une boucle d'outils,
si. Tests : `infra/fil/texte-long.test.ts` (60 000 caractères arrivent entiers dans la requête du modèle ; 600 000
deviennent une pièce de la bonne taille ; la boucle reste arrêtée). La lecture par parties d'un long document (`lire_document`)
passe de 14 à 45 parties (≈ 1 080 000 caractères) et a son propre budget, hors du plafond par tour (elle est bornée par
ses parties) : au banc, 600 000 caractères collés ont été lus jusqu'au bout. Playwright (serveur réel, mode app) :
60 000 caractères arrivés entiers sur iPhone 13 et au bureau.

**Mémoire « légèrement plus ».** Le filtre déterministe s'ouvre aux avis sur le travail (« je pense », « à mon avis »,
« je suis plutôt d'avis »), aux priorités, échéances et rendez-vous datés, aux lieux de l'entreprise (« notre usine »), aux
personnes citées et au vocabulaire (« quand je dis… ») ; la consigne de l'extracteur les nomme et dit « dans le doute sur un
fait qui l'aidera dans les semaines à venir, retiens-le » — le bavardage et les questions restent exclus, la garde des
valeurs interdites est inchangée. Mesuré au vrai modèle sur le MÊME jeu de 30 messages (`scripts/bench/m1-retention.ts`,
`preuves/m1/retention-avant.json` / `retention-apres.json`) :

| | Avant | Après |
|---|---|---|
| Messages porteurs d'un fait durable retenus (sur 15) | 7 | 13 |
| Faux positifs — bavardage, questions (sur 10) | 0 | 0 |
| Valeurs interdites retenues (sur 5) | 0 | 0 (une proposée par le modèle, refusée par la garde) |
| Appels de l'extracteur (sur 30) | 10 | 16 |
| Coût du jeu | 0,0013 $ | 0,0023 $ |

Le budget en jetons tient : la consolidation (§ 4) reste la borne.
