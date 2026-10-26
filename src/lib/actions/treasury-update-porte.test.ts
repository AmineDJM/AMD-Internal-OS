import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestTreasuryUpdate } from "./finance-actions";
import { repondreActualisationSoldes } from "./actualisation-soldes-actions";
import { jourAlger } from "@/lib/finance/tresorerie";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__porteTresorerie__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * « DEMANDER L'ACTUALISATION DES SOLDES » — LE SUPER ADMIN DEMANDE, LES FINANCES RÉPONDENT DEPUIS LA
 * NOTIFICATION, LE SUPER ADMIN EST PRÉVENU EN RETOUR (Direction, 10/2026).
 *
 * ── POURQUOI LA PORTE RESTE AU SEUL SUPER ADMIN ─────────────────────────────────────────────
 *
 * Le geste SONNE chez les responsables Finance pour qu'ils mettent la trésorerie à jour. Ouvert à
 * toute la direction, il devient une sonnerie fréquente — et une sonnerie fréquente finit par n'être
 * plus écoutée, y compris le jour où le solde est vraiment douteux.
 *
 * ── CE QUE LE BANC TIENT, PAR LES VRAIES PORTES ─────────────────────────────────────────────
 *
 * La demande porte sur UNE entité, avec une ligne par compte ; la notification du responsable Finance
 * ouvre l'écran de réponse ; un second clic relance la même demande ; la réponse réancre le compte,
 * accepte « pas encore reçu » (la demande reste ouverte) et prévient le Super Admin ; un compte
 * actualisé ne se réécrit pas.
 */
