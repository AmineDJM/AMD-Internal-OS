# Module `graphe-entreprise` — le graphe de l'entreprise et les faits datés (J9, décision 0021)

Une VUE, pas un registre : les nœuds sont les fiches canoniques qui existent déjà (`Personne`, `Organisation`, `Product`,
`RegulatoryProduct`, demandes Ad & Pro, congrès, `Piece`) ; les arêtes datées sont lues où elles sont écrites
(`EntityLink`, `PieceLien`, `FaitConfirme`, `EntityMention`, clés étrangères métier). Décision :
[`docs/assistant/decisions/0021-graphe.md`](../../../docs/assistant/decisions/0021-graphe.md).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : nœuds et arêtes datées, translittération arabe/latin, résolution, parcours borné, faits bitemporels, « chaque chiffre porte sa source » |
| `api.ts` | **Porte serveur** : `resoudreEntite`, `explorerRelations`, `etatALaDate`, `dOuVient`, `perimetreDe` |
| `domaine/` | règles pures (+ tests en millisecondes) |
| `infra/` | périmètre (droits AVANT le parcours), arêtes, canonisation, libellés, index de résolution (cache 5 min), faits datés |

- **Tables** : aucune à lui. La migration `20270210090000_graphe_faits_dates` ajoute à `FaitConfirme` le temps de constat
  de la fermeture (`fermeLe`), `fermeParId`, `remplaceParId` ; `lib/enrichissement/confirmation.ts` ferme par `fermeture()`.
- **Lit** : `referentiels` (normalisation des noms), `bibliotheque` (`piecesOuvrables`, `faitsVisibles`).
- **Consommateurs** : l'Assistant IA par le socle (`src/platform/ia/lectures/graphe.ts` : `explorer_relations`,
  `etat_a_une_date`, `d_ou_vient`).
- **Bancs** : `graphe.test.ts` (base réelle) — résolution ≥ 95 % sur un corpus semé, 100 % des chiffres sourcés, p95 < 300 ms
  sur 50 000 arêtes, aucun résultat hors droits (tests par rôle).
