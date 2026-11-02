# Module `ad-pro` — sponsoring, congrès, événements, « autres », prise en charge, postes (métier, lot V4)

Le pôle Ad & Pro : une **demande** (sponsoring, congrès national ou international, événement, demande
« autre », dossier de matériel promotionnel) passe son circuit, porte des **postes** (devis → BC →
facture → paiement), franchit la **porte du DG** sur son total et le **centre de validation**, puis se
**clôture**. Les congrès emmènent des professionnels : la **prise en charge** (une fiche par personne,
ses pièces, ses cases, ses devis). Lit `referentiels` (double écriture des personnes) et `finances` (ordres de dépense, révision et annulation d'un ordre, statuts qu'un règlement solde — jamais l'inverse) (`carte.ts`).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** : natures et états (`unified`), postes (`breakdown`, `canEmitOrder`…), centre (`siegeAuCentreAdPro`, `trierCentre`), clôture d'un sponsoring, voyageurs / hébergements, prise en charge, événements (statut, portée de modification), correction d'une demande |
| `api.ts` | **Porte serveur** : tout `partage` + visa du centre, porte du DG, BC des postes (`genererLesBCsDuPoste`, `bcEtablisDuPoste`), pièces des postes, fil, lectures des écrans (`infra/requetes/*`) |
| `actions-*.ts` | Les actions serveur, chacune sous sa **clé historique** (`src/lib/actions/parc.ts`) — voir ci-dessous |
| `domaine/` | Règles pures + tests ; `prise-en-charge/` (fiches, pièces, règles), `evenements/` (statut, modification, externe) |
| `infra/` | Prisma, fichiers, modèle : visa, porte DG, BC, pièces, fiches ; `requetes/` (lectures des écrans), `postes/commun.ts` et `prise-en-charge/actions-commun.ts` (socles privés des actions découpées), tests de bout en bout |
| `ecrans/` | Composants des fiches (postes, devis / BC, facture, voyageurs, hébergements, pièces, discussion) ; `postes/` (la carte d'un poste et ses formulaires), `prise-en-charge/` |

- **Actions** (clé → fichier) : `ad-pro-item-actions` → `actions-postes.ts` + `actions-postes-{decision,paiement,materiel,voyageurs,lignes}.ts`
  (une clé, six morceaux : `parc.ts` les déclare ensemble) ; `care-actions` → `actions-prise-en-charge{,-logistique}.ts` ;
  `sponsoring-actions`, `congress-request-actions` (`actions-congres`), `congress-beneficiary-actions`, `event-actions`
  (`actions-evenements`), `ad-pro-{centre,conseil,discussion,edit,medecins,other,pieces,postes-luna,transfer}-actions`,
  `ad-pro-rattacher-legal`.
- **Tables** : voir l'en-tête de `api.ts` (demandes, postes, prise en charge, portes).
- **Hors du module** (prochains lots) : le stock et le circuit du matériel promotionnel (`lib/promo/`,
  `lib/promo-material/`), le consulting (pôle partagé avec les RH), l'intégration des dépenses 2026
  (budget marketing), le ROI (intelligence terrain), les opérations d'Adam (`lib/agent/operations/adpro-*`).
  Le seuil de la porte du DG (`lib/seuils/ad-pro.ts`) et les adresses (`lib/chemins/ad-pro.ts`, dont le parent
  d'un poste) restent au socle : d'autres couches les lisent sans avoir le droit de lire un métier.
- **Dette héritée** (nommée dans `frontieres.test.ts`) : les écrivains que le module appelle chez leurs
  domaines — bons de commande, circuit de validation, stock promotionnel, ordres de dépense et règlement
  (Finances), pièces et Drive, droits par enregistrement.
