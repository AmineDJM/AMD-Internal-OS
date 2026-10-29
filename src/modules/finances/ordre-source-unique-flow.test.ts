import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";

/**
 * UNE DEMANDE DE PAIEMENT, UNE AVANCE : UN SEUL ORDRE VIVANT, GARDÉ PAR LA BASE (audit 27/10/2026, DONNEES-10).
 *
 * Vingt et un appelants de `createExpenseOrder` portent chacun leur garde ; deux l'avaient manquée. Pour les sources
 * à ordre unique, l'index partiel `ExpenseOrder_source_unique_vivant` refuse le second ordre vivant, quelle que soit
 * la porte qui l'émet. Un ordre annulé libère la place ; les sources à plusieurs ordres (pièce Legal payée en parts)
 * ne sont pas touchées.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zunique${Date.now().toString(36)}`;
let n = 0;
const ordre = (sourceType: "PAYMENT_REQUEST" | "SALARY_ADVANCE" | "LEGAL_DOCUMENT", sourceId: string, status: "PENDING" | "CANCELLED" = "PENDING") =>
  prisma.expenseOrder.create({ data: { reference: `${TAG}-${++n}`, label: `${TAG} ${n}`, amount: 1000, status, sourceType, sourceId } });

suite("ExpenseOrder — un seul ordre vivant par demande de paiement / avance", () => {
  afterAll(async () => {
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
  });

  it("le second ordre vivant d'une même demande de paiement est refusé par la base", async () => {
    await ordre("PAYMENT_REQUEST", `${TAG}-dp`);
    await expect(ordre("PAYMENT_REQUEST", `${TAG}-dp`)).rejects.toMatchObject({ code: "P2002" });
  });

  it("idem pour une avance sur salaire ; un ordre annulé libère la place", async () => {
    await ordre("SALARY_ADVANCE", `${TAG}-av`, "CANCELLED");
    await ordre("SALARY_ADVANCE", `${TAG}-av`);
    await expect(ordre("SALARY_ADVANCE", `${TAG}-av`)).rejects.toMatchObject({ code: "P2002" });
  });

  it("une pièce Legal, payée en parts, garde ses ordres multiples", async () => {
    await ordre("LEGAL_DOCUMENT", `${TAG}-fac`);
    await expect(ordre("LEGAL_DOCUMENT", `${TAG}-fac`)).resolves.toBeTruthy();
  });
});
