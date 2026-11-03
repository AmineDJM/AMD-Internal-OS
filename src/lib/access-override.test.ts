import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";

/**
 * Un override « BLOQUÉ » (UserAccess.canView = false) doit retirer le module de façon
 * ABSOLUE — y compris quand le **rôle secondaire** de la personne l'accorde. Sinon
 * l'admin ne peut jamais retirer un accès à quelqu'un qui le détient via son « autre
 * rôle » (bug rapporté : module bloqué mais toujours accessible).
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__accblock__${Date.now()}`;
let viaSecondaryId = "";
let blockedId = "";

suite("Blocage de module : absolu, même contre le rôle secondaire", () => {
  beforeAll(async () => {
    // Compte dont SALES_PLANNING vient UNIQUEMENT du rôle secondaire (principal = SALES_USER
    // qui n'a pas ce module ; secondaire = NATIONAL_SALES qui l'a en lecture).
    viaSecondaryId = (await prisma.user.create({
      data: { email: `${TAG}-a@test.local`, name: `${TAG} secondary`, passwordHash: "x", role: "SALES_USER", secondaryRole: "NATIONAL_SALES" },
      select: { id: true },
    })).id;
    // Même configuration MAIS l'admin a BLOQUÉ SALES_PLANNING pour ce compte.
    blockedId = (await prisma.user.create({
      data: {
        email: `${TAG}-b@test.local`, name: `${TAG} blocked`, passwordHash: "x", role: "SALES_USER", secondaryRole: "NATIONAL_SALES",
        access: { create: [{ module: "SALES_PLANNING", canView: false, scope: "ASSIGNED" }] },
      },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { userId: { in: [viaSecondaryId, blockedId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [viaSecondaryId, blockedId] } } }).catch(() => {});
  });

  it("sans blocage, le rôle secondaire donne bien accès au module", async () => {
    const acc = await getAccess(viaSecondaryId, "SALES_USER");
    expect(acc.modules.has("SALES_PLANNING")).toBe(true);
  });

  it("avec un override BLOQUÉ, le module est retiré MALGRÉ le rôle secondaire", async () => {
    const acc = await getAccess(blockedId, "SALES_USER");
    expect(acc.modules.has("SALES_PLANNING")).toBe(false);
  });
});
