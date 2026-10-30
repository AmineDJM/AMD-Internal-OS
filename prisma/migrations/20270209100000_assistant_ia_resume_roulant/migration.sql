-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J4 (décision 0018) — LE RÉSUMÉ ROULANT DU FIL de l'Assistant IA.
--
-- La conversation au modèle = les derniers échanges mot pour mot + le résumé de ce qui précède. Le résumé est
-- gardé sur le fil (régénéré par le modèle « rapide » quand assez d'échanges sont sortis de la fenêtre), avec la
-- date du dernier tour qu'il couvre : relancer la compaction sans nouveau tour ne refait rien (idempotence).
-- Aucune valeur sensible : le texte résumé a passé le filtre (repères ⟦Sn⟧ seulement), le résumé le repasse.
--
-- ADDITIVE ET IDEMPOTENTE : trois colonnes nullables. « Nouvelle conversation » les remet à NULL.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "resume"        TEXT;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "resumeJusquA"  TIMESTAMP(3);
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "resumeLe"      TIMESTAMP(3);
