# Module « suivi-dossiers » — la mise à jour du Suivi de dossiers depuis un tableau (lot T3, décision 0051)

Le Suivi de dossiers (sujets `DOS-AAAA-NNN`, module RBAC `DOSSIERS`) vit encore dans `src/lib/actions/dossier-actions.ts`
et `src/lib/dossiers-core.ts` ; ce module porte le code NEUF du lot T3 : la mise à jour EN LOT depuis un Excel / CSV.

| Porte | Contenu |
|---|---|
| `partage.ts` | règles pures : statuts / priorités / dates écrits par une personne, colonnes reconnues, rapprochement (référence → intitulé exact → intitulé approché contrôlé, sinon ambigu ou introuvable), plan avant → après, lecture du lot confirmé |
| `api.ts` | serveur : `dossiersConnus` (ce que la personne voit, et ce qu'elle peut modifier) |

L'application : `dossier-actions:mettreAJourDossiersEnLot` (tout ou rien, lignes modifiées depuis l'aperçu écartées, UN
geste réversible). L'Assistant IA : `maj_dossiers_depuis_tableau`, `lire_dossiers_suivi`.
