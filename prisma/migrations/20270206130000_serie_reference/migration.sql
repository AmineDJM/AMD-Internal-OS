-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Audit 27/10/2026, DONNEES-12 et ADPRO-08 — LES SÉRIES DE RÉFÉRENCES ONT UN COMPTEUR.
--
-- Chaque création chargeait TOUTES les références de l'année (`findMany startsWith`) pour en tirer le maximum : un
-- coût qui croît toute l'année, et une référence REPRISE après une suppression réversible — la restauration
-- échouait alors (« une référence a été réutilisée depuis »). Une ligne par série (modèle, préfixe, année) porte le
-- dernier numéro, avancé atomiquement (`UPDATE … RETURNING`, ou `INSERT … ON CONFLICT` la première fois, amorcé au
-- maximum existant). Un numéro attribué ne revient jamais, même si la ligne est supprimée.
--
-- Additive et idempotente : une table neuve ; les lignes naissent au premier numéro de chaque série.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "SerieReference" (
  "cle"       TEXT NOT NULL,
  "dernier"   INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SerieReference_pkey" PRIMARY KEY ("cle")
);
