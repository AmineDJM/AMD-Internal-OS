-- Migration : 20270130110000_lieux_reference
-- R3 — LIEUX DE RÉFÉRENCE : le découpage administratif officiel de l'Algérie (wilayas), et la table des communes.
--
-- SOURCES (Journal officiel de la République algérienne, www.joradp.dz, consultées le 27 octobre 2026) :
--   * Loi n° 26-06 du 4 avril 2026 modifiant et complétant la loi n° 84-09 du 4 février 1984 — JO n° 25 du
--     5 avril 2026. Art. 3 : « soixante-neuf (69) wilayas et mille cinq cent quarante-et-une (1541) communes ».
--     Crée onze wilayas (art. 52 bis 10 à 52 bis 20), détachées de 03, 05, 07, 12, 13, 14, 17 (deux), 26, 28, 32
--     (articles 7, 9, 11, 16, 17, 18, 21, 30, 32, 36 réécrits). Art. 54 : transfert des prérogatives des wilayas
--     mères au plus tard le 31 décembre 2026.
--   * Décret présidentiel n° 26-206 du 25 mai 2026 complétant le décret n° 84-79 du 3 avril 1984 fixant les noms
--     et les chefs-lieux des wilayas — JO n° 40 du 3 juin 2026 (versions française et arabe) : numéros 59 à 69,
--     noms français et arabes.
--   * Arrêté du 17 juin 2026 (immatriculation des véhicules) — JO n° 50 du 15 juillet 2026 : diagrammes 59 à 69
--     en vigueur au 1er janvier 2027 (date d'entrée en fonction retenue, cf. décret exécutif n° 26-208 du
--     26 mai 2026, JO n° 40 : recouvrement par la nouvelle wilaya à compter du 1er janvier 2027).
--   * Loi n° 19-12 du 11 décembre 2019 — JO n° 78 du 18 décembre 2019 : 58 wilayas (création de 49 à 58).
--   * Loi n° 84-09 du 4 février 1984 et décret n° 84-79 du 3 avril 1984 : wilayas 01 à 48 (32 à 48 créées en 1984).
--
-- DATE DE LA DONNÉE : état au 3 juin 2026 (dernier texte modifiant noms et numéros), vérifié le 27 octobre 2026.
--
-- CE QUI N'EST PAS CHARGÉ, et pourquoi :
--   * Noms arabes de 01 à 58 : le JO de 1984 n'est disponible qu'en image (pas de texte vérifiable) et les sites du
--     ministère de l'Intérieur / de l'ONS n'étaient pas joignables proprement ; `nomAr` reste NULL plutôt
--     qu'une transcription non sourcée.
--   * Communes : aucune liste officielle complète et à jour (1541 communes, codes, rattachements de 2026) n'a pu
--     être lue ; la loi 26-06 ne relit que les wilayas modifiées et ne porte pas de codes. Table créée VIDE.
--   * Graphies françaises 01 à 58 : celles déjà en usage dans l'application (`src/lib/labels.ts`), pour que les
--     valeurs déjà stockées se rattachent à l'identique.
--
-- Idempotente : CREATE … IF NOT EXISTS, données en ON CONFLICT DO UPDATE (rejouer remet la référence à jour).

CREATE TABLE IF NOT EXISTS "Wilaya" (
  "code"           TEXT NOT NULL,
  "nom"            TEXT NOT NULL,
  "nomAr"          TEXT,
  "creeeLe"        DATE,
  "texteCreation"  TEXT,
  "enFonctionLe"   DATE,
  "wilayaMereCode" TEXT,
  "active"         BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT "Wilaya_pkey" PRIMARY KEY ("code")
);
CREATE INDEX IF NOT EXISTS "Wilaya_wilayaMereCode_idx" ON "Wilaya"("wilayaMereCode");

CREATE TABLE IF NOT EXISTS "Commune" (
  "code"       TEXT NOT NULL,
  "nom"        TEXT NOT NULL,
  "nomAr"      TEXT,
  "wilayaCode" TEXT NOT NULL,
  CONSTRAINT "Commune_pkey" PRIMARY KEY ("code")
);
CREATE INDEX IF NOT EXISTS "Commune_wilayaCode_idx" ON "Commune"("wilayaCode");

