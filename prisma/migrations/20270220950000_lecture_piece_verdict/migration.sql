-- Lot B1 (décision 0049) : le verdict d'une lecture de pièce commerciale, calculé par invariants. Additif, idempotent.
ALTER TABLE "LecturePiece" ADD COLUMN IF NOT EXISTS "verdict" TEXT;
ALTER TABLE "LecturePiece" ADD COLUMN IF NOT EXISTS "verdictDetail" JSONB;
