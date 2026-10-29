-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Décision 0012 (Direction, 29/10/2026) — LES ACCÈS DE L'ASSISTANT IA, réglés dans la console.
--
-- Une ligne par cible (un rôle OU une personne) : les familles ouvertes et fermées à l'assistant ; le reste suit le
-- défaut (droits applicatifs, salaires et contrats fermés). Additive et idempotente : une table neuve, vide.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaAcces" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT,
  "role"        "UserRole",
  "ouvertes"    TEXT[] DEFAULT ARRAY[]::TEXT[],
  "fermees"     TEXT[] DEFAULT ARRAY[]::TEXT[],
  "updatedById" TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaAcces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaAcces_userId_key" ON "AssistantIaAcces"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaAcces_role_key" ON "AssistantIaAcces"("role");
