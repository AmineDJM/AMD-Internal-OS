import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTEUR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { ACTIONS, MODULES, PERMISSIONS, getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { MODULE_LABELS, NAVIGATION } from "@/lib/labels";
import { canOpenModule, isHideable } from "@/lib/modules-visibility";
import { navigationFor } from "@/lib/nav-access";
import { saveModuleAccess } from "@/lib/actions/access-actions";
import { lireEcranRecettes, ouvreLesRecettes, recettePour, voitDesRecettes } from "@/modules/recettes/api";
import { designerResponsableAction, rejeterRecetteAction, validerRecetteAction } from "@/modules/recettes/actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT R1 (décision 0054) — « RECETTES » SE MASQUE ET SE GÈRE COMME LES AUTRES MODULES.
 *
 * Direction, 02/11/2026 : « permets-moi de masquer ou gérer les accès au module 'Recettes' ». Ce banc passe par les
 * VRAIS points d'entrée, sur la base locale : la console « par module » (`saveModuleAccess`, le geste exact du Super
 * Admin), l'accès effectif (`getAccess`), le menu (`navigationFor`), la porte de la page (`requireModule("RECETTES")`,
 * dont la décision est `userCan`), les actions serveur du module et le service que sert l'Assistant IA.
 *
 *   1. DÉFAUTS SANS RUPTURE : tous les rôles ont le module (Voir + Valider ; la Direction Modifier en plus) — qui voyait
 *      Recettes hier le voit encore, la règle dérivée (circuit visible, responsable désigné, `peutDesigner`) restant
 *      derrière la porte ;
 *   2. MASQUÉ (« Bloqué » dans la console) : ni menu, ni page, ni écran, ni geste, ni recette servie à l'assistant ;
 *   3. RÉTABLI (« Par défaut ») : tout revient — le geste est réversible, sans rien perdre ;
 *   4. OUVERT EN LECTURE SEULE (« Personnalisé », sans Valider) : on lit, on ne tranche pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__r1recettes${Date.now().toString(36)}__`;
/** Un circuit de validation propre au banc : sa porte est le module « Validations », ouvert à tous les rôles. */
const CIRCUIT = `VAL:${TAG.toUpperCase()}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x); else f.set(k, v);
  }
  return f;
};

const destinations = (items: Awaited<ReturnType<typeof navigationFor>>): string[] =>
  items.flatMap((i) => [i.href, ...destinations(i.children ?? [])]);

describe("Recettes — un module du contrôle d'accès standard", () => {
  it("RECETTES est au catalogue, nommé, masquable, et l'entrée de menu porte le module", () => {
    expect((MODULES as readonly string[]).includes("RECETTES")).toBe(true);
    expect(MODULE_LABELS.RECETTES).toBe("Recettes");
    expect(isHideable("RECETTES"), "la Direction peut le masquer pour tous (Réglages)").toBe(true);
    expect(canOpenModule("RECETTES", ["RECETTES"], { isSuperAdmin: false }), "masqué : l'adresse ne s'ouvre pas").toBe(false);
    const entree = NAVIGATION.find((n) => n.href === "/recettes");
    expect(entree?.module).toBe("RECETTES");
    expect(entree?.gate, "la règle dérivée (jamais une page vide) reste DERRIÈRE le module").toBe("recettes");
  });

  it("DÉFAUTS SANS RUPTURE : chaque rôle a le module — Voir + Valider ; la Direction désigne en plus ; le Super Admin a tout", () => {
    for (const [role, matrice] of Object.entries(PERMISSIONS)) {
      if (role === "SUPER_ADMIN") { expect(matrice.RECETTES).toEqual([...ACTIONS]); continue; }
      if (role === "DIRECTION") { expect(matrice.RECETTES).toEqual(["VIEW", "UPDATE", "VALIDATE"]); continue; }
      expect(matrice.RECETTES, `${role} : un responsable désigné peut être de n'importe quel rôle`).toEqual(["VIEW", "VALIDATE"]);
    }
  });

  it("la page /recettes passe par la porte du module (`requireModule(\"RECETTES\")`)", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/(app)/recettes/page.tsx"), "utf8");
    expect(page).toContain('requireModule("RECETTES")');
    expect(page).not.toMatch(/requireUser\(\)/);
  });
});

