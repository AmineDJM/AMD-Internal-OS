import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));
// La passerelle de l'IA n'est jamais sur ce chemin : si elle l'était, elle lèverait.
vi.mock("@/lib/models/gateway", () => ({ askModelJson: async () => { throw new Error("fournisseur en panne"); } }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { ajouterVisiteImprevue, rapporterVisite } from "./tour-visit-actions";
import { ecarterAlertePvVisite } from "./visite-pv-ecart-actions";
import { signalerCasPv } from "./pharmacovigilance-actions";
import { chargerEquipeTerrain, chargerRapportARelire } from "@/lib/queries/equipe-terrain";
import { loadJourneeDuDelegue } from "@/lib/queries/tour-schedule";
import { etatLectureIa } from "@/lib/sfe/compte-rendu-envoye";
import { lignesARelire } from "@/lib/force-de-vente/file-actions";
import type { LigneDelegue } from "@/lib/queries/force-de-vente";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__vmecart__";

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole as SessionUser["role"] | null, access, mustChangePassword: false } as CurrentUser;
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const EXTRAIT = "Une patiente de 71 ans a fait un malaise avec sueurs dix jours après le changement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CE N'EST PAS UN CAS » — la réponse du délégué à l'alerte de pharmacovigilance de l'IA, par la vraie action et la
 * vraie base : tracée (visite, journal, notification), refusée à un autre, une seule fois, jamais après un cas déclaré,
 * effacée par une correction du compte rendu — et lue par le superviseur, qui garde le rapport en priorité.
 *
 *   kam    délégué de la BU                 sup    superviseur de la BU
 *   autre  délégué d'ailleurs
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Visite médicale — « Ce n'est pas un cas » (interface du délégué)", () => {
  const ids: Record<string, string> = {};
  let doc = "", v1 = "", v2 = "", vPlan = "";
  const comme = async (qui: string) => { ACTOR = await actorFor(ids[qui]!); };
  const lecturePossible = { pvIa: "POSSIBLE", pvIaRaison: "Malaise hypoglycémique possible.", pvIaExtrait: EXTRAIT, prioriteIa: 88, analyseIaLe: new Date() };

  async function nettoyer() {
    const users = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
    const uids = users.map((u) => u.id);
    if (uids.length) {
      await prisma.pharmacovigilanceCase.deleteMany({ where: { reporterId: { in: uids } } });
      const visites = await prisma.medicalVisit.findMany({ where: { delegateId: { in: uids } }, select: { id: true } });
      await prisma.fieldReport.deleteMany({ where: { visitId: { in: visites.map((v) => v.id) } } });
      await prisma.medicalVisit.deleteMany({ where: { id: { in: visites.map((v) => v.id) } } });
      await prisma.salesRepProfile.deleteMany({ where: { repId: { in: uids } } });
      await prisma.notification.deleteMany({ where: { userId: { in: uids } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: uids } } }).catch(() => undefined);
    }
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await retirerComptesEtSemis({ where: { id: { in: uids } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const faire = (nom: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role: role as never, passwordHash: "x" } });
    const [kam, sup, autre] = await Promise.all([faire("kam", "MEDICAL_DELEGATE"), faire("sup", "NATIONAL_SALES"), faire("autre", "MEDICAL_DELEGATE")]);
    Object.assign(ids, { kam: kam.id, sup: sup.id, autre: autre.id });
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Diabète`, supervisorId: sup.id }, select: { id: true } });
    ids.bu = bu.id;
    await prisma.salesRepProfile.create({ data: { repId: kam.id, businessUnitId: bu.id } });
    doc = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Cherif`, delegateId: kam.id, wilaya: "Blida" }, select: { id: true } })).id;
    await comme("kam");
    const r1 = await ajouterVisiteImprevue(form({ doctorId: doc, report: `${EXTRAIT}. Elle demande la documentation.`, doctorFeedback: "Trop cher pour les non-assurés." }));
    expect(r1.ok, r1.ok ? "" : r1.error).toBe(true);
    v1 = r1.ok ? r1.id! : "";
    const r2 = await ajouterVisiteImprevue(form({ doctorId: doc, report: "Visite de courtoisie." }));
    v2 = r2.ok ? r2.id! : "";
  });
  afterAll(async () => { await nettoyer(); });

  it("la migration imposée est appliquée (pvEcarteLe, pvEcarteParId) ; les objections du médecin s'enregistrent", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'MedicalVisit' AND column_name IN ('pvEcarteLe','pvEcarteParId')`;
    expect(cols.length).toBe(2);
    expect((await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v1 }, select: { doctorFeedback: true } })).doctorFeedback).toBe("Trop cher pour les non-assurés.");
  });

  it("refusé tant que l'IA n'a rien relevé, et à un autre que le délégué", async () => {
    await comme("kam");
    const rien = await ecarterAlertePvVisite(form({ visitId: v2 }));
    expect(rien.ok ? "" : rien.error).toMatch(/aucun possible cas/);
    await prisma.medicalVisit.update({ where: { id: v1 }, data: lecturePossible });
    await comme("autre");
    const autre = await ecarterAlertePvVisite(form({ visitId: v1 }));
    expect(autre.ok ? "" : autre.error).toMatch(/Seul le délégué/);
    await comme("sup");
    const sup = await ecarterAlertePvVisite(form({ visitId: v1 }));
    expect(sup.ok).toBe(false);
    expect(await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v1 }, select: { pvEcarteLe: true } })).toEqual({ pvEcarteLe: null });
  });

  it("le délégué répond : tracé sur la visite et au journal, le superviseur prévenu ; une seconde fois est refusée", async () => {
    await comme("kam");
    const r = await ecarterAlertePvVisite(form({ visitId: v1 }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const v = await prisma.medicalVisit.findUniqueOrThrow({ where: { id: v1 }, select: { pvEcarteLe: true, pvEcarteParId: true, pvIa: true } });
    expect(v.pvEcarteLe).not.toBeNull();
    expect(v.pvEcarteParId).toBe(ids.kam);
    // L'ALERTE DE L'IA RESTE : seul un humain la tranche, à la relecture.
    expect(v.pvIa).toBe("POSSIBLE");
    expect(await prisma.auditLog.count({ where: { entityId: v1, summary: { contains: "ce n'est pas un cas" } } })).toBe(1);
    const auSup = await prisma.notification.findMany({ where: { userId: ids.sup }, select: { title: true, link: true } });
    expect(auSup).toEqual([{ title: expect.stringContaining("ce n'est pas un cas"), link: `/planning?relire=${v1}` }]);
    const encore = await ecarterAlertePvVisite(form({ visitId: v1 }));
    expect(encore.ok ? "" : encore.error).toMatch(/déjà indiqué/);
  });

  it("le superviseur le lit : la file garde le rapport en tête et dit la réponse ; le panneau de relecture aussi", async () => {
    await comme("sup");
    const ligne = { repId: ids.kam!, nom: `${TAG}kam`, buId: ids.bu!, buNom: null, secteurNom: null, panelVide: false } as unknown as LigneDelegue;
    const e = await chargerEquipeTerrain({ user: ACTOR!, lignes: [ligne], aTraiter: { plansAValider: [], ciblesNonVues: { total: 0, decideurs: 0 }, secteursVacants: [], coachingsEnRetard: [] } });
    expect(e.aRelire.lignes[0]).toMatchObject({ visitId: v1, pvIa: "POSSIBLE", ecarteParLeDelegue: true });
    const actions = lignesARelire({ aRelire: e.aRelire, liens: { relire: (id: string) => `/planning?relire=${id}` } as never });
    expect(actions[0]!.sous).toContain("le délégué indique : « ce n'est pas un cas »");
    const r = await chargerRapportARelire(ACTOR!, { mode: "all" } as never, v1);
    expect(r?.visite.pvEcarteLe).not.toBeNull();
  });

  it("une correction du compte rendu efface la réponse avec la lecture de l'IA (elle portait sur l'ancien texte)", async () => {
    await comme("kam");
    // Une visite rapportée se CORRIGE par `rapporterVisite` (dans ses 48 h) — hors plan : ni produit ni message exigés.
    vPlan = (await prisma.medicalVisit.create({ data: { date: new Date(), doctorId: doc, delegateId: ids.kam, status: "COMPLETED", origin: "UNPLANNED", report: `${EXTRAIT}.`, ...lecturePossible }, select: { id: true } })).id;
    expect((await ecarterAlertePvVisite(form({ visitId: vPlan }))).ok).toBe(true);
    const corr = await rapporterVisite(form({ visitId: vPlan, report: "Compte rendu corrigé : aucun incident." }));
    expect(corr.ok, corr.ok ? "" : corr.error).toBe(true);
    expect(await prisma.medicalVisit.findUniqueOrThrow({ where: { id: vPlan }, select: { pvEcarteLe: true, pvEcarteParId: true, pvIa: true } }))
      .toEqual({ pvEcarteLe: null, pvEcarteParId: null, pvIa: null });
  });

  it("« Ma journée » relit la visite : la lecture, la réponse, puis le cas déclaré qui efface l'alerte", async () => {
    await comme("kam");
    const edt = await loadJourneeDuDelegue(ACTOR!, new Date());
    const l = edt.lignes.find((x) => x.id === v1);
    expect(l?.lecture).toMatchObject({ pvIa: "POSSIBLE", extrait: EXTRAIT, cas: null });
    expect(l?.objections).toBe("Trop cher pour les non-assurés.");
    expect(etatLectureIa(l!.lecture).sorte).toBe("ECARTE");
    const champs = { produitAutre: `${TAG}Gliclazide`, etablissementAutre: `${TAG}EPH Boufarik`, occurredOn: new Date().toISOString().slice(0, 10), description: "Malaise avec sueurs." };
    const cas = await signalerCasPv(form({ ...champs, visitId: v1 }));
    expect(cas.ok, cas.ok ? "" : cas.error).toBe(true);
    const apres = (await loadJourneeDuDelegue(ACTOR!, new Date())).lignes.find((x) => x.id === v1);
    expect(etatLectureIa(apres!.lecture).sorte).toBe("DECLARE");
    // Un cas déclaré ferme la porte à « ce n'est pas un cas » sur une autre visite qui en porte un.
    await prisma.medicalVisit.update({ where: { id: v1 }, data: { pvEcarteLe: null, pvEcarteParId: null } });
    const refus = await ecarterAlertePvVisite(form({ visitId: v1 }));
    expect(refus.ok ? "" : refus.error).toMatch(/déjà déclaré/);
  });
});
