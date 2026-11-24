import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ».
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, ouvreLeBureauAdam, peutUtiliserAssistantIA, userCan, type SessionUser } from "@/lib/rbac";
import { reallouerCategorie } from "@/lib/actions/budget-pole-actions";
import { createHrTraining, decideTraining } from "@/lib/actions/training-actions";
import { agirSurRisque } from "@/lib/actions/adventum-actions";
import { lignesFormationsAAutoriser } from "@/lib/queries/action-center-formations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POUVOIR DES DIRECTEURS (Super Admin, 24/11/2026), PAR LES VRAIS POINTS D'ENTRÉE.
 *
 * Société A : la « Direction des opérations » (responsable : le Directeur des opérations) tient deux enveloppes
 * Operations & Sales de l'exercice ; la société B a la sienne. Le directeur réalloue LIBREMENT d'une ligne à l'autre de SON
 * budget, d'une enveloppe à l'autre ; le total ne bouge pas ; le Super Admin est prévenu, le DG non. Hors de son budget —
 * une autre société, un autre directeur — c'est refusé. Une formation RÉGLEMENTAIRE organisée par les RH part à
 * l'autorisation du Directeur des opérations, sans le DG. Adventum Brain et Adam : au Super Admin seul, même quand la
 * console les ouvre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pdir${Date.now().toString(36)}__`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

suite("le pouvoir des directeurs", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const e: Record<string, string> = {};
  const env: Record<string, string> = {};
  const cat: Record<string, string> = {};

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    const envs = (await prisma.budgetEnvelope.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: envs } }, { actorId: { in: comptes } }] } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envs } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs } } }).catch(() => {});
    await prisma.training.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  const compte = async (cle: string, role: SessionUser["role"], companyId: string | null) => {
    u[cle] = (await prisma.user.create({ data: { name: `${TAG}${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } })).id;
    e[cle] = (await prisma.employee.create({ data: { fullName: `${TAG}${cle}`, userId: u[cle], isActive: true, companyId }, select: { id: true } })).id;
  };
  const enveloppe = async (cle: string, companyId: string, total: number, lignes: Record<string, number>) => {
    const annee = new Date().getUTCFullYear();
    env[cle] = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}${cle}`, domaine: "OPERATIONS", companyId, totalAmount: total, periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59)) },
      select: { id: true },
    })).id;
    for (const [nom, alloue] of Object.entries(lignes)) {
      cat[nom] = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env[cle], name: `${TAG}${nom}`, allocated: alloue }, select: { id: true } })).id;
    }
  };
  const alloue = async (nom: string) => Number((await prisma.budgetCategoryLine.findUniqueOrThrow({ where: { id: cat[nom] }, select: { allocated: true } })).allocated);
  const totalDe = async (cle: string) => Number((await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: env[cle] }, select: { totalAmount: true } })).totalAmount);
  const reallouer = (source: string, cible: string, montant: number) =>
    reallouerCategorie(form({ sourceId: cat[source], cibleId: cat[cible], montant: String(montant), motif: "Carburant plus cher que prévu" }));

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["A", "B"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    await compte("dirOps", "OPERATIONS_DIRECTOR", A);
    await compte("dirMkt", "PRODUCT_MANAGER", A);
    await compte("sa", "SUPER_ADMIN", null);
    await compte("dg", "GENERAL_MANAGER", A);
    await compte("rh", "VIEWER", A);
    await compte("direction", "DIRECTION", A);
    await prisma.department.create({ data: { name: "Direction des opérations", code: `${TAG}OPS`, companyId: A, headId: e.dirOps } });
    await prisma.department.create({ data: { name: "Marketing", code: `${TAG}MKT`, companyId: A, headId: e.dirMkt } });
    // Les RH : la fonction RH sur les formations, ouverte dans la console à un compte ordinaire.
    await prisma.userAccess.create({ data: { userId: u.rh, module: "TRAINING", canView: true, canCreate: true, canUpdate: true, canValidate: true, scope: "ALL" } });
    await enveloppe("ops1", A, 1_000_000, { carburant: 600_000, telephonie: 400_000 });
    await enveloppe("ops2", A, 500_000, { masse: 500_000 });
    await enveloppe("opsB", B, 300_000, { autreSociete: 300_000 });
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("le directeur réalloue d'une enveloppe à l'autre de SON budget : le total ne bouge pas, le Super Admin est prévenu, pas le DG", async () => {
    ACTOR = await actorFor(u.dirOps);
    const r = await reallouer("carburant", "masse", 100_000);
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect(await alloue("carburant")).toBe(500_000);
    expect(await alloue("masse")).toBe(600_000);
    expect(await totalDe("ops1")).toBe(900_000);
    expect(await totalDe("ops2")).toBe(600_000);
    expect((await totalDe("ops1")) + (await totalDe("ops2"))).toBe(1_500_000);
    const journal = await prisma.auditLog.findFirstOrThrow({ where: { entityId: env.ops1, field: "reallocation" } });
    expect(journal.actorId).toBe(u.dirOps);
    expect(journal.summary).toMatch(/par le directeur du budget/);
    expect(await prisma.notification.count({ where: { userId: u.sa, title: { contains: "Réallocation" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.dg } })).toBe(0);
  });

  it("…et dans une même enveloppe, sans plafond ni validation", async () => {
    ACTOR = await actorFor(u.dirOps);
    const r = await reallouer("telephonie", "carburant", 400_000);
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect(await alloue("telephonie")).toBe(0);
    expect(await totalDe("ops1")).toBe(900_000);
  });

  it("refuse vers le budget d'une autre société : le total de chacun changerait", async () => {
    ACTOR = await actorFor(u.dirOps);
    const r = await reallouer("carburant", "autreSociete", 50_000);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/même budget/);
    expect(await alloue("autreSociete")).toBe(300_000);
    expect(await totalDe("opsB")).toBe(300_000);
  });

  it("refuse à qui n'est pas le directeur de ce budget (le Directeur Marketing sur le budget Ops)", async () => {
    ACTOR = await actorFor(u.dirMkt);
    const r = await reallouer("carburant", "masse", 10_000);
    expect(r.ok).toBe(false);
    expect(await alloue("masse")).toBe(600_000);
  });

  it("une formation RÉGLEMENTAIRE organisée par les RH part à l'autorisation du Directeur des opérations — sans le DG", async () => {
    ACTOR = await actorFor(u.rh);
    const cree = await createHrTraining(undefined, form({ title: `${TAG}Bonnes pratiques de distribution`, amount: "80000" }));
    expect(cree.ok, cree.ok ? undefined : cree.error).toBe(true);
    const id = (cree as { id: string }).id;
    await prisma.training.update({ where: { id }, data: { companyId: A } });
    const t = await prisma.training.findUniqueOrThrow({ where: { id }, select: { stage: true } });
    expect(t.stage).toBe("OPERATIONS");
    // Son « Aujourd'hui » la montre ; celui du DG non.
    expect((await lignesFormationsAAutoriser(u.dirOps)).map((l) => l.objet)).toContain(`TRAINING:${id}`);
    expect((await lignesFormationsAAutoriser(u.dg)).map((l) => l.objet)).not.toContain(`TRAINING:${id}`);

    ACTOR = await actorFor(u.dg);
    const parDg = await decideTraining(form({ id, decision: "APPROVED" }));
    expect(parDg.ok).toBe(false);
    expect(parDg.ok ? "" : parDg.error).toMatch(/Directeur des opérations/);

    ACTOR = await actorFor(u.dirOps);
    const r = await decideTraining(form({ id, decision: "APPROVED", amountGranted: "75000" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const apres = await prisma.training.findUniqueOrThrow({ where: { id }, select: { status: true, opsDecidedById: true, dgDecidedById: true, amountGranted: true } });
    expect(apres).toMatchObject({ status: "APPROVED", opsDecidedById: u.dirOps, dgDecidedById: null });
    expect(Number(apres.amountGranted)).toBe(75_000);
  });

  it("une formation restée « chez le DG » avant la décision attend le Directeur des opérations", async () => {
    const t = await prisma.training.create({
      data: { title: `${TAG}ancienne`, reference: `${TAG}-old`, origin: "HR", stage: "DG", status: "PENDING", amount: 10_000, companyId: A, requesterId: u.rh },
      select: { id: true },
    });
    ACTOR = await actorFor(u.dg);
    expect((await decideTraining(form({ id: t.id, decision: "APPROVED" }))).ok).toBe(false);
    ACTOR = await actorFor(u.dirOps);
    expect((await decideTraining(form({ id: t.id, decision: "APPROVED" }))).ok).toBe(true);
  });

  it("Adventum Brain est refusé au Directeur des opérations — même ouvert dans la console", async () => {
    await prisma.userAccess.create({ data: { userId: u.dirOps, module: "ADVENTUM_BRAIN", canView: true, canUpdate: true, scope: "ALL" } });
    ACTOR = await actorFor(u.dirOps);
    expect(userCan(ACTOR, "ADVENTUM_BRAIN", "VIEW")).toBe(false);
    const r = await agirSurRisque(form({ riskId: "inexistant", geste: "prendre" }));
    expect(r.ok).toBe(false);
    ACTOR = await actorFor(u.sa);
    expect(userCan(ACTOR, "ADVENTUM_BRAIN", "VIEW")).toBe(true);
  });

  it("Adam est refusé à tout rôle non Super Admin, clé de la console ouverte ; le Super Admin le garde", async () => {
    await prisma.userAccess.createMany({
      data: [
        { userId: u.direction, module: "ASSISTANT_IA", canView: true, scope: "ALL" },
        { userId: u.direction, module: "CHIEF_OF_STAFF", canView: true, scope: "ALL" },
      ],
    });
    const direction = await actorFor(u.direction);
    expect(userCan(direction, "ASSISTANT_IA", "VIEW")).toBe(false);
    expect(peutUtiliserAssistantIA(direction)).toBe(false);
    expect(ouvreLeBureauAdam(direction)).toBe(false);
    // Même un accès résolu fabriqué à la main (la console « mal réglée ») ne passe pas la porte : le rôle est relu.
    const force: SessionUser = { ...direction, access: { ...direction.access, modules: new Map([...direction.access.modules, ["ASSISTANT_IA", { actions: new Set(["VIEW"]), scope: "ALL" }], ["CHIEF_OF_STAFF", { actions: new Set(["VIEW"]), scope: "ALL" }]]) } } as SessionUser;
    expect(peutUtiliserAssistantIA(force)).toBe(false);
    expect(ouvreLeBureauAdam(force)).toBe(false);
    const sa = await actorFor(u.sa);
    expect(peutUtiliserAssistantIA(sa)).toBe(true);
    expect(ouvreLeBureauAdam(sa)).toBe(true);
  });
});
