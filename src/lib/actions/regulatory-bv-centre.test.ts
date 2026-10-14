import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestBV } from "./regulatory-actions";

/**
 * LE BV D'UN DOSSIER RÉGLEMENTAIRE PASSE PAR LE CENTRE DE PAIEMENT D'ABORD (§118.202) — vérifié par
 * le vrai point d'entrée : l'ordre naît EN ATTENTE du centre, à l'entité du DOSSIER, la phrase dit
 * où il est parti ; et un fichier refusé n'en laisse aucun derrière lui.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__regbv${Date.now().toString(36)}__`;

suite("Demande de BV — centre de paiement d'abord", () => {
  let userId = "", societeId = "", produitId = "";
  beforeAll(async () => {
    const [u, soc] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.company.create({ data: { name: `${TAG}Société` } }),
    ]);
    userId = u.id; societeId = soc.id;
    produitId = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}dci`, brandName: `${TAG}Marque`, reference: `${TAG}REF`, companyId: soc.id } })).id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as SessionUser as CurrentUser;
  });
  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: produitId }, select: { id: true } });
    await prisma.document.deleteMany({ where: { entityId: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { sourceId: produitId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  });

  const fd = (o: Record<string, string>, fichier?: File) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    if (fichier) f.set("file", fichier);
    return f;
  };

  it("un fichier refusé : aucun ordre n'est créé", async () => {
    const r = await requestBV(fd({ productId: produitId, amount: "120000" }, new File([new Uint8Array([1, 2, 3])], "proforma.exe")));
    expect(r.ok).toBe(false);
    expect(await prisma.expenseOrder.count({ where: { sourceId: produitId } })).toBe(0);
  });

  it("l'ordre naît EN ATTENTE du centre, à l'entité du dossier, et la phrase le dit", async () => {
    const r = await requestBV(fd({ productId: produitId, amount: "120000", bvType: "BV d'enregistrement" }, new File([new Uint8Array([37, 80, 68, 70])], "proforma.pdf", { type: "application/pdf" })));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: produitId }, select: { id: true, centralStatus: true, companyId: true, reference: true } });
    expect(ordres).toHaveLength(1);
    expect(ordres[0]!.centralStatus, "le centre d'abord — les Finances ne le voient qu'autorisé").toBe("AWAITING");
    expect(ordres[0]!.companyId).toBe(societeId);
    expect(r.message).toContain("centre de paiement");
    expect(r.message).toContain(ordres[0]!.reference);
    expect(await prisma.document.count({ where: { entityType: "EXPENSE_ORDER", entityId: ordres[0]!.id } })).toBe(1);
  });
});
