import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));
/**
 * LE SERVICE DES MOYENS GÉNÉRAUX EST UN RÉGLAGE GLOBAL (§118.132) : le banc l'injecte dans son processus, la base
 * partagée garde son réglage.
 */
let SERVICE: string | null = null;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), generalMeansDepartmentId: SERVICE }) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { allotPettyCash, confirmPettyCashReceipt, decidePettyCashTopUp, spendFromPettyCash } from "./petty-cash-actions";
import { decidePayment } from "@/modules/finances/actions-centre";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { getGeneralMeans } from "@/lib/queries/general-means";
import { libelleRemise } from "@/lib/general-means/remise-centre";

/** LE BON DE REMISE, justificatif de la remise (24/11/2026) — sans lui, elle n'entrerait pas au centre de paiement. */
const avecBon = (f: FormData): FormData => {
  f.set("bonDeRemise", new File([`bon ${Math.random()}`], "bon-de-remise.pdf", { type: "application/pdf" }));
  return f;
};

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__caisseconf__${Date.now().toString(36)}`;
const YEAR = 2026;

const fd = (champs: Record<string, string>, fichiers: File[] = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  for (const x of fichiers) f.append("files", x);
  return f;
};
const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, Math.floor(Math.random() * 250)])], "ticket.pdf", { type: "application/pdf" });
/** Les effets que l'annulation n'a pas pu défaire — hors la notification poussée déjà partie. */
const bloquants = (c: CompteRenduAnnulation) => c.details.filter((d) => d.issue === "IMPOSSIBLE" && !/^notification poussée/.test(d.quoi)).map((d) => `${d.quoi} : ${d.pourquoi}`);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAISSE D'AVANCE NE COMPTE UNE REMISE QU'À LA CONFIRMATION DU CAISSIER (Super Admin, 24/11/2026).
 *
 * « Quand on remet une somme : c'est envoyé au centre de paiement ; s'il refuse, ça affiche Refusé ; s'il accepte, ça va
 * aux Finances ; les Finances mettent payé ou non payé ; quand les Finances marquent payé, ET que le caissier confirme la
 * réception, c'est à ce moment-là que la somme compte dans la caisse. »
 *
 * Par les vraies actions, de bout en bout : remise → refus (Refusé visible, avec le motif) → nouvelle remise → accord (pas
 * de crédit) → Finances « payé » (pas encore de crédit : à confirmer) → « non payé » avant confirmation (de nouveau à
 * payer) → payé → confirmation (crédit exact) → dépense → « non payé » APRÈS confirmation (la somme sort de la caisse,
 * la dépense reste) → payé de nouveau (à reconfirmer). Et la seule caisse qui reçoit : celle du service désigné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Caisse d'avance — payée par les Finances, comptée à la confirmation du caissier", () => {
  const u: Record<string, string> = {};
  let soc = "", compte = "", dMg = "", dAutre = "";

  const vue = async () => (await getGeneralMeans(await acteur(u.caissier, "DIRECTION_ASSISTANT"), dMg, YEAR))!;
  const remiseDe = async (amount: number) => prisma.pettyCashAllotment.findFirstOrThrow({ where: { departmentId: dMg, amount }, orderBy: { createdAt: "desc" } });
  const remettre = async (amount: string) => {
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    return allotPettyCash(avecBon(fd({ departmentId: dMg, holderId: u.caissier, amount })));
  };
  const centre = async (orderId: string, decision: "APPROVE" | "REFUSE", body = "") => {
    ACTOR = await acteur(u.pdg, "DIRECTION");
    return decidePayment(fd({ id: orderId, decision, body }));
  };
  const payer = async (orderId: string) => {
    ACTOR = await acteur(u.fin, "FINANCE_BUDGET_MANAGER");
    return settleExpenseOrder(fd({ id: orderId, treasuryAccountId: compte }));
  };
  const confirmer = async (id: string) => {
    ACTOR = await acteur(u.caissier, "DIRECTION_ASSISTANT");
    return confirmPettyCashReceipt(fd({ id }));
  };
  /** « Non payé » : la barre d'annulation des Finances sur leur dernier règlement. */
  const nonPaye = async () => {
    const fin = await acteur(u.fin, "FINANCE_BUDGET_MANAGER");
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({
      where: { principalId: u.fin, capaciteId: "expense-actions:settleExpenseOrder", annuleLe: null }, orderBy: { creeLe: "desc" },
    });
    const c = await annulerGeste(g.id, fin);
    if ("refus" in c) throw new Error(c.refus);
    return c;
  };

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    // TROIS MAINS pour l'argent (séparation des tâches) : l'administration remet, le PDG autorise, les Finances paient.
    await Promise.all([mk("sa", "SUPER_ADMIN"), mk("pdg", "DIRECTION"), mk("fin", "FINANCE_BUDGET_MANAGER"), mk("caissier", "DIRECTION_ASSISTANT")]);
    soc = (await prisma.company.create({ data: { name: `${TAG} Adventum`, shortName: `${TAG}A` } })).id;
    compte = (await prisma.treasuryAccount.create({ data: { name: `${TAG} Banque`, openingBalance: 1_000_000, openingDate: new Date("2026-01-01"), companyId: soc, principal: true } })).id;
    dMg = (await prisma.department.create({ data: { name: `${TAG} Moyens généraux`, code: `${TAG}MG`, companyId: soc } })).id;
    dAutre = (await prisma.department.create({ data: { name: `${TAG} Regulatory`, code: `${TAG}RG`, companyId: soc } })).id;
    SERVICE = dMg;
    await prisma.userAccess.create({ data: { userId: u.caissier, module: "GENERAL_MEANS", canView: true, canCreate: true, canUpdate: true, scope: "ALL" } });
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: ids } } }).catch(() => {});
    const depts = [dMg, dAutre];
    const depenses = (await prisma.departmentBudgetExpense.findMany({ where: { departmentId: { in: depts } }, select: { id: true } }).catch(() => [])).map((e) => e.id);
    await retirerDocumentsEtContenu({ where: { entityId: { in: depenses } } }).catch(() => {});
    await prisma.departmentExpenseLine.deleteMany({ where: { expenseId: { in: depenses } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { departmentId: { in: depts } } }).catch(() => {});
    const remises = await prisma.pettyCashAllotment.findMany({ where: { departmentId: { in: depts } }, select: { expenseOrderId: true } }).catch(() => []);
    await prisma.pettyCashTopUpRequest.deleteMany({ where: { allotment: { departmentId: { in: depts } } } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { departmentId: { in: depts } } }).catch(() => {});
    const ordres = [...remises.map((r) => r.expenseOrderId).filter((x): x is string => Boolean(x)),
      ...(await prisma.expenseOrder.findMany({ where: { companyId: soc }, select: { id: true } }).catch(() => [])).map((o) => o.id)];
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.updateMany({ where: { companyId: soc }, data: { compensationDeId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { companyId: soc } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { id: compte } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: { in: depts } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: soc } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
    SERVICE = null;
    ACTOR = null;
  }, 60_000);

  it("1. REFUSÉE PAR LE CENTRE : « Refusé » et son motif sont portés par la caisse — jusqu'à la remise suivante", async () => {
    expect((await remettre("10000")).ok).toBe(true);
    const a = await remiseDe(10_000);
    expect((await centre(a.expenseOrderId!, "REFUSE", "Caisse encore suffisante")).ok).toBe(true);
    const v = await vue();
    expect(v.refusee?.id).toBe(a.id);
    expect(v.refusee?.motif).toBe("Caisse encore suffisante");
    expect(libelleRemise(v.refusee!.centre, v.refusee!.status).label).toBe("Refusé");
    expect(v.cash, "rien d'autre n'est en cours : la caisse est vide, mais le refus reste dit").toBeNull();
  });

  it("2. NOUVELLE REMISE, AUTORISÉE : elle passe aux Finances — la caisse n'est PAS créditée", async () => {
    expect((await remettre("20000")).ok).toBe(true);
    const b = await remiseDe(20_000);
    expect((await vue()).refusee, "une nouvelle remise faite, le refus précédent quitte le bandeau").toBeNull();
    const r = await centre(b.expenseOrderId!, "APPROVE");
    expect(r.ok, r.error).toBe(true);
    const relue = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id }, include: { expenseOrder: true } });
    expect([relue.status, relue.transactionId, relue.expenseOrder?.status, relue.expenseOrder?.centralStatus]).toEqual(["ALLOTTED", null, "PENDING", "APPROVED"]);
    const v = await vue();
    const ligne = v.cash!.remittances.find((x) => x.id === b.id)!;
    expect(libelleRemise(ligne.centre, ligne.status).label).toBe("Autorisée — à payer par les Finances");
    expect([v.cash!.fund.received, v.cash!.fund.remaining]).toEqual([0, 0]);
  });

  it("3. FINANCES « PAYÉ » : l'écriture sort de la banque, la remise est « à confirmer par le caissier » — toujours pas dans la caisse", async () => {
    const b = await remiseDe(20_000);
    const r = await payer(b.expenseOrderId!);
    expect(r.ok, r.error).toBe(true);
    const relue = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id }, include: { expenseOrder: true } });
    expect([relue.status, relue.expenseOrder?.status]).toEqual(["ALLOTTED", "PAID"]);
    expect(relue.transactionId).toBeTruthy();
    const v = await vue();
    const ligne = v.cash!.remittances.find((x) => x.id === b.id)!;
    expect(libelleRemise(ligne.centre, ligne.status).label).toBe("Versée — à confirmer par le caissier");
    expect([v.cash!.fund.received, v.cash!.fund.remaining, v.cash!.fund.awaitingAmount]).toEqual([0, 0, 20_000]);
    expect(await prisma.notification.count({ where: { userId: u.caissier, title: "Caisse d'avance payée — confirmez la réception" } })).toBe(1);
  });

  it("4. « NON PAYÉ » AVANT CONFIRMATION : la remise redevient « à payer par les Finances », le décaissement est compensé, rien n'est à confirmer", async () => {
    const b = await remiseDe(20_000);
    const tx = b.transactionId!;
    expect(bloquants(await nonPaye())).toEqual([]);
    const relue = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id }, include: { expenseOrder: true } });
    expect([relue.status, relue.transactionId, relue.expenseOrder?.status]).toEqual(["ALLOTTED", null, "PENDING"]);
    const ar = await prisma.financeTransaction.findFirstOrThrow({ where: { compensationDeId: tx } });
    expect([ar.compensation, Number(ar.amount)]).toEqual(["A_RECUPERER", 20_000]);
    const ligne = (await vue()).cash!.remittances.find((x) => x.id === b.id)!;
    expect(libelleRemise(ligne.centre, ligne.status).label).toBe("Autorisée — à payer par les Finances");
    const c = await confirmer(b.id);
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/les Finances doivent encore la payer/);
  });

  it("5. PAYÉE DE NOUVEAU, PUIS CONFIRMÉE PAR LE CAISSIER : la somme compte, exactement", async () => {
    const b = await remiseDe(20_000);
    expect((await payer(b.expenseOrderId!)).ok).toBe(true);
    expect([(await vue()).cash!.fund.received]).toEqual([0]);
    // Un autre que le caissier (ici, les Finances qui viennent de payer) ne confirme pas à sa place.
    ACTOR = await acteur(u.fin, "FINANCE_BUDGET_MANAGER");
    const autrui = await confirmPettyCashReceipt(fd({ id: b.id }));
    expect(autrui.ok).toBe(false);
    const c = await confirmer(b.id);
    expect(c.ok, c.error).toBe(true);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("RECEIVED");
    const v = await vue();
    expect([v.cash!.fund.received, v.cash!.fund.remaining, v.cash!.fund.awaitingAmount]).toEqual([20_000, 20_000, 0]);
  });

  it("6. « NON PAYÉ » APRÈS CONFIRMATION : la somme SORT de la caisse, la dépense déjà faite reste comptée ; payée de nouveau, elle se reconfirme", async () => {
    const b = await remiseDe(20_000);
    ACTOR = await acteur(u.caissier, "DIRECTION_ASSISTANT");
    const dep = await spendFromPettyCash(fd({ cashId: b.id, label: `${TAG} fournitures`, amount: "5000", year: String(YEAR) }, [pdf()]));
    expect(dep.ok, dep.error).toBe(true);
    expect((await vue()).cash!.fund.remaining).toBe(15_000);

    expect(bloquants(await nonPaye())).toEqual([]);
    const relue = await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id }, include: { expenseOrder: true } });
    expect(relue.expenseOrder?.status).toBe("PENDING");
    const v = await vue();
    const ligne = v.cash!.remittances.find((x) => x.id === b.id)!;
    expect(ligne.centre).toBe("A_VERSER");
    // Plus en main : la somme est sortie ; la dépense de 5 000, elle, est sortie du tiroir quoi qu'il arrive.
    expect([v.cash!.fund.received, v.cash!.fund.spent, v.cash!.fund.remaining]).toEqual([0, 5_000, -5_000]);

    // PAYÉE DE NOUVEAU : l'argent qui vient de partir n'est pas celui reçu la première fois — à reconfirmer.
    expect((await payer(b.expenseOrderId!)).ok).toBe(true);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("ALLOTTED");
    expect((await vue()).cash!.fund.received).toBe(0);
    expect((await confirmer(b.id)).ok).toBe(true);
    expect((await vue()).cash!.fund.remaining).toBe(15_000);
  });

  it("7. LA SEULE CAISSE QUI REÇOIT EST CELLE DU SERVICE : une remise, une rallonge accordée vers un autre département sont refusées ; sans service désigné, aucune", async () => {
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const autre = await allotPettyCash(avecBon(fd({ departmentId: dAutre, holderId: u.caissier, amount: "7000" })));
    expect(autre.ok).toBe(false);
    expect(autre.error).toMatch(/celle des moyens généraux \(« .* Moyens généraux »\)/);
    expect(await prisma.pettyCashAllotment.count({ where: { departmentId: dAutre } })).toBe(0);

    // UNE ANCIENNE CAISSE d'un autre département reste en base, intacte — mais ne reçoit plus de rallonge.
    const vieille = await prisma.pettyCashAllotment.create({ data: { departmentId: dAutre, period: "2026-01", amount: 4_000, holderId: u.caissier, status: "RECEIVED" } });
    const [oui, non] = await Promise.all([
      prisma.pettyCashTopUpRequest.create({ data: { allotmentId: vieille.id, amountRequested: 3_000, requestedById: u.caissier } }),
      prisma.pettyCashTopUpRequest.create({ data: { allotmentId: vieille.id, amountRequested: 2_000, requestedById: u.caissier } }),
    ]);
    const accord = await decidePettyCashTopUp(fd({ id: oui.id, decision: "APPROVED", amountGranted: "3000" }));
    expect(accord.ok).toBe(false);
    expect(accord.error).toMatch(/celle des moyens généraux/);
    expect((await prisma.pettyCashTopUpRequest.findUniqueOrThrow({ where: { id: oui.id } })).status).toBe("PENDING");
    // Refuser une vieille demande ne crée rien : c'est permis.
    expect((await decidePettyCashTopUp(fd({ id: non.id, decision: "REJECTED" }))).ok).toBe(true);
    expect(await prisma.pettyCashAllotment.count({ where: { departmentId: dAutre } })).toBe(1);

    SERVICE = null;
    const sans = await allotPettyCash(avecBon(fd({ departmentId: dMg, holderId: u.caissier, amount: "7000" })));
    SERVICE = dMg;
    expect(sans.ok).toBe(false);
    expect(sans.error).toMatch(/Aucun service des moyens généraux n'est désigné.*Administration › Réglages/);
  });
});
