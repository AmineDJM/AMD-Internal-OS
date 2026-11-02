# Module `assistant-ia` — l'Assistant IA (« Adventum Brain »), ouvert à chacun selon ses droits

Le second produit d'IA du dépôt, à côté d'Adam (le Chief of Staff du Super Admin). Moteur Mastra + `gpt-6.1-terra`,
page `/assistant`, accès par le module RBAC `ASSISTANT_IA` et la console `/admin/ai/acces`. Décisions :
[`docs/assistant/decisions/`](../../../docs/assistant/decisions/) (0001 → 0027, 0029 → 0038, 0040, 0044, 0045 ; 0013 : la séparation d'Adam et le socle IA ;
0017 : l'Atelier ; 0018 : vitesse et mémoire — outils à la demande, consigne stable, résumé roulant, assembleur, modèle par rôle ; 0020 : le registre des
capacités ; 0022 : la qualité continue ; 0023 : délégation des travaux ; 0024 : la proactivité ; 0025 : terrain et voix ; 0026 : « Mes notes » ; 0027 : Adventum IA, conversations et dossiers ; 0029 : simulation, journal des effets, annulation ; 0030 : formulaires de carte, dépôt de dossier, gros volumes ; 0031 : analyse de données, chiffres exacts, Excel, graphiques ; 0032 : images, vidéos et vidéos de données générées ; 0033 : sous-missions, tableau de bord en temps réel, dépôt d'office ; 0034 : valeurs sensibles en clair pour qui a le droit, `store: false` ; 0035 : la consommation exacte en jetons et en dollars ; 0036 : pièces reçues par WhatsApp et par mail ; 0037 : exports de l'ERP, envoi d'un fichier, gestes d'écran ; 0038 : la voix orale, une carte confirmée à l'oral ; 0039 : la voix entièrement orale — attente vivante, réponses pour l'oreille, tout par la voix ; 0046 : l'orchestrateur de conversation — parler pendant qu'un travail tourne, à l'oral et à l'écrit ; 0040 : communications réversibles et fenêtre d'annulation ; 0042-0043 : chantiers de développement (Claude Code, GitHub, Render) ; 0044 : actions métier réversibles, rétablir).

| Porte / dossier | Rôle |
|---|---|
| `api.ts` | **Porte serveur** : le fil (`deposerMessage`, `traiterFil`, `lireFil`, `reprendreLesFils`, `jouerTour`), vocaux, mémoire, routines, opérations, accès, consommation |
| `api-banc.ts` | porte des **bancs et de l'E2E** (`scripts/e2e/`) : le faux modèle et son branchement — jamais importée par la production |
| `partage.ts` | **Porte pure** : familles d'accès, plafonds, filtre de confidentialité, règles de lecture et de dépôt, MRZ |
| `actions.ts` | clé `assistant-ia-actions` : mémoire, routines, fil, et `confirmerIntentionAssistantIA` (l'exécution d'une carte) |
| `actions-consommation.ts` | clé `assistant-ia-consommation-actions` : réglages de consommation et d'accès (Super Admin) ; `lireConsommationIa` (K8 : ma consommation, ou toute l'entreprise pour le Super Admin) |
| `actions-conversations.ts` | clé `assistant-ia-conversations-actions` (décision 0027) : conversations (lister, chercher, créer — privée ou non —, renommer, épingler, archiver, supprimer, ranger), dossiers (consignes, documents), appareils (déconnexion à distance) |
| `actions-qualite.ts` | clé `assistant-ia-qualite-actions` (J5 + J14, décision 0022) : calendrier du banc programmé, passage maintenant, banc A/B, modèle d'un rôle (sur banc vert seulement) |
| `actions-atelier.ts` | clé `assistant-ia-atelier-actions` (J3, décision 0017) : l'Atelier — ouvrir, revoir, enregistrer (nouvelle version), comparer, convertir |
| `actions-travaux.ts` | clé `assistant-ia-travaux-actions` (J8, décision 0023) : demandes reçues (lister, répondre, décliner), priorité d'un travail, travaux de mon équipe (si la console l'autorise, audités) |
| `actions-notes.ts` | clé `assistant-ia-notes-actions` (décision 0026) : « Mes notes » — pages, enregistrement automatique, historique, corbeille ; accepter / refuser / annuler ce que l'IA propose |
| `actions-proactivite.ts` | clé `assistant-ia-proactivite-actions` (J12, décision 0024) : ma veille (veilleurs, réglages, retours), mandats, gestes sous mandat (coque), console |
| `domaine/` | règles pures (accès, plafonds, confidentialité, lecture, dépôt, mémoire affichée, MRZ, UI générative) |
| `infra/` | le moteur : fil, tour, outils, opérations, lecture des pièces, voix, mémoire, routines, consommation, modèle ; `testing/` (faux modèle, tests seulement) |
| `ecrans/` | l'interface de `/assistant` (ex-`components/assistant-beta/`) ; `use-fil`, `use-pieces`, `conversations/` partagés avec `ecrans/app/` — l'app **Adventum IA** (`/ia`, thème `app/theme.css`) |

- **Tables** : `AssistantIaFil` (une CONVERSATION — plusieurs par personne depuis la décision 0027), `AssistantIaDossier`, `AssistantIaTour`, `AssistantMemoryItem`, `AssistantRoutine`, `AssistantRoutineRun`,
  `AssistantRoleConfig`, `AssistantIaAcces`, `AssistantIaReglage`, `AssistantIaPlafondAtteint` ; J12 : `AssistantVeille`,
  `AssistantVeilleur`, `AssistantSignal`, `AssistantMandat`, `AssistantMandatGeste` ; J11 : `AssistantIaDepotDossier` ; K6 : `AssistantIaAttentePieces`, `AssistantIaReception` ; « Mes notes » : `AssistantIaNote{Page,Version,Corbeille,Proposition}`
  (privées : aucune porte pour un autre compte). Les intentions
  (`AssistantActionIntent`) sont au socle IA (`src/platform/ia/intentions/`), partagées avec Adam.
