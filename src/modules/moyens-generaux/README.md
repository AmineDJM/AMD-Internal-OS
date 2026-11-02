# Module « moyens-generaux » — le registre des moyens généraux (lot T3, décision 0051)

Ce que la maison possède, loue ou assure, et ses ÉCHÉANCES : véhicules, assurances (rattachées à leur véhicule),
contrats de prestataires, entretiens, salles (capacité), équipements, fournitures — et les RÉSERVATIONS de salles et de
véhicules (jamais deux réservations confirmées qui se chevauchent). Les dépenses et la caisse restent dans l'écran
historique `/moyens-generaux` (`src/lib/general-means/`).

| Porte | Contenu |
|---|---|
| `partage.ts` | règles pures : `lireTypeMoyen`, `etatEcheance`, `joursAvant`, `chevauche`, `lireCreneau` (heure d'Algérie), libellés |
| `api.ts` | serveur : `conflitsDeReservation`, `registreEtReservations` (l'écran) |

Modèles `MoyenGeneral`, `MoyenGeneralReservation` (migration `20270225100000_registre_moyens_generaux`). Écritures :
`src/modules/moyens-generaux/actions.ts` (droit `GENERAL_MEANS` ; chaque action `actionReversible` et
déclarée dans `src/lib/effets/declarations/metiers.ts`). Écran : `/moyens-generaux/registre`. Assistant IA :
`enregistrer_moyen_general`, `reserver_moyen_general`, `lire_moyens_generaux`.
