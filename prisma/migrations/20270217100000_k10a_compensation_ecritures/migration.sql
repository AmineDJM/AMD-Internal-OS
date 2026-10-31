-- K10a (décision 0035) — une écriture de trésorerie ne s'efface jamais : on la COMPENSE.
-- `compensationDeId` lie l'écriture inverse (contre-passation) ou l'écriture « à récupérer » à celle qu'elle compense ;
-- `compensation` dit laquelle des deux. Additive et idempotente.
ALTER TABLE "FinanceTransaction" ADD COLUMN IF NOT EXISTS "compensationDeId" TEXT;
ALTER TABLE "FinanceTransaction" ADD COLUMN IF NOT EXISTS "compensation" TEXT;
CREATE INDEX IF NOT EXISTS "FinanceTransaction_compensationDeId_idx" ON "FinanceTransaction"("compensationDeId");
DO $$ BEGIN
  ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_compensationDeId_fkey"
    FOREIGN KEY ("compensationDeId") REFERENCES "FinanceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
