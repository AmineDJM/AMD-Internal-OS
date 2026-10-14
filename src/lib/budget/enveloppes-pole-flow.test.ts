import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { CLE_MASSE_SALARIALE } from "@/lib/budget-operations/force-de-vente";
import { assurerEnveloppeAnnuelle } from "./enveloppes-pole";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__envannuelle__";

/**
 * « Quand j'ouvre Budget Operations & Sales 2026, une enveloppe doit déjà exister, masse salariale en tête » (Direction,
 * 10/2026). Ce banc ouvre l'écran comme le directeur des opérations, deux fois, puis comme quelqu'un qui ne fait que lire.
 */
suite("Budget Operations & Sales — l'enveloppe de l'année existe d'emblée", () => {
  let dirOpsId = "", lecteurId = "";
  const envs: string[] = [];
  const annee = new Date().getUTCFullYear();

  beforeAll(async () => {
    dirOpsId = (await prisma.user.create({ data: { name: `${TAG}dirops`, email: `${TAG}dirops@t.dz`, role: "OPERATIONS_DIRECTOR", passwordHash: "x" } })).id;
    lecteurId = (await prisma.user.create({ data: { name: `${TAG}fin`, email: `${TAG}fin@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" } })).id;
  });

  afterAll(async () => {
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envs } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [dirOpsId, lecteurId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const acteur = async (id: string, role: SessionUser["role"]) => ({ id, role, access: await getAccess(id, role) });

  it("qui ne fait que lire n'ouvre rien", async () => {
    expect(await assurerEnveloppeAnnuelle("OPERATIONS", await acteur(lecteurId, "FINANCE_BUDGET_MANAGER"))).toBeNull();
  });

  it("le directeur des opérations la trouve ouverte, masse salariale en tête — et une seule fois", async () => {
    // La base partagée de la suite peut déjà porter une enveloppe O&S de l'année (un autre banc, un essai) : on ne la
    // touche pas — on vérifie alors qu'elle n'est pas doublée. Sinon, on vérifie la création.
    const id = await assurerEnveloppeAnnuelle("OPERATIONS", await acteur(dirOpsId, "OPERATIONS_DIRECTOR"));
    if (id) {
      envs.push(id);
      const env = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id }, include: { categories: { orderBy: { createdAt: "asc" } } } });
      expect(env.name).toBe(`Operations & Sales ${annee}`);
      expect(env.domaine).toBe("OPERATIONS");
      expect(Number(env.totalAmount)).toBe(0);
      const tetes = env.categories.filter((c) => c.parentId === null);
      expect(tetes[0].cle).toBe(CLE_MASSE_SALARIALE);
      expect(tetes.map((c) => c.name)).toContain("Véhicules & carburant");
    }
    const maintenant = new Date();
    const avant = await prisma.budgetEnvelope.count({ where: { domaine: "OPERATIONS", periodStart: { lte: maintenant }, periodEnd: { gte: maintenant } } });
    expect(avant).toBeGreaterThan(0);
    // Deux écrans ouverts en même temps : rien de plus.
    const [a, b] = await Promise.all([
      assurerEnveloppeAnnuelle("OPERATIONS", await acteur(dirOpsId, "OPERATIONS_DIRECTOR")),
      assurerEnveloppeAnnuelle("OPERATIONS", await acteur(dirOpsId, "OPERATIONS_DIRECTOR")),
    ]);
    expect([a, b]).toEqual([null, null]);
    expect(await prisma.budgetEnvelope.count({ where: { domaine: "OPERATIONS", periodStart: { lte: maintenant }, periodEnd: { gte: maintenant } } })).toBe(avant);
  });
});
