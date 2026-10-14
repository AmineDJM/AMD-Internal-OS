import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { continuousCash } from "@/lib/general-means/continuous-cash";
import { openRemittances } from "@/lib/queries/general-means";
import { deleteFileByKey } from "@/lib/storage";
import { allotPettyCash, confirmPettyCashReceipt, spendFromPettyCash } from "./petty-cash-actions";
import { addDepartmentExpense } from "./department-budget-actions";
import { decidePayment } from "./payment-centre-actions";
import { settleExpenseOrder } from "./expense-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PIÈCE SE JUGE AVANT LA DÉPENSE — moyens généraux, par ses deux portes.
 *
 * Le défaut : `addDepartmentExpense` et `spendFromPettyCash` créaient la dépense (et ses lignes
 * de ticket), PUIS contrôlaient chaque fichier. Un fichier refusé — un type hors de la liste
 * blanche, une taille au-delà du maximum — rendait bien « refusé » à l'écran, mais la dépense
 * restait en base : sans pièce, sans trace d'audit, imputée au budget, sortie de la caisse ; et
 * la personne, qui recommençait avec le bon fichier, en créait une SECONDE.
 *
 * Un refus qui n'annule pas ce qu'il a déjà écrit est un faux refus : le banc ne s'arrête donc pas
 * au message — il compte les dépenses et relit le fond, par les VRAIES actions, avec la détentrice
 * de la caisse (assistante de direction, SANS la vue globale — une garde éprouvée avec la vue
 * globale ne peut pas tomber, §118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mgpieces__${Date.now()}`;
/** Le début du banc, une minute de marge : borne le nettoyage des notifications à l'index de date (§118.175). */
const DEBUT = new Date(Date.now() - 60_000);

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
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

const pdf = (nom = "facture.pdf") => new File([new Uint8Array([1, 2, 3])], nom, { type: "application/pdf" });
/** Hors de la liste blanche des pièces jointes : refusé par `validateUpload`, aujourd'hui comme hier. */
const exe = () => new File([new Uint8Array([77, 90, 0])], "facture.exe", { type: "application/octet-stream" });

suite("moyens généraux — une pièce refusée n'écrit aucune dépense", () => {
  let adminId = "", holderId = "", deptId = "";

  const fond = async () => continuousCash(await openRemittances(deptId));
  const depenses = (label: string) => prisma.departmentBudgetExpense.findMany({ where: { departmentId: deptId, label }, select: { id: true, amount: true, pettyCashId: true } });
  const pieces = (ids: string[]) => prisma.document.count({ where: { entityType: "DEPARTMENT_EXPENSE", entityId: { in: ids } } });

  beforeAll(async () => {
    const [admin, holder] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}assistante`, email: `${TAG}holder@t.dz`, role: "DIRECTION_ASSISTANT", passwordHash: "x" } }),
    ]);
    adminId = admin.id; holderId = holder.id;
    deptId = (await prisma.department.create({ data: { name: `${TAG} Moyens généraux`, code: `${TAG}MG` } })).id;
    // L'assistante achète au quotidien : c'est son module, sur le département dont elle tient la caisse.
    await prisma.userAccess.create({
      data: { userId: holderId, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" },
    });

    // UN FOND EN MAIN, par les vraies actions (§118.176) : remis, autorisé par le centre, versé par
    // les Finances, confirmé reçu par la détentrice.
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const remise = await allotPettyCash(form({ departmentId: deptId, holderId, amount: "100000" }));
    expect(remise.ok, remise.error).toBe(true);
    const ligne = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true, expenseOrderId: true } });
    expect((await decidePayment(form({ id: ligne.expenseOrderId!, decision: "APPROVE" }))).ok).toBe(true);
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
    await prisma.departmentBudgetExpense.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { departmentId: deptId } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.pettyCashPlan.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [adminId, holderId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    // La remise et son autorisation préviennent les sièges du centre et les Finances de TOUTE la base
    // partagée (plus de trois cents comptes, mesuré) : ces avis nomment notre département, et ne
    // concernent personne une fois le banc fini. Bornés par la date, ils se trouvent par l'index au
    // lieu d'un parcours de la table entière.
    await prisma.notification.deleteMany({ where: { createdAt: { gte: DEBUT }, OR: [{ title: { contains: TAG } }, { body: { contains: TAG } }] } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSES : la détentrice achète sans la vue globale, et 100 000 DZD sont en main", async () => {
    const a = await actorFor(holderId, "DIRECTION_ASSISTANT");
    expect(hasGlobalView(a.role), "une garde éprouvée avec la vue globale ne peut pas tomber (§118.104)").toBe(false);
    expect(userCan(a, "GENERAL_MEANS", "CREATE")).toBe(true);
    const f = await fond();
    expect(f.received).toBe(100_000);
    expect(f.spent).toBe(0);
  });

  it("IMPUTER (addDepartmentExpense) avec un fichier refusé : refusée avec le motif du contrôle, et RIEN n'est écrit — ni dépense, ni pièce, ni sortie de caisse", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const label = `${TAG} cartouches`;
    const champs = { departmentId: deptId, year: "2026", kind: "OPERATING", label, amount: "12000", paymentSource: "CASH" };
    // Seul, puis à côté d'une pièce admise : l'ancien contrôle, fichier par fichier dans la boucle
    // d'enregistrement, aurait aussi laissé la facture admise rattachée à la dépense fantôme.
    for (const fichiers of [[exe()], [pdf(), exe()]]) {
      const r = await addDepartmentExpense(form(champs, fichiers));
      expect(r.ok, fichiers.map((f) => f.name).join(" + ")).toBe(false);
      expect(r.error).toMatch(/^« facture\.exe » : Type de fichier non autorisé \(\.exe\)/);
      expect(await depenses(label), "un refus qui laisse la dépense en base est un faux refus").toEqual([]);
    }
    const f = await fond();
    expect(f.spent, "la caisse a payé une dépense refusée").toBe(0);
    expect(f.remaining).toBe(100_000);

    // Un fichier VIDE n'est pas une pièce : refusé par le contrôle de PRÉSENCE, qui précédait déjà la
    // création (ce cas n'est pas un témoin de ce correctif — il dit seulement que rien n'a régressé).
    const vide = await addDepartmentExpense(form(champs, [new File([], "facture.pdf", { type: "application/pdf" })]));
    expect(vide.ok).toBe(false);
    expect(vide.error).toMatch(/Joignez la facture/);
    expect(await depenses(label)).toEqual([]);
  });

  it("…puis la même dépense avec la bonne pièce : UNE ligne — pas de doublon de la tentative refusée —, sa pièce, et le fond baisse de son montant", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const label = `${TAG} cartouches`;
    const r = await addDepartmentExpense(form({ departmentId: deptId, year: "2026", kind: "OPERATING", label, amount: "12000", paymentSource: "CASH" }, [pdf()]));
    expect(r.ok, r.error).toBe(true);
    const lignes = await depenses(label);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.pettyCashId).not.toBeNull();
    expect(await pieces(lignes.map((l) => l.id))).toBe(1);
    const f = await fond();
    expect(f.spent).toBe(12_000);
    expect(f.remaining).toBe(88_000);
  });

  it("DÉPENSER SUR LA CAISSE (spendFromPettyCash) avec un fichier refusé : refusée, rien n'est écrit ; avec la bonne pièce, une ligne et sa pièce", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const caisse = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true } });
    const label = `${TAG} timbres fiscaux`;
    const champs = { cashId: caisse.id, year: "2026", label, amount: "8000" };
    for (const fichiers of [[exe()], [pdf(), exe()]]) {
      const r = await spendFromPettyCash(form(champs, fichiers));
      expect(r.ok, fichiers.map((f) => f.name).join(" + ")).toBe(false);
      expect(r.error).toMatch(/^« facture\.exe » : Type de fichier non autorisé \(\.exe\)/);
      expect(await depenses(label), "un refus qui laisse la dépense en base est un faux refus").toEqual([]);
    }
    expect((await fond()).spent, "la caisse a payé une dépense refusée").toBe(12_000);

    const ok = await spendFromPettyCash(form(champs, [pdf("ticket.pdf")]));
    expect(ok.ok, ok.error).toBe(true);
    const lignes = await depenses(label);
    expect(lignes).toHaveLength(1);
    expect(await pieces(lignes.map((l) => l.id))).toBe(1);
    // 100 000 − 12 000 − 8 000 : le fond reste au-dessus du seuil d'alerte, donc personne n'est
    // prévenu — le banc ne dérange aucun compte de la base partagée.
    expect((await fond()).remaining).toBe(80_000);
  });
});
