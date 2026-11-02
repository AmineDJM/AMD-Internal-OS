import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { deleteBudgetCategory, deleteEnvelope } from "./budget-envelope-actions";

/**
 * SUPPRIMER UNE CATÉGORIE / UNE ENVELOPPE N'EFFACE AUCUNE DÉPENSE BUDGÉTAIRE (audit données 2026-10-27).
 *
 * `BudgetExpenseLine.categoryId` est en cascade : l'ancien geste supprimait, avec la catégorie (ou
 * l'enveloppe, ou la catégorie de tête d'une sous-catégorie), chaque dépense saisie dessous — alors que
 * l'écran promettait qu'elles « repasseraient à imputer ». Le témoin : la ligne survit, le refus est dit.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__budsupp__${Date.now()}`;
let envId = "", teteId = "", sousId = "", ligneId = "";

function form(extra: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

suite("suppression d'une catégorie ou d'une enveloppe budgétaire — les dépenses saisies ne partent pas en cascade", () => {
  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { name: `${TAG}a`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    ACTOR = { id: admin.id, name: admin.name, email: admin.email, role: "SUPER_ADMIN", access: await getAccess(admin.id, "SUPER_ADMIN"), mustChangePassword: false };
    const env = await prisma.budgetEnvelope.create({
      data: { name: TAG, modules: ["REGULATORY"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1000 },
    });
    envId = env.id;
    teteId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG} tête`, allocated: 1000 } })).id;
    sousId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG} sous`, parentId: teteId, allocated: 500 } })).id;
    ligneId = (await prisma.budgetExpenseLine.create({ data: { categoryId: sousId, reference: `${TAG} BV payé`, amount: 420 } })).id;
  });

  afterAll(async () => {
    await prisma.budgetExpenseLine.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: TAG } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("refuse de supprimer la catégorie de TÊTE dont une sous-catégorie porte une dépense — la dépense survit", async () => {
    const r = await deleteBudgetCategory(form({ id: teteId }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/1 dépense/);
    expect(await prisma.budgetExpenseLine.count({ where: { id: ligneId } })).toBe(1);
    expect(await prisma.budgetCategoryLine.count({ where: { id: { in: [teteId, sousId] } } })).toBe(2);
  });

  it("refuse de supprimer l'ENVELOPPE qui porte une dépense — rien n'est effacé", async () => {
    const r = await deleteEnvelope(form({ id: envId }));
    expect(r.ok).toBe(false);
    expect(await prisma.budgetExpenseLine.count({ where: { id: ligneId } })).toBe(1);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(1);
  });

  it("une fois la dépense retirée, la catégorie puis l'enveloppe se suppriment", async () => {
    await prisma.budgetExpenseLine.delete({ where: { id: ligneId } });
    expect((await deleteBudgetCategory(form({ id: teteId }))).ok).toBe(true);
    expect(await prisma.budgetCategoryLine.count({ where: { id: { in: [teteId, sousId] } } })).toBe(0);
    expect((await deleteEnvelope(form({ id: envId }))).ok).toBe(true);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(0);
  });
});
