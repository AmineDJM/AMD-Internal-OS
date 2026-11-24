-- JUSTIFICATIF OBLIGATOIRE (Super Admin, 24/11/2026) : « Chaque paiement de n'importe quoi doit avoir une justification —
-- facture, proforma, lettre de demande, fiche de paie… Tant qu'il n'y a pas de justificatif, ca ne va meme pas au centre de
-- paiement, donc pas aux Finances. »
--
-- 1. LES NATURES DE PIECE qui manquaient au dossier de paiement. Ajoutees seulement : aucune n'est utilisee ici (Postgres refuse
--    d'employer une valeur d'enum dans la transaction qui la cree).
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'PROFORMA';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'REQUEST_LETTER';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'PAYROLL_STATE';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'PAYSLIP';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'PAYMENT_RECEIPT';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'CASH_VOUCHER';
ALTER TYPE "PaymentPieceKind" ADD VALUE IF NOT EXISTS 'DECLARATION';

-- 2. L'ORDRE NE SOUS LA REGLE. Les ordres d'avant la bascule gardent `false` : ils continuent leur circuit sans etre bloques
--    retroactivement (ni au centre, ni au reglement) — le centre les signale « sans justificatif » quand c'est le cas. Tout ordre
--    cree ensuite porte `true`, et le reglement exige alors son justificatif. L'etat « en attente du justificatif » n'a pas
--    besoin de colonne : `centralStatus` est une chaine (`AWAITING_PROOF`).
ALTER TABLE "ExpenseOrder" ADD COLUMN IF NOT EXISTS "justificatifExige" BOOLEAN NOT NULL DEFAULT false;
