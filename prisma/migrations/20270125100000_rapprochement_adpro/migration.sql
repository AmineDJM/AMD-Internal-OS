-- Ad & Pro — LE RAPPROCHEMENT ASSISTÉ PAR LUNA (Direction, 14/10/2026) : dépenses hors postes et pièces de la plateforme
-- rattachées, après validation humaine, aux demandes du lot d'intégration 2026.
-- Additive et idempotente : deux tables neuves. Aucune ligne existante n'est réécrite ; le livre de trésorerie et les
-- ordres de dépense ne sont pas touchés.

-- ── 1. Les décisions (accepter, refuser, « pas Ad & Pro ») ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AdProRapprochement" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "sens" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceLibelle" TEXT NOT NULL,
    "montant" DECIMAL(14,2),
    "decision" TEXT NOT NULL,
    "demandeRowId" TEXT,
    "demandeType" TEXT,
    "demandeId" TEXT,
    "posteId" TEXT,
    "pieceCle" TEXT,
    "certitude" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "justification" TEXT NOT NULL DEFAULT '',
    "enveloppeSuggeree" TEXT,
    "lien" JSONB,
    "decideParId" TEXT,
    "decideLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "annuleLe" TIMESTAMP(3),
    "annuleParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdProRapprochement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdProRapprochement_lotId_sens_idx" ON "AdProRapprochement"("lotId", "sens");
CREATE INDEX IF NOT EXISTS "AdProRapprochement_source_idx" ON "AdProRapprochement"("source");
-- UNE DÉPENSE N'A QU'UN DESTIN ACTIF : rattachée à UNE demande, ou « pas Ad & Pro » — deux clics simultanés ne la
-- rattachent pas deux fois.
CREATE UNIQUE INDEX IF NOT EXISTS "AdProRapprochement_depense_active" ON "AdProRapprochement"("lotId", "source")
    WHERE "annuleLe" IS NULL AND "sens" = 'DEPENSE' AND "decision" IN ('ACCEPTEE', 'PAS_ADPRO');
-- UNE PIÈCE SE RATTACHE UNE FOIS À UNE MÊME DEMANDE.
CREATE UNIQUE INDEX IF NOT EXISTS "AdProRapprochement_piece_active" ON "AdProRapprochement"("lotId", "source", "demandeRowId")
    WHERE "annuleLe" IS NULL AND "sens" = 'PIECE' AND "decision" = 'ACCEPTEE';
DO $$ BEGIN
    ALTER TABLE "AdProRapprochement" ADD CONSTRAINT "AdProRapprochement_lotId_fkey"
        FOREIGN KEY ("lotId") REFERENCES "AdProIntegrationLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Ce que Luna a lu d'une pièce, une fois par empreinte ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AdProRapprochementLecture" (
    "id" TEXT NOT NULL,
    "empreinte" TEXT NOT NULL,
    "etat" TEXT NOT NULL,
    "raison" TEXT,
    "fournisseur" TEXT,
    "montant" DECIMAL(14,2),
    "date" TEXT,
    "numero" TEXT,
    "nature" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "motsCles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lectureId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "luParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdProRapprochementLecture_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdProRapprochementLecture_empreinte_key" ON "AdProRapprochementLecture"("empreinte");
