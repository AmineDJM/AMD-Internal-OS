import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — LE DÉPARTEMENT INFORMATIQUE, RÉVERSIBLE : abonnements (créer, modifier, résilier), parc (créer, modifier) et
 * imputation du coût de l'IA, EXÉCUTÉS par leurs vraies actions puis ANNULÉS (le bouton « Annuler ») contre la base —
 * l'état d'avant tel que la déclaration (`declarations/metiers.ts`) le promet.
 *
 * L'acteur est le responsable du département Informatique de SA société (les trois clés lui sont ouvertes par défaut),
 * comme dans `modules/informatique/informatique-flow.test.ts`. Le coût de l'IA est mesuré sur un mois ancien, propre au
 * banc, pour ne rien croiser dans la base partagée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { assurerDepartementInformatique } from "@/modules/informatique/api";
import { creerAbonnement, modifierAbonnement, resilierAbonnement } from "@/modules/informatique/actions-abonnements";
import { creerMateriel, modifierMateriel } from "@/modules/informatique/actions-parc";
import { imputerCoutIa } from "@/modules/informatique/actions-cout-ia";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10cinfo${Date.now().toString(36)}`;
/** Un mois ancien, sans autre appel de modèle dans la base partagée : le banc y est seul. */
const MOIS = "2017-05";
let CHEF: CurrentUser;
let companyId = "";
let deptId = "";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% ${nom} ${Math.random()}\n%%EOF\n`)], nom, { type: "application/pdf" });
const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string) => {
  const r = await annulerGeste(gesteId, CHEF);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};

