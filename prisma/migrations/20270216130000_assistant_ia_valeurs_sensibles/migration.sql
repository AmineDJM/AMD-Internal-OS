-- Décision 0034 (Direction, 31/10/2026) : les valeurs sensibles vont au modèle EN CLAIR pour qui a le droit de les voir
-- (défaut), ou MASQUÉES en repères ⟦Sn⟧ (décision 0012). Additive et idempotente.
ALTER TABLE "AssistantIaReglage" ADD COLUMN IF NOT EXISTS "valeursSensibles" TEXT NOT NULL DEFAULT 'EN_CLAIR';