suite("Actualisation des soldes : le Super Admin demande, les Finances répondent", () => {
  let adminId = "";
  let dgId = "";
  let deleId = "";
  let financeId = "";
  let companyId = "";
  let compteA = "";
  let compteB = "";
  let demandeId = "";

  beforeAll(async () => {
    const company = await prisma.company.create({ data: { name: `${TAG} Société`, shortName: `${TAG}S` }, select: { id: true } });
    companyId = company.id;
    const [a, d, m, f] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} dg`, email: `${TAG}d@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} delegue`, email: `${TAG}m@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} finance`, email: `${TAG}f@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" }, select: { id: true } }),
    ]);
    adminId = a.id; dgId = d.id; deleId = m.id; financeId = f.id;
    // Le responsable Finance VOIT la société — sans quoi il ne serait pas prévenu.
    await prisma.userCompanyAccess.create({ data: { userId: financeId, companyId, canEdit: true } });
    const ancrage = new Date("2026-09-28T00:00:00.000Z");
    const [ca, cb] = await Promise.all([
      prisma.treasuryAccount.create({ data: { name: `${TAG} Banque A`, openingBalance: 1000, openingDate: ancrage, companyId }, select: { id: true } }),
      prisma.treasuryAccount.create({ data: { name: `${TAG} Banque B`, openingBalance: 500, openingDate: ancrage, companyId }, select: { id: true } }),
    ]);
    compteA = ca.id; compteB = cb.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.demandeActualisationSoldes.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [adminId, dgId, deleId, financeId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, dgId, deleId, financeId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  it("LE DIRECTEUR GÉNÉRAL NE DEMANDE PAS — une vision globale ne suffit pas", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const fd = new FormData();
    fd.set("entite", companyId);
    const r = await requestTreasuryUpdate(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Super Admin/);
  });

  it("et un délégué encore moins", async () => {
    ACTOR = await actorFor(deleId, "MEDICAL_DELEGATE");
    expect((await requestTreasuryUpdate(new FormData())).ok).toBe(false);
  });

  it("LE SUPER ADMIN DEMANDE pour UNE entité : une ligne par compte, et le responsable Finance reçoit l'écran de réponse", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData();
    fd.set("entite", companyId);
    fd.set("note", "Avant le conseil de lundi");
    const r = await requestTreasuryUpdate(fd);
    expect(r.ok, r.error).toBe(true);
    demandeId = r.id!;
    const demande = await prisma.demandeActualisationSoldes.findUniqueOrThrow({ where: { id: demandeId }, include: { lignes: true } });
    expect(demande.companyId).toBe(companyId);
    expect(demande.lignes.map((l) => l.compteId).sort()).toEqual([compteA, compteB].sort());
    const notif = await prisma.notification.findFirst({ where: { userId: financeId }, orderBy: { createdAt: "desc" }, select: { link: true } });
    expect(notif?.link).toBe(`/finances/actualisation-soldes/${demandeId}`);
  });

  it("UN SECOND CLIC RELANCE la même demande au lieu d'en créer une autre", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData();
    fd.set("entite", companyId);
    const r = await requestTreasuryUpdate(fd);
    expect(r.ok, r.error).toBe(true);
    expect(r.id).toBe(demandeId);
    expect(await prisma.demandeActualisationSoldes.count({ where: { companyId } })).toBe(1);
  });

  it("UN DÉLÉGUÉ NE RÉPOND PAS — il faut modifier les Finances", async () => {
    ACTOR = await actorFor(deleId, "MEDICAL_DELEGATE");
    const fd = new FormData();
    fd.set("id", demandeId);
    fd.set("lignes", "[]");
    expect((await repondreActualisationSoldes(fd)).ok).toBe(false);
  });

  it("LA RÉPONSE réancre le compte saisi, garde « pas encore reçu » ouvert, et prévient le Super Admin", async () => {
    const lignes = await prisma.ligneActualisationSoldes.findMany({ where: { demandeId } });
    const la = lignes.find((l) => l.compteId === compteA)!;
    const lb = lignes.find((l) => l.compteId === compteB)!;
    const aujourdhui = jourAlger(new Date());
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");

    // Une réponse INCOMPLÈTE est refusée en nommant le compte oublié.
    const incomplet = new FormData();
    incomplet.set("id", demandeId);
    incomplet.set("lignes", JSON.stringify([{ ligneId: la.id, choix: "ACTUALISE", solde: 2_000_000, date: aujourdhui }]));
    const refus = await repondreActualisationSoldes(incomplet);
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Banque B/);

    const fd = new FormData();
    fd.set("id", demandeId);
    fd.set("lignes", JSON.stringify([
      { ligneId: la.id, choix: "ACTUALISE", solde: 2_000_000, date: aujourdhui },
      { ligneId: lb.id, choix: "NON_RECU" },
    ]));
    const r = await repondreActualisationSoldes(fd);
    expect(r.ok, r.error).toBe(true);

    const compte = await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compteA } });
    expect(Number(compte.openingBalance)).toBe(2_000_000);
    expect(jourAlger(compte.openingDate)).toBe(aujourdhui);
    const demande = await prisma.demandeActualisationSoldes.findUniqueOrThrow({ where: { id: demandeId } });
    expect(demande.termineeLe).toBeNull();
    const retour = await prisma.notification.findFirst({ where: { userId: adminId, title: { contains: "partiellement" } } });
    expect(retour?.link).toBe(`/finances/paiements-a-faire?entite=${companyId}`);
  });

  it("UN COMPTE ACTUALISÉ NE SE RÉÉCRIT PAS ; compléter le reste clôt la demande", async () => {
    const lignes = await prisma.ligneActualisationSoldes.findMany({ where: { demandeId } });
    const la = lignes.find((l) => l.compteId === compteA)!;
    const lb = lignes.find((l) => l.compteId === compteB)!;
    const aujourdhui = jourAlger(new Date());
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");

    const reecrire = new FormData();
    reecrire.set("id", demandeId);
    reecrire.set("lignes", JSON.stringify([
      { ligneId: la.id, choix: "ACTUALISE", solde: 1, date: aujourdhui },
      { ligneId: lb.id, choix: "ACTUALISE", solde: 750, date: aujourdhui },
    ]));
    const refus = await repondreActualisationSoldes(reecrire);
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/déjà actualisé/);

    const fd = new FormData();
    fd.set("id", demandeId);
    fd.set("lignes", JSON.stringify([{ ligneId: lb.id, choix: "ACTUALISE", solde: 750, date: aujourdhui }]));
    const r = await repondreActualisationSoldes(fd);
    expect(r.ok, r.error).toBe(true);
    const demande = await prisma.demandeActualisationSoldes.findUniqueOrThrow({ where: { id: demandeId } });
    expect(demande.termineeLe).not.toBeNull();
    expect(Number((await prisma.treasuryAccount.findUniqueOrThrow({ where: { id: compteA } })).openingBalance)).toBe(2_000_000);
  });
});
