## 🔧 Variables d'environnement

| Variable | Requis | Description |
|---|:---:|---|
| `DATABASE_URL` | ✅ | Chaîne de connexion PostgreSQL. |
| `AUTH_SECRET` | ✅ | Secret Auth.js (`openssl rand -base64 32`). Sert aussi de clé maître au chiffrement Drive/mail. |
| `AUTH_TRUST_HOST` | ✅ (prod) | `true` derrière un proxy (Render/Vercel). |
| `ADMIN_EMAIL` · `ADMIN_PASSWORD` · `ADMIN_NAME` | ✅ | Compte Super Admin initial créé au bootstrap. |
| `ANTHROPIC_API_KEY` | ⬜ | Active l'**Assistant IA**, l'analyse des rapports vocaux, les synthèses Brain/Process Intelligence/réunions. |
| `AI_MODEL` · `AI_MODEL_CHEAP` | ⬜ | Les **deux paliers** de modèle IA (maîtrise du coût). Palier **qualité** (défaut `claude-sonnet-4-6`) : revue CTD sourcée (14 agents), simulateur d'examen, réponse aux réserves, assistant conversationnel, Adventum Brain. Palier **éco** (défaut `claude-haiku-4-5`, ≈ 3× moins cher) : tâches **mécaniques** — revue de fond/forme par parts, extraction de faits & de rapports vocaux, résumés de réunion, brouillons fournisseur, Q&R de dossier, suggestion proactive. Baisser encore le coût = pointer `AI_MODEL` vers le palier éco. |
| `OPENAI_API_KEY` | ⬜ | Active la **transcription vocale** (Whisper). |
| `ASSISTANT_IA_MODEL` · `ASSISTANT_IA_TIMEOUT_MS` | ⬜ | L'**Assistant IA** (`/assistant`, Mastra) tourne sur la clé **`OPENAI_API_KEY`** déjà posée, modèle `gpt-6.1-terra` par l'API Responses (Direction, 28/10/2026 — il remplace MiMo, décision [0010](../assistant/decisions/0010-assistant-sur-openai.md)). Facultatifs : un autre modèle, le délai d'un tour (ms, 45 000 par défaut). |
| `ASSISTANT_IA_PRICE_IN` · `ASSISTANT_IA_PRICE_OUT` | ⬜ | Tarif du modèle en **dollars par million de jetons** (entrée, sortie) : le coût ESTIMÉ de l'écran Consommation IA. Absent → coût « inconnu », jamais deviné. Les plafonds se comptent en jetons et tiennent sans tarif. (`MIMO_PRICE_*` ne sert plus qu'aux journaux d'avant le 28/10.) |
| `ASSISTANT_IA_TTS_MODEL` · `ASSISTANT_IA_TTS_VOICE` | ⬜ | **Réponse vocale** de l'Assistant IA (décision [0011](../assistant/decisions/0011-vocaux-et-lecture-de-toute-piece.md)) : modèle et voix de la synthèse OpenAI (défauts `gpt-4o-mini-tts`, `alloy`). La transcription des vocaux garde `STT_MODEL`. |
| `ASSISTANT_IA_AUDIO_PRICE_IN` · `ASSISTANT_IA_AUDIO_PRICE_OUT` | ⬜ | Tarif de la VOIX de l'Assistant IA (transcription, synthèse ; fournisseur `openai-audio`) en dollars par million de jetons — équivalents compris (10 par seconde d'audio). Absent → coût « inconnu ». |
| `MAX_UPLOAD_MB` | ⬜ | Taille max d'upload par défaut (réglable aussi en base depuis l'admin). |
| `APP_URL` | ⬜* | URL **publique** de l'app — requise pour le callback OnlyOffice, et écrite dans le bloc de liaison du site (`ERP_BASE_URL`) : c'est par elle que les candidatures du site arrivent (à défaut, l'adresse par laquelle le Super Admin a ouvert l'écran, puis celle de Render). |
| `TACHES_DE_FOND` | ⬜ | **Qui porte les tâches de fond** (refonte V2-F) : `web` (défaut) · `worker` (service `npm run worker` seul) · `les-deux` (bascule ; un bail par tâche en base). Lu par chaque service. Procédure : [24-deploiement-render.md](24-deploiement-render.md). |
| `SCHEDULER_DISABLED` · `SCHEDULER_TICK_MS` | ⬜ | Soupape (`1` = aucun battement, web ni worker) · période du battement en ms (défaut 60000, min 15000). |
| `ONLYOFFICE_URL` | ⬜* | URL **publique** du Document Server OnlyOffice. |
| `ONLYOFFICE_JWT_SECRET` | ⬜* | Secret JWT **identique** à celui du Document Server. |
| `MAIL_ENCRYPTION_KEY` | ⬜ | Clé dédiée au chiffrement des mots de passe e-mail (sinon retombe sur `AUTH_SECRET`). |
| `MAIL_MAX_CONCURRENCY` | ⬜ | Connexions IMAP simultanées **max, tous comptes** (défaut 3). ↓ si Infomaniak renvoie « command failed » sur IP partagée. |
| `MAIL_MAX_POOL` · `MAIL_IMAP_IDLE_MS` | ⬜ | Plafond de connexions IMAP chaudes (défaut 8) · durée de maintien au chaud en ms (défaut 90000). |
| `MAIL_BREAKER_THRESHOLD` · `MAIL_BREAKER_COOLDOWN_MS` | ⬜ | Disjoncteur mail : nb d'échecs avant ouverture (défaut 3) · temps de repos sans solliciter Infomaniak (défaut 30000 ms). |
| `MAIL_CACHE_FRESH_MS` · `MAIL_CACHE_STALE_MS` | ⬜ | Cache boîte mail : fenêtre « frais » servie sans IMAP (défaut 10000) · repli max sur cache si saturé (défaut 900000). |
| `MAIL_PROVIDER` · `MAIL_API_KEY` · `MAIL_FROM` | ⬜ | **Courrier « smart »** — envoi par API HTTPS (port 443) au lieu de SMTP : `resend`\|`postmark`\|`brevo` · clé d'API du fournisseur · adresse d'expédition d'un **domaine vérifié chez lui** (SPF + DKIM + DMARC en DNS, sinon les messages arrivent en indésirables). Les trois ensemble → envoi actif ; sinon `/admin/courrier` dit précisément ce qui manque. |
| `MAIL_WEBHOOK_SECRET` | ⬜ | Secret du webhook de **réception** (`POST /api/mail/inbound`) : signature HMAC-SHA256 du corps brut. Absent → la route refuse tout (jamais de mode ouvert par défaut). |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | ⬜ | Notifications **push** (PWA Web Push). |
| `MISTRAL_API_KEY` | ⬜ | Active **Mistral OCR** (moteur OCR primaire, cloud, rapide) pour l'analyse CTD. Absent → repli automatique sur l'OCR local tesseract.js (aucune perte). Service tiers **payant à la page**, réseau sortant requis. |
| `REG_OCR_ENGINE` · `REG_OCR_CONCURRENCY` · `REG_OCR_BATCH` | ⬜ | Moteur OCR (`auto`\|`mistral`\|`tesseract`, défaut `auto`) · documents OCR en parallèle (défaut 3, 1-20 ; modéré car un document massif charge un gros blob) · documents par passage (défaut 24). |
| `REG_OCR_CHUNK_PAGES` · `REG_OCR_CHUNK_CONCURRENCY` | ⬜ | Découpage des PDF massifs : pages par tranche (défaut 400, sous la limite Mistral 1000) · tranches océrisées en parallèle au sein d'un document (défaut 4). |
| `REG_EXTRACTION_MAX_CHARS` | ⬜ | Plafond du texte extrait/OCR persisté par document (défaut 20 M — ≈ 10 000 pages ; fin de la troncature 1 M). ↑ demande plus de disque base. |
| `REG_AI_CHUNK_PAGES` · `REG_AI_CONCURRENCY` | ⬜ | Revue IA par parts : pages par part envoyée à l'IA (défaut 10) · parts analysées en parallèle (défaut 4). |
| `REG_AI_MAX_CHUNKS` · `REG_AI_MAX_FINDINGS` | ⬜ | Garde-coût revue IA : parts max analysées par version (défaut 120, **0 = illimité**) · constats IA max persistés (défaut 300). Chaque part = 1 appel Claude (palier **éco**) facturé — c'est le principal poste de coût CTD, borné ici. |
| `DB_CONNECTION_LIMIT` · `DB_POOL_TIMEOUT` | ⬜ | Taille du pool de connexions Prisma (**défaut 12 en production**, contre `CPUs × 2 + 1` — soit 3 — chez Prisma) · délai d'attente d'une connexion libre. ⚠️ Un pool se compte **par processus** : multiplier par le nombre d'instances et rester sous le `max_connections` de Postgres. |
| `REG_UPLOAD_PART_MB` · `REG_UPLOAD_CONCURRENCY` | ⬜ | Taille d'une partie envoyée (défaut **4 Mo**, borné à 32) · parties en parallèle (défaut **8**). ⚠️ **Ne pas grossir les parties pour aller plus vite : c'est l'inverse** — mesuré, 16 Mo est ~2× plus lent que 4 Mo (Postgres écrit moins vite une grosse valeur `bytea`, et il faut la relire pour réassembler). Le levier utile est le parallélisme. |
| `REG_INGEST_STORE_CONCURRENCY` | ⬜ | Fichiers du dossier écrits en parallèle pendant l'ingestion (défaut **4**). Au-delà, les écritures se disputent le pool de connexions et le total **remonte** (mesuré : 4,7 s en série, 1,5 s à quatre, 2,0 s à huit) — ne relever qu'avec `DB_CONNECTION_LIMIT`. |
| `REG_MAX_PG_FILE_MB` · `REG_BLOB_CHUNK_MB` | ⬜ | Taille max d'un fichier unique conservé en base (défaut **950 Mo** ≈ 1 Go, stocké en tranches) · taille d'une tranche de blob chiffré (défaut 16 Mo). Fichiers proches d'1 Go : prévoir ≥ 4 Go de RAM ou activer le stockage objet (`S3_*`). |
| `S3_ENDPOINT` · `S3_BUCKET` · `S3_ACCESS_KEY_ID` · `S3_SECRET_ACCESS_KEY` | ⬜ | **Stockage objet S3-compatible** (fournisseur actuel : **Supabase Storage** ; R2, MinIO, AWS S3 fonctionnent aussi). Configuré ⇒ le contenu **chiffré** des fichiers part dans le bucket privé et la base ne garde que les métadonnées. Absent ⇒ tout reste en base (fonctionnel, mais le disque Postgres gonfle). **Strictement côté serveur** — jamais de `NEXT_PUBLIC_`. |
| `S3_REGION` · `S3_FORCE_PATH_STYLE` | ⬜ | Région (défaut `auto`, valeur admise par R2 ; Supabase et AWS veulent une vraie région) · style d'URL **chemin** (défaut activé — exigé par Supabase et MinIO ; `0`/`false` pour du virtual-hosted). |
| `S3_DISABLED` | ⬜ | Interrupteur d'arrêt : `1` force le repli sur le stockage en base **sans effacer** les variables. Sert à écarter le stockage objet le temps d'un incident. |
| `REG_S3_*` | ⬜ | **Anciens noms**, encore acceptés en **repli** pour ne pas casser une production en cours. Les `S3_*` priment quand les deux existent. À supprimer une fois la transition faite. |
| `DRIVE_ENCRYPTION_KEY` | ⬜ | Clé maîtresse AES-256-GCM (32 octets, hex ou base64). À défaut, dérivée de `NEXTAUTH_SECRET`. ⚠️ **La changer rend illisibles tous les fichiers déjà stockés.** |
| `COFFRE_KEY` | ⬜ (obligatoire pour ouvrir le coffre) | Clé maîtresse du **coffre des données sensibles** (refonte V2-E) : 32 octets, hex ou base64, **différente** de `DRIVE_ENCRYPTION_KEY` (refusée sinon). Aucun repli en production : sans elle, la double écriture et la double lecture ne s'ouvrent pas. ⚠️ **La perdre rend le coffre illisible** — la sauvegarder hors de Render. |
| `OPENAI_API_KEY` · `OPENAI_BASE_URL` | ⬜ | Modèle économique **Luna** (`gpt-5.6-luna`) : lecture des lettres de réserves, des graphiques/images, et analyse différée (Batch). Sans clé, ces fonctions se désactivent **proprement** (message explicite) — le reste du module continue de fonctionner. |
| `CTD_MODEL_CHEAP` | ⬜ | Surcharge du modèle économique (défaut `gpt-5.6-luna`). |
| `CTD_BUDGET_USD_DEFAULT` | ⬜ | Plafond IA **global** par dossier, en dollars (défaut : aucun). Un dossier peut avoir son propre plafond, réglé à l'écran. Atteint ⇒ les appels sont **refusés avant dépense**, et l'écran le dit. |
| `REG_ANPP_WATCH` | ⬜ | `0` désactive la veille quotidienne des pages de publication ANPP (défaut activée). La veille **signale** un changement, elle n'ingère et n'active rien. |
| `ADVENTUM_BASE_URL` | ⬜ | Adresse du **site public** — défaut `https://adventumdz.com` (mesuré : `www.adventumdz.com` y redirige, et une requête redirigée n'est jamais suivie). `…/api/v1` accepté, jamais doublé ; en `https` hors poste local, sans identifiants. |
| `ADVENTUM_API_KEY` | ⬜ | **Repli** : la clé se génère depuis `/site-web` (« Générer la clé »). Posée ici, elle vaut tant qu'aucune clé de l'ERP n'est active. Ne la committez jamais : elle donne le droit de publier sur le site public. |
| `ADVENTUM_WEBHOOK_SECRET` | ⬜ | **Repli** du secret de signature (la clé générée par l'ERP porte le sien). La même valeur que `ERP_WEBHOOK_SECRET` côté site, sinon le site refuse. |
| `SITE_WEB_RECONCILIATION` | ⬜ | `off` coupe le rapprochement quotidien avec le site (la file, elle, continue d'envoyer). |

> \* Requis **ensemble** uniquement pour activer l'édition Office. Côté **service OnlyOffice**, poser
> `JWT_ENABLED=true` et `JWT_SECRET=<même valeur que ONLYOFFICE_JWT_SECRET>`.

---

