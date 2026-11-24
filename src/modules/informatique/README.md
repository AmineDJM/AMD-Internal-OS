# Module `informatique` — le département Informatique du groupe

Décision du Super Admin (24/11/2026) : « le coût de l'IA imputé au budget des départements — un département informatique,
avec ses propres modules, bases de données, et son propre budget ».

- **Le département** : une ligne `Department` par société, reconnue par sa clé `cle = "INFORMATIQUE"` (migration
  `20270248100000_departement_informatique`) ; son responsable se désigne dans l'organigramme et reçoit, par ce fait, les
  trois écrans (`getAccess`).
- **Le budget** : l'enveloppe « Informatique AAAA » de chaque société (`infra/budget.ts`), domaine général, trois lignes
  reconnues par clé (`IA_CONSOMMATION`, `ABONNEMENTS_LICENCES`, `MATERIEL_INFORMATIQUE`), montants à zéro.
- **Le coût de l'IA** : `infra/imputation.ts` — le journal `ModelCallLog` d'un mois, réparti par société (fiche de la
  personne, puis son département), consomme la ligne IA par une `BudgetExpenseLine` ; une `ImputationCoutIa` par
  (société, mois), rejouable, avec le détail par fonction IA et par département demandeur. Aucun ordre de paiement.

Portes : `api.ts` (serveur), `partage.ts` (pur), `actions-abonnements.ts` (clé `informatique-abonnements-actions`),
`actions-parc.ts` (`informatique-parc-actions`), `actions-cout-ia.ts` (`informatique-cout-ia-actions`), `ecrans/`.

Tables possédées : `AbonnementInformatique`, `MaterielInformatique`, `ImputationCoutIa`.

Consommateurs : pages `/informatique/*`, `lib/scheduled.ts` (tâches `informatique.cout-ia`, `informatique.rappels`).
