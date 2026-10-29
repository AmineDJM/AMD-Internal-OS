import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const revalides: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => { revalides.push(p); } }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import fs from "node:fs";
import React from "react";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, peutGererSpecialites, userCan, type SessionUser } from "@/lib/rbac";
import {
  createSpecialty, updateSpecialty, deleteSpecialty, fusionnerSpecialite, rattacherLibelleSpecialite,
} from "@/lib/actions/medical-actions";
import { OPS_BY_TOOL } from "@/lib/assistant/ops/catalog";
import { EcranSpecialites } from "@/components/directory/ecran-specialites";
import PlanningSpecialitesPage from "@/app/(app)/annuaires/specialites/page";
import { ANNUAIRES_TABS, BUSINESS_UNITS_TABS, SALES_PLANNING_TABS } from "@/lib/labels";
import { CHEMINS_SPECIALITES } from "@/lib/annuaires/specialites";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FORCE DE VENTE › SPÉCIALITÉS, À LA DIRECTION MARKETING (Direction, 05/10, §118.209) :
 * « donne la gestion des spécialités, dans Force de vente, dans un onglet à part au marketing —
 * ils peuvent ajouter, supprimer, modifier ».
 *
 * Les acteurs n'ont PAS la vue globale (§118.104) : la Direction Marketing (`PRODUCT_MANAGER`) n'a que
 * la LECTURE de la Promotion médicale et de la Force de vente — c'est elle qui prouve que la règle
 * précise suffit, sans élargir un module. Le Manager Promotion médicale la gère par son droit de
 * module. Un rôle sans rien de tout cela (Logistique) est refusé : page ET action.
 *
 * Les noms portent le préfixe du banc : la base est partagée (§118.91).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "ZZFDVSPE";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
async function acteur(id: string, role: string, secondaryRole: string | null = null): Promise<SessionUser> {
  return { id, role, secondaryRole, access: await getAccess(id, role as never) } as unknown as SessionUser;
}
// Les composants se lisent en JSX « classique » sous vitest : on appelle leurs fonctions, on ne les monte pas.
(globalThis as { React?: unknown }).React = React;
const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

