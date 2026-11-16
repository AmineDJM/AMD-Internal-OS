-- « AGIR COMME CET UTILISATEUR » (Direction, 16/11/2026) : un Super Admin agit au nom d'une personne pour simuler un parcours.
-- Chaque trace de ces gestes garde le Super Admin réel — montré à lui seul — et chaque geste s'annule depuis le journal.
-- Additive et idempotente.

ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "parVueExacteId" TEXT;
CREATE INDEX IF NOT EXISTS "AuditLog_parVueExacteId_idx" ON "AuditLog"("parVueExacteId");

ALTER TABLE "AssistantGesteJournal" ADD COLUMN IF NOT EXISTS "parVueExacteId" TEXT;
CREATE INDEX IF NOT EXISTS "AssistantGesteJournal_parVueExacteId_creeLe_idx" ON "AssistantGesteJournal"("parVueExacteId", "creeLe" DESC);
