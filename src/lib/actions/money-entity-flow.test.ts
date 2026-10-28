import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { moneyEntityOf, adventumCompanyId } from "@/lib/company";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { envoyerPaieAuCentre } from "./payroll-hr-actions";
import { decidePayment } from "@/modules/finances/actions-centre";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__moneyent__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const withPiece = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set("kind_0", "INVOICE");
  fd.set("paymentMethodStated", "1");
  // UNE FACTURE DISTINCTE PAR DEMANDE (Direction, 14/10) : le même fichier deux fois serait la même facture, refusée.
  fd.append("files", new File([new Uint8Array([1, 2, 3]), `${Date.now()}-${Math.random()}`], "facture.pdf", { type: "application/pdf" }));
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ENTITÉ EST LA COLONNE VERTÉBRALE DE L'ARGENT.
 *
 * Elle était facultative et implicite : la demande de paiement prenait celle du demandeur en
 * silence — et, pire, celle de sa PORTÉE D'AFFICHAGE. Un délégué de Pharmagène qui consultait
 * Adventum imputait sa demande à Adventum : la société qui paie était décidée par un cookie.
 *
 * Et la masse salariale du budget restait un montant SAISI À LA MAIN, qu'on remontait à chaque
 * embauche et qu'on oubliait à chaque départ.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("L'entité de l'argent", () => {
  let advId = "", phaId = "", deptId = "", rhId = "", demandeurId = "", employeId = "";

  beforeAll(async () => {
    const [adv, pha] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: `${TAG}ADV` } }),
      prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: `${TAG}PHA` } }),
    ]);
    advId = adv.id; phaId = pha.id;
    const dept = await prisma.department.create({ data: { name: `${TAG} Ventes`, code: `${TAG}V`, companyId: phaId } });
    deptId = dept.id;

    const [rh, dem] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}rh`, email: `${TAG}rh@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}dem`, email: `${TAG}dem@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
    ]);
    rhId = rh.id; demandeurId = dem.id;

    // LE DEMANDEUR TRAVAILLE CHEZ PHARMAGÈNE : c'est cette société qui doit payer ses dépenses.
    const emp = await prisma.employee.create({
      data: {
        fullName: `${TAG} Délégué`, userId: demandeurId, companyId: phaId, departmentId: deptId,
        employerCost: 120_000,
      },
    });
    employeId = emp.id;
    // On lui ouvre les DEUX entités : sans cela, la règle ne pourrait pas se tromper de société,
    // et le test ne prouverait rien.
    await prisma.userCompanyAccess.createMany({
      data: [
        { userId: demandeurId, companyId: advId, canEdit: true },
        { userId: demandeurId, companyId: phaId, canEdit: true },
      ],
    });
    await prisma.userAccess.create({
      data: { userId: demandeurId, module: "VALIDATIONS", canView: true, canCreate: true, scope: "ALL" },
    });
  });

  afterAll(async () => {
    await prisma.departmentBudget.deleteMany({ where: { departmentId: deptId } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { employeeId: employeId } }).catch(() => {});
    await prisma.payrollEntry.deleteMany({ where: { employeeId: employeId } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { requesterId: demandeurId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { userId: demandeurId } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [rhId, demandeurId] } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [advId, phaId] } } }).catch(() => {});
  });

  describe("la demande de paiement", () => {
    it("L'ARGENT SUIT LA PERSONNE — sa société, pas la portée de son écran", async () => {
      expect(await moneyEntityOf(demandeurId)).toBe(phaId);
    });

    // DEPUIS LE 06/10 : la demande d'un salarié est rattachée d'office à Adventum, sans choix.
    it("la demande est rattachée à ADVENTUM d'office, même si le demandeur travaille chez Pharmagène", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      const r = await createPaymentRequest(undefined, withPiece({
        title: `${TAG} Facture transporteur`, payee: "Transporteur", amount: "12000",
      }));
      expect(r.ok, r.error).toBe(true);
      const attendu = await adventumCompanyId();
      expect(attendu).not.toBeNull();
      expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r.id! } })).companyId).toBe(attendu);
    });

    it("une entité envoyée quand même est IGNORÉE : pas de choix d'entité", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      const r = await createPaymentRequest(undefined, withPiece({
        title: `${TAG} Facture imprimeur`, payee: "Imprimeur", amount: "40000", companyId: phaId,
      }));
      expect(r.ok, r.error).toBe(true);
      const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r.id! } });
      expect(req.companyId).toBe(await adventumCompanyId());
      expect(req.companyId).not.toBe(phaId);
    });

    it("UN BROUILLON se garde incomplet — c'est sa raison d'être", async () => {
      ACTOR = await actorFor(demandeurId, "MEDICAL_DELEGATE");
      const fd = withPiece({ title: `${TAG} Brouillon`, payee: "X", amount: "500", companyId: "" });
      fd.set("submit", "0");
      expect((await createPaymentRequest(undefined, fd)).ok).toBe(true);
    });
  });

  describe("la masse salariale au budget", () => {
    // Depuis §118.176, la masse s'actualise au RÈGLEMENT du virement de la paie (centre de
    // paiement → Finances), et non plus au « transfert au budget », qui n'existe plus. La propriété
    // est la même : on REMPLACE, on n'additionne pas.
    it("S'ACTUALISE AU VIREMENT, ELLE NE S'AJOUTE PAS — et régler deux fois ne double rien", async () => {
      await prisma.payrollEntry.create({
        data: {
          employeeId: employeId, year: 2031, month: 3, status: "PAID", paidDate: new Date(),
          gross: 100_000, net: 80_000, bonuses: 0, deductions: 0, employerCost: 120_000,
        },
      });
      const envelope = await prisma.budgetEnvelope.create({
        data: {
          name: `${TAG} Enveloppe`, periodStart: new Date("2031-01-01"), periodEnd: new Date("2031-12-31"),
          totalAmount: 1_000_000,
        },
      });
      const cat = await prisma.budgetCategoryLine.create({
        data: { envelopeId: envelope.id, name: `${TAG} Salaires`, allocated: 1_000_000 },
      });

      ACTOR = await actorFor(rhId, "SUPER_ADMIN");
      const fd = new FormData();
      fd.set("companyId", phaId); fd.set("year", "2031"); fd.set("month", "3");
      fd.set("amount", "80000"); fd.set("budgetCategoryId", cat.id);
      const r = await envoyerPaieAuCentre(fd);
      expect(r.ok, r.error).toBe(true);
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: phaId, year: 2031, month: 3 } });
      const regler = () => { const f = new FormData(); f.set("id", wire.expenseOrderId!); return settleExpenseOrder(f); };

      // Avant l'autorisation du centre, rien ne bouge — ni le livre, ni la masse.
      expect((await regler()).ok).toBe(false);
      const autoriser = new FormData(); autoriser.set("id", wire.expenseOrderId!); autoriser.set("decision", "APPROVE");
      expect((await decidePayment(autoriser)).ok).toBe(true);
      const regle = await regler();
      expect(regle.ok, regle.error).toBe(true);

      const apres = await prisma.departmentBudget.findUniqueOrThrow({
        where: { departmentId_year_kind: { departmentId: deptId, year: 2031, kind: "HR" } },
      });
      expect(Number(apres.amount), "la masse salariale vaut le coût employeur saisi").toBe(120_000);

      // REJOUER le règlement : déjà réglé, rien de neuf, et surtout aucune addition.
      expect((await regler()).ok).toBe(true);
      const inchange = await prisma.departmentBudget.findUniqueOrThrow({
        where: { departmentId_year_kind: { departmentId: deptId, year: 2031, kind: "HR" } },
      });
      expect(Number(inchange.amount), "un second règlement ne doit rien ADDITIONNER").toBe(120_000);

      const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: wire.expenseOrderId! } });
      await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: ordre.id } }).catch(() => {});
      await prisma.payrollWire.deleteMany({ where: { id: wire.id } }).catch(() => {});
      await prisma.expenseOrder.deleteMany({ where: { id: ordre.id } }).catch(() => {});
      if (ordre.transactionId) await prisma.financeTransaction.deleteMany({ where: { id: ordre.transactionId } }).catch(() => {});
      await prisma.budgetCategoryLine.delete({ where: { id: cat.id } }).catch(() => {});
      await prisma.budgetEnvelope.delete({ where: { id: envelope.id } }).catch(() => {});
    });
  });
});
