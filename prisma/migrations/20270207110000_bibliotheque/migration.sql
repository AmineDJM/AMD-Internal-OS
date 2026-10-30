-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J1 — LA BIBLIOTHÈQUE (décision du 29/10/2026) : « toute pièce qui entre dans la plateforme, quelle que
-- soit la porte, est inscrite au même registre et lue une fois pour toutes ; une seule requête la retrouve
-- par son contenu, filtrée par les droits ».
--
-- Le registre reste `Piece` / `PieceLien` (R5). Cette migration ajoute :
--   • `BibliothequeFiche`   — une ligne par pièce : métadonnées de recherche, clés d'accès, état d'ingestion ;
--   • `BibliothequePassage` — les passages (~800 jetons) du texte lu ;
--   • la recherche PLEIN TEXTE française repliée (configuration `bibliotheque_fr` : unaccent + french_stem
--     quand l'extension unaccent est là, `french` seul sinon), en colonne générée `recherche` + GIN ;
--   • les TRIGRAMMES sur le titre replié (pg_trgm, déjà facultatif depuis 20260824210000) ;
--   • le VECTEUR (pgvector, approuvé en production) : colonne `vecteur vector(512)` + index HNSW, SEULEMENT
--     si l'extension est disponible. Sans elle la migration passe, et le code retombe sur plein texte +
--     trigrammes (`src/modules/bibliotheque/infra/capacites.ts`).
--
-- Additive et IDEMPOTENTE : rejouée, elle ne fait rien ; elle n'échoue jamais faute d'extension ou de droit.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StatutIngestionPiece') THEN
    CREATE TYPE "StatutIngestionPiece" AS ENUM ('A_FAIRE', 'EN_COURS', 'FAITE', 'ECHEC', 'IGNOREE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BibliothequeFiche" (
    "pieceId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "titrePlie" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "mime" TEXT,
    "taille" DOUBLE PRECISION,
    "nature" TEXT,
    "source" "SourcePiece" NOT NULL DEFAULT 'AUTRE',
    "confidentiality" "Confidentiality" NOT NULL DEFAULT 'INTERNAL',
    "sensible" BOOLEAN NOT NULL DEFAULT false,
    "cles" TEXT[],
    "familles" TEXT[],
    "auteurId" TEXT,
    "dateDocument" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statut" "StatutIngestionPiece" NOT NULL DEFAULT 'A_FAIRE',
    "tentatives" INTEGER NOT NULL DEFAULT 0,
    "prochainEssaiLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verrouilleLe" TIMESTAMP(3),
    "derniereErreur" TEXT,
    "methode" TEXT,
    "caracteres" INTEGER,
    "nbPassages" INTEGER NOT NULL DEFAULT 0,
    "versionIngestion" INTEGER NOT NULL DEFAULT 0,
    "ingereLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BibliothequeFiche_pkey" PRIMARY KEY ("pieceId")
);

CREATE TABLE IF NOT EXISTS "BibliothequePassage" (
    "id" TEXT NOT NULL,
    "pieceId" TEXT NOT NULL,
    "rang" INTEGER NOT NULL,
    "texte" TEXT NOT NULL,
    "debut" INTEGER NOT NULL,
    "jetons" INTEGER NOT NULL,
    "vectoriseLe" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BibliothequePassage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BibliothequeFiche_statut_prochainEssaiLe_idx" ON "BibliothequeFiche"("statut", "prochainEssaiLe");
CREATE INDEX IF NOT EXISTS "BibliothequeFiche_dateDocument_idx" ON "BibliothequeFiche"("dateDocument");
CREATE INDEX IF NOT EXISTS "BibliothequeFiche_blobId_idx" ON "BibliothequeFiche"("blobId");
CREATE INDEX IF NOT EXISTS "BibliothequePassage_vectoriseLe_idx" ON "BibliothequePassage"("vectoriseLe");
CREATE UNIQUE INDEX IF NOT EXISTS "BibliothequePassage_pieceId_rang_key" ON "BibliothequePassage"("pieceId", "rang");
-- Les clés d'accès et leurs familles : « au moins une clé que la personne peut ouvrir » se filtre par `&&`.
CREATE INDEX IF NOT EXISTS "BibliothequeFiche_cles_gin" ON "BibliothequeFiche" USING gin ("cles");
CREATE INDEX IF NOT EXISTS "BibliothequeFiche_familles_gin" ON "BibliothequeFiche" USING gin ("familles");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BibliothequeFiche_pieceId_fkey') THEN
    ALTER TABLE "BibliothequeFiche" ADD CONSTRAINT "BibliothequeFiche_pieceId_fkey"
      FOREIGN KEY ("pieceId") REFERENCES "Piece"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BibliothequePassage_pieceId_fkey') THEN
    ALTER TABLE "BibliothequePassage" ADD CONSTRAINT "BibliothequePassage_pieceId_fkey"
      FOREIGN KEY ("pieceId") REFERENCES "BibliothequeFiche"("pieceId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── LE PLEIN TEXTE FRANÇAIS REPLIÉ ─────────────────────────────────────────────────────────
-- « reglement » doit trouver « Règlement ». `unaccent()` n'est pas IMMUABLE et ne peut pas servir dans une colonne
-- générée ; le DICTIONNAIRE unaccent, placé dans une configuration de recherche, si : `to_tsvector(regconfig, text)`
-- l'est. Sans l'extension, la configuration est un simple `french` (la requête reste repliée côté code).
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS unaccent;
  EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'extension unaccent indisponible — plein texte sans repli des accents';
  END;
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'bibliotheque_fr') THEN
    CREATE TEXT SEARCH CONFIGURATION bibliotheque_fr (COPY = french);
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
      ALTER TEXT SEARCH CONFIGURATION bibliotheque_fr
        ALTER MAPPING FOR hword, hword_part, word WITH unaccent, french_stem;
    END IF;
  END IF;
END $$;

ALTER TABLE "BibliothequePassage" ADD COLUMN IF NOT EXISTS "recherche" tsvector
  GENERATED ALWAYS AS (to_tsvector('bibliotheque_fr', left(coalesce("texte", ''), 1048576))) STORED;
CREATE INDEX IF NOT EXISTS "BibliothequePassage_recherche_gin" ON "BibliothequePassage" USING gin ("recherche");

-- ── LES TRIGRAMMES (titre replié) — facultatifs, comme partout ailleurs ────────────────────
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'extension pg_trgm indisponible — pas de rapprochement par trigrammes';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS "BibliothequeFiche_titrePlie_trgm" ON "BibliothequeFiche" USING gin ("titrePlie" gin_trgm_ops);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'index trigrammes de la bibliothèque non créé (%: %)', SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;

-- ── LE VECTEUR (pgvector) — SEULEMENT s'il est disponible ─────────────────────────────────
-- `pg_available_extensions` dit si le serveur porte l'extension ; sans elle, rien n'est tenté et la migration
-- passe. Un rôle sans le droit de la créer, ou une version sans HNSW (< 0.5), passent aussi : dit en NOTICE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'extension vector non créée (%: %) — recherche plein texte et trigrammes seulement', SQLSTATE, SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'pgvector absent de ce serveur — recherche plein texte et trigrammes seulement';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE "BibliothequePassage" ADD COLUMN IF NOT EXISTS "vecteur" vector(512)';
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS "BibliothequePassage_vecteur_hnsw" ON "BibliothequePassage" USING hnsw ("vecteur" vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'index HNSW non créé (%: %) — balayage exact des vecteurs', SQLSTATE, SQLERRM;
    END;
  END IF;
END $$;
