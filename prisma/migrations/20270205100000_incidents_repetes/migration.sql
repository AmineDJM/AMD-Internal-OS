-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Lot V3-E « Fiabilité » — LES ERREURS RÉPÉTÉES REMONTENT AU SUPER ADMIN.
--
-- Une ligne par événement du journal unique (`src/lib/journal.ts`) qui a échoué. Chaque processus
-- (web, worker) y VERSE ses compteurs à chaque passage des tâches de fond ; la tâche
-- `observabilite.incidents` envoie UNE notification agrégée quand un événement dépasse le seuil
-- dans sa fenêtre, puis se tait jusqu'au rappel. Lue par le Diagnostic.
--
-- Additive et idempotente : une table neuve, rien n'est modifié ni effacé.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "IncidentRepete" (
  "evenement"      TEXT NOT NULL,
  "total"          INTEGER NOT NULL DEFAULT 0,
  "fenetreDebut"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "compteFenetre"  INTEGER NOT NULL DEFAULT 0,
  "premierA"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dernierA"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dernierMessage" TEXT,
  "notifieA"       TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentRepete_pkey" PRIMARY KEY ("evenement")
);

CREATE INDEX IF NOT EXISTS "IncidentRepete_dernierA_idx" ON "IncidentRepete"("dernierA");
