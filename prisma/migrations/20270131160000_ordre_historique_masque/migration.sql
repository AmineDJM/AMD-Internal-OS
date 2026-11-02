-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Finances — VIDER L'HISTORIQUE DES RÈGLEMENTS MASQUE, IL NE SUPPRIME PLUS (audit argent 27/10/2026, ARGENT-01)
--
-- La purge supprimait les ordres réglés et annulés. Or un ordre réglé est un FAIT que d'autres lisent :
-- le payé / l'engagé d'un poste (Budget Marketing), la garde « un BV de cette nature à la fois », la paie.
-- Supprimé, le poste payé redevenait « engagé » (engagé fantôme) et pouvait être consommé une seconde
-- fois. La purge pose désormais une date de masquage, lue par le seul historique de l'écran.
--
-- Additive et idempotente.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "ExpenseOrder" ADD COLUMN IF NOT EXISTS "historiqueMasqueLe" TIMESTAMP(3);
