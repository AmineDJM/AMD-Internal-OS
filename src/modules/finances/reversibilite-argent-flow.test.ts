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
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retablirGeste } from "@/lib/effets/retablissement";
import { gestesRecents } from "@/lib/effets/ecran";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import {
  createQuickIncome, createTransaction, deleteTransaction, deleteTreasuryAccount, modifierCompteTresorerie,
  setTreasuryOpeningBalance, updateTransaction, updateTransactionStatus,
} from "./actions-tresorerie";
import { deferExpenseOrder, resumeExpenseOrder, settleExpenseOrder } from "./actions-depenses";
import { createSupplier, createSupplierUser, toggleSupplier, toggleSupplierUser } from "@/lib/actions/supplier-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__k10a__";
const RUN = `${TAG}${Date.now().toString(36)}`;

/** Les effets que l'annulation n'a pas pu défaire — hors la notification poussée déjà partie (effet sortant, K10b). */
const bloquants = (c: CompteRenduAnnulation) => c.details.filter((d) => d.issue === "IMPOSSIBLE" && !/^notification poussée/.test(d.quoi)).map((d) => `${d.quoi} : ${d.pourquoi}`);

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARGENT RÉVERSIBLE, PAR LES VRAIS POINTS D'ENTRÉE (lot K10a, décision 0041).
 *
 * Chaque cas EXÉCUTE l'action de l'écran (session d'une vraie personne, base locale), relit le geste que le journal
 * des effets a gardé, l'ANNULE par l'annulation J7, et vérifie l'état : données, solde, journal, audit. L'argent ne
 * s'efface jamais — il se contre-passe ou devient « à récupérer » — et l'annulation se défait (rétablir).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("K10a — les actions d'argent se défont d'un geste", () => {
  const u: Record<string, string> = {};
  let soc = "", compte = "", categorie = "";

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
  const soldeDuCompte = async () => {
    const t = await prisma.financeTransaction.findMany({ where: { treasuryAccountId: compte, status: "SETTLED" }, select: { amount: true, direction: true } });
    return t.reduce((s, x) => s + (x.direction === "IN" ? 1 : -1) * Number(x.amount), 0);
  };

  beforeAll(async () => {
    const access = await getAccess("x", "SUPER_ADMIN" as SessionUser["role"]);
    const sa = await prisma.user.create({ data: { name: `${RUN} sa`, email: `${RUN}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    u.sa = sa.id;
    u.dem = (await prisma.user.create({ data: { name: `${RUN} demandeur`, email: `${RUN}dem@t.dz`, role: "VIEWER", passwordHash: "x" } })).id;
    ACTOR = { id: sa.id, name: sa.name, email: sa.email, role: "SUPER_ADMIN", access, mustChangePassword: false };
    soc = (await prisma.company.create({ data: { name: `${RUN} Adventum`, shortName: "K" } })).id;
    // Un ordre réglé s'impute sur un budget : le banc tient sa ligne (comme `tresorerie-flow.test.ts`).
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN} Fonctionnement`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2027-12-31"), totalAmount: 10_000_000,
        categories: { create: [{ name: `${TAG} Frais`, module: "FINANCES", allocated: 10_000_000 }] },
      },
      include: { categories: true },
    });
    categorie = env.categories[0]!.id;
    compte = (await prisma.treasuryAccount.create({ data: { name: `${RUN} Banque`, openingBalance: 1_000_000, companyId: soc, principal: true } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.updateMany({ where: { treasuryAccountId: compte }, data: { compensationDeId: null } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { treasuryAccountId: compte } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.supplierUser.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: Object.values(u) } } }).catch(() => {});
  }, 60_000);

  it("SAISIR une écriture réalisée → annuler la CONTRE-PASSE (le solde revient, les deux lignes restent) → rétablir la contre-passe à son tour", async () => {
    const avant = await soldeDuCompte();
    const r = await createTransaction(undefined, fd({ label: `${TAG} loyer`, amount: "50000", category: "AUTRE", direction: "OUT", companyId: soc, treasuryAccountId: compte }));
    expect(r.ok, r.error).toBe(true);
    expect(await soldeDuCompte()).toBe(avant - 50_000);
    // La barre « Annuler » (K10b) le propose : le geste porte son action et sa phrase.
    const g0 = await dernierGeste();
    expect([g0.capaciteId, g0.libelle, g0.origine]).toEqual(["finance-actions:createTransaction", "Saisir une écriture de trésorerie", "ecran"]);
    expect((await gestesRecents(ACTOR!)).map((x) => x.id)).toContain(g0.id);

    const compteRendu = await annulerDernier();
    expect(compteRendu.compte.COMPENSE).toBe(1);
    expect(compteRendu.complet).toBe(true);
    const origine = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: r.id! } });
    const cp = await prisma.financeTransaction.findFirstOrThrow({ where: { compensationDeId: r.id! } });
    expect([origine.status, cp.compensation, Number(cp.amount), cp.direction, cp.treasuryAccountId]).toEqual(["SETTLED", "CONTRE_PASSATION", -50_000, "OUT", compte]);
    expect(await soldeDuCompte()).toBe(avant);
    // L'audit garde l'annulation ; le journal garde le geste annulé, avec son compte rendu.
    const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { id: compteRendu.gesteId } });
    expect(g.annuleLe).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { actorId: u.sa, module: "ASSISTANT_IA", entityId: compteRendu.gesteId } })).toBe(1);

    // RÉTABLIR = annuler l'annulation : la contre-passation est contre-passée, le solde redescend.
    const retabli = await retablirGeste(compteRendu.gesteId, ACTOR!);
    expect("refus" in retabli ? retabli.refus : retabli.compte.ANNULE).toBe(1);
    expect(await soldeDuCompte()).toBe(avant - 50_000);
  });

  it("une écriture PRÉVUE n'a pas touché au solde : annuler la passe à « annulée » (la trace reste)", async () => {
    const r = await createTransaction(undefined, fd({ label: `${TAG} prévue`, amount: "7000", direction: "OUT", status: "PENDING", companyId: soc, treasuryAccountId: compte }));
    expect(r.ok, r.error).toBe(true);
    const c = await annulerDernier();
    expect(c.compte.COMPENSE).toBe(1);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: r.id! } })).status).toBe("CANCELLED");
  });

  it("ENCAISSEMENT rapide → contre-passé ; MODIFIER puis CHANGER LE STATUT d'une écriture → valeurs d'avant remises", async () => {
    const avant = await soldeDuCompte();
    const enc = await createQuickIncome(undefined, fd({ label: `${TAG} client`, amount: "12000", companyId: soc, treasuryAccountId: compte }));
    expect(enc.ok, enc.error).toBe(true);
    expect((await annulerDernier()).compte.COMPENSE).toBe(1);
    expect(await soldeDuCompte()).toBe(avant);

    const t = await createTransaction(undefined, fd({ label: `${TAG} à corriger`, amount: "3000", direction: "OUT", companyId: soc, treasuryAccountId: compte }));
    const m = await updateTransaction(fd({ id: t.id!, label: `${TAG} corrigée`, amount: "3500", direction: "OUT", category: "AUTRE" }));
    expect(m.ok, m.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    const relue = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } });
    expect([relue.label, Number(relue.amount)]).toEqual([`${TAG} à corriger`, 3000]);

    const s = await updateTransactionStatus(fd({ id: t.id!, status: "PENDING" }));
    expect(s.ok, s.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } })).status).toBe("SETTLED");
  });

  it("SUPPRIMER une écriture → annuler la RECRÉE à l'identique, même identifiant (le solde revient)", async () => {
    const t = await createTransaction(undefined, fd({ label: `${TAG} supprimée`, amount: "900", direction: "OUT", companyId: soc, treasuryAccountId: compte }));
    const avant = await soldeDuCompte();
    const d = await deleteTransaction(fd({ id: t.id! }));
    expect(d.ok, d.error).toBe(true);
    expect(await prisma.financeTransaction.findUnique({ where: { id: t.id! } })).toBeNull();
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: t.id! } })).label).toBe(`${TAG} supprimée`);
    expect(await soldeDuCompte()).toBe(avant);
  });

  it("RÉGLER un ordre (l'argent part) → annuler : l'ordre redevient dû, le décaissement RESTE, un « à récupérer » le compense ; rétablir remet « payé »", async () => {
    const o = await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD${RUN.slice(-5)}`, label: `${TAG} fournisseur`, amount: 20_000, category: "AUTRE", status: "PENDING", centralStatus: "APPROVED", companyId: soc, budgetCategoryId: categorie, requestedById: u.dem },
    });
    const avant = await soldeDuCompte();
    const r = await settleExpenseOrder(fd({ id: o.id, treasuryAccountId: compte }));
    expect(r.ok, r.error).toBe(true);
    const regle = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(regle.status).toBe("PAID");
    expect(await soldeDuCompte()).toBe(avant - 20_000);

    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    const rouvert = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect([rouvert.status, rouvert.transactionId, rouvert.paidDate]).toEqual(["PENDING", null, null]);
    const tx = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: regle.transactionId! } });
    expect(tx.status).toBe("SETTLED"); // le décaissement n'est pas effacé
    const ar = await prisma.financeTransaction.findFirstOrThrow({ where: { compensationDeId: tx.id } });
    expect([ar.compensation, ar.direction, ar.status, Number(ar.amount)]).toEqual(["A_RECUPERER", "IN", "PENDING", 20_000]);
    expect(await soldeDuCompte()).toBe(avant - 20_000);

    const retabli = await retablirGeste(c.gesteId, ACTOR!);
    expect("refus" in retabli ? retabli.refus : bloquants(retabli)).toEqual([]);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: ar.id } })).status).toBe("CANCELLED");
  });

  it("REPORTER puis LEVER LE REPORT d'un ordre → chaque geste se remet", async () => {
    const o = await prisma.expenseOrder.create({
      data: { reference: `${TAG}OR${RUN.slice(-5)}`, label: `${TAG} report`, amount: 1_000, category: "AUTRE", status: "PENDING", centralStatus: "APPROVED", companyId: soc, budgetCategoryId: categorie, requestedById: u.dem },
    });
    const d = await deferExpenseOrder(fd({ id: o.id, until: "2027-03-01", reason: "trésorerie tendue" }));
    expect(d.ok, d.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } })).deferredUntil).not.toBeNull();
    const c = await annulerDernier();
    expect(bloquants(c)).toEqual([]);
    // La poussée attendait sa FENÊTRE D'ANNULATION (K10b) : annulée dans la fenêtre, elle n'est jamais partie.
    expect(c.details.find((d) => /^notification poussée/.test(d.quoi))?.issue).toBe("ANNULE");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } })).deferredUntil).toBeNull();
    await deferExpenseOrder(fd({ id: o.id, until: "2027-03-01", reason: "trésorerie tendue" }));
    const l = await resumeExpenseOrder(fd({ id: o.id }));
    expect(l.ok, l.error).toBe(true);
    expect(bloquants(await annulerDernier())).toEqual([]);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o.id } })).deferredUntil).not.toBeNull();
  });

  it("COMPTE DE TRÉSORERIE : modifier → remis ; ouvrir puis supprimer → recréé ; fixer l'ancrage → remis", async () => {
    const m = await modifierCompteTresorerie(fd({ id: compte, name: `${RUN} Banque renommée`, bank: "BNA" }));
    expect(m.ok, m.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect((await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compte } })).name).toBe(`${RUN} Banque`);

    const o = await setTreasuryOpeningBalance(undefined, fd({ name: `${RUN} Caisse`, openingBalance: "5000", openingDate: "2026-10-01", companyId: soc }));
    expect(o.ok, o.error).toBe(true);
    const caisse = await prisma.treasuryAccount.findFirstOrThrow({ where: { name: `${RUN} Caisse` } });
    const s = await deleteTreasuryAccount(fd({ id: caisse.id }));
    expect(s.ok, s.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect(Number((await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: caisse.id } })).openingBalance)).toBe(5000);
  });

  it("FOURNISSEURS : créer → retiré ; activer/désactiver → remis ; créer un accès → retiré", async () => {
    const c = await createSupplier(undefined, fd({ name: `${RUN} Labo` }));
    expect(c.ok, c.error).toBe(true);
    const t = await toggleSupplier(fd({ id: c.id! }));
    expect(t.ok, t.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: c.id! } })).active).toBe(true);

    const a = await createSupplierUser(undefined, fd({ supplierId: c.id!, email: `${RUN}portail@t.dz`, name: "Portail", password: "Motdepasse-k10a-1" }));
    expect(a.ok, a.error).toBe(true);
    const ta = await toggleSupplierUser(fd({ id: a.id! }));
    expect(ta.ok, ta.error).toBe(true);
    expect((await annulerDernier()).compte.ANNULE).toBe(1);
    expect((await annulerDernier()).compte.ANNULE).toBeGreaterThanOrEqual(1); // l'accès créé : retiré
    expect(await prisma.supplierUser.findUnique({ where: { id: a.id! } })).toBeNull();
  });
});
