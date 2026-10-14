import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity, ENTITY_MODULE } from "@/lib/entity-access";
import { createInstitution, updateInstitution, deleteInstitution } from "@/lib/actions/medical-actions";
import { createBusinessUnit, updateBusinessUnit, deleteBusinessUnit, createSector, deleteSector } from "@/lib/actions/sales-planning-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TYPES D'AUDIT DU GRAPHE (§118.181) — l'historique d'un objet se relit par son identifiant.
 *
 * Une Business Unit, un secteur, un établissement s'auditaient SANS type d'entité, et un plan de
 * tournée sous le type VISIT avec l'identifiant du PLAN : rien ne pouvait relire « qui a touché à
 * cet objet, et quand » — l'historique existait, adressé à personne.
 *
 * Trois propriétés, chacune par son vrai point d'entrée :
 *   1. les ACTIONS de l'écran écrivent le bon type ET le bon identifiant ;
 *   2. la MIGRATION de requalification, jouée sur son TEXTE RÉEL contre des tables temporaires
 *      (le patron de §118.173), ne requalifie que ce que le LIEN CAUSAL désigne — et rien deux fois ;
 *   3. ces types ne sont pas des PORTES : `canAccessEntity` les refuse même à qui a le module.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__audtypes__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

const TYPES_DU_GRAPHE: EntityType[] = ["BUSINESS_UNIT", "TOUR_PLAN", "SALES_SECTOR", "INSTITUTION", "SPECIALTY"];

const DIR = path.join(process.cwd(), "prisma/migrations");
const SQL_TYPES = readFileSync(path.join(DIR, "20261222090000_audit_types_graphe/migration.sql"), "utf8");
const SQL_REQUALIF = readFileSync(path.join(DIR, "20261222090100_audit_plans_de_tournee/migration.sql"), "utf8");

describe("Les deux migrations, lues", () => {
  it("la première AJOUTE les cinq valeurs, sans échouer si on la rejoue", () => {
    for (const t of TYPES_DU_GRAPHE) {
      expect(SQL_TYPES, t).toMatch(new RegExp(`ADD VALUE IF NOT EXISTS '${t}'`));
    }
  });

  it("la seconde n'ajoute AUCUNE valeur : une valeur neuve ne sert pas dans la transaction qui l'ajoute", () => {
    // Postgres refuse d'utiliser une valeur d'énumération dans la transaction qui l'a créée, et
    // Prisma joue chaque fichier dans la sienne. Fusionner les deux fichiers ferait échouer le
    // déploiement sur « unsafe use of new value » — c'est la raison d'être de la séparation.
    expect(SQL_REQUALIF).not.toMatch(/ADD VALUE/i);
    expect("20261222090100_audit_plans_de_tournee" > "20261222090000_audit_types_graphe").toBe(true);
  });
});

/** Joue le SQL de requalification sur des tables temporaires préparées par `avant`. */
async function requalifier(avant: string[], rejouer = 1): Promise<{ id: string; entityType: string | null; entityId: string | null }[]> {
  const ANNULE = new Error("annulé — le banc ne garde rien");
  let lignes: { id: string; entityType: string | null; entityId: string | null }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // `pg_temp` passe devant `public` pour la session : le SQL du FICHIER s'exécute tel qu'il est
      // écrit, sans lire ni écrire l'historique réel de la base partagée (§118.173).
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "AuditLog" (LIKE public."AuditLog" INCLUDING DEFAULTS) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "TourPlan" ("id" text PRIMARY KEY) ON COMMIT DROP`);
      for (const s of avant) await tx.$executeRawUnsafe(s);
      for (let i = 0; i < rejouer; i++) await tx.$executeRawUnsafe(SQL_REQUALIF);
      lignes = await tx.$queryRawUnsafe(`SELECT id, "entityType"::text AS "entityType", "entityId" FROM "AuditLog" ORDER BY id`);
      throw ANNULE;
    }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ANNULE) throw e;
  }
  return lignes;
}

const ligneAudit = (id: string, type: string | null, entityId: string | null) =>
  `INSERT INTO "AuditLog" (id, action, module, "entityType", "entityId") VALUES ('${id}', 'UPDATE', 'Promotion médicale', ${type ? `'${type}'::"EntityType"` : "NULL"}, ${entityId ? `'${entityId}'` : "NULL"})`;

suite("La requalification de l'historique des plans, jouée sur son texte réel", () => {
  it("PRÉMISSE : les cinq valeurs existent dans la base de travail", async () => {
    const valeurs = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT unnest(enum_range(NULL::"EntityType"))::text AS v`);
    const connues = new Set(valeurs.map((x) => x.v));
    for (const t of TYPES_DU_GRAPHE) expect(connues.has(t), t).toBe(true);
  });

  it("une ligne VISIT qui nomme un PLAN devient TOUR_PLAN ; tout le reste est intact", async () => {
    const l = await requalifier([
      `INSERT INTO "TourPlan" (id) VALUES ('plan-1')`,
      ligneAudit("a1-plan", "VISIT", "plan-1"),
      // UNE VRAIE VISITE : son identifiant n'est pas celui d'un plan, elle reste une visite.
      ligneAudit("a2-visite", "VISIT", "visite-9"),
      // UNE LIGNE SANS TYPE qui porte l'identifiant d'un plan : rien ne dit à coup sûr qu'elle le
      // concerne — on ne devine pas d'après un identifiant seul quand le type ne le dit pas.
      ligneAudit("a3-sans-type", null, "plan-1"),
      // UN AUTRE TYPE : seul VISIT a été mal typé, on ne réécrit pas ce qui était juste.
      ligneAudit("a4-autre", "DOCTOR", "plan-1"),
    ]);
    const par = new Map(l.map((x) => [x.id, x.entityType]));
    expect(par.get("a1-plan")).toBe("TOUR_PLAN");
    expect(par.get("a2-visite")).toBe("VISIT");
    expect(par.get("a3-sans-type")).toBeNull();
    expect(par.get("a4-autre")).toBe("DOCTOR");
  });

  it("rejouée, elle ne change RIEN de plus", async () => {
    const une = await requalifier([
      `INSERT INTO "TourPlan" (id) VALUES ('plan-1')`,
      ligneAudit("a1-plan", "VISIT", "plan-1"),
      ligneAudit("a2-visite", "VISIT", "visite-9"),
    ]);
    const deux = await requalifier([
      `INSERT INTO "TourPlan" (id) VALUES ('plan-1')`,
      ligneAudit("a1-plan", "VISIT", "plan-1"),
      ligneAudit("a2-visite", "VISIT", "visite-9"),
    ], 2);
    expect(deux).toEqual(une);
  });
});

