-- D3 (décision 0057) : le journal d'OBSERVATION de la garde (rien n'est bloqué, tout est compté). Additive, idempotente.
CREATE TABLE IF NOT EXISTS "ObservationAccesBase" (
  "id" TEXT NOT NULL,
  "jour" DATE NOT NULL,
  "base" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "geste" TEXT NOT NULL,
  "niveau" TEXT NOT NULL,
  "modeles" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "nombre" INTEGER NOT NULL DEFAULT 0,
  "dernierLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ObservationAccesBase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ObservationAccesBase_jour_base_userId_geste_key" ON "ObservationAccesBase"("jour", "base", "userId", "geste");
CREATE INDEX IF NOT EXISTS "ObservationAccesBase_base_jour_idx" ON "ObservationAccesBase"("base", "jour");
