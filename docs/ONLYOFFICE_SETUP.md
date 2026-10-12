# Co-édition Bureautique — installer le serveur d'édition

Word, Excel et PowerPoint s'éditent **à plusieurs, en direct** dans AMD Internal OS — curseurs
visibles, modifications instantanées, comme dans Google Docs. Le code est déjà en place et attend
seulement deux variables d'environnement.

**Pourquoi un serveur à vous ?** Microsoft n'autorise l'intégration de Word/Excel/PowerPoint « pour
le web » que sur des fichiers hébergés **chez lui** (OneDrive/SharePoint). Nos fichiers sont
chiffrés dans notre stockage, sous nos permissions : s'y conformer signifierait déplacer les
dossiers réglementaires et les contrats RH chez un tiers. OnlyOffice Document Server, installé sur
**votre** machine, fait le même travail sans que rien ne sorte.

---

## 1. Installer le Document Server

Sur un serveur Linux joignable en HTTPS (le vôtre, ou une petite VM à côté de l'ERP) :

```bash
docker run -d --name onlyoffice --restart=always \
  -p 8443:443 \
  -e JWT_ENABLED=true \
  -e JWT_SECRET='UN-SECRET-LONG-ET-ALEATOIRE' \
  -v /srv/onlyoffice/data:/var/www/onlyoffice/Data \
  -v /srv/onlyoffice/logs:/var/log/onlyoffice \
  onlyoffice/documentserver
```

Générez le secret avec `openssl rand -hex 32`. **Gardez-le** : il va servir à l'étape 3.

> Le conteneur écoute en HTTPS sur le port 8443. Mettez-le derrière votre reverse-proxy habituel
> (Nginx, Caddy, Traefik) avec un vrai certificat — le navigateur des utilisateurs doit pouvoir le
> joindre sans avertissement de sécurité, sinon l'éditeur refuse de se charger.

## 2. Vérifier qu'il répond

```bash
curl -sS https://office.votre-domaine.dz/healthcheck
# doit répondre : true
```

## 3. Brancher l'ERP

Deux variables d'environnement, côté serveur AMD Internal OS (Render → Environment) :

| Variable | Valeur | Rôle |
|---|---|---|
| `ONLYOFFICE_URL` | `https://office.votre-domaine.dz` | URL **publique** du Document Server |
| `ONLYOFFICE_JWT_SECRET` | le secret de l'étape 1 | signe les échanges ERP ↔ serveur d'édition |

Vérifiez aussi que `APP_URL` pointe sur l'URL publique de l'ERP : le Document Server appelle l'ERP
**en retour** (serveur à serveur) pour lire le fichier et enregistrer les modifications. Si cette
URL est fausse ou injoignable depuis le Document Server, l'éditeur s'ouvre mais **ne sauvegarde
pas** — c'est la panne la plus fréquente, et la plus silencieuse.

Redéployez. Le bouton « Modifier » apparaît de lui-même sur les `.docx`, `.xlsx` et `.pptx` :
`onlyofficeConfigured()` teste ces deux variables, et tout reste inerte tant qu'elles manquent.

## 4. Essayer la co-édition

1. Créez un document depuis **Bureautique**.
2. Sur sa ligne, **Partager** → choisissez un collègue → droit **Modification**.
3. Ouvrez-le chacun de votre côté : vous voyez le curseur de l'autre, et les frappes en direct.

---

## Ce qui est garanti

- **Les fichiers ne quittent pas votre stockage.** Le Document Server les lit par une URL signée à
  durée de vie courte et les réécrit par le rappel de sauvegarde. Rien n'est stocké chez un tiers.
- **Le secret JWT ne va jamais au navigateur.** Il est lu côté serveur uniquement ; la
  configuration envoyée à l'éditeur est signée, pas déchiffrable.
- **Les droits sont ceux du Drive.** L'éditeur ne s'ouvre qu'avec un accès `EDIT` sur le fichier —
  vérifié dans `buildEditorSetup`, pas dans l'écran, pour qu'un écran de plus ne puisse pas
  l'oublier.
- **L'historique est conservé.** Chaque sauvegarde crée une version dans le Drive ; la clé de
  document (`nodeId_version`) change à chaque enregistrement, ce qui évite qu'un cache serve une
  version périmée.

## Si ça ne marche pas

**Premier réflexe : Administration → « Éditeur Office (OnlyOffice) » → « Tester l'éditeur Office »** (Super Admin ; lien
« Diagnostiquer » depuis l'écran d'édition). Le test vérifie les trois variables (le secret n'est jamais affiché), la forme des
adresses (`http://` est forcé en `https://` par le navigateur ; une adresse interne n'est pas joignable depuis Internet),
`/healthcheck` et `api.js` depuis le serveur de l'ERP, l'adresse publique de l'ERP (`/api/onlyoffice/file` doit répondre 401),
puis charge `api.js` dans votre navigateur. Chaque ✗ dit quoi corriger. Pendant la panne, l'écran d'édition affiche un
aperçu en lecture seule du document.

| Symptôme | Cause quasi certaine |
|---|---|
| Le bouton « Modifier » n'apparaît pas | `ONLYOFFICE_URL` ou `ONLYOFFICE_JWT_SECRET` absent |
| L'éditeur affiche « erreur de téléchargement » | Le Document Server n'atteint pas `APP_URL` |
| L'éditeur s'ouvre mais rien n'est enregistré | Idem — le rappel de sauvegarde n'arrive pas |
| « Le jeton n'est pas valide » | Le secret diffère entre le conteneur et l'ERP |
| Page blanche dans l'éditeur | Certificat HTTPS non reconnu par le navigateur |

**Fichiers concernés** : `src/lib/onlyoffice.ts` (JWT, détection), `src/lib/onlyoffice-config.ts`
(configuration de l'éditeur + contrôle de droit), `src/app/api/onlyoffice/{file,callback}/route.ts`
(lecture et sauvegarde), `src/app/(app)/drive/[id]/edit/` (l'écran d'édition).