suite("Les actions de l'écran écrivent le bon type ET le bon identifiant", () => {
  let adminId = "";
  const comptes: string[] = [];

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    adminId = admin.id;
    comptes.push(admin.id);
    ACTEUR = { id: admin.id, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(admin.id, "SUPER_ADMIN") } as unknown as SessionUser;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  const journal = (type: EntityType, entityId: string) =>
    prisma.auditLog.findMany({ where: { actorId: adminId, entityType: type, entityId }, select: { action: true, summary: true }, orderBy: { createdAt: "asc" } });

  it("un ÉTABLISSEMENT : créé, renommé, supprimé — trois lignes INSTITUTION sur SON identifiant", async () => {
    const c = await createInstitution(fd({ name: `${TAG}CHU Test`, wilaya: "Alger" }));
    expect(c.ok, c.ok === false ? c.error : "").toBe(true);
    const id = c.ok ? (c.id ?? "") : "";
    const u = await updateInstitution(fd({ id, name: `${TAG}CHU Test renommé` }));
    expect(u.ok, u.ok === false ? u.error : "").toBe(true);
    const d = await deleteInstitution(fd({ id }));
    expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    const l = await journal("INSTITUTION", id);
    expect(l.map((x) => x.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
    // Le résumé du renommage nomme l'ANCIEN et le NOUVEAU nom : c'est ce qu'on vient y relire.
    expect(l[1]?.summary).toContain("renommé");
    expect(l[2]?.summary).toContain(`${TAG}CHU Test renommé`);
  });

  it("une BUSINESS UNIT : créée, modifiée, supprimée — trois lignes BUSINESS_UNIT", async () => {
    const c = await createBusinessUnit(fd({ name: `${TAG}Oncologie` }));
    expect(c.ok, c.ok === false ? c.error : "").toBe(true);
    const id = c.ok ? (c.id ?? "") : "";
    const u = await updateBusinessUnit(fd({ id, name: `${TAG}Oncologie` }));
    expect(u.ok, u.ok === false ? u.error : "").toBe(true);
    const d = await deleteBusinessUnit(fd({ id }));
    expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    expect((await journal("BUSINESS_UNIT", id)).map((x) => x.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
  });

  it("un SECTEUR : créé puis supprimé — deux lignes SALES_SECTOR sur l'identifiant du SECTEUR", async () => {
    const bu = await createBusinessUnit(fd({ name: `${TAG}Cardiologie` }));
    expect(bu.ok).toBe(true);
    const buId = bu.ok ? (bu.id ?? "") : "";
    const c = await createSector(fd({ businessUnitId: buId, name: `${TAG}Est` }));
    expect(c.ok, c.ok === false ? c.error : "").toBe(true);
    const id = c.ok ? (c.id ?? "") : "";
    // L'identifiant écrit est celui du SECTEUR, pas celui de sa BU : c'est la confusion qu'un
    // résumé seul ne permettait pas de démêler.
    expect(id).not.toBe(buId);
    const d = await deleteSector(fd({ id }));
    expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    expect((await journal("SALES_SECTOR", id)).map((x) => x.action)).toEqual(["CREATE", "DELETE"]);
  });
});

suite("Ces types nomment une ligne d'historique — ce ne sont pas des portes", () => {
  let admin: SessionUser | null = null;
  let compteId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}porte`, email: `${TAG}porte@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    compteId = u.id;
    admin = { id: u.id, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN") } as unknown as SessionUser;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: compteId } }).catch(() => {});
  });

  it("refusés même au Super Admin, qui a tous les modules — VIEW comme UPLOAD", async () => {
    for (const t of TYPES_DU_GRAPHE) {
      // PRÉMISSE : le refus ne peut venir QUE du cas explicite — le module, lui, est accordé. Sans
      // cette ligne, un module mal déclaré refuserait pour une autre raison et le cas passerait au
      // vert sans plus rien garder (§118.104).
      expect(userCan(admin!, ENTITY_MODULE[t], "VIEW"), `PRÉMISSE ${t}`).toBe(true);
      expect(await canAccessEntity(admin!, t, "nimporte-quel-id", "VIEW"), `${t} VIEW`).toBe(false);
      expect(await canAccessEntity(admin!, t, "nimporte-quel-id", "UPLOAD"), `${t} UPLOAD`).toBe(false);
    }
  });
});
