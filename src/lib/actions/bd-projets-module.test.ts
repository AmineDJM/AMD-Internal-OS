import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, canViewBdProjects, canManageBdProjects, MODULES, PERMISSIONS, ACTIONS, type SessionUser } from "@/lib/rbac";
import { isRetiredModule } from "@/lib/modules-retired";
import { NAVIGATION } from "@/lib/labels";
import { navigationFor } from "@/lib/nav-access";
import { navPaths } from "@/components/layout/sidebar";
import { canAccessEntity } from "@/lib/entity-access";
import { getBdProjectOptions, entiteProposee } from "@/lib/queries/bd";
import { executerAction } from "./executer";
import { saveModuleAccess } from "./access-actions";
import { setRegulatoryClassification } from "./regulatory-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bdmodule__";

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x); else f.set(k, v);
  }
  return f;
};

/** Les destinations du menu (`href`), sans les alias de surlignage. */
const destinations = (items: Awaited<ReturnType<typeof navigationFor>>): string[] =>
  items.flatMap((i) => [i.href, ...destinations(i.children ?? [])]);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « PROJETS » (BD) EST UN MODULE, RÉGLÉ PAR LE SUPER ADMIN — et chaque projet a son entité
 * (§118.163).
 *
 * Décision de la Direction (30/09/2026) : « le module Projets dans Business Development : donne la
 * permission au Super Admin de gérer l'accès au module depuis Super Admin » ; et « fais en sorte
 * que chaque projet soit associé à une société/entité, et donc visible ».
 *
 * Avant : une porte DÉDUITE de Regulatory (« quiconque voit Regulatory lit le registre ; seul le
 * Super Admin nomme ») et un chemin « maintenu » affiché à tout le monde. Aucune case de la console
 * ne l'ouvrait ni ne la fermait. Ce banc passe par les VRAIS points d'entrée : l'action de la
 * console (`saveModuleAccess`), la résolution d'accès (`getAccess`), le menu (`navigationFor`),
 * les actions du registre et la garde par enregistrement — jamais par une ligne posée à la main
 * là où un écran existe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("Projets — un module à part, et Market Intelligence reste retiré", () => {
  it("BUSINESS_DEVELOPMENT est TOUJOURS retiré ; BD_PROJECTS est un module en service", () => {
    expect(isRetiredModule("BUSINESS_DEVELOPMENT")).toBe(true);
    expect((MODULES as readonly string[]).includes("BD_PROJECTS")).toBe(true);
    expect(isRetiredModule("BD_PROJECTS")).toBe(false);
  });

  it("LE DÉFAUT : chaque rôle qui voit Regulatory LIT le registre — les mêmes personnes qu'hier", () => {
    // Le jour où la règle change de forme, personne ne doit perdre l'écran : le défaut du module
    // reproduit EXACTEMENT la porte d'avant (voir Regulatory ⇒ lire le registre, rien de plus).
    for (const [role, matrice] of Object.entries(PERMISSIONS)) {
      if (role === "SUPER_ADMIN") {
        expect(matrice.BD_PROJECTS, "le Super Admin tient tout").toEqual([...ACTIONS]);
        continue;
      }
      if (matrice.REGULATORY?.includes("VIEW")) {
        expect(matrice.BD_PROJECTS, `${role} voit Regulatory : il lit le registre, et rien de plus`).toEqual(["VIEW"]);
      } else {
        expect(matrice.BD_PROJECTS, `${role} ne voit pas Regulatory : pas de registre par défaut`).toBeUndefined();
      }
    }
  });

  it("l'entrée de menu porte le MODULE, plus une garde déduite", () => {
    const entree = NAVIGATION.find((n) => n.href === "/business-development/projets");
    expect(entree?.module).toBe("BD_PROJECTS");
    expect(entree?.gate, "une garde à côté du module serait une seconde porte que la console ne règle pas").toBeUndefined();
  });

  it("l'entité PROPOSÉE est celle de TOUS les dossiers — sinon rien", () => {
    expect(entiteProposee(["A", "A", null])).toBe("A");
    expect(entiteProposee(["A", "B"]), "deux sociétés : choisir serait décider à la place d'une personne").toBeNull();
    expect(entiteProposee([])).toBeNull();
    expect(entiteProposee([null, null])).toBeNull();
  });
});

