# 0058 — Chantiers autonomes : 24 h d'attente, rouge corrigé seul, consignes de la Direction (02/11/2026)

**Décision de la Direction (02/11/2026, verbatim)** : « au bout de 6 heures sans commit, l'étape échoue, alors que non
(…) vu que l'ERP est très gros, des fois ça prend énormément de temps (…) 7, 8, 9, 10, 12, 14 heures, donc tu mets
plutôt 24 heures. Il doit être autonome sur ça, réessayer etc. si c'est rouge, et me prévenir au bout de la 3, et si je
lui donne des consignes il les suit. »

Elle complète [0042](0042-chantiers-socle.md) (le socle) et [0043](0043-connecteurs-chantiers.md) (les connecteurs).

> Code : réglages `lib/missions/chantiers/regles.ts` (`attenteCommitHeures` 24, `relanceSansCommitHeures` 4,
> `correctionsMax` 8, `alerteApresEchecs` 3, `lancementsMax` 4 (seules les sessions neuves comptent) ; `deciderAntiBoucle`, `MOTIF_CONSIGNES_CHANTIER`) ;
> étapes `etapes.ts` (`commitNeuf`, `faireLePoint`, `devCorriger`) ; pause et alerte `conduite.ts` (`prevenir`,
> `demanderConsignes`) ; réservations `reservations.ts` (`STATUTS_VIVANTS`, `reservationTenue`) ; consigne
> `service.ts` (`donnerConsigneChantier`) et outil `outils.ts` (`consigne_chantier`, Assistant IA et Adam) ; dossier
> `dossier.ts` (`consignes`, `attenteConsignes`) ; console `modules/assistant-ia/ecrans/reglages-chantiers.tsx`.
> Bancs (moteur réel, ports simulés) : `chantiers.test.ts` — 20 h sans commit, session morte, rouge autonome, même
> panne après Sol, consigne ; `regles.test.ts` — l'anti-boucle.

## 1. Attendre longtemps, sans abandonner
- Délai sans commit : **24 h par défaut**, réglable (Administration › IA › Chantiers, 6 à 72 h).
- Toutes les **4 h** sans commit (réglable) : **« où en es-tu ? »** à la MÊME session (relais CLI, sinon fil de la PR).
  Jamais une session neuve pour une question : elle doublerait une session qui travaille encore sur la même branche.
- Une session **morte** (le relais répond « archivée » / « introuvable » — messages documentés par Anthropic) est
  **relancée** au point suivant, dans le budget (« reprends la branche là où elle en est »). Une session de routine ne se
  lit pas : sans signe de mort, Adam attend (c'est dit au journal), il n'en ouvre pas une seconde.
- À 24 h : **pas d'échec sec** — pause « attend tes consignes » (`ATTEND_CONSIGNES`), notification et carte de la
  conversation, **branche et périmètre gardés**.
- Tout ce qui supposait « 6 h » suit : les réservations sont prolongées à chaque passage, y compris EN PAUSE, et une
  réservation **échue d'un chantier vivant ne se reprend plus** (seule celle d'un chantier fini) — vérifié par un banc
  qui fait échouer cette garde quand on la retire. Les ordres du relais ont leur propre délai (20 min par commande,
  inchangé : une commande `claude` rend la main en minutes, c'est la session qui travaille des heures).

## 2. Rouge : autonome, borné, prévenu
- La boucle de correction continue **seule** (auto-fix natif d'abord, puis relances), dans les plafonds de budget
  (dollars par chantier et par jour, lancements, déploiements — le plus strict du plan et de la console).
- Même panne deux fois → **Sol** une fois, pour changer d'approche.
- Au **3ᵉ rouge** (réglable) : la Direction est **prévenue** — ce qui casse, ce qui a été essayé, ce qui va l'être —
  **sans arrêt**.
- Au **plafond de corrections** (défaut 8, réglable 3 à 30), ou si la même panne revient après Sol : pause « attend tes
  consignes » ; l'incident entre en mémoire technique. Le blocage définitif d'avant (3ᵉ occurrence → échec) disparaît.

## 3. Les consignes de la Direction
Outil `consigne_chantier` (Super Admin, Assistant IA et Adam ; écrit ou oral) : « dis-lui de … », « change d'approche,
fais … », « attends encore ».
- Transmise à la **MÊME session** (relais : message, contexte gardé), sinon dans le **fil de la PR** (`@claude`), sinon
  à une **session neuve qui reçoit l'historique** (consignes précédentes, où en était le chantier, dernier blocage).
- **Journalisée** au chantier (`CHANTIER_CONSIGNE`), gardée au dossier, citée au rapport.
- **Nouvelle approche** : tours de correction, signatures et analyse de Sol repartent de zéro ; l'étape attend le commit
  que la consigne produit (la consigne EST la relance).
- Un chantier en pause « attend tes consignes » **reprend** ; ses étapes en attente repartent tout de suite.
- « Durable » (« toujours », « désormais ») : gardée aussi dans la **mémoire technique** du dépôt (`decision`).
