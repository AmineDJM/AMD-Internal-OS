import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ getCurrentUser: async () => ACTEUR, requireUser: async () => ACTEUR , requireUserAuNomDeLaVue: async () => ACTEUR}));
// Les octets d'une pièce : le banc juge la PORTE, pas le stockage chiffré.
vi.mock("@/lib/drive-storage", () => ({ getBlob: async () => Buffer.from("PDF") }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { voitLesSalaires, natureDeLAbsence, voitLeTypeDesAbsences } from "@/lib/hr/confidentialite";
import { getRhData } from "@/lib/queries/hr";
import { GET as telechargerPieceRh } from "@/app/api/rh/document/[id]/route";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAIE N'EST PAS DANS LA LECTURE SEULE, ET LES LISTES RH S'ARRÊTENT À LA SOCIÉTÉ
 * (§118.184 — audit 360°, S5 et S6). Joué avec de vrais rôles par défaut (le Directeur des
 * Opérations n'a des RH que la lecture) et un gestionnaire RH rattaché à UNE société.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * « CONGÉ » OU « ABSENT » — ce qu'un encadrant lit d'une absence dans Mon Équipe (§118.184). Pur : sans base.
 * Un arrêt maladie ne s'affiche plus « Congé » (on croirait la personne en vacances), sans que la maladie soit dite.
 */
describe("Mon Équipe — la nature d'une absence, sans la nature médicale", () => {
  const sansRh = { id: "u", role: "VIEWER", secondaryRole: null, access: { modules: new Map() } } as unknown as SessionUser;
  const gereLesRh = {
    id: "h", role: "VIEWER", secondaryRole: null,
    access: { modules: new Map([["RH", { actions: new Set(["VIEW", "UPDATE"]) }]]) },
  } as unknown as SessionUser;

  it("le congé annuel (et sans solde, récupération) se dit « Congé » ; toute autre absence se dit « Absent »", () => {
    expect(natureDeLAbsence("ANNUAL")).toBe("CONGE");
    expect(natureDeLAbsence("UNPAID")).toBe("CONGE");
    expect(natureDeLAbsence("RECOVERY")).toBe("CONGE");
    for (const t of ["SICK", "MATERNITY", "SPECIAL", "OTHER"]) expect(natureDeLAbsence(t), t).toBe("ABSENCE");
  });

  it("dans le doute, on en dit le moins : un type inconnu ou absent se dit « Absent »", () => {
    expect(natureDeLAbsence("QUELQUE_CHOSE_DE_NOUVEAU")).toBe("ABSENCE");
    expect(natureDeLAbsence(null)).toBe("ABSENCE");
    expect(natureDeLAbsence(undefined)).toBe("ABSENCE");
  });

  it("« Absent » ne dit pas « malade » : plusieurs natures s'y confondent", () => {
    const natures = new Set(["SICK", "MATERNITY", "SPECIAL", "OTHER"].map(natureDeLAbsence));
    expect([...natures]).toEqual(["ABSENCE"]);
  });

  it("le type précis ne se lit que pour qui gère les RH — la règle de la paie", () => {
    expect(voitLeTypeDesAbsences(gereLesRh)).toBe(true);
    expect(voitLeTypeDesAbsences(gereLesRh)).toBe(voitLesSalaires(gereLesRh));
    expect(voitLeTypeDesAbsences(sansRh)).toBe(false);
  });

  it("POINTS D'APPEL : l'aperçu n'envoie le libellé précis qu'aux RH, et le type n'est jamais sérialisé tel quel", () => {
    const src = readFileSync("src/lib/queries/my-team-overview.ts", "utf8");
    expect(src).toMatch(/genre: natureDeLAbsence\(c\.type\)/);
    expect(src).toMatch(/libelle: typePrecis \? LEAVE_TYPE\[c\.type\] \?\? null : null/);
    expect(src, "le type brut ne doit pas être poussé dans un événement").not.toMatch(/\btype: c\.type\b/);
    const my = readFileSync("src/lib/queries/my-team.ts", "utf8");
    expect(my, "my-team.ts ne lit toujours pas le type du congé").not.toMatch(/select: \{[^}]*\btype: true/);
  });
});

const TAG = "__hrconf__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("RH — qui voit la paie, et jusqu'où", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const e: Record<string, string> = {};
  const doc: Record<string, string> = {};
  let dirOps: SessionUser, rhA: SessionUser, salarieA: SessionUser, direction: SessionUser;

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);

  async function nettoyer() {
    const emps = await prisma.employee.findMany({ where: { fullName: { startsWith: TAG } }, select: { id: true } });
    const ids = emps.map((x) => x.id);
    await prisma.employeeDocument.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.salaryAdvance.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = async (k: string, role: string, companyId: string) => {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } });
      u[k] = user.id;
      e[k] = (await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id, baseSalary: 150000 } })).id;
    };
    await mk("dirOps", "OPERATIONS_DIRECTOR", A);
    await mk("rhA", "VIEWER", A);
    await mk("salA", "VIEWER", A);
    await mk("salB", "VIEWER", B);
    await mk("dir", "DIRECTION", A);
    // Le gestionnaire RH : un accès personnalisé au module, comme la console le donne.
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: u.rhA, module, canView: true, canUpdate: true, scope: "ALL" } });
    dirOps = await acteur(u.dirOps, "OPERATIONS_DIRECTOR");
    rhA = await acteur(u.rhA, "VIEWER");
    salarieA = await acteur(u.salA, "VIEWER");
    direction = await acteur(u.dir, "DIRECTION");
    for (const k of ["salA", "salB"]) {
      await prisma.leaveRequest.create({ data: { employeeId: e[k], startDate: new Date("2026-11-02"), endDate: new Date("2026-11-06") } });
      await prisma.salaryAdvance.create({ data: { employeeId: e[k], amount: 20000 } });
      doc[k] = (await prisma.employeeDocument.create({ data: { employeeId: e[k], category: "PAYSLIP", name: `${TAG}bulletin.pdf`, blobId: "x", mime: "application/pdf", size: 3 } })).id;
    }
  });

  afterAll(async () => { await nettoyer(); });

  it("la règle : la LECTURE des RH ne voit pas la paie ; qui GÈRE les RH, si", () => {
    // PRÉMISSE : le Directeur des Opérations voit le module, sans le gérer.
    expect(dirOps.access.modules.get("RH")?.actions.has("VIEW")).toBe(true);
    expect(voitLesSalaires(dirOps)).toBe(false);
    expect(voitLesSalaires(rhA)).toBe(true);
    expect(voitLesSalaires(direction)).toBe(true);
  });

  it("les LISTES de congés et d'avances s'arrêtent à la société du gestionnaire", async () => {
    const data = await getRhData(u.rhA);
    const conges = data.pendingLeaves.map((l) => l.employee.id);
    expect(conges).toContain(e.salA);
    expect(conges).not.toContain(e.salB);
    expect(data.advances.map((a) => a.employee.id)).not.toContain(e.salB);
  });

  const telecharger = async (acteurCourant: SessionUser, id: string) => {
    ACTEUR = acteurCourant;
    return (await telechargerPieceRh(new NextRequest(`http://x/api/rh/document/${id}`), { params: { id } })).status;
  };

  it("un BULLETIN : la lecture seule ne le télécharge plus ; le gestionnaire de SA société, si ; l'autre société, non", async () => {
    expect(await telecharger(dirOps, doc.salA)).toBe(403);
    expect(await telecharger(rhA, doc.salA)).toBe(200);
    expect(await telecharger(rhA, doc.salB)).toBe(403);
  });

  it("le salarié garde SON bulletin — et seulement le sien", async () => {
    expect(await telecharger(salarieA, doc.salA)).toBe(200);
    expect(await telecharger(salarieA, doc.salB)).toBe(403);
  });

  it("POINTS D'APPEL : les quatre portes lisent la même règle, et le salaire masqué n'est pas sérialisé", () => {
    // « Équipe » (maquette validée par la Direction, 07/10) n'affiche plus de masse salariale — elle vit dans la Paie.
    // Reste à garder : la même règle décide de la colonne « Salaire de base », et le salaire masqué n'est pas SÉRIALISÉ.
    const equipe = readFileSync("src/app/(app)/rh/equipe/page.tsx", "utf8");
    expect(equipe).toMatch(/const canSeeSalary = voitLesSalaires\(user\)/);
    // Le salaire n'est lu (par le coffre, refonte V2-E) que si la colonne est montrée ; sinon rien n'est lu ni sérialisé.
    expect(equipe).toMatch(/const salaires = canSeeSalary\s*\? await lireSensiblesPour\(/);
    expect(equipe).toMatch(/baseSalary: salaires\?\.get\(e\.id\)\?\.baseSalary\.lu \? Number\(/);
    expect(equipe).toMatch(/<TeamDirectory rows=\{rows\} canSeeSalary=\{canSeeSalary\}/);
    expect(equipe, "aucune masse salariale ne doit réapparaître hors de la règle").not.toMatch(/masseSalariale|byCompany/);
    const annuaire = readFileSync("src/app/(app)/rh/team-directory.tsx", "utf8");
    expect(annuaire).toMatch(/\{canSeeSalary && <TableHead[^>]*>Salaire de base<\/TableHead>\}/);
    expect(annuaire).toMatch(/\{canSeeSalary && \(\s*<TableCell/);
    const fiche = readFileSync("src/app/(app)/rh/[id]/page.tsx", "utf8");
    const porte = fiche.indexOf("entitePermisePourFiche(user.id, employee.companyId)");
    expect(porte).toBeGreaterThan(0);
    expect(porte).toBeLessThan(fiche.indexOf("getEmployeeHrDossier(employee.id)"));
    expect(fiche).toMatch(/\{salairesVisibles && <Info label="NIN"/);
    expect(fiche).toMatch(/\{salairesVisibles && <Card>\s+<CardHeader className="flex-row items-center justify-between">\s+<CardTitle>Derniers bulletins/);
  });
});
