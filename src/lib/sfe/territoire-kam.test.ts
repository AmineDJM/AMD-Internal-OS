import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { clausePanelDuKam, getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import {
  enregistrerTerritoireKam, saveRepProfile, deleteRepProfile, createSector, updateSector, deleteSector,
} from "@/lib/actions/sales-planning-actions";
import { diagnostiquerPanelVide, loadPanelPlanifiable } from "@/lib/queries/tour-schedule";
import { nomDuTerritoire } from "./territoire-kam";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TERRITOIRE D'UN KAM, CHOISI SUR SA LIGNE (04/10/2026) — par les VRAIS points d'entrée.
 *
 * L'action de l'écran (`enregistrerTerritoireKam`), puis la règle du panel (`clausePanelDuKam`) EN
 * BASE : ce que l'écran BU montre doit être exactement ce que le panel lit. L'acteur est le Manager
 * Promotion médicale — il monte les BU SANS vue globale (§118.104) ; sa prémisse est vérifiée.
 *
 * Et le rapport de production : « j'ai donné un secteur à chaque KAM mais ils ne peuvent toujours
 * pas mettre leur plan de tournée ni sélectionner les wilayas » — chaque cause plausible d'un panel
 * vide est REPRODUITE, et la phrase de l'écran doit nommer la bonne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__terrkam__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
};

async function nettoyer() {
  await prisma.salesSector.deleteMany({ where: { businessUnit: { name: { startsWith: TAG } } } }).catch(() => {});
  const comptes = await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } });
  await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: comptes.map((c) => c.id) } } }).catch(() => {});
}

