import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { prisma, estUneBaseLocale } from "@/lib/prisma";
import { ecarts, juger, instructions } from "./analyse";
import { EXCEPTIONS, REGLES } from "./exceptions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONTRÔLE DE DÉRIVE SCHÉMA ↔ BASE MIGRÉE (refonte P0 — docs/architecture/refonte-p0-outillage.md).
 *
 * Le typecheck compile contre `schema.prisma` ; la production tourne sur ce que les migrations SQL
 * ont construit. Rien ne vérifiait que les deux disent la même chose (KB 03 §6) : un champ ajouté
 * au schéma sans sa migration compile, passe le build, et casse à la première requête en
 * production. Ce test compare la base LOCALE, migrée par `prisma migrate deploy`, au schéma, et
 * échoue sur tout écart qui n'est pas dans `exceptions.ts` — ou sur une exception devenue sans
 * objet (la dette a été soldée : retirer la ligne).
 *
 * Sans base joignable, la partie base se saute (comme les autres bancs) ; l'analyseur, lui, est
 * toujours testé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const URL_BASE = process.env.DATABASE_URL ?? "";
let dbOk = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbOk = estUneBaseLocale(URL_BASE);
} catch {
  dbOk = false;
}

describe("analyse d'un script migrate diff", () => {
  const SCRIPT = `-- DropForeignKey
ALTER TABLE "A" DROP CONSTRAINT "A_bId_fkey";

-- DropIndex
DROP INDEX "A_x_trgm";

-- AlterTable
ALTER TABLE "A" ALTER COLUMN "tags" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ADD COLUMN "nouveau" TEXT;

-- AlterTable
ALTER TABLE "S" ALTER COLUMN "id" SET DEFAULT 'global, avec virgule';

-- CreateIndex
CREATE UNIQUE INDEX "A_k_key" ON "A"("k");

-- RenameIndex
ALTER INDEX "A_court" RENAME TO "A_x_y_idx";

-- DropTable
DROP TABLE "Vieille";

-- AddForeignKey
ALTER TABLE "A" ADD CONSTRAINT "A_bId_fkey" FOREIGN KEY ("bId") REFERENCES "B"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE EXTENSION "inconnu";
`;

  it("découpe chaque clause en un écart à clé stable", () => {
    expect(ecarts(SCRIPT).map((e) => e.cle)).toEqual([
      "fk:A_bId_fkey:DROP",
      "index:A_x_trgm:DROP",
      "defaut:A.tags:DROP",
      "defaut:A.updatedAt:DROP",
      "colonne:A.nouveau:ADD",
      "defaut:S.id:SET 'global, avec virgule'",
      "index:A_k_key:CREATE UNIQUE",
      "index:A_court->A_x_y_idx:RENAME",
      "table:Vieille:DROP",
      "fk:A_bId_fkey:ADD",
      'autre:CREATE EXTENSION "inconnu"',
    ]);
  });

  it("juge : exception connue, règle, écart nouveau, exception périmée — et jamais une règle sur l'inconnu", () => {
    const v = juger(
      ecarts(SCRIPT),
      [
        { cle: "index:A_x_trgm:DROP", raison: "trigramme" },
        { cle: "table:Disparue:DROP", raison: "soldée depuis" },
      ],
      [...REGLES, { nom: "tout", accepte: () => true, raison: "règle trop large" }],
    );
    expect(v.perimees.map((e) => e.cle)).toEqual(["table:Disparue:DROP"]);
    expect(v.parRegle["updatedAt-defaut-sql"]).toBe(1);
    expect(v.nouveaux.map((e) => e.cle)).toEqual(['autre:CREATE EXTENSION "inconnu"']);
  });

  it("un script vide ne produit aucun écart", () => {
    expect(instructions("-- This is an empty migration.\n")).toEqual([]);
    expect(ecarts("")).toEqual([]);
  });

  it("chaque exception porte une raison et n'est listée qu'une fois", () => {
    const vues = new Set<string>();
    for (const e of EXCEPTIONS) {
      expect(e.raison.trim().length, e.cle).toBeGreaterThan(20);
      expect(vues.has(e.cle), `exception en double : ${e.cle}`).toBe(false);
      vues.add(e.cle);
    }
  });
});

describe.skipIf(!dbOk)("schema.prisma ↔ base locale migrée", () => {
  it("toutes les migrations du dépôt sont appliquées (sinon le diff mesurerait le retard, pas la dérive)", async () => {
    const surDisque = fs
      .readdirSync("prisma/migrations", { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const appliquees = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const faites = new Set(appliquees.map((r) => r.migration_name));
    const manquantes = surDisque.filter((n) => !faites.has(n));
    expect(manquantes, "base locale en retard : lancer `npm run db:deploy`").toEqual([]);
  });

  it("aucun écart nouveau, aucune exception périmée", () => {
    const binaire = path.resolve("node_modules/.bin/prisma");
    const script = execFileSync(
      binaire,
      ["migrate", "diff", "--from-url", URL_BASE, "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      { encoding: "utf8", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, maxBuffer: 32 * 1024 * 1024 },
    );
    const v = juger(ecarts(script), EXCEPTIONS, REGLES);
    const message = [
      v.nouveaux.length
        ? `DÉRIVE NOUVELLE — la base migrée et schema.prisma divergent (migration manquante, ou exception à justifier dans src/lib/derive-schema/exceptions.ts) :\n` +
          v.nouveaux.map((e) => `  ${e.cle}\n      ${e.sql}`).join("\n")
        : "",
      v.perimees.length
        ? `EXCEPTIONS PÉRIMÉES — l'écart a disparu, retirer ces lignes de exceptions.ts :\n` +
          v.perimees.map((e) => `  ${e.cle}`).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    expect(v.nouveaux.length + v.perimees.length, message).toBe(0);
  }, 60_000);
});
