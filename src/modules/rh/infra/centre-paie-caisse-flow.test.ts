import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }) }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { envoyerPaieAuCentre, markSalaryPaid, unmarkSalaryPaid, updatePayrollEntry } from "@/modules/rh/actions-paie";
import { allotPettyCash, confirmPettyCashReceipt, closePettyCash } from "@/lib/actions/petty-cash-actions";
import { decidePayment } from "@/lib/actions/payment-centre-actions";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { clauseSalairesVersesANotifier, etatVirement, etatSalaire, saisiAvantLeCentre, SOMME_A_VIRER_MANQUANTE } from "../domaine/virement-paie";
import { instantDuCentreDePaie } from "./paie-centre";
import { ORDRES_AUTORISES_NON_REGLES } from "@/lib/queries/finance";
import { clauseAImputer } from "@/lib/finance/a-imputer";
import { etatRemise } from "@/lib/general-means/remise-centre";
import { getGeneralMeans, openRemittances } from "@/lib/queries/general-means";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centrepaie__";
const YEAR = 2033;
const MONTH = 3;

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAIE ET LA CAISSE D'AVANCE PASSENT PAR LE CENTRE DE PAIEMENT (§118.176) — par les VRAIS
 * points d'entrée, avec des acteurs SANS vue globale (§118.104).
 *
 * « La caisse qui est donnée mensuellement aux moyens généraux ainsi que la paie doivent
 * dorénavant aussi passer par le centre de paiement et attendre la validation. Pour la paie, c'est
 * un bouton pour toute la paie avec mention obligatoire de la somme des salaires à virer (un
 * bouton par entité). » — la Direction, 01/10/2026.
 *
 * Ce que chaque cas fait tomber est écrit sur lui. Les acteurs : une RH qui n'a que le module RH
 * (pas de vue globale) et ne voit que l'entité A ; la Direction au centre ; un financier qui règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Paie et caisse d'avance par le centre de paiement", () => {
  let aId = "", bId = "", cId = "";
  let rhId = "", directionId = "", financeId = "", holderId = "";
  let deptAId = "", deptBId = "";
  let empA1 = "", empA2 = "", empB1 = "";
  let categoryId = "", envelopeId = "";

  const rh = () => actorFor(rhId, "DIRECTION_ASSISTANT");
  const direction = () => actorFor(directionId, "DIRECTION");
  const finance = () => actorFor(financeId, "FINANCE_BUDGET_MANAGER");

  const saisir = async (employeeId: string, net: string, cost = "150000") => {
    ACTOR = await rh();
    return markSalaryPaid(form({ employeeId, year: String(YEAR), month: String(MONTH), employerCost: cost, net }));
  };
  const envoyer = async (fields: Record<string, string>) => {
    ACTOR = await rh();
    return envoyerPaieAuCentre(form({ companyId: aId, year: String(YEAR), month: String(MONTH), ...fields }));
  };
  const autoriser = async (orderId: string) => {
    ACTOR = await direction();
    return decidePayment(form({ id: orderId, decision: "APPROVE" }));
  };
  const refuser = async (orderId: string, body: string) => {
    ACTOR = await direction();
    return decidePayment(form({ id: orderId, decision: "REFUSE", body }));
  };
  const regler = async (orderId: string, extra: Record<string, string> = {}) => {
    ACTOR = await finance();
    return settleExpenseOrder(form({ id: orderId, ...extra }));
  };
  const lignes = (ids: string[]) => prisma.payrollEntry.findMany({
    where: { employeeId: { in: ids }, year: YEAR, month: MONTH },
    include: { payrollWire: { select: { paidAt: true, expenseOrder: { select: { status: true, centralStatus: true } } } } },
  });
  const etats = async (ids: string[]) => {
    const depuis = await instantDuCentreDePaie();
    return (await lignes(ids)).map((l) => etatSalaire({
      status: l.status, transactionId: l.transactionId, budgetTransferredAt: l.budgetTransferredAt,
      virement: l.payrollWire ? etatVirement({ paidAt: l.payrollWire.paidAt, ordre: l.payrollWire.expenseOrder }) : null,
      avantLeCentre: saisiAvantLeCentre(l, depuis),
    }));
  };

  beforeAll(async () => {
    const [a, b, c] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: `${TAG}ADV` } }),
      prisma.company.create({ data: { name: `${TAG} Pharmagène`, shortName: `${TAG}PHA` } }),
      prisma.company.create({ data: { name: `${TAG} Tierce`, shortName: `${TAG}TRC` } }),
    ]);
    aId = a.id; bId = b.id; cId = c.id;
    const [dA, dB] = await Promise.all([
      prisma.department.create({ data: { name: `${TAG} Administration A`, code: `${TAG}A`, companyId: aId } }),
      prisma.department.create({ data: { name: `${TAG} Administration B`, code: `${TAG}B`, companyId: bId } }),
    ]);
    deptAId = dA.id; deptBId = dB.id;
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } }).then((u) => u.id);
    [rhId, directionId, financeId, holderId] = await Promise.all([
      mk("rh", "DIRECTION_ASSISTANT"), mk("direction", "DIRECTION"), mk("finance", "FINANCE_BUDGET_MANAGER"), mk("holder", "DIRECTION_ASSISTANT"),
    ]);
    // LA RH N'A QUE LE MODULE RH, ET NE VOIT QUE L'ENTITÉ A : sans cela, « une entité qui n'est
    // pas la vôtre » ne pourrait pas être refusée, et la garde passerait pour armée (§118.104).
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: rhId, module, canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    await prisma.employee.create({ data: { fullName: `${TAG} RH`, userId: rhId, companyId: aId, departmentId: deptAId } });
    await prisma.userCompanyAccess.create({ data: { userId: rhId, companyId: aId, canEdit: true } });
    await prisma.userAccess.create({ data: { userId: holderId, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });

    const emps = await Promise.all([
      prisma.employee.create({ data: { fullName: `${TAG} Salarié A1`, companyId: aId, departmentId: deptAId, employerCost: 150_000 } }),
      prisma.employee.create({ data: { fullName: `${TAG} Salarié A2`, companyId: aId, departmentId: deptAId, employerCost: 150_000 } }),
      prisma.employee.create({ data: { fullName: `${TAG} Salarié B1`, companyId: bId, departmentId: deptBId, employerCost: 150_000 } }),
    ]);
    [empA1, empA2, empB1] = emps.map((e) => e.id);

    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Enveloppe`, periodStart: new Date(`${YEAR}-01-01`), periodEnd: new Date(`${YEAR}-12-31`), totalAmount: 10_000_000 },
    });
    envelopeId = env.id;
    categoryId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG} Salaires`, allocated: 10_000_000 } })).id;
  });

  afterAll(async () => {
    const remises = await prisma.pettyCashAllotment.findMany({
      where: { departmentId: { in: [deptAId, deptBId] } }, select: { expenseOrderId: true, transactionId: true },
    }).catch(() => []);
    const wires = await prisma.payrollWire.findMany({
      where: { companyId: { in: [aId, bId, cId] } }, select: { expenseOrderId: true, transactionId: true },
    }).catch(() => []);
    const ordres = [...remises, ...wires].map((x) => x.expenseOrderId).filter((v): v is string => Boolean(v));
    const ordresTx = (await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } }).catch(() => []))
      .map((o) => o.transactionId);
    const ecritures = [...remises, ...wires].map((x) => x.transactionId).concat(ordresTx).filter((v): v is string => Boolean(v));
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: { in: [deptAId, deptBId] } } }).catch(() => {});
    await prisma.payrollEntry.deleteMany({ where: { employeeId: { in: [empA1, empA2, empB1] } } }).catch(() => {});
    await prisma.payrollWire.deleteMany({ where: { companyId: { in: [aId, bId, cId] } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.departmentBudget.deleteMany({ where: { departmentId: { in: [deptAId, deptBId] } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envelopeId } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.employee.deleteMany({ where: { OR: [{ id: { in: [empA1, empA2, empB1] } }, { userId: { in: comptes } }] } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userCompanyAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: { in: [deptAId, deptBId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [aId, bId, cId] } } }).catch(() => {});
  });

  describe("la paie — un bouton par entité, avec la somme des salaires à virer", () => {
    it("RIEN DE SAISI, RIEN À ENVOYER — le refus dit le geste qui précède", async () => {
      const r = await envoyer({ amount: "100000" });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Aucun salaire saisi/);
      expect(await prisma.payrollWire.count({ where: { companyId: aId } })).toBe(0);
    });

    it("LA SOMME EST OBLIGATOIRE ET LISIBLE ; l'entité doit être la vôtre ; la catégorie aussi", async () => {
      expect((await saisir(empA1, "100000")).ok).toBe(true);
      expect((await saisir(empA2, "110000")).ok).toBe(true);
      // Le salaire de B est saisi par la RH de B : celle de ce banc ne voit que A, et la porte de la fiche le lui
      // refuse désormais (audit sécurité 27/10, SECURITE-ACCES-09). Il sert ici de témoin « autre entité ».
      ACTOR = await rh();
      expect((await saisir(empB1, "90000")).ok, "la RH de A ne saisit pas la paie d'un salarié de B").toBe(false);
      await prisma.payrollEntry.create({ data: { employeeId: empB1, year: YEAR, month: MONTH, gross: 150_000, employerCost: 150_000, net: 90_000, status: "PAID", paidDate: new Date() } });

      const sans = await envoyer({});
      expect(sans.ok).toBe(false);
      expect(sans.error).toBe(SOMME_A_VIRER_MANQUANTE);
      const illisible = await envoyer({ amount: "1,2 M" });
      expect(illisible.ok).toBe(false);
      expect(illisible.error).toMatch(/pas un montant lisible/);
      const nulle = await envoyer({ amount: "0" });
      expect(nulle.ok).toBe(false);

      // PRÉMISSE : l'entité C existe, et elle n'est pas ouverte à la RH.
      ACTOR = await rh();
      const autre = await envoyerPaieAuCentre(form({ companyId: cId, year: String(YEAR), month: String(MONTH), amount: "1000" }));
      expect(autre.ok).toBe(false);
      expect(autre.error).toMatch(/ne vous est pas ouverte/);

      const categorieForgee = await envoyer({ amount: "210000", budgetCategoryId: categoryId });
      expect(categorieForgee.ok).toBe(false);
      expect(categorieForgee.error).toMatch(/catégorie budgétaire ne vous est pas ouverte/);
      expect(await prisma.payrollWire.count({ where: { companyId: aId } })).toBe(0);
    });

    it("L'ENVOI CRÉE L'ORDRE EN ATTENTE DU CENTRE — l'entité, la nature, la somme déclarée, et la note qui la justifie", async () => {
      const r = await envoyer({ amount: "215000" });
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toMatch(/centre de paiement/);
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId, year: YEAR, month: MONTH } });
      const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: wire.expenseOrderId! } });
      expect(ordre.centralStatus).toBe("AWAITING");
      expect(ordre.companyId).toBe(aId);
      expect(ordre.category).toBe("SALAIRE");
      expect(ordre.sourceType).toBe("PAYROLL");
      expect(ordre.sourceId).toBe(wire.id);
      expect(Number(ordre.amount)).toBe(215_000);
      expect(ordre.label).toMatch(/^Paie mars 2033 — /);
      // La note du centre : la somme déclarée, les nets saisis, et l'écart avec son SIGNE.
      expect(ordre.notes).toMatch(/2 salaires saisis/);
      expect(ordre.notes).toMatch(/écart \+5\s000 DZD/);
      // Les deux salaires de A sont couverts ; celui de B, non — une autre entité, un autre envoi.
      expect(await etats([empA1, empA2])).toEqual(["ENVOYE", "ENVOYE"]);
      expect(await etats([empB1])).toEqual(["SAISI"]);
    });

    it("UN SEUL ENVOI EN COURS — un second envoi, pendant que le premier attend, est refusé", async () => {
      const x = await envoyer({ amount: "215000" });
      expect(x.ok).toBe(false);
      expect(x.error).toMatch(/attend déjà le centre de paiement/);
      expect(await prisma.payrollWire.count({ where: { companyId: aId } })).toBe(1);
    });

    it("AVANT LE CENTRE, RIEN NE PART : pas de règlement, pas d'annonce au salarié, pas d'annulation", async () => {
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId } });
      expect((await regler(wire.expenseOrderId!)).ok).toBe(false);
      const plusTard = new Date(Date.now() + 3 * 86_400_000);
      const annoncables = await prisma.payrollEntry.count({
        where: { AND: [clauseSalairesVersesANotifier(plusTard), { employeeId: { in: [empA1, empA2] } }] },
      });
      expect(annoncables, "« votre salaire a été versé » avant le centre serait une promesse").toBe(0);

      const [l1] = await lignes([empA1]);
      ACTOR = await rh();
      const annuler = await unmarkSalaryPaid(form({ id: l1!.id }));
      expect(annuler.ok).toBe(false);
      expect(annuler.error).toMatch(/corrigez la ligne/);
      // Corriger reste possible — et la phrase dit que la somme déclarée ne bouge pas.
      const corriger = await updatePayrollEntry(form({ id: l1!.id, employerCost: "151000", net: "100500" }));
      expect(corriger.ok, corriger.error).toBe(true);
      expect(corriger.message).toMatch(/n'est pas modifiée/);
    });

    it("AUTORISÉE PUIS RÉGLÉE : UNE écriture, de la somme déclarée — aucune écriture par salarié", async () => {
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId } });
      // LE SOLDE DE TRÉSORERIE LA RETRANCHE DÈS L'AUTORISATION : la paie entre dans la MÊME clause
      // que tout paiement autorisé (celle que lit `chargerTresorerie`), et en sort au règlement —
      // jugé sur CET ordre, pas sur un total que la suite parallèle ferait bouger (§118.92).
      const autorise = () => prisma.expenseOrder.count({ where: { id: wire.expenseOrderId!, ...ORDRES_AUTORISES_NON_REGLES } });
      expect(await autorise(), "en attente du centre, elle n'est pas encore « autorisée à régler »").toBe(0);
      expect((await autoriser(wire.expenseOrderId!)).ok).toBe(true);
      expect(await autorise(), "autorisée, elle se retranche du solde de trésorerie").toBe(1);
      const r = await regler(wire.expenseOrderId!, { budgetCategoryId: categoryId });
      expect(r.ok, r.error).toBe(true);
      expect(await autorise(), "réglée, elle est dans le livre — plus parmi les autorisés").toBe(0);

      const apres = await prisma.payrollWire.findUniqueOrThrow({ where: { id: wire.id } });
      expect(apres.paidAt).not.toBeNull();
      const tx = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: apres.transactionId! } });
      expect(Number(tx.amount)).toBe(215_000);
      expect(tx.category).toBe("SALAIRE");
      expect(tx.companyId).toBe(aId);
      expect(tx.budgetCategoryId).toBe(categoryId);
      expect(await prisma.financeTransaction.count({ where: { employeeId: { in: [empA1, empA2, empB1] } } }),
        "une écriture par salarié compterait la paie deux fois").toBe(0);
      expect(await etats([empA1, empA2])).toEqual(["VIRE", "VIRE"]);

      const plusTard = new Date(Date.now() + 3 * 86_400_000);
      expect(await prisma.payrollEntry.count({
        where: { AND: [clauseSalairesVersesANotifier(plusTard), { employeeId: { in: [empA1, empA2] } }] },
      })).toBe(2);
      // …mais jamais avant 24 h : la marge de correction tient toujours.
      expect(await prisma.payrollEntry.count({
        where: { AND: [clauseSalairesVersesANotifier(new Date()), { employeeId: { in: [empA1, empA2] } }] },
      })).toBe(0);

      // La masse salariale du département suit, au coût employeur saisi (151 000 corrigé + 150 000).
      const masse = await prisma.departmentBudget.findUniqueOrThrow({
        where: { departmentId_year_kind: { departmentId: deptAId, year: YEAR, kind: "HR" } },
      });
      expect(Number(masse.amount)).toBe(301_000);
    });

    it("TOUTE LA PAIE EST VIRÉE : un nouvel envoi est refusé, et l'ordre purgé ne la ferait pas repartir", async () => {
      const deja = await envoyer({ amount: "1000" });
      expect(deja.ok).toBe(false);
      expect(deja.error).toMatch(/déjà virée/);
      // L'historique des règlements se purge : le FAIT du virement reste sur lui.
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId } });
      expect(etatVirement({ paidAt: wire.paidAt, ordre: null })).toBe("VIRE");
    });

    it("UN SALAIRE SAISI APRÈS PART EN COMPLÉMENT — refusé par le centre, il est libéré et repart", async () => {
      // A2 annulé ne peut pas l'être (viré) : on saisit un salaire neuf pour un salarié de A.
      const emp3 = (await prisma.employee.create({ data: { fullName: `${TAG} Salarié A3`, companyId: aId, departmentId: deptAId } })).id;
      try {
        expect((await saisir(emp3, "70000", "90000")).ok).toBe(true);
        const r = await envoyer({ amount: "70000" });
        expect(r.ok, r.error).toBe(true);
        // L'accord et l'élision : « Le complément de paie de mars 2033 … est envoyé » — la phrase
        // écrivait « Complément de paie de mars 2033 … envoyé·e ».
        expect(r.message).toMatch(/^Le complément de paie de mars 2033 de .+ est envoyé au centre de paiement \(/);
        const comp = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId, paidAt: null }, orderBy: { createdAt: "desc" } });
        const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: comp.expenseOrderId! } });
        expect(ordre.label).toMatch(/^Complément de paie mars 2033/);

        expect((await refuser(comp.expenseOrderId!, "Montant à revoir")).ok).toBe(true);
        expect(await etats([emp3])).toEqual(["SAISI"]);
        // Libéré : il s'annule de nouveau, et un nouvel envoi le couvre.
        const [l3] = await lignes([emp3]);
        ACTOR = await rh();
        expect((await unmarkSalaryPaid(form({ id: l3!.id }))).ok).toBe(true);
        expect((await saisir(emp3, "72000", "92000")).ok).toBe(true);
        // DEUX ENVOIS SIMULTANÉS N'EN FONT QU'UN : un double clic ferait sinon deux ordres pour la
        // même paie, et le centre pourrait dire oui aux deux. Ici aucun envoi n'est en cours au
        // départ — c'est la file des envois (`enSerie`), et elle seule, qui arrête le second.
        const avant = await prisma.payrollWire.count({ where: { companyId: aId } });
        const [p1, p2] = await Promise.all([envoyer({ amount: "72000" }), envoyer({ amount: "72000" })]);
        expect([p1.ok, p2.ok].filter(Boolean)).toHaveLength(1);
        expect([p1.error, p2.error].join(" ")).toMatch(/attend déjà le centre de paiement/);
        expect(await prisma.payrollWire.count({ where: { companyId: aId } })).toBe(avant + 1);
        expect(await etats([emp3])).toEqual(["ENVOYE"]);
      } finally {
        await prisma.payrollEntry.deleteMany({ where: { employeeId: emp3 } }).catch(() => {});
        await prisma.employee.deleteMany({ where: { id: emp3 } }).catch(() => {});
      }
    });
  });

  describe("la paie d'AVANT le centre — l'ancien « marquer payé » voulait dire « versé »", () => {
    const AVRIL = 4;

    it("UN SALAIRE MARQUÉ PAYÉ AVANT LA BASCULE EST VERSÉ : il ne repart jamais au centre, et il s'annonce comme avant", async () => {
      // La première version ne regardait que le « transfert au budget » : tout salaire marqué payé
      // sans transfert ressortait « à envoyer », donc payable une SECONDE fois.
      const depuis = await instantDuCentreDePaie();
      expect(depuis, "PRÉMISSE : la migration a posé l'instant de la bascule").not.toBeNull();
      const ancien = await prisma.payrollEntry.create({
        data: {
          employeeId: empA1, year: YEAR, month: AVRIL, status: "PAID", gross: 120_000, net: 100_000, employerCost: 150_000,
          paidDate: new Date(depuis!.getTime() - 3 * 86_400_000), employeeNotifyAt: new Date(depuis!.getTime() - 2 * 86_400_000),
        },
      });
      // Lu par la même règle que l'écran et l'envoi : VIRÉ, jamais « à envoyer ».
      expect(etatSalaire({ status: ancien.status, virement: null, avantLeCentre: saisiAvantLeCentre(ancien, depuis) })).toBe("VIRE");
      // Un salaire saisi APRÈS la bascule, même mois, même entité : lui seul part au centre.
      ACTOR = await rh();
      expect((await markSalaryPaid(form({ employeeId: empA2, year: String(YEAR), month: String(AVRIL), employerCost: "160000", net: "110000" }))).ok).toBe(true);
      const r = await envoyerPaieAuCentre(form({ companyId: aId, year: String(YEAR), month: String(AVRIL), amount: "110000" }));
      expect(r.ok, r.error).toBe(true);
      // Une partie du mois a déjà été versée : c'est un COMPLÉMENT — et il ne couvre que la saisie neuve.
      expect(r.message).toMatch(/^Le complément de paie d'avril 2033 de .+ est envoyé au centre de paiement/);
      const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: aId, year: YEAR, month: AVRIL } });
      const couverts = (await prisma.payrollEntry.findMany({ where: { payrollWireId: wire.id }, select: { id: true } })).map((c) => c.id);
      expect(couverts, "renvoyer au centre un salaire déjà versé le paierait deux fois").not.toContain(ancien.id);
      expect(couverts).toHaveLength(1);
      expect(Number(wire.amount)).toBe(110_000);
      // L'annonce : versé par l'ancien circuit, il est annoncé comme avant, sans virement — et sans
      // l'instant, il resterait muet pour toujours.
      const annoncable = (clause: ReturnType<typeof clauseSalairesVersesANotifier>) =>
        prisma.payrollEntry.count({ where: { AND: [clause, { id: ancien.id }] } });
      expect(await annoncable(clauseSalairesVersesANotifier(new Date(), depuis))).toBe(1);
      expect(await annoncable(clauseSalairesVersesANotifier(new Date()))).toBe(0);
    });
  });

  describe("la caisse d'avance — la remise passe par le centre", () => {
    let remiseId = "";

    it("REMETTRE CRÉE L'ORDRE, PAS L'ÉCRITURE — et l'ordre porte l'entité du DÉPARTEMENT", async () => {
      // PRÉMISSE : la RH travaille chez A ; le département de la caisse est chez B. Le repli sur sa
      // fiche rattacherait la remise à la mauvaise société.
      ACTOR = await rh();
      const r = await allotPettyCash(form({ departmentId: deptBId, holderId, amount: "24000", period: "2033-03" }));
      expect(r.ok, r.error).toBe(true);
      const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptBId } });
      remiseId = remise.id;
      expect(remise.status).toBe("ALLOTTED");
      expect(remise.transactionId, "écrire la sortie avant l'autorisation, c'est inscrire un décaissement que personne n'a autorisé").toBeNull();
      const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: remise.expenseOrderId! } });
      expect(ordre.centralStatus).toBe("AWAITING");
      expect(ordre.companyId).toBe(bId);
      expect(Number(ordre.amount)).toBe(24_000);
      // LE FOND NE COMPTE QUE CE QUI EST VERSÉ : la remise est listée, avec ce qu'elle attend, mais
      // « Remis (non soldé) » ne la compte pas — sinon la détentrice se verrait annoncer une somme
      // à confirmer qu'elle ne peut pas recevoir. Lu par le chargeur de l'ÉCRAN.
      const vue = await getGeneralMeans(await actorFor(holderId, "DIRECTION_ASSISTANT"), deptBId, YEAR);
      expect(vue?.cash?.remittances.find((x) => x.id === remise.id)?.centre).toBe("EN_ATTENTE");
      expect(vue?.cash?.fund.remitted).toBe(0);
      expect(vue?.cash?.fund.remittanceCount).toBe(0);
    });

    it("AVANT LE CENTRE, RIEN À CONFIRMER ; AUTORISÉE, LA REMISE EST DANS LA CAISSE — sans passer par les Finances (Direction, 28/10/2026)", async () => {
      ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
      const avant = await confirmPettyCashReceipt(form({ id: remiseId }));
      expect(avant.ok).toBe(false);
      expect(avant.error).toMatch(/centre de paiement/);
      const remise = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remiseId } });
      const r = await autoriser(remise.expenseOrderId!);
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toMatch(/ajoutés à la caisse d'avance/);
      const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: remise.expenseOrderId! } });
      expect(ordre.status, "l'ordre ne reste pas dans « Banque & paiements »").toBe("PAID");
      const apres = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remiseId } });
      expect(apres.status, "en main dès l'autorisation, sans confirmation").toBe("RECEIVED");
      expect(apres.transactionId).toBe(ordre.transactionId);
      const fond = (await openRemittances(remise.departmentId)).find((x) => x.id === remiseId);
      expect(fond?.enAttenteDuCentre).toBe(false);
    });

    it("VERSÉE À L'AUTORISATION : UNE écriture SANS catégorie (ce n'est pas une dépense), en liquide, rattachée à la remise, et la détentrice est prévenue", async () => {
      const apres = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remiseId } });
      expect(await prisma.financeTransaction.count({ where: { id: apres.transactionId! } })).toBe(1);
      const tx = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: apres.transactionId! } });
      expect(tx.budgetCategoryId, "imputer la remise compterait le même dinar deux fois").toBeNull();
      expect(tx.method).toBe("CASH");
      expect(tx.companyId).toBe(bId);
      expect(await prisma.notification.count({ where: { userId: holderId, title: "Caisse d'avance créditée" } })).toBe(1);
      // Les Finances n'ont plus rien à régler : un second règlement ne pose pas une seconde écriture.
      expect((await regler(apres.expenseOrderId!, { budgetCategoryId: categoryId })).ok).toBe(true);
      expect(await prisma.financeTransaction.count({ where: { label: tx.label, companyId: bId } })).toBe(1);

      // Elle ne traîne pas parmi les « à imputer » — une dépense ordinaire sans catégorie, si.
      const ordinaire = await prisma.financeTransaction.create({
        data: { reference: `${TAG}ord`, direction: "OUT", category: "AUTRE", label: `${TAG} ordinaire`, amount: 1000, status: "SETTLED", date: tx.date },
      });
      const du = new Date(tx.date.getTime() - 86_400_000);
      const au = new Date(tx.date.getTime() + 86_400_000);
      const aImputer = (await prisma.financeTransaction.findMany({ where: await clauseAImputer(du, au), select: { id: true } })).map((t) => t.id);
      expect(aImputer).not.toContain(tx.id);
      expect(aImputer).toContain(ordinaire.id);
    });

    it("UNE REMISE AUTORISÉE AVANT LA RÈGLE, restée chez les Finances, est versée par le même écrivain et entre dans la caisse", async () => {
      ACTOR = await rh();
      expect((await allotPettyCash(form({ departmentId: deptBId, holderId, amount: "6000", period: "2033-06" }))).ok).toBe(true);
      const ancienne = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptBId, amount: 6000 } });
      // L'état qu'avait une remise autorisée avant le 28/10 : autorisée, pas encore versée.
      await prisma.expenseOrder.update({ where: { id: ancienne.expenseOrderId! }, data: { centralStatus: "APPROVED" } });
      const r = await regler(ancienne.expenseOrderId!, {});
      expect(r.ok, r.error).toBe(true);
      const apres = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: ancienne.id } });
      expect(apres.status).toBe("RECEIVED");
      expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: apres.transactionId! } })).budgetCategoryId).toBeNull();
    });

    it("REFUSÉE PAR LE CENTRE : la remise sort du fond, la raison s'écrit sur elle, la détentrice l'apprend", async () => {
      ACTOR = await rh();
      expect((await allotPettyCash(form({ departmentId: deptBId, holderId, amount: "5000", period: "2033-04" }))).ok).toBe(true);
      const refusee = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptBId, amount: 5000 } });
      expect((await refuser(refusee.expenseOrderId!, "Caisse déjà suffisante ce mois-ci")).ok).toBe(true);
      const apres = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: refusee.id }, include: { expenseOrder: true } });
      expect(apres.status).toBe("CLOSED");
      expect(apres.note).toMatch(/Refusée par le centre de paiement : Caisse déjà suffisante/);
      expect(etatRemise({ aUnOrdre: true, ordre: apres.expenseOrder, transactionId: apres.transactionId })).toBe("REFUSEE");
      expect((await openRemittances(deptBId)).map((r) => r.id)).not.toContain(refusee.id);
      expect(await prisma.notification.count({ where: { userId: holderId, title: "Remise de caisse refusée" } })).toBe(1);
    });

    it("SOLDER LA CAISSE NE SOLDE PAS UNE REMISE QUI ATTEND LE CENTRE", async () => {
      ACTOR = await rh();
      expect((await allotPettyCash(form({ departmentId: deptBId, holderId, amount: "8000", period: "2033-05" }))).ok).toBe(true);
      const enAttente = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: deptBId, amount: 8000 } });
      ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
      const r = await closePettyCash(form({ id: remiseId }));
      expect(r.ok, r.error).toBe(true);
      expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remiseId } })).status).toBe("CLOSED");
      expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: enAttente.id } })).status,
        "soldée, elle serait versée par les Finances vers une caisse fermée").toBe("ALLOTTED");
      const seule = await closePettyCash(form({ id: enAttente.id }));
      expect(seule.ok).toBe(false);
      expect(seule.error).toMatch(/attend encore le centre de paiement/);
    });

    it("UNE REMISE D'AVANT LA RÈGLE (sans ordre) se confirme comme avant", async () => {
      const ancienne = await prisma.pettyCashAllotment.create({
        data: { departmentId: deptAId, period: "2033-01", amount: 3000, holderId },
      });
      ACTOR = await actorFor(holderId, "DIRECTION_ASSISTANT");
      const r = await confirmPettyCashReceipt(form({ id: ancienne.id }));
      expect(r.ok, r.error).toBe(true);
    });
  });
});
