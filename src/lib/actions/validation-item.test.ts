import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { getPendingValidations, getMyValidationRequests } from "@/lib/queries/validations";
import { reviewValidationItem, clearValidationItem } from "./validation-actions";

/**
 * Validation GRANULAIRE : le validateur approuve / refuse / demande une révision, élément
 * par élément (le « message » ET chaque pièce jointe), avec un commentaire OPTIONNEL.
 * Les verdicts sont rejoués au validateur et remontent au demandeur (retour détaillé).
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__valitem__${Date.now()}__`;
function fd(obj: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) f.set(k, v);
  return f;
}
async function actor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, access: await getAccess(id, u.role), mustChangePassword: false };
}

suite("reviewValidationItem — décision par élément", () => {
  let requesterId = "", validatorId = "", strangerId = "", stepId = "", docId = "";

  beforeAll(async () => {
    const mk = (s: string, role: Parameters<typeof getAccess>[1]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    requesterId = (await mk("req", "REGULATORY_ASSISTANT")).id;
    validatorId = (await mk("val", "HEAD_OF_REGULATORY")).id;
    strangerId = (await mk("str", "SALES_USER")).id;

    const req = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-r`, module: "Demandes de validations", title: "Courrier à valider",
        requesterId, status: "PENDING", currentOrder: 1, mode: "SEQUENTIAL",
        steps: { create: [{ order: 1, validatorId, status: "PENDING" }] },
      },
      include: { steps: true },
    });
    stepId = req.steps[0].id;
    docId = (await prisma.document.create({
      data: { name: `${TAG}piece.pdf`, category: "OTHER", entityType: "VALIDATION_REQUEST", entityId: req.id, fileKey: `${TAG}/k`, confidentiality: "INTERNAL", uploadedById: requesterId },
    })).id;
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le validateur approuve le MESSAGE et demande une révision d'une PIÈCE (commentaire optionnel)", async () => {
    ACTOR = await actor(validatorId);
    expect((await reviewValidationItem(fd({ stepId, itemKey: "MESSAGE", decision: "APPROVED", comment: "" }))).ok).toBe(true);
    expect((await reviewValidationItem(fd({ stepId, itemKey: docId, decision: "CHANGES_REQUESTED", comment: "mauvaise version" }))).ok).toBe(true);

    const item = (await getPendingValidations(validatorId)).find((i) => i.stepId === stepId)!;
    expect(item.itemDecisions.find((d) => d.itemKey === "MESSAGE")?.decision).toBe("APPROVED");
    const docDec = item.itemDecisions.find((d) => d.itemKey === docId);
    expect(docDec?.decision).toBe("CHANGES_REQUESTED");
    expect(docDec?.comment).toBe("mauvaise version");
  });

  it("réenregistrer un élément MET À JOUR son verdict (idempotent)", async () => {
    ACTOR = await actor(validatorId);
    expect((await reviewValidationItem(fd({ stepId, itemKey: "MESSAGE", decision: "REJECTED", comment: "à refaire" }))).ok).toBe(true);
    const item = (await getPendingValidations(validatorId)).find((i) => i.stepId === stepId)!;
    expect(item.itemDecisions.find((d) => d.itemKey === "MESSAGE")?.decision).toBe("REJECTED");
  });

  it("le demandeur voit le retour DÉTAILLÉ par élément (libellés lisibles)", async () => {
    const req = (await getMyValidationRequests(requesterId)).find((r) => r.reference === `${TAG}-r`)!;
    const items = req.steps[0].items ?? [];
    expect(items.find((it) => it.label === "Message")?.decision).toBe("REJECTED");
    expect(items.find((it) => it.label === `${TAG}piece.pdf`)?.decision).toBe("CHANGES_REQUESTED");
  });

  it("refuse un itemKey qui n'est pas une pièce de la demande", async () => {
    ACTOR = await actor(validatorId);
    expect((await reviewValidationItem(fd({ stepId, itemKey: "doc-inexistant", decision: "APPROVED" }))).ok).toBe(false);
  });

  it("une personne qui n'est pas le validateur ne peut rien évaluer", async () => {
    ACTOR = await actor(strangerId);
    expect((await reviewValidationItem(fd({ stepId, itemKey: "MESSAGE", decision: "APPROVED" }))).ok).toBe(false);
  });

  it("le validateur peut EFFACER son verdict sur un élément", async () => {
    ACTOR = await actor(validatorId);
    expect((await clearValidationItem(fd({ stepId, itemKey: "MESSAGE" }))).ok).toBe(true);
    const item = (await getPendingValidations(validatorId)).find((i) => i.stepId === stepId)!;
    expect(item.itemDecisions.some((d) => d.itemKey === "MESSAGE")).toBe(false);
  });
});
