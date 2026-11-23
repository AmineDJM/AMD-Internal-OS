import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { etapeDeLaFile, fileAgences } from "./requetes/file-agences";
import { demandesAuCentreAdPro } from "./requetes/centre";
import { posteAttendLeCentreBC, relacherLesPostesSousLeSeuil } from "./marche-bc";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RECETTE DU 23/11/2026 — LE PARCOURS AGENCE, LE CENTRE ET LE SEUIL DES BC.
 *
 *   • la file « Prospection d'agences » dit l'étape RÉELLE du poste (celle de sa carte) : un BC au centre du DG, chez les
 *     Finances, ou renvoyé pour correction n'est plus « à la Direction Marketing de jouer » ;
 *   • la ligne du centre ouvre LE POSTE sur la fiche de son opération, pas la fiche en tête ;
 *   • un seuil relevé rend aux Finances les demandes de BC de poste qui attendaient le DG et n'ont plus à y être.
 *
 * Le seuil des BC est un réglage GLOBAL que d'autres bancs font bouger (1, 3 DZD…) : ce banc ne le touche pas, il appelle la
 * relâche avec son propre seuil (7 DZD) et joue des postes de 6 et 8 DZD, hors de la bande des voisins.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__rec2311${Date.now().toString(36)}__`;

async function personne(id: string): Promise<SessionUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access } as SessionUser;
}

describe("la file range l'étape de la carte (PUR)", () => {
  it("BC renvoyé par les Finances, au centre du DG, chez les Finances : trois étapes distinctes, aucune « BC soumis »", () => {
    expect(etapeDeLaFile("BC_A_CORRIGER")).toBe("BC_A_CORRIGER");
    expect(etapeDeLaFile("BC_CHEZ_CENTRE")).toBe("BC_CHEZ_DG");
    expect(etapeDeLaFile("BC_A_SIGNER_FINANCES")).toBe("BC_CHEZ_FINANCES");
    expect(etapeDeLaFile("BC_A_VALIDER")).toBe("BC_SOUMIS");
    expect(etapeDeLaFile("BC_CHEZ_ASSISTANTE")).toBe("BC_A_FINALISER");
    expect(etapeDeLaFile("BC_A_PREPARER")).toBe("BC_A_PREPARER");
  });

  it("le centre ne garde une demande de BC de poste qu'au-dessus du seuil en vigueur", () => {
    expect(posteAttendLeCentreBC(6, 7)).toBe(false);
    expect(posteAttendLeCentreBC(7, 7), "au seuil : en deçà").toBe(false);
    expect(posteAttendLeCentreBC(8, 7)).toBe(true);
    expect(posteAttendLeCentreBC(null, 7), "montant inconnu : le centre").toBe(true);
    expect(posteAttendLeCentreBC(6, 0), "aucun seuil : tout BC passe au centre").toBe(true);
  });
});

suite("Recette du 23/11/2026 — file agences, ligne du centre, seuil relevé (base réelle)", () => {
  let pmId = "", astId = "", kamId = "", saId = "", eventId = "";
  let posteAgence = "", bcAgence = "";
  let petit = "", bcPetit = "", grand = "";
  const docs: string[] = [];
  const postes: string[] = [];

  const ligneDe = async (userId: string) => (await fileAgences(await personne(userId)))?.find((l) => l.itemId === posteAgence) ?? null;

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    pmId = await mk("pm", "PRODUCT_MANAGER");
    astId = await mk("ast", "DIRECTION_ASSISTANT");
    kamId = await mk("kam", "MEDICAL_DELEGATE");
    saId = await mk("sa", "SUPER_ADMIN");
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journée`, requesterId: kamId, requestStatus: "APPROVED" } })).id;

    // UN POSTE AGENCE dont le BC, signé par la Direction Marketing, attend le visa du DG (au-dessus du seuil).
    posteAgence = (await prisma.adProItem.create({
      data: { label: `${TAG}Kakémonos`, eventId, kind: "PRINTING", status: "APPROVED", amountGranted: 50_000_000, supplier: "Imprimerie Alpha", voie: "AGENCE", orderStage: "REQUESTED", orderRequestedAt: new Date() },
    })).id;
    postes.push(posteAgence);
    const ancien = new Date("2000-01-01T00:00:00Z"); // en tête de la file, quoi qu'y aient laissé les autres bancs
    await prisma.adProExecutionPoste.create({
      data: { itemId: posteAgence, assistanteId: astId, prospectionDemandeeAt: ancien, devisTransmisAt: ancien, agenceRetenueAt: ancien, bcSoumisAt: ancien },
    });
    bcAgence = (await prisma.legalDocument.create({
      data: { title: `${TAG}BC agence`, kind: "PURCHASE_ORDER", reference: `${TAG}BC-A`, amount: 50_000_000, sourceType: "AD_PRO_ITEM", sourceId: posteAgence, bcCircuitAt: new Date() },
    })).id;
    docs.push(bcAgence);
    await prisma.adProItemPiece.create({ data: { itemId: posteAgence, legalDocumentId: bcAgence, nature: "BON_DE_COMMANDE" } });
    await prisma.signatureBC.create({
      data: { legalDocumentId: bcAgence, qualite: "DIRECTION_MARKETING", userId: pmId, signataireNom: `${TAG}pm`, methode: "EN_LIGNE", jeton: `${TAG}jeton` },
    });

    // DEUX DEMANDES DE BC « au centre » : 6 DZD (sous le seuil de 7) et 8 DZD (au-dessus).
    petit = (await prisma.adProItem.create({
      data: { label: `${TAG}Petit`, eventId, kind: "CATERING", status: "APPROVED", amountGranted: 6, orderStage: "REQUESTED", orderRequestedAt: new Date(), orderRequestedById: pmId },
    })).id;
    grand = (await prisma.adProItem.create({
      data: { label: `${TAG}Grand`, eventId, kind: "CATERING", status: "APPROVED", amountGranted: 8, orderStage: "REQUESTED", orderRequestedAt: new Date(), orderRequestedById: pmId },
    })).id;
    postes.push(petit, grand);
    bcPetit = (await prisma.legalDocument.create({
      data: { title: `${TAG}BC petit`, kind: "PURCHASE_ORDER", reference: `${TAG}BC-P`, amount: 6, sourceType: "AD_PRO_ITEM", sourceId: petit, bcCircuitAt: new Date() },
    })).id;
    docs.push(bcPetit);
    await prisma.adProItemPiece.create({ data: { itemId: petit, legalDocumentId: bcPetit, nature: "BON_DE_COMMANDE" } });
  }, 60_000);

  afterAll(async () => {
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: docs } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...postes, eventId] } }, { actorId: { in: [pmId, astId, kamId, saId] } }] } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("BC AU CENTRE DU DG : la file le dit chez le DG — ni la Direction Marketing ni l'assistante n'ont la main", async () => {
    const pm = await ligneDe(pmId);
    expect(pm).toMatchObject({ etape: "BC_CHEZ_DG", aMoi: false });
    expect(await ligneDe(astId)).toMatchObject({ etape: "BC_CHEZ_DG", aMoi: false });
    // Le Super Admin siège au centre : la carte lui donne « Viser le bon de commande », la file aussi.
    expect(await ligneDe(saId)).toMatchObject({ etape: "BC_CHEZ_DG", aMoi: true });
  });

  it("la ligne du centre ouvre LE POSTE sur la fiche de son opération", async () => {
    const ligne = (await demandesAuCentreAdPro()).find((l) => l.entityId === posteAgence);
    expect(ligne?.forme).toBe("BC_POSTE");
    expect(ligne?.href).toBe(lienPosteAdPro("EVENT", eventId, posteAgence));
  });

  it("BC VISÉ, chez les Finances : personne du parcours n'a la main", async () => {
    await prisma.adProItem.update({ where: { id: posteAgence }, data: { orderStage: "DIRECTION_OK", orderDirectionAt: new Date() } });
    expect(await ligneDe(pmId)).toMatchObject({ etape: "BC_CHEZ_FINANCES", aMoi: false });
    expect(await ligneDe(astId)).toMatchObject({ etape: "BC_CHEZ_FINANCES", aMoi: false });
  });

  it("BC RENVOYÉ par les Finances : à l'assistante de le corriger — plus à la Direction Marketing", async () => {
    await prisma.legalDocument.update({ where: { id: bcAgence }, data: { signatureReturnedAt: new Date(), signatureReturnNote: "Mauvais RIB" } });
    expect(await ligneDe(astId)).toMatchObject({ etape: "BC_A_CORRIGER", aMoi: true });
    expect(await ligneDe(pmId)).toMatchObject({ etape: "BC_A_CORRIGER", aMoi: false });
  });

  it("SEUIL RELEVÉ : la demande sous le seuil quitte le centre comme la marche l'aurait aiguillée ; celle au-dessus reste", async () => {
    const bilan = await relacherLesPostesSousLeSeuil(7, saId);
    const p = await prisma.adProItem.findUniqueOrThrow({ where: { id: petit } });
    expect(p.orderStage).toBe("DIRECTION_OK");
    expect(p.orderDecisionNote ?? "").toMatch(/Sous le seuil/);
    expect(p.orderDirectionAt, "la fiche ne dit pas « validé par le centre »").toBeNull();
    expect(bilan.bcIds, "son BC déjà établi est rendu à l'appelant, qui prévient les Finances").toContain(bcPetit);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: grand } })).orderStage).toBe("REQUESTED");
    expect(await prisma.auditLog.count({ where: { entityId: eventId, summary: { contains: "quitte le centre" } } })).toBeGreaterThan(0);
    // Rejoué, rien ne bouge : l'écriture est conditionnelle.
    const encore = await relacherLesPostesSousLeSeuil(7, saId);
    expect(encore.bcIds).not.toContain(bcPetit);
  });

  it("sans seuil (0), rien n'est rendu : tout BC passe par le centre", async () => {
    expect(await relacherLesPostesSousLeSeuil(0, saId)).toEqual({ postes: 0, bcIds: [], tronque: false });
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: grand } })).orderStage).toBe("REQUESTED");
  });
});
