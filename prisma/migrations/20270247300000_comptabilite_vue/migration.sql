-- COMPTABILITÉ — la facture du registre qui JUSTIFIE un paiement déjà fait (maquette validée, 24/11/2026 :
-- « Joindre un justificatif › une pièce déjà dans l'ERP », « Rattacher à un paiement fait »).
-- Un lien à part, et non `LegalDocument.settlementTxId` : celui-ci désigne l'écriture NÉE du règlement direct d'une
-- facture, et dé-marquer ce règlement dans Legal la retire du livre — un paiement réel (le règlement d'un ordre) n'a pas
-- à disparaître parce qu'on a corrigé une facture. UNIQUE : une facture ne justifie qu'un paiement.
-- Idempotente : chaque ordre se rejoue sans effet.

ALTER TABLE "FinanceTransaction" ADD COLUMN IF NOT EXISTS "justificatifFactureId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "FinanceTransaction_justificatifFactureId_key" ON "FinanceTransaction"("justificatifFactureId");
DO $$ BEGIN
  ALTER TABLE "FinanceTransaction" ADD CONSTRAINT "FinanceTransaction_justificatifFactureId_fkey"
    FOREIGN KEY ("justificatifFactureId") REFERENCES "LegalDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
