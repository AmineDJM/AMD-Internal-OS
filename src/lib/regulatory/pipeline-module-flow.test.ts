import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRole } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

// Hors requête : pas de cookie d'entité (vue « toutes les entités »).
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

// LES RÉGLAGES SONT GLOBAUX : la confidence du pipeline s'INJECTE dans ce processus — l'écrire en base l'ouvrirait, le
// temps d'un cas, à toute la suite qui tourne à côté.
let VOIT_PIPELINE: string[] = [];
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...vrai,
    getAppSettings: async () => ({
      ...(await vrai.getAppSettings()),
      hiddenModules: [],
      pipelineViewerRoles: [],
      pipelineViewerUserIds: VOIT_PIPELINE,
      pipelineManagerRoles: [],
      pipelineManagerUserIds: [],
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  PERMISSIONS, accesAttribue, defaultScope, getAccess, scopeRegulatory, seesLockedRegulatory, userCan,
  type LigneAccesAttribue, type Module, type SessionUser,
} from "@/lib/rbac";
import { navigationFor } from "@/lib/nav-access";
import { canAccessEntity } from "@/lib/entity-access";
import { NAVIGATION, type NavItem } from "@/lib/labels";

/**
 * « SÉPARE PIPELINE ET SUIVI DE DOSSIERS DANS LES ACCÈS … POUR QUE JE CONTRÔLE » (Direction, 08/10).
 *
 * Le pipeline est désormais son propre module (`REGULATORY_PIPELINE`) : la console l'ouvre ou le ferme indépendamment du
 * suivi des dossiers. Par défaut rien ne bouge (chaque rôle y a ses gestes de Regulatory) ; un blocage ferme le pipeline
 * — l'entrée, la page et les dossiers verrouillés — sans toucher au suivi, et un accès au seul pipeline n'ouvre pas le
 * suivi. Joué par les vrais points d'entrée : le menu (`navigationFor`), la porte des pages (`userCan` de `requireModule`)
 * et la règle du dossier (`canAccessEntity`).
 */
const TAG = "__pipemod__";
const destinations = (items: NavItem[]): string[] => items.flatMap((i) => [i.href, ...destinations(i.children ?? [])]);

describe("le pipeline par défaut — les mêmes gestes que Regulatory, rôle par rôle", () => {
  it("chaque rôle a sur le pipeline EXACTEMENT ses gestes de Regulatory, à la même portée", () => {
    for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
      expect(PERMISSIONS[role].REGULATORY_PIPELINE, role).toEqual(PERMISSIONS[role].REGULATORY);
      expect(defaultScope(role, "REGULATORY_PIPELINE"), role).toBe(defaultScope(role, "REGULATORY"));
    }
  });
});

/** Une personne telle que `getAccess` la résout — sans base : rôle + lignes de la console + confidence du pipeline. */
function personne(role: UserRole, lignes: Partial<LigneAccesAttribue>[]): SessionUser {
  const base = { canView: true, canCreate: false, canUpdate: false, canDelete: false, canValidate: false, canExport: false, canUpload: false, scope: "ASSIGNED" as const, sections: [] };
  const { modules } = accesAttribue(role, null, lignes.map((l) => ({ ...base, ...l }) as LigneAccesAttribue));
  return { id: `p-${role}`, role, access: { modules, rowGrants: new Map(), pipelineView: true, pipelineManage: false } };
}

/** Les entrées du pôle Regulatory que le menu livrerait : le module, puis la garde `pipeline` (`nav-access.ts`). */
function entreesRegulatory(user: SessionUser): string[] {
  return NAVIGATION
    .filter((n) => n.pole === "REGULATORY" && (!n.gate || n.gate === "pipeline"))
    .filter((n) => user.access.modules.has(n.module as Module) && (n.gate !== "pipeline" || seesLockedRegulatory(user)))
    .map((n) => n.href);
}

