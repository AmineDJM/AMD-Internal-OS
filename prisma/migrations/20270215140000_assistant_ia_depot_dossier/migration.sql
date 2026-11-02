-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- J11 (décision 0030) — LE DÉPÔT DE DOSSIER dans l'Assistant IA : un dossier glissé recrée son arborescence dans le
-- Drive de la personne (dossier racine nommé, sous-dossiers, une pièce par fichier inscrite à la Bibliothèque).
--
-- Une ligne par LOT : la racine créée, ce qui a été annoncé (fichiers, octets), l'empreinte de la liste (la reprise
-- retrouve le même lot pour la même liste). Les fichiers eux-mêmes ne sont pas recopiés ici : le Drive est la vérité
-- (sous la racine), la Bibliothèque dit l'état de lecture de chacun.
--
-- ADDITIVE ET IDEMPOTENTE : une table neuve.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "AssistantIaDepotDossier" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "racineId"         TEXT NOT NULL,
  "nom"              TEXT NOT NULL,
  "mode"             TEXT NOT NULL DEFAULT 'DOSSIER',
  "fichiersAnnonces" INTEGER NOT NULL,
  "octetsAnnonces"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  "empreinte"        TEXT NOT NULL,
  "statut"           TEXT NOT NULL DEFAULT 'TELEVERSEMENT',
  "termineLe"        TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantIaDepotDossier_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssistantIaDepotDossier_userId_createdAt_idx" ON "AssistantIaDepotDossier"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssistantIaDepotDossier_userId_empreinte_idx" ON "AssistantIaDepotDossier"("userId", "empreinte");
