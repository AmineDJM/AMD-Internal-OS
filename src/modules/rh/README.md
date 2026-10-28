# Module `rh` — congés, paie, avances, notes de frais, documents RH, organisation (lot V4)

Le métier des Ressources humaines : la **fiche salarié**, les **congés** (fiche, circuit N+1 → RH → DG, file,
escalade, intérim désigné), la **paie** (coût, masse salariale, correction d'une ligne, virement — qui part au
**centre de paiement** des Finances comme une demande, jamais payé ici), les **avances sur salaire**, les
**demandes et documents RH** (attestation de travail générée, ordre de mission, entrevues, archives au Drive),
les **notes de frais**, et l'organisation lue par Mon Équipe (ligne hiérarchique, arbre, indicateurs).
Lit `coffre` (porte d'écriture : la double écriture des salaires, IBAN, NIN) et `referentiels` (`carte.ts`).

| Porte / dossier | Rôle |
|---|---|
| `partage.ts` | **Porte pure** (navigateur compris) : fiche de congé, circuit, absences, coût et masse de paie, état d'un virement, fenêtre d'une note de frais, visibilité d'un document, règles de l'attestation, ligne hiérarchique, KPI d'équipe |
| `api.ts` | **Porte serveur** : tout `partage.ts` + les écrivains (`createLeaveRequest`, `solderVirementPaie`, `archiveHrRequestIfDone`…), les dépôts (attestation, ordre de mission) et les lectures des écrans (`getRhData`, `getHrRequestQueue`, `getHrPulse`…) |
| `actions*.ts` | Les actions serveur, chacune sous sa **clé historique** (`src/lib/actions/parc.ts`) : `actions.ts` (`hr-actions` : fiche, congés, avances), `actions-documents.ts` (`hr-document-actions` : demandes, notes de frais, entrevues, attestation, OM), `actions-paie.ts` (`payroll-hr-actions`), `actions-interim.ts` (`stand-in-actions`), `actions-conges-discussion.ts` (`conge-discussion-actions`) |
| `domaine/` | règles pures + leurs tests ; `attestation-travail/regles`, `ordre-mission/constantes` |
| `infra/` | congés (`leave-core`, `conge-escalade`), paie (`paie-centre`, `salaires-partis`), dépôts (`attestation-travail-depot`, `ordre-mission-depot`, modèles `.docx`), archives, `requetes/` (lectures des écrans) |
| `ecrans/` | `hr-request-thread`, `hr-meeting-controls` (fil et entrevue d'une demande RH), montés par `/rh` et `/mon-dossier` |

- **Tables** : `Employee` (fiche RH), `LeaveRequest`, `SalaryAdvance`, `PayrollEntry`, `PayrollWire`,
  `HrDocumentRequest`, `EmployeeDocument`.
- **Données sensibles** : écrites par la double écriture du coffre (`@/modules/coffre/api`) ; DÉCHIFFRÉES
  seulement par les pages RH (`@/modules/coffre/api-lecture`) — aucune porte de ce module ne déchiffre.
- **Restent hors du module** (socle des droits, lus par `rbac.ts` et le coffre) : `lib/hr/stand-in`,
  `lib/hr/stand-in-resolve`, `lib/hr/confidentialite`. Le recrutement (`lib/recruitment/`) n'est pas couplé :
  il migrera seul. Les composants `components/hr/` et les pages `app/(app)/rh/` consomment les portes.
- **Dette héritée** (nommée dans `frontieres.test.ts`) : le centre de paiement (`lib/expense-orders`, cible
  `@/modules/finances/api`), les missions d'équipe (cible `@/modules/adpro/api`), l'organisation, les services
  transverses (notifications, Drive, stockage).
