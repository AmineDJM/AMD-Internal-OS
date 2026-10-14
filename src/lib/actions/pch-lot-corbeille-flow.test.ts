import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { createOrderFromLine, deleteTenderLine, updateTenderLine } from "@/lib/actions/pch-tender-line-actions";
import { restaurerLotDeLaCorbeille } from "@/lib/suppression/coeur";
import { apercuSuppression } from "@/lib/admin-delete-registry";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pchlotcorb__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN LOT D'APPEL D'OFFRES : RETIRÉ À LA CORBEILLE, REFUSÉ QUAND QUELQUE CHOSE EN DÉCOULE, ET CORRIGÉ SANS
 * RÉÉCRIRE CE QUE LE FORMULAIRE NE PORTE PAS (vague « restes »).
 *
 * `deleteTenderLine` effaçait d'un seul `delete`, sans corbeille ni journal — et un bon de commande né du lot
 * gardait un `lineId` vers rien ; `updateTenderLine` écrivait chaque colonne à chaque appel, si bien qu'un
 * formulaire qui ne portait que la quantité remettait un lot GAGNÉ à « À étudier » et effaçait ses prix de boîte.
 * Joué par les VRAIES actions, avec un gestionnaire des marchés SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("le lot d'un appel d'offres — corbeille, refus nommé, écriture partielle", () => {
  let gest = "", tender = "", bu = "", produit = "", contrat = "";

  async function nettoyer() {
    const tenders = (await prisma.pchTender.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
    const lignes = (await prisma.pchTenderLine.findMany({ where: { tenderId: { in: tenders } }, select: { id: true } })).map((l) => l.id);
    await prisma.deletedRecord.deleteMany({ where: { kind: "PCH_TENDER_LINE", name: { contains: TAG } } }).catch(() => {});
    await prisma.sale.deleteMany({ where: { product: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchContractLine.deleteMany({ where: { tenderLineId: { in: lignes } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: tenders } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    gest = (await prisma.user.create({ data: { name: `${TAG}gest`, email: `${TAG}gest@t.dz`, role: "LOGISTICS_MANAGER", passwordHash: "x" } })).id;
    ACTEUR = { id: gest, role: "LOGISTICS_MANAGER", secondaryRole: null, access: await getAccess(gest, "LOGISTICS_MANAGER") } as unknown as SessionUser;
    tender = (await prisma.pchTender.create({ data: { reference: `${TAG}AO-1`, title: `${TAG} marché CHU`, responsibleId: gest } })).id;
    bu = (await prisma.businessUnit.create({ data: { name: `${TAG} BU hôpital`, code: `${TAG}BU` } })).id;
    produit = (await prisma.product.create({ data: { code: `${TAG}P1`, canonicalName: `${TAG}P1`, dci: "ZZQLOTCORB", identityKey: `${TAG}P1` } })).id;
    contrat = (await prisma.legalDocument.create({ data: { reference: `${TAG}CT-1`, title: `${TAG} contrat de marché`, kind: "CONTRACT", status: "ACTIVE", tenderId: tender } as never, select: { id: true } })).id;
  });
  afterAll(async () => { await nettoyer(); });

  const ligne = (designation: string, data: Record<string, unknown> = {}) =>
    prisma.pchTenderLine.create({ data: { tenderId: tender, designation: `${TAG} ${designation}`, ...data } as never, select: { id: true } });
  const relire = (id: string) => prisma.pchTenderLine.findUnique({ where: { id } });

  it("PRÉMISSES : le gestionnaire modifie les marchés sans vue globale", () => {
    const a = ACTEUR as SessionUser;
    expect(hasGlobalView(a.role)).toBe(false);
    expect(userCan(a, "PCH", "UPDATE")).toBe(true);
  });

  it("RETIRER un lot l'envoie à la corbeille avec ses affectations à des BU — le marché le dit — et tout revient", async () => {
    const l = (await ligne("Paracétamol 500 mg")).id;
    await prisma.pchTenderLineBusinessUnit.create({ data: { tenderLineId: l, businessUnitId: bu } });
    const r = await deleteTenderLine(fd({ id: l, tenderId: tender }));
    expect(r.ok, r.error).toBe(true);
    expect(await relire(l)).toBeNull();
    expect(await prisma.pchTenderLineBusinessUnit.count({ where: { tenderLineId: l } })).toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "PCH_TENDER_LINE", sourceId: l } });
    expect(rec.name).toBe(`${TAG} Paracétamol 500 mg — ${TAG}AO-1`);
    // L'historique du MARCHÉ porte le geste : le journal du cœur désigne une ligne qu'aucun écran ne relit plus.
    expect(await prisma.auditLog.count({ where: { actorId: gest, entityType: "PCH_TENDER", entityId: tender, summary: { contains: "Paracétamol 500 mg" } } })).toBe(1);
    const back = await restaurerLotDeLaCorbeille(rec, "PCH_TENDER_LINE");
    expect(back?.ok, back?.error).toBe(true);
    expect((await relire(l))?.designation).toBe(`${TAG} Paracétamol 500 mg`);
    expect(await prisma.pchTenderLineBusinessUnit.count({ where: { tenderLineId: l } }), "l'affectation revient avec son lot").toBe(1);
  });

  it("UN BON DE COMMANDE NÉ DU LOT (`lineId`, un lien texte) refuse la suppression en le nommant — rien ne part", async () => {
    const l = (await ligne("Ibuprofène 400 mg", { status: "WON", unitPriceDzd: 12, awardedUnitPriceDzd: 11 })).id;
    const bc = await createOrderFromLine(fd({ lineId: l, tenderId: tender, quantity: "500", reference: `${TAG}BC-1` }));
    expect(bc.ok, bc.error).toBe(true);
    const r = await deleteTenderLine(fd({ id: l, tenderId: tender }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`Ce lot ne se supprime pas : il porte 1 bon de commande (${TAG}BC-1). Le supprimer les détacherait de leur lot — une vente sous marché passerait pour une vente de ville, un contrat ne dirait plus de quel lot il découle. Pour le sortir du marché, passez son statut à « Lot annulé » : il reste à l'historique, avec ce qui en découle.`);
    expect(await relire(l)).not.toBeNull();
    expect(await prisma.deletedRecord.count({ where: { kind: "PCH_TENDER_LINE", sourceId: l } })).toBe(0);
    // Le bouton rouge et Adam lisent le MÊME refus, avant le clic (§118.53).
    expect((await apercuSuppression("PCH_TENDER_LINE", l)).refus).toBe(r.error);
  });

  it("UNE LIGNE DE BON, UNE LIGNE DE CONTRAT, UNE VENTE, UNE RÉPARTITION Ad & Pro : chacune comptée, aucune nommée hors du marché", async () => {
    const l = (await ligne("Amoxicilline 1 g", { status: "WON" })).id;
    await prisma.pchOrder.create({ data: { tenderId: tender, reference: `${TAG}BC-2`, orderLines: { create: [{ designation: "Amoxicilline 1 g", tenderLineId: l }] } } });
    await prisma.pchContractLine.create({ data: { documentId: contrat, contractId: contrat, designation: "Amoxicilline 1 g", quantityUnits: 900, tenderLineId: l } });
    await prisma.sale.create({ data: { product: `${TAG} Amoxicilline`, client: "CHU Mustapha", tenderLineId: l } });
    const evenement = (await prisma.event.create({ data: { name: `${TAG} congrès` } as never, select: { id: true } })).id;
    const poste = (await prisma.adProItem.create({ data: { label: `${TAG} poste imprimerie`, eventId: evenement } as never, select: { id: true } })).id;
    await prisma.adProProductAllocation.create({ data: { itemId: poste, productId: produit, tenderLineId: l } });
    const r = await deleteTenderLine(fd({ id: l, tenderId: tender }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(`il porte 1 bon de commande (${TAG}BC-2), 1 ligne de contrat de marché, 1 vente sous marché et 1 répartition d'un poste Ad & Pro.`);
    // Le titre d'un contrat passe par la porte de Legal, le libellé d'un poste par celle d'Ad & Pro (§118.118).
    expect(r.error).not.toContain("contrat de marché »");
    expect(r.error).not.toContain(`${TAG} contrat`);
    expect(r.error).not.toContain("poste imprimerie");
    expect(await relire(l)).not.toBeNull();
    expect(await prisma.sale.count({ where: { tenderLineId: l } }), "la vente reste une vente SOUS MARCHÉ").toBe(1);
  });

  it("CHACUN SEUL REFUSE : une vente sous marché suffit à garder le lot", async () => {
    const l = (await ligne("Céfazoline 1 g")).id;
    await prisma.sale.create({ data: { product: `${TAG} Céfazoline`, client: "EPH Kouba", tenderLineId: l } });
    const r = await deleteTenderLine(fd({ id: l, tenderId: tender }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("il porte 1 vente sous marché.");
    expect(await relire(l)).not.toBeNull();
  });

  it("ÉCRITURE PARTIELLE : un formulaire qui ne porte que la quantité ne touche à rien d'autre", async () => {
    const l = (await ligne("Héparine 5000 UI", {
      status: "WON", dci: "HEPARINE", dosage: "5000 UI", note: "prix négocié", haveProduct: true, unitsPerBox: 10,
      boxPriceDzd: 1000, boxCostDzd: 700, unitPriceDzd: 100, awardedUnitPriceDzd: 95, awardedQuantityUnits: 800, submittedQuantityUnits: 1000,
    })).id;
    const r = await updateTenderLine(fd({ id: l, tenderId: tender, quantityUnits: "1200" }));
    expect(r.ok, r.error).toBe(true);
    const x = (await relire(l))!;
    expect(x.quantityUnits).toBe(1200);
    expect(x.modifieeLe, "une vraie différence pose la marque de modification").not.toBeNull();
    expect({
      status: x.status, dci: x.dci, dosage: x.dosage, note: x.note, haveProduct: x.haveProduct, unitsPerBox: x.unitsPerBox,
      box: Number(x.boxPriceDzd), cout: Number(x.boxCostDzd), unite: Number(x.unitPriceDzd), attribue: Number(x.awardedUnitPriceDzd),
      qAttribuee: x.awardedQuantityUnits, qSoumise: x.submittedQuantityUnits,
    }, "ce que le formulaire ne porte pas garde sa valeur").toEqual({
      status: "WON", dci: "HEPARINE", dosage: "5000 UI", note: "prix négocié", haveProduct: true, unitsPerBox: 10,
      box: 1000, cout: 700, unite: 100, attribue: 95, qAttribuee: 800, qSoumise: 1000,
    });
  });

  it("CE QUI EST PORTÉ VIDE SE VIDE, la case dit « non » par son témoin, et la boîte se divise par le conditionnement EN VIGUEUR", async () => {
    const l = (await ligne("Ceftriaxone 1 g", { note: "à revoir", haveProduct: true, unitsPerBox: 25, unitPriceDzd: 40 })).id;
    // Une boîte sans conditionnement dans le formulaire : la ligne a 25 unités par boîte, pas « rien ».
    expect((await updateTenderLine(fd({ id: l, tenderId: tender, note: "", haveProduct: "off", boxPriceDzd: "1500" }))).ok).toBe(true);
    const x = (await relire(l))!;
    expect(x.note).toBeNull();
    expect(x.haveProduct).toBe(false);
    expect(Number(x.boxPriceDzd)).toBe(1500);
    expect(Number(x.unitPriceDzd)).toBe(60);
    expect(x.unitsPerBox).toBe(25);
    // La case cochée revient par « on ».
    expect((await updateTenderLine(fd({ id: l, tenderId: tender, haveProduct: "on" }))).ok).toBe(true);
    expect((await relire(l))!.haveProduct).toBe(true);
  });

  it("UN STATUT ILLISIBLE est refusé — il ne rend pas un lot gagné « À étudier » — et rien n'est écrit", async () => {
    const l = (await ligne("Vancomycine 500 mg", { status: "WON", quantityUnits: 300 })).id;
    const r = await updateTenderLine(fd({ id: l, tenderId: tender, status: "GAGNE", quantityUnits: "999" }));
    expect(r).toEqual({ ok: false, error: "Statut de lot inconnu (« GAGNE ») : rien n'a été enregistré." });
    const x = (await relire(l))!;
    expect(x.status).toBe("WON");
    expect(x.quantityUnits).toBe(300);
    // Un statut lisible s'écrit, lui.
    expect((await updateTenderLine(fd({ id: l, tenderId: tender, status: "CANCELLED" }))).ok).toBe(true);
    expect((await relire(l))!.status).toBe("CANCELLED");
  });
});
