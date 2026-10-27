-- Migration : 20270131140000_adpro_porte_dg_total
-- Ad & Pro — la porte du DG sur le TOTAL d'une demande (Direction, 27/10/2026). Une ligne par demande.
-- Additive et idempotente : rejouable sans erreur ; aucune table existante touchée.

CREATE TABLE IF NOT EXISTS "AdProPorteDg" (
    "id" TEXT NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "statut" TEXT,
    "montant" DECIMAL(14,2),
    "note" TEXT,
    "decideParId" TEXT,
    "decideLe" TIMESTAMP(3),
    "signaleMontant" DECIMAL(14,2),
    "signaleLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdProPorteDg_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AdProPorteDg_entityType_entityId_key" ON "AdProPorteDg"("entityType", "entityId");
