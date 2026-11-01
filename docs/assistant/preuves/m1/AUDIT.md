# Audit M1 — Adventum IA sur serveur réel (01/11/2026)

**Conditions** : build de production propre — trois fois (mode app, après fusion, puis ERP) (`rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render`,
lint + typecheck + build), `next start` en mode app sur la base de banc `amd_bench` (semée par
`scripts/bench/seed-adam-bench.ts`), **vrai modèle** OpenAI (`gpt-6.1-terra` pour les tours, `gpt-6-luna` rapide,
`gpt-image-2.5-sunburst`), compte de Direction du banc (Yacine Benali, assistant ouvert à sa personne). Script rejouable :
`scripts/bench/m1-audit.ts` (Playwright, iPhone 13 puis bureau 1440 px) ; rapport brut : [`rapport.json`](rapport.json).
Erreurs de console (navigateur, réponses ≥ 500) pendant tout l'audit : **0**. Rejoué après chaque fusion de
`origin/claude/hopeful-goodall-phd0nb` (4c6c7ec4, puis 03f6dbd3 avec l'orchestrateur O1), build propre : capture,
annulation, rappel, panneau, voix, bureau — 6/6 « marche » (`rapport.json` porte le dernier passage ; ses coûts cumulent
les passages ; d'un passage à l'autre, l'extracteur fusionne parfois « Fille : Lina » dans le fait du voyage — 3 ou 4
souvenirs pour le même message).

## Le tableau

| Fonction | Verdict | Preuve |
|---|---|---|
| **Mémoire — capture automatique** | ✅ marche | 4 souvenirs en base (`AssistantMemoryItem`, origine `auto`) après UN message : `[VOYAGES] Part à Lyon le 12 novembre 2026 avec sa fille Lina` · `[FAMILLE] Fille : Lina` · `[ETUDES_PARCOURS] A fait ses études à l'École nationale polytechnique d'Alger` · `[GOUTS_LOISIRS] Adore le café noir le matin`. Lignes « Retenu : … — annuler · voir » sous la réponse. [iphone-01](iphone-01-capture-retenu.jpg) |
| Mémoire — « annuler » | ✅ marche | souvenirs actifs 4 → 3, ligne barrée « annulé ». [iphone-02](iphone-02-annule.jpg), [bureau-01](bureau-01-conversation-retenu.jpg) |
| **Mémoire — rappel dans une NOUVELLE conversation** | ✅ marche | « Tu te souviens de mon voyage ? » → « Oui, tu pars à Lyon le 12 novembre 2026 avec ta fille Lina. » [iphone-03](iphone-03-rappel-voyage.jpg) |
| Mémoire — panneau « Ce qu'il retient » | ✅ marche | groupes (Moi, Ma vie…), compteur, origine (lien vers la conversation), date, édition en ligne écrite en base, réglage « Mémoire automatique », tout effacer ; mis à jour sans recharger (l'édition se voit aussitôt dans la conversation : « Fille : Lina. (corrigé) »). [iphone-04](iphone-04-panneau.jpg), [iphone-05](iphone-05-panneau-edite.jpg), [bureau-02](bureau-02-panneau.jpg) |
| Mémoire — conversation vocale | ✅ marche | fin de session (`/api/assistant-ia/voix/journal`) : transcription au fil + `[FAMILLE] Fils : Adam, qui commence l'université à Constantine en septembre 2027` (origine `voix`). [iphone-15](iphone-15-voix-transcription.jpg) |
| Conversation privée | ✅ marche | « Ma femme s'appelle Sarah… » → 0 souvenir créé, aucun appel d'extracteur. [iphone-06](iphone-06-privee.jpg) |
| Conversations — création, titre | ✅ marche | `AssistantIaFil` titré « Voyage à Lyon avec Lina » (`titreSource = auto`, modèle rapide). |
| Dossiers de conversations | ✅ marche | bouton « Nouveau dossier », panneau du dossier. [iphone-18](iphone-18-dossiers.jpg) |
| Mes notes — proposition, acceptation, onglet | ✅ marche | 1 proposition (`AssistantIaNoteProposition` → `ACCEPTEE`), onglet Notes du tiroir. Une note identique déjà présente : l'assistant le dit et ne propose rien (vu au banc). [iphone-07](iphone-07-notes-proposees.jpg), [iphone-08](iphone-08-onglet-notes.jpg) |
| Missions — sous-missions, tableau temps réel, synthèse | ✅ marche | 2 sous-missions, « Tout approuver », carte mise à jour en direct, synthèse `TERMINE` (« 2/2 terminées, coût total 0,03 $ »). [iphone-12a](iphone-12a-missions-a-approuver.jpg), [iphone-12](iphone-12-missions.jpg) |
| Recherche approfondie | ✅ marche | 1 mission (2 angles), rapport de 24 424 caractères, 104 appels de source numérotés, coût 0,11 $. [iphone-13a](iphone-13a-recherche-approfondie.jpg) |
| Recherche web | ✅ marche | `web_research`, réponse datée (« publications du 28 octobre 2026 ») avec la source. [iphone-11](iphone-11-web.jpg) |
| Analyse de données | ✅ marche | lecture → SQL en lecture seule → « Analyse calculée » : tableau et calcul vérifiable sous la réponse. [iphone-09](iphone-09-analyse.jpg) |
| Exports | ✅ marche | « Exporte le suivi Regulatory en Excel » → fichier dans Drive › Exports, lien de téléchargement. [iphone-10](iphone-10-export.jpg) |
| Pièces jointes | ✅ marche | fichier déposé, lu, résumé exact (« reporté à janvier 2027 faute d'enregistrement ANPP »). [iphone-13](iphone-13-piece.jpg) |
| Images | ✅ marche | `AssistantIaVisuel` créé, image dans le Drive (famille « Images & vidéos » ouverte pour le banc — fermée par défaut). [iphone-14](iphone-14-image.jpg) |
| Réglages | ✅ marche | thème, réponse vocale, missions d'office, notifications, appareils connectés, consommation. [iphone-16](iphone-16-reglages.jpg), [iphone-17](iphone-17-consommation.jpg) |
| Routines (créer, lancer, résultat, non-lus) | ✅ marche | « Chaque lundi à 8 h, fais-moi un point sur mes tâches en retard » → carte confirmée → `AssistantRoutine` ; « Exécuter maintenant » → passage `SUCCES`, marqué lu à l'ouverture. [iphone-19](iphone-19-routine-carte.jpg), [iphone-20](iphone-20-routines-panneau.jpg), [bureau-03](bureau-03-routines.jpg) |
| Veille | ✅ marche | panneau ouvert depuis la liste. [iphone-21](iphone-21-veille.jpg), [bureau-04](bureau-04-veille.jpg) |
| « Ce que l'assistant a fait » (journal des gestes, Annuler) | ✅ **corrigé** | ABSENT de l'app (page ERP `/assistant/gestes` non servie en mode app) → panneau `ecrans/app/panneau-gestes.tsx` dans la liste latérale, même écran `GestesAssistant`. [iphone-22](iphone-22-gestes.jpg), [bureau-05](bureau-05-gestes.jpg) |
| Documents (tiroir) et Atelier | ✅ marche | [iphone-23](iphone-23-documents.jpg), [iphone-24](iphone-24-atelier.jpg), [bureau-06](bureau-06-documents.jpg) |
| Dépôt de dossier | ✅ marche | 3 fichiers en dossier → « une lettre de demande d'AMM pour Cardiofix 10 mg…, un RCP…, une étude de stabilité sur 24 mois ». [iphone-25](iphone-25-depot-dossier.jpg) |
| Voix — ouvrir, appeler, raccrocher, fermer au pouce | ✅ **corrigé** | « Annuler » et « Fermer » à y = 592 sur 664 (bas d'écran), panneau refermé ; la session gpt-live est ouverte par le serveur, mais l'audio WebRTC ne passe pas dans le conteneur du banc (pas d'UDP) : l'appel reste « Connexion… » — et pendant ce temps AUCUN bouton n'était au pouce (seule la croix du haut). Ajouté : « Annuler » en bas pendant la connexion. Les boutons « Fermer », « Appeler », « Raccrocher » sont dans la barre du bas (safe-area). [iphone-26a](iphone-26a-voix-pret.jpg), [iphone-26b](iphone-26b-voix-en-appel.jpg), [iphone-26c](iphone-26c-voix-raccroche.jpg) |
| ERP `/assistant` — panneau « Ce qu'il retient » | ✅ marche | serveur de production SANS `APP_MODE` (l'ERP), même compte : 4 souvenirs, compteur, souvenir vocal (« retenu de la conversation vocale »), ouvert par « Ma mémoire » (bureau) et « Plus d'outils › Ma mémoire » (iPhone). Script `scripts/bench/m1-audit-erp.ts`. [erp-bureau](erp-bureau-panneau.jpg), [erp-iphone](erp-iphone-panneau.jpg) |

## Décisions de la Direction du 01/11 — vérifiées

| Point | Verdict | Preuve |
|---|---|---|
| Mémoire en jetons : consolidation | ✅ | 123 faits redondants → 9 ; stockage 1 688 → 402 jetons ; injecté par tour 892 → 467 ; 0,00097 $ (gpt-6-luna, 4 335/1 080 jetons, 10 s), aucun groupe refusé, rien de perdu. [`jetons.json`](jetons.json) |
| Panneau « X jetons sur Y » | ✅ | « 402 jetons sur 8 000 — 5 % » (ERP, iPhone 13). [erp-iphone-memoire-jetons](erp-iphone-memoire-jetons.jpg) |
| Sans plafond quotidien | ✅ | Console : « Sans plafond » ; Administration › IA : « Sans plafond par jour · 150 000 jetons par tour ». [erp-admin-consommation](erp-admin-consommation-sans-plafond.jpg), [erp-admin-ia](erp-admin-ia-plafonds.jpg) |
| Historique 12 mois, santé d'office | ✅ | tests `infra/memoire-consolidation.test.ts` (purge à 13 mois, gardé à 11, actif de 3 ans gardé ; allergie retenue). |

## L'app face à l'ERP `/assistant`

Outils de l'ERP (barre et « Plus d'outils ») : Ma mémoire, Mes routines, Mes travaux, Veille, « Ce que l'assistant a
fait », Atelier, réponse vocale, missions, dépôt de dossier, pièces, voix. Dans l'app : tous présents — mémoire, routines,
veille et « Ce que l'assistant a fait » dans la liste latérale ; travaux et missions dans le tiroir (onglet Missions,
demandes reçues) et l'indicateur d'en-tête ; Atelier par l'onglet Documents ; réponse vocale dans Réglages. Seul écart
trouvé : « Ce que l'assistant a fait » — corrigé. Restent propres à l'ERP, sans fonction perdue : le bandeau d'indicateurs
(KPI) et l'effet de curseur décoratif.

