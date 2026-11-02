-- Migration : 20270226000000_devis_non_retenu
-- Un devis de poste Ad & Pro qui n'a pas été choisi se marque « non retenu » au dépôt du bon de commande
-- SIGNÉ du poste : la date, et la personne qui a validé l'offre retenue. Deux colonnes, nulles tant que
-- le poste n'a pas de BC signé (et de nouveau nulles si ce BC est annulé).
-- Idempotente : rejouable sans effet.

ALTER TABLE "AdProItemPiece" ADD COLUMN IF NOT EXISTS "nonRetenuAt" TIMESTAMP(3);
ALTER TABLE "AdProItemPiece" ADD COLUMN IF NOT EXISTS "nonRetenuParId" TEXT;
