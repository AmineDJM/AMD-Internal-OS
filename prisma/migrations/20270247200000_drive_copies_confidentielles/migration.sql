-- DRIVE — LES COPIES DES PIÈCES SENSIBLES PARTENT À LA CORBEILLE (audit Drive du 24/11/2026, F2).
--
-- Le miroir automatique copiait dans le Drive de celui qui dépose (« Mes documents importés », l'ancien miroir
-- « Regulatory — Dossiers produits », la catégorie Regulatory) TOUTE pièce téléversée — pièces confidentielles de
-- pharmacovigilance, RH, données médicales, documents de voyageurs compris. La copie se lisait par la portée ALL
-- du Drive et survivait à la pièce. Le code n'en fait plus (`COPIE_AU_DRIVE`, src/lib/drive/mirror-path.ts) ; ici
-- les copies DÉJÀ faites sont mises à la CORBEILLE de leur propriétaire — réversible : il les restaure d'un clic
-- (« Corbeille » du Drive), rien n'est effacé, aucun fichier n'est libéré. Chaque mise à la corbeille laisse une
-- ligne d'audit (module « Drive », résumé « Copie d'une pièce sensible… ») pour que l'exploitation la retrouve.
--
-- Une copie se reconnaît sans lien en base : un FICHIER du Drive dont une version porte le même contenu (blob
-- dédupliqué par empreinte) qu'une pièce SENSIBLE déposée par son propriétaire, rangé sous l'une des boîtes du
-- miroir (racine de son Drive personnel) ou dans la catégorie Regulatory. Sensible = confidentialité autre
-- qu'INTERNAL, ou type d'objet `jamais` de `COPIE_AU_DRIVE`.
-- Idempotente : une copie déjà à la corbeille n'est plus candidate ; rejouer ne change rien.

WITH RECURSIVE
sensibles AS (
  SELECT DISTINCT s."blobId", d."uploadedById" AS "ownerId"
  FROM "Document" d
  JOIN "StoredFile" s ON s."key" = d."fileKey"
  WHERE d."uploadedById" IS NOT NULL
    AND (d."confidentiality" <> 'INTERNAL' OR d."entityType"::text IN (
      'EMPLOYEE', 'PAYROLL', 'LEAVE_REQUEST', 'SALARY_ADVANCE', 'HR_REQUEST', 'RECRUITMENT_REQUEST',
      'RECRUITMENT_CANDIDATE', 'TRAINING', 'MEDICAL_INFO_DECLARATION', 'DOCTOR', 'VISIT', 'PHARMACOVIGILANCE_CASE',
      'RECLAMATION', 'MISSION_ASSIGNMENT', 'CONGRESS_INTERNATIONAL', 'CONGRESS_NATIONAL', 'AD_PRO_ITEM',
      'ADMIN_REQUEST', 'DRIVER_MISSION'
    ))
),
candidats AS (
  SELECT DISTINCT n."id", n."parentId", n."ownerId", n."spaceId"
  FROM "DriveNode" n
  JOIN "FileVersion" v ON v."nodeId" = n."id"
  JOIN sensibles x ON x."blobId" = v."blobId" AND x."ownerId" = n."ownerId"
  WHERE n."type" = 'FILE' AND n."isTrashed" = false
),
-- Remonte jusqu'à la racine de chaque candidat (le miroir Regulatory garde l'arborescence déposée : profondeur libre).
remontee AS (
  SELECT c."id" AS "nodeId", c."parentId" AS "suivant", c."id" AS "courant", 0 AS "pas"
  FROM candidats c
  UNION ALL
  SELECT r."nodeId", p."parentId", p."id", r."pas" + 1
  FROM remontee r
  JOIN "DriveNode" p ON p."id" = r."suivant"
  WHERE r."pas" < 64
),
racines AS (
  SELECT r."nodeId", p."name", p."ownerId", p."spaceId"
  FROM remontee r
  JOIN "DriveNode" p ON p."id" = r."courant"
  WHERE r."suivant" IS NULL
),
cibles AS (
  SELECT c."id", c."ownerId"
  FROM candidats c
  JOIN racines rc ON rc."nodeId" = c."id"
  WHERE (rc."spaceId" IS NULL AND rc."ownerId" = c."ownerId"
         AND rc."name" IN ('Mes documents importés', 'Regulatory — Dossiers produits'))
     OR c."spaceId" IN (SELECT sp."id" FROM "DriveSpace" sp WHERE lower(sp."name") LIKE '%regulatory%')
),
corbeille AS (
  UPDATE "DriveNode" n
  SET "isTrashed" = true, "updatedAt" = CURRENT_TIMESTAMP
  FROM cibles c
  WHERE n."id" = c."id" AND n."isTrashed" = false
  RETURNING n."id", n."ownerId", n."name"
)
INSERT INTO "AuditLog" ("id", "actorId", "action", "module", "entityType", "entityId", "field", "oldValue", "newValue", "summary", "createdAt")
SELECT 'f2_' || md5(c."id" || clock_timestamp()::text), c."ownerId", 'UPDATE'::"AuditAction", 'Drive', 'DRIVE_NODE'::"EntityType", c."id", 'isTrashed', 'false', 'true',
       'Copie d''une pièce sensible mise à la corbeille (audit Drive F2) : « ' || c."name" || ' » — restaurable depuis la corbeille.',
       CURRENT_TIMESTAMP
FROM corbeille c;
