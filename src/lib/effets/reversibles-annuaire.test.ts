import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T2 (décision 0051) — L'ANNUAIRE TENU EN LOT, RÉVERSIBLE : `appliquerLotAnnuaire` et
 * `fusionnerEtablissementsAnnuaire` EXÉCUTÉES au clic de l'écran (`actionReversible`), puis ANNULÉES contre la base locale
 * — tout le lot d'un coup — puis RÉTABLIES.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { appliquerLotAnnuaire, fusionnerEtablissementsAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";

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
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.salesSectorInstitution.deleteMany({ where: { institution: { name: { startsWith: TAG } } } });
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.salesSector.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: `${TAG}@banc.dz` } });
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