- **Tâches de fond** : `assistant.routines`, `assistant.fils`, `assistant.veilleurs` (J12), `assistant.conversations-privees` (0027, purge à 30 jours) (`src/lib/scheduled.ts`).
- **Frontière** : le module n'importe pas Adam — plus aucune exception depuis J6 (`RESIDUS` vide dans
  `src/platform/ia/frontieres.test.ts`) ; ce que les deux partagent vit au socle `src/platform/ia/`.

## Consommation précise — jetons et dollars (lot K8, décision 0035)

- **Grille** datée par modèle et par type de jeton : `src/lib/models/tarifs.ts` (pure ; vue du socle
  `platform/ia/telemetry/tarifs.ts`). Coût en entiers, au micro-dollar ; hors grille → « tarif inconnu », jamais 0 $.
- **Journal** : `ModelCallLog`, une ligne par appel payé, ventilée (audio, image, cache, raisonnement, durée, pages,
  estimé, Batch, date de grille). Coût d'une ligne : `platform/ia/telemetry/cout-journal.ts` (budget de l'assistant,
  visuels, puits de la passerelle). `auNomDe`/`sousBudget` posent aussi l'imputation de la passerelle (`sousImputation`).
- **Écran** : `ecrans/consommation/tableau-consommation.tsx` — Réglages de l'app (« Consommation ») et Administration › IA ;
  données `infra/consommation-detail.ts` (périmètre : « moi » = la personne connectée, « entreprise » = Super Admin),
  vue pure `domaine/consommation-vue.ts`, rapprochement `infra/consommation-rapprochement.ts` (`OPENAI_ADMIN_KEY`),
  export `GET /api/assistant-ia/consommation/export?format=csv|xlsx`.
- Tests : `consommation-precise.test.ts` (RBAC, exhaustivité des chemins payants, rapprochement),
  `src/lib/models/tarifs.test.ts`.

## Pièces reçues par WhatsApp et par mail (lot K6, décision 0036)

- **Attente de pièces** — `domaine/canaux/attentes.ts` (pur : durée, canal, rattachable, section de consigne, clé de
  numéro, confidentialité, phrases) ; `infra/canaux/outil.ts` (`attendre_pieces`, écrit et voix) ; table `AssistantIaAttentePieces`.
  La consigne n'a une section « PIÈCES ATTENDUES » que si une attente est ouverte (`infra/canaux/section.ts`).
- **Réception** — `infra/canaux/reception.ts` (`recevoirPieces` : idempotence, personne par numéro ou adresse, gardes,
  Drive « Assistant IA — pièces reçues », tour dans la conversation, carte `preparer_depot_piece`, notification) ; journal
  `AssistantIaReception`. Entrées : `app/api/canaux/whatsapp` (socle `platform/ia/canaux/whatsapp.ts`), `app/api/mail/inbound`
  (`platform/ia/canaux/courrier.ts`, adresse `ASSISTANT_IA_MAIL`), `lib/google/gmail/ingest.ts` (le dirigeant, attente ouverte).
  Banc : `app/api/canaux/canaux.test.ts`.

## Valeurs sensibles et conservation chez OpenAI (lot K4, décision 0034)

- **Réglage de la console** (`/admin/ai/acces`, Super Admin, audité) : « Valeurs sensibles » = **en clair pour qui a le droit
  de les voir** (défaut, Direction 31/10/2026) | **masquées** (repères ⟦Sn⟧, décision 0012). `AssistantIaReglage.valeursSensibles`.
- **Les droits ne changent pas** : la sortie d'un outil est jetonnée, puis, en clair, chaque repère est jugé par le même
  juge que l'écran (`Revelateur.enClair`, journalisé) — valeur ou « [confidentiel] ». Consigne `CONSIGNE_EN_CLAIR`, règle 2
  `REGLE_CONFIDENTIALITE_EN_CLAIR`, voix `consignesVoix(enClair)` / `reponsePourVoix(contenu, enClair)` (prononcée).
- Restent masqués dans les deux modes : notification, résumé roulant, mémoire, titres, routines et travaux, question de la
  recherche web, pièces jointes (leur propre garde).
- **`store: false`** sur tous les appels Mastra du module (`optionsFournisseur`) ; la recherche web (passerelle, sans
  chaînage) l'a déjà. Banc : `valeurs-sensibles.test.ts`.
## L'orchestrateur de conversation — pendant qu'un travail tourne (lot O1, décision 0046)

- **Une machine à états pure, commune à l'oral et à l'écrit** — `platform/ia/conversation/orchestrateur.ts` : la personne
  parle / l'assistant parle / une question attend sa réponse / libre. Un résultat arrivé hors de « libre » est TENU (file
  d'annonces par travail) et dit au point de rupture, collé à l'accusé de la réponse (« Noté, PDF. Et justement… ») ;
  jamais par-dessus une question ; jamais deux annonces collées ; jamais « j'attends ».
- **L'agenda** (`domaine/conversation/agenda.ts`, sans modèle, SANS plafond — une chose à la fois tant que le travail
  tourne) : précisions (format, période, détail), approfondissements (ventilation, comparaison, vigilance), étape suivante
  (destinataire), partiels (sous-missions K3 finies), avancement réel dit une fois. Table `AssistantIaAgenda`.
