import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { apercuSuppressionEnveloppe, deleteEnvelope } from "@/lib/actions/budget-envelope-actions";
import { restoreDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { trouverOuCreerEnveloppe } from "./enveloppe-unique";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UNE ENVELOPPE — par les VRAIS points d'entrée (Direction générale, 25/11/2026) :
 *
 *   • refusée à un directeur (règle serveur), même s'il voit l'écran ;
 *   • le DG lit l'aperçu chiffré, doit RETAPER le nom, puis l'enveloppe part À LA CORBEILLE avec ses lignes ;
 *   • les dépenses ne sont pas effacées : l'écriture et l'ordre redeviennent « à imputer » (sans catégorie) ;
 *   • restaurée par le Super Admin, elle revient avec ses lignes (mêmes identifiants) et les dépenses s'y rattachent ;
 *   • le Super Admin la supprime aussi ; une enveloppe qui porte une dépense saisie dans ses lignes est refusée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__suppenv${Date.now().toString(36)}__`;
const ANNEE = 2033;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("Supprimer une enveloppe — Direction générale, réversible, dépenses « à imputer »", () => {
  let saId = "", dgId = "", dirId = "";
  let envId = "", ligneA = "", ligneB = "", ecriture = "", ordre = "";
  const NOM = `${TAG} Événements ${ANNEE}`;

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } }).then((u) => u.id);
    saId = await mk("sa", "SUPER_ADMIN");
    dgId = await mk("dg", "GENERAL_MANAGER");
    dirId = await mk("dir", "OPERATIONS_DIRECTOR");
    envId = (await trouverOuCreerEnveloppe({ companyId: null, annee: ANNEE, direction: null }, { name: NOM, totalAmount: 800_000 })).id;
    ligneA = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: "Logistique", allocated: 500_000 } })).id;
    ligneB = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, parentId: ligneA, name: "Traiteur", allocated: 100_000 } })).id;
    ecriture = (await prisma.financeTransaction.create({ data: { reference: `${TAG}FT`, direction: "OUT", category: "AUTRE", label: `${TAG} Traiteur`, amount: 120_000, status: "SETTLED", date: new Date(Date.UTC(ANNEE, 3, 2)), budgetCategoryId: ligneA } })).id;
    ordre = (await prisma.expenseOrder.create({ data: { reference: `${TAG}OD`, label: `${TAG} Salle`, amount: 60_000, status: "PENDING", budgetCategoryId: ligneB } })).id;
  });

  afterAll(async () => {
    await prisma.deletedRecord.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const comptes = [saId, dgId, dirId];
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("refusée à un directeur — règle serveur, rien ne part", async () => {
    ACTOR = await actorFor(dirId, "OPERATIONS_DIRECTOR");
    const r = await deleteEnvelope(fd({ id: envId, nom: NOM }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Direction générale/);
    expect((await apercuSuppressionEnveloppe(fd({ id: envId }))).ok).toBe(false);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(1);
  });

  it("le DG : aperçu chiffré, nom retapé, corbeille — les dépenses redeviennent « à imputer »", async () => {
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const a = await apercuSuppressionEnveloppe(fd({ id: envId }));
    if (!a.ok) throw new Error(a.error);
    expect(a.apercu).toMatchObject({ nom: NOM, lignes: 2, alloue: 500_000, total: 800_000, refus: null });
    expect(a.apercu.depenses).toEqual({ nombre: 1, montant: 120_000 });
    expect(a.apercu.engagements).toEqual({ nombre: 1, montant: 60_000 });
    expect(a.apercu.aImputer.join(" · ")).toMatch(/écriture/);
    expect(a.apercu.aImputer.join(" · ")).toMatch(/ordre de dépense/);

    const mauvais = await deleteEnvelope(fd({ id: envId, nom: "Événements" }));
    expect(mauvais.ok).toBe(false);
    expect(mauvais.error).toContain(NOM);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(1);

    const r = await deleteEnvelope(fd({ id: envId, nom: `  ${NOM.toUpperCase()} ` }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(0);
    expect(await prisma.budgetCategoryLine.count({ where: { id: { in: [ligneA, ligneB] } } })).toBe(0);
    // Rien d'effacé : l'écriture et l'ordre restent, sans catégorie — « à imputer ».
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: ecriture } })).budgetCategoryId).toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).budgetCategoryId).toBeNull();
    expect(await prisma.deletedRecord.count({ where: { kind: "BUDGET_ENVELOPE", sourceId: envId, restoredAt: null } })).toBe(1);
  });

  it("restaurée par le Super Admin : l'enveloppe, ses lignes (mêmes identifiants), et les dépenses s'y rattachent de nouveau", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "BUDGET_ENVELOPE", sourceId: envId, restoredAt: null } });
    const r = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: envId } })).name).toBe(NOM);
    expect((await prisma.budgetCategoryLine.findUniqueOrThrow({ where: { id: ligneB } })).parentId).toBe(ligneA);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: ecriture } })).budgetCategoryId).toBe(ligneA);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).budgetCategoryId).toBe(ligneB);
  });

  it("une dépense SAISIE dans ses lignes bloque (elle ne peut pas devenir « à imputer ») ; le Super Admin supprime ensuite", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const saisie = await prisma.budgetExpenseLine.create({ data: { categoryId: ligneB, reference: `${TAG} BV`, amount: 9_000 } });
    const a = await apercuSuppressionEnveloppe(fd({ id: envId }));
    expect(a.ok && a.apercu.refus).toMatch(/saisie/);
    const refus = await deleteEnvelope(fd({ id: envId, nom: NOM }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Déplacez-les/);
    expect(await prisma.budgetEnvelope.count({ where: { id: envId } })).toBe(1);

    await prisma.budgetExpenseLine.delete({ where: { id: saisie.id } });
    const r = await deleteEnvelope(fd({ id: envId, nom: NOM }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: ecriture } })).budgetCategoryId).toBeNull();
  });
});
