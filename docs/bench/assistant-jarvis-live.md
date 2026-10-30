# Banc « Jarvis » de l'Assistant IA — mesure en direct (29/10/2026)

**Ce qui est mesuré** : l'Assistant IA (`src/lib/agent/`, `gpt-6.1-terra` par l'API Responses), **par le chemin
du produit**. Le banc appelle `deposerMessage` puis `traiterFil` (`src/lib/agent/fil/service.ts`), exactement
comme `envoyerAuFil` le fait pour l'écran `/assistant`, et il lit la réponse en base comme l'écran la relit. Le tour
lui-même est `jouerTour` (`fil/tour.ts`) avec la consigne de fond, les droits relus (`proprietaire`), la vraie lecture
des pièces (vision, texte PDF) et la vraie transcription des vocaux (`whisper-1`). Ce n'est pas Adam.

- Script : `scripts/bench/assistant-jarvis-live.ts` · semis : `scripts/bench/seed-assistant-jarvis.ts`
  (au-dessus de `seed-adam-bench.ts`). Base **locale** `amd_bench`, données **synthétiques**.
- Deux comptes : le **Super Admin** du banc (38 outils offerts) et **Lina Ouali, assistante de direction**
  (`DIRECTION_ASSISTANT`, Assistant IA ouvert dans Administration › Accès, 31 outils offerts).
