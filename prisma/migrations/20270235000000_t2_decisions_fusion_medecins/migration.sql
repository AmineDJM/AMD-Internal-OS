-- Lot T2 (décision 0062) : la décision du Super Admin sur une paire de fiches médecins en double (✓ fusionnée, ✗ écartée).
-- Additive et idempotente.
CREATE TABLE IF NOT EXISTS "DecisionFusionMedecin" (
  "id" TEXT NOT NULL,
  "cle" TEXT NOT NULL,
  "medecinAId" TEXT NOT NULL,
  "medecinBId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "empreinte" TEXT NOT NULL,
  "gardeId" TEXT,
  "decideParId" TEXT,
  "decideLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionFusionMedecin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionFusionMedecin_cle_key" ON "DecisionFusionMedecin"("cle");
CREATE INDEX IF NOT EXISTS "DecisionFusionMedecin_decision_idx" ON "DecisionFusionMedecin"("decision");
