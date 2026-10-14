import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBudgetOverview, getEnvelopesGrandTotal } from "@/lib/queries/budget";
import { getEntityMissions } from "@/lib/queries/missions";
import { assignMission, choisirBudgetMission, integrerFraisEquipe } from "@/lib/actions/mission-actions";
import { assurerImputationEquipe, imputationsProposees } from "./imputation-serveur";
import { CATEGORIE_EQUIPE_PAR_DEFAUT } from "./imputation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__equipe_os__${Date.now()}`;
const ANNEE = 2031;
const DU = new Date(Date.UTC(ANNEE, 0, 1));
const AU = new Date(Date.UTC(ANNEE, 11, 31, 23, 59, 59));

/**
 * « Ici le budget à imputer, ce n'est pas Ad & Pro, c'est Operations & Sales » (Direction, 10/2026). Ce banc invite un
 * collaborateur sur un événement Ad & Pro, puis suit ses frais : l'imputation par défaut va à l'enveloppe Operations &
 * Sales de l'année (ouverte d'office), une catégorie Ad & Pro est refusée, le transport intégré à la clôture et la note
 * de frais comptent dans Operations & Sales — et Ad & Pro n'en voit rien. Une ancienne imputation Ad & Pro reste lisible.
 */
suite("Équipe Adventum — les frais de l'équipe interne vont au budget Operations & Sales", () => {
  let pdgId = "", dmId = "", delegueId = "", ancienId = "", societeId = "", employeId = "", eventId = "", adProEnvId = "", adProCatId = "";
  const users: string[] = [];

  async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: u.name, email: u.email, role, access: await getAccess(id, role), mustChangePassword: false };
  }
  const form = (champs: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(champs)) fd.set(k, v); return fd; };
  const enveloppeOs = async () => prisma.budgetEnvelope.findFirstOrThrow({
    where: { domaine: "OPERATIONS", periodStart: { lte: new Date(Date.UTC(ANNEE, 10, 2)) }, periodEnd: { gte: new Date(Date.UTC(ANNEE, 10, 2)) }, OR: [{ companyId: societeId }, { companyId: null }] },
    include: { categories: true },
  });

  beforeAll(async () => {
    const creer = async (nom: string, role: SessionUser["role"]) => {
      const id = (await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } })).id;
      users.push(id);
      return id;
    };
    pdgId = await creer("pdg", "SUPER_ADMIN");
    dmId = await creer("dm", "PRODUCT_MANAGER");
    delegueId = await creer("delegue", "SALES_USER");
    ancienId = await creer("ancien", "SALES_USER");
    societeId = (await prisma.company.create({ data: { name: `${TAG} Adventum` } })).id;
    employeId = (await prisma.employee.create({ data: { fullName: `${TAG} Délégué`, companyId: societeId, isActive: true, userId: delegueId } })).id;
    eventId = (await prisma.event.create({ data: { name: `${TAG} congrès`, requesterId: pdgId, startDate: new Date(Date.UTC(ANNEE, 10, 2)), endDate: new Date(Date.UTC(ANNEE, 10, 4)) } })).id;
    const adPro = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG} Ad & Pro ${ANNEE}`, domaine: "MARKETING", modules: ["EVENTS", "CONGRESS_INTERNATIONAL"], periodStart: DU, periodEnd: AU, totalAmount: 1_000_000,
        categories: { create: [{ name: "Événements", module: "EVENTS", allocated: 1_000_000 }] },
      },
      include: { categories: true },
    });
    adProEnvId = adPro.id;
    adProCatId = adPro.categories[0]!.id;
  });

  afterAll(async () => {
    const missions = await prisma.missionAssignment.findMany({ where: { entityId: eventId }, select: { id: true } });
    await prisma.hrDocumentRequest.deleteMany({ where: { missionAssignmentId: { in: missions.map((m) => m.id) } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.missionAssignment.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    const envs = await prisma.budgetEnvelope.findMany({ where: { OR: [{ id: adProEnvId }, { createdById: { in: users } }] }, select: { id: true } });
    const cats = await prisma.budgetCategoryLine.findMany({ where: { envelopeId: { in: envs.map((e) => e.id) } }, select: { id: true } });
    await prisma.budgetExpenseLine.deleteMany({ where: { categoryId: { in: cats.map((c) => c.id) } } }).catch(() => {});
    // Une enveloppe O&S préexistante (autre banc) n'est pas supprimée : seules ses lignes de ce banc le sont.
    await prisma.budgetExpenseLine.deleteMany({ where: { reference: { contains: TAG } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envs.map((e) => e.id) } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs.map((e) => e.id) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: employeId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });

  it("inviter un collaborateur pose l'imputation par défaut : Operations & Sales de l'année, ouverte d'office", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await assignMission(form({ entityType: "EVENT", entityId: eventId, userId: delegueId, role: "DELEGATE_REFERENCE" }));
    expect(r.ok, r.error).toBe(true);
    const a = await prisma.missionAssignment.findUniqueOrThrow({ where: { id: r.id! } });
    expect(a.budgetCategoryId).toBeTruthy();
    expect(a.budgetChoisiParId).toBeNull(); // le défaut, pas un choix
    const env = await enveloppeOs();
    const cat = env.categories.find((c) => c.id === a.budgetCategoryId);
    expect(cat?.name).toBe(CATEGORIE_EQUIPE_PAR_DEFAUT);
    expect(env.domaine).toBe("OPERATIONS");

    const [dto] = await getEntityMissions("EVENT", eventId);
    expect(dto!.imputation).toMatchObject({ pole: "OPERATIONS", parDefaut: true });
    expect(dto!.imputation!.libelle).toContain(CATEGORIE_EQUIPE_PAR_DEFAUT);

    // L'écran ne propose que des catégories Operations & Sales (jamais la masse salariale, jamais Ad & Pro).
    const p = await imputationsProposees({ date: new Date(Date.UTC(ANNEE, 10, 2)), actorId: pdgId });
    expect(p.defaut?.label).toContain(CATEGORIE_EQUIPE_PAR_DEFAUT);
    expect(p.options.some((o) => o.id === adProCatId)).toBe(false);
    expect(p.options.some((o) => /Masse salariale/.test(o.label))).toBe(false);
  });

  it("une ligne Ad & Pro est refusée ; une autre catégorie Operations & Sales est acceptée ; « par défaut » la remet", async () => {
    ACTOR = await acteur(dmId, "PRODUCT_MANAGER");
    const a = await prisma.missionAssignment.findFirstOrThrow({ where: { entityId: eventId, userId: delegueId } });
    const refus = await choisirBudgetMission(form({ id: a.id, budgetCategoryId: adProCatId }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Operations & Sales/);
    const ms = (await enveloppeOs()).categories.find((c) => c.cle === "MASSE_SALARIALE_FDV" && c.parentId === null);
    if (ms) expect((await choisirBudgetMission(form({ id: a.id, budgetCategoryId: ms.id }))).ok).toBe(false);

    const logistique = (await enveloppeOs()).categories.find((c) => c.name === "Logistique")!;
    const ok = await choisirBudgetMission(form({ id: a.id, budgetCategoryId: logistique.id }));
    expect(ok.ok, ok.error).toBe(true);
    expect((await prisma.missionAssignment.findUniqueOrThrow({ where: { id: a.id } })).budgetCategoryId).toBe(logistique.id);

    const reset = await choisirBudgetMission(form({ id: a.id, budgetCategoryId: "" }));
    expect(reset.ok, reset.error).toBe(true);
    const apres = await prisma.missionAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect((await enveloppeOs()).categories.find((c) => c.id === apres.budgetCategoryId)?.name).toBe(CATEGORIE_EQUIPE_PAR_DEFAUT);
    expect(apres.budgetChoisiParId).toBeNull();
  });

  it("le transport intégré à la clôture et la note de frais comptent dans Operations & Sales — Ad & Pro n'en voit rien", async () => {
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const a = await prisma.missionAssignment.findFirstOrThrow({ where: { entityId: eventId, userId: delegueId } });
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { response: "CONFIRMEE", respondedAt: new Date() } });
    const postesAvant = await prisma.adProItem.count({ where: { eventId } });

    const r = await integrerFraisEquipe(form({ id: a.id, etape: "TRANSPORT", montant: "45000", integrer: "on" }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.adProItem.count({ where: { eventId } })).toBe(postesAvant); // plus de poste Ad & Pro
    const ligne = await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: r.id! }, include: { category: { include: { envelope: true } } } });
    expect(ligne.category.envelope.domaine).toBe("OPERATIONS");
    expect(ligne.category.name).toBe(CATEGORIE_EQUIPE_PAR_DEFAUT);
    expect(Number(ligne.amount)).toBe(45000);
    expect(ligne.date.getUTCFullYear()).toBe(ANNEE);
    // Une seconde intégration du même transport est refusée.
    expect((await integrerFraisEquipe(form({ id: a.id, etape: "TRANSPORT", montant: "1", integrer: "on" }))).ok).toBe(false);
    const [dto] = await getEntityMissions("EVENT", eventId);
    expect(dto!.fraisIntegres.TRANSPORT).toBe("OPERATIONS");

    const env = await enveloppeOs();
    const catId = ligne.categoryId;
    const avant = await getBudgetOverview(ACTOR, env.id, DU, AU, { portee: "OPERATIONS" });
    const consAvant = avant!.categories.find((c) => c.id === catId)!.consumed;
    const engAvant = avant!.categories.find((c) => c.id === catId)!.committed;

    // La note de frais de la mission : en route → engagée ; validée par les RH → consommée.
    const note = await prisma.hrDocumentRequest.create({
      data: { employeeId: employeId, type: "EXPENSE_REPORT", status: "PENDING", expenseAmount: 12000, expenseMonth: `${ANNEE}-11`, missionAssignmentId: a.id, managerGate: "PENDING" },
    });
    const enRoute = await getBudgetOverview(ACTOR, env.id, DU, AU, { portee: "OPERATIONS" });
    expect(enRoute!.categories.find((c) => c.id === catId)!.committed).toBe(engAvant + 12000);
    expect(enRoute!.categories.find((c) => c.id === catId)!.consumed).toBe(consAvant);

    await prisma.hrDocumentRequest.update({ where: { id: note.id }, data: { status: "READY", managerGate: "APPROVED" } });
    const validee = await getBudgetOverview(ACTOR, env.id, DU, AU, { portee: "OPERATIONS" });
    const cat = validee!.categories.find((c) => c.id === catId)!;
    expect(cat.consumed).toBe(consAvant + 12000);
    expect(cat.committed).toBe(engAvant);
    expect(validee!.attributed.transactions.some((t) => t.kind === "MISSION" && t.id === note.id)).toBe(true);
    expect(validee!.attributed.transactions.some((t) => t.kind === "BUDGET" && t.id === ligne.id)).toBe(true);
    const total = await getEnvelopesGrandTotal(ACTOR, { portee: "OPERATIONS" });
    expect(total.items.find((i) => i.id === env.id)!.consumed).toBeGreaterThanOrEqual(45000 + 12000);

    // Ad & Pro : rien de l'équipe interne — ni la ligne, ni la note.
    const adPro = await getBudgetOverview(ACTOR, adProEnvId, DU, AU, { portee: "MARKETING" });
    expect(adPro!.totals.consumed).toBe(0);
    expect(adPro!.totals.committed).toBe(0);
  });

  it("une ancienne imputation Ad & Pro reste lisible telle quelle, n'est pas réécrite, et n'est comptée par personne", async () => {
    const vieille = await prisma.missionAssignment.create({
      data: {
        entityType: "EVENT", entityId: eventId, userId: ancienId, role: "ACCOMPAGNANT", response: "CONFIRMEE", createdById: pdgId,
        budgetCategoryId: adProCatId, budgetChoisiParId: dmId, budgetChoisiLe: new Date(Date.UTC(ANNEE - 6, 5, 1)),
      },
    });
    expect(await assurerImputationEquipe(vieille.id, pdgId, null)).toBe(adProCatId);
    expect((await prisma.missionAssignment.findUniqueOrThrow({ where: { id: vieille.id } })).budgetCategoryId).toBe(adProCatId);
    const dto = (await getEntityMissions("EVENT", eventId)).find((m) => m.id === vieille.id)!;
    expect(dto.imputation).toMatchObject({ pole: "AD_PRO", parDefaut: false, categoryId: adProCatId });

    await prisma.hrDocumentRequest.create({
      data: { employeeId: employeId, type: "EXPENSE_REPORT", status: "READY", expenseAmount: 7000, expenseMonth: `${ANNEE}-11`, missionAssignmentId: vieille.id },
    });
    ACTOR = await acteur(pdgId, "SUPER_ADMIN");
    const adPro = await getBudgetOverview(ACTOR, adProEnvId, DU, AU, { portee: "MARKETING" });
    expect(adPro!.totals.consumed).toBe(0);
  });
});
