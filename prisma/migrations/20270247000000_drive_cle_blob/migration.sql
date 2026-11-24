-- LA CLÉ DE CHAQUE BLOB (audit Drive du 24/11, A2).
-- `keyId` : empreinte courte (HMAC) de la clé qui a chiffré le blob. Nulle pour les blobs d'avant
-- (posée à leur première lecture réussie) et pour les dépôts directs (non chiffrés par l'application).
ALTER TABLE "FileBlob" ADD COLUMN IF NOT EXISTS "keyId" TEXT;

-- La déduplication se fait désormais PAR CLÉ : un même contenu peut exister sous deux clés (un blob
-- d'avant, de clé inconnue, n'est jamais réemployé par un dépôt chiffré avec la clé active).
DROP INDEX IF EXISTS "FileBlob_sha256_key";
CREATE UNIQUE INDEX IF NOT EXISTS "FileBlob_sha256_keyId_key" ON "FileBlob"("sha256", "keyId");

-- L'empreinte de la clé de référence, posée au premier démarrage, comparée au démarrage de chaque service.
ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "driveKeyFingerprint" TEXT;
