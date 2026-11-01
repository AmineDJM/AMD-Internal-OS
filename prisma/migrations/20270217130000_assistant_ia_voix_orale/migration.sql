-- K9 (décision 0038) : la voix de l'Assistant IA entièrement orale — sessions vocales, travaux délégués suivis en
-- asynchrone, cartes conduites et confirmées à l'oral. Additive et idempotente.
CREATE TABLE IF NOT EXISTS "AssistantIaVoixSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversation" TEXT,
  "ouverteLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fermeeLe" TIMESTAMP(3),
  CONSTRAINT "AssistantIaVoixSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaVoixSession_userId_ouverteLe_idx" ON "AssistantIaVoixSession"("userId", "ouverteLe");

CREATE TABLE IF NOT EXISTS "AssistantIaVoixTravail" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "session" TEXT NOT NULL,
  "delegationId" TEXT,
  "conversation" TEXT NOT NULL,
  "tourId" TEXT NOT NULL,
  "remplacePar" TEXT,
  "annonceLe" TIMESTAMP(3),
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaVoixTravail_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaVoixTravail_userId_creeLe_idx" ON "AssistantIaVoixTravail"("userId", "creeLe");
CREATE INDEX IF NOT EXISTS "AssistantIaVoixTravail_session_idx" ON "AssistantIaVoixTravail"("session");

CREATE TABLE IF NOT EXISTS "AssistantIaVoixCarte" (
  "intentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "session" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "resume" TEXT NOT NULL,
  "resumeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resumeDitLe" TIMESTAMP(3),
  "champ" TEXT,
  "formulaire" JSONB,
  "etat" TEXT NOT NULL DEFAULT 'A_DIRE',
  "majLe" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantIaVoixCarte_pkey" PRIMARY KEY ("intentId")
);
CREATE INDEX IF NOT EXISTS "AssistantIaVoixCarte_session_idx" ON "AssistantIaVoixCarte"("session");
CREATE INDEX IF NOT EXISTS "AssistantIaVoixCarte_userId_resumeLe_idx" ON "AssistantIaVoixCarte"("userId", "resumeLe");
