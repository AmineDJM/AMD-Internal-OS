-- L'Assistant IA : messages vocaux, lecture des pièces, réponse vocale (28/10/2026). Additif et idempotent.
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "vocal" JSONB;
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "lecture" JSONB;
ALTER TABLE "AssistantIaTour" ADD COLUMN IF NOT EXISTS "audio" JSONB;
ALTER TABLE "AssistantIaFil" ADD COLUMN IF NOT EXISTS "reponseVocale" BOOLEAN NOT NULL DEFAULT false;