DO $$ BEGIN
  ALTER TABLE "Commune" ADD CONSTRAINT "Commune_wilayaCode_fkey"
    FOREIGN KEY ("wilayaCode") REFERENCES "Wilaya"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO "Wilaya" ("code", "nom", "nomAr", "creeeLe", "texteCreation", "enFonctionLe", "wilayaMereCode", "active") VALUES
  ('01', 'Adrar', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('02', 'Chlef', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('03', 'Laghouat', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('04', 'Oum El Bouaghi', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('05', 'Batna', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('06', 'Béjaïa', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('07', 'Biskra', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('08', 'Béchar', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('09', 'Blida', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('10', 'Bouira', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('11', 'Tamanrasset', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('12', 'Tébessa', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('13', 'Tlemcen', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('14', 'Tiaret', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('15', 'Tizi Ouzou', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('16', 'Alger', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('17', 'Djelfa', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('18', 'Jijel', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('19', 'Sétif', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('20', 'Saïda', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('21', 'Skikda', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('22', 'Sidi Bel Abbès', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('23', 'Annaba', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('24', 'Guelma', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('25', 'Constantine', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('26', 'Médéa', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('27', 'Mostaganem', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('28', 'M''Sila', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('29', 'Mascara', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('30', 'Ouargla', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('31', 'Oran', NULL, NULL::date, 'Antérieure à la loi n° 84-09 ; nom et chef-lieu : décret n° 84-79 du 3 avril 1984', NULL, NULL, TRUE),
  ('32', 'El Bayadh', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('33', 'Illizi', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('34', 'Bordj Bou Arréridj', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('35', 'Boumerdès', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('36', 'El Tarf', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('37', 'Tindouf', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('38', 'Tissemsilt', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('39', 'El Oued', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('40', 'Khenchela', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('41', 'Souk Ahras', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('42', 'Tipaza', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('43', 'Mila', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('44', 'Aïn Defla', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('45', 'Naâma', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('46', 'Aïn Témouchent', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('47', 'Ghardaïa', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('48', 'Relizane', NULL, '1984-02-04'::date, 'Loi n° 84-09 du 4 février 1984', NULL, NULL, TRUE),
  ('49', 'Timimoun', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('50', 'Bordj Badji Mokhtar', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('51', 'Ouled Djellal', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('52', 'Béni Abbès', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('53', 'In Salah', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('54', 'In Guezzam', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('55', 'Touggourt', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('56', 'Djanet', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('57', 'El M''Ghair', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('58', 'El Meniaa', NULL, '2019-12-11'::date, 'Loi n° 19-12 du 11 décembre 2019 (JO n° 78 du 18 décembre 2019)', NULL, NULL, TRUE),
  ('59', 'Aflou', 'أفلو', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '03', FALSE),
  ('60', 'Barika', 'بريكة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '05', FALSE),
  ('61', 'El Kantara', 'القنطرة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '07', FALSE),
  ('62', 'Bir El Ater', 'بئر العاتر', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '12', FALSE),
  ('63', 'El Aricha', 'العريشة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '13', FALSE),
  ('64', 'Ksar Chellala', 'قصر الشلالة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '14', FALSE),
  ('65', 'Aïn Ouessara', 'عين وسارة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '17', FALSE),
  ('66', 'Messaad', 'مسعد', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '17', FALSE),
  ('67', 'Ksar El Boukhari', 'قصر البخاري', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '26', FALSE),
  ('68', 'Bou Saâda', 'بوسعادة', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '28', FALSE),
  ('69', 'El Abiodh Sidi Cheikh', 'الأبيض سيدي الشيخ', '2026-04-04'::date, 'Loi n° 26-06 du 4 avril 2026 (JO n° 25 du 5 avril 2026) ; numéro : décret présidentiel n° 26-206 du 25 mai 2026 (JO n° 40 du 3 juin 2026)', '2027-01-01'::date, '32', FALSE)
ON CONFLICT ("code") DO UPDATE SET
  "nom" = EXCLUDED."nom",
  "nomAr" = COALESCE(EXCLUDED."nomAr", "Wilaya"."nomAr"),
  "creeeLe" = EXCLUDED."creeeLe",
  "texteCreation" = EXCLUDED."texteCreation",
  "enFonctionLe" = EXCLUDED."enFonctionLe",
  "wilayaMereCode" = EXCLUDED."wilayaMereCode";
