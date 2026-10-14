import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  ouvrirPlanTournee, planifierVisites, soumettrePlanTournee, deciderPlanTournee, escaladerPlanTournee,
} from "@/lib/actions/tour-plan-actions";
import { loadPlanTournee } from "@/lib/queries/tour-schedule";
import { accesAuPlan, periodeSuivante, type StatutPlan } from "@/lib/sfe/tournee";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI VOIT ET QUI TRANCHE UN PLAN DE TOURNÉE (§118.184) — l'audit 360° a nommé quatre défauts sur
 * le même écran : le plan d'un collègue s'ouvrait par son lien (panel et motif de rejet compris), le
 * N+2 d'un plan escaladé n'avait aucun bouton, le circuit n'envoyait aucune notification, et le
 * validateur tranchait sans voir les visites. Ce banc tient la règle (table de vérité) et le circuit
 * réel, avec un VRAI N+2 à l'organigramme — le banc historique n'en avait pas, si bien que
 * l'escalade n'y était jamais jouée jusqu'à la décision.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const base = {
  repId: "kam", reviewerId: "sup", escalatedToId: null as string | null, vueGlobale: false,
  chaineDuKam: [] as string[], agitPour: [] as string[],
};
const regle = (userId: string, statut: StatutPlan, extra: Partial<typeof base> = {}) =>
  accesAuPlan({ ...base, ...extra, userId, statut });

