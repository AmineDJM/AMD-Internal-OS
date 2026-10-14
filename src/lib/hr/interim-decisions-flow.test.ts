import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { activeStandInsFor, auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { decideLeave } from "@/lib/actions/hr-actions";
import { decideTraining } from "@/lib/actions/training-actions";
import { decideApproval } from "@/lib/actions/admin-request-actions";
import { deciderPlanTournee } from "@/lib/actions/tour-plan-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { getLeavesToDecide } from "@/lib/queries/hr";
import { getPendingValidations } from "@/lib/queries/validations";
import { getApprovals, clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { clauseFormationsVisibles } from "@/lib/queries/visibilite-listes";
import { getActionCenter } from "@/lib/queries/action-center";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉRIMAIRE TRANCHE CE QUI ATTEND L'ABSENT — PARTOUT où l'absent tranchait en personne
 * (§118.185 — audit 360°, I18).
 *
 * Le panneau d'intérim promet « trancher les validations qui vous sont adressées ». Seules les
 * validations génériques le tenaient : congés, formations, achats et plans de tournée restaient
 * bloqués chez l'absent, et même la validation générique n'apparaissait dans aucune liste de
 * l'intérimaire. Joué par les vraies actions, avec un intérim VALIDÉ par les RH (la seule chose qui
 * l'arme) et un témoin sans intérim.
 *
 * Trois propriétés, chacune son cas : l'intérimaire tranche (quatre circuits + la validation
 * générique) ; il ne tranche JAMAIS sa propre demande, même adressée à l'absent qu'il remplace ;
 * l'intérim s'éteint seul avec le congé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__interim${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const jour = (decalage: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + decalage); return d; };

suite("l'intérimaire tranche ce qui attend l'absent — et jamais sa propre demande", () => {
  const u: Record<string, string> = {};
  const emp: Record<string, string> = {};
  let congeAbsent = "";
  let n = 0;

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__interim" } }, select: { id: true } })).map((x) => x.id);
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    await prisma.validationRequest.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { OR: [{ validatorId: { in: comptes } }, { requestedById: { in: comptes } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { repId: { in: comptes } } }).catch(() => {});
    await prisma.training.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: fiches } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const companyId = (await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))!.id;
    // M l'absent (un responsable d'équipe), S l'intérimaire (membre de SON équipe — c'est le cas
    // qui éprouve « jamais sa propre demande »), K un collaborateur, W le témoin sans intérim.
    for (const [k, role] of [["m", "HEAD_OF_SALES"], ["s", "SALES_USER"], ["k", "MEDICAL_DELEGATE"], ["w", "SALES_USER"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    emp.m = (await prisma.employee.create({ data: { fullName: `${TAG} m`, userId: u.m, companyId, isActive: true } })).id;
    for (const k of ["s", "k", "w"]) {
      emp[k] = (await prisma.employee.create({
        data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true, managerId: k === "w" ? null : emp.m },
      })).id;
    }
    // L'INTÉRIM : congé de M accordé, intérimaire S validé par les RH, en cours aujourd'hui.
    congeAbsent = (await prisma.leaveRequest.create({
      data: {
        employeeId: emp.m, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
        standInId: u.s, standInStatus: "APPROVED", standInModules: ["VALIDATIONS"],
      },
    })).id;
  }, 120_000);
  afterAll(nettoyer, 120_000);

  const congeDe = async (k: string) => (await prisma.leaveRequest.create({
    data: { employeeId: emp[k], startDate: jour(20), endDate: jour(22), days: 3, status: "PENDING", stage: "MANAGER", managerId: emp.m },
  })).id;
  const formationDe = async (k: string) => (await prisma.training.create({
    data: { reference: `${TAG}F${++n}`, title: `${TAG} formation ${k}`, requesterId: u[k], managerId: emp.m, status: "PENDING", stage: "MANAGER" },
  })).id;
  const achatDe = async (k: string) => {
    const req = await prisma.administrativeRequest.create({
      data: { reference: `${TAG}A${++n}`, title: `${TAG} achat ${k}`, type: "PURCHASE", status: "AWAITING_VALIDATION", requesterId: u[k], validatorId: u.m },
    });
    return (await prisma.adminApproval.create({ data: { requestId: req.id, requestedById: u[k], validatorId: u.m, status: "PENDING" } })).id;
  };
  // Une période par plan : un KAM n'a qu'un plan par période (contrainte d'unicité).
  const planDe = async (k: string) => {
    const decalage = 30 + 40 * ++n;
    return (await prisma.tourPlan.create({
      data: { repId: u[k], periodStart: jour(decalage), periodEnd: jour(decalage + 30), status: "SUBMITTED", submissionDueAt: jour(decalage - 5), submittedAt: new Date(), reviewerId: u.m },
    })).id;
  };
  const validationDe = async (k: string) => {
    const r = await prisma.validationRequest.create({
      data: { reference: `${TAG}V${++n}`, module: "Test", title: `${TAG} validation ${k}`, requesterId: u[k], steps: { create: [{ order: 1, validatorId: u.m }] } },
      include: { steps: true },
    });
    return r.steps[0].id;
  };

  it("PRÉMISSE : l'intérim de S est armé (congé accordé, RH validées, dates en cours) ; W n'en a aucun", async () => {
    expect((await activeStandInsFor(u.s)).map((a) => a.absenteeUserId)).toEqual([u.m]);
    expect(await activeStandInsFor(u.w)).toEqual([]);
    const auNom = await auNomDeQui(u.s);
    expect([...auNom.ids].sort()).toEqual([u.m, u.s].sort());
    expect(auNom.nomDe(u.m)).toBe(`${TAG} m`);
    expect(auNom.nomDe(u.s), "agir pour soi n'est pas un intérim").toBeNull();
  });

  it("CONGÉ : S signe la marche du N+1 pour K ; W ne le peut pas ; S ne signe pas le sien", async () => {
    const deK = await congeDe("k");
    ACTOR = await actorFor(u.w);
    expect((await decideLeave(form({ id: deK, decision: "APPROVED" }))).ok, "le témoin est refusé").toBe(false);
    const liste = await getLeavesToDecide(await actorFor(u.s));
    const ligne = liste.find((l) => l.id === deK);
    expect(ligne, "le congé de K est dans la file de S").toBeDefined();
    expect(ligne!.pourLeCompteDe, "la file dit au nom de qui").toBe(`${TAG} m`);
    ACTOR = await actorFor(u.s);
    const r = await decideLeave(form({ id: deK, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: deK } })).stage, "la marche suivante est atteinte").not.toBe("MANAGER");
    const deS = await congeDe("s");
    expect((await getLeavesToDecide(await actorFor(u.s))).some((l) => l.id === deS), "son propre congé n'est pas dans sa file").toBe(false);
    expect((await decideLeave(form({ id: deS, decision: "APPROVED" }))).ok, "ni signable").toBe(false);
  });

  it("LE N+1 ENREGISTRÉ, muté depuis : S signe au nom de M même quand M n'est plus dans la chaîne (§118.140)", async () => {
    // Deux gardes tiennent « S agit pour M » : le N+1 ENREGISTRÉ à la soumission, et la chaîne ACTUELLE.
    // Le cas qui les sépare : W n'a plus de responsable dans l'organigramme, sa demande porte encore M.
    const conge = (await prisma.leaveRequest.create({
      data: { employeeId: emp.w, startDate: jour(40), endDate: jour(41), days: 2, status: "PENDING", stage: "MANAGER", managerId: emp.m },
    })).id;
    const formation = (await prisma.training.create({
      data: { reference: `${TAG}F${++n}`, title: `${TAG} formation w`, requesterId: u.w, managerId: emp.m, status: "PENDING", stage: "MANAGER" },
    })).id;
    ACTOR = await actorFor(u.s);
    const r1 = await decideLeave(form({ id: conge, decision: "APPROVED" }));
    expect(r1.ok, r1.ok ? undefined : r1.error).toBe(true);
    const r2 = await decideTraining(form({ id: formation, decision: "APPROVED" }));
    expect(r2.ok, r2.ok ? undefined : r2.error).toBe(true);
  });

  it("FORMATION : S tranche la marche du N+1 pour K ; jamais la sienne", async () => {
    const deK = await formationDe("k");
    const deS = await formationDe("s");
    const visibles = await prisma.training.findMany({ where: { AND: [await clauseFormationsVisibles(await actorFor(u.s)), { id: { in: [deK, deS] } }] }, select: { id: true } });
    expect(visibles.map((v) => v.id), "la formation de K est visible pour S").toContain(deK);
    ACTOR = await actorFor(u.w);
    expect((await decideTraining(form({ id: deK, decision: "APPROVED" }))).ok).toBe(false);
    ACTOR = await actorFor(u.s);
    const r = await decideTraining(form({ id: deK, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect((await decideTraining(form({ id: deS, decision: "APPROVED" }))).ok, "sa propre formation").toBe(false);
  });

  it("ACHAT : S valide l'achat de K adressé à M ; la file et la fiche le lui montrent ; jamais le sien", async () => {
    const deK = await achatDe("k");
    const deS = await achatDe("s");
    const file = await getApprovals(await actorFor(u.s));
    const ligne = file.find((a) => a.id === deK);
    expect(ligne?.pourLeCompteDe).toBe(`${TAG} m`);
    expect(file.some((a) => a.id === deS), "sa propre demande n'est pas dans la file").toBe(false);
    const reqK = (await prisma.adminApproval.findUniqueOrThrow({ where: { id: deK } })).requestId;
    expect(await prisma.administrativeRequest.count({ where: await clauseDemandeLisible(await actorFor(u.s), reqK) }), "la fiche s'ouvre").toBe(1);
    expect(await prisma.administrativeRequest.count({ where: await clauseDemandeLisible(await actorFor(u.w), reqK) }), "pas au témoin").toBe(0);
    ACTOR = await actorFor(u.w);
    expect((await decideApproval(form({ approvalId: deK, decision: "APPROVED" }))).ok).toBe(false);
    ACTOR = await actorFor(u.s);
    const r = await decideApproval(form({ approvalId: deK, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect((await decideApproval(form({ approvalId: deS, decision: "APPROVED" }))).ok, "son propre achat").toBe(false);
  });

  it("PLAN DE TOURNÉE : S tranche le plan que K a soumis à M", async () => {
    const plan = await planDe("k");
    ACTOR = await actorFor(u.w);
    expect((await deciderPlanTournee(form({ planId: plan, decision: "APPROVE" }))).ok).toBe(false);
    ACTOR = await actorFor(u.s);
    const r = await deciderPlanTournee(form({ planId: plan, decision: "APPROVE" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect((await prisma.tourPlan.findUniqueOrThrow({ where: { id: plan } })).status).toBe("APPROVED");
  });

  it("VALIDATION GÉNÉRIQUE : elle entre dans la file de S, au nom de M — et sa propre demande n'y entre pas, ni ne se décide", async () => {
    const deK = await validationDe("k");
    const deS = await validationDe("s");
    const file = await getPendingValidations(u.s);
    expect(file.find((v) => v.stepId === deK)?.pourLeCompteDe).toBe(`${TAG} m`);
    expect(file.some((v) => v.stepId === deS)).toBe(false);
    ACTOR = await actorFor(u.s);
    expect((await decideValidation(form({ stepId: deS, decision: "APPROVED" }))).ok, "s'approuver soi-même").toBe(false);
    const r = await decideValidation(form({ stepId: deK, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
  });

  it("MON ESPACE : ce qui attend M est listé pour S, au nom de M — rien pour le témoin", async () => {
    const deK = await congeDe("k");
    const achat = await achatDe("k");
    const plan = await planDe("k");
    const centre = await getActionCenter(await actorFor(u.s));
    const cles = centre.items.map((i) => i.key);
    expect(cles).toContain(`interim-leave-${deK}`);
    expect(cles).toContain(`interim-achat-${achat}`);
    expect(cles).toContain(`interim-plan-${plan}`);
    expect(centre.items.find((i) => i.key === `interim-plan-${plan}`)!.subtitle).toContain(`Intérim pour ${TAG} m`);
    const temoin = await getActionCenter(await actorFor(u.w));
    expect(temoin.items.some((i) => i.key.startsWith("interim-"))).toBe(false);
  });

  it("L'INTÉRIM S'ÉTEINT SEUL avec le congé : le lendemain du retour, plus rien ne se tranche au nom de M", async () => {
    const deK = await congeDe("k");
    await prisma.leaveRequest.update({ where: { id: congeAbsent }, data: { startDate: jour(-10), endDate: jour(-2) } });
    expect(await activeStandInsFor(u.s)).toEqual([]);
    ACTOR = await actorFor(u.s);
    expect((await decideLeave(form({ id: deK, decision: "APPROVED" }))).ok).toBe(false);
    expect((await getLeavesToDecide(await actorFor(u.s))).some((l) => l.id === deK)).toBe(false);
  });

  it("LES POINTS D'APPEL : chaque porte lit la même fonction (une recopie divergerait)", () => {
    expect(readFileSync("src/lib/hr/leave-core.ts", "utf8")).toMatch(/auNomDeQui\(user\.id\)/);
    expect(readFileSync("src/lib/actions/training-actions.ts", "utf8")).toMatch(/auNomDeQui\(user\.id\)/);
    expect(readFileSync("src/app/(app)/formations/page.tsx", "utf8")).toMatch(/auNomDeQui\(user\.id\)/);
    expect(readFileSync("src/lib/actions/tour-plan-actions.ts", "utf8").match(/agitPour: await standInForUserIds\(user\.id\)/g)?.length).toBe(2);
    expect(readFileSync("src/app/(app)/medical/plan-de-tournee/page.tsx", "utf8")).toMatch(/agitPour,/);
  });
});
