import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { setTenderLineBusinessUnits } from "./pch-tender-line-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__buAlloc__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * DU LOT D'AO AU PORTEFEUILLE D'UNE BU — vérifié par la VRAIE action (§118-14).
 *
 * Le module pur dit ce que la règle décide ; ici on vérifie ce qu'elle FAIT : que l'affectation
 * s'enregistre, qu'elle inscrit le produit au portefeuille de la gamme — le maillon qui manquait
 * entre « on a gagné le lot » et « la force de vente l'attribue à un KAM » —, et que la retirer ne
 * détruit pas le travail de l'équipe commerciale.
 */
suite("Affecter un lot d'appel d'offres à une Business Unit", () => {
  let userId = "", tenderId = "", lineId = "", buA = "", buB = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}user`, email: `${TAG}@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
      select: { id: true },
    });
    userId = u.id;
    const [a, b] = await Promise.all([
      prisma.businessUnit.create({ data: { name: `${TAG} Oncologie` }, select: { id: true } }),
      prisma.businessUnit.create({ data: { name: `${TAG} Anti-infectieux` }, select: { id: true } }),
    ]);
    buA = a.id; buB = b.id;
    const t = await prisma.pchTender.create({
      data: { reference: `${TAG}-AO-1`, title: `${TAG} marché` },
      select: { id: true },
    });
    tenderId = t.id;
    const l = await prisma.pchTenderLine.create({
      data: { tenderId, designation: `${TAG} AMOXICILLINE`, dosage: "500 mg", form: "Gélule", status: "WON", quantityUnits: 8000 },
      select: { id: true },
    });
    lineId = l.id;
    ACTOR = await actorFor(userId, "SUPER_ADMIN");
  });

  afterAll(async () => {
    await prisma.pchTenderLineBusinessUnit.deleteMany({ where: { tenderLineId: lineId } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { businessUnitId: { in: [buA, buB] } } }).catch(() => {});
    await prisma.pchTenderLine.deleteMany({ where: { tenderId } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: tenderId } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { id: { in: [buA, buB] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  async function affecter(...ids: string[]) {
    const fd = new FormData();
    fd.set("id", lineId); fd.set("tenderId", tenderId);
    for (const v of ids) fd.append("businessUnitId", v);
    return setTenderLineBusinessUnits(fd);
  }

  it("L'AFFECTATION S'ENREGISTRE, et le produit ENTRE au portefeuille de la gamme", async () => {
    const r = await affecter(buA);
    expect(r.ok, r.error).toBe(true);
    const liens = await prisma.pchTenderLineBusinessUnit.findMany({ where: { tenderLineId: lineId } });
    expect(liens.map((l) => l.businessUnitId)).toEqual([buA]);

    // LE MAILLON QUI MANQUAIT : sans cette ligne, le produit gagné n'apparaissait dans aucun
    // portefeuille et la force de vente ne pouvait pas l'attribuer.
    const portefeuille = await prisma.promoProduct.findMany({ where: { businessUnitId: buA } });
    expect(portefeuille).toHaveLength(1);
    expect(portefeuille[0].name).toContain("AMOXICILLINE");
    // Le dosage et la forme distinguent le lot d'un homonyme du même bordereau.
    expect(portefeuille[0].name).toContain("500 mg");
  });

  it("DEUX GAMMES PEUVENT SE PARTAGER UN PRODUIT — ville et hôpital sur la même molécule", async () => {
    const r = await affecter(buA, buB);
    expect(r.ok, r.error).toBe(true);
    const liens = await prisma.pchTenderLineBusinessUnit.findMany({ where: { tenderLineId: lineId } });
    expect(liens.map((l) => l.businessUnitId).sort()).toEqual([buA, buB].sort());
    expect(await prisma.promoProduct.count({ where: { businessUnitId: buB } })).toBe(1);
  });

  it("RÉAFFECTER À L'IDENTIQUE NE DUPLIQUE RIEN", async () => {
    await affecter(buA, buB);
    expect(await prisma.pchTenderLineBusinessUnit.count({ where: { tenderLineId: lineId } })).toBe(2);
    expect(await prisma.promoProduct.count({ where: { businessUnitId: buA } })).toBe(1);
  });

  it("RETIRER UNE BU DÉFAIT LE RATTACHEMENT, PAS LE TRAVAIL DE L'ÉQUIPE", async () => {
    // Le produit a pu recevoir des prévisions et des affectations de KAM : le supprimer du
    // portefeuille détruirait ce travail pour un lot qu'on ne fait que dérattacher.
    const r = await affecter(buA);
    expect(r.ok, r.error).toBe(true);
    const liens = await prisma.pchTenderLineBusinessUnit.findMany({ where: { tenderLineId: lineId } });
    expect(liens.map((l) => l.businessUnitId)).toEqual([buA]);
    expect(await prisma.promoProduct.count({ where: { businessUnitId: buB } })).toBe(1);
  });

  it("UNE BU INCONNUE OU DÉSACTIVÉE N'EST PAS AFFECTÉE", async () => {
    const r = await affecter(buA, "bu-qui-n-existe-pas");
    expect(r.ok).toBe(true);
    const liens = await prisma.pchTenderLineBusinessUnit.findMany({ where: { tenderLineId: lineId } });
    expect(liens.map((l) => l.businessUnitId)).toEqual([buA]);
  });
});
