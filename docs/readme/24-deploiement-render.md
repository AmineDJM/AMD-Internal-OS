## ☁️ Déploiement — Render

Un **Blueprint** [`render.yaml`](render.yaml) provisionne **l'app Next.js + une base PostgreSQL managée**,
applique les migrations et crée le Super Admin (aucune donnée de démo).

1. [dashboard.render.com](https://dashboard.render.com) → **New + → Blueprint**, connecter ce dépôt.
2. Renseigner `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` (`DATABASE_URL` et `AUTH_SECRET` gérés automatiquement).
3. **Apply** → Render exécute `npm ci && prisma generate && npm run build:render && prisma migrate deploy && db:bootstrap` — lint, typecheck et build AVANT toute écriture en base (refonte P0, [`docs/architecture/refonte-p0-outillage.md`](../architecture/refonte-p0-outillage.md) §2).

### Sonde de santé et fiabilité (lot V3-E, 2026-10-28)

- **`healthCheckPath: /api/health`** (au lieu de `/login`, page statique qui répondait 200 base perdue). La sonde rend
  **503** si Postgres ne répond pas en 3 s (`base: "injoignable"`) **ou** s'il manque une migration du dépôt en base
  (`migrations: "en-retard"`, nombre seulement) : un tableau de bord qui aurait perdu `prisma migrate deploy` fait
  échouer le déploiement au lieu de servir du code sur un schéma en retard. Elle rend aussi `etat: "sain" | "degrade"` et
  des **nombres** d'erreurs répétées du processus (15 dernières minutes) — **200 quand même** : redémarrer ne répare pas
  une requête qui échoue. ⚠️ Le tableau de bord prime (§118.208) : *Settings → Health Check Path* = `/api/health`.
- **`npm ci`** au lieu de `npm install` : le build installe exactement `package-lock.json` (comme la CI) ; `package.json`
  déclare `"engines": { "node": "22.x" }` (= `NODE_VERSION` de Render = `.nvmrc`).
- **Erreurs répétées → Super Admin** : la tâche `observabilite.incidents` envoie une notification **agrégée** quand un
  événement du journal échoue 5 fois dans l'heure (puis silence 6 h) ; détail dans **Administration › Diagnostic ›
  Erreurs rattrapées**. Mécanisme : [32-conventions-contribution.md](32-conventions-contribution.md).

> **Conflit de dépendances résolu** : l'ERP utilise `nodemailer@10`, en conflit avec le peer optionnel
> `nodemailer@^7 || ^8` de `next-auth` (fournisseur e-mail inutilisé : connexion par identifiants). Le fichier
> **`.npmrc`** (`legacy-peer-deps=true`) règle le `npm install` de Render automatiquement.

> **`xlsx` vient du CDN officiel SheetJS** (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, empreinte
> d'intégrité dans `package-lock.json`) : SheetJS ne publie plus sur npm, où la 0.18.5 reste vulnérable. Le
> builder doit joindre `cdn.sheetjs.com` ; si l'hôte tombe, `npm install` échoue AVANT toute migration.

> **Mémoire de build (Next 15)** : la compilation tourne avec un tas de **3584 Mo** (`TAS_DU_BUILD_MO`,
> `next.config.mjs`) — Next 15 meurt en OOM à 3072. Pic mesuré sur build propre : 5150 Mo.

### Le worker — « Cliquez Sync, c'est tout » (décision 0019, 30/10/2026)

**La seule manipulation : Render → Blueprint → *Sync*.** La synchronisation crée le service `amd-worker` (image Docker
[`Dockerfile.worker`](../../Dockerfile.worker), plan `starter` — payant, Render n'a pas d'offre gratuite pour un worker), lui
donne ses variables (reliées au web), et il travaille aussitôt : `TACHES_DE_FOND=les-deux` est posé par le Blueprint sur le
web ET sur le worker. Aucune recopie de variable, aucun interrupteur à basculer.

**Ce qui est vérifié tout seul :**
1. **Au build de l'image** — le moteur de conversion (Python et paquets épinglés, tesseract ara/fra/eng « best » à empreintes
   vérifiées, LibreOffice, polices arabes et latines) se déclare complet (`convertir.py --verifier`), sinon l'image n'est pas
   construite et le déploiement échoue en le disant.
2. **Au démarrage** — le worker attend que la base porte les migrations de son commit (seul le web migre), puis **contrôle**
   ses variables et son moteur : chaque manque est écrit en clair dans son journal (`worker.controle.manque`, ex. « À poser
   — OPENAI_API_KEY absente : les travaux de l'Assistant IA… ») et dans **Administration › Diagnostic › Worker et
   conversions**. Une clé facultative absente ne l'empêche pas de tourner ; il le dit.
3. **En marche** — `GET /api/health/worker` (exécutants récents) et le même écran : dernier battement, file des conversions,
   échecs des dernières 24 h avec leur motif.

**Sûr pendant que le worker n'existe pas encore** (construction de l'image, panne) : en `les-deux`, le web bat comme avant,
et le **bail par tâche** (table `TacheDeFond`) garantit qu'UN seul exécutant tient chaque tâche dès que le worker arrive. Les
travaux longs restent au web tant que le worker n'a pas battu depuis 5 min ; les conversions aussi (moteur local, ou le
secours texte — dit à l'écran) ; une conversion mise en file puis jamais prise échoue au bout de 15 min, en le disant.

**Les variables du worker** (recensées dans le code, `src/lib/taches-de-fond/sante.ts`) : `DATABASE_URL` (`fromDatabase`),
`AUTH_SECRET`, `OPENAI_API_KEY`, `S3_*`, `VAPID_*`, `ADVENTUM_*` (`fromService` depuis le web : la **même** valeur),
`APP_URL` (littérale : `https://amd-internal-os-k3uc.onrender.com`). ⚠️ Render ne documente pas ce que fait un `fromService`
vers une clé que le web ne porte pas : seules des clés **déclarées** dans le bloc du web sont reliées (`OPENAI_API_KEY` y est
déclarée en `sync: false`, ce qui ne modifie pas la valeur déjà posée). Google, Microsoft, Mistral, courriel : non reliées
— le contrôle les signale ; pour les relier, ajouter une ligne `fromService` (même forme) une fois la clé posée sur le web.
Si un *Sync* échouait sur une clé reliée absente, retirer sa ligne du bloc `amd-worker` : le contrôle dira ce qui manque.

**Retour arrière** : suspendre le service `amd-worker` — le web, en `les-deux`, reprend seul les tâches. Aucun code.

### Worker séparé — les mécanismes (refonte V2-F, 28/10/2026)


Les tâches de fond (rappels, paie notifiée, jobs réglementaires, routines et fil de l'Assistant IA, missions, boîte
Gmail d'Adam, site public, couche de connaissance… — la table `TACHES_PLANIFIEES` de `src/lib/scheduled.ts`) tournent
par défaut **dans le processus web**. Le même passage peut tourner dans un **service `worker`** (`npm run worker`,
`scripts/worker.ts`) : une extraction lourde ne ralentit plus une page, et le battement ne s'endort plus avec le web.

- **Interrupteur** `TACHES_DE_FOND` (lu par CHAQUE service) : `web` (défaut — la production d'avant V2-F) · `worker`
  (seul le worker bat, le web se tait) · `les-deux` (les deux battent ; le **bail par tâche** en base, table
  `TacheDeFond`, garantit qu'UN seul exécutant tient chaque tâche). Une coquille retombe sur `web`.
- **Santé** : `GET /api/health/worker` (200 si une tâche est partie depuis < 5 min, 503 sinon ; détail réservé au Super
  Admin connecté) et **Administration › Diagnostic › Tâches de fond** (exécutant, dernier départ, durée, issue, échecs).
- **Journal** : une ligne JSON par événement (`"source":"taches-de-fond"`) — `passage.fin` (durée de chaque tâche),
  `tache.echec`, `tache.lente` (≥ 2 s), `tache.bail-perdu`, `worker.*`.

**Activation manuelle (historique — remplacée par le Sync ci-dessus, gardée pour un service créé à la main)**

1. **Créer le service.** Le bloc `amd-worker` est déclaré dans [`render.yaml`](../../render.yaml) depuis le 28/10/2026
   (en attente : `TACHES_DE_FOND=web`) — **en image Docker depuis J2** (décision 3 de la Direction, 29/10/2026) :
   [`Dockerfile.worker`](../../Dockerfile.worker) à la racine (Node 22, `npm ci`, `prisma generate`, **LibreOffice
   headless**, **ffmpeg**, **Tesseract fra/ara/eng**, utilisateur non root, `tini` pour relayer SIGTERM). *Blueprint → Sync*
   — ou à la main **New + → Background Worker** sur ce dépôt et cette branche, **Runtime : Docker**, *Dockerfile Path*
   `./Dockerfile.worker`, *Docker Context* `.`, aucune commande (l'image démarre seule : `tsx scripts/worker.ts`), plan
   payant (pas d'offre gratuite pour un worker). Le worker ne compile pas Next et **ne migre pas** : seul le build du web
   migre, après son lint/typecheck/build (P0) ; le worker démarré **attend** que la base porte les migrations de son commit.
   Un service déjà créé en runtime Node se **convertit** : *Settings → Runtime → Docker* (ou le recréer depuis le Blueprint).
2. **Variables du worker** — les MÊMES que le web : `DATABASE_URL` (base `amd-postgres`), **`AUTH_SECRET` identique**
   (clé maître du coffre et des secrets de connexion — une autre valeur rendrait tout illisible), **`APP_URL`** = URL
   publique du web (Render ne donne `RENDER_EXTERNAL_URL` qu'aux services web ; les liens des notifications en
   dépendent), `S3_*`, `VAPID_*`, `ADVENTUM_*`, clés des fournisseurs d'IA (**`OPENAI_API_KEY`** : les travaux longs de
   l'Assistant IA appellent le modèle depuis le worker), Google/Microsoft, mail. (`NODE_VERSION` est sans effet en Docker.)
   Le plus sûr : un **Environment Group** attaché aux deux services — *Dashboard → Env Groups → New Environment Group*
   (« amd-commun »), y **déplacer** depuis le web toutes les variables posées à la main (pas celles du Blueprint qui
   pointent la base), puis *web → Environment → Link Environment Group* et *amd-worker → Environment → Link Environment
   Group*. À recopier au minimum : `AUTH_SECRET` (identique !), `APP_URL`, `OPENAI_API_KEY`, `S3_*`, `VAPID_*`,
   `ADVENTUM_*`, les identifiants Google/Microsoft et SMTP. Et **`TACHES_DE_FOND=les-deux`** sur le worker.
   Contrôle : *Shell* du worker → `npm run adam:doctor`.
3. **Passer le web en `les-deux`** : *web → Environment* → `TACHES_DE_FOND=les-deux` (redémarrage automatique). Les deux
   battent ; le bail départage tâche par tâche.
4. **Vérifier** : `curl https://<web>/api/health/worker` → `executeursRecents` contient `"worker"` ; au Diagnostic, des
   tâches ont l'exécutant « worker ». Journal du worker : `worker.demarrage`, puis `passage.fin` chaque minute.
5. **Basculer** : `TACHES_DE_FOND=worker` sur le **web** (il ne bat plus, ni par minuterie ni par le polling de la
   messagerie), puis `TACHES_DE_FOND=worker` sur le worker. Après 5 min, `executeursRecents` = `["worker"]`.

**Les travaux longs (J2) pendant la bascule.** La tâche `travaux.balayage` conduit les travaux de l'Assistant IA. Sous
`les-deux`, le **web s'abstient** dès que le worker a pris une tâche dans les 5 dernières minutes (« ignorée : le worker
conduit les travaux » au Diagnostic) : un travail long ne tourne jamais dans le processus qui sert les pages quand le
worker est là. Sous `web` (aujourd'hui), le web les conduit par passages bornés (45 s) — un travail survit à chaque
redéploiement : il reprend à sa dernière étape (reçus en base). Débrayage : `TRAVAUX_SWEEP=off`.

**Retour arrière** : `TACHES_DE_FOND=web` sur le web — il rebat dès son redémarrage ; puis suspendre le worker (ou lui
poser `web` : il démarre et attend sans rien exécuter, sans boucle de redémarrage). Aucune ligne de code, aucun
redéploiement. Un worker tué en pleine tâche ne bloque rien : son bail (2 min, renouvelé tant qu'il tourne) expire et la
tâche est reprise au passage suivant. `SCHEDULER_DISABLED=1` reste la soupape d'urgence (web et worker).

### Activer OnlyOffice (optionnel)

1. Déployer le **Document Server OnlyOffice** en **Web Service public**, avec `JWT_ENABLED=true` et un `JWT_SECRET`.
2. Sur l'app : poser `ONLYOFFICE_URL`, `ONLYOFFICE_JWT_SECRET` (**le même secret**), `APP_URL`.

> 🆓 Plan gratuit Render : la base Postgres expire après ~30 jours et le service se met en veille — passer en plan
> payant pour une base durable + service always-on.

---

