import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

// Le stockage n'est pas le sujet : le faux rend un `documentId` réel, retrouvé au nettoyage par son nom.
vi.mock("@/lib/documents", () => ({
  persistUploadedDocument: async () => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: { name: "__paydbl__piece.pdf", entityType: "PAYMENT_REQUEST", entityId: "x", fileKey: "k", mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    });
    return { ok: true, documentId: doc.id };
  },
}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { createPaymentRequest, submitPaymentRequest } from "./payment-request-actions";

/**
 * TRANSMETTRE UN BROUILLON À DEUX CLICS N'OUVRE QU'UN ORDRE DE DÉPENSE (audit données 2026-10-27).
 *
 * `submitPaymentRequest` lisait le statut, faisait plusieurs lectures (factures, écarts), puis écrivait
 * le statut par le seul id et créait l'ordre si `expenseOrderId` était vide à la LECTURE. Deux clics
 * franchissaient tous deux la garde : deux ordres au centre de paiement pour une seule facture, le
 * second écrasant le lien du premier — un ordre orphelin, autorisable et payable.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__paydbl__${Date.now()}`;
let reqUserId = "";
const created: string[] = [];

function form(fields: Record<string, string>, pieces: { kind: string }[] = []): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  pieces.forEach((p, i) => {
    fd.append("files", new File(["x"], `piece-${i}.pdf`, { type: "application/pdf" }));
    fd.set(`kind_${i}`, p.kind);
  });
  return fd;
}

suite("submitPaymentRequest — un double clic ne crée qu'un ordre de dépense", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}r`, email: `${TAG}r@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } });
    reqUserId = u.id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "MEDICAL_DELEGATE", access: await getAccess(u.id, "MEDICAL_DELEGATE"), mustChangePassword: false };
  });

  afterAll(async () => {
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "PAYMENT_REQUEST", sourceId: { in: created } }, select: { id: true } });
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: created } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: "__paydbl__piece.pdf" } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: reqUserId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: reqUserId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("deux transmissions simultanées du même brouillon → un seul ordre, et c'est lui que la demande nomme", async () => {
    const r = await createPaymentRequest(undefined, form({
      title: `${TAG} facture`, payee: "SARL Atlas", amount: "500000", submit: "0", paymentMethodStated: "on", dueDate: "2026-11-15",
    }, [{ kind: "INVOICE" }]));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const id = r.id!;
    created.push(id);
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id } })).status).toBe("DRAFT");

    const [a, b] = await Promise.all([submitPaymentRequest(form({ id })), submitPaymentRequest(form({ id }))]);
    expect([a.ok, b.ok].filter(Boolean).length, "un clic au moins aboutit").toBeGreaterThanOrEqual(1);

    const ordres = await prisma.expenseOrder.findMany({ where: { sourceType: "PAYMENT_REQUEST", sourceId: id }, select: { id: true } });
    expect(ordres, "un seul ordre au centre pour une seule facture").toHaveLength(1);
    const demande = await prisma.paymentRequest.findUniqueOrThrow({ where: { id }, select: { status: true, expenseOrderId: true } });
    expect(demande.status).toBe("SUBMITTED");
    expect(demande.expenseOrderId).toBe(ordres[0]!.id);
  });
});
