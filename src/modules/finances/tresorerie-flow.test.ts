import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  setTreasuryOpeningBalance, modifierCompteTresorerie, corrigerAncrageTresorerie, deleteTreasuryAccount, createTransaction,
} from "./actions-tresorerie";
import { settleExpenseOrder } from "./actions-depenses";
import { chargerTresorerie, ORDRES_AUTORISES_NON_REGLES } from "./infra/requetes/finance";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__tresoancre__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (champs: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRÉSORERIE ANCRÉE, PAR LES VRAIS POINTS D'ENTRÉE (§118.176).
 *
 * « SGA Birkhadem, compte Adventum, 2 966 153 DZD au 28 sept. 2026. Plusieurs comptes. Solde
 * trésorerie = somme des comptes − paiements autorisés » (Direction, 01/10).
 *
 * Les comptes sont GLOBAUX à la base partagée : le banc en tient toujours DEUX au moins, chacun
 * PRINCIPAL de son entité — sans quoi la marche « le compte unique » rattacherait aux siens les
 * écritures d'un banc voisin, et son nettoyage tomberait sur la clé étrangère. Et le banc tient
 * un comptable CLOISONNÉ sur son entité : une portée éprouvée avec un Super Admin ne peut pas
 * tomber (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Trésorerie ancrée — comptes, règlement, solde et disponible", () => {
  const u: Record<string, string> = {};
  let socA = "", socB = "", categorie = "";
  let sga = "", bna = "", cpa = "";
  const ordres: string[] = [];

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([mk("sa", "SUPER_ADMIN"), mk("finA", "FINANCE_BUDGET_MANAGER")]);
    socA = (await prisma.company.create({ data: { name: `${RUN} Adventum`, shortName: "A" } })).id;
    socB = (await prisma.company.create({ data: { name: `${RUN} Pharmagène`, shortName: "B" } })).id;
    // Le comptable relève d'Adventum : son entité d'appartenance le CLOISONNE (§118.104).
    await prisma.employee.create({ data: { fullName: `${RUN} Comptable A`, userId: u.finA, companyId: socA } });
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN} Fonctionnement`, modules: ["FINANCES"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 10_000_000,
        categories: { create: [{ name: `${TAG} Frais`, module: "FINANCES", allocated: 10_000_000 }] },
      },
      include: { categories: true },
    });
    categorie = env.categories[0].id;
  }, 60_000);

  afterAll(async () => {
    const comptes = (await prisma.treasuryAccount.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { OR: [{ treasuryAccountId: { in: comptes } }, { label: { startsWith: TAG } }] } }).catch(() => {});
    // Défensif : une écriture d'un banc voisin qui nommerait l'un de nos comptes ne doit pas bloquer
    // le nettoyage — elle perd son compte, rien d'autre (la règle de lecture la rattachera ailleurs).
    await prisma.financeTransaction.updateMany({ where: { treasuryAccountId: { in: comptes } }, data: { treasuryAccountId: null } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: RUN } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => {});
  }, 60_000);

  const ouvrir = (champs: Record<string, string | string[]>) => setTreasuryOpeningBalance(undefined, fd(champs));
  const compte = (id: string) => prisma.treasuryAccount.findUniqueOrThrow({ where: { id } });

  it("PRÉMISSES : le comptable a les Finances, SANS vue globale, et il est cloisonné sur Adventum", async () => {
    const finA = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    expect(userCan(finA, "FINANCES", "UPDATE")).toBe(true);
    expect(hasGlobalView(finA)).toBe(false);
  });

  it("OUVRIR : un compte naît ANCRÉ — un relevé, une date ; un nom déjà pris est refusé en nommant le geste qui corrige", async () => {
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const a = await ouvrir({
      name: `${TAG} SGA Birkhadem — A`, bank: "SGA Birkhadem", rib: "0210 0012 1130 0623 3628", openingBalance: "2966153",
      openingDate: "2026-09-28", companyId: socA, principal: ["off", "on"],
    });
    expect(a.ok, a.error).toBe(true);
    sga = a.id!;
    const b = await ouvrir({ name: `${TAG} BNA — B`, openingBalance: "1000000", openingDate: "2026-09-30", companyId: socB, principal: ["off", "on"] });
    expect(b.ok, b.error).toBe(true);
    bna = b.id!;
    expect(await compte(sga)).toMatchObject({ rib: "02100012113006233628", bank: "SGA Birkhadem", principal: true, companyId: socA });

    // L'ancien geste était un « upsert » : rouvrir réécrivait l'ouverture en silence.
    const doublon = await ouvrir({ name: `${TAG} SGA Birkhadem — A`, openingBalance: "1", openingDate: "2026-10-01" });
    expect(doublon.ok).toBe(false);
    expect(doublon.error).toMatch(/existe déjà[\s\S]*Corriger l'ancrage/);
    expect(Number((await compte(sga)).openingBalance)).toBe(2_966_153);

    // Un RIB de 19 chiffres, une date absente : refusés, chacun avec sa raison.
    expect((await ouvrir({ name: `${TAG} X`, rib: "0210001211300623362", openingBalance: "0", openingDate: "2026-09-28" })).error).toMatch(/20 chiffres — celui-ci en a 19/);
    expect((await ouvrir({ name: `${TAG} X`, openingBalance: "0" })).error).toMatch(/date du relevé/);
  });

  it("UN SEUL PRINCIPAL PAR ENTITÉ : en désigner un nouveau retire l'ancien — et la phrase le DIT", async () => {
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const c = await ouvrir({ name: `${TAG} CPA — A`, openingBalance: "500000", openingDate: "2026-09-28", companyId: socA, principal: ["off", "on"] });
    expect(c.ok, c.error).toBe(true);
    cpa = c.id!;
    expect(c.message).toMatch(new RegExp(`${TAG} SGA Birkhadem — A n'est plus le compte principal`));
    expect((await compte(sga)).principal).toBe(false);
    // Et l'on revient : SGA redevient principal, CPA ne l'est plus — dit aussi.
    const r = await modifierCompteTresorerie(fd({ id: sga, principal: ["off", "on"] }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(new RegExp(`${TAG} CPA — A n'est plus le compte principal`));
    expect([(await compte(sga)).principal, (await compte(cpa)).principal]).toEqual([true, false]);
  });

  it("MODIFIER ne touche JAMAIS l'ancrage, et un formulaire partiel n'efface rien (§118.152c)", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    // Un formulaire forgé porterait l'ancrage : il n'est pas lu ici.
    const r = await modifierCompteTresorerie(fd({ id: cpa, name: `${TAG} CPA Hydra — A`, openingBalance: "1", openingDate: "2020-01-01" }));
    expect(r.ok, r.error).toBe(true);
    const c = await compte(cpa);
    expect(c.name).toBe(`${TAG} CPA Hydra — A`);
    expect(Number(c.openingBalance)).toBe(500_000);
    expect(c.openingDate.toISOString().slice(0, 10)).toBe("2026-09-28");
    // Le RIB, absent du formulaire, reste — et un RIB saisi ensuite s'écrit.
    expect((await modifierCompteTresorerie(fd({ id: cpa, rib: "00100123456789012345" }))).ok).toBe(true);
    expect((await modifierCompteTresorerie(fd({ id: cpa, notes: "relevé mensuel" }))).ok).toBe(true);
    expect((await compte(cpa)).rib).toBe("00100123456789012345");
  });

  it("CORRIGER L'ANCRAGE exige un motif, et l'audit garde d'où l'on vient", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    const sansMotif = await corrigerAncrageTresorerie(fd({ id: cpa, openingBalance: "480000", openingDate: "2026-09-29", motif: "" }));
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.error).toMatch(/motif/);
    expect(Number((await compte(cpa)).openingBalance)).toBe(500_000);
    const ok = await corrigerAncrageTresorerie(fd({ id: cpa, openingBalance: "480000", openingDate: "2026-09-29", motif: "relevé définitif reçu" }));
    expect(ok.ok, ok.error).toBe(true);
    expect(Number((await compte(cpa)).openingBalance)).toBe(480_000);
    const trace = await prisma.auditLog.findFirstOrThrow({ where: { actorId: u.finA, field: "ancrage" }, orderBy: { createdAt: "desc" } });
    expect(trace.oldValue).toMatch(/500\s000 DZD au 28\/09\/2026/);
    expect(trace.newValue).toMatch(/480\s000 DZD au 29\/09\/2026/);
    expect(trace.summary).toMatch(/motif : relevé définitif reçu/);
  });

  it("UNE ENTITÉ HORS PÉRIMÈTRE est refusée : un compte ne s'ouvre pas au nom d'une autre société", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    const r = await ouvrir({ name: `${TAG} Intrus — B`, openingBalance: "0", openingDate: "2026-09-28", companyId: socB });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hors de votre périmètre/);
  });

  it("RÉGLER UN ORDRE fige l'entité ET le compte : le principal de l'entité, ou celui choisi « payé depuis »", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    const nouvelOrdre = async (ref: string, amount: number) => {
      const o = await prisma.expenseOrder.create({
        data: {
          reference: `${TAG}${ref}${RUN.slice(-4)}`, label: `${TAG} ${ref}`, amount, category: "AUTRE", status: "PENDING",
          centralStatus: "APPROVED", companyId: socA, budgetCategoryId: categorie, requiresInvoice: false, requestedById: u.sa,
        },
      });
      ordres.push(o.id);
      return o.id;
    };
    const o1 = await nouvelOrdre("OD1", 12_345);
    const r1 = await settleExpenseOrder(fd({ id: o1 }));
    expect(r1.ok, r1.error).toBe(true);
    const tx1 = (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o1 } })).transactionId!;
    const t1 = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: tx1 } });
    expect([t1.companyId, t1.treasuryAccountId]).toEqual([socA, sga]);

    const o2 = await nouvelOrdre("OD2", 1_000);
    const r2 = await settleExpenseOrder(fd({ id: o2, treasuryAccountId: cpa }));
    expect(r2.ok, r2.error).toBe(true);
    const tx2 = (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: o2 } })).transactionId!;
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: tx2 } })).treasuryAccountId).toBe(cpa);
  });

  it("LE SOLDE : l'ancrage plus ce qui vient APRÈS — le jour même est déjà dans le relevé ; le comptable ne voit que SES comptes", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    // Une écriture datée du jour d'ancrage : déjà dans le relevé du 28, elle ne compte pas.
    const jourMeme = await createTransaction(undefined, fd({ label: `${TAG} frais du 28`, amount: "777", direction: "OUT", date: "2026-09-28", companyId: socA }));
    expect(jourMeme.ok, jourMeme.error).toBe(true);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: jourMeme.id! } })).treasuryAccountId, "fige le principal d'Adventum").toBe(sga);

    const t = await chargerTresorerie(u.finA);
    const lu = (id: string) => t.comptes.find((c) => c.id === id);
    expect(lu(sga)).toMatchObject({ ancrage: 2_966_153, solde: 2_966_153 - 12_345, nombreMouvements: 1 });
    expect(lu(cpa)).toMatchObject({ ancrage: 480_000, solde: 479_000 });
    // Pharmagène n'est pas son entité : le compte BNA n'est ni montré, ni compté dans son total.
    expect(lu(bna)).toBeUndefined();
    expect(t.comptes.some((c) => c.id === sga) && t.comptes.some((c) => c.id === cpa)).toBe(true);
    // Le Super Admin, lui, voit les trois.
    const tSa = await chargerTresorerie(u.sa);
    expect([sga, bna, cpa].every((id) => tSa.comptes.some((c) => c.id === id))).toBe(true);
  });

  it("LES CASES D'ENTITÉS : choisir une entité ne montre, ne compte et ne somme que SES comptes — « toutes » les montre tous", async () => {
    const tous = await chargerTresorerie(u.sa);
    const deA = await chargerTresorerie(u.sa, socA);
    const deB = await chargerTresorerie(u.sa, socB);
    expect(deA.comptes.map((c) => c.id).sort()).toEqual([sga, cpa].sort());
    expect(deB.comptes.map((c) => c.id)).toEqual([bna]);
    // Le total suit les comptes montrés — jamais le total du groupe sous la case d'une entité.
    expect(deA.total).toBeCloseTo(deA.comptes.reduce((t, c) => t + c.solde, 0), 2);
    expect(deB.total).toBeCloseTo(tous.comptes.find((c) => c.id === bna)!.solde, 2);
  });

  it("LES PAIEMENTS AUTORISÉS : le prédicat du verrou — en attente, refusé ou déjà réglé n'y sont pas ; reporté, si", async () => {
    const mien = async (ref: string, amount: number, status: "PENDING" | "PAID", centralStatus: string, deferredUntil?: Date) => {
      const o = await prisma.expenseOrder.create({
        data: {
          reference: `${TAG}${ref}${RUN.slice(-4)}`, label: `${TAG} ${ref}`, amount, category: "AUTRE", status,
          centralStatus, companyId: socA, requestedById: u.sa, ...(deferredUntil ? { deferredUntil, deferredReason: "fin de mois" } : {}),
        },
      });
      ordres.push(o.id);
    };
    await mien("AUT", 400_000.37, "PENDING", "APPROVED");
    await mien("REP", 100, "PENDING", "APPROVED", new Date("2026-12-01"));
    await mien("HIST", 1.5, "PENDING", "NOT_REQUIRED");
    await mien("ATT", 9_999, "PENDING", "AWAITING");
    await mien("REF", 8_888, "PENDING", "REFUSED");
    await mien("PAYE", 7_777, "PAID", "APPROVED");
    const r = await prisma.expenseOrder.aggregate({
      where: { AND: [ORDRES_AUTORISES_NON_REGLES, { id: { in: ordres } }] },
      _sum: { amount: true }, _count: { _all: true },
    });
    expect(Number(r._sum.amount)).toBeCloseTo(400_101.87, 2);
    expect(r._count._all).toBe(3);
  });

  it("LE DISPONIBLE se calcule avec CE prédicat — et c'est son point d'appel qu'on vérifie (§118.49)", () => {
    const src = readFileSync("src/modules/finances/infra/requetes/finance.ts", "utf8");
    const corps = src.slice(src.indexOf("export async function chargerTresorerie("));
    expect(corps).toMatch(/expenseOrder\.aggregate\(\{\s*where: await companyScopedWhere\(userId, entiteId \? \{ \.\.\.ORDRES_AUTORISES_NON_REGLES, companyId: entiteId \} : ORDRES_AUTORISES_NON_REGLES\)/);
    expect(corps).toMatch(/disponible: disponible\(total, montantAutorise\)/);
  });

  it("SUPPRIMER un compte que des écritures nomment est REFUSÉ — l'ancien geste avalait l'erreur et disait « fait »", async () => {
    ACTOR = await acteur(u.finA, "FINANCE_BUDGET_MANAGER");
    const refus = await deleteTreasuryAccount(fd({ id: cpa }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/écriture\(s\) nomment le compte/);
    expect(await prisma.treasuryAccount.count({ where: { id: cpa } })).toBe(1);
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const vide = await ouvrir({ name: `${TAG} Vide`, openingBalance: "0", openingDate: "2026-09-28", companyId: socA });
    expect(vide.ok, vide.error).toBe(true);
    const ok = await deleteTreasuryAccount(fd({ id: vide.id! }));
    expect(ok.ok, ok.error).toBe(true);
    expect(await prisma.treasuryAccount.count({ where: { id: vide.id! } })).toBe(0);
  });
});
