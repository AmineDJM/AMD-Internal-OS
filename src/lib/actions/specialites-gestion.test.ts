import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, peutGererSpecialites, userCan, type SessionUser } from "@/lib/rbac";
import { visibleTabs } from "@/lib/nav-tabs";
import { ANNUAIRES_TABS, MARKETING_COCKPIT_TABS } from "@/lib/labels";
import {
  createSpecialty, updateSpecialty, deleteSpecialty, fusionnerSpecialite, rattacherLibelleSpecialite,
} from "@/lib/actions/medical-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GESTION DU RÉFÉRENTIEL DES SPÉCIALITÉS AUX DEUX DIRECTEURS DES OPÉRATIONS (Direction, 04/10) :
 * « donne la gestion/création des spécialités au directeur des opérations ». `DIRECTION`
 * (« Direction des opérations ») et `OPERATIONS_DIRECTOR` (« Directeur des Opérations ») créent,
 * renomment, rattachent, fusionnent et retirent — par les VRAIES actions. Le second n'a de la
 * Promotion médicale que la lecture, et pas de vue globale : c'est lui qui prouve la règle (§118.104).
 * Un délégué médical garde ce qu'il avait (la Promotion médicale en contribution : ajouter,
 * renommer, rattacher dans son panel) et n'obtient PAS la structure : ni fusion, ni retrait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "ZZGSPE";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function acteur(id: string, role: string, secondaryRole: string | null = null): Promise<SessionUser> {
  return { id, role, secondaryRole, access: await getAccess(id, role as never) } as unknown as SessionUser;
}

