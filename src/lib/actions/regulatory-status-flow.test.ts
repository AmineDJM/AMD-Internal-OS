import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { setRegulatoryStepState, setRegulatoryPresubOutcome, updateRegulatoryStatus } from "./regulatory-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__statustest__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const statusOf = async (id: string) =>
  (await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

const cocher = async (productId: string, stepKey: string, status = "DONE") => {
  const fd = new FormData();
  fd.set("productId", productId); fd.set("stepKey", stepKey); fd.set("status", status);
  return setRegulatoryStepState(fd);
};

/**
 * LE NIVEAU DE PROCESS SUIT LES ÉTAPES — depuis la VRAIE porte.
 *
 * Les règles sont prouvées à part (`lib/regulatory/process-status.test.ts`, module pur). Ce qui
 * se vérifie ici est le BRANCHEMENT : cocher une étape depuis l'écran écrit-il vraiment le
 * nouveau niveau en base, et l'audit le dit-il ? Un calcul juste que personne n'appelle ne
 * change rien à ce qu'on lit dans le tableau de suivi.
 */
suite("Regulatory — le niveau de process se déduit des étapes cochées", () => {
  let productId = "", regId = "";

  beforeAll(async () => {
    const reg = await prisma.user.create({
      data: { name: `${TAG}reg`, email: `${TAG}reg@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" },
    });
    regId = reg.id;
    const p = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-001`, dci: `${TAG} Dolutegravir`, status: "PRE_SUBMISSION" },
    });
    productId = p.id;
    ACTOR = await actorFor(regId, "HEAD_OF_REGULATORY");
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityId: productId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { link: `/regulatory/${productId}` } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("sans avis de présoumission, cocher le dépôt ne fait PAS avancer le dossier", async () => {
    expect((await cocher(productId, "depot")).ok).toBe(true);
    // Le verrou de présoumission tient : le dossier en est encore à sa réception.
    expect(await statusOf(productId)).toBe("PRE_SUBMISSION");
  }, 30_000);

  it("avis FAVORABLE → le dépôt déjà coché fait passer le dossier à « Déposé »", async () => {
    const fd = new FormData();
    fd.set("productId", productId); fd.set("outcome", "FAVORABLE");
    expect((await setRegulatoryPresubOutcome(fd)).ok).toBe(true);
    expect(await statusOf(productId)).toBe("SUBMITTED");
  }, 30_000);

  it("l'évaluation ANPP fait suivre le niveau, et l'audit dit d'où il vient", async () => {
    expect((await cocher(productId, "evaluation")).ok).toBe(true);
    expect(await statusOf(productId)).toBe("AWAITING_ANPP");

    const logs = await prisma.auditLog.findMany({
      where: { entityType: "REGULATORY_PRODUCT", entityId: productId, field: "status" },
      orderBy: { createdAt: "desc" }, take: 5,
    });
    expect(logs.some((l) => (l.summary ?? "").includes("déduit du processus"))).toBe(true);
    expect(logs.some((l) => l.newValue === "AWAITING_ANPP")).toBe(true);
  }, 30_000);

  it("une étape BLOQUÉE bloque le dossier ; la débloquer lui rend son niveau", async () => {
    expect((await cocher(productId, "rdv", "BLOCKED")).ok).toBe(true);
    expect(await statusOf(productId)).toBe("BLOCKED");

    expect((await cocher(productId, "rdv", "DONE")).ok).toBe(true);
    expect(await statusOf(productId)).toBe("AWAITING_ANPP");
  }, 30_000);

  it("le formulaire d'en-tête ne pose plus le niveau — il n'écrit QUE la priorité", async () => {
    const fd = new FormData();
    fd.set("id", productId);
    fd.set("priority", "HIGH");
    // Un `status` envoyé par un appelant qui l'ignore encore ne s'impose pas : il est lu comme
    // une demande d'avancement, et le niveau reste celui que les étapes racontent.
    fd.set("status", "DECISION_OBTAINED");
    expect((await updateRegulatoryStatus(fd)).ok).toBe(true);

    const after = await prisma.regulatoryProduct.findUniqueOrThrow({
      where: { id: productId }, select: { status: true, priority: true },
    });
    expect(after.priority).toBe("HIGH");
    // Les étapes jusqu'à la décision ont été comptées → le niveau les suit, par la seule route
    // qui existe désormais.
    expect(after.status).toBe("DECISION_OBTAINED");
    const wf = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: productId }, select: { workflow: true } });
    expect((wf.workflow as Record<string, { status?: string }>)?.decision?.status).toBe("DONE");
  }, 30_000);
});
