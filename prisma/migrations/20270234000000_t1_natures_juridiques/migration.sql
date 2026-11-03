-- T1 (décision 0061) : quatre natures de pièces juridiques — agrément, AMM, statuts, procès-verbal.
-- Additive et idempotente : une valeur d'énumération ajoutée ne touche aucune ligne existante.
ALTER TYPE "LegalDocKind" ADD VALUE IF NOT EXISTS 'APPROVAL';
ALTER TYPE "LegalDocKind" ADD VALUE IF NOT EXISTS 'MARKETING_AUTHORIZATION';
ALTER TYPE "LegalDocKind" ADD VALUE IF NOT EXISTS 'STATUTES';
ALTER TYPE "LegalDocKind" ADD VALUE IF NOT EXISTS 'MINUTES';
