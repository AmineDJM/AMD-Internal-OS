import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, scopeSupport, type SessionUser } from "@/lib/rbac";
import { canViewSupport, getSupportRequest } from "@/lib/queries/support";
import { createSupportRequest, takeSupportRequest, answerSupportRequest, updateSupportStatus } from "./support-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__suptest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Demandes de support — émission, prise en charge, réponse, accès", () => {
  let reqId = "", requesterId = "", cdpId = "", otherId = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [rq, cdp, ot] = await Promise.all([
      mk("deleg", "MEDICAL_DELEGATE"),
      mk("cdp", "PRODUCT_MANAGER"),
      mk("other", "SALES_USER"),
    ]);
    requesterId = rq.id; cdpId = cdp.id; otherId = ot.id;
  });

  afterAll(async () => {
    await prisma.supportRequest.deleteMany({ where: { reference: { startsWith: "SUP-" }, requester: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un délégué adresse une demande à la fonction « Direction Marketing » (OPEN, rôle notifié)", async () => {
    ACTOR = await actorFor(requesterId, "MEDICAL_DELEGATE");
    const fd = new FormData();
    fd.set("subject", `${TAG} Brochure produit X`); fd.set("body", "Besoin de la dernière brochure."); fd.set("category", "BROCHURE"); fd.set("targetRole", "PRODUCT_MANAGER");
    const r = await createSupportRequest(undefined, fd);
    expect(r.ok).toBe(true);
    reqId = r.id!;
    const sr = await prisma.supportRequest.findUniqueOrThrow({ where: { id: reqId } });
    expect(sr.status).toBe("OPEN");
    expect(sr.targetRole).toBe("PRODUCT_MANAGER");
    expect(sr.reference).toMatch(/^SUP-\d{4}-\d{3}$/);
    const notif = await prisma.notification.findFirst({ where: { userId: cdpId, title: "Nouvelle demande de support" } });
    expect(notif).not.toBeNull();
  });

  it("accès : demandeur + Direction Marketing ciblé voient ; un tiers non", async () => {
    const sr = await getSupportRequest(reqId);
    expect(canViewSupport(await actorFor(requesterId, "MEDICAL_DELEGATE"), sr!)).toBe(true);
    expect(canViewSupport(await actorFor(cdpId, "PRODUCT_MANAGER"), sr!)).toBe(true);
    expect(canViewSupport(await actorFor(otherId, "SALES_USER"), sr!)).toBe(false);
    // Scope liste : la Direction Marketing voit la demande ciblant son rôle ; un commercial non.
    const cdp = await actorFor(cdpId, "PRODUCT_MANAGER");
    const inScope = await prisma.supportRequest.findFirst({ where: { AND: [{ id: reqId }, scopeSupport(cdp)] }, select: { id: true } });
    expect(inScope?.id).toBe(reqId);
    const other = await actorFor(otherId, "SALES_USER");
    const outScope = await prisma.supportRequest.findFirst({ where: { AND: [{ id: reqId }, scopeSupport(other)] }, select: { id: true } });
    expect(outScope).toBeNull();
  });

  it("la Direction Marketing prend en charge puis répond (assigné + statut ANSWERED)", async () => {
    ACTOR = await actorFor(cdpId, "PRODUCT_MANAGER");
    const fdTake = new FormData(); fdTake.set("id", reqId);
    expect((await takeSupportRequest(fdTake)).ok).toBe(true);
    let sr = await prisma.supportRequest.findUniqueOrThrow({ where: { id: reqId } });
    expect(sr.status).toBe("IN_PROGRESS");
    expect(sr.assignedToId).toBe(cdpId);

    const fdMsg = new FormData(); fdMsg.set("id", reqId); fdMsg.set("body", "Voici la brochure en pièce jointe.");
    expect((await answerSupportRequest(fdMsg)).ok).toBe(true);
    sr = await prisma.supportRequest.findUniqueOrThrow({ where: { id: reqId } });
    expect(sr.status).toBe("ANSWERED");
    const msgs = await prisma.supportMessage.findMany({ where: { requestId: reqId } });
    expect(msgs).toHaveLength(1);
  });

  it("un tiers (ni demandeur ni destinataire) ne peut ni répondre ni changer le statut", async () => {
    ACTOR = await actorFor(otherId, "SALES_USER");
    const fdMsg = new FormData(); fdMsg.set("id", reqId); fdMsg.set("body", "intrus");
    expect((await answerSupportRequest(fdMsg)).ok).toBe(false);
    const fdSt = new FormData(); fdSt.set("id", reqId); fdSt.set("status", "CLOSED");
    expect((await updateSupportStatus(fdSt)).ok).toBe(false);
  });

  it("le demandeur peut clôturer sa demande", async () => {
    ACTOR = await actorFor(requesterId, "MEDICAL_DELEGATE");
    const fd = new FormData(); fd.set("id", reqId); fd.set("status", "CLOSED");
    expect((await updateSupportStatus(fd)).ok).toBe(true);
    const sr = await prisma.supportRequest.findUniqueOrThrow({ where: { id: reqId } });
    expect(sr.status).toBe("CLOSED");
  });
});
