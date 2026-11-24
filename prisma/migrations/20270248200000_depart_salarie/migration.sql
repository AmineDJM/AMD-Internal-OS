-- LA FIN DE CONTRAT D'UN SALARIÉ, ENTIÈREMENT AUTOMATIQUE (Super Admin, 24/11/2026 — lot rhdepart).
--
-- • `DepartSalarie` : la fin de contrat ouverte depuis la fiche (motif, date de fin, préavis), validée par le moteur
--   commun (RH → N+1 → DG), puis son solde de tout compte et son certificat de travail (JSON modifiables).
-- • `DepartSalarieTache` : la liste de sortie (véhicule, matériel promotionnel, accès, transferts…), unique par
--   (départ, source) pour que le préremplissage rejoué ne double aucune ligne.
-- Idempotente : chaque objet n'est créé que s'il manque.

CREATE TABLE IF NOT EXISTS "DepartSalarie" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "motif" TEXT NOT NULL,
    "dateFin" TIMESTAMP(3) NOT NULL,
    "preavisJours" INTEGER,
    "note" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'EN_VALIDATION',
    "validationRequestId" TEXT,
    "ouvertParId" TEXT NOT NULL,
    "valideLe" TIMESTAMP(3),
    "compteFermeLe" TIMESTAMP(3),
    "solde" JSONB,
    "soldeModifieLe" TIMESTAMP(3),
    "soldeModifieParId" TEXT,
    "certificat" JSONB,
    "certificatEmisLe" TIMESTAMP(3),
    "certificatReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DepartSalarie_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DepartSalarieTache" (
    "id" TEXT NOT NULL,
    "departId" TEXT NOT NULL,
    "categorie" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "detail" TEXT,
    "quantite" DECIMAL(12,3),
    "source" TEXT,
    "ordre" INTEGER NOT NULL DEFAULT 0,
    "faitLe" TIMESTAMP(3),
    "faitParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DepartSalarieTache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DepartSalarie_validationRequestId_key" ON "DepartSalarie"("validationRequestId");
CREATE INDEX IF NOT EXISTS "DepartSalarie_employeeId_idx" ON "DepartSalarie"("employeeId");
CREATE INDEX IF NOT EXISTS "DepartSalarie_statut_dateFin_idx" ON "DepartSalarie"("statut", "dateFin");
CREATE UNIQUE INDEX IF NOT EXISTS "DepartSalarieTache_departId_source_key" ON "DepartSalarieTache"("departId", "source");
CREATE INDEX IF NOT EXISTS "DepartSalarieTache_departId_idx" ON "DepartSalarieTache"("departId");

DO $$ BEGIN
  ALTER TABLE "DepartSalarie" ADD CONSTRAINT "DepartSalarie_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "DepartSalarieTache" ADD CONSTRAINT "DepartSalarieTache_departId_fkey"
    FOREIGN KEY ("departId") REFERENCES "DepartSalarie"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
