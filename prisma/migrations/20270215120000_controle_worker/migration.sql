-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Décision 0019 (Direction 30/10/2026) — LE CONTRÔLE AU DÉMARRAGE DU WORKER.
--
-- À chaque démarrage, le worker vérifie ce qu'il lui faut (variables d'environnement, moteur de conversion :
-- Python, tesseract ara/fra/eng, LibreOffice, polices) et en écrit le rapport ici : l'écran d'administration
-- (Diagnostic › Worker) le montre au Super Admin, en clair, sans ouvrir les journaux de Render.
-- Une ligne par service (« worker »). Aucune valeur de variable n'est stockée : seulement présente / absente.
--
-- ADDITIVE ET IDEMPOTENTE : une table neuve.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "ControleWorker" (
  "id"         TEXT NOT NULL,
  "detenteur"  TEXT NOT NULL,
  "verifieA"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "pret"       BOOLEAN NOT NULL DEFAULT false,
  "rapport"    JSONB NOT NULL,
  CONSTRAINT "ControleWorker_pkey" PRIMARY KEY ("id")
);