describe("la scission, règle pure — sans base", () => {
  it("témoin : Regulatory par défaut → le suivi ET le pipeline, tout le portefeuille", () => {
    const t = personne("HEAD_OF_REGULATORY", []);
    expect(entreesRegulatory(t)).toEqual(expect.arrayContaining(["/regulatory", "/regulatory/pipeline"]));
    expect(scopeRegulatory(t)).toEqual({});
  });

  it("Regulatory mais pipeline BLOQUÉ : pas d'onglet Pipeline, pas de page, aucun dossier verrouillé", () => {
    const s = personne("HEAD_OF_REGULATORY", [{ module: "REGULATORY_PIPELINE", canView: false }]);
    expect(userCan(s, "REGULATORY", "VIEW")).toBe(true);
    expect(userCan(s, "REGULATORY_PIPELINE", "VIEW")).toBe(false); // requireModule("REGULATORY_PIPELINE") refuse
    expect(seesLockedRegulatory(s)).toBe(false);
    expect(entreesRegulatory(s)).toContain("/regulatory");
    expect(entreesRegulatory(s)).not.toContain("/regulatory/pipeline");
    expect(scopeRegulatory(s)).toEqual({ isLocked: false });
  });

  it("le pipeline SEUL : l'onglet Pipeline, pas la liste des dossiers — et seulement les verrouillés", () => {
    const p = personne("BUSINESS_DEVELOPMENT_MANAGER", [{ module: "REGULATORY_PIPELINE", canUpdate: true, scope: "ALL" }]);
    expect(userCan(p, "REGULATORY", "VIEW")).toBe(false); // requireModule("REGULATORY") refuse /regulatory
    expect(userCan(p, "REGULATORY_PIPELINE", "UPDATE")).toBe(true);
    expect(entreesRegulatory(p)).toEqual(["/regulatory/pipeline"]);
    expect(scopeRegulatory(p)).toEqual({ isLocked: true });
  });

  it("sans la confidence, le module seul n'ouvre rien des dossiers verrouillés (seconde clé conservée)", () => {
    const p = personne("BUSINESS_DEVELOPMENT_MANAGER", [{ module: "REGULATORY_PIPELINE", scope: "ALL" }]);
    const sansConfidence = { ...p, access: { ...p.access, pipelineView: false } };
    expect(seesLockedRegulatory(sansConfidence)).toBe(false);
    expect(entreesRegulatory(sansConfidence)).toEqual([]);
    expect(scopeRegulatory(sansConfidence)).toEqual({ id: "__none__" });
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("Pipeline et Suivi des dossiers se règlent à part dans la console", () => {
  const u: Record<string, string> = {};
  let ouvert = "";
  let verrouille = "";

  async function acteur(id: string, role: UserRole): Promise<CurrentUser> {
    const access = await getAccess(id, role);
    const r = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: r.name, email: r.email, role, access, mustChangePassword: false };
  }

  async function nettoyer() {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } });
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: UserRole) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await mk("temoin", "HEAD_OF_REGULATORY");
    await mk("suivi", "HEAD_OF_REGULATORY");
    await mk("pipe", "BUSINESS_DEVELOPMENT_MANAGER");
    // « Bloqué » sur le pipeline : la ligne que la console écrit (canView = false).
    await prisma.userAccess.create({ data: { userId: u.suivi, module: "REGULATORY_PIPELINE", canView: false } });
    // « Personnalisé » sur le pipeline seul : Voir + Modifier, toutes les lignes.
    await prisma.userAccess.create({
      data: { userId: u.pipe, module: "REGULATORY_PIPELINE", canView: true, canUpdate: true, scope: "ALL" },
    });
    // Les trois ont la confidence du pipeline : seule la console les distingue.
    VOIT_PIPELINE = [u.temoin, u.suivi, u.pipe];
    ouvert = (await prisma.regulatoryProduct.create({ data: { reference: `${TAG}ouvert`, dci: `${TAG} ouvert` } })).id;
    verrouille = (await prisma.regulatoryProduct.create({ data: { reference: `${TAG}verrou`, dci: `${TAG} verrouillé`, isLocked: true } })).id;
  }, 60_000);

  afterAll(nettoyer);

  it("le témoin (Regulatory par défaut) garde le suivi ET le pipeline — la scission ne retire rien", async () => {
    const t = await acteur(u.temoin, "HEAD_OF_REGULATORY");
    expect(userCan(t, "REGULATORY", "VIEW")).toBe(true);
    expect(userCan(t, "REGULATORY_PIPELINE", "UPDATE")).toBe(true);
    expect(seesLockedRegulatory(t)).toBe(true);
    const menu = destinations(await navigationFor(t));
    expect(menu).toContain("/regulatory");
    expect(menu).toContain("/regulatory/pipeline");
    expect(await canAccessEntity(t, "REGULATORY_PRODUCT", ouvert, "VIEW")).toBe(true);
    expect(await canAccessEntity(t, "REGULATORY_PRODUCT", verrouille, "UPDATE")).toBe(true);
  });

  it("Regulatory, mais le pipeline BLOQUÉ : ni l'onglet, ni la page, ni les dossiers verrouillés", async () => {
    const s = await acteur(u.suivi, "HEAD_OF_REGULATORY");
    // PRÉMISSE : il a bien la confidence — sans elle, le cas passerait au vert pour une autre raison.
    expect(s.access.pipelineView).toBe(true);
    expect(userCan(s, "REGULATORY", "VIEW")).toBe(true);
    // La porte de /regulatory/pipeline (`requireModule("REGULATORY_PIPELINE")`) est fermée.
    expect(userCan(s, "REGULATORY_PIPELINE", "VIEW")).toBe(false);
    expect(seesLockedRegulatory(s)).toBe(false);
    const menu = destinations(await navigationFor(s));
    expect(menu).toContain("/regulatory");
    expect(menu).not.toContain("/regulatory/pipeline");
    expect(await canAccessEntity(s, "REGULATORY_PRODUCT", ouvert, "UPDATE")).toBe(true);
    expect(await canAccessEntity(s, "REGULATORY_PRODUCT", verrouille, "VIEW")).toBe(false);
  });

  it("le pipeline SEUL : le Pipeline s'ouvre, la liste des dossiers non", async () => {
    const p = await acteur(u.pipe, "BUSINESS_DEVELOPMENT_MANAGER");
    // La porte de /regulatory (`requireModule("REGULATORY")`) reste fermée ; celle du pipeline s'ouvre.
    expect(userCan(p, "REGULATORY", "VIEW")).toBe(false);
    expect(userCan(p, "REGULATORY_PIPELINE", "VIEW")).toBe(true);
    expect(seesLockedRegulatory(p)).toBe(true);
    const menu = destinations(await navigationFor(p));
    expect(menu).toContain("/regulatory/pipeline");
    expect(menu).not.toContain("/regulatory");
    // Les gestes du pipeline portent sur les dossiers verrouillés — et sur eux seuls.
    expect(await canAccessEntity(p, "REGULATORY_PRODUCT", verrouille, "UPDATE")).toBe(true);
    expect(await canAccessEntity(p, "REGULATORY_PRODUCT", verrouille, "DELETE")).toBe(false);
    expect(await canAccessEntity(p, "REGULATORY_PRODUCT", ouvert, "VIEW")).toBe(false);
  });
});
