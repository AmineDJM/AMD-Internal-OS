-- Direction, 03/11/2026 : la fenêtre d'annulation passe de 120 s à 30 s par défaut.
-- Additive et idempotente : le défaut de la colonne change ; le réglage enregistré n'est ramené à 30 s QUE s'il est
-- encore à l'ancien défaut (120) — une valeur choisie par le Super Admin est gardée.
ALTER TABLE "AssistantIaReglage" ALTER COLUMN "fenetreAnnulationSecondes" SET DEFAULT 30;
UPDATE "AssistantIaReglage" SET "fenetreAnnulationSecondes" = 30 WHERE "fenetreAnnulationSecondes" = 120;