- **Le classement** de chaque énoncé pendant un travail (`domaine/conversation/classement.ts`, `infra/orchestration/
  classement.ts`) : précision / autre demande (parallèle) / conversation — règles quand c'est évident, sinon classifieur
  `rapide` à sortie JSON stricte, journalisé (K8). **Impact** : MAJEURE réinjectée (ajoutée, ou UNE relance ciblée à la fin
  du travail) ; MINEURE appliquée au rendu sans relance (la voix le dit ainsi ; l'écrit reformule par le modèle rapide ; un
  fichier ou une carte d'envoi est produit d'après le résultat prêt). `appliquerPrecisions` (`infra/orchestration/agenda.ts`).
- **Oral** : le client GPT-Live (`platform/ia/voix/client-temps-reel.ts`) lit les tours de parole sur les fragments de
  transcription (GPT-Live n'expose ni détection de parole ni fin de réponse), suit plusieurs travaux ; le serveur
  (`infra/voix/oral.ts`) rend l'agenda au lancement, juge la réponse à la question (`question` de la délégation), lance une
  AUTRE demande en parallèle.
- **Écrit** (`infra/orchestration/ecrit.ts`) : `deposerEcrit` (réponse à la question / voie parallèle du fil pour une autre
  demande pendant un travail long / file habituelle), `orchestrationDuFil` lu par `/api/assistant-ia/fil` (question avec
  choix, réponses tenues, avancement, « version d'avant ») ; écran `ecrans/orchestration-fil.tsx`.
- Bancs : `orchestrateur.test.ts`, `agenda.test.ts`, `infra/orchestration/orchestration.test.ts` (bout en bout, vraie base),
  `e2e/orchestration-conversation.spec.ts`.

## La voix orale — une carte devient une conversation (lot K4, décision 0038)

- La voix **dit** les valeurs (mode « en clair ») ; une carte rendue par la délégation devient **orale** : résumé à dire,
  facultatifs proposés, récit, « Tu confirmes ? » (`domaine/terrain/voix-orale.ts`, `infra/voix/carte-orale.ts`).
- **Confirmation orale** jugée par le SERVEUR sur la transcription de la personne (`parole`) : « oui » explicite après la
  question, élément clé prononcé pour R3/R4, puis la garde du bouton (`infra/confirmation.ts` `confirmerCarte`) ; audit
  « confirmée à l'oral » avec la transcription. Corrections dites : `corriger_carte` → `corrigerCarteCapacite`.

## Images, vidéos et vidéos de données (lot K2, décision 0032)

- **Outils** (`infra/visuels/outils.ts`, conversation seulement, famille de console `VISUELS` fermée par défaut) :
  `generer_image`, `modifier_image` (pièce jointe ou Drive, droits relus), `generer_video` (arrière-plan),
  `video_de_donnees` (chiffres EXIGÉS dans les sorties d'outils du tour). Le résultat entre dans la réponse par un bloc
  `visuel` (`fil/tour.ts` → `visuels`), rendu par `platform/ia/ecrans/blocks/visuel.tsx` (plein écran, lecteur natif, carte
  « en cours » qui relit `app/api/assistant-ia/visuels/[id]`).
- **Moteur** (`infra/visuels/service.ts`) : portes avant toute dépense — interrupteur de la nature, interrupteur général,
  `filtrerConsigne` (`domaine/visuels/regles.ts`), plafond du mois (`consommation.ts:depenseVisuelsDuMois`) ; fichier au
  Drive (« Visuels de l'assistant », port `portsArtefact.documents.creerFichier`) ; table `AssistantIaVisuel` ; coût réel
  (`journaliserVisuel`). Fournisseurs : `infra/visuels/fournisseurs.ts` (gpt-image-2.5-sunburst ; gemini-3-pro-image en
  secours seulement ; `/videos` après `etatModeleVideo` — Sora arrêté le 24/09/2026).
- **Vidéo de données** : `domaine/visuels/video-donnees.ts` (pur : vérification, sous-titres calculés, SVG à l'instant t),
  `infra/visuels/rendu-donnees.ts` (sharp + ffmpeg, H.264 yuv420p faststart) ; tâche `assistant.visuels`
  (`traiterVisuelsEnFile` : rendu là où ffmpeg est, suivi des vidéos du modèle, échecs dits, avis à la fin).
- **Console** : `ecrans/reglages-visuels.tsx` (Administration › IA), action `enregistrerReglagesVisuels`
  (`actions-consommation.ts`). Tests : `domaine/visuels/visuels.test.ts`.

## Analyse de données (lot K1, décision 0031)

- **Outils** (`infra/analyse/outils.ts`, conversation seulement) : `lire_tableur` (Excel/CSV joint ou du Drive, typé : feuilles,
  en-têtes, types, formules → valeurs), `analyser_donnees` (le pipeline fermé du socle sur un JEU du tour), `calculer_code`
  (JS isolé, Python s'il est présent ; chaque nombre vient de la demande), `requete_sql` (vue globale seulement, refuse une
  colonne confidentielle même sous alias, audit). Moteur au SOCLE : `platform/ia/analyse/` (déménagé de `lib/sandbox/`).
- **Jeux du tour** (`domaine/analyse/jeux.ts`) : chaque lecture (déjà jetonnée) devient un jeu nommé ; le modèle nomme, il ne
  recopie jamais de lignes. **Colonnes confidentielles** masquées avant le calcul (`domaine/analyse/confidentialite.ts`).
- **Chiffres exacts** : le bloc `analyse` (socle `analyse/bloc.ts`, `workspace/analyse.ts`) est posé sous la réponse par
  `fil/tour.ts` ; le modèle cite l'aperçu déjà formaté ; un chiffre du message que rien ne prouve est dit (`domaine/analyse/chiffres.ts`).
  Intention chiffrée → outils d'analyse en tête de la présélection (`domaine/analyse/intention.ts`).
- **Écran** (socle `ecrans/blocks/analyse.tsx`) : tri, filtres, totaux, CSV / Excel d'un clic / « Enregistrer dans mon Drive »
  (route `app/api/assistant-ia/analyse/classeur`, `infra/analyse/classeur.ts`), graphiques exportables PNG / SVG / données,
  « Comment c'est calculé ». Le `chart` du modèle : onze formes, choix et garde (`domaine/ui/graphique.ts`).
- **Preuves** : `analyse.test.ts`, `platform/ia/analyse/bloc.test.ts` ; banc réel `scripts/bench/analyse-k1.ts`.

## Sous-missions, tableau de bord en temps réel, dépôt d'office (lot K3, décision 0033)

- **Sous-missions** — `infra/sous-missions.ts` : l'outil du tour (`outilSousMissionsPour`, par `outilTravailPour` de `infra/travaux.ts`) —
  une sous-mission de plus par appel, `remplace` / même titre = reformulation, `parent` ; démarrage d'office d'un plan sans geste
  (`travauxDOfficePour` : préférence `AssistantIaPreference` > console `AssistantIaAcces.travauxDOffice` > Super Admin) ; la
  synthèse dans la conversation (`conclureSousMissions` → `fil/service.ts deposerSynthese`, unique par tour, notifiée ;
  rattrapage `balayerSousMissions`, tâche `assistant.sous-missions`) ; `tableauDesMissions` (missions + conversation d'origine).
  Règles pures `domaine/sous-missions.ts` (clé de titre, réglage, synthèse, libellés, avancement).
- **Temps réel** — route SSE `app/api/assistant-ia/missions/flux` ; écrans `ecrans/missions/` : `use-missions.ts` (une connexion par
  onglet, repli en sondage 3 s), `tableau-missions.tsx` (plein écran sur téléphone, tiroir sur ordinateur), `carte-sous-missions.tsx`
  (la carte du fil, l'indicateur d'en-tête), `reglage-d-office.tsx`. Actions `actions-travaux.ts` : `lireMonTableauDeMissions`,
  `annulerMaMission`, `lireMaPreferenceDOffice`, `reglerMaPreferenceDOffice` ; console : `enregistrerTravauxDOffice`.
- **Recherche approfondie** (§ 7) — outil `recherche_approfondie` (`infra/sous-missions.ts`, plan pur `domaine/recherche-approfondie.ts`) :
  une `web_research` par angle en parallèle, puis un rapport complet sourcé (Word + PDF au Drive), affiché en entier dans la conversation.
- **Dépôt d'office** — `domaine/lecture/depot-dossier.ts` (`modeDuDepot` au-delà de 6 pièces, `libelleDepotDOffice`),
  `ecrans/depot-dossier.tsx`, `ecrans/use-pieces.ts`. Bancs : `infra/sous-missions.test.ts`, `scripts/bench/k3-missions-ux.ts`.

## Formulaires de carte et dépôt de dossier (lot J11, décision 0030)

- **La carte d'une capacité R1–R4 est un formulaire généré depuis le contrat** — `platform/ia/capacites/formulaire.ts` (pur :
  widget par type, proposition pré-remplie, `verifierFormulaire` = `zodDe` du registre), `ecrans/formulaire-carte.tsx`
  (champs, sélecteur de référence au clavier), `ecrans/action-confirmation-card.tsx` (« Proposé » / « Corrigé », signer) ;
  serveur : `infra/capacites.ts` — `carteDe`, `corrigerCarteCapacite` (la correction repasse par les portes de la
  proposition et réécrit la carte), `chercherReferenceDeCarte` (fiches visibles seulement) ; `actions.ts` —
  `confirmerIntentionAssistantIA(intentId, ressaisie, corrections)`, `chercherReferenceCarteAssistantIA`. Bancs :
  `formulaires.test.ts` (1 157 capacités, 0 écart), `formulaire-carte.test.ts`.
- **Dépôt de dossier** — règles pures `domaine/lecture/depot-dossier.ts` (mode, bornes réglables, racine, empreinte, reprise,
  état) ; serveur `infra/depot-dossier.ts` (lot, arborescence par port, reprise, état par la Bibliothèque), route
  `app/api/assistant-ia/depot-dossier` ; écran `ecrans/depot-dossier.tsx` (puce, envoi par le gestionnaire d'envois,
  `SuiviDepots`). Banc : `depot-dossier.test.ts`, `npm run bench:dossier` (300 fichiers).
- **Répondre sur le dossier** — `infra/lecture-dossier.ts` (`lire_dossier_depose`) et `domaine/ctd.ts` (classement CTD,
  pièces manquantes), sur les fiches de la Bibliothèque (`fichesDeDossier`), sans relire les fichiers.

## Vitesse et mémoire (lot J4, décision 0018)

- **Outils à la demande** — `domaine/selection-outils.ts` (règle pure : socle de 10, présélection plein texte de 6,
  `trouver_outil`), `infra/selection.ts` (fiches = outils offerts sous les droits ; `trouver_outil`). `repondre.ts` ne
  fait partir que les ACTIFS de chaque étape (`prepareStep` → `activeTools`). Corpus de référence : `infra/selection.test.ts`.
- **Consigne stable** — `infra/contexte.ts` : préfixe identique d'un tour à l'autre, règles par famille d'outils
  (`reglesPour`, `reglesAjoutees`), partie variable et heure à la fin ; clé de cache par personne.
- **Mémoire en 4 couches** — (a) carnet d'un travail (J2) ; (b) conversation : 4 échanges mot pour mot + **résumé
  roulant** (`domaine/fil/resume.ts`, `infra/fil/resume.ts`, colonnes `AssistantIaFil.resume*`) ; (c) mémoire
  personnelle ; (d) connaissance : `chercher_documents`, `ouvrir_documents`, `faits_confirmes` (socle,
  `platform/ia/lectures/connaissance.ts`). **Assembleur** : `domaine/assembleur.ts` (enveloppes fixes).
- **Le bon modèle** — `platform/ia/modeles-roles.ts` (rapide / standard / raisonnement, effort adaptatif) ;
  `infra/modele.ts` (`optionsFournisseur` : effort, clé de cache).

## La super mémoire (lot M1, décision 0045)

- **Capture automatique** — `infra/memoire-capture.ts` (`capturerApresTour`, appelée par `fil/service.ts` après la
  réponse et par `voix/temps-reel.ts` en fin de vocal) ; règle pure `domaine/memoire/capture.ts` : filtre déterministe
  (aucun appel sans fait durable), extracteur `rapide` en JSON strict sur le SEUL message de la personne, garde (ancres du
  message, rien de confidentiel ni d'autrui). Journal K8 : usage « memoire ». Privée et réglage coupé : rien.
- **Stockage et historique** — `infra/memoire.ts` : dédoublonnage, `remplaceId`/`remplaceLe` (un fait qui change remplace
  l'ancien), `annulerSouvenir` (l'ancien revient), `memoireAutoActive`/`reglerMemoireAuto` (`AssistantIaPreference`).
- **Rappel** — `domaine/memoire/rappel.ts` (profil 250 jetons + pertinents 600, BM25 sur racines + mots de la sorte, cosinus
  si la mémoire dépasse l'enveloppe), `rappelDuTour` dans `infra/contexte.ts` ; la voix : `memoirePourVoix`. Plongements :
  `infra/generer.ts` (`plongerTextes`, même garde que le texte).
- **Écrans** — `ecrans/memoires-retenues.tsx` (« Retenu : … — annuler · voir »), `ecrans/memoire-panel.tsx` (« Ce qu'il
  retient » : groupes, recherche, édition, origine, compteur, réglage, tout effacer) ; route `app/api/assistant-ia/fil`
  (`memoiresRetenues` dans leur état présent ; `enCours` tant que la capture tourne).
- **Jetons, consolidation, historique** (Direction 01/11) — compteur calibré (`rappel.ts`, 3,5 car./jeton), budget de
  stockage `AssistantIaReglage.memoireJetonsBudget` (8 000), consolidation rare et réversible au modèle rapide
  (`domaine/memoire/consolidation.ts`, `infra/memoire-consolidation.ts`, `consolideDans`), historique purgé à 12 mois
  (`purgerHistoriqueMemoire`) — tâche `assistant.memoire`. Plafond quotidien : 0 = sans (défaut).
- **Textes longs jamais coupés** (Direction 02/11) — `domaine/fil/texte-long.ts`, `infra/fil/texte-long.ts` (au-delà de
  200 000 caractères : pièce `.txt` lue) ; `Budget.franchiseParAppel` (le plafond par tour compte le message une fois).
- **Preuves** — `domaine/memoire/memoire.test.ts`, `infra/memoire-capture.test.ts`, `infra/memoire-consolidation.test.ts`, `infra/memoire.test.ts` ; audit sur
  serveur réel : `scripts/bench/m1-audit.ts` → `docs/assistant/preuves/m1/`.

## Le registre des capacités (lot J6, décision 0020)

- **Registre** (socle, pur) : `src/platform/ia/capacites/` — une fiche par action du contrat (`contrat.genere.json`), par outil
  du module et par commande de l'Atelier ; risque R0 → R4, famille, simulable, annulation, contenu tiers, porte d'écran.
  Cliché relu `classement.genere.json` (`npm run capacites:classement`).
- **Branché** : `infra/capacites.ts` — `registreDesCapacites` (les ports : refus générique, annulation, modules), `porteOuverte`,
  `outilsCapacites` (un outil par capacité offerte, `fichier__fonction`), `executerCapacite` (la confirmation) ;
  `domaine/capacites.ts` (charge `assistant_ia_capacite`, niveau de carte, ressaisie, anciens noms d'outils).
  `outilsV1(…, { capacites: true })` ne sert qu'à la CONVERSATION (`fil/tour.ts`) : ni les routines ni les travaux.
- **Lectures propres** (plus d'emprunt à Adam) : `infra/lectures-erp.ts` (tâches, demandes, aperçu, catalogue Regulatory,
  recherche fédérée, agenda, file des décisions), `operations/budget.ts` (`read_budget`), `lectures.ts` (`read_hr_overview`,
  `finance_totals`), `outils-v1.ts` (`read_workflow`) ; `operations/quotidien.ts` : `send_message` (opération propre).
- **Preuves** : `capacites.test.ts`, `infra/selection-capacites.test.ts` (300 demandes), `infra/banc-selection.test.ts` (banc 26).
- **Aucune régression** (0020 § 8) : `infra/equivalents-avant-j6.json` (écrit par `npm run capacites:inventaire`) — chaque geste
  qu'Adam prêtait avant J6 et son équivalent ; `equivalents-avant-j6.test.ts` le rejoue (appelable, porte ouverte par rôle).
  La fiche employé passe par `executerAction(…, "assistant-ia")` (`GESTES_DE_FICHE`, sans `userId`) ; `updateEmployee` est
  relue et rejouée à la confirmation (`FUSIONS`).

## Simulation, journal des effets, annulation (lot J7, décision 0029)

- **Socle** (`src/lib/effets/`, porte `@/platform/ia/hors-requete`) : contexte de geste étendu (mode réel / simulation),
  client Prisma du geste (`lib/prisma.ts`), capture des écritures (avant / après / champs), simulation dans une transaction
  annulée, ports de sortie neutralisés en simulation, journal des effets, annulation honnête.
- **Carte** (`infra/capacites.ts`, `domaine/simulation.ts`) : une capacité R1–R4 simulable montre le **diff réel** de sa
  simulation (`proposition.simulation`, `ecrans/action-confirmation-card.tsx` — bloc « Simulé — rien n'a été écrit ») ;
  non simulable, elle le dit. À la confirmation, la simulation est rejouée et son empreinte comparée : un écart, rien ne
  s'exécute et la carte se remontre (`payload.simulation` remplacé ; `fil/service.ts` le relit).
- **Journal** : toute carte confirmée (`actions.ts` → `executerOperationJournalisee`, `executerCapacite`), toute étape de
  travail (`infra/travaux.ts`, `ecrire(…, contexte)`) et tout geste sous mandat (`proactivite/mandats.ts`) va au journal
  des effets (`AssistantGesteJournal`, `AssistantEffet`) ; durée de garde à la console `/admin/ai/acces`.
- **Écran** « Ce que l'assistant a fait » : `/assistant/gestes` (`ecrans/gestes-assistant.tsx`, `actions-gestes.ts` :
  lister, aperçu, annuler un geste ou un lot — annulé / compensé / impossible / sans objet + pourquoi).
- **Preuves** : `lib/effets/{simulation,ports,annulation}.test.ts` (50 cas réels), `infra/capacites-simulation.test.ts`.

## Actions métier réversibles (lot K10c, décision 0044)

- Les réglages de ce module (`reglerMaReponseVocale`, `reglerMaConversationPrivee`, `reglerMaVeille`, `reglerMonVeilleur`,
  `reglerConsoleProactivite`, `reglerMaPreferenceDOffice`, `reglerPrioriteMonTravail`) enveloppent leur corps par
  `actionReversible` (`lib/effets/reversible.ts`) : au clic, ils entrent au journal des effets ; « Annuler » remet la valeur
  d'avant (rien d'écrasé si quelqu'un l'a changée depuis), « Rétablir » la nouvelle.
- « Ce que l'assistant a fait » et la barre « Annuler » (K10b) listent aussi ces gestes d'écran ; l'annulation d'une
  action métier y suit la politique tout-ou-rien (`lib/effets/politiques.ts`) ; une simulation n'annule rien (le plan).

## Travaux, suite (lot J8, décision 0023)

- **Persona** (`infra/travaux.ts`) : en plus de J2, `pieces` (`PIECES_TRAVAUX` : voir / accorder la lecture d'une
  pièce du Drive, à l'audit), `responsable` (N+1 de l'organigramme, pour les escalades), `deposerLivrable`
  (`infra/travaux-livrables.ts` : Word / Excel de la fabrique au Drive « Travaux », inscrit à la Bibliothèque ; PDF par
  l'Atelier).
- **Côté sollicité** (`infra/operations/delegation.ts`) : lecture `mes_demandes_recues` (contenu non fiable), carte
  `preparer_reponse_demande` — fiches MOTS_CLES de la sélection (pas le socle) ; exclue des gestes de travail.
- **Équipe** (`lib/missions/travaux/equipe.ts`, par la porte `service.ts`) : option console `managerVoitEquipe` (défaut non), résumé et étapes seulement,
  chaque consultation à l'audit.
- **Écrans** : `ecrans/demandes-recues.tsx`, `ecrans/travaux-equipe.tsx`, onglets du panneau « Travaux ».

## Adventum IA (décision 0027)

- **Conversations** — `domaine/conversations.ts` (groupes, titres, privée verrouillée), `infra/conversations/service.ts`
  (CRUD sous la personne, recherche titres + contenu, titre proposé par le modèle rapide, purge des privées),
  `infra/conversations/outil.ts` (`chercher_conversations` : la mémoire des conversations passées, jamais une privée).
- **Dossiers** — `domaine/dossiers.ts`, `infra/conversations/dossiers.ts` (consignes et documents, droits relus à chaque tour).
- **Écrans** — `ecrans/use-fil.ts`, `ecrans/use-pieces.ts`, `ecrans/conversations/` (une seule implémentation pour l'ERP et
  l'app) ; `ecrans/app/` (coque, saisie à trois voix, tiroir Notes/Travaux/Documents, réglages, hors ligne et
  notifications ; la voix en direct est `ecrans/voix-temps-reel.tsx` de J13, sur la conversation ouverte). Mode app : `src/platform/app-mode.ts`.

## Graphe de l'entreprise (lot J9, décision 0021)

- `explorer_relations`, `etat_a_une_date`, `d_ou_vient` — au socle (`platform/ia/lectures/graphe.ts`, module `graphe-entreprise`),
  branchés dans `infra/outils-v1.ts` : les familles FERMÉES de la console retirent leurs types du graphe (pas de refus de
  l'outil). Fiches de la sélection (`MOTS_CLES`), règle 12 de la consigne (`contexte.ts`) : chaque chiffre cité avec sa source.

## Proactivité sous mandat (lot J12, décision 0024)

- **Veilleurs** — `domaine/proactivite/veilleurs.ts` (12 règles pures, signature anti-répétition), lectures sous l'identité
  de la personne `infra/proactivite/sources.ts` (module d'écran + famille de console). Passage `infra/proactivite/veille.ts`
  (tâche `assistant.veilleurs`) : constater, résoudre, livrer ; point du matin (seul appel au modèle, texte de secours).
- **Budget d'interruptions** — `domaine/proactivite/budget.ts` : heures calmes d'Alger, vendredi-samedi, regroupement,
  ≤ 5 par jour (console), retours « utile / pas utile » qui ajustent le seuil et rendent un veilleur discret.
- **Mandats** — `domaine/proactivite/mandats.ts` (niveaux R1→R4, bornes, contrôle avant chaque geste) ;
  `infra/proactivite/mandats.ts` : gestes par `proposer` + `executerOperationIA`, **dans la requête de la personne**
  (`ecrans/executeur-mandats.tsx`, monté par la coque), reçu pris avant, audit.
- **Écrans** — `ecrans/veille-panel.tsx` (« Ce que mon assistant surveille »), `ecrans/suggestions-dossier.tsx`
  (`/validations/[id]`, `/sponsoring/[id]`), `ecrans/console-proactivite.tsx` (`/admin/ai/acces`).

## Qualité continue (lots J5 + J14, décision 0022)

- **Banc programmé** — `infra/qualite/banc.ts` (tâche `qualite.banc`, worker seul ; processus `scripts/bench/banc-programme.ts`
  contre la base d'essai déclarée `BANC_ESSAI_DATABASE_URL`, marqueur `BancBaseEssai`) ; règles pures `domaine/qualite/`
  (calendrier, régression +30 %, base d'essai, résultat). Tables `AssistantIaBancReglage`, `AssistantIaBancPassage`,
  `AssistantIaBancScenario`. Écran `/admin/ai/qualite`.
- **Traces rejouables** — `infra/qualite/traces.ts` (enregistrement du modèle et des outils, `AssistantIaTrace` gzip, 30 j),
  `infra/qualite/rejeu.ts`, `npm run assistant:rejouer`.
- **Provenance tierce** — `domaine/provenance-tierce.ts` (pur), `infra/provenance.ts` (sur chaque carte) ; corpus de 240
  pièges `infra/testing/corpus-pieges.ts`, preuves `infra/qualite/pieges-regles.test.ts`, `pieges.test.ts`.
- **A/B des modèles** — `infra/qualite/modeles.ts` (`AssistantIaModeleRole` au-dessus de l'environnement ; garde
  `domaine/qualite/ab-modele.ts` : banc vert pour ce candidat exact, < 14 jours).

## Terrain et voix (lot J13, décision 0025)

- **Terrain** — `domaine/terrain/` (compte rendu dicté, résolution dans l'annuaire, file hors ligne, photos, règles de la
  voix — pur), `infra/terrain/captation.ts` (vocal / photo → cartes, idempotent), `infra/operations/terrain.ts`
  (`terrain_*`), `ecrans/terrain/` (écran mobile, file IndexedDB), page `/medical/terrain`, confirmation
  `confirmerCarteTerrain`. Table `AssistantIaTerrainCapture`.
- **Voix temps réel (GPT-Live)** — `infra/voix/temps-reel.ts` (session ouverte par le serveur, délégation au même
  assistant par le fil, journal et transcription), `ecrans/voix-temps-reel.tsx` ; socle `platform/ia/voix/`. Valeurs
  sensibles selon la console (0034) ; modèle `gpt-live-1` réglable (Consommation IA).
- **Voix entièrement orale (lot K9, décision 0039, sur la carte orale de K4)** — `domaine/terrain/oral.ts` (pur :
  commandes orales, chiffres à l'oral, blocs dits en une phrase, mission désignée par son nom, `CONSIGNE_ORALE`),
  `infra/voix/oral.ts` (sessions vocales, délégation asynchrone suivie par `/voix/travail`, précision transmise, reprise à
  l'ouverture suivante, aiguillage : commande → carte orale K4 → précision → travail ; annuler, pause / reprise / arrêt
  de mission). La carte orale reste `infra/voix/carte-orale.ts` (K4) : la voix relit l'élément clé, un oui suffit.

## Recettes de la maison (lot J10, décision 0028)

- `recette_pour` (`infra/recettes.ts`, module `recettes`) : la version VALIDÉE d'une recette ou rien ; plan de travail tiré de la
  recette, phrase « selon la recette … validée par … le … », écarts. Fiche de la sélection (`MOTS_CLES`), règle 13 de la consigne
  (`contexte.ts`). Une famille FERMÉE retire les processus qu'elle couvre. Banc : `infra/recettes.test.ts` (faux modèle).

## « Mes notes » (décision 0026)

- **Le bloc-notes privé de chacun** : pages, blocs (texte, titre, puce, case), imbrication par niveau, raccourcis — règles pures
  `domaine/notes/` ; serveur `infra/notes/{pages,propositions}.ts` ; écran `ecrans/notes/` (chargé à la demande) et la carte
  `ecrans/notes-proposees-card.tsx`. Privé : `userId` de la session, « Vue exacte » refusée, aucune porte d'administration.
- **L'IA propose, la personne accepte** : `infra/notes/outils.ts` (`lire_notes` + 7 gestes) n'écrit qu'une
  `AssistantIaNoteProposition` ; `accepter` applique (version d'avant gardée, inverse posé), `annuler` rejoue l'inverse.
  Mêmes outils pour la voix (`outilsNotes`, `canal: "voix"`, par `api.ts`).

## Exports de l'ERP et gestes d'écran (lot K7, décision 0037)

- **Une fonction par export** (`(personne, options) → { octets, nomDeFichier, mime }` ou un refus avec son statut), dans la façade
  `lib/exports/` (L2), atteinte par la porte du socle `platform/ia/exports.ts` ; la route d'écran ET l'assistant l'appellent (même portée, mêmes droits, même audit). Catalogue pur
  `lib/exports/catalogue.ts` (14 fiches : outil, route, libellé, écran, filtres, mots), producteurs `lib/exports/producteurs.ts`.
- **Outils `exporter_*`** — `infra/exports.ts` : offerts à qui a le bouton, familles Drive + domaine ; le fichier est déposé
  au Drive de la personne (« Exports ») et rendu par deux liens (`/drive/<id>` → bloc fichier, `/api/drive/<id>/raw?dl=1`).
  Fiches au registre des capacités (`registreDesCapacites`, R0) et mots à la sélection (`MOTS_EXPORTS`). Conversation seulement.
- **Envoyer à un collègue** — `send_message` accepte des `pieces` (nodeId ou nom) : carte à confirmer ; la messagerie
  (`sendMessage`, `driveRefs`) rejuge que l'expéditeur voit la pièce et l'ouvre au destinataire en lecture.
- **Consigne** — règle 14 (`contexte.ts`) : chercher (`trouver_outil`) avant « je ne peux pas » ; sans outil, `trouver_outil`
  rend les écrans qui portent le geste (`ecransPour`) et leur lien.
- **L'export de tout** (Direction, 01/11) — `exporter_demandes_paiement`, `exporter_ordres_centre_paiement` (catalogue,
  boutons ajoutés aux écrans) ; `exporter_donnees` (`infra/analyse/exporter.ts`) : un JEU DU TOUR (lecture, tableur, SQL,
  analyse) en Excel vérifié / CSV / PDF (`platform/ia/analyse/export.ts`, `pdf.ts`), lignes jamais recopiées par le modèle,
  repères révélés par le `Revelateur` (K4) seulement à qui a le droit, colonnes confidentielles non jugées masquées.
- **Inventaire et cliquet** — `gestes-ecran.test.ts` : les 138 routes de `src/app/api` classées (couvert / exposé / hors, avec
  raison) ; une route nouvelle non classée fait échouer `npm test` ; tout bouton d'export d'un écran a sa fiche au catalogue. Preuves : `exports.test.ts`, `scripts/bench/k7-exports.ts`.
## Carte d'action compacte (31/10/2026)

- `ecrans/action-confirmation-card.tsx` : une carte À FORMULAIRE se résume dans le fil (`data-testid="carte-action-compacte"`) ;
  le formulaire s'ouvre dans `ecrans/panneau-lateral.tsx` (`pleinEcranMobile`) rendu par portail — un ancêtre en
  `backdrop-blur` casse le `fixed`. Règles pures et testées : `domaine/ui/carte-action.ts` (avertissements uniques, état de
  simulation affiché, libellé du bouton, aperçu des champs). Zones de texte auto-ajustées : `ecrans/formulaire-carte.tsx:ZoneAuto`.

## Banc d'audit permanent (lot Q1, décision 0050)

Un ATTAQUANT (93 scénarios) et un UTILISATEUR EXIGEANT (65 tâches) joués par la machine. Catalogue pur et semis partagés :
`infra/testing/audit/` (porte `api-banc.ts`) — personas et témoins (`personas.ts`, matrice `peutVoir`), attaques, tâches,
verdicts, espion de Prisma (`espion.ts` : la ligne d'autrui n'a jamais été lue), sondes et cliquet (`sondes.ts`).
Déterministe dans `npm test` : `audit-assistant.test.ts` (faux modèle adversarial ; toute lecture de `outilsV1` doit avoir sa
sonde, son scénario réel ou sa raison « sans donnée de personne »). Réel : `npm run audit:assistant`
(`scripts/bench/audit-assistant/`, base de banc), rapport `docs/assistant/preuves/audit/`, et chaque nuit par `qualite.banc`
(verdict `FUITE` notifié). En Vue exacte, le tour ne lit plus la mémoire, les notes ni les conversations de la personne
regardée (`infra/fil/tour.ts`).

## Dossiers, caisse d'avance, salles, fiches Ad & Pro (lot T3, décision 0051)

« Voici l'Excel, mets à jour les statuts » → `maj_dossiers_depuis_tableau` (`infra/operations/dossiers-excel.ts`, règles
pures `modules/suivi-dossiers`) : lecture serveur, rapprochement contrôlé, carte = aperçu (ambiguës, introuvables, lecture
seule, erreurs listées), application par l'action de lot `dossier-actions:mettreAJourDossiersEnLot` — UN geste, UNE
annulation. « Moyens généraux » = la CAISSE D'AVANCE de l'assistante (Direction, 02/11) : `lire_caisse_avance`
(`infra/caisse-avance.ts`, vue de l'écran) et `depenser_caisse_avance` (avec justificatif), `demander_rallonge_caisse`,
`confirmer_reception_caisse` (`infra/operations/caisse-avance.ts`, actions `petty-cash-actions`). Salles de réunion
(module `salles`, réservation ouverte à tous) : `reserver_salle`, `declarer_salle`, `lire_salles`. Fiches hôtellerie et
voyage en lot : `preparer_fiches_hotellerie_voyage`. Lecture du suivi : `lire_dossiers_suivi`
(`infra/lectures-dossiers-mg.ts`). Banc du domaine : `infra/testing/audit/taches/dossiers-mg-adpro.ts`. Tests qui
exécutent puis annulent : `infra/operations/dossiers-mg-adpro.test.ts`, `lib/effets/reversibles-salles.test.ts`.
