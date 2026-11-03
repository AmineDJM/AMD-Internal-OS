-- D4 (décision 0057) : l'interrupteur de l'application STRICTE de l'accès par base. Désactivé par défaut. Additive, idempotente.
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "accesBasesStrict" TEXT NOT NULL DEFAULT 'AUCUNE';
