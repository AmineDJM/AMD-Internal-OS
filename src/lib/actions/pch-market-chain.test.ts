import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import {
  addContractLine, addOrderLine, createAmendment, createContractFromAward, createDelivery,
  createSubmission, setAmendmentEffective, setLineResult, submitSubmission, updateSubmission,
} from "./pch-market-actions";
import { createOrder } from "./pch-actions";
import { createInvoice } from "./invoice-actions";
import { loadMarket360, loadProductMarkets } from "@/lib/queries/market-360";
import { storyMarche } from "@/lib/queries/story";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__mkt360__";
const fd = (data: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.set(k, v);
  return f;
};

/**
 * LA CHAÎNE ENTIÈRE, DEPUIS LES VRAIES PORTES — l'exemple cible de la mission (§87), joué tel
 * quel : AO à deux produits → soumission versionnée verrouillée → attribution PARTIELLE →
 * contrat né de l'attribution → avenant effectif (+2 000 Pembrolizumab, +180 M) → BC contrôlé
 * contre le restant → livraison partielle avec mouvement de stock → facture → lecture 360°.
 *
 * Les règles pures sont prouvées dans `lib/pch/market-math.test.ts` ; ICI se prouve le
 * BRANCHEMENT : chaque geste passe par l'action serveur (droits, transaction, audit), et la
 * lecture 360° raconte à la fin exactement ce que les gestes ont construit.
 */
