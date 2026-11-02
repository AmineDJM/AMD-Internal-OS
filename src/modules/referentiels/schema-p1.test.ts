import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCHÉMA DES RÉFÉRENTIELS (refonte des données, palier P1) — additif, rejouable, sans dérive.
 *
 * `docs/architecture/refonte-donnees-et-monolithe-modulaire.md` : R1 Personne, R2 Organisation,
 * R3 Adresse / PointDeContact, R5 Piece, R6 coffre, E faits proposés → confirmés. Trois propriétés,
 * chacune par son vrai point d'entrée :
 *   1. le TEXTE de la migration est additif : il crée, il n'efface ni ne réécrit rien, ne remplit
 *      rien (le remplissage est P2) ;
 *   2. JOUÉE sur une base vierge puis REJOUÉE, elle aboutit au même état — et ses contraintes en base
 *      (un seul titulaire, aucune valeur sensible en clair) tiennent ; rejouée sur la base de travail
 *      (le cas d'un `migrate deploy` relancé), elle ne change rien ;
 *   3. `prisma migrate diff` ne voit AUCUN écart entre la base migrée et `schema.prisma` sur ce que
 *      la migration crée (la base porte des dérives plus anciennes, hors de ce lot : on les filtre).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const NOM = "20270130100000_referentiels";
const SQL = readFileSync(path.join(process.cwd(), "prisma/migrations", NOM, "migration.sql"), "utf8");

const TABLES = [
  "Personne", "PersonneRole", "Organisation", "OrganisationRole", "OrganisationIdentifiant", "Affiliation",
  "Adresse", "PointDeContact", "Piece", "PieceLien", "DonneeSensible", "AccesDonneeSensible",
  "Extraction", "FaitPropose", "FaitConfirme", "ConflitDeFait",
];
const ENUMS = [
  "RolePersonne", "RoleOrganisation", "TypeIdentifiantOrganisation", "TypeAdresse", "TypePointDeContact",
  "SourcePiece", "TypeSujetPiece", "TypeTitulaire", "StatutExtraction", "TypeSujetFait", "RoleSujetFait",
  "DecisionFaitPropose", "SourceFaitConfirme", "StatutConflitDeFait",
];
/** Les colonnes de LIEN ajoutées aux fiches existantes : [table, colonne]. */
const LIENS: [string, string][] = [
  ...["User", "Employee", "MedicalDoctor", "CareBeneficiary", "AdProVoyageur", "AdProHebergement",
    "RecruitmentCandidate", "DirectoryEntry", "SupplierUser"].map((t): [string, string] => [t, "personneId"]),
  ...["Company", "CompanyContact", "Supplier", "MedicalInstitution", "SponsoringRequest", "CongressNational",
    "CongressInternational"].map((t): [string, string] => [t, "organisationId"]),
  ["Document", "pieceId"], ["DriveNode", "pieceId"],
];

/** Le SQL découpé en instructions de tête (un bloc `DO $$ … $$` compte pour une). */
const instructions = (sql: string): string[] =>
  sql.replace(/^--.*$/gm, "").split(/;\s*\n(?![^$]*\$\$;)/).map((s) => s.trim()).filter(Boolean);

describe("La migration, lue", () => {
  it("ne supprime, ne renomme, ne réécrit ni ne remplit RIEN", () => {
    const code = SQL.replace(/^--.*$/gm, "");
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bRENAME\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+"/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN/i);
  });

  it("chaque instruction est idempotente par construction", () => {
    for (const s of instructions(SQL)) {
      if (/^DO \$\$/.test(s)) {
        expect(s, s).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
        continue;
      }
      expect(s, s).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS)/);
    }
  });

  it("une colonne de lien est NULLABLE et sa clé étrangère est `ON DELETE SET NULL`", () => {
    for (const [table, col] of LIENS) {
      expect(SQL, `${table}.${col}`).toMatch(new RegExp(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" TEXT;`));
      expect(SQL, `${table}.${col} FK`).toMatch(
        new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${col}_fkey" FOREIGN KEY \\("${col}"\\) REFERENCES "\\w+"\\("id"\\) ON DELETE SET NULL`),
      );
    }
  });

  it("aucune clé étrangère vers Wilaya / Commune : ce référentiel est chargé par un autre lot", () => {
    expect(SQL).not.toMatch(/REFERENCES "(Wilaya|Commune)"/);
  });
});

/** Joue le fichier instruction par instruction — Prisma n'en accepte qu'une par appel préparé. */
async function jouer(tx: { $executeRawUnsafe: typeof prisma.$executeRawUnsafe }): Promise<void> {
  for (const s of instructions(SQL)) await tx.$executeRawUnsafe(s);
}

const ANNULE = new Error("annulé — le banc ne garde rien");

/** Exécute `corps` dans une transaction TOUJOURS annulée. */
async function dansUnBancAnnule<T>(corps: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>): Promise<T> {
  let r: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      r = await corps(tx);
      throw ANNULE;
    }, { timeout: 60_000, maxWait: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return r as T;
}

/** Recommence `essai` tant qu'il échoue sur un délai de verrou dépassé (55P03) — jamais sur une autre erreur. */
async function avecReprise<T>(essai: () => Promise<T>, fois = 40): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await essai();
    } catch (e) {
      if (i >= fois || !/55P03|lock timeout/i.test(String((e as { message?: string })?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    }
  }
}

/** Les fiches existantes que la migration touche, réduites à leur clé — et l'énumération qu'elle emprunte. */
const SOUCHES = [
  `CREATE TYPE "Confidentiality" AS ENUM ('INTERNAL', 'RESTRICTED', 'CONFIDENTIAL')`,
  ...[...new Set(LIENS.map(([t]) => t))].map((t) => `CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY)`),
];

type Etat = { tables: string[]; colonnes: string[]; contraintes: string[]; index: string[]; enums: string[] };

async function etatDuSchema(tx: { $queryRawUnsafe: typeof prisma.$queryRawUnsafe }, schema: string): Promise<Etat> {
  const q = async (sql: string) => (await tx.$queryRawUnsafe<{ v: string }[]>(sql, schema)).map((x) => x.v).sort();
  return {
    tables: await q(`SELECT table_name AS v FROM information_schema.tables WHERE table_schema = $1`),
    colonnes: await q(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS v FROM information_schema.columns WHERE table_schema = $1`),
    contraintes: await q(`SELECT c.conrelid::regclass::text || ':' || c.conname || ':' || pg_get_constraintdef(c.oid) AS v FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1`),
    index: await q(`SELECT indexdef AS v FROM pg_indexes WHERE schemaname = $1`),
    enums: await q(`SELECT t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 GROUP BY t.typname`),
  };
}

suite("Jouée sur une base vierge, puis rejouée", () => {
  const BANC = "banc_referentiels_p1";

  it("crée les seize tables, les quatorze énumérations, les dix-huit liens — et la rejouer ne change rien", async () => {
    const { une, deux } = await dansUnBancAnnule(async (tx) => {
      // Un schéma JETABLE en tête du chemin de recherche : le SQL du FICHIER s'exécute tel qu'il est
      // écrit, sans lire ni écrire les tables réelles (la transaction est de toute façon annulée).
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${BANC}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${BANC}"`);
      for (const s of SOUCHES) await tx.$executeRawUnsafe(s);
      await jouer(tx);
      const une = await etatDuSchema(tx, BANC);
      await jouer(tx);
      const deux = await etatDuSchema(tx, BANC);
      return { une, deux };
    });
    for (const t of TABLES) expect(une.tables, t).toContain(t);
    for (const e of ENUMS) expect(une.enums.some((x) => x.startsWith(`${e}:`)), e).toBe(true);
    for (const [t, c] of LIENS) expect(une.colonnes, `${t}.${c}`).toContain(`${t}.${c}:text:YES:`);
    expect(deux).toEqual(une);
  });

  it("les contraintes en base tiennent : un seul titulaire, aucune valeur sensible en clair", async () => {
    const refus = await dansUnBancAnnule(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${BANC}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${BANC}"`);
      for (const s of SOUCHES) await tx.$executeRawUnsafe(s);
      await jouer(tx);
      await tx.$executeRawUnsafe(`INSERT INTO "Personne" (id, nom, "nomReplie", "updatedAt") VALUES ('p1', 'Benali', 'benali', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "Organisation" (id, "raisonSociale", "nomReplie", "updatedAt") VALUES ('o1', 'Imprimerie du Centre', 'imprimerie du centre', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "Piece" (id, empreinte, nom, "updatedAt") VALUES ('pc1', 'abc', 'devis.pdf', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "Extraction" (id, "pieceId", moteur, local, "updatedAt") VALUES ('x1', 'pc1', 'mrz-local/1', true, now())`);

      /** Vrai si Postgres REFUSE l'instruction (rattrapée par un point de reprise). */
      const refuse = async (sql: string): Promise<boolean> => {
        await tx.$executeRawUnsafe(`SAVEPOINT essai`);
        try {
          await tx.$executeRawUnsafe(sql);
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT essai`);
          return false;
        } catch {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT essai`);
          return true;
        }
      };
      const adr = (id: string, p: string | null, o: string | null) =>
        `INSERT INTO "Adresse" (id, "personneId", "organisationId", ligne1, "updatedAt") VALUES ('${id}', ${p ? `'${p}'` : "NULL"}, ${o ? `'${o}'` : "NULL"}, '1 rue', now())`;
      const fait = (id: string, sensible: boolean, valeur: string | null) =>
        `INSERT INTO "FaitPropose" (id, "extractionId", "sujetRef", "sujetType", role, attribut, valeur, "valeurNormalisee", confiance, preuve, sensible) VALUES ('${id}', 'x1', 'titulaire', 'PERSONNE', 'TITULAIRE', 'personne.passeport.numero', ${valeur ? `'${valeur}'` : "NULL"}, ${valeur ? `'${valeur}'` : "NULL"}, 0.95, '{}'::jsonb, ${sensible})`;
      return {
        adresseDePersonne: await refuse(adr("a1", "p1", null)),
        adresseDOrganisation: await refuse(adr("a2", null, "o1")),
        adresseDeDeux: await refuse(adr("a3", "p1", "o1")),
        adresseDePersonne0: await refuse(adr("a4", null, null)),
        contactDeDeux: await refuse(`INSERT INTO "PointDeContact" (id, "personneId", "organisationId", type, valeur, "valeurNormalisee", "updatedAt") VALUES ('c1', 'p1', 'o1', 'EMAIL', 'a@b.dz', 'a@b.dz', now())`),
        faitSensibleEnClair: await refuse(fait("f1", true, "AB123456")),
        faitSensibleAuCoffre: await refuse(fait("f2", true, null)),
        faitOrdinaire: await refuse(fait("f3", false, "Benali")),
        confianceHorsBornes: await refuse(`UPDATE "FaitPropose" SET confiance = 1.5 WHERE id = 'f3'`),
        confirmeSensibleEnClair: await refuse(`INSERT INTO "FaitConfirme" (id, "sujetType", "sujetId", attribut, valeur, sensible, source) VALUES ('fc1', 'PERSONNE', 'p1', 'personne.nin', '1234', true, 'SAISIE')`),
        identifiantEnDouble: await (async () => {
          await tx.$executeRawUnsafe(`INSERT INTO "OrganisationIdentifiant" (id, "organisationId", type, valeur, "valeurNormalisee") VALUES ('i1', 'o1', 'NIF', '000 216 0012', '0002160012')`);
          return refuse(`INSERT INTO "OrganisationIdentifiant" (id, "organisationId", type, valeur, "valeurNormalisee") VALUES ('i2', 'o1', 'NIF', '0002160012', '0002160012')`);
        })(),
      };
    });
    expect(refus).toEqual({
      adresseDePersonne: false,
      adresseDOrganisation: false,
      adresseDeDeux: true,
      adresseDePersonne0: true,
      contactDeDeux: true,
      faitSensibleEnClair: true,
      faitSensibleAuCoffre: false,
      faitOrdinaire: false,
      confianceHorsBornes: true,
      confirmeSensibleEnClair: true,
      identifiantEnDouble: true,
    });
  });
});

