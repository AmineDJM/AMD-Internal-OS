import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 4a — Regulatory (note d'étape par numéro, variation CRITIQUE, déverrouillage
 * global, rapprochement des catalogues avec « kind » qui tranche), PCH (FUSION intégrale de
 * l'appel d'offres — caution comprise — et de la ligne-produit, vente réelle refusée hors
 * statut Gagné, suppression CRITIQUE en cascade), Stocks (lieux Super Admin, état daté avec
 * lieu résolu), Ventes (CSV collé compté), Logistique (statuts FR → enum, jalons datés).
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops4__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let otherId = "";
let productId = "";
let variationId = "";
let tenderId = "";
let lineWonId = "";
let orderId = "";
let hospitalId = "";
let institutionId = "";
let shipmentId = "";

const sa = () => userWith({
  REGULATORY: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  PCH: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  STOCKS: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  SALES: ["VIEW", "CREATE"],
  LOGISTICS: ["VIEW", "CREATE", "UPDATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);
const other = () => userWith({ WORKSPACE: ["VIEW"] }, "MEDICAL_DELEGATE", otherId, `${TAG} Walid`);

suite("ops vague 4a — Regulatory reste, PCH, Stocks, Ventes, Logistique", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.stockSnapshot.deleteMany({ where: { annex: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.stockSnapshot.deleteMany({ where: { product: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.stockAnnex.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.pchOrder.deleteMany({ where: { tender: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.pchTenderLine.deleteMany({ where: { tender: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdProduct.deleteMany({ where: { dci: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdRange.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.regulatoryVariation.deleteMany({ where: { product: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.logisticsOrder.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.sale.deleteMany({ where: { product: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Walid`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; otherId = o.id;

    const product = await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}-REG-1`, dci: `${TAG} RIFAMPICINE`, status: "SUBMITTED" },
    });
    productId = product.id;
    const variation = await prisma.regulatoryVariation.create({
      data: { productId: product.id, toStatus: "SECONDARY_PACKAGING", status: "EN_ATTENTE" },
    });
    variationId = variation.id;
    await prisma.bdProduct.create({
      data: {
        dci: `${TAG} Ternidazole`,
        range: { create: { name: `${TAG} Gamme BD`, project: { create: { name: `${TAG} Projet BD` } } } },
      },
    });

    const tender = await prisma.pchTender.create({
      data: {
        reference: `${TAG}-AO-1`, title: `${TAG} AO antibiotiques 2026`, products: "Antibiotiques injectables",
        supplier: "Fournisseur Alpha", supplierCountry: "Inde", quantity: 120_000, value: 45_000_000,
        cautionAmount: 900_000, cautionDeposited: true,
        cautionStart: new Date("2026-01-15T00:00:00Z"), cautionEnd: new Date("2026-12-31T00:00:00Z"),
        notes: "Caution bancaire BNA",
      },
    });
    tenderId = tender.id;
    const line = await prisma.pchTenderLine.create({
      data: {
        tenderId: tender.id, designation: `${TAG} Ceftriaxone 1 g inj`, dci: "ceftriaxone",
        dosage: "1 g", form: "injectable", quantityUnits: 50_000, unitsPerBox: 10, unitLabel: "flacon",
        haveProduct: true, suppliersInfo: "2 fabricants locaux", status: "WON", awardedUnitPriceDzd: 180,
      },
    });
    lineWonId = line.id;
    await prisma.pchTenderLine.create({
      data: { tenderId: tender.id, designation: `${TAG} Amoxicilline 500 mg gél`, status: "PENDING", quantityUnits: 80_000 },
    });
    const order = await prisma.pchOrder.create({
      data: { tenderId: tender.id, reference: `${TAG}-BC-7`, products: "Ceftriaxone", quantity: 20_000, value: 3_600_000 },
    });
    orderId = order.id;

    // UN HÔPITAL DE STOCK EST UN ÉTABLISSEMENT DE L'ANNUAIRE (§118.134) : le lieu est RATTACHÉ.
    const etab = await prisma.medicalInstitution.create({ data: { name: `${TAG} CHU Mustapha`, wilaya: "Alger" } });
    institutionId = etab.id;
    const hosp = await prisma.stockAnnex.create({ data: { name: `${TAG} CHU Mustapha`, kind: "HOSPITAL", institutionId: etab.id } });
    hospitalId = hosp.id;
    await prisma.stockSnapshot.create({
      data: { scope: "HOSPITAL", annexId: hosp.id, productId: product.id, date: new Date("2026-08-20T00:00:00Z"), quantity: 340 },
    });

    const shipment = await prisma.logisticsOrder.create({
      data: { reference: `${TAG}-CMD-1`, product: `${TAG} Rifampicine 300 mg`, quantityOrdered: 60_000, status: "SHIPPED", ownerId: s.id },
    });
    shipmentId = shipment.id;
  });


  describe("Regulatory — reste du dossier", () => {
    it("set_step_note : l'étape se donne par NUMÉRO (« 6 » = Demande de présoumission) ; « aucune » efface", async () => {
      // Le numéro suit le processus OFFICIEL du moment (19 étapes — la check-list de
      // présoumission est l'étape 2, la demande de présoumission est donc la 6).
      const p = await buildProposal("regulatory_operation", {
        op: "set_step_note", reference: `${TAG}-REG-1`, step: "6", note: "Rendez-vous ANPP confirmé",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).stepKey).toBe("presub_req");
      expect(domainArgs(p).note).toBe("Rendez-vous ANPP confirmé");

      const clear = await buildProposal("regulatory_operation", {
        op: "set_step_note", reference: `${TAG}-REG-1`, step: "Réception du CTD", note: "aucune",
      }, sa());
      expect("error" in clear).toBe(false);
      if (!("error" in clear)) {
        expect(domainArgs(clear).stepKey).toBe("ctd");
        expect(domainArgs(clear).note).toBeNull();
      }
    });

    it("delete_variation : CRITIQUE — confirmText = référence du dossier, variation unique auto-résolue", async () => {
      const p = await buildProposal("regulatory_operation", { op: "delete_variation", reference: `${TAG}-REG-1` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG}-REG-1`);
      expect(domainArgs(p).id).toBe(variationId);
    });

    it("create_supplier : nom obligatoire ; un homonyme existant est SIGNALÉ avant de confirmer", async () => {
      await prisma.supplier.create({ data: { name: `${TAG} Labo Delta` } });
      const dup = await buildProposal("regulatory_operation", { op: "create_supplier", name: `${TAG} Labo Delta` }, sa());
      expect("error" in dup).toBe(false);
      if (!("error" in dup)) expect(dup.warnings.join(" ")).toMatch(/DÉJÀ/);
    });

    it("link_catalog_product : le produit BD se résout par DCI, le dossier par référence — déjà rattaché = averti", async () => {
      const p = await buildProposal("regulatory_operation", {
        op: "link_catalog_product", name: `${TAG} Ternidazole`, reference: `${TAG}-REG-1`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).kind).toBe("BD");
      expect(domainArgs(p).regulatoryProductId).toBe(productId);
    });
  });

  describe("PCH — FUSION intégrale des marchés", () => {
    it("update_tender : changer le SEUL statut rejoue tout — caution déposée, dates, notes, valeur", async () => {
      const p = await buildProposal("pch_operation", {
        op: "update_tender", reference: `${TAG}-AO-1`, status: "en cours",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.status).toBe("IN_PROGRESS");
      expect(a.title).toBe(`${TAG} AO antibiotiques 2026`);
      expect(a.supplier).toBe("Fournisseur Alpha");
      expect(a.quantity).toBe("120000");
      expect(a.value).toBe("45000000");
      expect(a.cautionAmount).toBe("900000");
      expect(a.cautionDeposited).toBe("1");
      expect(a.cautionStart).toBe("2026-01-15");
      expect(a.notes).toBe("Caution bancaire BNA");
    });

    it("delete_tender : CRITIQUE — confirmText = référence, cascade annoncée avec les comptes", async () => {
      const p = await buildProposal("pch_operation", { op: "delete_tender", reference: `${TAG}-AO-1` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG}-AO-1`);
      expect(p.fields.map((f) => f.value).join(" ")).toMatch(/1 bon\(s\) de commande, 2 ligne\(s\)/);
    });

    it("update_line : FUSION — marquer un prix rejoue conditionnement, unitLabel, haveProduct et statut WON", async () => {
      const p = await buildProposal("pch_operation", {
        op: "update_line", reference: `${TAG}-AO-1`, line: "Ceftriaxone", amount: "175",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.unitPriceDzd).toBe("175");
      expect(a.unitsPerBox).toBe("10");
      expect(a.unitLabel).toBe("flacon");
      expect(a.haveProduct).toBe("on");
      expect(a.status).toBe("WON");
      expect(a.suppliersInfo).toBe("2 fabricants locaux");
      expect(a.quantityUnits).toBe("50000");
    });

    it("create_order_from_line : une ligne NON gagnée est refusée net ; la ligne WON passe avec quantité", async () => {
      const notWon = await buildProposal("pch_operation", {
        op: "create_order_from_line", reference: `${TAG}-AO-1`, line: "Amoxicilline", quantity: "1000",
      }, sa());
      expect("error" in notWon && notWon.error).toMatch(/pas GAGNÉE/);

      const p = await buildProposal("pch_operation", {
        op: "create_order_from_line", reference: `${TAG}-AO-1`, line: "Ceftriaxone", quantity: "5000",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).lineId).toBe(lineWonId);
    });

    it("set_order_arrival : le bon se résout par n°, la date non donnée est rejouée", async () => {
      const p = await buildProposal("pch_operation", {
        op: "set_order_arrival", reference: `${TAG}-AO-1`, order: `${TAG}-BC-7`, date: "2026-09-15",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(orderId);
      expect(domainArgs(p).expectedArrival).toBe("2026-09-15");
    });

    it("analyze_tender_text : sans texte collé, refus explicite", async () => {
      const p = await buildProposal("pch_operation", { op: "analyze_tender_text", reference: `${TAG}-AO-1` }, sa());
      expect("error" in p && p.error).toMatch(/Collez le texte/);
    });
  });

  describe("Stocks — lieux Super Admin + états datés", () => {
    it("record_snapshot : « hôpital » exige l'établissement résolu dans l'annuaire ; l'état complet part avec institutionId + date + quantité", async () => {
      const noLoc = await buildProposal("stock_operation", {
        op: "record_snapshot", product: `${TAG} RIFAMPICINE`, kind: "hôpital", date: "2026-08-25", quantity: "220",
      }, sa());
      expect("error" in noLoc).toBe(true);

      const p = await buildProposal("stock_operation", {
        op: "record_snapshot", product: `${TAG} RIFAMPICINE`, kind: "hôpital", location: "CHU Mustapha", date: "2026-08-25", quantity: "220",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).scope).toBe("HOSPITAL");
      // L'hôpital est désigné par l'ÉTABLISSEMENT de l'annuaire, jamais par le lieu : c'est
      // l'action qui retrouve (ou crée) le lieu rattaché — un seul endroit pour ce lien.
      expect(domainArgs(p).institutionId).toBe(institutionId);
      expect(domainArgs(p).annexId).toBeNull();
      expect(domainArgs(p).quantity).toBe("220");
      expect(p.warnings.join(" ")).toMatch(/MÊME JOUR/);
    });

    it("delete_hospital : CRITIQUE — confirmText = nom, états emportés annoncés ; un non-SA est écarté", async () => {
      const p = await buildProposal("stock_operation", { op: "delete_hospital", location: "CHU Mustapha" }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(p.confirmText).toBe(`${TAG} CHU Mustapha`);
        expect(p.fields.map((f) => f.value).join(" ")).toContain("1");
      }
      const refused = await buildProposal("stock_operation", { op: "create_hospital", location: "CHU Beni Messous" }, other());
      expect("error" in refused).toBe(true);
    });
  });

  describe("Ventes & Logistique", () => {
    it("create_sale : produit ET client obligatoires ; import_sales compte les lignes du CSV collé", async () => {
      const noClient = await buildProposal("sales_operation", { op: "create_sale", product: `${TAG} Doliprane` }, sa());
      expect("error" in noClient && noClient.error).toMatch(/client/);

      const csv = "date,produit,dci,dosage,forme,client,institution,pch,quantité,prix\n2026-08-01,ProdA,,,,CHU Oran,,oui,100,250\n2026-08-02,ProdB,,,,Clinique El Azhar,,non,50,400";
      const imp = await buildProposal("sales_operation", { op: "import_sales", csv }, sa());
      expect("error" in imp).toBe(false);
      if (!("error" in imp)) expect(imp.title).toContain("2 ligne(s)");
    });

    it("update_shipment_status : « dédouanement » → CUSTOMS + jalon daté ; rien à changer = refus", async () => {
      const empty = await buildProposal("logistics_operation", { op: "update_shipment_status", reference: `${TAG}-CMD-1` }, sa());
      expect("error" in empty && empty.error).toMatch(/Rien à changer/);

      const p = await buildProposal("logistics_operation", {
        op: "update_shipment_status", reference: `${TAG}-CMD-1`, status: "dédouanement", customsDate: "2026-08-24",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(shipmentId);
      expect(domainArgs(p).status).toBe("CUSTOMS");
      expect(domainArgs(p).customsDate).toBe("2026-08-24");
    });
  });
});
