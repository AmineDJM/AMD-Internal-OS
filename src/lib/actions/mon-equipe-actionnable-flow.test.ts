import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

// LES RÉGLAGES SONT GLOBAUX (§118.132, §118.170) : les modules masqués et l'accès au pipeline s'INJECTENT dans ce
// processus — les écrire en base ferait masquer un module, le temps d'un cas, à toute la suite qui tourne à côté.
let MASQUES: string[] = [];
let VOIT_PIPELINE: string[] = [];
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...vrai,
    getAppSettings: async () => ({
      ...(await vrai.getAppSettings()),
      hiddenModules: MASQUES,
      pipelineViewerRoles: [],
      pipelineViewerUserIds: VOIT_PIPELINE,
      pipelineManagerRoles: [],
      pipelineManagerUserIds: [],
    }),
  };
});

import { prisma } from "@/lib/prisma";
import {
  getAccess, hasGlobalView, isTopManagement, seesLockedRegulatory, userCan, type Module, type SessionUser,
} from "@/lib/rbac";
import { canOpenModule } from "@/lib/modules-visibility";
import { entitePermisePourFiche } from "@/lib/company";
import { isManagerOfUser } from "@/lib/departments";
import { standInForUserIds } from "@/lib/hr/stand-in-resolve";
import { recruitmentScope, recruitmentViewer } from "@/lib/recruitment/access";
import { accesAuPlan, type StatutPlan } from "@/lib/sfe/tournee";
import { clauseDemandeLisible } from "@/lib/queries/admin-requests";
import { loadPlanTournee } from "@/lib/queries/tour-schedule";
import { getMyTeam, type MyTeam } from "@/lib/queries/my-team";
import { NO_JOB_KPI_NOTE, type TeamKpi } from "@/modules/rh/partage";
import { teamMemberKpis } from "./my-team-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__monEquipeActionnable__";

