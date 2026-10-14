-- Budget Marketing — la dépense d'un poste Ad & Pro : imputée (engagée) puis, le cas échéant, annulée (Direction, 10/2026).
-- Consommée et payée se lisent sur l'ordre de dépense du poste : aucune colonne ne les recopie.
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "depenseImputeeLe" TIMESTAMP(3);
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "depenseImputeeParId" TEXT;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "depenseAnnuleeLe" TIMESTAMP(3);
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "depenseAnnuleeParId" TEXT;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "depenseAnnulationMotif" TEXT;
CREATE INDEX IF NOT EXISTS "AdProItem_depenseImputeeLe_idx" ON "AdProItem"("depenseImputeeLe");