suite("le territoire d'un KAM — l'action de l'écran, puis le panel en base", () => {
  const u: Record<string, string> = {};
  const bu: Record<string, string> = {};
  const et: Record<string, string> = {};
  const sv: Record<string, string> = {};
  const dr: Record<string, string> = {};

  const panel = async (repId: string) =>
    (await prisma.medicalDoctor.findMany({ where: { AND: [clausePanelDuKam(repId), { name: { startsWith: TAG } }] }, select: { id: true } }))
      .map((d) => d.id).sort();
  const territoire = (buId: string, repId: string) => prisma.salesSector.findUnique({
    where: { businessUnitId_repId: { businessUnitId: buId, repId } },
    include: { institutions: { include: { services: true } }, reps: true },
  });
  const enregistrer = (o: Record<string, string | string[]>) => enregistrerTerritoireKam(fd(o));

  beforeAll(async () => {
    await nettoyer();
    const mk = async (k: string, role: string, name = `${TAG}${k}`) => {
      u[k] = (await prisma.user.create({ data: { name, email: `${TAG}${k}@t.dz`, role: role as never, passwordHash: "x" } })).id;
    };
    await mk("mpm", "MEDICAL_PROMOTION_MANAGER");
    await mk("leila", "MEDICAL_DELEGATE", `${TAG}Leila Sahridj`);
    await mk("amel", "MEDICAL_DELEGATE");
    await mk("autre", "MEDICAL_DELEGATE");
    await mk("sansbu", "MEDICAL_DELEGATE");
    await mk("texte", "MEDICAL_DELEGATE");
    bu.hop = (await prisma.businessUnit.create({ data: { name: `${TAG}Onco`, channel: "HOSPITAL" } })).id;
    bu.deux = (await prisma.businessUnit.create({ data: { name: `${TAG}Cardio`, channel: "BOTH" } })).id;
    bu.ville = (await prisma.businessUnit.create({ data: { name: `${TAG}Ville`, channel: "RETAIL" } })).id;
    await prisma.salesRepProfile.createMany({
      data: [
        { repId: u.leila, businessUnitId: bu.hop }, { repId: u.amel, businessUnitId: bu.ville },
        { repId: u.autre, businessUnitId: bu.deux }, { repId: u.texte, businessUnitId: bu.hop, region: "Est" },
      ],
    });
    et.chu = (await prisma.medicalInstitution.create({ data: { name: `${TAG}CHU Mustapha`, type: "CHU", wilaya: "Alger" } })).id;
    et.eph = (await prisma.medicalInstitution.create({ data: { name: `${TAG}EPH Kouba`, type: "EPH", wilaya: "Alger" } })).id;
    et.ferme = (await prisma.medicalInstitution.create({ data: { name: `${TAG}Clinique fermée`, type: "CLINIQUE_PRIVEE", isActive: false } })).id;
    sv.cardio = (await prisma.medicalInstitutionService.create({ data: { institutionId: et.eph, name: "Cardiologie" } })).id;
    sv.onco = (await prisma.medicalInstitutionService.create({ data: { institutionId: et.eph, name: "Oncologie" } })).id;
    sv.chuUrg = (await prisma.medicalInstitutionService.create({ data: { institutionId: et.chu, name: "Urgences" } })).id;
    const doc = async (k: string, data: Record<string, unknown>) => {
      dr[k] = (await prisma.medicalDoctor.create({ data: { name: `${TAG}${k}`, ...data } as never })).id;
    };
    // La fiche du CHU ne porte PAS de wilaya : la wilaya de son établissement doit la porter au planificateur.
    await doc("chu", { institutionId: et.chu });
    await doc("cardio", { institutionId: et.eph, serviceId: sv.cardio, wilaya: "Alger" });
    await doc("onco", { institutionId: et.eph, serviceId: sv.onco, wilaya: "Alger" });
    await doc("ephSansService", { institutionId: et.eph, wilaya: "Alger" });
    ACTEUR = { id: u.mpm, role: "MEDICAL_PROMOTION_MANAGER", secondaryRole: null, access: await getAccess(u.mpm, "MEDICAL_PROMOTION_MANAGER") } as unknown as SessionUser;
  });

  afterAll(nettoyer);

  it("la prémisse : le Manager Promotion médicale monte les BU, SANS vue globale", () => {
    const a = ACTEUR as SessionUser;
    expect(userCan(a, "SALES_PLANNING", "UPDATE")).toBe(true);
    expect(hasGlobalView(a.role)).toBe(false);
  });

  it("un établissement ENTIER : son praticien entre dans le panel du KAM — et seulement après", async () => {
    expect(await panel(u.leila)).toEqual([]);
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.chu], couverture: "{}" });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const t = await territoire(bu.hop, u.leila);
    expect(t?.name).toBe(nomDuTerritoire(`${TAG}Leila Sahridj`, u.leila, false));
    expect(t?.reps.map((x) => x.repId)).toEqual([u.leila]);
    expect(t?.institutions.map((i) => [i.institutionId, i.tousLesServices])).toEqual([[et.chu, true]]);
    expect(await panel(u.leila)).toEqual([dr.chu]);
  });

  it("un établissement RESTREINT à un service : le praticien du service entre, ceux d'un autre service ou sans service, non", async () => {
    const r = await enregistrer({
      businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.chu, et.eph], couverture: JSON.stringify({ [et.eph]: [sv.cardio] }),
    });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(await panel(u.leila)).toEqual([dr.chu, dr.cardio].sort());
    // UN SEUL territoire : le second enregistrement met à jour, il n'en crée pas un autre.
    expect(await prisma.salesSector.count({ where: { businessUnitId: bu.hop, repId: u.leila } })).toBe(1);
  });

  it("ce que l'écran BU montre est ce que le planificateur lit — et la wilaya vient de l'établissement quand la fiche n'en a pas", async () => {
    const plan = await loadPanelPlanifiable(u.leila);
    const ids = plan.filter((p) => p.name.startsWith(TAG)).map((p) => p.id).sort();
    expect(ids).toEqual(await panel(u.leila));
    expect(plan.find((p) => p.id === dr.chu)?.wilaya).toBe("Alger");
    expect(plan.find((p) => p.id === dr.chu)?.secteur).toBe(nomDuTerritoire(`${TAG}Leila Sahridj`, u.leila, false));
  });

  it("un formulaire SANS couverture garde la restriction ; un nouvel établissement les couvre tous", async () => {
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.chu, et.eph] });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const t = await territoire(bu.hop, u.leila);
    const eph = t?.institutions.find((i) => i.institutionId === et.eph);
    expect(eph?.tousLesServices).toBe(false);
    expect(eph?.services.map((s) => s.serviceId)).toEqual([sv.cardio]);
  });

  it("« aucun service » coché est refusé en NOMMANT l'établissement — rien n'est écrit", async () => {
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.eph], couverture: JSON.stringify({ [et.eph]: [] }) });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain(`${TAG}EPH Kouba`);
    expect((await territoire(bu.hop, u.leila))?.institutions.length).toBe(2);
  });

  it("un service d'un AUTRE établissement est refusé", async () => {
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.eph], couverture: JSON.stringify({ [et.eph]: [sv.chuUrg] }) });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("n'appartient pas à son établissement");
  });

  it("un établissement DÉSACTIVÉ ne s'ajoute pas — et reste s'il y était déjà", async () => {
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.chu, et.ferme], couverture: "{}" });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain(`${TAG}Clinique fermée`);
    // Désactivé APRÈS avoir été choisi : il reste au réenregistrement.
    await prisma.medicalInstitution.update({ where: { id: et.chu }, data: { isActive: false } });
    try {
      const ok = await enregistrer({ businessUnitId: bu.hop, repId: u.leila, institutionIds: [et.chu, et.eph], couverture: JSON.stringify({ [et.eph]: [sv.cardio] }) });
      expect(ok.ok, ok.ok === false ? ok.error : "").toBe(true);
    } finally {
      await prisma.medicalInstitution.update({ where: { id: et.chu }, data: { isActive: true } });
    }
  });

  it("une BU DE VILLE est refusée — rien n'est créé", async () => {
    const r = await enregistrer({ businessUnitId: bu.ville, repId: u.amel, institutionIds: [et.chu], couverture: "{}" });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("gamme de ville");
    expect(await territoire(bu.ville, u.amel)).toBeNull();
  });

  it("un KAM d'une AUTRE BU est refusé — on ne donne pas un territoire à l'équipe d'à côté", async () => {
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.autre, institutionIds: [et.chu], couverture: "{}" });
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("n'est pas (ou plus) rattaché à cette BU");
    expect(await territoire(bu.hop, u.autre)).toBeNull();
  });

  it("deux premiers enregistrements SIMULTANÉS : un seul territoire, les deux réussissent", async () => {
    const [a, b] = await Promise.all([
      enregistrer({ businessUnitId: bu.deux, repId: u.autre, institutionIds: [et.chu], couverture: "{}" }),
      enregistrer({ businessUnitId: bu.deux, repId: u.autre, institutionIds: [et.eph], couverture: "{}" }),
    ]);
    expect([a.ok, b.ok], JSON.stringify([a, b])).toEqual([true, true]);
    expect(await prisma.salesSector.count({ where: { businessUnitId: bu.deux, repId: u.autre } })).toBe(1);
  });

  it("le territoire n'est pas un secteur partagé : `updateSector` et `deleteSector` le refusent en nommant la ligne du KAM", async () => {
    const t = await territoire(bu.hop, u.leila);
    for (const r of [
      await updateSector(fd({ id: t!.id, name: "Est", repIds: [u.leila, u.texte] })),
      await deleteSector(fd({ id: t!.id })),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.ok === false ? r.error : "").toContain("« Territoire »");
    }
    expect((await territoire(bu.hop, u.leila))?.reps.map((x) => x.repId)).toEqual([u.leila]);
  });

  it("le nom pris dans la BU (un ancien secteur) : le territoire prend la fin de l'identifiant du KAM", async () => {
    await createSector(fd({ businessUnitId: bu.hop, name: nomDuTerritoire(`${TAG}texte`, u.texte, false) }));
    const r = await enregistrer({ businessUnitId: bu.hop, repId: u.texte, institutionIds: [et.chu], couverture: "{}" });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect((await territoire(bu.hop, u.texte))?.name).toBe(nomDuTerritoire(`${TAG}texte`, u.texte, true));
  });

  it("retiré de la BU, le KAM perd son panel ; rattaché de nouveau, son territoire lui est RENDU tel quel", async () => {
    const avant = await panel(u.leila);
    expect(avant.length).toBeGreaterThan(0);
    expect((await saveRepProfile(fd({ repId: u.leila, businessUnitId: "" }))).ok).toBe(true);
    expect(await panel(u.leila)).toEqual([]);
    const r = await saveRepProfile(fd({ repId: u.leila, businessUnitId: bu.hop }));
    expect(r.ok).toBe(true);
    expect(r.ok && "message" in r ? r.message : "").toContain("lui est rendu");
    expect(await panel(u.leila)).toEqual(avant);
    // Retiré de la force de vente : même chose, sans rien perdre du territoire.
    expect((await deleteRepProfile(fd({ repId: u.leila }))).ok).toBe(true);
    expect(await panel(u.leila)).toEqual([]);
    expect((await territoire(bu.hop, u.leila))?.institutions.length).toBe(2);
    await saveRepProfile(fd({ repId: u.leila, businessUnitId: bu.hop }));
    expect(await panel(u.leila)).toEqual(avant);
  });
});

