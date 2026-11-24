import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { prevenirSuperviseurPanelVide } from "@/lib/actions/visite-medicale-actions";
import { envoyerVisite } from "@/app/(app)/medical/ma-journee/envoi-visite";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { loadJourneeDuDelegue } from "@/lib/queries/tour-schedule";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { dernieresVisites, planDuJour } from "@/lib/queries/journee-delegue";
import { fusionnerJournee, jourLocal, prochaineVisite } from "@/lib/sfe/journee-visite";
import { periodeDe } from "@/lib/sfe/tournee";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « VISITE MÉDICALE » DE BOUT EN BOUT (11/2026), par les vrais points d'entrée :
 *
 *  · l'aiguillage de `/medical` — le délégué vers « Ma journée », le superviseur vers son équipe, le directeur
 *    des opérations vers le Cockpit ;
 *  · la liste du jour — la visite planifiée en tête, le même médecin absent de « À rattraper » ;
 *  · toucher un médecin PLANIFIÉ clôt CETTE visite (pas de doublon, plus de « délai dépassé » sur la ligne
 *    prévue) ; un autre médecin est une visite hors plan ;
 *  · « La dernière fois » relit la visite rapportée ;
 *  · un panel vide se signale au superviseur de la BU, une fois par jour, sous le nom « Visite médicale ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__vm1flow__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

