## 💾 Sauvegardes de la base et restauration

> Audit du 27/10/2026, INFRA-06 : aucune sauvegarde ni procédure de restauration n'existait. Depuis le 28/10/2026,
> la base de production est **copiée chaque nuit, chiffrée, hors de Render**, et **restaurée pour de vrai chaque
> dimanche** dans une base jetable. Workflow : `.github/workflows/sauvegarde-base.yml`.

### 1. Ce qui tourne

| Quand | Quoi | Où |
|---|---|---|
| Chaque nuit, 03:17 (Alger) | `pg_dump` format custom → chiffrement GPG AES-256 → empreinte SHA-256 | Stockage S3 `sauvegardes/base/amd-AAAAMMJJTHHMMSSZ.dump.gpg` (+ artefact GitHub 7 jours) |
| Après chaque copie | Purge selon la rétention : **14 quotidiennes, 8 hebdomadaires, 12 mensuelles** ; la plus récente n'est jamais purgée | `scripts/sauvegarde/retention.mjs` (règle pure, testée : `src/lib/sauvegarde/retention.test.ts`) |
| Chaque dimanche (et à la demande) | La copie de la nuit est **déchiffrée et restaurée** dans un Postgres 16 neuf ; contrôles : migrations, tables, comptes, volume | Résumé du job GitHub Actions |

Un échec (secret manquant, copie vide, restauration incomplète) fait **échouer le workflow** : GitHub prévient par
e-mail le propriétaire du dépôt. Une sauvegarde silencieuse qui ne marche pas est le pire des cas — d'où ce choix.

### 2. Mise en place (une fois, ~10 minutes)

Dans GitHub : **Settings › Secrets and variables › Actions › New repository secret**.

| Secret | Valeur |
|---|---|
| `SAUVEGARDE_DATABASE_URL` | Render › la base › **Connect › External Database URL** (l'URL externe, pas l'interne) |
| `SAUVEGARDE_PHRASE` | Une phrase secrète de **32 caractères au moins**. ⚠️ La garder AUSSI hors de GitHub (coffre de la Direction) : sans elle, aucune copie ne se relit. |
| `SAUVEGARDE_S3_ENDPOINT` · `SAUVEGARDE_S3_BUCKET` · `SAUVEGARDE_S3_ACCESS_KEY_ID` · `SAUVEGARDE_S3_SECRET_ACCESS_KEY` · `SAUVEGARDE_S3_REGION` | Un bucket **dédié aux sauvegardes**, idéalement chez un autre fournisseur que la production (ex. Cloudflare R2, Backblaze B2) et avec le **verrouillage d'objet / versionnement** activé. Sans ces secrets, la copie n'est gardée que 7 jours en artefact. |

Puis **Actions › Sauvegarde de la base › Run workflow** (case « Restaurer » cochée) : le premier passage doit finir
vert, avec le tableau de contrôle de la restauration dans le résumé.

> En complément (recommandé) : passer la base Render sur un plan payant qui inclut les sauvegardes et la
> restauration à un instant donné (PITR). Les deux se cumulent : PITR pour « revenir 2 h en arrière », la copie
> chiffrée hors de Render pour « Render ou le compte a disparu ».

### 3. Restaurer en urgence

