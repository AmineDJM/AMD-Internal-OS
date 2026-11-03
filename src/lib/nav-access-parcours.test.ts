import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, canViewBdProjects, peutVoirAdam, type SessionUser } from "@/lib/rbac";
import { navigationFor } from "@/lib/nav-access";
import type { NavItem } from "@/lib/labels";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__navparcours__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const destinations = (items: NavItem[]): string[] => items.flatMap((i) => [i.href, ...destinations(i.children ?? [])]);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MENU DANS LA PEAU DES GENS (§118.153).
 *
 * Deux défauts trouvés en parcourant le menu rôle par rôle, dans le navigateur, et qu'aucun test
 * ne tenait parce que tous éprouvaient le menu du Super Admin :
 *   • « Projets » (BD) était affiché à TOUT LE MONDE — un chemin maintenu s'affiche par son
 *     adresse — alors que l'écran ne s'ouvre qu'à qui voit Regulatory ;
 *   • « Mon Équipe » dépliait un sous-menu d'UN seul lien, identique au parent, chez chaque
 *     encadrant qui n'a pas le recrutement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("le menu d'un employé ordinaire ne promet que ce qui s'ouvre", () => {
  const u: Record<string, string> = {};

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("ns", "NATIONAL_SALES");
    await mk("kam", "MEDICAL_DELEGATE");
    await mk("dir", "DIRECTION");
    await mk("rep", "SALES_USER");
    await mk("sa", "SUPER_ADMIN");
    const ns = await prisma.employee.create({ data: { fullName: `${TAG} ns`, userId: u.ns } });
    await prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, managerId: ns.id } });
    const dir = await prisma.employee.create({ data: { fullName: `${TAG} dir`, userId: u.dir } });
    await prisma.employee.create({ data: { fullName: `${TAG} rep`, userId: u.rep, managerId: dir.id } });
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG }, managerId: { not: null } } });
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } });
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  }

  it("« Projets » n'est PAS au menu de qui ne voit pas Regulatory", async () => {
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    // PRÉMISSE : sans elle, le cas passerait au vert le jour où le délégué gagnerait Regulatory.
    expect(canViewBdProjects(kam)).toBe(false);
    expect(destinations(await navigationFor(kam))).not.toContain("/business-development/projets");
  });

  it("… et il y est pour qui voit Regulatory — la garde ne ferme que ce qu'elle doit", async () => {
    const dir = await acteur(u.dir, "DIRECTION");
    expect(canViewBdProjects(dir)).toBe(true);
    expect(destinations(await navigationFor(dir))).toContain("/business-development/projets");
  });

  it("« Mon Équipe » est une entrée simple — le recrutement n'y est plus, même pour qui l'a", async () => {
    const ns = await acteur(u.ns, "NATIONAL_SALES");
    // PRÉMISSES : il encadre (sinon l'entrée n'existe pas du tout) et A le recrutement — n'importe qui peut
    // demander un poste (Direction, 07/10) : l'absence de sous-menu vient du déplacement, pas d'un droit manquant.
    expect(userCan(ns, "RECRUITMENT", "CREATE")).toBe(true);
    const menu = await navigationFor(ns);
    const equipe = menu.find((i) => i.href === "/mon-equipe");
    expect(equipe, "l'encadrant doit voir « Mon Équipe »").toBeDefined();
    expect(equipe?.children ?? []).toEqual([]);
    // … et le recrutement l'attend sous les Ressources humaines.
    const rh = menu.find((i) => i.label === "Ressources humaines");
    expect((rh?.children ?? []).map((c) => c.href)).toContain("/recrutement");
  });

  it("Adam (assistant ET chief of staff) n'est PAS au menu de la Direction — qui n'a pas le module ASSISTANT_IA", async () => {
    const dir = await acteur(u.dir, "DIRECTION");
    // PRÉMISSES : les modules sont là ; sans elles, l'absence viendrait du module, pas de la règle.
    expect(userCan(dir, "WORKSPACE", "VIEW")).toBe(true);
    expect(userCan(dir, "CHIEF_OF_STAFF", "VIEW")).toBe(true);
    expect(peutVoirAdam(dir)).toBe(false);
    const d = destinations(await navigationFor(dir));
    expect(d).not.toContain("/assistant");
    expect(d).not.toContain("/chief-of-staff");
  });

  it("… et il y est pour le Super Admin — la garde ne ferme que ce qu'elle doit", async () => {
    const sa = await acteur(u.sa, "SUPER_ADMIN");
    // « My Chief of Staff » est mis de côté pour TOUT LE MONDE, Super Admin compris (02/11/2026) : son bureau est un
    // onglet d'Adam. Adam et ses missions restent au menu.
    const d = destinations(await navigationFor(sa));
    expect(d).toEqual(expect.arrayContaining(["/assistant", "/centre-de-missions"]));
    expect(d).not.toContain("/chief-of-staff");
  });

  it("… et le recrutement est un sous-module des Ressources humaines, une seule fois dans le menu", async () => {
    const dir = await acteur(u.dir, "DIRECTION");
    expect(userCan(dir, "RECRUITMENT", "VIEW")).toBe(true);
    const menu = await navigationFor(dir);
    const equipe = menu.find((i) => i.href === "/mon-equipe");
    expect(equipe?.children ?? []).toEqual([]);
    const rh = menu.find((i) => i.label === "Ressources humaines");
    expect((rh?.children ?? []).map((c) => c.href)).toContain("/recrutement");
    expect(destinations(menu).filter((d) => d === "/recrutement")).toHaveLength(1);
  });
});
