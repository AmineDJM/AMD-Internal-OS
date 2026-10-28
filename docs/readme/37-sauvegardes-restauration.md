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
