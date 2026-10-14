-- Ad & Pro — L'INTÉGRATION DES DÉPENSES RÉELLES 2026 (Direction, 10/2026 — maquette « adpro-integration » validée).
-- Additive et idempotente : trois tables neuves, des colonnes facultatives sur les postes, deux porteurs de postes de plus
-- (dossier de matériel promotionnel, déclaration d'information médicale) et la contrainte « un seul parent » qui les compte.
-- Aucune ligne existante n'est réécrite ; le livre de trésorerie et les ordres de dépense ne sont pas touchés.

-- ── 1. Le lot ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AdProIntegrationLot" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "configVersion" TEXT NOT NULL,
    "fichierNom" TEXT NOT NULL,
    "fichierSha256" TEXT NOT NULL,
    "fichierDocumentId" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "integreLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creeParId" TEXT,
    "annuleLe" TIMESTAMP(3),
    "annuleParId" TEXT,
    "annulationMotif" TEXT,
    "instantaneAvant" JSONB NOT NULL,
    "lignes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdProIntegrationLot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AdProIntegrationLot_envelopeId_idx" ON "AdProIntegrationLot"("envelopeId");
CREATE INDEX IF NOT EXISTS "AdProIntegrationLot_annuleLe_idx" ON "AdProIntegrationLot"("annuleLe");
-- UN SEUL LOT ACTIF PAR ENVELOPPE : deux validations simultanées ne peuvent pas intégrer deux fois le même fichier.
CREATE UNIQUE INDEX IF NOT EXISTS "AdProIntegrationLot_actif" ON "AdProIntegrationLot"("envelopeId") WHERE "annuleLe" IS NULL;
DO $$ BEGIN
    ALTER TABLE "AdProIntegrationLot" ADD CONSTRAINT "AdProIntegrationLot_envelopeId_fkey"
        FOREIGN KEY ("envelopeId") REFERENCES "BudgetEnvelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Les demandes touchées par un lot ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AdProIntegrationDemande" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "ligne" INTEGER NOT NULL,
    "lignes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "libelle" TEXT NOT NULL,
    "demandeType" TEXT NOT NULL,
    "demandeId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "demandeurAffiche" TEXT,
    "montant" DECIMAL(14,2) NOT NULL,
    "piecesAttendues" JSONB NOT NULL DEFAULT '[]',
    "piecesRattachees" JSONB NOT NULL DEFAULT '[]',
    "ecritureId" TEXT,
    "avant" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdProIntegrationDemande_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdProIntegrationDemande_lotId_ligne_key" ON "AdProIntegrationDemande"("lotId", "ligne");
CREATE INDEX IF NOT EXISTS "AdProIntegrationDemande_demandeType_demandeId_idx" ON "AdProIntegrationDemande"("demandeType", "demandeId");
DO $$ BEGIN
    ALTER TABLE "AdProIntegrationDemande" ADD CONSTRAINT "AdProIntegrationDemande_lotId_fkey"
        FOREIGN KEY ("lotId") REFERENCES "AdProIntegrationLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. « Dans la plateforme, absentes du fichier » : garder ou sortir ───────────────────────────────
CREATE TABLE IF NOT EXISTS "AdProIntegrationDecision" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "cleSource" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "montant" DECIMAL(14,2) NOT NULL,
    "decideParId" TEXT,
    "decideLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdProIntegrationDecision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdProIntegrationDecision_lotId_cleSource_key" ON "AdProIntegrationDecision"("lotId", "cleSource");
DO $$ BEGIN
    ALTER TABLE "AdProIntegrationDecision" ADD CONSTRAINT "AdProIntegrationDecision_lotId_fkey"
        FOREIGN KEY ("lotId") REFERENCES "AdProIntegrationLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "AdProIntegrationDecision" ADD CONSTRAINT "AdProIntegrationDecision_choix"
        CHECK ("decision" IN ('GARDER', 'SORTIR'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Les postes historiques ─────────────────────────────────────────────────────────────────────
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "historiqueLotId" TEXT;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "historiqueLigne" INTEGER;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "montantPayeHistorique" DECIMAL(14,2);
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "historiquePayeLe" TIMESTAMP(3);
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "historiqueAvant" JSONB;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "promoMaterialParentId" TEXT;
ALTER TABLE "AdProItem" ADD COLUMN IF NOT EXISTS "declarationInfoMedId" TEXT;
CREATE INDEX IF NOT EXISTS "AdProItem_historiqueLotId_idx" ON "AdProItem"("historiqueLotId");
CREATE INDEX IF NOT EXISTS "AdProItem_promoMaterialParentId_idx" ON "AdProItem"("promoMaterialParentId");
CREATE INDEX IF NOT EXISTS "AdProItem_declarationInfoMedId_idx" ON "AdProItem"("declarationInfoMedId");
DO $$ BEGIN
    ALTER TABLE "AdProItem" ADD CONSTRAINT "AdProItem_historiqueLotId_fkey"
        FOREIGN KEY ("historiqueLotId") REFERENCES "AdProIntegrationLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "AdProItem" ADD CONSTRAINT "AdProItem_promoMaterialParentId_fkey"
        FOREIGN KEY ("promoMaterialParentId") REFERENCES "PromoMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE "AdProItem" ADD CONSTRAINT "AdProItem_declarationInfoMedId_fkey"
        FOREIGN KEY ("declarationInfoMedId") REFERENCES "MedicalInfoDeclaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Un montant payé historique n'est jamais négatif.
DO $$ BEGIN
    ALTER TABLE "AdProItem" ADD CONSTRAINT "AdProItem_montant_historique_positif"
        CHECK ("montantPayeHistorique" IS NULL OR "montantPayeHistorique" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 5. Un poste appartient à UNE opération et une seule — la contrainte compte désormais 7 parents ──
-- Elle se REMPLACE (elle ne se cumule pas) : la version à cinq parents refuserait les postes historiques d'un dossier
-- de matériel promotionnel ou d'une déclaration d'information médicale. Plus permissive, jamais plus stricte : toute
-- ligne déjà en base la respecte.
ALTER TABLE "AdProItem" DROP CONSTRAINT IF EXISTS "AdProItem_one_parent";
ALTER TABLE "AdProItem"
  ADD CONSTRAINT "AdProItem_one_parent"
  CHECK (
    (CASE WHEN "sponsoringId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "congressNationalId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "congressInternationalId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "eventId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "trainingId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "promoMaterialParentId" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "declarationInfoMedId" IS NULL THEN 0 ELSE 1 END)
  = 1
  );