suite("Rejouée sur la base de travail (un `migrate deploy` relancé)", () => {
  it("PRÉMISSE : la migration y est appliquée", async () => {
    const r = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, TABLES,
    );
    expect(r[0]?.n, "lancer `npx prisma migrate deploy` sur la base locale").toBe(TABLES.length);
  });

  it("deux fois de suite, dans une transaction annulée : rien ne change", async () => {
    // Rejouer sur les VRAIES tables prend leurs verrous exclusifs un à un, pendant que les suites voisines y
    // écrivent : en attendant, ce banc pouvait former une étreinte fatale et Postgres tuait l'écriture d'un
    // VOISIN (CI 244c8695). Un délai de verrou plus court que la détection d'étreinte (1 s) fait renoncer CE banc
    // le premier — il relâche tout et recommence ; les voisins n'attendent jamais plus que ce délai.
    const { avant, apres } = await avecReprise(() => dansUnBancAnnule(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
      const avant = await etatDuSchema(tx, "public");
      await jouer(tx);
      await jouer(tx);
      return { avant, apres: await etatDuSchema(tx, "public") };
    }));
    expect(apres).toEqual(avant);
  }, 120_000);
});

suite("Aucune dérive entre la base migrée et `schema.prisma`", () => {
  it("`prisma migrate diff` ne propose rien sur les tables, énumérations et liens de ce lot", () => {
    const prismaCli = path.join(process.cwd(), "node_modules/.bin/prisma");
    const diff = execFileSync(prismaCli, [
      "migrate", "diff", "--from-url", process.env.DATABASE_URL ?? "", "--to-schema-datamodel", "prisma/schema.prisma", "--script",
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env });
    // La base porte des écarts plus anciens (hors de ce lot) : on ne retient que les instructions qui
    // nomment une table, une énumération ou une colonne de lien de ce lot.
    const noms = [...TABLES, ...ENUMS].map((n) => `"${n}"`);
    const cols = [...new Set(LIENS.map(([, c]) => `"${c}"`))];
    const concernees = instructions(diff).filter((s) =>
      noms.some((n) => s.includes(n)) ||
      LIENS.some(([t, c]) => s.includes(`"${t}"`) && s.includes(`"${c}"`)) ||
      (cols.some((c) => s.includes(c)) && /CONSTRAINT "\w+_(personneId|organisationId|pieceId)_fkey"/.test(s)),
    );
    expect(concernees).toEqual([]);
  }, 120_000);
});
