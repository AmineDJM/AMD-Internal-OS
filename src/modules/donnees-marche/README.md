# Module `donnees-marche` — nomenclature nationale et audit IQVIA, déposés comme fichiers (11/2026)

La nomenclature (décisions d'enregistrement, trois onglets : en vigueur, non renouvelés, retraits) et l'audit IQVIA
(marché de ville) se déposent à l'écran `/explorateur-produits/donnees`. Le même fichier ne fait rien ; le plus récent
d'une nature fait foi ; le fichier original est gardé. Les réceptions hospitalières viennent de l'import des ventes PCH.

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : `lireNomenclature`, `lireIqvia` et leurs primitives |
| `api.ts` | **Porte serveur** : `deposerFichierMarche`, `importCourant`, `derniersDepots`, les flux, `verifierCleApi` |
| `domaine/` | lecteurs purs (+ tests) : une association IQVIA n'est comptée qu'une fois ; une décision par ligne de nomenclature |
| `infra/` | `classeur.ts` (xlsx), `imports.ts` (dépôt), `flux.ts` (lectures du service), `cle-api.ts` |

- **Tables** : `MarcheImport`, `NomenclatureLigne`, `IqviaLigne` (migration `20270243000000_donnees_marche`).
- **Lit** : `PchReceptionLigne` / `PchVenteImport` (réceptions FO, gamme MED, imports non remplacés).
- **Consommateurs** : le service Portefeuille DCI (dépôt séparé), par `GET /api/donnees-marche/v1/{etat,nomenclature,iqvia,receptions-hopital}`
  avec `Authorization: Bearer $DONNEES_MARCHE_API_KEY`.
