import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T2 (décision 0052) — L'ANNUAIRE TENU EN LOT, RÉVERSIBLE : `appliquerLotAnnuaire` et
 * `fusionnerEtablissementsAnnuaire` EXÉCUTÉES au clic de l'écran (`actionReversible`), puis ANNULÉES contre la base locale
 * — tout le lot d'un coup — puis RÉTABLIES.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { appliquerLotAnnuaire, fusionnerEtablissementsAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";
import { ecarterFusionMedecin, fusionnerMedecinsEnDouble } from "@/lib/actions/medical-directory-crud-actions";
import { propositionsFusionMedecins } from "@/modules/referentiels/api";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zt2annuaire${Date.now()}`;
let moi: CurrentUser;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};

suite("T2 — l'annuaire en lot : exécuté, annulé d'un coup, rétabli", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Directrice`, email: `${TAG}@banc.dz`, passwordHash: "x", role: "SUPER_ADMIN" as never } });
    moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: await getAccess(u.id, "SUPER_ADMIN" as never) } as unknown as CurrentUser;
    ACTOR = moi;
  });
  afterAll(async () => {
    await prisma.medicalVisit.deleteMany({ where: { doctor: { name: { contains: TAG } } } });
    await prisma.decisionFusionMedecin.deleteMany({ where: { decideParId: moi.id } });
    await prisma.medicalDoctor.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.salesSectorInstitution.deleteMany({ where: { institution: { name: { startsWith: TAG } } } });
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await retirerComptesEtSemis({ where: { email: `${TAG}@banc.dz` } });
  });

  it("appliquerLotAnnuaire : deux fiches modifiées en un geste ; l'annulation remet les deux ; le rétablissement les refait", async () => {
    const e = await prisma.medicalInstitution.create({ data: { name: `${TAG} Pharmacie A`, type: "PHARMACIE", phone: "041 00 00 01", address: "1 rue A" } });
    const d = await prisma.medicalDoctor.create({ data: { name: `${TAG} Dr B`, phone: null } });
    const r = await appliquerLotAnnuaire(fd({ lignes: JSON.stringify([
      { cible: "etablissement", id: e.id, champs: { telephone: "041 99 99 99" } },
      { cible: "medecin", id: d.id, champs: { telephone: "0550 11 11 11" } },
    ]) }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.compte?.faites).toBe(2);
    const g = gesteDe(r);
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: e.id } })).phone).toBe("041 99 99 99");
    const a = await annulerGeste(g, moi);
    expect("refus" in a ? a.refus : "ok").toBe("ok");
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: e.id } })).phone).toBe("041 00 00 01");
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: e.id } })).address).toBe("1 rue A");
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: d.id } })).phone).toBeNull();
    const re = await retablirGeste(g, moi);
    expect("refus" in re ? re.refus : "ok").toBe("ok");
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: d.id } })).phone).toBe("0550 11 11 11");
  }, 60_000);

  it("fusionnerEtablissementsAnnuaire : la fiche gardée complétée, praticien et secteur déplacés, le doublon désactivé ; tout revient à l'annulation", async () => {
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG} BU` } });
    const secteur = await prisma.salesSector.create({ data: { name: `${TAG} Secteur`, businessUnitId: bu.id } });
    const garde = await prisma.medicalInstitution.create({ data: { name: `${TAG} Pharmacie Es-Salam`, type: "PHARMACIE", phone: "041 28 76 54" } });
    const doublon = await prisma.medicalInstitution.create({ data: { name: `${TAG} PHARMACIE ES SALAM`, type: "PHARMACIE", address: "9 avenue de l'ALN" } });
    await prisma.salesSectorInstitution.create({ data: { sectorId: secteur.id, institutionId: doublon.id } });
    const doc = await prisma.medicalDoctor.create({ data: { name: `${TAG} Dr C`, institutionId: doublon.id, institution: doublon.name } });
    const r = await fusionnerEtablissementsAnnuaire(fd({ groupes: JSON.stringify([{ garder: garde.id, absorber: [doublon.id] }]) }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const g = gesteDe(r);
    const [G, D, P, L] = await Promise.all([
      prisma.medicalInstitution.findUniqueOrThrow({ where: { id: garde.id } }), prisma.medicalInstitution.findUniqueOrThrow({ where: { id: doublon.id } }),
      prisma.medicalDoctor.findUniqueOrThrow({ where: { id: doc.id } }), prisma.salesSectorInstitution.findMany({ where: { sectorId: secteur.id } }),
    ]);
    expect(G.address).toBe("9 avenue de l'ALN");
    expect(D.isActive).toBe(false);
    expect(P.institutionId).toBe(garde.id);
    expect(L.map((l) => l.institutionId)).toEqual([garde.id]);
    const a = await annulerGeste(g, moi);
    expect("refus" in a ? a.refus : "ok").toBe("ok");
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: doublon.id } })).isActive).toBe(true);
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: garde.id } })).address).toBeNull();
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: doc.id } })).institutionId).toBe(doublon.id);
    expect((await prisma.salesSectorInstitution.findMany({ where: { sectorId: secteur.id } })).map((l) => l.institutionId)).toEqual([doublon.id]);
  }, 60_000);

  it("T2 bis — deux fiches médecins en double : ✓ du Super Admin (visites déplacées, absorbée archivée), annulé d'un coup, rétabli", async () => {
    const a = await prisma.medicalDoctor.create({ data: { name: `Leila MOKRANI ${TAG}`, phone: "0551 22 33 44", wilaya: "Oran" } });
    const b = await prisma.medicalDoctor.create({ data: { name: `Dr MOKRANI Leila ${TAG}`, email: "l.mokrani@exemple.dz", wilaya: "Oran" } });
    await prisma.medicalVisit.create({ data: { date: new Date(), doctorId: b.id, status: "COMPLETED", report: "visite de la fiche en double" } });
    const avant = await propositionsFusionMedecins(moi);
    expect(avant.some((p) => [p.garde.id, p.absorbee.id].sort().join() === [a.id, b.id].sort().join())).toBe(true);
    const r = await fusionnerMedecinsEnDouble(fd({ gardeId: a.id, absorbeId: b.id }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const g = gesteDe(r);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: b.id } })).archivedAt).toBeTruthy();
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: a.id } })).email).toBe("l.mokrani@exemple.dz");
    expect(await prisma.medicalVisit.count({ where: { doctorId: a.id } })).toBe(1);
    expect((await propositionsFusionMedecins(moi)).some((p) => p.garde.id === b.id || p.absorbee.id === b.id)).toBe(false);
    const x = await annulerGeste(g, moi);
    expect("refus" in x ? x.refus : "ok").toBe("ok");
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: b.id } })).archivedAt).toBeNull();
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: a.id } })).email).toBeNull();
    expect(await prisma.medicalVisit.count({ where: { doctorId: b.id } })).toBe(1);
    expect(await prisma.decisionFusionMedecin.count({ where: { gardeId: a.id } })).toBe(0);
    const re = await retablirGeste(g, moi);
    expect("refus" in re ? re.refus : "ok").toBe("ok");
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: b.id } })).archivedAt).toBeTruthy();
  }, 60_000);

  it("T2 bis — ✗ écarte la paire ; elle ne revient que si une fiche change ; un autre rôle est refusé", async () => {
    const c = await prisma.medicalDoctor.create({ data: { name: `Yacine BRAHIMI ${TAG}`, wilaya: "Alger" } });
    const d = await prisma.medicalDoctor.create({ data: { name: `BRAHIMI Yacine ${TAG}`, phone: "0552 00 11 22" } });
    const paire = (ps: Awaited<ReturnType<typeof propositionsFusionMedecins>>) => ps.some((p) => [p.garde.id, p.absorbee.id].sort().join() === [c.id, d.id].sort().join());
    const r = await ecarterFusionMedecin(fd({ medecinAId: c.id, medecinBId: d.id }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(paire(await propositionsFusionMedecins(moi))).toBe(false);
    await prisma.medicalDoctor.update({ where: { id: c.id }, data: { phone: "0552 00 11 22" } });
    expect(paire(await propositionsFusionMedecins(moi))).toBe(true);
    const u = await prisma.user.create({ data: { name: `${TAG} Délégué`, email: `${TAG}d@banc.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" as never } });
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "MEDICAL_DELEGATE", access: await getAccess(u.id, "MEDICAL_DELEGATE" as never) } as unknown as CurrentUser;
    try {
      expect(await propositionsFusionMedecins(ACTOR)).toEqual([]);
      expect((await fusionnerMedecinsEnDouble(fd({ gardeId: c.id, absorbeId: d.id }))).ok).toBe(false);
      expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: d.id } })).archivedAt).toBeNull();
    } finally {
      ACTOR = moi;
      await prisma.user.delete({ where: { id: u.id } });
    }
  }, 60_000);

  it("un compte sans droit sur l'annuaire : la fusion est refusée, rien ne bouge", async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Viewer`, email: `${TAG}v@banc.dz`, passwordHash: "x", role: "VIEWER" as never } });
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "VIEWER", access: await getAccess(u.id, "VIEWER" as never) } as unknown as CurrentUser;
    try {
      const r = await fusionnerEtablissementsAnnuaire(fd({ groupes: JSON.stringify([{ garder: "x", absorber: ["y"] }]) }));
      expect(r.ok).toBe(false);
    } finally {
      ACTOR = moi;
      await prisma.user.delete({ where: { id: u.id } });
    }
  });
});
