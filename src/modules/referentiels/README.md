# Module `referentiels` — personnes, organisations, coordonnées (socle métier, refonte V2)

Le référentiel unique des données : une **Personne** (R1) et une **Organisation** (R2) par être réel,
reliées aux fiches historiques (praticien, salarié, contact, fournisseur…), avec leurs **coordonnées**
(R4 : adresses, téléphones, e-mails). Lit `lieux` et `coffre`, jamais un métier (`carte.ts`).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : `plier`, moteur de doublons (`proposerDoublons…`, `regrouper`), libellés, types des reprises |
| `actions-*.ts` | Les actions serveur des écrans `/personnes/doublons` et `/admin/refonte-donnees` |
| `api.ts` | **Porte serveur** : double écriture (`relierALaPersonne`, `doubleEcrireOrganisation`…), fusion humaine, reprises (`REPRISES`), fiches 360° |
| `domaine/` | `normalisation`, `doublons`, `coordonnees` ; `organisations/{candidats,ecriture,libelles}` ; `personnes/paires` ; `reprises/{types,lots,curseur,pagination}` |
| `infra/organisations/` | fiches, affiliations, textes, doublons, fusion, double écriture, fiche 360° |
| `infra/personnes/` | sources (identifiants dérivés : `node:crypto`), rattachement, visibilité, fusion, reprise, fiche 360° |
| `infra/reprises/` | les reprises par lots (`index.ts` = le registre `REPRISES`), journal, curseurs |

- **Tables** : `Personne`, `PersonneRole`, `DoublonPersonne`, `Organisation`, `OrganisationRole`,
  `OrganisationIdentifiant`, `PropositionDoublonOrganisation`, `Affiliation`, `Adresse`, `PointDeContact`.
- **Actions** (une porte par fichier, chacun sous sa clé historique, `src/lib/actions/parc.ts`) :
  `actions-personnes.ts` (`personnes-actions` : fusion des doublons, interrupteur de la double écriture),
  `actions-organisations.ts` (`organisation-actions`), `actions-reprises.ts` (`refonte-reprise-actions` : aperçu
  et lots des reprises, Super Admin).
- **Dette héritée** (nommée dans `frontieres.test.ts`) : les fiches 360° lisent la visibilité de chaque
  métier ; les normalisations NIF/RC/e-mail vivent chez `quality/` et `pieces-lues/`.
