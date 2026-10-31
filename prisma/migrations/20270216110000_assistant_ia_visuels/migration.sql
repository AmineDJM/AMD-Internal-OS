-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Lot K2 (décision 0032, Direction 31/10/2026) — IMAGES, VIDÉOS ET VIDÉOS DE DONNÉES de l'Assistant IA.
--
-- Une table (l'état et le coût réel de chaque visuel, le fichier au Drive de la personne) et les réglages du Super
-- Admin (interrupteurs, plafonds mensuels en dollars, modèles, durée max d'une vidéo).
--
-- ADDITIVE ET IDEMPOTENTE.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaVisuel" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT,
  "nature" TEXT NOT NULL,
  "statut" TEXT NOT NULL DEFAULT 'EN_FILE',
  "titre" TEXT NOT NULL,
  "consigne" TEXT NOT NULL DEFAULT '',
  "spec" JSONB,
  "fournisseur" TEXT,
  "modele" TEXT,
  "travailExterne" TEXT,
  "progression" INTEGER NOT NULL DEFAULT 0,
  "driveNodeId" TEXT,
  "mime" TEXT,
  "octets" INTEGER,
  "secondes" DOUBLE PRECISION,
  "coutUsd" DOUBLE PRECISION,
  "erreur" TEXT,
  "notifie" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "termineLe" TIMESTAMP(3),
  CONSTRAINT "AssistantIaVisuel_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaVisuel_userId_createdAt_idx" ON "AssistantIaVisuel"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaVisuel_statut_createdAt_idx" ON "AssistantIaVisuel"("statut", "createdAt");

ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsImagesActives" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsImagesPlafondUsd" DOUBLE PRECISION NOT NULL DEFAULT 20;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsModeleImage" TEXT;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsVideosActives" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsVideosPlafondUsd" DOUBLE PRECISION NOT NULL DEFAULT 30;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsModeleVideo" TEXT;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsVideoSecondesMax" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "visuelsDonneesActives" BOOLEAN NOT NULL DEFAULT true;
