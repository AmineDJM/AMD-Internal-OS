# Module `lieux` — wilayas et communes (socle métier, refonte V2-D)

Lire un lieu écrit à la main (« Alger », « 16 – ALGER CENTRE ») et poser le code de wilaya
(`wilayaCode`) sur les cinq fiches qui portent un lieu. Référentiel du socle : tout le monde le lit,
lui ne lit personne (`carte.ts` : `lieux: []`).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** (navigateur compris) : `normaliserLieu`, `normaliserWilaya`, `rattacherFiche`, `regrouperParWilaya`… |
| `api.ts` | **Porte serveur** : tout `partage.ts` + `reposerWilayaCode`, `poserWilayaCodes`, `lireLotLieux` |
| `domaine/` | `normaliser.ts` (69 wilayas, communes), `rattachement.ts` (quelle colonne de quelle fiche), `par-wilaya.ts` |
| `infra/` | `rattachement-prisma.ts` : lit et écrit `wilayaCode` |

- **Tables** : aucune en propre ; il écrit `wilayaCode` de `MedicalDoctor`, `MedicalInstitution`,
  `CompanyContact`, `Supplier`, `SalesSector` (`MODELES_LIEU`).
- **Règle tenue** : tout écrivain de ces fiches appelle `reposerWilayaCode` — `double-ecriture-garde.test.ts`.
- **Consommateurs** : `referentiels` (coordonnées, reprise des lieux), `lib/segmentation`, sept fichiers
  d'actions des annuaires, la page `/annuaires/etablissements`.
