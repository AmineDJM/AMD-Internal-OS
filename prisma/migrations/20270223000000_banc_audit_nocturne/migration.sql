-- Lot Q1 (décision 0050) : le banc programmé de l'Assistant IA porte le banc d'audit (attaques, tâches) et tourne
-- CHAQUE NUIT. Le défaut de la colonne change ; le réglage existant n'est basculé que s'il est encore le défaut
-- d'origine, jamais touché par un Super Admin (`updatedById` nul) — un choix fait à l'écran est respecté. Idempotent.
ALTER TABLE "AssistantIaBancReglage" ALTER COLUMN "frequence" SET DEFAULT 'QUOTIDIEN';
UPDATE "AssistantIaBancReglage"
   SET "frequence" = 'QUOTIDIEN'
 WHERE "id" = 'global' AND "frequence" = 'HEBDOMADAIRE' AND "jour" = 5 AND "heure" = 3 AND "plafondUsd" = 1 AND "updatedById" IS NULL;
