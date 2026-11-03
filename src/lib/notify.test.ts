import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { notifyRoles } from "./notify";

// Sonde DB ; suite sautée proprement sans base (CI sans Postgres).
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__ntftest__";

suite("notifyRoles — cible le rôle principal ET le rôle secondaire", () => {
  let primaryNsId = "", secondaryNsId = "", otherId = "", inactiveNsId = "";

  beforeAll(async () => {
    const mk = (s: string, data: Record<string, unknown>) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", ...data } as never });
    const [a, b, c, d] = await Promise.all([
      mk("ns-prim", { role: "NATIONAL_SALES" }),
      // Le cas du bug rapporté : National Sales attribué en RÔLE SECONDAIRE
      // (tableau « Rôles principaux & secondaires » de l'Administration).
      mk("ns-sec", { role: "MEDICAL_DELEGATE", secondaryRole: "NATIONAL_SALES" }),
      mk("other", { role: "SALES_USER" }),
      mk("ns-off", { role: "NATIONAL_SALES", isActive: false }),
    ]);
    primaryNsId = a.id; secondaryNsId = b.id; otherId = c.id; inactiveNsId = d.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("une demande de congrès notifie le National Sales, que le rôle soit principal ou secondaire", async () => {
    await notifyRoles(["NATIONAL_SALES"], {
      type: "VALIDATION_REQUIRED",
      title: `${TAG} Demande de congrès — à attribuer (National Sales)`,
      body: "Congrès test",
      link: "/congress-international/x",
    });

    const byUser = async (userId: string) =>
      prisma.notification.count({ where: { userId, title: { startsWith: TAG } } });

    expect(await byUser(primaryNsId)).toBe(1); // rôle principal
    expect(await byUser(secondaryNsId)).toBe(1); // rôle secondaire ← le bug corrigé
    expect(await byUser(otherId)).toBe(0); // pas concerné
    expect(await byUser(inactiveNsId)).toBe(0); // compte désactivé
  });
});
