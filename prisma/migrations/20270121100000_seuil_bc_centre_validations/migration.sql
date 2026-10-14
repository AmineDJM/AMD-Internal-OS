-- Seuil des bons de commande hors Ad & Pro, réglé depuis le centre de validations (Direction, 10/2026).
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "bcValidationThresholdCentre" DECIMAL(14,2) NOT NULL DEFAULT 0;