describe("le point d'appel — une règle, lue par l'onglet, la page et les cinq actions", () => {
  const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  it("les cinq actions du référentiel appellent `peutGererSpecialites`, et plus le droit de module seul", () => {
    const src = code("src/lib/actions/medical-actions.ts");
    for (const [fn, geste] of [
      ["createSpecialty", "CREATE"], ["updateSpecialty", "UPDATE"], ["deleteSpecialty", "DELETE"],
      ["fusionnerSpecialite", "DELETE"], ["rattacherLibelleSpecialite", "UPDATE"],
    ] as const) {
      const debut = src.indexOf(`export async function ${fn}(`);
      expect(debut, fn).toBeGreaterThan(-1);
      const corps = src.slice(debut, debut + 400);
      expect(corps, fn).toContain(`peutGererSpecialites(user, "${geste}")`);
      expect(corps, fn).not.toMatch(/userCan\(user, "MEDICAL"/);
    }
  });
  it("la page lit la même règle pour s'ouvrir et pour chaque bouton", () => {
    // L'écran est le composant partagé (§118.209) : la règle se lit dans le composant.
    // Porte unique : Annuaires › Spécialités (Direction, 07/10) ; l'ancienne adresse du Marketing cockpit y MÈNE.
    expect(code("src/app/(app)/marketing-cockpit/specialites/page.tsx")).toContain('redirect("/annuaires/specialites")');
    const page = code("src/app/(app)/annuaires/specialites/page.tsx");
    expect(page).toContain(`peutGererSpecialites(user, "VIEW")`);
    expect(page).toContain("<EcranSpecialites user={user} />");
    const src = code("src/components/directory/ecran-specialites.tsx");
    for (const g of ["VIEW", "CREATE", "UPDATE", "DELETE"]) expect(src).toContain(`peutGererSpecialites(user, "${g}")`);
    expect(src).not.toMatch(/userCan\(/);
  });
});

suite("le référentiel des spécialités — les deux directeurs des opérations le gèrent, un délégué n'en fait pas la structure", () => {
  let dirOps = "", direction = "", delegue = "", viewer = "";
  let OD: SessionUser, DIR: SessionUser, DEL: SessionUser;

  const nettoyer = async () => {
    const spes = await prisma.medicalSpecialty.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "SPECIALTY", entityId: { in: spes.map((s) => s.id) } } }).catch(() => {});
    await prisma.medicalSpecialty.deleteMany({ where: { id: { in: spes.map((s) => s.id) } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG.toLowerCase() } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG.toLowerCase()}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, b, c, d] = await Promise.all([
      mk("dirops", "OPERATIONS_DIRECTOR"), mk("direction", "DIRECTION"), mk("delegue", "MEDICAL_DELEGATE"), mk("viewer", "VIEWER"),
    ]);
    dirOps = a.id; direction = b.id; delegue = c.id; viewer = d.id;
    OD = await acteur(dirOps, "OPERATIONS_DIRECTOR");
    DIR = await acteur(direction, "DIRECTION");
    DEL = await acteur(delegue, "MEDICAL_DELEGATE");
  });

  afterAll(nettoyer);

  it("les acteurs sont ce que le banc croit qu'ils sont", () => {
    expect(hasGlobalView(OD.role), "prémisse : le Directeur des Opérations n'a pas la vue globale").toBe(false);
    expect(userCan(OD, "MEDICAL", "VIEW")).toBe(true);
    for (const g of ["CREATE", "UPDATE", "DELETE"] as const) {
      expect(userCan(OD, "MEDICAL", g), `prémisse : sans la règle, il n'aurait pas ${g}`).toBe(false);
    }
    expect(userCan(DEL, "MEDICAL", "DELETE"), "prémisse : le délégué ne supprime pas dans la Promotion médicale").toBe(false);
  });

  it("le Directeur des Opérations : créer, renommer, rattacher un libellé, fusionner, retirer — par les vraies actions", async () => {
    ACTEUR = OD;
    const a = await createSpecialty(fd({ name: `${TAG}Néphrologie` }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    const b = await createSpecialty(fd({ name: `${TAG}Nephro bis` }));
    expect(b.ok, b.ok ? "" : b.error).toBe(true);
    const idA = a.ok ? a.id! : "", idB = b.ok ? b.id! : "";

    const r = await updateSpecialty(fd({ id: idB, name: `${TAG}Néphro pédiatrique` }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.medicalSpecialty.findUniqueOrThrow({ where: { id: idB } })).name).toBe(`${TAG}Néphro pédiatrique`);

    const fiche = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Libellé`, specialty: `${TAG}nephro` }, select: { id: true } });
    const ra = await rattacherLibelleSpecialite(fd({ libelle: `${TAG}nephro`, specialtyId: idA }));
    expect(ra.ok, ra.ok ? "" : ra.error).toBe(true);
    expect(ra.rattachees).toBe(1);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fiche.id } })).specialtyId).toBe(idA);

    const fu = await fusionnerSpecialite(fd({ id: idB, cibleId: idA }));
    expect(fu.ok, fu.ok ? "" : fu.error).toBe(true);
    expect(await prisma.medicalSpecialty.count({ where: { id: idB } })).toBe(0);

    const de = await deleteSpecialty(fd({ id: idA }));
    expect(de.ok, de.ok ? "" : de.error).toBe(true);
    expect(await prisma.medicalSpecialty.count({ where: { id: idA } })).toBe(0);
  });

  it("la Direction des opérations : la même gestion, par les mêmes actions", async () => {
    ACTEUR = DIR;
    const a = await createSpecialty(fd({ name: `${TAG}Rhumatologie` }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    const de = await deleteSpecialty(fd({ id: a.ok ? a.id! : "" }));
    expect(de.ok, de.ok ? "" : de.error).toBe(true);
  });

  it("un délégué : ni fusion ni retrait — la STRUCTURE du référentiel ne lui est pas ouverte", async () => {
    ACTEUR = DIR;
    const a = await createSpecialty(fd({ name: `${TAG}Gériatrie` }));
    const b = await createSpecialty(fd({ name: `${TAG}Gériatrie bis` }));
    const idA = a.ok ? a.id! : "", idB = b.ok ? b.id! : "";
    ACTEUR = DEL;
    expect(await fusionnerSpecialite(fd({ id: idB, cibleId: idA }))).toEqual({ ok: false, error: "Non autorisé." });
    expect(await deleteSpecialty(fd({ id: idA }))).toEqual({ ok: false, error: "Non autorisé." });
    expect(await prisma.medicalSpecialty.count({ where: { id: { in: [idA, idB] } } })).toBe(2);
    expect(peutGererSpecialites(DEL, "DELETE")).toBe(false);
  });

  it("UNE porte d'entrée (Direction, 07/10) : Annuaires › Spécialités, qui suit la règle ; le Marketing cockpit n'en porte plus", async () => {
    expect(MARKETING_COCKPIT_TABS.some((t) => t.label === "Spécialités")).toBe(false);
    const onglet = async (u: SessionUser) => (await visibleTabs(u, ANNUAIRES_TABS)).find((t) => t.href === "/annuaires/specialites")?.show;
    expect(await onglet(OD)).toBe(true);
    expect(await onglet(DIR)).toBe(true);
    const nu = await acteur(viewer, "VIEWER");
    nu.access.modules.delete("MEDICAL");
    expect(await onglet(nu)).toBe(false);
    expect(userCan(nu, "MEDICAL", "VIEW")).toBe(false);
  });
});
