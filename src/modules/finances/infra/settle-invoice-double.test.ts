import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { syncInvoiceSettlement } from "./settle-invoice";

/**
 * MARQUER UNE FACTURE « PAYÉE » DEUX FOIS EN MÊME TEMPS N'ÉCRIT QU'UNE SORTIE D'ARGENT (audit données 2026-10-27).
 *
 * L'ancien chemin lisait `settlementTxId` (vide), créait l'écriture, puis posait le lien par le seul id,
 * hors transaction : deux gestes simultanés (deux onglets, deux comptables, `setInvoicePaid` et
 * `updateLegalDocument`) posaient DEUX écritures SETTLED au livre — la seconde écrasant le lien, la
 * première restant orpheline et comptée dans le solde du compte.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__setdbl__${Date.now()}`;
let actorId = "";
let docId = "";

suite("syncInvoiceSettlement — deux règlements simultanés, une seule écriture", () => {
  afterAll(async () => {
    await prisma.legalDocument.deleteMany({ where: { title: TAG } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { createdById: actorId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("la facture ne nomme qu'une écriture, et le livre n'en porte qu'une", async () => {
    actorId = (await prisma.user.create({ data: { name: TAG, email: `${TAG}@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } })).id;
    docId = (await prisma.legalDocument.create({
      data: { title: TAG, kind: "INVOICE", direction: "OUT", amount: 120_000, paidDate: new Date("2026-10-20"), counterparty: "SARL Atlas" },
    })).id;

    // Simultanés, et décalés de quelques millisecondes : assez pour ne pas se disputer la référence FIN-…,
    // pas assez pour que l'un voie le lien posé par l'autre.
    await Promise.all([0, 0, 5, 10].map((ms) => new Promise((r) => setTimeout(r, ms)).then(() => syncInvoiceSettlement(docId, actorId))));

    const ecritures = await prisma.financeTransaction.findMany({ where: { createdById: actorId }, select: { id: true } });
    expect(ecritures, "une seule sortie d'argent pour une facture").toHaveLength(1);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: docId }, select: { settlementTxId: true } });
    expect(doc.settlementTxId).toBe(ecritures[0]!.id);

    // Idempotent ensuite : un nouveau passage n'ajoute rien.
    await syncInvoiceSettlement(docId, actorId);
    expect(await prisma.financeTransaction.count({ where: { createdById: actorId } })).toBe(1);
  });
});
