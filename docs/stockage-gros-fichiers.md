# Gros fichiers : activer le stockage objet (Cloudflare R2 ou AWS S3)

Sans stockage objet, les fichiers vont **dans Postgres** : au-delà de 100 Mo
(`MAX_DB_UPLOAD_MB`), ils sont **refusés** — un dossier CTD de plusieurs Go remplirait la
base (≈ 1 Go sur l'offre gratuite de Render). Avec un bucket, le navigateur envoie les gros
fichiers **directement au bucket**, en parties de 32 Mo envoyées six à la fois, avec reprise
après coupure : le serveur ne voit pas un octet.

Durée : ~10 minutes. Coût R2 : 10 Go gratuits, puis ~0,015 $/Go/mois, **aucun frais de sortie**.

## 1. Créer le bucket

**Cloudflare R2** (recommandé) : tableau de bord Cloudflare → R2 → *Create bucket* → nom
`amd-documents`, région *Automatic*. Puis R2 → *Manage R2 API Tokens* → *Create API token* →
permission **Object Read & Write**, limitée à ce bucket. Notez l'**Access Key ID**, le
**Secret Access Key** et l'**endpoint** (`https://<compte>.r2.cloudflarestorage.com`, ou
`…eu.r2…` si le bucket est en juridiction UE).

**AWS S3** : console S3 → *Create bucket* (accès public bloqué) ; IAM → utilisateur avec
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListMultipartUploadParts`,
`s3:AbortMultipartUpload` sur ce bucket ; endpoint `https://s3.<région>.amazonaws.com`.

## 2. Autoriser l'envoi depuis le navigateur (CORS)

Indispensable : sans elle, tout « semble » configuré et chaque gros envoi échoue.
R2 → bucket → *Settings* → *CORS Policy* (S3 : *Permissions* → *CORS*) :

```json
[
  {
    "AllowedOrigins": ["https://VOTRE-APPLICATION.onrender.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: ETag` sert de **secours** : pour recoller les parties, le serveur relit d'abord leurs empreintes au bucket (`ListParts`). Sur **Supabase Storage**, la règle CORS ne se règle pas et `ETag` n'est pas exposé au navigateur : ce n'est pas bloquant tant que le stockage liste les parties — le bouton « Tester l'envoi direct » le vérifie de bout en bout.

Conseillé : une **règle de cycle de vie** « abandonner les envois en plusieurs parties
incomplets après 7 jours » (R2 : *Object lifecycle rules* ; S3 : *Lifecycle* →
*Delete expired object delete markers or incomplete multipart uploads*).

## 3. Poser les variables dans Render

Render → votre service → **Environment** → *Add Environment Variable* :

| Variable | Valeur |
|---|---|
| `S3_ENDPOINT` | l'endpoint de l'étape 1 (sans le nom du bucket) |
| `S3_BUCKET` | `amd-documents` |
| `S3_ACCESS_KEY_ID` | la clé d'accès |
| `S3_SECRET_ACCESS_KEY` | le secret |
| `S3_REGION` | `auto` pour R2, la région pour S3 (ex. `eu-west-3`) |

Enregistrez : Render redéploie. Aucun secret ne quitte le serveur ; le navigateur ne reçoit
que des adresses signées valables quelques heures.

## 4. Vérifier

**Administration → Stockage objet** : le badge passe à « Cloudflare R2 » (ou « Amazon S3 »).
Cliquez **Tester la connexion** (le serveur écrit, relit et efface un petit objet), puis
**Tester l'envoi direct (navigateur)** : le vrai chemin des gros fichiers — une partie poussée par le navigateur (CORS), puis recollée par le serveur à partir des empreintes du bucket (ETag du navigateur en secours).

## Réglages facultatifs

| Variable | Défaut | Effet |
|---|---|---|
| `S3_DIRECT_THRESHOLD_MB` | 20 | au-delà, un fichier du Drive part directement au bucket |
| `S3_DIRECT_PART_MB` | 32 | taille d'une partie (5 minimum) |
| `S3_DIRECT_CONCURRENCY` | 6 | parties envoyées en même temps |
| `MAX_DB_UPLOAD_MB` | 100 | sans bucket, au-delà, refus au lieu d'écrire en base |
| `S3_DISABLED` | — | `true` coupe le stockage objet sans effacer les variables |

## Ce qu'il faut savoir

- Les fichiers déjà stockés en base restent lisibles ; seuls les nouveaux vont au bucket.
- Les gros fichiers du Drive envoyés en direct sont protégés par le chiffrement au repos du
  fournisseur et par les droits de l'application (seule elle signe les adresses) ; ils ne
  passent pas par le chiffrement applicatif et ne sont pas dédupliqués. Limite : 10 Go par
  fichier (Drive, zip, archive CTD — un zip est un fichier). Réglage Drive : Administration › Réglages
  (`maxDriveUploadMb`, 10 240 par défaut) ; archives CTD : `REG_ZIP_MAX_ARCHIVE_MB` (10 240 par défaut).
  Les tailles sont des `Float` en base (exactes jusqu'à 9 Po). Le stockage du bucket a SA propre limite
  (Supabase : réglage global et limite du bucket) : à relever aussi côté fournisseur.
- Une coupure (réseau, onglet fermé) ne perd rien : relancez le même fichier, seules les
  parties manquantes repartent (24 h pour un dossier CTD, 7 jours pour le Drive).
