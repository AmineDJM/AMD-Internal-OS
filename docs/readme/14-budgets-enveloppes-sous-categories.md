## 💰 Budgets, enveloppes & sous-catégories

Le module **Budgets** est un vrai système de gestion budgétaire multi-niveaux, réparti sur **cinq onglets, un par
intention** — on ne consulte plus son budget en traversant tout ce qui le modifie :

| Écran | Route | Ce qu'on y fait |
|---|---|---|
| **Vue d'ensemble** | `/budgets` | **Que de la lecture.** Le reste à dépenser en grand, une jauge, un **camembert** de la répartition, une **courbe** de la consommation cumulée face au **rythme théorique**, des **barres** par catégorie. Aucun bouton d'action. |
| **Dépenses** | `/budgets/depenses` | **Le travail.** Ce qui est **à imputer** vient en premier (tant que ces lignes traînent, la vue d'ensemble est fausse), puis la saisie d'une dépense, puis l'historique. |
| **Départements** | `/budgets/departements` | **Le budget de chaque département**, par exercice — une ligne par nature (fonctionnement, masse salariale, activité, formation), chacune avec son responsable (voir [référence](#budgets-par-département--trois-natures-trois-responsables)). |
| **Business Units** | `/budgets/business-units` | **Le budget par gamme** : une Business Unit est un sous-département — son enveloppe et ses dépenses sont celles de son sous-département, lues gamme par gamme ; le consolidé est la somme des lignes affichées, et une gamme sans sous-département apparaît à zéro, signalée. |
| **Réglages** | `/budgets/reglages` | **Le paramétrage.** L'enveloppe, ses catégories et sous-catégories, le budget total au-dessus des enveloppes. |

> **Budgets des pôles (08/10)** : trois modules — **Budget Marketing** (`/budget-marketing`), **Budget Regulatory**
> (`/budget-regulatory`, BV 25 % / 75 % par dossier) et **Budget Operations & Sales** (`/budget-operations`, masse
> salariale de la force de vente) — lisent les MÊMES enveloppes, bornées à leur `domaine`. Budgets lit et additionne
> tout, mais une enveloppe de pôle s'y **lit sans se régler**. → [référence](#budgets-des-pôles--marketing-regulatory-operations--sales-0810)

> **Budget Marketing › Dépenses (10/2026, maquette validée)** — « on sépare une dépense engagée d'une dépense payée ».
> Un poste Ad & Pro dont **tous les BC sont signés** est **À imputer** ; la Direction Marketing l'**impute** à une
> catégorie d'une enveloppe MARKETING → **Engagée** (somme des BC signés) ; **Consommer** (montant ≤ engagé, facture
> facultative) crée l'ordre de dépense du poste, qui naît au **centre de paiement** puis va aux **Finances** →
> **Consommée** (lue sur l'ordre : centre de paiement / réponse attendue / refusée / chez les Finances) → **Payée** ;
> **Annuler** libère l'engagement (refusé une fois consommée). Le budget se **change à tout moment** (poste, ordres et
> écritures suivent, tracé ancien → nouveau). Tout geste passe par une seconde confirmation. Règle pure :
> `lib/budget/depense-poste.ts` ; lectures : `queries/budget-sources.ts` (`depensesDesPostes`, engagé ventilé
> `ENGAGE` / `EN_CIRCUIT`), `queries/budget-marketing-depenses.ts` ; gestes : `actions/budget-depense-poste-actions.ts` ;
> écran : `budgets/depenses-marketing.tsx`. Colonnes `AdProItem.depenseImputeeLe/…AnnuleeLe/…AnnulationMotif`
> (migration `20270123100000_depense_poste_budget_marketing`). Vue d'ensemble et Budgets : « engagé, pas encore payé »
> = engagé + consommé en circuit — même disponible que les tuiles (budget − engagé − consommé).

> **Intégration des dépenses réelles Ad & Pro 2026 (14/10/2026)** — une enveloppe Budget Marketing sur laquelle un lot
> d'intégration est validé se lit par UNE règle (`budget/integration-regle.ts`, lue par tous les lecteurs via
> `queries/budget-integration.ts`) : ses postes historiques (payés, à leur date, dans leur catégorie ou sous-catégorie),
> ce qui naît après l'intégration, jamais deux fois une dépense d'une demande intégrée ; ce qui comptait avant sans ligne
> au fichier se garde ou se sort. → [36-integration-depenses-adpro-2026.md](36-integration-depenses-adpro-2026.md)

La **barre de contexte** (`budget-context-bar.tsx`) ne porte que ce qui change ce qu'on **regarde** : l'enveloppe et
la période. Une **alerte actionnable** unique remplace l'ancienne section « dépenses non attribuées » dépliée.

**Lecture de la courbe** : le pointillé gris est le budget dépensé régulièrement sur la période. Au-dessus = on
dépense trop vite. `buildMonthlySeries` (pure, testée) couvre **tous** les mois de la période même vides, garantit un
cumul strictement croissant, et fait atterrir le rythme théorique **exactement** sur le budget au dernier mois.

- **Enveloppe budgétaire** — créée / modifiée / supprimée par le **Super Admin** (délégable via le droit
  `BUDGETS:DELETE`). Chaque enveloppe porte : une **période**, **un ou plusieurs modules rattachés**, un **montant
  total**, et ses **règles d'accès**.
- **Catégories & sous-catégories** — l'enveloppe se répartit en **catégories** (ex. « Événement », rattachée à un
  module pour l'attribution automatique), chacune pouvant contenir des **sous-catégories créées à la main**
  (ex. « Table ronde » sous « Événement »). Les sous-catégories sont une **répartition interne** : l'alloué de
  l'enveloppe ne compte que les catégories de tête.
- **Budget total (au-dessus des enveloppes)** — mode **FIXE** (montant figé par le Super Admin) ou **FLEXIBLE**
  (= somme automatique des enveloppes actives visibles).
- **Attribution automatique** — quand une dépense validée est **réglée** par les Finances, elle « tombe »
  automatiquement dans la **catégorie de tête** rattachée au **module** d'origine de la demande.
- **Vue consolidée « Total des enveloppes »** — un panneau affiche le **budget cumulé, l'alloué, le consommé et le
  reste de TOUTES les enveloppes accessibles**, plus le détail par enveloppe. Réservé au Super Admin et aux
  personnes/rôles autorisés (la vue n'agrège que ce qu'on a le droit de voir).
- **Contrôle d'accès par enveloppe** — le Super Admin ouvre une enveloppe en consultation **à des rôles** (ex.
  Direction des opérations) **et/ou à des personnes nommées** (`accessUserIds`). Un non-gestionnaire ne voit qu'une
  enveloppe qui lui est ouverte.
- **Santé** — barres **Maîtrisé / À surveiller / Dépassé** par catégorie, montant **non alloué**, dépenses **non
  attribuées** à réaffecter d'un clic.

---

