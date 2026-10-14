import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { circuitStateOf } from "@/lib/medical-info/circuit-state";
import { slipStage, canRequestSlipPayment } from "@/lib/medical-info/slips";
import { reporterLesPostesSurLaDeclaration } from "@/lib/workflow/engine";
import {
  requestSlipPayment, skipMedicalInfoBv, removeMedicalInfoSlip, validateDeclaration, validateDeclarationByDirection, createMedicalInfoItem,
} from "./medical-info-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARGENT DE L'INFORMATION MÉDICALE — les défauts de l'audit (Direction, 10/2026), joués en base.
 *
 *  1. Deux demandes de paiement simultanées d'un même bon n'en créent qu'UNE (prise conditionnelle).
 *  2. Un bon dont l'ordre est ANNULÉ n'est plus bloqué : il se redemande, se retire, ou le dossier se
 *     déclare « sans versement ».
 *  3. Un dossier ouvert par le PRIM (MIP, visa) n'émet AUCUN ordre global à la validation finale ; une
 *     déclaration née après un ordre déjà parti ne le double pas.
 *  6. Un visa publicitaire ne se valide pas sans son numéro.
 *  7. Une révision de poste Ad & Pro se reporte sur la déclaration non validée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__miargent${Date.now()}__`;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false };
}

suite("Information médicale — l'argent : un ordre par bon, aucun ordre sans pièce, rien de bloqué à vie", () => {
  let primId = "", saId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const ids = (await prisma.medicalInfoDeclaration.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    const demandes = await prisma.paymentRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true, expenseOrderId: true } });
    await prisma.expenseOrder.deleteMany({ where: { OR: [{ id: { in: demandes.map((d) => d.expenseOrderId).filter((x): x is string => Boolean(x)) } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.medicalInfoSlip.deleteMany({ where: { declarationId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [prim, sa] = await Promise.all([mk("prim", "MEDICAL_INFO_PHARMACIST"), mk("sa", "SUPER_ADMIN")]);
    primId = prim.id; saId = sa.id;
  }, 120_000);
  afterAll(nettoyer, 120_000);

  /** Un dossier matériel dont le lot de bons est déjà accordé (la reprise pose l'accord). */
  async function dossierPromoAccorde(): Promise<{ id: string; slipId: string }> {
    const d = await prisma.medicalInfoDeclaration.create({
      data: {
        reference: `DIM-2036-${Math.floor(Math.random() * 900000 + 100000)}`, sourceType: "PROMO_MATERIAL",
        sourceId: `${TAG}pm-${Math.random().toString(36).slice(2)}`, label: `${TAG}promo`, pharmacistId: primId,
      },
    });
    const v = await prisma.validationRequest.create({
      data: { reference: `${TAG}V${Math.random().toString(36).slice(2, 8)}`, module: "Information médicale", title: `${TAG}lot`, requesterId: primId, status: "APPROVED", entityType: "MEDICAL_INFO_DECLARATION", entityId: d.id },
    });
    await prisma.medicalInfoDeclaration.update({ where: { id: d.id }, data: { bvValidationId: v.id } });
    const s = await prisma.medicalInfoSlip.create({ data: { declarationId: d.id, label: `${TAG}affiches`, amount: 15000 } });
    return { id: d.id, slipId: s.id };
  }

  afterAll(async () => {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
  });

  it("DEUX DEMANDES SIMULTANÉES du paiement d'un même bon : une seule demande, un seul ordre", async () => {
    const { slipId } = await dossierPromoAccorde();
    const prim = await actorFor(primId);
    ACTOR = prim;
    const [a, b] = await Promise.all([
      requestSlipPayment(undefined, form({ slipId, amount: "15000" })),
      requestSlipPayment(undefined, form({ slipId, amount: "15000" })),
    ]);
    expect([a.ok, b.ok].filter(Boolean), `exactement une : ${a.error ?? ""} / ${b.error ?? ""}`).toHaveLength(1);
    const slip = await prisma.medicalInfoSlip.findUniqueOrThrow({ where: { id: slipId } });
    expect(slip.requestId).toBe((a.ok ? a : b).id);
    expect(await prisma.paymentRequest.count({ where: { entityType: "MEDICAL_INFO_DECLARATION", requesterId: primId, title: { contains: `${TAG}affiches` } } })).toBe(1);
  });

  it("UN ORDRE ANNULÉ libère le bon : il se redemande — et le dossier peut se déclarer sans versement", async () => {
    const { id, slipId } = await dossierPromoAccorde();
    ACTOR = await actorFor(primId);
    const r = await requestSlipPayment(undefined, form({ slipId, amount: "15000" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r.id! } });
    // Le centre (ou la source retirée) annule l'ordre : le bon restait « autorisé — à régler » à vie.
    await prisma.expenseOrder.update({ where: { id: req.expenseOrderId! }, data: { status: "CANCELLED" } });
    const etat = await circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } }));
    const bon = etat.slips.find((s) => s.id === slipId)!;
    expect(slipStage(bon)).toBe("ANNULE");
    expect(canRequestSlipPayment(bon)).toBe(true);

    const encore = await requestSlipPayment(undefined, form({ slipId, amount: "14000" }));
    expect(encore.ok, encore.ok ? "" : encore.error).toBe(true);
    expect(encore.id).not.toBe(r.id);
    // Le nouveau paiement vit : on ne déclare pas « sans versement » par-dessus.
    expect((await skipMedicalInfoBv(form({ id, reason: "Rien à verser" }))).ok).toBe(false);
    const nouveau = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: encore.id! } });
    await prisma.paymentRequest.update({ where: { id: nouveau.id }, data: { status: "REJECTED" } });
    const sans = await skipMedicalInfoBv(form({ id, reason: "Le ministère a renoncé à la taxe." }));
    expect(sans.ok, sans.ok ? "" : sans.error).toBe(true);
  });

  it("un bon au paiement refusé se RETIRE après la validation du lot", async () => {
    const { slipId } = await dossierPromoAccorde();
    ACTOR = await actorFor(primId);
    const r = await requestSlipPayment(undefined, form({ slipId, amount: "15000" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await removeMedicalInfoSlip(form({ slipId }))).ok, "paiement vivant : le bon reste").toBe(false);
    await prisma.paymentRequest.update({ where: { id: r.id! }, data: { status: "CANCELLED" } });
    const retrait = await removeMedicalInfoSlip(form({ slipId }));
    expect(retrait.ok, retrait.ok ? "" : retrait.error).toBe(true);
    expect(await prisma.medicalInfoSlip.count({ where: { id: slipId } })).toBe(0);
  });

  it("un dossier OUVERT PAR LE PRIM, montant saisi : aucun ordre de dépense à la validation finale", async () => {
    ACTOR = await actorFor(primId);
    const c = await createMedicalInfoItem(undefined, form({ label: `${TAG}MIP libre`, kind: "MIP", amount: "250000" }));
    expect(c.ok, c.ok ? "" : c.error).toBe(true);
    await prisma.medicalInfoDeclaration.update({ where: { id: c.id! }, data: { status: "AWAITING_DIRECTION" } });
    ACTOR = await actorFor(saId);
    const v = await validateDeclarationByDirection(form({ id: c.id! }));
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    const d = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: c.id! } });
    expect(d.status).toBe("VALIDATED");
    expect(d.expenseOrderId, "une saisie libre n'est pas une pièce : aucun ordre").toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceId: d.sourceId } })).toBe(0);
  });

  it("une déclaration née APRÈS l'ordre (aucun pharmacien) ne le double pas à la validation finale", async () => {
    const spo = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO`, institution: `${TAG}Hôpital`, type: "Congrès", status: "APPROVED", amountGranted: 30000 } });
    const ordre = await prisma.expenseOrder.create({ data: { reference: `${TAG}OD`, label: `${TAG}ordre parti`, amount: 30000, category: "EVENEMENT", sourceType: "SPONSORING", sourceId: spo.id } });
    const decl = await createMedicalInfoDeclaration({ sourceType: "SPONSORING", sourceId: spo.id, label: `${TAG}sans pharmacien`, amount: 30000, expenseOrderId: ordre.id });
    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { status: "AWAITING_DIRECTION" } });
    ACTOR = await actorFor(saId);
    const v = await validateDeclarationByDirection(form({ id: decl.id }));
    expect(v.ok, v.ok ? "" : v.error).toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spo.id } }), "l'ordre parti reste le seul").toBe(1);
  });

  it("un VISA PUBLICITAIRE ne se valide pas sans son numéro", async () => {
    ACTOR = await actorFor(primId);
    const c = await createMedicalInfoItem(undefined, form({ label: `${TAG}visa`, kind: "AD_VISA" }));
    expect(c.ok, c.ok ? "" : c.error).toBe(true);
    await prisma.medicalInfoDeclaration.update({ where: { id: c.id! }, data: { bvSkippedAt: new Date(), bvSkipReason: "aucune taxe" } });
    const sansNumero = await validateDeclaration(form({ id: c.id! }));
    expect(sansNumero.ok).toBe(false);
    expect(sansNumero.error).toMatch(/numéro du visa/);
    await prisma.medicalInfoDeclaration.update({ where: { id: c.id! }, data: { authorityRef: "VP-2026-117" } });
    const avec = await validateDeclaration(form({ id: c.id! }));
    expect(avec.ok, avec.ok ? "" : avec.error).toBe(true);
  });

  it("UNE RÉVISION DE POSTE se reporte sur la déclaration non validée — pas sur une validée", async () => {
    const spo = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO2`, institution: `${TAG}Société savante`, type: "Association", status: "PRE_VALIDATED" } });
    const decl = await prisma.medicalInfoDeclaration.create({
      data: { reference: `DIM-2036-${Math.floor(Math.random() * 900000 + 100000)}`, sourceType: "SPONSORING", sourceId: spo.id, label: `${TAG}tenue`, amount: 10000 },
    });
    await prisma.adProItem.create({ data: { sponsoringId: spo.id, label: `${TAG}stand`, kind: "STAND", amountEstimated: 42000 } });
    await reporterLesPostesSurLaDeclaration("SPONSORING", spo.id);
    expect(Number((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decl.id } })).amount)).toBe(42000);
    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { status: "VALIDATED" } });
    await prisma.adProItem.updateMany({ where: { sponsoringId: spo.id }, data: { amountEstimated: 99000 } });
    await reporterLesPostesSurLaDeclaration("SPONSORING", spo.id);
    expect(Number((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decl.id } })).amount), "une déclaration validée ne se réécrit pas").toBe(42000);
  });
});
