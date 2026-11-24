-- « CE N'EST PAS UN CAS » (Visite médicale — interface du délégué, maquette VALIDÉE le 24/11/2026).
-- L'IA a relevé un possible cas de pharmacovigilance dans un compte rendu ; le délégué peut répondre qu'il n'en est pas
-- un. Sa réponse est TRACÉE (quand, par qui) et le superviseur la lit à la relecture — qui garde la priorité : un
-- humain tranche toujours. Deux colonnes nullables, sans relation (la convention de `notHeldById`, `reluParId`).
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "pvEcarteLe" TIMESTAMP(3);
ALTER TABLE "MedicalVisit" ADD COLUMN IF NOT EXISTS "pvEcarteParId" TEXT;