1. **Créer une base NEUVE et VIDE** (Render › New › PostgreSQL), jamais la base en service.
2. Télécharger la copie voulue (S3, ou l'artefact du workflow) et son `.sha256` à côté.
3. Depuis un poste qui a `gpg` et le client PostgreSQL ≥ 16 :
   ```bash
   SAUVEGARDE_PHRASE='…' scripts/sauvegarde/restaurer.sh amd-20261028T021700Z.dump.gpg "postgresql://…/nouvelle_base"
   ```
   Le script vérifie l'empreinte, refuse une cible non vide, restaure, puis affiche migrations, comptes et volume.
4. **Basculer** : Render › service web (et worker) › `DATABASE_URL` = la nouvelle base → redéployer.
   Le build applique les migrations éventuellement plus récentes que la copie (`prisma migrate deploy`).
5. Vérifier `/api/health` (la sonde interroge la base) et se connecter.

### 4. Les fichiers

Quand le stockage objet est configuré (`S3_*`), les fichiers vivent **dans le bucket** (chiffrés) et la base ne
garde que leurs métadonnées : la copie de la base ne les contient pas. Activer le **versionnement** du bucket de
production (Supabase / R2 / S3) couvre la suppression accidentelle ; sans stockage objet, les fichiers sont dans la
base et donc dans la copie.

### 5. Fichiers du bucket et clé de chiffrement

> Audit du Drive du 24/11/2026 (A2, A8). La copie nocturne de la base **ne contient pas** les fichiers du bucket,
> et elle ne sert à rien sans la **clé** qui les déchiffre. Les trois points ci-dessous sont à tenir ensemble.

**La clé (`DRIVE_ENCRYPTION_KEY`).** Tous les fichiers (Drive, documents, pièces) sont chiffrés AES-256-GCM avec
cette clé : 32 octets, en hexadécimal (64 caractères) ou base64 (44). Depuis le 24/11/2026 :

- elle est **obligatoire en production** et doit être **identique** sur `amd-internal-os`, `adventum-ia` et
  `amd-worker` (plus aucun repli sur `NEXTAUTH_SECRET`/`AUTH_SECRET`, qui différaient d'un service à l'autre) ;
- une clé **mal formée** (collée tronquée) est une **erreur**, plus un repli silencieux ;
- chaque fichier garde l'empreinte de sa clé (`FileBlob.keyId`) ; un redépôt ne réemploie jamais un fichier
  d'une autre clé ; les fichiers d'avant (sans empreinte) se relisent avec la clé active, et prennent leur
  empreinte à la première lecture réussie ;
- le premier service qui démarre pose l'empreinte de sa clé dans les réglages (`AppSetting.driveKeyFingerprint`) ;
  un service qui démarre avec une autre clé **refuse d'enregistrer des fichiers** et `/api/health` répond
  `"cleFichiers": "divergente"` (`"absente"` / `"invalide"` si la variable manque ou est fausse ; `"etat": "degrade"`).

*Première mise en place* (avant de déployer cette version) : poser sur les **trois** services la clé
qu'utilisait jusqu'ici le service web — sa `DRIVE_ENCRYPTION_KEY` si elle existait ; sinon, dans le Shell Render
du service web, `node -e "console.log(require('crypto').createHash('sha256').update(process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET).digest('hex'))"`.
Si `adventum-ia` ou le worker ont écrit des fichiers avec leur propre secret (fichiers « illisibles »),
calculer de même la clé dérivée de LEUR secret et la mettre dans `DRIVE_ENCRYPTION_KEYS` des trois services.

*Rotation* : nouvelle clé dans `DRIVE_ENCRYPTION_KEY`, l'ancienne dans `DRIVE_ENCRYPTION_KEYS` (liste séparée par
des virgules), sur les trois services, puis redéployer. Le premier service redémarré fait avancer la référence ;
les anciens fichiers restent lisibles tant que l'ancienne clé est dans le trousseau. **Ne jamais retirer une
ancienne clé** du trousseau tant que des fichiers en dépendent.

**La clé sous séquestre.** Sans elle, ni la production ni une copie ne se relisent. La conserver **hors de
Render et hors de GitHub** (coffre de la Direction, comme `SAUVEGARDE_PHRASE`), avec toutes les anciennes clés
du trousseau, et noter la date de chaque rotation.

**La copie nocturne du bucket.** Cloudflare R2 **n'a pas de versionnement d'objets** : un objet supprimé ou
écrasé l'est pour de bon, et la copie de la base n'en garde que les métadonnées. Il faut donc une copie
nocturne du bucket de production vers un bucket **d'un autre compte** (idéalement un autre fournisseur, avec
verrouillage d'objet), en mode **ajout seul** (sans propager les suppressions), par exemple
`rclone copy prod:amd-fichiers sauvegarde:amd-fichiers-copie --immutable` planifié chaque nuit après la copie de
la base. Les objets sont déjà chiffrés : la copie ne voit jamais le clair.

**Restauration testée.** Une restauration n'est prouvée que si un fichier se rouvre. Une fois par trimestre (et
après chaque rotation de clé) : restaurer la copie de la base (§ 3), pointer un service de test sur la copie du
bucket (`S3_*`) avec la clé et le trousseau sous séquestre, ouvrir trois fichiers de dates différentes (dont un
antérieur à la dernière rotation), vérifier `/api/health` (`"cleFichiers": "ok"`), et consigner le résultat.
