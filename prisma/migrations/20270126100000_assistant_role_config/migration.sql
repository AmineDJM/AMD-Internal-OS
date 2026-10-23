-- Migration : 20270126100000_assistant_role_config
-- Jalon 4 (Décisions Q4 & Q12) : Configuration par rôle de l'Assistant IA + traçabilité

CREATE TABLE IF NOT EXISTS "AssistantRoleConfig" (
    "role" "UserRole" NOT NULL,
    "assistantName" TEXT,
    "tone" TEXT,
    "customInstructions" VARCHAR(2000),
    "allowedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmationLevel" TEXT NOT NULL DEFAULT 'CRITIQUE',
    "enforcedModel" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    CONSTRAINT "AssistantRoleConfig_pkey" PRIMARY KEY ("role")
);

CREATE TABLE IF NOT EXISTS "AssistantRoleConfigAudit" (
    "id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "actorId" TEXT NOT NULL,
    "previousData" JSONB,
    "newData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantRoleConfigAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantRoleConfigAudit_role_createdAt_idx" ON "AssistantRoleConfigAudit"("role", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantRoleConfigAudit_actorId_idx" ON "AssistantRoleConfigAudit"("actorId");

DO $$ BEGIN
    ALTER TABLE "AssistantRoleConfig" ADD CONSTRAINT "AssistantRoleConfig_updatedById_fkey"
        FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AssistantRoleConfigAudit" ADD CONSTRAINT "AssistantRoleConfigAudit_role_fkey"
        FOREIGN KEY ("role") REFERENCES "AssistantRoleConfig"("role") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AssistantRoleConfigAudit" ADD CONSTRAINT "AssistantRoleConfigAudit_actorId_fkey"
        FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
