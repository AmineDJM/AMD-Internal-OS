import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES CONSULTING ET AD & PRO « AUTRE » D'UNE AUTRE SOCIÉTÉ (audit 27/10/2026, SA-14).
 *
 * Les deux listes étaient filtrées par entité ; les fiches `/consulting/[id]` et `/ad-pro/autres/[id]` s'ouvraient
 * par leur seul identifiant après le droit du module, et `canAccessEntity` — la porte de leurs pièces — ne
 * connaissait ni le contrat de consulting (le `default` : le module suffit) ni la demande « Autre » (absente des
 * natures Ad & Pro soumises au contrôle de société). Les deux pages lisent désormais `canAccessEntity`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `zfiches${Date.now().toString(36)}`;
const ids = { A: "", B: "", u: "" };
let acteur: CurrentUser;

suite("canAccessEntity — contrat de consulting et demande « Autre » d'une autre société", () => {
  beforeAll(async () => {
    [ids.A, ids.B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    ids.u = (await prisma.user.create({ data: { name: `${TAG} u`, email: `${TAG}u@t.dz`, role: "COORDINATOR", passwordHash: "x" } })).id;
    await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} u`, companyId: ids.A, userId: ids.u, isActive: true } }),
      prisma.userAccess.createMany({
        data: [
          { userId: ids.u, module: "CONSULTING", canView: true, scope: "ALL" },
          { userId: ids.u, module: "AD_PRO_OTHER", canView: true, scope: "ALL" },
        ],
      }),
    ]);
    acteur = { id: ids.u, name: `${TAG} u`, email: `${TAG}u@t.dz`, role: "COORDINATOR", secondaryRole: null, access: await getAccess(ids.u, "COORDINATOR") } as unknown as CurrentUser;
  }, 60_000);

  afterAll(async () => {
    await prisma.consultingContract.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: ids.u } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: ids.u } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: ids.u } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [ids.A, ids.B] } } }).catch(() => {});
  }, 60_000);

  it("le contrat de consulting de Beta est fermé ; celui d'Alpha s'ouvre", async () => {
    const [cB, cA] = await Promise.all(["B", "A"].map((s) => prisma.consultingContract.create({
      data: { reference: `${TAG}-C${s}`, title: `${TAG} contrat ${s}`, counterparty: "Dr X", companyId: s === "A" ? ids.A : ids.B },
    })));
    expect(await canAccessEntity(acteur, "CONSULTING_CONTRACT", cB.id, "VIEW")).toBe(false);
    expect(await canAccessEntity(acteur, "CONSULTING_CONTRACT", cA.id, "VIEW")).toBe(true);
  });

  it("la demande « Autre » de Beta est fermée ; celle d'Alpha s'ouvre", async () => {
    const [rB, rA] = await Promise.all(["B", "A"].map((s) => prisma.adProOtherRequest.create({
      data: { reference: `${TAG}-O${s}`, title: `${TAG} demande ${s}`, companyId: s === "A" ? ids.A : ids.B },
    })));
    expect(await canAccessEntity(acteur, "AD_PRO_OTHER", rB.id, "VIEW")).toBe(false);
    expect(await canAccessEntity(acteur, "AD_PRO_OTHER", rA.id, "VIEW")).toBe(true);
  });

  it("les deux fiches lisent la porte avant de charger l'objet", () => {
    for (const [page, type] of [["src/app/(app)/consulting/[id]/page.tsx", "CONSULTING_CONTRACT"], ["src/app/(app)/ad-pro/autres/[id]/page.tsx", "AD_PRO_OTHER"]]) {
      const src = readFileSync(page, "utf8");
      expect(src, page).toContain(`canAccessEntity(user, "${type}", params.id, "VIEW")`);
    }
  });
});
