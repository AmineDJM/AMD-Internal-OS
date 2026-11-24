-- LA DÉTECTION DE PHARMACOVIGILANCE DANS LES COMPTES RENDUS DE VISITE, ALLUMÉE (Super Admin, 24/11/2026).
-- Elle naissait coupée ; le Super Admin la veut active en production. La bascule reste dans les réglages IA :
-- l'éteindre là-bas tient, cette migration ne se rejoue pas.
ALTER TABLE "AiSetting" ALTER COLUMN "visitePvDetectionEnabled" SET DEFAULT true;
UPDATE "AiSetting" SET "visitePvDetectionEnabled" = true WHERE "visitePvDetectionEnabled" = false;
