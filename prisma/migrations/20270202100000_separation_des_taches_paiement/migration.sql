-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Audit 27/10/2026, ARGENT-06 — LA SÉPARATION DES TÂCHES AU CENTRE DE PAIEMENT.
--
-- Vrai (défaut) : celui qui a DEMANDÉ un paiement ne l'autorise pas au centre, et celui qui l'a
-- demandé ou autorisé ne le règle pas. Le Super Admin peut la suspendre (Réglages & diffusion) ;
-- le geste est journalisé. Décision de Direction appliquée dans sa forme la plus prudente.
--
-- Additive et idempotente : une colonne neuve, défaut posé sur la ligne existante.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "separationTachesPaiement" BOOLEAN NOT NULL DEFAULT true;
