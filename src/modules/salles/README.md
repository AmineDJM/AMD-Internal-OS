# Module « salles » — les salles de réunion et leurs réservations (lot T3, décision 0051)

Les salles (capacité) et leurs RÉSERVATIONS, ouvertes à **tous les employés** (Direction, 02/11/2026) : un créneau ne se
réserve qu'une fois (jamais deux réservations confirmées qui se chevauchent), la capacité est contrôlée, l'annulation
est réversible. Aucun autre module de réservation de salle n'existait (les « salles » des réunions sont des liens Jitsi).

| Porte | Contenu |
|---|---|
| `partage.ts` | règles pures : `lireCreneau` (heure d'Algérie), `libelleInstant`, natures réservables |
| `api.ts` | serveur : `conflitsDeReservation`, `sallesEtReservations` (l'écran `/salles`) |
| `actions.ts` | `creerMoyenGeneral` (une SALLE, droit de créer « Moyens généraux »), `modifierMoyenGeneral`, `archiverMoyenGeneral`, `reserverMoyenGeneral` (tout employé), `annulerReservationMoyenGeneral` (qui a réservé, ou l'équipe) — clé historique `moyens-generaux-registre-actions` |

**Historique.** Le module est né « registre des moyens généraux » (véhicules, assurances, contrats, entretiens). La
Direction a tranché le 02/11 : chez Adventum, « moyens généraux » désigne la **caisse d'avance** tenue par l'assistante de
direction (`src/lib/actions/petty-cash-actions.ts`, écran `/moyens-generaux`). Le registre a été retiré de l'assistant,
du banc et des écrans ; les tables `MoyenGeneral` / `MoyenGeneralReservation` restent en place (aucune migration
destructive) et ne servent plus qu'aux salles — les autres natures y sont inertes.
