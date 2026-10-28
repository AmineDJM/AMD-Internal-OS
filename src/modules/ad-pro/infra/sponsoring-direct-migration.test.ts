import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MIGRATION « SPONSORING DIRECT SANS FACTURE EXIGÉE » (Direction, 05/10), jouée sur son TEXTE RÉEL.
 *
 * Les ordres NÉS ensuite portent `requiresInvoice: false` par le code (`facturePourPayer`) ; cette
 * migration ne règle que les ordres DÉJÀ nés et pas encore réglés d'un poste « versement à
 * l'association ». Trois propriétés :
 *   • elle atteint ce qu'elle doit (ordre en attente ou en révision d'un poste direct) ;
 *   • elle épargne tout le reste : un ordre RÉGLÉ (un fait), l'ordre d'un poste d'un autre genre, un
 *     ordre sans poste — une garde trop large passerait pour armée si on ne le prouvait pas (§118.17) ;
 *   • rejouée, elle ne change rien.
 *
 * Le patron est celui de §118.173 : des tables TEMPORAIRES du même nom (`pg_temp` passe devant
 * `public` pour la session), dans une transaction annulée — le SQL du fichier s'exécute tel qu'il est
 * écrit, sans lire ni écrire les ordres réels de la base partagée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SQL = readFileSync(path.join(process.cwd(), "prisma/migrations/20270111090000_sponsoring_direct_sans_facture/migration.sql"), "utf8");

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function jouer(avant: string[], rejouer = 1): Promise<Map<string, boolean>> {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  let lignes: { id: string; requiresInvoice: boolean }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "ExpenseOrder" ("id" text PRIMARY KEY, "requiresInvoice" boolean NOT NULL, "status" text NOT NULL) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "AdProItem" ("id" text PRIMARY KEY, "expenseOrderId" text, "kind" text NOT NULL) ON COMMIT DROP`);
      for (const s of avant) await tx.$executeRawUnsafe(s);
      for (let i = 0; i < rejouer; i++) await tx.$executeRawUnsafe(SQL);
      lignes = await tx.$queryRawUnsafe(`SELECT id, "requiresInvoice" FROM "ExpenseOrder" ORDER BY id`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return new Map(lignes.map((l) => [l.id, l.requiresInvoice]));
}
const ordre = (id: string, statut: string) => `INSERT INTO "ExpenseOrder" (id, "requiresInvoice", status) VALUES ('${id}', true, '${statut}')`;
const poste = (id: string, ordreId: string | null, kind: string) =>
  `INSERT INTO "AdProItem" (id, "expenseOrderId", kind) VALUES ('${id}', ${ordreId ? `'${ordreId}'` : "NULL"}, '${kind}')`;

const DECOR = [
  ordre("o-direct-attente", "PENDING"), poste("p1", "o-direct-attente", "ASSOCIATION_SUPPORT"),
  ordre("o-direct-revision", "REVISION_REQUESTED"), poste("p2", "o-direct-revision", "ASSOCIATION_SUPPORT"),
  ordre("o-direct-regle", "PAID"), poste("p3", "o-direct-regle", "ASSOCIATION_SUPPORT"),
  ordre("o-direct-annule", "CANCELLED"), poste("p4", "o-direct-annule", "ASSOCIATION_SUPPORT"),
  ordre("o-autre-poste", "PENDING"), poste("p5", "o-autre-poste", "OTHER"),
  ordre("o-sans-poste", "PENDING"),
];

suite("La migration du sponsoring direct, jouée sur son texte réel", () => {
  it("elle lève l'exigence des ordres en attente ou en révision d'un poste direct — et de ceux-là seulement", async () => {
    const r = await jouer(DECOR);
    expect(r.get("o-direct-attente"), "ordre en attente d'un poste direct").toBe(false);
    expect(r.get("o-direct-revision"), "ordre en révision d'un poste direct").toBe(false);
    expect(r.get("o-direct-regle"), "un ordre RÉGLÉ est un fait : on ne réécrit pas son histoire").toBe(true);
    expect(r.get("o-direct-annule"), "un ordre annulé ne bouge pas").toBe(true);
    expect(r.get("o-autre-poste"), "le poste d'un autre genre garde sa facture").toBe(true);
    expect(r.get("o-sans-poste"), "un ordre qu'aucun poste ne porte garde sa règle").toBe(true);
  });

  it("rejouée, elle ne change RIEN de plus", async () => {
    expect([...(await jouer(DECOR, 2))]).toEqual([...(await jouer(DECOR, 1))]);
  });

  it("le texte s'exécute contre le VRAI schéma (noms de colonnes, valeurs d'énumération) — dans une transaction annulée", async () => {
    // Les tables temporaires ci-dessus prouvent la logique ; elles ne prouvent pas que `status`, `kind`
    // et `expenseOrderId` existent sous ces noms, ni que les valeurs comparées sont celles de l'énumération.
    const ANNULE = new Error("annulé");
    let passe = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(SQL);
        passe = true;
        throw ANNULE;
      }, { timeout: 30_000 });
    } catch (e) {
      if (e !== ANNULE) throw e;
    }
    expect(passe).toBe(true);
  });

  it("le texte ne touche que ce qu'il nomme : aucune écriture hors `ExpenseOrder`, aucune valeur d'énumération ajoutée", () => {
    expect(SQL).not.toMatch(/ADD VALUE|ALTER TABLE|DROP |DELETE /i);
    expect(SQL).toMatch(/UPDATE "ExpenseOrder"/);
  });
});
