-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- LA VALIDITÉ DE LA DÉCISION D'ENREGISTREMENT (Super Admin, 24/11/2026).
--
-- « La décision d'enregistrement dure 5 ans. Quand on l'obtient, on dépose la décision et
-- l'attestation de prix dans Regulatory ; l'IA lit la date de début et de fin de validité, et
-- devine la fin (début + 5 ans) quand elle manque. Il faut une alerte sur le renouvellement. »
--
-- Les dates vivent sur le DOSSIER (RegulatoryProduct), pas dans une table de plus : c'est lui le
-- produit enregistré. Chaque date dit sa SOURCE (lue par l'IA, déduite +5 ans, saisie) : une date
-- devinée ne se lit pas comme une date imprimée. Le statut (valide / à renouveler / expirée) n'est
-- PAS stocké : il se calcule sur la date du jour, et un statut écrit serait faux le lendemain.
--
-- Idempotente : rejouable sans effet.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- La pièce typée « Attestation de prix », à côté de « Décision d'enregistrement » (déjà là).
ALTER TYPE "DocumentCategory" ADD VALUE IF NOT EXISTS 'PRICE_ATTESTATION';

ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationDecisionNumber" TEXT;
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationDecisionDate" TIMESTAMP(3);
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationDecisionSource" TEXT;
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationValidFrom" TIMESTAMP(3);
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationValidFromSource" TEXT;
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationValidUntil" TIMESTAMP(3);
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationValidUntilSource" TEXT;
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationConfirmedAt" TIMESTAMP(3);
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationConfirmedById" TEXT;
-- Les PROPOSITIONS de l'IA en attente d'une confirmation humaine (décision, attestation de prix).
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "registrationReading" JSONB;
-- Le dernier palier d'alerte envoyé (12, 6, 1 mois ; 0 = expirée) et la fin de validité qu'il visait :
-- une nouvelle décision (renouvellement) rouvre les paliers.
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "renewalAlertTier" INTEGER;
ALTER TABLE "RegulatoryProduct" ADD COLUMN IF NOT EXISTS "renewalAlertUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "RegulatoryProduct_registrationValidUntil_idx" ON "RegulatoryProduct"("registrationValidUntil");
