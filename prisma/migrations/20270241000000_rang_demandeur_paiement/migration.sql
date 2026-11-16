-- « Ma priorité » : la place choisie par le demandeur dans « Mes demandes » de paiement (10/11/2026).
ALTER TABLE "PaymentRequest" ADD COLUMN IF NOT EXISTS "rangDemandeur" INTEGER;
