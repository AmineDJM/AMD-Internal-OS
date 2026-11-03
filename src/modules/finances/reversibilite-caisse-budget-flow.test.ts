import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retablirGeste } from "@/lib/effets/retablissement";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import {
  allotPettyCash, annulerRallongeCaisse, closePettyCash, confirmPettyCashReceipt, decidePettyCashTopUp, nextRechargeFor,
  requestPettyCashTopUp, runPettyCashRechargeReminders, setPettyCashPlan, spendFromPettyCash,
} from "@/lib/actions/petty-cash-actions";
import { addDepartmentExpense, deleteDepartmentExpense, updateDepartmentExpense } from "@/lib/actions/department-budget-actions";
import { attributeTransaction, changerSocieteEcriture } from "@/lib/actions/budget-envelope-actions";
import { reglerPoleCampagne } from "@/lib/actions/budget-campagne-actions";
import { reglerFournisseurVentesPch } from "@/lib/actions/ventes-pch-actions";
import { updateSupplierView } from "@/lib/actions/supplier-actions";
import { decidePayment } from "./actions-centre";
import { repondreActualisationSoldes } from "./actions-soldes";
import { corrigerAncrageTresorerie, createPayroll, createTransaction, importTransactions } from "./actions-tresorerie";
import { changerBudgetDepensePoste, consommerDepensePoste, imputerDepensePoste } from "@/lib/actions/budget-depense-poste-actions";
import { envoyerPaieAuCentre, markSalaryPaid, unmarkSalaryPaid, updatePayrollEntry } from "@/modules/rh/actions-paie";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__k10a_cb__";
// TOUT ce que le banc crée, cherche et nettoie porte RUN, jamais le seul TAG : un ménage ou une lecture par TAG
// touchait les écritures d'un AUTRE passage du fichier lancé à côté (F1).
const RUN = `${TAG}${Date.now().toString(36)}`;
const YEAR = 2034;

/** Les effets que l'annulation n'a pas pu défaire — hors la notification poussée déjà partie (effet sortant, K10b). */
const bloquants = (c: CompteRenduAnnulation) => c.details.filter((d) => d.issue === "IMPOSSIBLE" && !/^notification poussée/.test(d.quoi)).map((d) => `${d.quoi} : ${d.pourquoi}`);

