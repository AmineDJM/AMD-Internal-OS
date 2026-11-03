import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ».
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { clauseFormationsVisibles } from "@/lib/queries/visibilite-listes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI VOIT UNE FORMATION, ET QUI ROUVRE SES PIÈCES (§118.184 — audit 360°, S4).
 *
 * Mesuré par l'audit : `/formations` listait toutes les formations de la société à tout salarié —
 * montants, motifs, pièces. Et, trouvé en écrivant ce banc : ses pièces s'écrivaient sous le type
 * DOSSIER (un « sujet ») avec l'identifiant de la FORMATION, si bien que la porte des pièces cherchait
 * un sujet inexistant et refusait le téléchargement à TOUT LE MONDE. Les acteurs sont des salariés
 * ordinaires, sans vue globale (§118.104), reliés par un vrai organigramme.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__formv__";

suite("Formations — la liste et la fiche lisent la même règle", () => {
  let A = "", B = "";
  const u: Record<string, string> = {};
  const t: Record<string, string> = {};
  const acteurs: Record<string, SessionUser> = {};

  async function nettoyer() {
    const ts = await prisma.training.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } });
    await retirerDocumentsEtContenu({ where: { entityId: { in: ts.map((x) => x.id) } } }).catch(() => {});
    await prisma.trainingParticipant.deleteMany({ where: { trainingId: { in: ts.map((x) => x.id) } } }).catch(() => {});
    await prisma.training.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    // Les salariés se retirent du bas vers le haut de l'organigramme (clé étrangère `managerId`).
    for (const k of ["req", "coll", "part", "rhA", "rhB", "mgr", "dir"]) {
      await prisma.employee.deleteMany({ where: { fullName: `${TAG}${k}` } }).catch(() => {});
    }
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    const mk = async (k: string, companyId: string, managerId: string | null) => {
      const user = await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: "VIEWER" as never, passwordHash: "x" } });
      u[k] = user.id;
      const e = await prisma.employee.create({ data: { fullName: `${TAG}${k}`, companyId, userId: user.id, managerId } });
      return e.id;
    };
    // L'organigramme : directeur → N+1 → demandeuse. Le directeur est N+2 : il tranche par la chaîne.
    const eDir = await mk("dir", A, null);
    const eMgr = await mk("mgr", A, eDir);
    await mk("req", A, eMgr);
    await mk("coll", A, eMgr);
    await mk("part", A, null);
    await mk("rhA", A, null);
    await mk("rhB", B, null);
    // Les RH : un accès personnalisé au module, comme la console le donne.
    for (const k of ["rhA", "rhB"]) {
      for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: u[k], module, canView: true, canUpdate: true, canValidate: true, scope: "ALL" } });
    }
    for (const k of Object.keys(u)) acteurs[k] = { id: u[k], role: "VIEWER", secondaryRole: null, access: await getAccess(u[k], "VIEWER" as never) } as unknown as SessionUser;
    const mkT = async (k: string, data: Record<string, unknown>) => {
      t[k] = (await prisma.training.create({ data: { reference: `${TAG}${k}`, title: `${TAG}${k}`, ...data } })).id;
    };
    await mkT("demande", { companyId: A, requesterId: u.req, managerId: eMgr, amount: 120000 });
    await mkT("session", { companyId: A, origin: "HR", amount: 300000 });
    await prisma.trainingParticipant.create({ data: { trainingId: t.session, userId: u.part } });
    await mkT("beta", { companyId: B, requesterId: u.rhB, amount: 50000 });
    await prisma.document.create({ data: { name: `${TAG}devis.pdf`, category: "OTHER", entityType: "TRAINING", entityId: t.demande, uploadedById: u.req } });
  });

  afterAll(async () => { await nettoyer(); });

  const visibles = async (k: string) => (await prisma.training.findMany({
    where: { AND: [{ reference: { startsWith: TAG } }, await clauseFormationsVisibles(acteurs[k])] },
    select: { id: true },
  })).map((x) => x.id);

  it("PRÉMISSE : aucun de ces salariés n'a la vue globale ; les RH ont le module en écriture", () => {
    expect(acteurs.coll.access.modules.get("RH")).toBeUndefined();
    expect(acteurs.rhA.access.modules.get("RH")?.actions.has("UPDATE")).toBe(true);
  });

  it("la LISTE : un collègue ne voit plus la demande de formation d'un autre — montant, motif, pièces", async () => {
    expect(await visibles("coll")).toEqual([]);
  });

  it("la LISTE : la demandeuse, son N+1, le participant d'une session, chacun voit ce qui le concerne", async () => {
    expect(await visibles("req")).toEqual([t.demande]);
    expect(await visibles("mgr")).toEqual([t.demande]);
    expect(await visibles("part")).toEqual([t.session]);
  });

  it("la LISTE : les RH voient les formations de LEUR société, pas celles d'une autre", async () => {
    expect(new Set(await visibles("rhA"))).toEqual(new Set([t.demande, t.session]));
    expect(await visibles("rhB")).toEqual([t.beta]);
  });

  it("la FICHE et ses pièces : la même règle — plus la chaîne au-dessus du demandeur, qui tranche", async () => {
    expect(await canAccessEntity(acteurs.req, "TRAINING", t.demande, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.mgr, "TRAINING", t.demande, "VIEW")).toBe(true);
    // Le N+2 n'est pas dans la liste (subordonnés DIRECTS) mais peut trancher : il ouvre les pièces.
    expect(await visibles("dir")).toEqual([]);
    expect(await canAccessEntity(acteurs.dir, "TRAINING", t.demande, "VIEW")).toBe(true);
    expect(await canAccessEntity(acteurs.coll, "TRAINING", t.demande, "VIEW")).toBe(false);
    expect(await canAccessEntity(acteurs.rhB, "TRAINING", t.demande, "VIEW")).toBe(false);
  });

  it("retirer une PIÈCE : la demandeuse et les RH — pas son N+1, ni un participant", async () => {
    expect(await canAccessEntity(acteurs.req, "TRAINING", t.demande, "DELETE")).toBe(true);
    expect(await canAccessEntity(acteurs.rhA, "TRAINING", t.demande, "DELETE")).toBe(true);
    expect(await canAccessEntity(acteurs.mgr, "TRAINING", t.demande, "DELETE")).toBe(false);
    expect(await canAccessEntity(acteurs.part, "TRAINING", t.session, "DELETE")).toBe(false);
  });

  it("POINTS D'APPEL : la page lit la clause, les actions écrivent les pièces sous TRAINING", () => {
    const page = readFileSync("src/app/(app)/formations/page.tsx", "utf8");
    expect(page).toMatch(/where: await clauseFormationsVisibles\(user\)/);
    expect(page).toMatch(/entityType: "TRAINING"/);
    const actions = readFileSync("src/lib/actions/training-actions.ts", "utf8");
    expect(actions).not.toMatch(/entityType: "DOSSIER"/);
    expect(actions).toMatch(/entityType: "TRAINING", entityId: trainingId/);
  });

  it("LA MIGRATION requalifie par le LIEN CAUSAL : la pièce d'une formation change de type, celle d'un vrai sujet non", async () => {
    // Le texte RÉEL de la migration, joué contre des tables TEMPORAIRES du même nom (`pg_temp` passe
    // devant `public`), dans une transaction annulée : rien de la base partagée n'est lu ni écrit.
    const sql = readFileSync("prisma/migrations/20261224090100_formations_pieces_requalifiees/migration.sql", "utf8");
    const lus = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "Training" ("id" text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "Document" ("id" text, "entityType" text, "entityId" text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "AuditLog" ("id" text, "entityType" text, "entityId" text) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO "Training" VALUES ('t1')`);
      await tx.$executeRawUnsafe(`INSERT INTO "Document" VALUES ('d1','DOSSIER','t1'),('d2','DOSSIER','sujet-1'),('d3','SPONSORING','t1')`);
      await tx.$executeRawUnsafe(`INSERT INTO "AuditLog" VALUES ('a1','DOSSIER','t1'),('a2','DOSSIER','sujet-1')`);
      for (const instr of sql.split(";").map((x) => x.replace(/--.*$/gm, "").trim()).filter(Boolean)) await tx.$executeRawUnsafe(instr);
      // Rejouée, elle ne change rien de plus.
      for (const instr of sql.split(";").map((x) => x.replace(/--.*$/gm, "").trim()).filter(Boolean)) await tx.$executeRawUnsafe(instr);
      const docs = await tx.$queryRawUnsafe<{ id: string; entityType: string }[]>(`SELECT "id", "entityType" FROM "Document" ORDER BY "id"`);
      const logs = await tx.$queryRawUnsafe<{ id: string; entityType: string }[]>(`SELECT "id", "entityType" FROM "AuditLog" ORDER BY "id"`);
      return { docs, logs };
    });
    expect(lus.docs).toEqual([
      { id: "d1", entityType: "TRAINING" },
      { id: "d2", entityType: "DOSSIER" },
      { id: "d3", entityType: "SPONSORING" },
    ]);
    expect(lus.logs).toEqual([{ id: "a1", entityType: "TRAINING" }, { id: "a2", entityType: "DOSSIER" }]);
  });
});
