## ☁️ Déploiement — Render

Un **Blueprint** [`render.yaml`](render.yaml) provisionne **l'app Next.js + une base PostgreSQL managée**,
applique les migrations et crée le Super Admin (aucune donnée de démo).

1. [dashboard.render.com](https://dashboard.render.com) → **New + → Blueprint**, connecter ce dépôt.
2. Renseigner `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` (`DATABASE_URL` et `AUTH_SECRET` gérés automatiquement).
3. **Apply** → Render exécute `npm install && prisma generate && npm run build:render && prisma migrate deploy && db:bootstrap` — lint, typecheck et build AVANT toute écriture en base (refonte P0, [`docs/architecture/refonte-p0-outillage.md`](../architecture/refonte-p0-outillage.md) §2).

> **Conflit de dépendances résolu** : `imapflow` tire `nodemailer@9`, en conflit avec le peer optionnel
> `nodemailer@6` de `next-auth` (inutilisé). Le fichier **`.npmrc`** (`legacy-peer-deps=true`) règle le
> `npm install` de Render automatiquement.

### Worker séparé — les tâches de fond hors du web (refonte V2-F, déclaré le 28/10/2026, en attente de bascule)

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

**Activation sur Render — procédure exacte**

1. **Créer le service.** Le bloc `amd-worker` est déclaré dans [`render.yaml`](../../render.yaml) depuis le 28/10/2026
   (en attente : `TACHES_DE_FOND=web`) : *Blueprint → Sync* — ou créer à la main **New + → Background Worker** sur ce dépôt et cette branche, runtime Node,
   *Build Command* `npm install && npx prisma generate`, *Start Command* `npm run worker`, plan payant (pas d'offre
   gratuite pour un worker). Le build du worker ne compile pas Next et **ne migre pas** : seul le build du web migre,
   après son lint/typecheck/build (P0) ; le worker démarré **attend** que la base porte les migrations de son commit.
2. **Variables du worker** — les MÊMES que le web : `DATABASE_URL` (base `amd-postgres`), **`AUTH_SECRET` identique**
   (clé maître du coffre et des secrets de connexion — une autre valeur rendrait tout illisible), **`APP_URL`** = URL
   publique du web (Render ne donne `RENDER_EXTERNAL_URL` qu'aux services web ; les liens des notifications en
   dépendent), `NODE_VERSION=22`, `S3_*`, `VAPID_*`, `ADVENTUM_*`, clés des fournisseurs d'IA, Google/Microsoft, mail.
   Le plus sûr : un **Environment Group** attaché aux deux services. Et **`TACHES_DE_FOND=les-deux`**.
   Contrôle : *Shell* du worker → `npm run adam:doctor`.
3. **Passer le web en `les-deux`** : *web → Environment* → `TACHES_DE_FOND=les-deux` (redémarrage automatique). Les deux
   battent ; le bail départage tâche par tâche.
4. **Vérifier** : `curl https://<web>/api/health/worker` → `executeursRecents` contient `"worker"` ; au Diagnostic, des
   tâches ont l'exécutant « worker ». Journal du worker : `worker.demarrage`, puis `passage.fin` chaque minute.
5. **Basculer** : `TACHES_DE_FOND=worker` sur le **web** (il ne bat plus, ni par minuterie ni par le polling de la
   messagerie), puis `TACHES_DE_FOND=worker` sur le worker. Après 5 min, `executeursRecents` = `["worker"]`.

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

