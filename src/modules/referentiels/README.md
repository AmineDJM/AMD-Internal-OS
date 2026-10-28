# Module `referentiels` — personnes, organisations, coordonnées (socle métier, refonte V2)

Le référentiel unique des données : une **Personne** (R1) et une **Organisation** (R2) par être réel,
reliées aux fiches historiques (praticien, salarié, contact, fournisseur…), avec leurs **coordonnées**
(R4 : adresses, téléphones, e-mails). Lit `lieux` et `coffre`, jamais un métier (`carte.ts`).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : `plier`, moteur de doublons (`proposerDoublons…`, `regrouper`), libellés, types des reprises |
| `api.ts` | **Porte serveur** : double écriture (`relierALaPersonne`, `doubleEcrireOrganisation`…), fusion humaine, reprises (`REPRISES`), fiches 360° |
| `domaine/` | `normalisation`, `doublons`, `coordonnees` ; `organisations/{candidats,ecriture,libelles}` ; `personnes/paires` ; `reprises/{types,lots,curseur,pagination}` |
| `infra/organisations/` | fiches, affiliations, textes, doublons, fusion, double écriture, fiche 360° |
| `infra/personnes/` | sources (identifiants dérivés : `node:crypto`), rattachement, visibilité, fusion, reprise, fiche 360° |
| `infra/reprises/` | les reprises par lots (`index.ts` = le registre `REPRISES`), journal, curseurs |

- **Tables** : `Personne`, `PersonneRole`, `DoublonPersonne`, `Organisation`, `OrganisationRole`,
  `OrganisationIdentifiant`, `PropositionDoublonOrganisation`, `Affiliation`, `Adresse`, `PointDeContact`.
- **Actions** : encore dans `src/lib/actions/` (`personnes-actions`, `organisation-actions`,
  `refonte-reprise-actions`) — elles peuvent rejoindre `actions.ts` ici en se déclarant dans
  `src/lib/actions/parc.ts` (voir `docs/architecture/MODULES.md`).
- **Dette héritée** (nommée dans `frontieres.test.ts`) : les fiches 360° lisent la visibilité de chaque
  métier ; les normalisations NIF/RC/e-mail vivent chez `quality/` et `pieces-lues/`.
