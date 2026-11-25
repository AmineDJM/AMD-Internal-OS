import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MIGRATION DE DÉDOUBLONNAGE (20270249300000), jouée sur un DÉCOR FIDÈLE au relevé de production du 25/11/2026 :
 *
 *   • Adventum : « Administration » créée à la main (module NULL, une dépense de trésorerie sur « Dons et mécénat ») et
 *     « Administration <année> » ouverte d'office (lignes à clé, une dépense budgétaire, un ordre de dépense) ;
 *   • « Operations & Sales » d'une société (30 M DZD) et sa jumelle SANS société, vide : retirée ;
 *   • une jumelle sans société qui PORTE une dépense : fusionnée, la dépense suit ;
 *   • l'ancienne enveloppe « Moyens généraux » du groupe, marquée par la migration des charges fixes : ses dépenses vont
 *     par société sur « Moyens généraux » de l'Administration, ses montants à Adventum, elle est retirée.
 *
 * Puis REJOUÉE : le second passage ne change rien. Tout se joue dans UNE transaction ANNULÉE à la fin — la migration est
 * globale, et la base de test des autres suites n'a pas à la subir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__dedup${Date.now().toString(36)}__`;
const ANNEE = 2031;
const debut = new Date(Date.UTC(ANNEE, 0, 1));
const fin = new Date(Date.UTC(ANNEE, 11, 31, 23, 59, 59));
const ANNULER = "ANNULER_LE_DECOR";

/** Les instructions du fichier — un `;` à l'intérieur d'un corps `$tag$ … $tag$` n'en termine pas une. */
function instructions(sql: string): string[] {
  const sansCommentaires = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const out: string[] = [];
  let courant = "";
  let dollar: string | null = null;
  for (let i = 0; i < sansCommentaires.length; i++) {
    const ch = sansCommentaires[i]!;
    if (ch === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sansCommentaires.slice(i));
      if (m) {
        if (dollar === null) dollar = m[0];
        else if (dollar === m[0]) dollar = null;
        courant += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === ";" && dollar === null) {
      if (courant.trim()) out.push(courant.trim());
      courant = "";
      continue;
    }
    courant += ch;
  }
  if (courant.trim()) out.push(courant.trim());
  return out;
}

const MIGRATION = instructions(readFileSync("prisma/migrations/20270249300000_enveloppes_dedoublonnees/migration.sql", "utf8"));

type Tx = Prisma.TransactionClient;
const jouer = async (tx: Tx) => { for (const s of MIGRATION) await tx.$executeRawUnsafe(s); };

