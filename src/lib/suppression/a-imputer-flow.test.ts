import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { superAdminDeleteMany, apercuSuppressionGroupee, restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__aimputer__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const selection = (ids: string[], kind = "FINANCE_TRANSACTION"): FormData => {
  const fd = new FormData();
  fd.set("kind", kind);
  for (const id of ids) fd.append("id", id);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER DES ÉCRITURES « À IMPUTER », UNE OU PLUSIEURS — par les VRAIS points d'entrée
 * (§118.176). « Tu dois me donner la main pour que je supprime carrément ça, une ou plusieurs. »
 *
 * Ce que chaque cas fait tomber :
 *   • le geste est au Super Admin : un financier qui peut supprimer dans les Finances est refusé ;
 *   • une écriture qui RÈGLE une facture, qu'un ordre de dépense ou une dotation de caisse NOMME :
 *     ces liens sont vidés ensemble, nommés AVANT le clic, et RÉTABLIS à la restauration — supprimée
 *     seule, elle laissait la clé de la facture vidée pour toujours et deux champs texte pointant
 *     vers une écriture disparue ;
 *   • une sélection partiellement valide applique ce qu'elle peut et DIT le reste ;
 *   • la liste des types est fermée, et la taille d'un geste bornée — en le disant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Écritures « à imputer » — suppression groupée par le Super Admin", () => {
  let saId = "", financeId = "", deptId = "";
  const tx: Record<string, string> = {};
  let factureId = "", ordreId = "", dotationId = "";

  const ecriture = async (cle: string, label: string, amount: number) => {
    const r = await prisma.financeTransaction.create({
      data: { reference: `${TAG}${cle}`, direction: "OUT", category: "AUTRE", label: `${TAG} ${label}`, amount, status: "SETTLED", date: new Date("2026-09-15T10:00:00Z") },
      select: { id: true },
    });
    tx[cle] = r.id;
    return r.id;
  };

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } }).then((u) => u.id);
    saId = await mk("sa", "SUPER_ADMIN");
    financeId = await mk("finance", "FINANCE_BUDGET_MANAGER");
    deptId = (await prisma.department.create({ data: { name: `${TAG} Administration`, code: `${TAG}ADM` }, select: { id: true } })).id;

    await ecriture("doublon", "Location de voiture ZERDANI", 375_000);
    await ecriture("info", "Facture informative SOFITEL", 427_200);
    const regleFacture = await ecriture("reglefacture", "Facture EPRINT", 14_280);
    const regleOrdre = await ecriture("regleordre", "Ordre réglé", 50_000);
    const dotation = await ecriture("dotation", "Caisse d'avance — Administration (octobre 2026)", 24_000);

    factureId = (await prisma.legalDocument.create({
      data: { title: `${TAG} Facture EPRINT`, kind: "INVOICE", settlementTxId: regleFacture, paidDate: new Date("2026-09-15") },
      select: { id: true },
    })).id;
    ordreId = (await prisma.expenseOrder.create({
      data: { reference: `${TAG}OD`, label: `${TAG} Ordre`, amount: 50_000, transactionId: regleOrdre },
      select: { id: true },
    })).id;
    dotationId = (await prisma.pettyCashAllotment.create({
      data: { departmentId: deptId, period: "2026-10", amount: 24_000, transactionId: dotation },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    const ids = Object.values(tx);
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "FINANCE_TRANSACTION", entityId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: factureId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: ordreId } }).catch(() => {});
    await prisma.pettyCashAllotment.deleteMany({ where: { id: dotationId } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { id: deptId } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("LE GESTE EST AU SUPER ADMIN : un financier qui supprime dans les Finances est refusé, et rien ne part", async () => {
    ACTOR = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    expect(userCan(ACTOR, "FINANCES", "DELETE"), "PRÉMISSE : le refus ne peut venir que du rôle").toBe(true);
    const r = await superAdminDeleteMany(selection([tx.doublon!]));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Super Admin/);
    expect(await prisma.financeTransaction.count({ where: { id: tx.doublon } })).toBe(1);
    const a = await apercuSuppressionGroupee(selection([tx.doublon!]));
    expect("erreur" in a).toBe(true);
  });

  it("L'APERÇU NOMME, écriture par écriture, ce qui reste et perd son lien — sans rien écrire", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const a = await apercuSuppressionGroupee(selection([tx.reglefacture!, tx.regleordre!, tx.dotation!, tx.info!]));
    if ("erreur" in a) throw new Error(a.erreur);
    const par = new Map(a.elements.map((e) => [e.id, e]));
    expect(par.get(tx.reglefacture!)?.detache.join(" ")).toMatch(/pièce au registre Legal/);
    expect(par.get(tx.regleordre!)?.detache.join(" ")).toMatch(/ordre de dépense/);
    expect(par.get(tx.dotation!)?.detache.join(" ")).toMatch(/dotation de caisse d'avance/);
    expect(par.get(tx.info!)?.detache, "une écriture que rien ne cite ne détache rien").toEqual([]);
    expect(a.elements.every((e) => e.refus === null && e.lot)).toBe(true);
    // N'a rien écrit.
    expect(await prisma.financeTransaction.count({ where: { id: { in: Object.values(tx) } } })).toBe(5);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureId } })).settlementTxId).toBe(tx.reglefacture);
  });

  it("UNE OU PLUSIEURS : la sélection part — ce qui la cite est vidé, et la corbeille la garde", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await superAdminDeleteMany(selection([tx.reglefacture!, tx.regleordre!, tx.dotation!, tx.doublon!]));
    expect(r.ok, r.error).toBe(true);
    expect(r.supprimes).toHaveLength(4);
    expect(r.refus).toEqual([]);
    expect(r.message).toMatch(/4 écritures supprimées/);
    expect(r.message).toMatch(/Corbeille/);
    expect(await prisma.financeTransaction.count({ where: { id: { in: [tx.reglefacture!, tx.regleordre!, tx.dotation!, tx.doublon!] } } })).toBe(0);
    // Ce qui la CITE reste, son lien vidé — jamais un champ texte vers une écriture disparue.
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureId } })).settlementTxId).toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).transactionId).toBeNull();
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: dotationId } })).transactionId).toBeNull();
    // Chacune a SON entrée de corbeille, et la non sélectionnée n'a pas bougé.
    expect(await prisma.deletedRecord.count({ where: { sourceId: { in: [tx.reglefacture!, tx.regleordre!, tx.dotation!, tx.doublon!] }, restoredAt: null } })).toBe(4);
    expect(await prisma.financeTransaction.count({ where: { id: tx.info } })).toBe(1);
  });

  it("RESTAURER rend l'écriture ET ses liens — la facture est de nouveau réglée par elle, l'ordre et la dotation la nomment", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    for (const cle of ["reglefacture", "regleordre", "dotation"] as const) {
      const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: tx[cle], restoredAt: null } });
      const fd = new FormData(); fd.set("id", rec.id);
      const r = await restoreDeletedRecord(fd);
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureId } })).settlementTxId).toBe(tx.reglefacture);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreId } })).transactionId).toBe(tx.regleordre);
    expect((await prisma.pettyCashAllotment.findUniqueOrThrow({ where: { id: dotationId } })).transactionId).toBe(tx.dotation);
  });

  it("PARTIELLEMENT VALIDE : ce qui peut partir part, et le reste est NOMMÉ avec sa raison", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await superAdminDeleteMany(selection([tx.info!, "id-qui-n-existe-pas"]));
    expect(r.ok).toBe(true);
    expect(r.supprimes).toHaveLength(1);
    expect(r.refus).toHaveLength(1);
    expect(r.refus[0]!.raison).toMatch(/introuvable/i);
    expect(r.message).toMatch(/1 écriture supprimée/);
    expect(r.message).toMatch(/1 refusée/);
  });

  it("LA LISTE DES TYPES EST FERMÉE, et un geste a une taille — dite, pas tue", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const autre = await superAdminDeleteMany(selection([factureId], "LEGAL_DOCUMENT"));
    expect(autre.ok).toBe(false);
    expect(autre.error).toMatch(/ne se supprime pas en sélection/);
    expect(await prisma.legalDocument.count({ where: { id: factureId } })).toBe(1);
    const trop = await superAdminDeleteMany(selection(Array.from({ length: 101 }, (_, i) => `x${i}`)));
    expect(trop.ok).toBe(false);
    expect(trop.error).toMatch(/101 éléments/);
  });
});