## Ce qui a été trouvé et CORRIGÉ dans ce lot

1. **La cause du constat** (décision [0045](../../decisions/0045-memoire-automatique.md) § 1) : la mémoire n'écrivait rien sans un clic sur
   une carte rarement proposée, ne visait que le travail, rien à l'oral ; rappel par mots communs seulement. → capture
   automatique réversible, sortes de la vie personnelle, rappel par pertinence, voix.
2. **Premier passage réel** : l'extracteur écrivait « **Elle** s'appelle Yacine Benali » — genre supposé, et le nom du
   compte retenu pour rien. → consigne « sans pronom ni genre supposé » (« Fille : Lina », « Part à Lyon… »), garde qui
   refuse le nom du compte.
3. **Faux positif du filtre** : « fais-moi la synthèse » déclenchait l'extracteur (« thèse » dans « synthèse »). → thèmes
   ancrés en début de mot (test ajouté).
4. **Mise en page iPhone** : la ligne « Retenu » se cassait (icône seule sur une ligne). → texte en flux.
5. **Écart ERP ↔ app** : « Ce que l'assistant a fait » (historique des gestes et Annuler) n'existait que dans l'ERP. → panneau dans l'app.
6. **Voix au pouce** : pendant « Connexion… », aucun bouton en bas pour abandonner un appel qui traîne. → « Annuler » en bas.

