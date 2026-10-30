import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { avertissementBudget } from "./budget";

/**
 * LE CONTRÔLE DE BUDGET AVANT DE REMPLIR — un éclairage pour qui consulte les Budgets à l'écran,
 * AUCUN chiffre pour qui ne les consulte pas (l'assistante de direction n'a pas « Budgets »).
 */
const TAG = `__iabud_${Date.now().toString(36)}_`;
let assistante: CurrentUser;
let admin: CurrentUser;

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false } as CurrentUser;
}

beforeAll(async () => {
  assistante = await compte("assistante", "DIRECTION_ASSISTANT");
  admin = await compte("admin", "SUPER_ADMIN");
});
afterAll(async () => { await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {}); });

describe("avertissementBudget", () => {
  it("LIMITE : sans le module Budgets, aucun chiffre d'enveloppe — la Direction arbitre", async () => {
    const a = await avertissementBudget(assistante, 1_200_000);
    expect(a).toMatch(/la Direction arbitre/);
    expect(a).not.toMatch(/\d{3}/);
  });

  it("avec Budgets : l'enveloppe qu'il voit, ou l'absence d'enveloppe — jamais une erreur", async () => {
    const a = await avertissementBudget(admin, 1_200_000);
    expect(a).toMatch(/^Budget : /);
  });
});
