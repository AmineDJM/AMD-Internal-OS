-- O1 (décision 0046) : l'orchestrateur de conversation — l'AGENDA d'un travail en cours (précisions qui changent le
-- résultat, partiels, étape suivante) et la VOIE PARALLÈLE du fil (une autre demande n'attend pas derrière un travail
-- long). Additive et idempotente.
CREATE TABLE IF NOT EXISTS "AssistantIaAgenda" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "filId" TEXT NOT NULL,
  "tourId" TEXT NOT NULL,
  "cle" TEXT NOT NULL,
  "nature" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "choix" JSONB,
  "etat" TEXT NOT NULL DEFAULT 'A_POSER',
  "reponse" TEXT,
  "change" BOOLEAN NOT NULL DEFAULT false,
  "precisionTourId" TEXT,
  "poseeLe" TIMESTAMP(3),
  "repondueLe" TIMESTAMP(3),
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaAgenda_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaAgenda_tourId_cle_key" ON "AssistantIaAgenda"("tourId", "cle");
CREATE INDEX IF NOT EXISTS "AssistantIaAgenda_filId_etat_idx" ON "AssistantIaAgenda"("filId", "etat");
CREATE INDEX IF NOT EXISTS "AssistantIaAgenda_userId_creeLe_idx" ON "AssistantIaAgenda"("userId", "creeLe");

ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "parallele" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "paralleleLe" TIMESTAMP(3);
