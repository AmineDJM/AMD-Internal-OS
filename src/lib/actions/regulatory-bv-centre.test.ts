import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestBV } from "./regulatory-actions";

/**
 * LA DEMANDE DE BV D'UN DOSSIER PART AU CENTRE DE VALIDATIONS (Super Admin, 24/11/2026) — vérifié par le vrai point
 * d'entrée : une demande de validation liée au DOSSIER, aucun ordre de dépense, la phrase dit où elle est partie ; un
 * fichier refusé n'en laisse aucune derrière lui (§118.202) ; un BV qui ne dit pas sa part est refusé.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__regbv${Date.now().toString(36)}__`;

suite("Demande de BV — Centre de validations", () => {
  let userId = "", membreId = "", societeId = "", produitId = "";
  beforeAll(async () => {
    const [u, soc] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.company.create({ data: { name: `${TAG}Société` } }),
    ]);
    userId = u.id; societeId = soc.id;
    membreId = (await prisma.user.create({ data: { name: `${TAG}membre`, email: `${TAG}membre@t.dz`, role: "COORDINATOR", passwordHash: "x" } })).id;
    await prisma.userAccess.create({ data: { userId: membreId, module: "VALIDATION_CENTRE", canView: true } });
    produitId = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}dci`, brandName: `${TAG}Marque`, reference: `${TAG}REF`, companyId: soc.id } })).id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false } as unknown as SessionUser as CurrentUser;
  });
  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: produitId }, select: { id: true } });
    await retirerDocumentsEtContenu({ where: { entityId: { in: ordres.map((o) => o.id) } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { sourceId: produitId } }).catch(() => undefined);
    await prisma.validationRequest.deleteMany({ where: { entityId: produitId } }).catch(() => undefined);
    await retirerDocumentsEtContenu({ where: { entityId: produitId } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: [userId, membreId] } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: [userId, membreId] } } }).catch(() => undefined);
  });

  const fd = (o: Record<string, string>, fichier?: File) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    if (fichier) f.set("file", fichier);
    return f;
  };

  it("un fichier refusé, ou un BV sans part : aucune demande n'est créée", async () => {
    const r = await requestBV(fd({ productId: produitId, stepKey: "bv25_req", amount: "120000" }, new File([new Uint8Array([1, 2, 3])], "proforma.exe")));
    expect(r.ok).toBe(false);
    const sansPart = await requestBV(fd({ productId: produitId, amount: "120000", bvType: "BV d'enregistrement" }));
    expect(sansPart.ok).toBe(false);
    expect(sansPart.error).toMatch(/BV 25 %/);
    expect(await prisma.validationRequest.count({ where: { entityId: produitId } })).toBe(0);
  });

  it("la demande part au Centre de validations, liée au dossier, sans ordre de dépense — la phrase le dit", async () => {
    const r = await requestBV(fd({ productId: produitId, amount: "120000", bvType: "BV 75 %" }, new File([new Uint8Array([37, 80, 68, 70])], "proforma.pdf", { type: "application/pdf" })));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const [v] = await prisma.validationRequest.findMany({ where: { entityId: produitId }, include: { steps: true } });
    expect(v.objectType).toBe("REGULATORY_BV_75");
    expect(v.entityType).toBe("REGULATORY_PRODUCT");
    expect(v.steps.map((e) => e.validatorId)).toContain(membreId);
    expect(r.message).toContain("Centre de validations");
    expect(r.message).toContain(v.reference);
    expect(await prisma.expenseOrder.count({ where: { sourceId: produitId } })).toBe(0);
    expect(await prisma.document.count({ where: { entityType: "REGULATORY_PRODUCT", entityId: produitId, stepKey: "bv75_req" } })).toBe(1);
  });
});
