# Audit M1 — Adventum IA sur serveur réel (01/11/2026)

**Conditions** : build de production propre — trois fois (mode app, après fusion, puis ERP) (`rm -rf .next && APP_MODE=adventum-ia RENDER=1 npm run build:render`,
lint + typecheck + build), `next start` en mode app sur la base de banc `amd_bench` (semée par
`scripts/bench/seed-adam-bench.ts`), **vrai modèle** OpenAI (`gpt-6.1-terra` pour les tours, `gpt-6-luna` rapide,
`gpt-image-2.5-sunburst`), compte de Direction du banc (Yacine Benali, assistant ouvert à sa personne). Script rejouable :
`scripts/bench/m1-audit.ts` (Playwright, iPhone 13 puis bureau 1440 px) ; rapport brut : [`rapport.json`](rapport.json).
Erreurs de console (navigateur, réponses ≥ 500) pendant tout l'audit : **0**. Rejoué après la dernière fusion de
`origin/claude/hopeful-goodall-phd0nb` (4c6c7ec4), build propre : capture, annulation, rappel, panneau, bureau — 5/5
« marche » (`rapport.json` porte ce passage ; ses coûts cumulent les deux).

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
| Voix — session temps réel | ⚪ non testable ici | la session WebRTC exige un vrai micro : la route répond proprement (502 du fournisseur à une offre SDP factice, 429 au plafond), jamais d'erreur serveur. La capture de fin de session est prouvée ci-dessus. |
| ERP `/assistant` — panneau « Ce qu'il retient » | ✅ marche | serveur de production SANS `APP_MODE` (l'ERP), même compte : 4 souvenirs, compteur, souvenir vocal (« retenu de la conversation vocale »), ouvert par « Ma mémoire » (bureau) et « Plus d'outils › Ma mémoire » (iPhone). Script `scripts/bench/m1-audit-erp.ts`. [erp-bureau](erp-bureau-panneau.jpg), [erp-iphone](erp-iphone-panneau.jpg) |

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

## Reste (hors de ce lot, pour décision)

- **Plafond quotidien** : 600 000 jetons/personne/jour (défaut). L'audit l'a atteint (une recherche approfondie et des
  missions pèsent ~150 000 jetons) : le refus est propre et dit, mais un usage intensif de la Direction peut le toucher.
  Relevé pour le banc uniquement (`AssistantIaReglage`, 5 M) — à décider pour la production.
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