/** Un JOUR de congé, écrit comme la saisie l'écrit : minuit UTC (`<input type="date">` → `fdDate`). */
const J = (jour: string) => new Date(`${jour}T00:00:00Z`);
/** 08:00 à Alger le 12 mars 2031 — des dates FIXES, jamais « maintenant + n heures » (§118.131, §118.195). */
const MATIN = new Date("2031-03-12T07:00:00Z");
/** 00:30 à Alger le 13 mars 2031 — il est encore le 12 en UTC. */
const NUIT = new Date("2031-03-12T23:30:00Z");

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * LA GARDE RÉELLE DE CHAQUE PAGE VERS LAQUELLE MON ÉQUIPE POSE UN LIEN — rejouée ici, écran par écran, sans passer
 * par `lienDeLigne` (le banc ne doit pas juger le code avec le code qu'il juge, §118.120). Les deux portes de
 * `requireModule` (`session.ts`) sont recopiées telles quelles : le droit de LECTURE, puis le module en service.
 * Un lien inconnu LÈVE : une adresse ajoutée demain sans sa garde ici ferait tomber ce banc, pas passer.
 */
async function pageOuvrable(u: CurrentUser, href: string): Promise<boolean> {
  const module = (m: Module) =>
    userCan(u, m, "VIEW") && canOpenModule(m, MASQUES, { isSuperAdmin: u.role === "SUPER_ADMIN" });
  let m: RegExpMatchArray | null;
  if ((m = href.match(/^\/recrutement\/([^/?#]+)$/))) {
    // `recrutement/[id]/page.tsx` : requireModule("RECRUITMENT") puis `recruitmentViewer` → notFound.
    return module("RECRUITMENT") && (await recruitmentViewer(u, m[1])) !== null;
  }
  if ((m = href.match(/^\/demandes\/([^/?#]+)$/))) {
    // `demandes/[id]/page.tsx` : requireModule("ADMIN_REQUESTS") puis `clauseDemandeLisible` → notFound.
    if (!module("ADMIN_REQUESTS")) return false;
    return (await prisma.administrativeRequest.findFirst({ where: await clauseDemandeLisible(u, m[1]), select: { id: true } })) !== null;
  }
  if ((m = href.match(/^\/medical\/plan-de-tournee\?plan=([^&#]+)$/))) {
    // `medical/plan-de-tournee/page.tsx` : requireModule("MEDICAL") puis `accesAuPlan(...).voir` → notFound.
    if (!module("MEDICAL")) return false;
    const plan = await loadPlanTournee(m[1]);
    if (!plan) return false;
    const agitPour = await standInForUserIds(u.id);
    const chaineDuKam = plan.repId === u.id || plan.reviewerId === u.id || plan.escalatedToId === u.id || hasGlobalView(u)
      ? []
      : (await isManagerOfUser(u.id, plan.repId)) ? [u.id] : [];
    return accesAuPlan({
      userId: u.id, vueGlobale: hasGlobalView(u), repId: plan.repId, reviewerId: plan.reviewerId,
      escalatedToId: plan.escalatedToId, statut: plan.status as StatutPlan, chaineDuKam, agitPour,
    }).voir;
  }
  if ((m = href.match(/^\/rh\/([^/?#]+)$/))) {
    // `rh/[id]/page.tsx` : requireModule("EMPLOYEES") (sous-module « Employés », Direction 06/10), la fiche existe, puis
    // `entitePermisePourFiche` → notFound.
    if (!module("EMPLOYEES")) return false;
    const e = await prisma.employee.findUnique({ where: { id: m[1] }, select: { companyId: true } });
    return e !== null && (await entitePermisePourFiche(u.id, e.companyId));
  }
  if (href.startsWith("/mon-espace")) return module("WORKSPACE"); // `mon-espace/page.tsx` : requireModule("WORKSPACE").
  if (href === "/formations" || href.startsWith("/formations?")) return true; // `formations/page.tsx` : requireUser seul (`?formation=` ouvre la ligne).
  throw new Error(`Lien sans garde rejouée dans ce banc : ${href}`);
}

/**
 * MON ÉQUIPE DEVIENT ACTIONNABLE (§118.196, lot E3 — audit 360°, managers M10, M12, M19, M21), depuis les VRAIS
 * points d'entrée : `getMyTeam` (le chargeur de l'écran) et `teamMemberKpis` (l'action des indicateurs), avec des
 * acteurs SANS vue globale (§118.104) et les prémisses vérifiées — sans elles, un refus pourrait venir d'ailleurs.
 */
suite("Mon Équipe : ce qui m'attend, qui manque, et des liens qui s'ouvrent", () => {
  const users: Record<string, string> = {};
  const emps: Record<string, string> = {};
  const companies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const A: Record<string, CurrentUser> = {};

  const nettoyer = async () => {
    const parNom = { fullName: { startsWith: TAG } };
    await Promise.all([
      prisma.recruitmentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }),
      prisma.adminApproval.deleteMany({ where: { request: { reference: { startsWith: TAG } } } }),
      prisma.training.deleteMany({ where: { reference: { startsWith: TAG } } }),
      prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }),
      prisma.tourPlan.deleteMany({ where: { rep: { email: { startsWith: TAG } } } }),
      prisma.leaveRequest.deleteMany({ where: { employee: parNom } }),
    ]);
    await prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.employee.deleteMany({ where: parNom });
    await Promise.all([
      prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }),
      prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }),
    ]);
  };

  beforeAll(async () => {
    await nettoyer();

    // ── QUI EST QUI ───────────────────────────────────────────────────────────────────────────
    //  dg (sommet) → dir → kam1, kam2, kam3 ; dg → autreDir → autreKam ; outsider seul.
    //  fin (Finances, société A) → membreA (A, délégué), membreB (B, ventes).
    //  voitPipe (voit le pipeline) → headReg (ne le voit pas) → assist (porte un dossier ouvert et un verrouillé).
    //  lecteurProfond → p1 → … → p10 → kamProfond : onze rangs, un de plus que la chaîne que lit la page du plan ;
    //  p1, un rang plus bas, est à dix : c'est le témoin.
    const ROLES: [string, SessionUser["role"]][] = [
      ["dg", "GENERAL_MANAGER"], ["dir", "MEDICAL_PROMOTION_MANAGER"], ["kam1", "MEDICAL_DELEGATE"],
      ["kam2", "MEDICAL_DELEGATE"], ["kam3", "MEDICAL_DELEGATE"], ["autreDir", "MEDICAL_PROMOTION_MANAGER"],
      ["autreKam", "MEDICAL_DELEGATE"], ["outsider", "MEDICAL_DELEGATE"], ["fin", "FINANCE_BUDGET_MANAGER"],
      ["membreA", "MEDICAL_DELEGATE"], ["membreB", "SALES_USER"], ["voitPipe", "HEAD_OF_REGULATORY"],
      ["headReg", "HEAD_OF_REGULATORY"], ["assist", "REGULATORY_ASSISTANT"],
      ["lecteurProfond", "MEDICAL_PROMOTION_MANAGER"], ["p1", "MEDICAL_PROMOTION_MANAGER"], ["kamProfond", "MEDICAL_DELEGATE"],
    ];
    for (const [cle] of ROLES) { users[cle] = randomUUID(); emps[cle] = randomUUID(); }
    for (let i = 1; i <= 10; i++) emps[`p${i}`] ??= randomUUID();
    companies.A = randomUUID(); companies.B = randomUUID();

    const manager: Record<string, string | null> = {
      dg: null, dir: "dg", kam1: "dir", kam2: "dir", kam3: "dir", autreDir: "dg", autreKam: "autreDir", outsider: null,
      fin: null, membreA: "fin", membreB: "fin", voitPipe: null, headReg: "voitPipe", assist: "headReg",
      lecteurProfond: null, p1: "lecteurProfond", p2: "p1", p3: "p2", p4: "p3", p5: "p4", p6: "p5", p7: "p6", p8: "p7",
      p9: "p8", p10: "p9", kamProfond: "p10",
    };
    const societe: Record<string, string> = { fin: companies.A, membreA: companies.A, membreB: companies.B };

    await Promise.all([
      prisma.company.createMany({
        data: [
          { id: companies.A, name: `${TAG} Société A`, isActive: true },
          { id: companies.B, name: `${TAG} Société B`, isActive: true },
        ],
      }),
      prisma.user.createMany({
        data: ROLES.map(([cle, role]) => ({ id: users[cle], name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" })),
      }),
    ]);
    // Les N+1 d'abord dans l'ordre d'écriture ; Postgres vérifie de toute façon les clés en fin d'instruction.
    await prisma.employee.createMany({
      data: Object.keys(manager).map((cle) => ({
        id: emps[cle], fullName: `${TAG} ${cle}`, userId: users[cle] ?? null, isActive: true, position: cle,
        managerId: manager[cle] ? emps[manager[cle] as string] : null, companyId: societe[cle] ?? null,
      })),
    });

    ids.R1 = randomUUID(); ids.R2 = randomUUID(); ids.R3 = randomUUID(); ids.R4 = randomUUID();
    ids.P1 = randomUUID(); ids.P2 = randomUUID(); ids.P3 = randomUUID(); ids.P4 = randomUUID();
    ids.PA = randomUUID(); ids.PP = randomUUID(); ids.ACHAT = randomUUID(); ids.F1 = randomUUID();
    ids.CONGE_KAM2_ATTENTE = randomUUID(); ids.CONGE_DIR_ATTENTE = randomUUID();
    const recrutement = (cle: string, demandeur: string, marches: [string, "PENDING" | "APPROVED"][]) =>
      prisma.recruitmentRequest.create({
        data: {
          id: ids[cle], reference: `${TAG}-${cle}`, requesterId: users[demandeur],
          position: `Poste ${cle}`, headcount: 1, contractType: "CDI", stage: "CHAIN",
          approvals: { create: marches.map(([qui, status], i) => ({ order: i + 1, approverId: users[qui], status })) },
        },
      });
    const mois = (a: number, m: number) => ({ periodStart: new Date(Date.UTC(a, m - 1, 1)), periodEnd: new Date(Date.UTC(a, m, 0, 23, 59, 59)) });
    await Promise.all([
      recrutement("R1", "dir", [["dg", "PENDING"]]),
      // R2 : la marche de dir est franchie, celle de dg attend — c'est le tour de dg.
      recrutement("R2", "kam1", [["dir", "APPROVED"], ["dg", "PENDING"]]),
      // R3 : la marche de dir attend encore — ce n'est PAS le tour de dg.
      recrutement("R3", "kam2", [["dir", "PENDING"], ["dg", "PENDING"]]),
      // R4 : la marche de dg attend, mais le demandeur n'est pas dans son arbre.
      recrutement("R4", "outsider", [["dg", "PENDING"]]),
      prisma.tourPlan.createMany({
        data: [
          { id: ids.P1, repId: users.kam2, ...mois(2031, 4), status: "SUBMITTED", reviewerId: users.dir, submissionDueAt: J("2031-03-25"), submittedAt: new Date("2031-03-01T09:00:00Z") },
          { id: ids.P2, repId: users.kam1, ...mois(2031, 5), status: "ESCALATED", reviewerId: users.dir, escalatedToId: users.dg, submissionDueAt: J("2031-04-25"), submittedAt: new Date("2031-03-02T09:00:00Z") },
          { id: ids.P3, repId: users.outsider, ...mois(2031, 4), status: "SUBMITTED", reviewerId: users.dir, submissionDueAt: J("2031-03-25"), submittedAt: new Date("2031-03-03T09:00:00Z") },
          { id: ids.P4, repId: users.kam1, ...mois(2031, 2), status: "APPROVED", reviewerId: users.dir, submissionDueAt: J("2031-01-25") },
          { id: ids.PA, repId: users.membreA, ...mois(2031, 4), status: "DRAFT", submissionDueAt: J("2031-03-25") },
          { id: ids.PP, repId: users.kamProfond, ...mois(2031, 4), status: "DRAFT", submissionDueAt: J("2031-03-25") },
        ],
      }),
      prisma.leaveRequest.createMany({
        data: [
          // kam1 : accordé du 10 au 12 mars — fini « le 12 », écrit le 12 à minuit UTC.
          { employeeId: emps.kam1, type: "ANNUAL", status: "APPROVED", stage: "DONE", startDate: J("2031-03-10"), endDate: J("2031-03-12"), days: 3 },
          // kam2 : accordé les 13 et 14 ; et une demande d'UN jour, le 12, qui attend la signature de dir.
          { employeeId: emps.kam2, type: "ANNUAL", status: "APPROVED", stage: "DONE", startDate: J("2031-03-13"), endDate: J("2031-03-14"), days: 2 },
          { id: ids.CONGE_KAM2_ATTENTE, employeeId: emps.kam2, type: "ANNUAL", status: "PENDING", stage: "MANAGER", startDate: J("2031-03-12"), endDate: J("2031-03-12"), days: 1, createdAt: new Date("2031-03-04T09:00:00Z") },
          // dir : une demande d'UN jour, le 11, qui attend la signature de dg — l'équipe de dir, sous lui, manque
          // ce jour-là (kam1), mais ce n'est pas l'équipe de dir chez dg : ses pairs, ce sont les autres N-1 de dg.
          { id: ids.CONGE_DIR_ATTENTE, employeeId: emps.dir, type: "ANNUAL", status: "PENDING", stage: "MANAGER", startDate: J("2031-03-11"), endDate: J("2031-03-11"), days: 1, createdAt: new Date("2031-03-05T09:00:00Z") },
          // autreKam : le 12 aussi — mais dans une AUTRE équipe.
          { employeeId: emps.autreKam, type: "ANNUAL", status: "APPROVED", stage: "DONE", startDate: J("2031-03-12"), endDate: J("2031-03-12"), days: 1 },
        ],
      }),
      // Une demande d'achat de kam1 qui attend la validation de dir — écrite comme l'action l'écrit : le validateur de
      // la demande ET son approbation en attente (`purchase-request-actions.ts`).
      prisma.administrativeRequest.create({
        data: {
          id: ids.ACHAT, reference: `${TAG}-ACHAT`, title: `${TAG} Achat`, type: "PURCHASE", status: "AWAITING_VALIDATION",
          requesterId: users.kam1, createdById: users.kam1, validatorId: users.dir,
          approvals: { create: { requestedById: users.kam1, validatorId: users.dir, status: "PENDING" } },
        },
      }),
      // Une demande de formation de dir, à la marche de son responsable (dg).
      prisma.training.create({
        data: { id: ids.F1, reference: `${TAG}-F1`, title: `${TAG} Formation`, requesterId: users.dir, status: "PENDING", stage: "MANAGER" },
      }),
      // Deux dossiers d'assist, tous deux en retard : l'un ouvert, l'autre VERROUILLÉ au pipeline.
      prisma.regulatoryProduct.createMany({
        data: [
          { reference: `${TAG}-D1`, dci: `${TAG} molécule ouverte`, assistantId: users.assist, targetDate: J("2020-01-01"), isLocked: false },
          { reference: `${TAG}-D2`, dci: `${TAG} molécule verrouillée`, assistantId: users.assist, targetDate: J("2020-01-01"), isLocked: true },
        ],
      }),
    ]);

    VOIT_PIPELINE = [users.voitPipe];
    // dir SANS le module Recrutement : tout le monde l'a depuis que n'importe qui peut demander un poste (Direction,
    // 07/10) — seul un BLOCAGE de la console le retire, et c'est ce cas que le banc éprouve plus bas.
    await prisma.userAccess.create({ data: { userId: users.dir, module: "RECRUITMENT", canView: false } });
    const acteurs = await Promise.all(ROLES.map(async ([cle, role]) => [cle, await actorFor(users[cle], role)] as const));
    for (const [cle, a] of acteurs) A[cle] = a;
  }, 120_000);

  afterAll(async () => {
    MASQUES = [];
    await nettoyer().catch(() => {});
  }, 120_000);

  const membre = (t: MyTeam, cle: string) => {
    const m = t.members.find((x) => x.employeeId === emps[cle]);
    if (!m) throw new Error(`${cle} n'est pas dans l'équipe`);
    return m;
  };
  const kpisDe = async (lecteur: string, cible: string) => {
    ACTOR = A[lecteur];
    const r = await teamMemberKpis(emps[cible]);
    if (!r.ok) throw new Error(`${lecteur} → ${cible} : ${r.error}`);
    return r.kpis;
  };
  const kpi = (k: { common: TeamKpi[]; job_: TeamKpi[] }, cle: TeamKpi["cle"]) => {
    const x = [...k.common, ...k.job_].find((y) => y.cle === cle);
    if (!x) throw new Error(`pas de chiffre « ${cle} »`);
    return x;
  };

  it("LE DERNIER JOUR, LE MATIN À ALGER, LA PERSONNE EST ABSENTE — le congé fini à minuit UTC compte encore (M21)", async () => {
    // PRÉMISSE — le défaut existait : comparé à l'INSTANT, le congé de kam1 est fini à 08:00 à Alger le 12.
    expect(J("2031-03-12") >= MATIN).toBe(false);
    const t = await getMyTeam(A.dg, { maintenant: MATIN });
    expect(membre(t, "kam1").absentToday).toBe(true);
    expect(membre(t, "kam2").absentToday).toBe(false);
    // Le congé du jour de kam2 n'est qu'en attente : il n'en fait pas un absent.
    expect(membre(t, "kam2").nextLeave).toEqual({ start: "2031-03-13T00:00:00.000Z", end: "2031-03-14T00:00:00.000Z" });
    expect(membre(t, "kam1").nextLeave).toBeNull();
    // Un congé d'UN jour, aujourd'hui : absent, et pas « à venir ».
    expect(membre(t, "autreKam").absentToday).toBe(true);
    expect(membre(t, "autreKam").nextLeave).toBeNull();
  });

  it("À 0 H 30 À ALGER, C'EST DÉJÀ DEMAIN — l'absence d'hier finit, celle d'aujourd'hui commence", async () => {
    // PRÉMISSE — en UTC, il est encore le 12 : c'est le jour d'ALGER qui décide.
    expect(NUIT.toISOString().slice(0, 10)).toBe("2031-03-12");
    const t = await getMyTeam(A.dg, { maintenant: NUIT });
    expect(membre(t, "kam1").absentToday).toBe(false);
    expect(membre(t, "kam2").absentToday).toBe(true);
  });

  it("LA MARCHE DE RECRUTEMENT QUI M'ATTEND EST DANS « À DÉCIDER », avec le lien de sa fiche (M10)", async () => {
    expect(userCan(A.dg, "RECRUITMENT", "VIEW")).toBe(true);
    const t = await getMyTeam(A.dg, { maintenant: MATIN });
    const recrutements = t.pending.filter((p) => p.kind === "RECRUITMENT");
    expect(recrutements.map((p) => p.id).sort()).toEqual([`recruitment-${ids.R1}`, `recruitment-${ids.R2}`].sort());
    const r2 = recrutements.find((p) => p.id === `recruitment-${ids.R2}`)!;
    expect(r2.href).toBe(`/recrutement/${ids.R2}`);
    expect(r2.sansLien).toBeNull();
    expect(r2.employeeId).toBe(emps.kam1);
    expect(r2.detail).toContain("marche 2/2");
  });

  it("UNE MARCHE QUI N'EST PAS ENCORE LA MIENNE NE M'ATTEND PAS — même pour le sommet", async () => {
    // PRÉMISSE — dg PEUT trancher à toute marche (le sommet) : c'est sa FILE qui ne doit pas s'en remplir.
    expect(isTopManagement(A.dg)).toBe(true);
    const t = await getMyTeam(A.dg, { maintenant: MATIN });
    expect(t.pending.some((p) => p.id === `recruitment-${ids.R3}`)).toBe(false);
  });

  it("UN RECRUTEMENT HORS DE MON ARBRE N'EST PAS DANS MON ÉQUIPE — même quand sa marche m'attend", async () => {
    // PRÉMISSE — dg voit tous les recrutements (portée entière) et la marche de R4 l'attend : seul l'ARBRE l'écarte.
    expect(recruitmentScope(A.dg)).toEqual({});
    const t = await getMyTeam(A.dg, { maintenant: MATIN });
    expect(t.pending.some((p) => p.id === `recruitment-${ids.R4}`)).toBe(false);
  });

  it("SANS LE MODULE RECRUTEMENT, LA LIGNE RESTE — SANS LIEN, ET DIT QUI PEUT L'OUVRIR", async () => {
    expect(userCan(A.dir, "RECRUITMENT", "VIEW")).toBe(false);
    const t = await getMyTeam(A.dir, { maintenant: MATIN });
    const r3 = t.pending.find((p) => p.id === `recruitment-${ids.R3}`);
    expect(r3, "la marche qui attend dir doit rester visible").toBeDefined();
    expect(r3!.href).toBeNull();
    expect(r3!.sansLien).toContain("Recrutement");
    expect(r3!.sansLien).toContain("Administration › Accès");
  });

  it("UN MODULE MASQUÉ NE TIENT PLUS DE FILE — la ligne disparaît, le lien aussi", async () => {
    MASQUES = ["RECRUITMENT"];
    try {
      const [chezDg, chezDir] = await Promise.all([getMyTeam(A.dg, { maintenant: MATIN }), getMyTeam(A.dir, { maintenant: MATIN })]);
      expect(chezDg.pending.some((p) => p.kind === "RECRUITMENT")).toBe(false);
      expect(chezDir.pending.some((p) => p.kind === "RECRUITMENT")).toBe(false);
      // Ce qui ne dépend pas du module masqué reste : les plans de tournée.
      expect(chezDg.pending.some((p) => p.id === `tourplan-${ids.P2}`)).toBe(true);
      expect(chezDir.pending.some((p) => p.id === `tourplan-${ids.P1}`)).toBe(true);
    } finally {
      MASQUES = [];
    }
  });

  it("LE PLAN DE TOURNÉE QUI M'ATTEND EST DANS « À DÉCIDER » — soumis à moi, ou escaladé à moi, dans mon arbre", async () => {
    const [chezDir, chezDg] = await Promise.all([getMyTeam(A.dir, { maintenant: MATIN }), getMyTeam(A.dg, { maintenant: MATIN })]);
    // dir : P1 (soumis à lui). Pas P3 (hors de son arbre), ni P4 (validé), ni P2 (escaladé : c'est dg qui tranche).
    const plansDir = chezDir.pending.filter((p) => p.kind === "TOUR_PLAN");
    expect(plansDir.map((p) => p.id)).toEqual([`tourplan-${ids.P1}`]);
    expect(plansDir[0].href).toBe(`/medical/plan-de-tournee?plan=${ids.P1}`);
    expect(plansDir[0].detail).toBe("Soumis au N+1");
    const plansDg = chezDg.pending.filter((p) => p.kind === "TOUR_PLAN");
    expect(plansDg.map((p) => p.id)).toEqual([`tourplan-${ids.P2}`]);
    expect(plansDg[0].detail).toBe("Escaladé au N+2");
  });

  it("LA CARTE COMPTE CE QUI M'ATTEND — à toute profondeur pour une chaîne, au premier rang pour un congé", async () => {
    const [chezDg, chezDir] = await Promise.all([getMyTeam(A.dg, { maintenant: MATIN }), getMyTeam(A.dir, { maintenant: MATIN })]);
    // dg : kam1 (N-2) porte R2 et P2 ; dir porte R1, sa formation et son congé ; le congé de kam2 attend dir, pas dg.
    expect(membre(chezDg, "kam1").pending).toBe(2);
    expect(membre(chezDg, "dir").pending).toBe(3);
    expect(membre(chezDg, "kam2").pending).toBe(0);
    // dir : kam2 porte le congé, R3 et P1 ; kam1, son achat.
    expect(membre(chezDir, "kam2").pending).toBe(3);
    expect(membre(chezDir, "kam1").pending).toBe(1);
    expect(membre(chezDir, "kam3").pending).toBe(0);
    // La carte et la liste disent le même nombre (§118.51).
    for (const t of [chezDg, chezDir]) {
      expect(t.members.reduce((s, m) => s + m.pending, 0)).toBe(t.pending.filter((p) => p.employeeId !== null).length);
    }
  });

  it("LE CONGÉ À SIGNER DIT QUI MANQUERA EN MÊME TEMPS DANS L'ÉQUIPE (M19)", async () => {
    const t = await getMyTeam(A.dir, { maintenant: MATIN });
    const conge = t.pending.find((p) => p.id === `leave-${ids.CONGE_KAM2_ATTENTE}`);
    expect(conge, "le congé de kam2 attend la signature de dir").toBeDefined();
    expect(conge!.href).toBe("/mon-espace#conges-a-signer");
    expect(conge!.chevauchements).toEqual([{ nom: `${TAG} kam1`, debut: "2031-03-10", fin: "2031-03-12", enAttente: false }]);
    // Chez dg, le congé de dir se juge parmi SES pairs (les N-1 de dg) : l'absence de kam1, sous dir, ce jour-là,
    // n'est pas un chevauchement — l'équipe de dir n'est pas l'équipe de dg.
    const chezDg = await getMyTeam(A.dg, { maintenant: MATIN });
    const congeDir = chezDg.pending.find((p) => p.id === `leave-${ids.CONGE_DIR_ATTENTE}`);
    expect(congeDir, "le congé de dir attend la signature de dg").toBeDefined();
    expect(congeDir!.chevauchements).toEqual([]);
  });

  it("LES CHEVAUCHEMENTS RESTENT DANS LEUR ÉQUIPE — deux équipes ne se chevauchent pas", async () => {
    const t = await getMyTeam(A.dg, { maintenant: MATIN });
    expect(t.chevauchements).toEqual([
      {
        groupe: emps.dir, equipe: `Équipe de ${TAG} dir`, debut: "2031-03-12", fin: "2031-03-12",
        personnes: [
          { employeeId: emps.kam1, nom: `${TAG} kam1`, enAttente: false },
          { employeeId: emps.kam2, nom: `${TAG} kam2`, enAttente: true },
        ],
      },
    ]);
    expect(t.chevauchementsNonMontres).toBe(0);
  });

  it("LES CHIFFRES QUI ONT UN ÉCRAN Y MÈNENT — le portefeuille vers le plan, les congés vers la fiche (M12)", async () => {
    expect(userCan(A.dg, "RH", "VIEW") && userCan(A.dg, "MEDICAL", "VIEW")).toBe(true);
    const k = await kpisDe("dg", "kam1");
    expect(kpi(k, "leaveDaysThisYear").href).toBe(`/rh/${emps.kam1}`);
    // Le plan le PLUS RÉCENT de kam1 (mai, escaladé) — pas celui de février.
    expect(kpi(k, "doctors").href).toBe(`/medical/plan-de-tournee?plan=${ids.P2}`);
    const avecLien = [...k.common, ...k.job_].filter((x) => x.href).map((x) => x.cle).sort();
    expect(avecLien).toEqual(["doctors", "leaveDaysThisYear"]);
  });

  it("SANS LES RH, PAS DE LIEN VERS LA FICHE ; SANS LA PROMOTION MÉDICALE, PAS DE LIEN VERS LE PLAN", async () => {
    expect(userCan(A.dir, "RH", "VIEW")).toBe(false);
    expect(userCan(A.dir, "MEDICAL", "VIEW")).toBe(true);
    const dirKam1 = await kpisDe("dir", "kam1");
    expect(kpi(dirKam1, "doctors").href).toBe(`/medical/plan-de-tournee?plan=${ids.P2}`);
    expect(kpi(dirKam1, "leaveDaysThisYear").href).toBeUndefined();
    // kam3 n'a aucun plan : rien à ouvrir.
    expect(kpi(await kpisDe("dir", "kam3"), "doctors").href).toBeUndefined();

    expect(userCan(A.fin, "RH", "VIEW")).toBe(true);
    expect(userCan(A.fin, "MEDICAL", "VIEW")).toBe(false);
    const finA = await kpisDe("fin", "membreA");
    expect(kpi(finA, "leaveDaysThisYear").href).toBe(`/rh/${emps.membreA}`);
    expect(kpi(finA, "doctors").href).toBeUndefined();
  });

  it("LA FICHE D'UNE AUTRE SOCIÉTÉ N'EST PAS UN LIEN — la fiche ne s'ouvre pas plus large que la liste", async () => {
    // PRÉMISSES — fin a les RH, et sa société A lui est permise ; la B, non : seul l'ENTITÉ écarte le lien.
    expect(userCan(A.fin, "RH", "VIEW")).toBe(true);
    expect(await entitePermisePourFiche(users.fin, companies.A)).toBe(true);
    expect(await entitePermisePourFiche(users.fin, companies.B)).toBe(false);
    const k = await kpisDe("fin", "membreB");
    expect(kpi(k, "leaveDaysThisYear").href).toBeUndefined();
  });

  it("UN MODULE MASQUÉ N'A PAS DE LIEN", async () => {
    MASQUES = ["RH", "MEDICAL"];
    try {
      const k = await kpisDe("dg", "kam1");
      expect([...k.common, ...k.job_].filter((x) => x.href)).toEqual([]);
    } finally {
      MASQUES = [];
    }
  });

  it("AU-DELÀ DE DIX RANGS, LA PAGE DU PLAN NE S'OUVRE PLUS — le chiffre reste sans lien", async () => {
    // PRÉMISSES — kamProfond est bien dans l'équipe (onze rangs : l'arbre en descend douze), ses indicateurs
    // s'ouvrent, et la page du plan, elle, le refuserait : la chaîne qu'elle lit s'arrête à dix.
    const t = await getMyTeam(A.lecteurProfond, { maintenant: MATIN });
    expect(membre(t, "kamProfond").depth).toBe(11);
    expect(userCan(A.lecteurProfond, "MEDICAL", "VIEW")).toBe(true);
    expect(await isManagerOfUser(users.lecteurProfond, users.kamProfond)).toBe(false);
    const k = await kpisDe("lecteurProfond", "kamProfond");
    expect(kpi(k, "doctors").href).toBeUndefined();
    // LE TÉMOIN : un rang plus bas, à dix, le MÊME plan s'ouvre et le chiffre y mène — c'est bien la PROFONDEUR qui
    // ferme, pas un droit qui manquerait.
    expect(await isManagerOfUser(users.p1, users.kamProfond)).toBe(true);
    expect(kpi(await kpisDe("p1", "kamProfond"), "doctors").href).toBe(`/medical/plan-de-tournee?plan=${ids.PP}`);
  });

  it("UN DOSSIER VERROUILLÉ NE SE COMPTE PAS POUR QUI NE VOIT PAS LE PIPELINE", async () => {
    expect(seesLockedRegulatory(A.headReg)).toBe(false);
    const k = await kpisDe("headReg", "assist");
    expect(kpi(k, "dossiers").value).toBe("1");
    expect(kpi(k, "overdue").value).toBe("1");
  });

  it("…ET CELUI QUI VOIT LE PIPELINE LE COMPTE — le cadenas est celui du lecteur, pas de la hiérarchie", async () => {
    expect(seesLockedRegulatory(A.voitPipe)).toBe(true);
    const k = await kpisDe("voitPipe", "assist");
    expect(kpi(k, "dossiers").value).toBe("2");
    expect(kpi(k, "overdue").value).toBe("2");
  });

  it("UN MÉTIER VRAIMENT GÉNÉRIQUE LE DIT — et la phrase ne prétend plus que l'outil n'a rien", async () => {
    const k = await kpisDe("fin", "membreB");
    expect(k.job).toBe("GENERIC");
    expect(k.job_).toEqual([]);
    expect(k.note).toBe(NO_JOB_KPI_NOTE);
    expect(k.note).not.toMatch(/dans l'outil/);
  });

  it("CHAQUE LIEN DE MON ÉQUIPE MÈNE À UNE PAGE QUI S'OUVRE — la garde de chaque page, rejouée", async () => {
    const liens: { qui: string; href: string }[] = [];
    for (const qui of ["dg", "dir", "fin", "lecteurProfond", "p1", "voitPipe"]) {
      const t = await getMyTeam(A[qui], { maintenant: MATIN });
      for (const p of t.pending) if (p.href) liens.push({ qui, href: p.href });
      for (const m of t.members) {
        const k = await kpisDe(qui, Object.keys(emps).find((c) => emps[c] === m.employeeId) as string);
        for (const x of [...k.common, ...k.job_]) if (x.href) liens.push({ qui, href: x.href });
      }
    }
    // Un `every` sur une liste vide ne prouverait rien (§118.17) : le décor pose au moins huit liens.
    expect(liens.length).toBeGreaterThanOrEqual(8);
    // Toutes les sortes de liens du décor sont là — sans quoi une garde ci-dessus ne serait jamais exercée.
    for (const forme of [/^\/recrutement\//, /^\/demandes\//, /^\/medical\/plan-de-tournee\?plan=/, /^\/rh\//, /^\/mon-espace/, /^\/formations(\?formation=|$)/]) {
      expect(liens.some((l) => forme.test(l.href)), `aucun lien ${forme}`).toBe(true);
    }
    for (const l of liens) {
      expect(await pageOuvrable(A[l.qui], l.href), `${l.qui} → ${l.href}`).toBe(true);
    }
  });
});