suite("Projets — réglé dans la console, et chaque projet appartient à une entité", () => {
  let pdgId = "", regId = "", regBId = "", etrId = "";
  let coA = "", coB = "";
  let projetA = "", projetB = "", projetSans = "", dossierB = "";

  beforeAll(async () => {
    await nettoyer();
    const [a, b] = await Promise.all([
      prisma.company.create({ data: { name: `${TAG}Société A` } }),
      prisma.company.create({ data: { name: `${TAG}Société B` } }),
    ]);
    coA = a.id; coB = b.id;
    const [pdg, reg, regB, etr] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}reg`, email: `${TAG}reg@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}regb`, email: `${TAG}regb@t.dz`, role: "HEAD_OF_REGULATORY", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}etr`, email: `${TAG}etr@t.dz`, role: "COORDINATOR", passwordHash: "x" } }),
    ]);
    pdgId = pdg.id; regId = reg.id; regBId = regB.id; etrId = etr.id;
    // L'entité d'APPARTENANCE — c'est elle qui cloisonne un salarié mono-entité.
    await prisma.employee.create({ data: { fullName: `${TAG}reg`, userId: regId, companyId: coA } });
    await prisma.employee.create({ data: { fullName: `${TAG}regb`, userId: regBId, companyId: coB } });
    const [pa, pb, p0, d] = await Promise.all([
      prisma.bdProject.create({ data: { name: `${TAG}Projet A`, companyId: coA, createdById: pdgId } }),
      prisma.bdProject.create({ data: { name: `${TAG}Projet B`, companyId: coB, createdById: pdgId } }),
      prisma.bdProject.create({ data: { name: `${TAG}Projet d'avant`, createdById: pdgId } }),
      prisma.regulatoryProduct.create({ data: { reference: `${TAG}REG-B`, dci: "Nivolex", companyId: coB, createdById: pdgId } }),
    ]);
    projetA = pa.id; projetB = pb.id; projetSans = p0.id; dossierB = d.id;
  }, 120_000);

  afterAll(nettoyer, 120_000);

  async function nettoyer() {
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  /** La console « par module » — le geste exact du Super Admin, jamais une ligne posée à la main. */
  async function reglerDansLaConsole(userId: string, mode: "CUSTOM" | "BLOCKED" | "DEFAULT", actions: string[] = []) {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const champs: Record<string, string | string[]> = { module: "BD_PROJECTS", userId, [`mode_${userId}`]: mode };
    for (const a of actions) champs[`act_${userId}_${a}`] = "on";
    const r = await saveModuleAccess(fd(champs));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }

  it("le Super Admin CRÉE un projet dans une entité — la ligne porte son entité", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "bd-project-actions:createBdProject", {
      name: `${TAG}Oncologie 2027`, status: "IN_PROGRESS", companyId: coA,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ligne = await prisma.bdProject.findFirst({ where: { name: `${TAG}Oncologie 2027` } });
    expect(ligne, "aucune ligne : le succès annoncé serait un faux succès").not.toBeNull();
    expect(ligne!.companyId).toBe(coA);
  });

  it("SANS entité déterminable, la création est REFUSÉE — elle ne naît jamais sans société", async () => {
    // Le Super Admin voit tout le groupe et n'a pas de fiche salarié : aucune entité ne se déduit.
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const r = await executerAction(ACTEUR, "bd-project-actions:createBdProject", { name: `${TAG}Sans société` });
    expect(r.ok).toBe(false);
    // Le refus NOMME le geste (choisir l'entité) — pas celui d'une entité fermée, qui dirait autre
    // chose et laisserait croire qu'une société a été devinée puis refusée (§118.30).
    expect(JSON.stringify(r)).toContain("Choisissez l'entité (société) du projet");
    expect(await prisma.bdProject.findFirst({ where: { name: `${TAG}Sans société` } })).toBeNull();
  });

  it("par DÉFAUT, un responsable Regulatory LIT le registre et ne le nomme pas — le refus dit où cocher", async () => {
    const reg = await acteur(regId, "HEAD_OF_REGULATORY");
    expect(canViewBdProjects(reg)).toBe(true);
    expect(userCan(reg, "BD_PROJECTS", "CREATE")).toBe(false);
    ACTEUR = reg;
    const r = await executerAction(ACTEUR, "bd-project-actions:createBdProject", { name: `${TAG}interdit`, companyId: coA });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r), "un « non autorisé » sans remède fait chercher un bug").toContain("Administration › Accès");
    expect(await prisma.bdProject.findFirst({ where: { name: `${TAG}interdit` } })).toBeNull();
  });

  it("LA DEMANDE : le Super Admin lui ACCORDE la création depuis la console — et elle marche", async () => {
    await reglerDansLaConsole(regId, "CUSTOM", ["CREATE", "UPDATE"]);
    const reg = await acteur(regId, "HEAD_OF_REGULATORY");
    expect(userCan(reg, "BD_PROJECTS", "CREATE")).toBe(true);
    ACTEUR = reg;
    // Sans entité choisie : celle où il TRAVAILLE (sa société d'appartenance).
    const r = await executerAction(ACTEUR, "bd-project-actions:createBdProject", { name: `${TAG}Cardio 2028` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ligne = await prisma.bdProject.findFirst({ where: { name: `${TAG}Cardio 2028` } });
    expect(ligne?.companyId).toBe(coA);
  });

  it("… mais jamais dans une entité qu'il ne voit pas", async () => {
    ACTEUR = await acteur(regId, "HEAD_OF_REGULATORY");
    const r = await executerAction(ACTEUR, "bd-project-actions:createBdProject", { name: `${TAG}Chez B`, companyId: coB });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("pas ouverte");
    expect(await prisma.bdProject.findFirst({ where: { name: `${TAG}Chez B` } })).toBeNull();
  });

  it("VISIBLE PAR SON ENTITÉ : chacun voit les projets de sa société, et ceux pas encore rattachés", async () => {
    const reg = await acteur(regId, "HEAD_OF_REGULATORY");
    const regB = await acteur(regBId, "HEAD_OF_REGULATORY");
    const pdg = await acteur(pdgId, "SUPER_ADMIN");
    const ids = async (u: CurrentUser) => (await getBdProjectOptions(u)).map((p) => p.id);
    const vusA = await ids(reg), vusB = await ids(regB), vusPdg = await ids(pdg);
    expect(vusA).toContain(projetA);
    expect(vusA, "un projet de la société B n'apparaît pas dans la vue d'un salarié de A").not.toContain(projetB);
    expect(vusB).toContain(projetB);
    expect(vusB).not.toContain(projetA);
    // Un projet d'avant, sans entité, reste visible — sinon on ne pourrait jamais le rattacher.
    expect(vusA).toContain(projetSans);
    expect(vusB).toContain(projetSans);
    expect(vusPdg).toEqual(expect.arrayContaining([projetA, projetB, projetSans]));
    // La garde par enregistrement dit la MÊME chose que la liste.
    expect(await canAccessEntity(regB, "BD_PROJECT", projetA, "VIEW")).toBe(false);
    expect(await canAccessEntity(reg, "BD_PROJECT", projetA, "VIEW")).toBe(true);
  });

  it("le CLASSEMENT d'un dossier n'accepte que les projets que le menu propose", async () => {
    ACTEUR = await acteur(regBId, "HEAD_OF_REGULATORY");
    const refus = await setRegulatoryClassification(fd({ id: dossierB, bdProjectId: projetA }));
    expect(refus.ok, "un projet d'une autre société, invisible au menu, ne doit pas pouvoir être posé").toBe(false);
    expect(await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierB }, select: { bdProjectId: true } }))
      .toEqual({ bdProjectId: null });
    const ok = await setRegulatoryClassification(fd({ id: dossierB, bdProjectId: projetB }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect((await prisma.regulatoryProduct.findUniqueOrThrow({ where: { id: dossierB } })).bdProjectId).toBe(projetB);
  });

  it("MODIFIER garde l'entité ; la rattacher se fait par un choix explicite, et jamais on ne la retire", async () => {
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    // Renommer sans toucher à l'entité : elle reste.
    let r = await executerAction(ACTEUR, "bd-project-actions:updateBdProject", { id: projetA, name: `${TAG}Projet A renommé` });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await prisma.bdProject.findUniqueOrThrow({ where: { id: projetA } })).companyId).toBe(coA);
    // Un projet d'avant reçoit son entité.
    r = await executerAction(ACTEUR, "bd-project-actions:updateBdProject", { id: projetSans, name: `${TAG}Projet d'avant`, companyId: coB });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await prisma.bdProject.findUniqueOrThrow({ where: { id: projetSans } })).companyId).toBe(coB);
    // Une valeur vide ne détache pas.
    const f = fd({ id: projetSans, name: `${TAG}Projet d'avant`, companyId: "" });
    ACTEUR = await acteur(pdgId, "SUPER_ADMIN");
    const { updateBdProject } = await import("./bd-project-actions");
    expect((await updateBdProject(f)).ok).toBe(true);
    expect((await prisma.bdProject.findUniqueOrThrow({ where: { id: projetSans } })).companyId).toBe(coB);
  });

  it("LA DEMANDE, L'AUTRE SENS : le Super Admin OUVRE le module à quelqu'un qui n'a pas Regulatory", async () => {
    const avant = await acteur(etrId, "COORDINATOR");
    // PRÉMISSE : sans elle, ce cas passerait au vert le jour où le coordinateur gagnerait Regulatory.
    expect(userCan(avant, "REGULATORY", "VIEW")).toBe(false);
    expect(canViewBdProjects(avant)).toBe(false);
    expect(destinations(await navigationFor(avant))).not.toContain("/business-development/projets");
    await reglerDansLaConsole(etrId, "CUSTOM");
    const apres = await acteur(etrId, "COORDINATOR");
    expect(canViewBdProjects(apres)).toBe(true);
    expect(canManageBdProjects(apres), "ouvrir en lecture n'accorde pas l'écriture").toBe(false);
    expect(destinations(await navigationFor(apres)), "le menu suit le droit accordé").toContain("/business-development/projets");
  });

  it("… et il le FERME à quelqu'un qui voit Regulatory — le menu, la liste et la fiche suivent", async () => {
    const avant = await acteur(regBId, "HEAD_OF_REGULATORY");
    expect(canViewBdProjects(avant)).toBe(true);
    await reglerDansLaConsole(regBId, "BLOCKED");
    const apres = await acteur(regBId, "HEAD_OF_REGULATORY");
    expect(userCan(apres, "REGULATORY", "VIEW"), "Regulatory, lui, reste ouvert : on n'a fermé que Projets").toBe(true);
    expect(canViewBdProjects(apres)).toBe(false);
    expect(destinations(await navigationFor(apres))).not.toContain("/business-development/projets");
    expect(await getBdProjectOptions(apres)).toEqual([]);
    expect(await canAccessEntity(apres, "BD_PROJECT", projetB, "VIEW")).toBe(false);
    // « Par défaut » rend la porte d'avant.
    await reglerDansLaConsole(regBId, "DEFAULT");
    expect(canViewBdProjects(await acteur(regBId, "HEAD_OF_REGULATORY"))).toBe(true);
  });

  it("SUPPRIMER, accordé par la console : l'aperçu et l'action suivent le droit ET l'entité de la ligne", async () => {
    const { apercuDeSuppression } = await import("./admin-delete-actions");
    const { deleteBdProject } = await import("./bd-project-actions");
    // PRÉMISSE : sans le droit, l'aperçu se ferme — sinon la suite ne mesurerait rien.
    ACTEUR = await acteur(regId, "HEAD_OF_REGULATORY");
    expect(userCan(ACTEUR, "BD_PROJECTS", "DELETE")).toBe(false);
    expect("erreur" in (await apercuDeSuppression(fd({ kind: "BD_PROJECT", id: projetA })))).toBe(true);
    await reglerDansLaConsole(regId, "CUSTOM", ["DELETE"]);
    ACTEUR = await acteur(regId, "HEAD_OF_REGULATORY");
    expect(userCan(ACTEUR, "BD_PROJECTS", "DELETE")).toBe(true);
    // Un projet de SA société : l'aperçu s'ouvre (le bouton s'armera).
    expect("erreur" in (await apercuDeSuppression(fd({ kind: "BD_PROJECT", id: projetA })))).toBe(false);
    // Un projet d'une AUTRE société : ni aperçu, ni suppression — le droit du module ne suffit pas.
    expect("erreur" in (await apercuDeSuppression(fd({ kind: "BD_PROJECT", id: projetB })))).toBe(true);
    const refus = await deleteBdProject(fd({ id: projetB }));
    expect(refus.ok).toBe(false);
    expect(await prisma.bdProject.findUnique({ where: { id: projetB } })).not.toBeNull();
    // Et la suppression accordée passe par la corbeille.
    const ok = await deleteBdProject(fd({ id: projetA }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(await prisma.bdProject.findUnique({ where: { id: projetA } })).toBeNull();
    const rec = await prisma.deletedRecord.findFirst({ where: { kind: "BD_PROJECT", sourceId: projetA } });
    expect(rec?.deletedById, "réversible, au nom de qui l'a fait").toBe(regId);
    await prisma.deletedRecord.deleteMany({ where: { kind: "BD_PROJECT", sourceId: projetA } });
  });

  it("MARKET INTELLIGENCE RESTE FERMÉ — l'empreinte n'a pas débordé", async () => {
    const pdg = await acteur(pdgId, "SUPER_ADMIN");
    expect(userCan(pdg, "BUSINESS_DEVELOPMENT", "CREATE")).toBe(false);
    ACTEUR = pdg;
    const r = await executerAction(ACTEUR, "bd-actions:createBD", { dci: `${TAG}molecule`, brandName: `${TAG}marque` });
    expect(r.ok, "createBD (Market Intelligence) ne doit PAS être rouvert").toBe(false);
  });

  it("LE MENU y mène, et à rien d'autre sous /business-development (§118.50)", async () => {
    const nav = await navigationFor(await acteur(pdgId, "SUPER_ADMIN"));
    const cibles = destinations(nav);
    expect(cibles).toContain("/business-development/projets");
    expect(cibles.filter((c) => c.startsWith("/business-development"))).toEqual(["/business-development/projets"]);
    expect(nav.flatMap(navPaths)).not.toContain("/business-development");
  });
});