/**
 * POURQUOI LE PANEL EST VIDE — chaque cause plausible du rapport de production, reproduite, et la
 * phrase que l'écran du plan de tournée affiche (`diagnostiquerPanelVide`) doit nommer CELLE-LÀ.
 */
suite("un panel vide dit sa VRAIE cause", () => {
  const T = `${TAG}diag_`;
  const u: Record<string, string> = {};
  let buA = "", buB = "", chu = "", eph = "", cardio = "";

  async function nettoyerDiag() {
    await prisma.salesSector.deleteMany({ where: { businessUnit: { name: { startsWith: T } } } }).catch(() => {});
    const comptes = await prisma.user.findMany({ where: { email: { startsWith: T } }, select: { id: true } });
    await prisma.salesRepProfile.deleteMany({ where: { repId: { in: comptes.map((c) => c.id) } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: T } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: T } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: T } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes.map((c) => c.id) } } }).catch(() => {});
  }

  const secteur = async (buId: string, nom: string, reps: string[], liens: { institutionId: string; tous?: boolean; services?: string[] }[], actif = true) => {
    const s = await prisma.salesSector.create({ data: { businessUnitId: buId, name: `${T}${nom}`, isActive: actif } });
    for (const l of liens) {
      const lien = await prisma.salesSectorInstitution.create({ data: { sectorId: s.id, institutionId: l.institutionId, tousLesServices: l.tous ?? true } });
      for (const sid of l.services ?? []) await prisma.salesSectorInstitutionService.create({ data: { sectorInstitutionId: lien.id, serviceId: sid } });
    }
    await prisma.salesSectorRep.createMany({ data: reps.map((repId) => ({ sectorId: s.id, repId })) });
  };
  const cause = async (k: string) => {
    expect(await loadPanelPlanifiable(u[k]), `PRÉMISSE — le panel de ${k} doit être vide`).toEqual([]);
    return diagnostiquerPanelVide(u[k]);
  };

  beforeAll(async () => {
    await nettoyerDiag();
    for (const k of ["sansbu", "autrebu", "inactif", "texte", "vide", "nonrattache", "services", "aucun"]) {
      u[k] = (await prisma.user.create({ data: { name: `${T}${k}`, email: `${T}${k}@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    }
    buA = (await prisma.businessUnit.create({ data: { name: `${T}A`, channel: "HOSPITAL" } })).id;
    buB = (await prisma.businessUnit.create({ data: { name: `${T}B`, channel: "HOSPITAL" } })).id;
    await prisma.salesRepProfile.createMany({
      data: ["autrebu", "inactif", "vide", "nonrattache", "services", "aucun"].map((k) => ({ repId: u[k], businessUnitId: buA }))
        .concat([{ repId: u.texte, businessUnitId: buA, region: "Est" } as never]),
    });
    chu = (await prisma.medicalInstitution.create({ data: { name: `${T}CHU Batna`, type: "CHU", wilaya: "Batna" } })).id;
    eph = (await prisma.medicalInstitution.create({ data: { name: `${T}EPH Sétif`, type: "EPH", wilaya: "Sétif" } })).id;
    cardio = (await prisma.medicalInstitutionService.create({ data: { institutionId: eph, name: "Cardiologie" } })).id;
    // Une fiche d'AVANT le lien : l'établissement n'est qu'un texte, écrit autrement en casse.
    await prisma.medicalDoctor.create({ data: { name: `${T}texteSeul`, institution: `${T}chu batna` } });
    // Un praticien rattaché à l'EPH, mais sans service.
    await prisma.medicalDoctor.create({ data: { name: `${T}ephSansService`, institutionId: eph } });
    await secteur(buB, "Ailleurs", [u.autrebu], [{ institutionId: chu }]);
    await secteur(buA, "Ferme", [u.inactif], [{ institutionId: chu }], false);
    await secteur(buA, "Vide", [u.vide], []);
    await secteur(buA, "NonRattache", [u.nonrattache], [{ institutionId: chu }]);
    await secteur(buA, "Services", [u.services], [{ institutionId: eph, tous: false, services: [cardio] }]);
  });

  afterAll(nettoyerDiag);

  it("aucune BU", async () => expect((await cause("sansbu")).cause).toBe("SANS_BU"));
  it("un secteur dans une AUTRE BU que la sienne — nommée", async () => {
    const d = await cause("autrebu");
    expect(d.cause).toBe("SECTEUR_AUTRE_BU");
    expect(d.phrase).toContain(`${T}B`);
  });
  it("un secteur désactivé", async () => expect((await cause("inactif")).cause).toBe("SECTEUR_INACTIF"));
  it("un « Secteur » tapé en TEXTE, relié à rien — la cause la plus probable du rapport", async () => {
    const d = await cause("texte");
    expect(d.cause).toBe("SANS_SECTEUR");
    expect(d.phrase).toContain("« Est » saisi en texte");
  });
  it("un territoire sans établissement", async () => expect((await cause("vide")).cause).toBe("SECTEUR_SANS_ETABLISSEMENT"));
  it("des fiches dont l'établissement n'est qu'un TEXTE — le remède nomme qui les rattache", async () => {
    const d = await cause("nonrattache");
    expect(d.cause).toBe("PRATICIENS_NON_RATTACHES");
    expect(d.phrase).toContain("1 fiche(s)");
    expect(d.phrase).toContain("Rattacher les établissements");
  });
  it("des médecins dans l'établissement, aucun dans les services retenus", async () => {
    const d = await cause("services");
    expect(d.cause).toBe("SERVICES_SANS_PRATICIEN");
    expect(d.phrase).toContain("1 médecin(s)");
  });
  it("un territoire dont les établissements n'ont aucun médecin", async () => {
    await secteur(buA, "Aucun", [u.aucun], [{ institutionId: (await prisma.medicalInstitution.create({ data: { name: `${T}Clinique vide`, type: "CLINIQUE_PRIVEE" } })).id }]);
    expect((await cause("aucun")).cause).toBe("AUCUN_PRATICIEN");
  });
});