suite("Dédoublonnage des enveloppes — migration sur un décor fidèle, rejouée", () => {
  it("fusionne sans rien perdre, retire le doublon vide, verse les moyens généraux par société — et le rejeu ne change rien", async () => {
    await prisma.$transaction(async (tx) => {
      const adventum = (await tx.company.findUnique({ where: { id: "company_adventum" }, select: { id: true } }))?.id
        ?? (await tx.company.create({ data: { id: "company_adventum", name: "Adventum Pharma" } })).id;
      const socB = (await tx.company.create({ data: { name: `${TAG} Pharmagène` } })).id;

      // ── 1. ADMINISTRATION d'Adventum : la main, puis l'office ────────────────────────────────────────────────────
      const humaine = await tx.budgetEnvelope.create({ data: { name: "Administration", companyId: adventum, periodStart: debut, periodEnd: fin, totalAmount: 1_000_000, createdAt: new Date(Date.UTC(ANNEE, 7, 10)) } });
      const dons = await tx.budgetCategoryLine.create({ data: { envelopeId: humaine.id, name: "Dons et mécénat", allocated: 100_000 } });
      for (const n of ["Loyer", "Électricité", "Eau", "Divers"]) await tx.budgetCategoryLine.create({ data: { envelopeId: humaine.id, name: n, allocated: 10_000 } });
      const ftDons = await tx.financeTransaction.create({ data: { reference: `${TAG}FT1`, direction: "OUT", category: "AUTRE", label: "Don", amount: 25_000, status: "SETTLED", date: new Date(Date.UTC(ANNEE, 8, 1)), budgetCategoryId: dons.id, companyId: adventum } });

      const office = await tx.budgetEnvelope.create({ data: { name: `Administration ${ANNEE}`, module: "ADMINISTRATION", companyId: adventum, managerRoles: ["FINANCE_BUDGET_MANAGER"], periodStart: debut, periodEnd: fin, totalAmount: 0, createdAt: new Date(Date.UTC(ANNEE, 10, 25)) } });
      const donsOffice = await tx.budgetCategoryLine.create({ data: { envelopeId: office.id, name: "Dons et mécénat", cle: "DONS_MECENAT" } });
      const reserve = await tx.budgetCategoryLine.create({ data: { envelopeId: office.id, name: "Réserve pour imprévus", cle: "RESERVE_IMPREVUS" } });
      const mgAdv = await tx.budgetCategoryLine.create({ data: { envelopeId: office.id, name: "Moyens généraux", cle: "MOYENS_GENERAUX", module: "GENERAL_MEANS" } });
      const fournAdv = await tx.budgetCategoryLine.create({ data: { envelopeId: office.id, parentId: mgAdv.id, name: "Fournitures", cle: "MG_FOURNITURES", module: "GENERAL_MEANS" } });
      const ftOffice = await tx.financeTransaction.create({ data: { reference: `${TAG}FT2`, direction: "OUT", category: "AUTRE", label: "Mécénat", amount: 5_000, status: "SETTLED", date: new Date(Date.UTC(ANNEE, 9, 1)), budgetCategoryId: donsOffice.id, companyId: adventum } });
      const ligneBudget = await tx.budgetExpenseLine.create({ data: { categoryId: reserve.id, reference: `${TAG} imprévu`, amount: 7_000 } });
      const ordre = await tx.expenseOrder.create({ data: { reference: `${TAG}OD1`, label: "Ramettes", amount: 3_000, budgetCategoryId: fournAdv.id, companyId: adventum } });

      // ── 2. LA RÈGLE DU DOUBLON ─────────────────────────────────────────────────────────────────────────────────
      const ops = await tx.budgetEnvelope.create({ data: { name: `${TAG} Operations & Sales ${ANNEE}`, domaine: "OPERATIONS", companyId: socB, periodStart: debut, periodEnd: fin, totalAmount: 30_000_000 } });
      await tx.budgetCategoryLine.create({ data: { envelopeId: ops.id, name: "Masse salariale force de vente", cle: "MASSE_SALARIALE_FDV", allocated: 20_000_000 } });
      const jumelleVide = await tx.budgetEnvelope.create({ data: { name: `${TAG} Operations & Sales ${ANNEE}`, domaine: "OPERATIONS", periodStart: debut, periodEnd: fin } });
      await tx.budgetCategoryLine.create({ data: { envelopeId: jumelleVide.id, name: "Masse salariale force de vente", cle: "MASSE_SALARIALE_FDV" } });
      for (const n of ["Séminaires", "Déplacements"]) await tx.budgetCategoryLine.create({ data: { envelopeId: jumelleVide.id, name: n } });

      const reg = await tx.budgetEnvelope.create({ data: { name: `${TAG} Regulatory ${ANNEE}`, domaine: "REGULATORY", companyId: socB, periodStart: debut, periodEnd: fin, totalAmount: 2_000_000 } });
      const jumellePleine = await tx.budgetEnvelope.create({ data: { name: `${TAG} Regulatory ${ANNEE}`, domaine: "REGULATORY", periodStart: debut, periodEnd: fin, totalAmount: 500 } });
      const bv = await tx.budgetCategoryLine.create({ data: { envelopeId: jumellePleine.id, name: "BV 25 %", cle: "BV_25", allocated: 500 } });
      const ftBv = await tx.financeTransaction.create({ data: { reference: `${TAG}FT3`, direction: "OUT", category: "AUTRE", label: "BV", amount: 400, status: "SETTLED", date: new Date(Date.UTC(ANNEE, 2, 1)), budgetCategoryId: bv.id } });

      // ── 3. L'ANCIENNE ENVELOPPE « MOYENS GÉNÉRAUX » ─────────────────────────────────────────────────────────────
      const adminB = await tx.budgetEnvelope.create({ data: { name: `Administration ${ANNEE}`, module: "ADMINISTRATION", companyId: socB, periodStart: debut, periodEnd: fin } });
      await tx.budgetCategoryLine.create({ data: { envelopeId: adminB.id, name: "Moyens généraux", cle: "MOYENS_GENERAUX", module: "GENERAL_MEANS" } });
      const vieille = await tx.budgetEnvelope.create({ data: {
        name: "Moyens généraux", periodStart: debut, periodEnd: fin, totalAmount: 50_000,
        notes: "Les moyens generaux sont passes par societe dans le budget de l'Administration (24/11/2026) : cette enveloppe garde l'historique.",
      } });
      const fourn = await tx.budgetCategoryLine.create({ data: { envelopeId: vieille.id, name: "Fournitures", cle: "MG_FOURNITURES", allocated: 40_000 } });
      const papier = await tx.budgetCategoryLine.create({ data: { envelopeId: vieille.id, parentId: fourn.id, name: "Papier", allocated: 5_000 } });
      const depB = await tx.department.create({ data: { name: `${TAG} Admin B`, code: `${TAG}B`, companyId: socB } });
      const depenseB = await tx.departmentBudgetExpense.create({ data: { departmentId: depB.id, year: ANNEE, label: "Ramettes B", amount: 3_000, budgetCategoryId: papier.id } });
      const ftSans = await tx.financeTransaction.create({ data: { reference: `${TAG}FT4`, direction: "OUT", category: "AUTRE", label: "Stylos", amount: 800, status: "SETTLED", date: new Date(Date.UTC(ANNEE, 4, 1)), budgetCategoryId: fourn.id } });
      const ligneMg = await tx.budgetExpenseLine.create({ data: { categoryId: fourn.id, reference: `${TAG} cartouches`, amount: 1_200 } });

      const auditsAvant = await tx.auditLog.count({ where: { module: "Budgets", summary: { startsWith: "Dedoublonnage" } } });
      await jouer(tx);

      // ── 1. Une seule Administration, celle de la main, alignée, et rien de perdu ─────────────────────────────────
      const admins = await tx.budgetEnvelope.findMany({ where: { companyId: adventum, module: "ADMINISTRATION", periodStart: { gte: debut, lte: fin } } });
      expect(admins.map((e) => e.id)).toEqual([humaine.id]);
      expect(admins[0]).toMatchObject({ name: `Administration ${ANNEE}`, module: "ADMINISTRATION" });
      expect(admins[0]!.managerRoles).toContain("FINANCE_BUDGET_MANAGER");
      expect(await tx.budgetEnvelope.findUnique({ where: { id: office.id } })).toBeNull();
      const lignesDons = await tx.budgetCategoryLine.findMany({ where: { envelopeId: humaine.id, name: "Dons et mécénat" } });
      expect(lignesDons.map((l) => l.id)).toEqual([dons.id]); // une seule ligne, celle de la main…
      expect(lignesDons[0]!.cle).toBe("DONS_MECENAT"); // … qui prend la clé reconnue
      expect(Number(lignesDons[0]!.allocated)).toBe(100_000);
      expect((await tx.financeTransaction.findUniqueOrThrow({ where: { id: ftDons.id } })).budgetCategoryId).toBe(dons.id);
      expect((await tx.financeTransaction.findUniqueOrThrow({ where: { id: ftOffice.id } })).budgetCategoryId).toBe(dons.id);
      expect((await tx.budgetCategoryLine.findUniqueOrThrow({ where: { id: reserve.id } })).envelopeId).toBe(humaine.id);
      expect((await tx.budgetExpenseLine.findUniqueOrThrow({ where: { id: ligneBudget.id } })).categoryId).toBe(reserve.id);
      expect((await tx.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } })).budgetCategoryId).toBe(fournAdv.id);
      expect((await tx.budgetCategoryLine.findUniqueOrThrow({ where: { id: fournAdv.id } })).envelopeId).toBe(humaine.id);

      // ── 2. Le doublon vide est retiré sans rien ajouter ; le doublon plein est fusionné, sa dépense suit ─────────
      expect(await tx.budgetEnvelope.findUnique({ where: { id: jumelleVide.id } })).toBeNull();
      expect(await tx.budgetCategoryLine.count({ where: { envelopeId: ops.id } })).toBe(1);
      expect(Number((await tx.budgetEnvelope.findUniqueOrThrow({ where: { id: ops.id } })).totalAmount)).toBe(30_000_000);
      expect(await tx.budgetEnvelope.findUnique({ where: { id: jumellePleine.id } })).toBeNull();
      expect((await tx.budgetCategoryLine.findUniqueOrThrow({ where: { id: bv.id } })).envelopeId).toBe(reg.id);
      expect((await tx.financeTransaction.findUniqueOrThrow({ where: { id: ftBv.id } })).budgetCategoryId).toBe(bv.id);
      expect(Number((await tx.budgetEnvelope.findUniqueOrThrow({ where: { id: reg.id } })).totalAmount)).toBe(2_000_500);

      // ── 3. Les moyens généraux : par société, à défaut Adventum ; les montants à Adventum ; l'ancienne retirée ───
      expect(await tx.budgetEnvelope.findUnique({ where: { id: vieille.id } })).toBeNull();
      const depB2 = await tx.departmentBudgetExpense.findUniqueOrThrow({ where: { id: depenseB.id }, include: { budgetCategory: { include: { parent: true, envelope: true } } } });
      expect(depB2.budgetCategory).toMatchObject({ name: "Fournitures", cle: "MG_FOURNITURES" });
      expect(depB2.budgetCategory?.parent?.cle).toBe("MOYENS_GENERAUX");
      expect(depB2.budgetCategory?.envelope.id).toBe(adminB.id);
      expect((await tx.financeTransaction.findUniqueOrThrow({ where: { id: ftSans.id } })).budgetCategoryId).toBe(fournAdv.id);
      expect((await tx.budgetExpenseLine.findUniqueOrThrow({ where: { id: ligneMg.id } })).categoryId).toBe(fournAdv.id);
      expect(Number((await tx.budgetCategoryLine.findUniqueOrThrow({ where: { id: fournAdv.id } })).allocated)).toBe(40_000);
      expect(Number((await tx.budgetCategoryLine.findUniqueOrThrow({ where: { id: mgAdv.id } })).allocated)).toBe(40_000);
      expect(Number((await tx.budgetEnvelope.findUniqueOrThrow({ where: { id: humaine.id } })).totalAmount)).toBe(1_050_000);

      // La trace : une ligne d'audit par fusion (Administration, deux doublons, moyens généraux), au moins.
      expect(await tx.auditLog.count({ where: { module: "Budgets", summary: { startsWith: "Dedoublonnage" } } })).toBeGreaterThanOrEqual(auditsAvant + 4);

      // ── LE REJEU : rien ne bouge ─────────────────────────────────────────────────────────────────────────────────
      const photo = async () => {
        const envs = await tx.budgetEnvelope.findMany({ where: { id: { in: [humaine.id, ops.id, reg.id, adminB.id] } }, include: { categories: true }, orderBy: { id: "asc" } });
        return JSON.stringify(envs.map((e) => ({ ...e, updatedAt: null, categories: e.categories.map((c) => ({ ...c, updatedAt: null })).sort((a, b) => a.id.localeCompare(b.id)) })));
      };
      const avant = await photo();
      const audits = await tx.auditLog.count({ where: { module: "Budgets", summary: { startsWith: "Dedoublonnage" } } });
      await jouer(tx);
      expect(await photo()).toBe(avant);
      expect(await tx.auditLog.count({ where: { module: "Budgets", summary: { startsWith: "Dedoublonnage" } } })).toBe(audits);

      throw new Error(ANNULER);
    }, { timeout: 180_000, maxWait: 20_000 }).catch((e: unknown) => {
      if (!(e instanceof Error && e.message === ANNULER)) throw e;
    });
  }, 240_000);
});