const fd = (champs: Record<string, string>, fichiers: File[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  for (const x of fichiers) f.append("files", x);
  return f;
};
const pdf = (nom = "ticket.pdf") => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, Math.floor(Math.random() * 250)])], nom, { type: "application/pdf" });

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CAISSE D'AVANCE, BUDGETS, PAIE : RÉVERSIBLES PAR LES VRAIS POINTS D'ENTRÉE (lot K10a, décision 0041).
 *
 * Même protocole que `reversibilite-argent-flow.test.ts` : exécuter l'action de l'écran, relire, annuler le geste
 * journalisé, vérifier l'état d'avant (ou la compensation), et que rien d'autre que la poussée partie ne reste
 * « impossible ». Une CASCADE (la remise d'une caisse versée par le centre, puis annulée) refuse en le disant, sans
 * laisser d'état incohérent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("K10a — caisse, budgets et paie se défont d'un geste", () => {
  const u: Record<string, string> = {};
  let soc = "", soc2 = "", compte = "", dept = "", employe = "";

  const dernierGeste = async () => {
    const g = await prisma.assistantGesteJournal.findFirst({ where: { principalId: ACTOR!.id, origine: "ecran", annuleLe: null }, orderBy: { creeLe: "desc" }, include: { effets: true } });
    return g!;
  };
  const annulerDernier = async (): Promise<CompteRenduAnnulation> => {
    const g = await dernierGeste();
    const r = await annulerGeste(g.id, ACTOR!);
    if ("refus" in r) throw new Error(r.refus);
    return r;
  };
  const nbGestes = () => prisma.assistantGesteJournal.count({ where: { principalId: { in: Object.values(u) } } });
  const commeSa = async () => { ACTOR = await acteur(u.sa, "SUPER_ADMIN"); };

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([mk("sa", "SUPER_ADMIN"), mk("pdg", "DIRECTION"), mk("holder", "DIRECTION_ASSISTANT")]);
    soc = (await prisma.company.create({ data: { name: `${RUN} Adventum`, shortName: `${RUN}A` } })).id;
    soc2 = (await prisma.company.create({ data: { name: `${RUN} Pharmagène`, shortName: `${RUN}B` } })).id;
    compte = (await prisma.treasuryAccount.create({ data: { name: `${RUN} Banque`, openingBalance: 1_000_000, openingDate: new Date("2026-01-01"), companyId: soc, principal: true } })).id;
    dept = (await prisma.department.create({ data: { name: `${RUN} Moyens généraux`, code: `${RUN}MG`, companyId: soc } })).id;
    employe = (await prisma.employee.create({ data: { fullName: `${RUN} Salarié`, companyId: soc, departmentId: dept } })).id;
    await prisma.userAccess.create({ data: { userId: u.holder, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
    await commeSa();
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    const depenses = (await prisma.departmentBudgetExpense.findMany({ where: { departmentId: dept }, select: { id: true } }).catch(() => [])).map((e) => e.id);
    await prisma.document.deleteMany({ where: { entityId: { in: depenses } } }).catch(() => {});
    await prisma.departmentExpenseLine.deleteMany({ where: { expenseId: { in: depenses } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { departmentId: dept } }).catch(() => {});
    const remises = await prisma.pettyCashAllotment.findMany({ where: { departmentId: dept }, select: { expenseOrderId: true } }).catch(() => []);
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { departmentId: dept } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: dept } }).catch(() => {});
    await prisma.pettyCashPlan.deleteMany({ where: { departmentId: dept } }).catch(() => {});
    const wires = (await prisma.payrollWire.findMany({ where: { companyId: soc }, select: { id: true } }).catch(() => [])).map((w) => w.id);
    await prisma.payrollEntry.deleteMany({ where: { employeeId: employe } }).catch(() => {});
    const ordres = [...remises.map((r) => r.expenseOrderId).filter((x): x is string => Boolean(x)),
      ...(await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: wires } }, { companyId: { in: [soc, soc2] } }] }, select: { id: true } }).catch(() => [])).map((o) => o.id)];
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.payrollWire.deleteMany({ where: { id: { in: wires } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.updateMany({ where: { OR: [{ treasuryAccountId: compte }, { label: { startsWith: RUN } }, { companyId: { in: [soc, soc2] } }] }, data: { compensationDeId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ treasuryAccountId: compte }, { label: { startsWith: RUN } }, { companyId: { in: [soc, soc2] } }] } }).catch(() => {});
    await prisma.demandeActualisationSoldes.deleteMany({ where: { companyId: soc } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.budgetProposal.deleteMany({ where: { poleLabel: { startsWith: RUN } } }).catch(() => {});
    await prisma.budgetCampaign.deleteMany({ where: { title: { startsWith: RUN } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.pchFournisseurProduit.deleteMany({ where: { product: { identityKey: { startsWith: RUN } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: RUN } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { identityKey: { startsWith: RUN } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employe } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: dept } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    ACTOR = null;
  }, 60_000);

  // ── CAISSE D'AVANCE ──────────────────────────────────────────────────────────────────────
  it("REMETTRE une caisse (avant le centre) → annuler la RETIRE avec son ordre ; RÉTABLIR la remet", async () => {
    await commeSa();
    const r = await allotPettyCash(fd({ departmentId: dept, holderId: u.holder, amount: "40000" }));
    expect(r.ok, r.error).toBe(true);
    const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: dept } });
    expect(remise.expenseOrderId).toBeTruthy();
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect(await prisma.pettyCashAllotment.findUnique({ where: { id: remise.id } })).toBeNull();
    expect(await prisma.expenseOrder.findUnique({ where: { id: remise.expenseOrderId! } })).toBeNull();
    // RÉTABLIR : la remise et son ordre reviennent, même identifiants.
    const re = await retablirGeste(c.gesteId, ACTOR!);
    // Les notifications « autorisation demandée » vont aux sièges du centre — des personnes que d'autres bancs créent
    // et retirent en parallèle : en recréer une pour une personne disparue est refusé, à juste titre. Le reste est rétabli.
    expect("refus" in re ? re.refus : bloquants(re).filter((b) => !/^notification à une personne/.test(b))).toEqual([]);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } })).expenseOrderId).toBe(remise.expenseOrderId);
  });

  it("CASCADE — la remise VERSÉE par le centre (un autre geste) puis annulée : refus dit, ligne par ligne, et rien d'incohérent", async () => {
    await commeSa();
    const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: dept } });
    // Le geste de la remise, RÉTABLI au cas précédent : il se ré-annule (K10b).
    const gesteRemise = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: u.sa, capaciteId: "petty-cash-actions:allotPettyCash", annuleLe: null }, orderBy: { creeLe: "desc" } });
    ACTOR = await acteur(u.pdg, "DIRECTION");
    const d = await decidePayment(fd({ id: remise.expenseOrderId!, decision: "APPROVE" }));
    expect(d.ok, d.error).toBe(true);
    const versee = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } });
    expect(versee.status).toBe("RECEIVED");
    const ordreAvant = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: remise.expenseOrderId! } });
    // Le Super Admin annule de nouveau la remise rétablie : elle a vécu depuis — versée par le centre.
    await commeSa();
    const c = await annulerGeste(gesteRemise.id, ACTOR!);
    // TOUT OU RIEN (K10b) : un geste d'écran dont un effet ne se défait plus n'est PAS annulé à moitié — le refus nomme,
    // effet par effet, ce qui a bougé depuis.
    expect("refus" in c, "un geste en partie vécu depuis ne s'annule pas à moitié").toBe(true);
    if (!("refus" in c)) return;
    expect(c.refus).toMatch(/^Rien n'est annulé/);
    expect(c.refus).toMatch(/modifiée depuis|vaut maintenant|rattaché/);
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteRemise.id } })).annuleLe).toBeNull();
    // Rien d'incohérent : la remise reste versée, son ordre reste payé et lié.
    const apres = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } });
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: remise.expenseOrderId! } });
    expect([apres.status, apres.expenseOrderId, ordre.status]).toEqual(["RECEIVED", remise.expenseOrderId, ordreAvant.status]);
  });

  it("CONFIRMER la réception → remis ; DÉPENSER sur la caisse → la dépense retirée ; RALLONGE demandée, refusée, retirée → chaque geste se remet", async () => {
    const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: dept } });
    // La confirmation d'une remise encore ALLOTTED : on repasse la remise à « remise » pour l'éprouver.
    await prisma.pettyCashAllotment.update({ where: { id: remise.id }, data: { status: "ALLOTTED" } });
    ACTOR = await acteur(u.holder, "DIRECTION_ASSISTANT");
    const conf = await confirmPettyCashReceipt(fd({ id: remise.id }));
    expect(conf.ok, conf.error).toBe(true);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } })).status).toBe("RECEIVED");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } })).status).toBe("ALLOTTED");
    await prisma.pettyCashAllotment.update({ where: { id: remise.id }, data: { status: "RECEIVED" } });

    const dep = await spendFromPettyCash(fd({ cashId: remise.id, label: `${RUN} fournitures`, amount: "5000", year: "2026" }, [pdf()]));
    expect(dep.ok, dep.error).toBe(true);
    expect(await prisma.departmentBudgetExpense.count({ where: { departmentId: dept } })).toBe(1);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.departmentBudgetExpense.count({ where: { departmentId: dept } })).toBe(0);

    const dem = await requestPettyCashTopUp(fd({ cashId: remise.id, amount: "10000", reason: `${RUN} rallonge` }));
    expect(dem.ok, dem.error).toBe(true);
    const rallonge = await prisma.pettyCashTopUpRequest.findFirstOrThrow({ where: { allotmentId: remise.id } });
    const retrait = await annulerRallongeCaisse(fd({ id: rallonge.id }));
    expect(retrait.ok, retrait.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.pettyCashTopUpRequest.findUniqueOrThrow({ where: { id: rallonge.id } })).status).toBe("PENDING");

    await commeSa();
    const dec = await decidePettyCashTopUp(fd({ id: rallonge.id, decision: "REJECTED", note: "pas ce mois-ci" }));
    expect(dec.ok, dec.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.pettyCashTopUpRequest.findUniqueOrThrow({ where: { id: rallonge.id } })).status).toBe("PENDING");

    ACTOR = await acteur(u.holder, "DIRECTION_ASSISTANT");
    expect(bloquants(await annulerDernier())).toEqual([]); // la demande de rallonge elle-même : retirée
    expect(await prisma.pettyCashTopUpRequest.findUnique({ where: { id: rallonge.id } })).toBeNull();
  });

  it("CLÔTURER la caisse → rouverte ; RÉGLER le plan mensuel → retiré ; le rappel planifié (sans session) et la lecture n'entrent pas au journal", async () => {
    await commeSa();
    const remise = await prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: dept } });
    const k = await closePettyCash(fd({ id: remise.id }));
    expect(k.ok, k.error).toBe(true);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } })).status).toBe("CLOSED");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: remise.id } })).status).toBe("RECEIVED");

    const p = await setPettyCashPlan(fd({ departmentId: dept, monthlyAmount: "30000", rechargeDay: "5", holderId: u.holder, isActive: "1" }));
    expect(p.ok, p.error).toBe(true);
    expect(await prisma.pettyCashPlan.count({ where: { departmentId: dept } })).toBe(1);
    // Lecture : `nextRechargeFor` n'écrit rien, aucun geste.
    const avant = await nbGestes();
    expect(await nextRechargeFor(dept, new Date("2026-11-01"))).not.toBeNull();
    expect(await nbGestes()).toBe(avant);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.pettyCashPlan.count({ where: { departmentId: dept } })).toBe(0);

    // Le rappel planifié tourne SANS session : il s'exécute tel quel, HORS journal (limite : une tâche planifiée n'a
    // pas de personne au nom de qui l'annuler). Ce qu'il touche (`lastReminderPeriod`) est un champ TECHNIQUE
    // (`modeles.ts`, `CHAMPS_TECHNIQUES`) : il ne fait pas du plan une fiche « modifiée depuis » — l'annulation le retire.
    expect((await setPettyCashPlan(fd({ departmentId: dept, monthlyAmount: "30000", rechargeDay: "5", holderId: u.holder, isActive: "1" }))).ok).toBe(true);
    const sauve = ACTOR;
    ACTOR = null;
    const gestes = await nbGestes();
    await runPettyCashRechargeReminders(new Date("2026-11-05T09:00:00Z"));
    ACTOR = sauve;
    expect(await nbGestes()).toBe(gestes);
    const plan = await prisma.pettyCashPlan.findFirstOrThrow({ where: { departmentId: dept } });
    expect(plan.lastReminderPeriod).not.toBeNull();
    const c = await annulerDernier();
    expect(c.details.find((d) => /petty cash plan/.test(d.quoi))).toMatchObject({ issue: "ANNULE" });
    expect(await prisma.pettyCashPlan.count({ where: { departmentId: dept } })).toBe(0);
  });

  // ── BUDGET DU DÉPARTEMENT ────────────────────────────────────────────────────────────────
  it("DÉPENSE DE DÉPARTEMENT : ajouter → retirée ; modifier → remise ; supprimer → recréée", async () => {
    await commeSa();
    const a = await addDepartmentExpense(fd({ departmentId: dept, kind: "OPERATING", label: `${RUN} papeterie`, amount: "2500", year: "2026" }, [pdf()]));
    expect(a.ok, a.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.departmentBudgetExpense.findUnique({ where: { id: a.id! } })).toBeNull();

    const b = await addDepartmentExpense(fd({ departmentId: dept, kind: "OPERATING", label: `${RUN} toner`, amount: "4000", year: "2026" }, [pdf()]));
    expect(b.ok, b.error).toBe(true);
    const m = await updateDepartmentExpense(fd({ id: b.id!, label: `${RUN} toner couleur`, amount: "4500" }));
    expect(m.ok, m.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const relue = await prisma.departmentBudgetExpense.findUniqueOrThrow({ where: { id: b.id! } });
    expect([relue.label, Number(relue.amount)]).toEqual([`${RUN} toner`, 4000]);

    const s = await deleteDepartmentExpense(fd({ id: b.id! }));
    expect(s.ok, s.error).toBe(true);
    expect(await prisma.departmentBudgetExpense.findUnique({ where: { id: b.id! } })).toBeNull();
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect((await prisma.departmentBudgetExpense.findUniqueOrThrow({ where: { id: b.id! } })).label).toBe(`${RUN} toner`);
  });

  // ── TRÉSORERIE ET BUDGETS ────────────────────────────────────────────────────────────────
  it("IMPORTER un relevé → chaque écriture CONTRE-PASSÉE ; CORRIGER l'ancrage → remis", async () => {
    await commeSa();
    const r = await importTransactions(undefined, fd({ csv: [
      "date,direction,category,label,amount,method,account,counterparty",
      `2026-10-02,OUT,LOYER,${RUN} loyer,90000,BANK_TRANSFER,${RUN} Banque,Propriétaire`,
      `2026-10-03,IN,RECETTE,${RUN} client,15000,BANK_TRANSFER,${RUN} Banque,Client`,
    ].join("\n") }));
    expect(r.ok, r.error).toBe(true);
    const importees = await prisma.financeTransaction.findMany({ where: { label: { in: [`${RUN} loyer`, `${RUN} client`] } } });
    expect(importees.length).toBe(2);
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect(c.compte.COMPENSE).toBe(2);
    for (const t of importees) {
      const cp = await prisma.financeTransaction.findFirstOrThrow({ where: { compensationDeId: t.id } });
      expect([cp.compensation, Number(cp.amount), cp.direction]).toEqual(["CONTRE_PASSATION", -Number(t.amount), t.direction]);
    }

    const a = await corrigerAncrageTresorerie(fd({ id: compte, openingBalance: "1200000", openingDate: "2026-09-30", motif: "relevé de septembre" }));
    expect(a.ok, a.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const cpt = await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compte } });
    expect([Number(cpt.openingBalance), cpt.openingDate.toISOString().slice(0, 10)]).toEqual([1_000_000, "2026-01-01"]);
  });

  it("ATTRIBUER une écriture à une enveloppe → retirée ; CHANGER son entité → remise (l'ordre lié suit)", async () => {
    await commeSa();
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN} Fonctionnement`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000,
        categories: { create: [{ name: `${RUN} Frais`, module: "FINANCES", allocated: 1_000_000 }] } },
      include: { categories: true },
    });
    const t = await createTransaction(undefined, fd({ label: `${RUN} à classer`, amount: "8000", direction: "OUT", companyId: soc, treasuryAccountId: compte }));
    expect(t.ok, t.error).toBe(true);
    const a = await attributeTransaction(fd({ transactionId: t.id!, budgetCategoryId: env.categories[0].id }));
    expect(a.ok, a.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } })).budgetCategoryId).toBeNull();

    const s = await changerSocieteEcriture(fd({ transactionId: t.id!, companyId: soc2 }));
    expect(s.ok, s.error).toBe(true);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } })).companyId).toBe(soc2);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } })).companyId).toBe(soc);
  });

  it("ACTUALISATION DES SOLDES : répondre → l'ancrage et la ligne reviennent à « en attente »", async () => {
    await commeSa();
    const cpt = await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compte } });
    const demande = await prisma.demandeActualisationSoldes.create({
      data: { companyId: soc, demandeParId: u.pdg, lignes: { create: [{ compteId: compte, ancienSolde: cpt.openingBalance, ancienneDate: cpt.openingDate }] } },
      include: { lignes: true },
    });
    const ligne = demande.lignes[0];
    const r = await repondreActualisationSoldes(fd({ id: demande.id, lignes: JSON.stringify([{ ligneId: ligne.id, choix: "ACTUALISE", solde: 1_234_000, date: "2026-10-30" }]) }));
    expect(r.ok, r.error).toBe(true);
    expect(Number((await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compte } })).openingBalance)).toBe(1_234_000);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(Number((await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compte } })).openingBalance)).toBe(1_000_000);
    const l = await prisma.ligneActualisationSoldes.findUniqueOrThrow({ where: { id: ligne.id } });
    expect(l.etat).toBe("EN_ATTENTE");
    expect((await prisma.demandeActualisationSoldes.findUniqueOrThrow({ where: { id: demande.id } })).termineeLe).toBeNull();
  });

  it("CAMPAGNE BUDGÉTAIRE : régler le pôle → remis ; VENTES PCH : régler un fournisseur → retiré ; VUE FOURNISSEUR d'un dossier → remise", async () => {
    await commeSa();
    const camp = await prisma.budgetCampaign.create({ data: { year: YEAR, title: `${RUN} Campagne`, opensAt: new Date(), submitDeadline: new Date(Date.now() + 9e8), validationDeadline: new Date(Date.now() + 2e9), status: "OPEN" } });
    const prop = await prisma.budgetProposal.create({ data: { campaignId: camp.id, poleLabel: `${RUN} Pôle`, domaine: "GENERAL" } });
    const r = await reglerPoleCampagne(fd({ proposalId: prop.id, domaine: "MARKETING", cadrage: "500000" }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.budgetProposal.findUniqueOrThrow({ where: { id: prop.id } })).domaine).toBe("MARKETING");
    expect(bloquants(await annulerDernier())).toEqual([]);
    const relue = await prisma.budgetProposal.findUniqueOrThrow({ where: { id: prop.id } });
    expect([relue.domaine, relue.cadrage]).toEqual(["GENERAL", null]);

    const produit = await prisma.product.create({ data: { code: `${RUN}P`, canonicalName: `${RUN}P`, dci: "ZZK10A", identityKey: `${RUN}P` } });
    const f = await reglerFournisseurVentesPch(fd({ productId: produit.id, fournisseur: "Labo Test", actif: "on" }));
    expect(f.ok, f.error).toBe(true);
    const lignes = await prisma.pchFournisseurProduit.count({ where: { productId: produit.id } });
    expect(lignes).toBeGreaterThan(0);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.pchFournisseurProduit.count({ where: { productId: produit.id } })).toBe(0);

    const dossier = await prisma.regulatoryProduct.create({ data: { dci: `${RUN}dci`, reference: `${RUN}REG`, companyId: soc } });
    const v = await updateSupplierView(fd({ productId: dossier.id, externalStatus: "SUBMITTED", externalComment: "déposé", portalVisible: "on" }));
    expect(v.ok, v.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const d = await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossier.id } });
    expect([d.externalStatus, d.externalComment, d.portalVisible]).toEqual([null, null, false]);
  });

  // ── PAIE ─────────────────────────────────────────────────────────────────────────────────
  it("PAIE : créer un bulletin → retiré ; saisir « payé » → retiré ; corriger → remis ; annuler le « payé » → remis payé", async () => {
    await commeSa();
    const b = await createPayroll(undefined, fd({ employeeId: employe, gross: "100000", year: String(YEAR), month: "1" }));
    expect(b.ok, b.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.payrollEntry.count({ where: { employeeId: employe, year: YEAR, month: 1 } })).toBe(0);

    const s = await markSalaryPaid(fd({ employeeId: employe, year: String(YEAR), month: "2", employerCost: "150000", net: "90000" }));
    expect(s.ok, s.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect(await prisma.payrollEntry.count({ where: { employeeId: employe, year: YEAR, month: 2 } })).toBe(0);

    await markSalaryPaid(fd({ employeeId: employe, year: String(YEAR), month: "3", employerCost: "150000", net: "90000" }));
    const ligne = await prisma.payrollEntry.findFirstOrThrow({ where: { employeeId: employe, year: YEAR, month: 3 } });
    const m = await updatePayrollEntry(fd({ id: ligne.id, employerCost: "160000", net: "95000" }));
    expect(m.ok, m.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const corrigee = await prisma.payrollEntry.findUniqueOrThrow({ where: { id: ligne.id } });
    expect([Number(corrigee.employerCost), Number(corrigee.net)]).toEqual([150_000, 90_000]);

    const un = await unmarkSalaryPaid(fd({ id: ligne.id }));
    expect(un.ok, un.error).toBe(true);
    expect((await prisma.payrollEntry.findUniqueOrThrow({ where: { id: ligne.id } })).status).not.toBe("PAID");
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.payrollEntry.findUniqueOrThrow({ where: { id: ligne.id } })).status).toBe("PAID");
  });

  it("PAIE AU CENTRE : envoyer le virement → annuler retire le virement ET son ordre, les salaires redeviennent à couvrir", async () => {
    await commeSa();
    const saisie = await markSalaryPaid(fd({ employeeId: employe, year: String(YEAR), month: "4", employerCost: "150000", net: "90000" }));
    expect(saisie.ok, saisie.error).toBe(true);
    const e = await envoyerPaieAuCentre(fd({ companyId: soc, year: String(YEAR), month: "4", amount: "90000" }));
    expect(e.ok, e.error).toBe(true);
    const wire = await prisma.payrollWire.findFirstOrThrow({ where: { companyId: soc, year: YEAR, month: 4 }, include: { expenseOrder: true } });
    expect(wire.expenseOrder).not.toBeNull();
    const ligne = await prisma.payrollEntry.findFirstOrThrow({ where: { employeeId: employe, year: YEAR, month: 4 } });
    expect(ligne.payrollWireId).toBe(wire.id);
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    expect(await prisma.payrollWire.findUnique({ where: { id: wire.id } })).toBeNull();
    expect(await prisma.expenseOrder.findUnique({ where: { id: wire.expenseOrder!.id } })).toBeNull();
    expect((await prisma.payrollEntry.findUniqueOrThrow({ where: { id: ligne.id } })).payrollWireId).toBeNull();
  });
});

/**
 * LA DÉPENSE D'UN POSTE AD & PRO (Budget Marketing) — imputer, changer de budget, consommer : chaque geste se défait.
 * Consommer émet un ordre au centre : l'annuler le RETIRE (rien n'est parti), et le poste redevient « engagé ».
 */
suite("K10a — la dépense d'un poste Ad & Pro se défait d'un geste", () => {
  let pmId = "", envId = "", catA = "", catB = "", eventId = "", poste = "", bc = "";
  const RUN2 = `${RUN}dp`;

  const annulerDernier = async (): Promise<CompteRenduAnnulation> => {
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: pmId, origine: "ecran", annuleLe: null }, orderBy: { creeLe: "desc" } });
    const r = await annulerGeste(g.id, ACTOR!);
    if ("refus" in r) throw new Error(r.refus);
    return r;
  };
  const lire = () => prisma.adProItem.findUniqueOrThrow({ where: { id: poste } });

  beforeAll(async () => {
    pmId = (await prisma.user.create({ data: { name: `${RUN2}pm`, email: `${RUN2}pm@t.dz`, role: "PRODUCT_MANAGER", passwordHash: "x" } })).id;
    const annee = new Date().getUTCFullYear();
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${RUN2} Budget Marketing`, domaine: "MARKETING", periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59)), totalAmount: 48_000_000 },
    })).id;
    catA = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${RUN2}Sponsoring`, allocated: 20_000_000 } })).id;
    catB = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${RUN2}Événements`, allocated: 20_000_000 } })).id;
    eventId = (await prisma.event.create({ data: { name: `${RUN2}Journées` } })).id;
    await prisma.adProPorteDg.create({ data: { entityType: "EVENT", entityId: eventId, statut: "VALIDEE", montant: 18_000_000, decideLe: new Date() } });
    poste = (await prisma.adProItem.create({ data: { label: `${RUN2}Stand`, eventId, kind: "STAND", status: "APPROVED", amountGranted: 6_000_000, supplier: "Expo Events DZ" } })).id;
    bc = (await prisma.legalDocument.create({ data: { title: `${RUN2}BC`, kind: "PURCHASE_ORDER", reference: `${RUN2}BC`, amount: 4_000_000, counterparty: "Expo Events DZ", signedAt: new Date() } })).id;
    await prisma.adProItemPiece.create({ data: { itemId: poste, legalDocumentId: bc, nature: "BON_DE_COMMANDE" } });
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
  }, 60_000);

  afterAll(async () => {
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: pmId } }).catch(() => {});
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceId: eventId }, select: { id: true } }).catch(() => [])).map((o) => o.id);
    await prisma.adProItem.updateMany({ where: { id: poste }, data: { expenseOrderId: null } }).catch(() => {});
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: poste } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: bc } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: pmId }, { entityId: { in: [poste, eventId, envId] } }] } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: poste } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: pmId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: pmId } }).catch(() => {});
    ACTOR = null;
  }, 60_000);

  it("IMPUTER → remis « à imputer » ; CHANGER DE BUDGET → l'ancien revient ; CONSOMMER → l'ordre au centre est retiré, le poste redevient engagé", async () => {
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const i = await imputerDepensePoste(fd({ id: poste, categorieId: catA }));
    expect(i.ok, i.error).toBe(true);
    expect((await lire()).budgetCategoryId).toBe(catA);
    expect(bloquants(await annulerDernier())).toEqual([]);
    const remis = await lire();
    expect([remis.budgetCategoryId, remis.depenseImputeeLe]).toEqual([null, null]);

    expect((await imputerDepensePoste(fd({ id: poste, categorieId: catA }))).ok).toBe(true);
    const ch = await changerBudgetDepensePoste(fd({ id: poste, categorieId: catB }));
    expect(ch.ok, ch.error).toBe(true);
    expect((await lire()).budgetCategoryId).toBe(catB);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await lire()).budgetCategoryId).toBe(catA);

    const engage = await lire();
    const co = await consommerDepensePoste(fd({ id: poste, montant: "3500000" }));
    expect(co.ok, co.error).toBe(true);
    const consomme = await lire();
    expect(consomme.expenseOrderId).toBeTruthy();
    expect(bloquants(await annulerDernier())).toEqual([]);
    const apres = await lire();
    expect([apres.expenseOrderId, apres.orderStage]).toEqual([engage.expenseOrderId, engage.orderStage]);
    expect(await prisma.expenseOrder.findUnique({ where: { id: consomme.expenseOrderId! } })).toBeNull();
  });
});
