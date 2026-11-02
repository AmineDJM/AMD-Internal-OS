-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- K6 (décision 0036, 31/10/2026) — PIÈCES REÇUES PAR WHATSAPP ET PAR MAIL, DANS LE CONTEXTE DE LA CONVERSATION.
--
-- Deux tables neuves : l'ATTENTE DE PIÈCES (« je t'envoie la lettre du Dr Mansouri ») et le JOURNAL DES RÉCEPTIONS
-- (chaque pièce reçue, chaque refus ; unicité canal + identifiant du message = idempotence des relivraisons).
--
-- ADDITIVE ET IDEMPOTENTE : « IF NOT EXISTS » partout, contraintes posées dans des blocs qui tolèrent le doublon.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaAttentePieces" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "filId"        TEXT,
    "description"  TEXT NOT NULL,
    "canaux"       TEXT[],
    "cibleType"    TEXT,
    "cibleId"      TEXT,
    "cibleLibelle" TEXT,
    "cibleLien"    TEXT,
    "categorie"    TEXT,
    "origine"      TEXT NOT NULL DEFAULT 'ECRIT',
    "etat"         TEXT NOT NULL DEFAULT 'OUVERTE',
    "expireLe"     TIMESTAMP(3) NOT NULL,
    "recueLe"      TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantIaAttentePieces_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AssistantIaAttentePieces_userId_etat_expireLe_idx" ON "AssistantIaAttentePieces"("userId", "etat", "expireLe");
DO $$ BEGIN
  ALTER TABLE "AssistantIaAttentePieces" ADD CONSTRAINT "AssistantIaAttentePieces_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AssistantIaReception" (
    "id"           TEXT NOT NULL,
    "canal"        TEXT NOT NULL,
    "idExterne"    TEXT NOT NULL,
    "userId"       TEXT,
    "expediteur"   TEXT NOT NULL,
    "issue"        TEXT NOT NULL,
    "raison"       TEXT,
    "nom"          TEXT,
    "mime"         TEXT,
    "taille"       INTEGER,
    "driveNodeId"  TEXT,
    "attenteId"    TEXT,
    "filId"        TEXT,
    "tourId"       TEXT,
    "intentId"     TEXT,
    "injection"    BOOLEAN NOT NULL DEFAULT false,
    "confidentiel" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantIaReception_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssistantIaReception_canal_idExterne_key" ON "AssistantIaReception"("canal", "idExterne");
CREATE INDEX IF NOT EXISTS "AssistantIaReception_userId_createdAt_idx" ON "AssistantIaReception"("userId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "AssistantIaReception" ADD CONSTRAINT "AssistantIaReception_attenteId_fkey"
    FOREIGN KEY ("attenteId") REFERENCES "AssistantIaAttentePieces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
