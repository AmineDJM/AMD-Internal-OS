-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Décision 0019 (suite, Direction 30/10/2026) — L'OCR « VISION » DES CONVERSIONS.
--
-- Une page scannée que tesseract lit mal (arabe vocalisé, scan dégradé) peut être transcrite par le modèle de vision
-- de l'Assistant IA — JAMAIS pour une pièce confidentielle, du coffre (identité, paie, RIB) ou d'un dossier RH.
-- COUPÉ par défaut : l'activer, et fixer son plafond mensuel en dollars, est une décision du Super Admin (écran IA).
--
-- ADDITIVE ET IDEMPOTENTE : deux colonnes à défaut.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AiSetting" ADD COLUMN IF NOT EXISTS "ocrVisionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiSetting" ADD COLUMN IF NOT EXISTS "ocrVisionPlafondUsd" DECIMAL(10,2) NOT NULL DEFAULT 20;
