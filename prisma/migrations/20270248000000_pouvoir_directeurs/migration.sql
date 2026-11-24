-- POUVOIR DES DIRECTEURS (Super Admin, 24/11/2026) — les formations passent par l'autorisation du Directeur des opérations.
-- Additive et idempotente : une valeur d'énumération ajoutée et trois colonnes facultatives ne touchent aucune ligne.
-- Les formations restées « chez le DG » ne sont PAS réécrites : le code les lit à la nouvelle marche (`etapeDeFormation`),
-- l'historique (colonnes `dg*`) reste tel quel.
ALTER TYPE "LeaveStage" ADD VALUE IF NOT EXISTS 'OPERATIONS';

ALTER TABLE "Training" ADD COLUMN IF NOT EXISTS "opsDecidedById" TEXT;
ALTER TABLE "Training" ADD COLUMN IF NOT EXISTS "opsDecidedAt" TIMESTAMP(3);
ALTER TABLE "Training" ADD COLUMN IF NOT EXISTS "opsNote" TEXT;
