import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";

/**
 * LE SERVICE DES MOYENS GÉNÉRAUX EST UN RÉGLAGE GLOBAL (une ligne `AppSetting`). Le poser pour de
 * vrai, même une seconde, changerait ce que voient toutes les suites qui tournent en parallèle sur
 * la même base (§118.132) : le banc l'INJECTE dans son propre processus, et la base partagée garde
 * son réglage. Tout le reste — départements, comptes, dépenses, enveloppe — est réel.
 */
let SERVICE: string | null = null;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), generalMeansDepartmentId: SERVICE }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { resolveGeneralMeansDepartment } from "./general-means";
import { getBudgetOverview } from "./budget";
import { lienRemiseCaisse } from "@/lib/chemins/moyens-generaux";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mgsvc__${Date.now().toString(36)}`;
const RACINE = process.cwd();

async function acteur(id: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role) } as SessionUser;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MOYENS GÉNÉRAUX : UN SEUL SERVICE À L'ÉCRAN, SUPER ADMIN COMPRIS (décision du 01/10, §118.170).
 *
 * « Enlève les autres départements, laisse que l'Administration. » Le Super Admin passait d'un
 * département à l'autre par un sélecteur (`?dept=`) ; il n'y a plus qu'une caisse, celle du service
 * désigné. Trois propriétés, chacune avec le cas qui la ferait tomber :
 *   1. tout le monde arrive sur le SERVICE — le Super Admin comme un salarié d'un autre département ;
 *   2. un service SUPPRIMÉ ne met pas le module en 404 : on retombe sur le repli d'avant ;
 *   3. le budget compte toujours TOUTES les dépenses, mais « Voir la dépense » ne mène que là où
 *      l'écran les montre — un lien vers une dépense que l'écran ne peut plus ouvrir est une impasse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Moyens généraux — le service, et lui seul", () => {
  const u: Record<string, string> = {};
  let dService = "", dAutre = "", envelopeId = "", categoryId = "", depService = "", depAutre = "";

  beforeAll(async () => {
    dService = (await prisma.department.create({ data: { name: `${TAG} Administration`, code: `${TAG}A` } })).id;
    dAutre = (await prisma.department.create({ data: { name: `${TAG} Regulatory`, code: `${TAG}R` } })).id;
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("sa", "SUPER_ADMIN");
    await mk("salarie", "SALES_USER");
    await prisma.employee.create({ data: { fullName: `${TAG} salarie`, userId: u.salarie, departmentId: dAutre } });

    const debut = new Date("2026-01-01T00:00:00Z");
    const fin = new Date("2026-12-31T23:59:59Z");
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Fonctionnement`, periodStart: debut, periodEnd: fin, totalAmount: 1_000_000, categories: { create: [{ name: `${TAG} Fournitures` }] } },
      include: { categories: true },
    });
    envelopeId = env.id;
    categoryId = env.categories[0]!.id;
    const depense = async (departmentId: string, label: string, amount: number) => (await prisma.departmentBudgetExpense.create({
      data: { departmentId, year: 2026, label, amount, date: new Date("2026-06-15T10:00:00Z"), budgetCategoryId: categoryId, createdById: u.sa },
    })).id;
    depService = await depense(dService, `${TAG} Cartouches`, 12_000);
    depAutre = await depense(dAutre, `${TAG} Classeurs`, 3_500);
  }, 60_000);

  afterAll(async () => {
    await prisma.departmentBudgetExpense.deleteMany({ where: { id: { in: [depService, depAutre] } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envelopeId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: Object.values(u) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: Object.values(u) } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: { in: [dService, dAutre] } } }).catch(() => {});
    SERVICE = null;
  }, 60_000);

  it("PRÉMISSES : sans service désigné, chacun retomberait sur SON département — le salarié sur le sien, le Super Admin sur aucun", async () => {
    // C'est ce repli qui rend la propriété suivante discriminante : si le service n'était pas lu, le
    // salarié arriverait sur Regulatory et le Super Admin sur rien.
    SERVICE = null;
    expect(await resolveGeneralMeansDepartment(await acteur(u.salarie))).toBe(dAutre);
    expect(await resolveGeneralMeansDepartment(await acteur(u.sa))).toBeNull();
  });

  it("1. le SERVICE désigné est la porte de TOUS — le Super Admin comme le salarié d'un autre département", async () => {
    SERVICE = dService;
    expect(await resolveGeneralMeansDepartment(await acteur(u.sa))).toBe(dService);
    expect(await resolveGeneralMeansDepartment(await acteur(u.salarie))).toBe(dService);
  });

  it("2. un service SUPPRIMÉ ne met pas le module en 404 : on retombe sur le repli, où le Super Admin peut le redésigner", async () => {
    // Le réglage n'est pas une clé étrangère : il survit au département qu'il nomme.
    SERVICE = `${TAG}-departement-supprime`;
    expect(await prisma.department.findUnique({ where: { id: SERVICE } }), "prémisse : ce département n'existe pas").toBeNull();
    expect(await resolveGeneralMeansDepartment(await acteur(u.salarie))).toBe(dAutre);
    expect(await resolveGeneralMeansDepartment(await acteur(u.sa))).toBeNull();
  });

  it("3. le budget compte TOUTES les dépenses ; « Voir la dépense » ne mène que vers celles que l'écran montre", async () => {
    SERVICE = dService;
    const vue = await getBudgetOverview(await acteur(u.sa), envelopeId);
    expect(vue, "prémisse : le Super Admin ouvre l'enveloppe").not.toBeNull();
    const mg = vue!.attributed.transactions.filter((t) => t.kind === "GENERAL_MEANS" && [depService, depAutre].includes(t.id));
    // Rien n'est retiré du budget : la dépense d'un autre département y est toujours COMPTÉE…
    expect(mg.map((t) => [t.id, t.amount]).sort()).toEqual([[depAutre, 3_500], [depService, 12_000]].sort());
    // … mais seule celle du service a un lien : l'écran des moyens généraux ne montre plus que lui.
    expect(mg.find((t) => t.id === depService)?.lien).toBe("/moyens-generaux");
    expect(mg.find((t) => t.id === depAutre)?.lien).toBeNull();
  });
});

