import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { enrichTenderLine } from "@/lib/actions/pch-tender-line-actions";
import { deleteTender } from "@/lib/actions/pch-actions";
import { restaurerLotDeLaCorbeille } from "@/lib/suppression/coeur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PRODUIT D'UN LOT, À COUP SÛR — ET UN APPEL D'OFFRES SUPPRIMÉ PART À LA CORBEILLE
 * (§118.185 — audit 360°, I17). Joué par les vraies actions (`enrichTenderLine`, `deleteTender`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__pchlot__";
const MOL = "ZZQPCHMOLX";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

suite("le produit canonique d'un lot, et la corbeille d'un appel d'offres", () => {
  let sa = "", p1 = "", p2 = "", tender = "";

  async function nettoyer() {
    const tenders = (await prisma.pchTender.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: tenders } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: tenders } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    sa = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    ACTEUR = { id: sa, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(sa, "SUPER_ADMIN") } as unknown as SessionUser;
    const prod = (k: string) => prisma.product.create({ data: { code: `${TAG}${k}`, canonicalName: `${TAG}${k}`, dci: MOL, identityKey: `${TAG}${k}` } });
    p1 = (await prod("P1")).id;
    p2 = (await prod("P2")).id;
    tender = (await prisma.pchTender.create({ data: { reference: `${TAG}AO-1`, title: `${TAG} marché` } })).id;
  });

  afterAll(async () => { await nettoyer(); });

  const ligne = (designation: string, productId: string | null = null) =>
    prisma.pchTenderLine.create({ data: { tenderId: tender, designation, dci: MOL, dosage: "10 mg", productId } });
  const dossier = (k: string, productId: string) =>
    prisma.regulatoryProduct.create({ data: { reference: `${TAG}${k}`, dci: MOL, dosage: "10", dosageUnit: "mg", productId } });
  const produitDe = async (id: string) => (await prisma.pchTenderLine.findUniqueOrThrow({ where: { id }, select: { productId: true } })).productId;

  it("UN SEUL produit canonique reconnu : le lot le reçoit", async () => {
    await dossier("D1", p1);
    const l = await ligne(`${TAG} lot un`);
    const r = await enrichTenderLine(fd({ id: l.id, tenderId: tender }));
    expect(r.ok, r.error).toBe(true);
    expect(await produitDe(l.id)).toBe(p1);
  });

  it("DEUX produits canoniques possibles : le lot n'en reçoit AUCUN — on ne choisit pas le premier", async () => {
    await dossier("D2", p2);
    const l = await ligne(`${TAG} lot deux`);
    expect((await enrichTenderLine(fd({ id: l.id, tenderId: tender }))).ok).toBe(true);
    expect(await produitDe(l.id)).toBeNull();
  });

  it("UNE DÉSIGNATION DÉJÀ POSÉE n'est jamais remplacée", async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: `${TAG}D2` } });
    const l = await ligne(`${TAG} lot trois`, p2);
    expect((await enrichTenderLine(fd({ id: l.id, tenderId: tender }))).ok).toBe(true);
    expect(await produitDe(l.id)).toBe(p2);
  });

  it("UNE FACTURE RÉGLÉE d'un bon du marché BLOQUE la suppression — rien n'est retiré", async () => {
    // Le bon de commande porte le type PCH_ORDER : ses factures (`sourceType = PCH_ORDER`) sont des
    // branches du lot. Une facture réglée est un fait qui a QUITTÉ l'ERP : le marché est sa cause.
    const bc = await prisma.pchOrder.create({ data: { tenderId: tender, reference: `${TAG}BC-1` } });
    const fac = await prisma.legalDocument.create({ data: {
      title: `${TAG} facture réglée`, reference: `${TAG}F-1`, kind: "INVOICE", counterparty: "PCH",
      amount: 1000, status: "ACTIVE", sourceType: "PCH_ORDER", sourceId: bc.id, paidDate: new Date(),
    } });
    const r = await deleteTender(fd({ id: tender }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/réglée/);
    expect(await prisma.pchTender.count({ where: { id: tender } })).toBe(1);
    expect(await prisma.pchOrder.count({ where: { id: bc.id } })).toBe(1);
    expect(await prisma.legalDocument.count({ where: { id: fac.id } })).toBe(1);
    // Non réglée, la même facture n'a plus de cause sans son marché : elle partira avec lui.
    await prisma.legalDocument.update({ where: { id: fac.id }, data: { paidDate: null } });
  });

  it("SUPPRIMER l'appel d'offres l'envoie à la corbeille avec ses lots — et tout revient à la restauration", async () => {
    const lots = await prisma.pchTenderLine.count({ where: { tenderId: tender } });
    expect(lots).toBeGreaterThan(0);
    const r = await deleteTender(fd({ id: tender }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.pchTender.count({ where: { id: tender } })).toBe(0);
    expect(await prisma.legalDocument.count({ where: { reference: `${TAG}F-1` } }), "la facture non réglée part avec le marché").toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: tender, kind: "PCH_TENDER" } });
    const restaure = await restaurerLotDeLaCorbeille(rec, "PCH_TENDER");
    expect(restaure?.ok, restaure?.error).toBe(true);
    expect(await prisma.pchTender.count({ where: { id: tender } })).toBe(1);
    expect(await prisma.pchTenderLine.count({ where: { tenderId: tender } })).toBe(lots);
    // La facture non réglée de son bon est partie AVEC lui, et revient avec lui — sans le type
    // PCH_ORDER du bon, elle restait en base, rattachée à un bon disparu.
    expect(await prisma.legalDocument.count({ where: { reference: `${TAG}F-1` } })).toBe(1);
    expect(await prisma.pchOrder.count({ where: { tenderId: tender } })).toBe(1);
  });
});
