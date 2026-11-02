-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J9 (décision 0021) — LE GRAPHE DE L'ENTREPRISE ET LES FAITS DATÉS.
--
-- Un fait confirmé était déjà clos plutôt qu'effacé (`actif = false`, `valideAu`), mais `valideAu` servait à la fois
-- de fin de VALIDITÉ (quand ce n'était plus vrai) et de fin de CONSTAT (quand on a cessé de le tenir pour vrai), et
-- rien ne disait qui l'avait fermé ni par quoi il était remplacé. Trois colonnes nullables le disent désormais :
--   fermeLe        le temps de constat de la fermeture (≠ valideAu, le temps de validité) ;
--   fermeParId     qui l'a fermé (la personne qui a confirmé le remplaçant ; nul pour un passage d'office) ;
--   remplaceParId  le fait confirmé qui le remplace.
-- Un index (sujet, début de validité) sert « l'état d'une entité à une date » ; deux index servent le parcours du
-- graphe depuis une personne (demandeur, responsable d'un événement).
--
-- ADDITIVE ET IDEMPOTENTE : colonnes nullables, index « IF NOT EXISTS ». Les fermetures déjà écrites gardent
-- `fermeLe = NULL` (leur temps de constat est inconnu : on ne l'invente pas).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "FaitConfirme" ADD COLUMN IF NOT EXISTS "fermeLe"       TIMESTAMP(3);
ALTER TABLE "FaitConfirme" ADD COLUMN IF NOT EXISTS "fermeParId"    TEXT;
ALTER TABLE "FaitConfirme" ADD COLUMN IF NOT EXISTS "remplaceParId" TEXT;

CREATE INDEX IF NOT EXISTS "FaitConfirme_sujetType_sujetId_valideDu_idx" ON "FaitConfirme" ("sujetType", "sujetId", "valideDu");
CREATE INDEX IF NOT EXISTS "Event_requesterId_idx" ON "Event" ("requesterId");
CREATE INDEX IF NOT EXISTS "Event_responsibleId_idx" ON "Event" ("responsibleId");
