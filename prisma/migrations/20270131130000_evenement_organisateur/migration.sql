-- LES ÉVÉNEMENTS AD & PRO SONT EXTERNES (Direction, 27/10) — voir src/lib/events/externe.ts.
--
-- L'ORGANISATEUR de l'événement (société savante, hôpital, laboratoire…). Additive et idempotente : une
-- colonne facultative, ajoutée si elle manque. Rien n'est supprimé : `capacity` et les valeurs d'état
-- d'organisation (PREPARATION, REGISTRATION_OPEN, FULL) restent en base, on cesse seulement de les écrire.
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "organizer" TEXT;
