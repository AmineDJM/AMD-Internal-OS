-- LE DEVIS DU MATÉRIEL PROMOTIONNEL AU REGISTRE LEGAL (Direction, 09/11/2026) : chaque devis retranscrit porte sa pièce Legal.
-- Additive et idempotente.
ALTER TABLE "PromoQuote" ADD COLUMN IF NOT EXISTS "legalDocumentId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PromoQuote_legalDocumentId_key" ON "PromoQuote"("legalDocumentId");