suite("Market 360° — la chaîne AO → contrat → avenant → BC → livraison → facture", () => {
  let admin = "";
  let tenderId = "";
  let lignePembro = "";
  let ligneNivo = "";
  let produitPembro = "";
  let contractId = "";
  let amendmentId = "";
  let orderId = "";
  let contractLinePembro = "";
  let orderLineId = "";

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" },
    });
    admin = u.id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false };

    // Deux produits canoniques ; Pembrolizumab porte un profil Regulatory (→ stock possible).
    const pembro = await prisma.product.create({
      data: { code: `${TAG}PRD-001`, canonicalName: `${TAG} Pembrolizumab 100 mg`, dci: `${TAG}pembrolizumab`, identityKey: `${TAG}pembro` },
    });
    produitPembro = pembro.id;
    await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-P1`, dci: `${TAG}pembrolizumab`, status: "CLOSED", productId: pembro.id },
    });
    const nivo = await prisma.product.create({
      data: { code: `${TAG}PRD-002`, canonicalName: `${TAG} Nivolumab 40 mg`, dci: `${TAG}nivolumab`, identityKey: `${TAG}nivo` },
    });

    const tender = await prisma.pchTender.create({
      data: { reference: `${TAG}-AO-2026-ONCO-04`, title: "AO Oncologie 2026", createdById: admin },
    });
    tenderId = tender.id;
    const l1 = await prisma.pchTenderLine.create({
      data: { tenderId, designation: "Pembrolizumab 100 mg flacon", quantityUnits: 5000, unitPriceDzd: 100, status: "SUBMITTED", productId: pembro.id },
    });
    lignePembro = l1.id;
    const l2 = await prisma.pchTenderLine.create({
      data: { tenderId, designation: "Nivolumab 40 mg flacon", quantityUnits: 8000, unitPriceDzd: 50, status: "SUBMITTED", productId: nivo.id },
    });
    ligneNivo = l2.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { summary: { contains: TAG } } }).catch(() => {});
    // Les factures sont des documents légaux : le nettoyage de `legalDocument`, plus bas, les emporte.
    await prisma.stockMovement.deleteMany({ where: { product: { contains: "Pembrolizumab 100 mg flacon" }, notes: { contains: "Livraison marché" } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { contains: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("la soumission se versionne, se dépose, se VERROUILLE — et fige la photo des lignes", async () => {
    const created = await createSubmission(fd({ tenderId, label: "Version finale" }));
    expect(created.ok).toBe(true);
    const subId = created.id!;

    expect((await submitSubmission(fd({ id: subId }))).ok).toBe(true);

    // Le marché porte désormais sa date de dépôt — le jalon que la frise DÉDUISAIT.
    const t = await prisma.pchTender.findUniqueOrThrow({ where: { id: tenderId }, select: { submittedAt: true } });
    expect(t.submittedAt).not.toBeNull();

    // La photo est figée sur les lignes, produit compris.
    const l = await prisma.pchTenderLine.findUniqueOrThrow({ where: { id: lignePembro }, select: { submissionSnapshot: true } });
    const snap = l.submissionSnapshot as Record<string, unknown>;
    expect(snap.quantiteSoumise).toBe(5000);
    expect((snap.produit as Record<string, unknown>).code).toBe(`${TAG}PRD-001`);

    // La version déposée REFUSE toute retouche — côté serveur.
    const refus = await updateSubmission(fd({ id: subId, label: "retouche interdite" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toContain("ne se modifie plus");
  }, 30_000);

  it("l'attribution est PARTIELLE ligne par ligne, et refuse d'attribuer plus que le soumis", async () => {
    expect((await setLineResult(fd({ lineId: lignePembro, status: "WON", awardedQuantityUnits: "5000", awardedUnitPriceDzd: "100" }))).ok).toBe(true);
    expect((await setLineResult(fd({ lineId: ligneNivo, status: "WON", awardedQuantityUnits: "4000", awardedUnitPriceDzd: "50" }))).ok).toBe(true);

    const trop = await setLineResult(fd({ lineId: ligneNivo, status: "WON", awardedQuantityUnits: "9000" }));
    expect(trop.ok).toBe(false);
    expect(trop.error).toContain("supérieure à la quantité soumise");
  }, 30_000);

  it("le contrat naît de l'attribution : un LegalDocument relié au marché, avec ses lignes", async () => {
    const res = await createContractFromAward(fd({ tenderId, reference: `${TAG}-174/2026`, title: `${TAG} Contrat PCH Oncologie` }));
    expect(res.ok).toBe(true);
    contractId = res.id!;

    const doc = await prisma.legalDocument.findUniqueOrThrow({
      where: { id: contractId },
      select: { kind: true, tenderId: true, amount: true, rootContractLines: { select: { id: true, quantityUnits: true, productId: true } } },
    });
    expect(doc.kind).toBe("CONTRACT");
    expect(doc.tenderId).toBe(tenderId); // le lien FORT, plus une recherche par texte
    // 5000×100 + 4000×50 = 700 000 — la quantité ATTRIBUÉE, pas la demandée.
    expect(Number(doc.amount)).toBe(700_000);
    expect(doc.rootContractLines).toHaveLength(2);
    contractLinePembro = doc.rootContractLines.find((l) => l.productId === produitPembro)!.id;
  }, 30_000);

  it("l'avenant ajoute +2 000 Pembrolizumab et +180 000 — l'initial ne bouge pas, le courant se calcule", async () => {
    const res = await createAmendment(fd({ contractId, amountDelta: "180000", title: `${TAG} Avenant n° 1` }));
    expect(res.ok).toBe(true);
    amendmentId = res.id!;

    // Pas encore effectif : il ne compte pas.
    let m = await loadMarket360(tenderId);
    expect(m!.contrats[0].valeurCourante).toBe(700_000);

    expect((await addContractLine(fd({ documentId: amendmentId, designation: "Pembrolizumab 100 mg flacon", quantityUnits: "2000", productId: produitPembro, tenderLineId: lignePembro }))).ok).toBe(true);
    expect((await setAmendmentEffective(fd({ id: amendmentId, effectiveAt: "2026-01-15" }))).ok).toBe(true);

    m = await loadMarket360(tenderId);
    expect(m!.contrats[0].montantInitial).toBe(700_000); // jamais écrasé
    expect(m!.contrats[0].valeurCourante).toBe(880_000); // 700 000 + 180 000
    const pembro = m!.lignes.find((l) => l.id === lignePembro)!;
    expect(pembro.quantiteContractuelle).toBe(7000); // 5 000 + 2 000 — les deux écritures restent lisibles
  }, 30_000);

  it("le BC est contrôlé contre le restant contractuel : refus chiffré, passage en force tracé", async () => {
    const created = await createOrder(fd({ tenderId, reference: `${TAG}-BC-001`, quantity: "0", contractId }));
    expect(created.ok).toBe(true);
    const order = await prisma.pchOrder.findFirstOrThrow({ where: { reference: `${TAG}-BC-001` }, select: { id: true, contractId: true } });
    orderId = order.id;
    expect(order.contractId).toBe(contractId);

    // 1 500 sur 7 000 : passe.
    const ok = await addOrderLine(fd({ orderId, contractLineId: contractLinePembro, designation: "Pembrolizumab 100 mg flacon", quantityUnits: "1500" }));
    expect(ok.ok).toBe(true);
    orderLineId = (await prisma.pchOrderLine.findFirstOrThrow({ where: { orderId }, select: { id: true } })).id;

    // 6 000 de plus sur 5 500 restantes : REFUS, avec le chiffre exact.
    const refus = await addOrderLine(fd({ orderId, contractLineId: contractLinePembro, designation: "Pembrolizumab 100 mg flacon", quantityUnits: "6000" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toContain("excès 500");

    // Le passage en force passe ET se dit — puis on retire la ligne pour la suite du scénario.
    const force = await addOrderLine(fd({ orderId, contractLineId: contractLinePembro, designation: "Pembrolizumab 100 mg flacon", quantityUnits: "6000", force: "true" }));
    expect(force.ok).toBe(true);
    expect(force.message).toContain("dépassement de 500");
    const forcee = await prisma.pchOrderLine.findFirstOrThrow({ where: { orderId, quantityUnits: 6000 }, select: { id: true } });
    await prisma.pchOrderLine.delete({ where: { id: forcee.id } });
  }, 30_000);

  it("la livraison PARTIELLE écrit ses lignes, son lot pharma, et son mouvement de stock", async () => {
    const res = await createDelivery(fd({
      orderId, reference: `${TAG}-BL-008`, deliveredAt: "2026-02-01",
      [`qty_${orderLineId}`]: "1000", [`batch_${orderLineId}`]: "LOT-2026-A",
      createStockMovements: "true",
    }));
    expect(res.ok).toBe(true);

    const delivery = await prisma.pchDelivery.findFirstOrThrow({
      where: { orderId },
      select: { id: true, lines: { select: { quantityUnits: true, batchNumber: true } }, stockMovements: { select: { direction: true, quantity: true } } },
    });
    expect(delivery.lines).toEqual([{ quantityUnits: 1000, batchNumber: "LOT-2026-A" }]);
    // Le produit se résout SANS ambiguïté (un seul profil Regulatory) → un mouvement OUT.
    expect(delivery.stockMovements).toEqual([{ direction: "OUT", quantity: 1000 }]);
  }, 30_000);

  it("la lecture 360° raconte toute la chaîne — et dit ce qui MANQUE", async () => {
    // Une facture Finance rattachée au BC — par le VRAI point d'entrée : l'action createInvoice
    // avec les champs cachés sourceType/sourceId, exactement ce que le bouton « Facture » du bon
    // déplié envoie (pas un état injecté à la main).
    const rInv = await createInvoice(undefined, fd({
      title: `${TAG} Facture F-194`, amount: "150000", direction: "IN",
      issueDate: "2026-02-05", dueDate: "2026-02-20",
      sourceType: "PCH_ORDER", sourceId: orderId,
    }));
    expect(rInv.ok).toBe(true);

    const m = await loadMarket360(tenderId);
    expect(m).not.toBeNull();
    expect(m!.niveau.niveau).toBe("EXECUTION");
    expect(m!.finances.soumis).toBe(900_000); // 5000×100 + 8000×50
    expect(m!.finances.attribue).toBe(700_000);
    expect(m!.finances.contratCourant).toBe(880_000);
    expect(m!.finances.facture).toBe(150_000);

    const pembro = m!.lignes.find((l) => l.id === lignePembro)!;
    expect(pembro.quantiteCommandee).toBe(1500);
    expect(pembro.quantiteLivree).toBe(1000);
    expect(pembro.restantACommander).toBe(5500);

    const bon = m!.bons.find((b) => b.id === orderId)!;
    expect(bon.factures).toHaveLength(1);
    expect(bon.livraisons[0].lignes[0].batchNumber).toBe("LOT-2026-A");

    // Les trous se DISENT : facture échue non réglée.
    expect(m!.manques.some((x) => x.includes("échue"))).toBe(true);
  }, 30_000);

  it("depuis le PRODUIT, on retrouve ses marchés — quantités, prix, restants (§30)", async () => {
    const rows = await loadProductMarkets(produitPembro);
    const row = rows.find((r) => r.tenderId === tenderId)!;
    expect(row.reference).toBe(`${TAG}-AO-2026-ONCO-04`);
    expect(row.quantiteAttribuee).toBe(5000);
    expect(row.quantiteContractuelle).toBe(7000);
    expect(row.quantiteCommandee).toBe(1500);
    expect(row.restantACommander).toBe(5500);
  }, 30_000);
  it("la frise (storyMarche) tient désormais sur les FK : dépôt daté, contrat rattaché, avenant effectif, BL réel, facture", async () => {
    const story = await storyMarche(`${TAG}-AO-2026-ONCO-04`);
    expect(story).not.toBeNull();
    const ev = story!.events;

    // Le dépôt est un FAIT daté — plus une déduction par lignes chiffrées.
    const soumission = ev.find((e) => e.id === "soumission");
    expect(soumission?.certitude).toBe("fait");
    expect(soumission?.date).not.toBeNull();
    expect(story!.limites.join(" | ")).not.toContain("déduit des lignes chiffrées");

    // Le contrat vient de la FK tenderId, plus de la recherche par texte.
    const contrat = ev.find((e) => e.id === `contrat:${contractId}`);
    expect(contrat).toBeDefined();
    expect(contrat?.provenance).toContain("tenderId");
    // Sa valeur COURANTE (initial + avenant effectif) est affichée à côté de l'initial.
    expect((contrat?.metriques ?? []).some((m) => m.label === "valeur courante")).toBe(true);

    // L'avenant EFFECTIF est un jalon fait, sous son contrat, avec son delta.
    const avenant = ev.find((e) => e.id === `avenant:${amendmentId}`);
    expect(avenant?.etat).toBe("fait");
    expect(avenant?.parent).toBe(`contrat:${contractId}`);

    // La livraison est le BL RÉEL (PchDelivery), pas le statut du bon.
    expect(ev.some((e) => e.kind === "livraison" && e.provenance === "PchDelivery" && e.etat === "fait")).toBe(true);
    // La facture du module Finances apparaît sous son bon de commande.
    expect(ev.some((e) => e.kind === "facture")).toBe(true);
  });

});
