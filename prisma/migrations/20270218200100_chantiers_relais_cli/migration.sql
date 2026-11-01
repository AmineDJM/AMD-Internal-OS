-- C2 (décision 0041 § 3 bis) : la file d'ordres du relais Claude Code (CLI sur une machine de la Direction) et son battement.
CREATE TABLE IF NOT EXISTS "ClaudeRelaisOrdre" (
  "id" TEXT NOT NULL,
  "cleIdempotence" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "depot" TEXT,
  "branche" TEXT,
  "sessionCible" TEXT,
  "texte" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "statut" TEXT NOT NULL DEFAULT 'EN_ATTENTE',
  "sessionId" TEXT,
  "sessionUrl" TEXT,
  "erreur" TEXT,
  "missionId" TEXT,
  "expireLe" TIMESTAMP(3) NOT NULL,
  "prisLe" TIMESTAMP(3),
  "termineLe" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClaudeRelaisOrdre_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ClaudeRelaisOrdre_cleIdempotence_key" ON "ClaudeRelaisOrdre"("cleIdempotence");
CREATE INDEX IF NOT EXISTS "ClaudeRelaisOrdre_statut_createdAt_idx" ON "ClaudeRelaisOrdre"("statut", "createdAt");
CREATE INDEX IF NOT EXISTS "ClaudeRelaisOrdre_missionId_idx" ON "ClaudeRelaisOrdre"("missionId");
CREATE TABLE IF NOT EXISTS "ClaudeRelaisEtat" (
  "id" TEXT NOT NULL,
  "vuLe" TIMESTAMP(3) NOT NULL,
  "version" TEXT,
  "authMethod" TEXT,
  "connecte" BOOLEAN,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClaudeRelaisEtat_pkey" PRIMARY KEY ("id")
);
