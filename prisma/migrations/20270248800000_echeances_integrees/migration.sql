-- LES ÉCHÉANCES INTÉGRÉES AUX MODULES (Super Admin, 24/11/2026) — « réparti dans les modules, sans que ce soit visible ».
-- La fiche salarié porte déjà la fin de contrat et la période d'essai ; il lui manquait la PROCHAINE VISITE MÉDICALE DU
-- TRAVAIL (périodique). Saisie par les RH sur la fiche, elle remonte dans « Aujourd'hui » des RH et du N+1 à J-30.
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "prochaineVisiteMedicale" TIMESTAMP(3);
