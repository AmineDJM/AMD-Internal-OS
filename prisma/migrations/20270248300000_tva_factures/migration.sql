-- LA TVA DES FACTURES (Super Admin, 24/11/2026 — « très, très, très important ») : la TVA de la G50 se CALCULE
-- depuis les factures (collectée − déductible). Une facture (ou un avoir) porte désormais son HT, sa TVA, son TTC
-- et le détail PAR TAUX (19 %, 9 %, 0 %).
--
-- Deux tables à part plutôt que des colonnes sur "LegalDocument" : la TVA est un fait comptable de la FACTURE, et
-- son absence se lit sans ambiguïté — pas de ligne = TVA « non renseignée ». Les factures existantes gardent leur
-- montant comme TTC ; AUCUNE TVA ne leur est inventée : elles apparaissent dans « TVA à compléter ».
--
-- La date de facture (la période de TVA) reste "LegalDocument"."startDate" (« Date d'émission ») et la société
-- "LegalDocument"."companyId" : on ne les recopie pas, deux copies divergent.
--
-- Idempotent : tables, contraintes et index conditionnels.

CREATE TABLE IF NOT EXISTS "FactureTva" (
  "id"              TEXT NOT NULL,
  "legalDocumentId" TEXT NOT NULL,
  "sens"            TEXT,
  "montantHt"       DECIMAL(14,2) NOT NULL,
  "montantTva"      DECIMAL(14,2) NOT NULL,
  "autresTaxes"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "montantTtc"      DECIMAL(14,2) NOT NULL,
  "source"          TEXT NOT NULL,
  "saisieParId"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FactureTva_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FactureTva_legalDocumentId_key" ON "FactureTva" ("legalDocumentId");

-- Supprimer la facture emporte sa TVA (elle n'a plus d'objet).
DO $$
BEGIN
  ALTER TABLE "FactureTva"
    ADD CONSTRAINT "FactureTva_legalDocumentId_fkey"
    FOREIGN KEY ("legalDocumentId") REFERENCES "LegalDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "FactureTvaTaux" (
  "id"           TEXT NOT NULL,
  "factureTvaId" TEXT NOT NULL,
  "taux"         DECIMAL(5,2) NOT NULL,
  "baseHt"       DECIMAL(14,2) NOT NULL,
  "montantTva"   DECIMAL(14,2) NOT NULL,
  CONSTRAINT "FactureTvaTaux_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FactureTvaTaux_factureTvaId_taux_key" ON "FactureTvaTaux" ("factureTvaId", "taux");

DO $$
BEGIN
  ALTER TABLE "FactureTvaTaux"
    ADD CONSTRAINT "FactureTvaTaux_factureTvaId_fkey"
    FOREIGN KEY ("factureTvaId") REFERENCES "FactureTva"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
