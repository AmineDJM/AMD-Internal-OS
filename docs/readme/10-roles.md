## 👤 Rôles

**19 rôles** métier. Le Super Admin attribue/retire tout via la **matrice d'accès** (`/admin/users/[id]`) ; les
libellés français viennent de `src/lib/labels.ts`.

| Rôle | Libellé | Portée typique |
|---|---|---|
| `SUPER_ADMIN` | Super Admin | Tout + administration (permissions, comptes, sécurité, IA, Brain, enveloppes budgétaires, Vue exacte). Compte **souverain**. **Seul compte qui pilote les missions et surveillances d'Adam** (`peutPiloterMissionsAdam`, décision de la Direction 09/2026) : Centre de missions, `run_mission`, `watch_entity`, interrupteur global. |
| `DIRECTION` | **Direction des opérations** | **Pair quasi-administrateur** : accès complet (gérer + valider) aux pôles, **vue globale** (`hasGlobalView`) donc supervision de toutes les demandes de validation. **Valide l'opération** dans le circuit Ad & Pro (étape « Validation (Direction des opérations) », sans chiffrer) et ne **tranche** que les demandes de rang 2 — Direction Marketing, Manager Promotion médicale —, dont elle fixe alors le montant et la sous-catégorie, hérités des étapes que la route n'atteint pas (`argentEffectif`, `lib/workflow/pouvoirs-argent.ts`) ; **siège au centre de paiement** (c'est le « PDG » du centre). Attribue les dépenses aux enveloppes. Restreignable par overrides. |
| `GENERAL_MANAGER` | **Directeur Général** | **Tous les pouvoirs métier** (gère et décide sur tous les pôles, signataire des circuits Ad & Pro) mais **délibérément hors vue globale** : il ne supervise **pas** les demandes de validation de tout le monde, et les modules **personnels** (Drive, directives, dossiers, support) restent cloisonnés. Administration, IA et Process Intelligence restent au seul Super Admin. |
| `OPERATIONS_DIRECTOR` | **Directeur des Opérations** | Rôle **à part**, pas une Direction au rabais : le pôle **Operations & Sales** — approvisionnement (**PCH**, **stocks**, dont la chaîne et le stock PCH central), **Cockpit Opérations** (`COCKPIT_OPERATIONS` VIEW), **Ventes PCH** (`PCH_VENTES` gérer : importer, rattacher), **Budget Operations & Sales** (`BUDGET_OPERATIONS` gérer) —, **moyens généraux**, **secrétariat**, Legal en contribution, le **stock promotionnel de ses équipes** et la **grille de coaching**. **Depuis le 08/10 il GÈRE la Force de vente et les Business Units** (`SALES_PLANNING` + `BUSINESS_UNITS` MANAGE, portée tout ; le Marketing cockpit reste en lecture) et ouvre **Adventum Brain borné à son périmètre** (`ADVENTUM_BRAIN` VIEW/UPDATE, `lib/adventum/perimetre.ts` : risques PCH, stocks, logistique, ventes, force de vente, terrain — ni briefing, ni question libre, ni seuils). **Tranche tout ce que le pharmacien responsable (PRIM) fait valider en Information médicale** (lecture « à déclarer ? », dépôt des bons de versement, validation finale qui émet l'ordre de dépense — refus motivé) et lit ce module en entier (`MEDICAL_INFO` lecture, portée tout ; `lib/medical-info/decideur.ts`, Direction 10/2026). **Lit** les bons de commande sans les signer, et ce dont il dépend — réglementaire, budgets, finances, RH — sans le piloter. Pas de vue globale ; les circuits Ad & Pro ne sont pas les siens. |
| `NATIONAL_SALES` | **National Sales** | **Toutes les capacités du délégué médical** + **approbation préliminaire** des demandes Ad & Pro / événements de ses KAM (approuver / refuser ; il ne désigne plus de référent Direction Marketing — les référents se configurent par gamme). Portée **ALL** pour voir toutes les demandes à instruire (le matériel promotionnel, lui, en portée « ses dossiers ») ; **pas** de décision (réservée à la Direction Marketing). |
| `MEDICAL_PROMOTION_MANAGER` | Manager Promotion Médicale | Promotion médicale, module Ad & Pro, **configuration de la force de vente** (donc des référents d'une gamme). Ne peut **pas** être désigné référent Direction Marketing : l'étape qui TRANCHE ne nomme que `PRODUCT_MANAGER`, et l'inscrire serait une attente sans pouvoir. N'assure **plus** l'étape préliminaire (désormais National Sales). |
| `HEAD_OF_REGULATORY` | Responsable Réglementaire | Regulatory (gestion complète + fournisseurs) ; le **Pipeline réglementaire** (`REGULATORY_PIPELINE`, mêmes gestes que Regulatory par défaut, plus la confidence du pipeline) ; **tient le Budget Regulatory** (08/10 : `BUDGET_REGULATORY` gérer — les BV 25 % / 75 % des dossiers). |
| `REGULATORY_ASSISTANT` | Assistante Réglementaire | Regulatory et Pipeline (lignes assignées) ; **lit** le Budget Regulatory (les BV). |
| `HEAD_OF_SALES` | Responsable Ventes | PCH, Stocks, **Ventes PCH en lecture** (l'ancienne saisie Ventes est retirée du service). |
| `SALES_USER` | Commercial | PCH en contribution (portée ALL), Stocks en lecture (le module Ventes est retiré du service). |
| `LOGISTICS_MANAGER` | Responsable Logistique | PCH, Stocks (la logistique est retirée du service). |
| `MEDICAL_DELEGATE` | Délégué Médical | Ses médecins, visites, demandes (scope **ASSIGNED**). Émetteur typique des demandes Ad & Pro / événements. Le KAM saisit à la visite d'un décideur le **besoin annuel du service** (son panel) ; il **supprime** ses plans de tournée encore en brouillon (09/10). |
| `PRODUCT_MANAGER` | **Direction Marketing** | **Tranche** toute demande Ad & Pro (« Gérer » les sept natures) : montant accordé et sous-catégorie ; pour un sponsoring, **pré-valide la tenue** puis **clôture**. Tient le **magasin central** du stock promotionnel (sa cheffe, lue sur l'organigramme), écrit les **articles du site**, lit la force de vente (en lecteur de pilotage : tous les KAM, lecture seule). **Tient le Marketing cockpit** (07/10 : `MARKETING_COCKPIT` VIEW/CREATE/UPDATE/DELETE/EXPORT par défaut, et autrice par défaut des messages — `promoMessageAuthorRoles`). **Tient le Budget Marketing** (08/10 : `BUDGET_MARKETING` gérer — crée, règle et consomme les enveloppes `domaine = MARKETING`, Ad & Pro compris, sans être listée enveloppe par enveloppe ; les listes d'accès restent au Super Admin) ; lit les **Ventes PCH**. |
| `BUSINESS_DEVELOPMENT_MANAGER` | Manager Business Development | **Explorateur produits** (Market Intelligence, son module d'origine, est retiré du service). |
| `FINANCE_BUDGET_MANAGER` | Responsable Finance / Budget | Finances, Budgets, ordres de dépense, **validations Finances** ; **lit** les trois budgets de pôle (Marketing, Regulatory, Operations & Sales). |
| `MEDICAL_INFO_PHARMACIST` | Pharmacien resp. information médicale | Déclaration réglementaire des événements validés (PRIM). |
| `DIRECTION_ASSISTANT` | **Assistante de Direction** | **Bureau du secrétariat** (gère les demandes, **retranscrit les devis** du matériel promotionnel ligne à ligne et pilote son exécution — BC, factures — **sans accès au module**). |
| `COORDINATOR` | Coordination / Coursier | **Missions chauffeur / courses** (adresse Maps, durée, retard) — espace restreint. |
| `VIEWER` | Lecteur | Lecture limitée. |

> Pense à créer au moins un **National Sales**, un **Direction Marketing** (à désigner ensuite référent d'au moins une gamme), un **Pharmacien information médicale**, une
> **Assistante de Direction** et un **Responsable Finance** pour que les circuits complets fonctionnent.
>
> **Défauts du 08/10** (tous réglables personne par personne dans la console) : **KPI & bilans** (`KPI`) est une porte
> accordée à **tous les rôles** (Voir/Créer/Modifier/Valider/Exporter) — le périmètre suit l'organigramme, jamais le rôle
> (`lib/kpi/droits.ts`) ; la **Direction** et le **Directeur Général** gèrent les trois budgets de pôle et Ventes PCH,
> et lisent le Cockpit Opérations ; **Business Units** revient par défaut à chaque rôle qui modifiait la Force de vente.
> (Retours & réclamations a été retiré le 09/10.)
>
> **Défauts du 09/10** : **Campagne budgétaire** (`BUDGET_CAMPAIGN`) — **Direction** et **DG** la pilotent, les
> **Finances** (`FINANCE_BUDGET_MANAGER`) la lisent, le **responsable de chaque département** prépare SON pôle par
> l'organigramme (accès implicite) ; la validation revient au comité nommé dans la campagne (défaut : **DG + Super
> Admin**), et le cadrage du DG reste invisible aux pôles. **Super Admin seul** : la console **Intelligence terrain**
> (`/admin/intelligence-terrain` — graphe d'influence, ROI Ad & Pro ; ni la Direction ni le DG) et le **contrôle de
> cohérence de l'organigramme** (corrections d'un clic). Le BC en brouillon se valide par **son demandeur** (ou le Super
> Admin), qui peut corriger le numéro NNN/DG/AAAA proposé.

---

