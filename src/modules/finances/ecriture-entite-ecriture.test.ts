import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * LE LIVRE D'UNE AUTRE SOCIÉTÉ NE S'ÉCRIT PAS PAR SON IDENTIFIANT (audit sécurité 27/10, SECURITE-ACCES-10).
 * Un financier rattaché à Alpha ne modifie, ne solde, ne supprime pas une écriture de Beta, et n'en crée pas
 * au nom de Beta. Les siennes, oui.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { createTransaction, updateTransaction, updateTransactionStatus, deleteTransaction } from "./actions-tresorerie";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zlivre${Date.now()}`;
const ids = { A: "", B: "", fin: "", txA: "", txB: "" };
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const ecriture = (companyId: string, ref: string) =>
  prisma.financeTransaction.create({ data: { reference: ref, date: new Date(), direction: "OUT", category: "AUTRE", label: `${TAG} ${ref}`, amount: 1000, method: "BANK_TRANSFER", account: "Banque", status: "PENDING", companyId } });

suite("Livre comptable : les écritures suivent la porte de la fiche", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const u = await prisma.user.create({ data: { name: `${TAG} fin`, email: `${TAG}f@t.dz`, role: "COORDINATOR", passwordHash: "x" } });
    ids.fin = u.id;
    await prisma.employee.create({ data: { fullName: `${TAG} fin`, companyId: ids.A, userId: u.id, isActive: true } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "FINANCES", canView: true, canCreate: true, canUpdate: true, canDelete: true, scope: "ALL" } });
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "COORDINATOR", secondaryRole: null, access: await getAccess(u.id, "COORDINATOR") } as unknown as CurrentUser;
    ids.txA = (await ecriture(ids.A, `${TAG}-A`)).id;
    ids.txB = (await ecriture(ids.B, `${TAG}-B`)).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: ids.fin } }).catch(() => undefined);
    await prisma.financeTransaction.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { userId: ids.fin } }).catch(() => undefined);
    await prisma.userAccess.deleteMany({ where: { userId: ids.fin } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: ids.fin } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => undefined);
  }, 60_000);

  it("témoin : le financier a bien les droits du module", () => {
    expect(userCan(ACTOR as unknown as SessionUser, "FINANCES", "UPDATE")).toBe(true);
  });

  it("une écriture de Beta : ni soldée, ni modifiée, ni supprimée", async () => {
    expect((await updateTransactionStatus(form({ id: ids.txB, status: "SETTLED" }))).ok).toBe(false);
    expect((await updateTransaction(form({ id: ids.txB, label: "pris", amount: "1" }))).ok).toBe(false);
    expect((await deleteTransaction(form({ id: ids.txB }))).ok).toBe(false);
    const b = await prisma.financeTransaction.findUnique({ where: { id: ids.txB } });
    expect(b?.status).toBe("PENDING");
    expect(Number(b?.amount)).toBe(1000);
  });

  it("pas de création au nom de Beta", async () => {
    expect((await createTransaction(undefined, form({ label: `${TAG} forgée`, amount: "5", companyId: ids.B }))).ok).toBe(false);
  });

  it("une écriture d'Alpha : soldée normalement", async () => {
    expect((await updateTransactionStatus(form({ id: ids.txA, status: "SETTLED" }))).ok).toBe(true);
  });
});
