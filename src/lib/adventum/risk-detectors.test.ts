import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getRisks } from "./risks";
import { getRiskThresholds } from "./risk-settings";
import { updateRiskThresholds } from "@/lib/actions/adventum-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__riskdet__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Risk Radar — détecteur stocks PCH + seuils réglables", () => {
  let adminId = "", userId = "", threshold = 10;

  beforeAll(async () => {
    const [admin, user] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}user`, email: `${TAG}user@t.dz`, role: "VIEWER", passwordHash: "x" } }),
    ]);
    adminId = admin.id; userId = user.id;

    threshold = (await getRiskThresholds()).stockLowThreshold;
    // Produit en RUPTURE (net 0 : entrées = sorties) et produit largement APPROVISIONNÉ.
    await prisma.stockMovement.createMany({
      data: [
        { product: `${TAG}rupture`, direction: "IN", quantity: 10, location: "PCH" },
        { product: `${TAG}rupture`, direction: "OUT", quantity: 10, location: "PCH" },
        { product: `${TAG}ok`, direction: "IN", quantity: threshold + 50, location: "PCH" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { product: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    // Réinitialise le singleton des seuils (modifié par le test de réglage).
    await prisma.riskSetting.deleteMany({}).catch(() => {});
  });

  it("détecte une rupture PCH (net ≤ seuil) mais pas un produit bien approvisionné", async () => {
    const risks = await getRisks();
    const rupture = risks.find((r) => r.id === `stock-${TAG}rupture`);
    const ok = risks.find((r) => r.id === `stock-${TAG}ok`);
    expect(rupture).toBeTruthy();
    expect(rupture!.level).toBe("critical"); // net 0 = rupture
    expect(ok).toBeUndefined(); // net > seuil → pas d'alerte
  });

  it("le Super Admin règle les seuils (bornés) ; un non-admin est refusé", async () => {
    ACTOR = await actorFor(userId, "VIEWER");
    const denied = new FormData(); denied.set("stockLowThreshold", "5");
    expect((await updateRiskThresholds(denied)).ok).toBe(false);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData();
    fd.set("stockLowThreshold", "99999"); // au-delà du max → borné
    fd.set("eventMinAttendance", "0"); // en-deçà du min → borné
    expect((await updateRiskThresholds(fd)).ok).toBe(true);

    const t = await getRiskThresholds();
    expect(t.stockLowThreshold).toBeLessThanOrEqual(1000);
    expect(t.eventMinAttendance).toBeGreaterThanOrEqual(1);
  });
});
