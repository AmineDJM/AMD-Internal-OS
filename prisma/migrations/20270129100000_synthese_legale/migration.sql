-- Migration : 20270129100000_synthese_legale
-- La lecture d'un document légal par Luna (nature, titre, dates, résumé) se garde sur la lecture du
-- fichier, comme ses lignes : une fois par empreinte, la première fait foi. Deux colonnes, nulles
-- tant qu'aucun modèle n'a lu le document comme pièce Legal.
-- Idempotente : rejouable sans effet.

ALTER TABLE "LecturePiece" ADD COLUMN IF NOT EXISTS "syntheseLegale" JSONB;
ALTER TABLE "LecturePiece" ADD COLUMN IF NOT EXISTS "synthesePar" TEXT;