suite("Recettes — masquer, rétablir, ouvrir depuis la console (base locale)", () => {
  let adminId = "", kamId = "", dirId = "", recetteId = "", versionId = "";

  beforeAll(async () => {
    await nettoyer();
    const [admin, kam, dir] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}coord`, email: `${TAG}coord@t.dz`, role: "COORDINATOR", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}dir`, email: `${TAG}dir@t.dz`, role: "DIRECTION", passwordHash: "x" } }),
    ]);
    adminId = admin.id; kamId = kam.id; dirId = dir.id;
    // Une recette PROPOSÉE sur un circuit que tout rôle voit : c'est elle qui fait l'entrée de menu d'un non-dirigeant.
    const r = await prisma.recette.create({
      data: {
        circuit: CIRCUIT, processus: "VALIDATIONS", titre: `${TAG} recette`, statut: "PROPOSEE",
        versions: { create: { numero: 1, statut: "PROPOSEE", contenu: {}, signature: TAG, occurrences: 6 } },
      },
      include: { versions: true },
    });
    recetteId = r.id; versionId = r.versions[0].id;
  }, 120_000);

  afterAll(nettoyer, 120_000);

  async function nettoyer() {
    await prisma.recetteUsage.deleteMany({ where: { recette: { circuit: { startsWith: "VAL:__R1RECETTES" } } } }).catch(() => {});
    await prisma.recette.deleteMany({ where: { circuit: { startsWith: "VAL:__R1RECETTES" } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: "__r1recettes" } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: "__r1recettes" } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: "__r1recettes" } } }).catch(() => {});
  }

  /** La console « par module » — le geste exact du Super Admin (Administration › Accès › Recettes). */
  async function console_(userId: string, mode: "CUSTOM" | "BLOCKED" | "DEFAULT", actions: string[] = []) {
    ACTEUR = await acteur(adminId, "SUPER_ADMIN");
    const champs: Record<string, string | string[]> = { module: "RECETTES", userId, [`mode_${userId}`]: mode };
    for (const a of actions) champs[`act_${userId}_${a}`] = "on";
    const r = await saveModuleAccess(fd(champs));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }

  it("PAR DÉFAUT, un profil d'aujourd'hui voit Recettes : module, menu, écran — et la règle dérivée tient", async () => {
    const coord = await acteur(kamId, "COORDINATOR");
    expect(userCan(coord, "RECETTES", "VIEW")).toBe(true);
    expect(await voitDesRecettes(coord)).toBe(true);
    expect(destinations(await navigationFor(coord))).toContain("/recettes");
    const ecran = await lireEcranRecettes(coord);
    expect(ecran.recettes.some((r) => r.id === recetteId)).toBe(true);
    expect(ecran.peutDesigner, "désigner reste à la Direction (`peutDesigner`)").toBe(false);
    // Le module ouvert ne suffit pas pour trancher : il faut AUSSI être le responsable désigné.
    ACTEUR = coord;
    const r = await validerRecetteAction(versionId);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("ne vous est pas ouvert");
    const dir = await acteur(dirId, "DIRECTION");
    expect(ouvreLesRecettes(dir, "UPDATE")).toBe(true);
    expect((await lireEcranRecettes(dir)).peutDesigner).toBe(true);
  });

  it("MASQUÉ À UNE PERSONNE (« Bloqué ») : ni menu, ni page, ni écran, ni geste, ni recette servie à l'assistant", async () => {
    await console_(kamId, "BLOCKED");
    const coord = await acteur(kamId, "COORDINATOR");
    expect(userCan(coord, "RECETTES", "VIEW"), "requireModule(\"RECETTES\") refuse /recettes").toBe(false);
    expect(await voitDesRecettes(coord)).toBe(false);
    expect(destinations(await navigationFor(coord))).not.toContain("/recettes");
    expect((await lireEcranRecettes(coord)).recettes).toEqual([]);
    ACTEUR = coord;
    for (const r of [await validerRecetteAction(versionId), await rejeterRecetteAction(versionId, "motif du banc")]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain("Le module Recettes ne vous est pas ouvert");
    }
    expect((await prisma.recetteVersion.findUniqueOrThrow({ where: { id: versionId } })).statut, "rien n'a été écrit").toBe("PROPOSEE");
    const servie = await recettePour(coord, "faire valider un dossier de validation du banc");
    expect(servie.statut).toBe("AUCUNE");
    expect(await prisma.recetteUsage.count({ where: { userId: kamId } }), "aucun usage compté").toBe(0);
  });

  it("MASQUÉ À LA DIRECTION ELLE-MÊME : elle ne désigne plus — `peutDesigner` ne passe pas par-dessus la console", async () => {
    await console_(dirId, "BLOCKED");
    ACTEUR = await acteur(dirId, "DIRECTION");
    const r = await designerResponsableAction("VALIDATIONS", "COORDINATOR", null);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("ne vous est pas ouvert");
    await console_(dirId, "DEFAULT");
    expect(ouvreLesRecettes(await acteur(dirId, "DIRECTION"), "UPDATE")).toBe(true);
  });

  it("RÉTABLI (« Par défaut ») : tout revient, sans rien perdre", async () => {
    await console_(kamId, "DEFAULT");
    expect(await prisma.userAccess.count({ where: { userId: kamId, module: "RECETTES" } }), "la ligne de blocage est retirée").toBe(0);
    const coord = await acteur(kamId, "COORDINATOR");
    expect(await voitDesRecettes(coord)).toBe(true);
    expect(destinations(await navigationFor(coord))).toContain("/recettes");
    expect((await lireEcranRecettes(coord)).recettes.some((r) => r.id === recetteId)).toBe(true);
  });

  it("OUVERT EN LECTURE SEULE (« Personnalisé », sans Valider) : visible, mais on ne tranche pas", async () => {
    await console_(kamId, "CUSTOM", []);
    const coord = await acteur(kamId, "COORDINATOR");
    expect(userCan(coord, "RECETTES", "VIEW")).toBe(true);
    expect(userCan(coord, "RECETTES", "VALIDATE")).toBe(false);
    expect(destinations(await navigationFor(coord))).toContain("/recettes");
    ACTEUR = coord;
    const r = await validerRecetteAction(versionId);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("ne vous est pas ouvert");
    await console_(kamId, "DEFAULT");
  });
});
