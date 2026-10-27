-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Ad & Pro — LA DEMANDE « AUTRE » SUIT LE CIRCUIT COMMUN (Direction, 27/10/2026, décision #17)
--
-- Son statut est désormais PROJETÉ par le moteur de circuit (catégorie `OTHER`, entité
-- `AD_PRO_OTHER`). Le renvoi pour correction (« à corriger », chez le demandeur) a besoin d'un nom
-- à lui, comme au sponsoring et aux prises en charge : ni « en attente de décision » (personne ne
-- décide), ni « brouillon » (la demande a déjà été soumise et a un historique), ni « refusée ».
--
-- Additive et idempotente. La définition de circuit `OTHER` n'est PAS semée ici : le moteur la sème
-- à la première demande (`getDefinition`), depuis la même graine que les quatre autres natures.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TYPE "AdProOtherStatus" ADD VALUE IF NOT EXISTS 'RETURNED';
