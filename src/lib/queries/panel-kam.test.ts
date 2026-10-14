import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { clausePanelDuKam, getAccess, scopeMedicalDoctors, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { loadPanelPlanifiable } from "@/lib/queries/tour-schedule";
import { loadMyFieldDay } from "@/lib/queries/my-field-day";
import { loadCockpit } from "@/lib/queries/sfe-cockpit";
import { getTeamMemberKpis } from "@/lib/queries/team-kpis";
import { kamsQuiCouvrent, panelsDesKams } from "@/lib/queries/panel-kam";
import { logVisit } from "@/lib/actions/medical-actions";
import { ajouterVisiteImprevue } from "@/lib/actions/tour-visit-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__panelkam__";
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN SEUL PANEL DU KAM, LU PAR TOUS SES LECTEURS (§118.179).
 *
 * Il y avait deux définitions : le plan de tournée lisait « secteur ∪ rattachement », tout le
 * reste — Ma journée, la saisie d'une visite, la visite imprévue, le cockpit et ses alertes, la
 * carte d'équipe, l'accès à la fiche — le seul rattachement. Ce banc fait se rencontrer TOUS les
 * lecteurs sur le même décor et exige le même ensemble de praticiens.
 *
 * Le décor éprouve chaque branche de la règle, et ce qu'elle ne fait PAS :
 *  - un établissement entier (tous les services) → tous ses praticiens, même sans service ;
 *  - un établissement restreint → le praticien du service choisi, pas celui d'un autre service,
 *    ni celui qui n'a pas de service (on ne devine pas, §118.34) ;
 *  - un secteur INACTIF ne couvre rien ;
 *  - un praticien rattaché au KAM, sans établissement (un libéral) → dans le panel ;
 *  - un praticien rattaché à un AUTRE KAM, dans un établissement que le secteur couvre → dans
 *    les DEUX panels (deux KAM couvrent le même hôpital, chacun pour sa gamme).
 *
 * Les acteurs n'ont PAS de vue globale (§118.104) : un Super Admin voit tout, et la règle ne
 * pourrait pas tomber.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Le panel du KAM — une définition, tous ses lecteurs (§118.179)", () => {
  let kam = "", autreKam = "", sansSecteur = "";
  let entier = "", restreint = "", inactif = "";
  let svcChoisi = "", svcAutre = "";
  let dEntierSansService = "", dRestreintChoisi = "", dRestreintAutre = "", dRestreintSansService = "",
    dInactif = "", dLiberal = "", dAutreKamDansLeSecteur = "", dHorsDeTout = "";

  const acteur = async (id: string, role: string) =>
    ({ id, role, secondaryRole: null, name: `${TAG}${role}`, access: await getAccess(id, role as never) } as unknown as SessionUser);

  const nettoyer = async () => {
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    const ids = comptes.map((c) => c.id);
    await prisma.medicalVisit.deleteMany({ where: { delegateId: { in: ids } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [k, ak, ss] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("autre", "MEDICAL_DELEGATE"), mk("sans", "MEDICAL_DELEGATE")]);
    kam = k.id; autreKam = ak.id; sansSecteur = ss.id;

    const etab = (name: string) => prisma.medicalInstitution.create({ data: { name: `${TAG}${name}`, wilaya: "Alger", type: "CHU" }, select: { id: true } });
    const [e1, e2, e3, bu] = await Promise.all([
      etab("CHU entier"), etab("EPH restreint"), etab("EPH du secteur inactif"),
      prisma.businessUnit.create({ data: { name: `${TAG}BU` }, select: { id: true } }),
    ]);
    entier = e1.id; restreint = e2.id; inactif = e3.id;
    const [s1, s2] = await Promise.all([
      prisma.medicalInstitutionService.create({ data: { institutionId: restreint, name: "Cardiologie" }, select: { id: true } }),
      prisma.medicalInstitutionService.create({ data: { institutionId: restreint, name: "Pneumologie" }, select: { id: true } }),
    ]);
    svcChoisi = s1.id; svcAutre = s2.id;
    // Un KAM affecté à un secteur est un KAM de SA BU (§118.184 — S15) : le panel ne compte que les
    // secteurs de la BU où il est rattaché.
    await prisma.salesRepProfile.create({ data: { repId: kam, businessUnitId: bu.id } });

    await Promise.all([
      prisma.salesSector.create({
        data: {
          name: `${TAG}Est`, businessUnitId: bu.id,
          reps: { create: [{ repId: kam }] },
          institutions: {
            create: [
              { institutionId: entier, tousLesServices: true },
              { institutionId: restreint, tousLesServices: false, services: { create: [{ serviceId: svcChoisi }] } },
            ],
          },
        },
      }),
      prisma.salesSector.create({
        data: {
          name: `${TAG}Ancien`, businessUnitId: bu.id, isActive: false,
          reps: { create: [{ repId: kam }] },
          institutions: { create: [{ institutionId: inactif, tousLesServices: true }] },
        },
      }),
    ]);

    const doc = (name: string, extra: Record<string, unknown>) =>
      prisma.medicalDoctor.create({ data: { name: `${TAG}${name}`, lastName: `${TAG}${name}`, wilaya: "Alger", ...extra }, select: { id: true } });
    const docs = await Promise.all([
      doc("Entier sans service", { institutionId: entier, institution: `${TAG}CHU entier` }),
      doc("Restreint choisi", { institutionId: restreint, institution: `${TAG}EPH restreint`, serviceId: svcChoisi }),
      doc("Restreint autre", { institutionId: restreint, institution: `${TAG}EPH restreint`, serviceId: svcAutre }),
      doc("Restreint sans service", { institutionId: restreint, institution: `${TAG}EPH restreint` }),
      doc("Secteur inactif", { institutionId: inactif, institution: `${TAG}EPH du secteur inactif` }),
      doc("Libéral rattaché", { delegateId: kam }),
      doc("Rattaché à l'autre KAM", { delegateId: autreKam, institutionId: entier, institution: `${TAG}CHU entier` }),
      doc("Hors de tout", {}),
    ]);
    [dEntierSansService, dRestreintChoisi, dRestreintAutre, dRestreintSansService, dInactif, dLiberal, dAutreKamDansLeSecteur, dHorsDeTout] = docs.map((d) => d.id);
  });

  afterAll(nettoyer);

  const ATTENDU_KAM = () => new Set([dEntierSansService, dRestreintChoisi, dLiberal, dAutreKamDansLeSecteur]);
  const duDecor = (ids: Iterable<string>) => {
    const decor = new Set([dEntierSansService, dRestreintChoisi, dRestreintAutre, dRestreintSansService, dInactif, dLiberal, dAutreKamDansLeSecteur, dHorsDeTout]);
    return new Set([...ids].filter((i) => decor.has(i)));
  };

  it("les acteurs sont ce que le banc croit qu'ils sont — aucun n'a la vue globale sur l'annuaire", async () => {
    for (const id of [kam, autreKam, sansSecteur]) {
      const a = await acteur(id, "MEDICAL_DELEGATE");
      expect(a.access.modules.get("MEDICAL")?.scope).not.toBe("ALL");
    }
  });

  it("la clause : chaque branche, et ce qu'elle ne fait pas", async () => {
    const lu = await prisma.medicalDoctor.findMany({ where: clausePanelDuKam(kam), select: { id: true } });
    expect(duDecor(lu.map((d) => d.id))).toEqual(ATTENDU_KAM());
    // L'autre KAM n'a pas de secteur : son panel est son rattachement, rien de plus.
    const autre = await prisma.medicalDoctor.findMany({ where: clausePanelDuKam(autreKam), select: { id: true } });
    expect(duDecor(autre.map((d) => d.id))).toEqual(new Set([dAutreKamDansLeSecteur]));
    // Un KAM sans secteur ni rattachement n'a PERSONNE — l'état honnête d'une BU pas encore découpée.
    const vide = await prisma.medicalDoctor.findMany({ where: clausePanelDuKam(sansSecteur), select: { id: true } });
    expect(duDecor(vide.map((d) => d.id)).size).toBe(0);
  });

  it("le chargeur de PLUSIEURS panels rend, KAM par KAM, ce que rend la clause", async () => {
    const panels = await panelsDesKams([kam, autreKam, sansSecteur]);
    for (const id of [kam, autreKam, sansSecteur]) {
      const parClause = await prisma.medicalDoctor.findMany({ where: clausePanelDuKam(id), select: { id: true } });
      expect(new Set((panels.get(id) ?? []).map((d) => d.id))).toEqual(new Set(parClause.map((d) => d.id)));
    }
  });

  it("le plan de tournée, Ma journée et la carte d'équipe lisent le MÊME panel", async () => {
    const plan = await loadPanelPlanifiable(kam);
    expect(duDecor(plan.map((p) => p.id))).toEqual(ATTENDU_KAM());
    // Le secteur qui amène chaque praticien reste nommé ; le libéral n'en a pas.
    expect(plan.find((p) => p.id === dRestreintChoisi)?.secteur).toBe(`${TAG}Est`);
    expect(plan.find((p) => p.id === dLiberal)?.secteur).toBeNull();

    const journee = await loadMyFieldDay(kam);
    expect(duDecor(journee.panel.map((p) => p.id))).toEqual(ATTENDU_KAM());
    expect(journee.panelVide).toBe(false);

    const carte = await getTeamMemberKpis("employe-fictif", "KAM", kam, "MEDICAL_DELEGATE");
    expect(carte.job_.find((k) => k.label === "Médecins au portefeuille")?.value).toBe(String(ATTENDU_KAM().size));
  });

  it("le cockpit compte le panel entier — et l'alerte « non armé » ne vise plus un KAM qui a un secteur", async () => {
    const { rows } = await loadCockpit({ year: 2026, month: 10, repIds: [kam, sansSecteur], cycleId: null });
    const ligne = rows.find((r) => r.repId === kam);
    expect(ligne?.panelSize).toBe(ATTENDU_KAM().size);
    expect(rows.find((r) => r.repId === sansSecteur)?.panelSize).toBe(0);
  });

  it("la portée d'accès : la fiche d'un praticien du secteur s'ouvre ; celle d'un autre service ou d'un secteur inactif, non", async () => {
    const a = await acteur(kam, "MEDICAL_DELEGATE");
    const vus = await prisma.medicalDoctor.findMany({ where: { AND: [scopeMedicalDoctors(a)] }, select: { id: true } });
    expect(duDecor(vus.map((d) => d.id))).toEqual(ATTENDU_KAM());
    expect(await canAccessEntity(a, "DOCTOR", dRestreintChoisi, "VIEW")).toBe(true);
    expect(await canAccessEntity(a, "DOCTOR", dRestreintAutre, "VIEW")).toBe(false);
    expect(await canAccessEntity(a, "DOCTOR", dRestreintSansService, "VIEW")).toBe(false);
    expect(await canAccessEntity(a, "DOCTOR", dInactif, "VIEW")).toBe(false);
    expect(await canAccessEntity(a, "DOCTOR", dHorsDeTout, "VIEW")).toBe(false);
  });

  it("saisie rapide et visite imprévue : un praticien du secteur s'enregistre, un autre service est refusé", async () => {
    ACTEUR = await acteur(kam, "MEDICAL_DELEGATE");
    const ok = await logVisit(undefined, fd({ doctorId: dEntierSansService, report: `${TAG}vu` }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    const refus = await logVisit(undefined, fd({ doctorId: dRestreintAutre, report: `${TAG}vu` }));
    expect(refus).toEqual({ ok: false, error: "Ce praticien n'est pas dans votre panel." });

    const imprevue = await ajouterVisiteImprevue(fd({ doctorId: dRestreintChoisi, report: `${TAG}rencontré au couloir` }));
    expect(imprevue.ok, imprevue.ok ? "" : imprevue.error).toBe(true);
    const imprevueRefus = await ajouterVisiteImprevue(fd({ doctorId: dRestreintSansService, report: `${TAG}rencontré` }));
    expect(imprevueRefus).toEqual({ ok: false, error: "Ce praticien n'est pas dans votre panel." });
  });

  it("qui couvre un praticien : le KAM de son secteur, jamais celui d'un secteur inactif", async () => {
    const couverts = await kamsQuiCouvrent([dEntierSansService, dRestreintAutre, dInactif]);
    expect((couverts.get(dEntierSansService) ?? []).map((k) => k.id)).toContain(kam);
    expect(couverts.get(dRestreintAutre) ?? []).toEqual([]);
    expect(couverts.get(dInactif) ?? []).toEqual([]);
  });
});

describe("Qui suit un médecin stratégique (§118.179) — la règle de l'alerte, sans base", () => {
  it("le délégué rattaché d'abord ; sinon CHAQUE KAM qui le couvre ; sinon personne — et la preuve le dit", async () => {
    const { suiviDuKol } = await import("@/lib/adventum/risks");
    const delegue = suiviDuKol({ delegateId: "d1", delegate: { name: "Amel" } }, [{ id: "k1", name: "Karim" }]);
    expect(delegue.destinataires.map((x) => x.id)).toEqual(["d1"]);
    const couvert = suiviDuKol({ delegateId: null, delegate: null }, [{ id: "k1", name: "Karim" }, { id: "k2", name: "Lyes" }]);
    expect(couvert.destinataires.map((x) => x.id)).toEqual(["k1", "k2"]);
    expect(couvert.preuve).toBe("Couvert par son secteur : Karim, Lyes");
    const personne = suiviDuKol({ delegateId: null, delegate: null }, []);
    expect(personne.destinataires).toEqual([]);
    expect(personne.preuve).toContain("aucun secteur");
  });
});
