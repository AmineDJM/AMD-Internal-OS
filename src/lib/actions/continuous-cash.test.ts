import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { continuousCash } from "@/lib/general-means/continuous-cash";
import { openRemittances } from "@/lib/queries/general-means";
import { allotPettyCash, confirmPettyCashReceipt, closePettyCash } from "./petty-cash-actions";
import { addDepartmentExpense } from "./department-budget-actions";
import { decidePayment } from "./payment-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__contcash__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/** Une pièce justificative : la dépense en exige une, et c'est très bien ainsi. */
const withFile = (fields: Record<string, string>): FormData => {
  const fd = form(fields);
  fd.set("files", new File([new Uint8Array([1, 2, 3])], "facture.pdf", { type: "application/pdf" }));
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAISSE D'AVANCE EST CONTINUE — remettre une somme ne ferme pas le mois précédent.
 *
 * Le défaut rapporté : « la caisse, quand je remets une somme, le mois ne se ferme pas ; on ne
 * fonctionne plus par mois ». Le code, lui, faisait l'inverse : une remise en septembre ouvrait
 * la caisse de septembre, et les 30 000 DZD d'août sortaient de l'écran — alors qu'ils étaient
 * toujours dans le tiroir. Le solde affiché était faux, et le mois précédent introuvable sans
 * connaître le paramètre d'URL qui le ramène.
 *
 * Ces tests partent du VRAI point d'entrée : les actions serveur, celles que les boutons
 * appellent. Ce que vérifie un module pur — l'arithmétique — est ailleurs ; ce qui se joue ici,
 * c'est que remettre, dépenser et solder se comportent comme la personne l'attend.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Caisse d'avance continue", () => {
  // TROIS MAINS pour l'argent (séparation des tâches, ARGENT-06) : l'administrateur remet, le PDG autorise au
  // centre, la comptabilité règle — un même compte ne fait pas les trois.
  let adminId = "", holderId = "", deptId = "", pdgId = "", comptableId = "";

  beforeAll(async () => {
    const [admin, holder, pdg, comptable] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}assistante`, email: `${TAG}holder@t.dz`, role: "DIRECTION_ASSISTANT", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}comptable`, email: `${TAG}cpt@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" } }),
    ]);
    adminId = admin.id; holderId = holder.id; pdgId = pdg.id; comptableId = comptable.id;
    const dept = await prisma.department.create({ data: { name: `${TAG} Direction générale`, code: `${TAG}DG` } });
    deptId = dept.id;
    // L'assistante achète au quotidien : c'est son module.
    await prisma.userAccess.create({
      data: { userId: holderId, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" },
    });
  });

  afterAll(async () => {
    // Les remises passent par le centre (§118.176) : leurs ordres, leurs dossiers compagnons et les
    // écritures du versement partent avec elles.
    const liens = await prisma.pettyCashAllotment.findMany({
      where: { departmentId: deptId }, select: { expenseOrderId: true, transactionId: true },
    }).catch(() => []);
    const ordres = liens.map((l) => l.expenseOrderId).filter((v): v is string => Boolean(v));
    const ecritures = liens.map((l) => l.transactionId).filter((v): v is string => Boolean(v));
    await prisma.departmentBudgetExpense.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { departmentId: deptId } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.pettyCashPlan.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [pdgId, comptableId] } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [adminId, holderId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const remettre = async (amount: string, period: string) => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    return allotPettyCash(form({ departmentId: deptId, holderId, amount, period }));
  };
  /**
   * LE CENTRE AUTORISE, ET LA SOMME ENTRE DANS LA CAISSE (§118.176, règle du 28/10/2026) — par la vraie
   * action, celle du bouton. Sans ce passage, rien n'est dans le fond : la somme n'est pas partie.
   */
  const verserTout = async () => {
    const [pdg, comptable] = await Promise.all([actorFor(pdgId, "DIRECTION"), actorFor(comptableId, "FINANCE_BUDGET_MANAGER")]);
    const attente = await prisma.pettyCashAllotment.findMany({
      where: { departmentId: deptId, status: "ALLOTTED", transactionId: null, expenseOrderId: { not: null } },
      select: { expenseOrderId: true },
    });
    for (const r of attente) {
      ACTOR = pdg;
      expect((await decidePayment(form({ id: r.expenseOrderId!, decision: "APPROVE" }))).ok).toBe(true);
    }
  };
  const fond = async () => continuousCash(await openRemittances(deptId));

  it("DEUX REMISES DE MOIS DIFFÉRENTS COEXISTENT — la seconde ne clôt pas la première", async () => {
    expect((await remettre("30000", "2026-08")).ok).toBe(true);
    const r2 = await remettre("50000", "2026-09");
    expect(r2.ok, r2.error).toBe(true);

    const lignes = await prisma.pettyCashAllotment.findMany({ where: { departmentId: deptId }, orderBy: { createdAt: "asc" } });
    expect(lignes, "les deux remises devraient être DEUX lignes, pas une somme").toHaveLength(2);
    expect(lignes.every((l) => l.status !== "CLOSED"), "aucune remise ne doit être close par la suivante").toBe(true);
    // Les périodes restent enregistrées : « combien a-t-on remis en août ? » reste une question
    // qu'on peut poser — c'est seulement le cloisonnement qui disparaît.
    expect(lignes.map((l) => l.period)).toEqual(["2026-08", "2026-09"]);

    // Elles partent au CENTRE DE PAIEMENT (§118.176) : chacune porte son ordre, en attente, et la
    // détentrice ne peut encore rien confirmer — la somme n'a pas quitté la banque.
    expect(lignes.every((l) => l.expenseOrderId && !l.transactionId)).toBe(true);
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const tot = await confirmPettyCashReceipt(form({ id: lignes[0]!.id }));
    expect(tot.ok).toBe(false);
    expect(tot.error).toMatch(/centre de paiement/);
    expect((await openRemittances(deptId)).every((r) => r.enAttenteDuCentre)).toBe(true);

    await verserTout();
    const f = await fond();
    expect(f.remitted).toBe(80_000);
    expect(f.remittanceCount).toBe(2);
    // Autorisée par le centre, la remise est EN MAIN : plus de confirmation à attendre.
    expect(f.received).toBe(80_000);
    expect(f.awaitingAmount).toBe(0);
  });

  it("la remise suivante NE REDEMANDE PAS la détentrice — elle est reprise du fond", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await allotPettyCash(form({ departmentId: deptId, amount: "10000", period: "2026-09" }));
    expect(r.ok, r.error).toBe(true);
    const derniere = await prisma.pettyCashAllotment.findFirst({ where: { departmentId: deptId }, orderBy: { createdAt: "desc" } });
    expect(derniere?.holderId).toBe(holderId);
  });

  it("chaque remise entre dans le fond à SON autorisation", async () => {
    await verserTout();
    const f = await fond();
    expect(f.received).toBe(90_000);
    expect(f.remaining).toBe(90_000);
    expect(f.awaitingReceipt).toBe(false);
  });

  it("UNE DÉPENSE QUE LE FOND COUVRE PASSE, même si aucune remise seule n'y suffirait", async () => {
    // Le cœur du chantier : 60 000 DZD sur un fond de 90 000 fait de trois remises (30 / 50 / 10).
    // Le calcul par mois aurait refusé — « la remise de septembre ne couvre pas ce montant ».
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const r = await addDepartmentExpense(withFile({
      departmentId: deptId, year: "2026", kind: "OPERATING", label: `${TAG} imprimante`,
      amount: "60000", paymentSource: "CASH",
    }));
    expect(r.ok, r.error).toBe(true);

    const f = await fond();
    expect(f.spent).toBe(60_000);
    expect(f.remaining).toBe(30_000);
  });

  it("ce que le fond NE couvre pas est refusé, et le motif chiffre ce qui reste", async () => {
    ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
    const r = await addDepartmentExpense(withFile({
      departmentId: deptId, year: "2026", kind: "OPERATING", label: `${TAG} trop cher`,
      amount: "40000", paymentSource: "CASH",
    }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("30000");
  });

  it("SOLDER ARRÊTE LE FOND ENTIER — jamais une tranche isolée", async () => {
    // Ne solder qu'une remise retirerait son montant du fond en y laissant les dépenses imputées
    // sur les autres : un solde qui s'effondre sans qu'une seule dépense n'ait été faite.
    const une = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true } });
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await closePettyCash(form({ id: une.id }));
    expect(r.ok, r.error).toBe(true);

    const restantes = await prisma.pettyCashAllotment.count({ where: { departmentId: deptId, status: { not: "CLOSED" } } });
    expect(restantes, "les trois remises devaient être soldées d'un bloc").toBe(0);
    expect((await fond()).remittanceCount).toBe(0);

    // Les dépenses déjà imputées RESTENT : solder arrête les comptes, il n'efface rien.
    expect(await prisma.departmentBudgetExpense.count({ where: { departmentId: deptId } })).toBe(1);
  });

  it("une caisse soldée refuse une nouvelle clôture, et le dit", async () => {
    const une = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptId }, select: { id: true } });
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const r = await closePettyCash(form({ id: une.id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà soldée/i);
  });
});