suite("Visite médicale — aiguillage, liste du jour, une seule porte par visite, panel vide", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, string> = { kam: "MEDICAL_DELEGATE", vide: "MEDICAL_DELEGATE", sup: "NATIONAL_SALES", dop: "OPERATIONS_DIRECTOR" };
  let buId = "", doc1 = "", doc2 = "", produit = "", message = "";
  const acteur = async (k: string) =>
    ({ id: u[k], name: `${TAG}${k}`, role: roles[k], secondaryRole: null, access: await getAccess(u[k]!, roles[k] as never) } as unknown as SessionUser);
  const comme = async (k: string) => { ACTEUR = await acteur(k); return ACTEUR as SessionUser; };

  async function nettoyer() {
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.medicalVisitProduct.deleteMany({ where: { visit: { delegateId: { in: ids } } } }).catch(() => {});
    await prisma.medicalVisitMessage.deleteMany({ where: { visit: { delegateId: { in: ids } } } }).catch(() => {});
    await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: ids } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.promoMessage.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" }, select: { id: true } })).id;
    }
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie`, supervisorId: u.sup }, select: { id: true } });
    buId = bu.id;
    await prisma.salesRepProfile.create({ data: { repId: u.kam!, businessUnitId: bu.id } });
    await prisma.salesRepProfile.create({ data: { repId: u.vide!, businessUnitId: bu.id } });
    const p = await prisma.product.create({ data: { code: `${TAG}P1`, canonicalName: `${TAG}Nivolex`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivo` } as never, select: { id: true } });
    produit = p.id;
    await prisma.promoProduct.create({ data: { name: `${TAG}Nivolex`, businessUnitId: bu.id, productId: p.id } });
    message = (await prisma.promoMessage.create({ data: { title: `${TAG}Message 1`, businessUnitId: bu.id }, select: { id: true } })).id;
    doc1 = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Achour`, delegateId: u.kam, potential: "VERY_HIGH" } as never, select: { id: true } })).id;
    doc2 = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Benali`, delegateId: u.kam, potential: "VERY_HIGH" } as never, select: { id: true } })).id;
  });
  afterAll(nettoyer);

  it("l'aiguillage : le délégué, son superviseur, le directeur des opérations — chacun son écran", async () => {
    expect((await aiguillerVisite(await acteur("kam"))).chemin).toBe("/medical/ma-journee");
    // panel vide, mais délégué : il va sur « Ma journée », où la cause et le remède s'affichent
    expect((await aiguillerVisite(await acteur("vide"))).chemin).toBe("/medical/ma-journee");
    // National Sales qui SUPERVISE la BU, sans tournée à lui : l'écran de son équipe, filtré sur sa BU
    expect((await aiguillerVisite(await acteur("sup"))).chemin).toBe(`/planning?bu=${encodeURIComponent(buId)}`);
    expect((await aiguillerVisite(await acteur("dop"))).chemin).toBe("/operations");
  });

  it("la liste du jour, et toucher le médecin PLANIFIÉ clôt SA visite — jamais une seconde à côté", async () => {
    const kam = await comme("kam");
    const maintenant = new Date();
    const { debut, fin } = periodeDe("MONTH", maintenant);
    const plan = await prisma.tourPlan.create({
      data: {
        repId: u.kam!, periodStart: debut, periodEnd: fin, granularity: "MONTH", status: "SUBMITTED", submissionDueAt: debut,
        reviewerId: u.sup, submittedAt: new Date(maintenant.getTime() - 2 * 86_400_000), createdById: u.kam,
      },
      select: { id: true },
    });
    const prevue = await prisma.medicalVisit.create({
      data: { date: new Date(`${jourLocal(maintenant)}T00:00:00`), doctorId: doc1, delegateId: u.kam, status: "PLANNED", origin: "PLAN", tourPlanId: plan.id, createdById: u.kam },
      select: { id: true },
    });

    const [day, edt, p] = await Promise.all([loadMyFieldDay(u.kam!), loadJourneeDuDelegue(kam), planDuJour(u.kam!)]);
    expect(p).toMatchObject({ id: plan.id, status: "SUBMITTED", chez: `${TAG}sup` });
    const j = fusionnerJournee({
      visites: edt.lignes.map((l) => ({ ...l, date: l.date.toISOString() })),
      rattrapages: day.tournee,
      aujourdhui: jourLocal(maintenant),
    });
    expect(j.aujourdhui.map((c) => c.id)).toEqual([prevue.id]);
    expect(j.aujourdhui[0]).toMatchObject({ geste: "COMMENCER", jourPasse: false });
    // Dr Achour est prévu aujourd'hui : il ne figure pas « à rattraper » ; Dr Benali, oui
    expect(j.aRattraper.map((r) => r.doctorId)).toEqual([doc2]);
    expect(prochaineVisite(j)).toEqual({ sorte: "PLANIFIEE", visitId: prevue.id });

    const r = await envoyerVisite("RAPPORT", fd({ visitId: prevue.id, productId: produit, messageId: message, report: "Il attend l'étude de phase III.", followUpActions: "Apporter l'étude" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const visites = await prisma.medicalVisit.findMany({ where: { doctorId: doc1 }, select: { id: true, status: true } });
    expect(visites).toEqual([{ id: prevue.id, status: "COMPLETED" }]);
    const audit = await prisma.auditLog.findFirst({ where: { actorId: u.kam, entityId: prevue.id }, select: { module: true } });
    expect(audit?.module).toBe(MODULE_AUDIT_VISITE);

    // « La dernière fois » relit ce qui vient d'être rapporté
    const [derniere] = await dernieresVisites(u.kam!, [doc1]);
    expect(derniere).toMatchObject({ visitId: prevue.id, produits: [`${TAG}Nivolex`], messages: [`${TAG}Message 1`], suite: "Apporter l'étude" });

    // Un autre médecin : une visite HORS PLAN, créée, hors du plan
    const h = await envoyerVisite("HORS_PLAN", fd({ doctorId: doc2, report: "Rencontré au CHU." }));
    expect(h.ok, h.ok ? "" : h.error).toBe(true);
    expect(await prisma.medicalVisit.findMany({ where: { doctorId: doc2 }, select: { origin: true, tourPlanId: true, status: true } }))
      .toEqual([{ origin: "UNPLANNED", tourPlanId: null, status: "COMPLETED" }]);
  });

  it("le serveur reste le juge : un rapport arrivé après ses 48 h est refusé, avec le délai dit", async () => {
    await comme("kam");
    const vieille = await prisma.medicalVisit.create({
      data: { date: new Date(Date.now() - 4 * 86_400_000), doctorId: doc2, delegateId: u.kam, status: "PLANNED", origin: "PLAN", createdById: u.kam },
      select: { id: true },
    });
    const r = await envoyerVisite("RAPPORT", fd({ visitId: vieille.id, productId: produit, messageId: message, report: "Vu." }));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/dans les 48 h/);
  });

  it("panel vide : le superviseur de la BU est prévenu, avec la cause — une fois par jour", async () => {
    await comme("vide");
    const r = await prevenirSuperviseurPanelVide();
    expect(r).toMatchObject({ ok: true });
    expect(r.ok ? r.message : "").toMatch(new RegExp(`${TAG}sup est prévenu`));
    const notes = await prisma.notification.findMany({ where: { userId: u.sup }, select: { title: true, body: true, link: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ title: `Panel vide — ${TAG}vide`, link: "/business-units" });
    expect(notes[0]!.body).toMatch(/ne peut ni planifier ni rapporter/);
    expect(await prisma.auditLog.count({ where: { actorId: u.vide, module: MODULE_AUDIT_VISITE } })).toBe(1);

    const encore = await prevenirSuperviseurPanelVide();
    expect(encore.ok ? encore.message : "").toMatch(/déjà été prévenu/);
    expect(await prisma.notification.count({ where: { userId: u.sup } })).toBe(1);

    // un panel rempli n'a plus rien à signaler
    await comme("kam");
    const plein = await prevenirSuperviseurPanelVide();
    expect(plein).toMatchObject({ ok: false });
    expect(plein.ok ? "" : plein.error).toMatch(/n'est plus vide/);
  });
});
