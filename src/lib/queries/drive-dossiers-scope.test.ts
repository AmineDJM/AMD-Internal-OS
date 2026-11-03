import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";

/**
 * Confidentialité STRICTE du Drive et des Projets (Dossiers) : un rôle ORDINAIRE ne
 * doit JAMAIS voir l'ensemble des drives / projets de la société, même si un override
 * de la matrice d'accès (ou un réglage hérité) lui a ouvert la portée « ALL ». Seule la
 * vue globale (Super Admin / Direction) voit tout. `getAccess` neutralise toute portée
 * ALL pour ces deux modules hors vue globale.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drivescope__${Date.now()}`;
let ordinaryId = "";
let directionId = "";

suite("Drive & Projets : portée ALL neutralisée hors vue globale", () => {
  beforeAll(async () => {
    // Compte ORDINAIRE (SALES_USER) à qui un admin a (par erreur) ouvert DRIVE + DOSSIERS
    // en portée ALL via la matrice.
    const ordinary = await prisma.user.create({
      data: {
        email: `${TAG}-ord@test.local`, name: `${TAG} ordinary`, passwordHash: "x", role: "SALES_USER",
        access: {
          create: [
            { module: "DRIVE", canView: true, canUpload: true, canCreate: true, scope: "ALL" },
            { module: "DOSSIERS", canView: true, canCreate: true, scope: "ALL" },
          ],
        },
      },
      select: { id: true },
    });
    ordinaryId = ordinary.id;
    // Compte à VUE GLOBALE (Direction) : lui garde bien la portée ALL.
    const direction = await prisma.user.create({
      data: { email: `${TAG}-dir@test.local`, name: `${TAG} direction`, passwordHash: "x", role: "DIRECTION" },
      select: { id: true },
    });
    directionId = direction.id;
  });

  afterAll(async () => {
    await prisma.userAccess.deleteMany({ where: { userId: { in: [ordinaryId, directionId] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [ordinaryId, directionId] } } }).catch(() => {});
  });

  it("un rôle ordinaire avec override ALL est ramené à ASSIGNED (Drive + Projets)", async () => {
    const acc = await getAccess(ordinaryId, "SALES_USER");
    expect(acc.modules.get("DRIVE")?.scope).toBe("ASSIGNED");
    expect(acc.modules.get("DOSSIERS")?.scope).toBe("ASSIGNED");
    // Il garde bien l'accès au module (juste la portée est cloisonnée).
    expect(acc.modules.get("DRIVE")?.actions.has("VIEW")).toBe(true);
    expect(acc.modules.get("DOSSIERS")?.actions.has("VIEW")).toBe(true);
  });

  it("la Direction (vue globale) conserve la portée ALL", async () => {
    const acc = await getAccess(directionId, "DIRECTION");
    expect(acc.modules.get("DRIVE")?.scope).toBe("ALL");
    expect(acc.modules.get("DOSSIERS")?.scope).toBe("ALL");
  });
});