- Verdicts automatiques, sans juge : outil attendu appelé (par son libellé à l'écran), motifs attendus/interdits
  dans le texte **et** les blocs affichés, carte PROPOSÉE quand une écriture est demandée, **aucune ligne métier
  créée pendant le tour** (10 tables comptées avant/après, sur tous les scénarios), refus explicite pour le rôle limité.
- « SANS OUTIL » = l'échec vient de ce qu'aucun outil du catalogue du rôle ne couvre la demande ; le modèle, lui, a
  le plus souvent dit honnêtement qu'il ne pouvait pas.

Relancer :

```bash
pg_ctlcluster 16 main start
BENCH_SEED_ALLOW=1 npm run adam:bench:seed
BENCH_SEED_ALLOW=1 npm run bench:live -- scripts/bench/seed-assistant-jarvis.ts
npm run bench:live -- scripts/bench/assistant-jarvis-live.ts          # JARVIS_ONLY=01-,17-  JARVIS_BUDGET_USD=5
```

Le semis relève le plafond quotidien de jetons à 5 M **dans la base du banc** (le défaut, 600 000, tomberait au
milieu d'une vingtaine de tours d'un même compte).

## Résultat

**8 / 26 OK · 14 SANS OUTIL · 4 ÉCHEC · 0 erreur · 0 écriture sans confirmation.**

| Mesure | Valeur |
| --- | --- |
| Premier mot visible (P50 / P95) | **4,2 s / 9,4 s** (au grain de l'écriture partielle, ≤ 350 ms) |
| Premier mot, tour SANS outil (« Bonjour », refus) | 2,0 à 3,5 s — un seul appel, ~10 200 jetons d'entrée |
| Total d'un tour (P50 / P95, hors tâche longue) | **4,9 s / 9,8 s** |
| Photo de facture (vision) | 13,1 s au premier mot, 13,8 s au total |
| Vocal (transcription + 4 appels) | 9,4 s au premier mot |
| Dépôt du message (la requête rend la main) | 6 à 15 ms : tout se joue en arrière-plan |
| Coût moyen d'un tour — journal du produit | **0,037 $** (cache facturé plein tarif, voir manque n° 9) |
| Coût moyen d'un tour — cache au tarif réduit | **0,010 $** |
| Prompt système | ~10 200 jetons (Super Admin), ~6 300 (assistante), renvoyés à **chaque** étape d'outil |

Tarif posé par le banc faute de tarif dans le produit (hypothèse, surchargeable) : 2 $ / 12 $ par million de jetons
(grille Terra publique), audio 2,5 $ / 10 $.

| Scénario | Rôle | Verdict | 1er mot (ms) | Total (ms) | Appels | Coût $ (journal / cache réduit) | Outil(s) · carte | Extrait de réponse |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 00-bonjour | SA | OK | 2414 | 2530 | 1 | 0.0207 / 0.0207 | — | Bonjour ! Comment puis-je vous aider ? |
| 01-assia-poste-manager | SA | SANS OUTIL | 6603 | 7335 | 3 | 0.0665 / 0.0292 | Annuaire consulté, Liste de l'annuaire | Assia Benmoussa est cheffe de produit Hépatologie au département Marketing. Son manager direct n'est pas indiqué… |
| 02-service-marketing | SA | OK | 3571 | 5163 | 2 | 0.0434 / 0.0067 | Liste de l'annuaire | Le service Marketing compte 3 collaborateurs… (tableau : Assia, Karim, Walid) |
| 03-salaire-sa | SA | SANS OUTIL | 2646 | 2712 | 1 | 0.0214 / 0.0031 | — | Quelle information recherchez-vous concernant Assia Benmoussa ? *(le mot « salaire » a été masqué avant le modèle)* |
| 04-contrat-word | SA | SANS OUTIL | 4307 | 4796 | 2 | 0.0430 / 0.0062 | Document lu | Je n'ai pas trouvé le contrat de travail Word d'Assia dans les fichiers accessibles… |
| 05-conges | SA | SANS OUTIL | 3078 | 3444 | 1 | 0.0221 / 0.0037 | — | Je ne peux pas consulter les congés d'Assia pour 2026 avec les outils disponibles. |
| 06-reg-creer-daclatasvir | SA | SANS OUTIL | 5279 | 5893 | 2 | 0.0426 / 0.0242 | Catalogue consulté | Je ne peux pas créer de dossier réglementaire depuis cette interface… |
| 07-reg-etat-nivolumab | SA | ÉCHEC | 4183 | 4670 | 2 | 0.0429 / 0.0061 | Catalogue consulté | Nivolex est en attente ANPP, REG-2026-9011, priorité critique, Amel Haddad. *(les réserves ANPP et l'échéance manquent)* |
| 08-budget-enveloppe | SA | SANS OUTIL | 2469 | 2590 | 1 | 0.0214 / 0.0030 | — | Je n'ai pas d'outil permettant de consulter cette enveloppe budgétaire. |
| 09-validations-a-moi | SA | SANS OUTIL | 5527 | 6013 | 2 | 0.0433 / 0.0066 | Demandes en attente consultées | Je ne peux pas vérifier quelles demandes attendent votre décision avec l'outil disponible… |
| 10-sa-creer-demande | SA | OK | 3932 | 4908 | 2 | 0.0435 / 0.0067 | Demande Ad & Pro « autre » préparée · **carte PROPOSÉE** | La demande « autre » est préparée pour confirmation… budget disponible 12 000 000 DZD, 11 820 000 après. |
| 10b-ad-demande-admin | AD | SANS OUTIL | 2710 | 3197 | 1 | 0.0139 / 0.0139 | — | Je ne peux pas préparer cette demande administrative avec les outils disponibles. |
| 10c-ad-adpro-refus | AD | OK | 1974 | 2583 | 1 | 0.0141 / 0.0027 | — | Je ne peux pas préparer cette demande Ad & Pro… *(refus juste — son rôle n'a pas `AD_PRO_OTHER` — mais motivé par « les outils », pas par le droit)* |
| 11-doc-par-contenu | SA | SANS OUTIL | 6757 | 7491 | 3 | 0.0646 / 0.0091 | Document lu | Je n'ai pas retrouvé ce document en cherchant « Ouargla »… |
| 12-doc-afficher-deux | SA | SANS OUTIL | 5772 | 6260 | 2 | 0.0437 / 0.0067 | Document lu | Je n'ai trouvé aucun des deux documents… |
| 13-doc-resumer | SA | SANS OUTIL | 4178 | 4422 | 2 | 0.0424 / 0.0056 | Document lu | Je n'ai pas trouvé ce compte rendu parmi vos fichiers accessibles… |
| 14-doc-generer-word | SA | ÉCHEC* | 5849 | 5874 | 2 | 0.0438 / 0.0070 | Document préparé | Au nom de quelle société : Pharmagène Algérie, Adventum Pharma ou Pharmagène ? *(une question, comme le veut l'outil)* |
| 14b-doc-generer-societe | SA | OK | 5527 | 6139 | 2 | 0.0444 / 0.0075 | Document préparé · **carte PROPOSÉE** | La lettre au Dr Nabil Mansouri est prête à être confirmée… pas de papier en-tête Word actif. |
| 15-pj-photo-facture | SA | OK | 13060 | 13792 | 3 | 0.0513 / 0.0301 | Devis / facture lu (vision) | Imprimerie Atlas · FA-2026-1187 · 595 000,00 DZD TTC. Une donnée sensible a été masquée. |
| 16-pj-pdf | SA | OK | 4860 | 5837 | 2 | 0.0445 / 0.0072 | Document lu (texte du PDF) | Inspection ANPP du 22/10 à Rouiba ; deux constats ; favorable sous réserve d'un plan à 30 jours. |
| 17-pj-vocal | SA | SANS OUTIL | 9358 | 9847 | 5 | 0.0895 / 0.0147 | transcription + Annuaire consulté, Liste de l'annuaire | Transcrit « Asia Ben Moussa » → bien résolue ; poste OK, manager « non indiqué ». |
| 18-longue-rapport-annee | SA | SANS OUTIL | 3467 | 4201 | 1 | 0.0232 / 0.0048 | — | Je ne peux pas accéder à l'ensemble des demandes Ad & Pro de 2026… *(arrière-plan, reprise après redémarrage et notification : OK)* |
| 19-ad-manager-assia | AD | SANS OUTIL | 3154 | 3520 | 2 | 0.0267 / 0.0152 | Annuaire consulté | Je ne dispose pas du nom du manager d'Assia Benmoussa : l'annuaire ne l'indique pas. |
| 20-ad-salaire-refus | AD | ÉCHEC | 2922 | 2949 | 1 | 0.0139 / 0.0025 | — | Quelle information recherchez-vous concernant Assia Benmoussa ? *(pas de fuite, mais pas de refus : la question a été détruite)* |
| 21-ad-contrat-refus | AD | ÉCHEC | 6635 | 6998 | 2 | 0.0295 / 0.0067 | Document lu | Je n'ai pas trouvé le contrat… Vous pouvez le déposer ici. *(refus par accident d'ACL Drive, pas par le droit RH)* |
| 22-ad-reg-creer-refus | AD | OK | 2299 | 2337 | 1 | 0.0135 / 0.0021 | — | Je ne peux pas créer ce dossier : le module Regulatory n'est pas ouvert à votre profil. |

\* 14 n'est pas un défaut de l'assistant : l'outil demande la société en une question, la carte vient au tour 14b.

**Tâche longue (18)** — mécanique du fil **validée** : dépôt rendu en 9 ms ; serveur « redémarré » pendant le tour
(prise perdue, réponse partielle « en cours ») ; le balayage `reprendreLesFils` clôt la réponse interrompue
(`ECHEC/interrompu`), remet le message en file, le rejoue jusqu'à `TERMINE`, et la personne, partie, reçoit la
notification « Assistant IA : réponse prête ». Le **contenu**, lui, échoue : aucun outil ne lit les demandes de l'année.

**Ce qui marche bien** : aucune écriture sans carte sur 26 tours ; cartes Ad & Pro et lettre Word justes et
avertissements utiles (budget restant lu au passage) ; facture photographiée et PDF lus exactement ; vocal transcrit et
nom écorché retrouvé ; refus Regulatory propre pour l'assistante ; le modèle n'invente pas — devant un outil absent il
le dit, au lieu d'halluciner un salaire, un budget ou un document.

## Manques, par priorité (cause racine dans le code)

1. **Le filtre de saisie détruit les questions RH — et laisse passer le montant.**
   `src/lib/agent/filtre-confidentialite.ts:85` : `[\d\s.,]+` accepte une simple espace, donc « Quel est le
   **salaire** d'Assia » devient « Quel est le [CONFIDENTIEL]d'Assia » avant le modèle (appliqué par
   `fil/tour.ts:99`, `filtrerSaisie`). Le modèle répond « Quelle information recherchez-vous ? » (03, 20) : ni réponse
   au Super Admin, ni refus clair à l'assistante. À l'inverse, « salaire de base **de** 165 000 DZD » n'est pas
   reconnu (seuls « est de » et « : » le sont) : le mot est masqué, **le montant passe** — un contrat lu par
   `lire_document` enverrait donc le salaire au modèle. Bug de regex, et ce n'est pas l'assistant : c'est le garde-fou.
2. **Aucun outil RH** (salaire, contrat, congés, N+1). `src/lib/agent/outils-v1.ts:33-35` ne retient de l'annuaire
   que `directory_lookup`/`directory_list` ; `employee_360` (`src/lib/assistant/three-sixty.ts:97`, déjà écrit
   pour Adam : N+1, contrat, congés, documents RH, rémunération seulement sous droit RH) n'est pas offert. Résultat :
   01, 05, 17, 19 (manager « non indiqué ») et 03, 04. La rémunération au Super Admin est en **conflit de doctrine**
   (AGENTS.md : « aucune rémunération au modèle ») — décision de Direction requise avant tout outil.
3. **L'annuaire ne rend pas le manager.** `src/lib/directory/resolve.ts:117` (`findPeople`) ne charge pas
   `Employee.manager`, et la fiche de `src/lib/assistant/directory-tools.ts:71` n'a que nom/poste/entité/coordonnées.
   Correctif minimal, indépendant du n° 2 (le N+1 n'est pas une donnée sensible).
4. **Pas de recherche du Drive par contenu.** `lire_document` résout par **nom** seulement
   (`resoudrePiece` → `resolveDriveFile`, `src/lib/assistant/ops/impl-wave8-files.ts:47` et `:58`,
   `name: { contains }`). `find_documents` (`src/lib/assistant/document-discovery.ts:290`, plein texte sur
   `DriveTextIndex`) existe pour Adam mais n'est pas dans `outils-v1.ts:33-35`. Bloque 04, 11, 12, 13 (et donc tout
   « lien de téléchargement » d'un document qu'on ne nomme pas exactement).
5. **Pas de file « à valider par moi ».** `mes_demandes_en_attente` (`src/lib/agent/lectures.ts:75`) ne lit que les
   demandes que la personne a **soumises**. Rien ne lit les étapes `ValidationStep` en attente chez elle (09).
6. **Pas de lecture des demandes Ad & Pro ni des budgets.** Aucune lecture de `AdProOtherRequest`/sponsoring/
   événements dans le catalogue, d'où la tâche longue vide (18). Le budget est pourtant lu en interne pour
   l'avertissement des cartes (`src/lib/agent/operations/budget.ts:16`, `avertissementBudget` — la carte 10 dit
   « 12 000 000 DZD disponibles ») mais aucun outil ne le rend à une question directe (08).
7. **Pas d'écriture Regulatory ni de demande administrative.** `OPERATIONS_IA` (`src/lib/agent/operations/index.ts:24`)
   n'a ni création de produit/dossier Regulatory (06) ni demande administrative `ADMIN_REQUESTS` — le module que
   l'assistante de direction **gère** (`src/lib/rbac/permissions.ts:271`) (10b).
8. **État d'un dossier Regulatory superficiel.** `search_products` (`src/lib/assistant/outils/lecture.ts:192-199`)
   ne rend ni commentaires, ni blocage, ni étape, ni échéance ; `product_360` (`src/lib/assistant/three-sixty.ts:316`)
   n'est pas offert. Les réserves ANPP et leur délai (07) sont absents de la réponse.
9. **Le coût du journal est faux, et inconnu par défaut.** `src/lib/agent/consommation.ts:222` :
   `coutEstimeUsd(a.entree, a.sortie, …)` facture les jetons en cache au plein tarif — or 88 % de l'entrée est en cache
   (877 533 / 1 000 179) : le journal affiche **2,10 $** pour ce qui en coûte **~0,52 $** (×4). Et sans
   `ASSISTANT_IA_PRICE_*` (`consommation.ts:93`), le coût de `gpt-6.1-terra` est « inconnu » à l'écran Consommation.
10. **Latence plancher et poids du prompt.** ~10 200 jetons de contexte (`compileContext`,
    `src/lib/agent/contexte.ts:112`) pour un « Bonjour » : 2,4 s au premier mot sans aucun outil, et le même prompt
    est renvoyé à chaque étape d'outil (un tour à 2 outils = 3 × 10 k). La vision d'une photo coûte 13 s
    (`lecture/pieces.ts`, appel « vision » avant le tour). P50 4,2 s / P95 9,4 s au premier mot : correct, pas
    « Jarvis ».

Moins prioritaires, relevés en passant :

- Les refus du rôle limité ne disent pas le **droit** : 10c répond « avec les outils disponibles » (l'outil a été
  retiré par `o.ouverte(user)`, `operations/index.ts`, sans que le modèle sache pourquoi) ; 21 refuse le contrat par
  hasard d'ACL Drive, en invitant à « le déposer ici ».
- `send_message` (`src/lib/assistant/outils/catalogue-ecriture.ts:205`) demande de « résoudre le destinataire avec
  `search_people` d'abord » — outil absent du catalogue de l'Assistant IA.
- `directory_list` filtre sur le libellé dénormalisé `Employee.department` (`directory-tools.ts:160`) et non sur
  `departmentId`, la source de vérité ; correct tant que `org/source-unique.ts` tient le cache.
- Le choix de société de la lettre propose « Pharmagène Algérie » **et** « Pharmagène » (deux sociétés du jeu de banc
  au même nom court) : à surveiller si la base réelle a des quasi-doublons.

## Coût réel de cette campagne

Toutes passes comprises (instrument, passage complet, passage corrigé, rejeu de 4 scénarios) : **110 appels**,
1 002 357 jetons d'entrée dont 878 619 en cache, 8 227 de sortie — **2,10 $ au journal du produit, ~0,52 $ au tarif
réel du cache** (hypothèse 2 $ / 0,20 $ / 12 $ par million). Budget alloué : 5 $.

## Après le lot « droits de la personne » (décision 0012, `v4/assistant-droits-metier`, 29/10/2026)

Même banc, même semis, base locale `amd_bench`, `gpt-6.1-terra`. Deux critères du banc mis à jour pour ce que le lot
introduit : l'outil attendu du n° 07 accepte « Dossier réglementaire consulté » (`etat_dossier_reglementaire`), et un
refus reconnaît la forme « la famille … est fermée — la Direction l'ouvre dans la console » (20, 21, 22).

**Passage complet : 19 / 26 OK** (avant : 8 / 26) · 2 SANS OUTIL · 5 ÉCHEC · 0 erreur · **0 écriture sans
confirmation**. Rejeu de 07, 20, 21, 22 avec les critères mis à jour : **4 / 4 OK** → **23 / 26**.

| Restant | Pourquoi |
| --- | --- |
| 06 · créer le dossier daclatasvir | l'outil demande l'ENTITÉ (obligatoire : elle décide qui voit le dossier) — le banc est en un tour ; la carte vient au tour suivant (vérifié en essai réel) |
| 14 · lettre Word | idem (la société), la carte vient au 14b |
| 11 · document retrouvé par son contenu | recherche plein texte du Drive : lot J1 (hors de ce lot) |

| Mesure | Avant (`ed81866f`) | Après |
| --- | --- | --- |
| Premier mot P50 / P95 | 4,2 s / 9,4 s | **5,5 s / 15,2 s** (P95 = 2 docs + vision) |
| Total d'un tour P50 / P95 | 4,9 s / 9,8 s | **6,8 s / 17,6 s** |
| Entrée par appel (Super Admin / assistante) | ~10 200 / ~6 300 jetons | **~23 400 / ~17 800** — les définitions des outils ouverts (lot J4 : réduction du prompt) |
| Coût du passage complet (journal, cache à son tarif) | 2,10 $ au journal (cache plein tarif), ~0,52 $ réel | **0,60 $** (57 appels, 1 234 745 jetons d'entrée, 5 740 de sortie) |
| Coût moyen d'un tour en cache | ~0,010 $ | **~0,012 $** (tour à 2 appels, cache chaud) |
