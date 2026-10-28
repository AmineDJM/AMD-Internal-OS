-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Audit 27/10/2026, DONNEES-10 — UNE DEMANDE DE PAIEMENT, UNE AVANCE SUR SALAIRE : UN SEUL ORDRE VIVANT.
--
-- Vingt et un appelants de `createExpenseOrder` portent chacun leur garde anti-doublon ; deux l'avaient
-- manquée (DONNEES-02, DONNEES-08). La base porte désormais la garde pour les sources qui n'ont, par
-- construction, qu'un ordre vivant : la demande de paiement (`PaymentRequest.expenseOrderId` n'est jamais
-- remis à nul) et l'avance sur salaire (une décision, un ordre). Un ordre annulé libère la place.
--
-- PAS les autres sources : une pièce Legal se paie en parts (« part reçue » du matériel promotionnel), une
-- demande administrative peut porter plusieurs ordres, les devis de prise en charge en émettent un chacun
-- sous la même demande, la paie un par société. Une unicité brute y casserait des circuits légitimes.
--
-- Prudente : si des doublons vivants existent déjà (données d'avant la garde), l'index n'est PAS posé et la
-- migration le dit (NOTICE) au lieu d'échouer — le déploiement ne se bloque pas, les doublons se règlent à
-- la main, puis une migration suivante pose l'index. Idempotente (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT 1 FROM "ExpenseOrder"
    WHERE status <> 'CANCELLED' AND "sourceType" IN ('PAYMENT_REQUEST', 'SALARY_ADVANCE') AND "sourceId" IS NOT NULL
    GROUP BY "sourceType", "sourceId" HAVING count(*) > 1
  ) d;
  IF doublons > 0 THEN
    RAISE NOTICE 'ExpenseOrder_source_unique_vivant NON posé : % source(s) portent plusieurs ordres vivants — à régler avant de rejouer.', doublons;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseOrder_source_unique_vivant"
      ON "ExpenseOrder" ("sourceType", "sourceId")
      WHERE status <> 'CANCELLED' AND "sourceType" IN ('PAYMENT_REQUEST', 'SALARY_ADVANCE');
  END IF;
END $$;
