-- Migration : 20270130100000_referentiels
-- Refonte des données, palier P1 (`docs/architecture/refonte-donnees-et-monolithe-modulaire.md`) : les
-- référentiels R1 (Personne), R2 (Organisation), R3 (Adresse, PointDeContact — Wilaya/Commune : autre lot,
-- d'où des codes SCALAIRES), R5 (Piece, PieceLien), R6 (coffre : DonneeSensible, AccesDonneeSensible) et le
-- moteur d'enrichissement E (Extraction, FaitPropose, FaitConfirme, ConflitDeFait).
-- ADDITIVE : tables créées VIDES (le remplissage est le palier P2), colonnes de lien NULLABLES sur les fiches
-- existantes (`personneId`, `organisationId`, `pieceId`), clés étrangères `ON DELETE SET NULL`. Rien n'est
-- supprimé, rien n'est réécrit.
-- Idempotente : rejouable sans effet (`IF NOT EXISTS`, `duplicate_object`).

-- ── Énumérations ──
DO $$ BEGIN
  CREATE TYPE "RolePersonne" AS ENUM ('COLLABORATEUR', 'PROFESSIONNEL_SANTE', 'BENEFICIAIRE', 'VOYAGEUR', 'CANDIDAT', 'CONTACT_TIERS', 'INTERVENANT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "RoleOrganisation" AS ENUM ('SOCIETE_DU_GROUPE', 'FOURNISSEUR', 'CLIENT', 'ETABLISSEMENT_SANTE', 'SOCIETE_SAVANTE', 'AUTORITE', 'LABORATOIRE', 'AGENCE', 'BANQUE', 'TRANSPORTEUR', 'AUTRE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypeIdentifiantOrganisation" AS ENUM ('NIF', 'NIS', 'RC', 'AI', 'AGREMENT', 'CODE_PCH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypeAdresse" AS ENUM ('SIEGE', 'LIVRAISON', 'DOMICILE', 'AUTRE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypePointDeContact" AS ENUM ('TELEPHONE', 'EMAIL', 'SITE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "SourcePiece" AS ENUM ('DRIVE', 'CONVERSATION', 'EMAIL', 'PORTAIL', 'AD_PRO', 'RH', 'LEGAL', 'AUTRE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypeSujetPiece" AS ENUM ('PERSONNE', 'ORGANISATION', 'ENTITE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypeTitulaire" AS ENUM ('PERSONNE', 'ORGANISATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "StatutExtraction" AS ENUM ('EN_COURS', 'TERMINEE', 'ECHOUEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "TypeSujetFait" AS ENUM ('PERSONNE', 'ORGANISATION', 'PRODUIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "RoleSujetFait" AS ENUM ('TITULAIRE', 'EMETTEUR', 'DESTINATAIRE', 'SIGNATAIRE', 'PARTIE', 'ORGANISATEUR', 'MENTIONNE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "DecisionFaitPropose" AS ENUM ('EN_ATTENTE', 'CONFIRME_D_OFFICE', 'CONFIRME', 'REJETE', 'CONFLIT', 'COFFRE', 'IGNORE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "SourceFaitConfirme" AS ENUM ('PIECE', 'SAISIE', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "StatutConflitDeFait" AS ENUM ('OUVERT', 'GARDE_ACTUELLE', 'REMPLACEE', 'ABANDONNE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Tables des référentiels ──
CREATE TABLE IF NOT EXISTS "Personne" (
    "id" TEXT NOT NULL,
    "civilite" TEXT,
    "nom" TEXT NOT NULL,
    "prenoms" TEXT,
    "nomReplie" TEXT NOT NULL,
    "naissance" DATE,
    "nationalite" TEXT,
    "langues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photoBlobId" TEXT,
    "completude" INTEGER NOT NULL DEFAULT 0,
    "fusionneeDansId" TEXT,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Personne_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PersonneRole" (
    "id" TEXT NOT NULL,
    "personneId" TEXT NOT NULL,
    "role" "RolePersonne" NOT NULL,
    "depuis" DATE,
    "jusquA" DATE,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonneRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Organisation" (
    "id" TEXT NOT NULL,
    "raisonSociale" TEXT NOT NULL,
    "nomCourt" TEXT,
    "nomReplie" TEXT NOT NULL,
    "formeJuridique" TEXT,
    "capital" DECIMAL(14,2),
    "pays" TEXT NOT NULL DEFAULT 'DZ',
    "statut" TEXT NOT NULL DEFAULT 'ACTIVE',
    "siteWeb" TEXT,
    "logoBlobId" TEXT,
    "completude" INTEGER NOT NULL DEFAULT 0,
    "fusionneeDansId" TEXT,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OrganisationRole" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "role" "RoleOrganisation" NOT NULL,
    "depuis" DATE,
    "jusquA" DATE,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganisationRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OrganisationIdentifiant" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "type" "TypeIdentifiantOrganisation" NOT NULL,
    "valeur" TEXT NOT NULL,
    "valeurNormalisee" TEXT NOT NULL,
    "pieceId" TEXT,
    "verifieLe" TIMESTAMP(3),
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganisationIdentifiant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Affiliation" (
    "id" TEXT NOT NULL,
    "personneId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "fonction" TEXT,
    "service" TEXT,
    "depuis" DATE,
    "jusquA" DATE,
    "principale" BOOLEAN NOT NULL DEFAULT false,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Affiliation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Adresse" (
    "id" TEXT NOT NULL,
    "personneId" TEXT,
    "organisationId" TEXT,
    "type" "TypeAdresse" NOT NULL DEFAULT 'AUTRE',
    "ligne1" TEXT NOT NULL,
    "ligne2" TEXT,
    "wilayaCode" TEXT,
    "communeCode" TEXT,
    "codePostal" TEXT,
    "pays" TEXT NOT NULL DEFAULT 'DZ',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "principale" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "verifieeLe" TIMESTAMP(3),
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Adresse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PointDeContact" (
    "id" TEXT NOT NULL,
    "personneId" TEXT,
    "organisationId" TEXT,
    "type" "TypePointDeContact" NOT NULL,
    "valeur" TEXT NOT NULL,
    "valeurNormalisee" TEXT NOT NULL,
    "libelle" TEXT,
    "principal" BOOLEAN NOT NULL DEFAULT false,
    "verifieLe" TIMESTAMP(3),
    "source" TEXT,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointDeContact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Piece" (
    "id" TEXT NOT NULL,
    "blobId" TEXT,
    "empreinte" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "mime" TEXT,
    "taille" DOUBLE PRECISION,
    "pages" INTEGER,
    "langue" TEXT,
    "nature" TEXT,
    "natureConfiance" DOUBLE PRECISION,
    "confidentiality" "Confidentiality" NOT NULL DEFAULT 'INTERNAL',
    "source" "SourcePiece" NOT NULL DEFAULT 'AUTRE',
    "deposeeParId" TEXT,
    "deposeeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Piece_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PieceLien" (
    "id" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "sujetType" "TypeSujetPiece" NOT NULL,
    "sujetId" TEXT NOT NULL,
    "entityType" TEXT,
    "role" TEXT NOT NULL,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PieceLien_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DonneeSensible" (
    "id" TEXT NOT NULL,
    "titulaireType" "TypeTitulaire" NOT NULL,
    "titulaireId" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "valeurChiffree" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "cleVersion" INTEGER NOT NULL DEFAULT 1,
    "empreinteHmac" TEXT NOT NULL,
    "derniersCaracteres" TEXT,
    "pieceId" TEXT,
    "valideDu" DATE,
    "valideAu" DATE,
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DonneeSensible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AccesDonneeSensible" (
    "id" TEXT NOT NULL,
    "donneeSensibleId" TEXT,
    "titulaireType" "TypeTitulaire" NOT NULL,
    "titulaireId" TEXT NOT NULL,
    "nature" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "geste" TEXT NOT NULL,
    "motif" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccesDonneeSensible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Extraction" (
    "id" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "nature" TEXT,
    "moteur" TEXT NOT NULL,
    "local" BOOLEAN NOT NULL,
    "statut" "StatutExtraction" NOT NULL DEFAULT 'EN_COURS',
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dureeMs" INTEGER,
    "coutUsd" DECIMAL(12,6),
    "creeParId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extraction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FaitPropose" (
    "id" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "sujetRef" TEXT NOT NULL,
    "sujetType" "TypeSujetFait" NOT NULL,
    "sujetId" TEXT,
    "role" "RoleSujetFait" NOT NULL,
    "attribut" TEXT NOT NULL,
    "valeur" TEXT,
    "valeurNormalisee" TEXT,
    "confiance" DOUBLE PRECISION NOT NULL,
    "preuve" JSONB NOT NULL,
    "sensible" BOOLEAN NOT NULL DEFAULT false,
    "donneeSensibleId" TEXT,
    "decision" "DecisionFaitPropose" NOT NULL DEFAULT 'EN_ATTENTE',
    "raisonDecision" TEXT,
    "decideeParId" TEXT,
    "decideeLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaitPropose_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FaitConfirme" (
    "id" TEXT NOT NULL,
    "sujetType" "TypeSujetFait" NOT NULL,
    "sujetId" TEXT NOT NULL,
    "attribut" TEXT NOT NULL,
    "valeur" TEXT,
    "valeurNormalisee" TEXT,
    "sensible" BOOLEAN NOT NULL DEFAULT false,
    "donneeSensibleId" TEXT,
    "source" "SourceFaitConfirme" NOT NULL,
    "pieceId" TEXT,
    "faitProposeId" TEXT,
    "confirmeParId" TEXT,
    "confirmeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valideDu" TIMESTAMP(3),
    "valideAu" TIMESTAMP(3),
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FaitConfirme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConflitDeFait" (
    "id" TEXT NOT NULL,
    "sujetType" "TypeSujetFait" NOT NULL,
    "sujetId" TEXT NOT NULL,
    "attribut" TEXT NOT NULL,
    "faitConfirmeId" TEXT,
    "faitProposeId" TEXT NOT NULL,
    "valeurActuelle" TEXT,
    "valeurProposee" TEXT,
    "statut" "StatutConflitDeFait" NOT NULL DEFAULT 'OUVERT',
    "resoluParId" TEXT,
    "resoluLe" TIMESTAMP(3),
    "commentaire" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConflitDeFait_pkey" PRIMARY KEY ("id")
);

-- ── Colonnes de lien sur les fiches existantes (nullables) ──
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "RecruitmentCandidate" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "SponsoringRequest" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "AdProVoyageur" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "AdProHebergement" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "CongressInternational" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "CongressNational" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "CareBeneficiary" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "MedicalDoctor" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "CompanyContact" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "MedicalInstitution" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "pieceId" TEXT;
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "DriveNode" ADD COLUMN IF NOT EXISTS "pieceId" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "organisationId" TEXT;
ALTER TABLE "SupplierUser" ADD COLUMN IF NOT EXISTS "personneId" TEXT;
ALTER TABLE "DirectoryEntry" ADD COLUMN IF NOT EXISTS "personneId" TEXT;

-- ── Index ──
CREATE INDEX IF NOT EXISTS "Personne_nomReplie_idx" ON "Personne"("nomReplie");
CREATE INDEX IF NOT EXISTS "Personne_fusionneeDansId_idx" ON "Personne"("fusionneeDansId");
CREATE INDEX IF NOT EXISTS "PersonneRole_personneId_idx" ON "PersonneRole"("personneId");
CREATE INDEX IF NOT EXISTS "PersonneRole_role_idx" ON "PersonneRole"("role");
CREATE INDEX IF NOT EXISTS "Organisation_nomReplie_idx" ON "Organisation"("nomReplie");
CREATE INDEX IF NOT EXISTS "Organisation_fusionneeDansId_idx" ON "Organisation"("fusionneeDansId");
CREATE INDEX IF NOT EXISTS "OrganisationRole_role_idx" ON "OrganisationRole"("role");
CREATE UNIQUE INDEX IF NOT EXISTS "OrganisationRole_organisationId_role_key" ON "OrganisationRole"("organisationId", "role");
CREATE INDEX IF NOT EXISTS "OrganisationIdentifiant_organisationId_idx" ON "OrganisationIdentifiant"("organisationId");
CREATE UNIQUE INDEX IF NOT EXISTS "OrganisationIdentifiant_type_valeurNormalisee_key" ON "OrganisationIdentifiant"("type", "valeurNormalisee");
CREATE INDEX IF NOT EXISTS "Affiliation_personneId_idx" ON "Affiliation"("personneId");
CREATE INDEX IF NOT EXISTS "Affiliation_organisationId_idx" ON "Affiliation"("organisationId");
CREATE INDEX IF NOT EXISTS "Adresse_personneId_idx" ON "Adresse"("personneId");
CREATE INDEX IF NOT EXISTS "Adresse_organisationId_idx" ON "Adresse"("organisationId");
CREATE INDEX IF NOT EXISTS "Adresse_wilayaCode_communeCode_idx" ON "Adresse"("wilayaCode", "communeCode");
CREATE INDEX IF NOT EXISTS "PointDeContact_personneId_idx" ON "PointDeContact"("personneId");
CREATE INDEX IF NOT EXISTS "PointDeContact_organisationId_idx" ON "PointDeContact"("organisationId");
CREATE INDEX IF NOT EXISTS "PointDeContact_type_valeurNormalisee_idx" ON "PointDeContact"("type", "valeurNormalisee");
CREATE INDEX IF NOT EXISTS "Piece_empreinte_idx" ON "Piece"("empreinte");
CREATE INDEX IF NOT EXISTS "Piece_nature_idx" ON "Piece"("nature");
CREATE INDEX IF NOT EXISTS "Piece_blobId_idx" ON "Piece"("blobId");
CREATE INDEX IF NOT EXISTS "PieceLien_sujetType_sujetId_idx" ON "PieceLien"("sujetType", "sujetId");
CREATE UNIQUE INDEX IF NOT EXISTS "PieceLien_pieceId_sujetType_sujetId_role_key" ON "PieceLien"("pieceId", "sujetType", "sujetId", "role");
CREATE INDEX IF NOT EXISTS "DonneeSensible_titulaireType_titulaireId_idx" ON "DonneeSensible"("titulaireType", "titulaireId");
CREATE INDEX IF NOT EXISTS "DonneeSensible_empreinteHmac_idx" ON "DonneeSensible"("empreinteHmac");
CREATE INDEX IF NOT EXISTS "AccesDonneeSensible_donneeSensibleId_idx" ON "AccesDonneeSensible"("donneeSensibleId");
CREATE INDEX IF NOT EXISTS "AccesDonneeSensible_userId_createdAt_idx" ON "AccesDonneeSensible"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AccesDonneeSensible_titulaireType_titulaireId_idx" ON "AccesDonneeSensible"("titulaireType", "titulaireId");
CREATE INDEX IF NOT EXISTS "Extraction_pieceId_idx" ON "Extraction"("pieceId");
CREATE INDEX IF NOT EXISTS "Extraction_statut_createdAt_idx" ON "Extraction"("statut", "createdAt");
CREATE INDEX IF NOT EXISTS "FaitPropose_extractionId_idx" ON "FaitPropose"("extractionId");
CREATE INDEX IF NOT EXISTS "FaitPropose_sujetType_sujetId_idx" ON "FaitPropose"("sujetType", "sujetId");
CREATE INDEX IF NOT EXISTS "FaitPropose_decision_createdAt_idx" ON "FaitPropose"("decision", "createdAt");
CREATE INDEX IF NOT EXISTS "FaitPropose_attribut_valeurNormalisee_idx" ON "FaitPropose"("attribut", "valeurNormalisee");
CREATE INDEX IF NOT EXISTS "FaitConfirme_sujetType_sujetId_attribut_actif_idx" ON "FaitConfirme"("sujetType", "sujetId", "attribut", "actif");
CREATE INDEX IF NOT EXISTS "FaitConfirme_attribut_valeurNormalisee_idx" ON "FaitConfirme"("attribut", "valeurNormalisee");
CREATE INDEX IF NOT EXISTS "FaitConfirme_pieceId_idx" ON "FaitConfirme"("pieceId");
CREATE INDEX IF NOT EXISTS "ConflitDeFait_sujetType_sujetId_idx" ON "ConflitDeFait"("sujetType", "sujetId");
CREATE INDEX IF NOT EXISTS "ConflitDeFait_statut_createdAt_idx" ON "ConflitDeFait"("statut", "createdAt");
CREATE INDEX IF NOT EXISTS "ConflitDeFait_faitProposeId_idx" ON "ConflitDeFait"("faitProposeId");
CREATE INDEX IF NOT EXISTS "ConflitDeFait_faitConfirmeId_idx" ON "ConflitDeFait"("faitConfirmeId");
CREATE INDEX IF NOT EXISTS "User_personneId_idx" ON "User"("personneId");
CREATE INDEX IF NOT EXISTS "Company_organisationId_idx" ON "Company"("organisationId");
CREATE INDEX IF NOT EXISTS "RecruitmentCandidate_personneId_idx" ON "RecruitmentCandidate"("personneId");
CREATE INDEX IF NOT EXISTS "SponsoringRequest_organisationId_idx" ON "SponsoringRequest"("organisationId");
CREATE INDEX IF NOT EXISTS "AdProVoyageur_personneId_idx" ON "AdProVoyageur"("personneId");
CREATE INDEX IF NOT EXISTS "AdProHebergement_personneId_idx" ON "AdProHebergement"("personneId");
CREATE INDEX IF NOT EXISTS "CongressInternational_organisationId_idx" ON "CongressInternational"("organisationId");
CREATE INDEX IF NOT EXISTS "CongressNational_organisationId_idx" ON "CongressNational"("organisationId");
CREATE INDEX IF NOT EXISTS "CareBeneficiary_personneId_idx" ON "CareBeneficiary"("personneId");
CREATE INDEX IF NOT EXISTS "MedicalDoctor_personneId_idx" ON "MedicalDoctor"("personneId");
CREATE INDEX IF NOT EXISTS "CompanyContact_organisationId_idx" ON "CompanyContact"("organisationId");
CREATE INDEX IF NOT EXISTS "MedicalInstitution_organisationId_idx" ON "MedicalInstitution"("organisationId");
CREATE INDEX IF NOT EXISTS "Document_pieceId_idx" ON "Document"("pieceId");
CREATE INDEX IF NOT EXISTS "Employee_personneId_idx" ON "Employee"("personneId");
CREATE INDEX IF NOT EXISTS "DriveNode_pieceId_idx" ON "DriveNode"("pieceId");
CREATE INDEX IF NOT EXISTS "Supplier_organisationId_idx" ON "Supplier"("organisationId");
CREATE INDEX IF NOT EXISTS "SupplierUser_personneId_idx" ON "SupplierUser"("personneId");
CREATE INDEX IF NOT EXISTS "DirectoryEntry_personneId_idx" ON "DirectoryEntry"("personneId");

-- ── Clés étrangères ──
DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Company" ADD CONSTRAINT "Company_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "RecruitmentCandidate" ADD CONSTRAINT "RecruitmentCandidate_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SponsoringRequest" ADD CONSTRAINT "SponsoringRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AdProVoyageur" ADD CONSTRAINT "AdProVoyageur_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AdProHebergement" ADD CONSTRAINT "AdProHebergement_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CongressInternational" ADD CONSTRAINT "CongressInternational_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CongressNational" ADD CONSTRAINT "CongressNational_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CareBeneficiary" ADD CONSTRAINT "CareBeneficiary_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "MedicalDoctor" ADD CONSTRAINT "MedicalDoctor_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "CompanyContact" ADD CONSTRAINT "CompanyContact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "MedicalInstitution" ADD CONSTRAINT "MedicalInstitution_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Employee" ADD CONSTRAINT "Employee_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DriveNode" ADD CONSTRAINT "DriveNode_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierUser" ADD CONSTRAINT "SupplierUser_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DirectoryEntry" ADD CONSTRAINT "DirectoryEntry_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Personne" ADD CONSTRAINT "Personne_fusionneeDansId_fkey" FOREIGN KEY ("fusionneeDansId") REFERENCES "Personne"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PersonneRole" ADD CONSTRAINT "PersonneRole_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_fusionneeDansId_fkey" FOREIGN KEY ("fusionneeDansId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "OrganisationRole" ADD CONSTRAINT "OrganisationRole_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "OrganisationIdentifiant" ADD CONSTRAINT "OrganisationIdentifiant_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Affiliation" ADD CONSTRAINT "Affiliation_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Affiliation" ADD CONSTRAINT "Affiliation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Adresse" ADD CONSTRAINT "Adresse_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Adresse" ADD CONSTRAINT "Adresse_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PointDeContact" ADD CONSTRAINT "PointDeContact_personneId_fkey" FOREIGN KEY ("personneId") REFERENCES "Personne"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PointDeContact" ADD CONSTRAINT "PointDeContact_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PieceLien" ADD CONSTRAINT "PieceLien_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DonneeSensible" ADD CONSTRAINT "DonneeSensible_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AccesDonneeSensible" ADD CONSTRAINT "AccesDonneeSensible_donneeSensibleId_fkey" FOREIGN KEY ("donneeSensibleId") REFERENCES "DonneeSensible"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Extraction" ADD CONSTRAINT "Extraction_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitPropose" ADD CONSTRAINT "FaitPropose_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitPropose" ADD CONSTRAINT "FaitPropose_donneeSensibleId_fkey" FOREIGN KEY ("donneeSensibleId") REFERENCES "DonneeSensible"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitConfirme" ADD CONSTRAINT "FaitConfirme_donneeSensibleId_fkey" FOREIGN KEY ("donneeSensibleId") REFERENCES "DonneeSensible"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitConfirme" ADD CONSTRAINT "FaitConfirme_pieceId_fkey" FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitConfirme" ADD CONSTRAINT "FaitConfirme_faitProposeId_fkey" FOREIGN KEY ("faitProposeId") REFERENCES "FaitPropose"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ConflitDeFait" ADD CONSTRAINT "ConflitDeFait_faitConfirmeId_fkey" FOREIGN KEY ("faitConfirmeId") REFERENCES "FaitConfirme"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ConflitDeFait" ADD CONSTRAINT "ConflitDeFait_faitProposeId_fkey" FOREIGN KEY ("faitProposeId") REFERENCES "FaitPropose"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Contraintes que le schéma Prisma ne sait pas dire : un seul titulaire ; aucune valeur sensible en clair ──
DO $$ BEGIN
  ALTER TABLE "Adresse" ADD CONSTRAINT "Adresse_un_titulaire_check" CHECK (num_nonnulls("personneId", "organisationId") = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "PointDeContact" ADD CONSTRAINT "PointDeContact_un_titulaire_check" CHECK (num_nonnulls("personneId", "organisationId") = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitPropose" ADD CONSTRAINT "FaitPropose_sensible_sans_clair_check" CHECK (NOT "sensible" OR ("valeur" IS NULL AND "valeurNormalisee" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitConfirme" ADD CONSTRAINT "FaitConfirme_sensible_sans_clair_check" CHECK (NOT "sensible" OR ("valeur" IS NULL AND "valeurNormalisee" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "FaitPropose" ADD CONSTRAINT "FaitPropose_confiance_check" CHECK ("confiance" >= 0 AND "confiance" <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Personne" ADD CONSTRAINT "Personne_completude_check" CHECK ("completude" BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_completude_check" CHECK ("completude" BETWEEN 0 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
