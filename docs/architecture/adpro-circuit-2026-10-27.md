# Ad & Pro — le circuit du 27/10/2026 : prévalidation, postes, DG sur le total

> Décision de la Direction, validée sur l'artefact « Circuits Ad & Pro » (version 3), le 27/10/2026.
> Vaut pour le **sponsoring**, les **prises en charge nationales et internationales**, les **événements**
> et les demandes **« autre »**. Le matériel promotionnel et le consulting ne changent pas.

## Les trois phases

### 1. Prévalidation — le fond et le montant demandé, sans argent

| Créateur | Route |
|---|---|
| Délégué médical (« CAM »/KAM) | National Sales → Directeur des opérations → Direction Marketing |
| National Sales, Manager Promotion médicale, tout autre demandeur | Directeur des opérations → Direction Marketing |
| Directeur des opérations, DG, Direction, Super Admin | Direction Marketing |
| Direction Marketing | **prévalidée d'office** (dit au journal du circuit) |

- Le **DG n'est plus une étape du circuit** (l'étape `dg` est toujours dans le tamis).
- L'étape `final` est tenue par le rôle **`OPERATIONS_DIRECTOR`** (la migration garde `DIRECTION` à côté tant
  qu'aucun compte actif ne porte ce rôle — à retirer depuis Administration › Circuits ensuite).
- L'étape de la Direction Marketing **prévalide** : ni montant, ni catégorie, ni ordre de dépense global ; la
  déclaration d'information médicale part ici. Sponsoring → `PRE_VALIDATED` ; congrès / événement / autre →
  `APPROVED` (« prévalidée »).
- **Aucun poste, aucun budget, aucun engagement avant cette prévalidation.**

Code : `src/lib/workflow/parcours.ts` (`parcoursAdPro`), `origin.ts`, `defaults.ts`, `engine.ts`
(`ensureInstance`, `ouvrirLeCircuit`), migration `20270131130000_adpro_circuit_prevalidation`.

### 2. Postes — ajoutés par les parties prenantes, acceptés par la Direction Marketing

- Ajoutés après la prévalidation par la Direction Marketing, le Directeur des opérations, le demandeur, et le
  National Sales quand la demande vient d'un de ses délégués.
- **Un seul accord** : la Direction Marketing (montant + catégorie budgétaire). Sur une demande qu'elle a
  déposée, une **autre** personne de la Direction Marketing accepte (le Super Admin supplée).

Code : `src/lib/ad-pro/validation-poste.ts`, `poste-etapes.ts`, `src/lib/actions/ad-pro-item-actions.ts`.

### 3. Le DG valide le TOTAL, à la fin, au-dessus du seuil

- Total = **somme des postes de toute la demande** (accordé, sinon estimé ; refusés exclus) — la proposition
  réelle, pas le montant demandé. Seuil = **un seul réglage** (`AppSetting.adProDgThreshold`), strictement au-dessus.
- Porte fermée ⇒ **ni bon de commande, ni visa, ni paiement**. Le DG (rôle principal ou secondaire) ou le Super
  Admin « valide le total » ou « renvoie en révision » (motif), depuis la fiche ; le centre de validation liste
  les totaux en attente. **Une rallonge au-delà du total validé rouvre la porte.**

Code : `src/lib/seuils/porte-dg-total.ts` (règle pure), `src/lib/ad-pro/porte-dg.ts`,
`src/lib/actions/porte-dg-actions.ts`, `src/components/ad-pro/porte-dg-carte.tsx`, table `AdProPorteDg`
(migration `20270131140000_adpro_porte_dg_total`).

## Les 29 décisions de l'artefact — où elles sont

| # | Décision | Où |
|---|---|---|
| 1 | Tous les acteurs notifiés à la création, puis chacun à son tour | `ouvrirLeCircuit` (engine) |
| 2 | Un seul endroit pour le seuil DG, même sens partout | porte sur le total ; l'étape `dg` hors circuit |
| 3 | Estimation précise avant le DG | le DG valide le total réel des postes |
| 4 | Un seul montant comparé | `totalDeLaDemande` |
| 5 | Pas de devis/BC/ordre pour des personnes proposées | `src/lib/care-engagement.ts` (branche `adpro/pec-devis-montants`) |
| 6 | Plus d'ordre global | étape marketing sans `emitExpenseOrder` |
| 7 | Catégorie budgétaire sur l'ordre d'un devis PEC | `decideCareQuote` (même branche) |
| 9, 10, 21, 24, 26 | Catégorie vérifiée, libellé ISSUED, budget du matériel promo, centres DG+SA | branche `adpro/budget-centres` |
| 11, 19 | Aucun poste avant prévalidation ; événement sans circuit non payable | `refusAvantPrevalidation` |
| 12 | Appel pour toutes les natures | `faireAppelAdPro` + formulaire dans `WorkflowPanel` |
| 13, 14, 18, 22 | « Marquer réalisée », actions héritées d'Adam, événements externes, une seule réservation | branche `adpro/nettoyage-evenements` |
| 15 | DZD reste DZD, 1 USD = 240 DZD | branche `adpro/pec-devis-montants` |
| 17 | « Autre » suit le même circuit | catégorie de circuit `OTHER`, postes `AdProItem.otherRequestId` |
| 23 | Commentaires du schéma | `prisma/schema.prisma` |
| 25 | Une rallonge repasse par le DG | `etatPorteDg` |
| 28 | Transfert : route recalculée sur le créateur | `ad-pro-transfer-actions.ts` |
| 8, 16, 20, 27, 29 | Gardés tels quels | — |