describe("accesAuPlan — la règle unique de l'écran et des actions", () => {
  it("le KAM voit son plan mais ne le tranche jamais", () => {
    expect(regle("kam", "SUBMITTED")).toEqual({ voir: true, decider: false, escalader: false });
    // Même avec une vue globale : on ne valide pas son propre plan.
    expect(regle("kam", "SUBMITTED", { vueGlobale: true }).decider).toBe(false);
  });

  it("le validateur tranche et escalade un plan SOUMIS — plus rien une fois escaladé", () => {
    expect(regle("sup", "SUBMITTED")).toEqual({ voir: true, decider: true, escalader: true });
    expect(regle("sup", "ESCALATED", { escalatedToId: "n2" })).toEqual({ voir: true, decider: false, escalader: false });
  });

  it("le N+2 tranche un plan ESCALADÉ — l'ancien écran ne lui donnait aucun bouton", () => {
    expect(regle("n2", "ESCALATED", { escalatedToId: "n2" })).toEqual({ voir: true, decider: true, escalader: false });
  });

  it("un collègue avec le module ne voit rien ; un manager de la chaîne voit sans trancher", () => {
    expect(regle("collegue", "SUBMITTED")).toEqual({ voir: false, decider: false, escalader: false });
    expect(regle("manager", "SUBMITTED", { chaineDuKam: ["manager"] })).toEqual({ voir: true, decider: false, escalader: false });
  });

  it("L'INTÉRIMAIRE du réviseur voit, tranche et escalade — et jamais son propre plan (§118.185, I18)", () => {
    expect(regle("interim", "SUBMITTED", { agitPour: ["sup"] })).toEqual({ voir: true, decider: true, escalader: true });
    // Celui du N+2 tranche le plan escaladé ; celui du réviseur ne le tranche plus.
    expect(regle("interim2", "ESCALATED", { escalatedToId: "n2", agitPour: ["n2"] }).decider).toBe(true);
    expect(regle("interim", "ESCALATED", { escalatedToId: "n2", agitPour: ["sup"] }).decider).toBe(false);
    // Le KAM qui remplace son propre réviseur ne s'approuve pas.
    expect(regle("kam", "SUBMITTED", { agitPour: ["sup"] })).toMatchObject({ decider: false, escalader: false });
    // Le témoin : sans intérim, la même personne ne voit rien.
    expect(regle("interim", "SUBMITTED")).toEqual({ voir: false, decider: false, escalader: false });
  });

  it("une vue globale voit et tranche ce qui attend ; rien ne se tranche hors des états décidables", () => {
    expect(regle("dir", "SUBMITTED", { vueGlobale: true })).toEqual({ voir: true, decider: true, escalader: true });
    expect(regle("dir", "ESCALATED", { vueGlobale: true, escalatedToId: "n2" })).toEqual({ voir: true, decider: true, escalader: false });
    for (const statut of ["DRAFT", "APPROVED", "REJECTED"] as StatutPlan[]) {
      expect(regle("sup", statut)).toEqual({ voir: true, decider: false, escalader: false });
    }
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__tourneeacces__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};
const jourIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

suite("Plan de tournée — accès, escalade jusqu'à la décision, notifications (vrais points d'entrée)", () => {
  let kamId = "", supId = "", n2Id = "", collegueId = "", planId = "", docId = "";
  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser);
  const notifs = async (userId: string) =>
    prisma.notification.findMany({ where: { userId, link: { contains: planId } }, select: { title: true, body: true } });

  async function nettoyer() {
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.medicalVisit.deleteMany({ where: { delegate: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { rep: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, sup, n2, collegue] = await Promise.all([
      mk("Kam", "MEDICAL_DELEGATE"), mk("Superviseur", "NATIONAL_SALES"),
      mk("N2", "OPERATIONS_DIRECTOR"), mk("Collegue", "MEDICAL_DELEGATE"),
    ]);
    kamId = kam.id; supId = sup.id; n2Id = n2.id; collegueId = collegue.id;
    // L'ORGANIGRAMME : le superviseur rapporte au N+2 — c'est lui que l'escalade désigne.
    const eN2 = await prisma.employee.create({ data: { fullName: `${TAG}N2`, userId: n2.id } });
    await prisma.employee.create({ data: { fullName: `${TAG}Superviseur`, userId: sup.id, managerId: eN2.id } });
    await prisma.employee.create({ data: { fullName: `${TAG}Kam`, userId: kam.id } });
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, supervisorId: sup.id } });
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });
    docId = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: kam.id, wilaya: "Alger" } })).id;

    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const periode = periodeSuivante("MONTH", new Date());
    const o = await ouvrirPlanTournee(fd({ granularity: "MONTH", date: periode.debut.toISOString() }));
    expect(o.ok, o.ok === false ? o.error : "").toBe(true);
    planId = (o.ok && o.id) || "";
    let jour = "";
    for (const d = new Date(periode.debut); d <= periode.fin; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 5 && d.getDay() !== 6) { jour = jourIso(d); break; }
    }
    const p = await planifierVisites(fd({ planId, visite: [`${jour}|${docId}`] }));
    expect(p.ok, p.ok === false ? p.error : "").toBe(true);
  });

  afterAll(async () => {
    await nettoyer();
  });

  it("soumettre PRÉVIENT le validateur, avec le lien du plan", async () => {
    ACTEUR = await acteur(kamId, "MEDICAL_DELEGATE");
    const r = await soumettrePlanTournee(fd({ planId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const n = await notifs(supId);
    expect(n.map((x) => x.title)).toEqual([expect.stringContaining("Plan de tournée à valider")]);
    // Le chargeur rend les IDENTIFIANTS dont la règle a besoin.
    const vue = await loadPlanTournee(planId);
    expect(vue?.reviewerId).toBe(supId);
  });

  it("un collègue avec le module ne tranche pas", async () => {
    ACTEUR = await acteur(collegueId, "MEDICAL_DELEGATE");
    const r = await deciderPlanTournee(fd({ planId, decision: "APPROVE" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("Seule la personne à qui ce plan est soumis");
  });

  it("escalader DÉSIGNE le N+2 de l'organigramme et le PRÉVIENT", async () => {
    ACTEUR = await acteur(supId, "NATIONAL_SALES");
    const r = await escaladerPlanTournee(fd({ planId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(p.status).toBe("ESCALATED");
    expect(p.escalatedToId).toBe(n2Id);
    expect((await notifs(n2Id)).map((x) => x.title)).toEqual([expect.stringContaining("escaladé")]);
  });

  it("une fois escaladé, le validateur ne tranche plus — c'est au N+2", async () => {
    ACTEUR = await acteur(supId, "NATIONAL_SALES");
    const r = await deciderPlanTournee(fd({ planId, decision: "APPROVE" }));
    expect(r.ok).toBe(false);
  });

  it("le N+2 SANS vue globale tranche — et le KAM reçoit le motif ET son délai", async () => {
    ACTEUR = await acteur(n2Id, "OPERATIONS_DIRECTOR");
    const r = await deciderPlanTournee(fd({ planId, decision: "REJECT", comment: "Pas assez de CHU la première semaine." }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const p = await prisma.tourPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(p.status).toBe("REJECTED");
    expect(p.decidedById).toBe(n2Id);
    const n = await notifs(kamId);
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain("rejeté");
    expect(n[0].body).toContain("Pas assez de CHU");
    expect(n[0].body).toContain("À resoumettre avant le");
  });
});

describe("Plan de tournée — les points d'appel de la règle (§118.49)", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("la page lit la règle, répond « introuvable » hors de la règle, et passe ses gestes à l'écran", () => {
    const page = src("src/app/(app)/medical/plan-de-tournee/page.tsx");
    expect(page).toMatch(/accesAuPlan\(/);
    expect(page).toMatch(/if \(plan && !acces\?\.voir\) notFound\(\);/);
    expect(page).toMatch(/jePeuxDecider=\{acces\?\.decider \?\? false\}/);
    expect(page).toMatch(/jePeuxEscalader=\{acces\?\.escalader \?\? false\}/);
    // Le panel n'est chargé qu'APRÈS la garde : il ne doit pas partir dans la page d'un intrus.
    expect(page.indexOf("notFound();")).toBeLessThan(page.indexOf("loadPanelPlanifiable(plan.repId)"));
  });
  it("les actions d'escalade et de décision lisent la même règle", () => {
    const actions = src("src/lib/actions/tour-plan-actions.ts");
    expect((actions.match(/accesAuPlan\(/g) ?? []).length).toBe(2);
    // Trois pour le circuit (soumettre, escalader, décider), trois pour la révision d'un plan validé (§118.193) :
    // la personne qui l'a validée quand le KAM rouvre ; le KAM, et le validateur s'il n'est pas l'auteur, sinon.
    expect((actions.match(/notifyUser\(/g) ?? []).length).toBe(6);
  });
  it("le validateur voit les visites qu'il valide — la lecture jour par jour existe hors édition", () => {
    const ecran = src("src/app/(app)/medical/plan-de-tournee/planificateur.tsx");
    expect(ecran).toContain("Visites prévues");
    // La grille jour par jour (Direction, 06/10) se rend HORS édition aussi : en lecture, rien ne s'y déplace.
    expect(ecran).toMatch(/<GrilleTournee/);
    expect(ecran).toMatch(/modifiable=\{modifiable\}/);
    expect(ecran).not.toMatch(/\{modifiable \? \(\s*<GrilleTournee/);
  });
  it("« à resoumettre » se lit sur la même règle dans l'en-tête du plan et dans la liste des plans — la révision comprise (§118.193)", () => {
    const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
    const ecran = sansCommentaires(src("src/app/(app)/medical/plan-de-tournee/planificateur.tsx"));
    const page = sansCommentaires(src("src/app/(app)/medical/plan-de-tournee/page.tsx"));
    expect(ecran).toMatch(/aResoumettre\(status\) \? "resoumettre" : "soumettre"/);
    expect(page).toMatch(/aResoumettre\(p\.status as StatutPlan\) \? "resoumettre" : "soumettre"/);
    // La liste montre l'échéance de tout plan à soumettre — un plan en révision compris.
    expect(page).toMatch(/gestesPossibles\(p\.status as StatutPlan\)\.soumettable && \(\(\) => \{/);
    // Aucune comparaison écrite à la main ne revient à côté.
    for (const t of [ecran, page]) expect(t).not.toMatch(/=== "REJECTED" \? "resoumettre"/);
  });
});