## Reste (hors de ce lot, pour décision)

- **Plafond quotidien** : atteint pendant l'audit (600 000 jetons, alors le défaut) — la Direction l'a supprimé le 01/11
  (0 = sans plafond, décision 0045 § 4).
- **Export des demandes de paiement** : aucun écran ne l'offre, l'assistant le dit honnêtement et cite le Centre de
  paiement. À ajouter au catalogue (`src/lib/exports/catalogue.ts`) si la Direction le veut.
- **Missions hors Super Admin** : elles attendent « Approuver » (réglage « démarrer d'office », décision 0033) — voulu.
- **Images** : famille fermée par défaut dans la console — voulu (coût).

## Coûts mesurés (journal K8, `ModelCallLog`, tout l'audit final)

| Usage · modèle | Appels | Jetons entrée / sortie | Coût |
|---|---|---|---|
| fil · gpt-6.1-terra (les tours) | 45 | 417 059 / 7 206 | 0,2657 $ |
| worker · gpt-5.6-terra (recherche approfondie) | 1 | 36 405 / 1 611 | 0,1321 $ |
| redaction · gpt-6.1-terra (rapport, synthèses) | 5 | 20 880 / 7 695 | 0,0594 $ |
| image · gpt-image-2.5-sunburst | 1 | 28 / 439 | 0,0133 $ |
| redaction · gpt-6-luna (titres, résumés) | 13 | 2 411 / 860 | 0,0007 $ |
| **memoire · gpt-6-luna (capture)** | **2** | **1 300 / 385** | **0,000323 $** |
| **memoire · text-embedding-3-small** | **2** | **163 / 0** | **0,000003 $** |

Sur 24 réponses, l'extracteur n'a été appelé que **2 fois** (les deux messages qui portaient des faits sur la personne) :
le filtre déterministe a écarté les 22 autres sans rien dépenser. Une capture coûte ≈ **0,00016 $**, soit < 1 % du tour
qu'elle suit.