describe("les points d'appel — une règle, un écran, une liste de chemins", () => {
  it("UNE porte (Annuaires, 07/10) monte le composant, qui lit la règle ; l'ancienne adresse du Marketing cockpit y mène", () => {
    expect(code("src/app/(app)/marketing-cockpit/specialites/page.tsx")).toContain('redirect("/annuaires/specialites")');
    for (const rel of ["src/app/(app)/annuaires/specialites/page.tsx"]) {
      const src = code(rel);
      expect(src, rel).toContain("<EcranSpecialites user={user} />");
      expect(src, rel).toContain(`peutGererSpecialites(user, "VIEW")`);
      expect(src, rel).not.toContain("SpecialitesTable");
    }
    const ecran = code("src/components/directory/ecran-specialites.tsx");
    for (const g of ["VIEW", "CREATE", "UPDATE", "DELETE"]) expect(ecran).toContain(`peutGererSpecialites(user, "${g}")`);
    expect(ecran).not.toMatch(/userCan\(/);
  });

  it("la page des Annuaires garde sa porte AVANT de charger quoi que ce soit", () => {
    const src = code("src/app/(app)/annuaires/specialites/page.tsx");
    expect(src.indexOf("requireUser")).toBeGreaterThan(-1);
    expect(src.indexOf("requireUser")).toBeLessThan(src.indexOf(`peutGererSpecialites(user, "VIEW")`));
    expect(src.indexOf(`peutGererSpecialites(user, "VIEW")`)).toBeLessThan(src.indexOf("<EcranSpecialites"));
  });

  it("Messages et Spécialités ont quitté la Force de vente : plus d'onglet, les anciennes adresses renvoient à leur nouvelle place", () => {
    const racine = path.join(process.cwd(), "src/app/(app)/planning");
    const pages = ["page.tsx", ...fs.readdirSync(racine, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${d.name}/page.tsx`)]
      .filter((p) => fs.existsSync(path.join(racine, p)));
    // LES ONGLETS VIVENT DANS `SALES_PLANNING_TABS` (07/10) et les pages d'onglet les montent par leur en-tête commun.
    const avecBarre = pages.filter((p) => /<EnteteFdv\b/.test(code(`src/app/(app)/planning/${p}`)));
    expect(avecBarre.length, "prémisse : la découverte voit les pages d'onglets").toBeGreaterThanOrEqual(3);
    for (const t of SALES_PLANNING_TABS) expect(t.href).not.toMatch(/specialites|messages/);
    expect(code("src/app/(app)/planning/specialites/page.tsx")).toContain('redirect("/annuaires/specialites")');
    expect(code("src/app/(app)/planning/messages/page.tsx")).toContain('redirect("/marketing-cockpit?vue=messages")');
  });

  it("une écriture du référentiel revalide TOUS les écrans qui le montent, et une seule liste les nomme", () => {
    expect([...CHEMINS_SPECIALITES]).toEqual(["/annuaires/specialites"]);
    for (const rel of ["src/lib/actions/medical-actions.ts", "src/lib/actions/sales-planning-actions.ts"]) {
      const src = code(rel);
      expect(src, rel).not.toMatch(/revalidatePath\("\/annuaires\/specialites"\)/);
      expect(src, rel).toContain("CHEMINS_SPECIALITES");
    }
  });

  it("les trois ops d'Adam lisent la même règle que l'écran, plus le droit de module seul", () => {
    const src = code("src/lib/assistant/ops/catalogue/stocks-annuaire.ts");
    for (const [op, geste] of [["create_specialty", "CREATE"], ["update_specialty", "UPDATE"], ["delete_specialty", "DELETE"]] as const) {
      const debut = src.indexOf(`op: "${op}"`);
      expect(debut, op).toBeGreaterThan(-1);
      const corps = src.slice(debut, debut + 700);
      expect(corps, op).toContain(`gate: (u) => peutGererSpecialites(u, "${geste}")`);
      expect(corps, op).not.toMatch(/gate: \(u\) => userCan\(u, "MEDICAL"/);
    }
  });
});

suite("la Direction Marketing gère le référentiel depuis la Force de vente — un rôle sans accès est refusé, page ET action", () => {
  let dm = "", mpm = "", logi = "", natSales = "", deleg = "", buId = "";
  let DM: SessionUser, MPM: SessionUser, LOGI: SessionUser, NS: SessionUser, DMSEC: SessionUser, BLOQ: SessionUser;

  const nettoyer = async () => {
    const spes = await prisma.medicalSpecialty.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const ids = spes.map((s) => s.id);
    await prisma.businessUnitSpecialty.deleteMany({ where: { OR: [{ specialtyId: { in: ids } }, { businessUnit: { name: { startsWith: TAG } } }] } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "SPECIALTY", entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalSpecialty.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG.toLowerCase() } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG.toLowerCase()}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, b, c, d, e] = await Promise.all([
      mk("dm", "PRODUCT_MANAGER"), mk("mpm", "MEDICAL_PROMOTION_MANAGER"), mk("logi", "LOGISTICS_MANAGER"), mk("ns", "NATIONAL_SALES"),
      mk("deleg", "MEDICAL_DELEGATE"),
    ]);
    dm = a.id; mpm = b.id; logi = c.id; natSales = d.id; deleg = e.id;
    DM = await acteur(dm, "PRODUCT_MANAGER");
    MPM = await acteur(mpm, "MEDICAL_PROMOTION_MANAGER");
    LOGI = await acteur(logi, "LOGISTICS_MANAGER");
    NS = await acteur(natSales, "NATIONAL_SALES");
    // La Direction Marketing portée en rôle SECONDAIRE (cumul de postes) : la règle lit les deux rôles.
    // Un compte qui a la Force de vente en lecture mais dont la console a RETIRÉ la Promotion médicale :
    // l'acteur qui prouve la garde de la page et de l'onglet (Logistique n'a pas la Force de vente du tout).
    BLOQ = await acteur(deleg, "MEDICAL_DELEGATE");
    BLOQ.access.modules.delete("MEDICAL");
    DMSEC = await acteur(logi, "LOGISTICS_MANAGER", "PRODUCT_MANAGER");
    buId = (await prisma.businessUnit.create({ data: { name: `${TAG} BU` }, select: { id: true } })).id;
  });

  afterAll(nettoyer);

  it("les acteurs sont ce que le banc croit qu'ils sont (prémisses)", () => {
    expect(hasGlobalView(DM.role), "la Direction Marketing n'a pas la vue globale").toBe(false);
    expect(userCan(DM, "MEDICAL", "VIEW"), "elle lit la Promotion médicale").toBe(true);
    for (const g of ["CREATE", "UPDATE", "DELETE"] as const) {
      expect(userCan(DM, "MEDICAL", g), `sans la règle, elle n'aurait pas ${g} sur la Promotion médicale`).toBe(false);
    }
    expect(userCan(DM, "SALES_PLANNING", "VIEW"), "elle lit la Force de vente — c'est la porte de l'onglet").toBe(true);
    expect(userCan(DM, "SALES_PLANNING", "UPDATE"), "elle ne la modifie pas : on n'élargit pas le module").toBe(false);
    expect(userCan(MPM, "MEDICAL", "DELETE"), "le Manager Promotion médicale gère par son module").toBe(true);
    expect(userCan(LOGI, "MEDICAL", "VIEW"), "la Logistique n'a pas la Promotion médicale").toBe(false);
    expect(userCan(LOGI, "SALES_PLANNING", "VIEW"), "…ni la Force de vente (la porte de l'onglet lui est fermée avant la règle)").toBe(false);
    expect(userCan(BLOQ, "SALES_PLANNING", "VIEW"), "le compte au module retiré lit la Force de vente").toBe(true);
    expect(userCan(BLOQ, "MEDICAL", "VIEW"), "…mais n'a plus la Promotion médicale").toBe(false);
    expect(userCan(NS, "MEDICAL", "DELETE"), "le National Sales ne supprime pas dans la Promotion médicale").toBe(false);
  });

  it("la règle : la Direction Marketing (rôle principal OU secondaire) a les quatre gestes, la Logistique aucun", () => {
    for (const g of ["VIEW", "CREATE", "UPDATE", "DELETE"] as const) {
      expect(peutGererSpecialites(DM, g), `DM ${g}`).toBe(true);
      expect(peutGererSpecialites(DMSEC, g), `DM secondaire ${g}`).toBe(true);
      expect(peutGererSpecialites(MPM, g), `MPM ${g}`).toBe(true);
      expect(peutGererSpecialites(LOGI, g), `Logistique ${g}`).toBe(false);
      expect(peutGererSpecialites(BLOQ, g), `compte au module retiré ${g}`).toBe(false);
    }
    // Le National Sales garde ce qu'il avait (module en contribution) : pas la structure.
    expect(peutGererSpecialites(NS, "DELETE")).toBe(false);
  });

  it("l'onglet « Spécialités » des Annuaires suit la règle du référentiel, et la Force de vente n'en porte plus", () => {
    const tab = ANNUAIRES_TABS.find((t) => t.href === "/annuaires/specialites");
    expect(tab?.regle, "l'onglet suit peutGererSpecialites, pas le seul module").toBe("specialites");
    // La Direction Marketing ne gagne aucun onglet de configuration de la Force de vente.
    // Ses onglets sont ceux de tout lecteur ; la configuration est le module « Business Units » (Direction, 08/10), qu'elle
    // n'a pas : le « ⋯ Réglages » de la Force de vente n'existe plus, ses écrans ont leur propre droit.
    const dmVoit = SALES_PLANNING_TABS.map((t) => t.href);
    expect(dmVoit).not.toContain("/planning/specialites");
    expect(dmVoit).not.toContain("/planning/messages");
    expect(dmVoit).not.toContain("/planning/business-units");
    expect(dmVoit).not.toContain("/planning/parametres");
    expect(code("src/app/(app)/planning/entete.tsx")).not.toMatch(/MenuDossier|\/planning\/business-units|\/planning\/parametres/);
    expect(BUSINESS_UNITS_TABS.map((t) => t.href)).toEqual(["/business-units", "/business-units/secteurs", "/business-units/parametres"]);
    expect(BUSINESS_UNITS_TABS.every((t) => t.module === "BUSINESS_UNITS")).toBe(true);
    expect(userCan(DM, "BUSINESS_UNITS", "VIEW"), "la Direction Marketing n'a pas le montage des BU").toBe(false);
    expect(peutGererSpecialites(DM, "VIEW"), "…et garde la règle du référentiel").toBe(true);
  });

  it("la page : la Direction Marketing l'ouvre ; un compte qui a la Force de vente en lecture sans la règle est redirigé", async () => {
    ACTEUR = DM;
    const ouverte = await PlanningSpecialitesPage();
    expect(ouverte).toBeTruthy();
    ACTEUR = BLOQ;
    await expect(PlanningSpecialitesPage()).rejects.toThrow(/NEXT_REDIRECT/);
    // L'écran partagé refuse de lui-même, AVANT de charger : la page n'est pas la seule garde.
    await expect(EcranSpecialites({ user: BLOQ })).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(EcranSpecialites({ user: LOGI })).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(EcranSpecialites({ user: DM })).resolves.toBeTruthy();
  });

  it("la Direction Marketing : ajouter, renommer, rattacher un libellé, fusionner, retirer — par les vraies actions, deux écrans revalidés", async () => {
    ACTEUR = DM;
    revalides.length = 0;
    const a = await createSpecialty(fd({ name: `${TAG}Néphrologie` }));
    expect(a.ok, a.ok ? "" : a.error).toBe(true);
    expect(revalides).toEqual(expect.arrayContaining(["/annuaires/specialites"]));
    const b = await createSpecialty(fd({ name: `${TAG}Nephro bis` }));
    expect(b.ok, b.ok ? "" : b.error).toBe(true);
    const idA = a.ok ? a.id! : "", idB = b.ok ? b.id! : "";

    const r = await updateSpecialty(fd({ id: idB, name: `${TAG}Néphro pédiatrique`, color: "#336699" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await prisma.medicalSpecialty.findUniqueOrThrow({ where: { id: idB } });
    expect(apres.name).toBe(`${TAG}Néphro pédiatrique`);
    expect(apres.color).toBe("#336699");

    const fiche = await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Libellé`, specialty: `${TAG}nephro` }, select: { id: true } });
    const ra = await rattacherLibelleSpecialite(fd({ libelle: `${TAG}nephro`, specialtyId: idA }));
    expect(ra.ok, ra.ok ? "" : ra.error).toBe(true);
    expect(ra.rattachees, "sa portée de la Promotion médicale (lecture) est entière : la fiche est dans ce qu'elle voit").toBe(1);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fiche.id } })).specialtyId).toBe(idA);

    const fu = await fusionnerSpecialite(fd({ id: idB, cibleId: idA }));
    expect(fu.ok, fu.ok ? "" : fu.error).toBe(true);
    expect(await prisma.medicalSpecialty.count({ where: { id: idB } })).toBe(0);

    const de = await deleteSpecialty(fd({ id: idA }));
    expect(de.ok, de.ok ? "" : de.error).toBe(true);
    expect(await prisma.medicalSpecialty.count({ where: { id: idA } })).toBe(0);
    // Retirer une spécialité ne retire rien au praticien : sa spécialité écrite reste.
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: fiche.id } })).specialty).toBeTruthy();
  });

  it("le refus nommé d'une spécialité visée par une BU vaut aussi pour la Direction Marketing — et la fusion fait suivre la BU", async () => {
    ACTEUR = DM;
    const a = await createSpecialty(fd({ name: `${TAG}Neurologie` }));
    const b = await createSpecialty(fd({ name: `${TAG}Neuro bis` }));
    const idA = a.ok ? a.id! : "", idB = b.ok ? b.id! : "";
    await prisma.businessUnitSpecialty.create({ data: { businessUnitId: buId, specialtyId: idB, principale: false } });
    const refus = await deleteSpecialty(fd({ id: idB }));
    expect(refus.ok).toBe(false);
    expect(refus.ok ? "" : refus.error).toMatch(/visée par 1 Business Unit/);
    expect(refus.ok ? "" : refus.error, "le refus nomme la BU").toContain(`${TAG} BU`);
    expect(await prisma.medicalSpecialty.count({ where: { id: idB } })).toBe(1);
    const fu = await fusionnerSpecialite(fd({ id: idB, cibleId: idA }));
    expect(fu.ok, fu.ok ? "" : fu.error).toBe(true);
    const liens = await prisma.businessUnitSpecialty.findMany({ where: { businessUnitId: buId } });
    expect(liens.map((l) => l.specialtyId)).toEqual([idA]);
  });

  it("un rôle sans accès : les cinq actions refusent, et rien n'est écrit", async () => {
    ACTEUR = MPM;
    const a = await createSpecialty(fd({ name: `${TAG}Cardio A` }));
    const b = await createSpecialty(fd({ name: `${TAG}Cardio B` }));
    const idA = a.ok ? a.id! : "", idB = b.ok ? b.id! : "";
    const refus = { ok: false, error: "Non autorisé." };
    for (const interdit of [LOGI, BLOQ]) {
    ACTEUR = interdit;
    expect(await createSpecialty(fd({ name: `${TAG}Interdite` }))).toEqual(refus);
    expect(await updateSpecialty(fd({ id: idA, name: `${TAG}Renommée` }))).toEqual(refus);
    expect(await fusionnerSpecialite(fd({ id: idB, cibleId: idA }))).toEqual(refus);
    expect(await rattacherLibelleSpecialite(fd({ libelle: "x", specialtyId: idA }))).toEqual(refus);
    expect(await deleteSpecialty(fd({ id: idA }))).toEqual(refus);
    }
    expect(await prisma.medicalSpecialty.count({ where: { name: `${TAG}Interdite` } })).toBe(0);
    expect((await prisma.medicalSpecialty.findUniqueOrThrow({ where: { id: idA } })).name).toBe(`${TAG}Cardio A`);
    expect(await prisma.medicalSpecialty.count({ where: { id: { in: [idA, idB] } } })).toBe(2);
  });

  it("Adam : les ops du référentiel s'ouvrent à la Direction Marketing, et pas à la Logistique", () => {
    for (const [op, geste] of [["create_specialty", "CREATE"], ["update_specialty", "UPDATE"], ["delete_specialty", "DELETE"]] as const) {
      const meta = OPS_BY_TOOL.medical_operation[op];
      expect(meta, op).toBeTruthy();
      expect(meta.gate(DM as never), `${op} (${geste}) — Direction Marketing`).toBe(true);
      expect(meta.gate(LOGI as never), `${op} — Logistique`).toBe(false);
    }
  });
});