suite("K10c — département Informatique : exécuter, puis annuler", () => {
  beforeAll(async () => {
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma` } })).id;
    deptId = (await assurerDepartementInformatique(companyId)).id;
    const u = await prisma.user.create({ data: { name: `${TAG} chef`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} Chef informatique`, companyId, departmentId: deptId, userId: u.id } });
    await prisma.department.update({ where: { id: deptId }, data: { headId: emp.id } });
    CHEF = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    ACTOR = CHEF;
    await prisma.modelCallLog.create({
      data: { at: new Date(Date.UTC(2017, 4, 10, 10)), userId: u.id, feature: "assistant_ia", costUsd: "2.000000", role: "fil", provider: "openai", model: `${TAG}modele`, inputTokens: 10, outputTokens: 5 },
    });
  });

  afterAll(async () => {
    ACTOR = null;
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: CHEF.id } }).catch(() => undefined);
    const imps = await prisma.imputationCoutIa.findMany({ where: { companyId }, select: { expenseLineId: true } }).catch(() => []);
    await prisma.budgetExpenseLine.deleteMany({ where: { id: { in: imps.flatMap((i) => (i.expenseLineId ? [i.expenseLineId] : [])) } } }).catch(() => undefined);
    await prisma.imputationCoutIa.deleteMany({ where: { companyId } }).catch(() => undefined);
    const envIds = (await prisma.budgetEnvelope.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((e) => e.id);
    await prisma.budgetExpenseLine.deleteMany({ where: { category: { envelopeId: { in: envIds } } } }).catch(() => undefined);
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envIds } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envIds } } }).catch(() => undefined);
    await prisma.modelCallLog.deleteMany({ where: { model: `${TAG}modele` } }).catch(() => undefined);
    const abos = (await prisma.abonnementInformatique.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((a) => a.id);
    await retirerDocumentsEtContenu({ where: { entityType: "IT_SUBSCRIPTION", entityId: { in: abos } } }).catch(() => undefined);
    await prisma.abonnementInformatique.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.materielInformatique.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: CHEF.id } }).catch(() => undefined);
    await prisma.department.updateMany({ where: { id: deptId }, data: { headId: null } }).catch(() => undefined);
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: CHEF.id } }).catch(() => undefined);
    await prisma.department.deleteMany({ where: { companyId } }).catch(() => undefined);
    await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
  });

  it("creerAbonnement → annulé : la fiche disparaît, sa pièce jointe avec elle", async () => {
    const f = fd({ companyId, fournisseur: `${TAG} OpenAI`, objet: "API", montant: "200", devise: "USD", periodicite: "MENSUEL" });
    f.set("piece", pdf("contrat.pdf"));
    const r = await creerAbonnement(f);
    ok(r);
    expect(await prisma.document.count({ where: { entityType: "IT_SUBSCRIPTION", entityId: r.id! } })).toBe(1);
    await annuler(gesteDe(r));
    expect(await prisma.abonnementInformatique.count({ where: { id: r.id! } })).toBe(0);
    expect(await prisma.document.count({ where: { entityType: "IT_SUBSCRIPTION", entityId: r.id! } })).toBe(0);
  });

  it("modifierAbonnement puis resilierAbonnement → annulés : valeurs d'avant, l'abonnement redevient actif", async () => {
    const c = await creerAbonnement(fd({ companyId, fournisseur: `${TAG} Anthropic`, objet: "API", montant: "100", devise: "USD", periodicite: "MENSUEL", notes: "équipe" }));
    ok(c);
    const m = await modifierAbonnement(fd({ id: c.id!, montant: "150", notes: "toute la société" }));
    ok(m);
    expect(Number((await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: c.id! } })).montant)).toBe(150);
    await annuler(gesteDe(m));
    const apres = await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: c.id! } });
    expect([Number(apres.montant), apres.notes]).toEqual([100, "équipe"]);

    const x = await resilierAbonnement(fd({ id: c.id! }));
    ok(x);
    expect((await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: c.id! } })).statut).toBe("RESILIE");
    await annuler(gesteDe(x));
    expect((await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: c.id! } })).statut).toBe("ACTIF");
  });

  it("creerMateriel → annulé : la fiche disparaît ; modifierMateriel → annulé : valeurs d'avant", async () => {
    const r = await creerMateriel(fd({ companyId, type: "PORTABLE", reference: `${TAG} Dell Latitude` }));
    ok(r);
    await annuler(gesteDe(r));
    expect(await prisma.materielInformatique.count({ where: { id: r.id! } })).toBe(0);

    const c = await creerMateriel(fd({ companyId, type: "PORTABLE", reference: `${TAG} Lenovo ThinkPad`, notes: "neuf" }));
    ok(c);
    const avant = await prisma.materielInformatique.findUniqueOrThrow({ where: { id: c.id! } });
    const m = await modifierMateriel(fd({ id: c.id!, etat: "EN_REPARATION", notes: "écran cassé" }));
    ok(m);
    expect((await prisma.materielInformatique.findUniqueOrThrow({ where: { id: c.id! } })).etat).toBe("EN_REPARATION");
    await annuler(gesteDe(m));
    const apres = await prisma.materielInformatique.findUniqueOrThrow({ where: { id: c.id! } });
    expect([apres.etat, apres.notes]).toEqual([avant.etat, "neuf"]);
  });

  it("imputerCoutIa → annulé : l'imputation créée et sa ligne de dépense budgétaire sont retirées", async () => {
    const r = await imputerCoutIa(fd({ mois: MOIS, taux: "135" }));
    ok(r);
    const imp = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId, mois: MOIS } } });
    expect(imp.expenseLineId).toBeTruthy();
    expect(Number((await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: imp.expenseLineId! } })).amount)).toBe(270);
    await annuler(gesteDe(r));
    expect(await prisma.imputationCoutIa.count({ where: { companyId, mois: MOIS } })).toBe(0);
    expect(await prisma.budgetExpenseLine.count({ where: { id: imp.expenseLineId! } })).toBe(0);
    // La preuve par le geste : le mois se réimpute.
    ok(await imputerCoutIa(fd({ mois: MOIS, taux: "135" })));
    expect(await prisma.imputationCoutIa.count({ where: { companyId, mois: MOIS } })).toBe(1);
  });
});
