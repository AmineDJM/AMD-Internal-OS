import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan } from "@/lib/rbac";
import { continuousCash } from "@/lib/general-means/continuous-cash";
import { openRemittances } from "@/lib/queries/general-means";
import { deleteFileByKey } from "@/lib/storage";
import { allotPettyCash, closePettyCash, confirmPettyCashReceipt, decidePettyCashTopUp, requestPettyCashTopUp, spendFromPettyCash } from "./petty-cash-actions";
import { decidePayment } from "./payment-centre-actions";
import { settleExpenseOrder } from "./expense-actions";
import { addDepartmentExpense, updateDepartmentExpense } from "./department-budget-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CAISSE D'AVANCE — LA DÉPENSE EST ATOMIQUE, ET LA RALLONGE VA À QUI LA TRANCHE (audit Assistante de direction, 10/2026).
 *
 *   (a) Deux dépenses envoyées au même instant lisaient chacune le même solde et passaient toutes les deux : la caisse
 *       finissait en négatif. La dépense relit désormais le fond sous verrou (`SELECT … FOR UPDATE`), dans la
 *       transaction qui l'écrit.
 *   (b) La demande de rallonge prévenait la Direction, alors que ce sont les RH ou les Budgets qui tranchent
 *       (`decidePettyCashTopUp`, garde `canAllot`) : les destinataires sont désormais lus par CETTE garde.
 *   (c) Les restes de l'audit données du 27/10 (DONNEES-06) : la CORRECTION d'une dépense vers la caisse relit le fond
 *       sous le même verrou ; la CLÔTURE se fait sous verrou et une seule fois ; une remise soldée ne se confirme plus.
 * Par les VRAIES actions, la détentrice étant une assistante de direction SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__caisseatomique__${Date.now()}`;
const DEBUT = new Date(Date.now() - 60_000);

async function actorFor(id: string, role: UserRole): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>, fichiers: File[] = []): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const f of fichiers) fd.append("files", f);
  return fd;
};
const pdf = (nom = "ticket.pdf") => new File([new Uint8Array([1, 2, 3])], nom, { type: "application/pdf" });

suite("Caisse d'avance — dépense atomique, rallonge adressée à qui tranche", () => {
  let adminId = "", holderId = "", rhId = "", horsId = "", deptId = "", pdgId = "", comptableId = "";

  const fond = async () => continuousCash(await openRemittances(deptId));

  beforeAll(async () => {
    const mk = (n: string, role: UserRole) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    // Séparation des tâches (ARGENT-06) : l'administrateur remet, le PDG autorise, la comptabilité règle.
    const [admin, holder, rh, hors, pdg, cpt] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("assistante", "DIRECTION_ASSISTANT"), mk("rh", "COORDINATOR"), mk("hors", "COORDINATOR"), mk("pdg", "DIRECTION"), mk("cpt", "FINANCE_BUDGET_MANAGER")]);
    adminId = admin.id; holderId = holder.id; rhId = rh.id; horsId = hors.id; pdgId = pdg.id; comptableId = cpt.id;
    deptId = (await prisma.department.create({ data: { name: `${TAG} Moyens généraux`, code: `${TAG}MG` } })).id;
    await prisma.userAccess.createMany({
      data: [
        { userId: holderId, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" },
        // LES RH, PAR LA CONSOLE : c'est le droit que `canAllot` lit (RH, modifier) — pas un rôle deviné.
        { userId: rhId, module: "RH", canView: true, canUpdate: true, scope: "ALL" },
      ],
    });

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const remise = await allotPettyCash(form({ departmentId: deptId, holderId, amount: "100000" }));
    expect(remise.ok, remise.error).toBe(true);
    const ligne = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true, expenseOrderId: true } });
    ACTOR = await actorFor(pdgId, "DIRECTION");
    expect((await decidePayment(form({ id: ligne.expenseOrderId!, decision: "APPROVE" }))).ok).toBe(true);
    ACTOR = await actorFor(comptableId, "FINANCE_BUDGET_MANAGER");
    const regle = await settleExpenseOrder(form({ id: ligne.expenseOrderId! }));
    expect(regle.ok, regle.error).toBe(true);
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const recu = await confirmPettyCashReceipt(form({ id: ligne.id }));
    expect(recu.ok, recu.error).toBe(true);
  }, 60_000);

  afterAll(async () => {
    const ids = (await prisma.departmentBudgetExpense.findMany({ where: { departmentId: deptId }, select: { id: true } }).catch(() => [])).map((e) => e.id);
    const docs = await prisma.document.findMany({ where: { entityType: "DEPARTMENT_EXPENSE", entityId: { in: ids } }, select: { fileKey: true } }).catch(() => []);
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "DEPARTMENT_EXPENSE", entityId: { in: ids } } }).catch(() => {});
    const liens = await prisma.pettyCashAllotment.findMany({ where: { departmentId: deptId }, select: { expenseOrderId: true, transactionId: true } }).catch(() => []);
    const ordres = liens.map((l) => l.expenseOrderId).filter((v): v is string => Boolean(v));
    const ecritures = liens.map((l) => l.transactionId).filter((v): v is string => Boolean(v));
    await prisma.departmentExpenseLine.deleteMany({ where: { expenseId: { in: ids } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { departmentId: deptId } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [adminId, holderId, rhId, horsId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, OR: [{ title: { contains: TAG } }, { body: { contains: TAG } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, holderId, rhId, horsId, pdgId, comptableId] } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("PRÉMISSES : la détentrice dépense sans vue globale ; 100 000 DZD sont en main", async () => {
    const a = await actorFor(holderId, "DIRECTION_ASSISTANT");
    expect(hasGlobalView(a)).toBe(false);
    expect(userCan(a, "GENERAL_MEANS", "CREATE")).toBe(true);
    expect((await fond()).remaining).toBe(100_000);
  });

  it("(a) DEUX DÉPENSES SIMULTANÉES de 60 000 sur 100 000 : une passe, l'autre est refusée en le disant — la caisse ne passe jamais en négatif", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const ouverte = (await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true } })).id;
    const champs = (n: number) => form({ cashId: ouverte, label: `${TAG} achat ${n}`, amount: "60000", year: "2026" }, [pdf()]);
    const [r1, r2] = await Promise.all([spendFromPettyCash(champs(1)), spendFromPettyCash(champs(2))]);
    const oks = [r1, r2].filter((r) => r.ok);
    const refus = [r1, r2].filter((r) => !r.ok);
    expect(oks.length, "une seule dépense passe").toBe(1);
    expect(refus[0]?.error).toMatch(/^Il ne reste que 40000 DZD dans la caisse/);
    const f = await fond();
    expect([f.spent, f.remaining]).toEqual([60_000, 40_000]);
    expect(await prisma.departmentBudgetExpense.count({ where: { departmentId: deptId } })).toBe(1);
  });

  it("(a′) LA SECONDE PORTE — une dépense « payée sur la caisse » saisie par Budget du département relit aussi le fond sous verrou (audit données 2026-10-27)", async () => {
    // Il reste 40 000 après (a). `addDepartmentExpense` contrôlait le fond HORS transaction : deux saisies
    // simultanées de 30 000 passaient toutes deux et la caisse finissait à −20 000.
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const champs = (n: number) => form({ departmentId: deptId, kind: "OPERATING", label: `${TAG} porte2 ${n}`, amount: "30000", year: "2026", paymentSource: "CASH" }, [pdf()]);
    const [r1, r2] = await Promise.all([addDepartmentExpense(champs(1)), addDepartmentExpense(champs(2))]);
    expect([r1, r2].filter((r) => r.ok).length, "une seule dépense passe").toBe(1);
    expect([r1, r2].find((r) => !r.ok)?.error).toMatch(/Il ne reste que 10000 DZD dans la caisse/);
    const f = await fond();
    expect([f.spent, f.remaining]).toEqual([90_000, 10_000]);
  });

  it("(b) LA RALLONGE est annoncée à qui la TRANCHE (les RH, par leur droit) — pas à qui ne le peut pas, ni à la demandeuse", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const ouverte = (await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true } })).id;
    const r = await requestPettyCashTopUp(form({ cashId: ouverte, amount: "30000", reason: `${TAG} fournitures` }));
    expect(r.ok, r.error).toBe(true);
    const avis = (id: string) => prisma.notification.count({ where: { userId: id, title: "Rallonge de caisse d'avance à trancher" } });
    expect(await avis(rhId), "les RH, qui tranchent, sont prévenues").toBe(1);
    expect(await avis(horsId), "qui ne tranche pas n'est pas prévenu").toBe(0);
    expect(await avis(holderId), "la demandeuse ne se prévient pas elle-même").toBe(0);

    // Et la personne prévenue PEUT trancher : la même garde, des deux côtés.
    const rh = await actorFor(rhId, "COORDINATOR");
    expect(hasGlobalView(rh)).toBe(false);
    ACTOR = rh;
    const demande = await prisma.pettyCashTopUpRequest.findFirstOrThrow({ where: { allotment: { departmentId: deptId }, status: "PENDING" }, select: { id: true } });
    const d = await decidePettyCashTopUp(form({ id: demande.id, decision: "REJECTED", note: "Pas ce mois-ci" }));
    expect(d.ok, d.error).toBe(true);
  });

  it("(c) DEUX CORRECTIONS SIMULTANÉES « en fait, c'était sur la caisse » : une passe, la caisse ne passe pas en négatif", async () => {
    // Il reste 10 000 après (a′). Deux dépenses de 8 000 saisies HORS caisse, corrigées ensemble vers la caisse.
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const hors = (n: number) => form({ departmentId: deptId, kind: "OPERATING", label: `${TAG} hors ${n}`, amount: "8000", year: "2026" }, [pdf()]);
    const [h1, h2] = await Promise.all([addDepartmentExpense(hors(1)), addDepartmentExpense(hors(2))]);
    expect(h1.ok && h2.ok, `${h1.error ?? ""} ${h2.error ?? ""}`).toBe(true);
    const versCaisse = (id: string, n: number) => form({ id, label: `${TAG} hors ${n}`, amount: "8000", paymentSource: "CASH" });
    const [c1, c2] = await Promise.all([updateDepartmentExpense(versCaisse(h1.id!, 1)), updateDepartmentExpense(versCaisse(h2.id!, 2))]);
    expect([c1, c2].filter((r) => r.ok).length, "une seule correction passe").toBe(1);
    const f = await fond();
    expect([f.spent, f.remaining]).toEqual([98_000, 2_000]);
  });

  it("(c′) DEUX CLÔTURES SIMULTANÉES : une seule solde la caisse ; la remise soldée ne se confirme plus", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const ouverte = (await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId, status: { not: "CLOSED" } }, select: { id: true } })).id;
    const [k1, k2] = await Promise.all([closePettyCash(form({ id: ouverte })), closePettyCash(form({ id: ouverte }))]);
    expect([k1, k2].filter((r) => r.ok).length, "une seule clôture").toBe(1);
    expect(await prisma.auditLog.count({ where: { actorId: adminId, summary: { startsWith: "Caisse d'avance soldée" } } })).toBe(1);
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    expect((await confirmPettyCashReceipt(form({ id: ouverte }))).ok).toBe(false);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: ouverte } })).status).toBe("CLOSED");
  });
});