/** La source sans ses commentaires — un cliquet ne s'accroche pas à la prose qui le décrit (§118.79d). */
const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Moyens généraux — plus aucune porte vers les autres départements à l'écran", () => {
  it("la page ne lit plus `?dept=` et ne monte plus de sélecteur de départements", () => {
    const page = sansCommentaires(readFileSync(path.join(RACINE, "src/app/(app)/moyens-generaux/page.tsx"), "utf8"));
    // PRÉMISSE : on lit bien la page qui résout le service — sans quoi l'absence ne prouverait rien.
    expect(page).toMatch(/resolveGeneralMeansDepartment\(user\)/);
    expect(page, "la page lit encore ?dept=").not.toMatch(/searchParams[^;]*\bdept\b|\.dept\b/);
    expect(page).not.toMatch(/DepartmentSwitcher/);
  });

  it("le Super Admin garde de quoi DÉSIGNER le service — sur l'écran du service ET sur l'écran vide, sinon le réglage n'a plus d'écrivain", () => {
    // Le seul geste qui écrit le réglage vivait sur l'écran d'un AUTRE département (« En faire le
    // service »), que plus personne ne peut ouvrir d'ici. Sans ces deux points d'appel, le service
    // ne se changerait plus jamais, et un Super Admin sans département resterait devant un écran
    // vide sans issue (§118.131, §118.63). Le POINT D'APPEL, pas le corps du composant (§118.49).
    const page = sansCommentaires(readFileSync(path.join(RACINE, "src/app/(app)/moyens-generaux/page.tsx"), "utf8"));
    expect(page.match(/<ChangerDeService departements=\{departements\}/g) ?? []).toHaveLength(2);
    expect(page, "l'écran vide du Super Admin propose la désignation ouverte d'office").toMatch(/<ChangerDeService departements=\{departements\} actuel=\{null\} ouvertParDefaut \/>/);
    expect(page, "l'écran du service la propose, fermée, à côté de l'état du réglage").toMatch(/<ChangerDeService departements=\{departements\} actuel=\{serviceCourant\} \/>/);
    // La liste des départements n'est chargée que pour le Super Admin : elle n'ouvre la caisse
    // d'aucun d'eux, mais rien ne justifie de la servir à qui ne peut rien en faire.
    expect(page).toMatch(/const departements = pilote\s*\?/);
  });

  it("EN-TÊTE : « Ajouter une dépense » et le menu ⋯ (catalogue) — la caisse, la liste et le service restent dans la PAGE (décisions du 04/10 puis du 09/10)", () => {
    const page = sansCommentaires(readFileSync(path.join(RACINE, "src/app/(app)/moyens-generaux/page.tsx"), "utf8"));
    // L'en-tête de la page de la CAISSE (celui qui porte le titre du service), pas ceux des écrans vides.
    const debut = page.lastIndexOf("<PageHeader", page.indexOf("title={pilote ?"));
    const fin = page.indexOf("</PageHeader>", debut);
    // PRÉMISSE : on isole bien l'en-tête — sans quoi les absences ci-dessous ne prouveraient rien.
    expect(debut).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(debut);
    const entete = page.slice(debut, fin);
    expect(entete, "le catalogue est derrière le ⋯ de l'en-tête").toMatch(/<EnteteMenu articles=\{catalogRows\} peutModifier \/>/);
    expect(entete, "le geste principal est dans l'en-tête").toMatch(/<ExpensePanel\b/);
    for (const interdit of [/ServiceSwitch/, /ChangerDeService/, /<Link/, /mon-espace\/annuaire/, /budgets\/departements/, /<CashPanel/, /<ExpenseTable/]) {
      expect(entete, `l'en-tête porte encore ${interdit}`).not.toMatch(interdit);
    }
  });

  it("POINT D'APPEL : la page rend la caisse d'avance, les dépenses et leurs gestes — rien de ce qui est enregistré n'est masqué", () => {
    const page = sansCommentaires(readFileSync(path.join(RACINE, "src/app/(app)/moyens-generaux/page.tsx"), "utf8"));
    expect(page).toMatch(/<CashPanel view=\{view\} people=\{people\} \/>/);
    expect(page).toMatch(/<ExpensePanel\b/);
    expect(page).toMatch(/<ExpenseTable\b/);
    expect(page, "une seule caisse : celle du service désigné").toMatch(/getGeneralMeans\(user, departmentId, year\)/);
    // Les gestes de la caisse existent dans le composant que la page monte (rallonge, remise, confirmation).
    const cash = readFileSync(path.join(RACINE, "src/app/(app)/moyens-generaux/cash-panel.tsx"), "utf8");
    for (const geste of ["allotPettyCash", "confirmPettyCashReceipt", "requestPettyCashTopUp", "decidePettyCashTopUp", "annulerRallongeCaisse"]) {
      expect(cash, `la caisse ne propose plus ${geste}`).toMatch(new RegExp(`${geste}\\(`));
    }
  });

  it("les notifications de la caisse mènent à la page qui porte le geste (constats 14 et 15 de l'audit du 04/10)", () => {
    for (const f of ["src/lib/finance/verser-remise.ts", "src/lib/actions/payment-centre-actions.ts"]) {
      // La page qui porte le geste, ouverte SUR la remise visée (`/moyens-generaux?cible=remise-<id>`).
      expect(sansCommentaires(readFileSync(path.join(RACINE, f), "utf8")), f).toMatch(/link: lienRemiseCaisse\(remise\.id\)/);
    }
    expect(lienRemiseCaisse("r1")).toMatch(/^\/moyens-generaux\?cible=/);
  });

  it("le sélecteur n'existe plus, et personne ne l'importe (une porte cachée vers ce qu'on a retiré de l'écran)", () => {
    expect(existsSync(path.join(RACINE, "src/app/(app)/moyens-generaux/department-switcher.tsx"))).toBe(false);
    const importeurs: string[] = [];
    const parcourir = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) { if (n !== "node_modules") parcourir(p); continue; }
        if (/\.tsx?$/.test(n) && /department-switcher/.test(sansCommentaires(readFileSync(p, "utf8")))) importeurs.push(path.relative(RACINE, p));
      }
    };
    parcourir(path.join(RACINE, "src"));
    expect(importeurs.filter((f) => !f.endsWith("general-means-service.test.ts"))).toEqual([]);
  });
});
