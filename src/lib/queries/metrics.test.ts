import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { METRICS, metricDef, valeurDe } from "@/lib/metrics/catalog";
import { metriquesMarche, metriquesProduit, moisEnCommun } from "./metrics";
import { ensureProduct } from "@/lib/products/resolve";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE SÉMANTIQUE — ce qui la rend digne de confiance.
 *
 * Une couche de métriques se corrompt toujours de la même façon : quelqu'un a besoin d'un
 * chiffre, la donnée manque, et il met zéro « en attendant ». Six mois plus tard le zéro est
 * dans une présentation et personne ne sait qu'il veut dire « on ne sait pas ».
 *
 * Ces tests figent donc la distinction ZÉRO ≠ NULL avant tout le reste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le catalogue des métriques", () => {
  it("chaque métrique porte un nom unique et une définition écrite", () => {
    const noms = METRICS.map((m) => m.nom);
    expect(new Set(noms).size).toBe(noms.length);
    for (const m of METRICS) {
      expect(m.definition.length, m.nom).toBeGreaterThan(40);
      expect(m.portees.length, m.nom).toBeGreaterThan(0);
    }
  });

  it("les cinq mots d'argent existent SÉPARÉMENT — c'est tout l'objet de la couche", () => {
    for (const nom of ["awardedRevenue", "orderedRevenue", "deliveredRevenue", "invoicedRevenue", "collectedRevenue"]) {
      expect(metricDef(nom), nom).not.toBeNull();
    }
    // Et chacun dit ce qu'il N'EST PAS quand la confusion est probable.
    expect(metricDef("awardedRevenue")!.neConfondrePasAvec).toBeTruthy();
    expect(metricDef("collectedRevenue")!.neConfondrePasAvec).toBeTruthy();
  });

  it("une métrique NON DÉCLARÉE ne peut pas circuler", () => {
    // Sans ce refus, un nom inventé au fil de l'eau voyagerait comme s'il avait une définition.
    expect(() => valeurDe("chiffreDaffaires", 42)).toThrow(/métrique inconnue/);
  });

  it("la valeur voyage AVEC sa définition, jamais sans", () => {
    const v = valeurDe("collectedRevenue", 1_000, { base: "3 ventes" });
    expect(v.definition).toContain("RÉGLÉ");
    expect(v.unite).toBe("DZD");
    expect(v.base).toBe("3 ventes");
  });

  it("les mois en commun se calculent sur le CHEVAUCHEMENT, pas sur la durée totale", () => {
    const periode = { du: new Date("2026-01-01"), au: new Date("2026-07-01") };
    // Affectation terminée AVANT la période : zéro mois, et non « la durée de l'affectation ».
    expect(moisEnCommun(periode, { debut: new Date("2024-01-01"), fin: new Date("2024-06-01") })).toBe(0);
    // Affectation à cheval : seule la partie dans la période compte.
    const partiel = moisEnCommun(periode, { debut: new Date("2025-06-01"), fin: new Date("2026-04-01") });
    expect(partiel).toBeGreaterThan(2.5);
    expect(partiel).toBeLessThan(3.5);
    // Affectation toujours en cours : jusqu'à la fin de la période, pas au-delà.
    const ouverte = moisEnCommun(periode, { debut: new Date("2026-01-01"), fin: null });
    expect(ouverte).toBeGreaterThan(5.5);
    expect(ouverte).toBeLessThan(6.5);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `ZZMET${Date.now()}`;
const produits: string[] = [];
const marches: string[] = [];
const utilisateurs: string[] = [];

suite("les métriques calculées", () => {
  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { client: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: marches } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: produits } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: utilisateurs } } }).catch(() => {});
  });

  it("ZÉRO ET « ON NE SAIT PAS » NE SE CONFONDENT PAS", async () => {
    const p = await ensureProduct({ dci: `${TAG}nul`, dosage: "10", dosageUnit: "mg", form: "Comprimé" });
    produits.push(p!.id);

    const m = await metriquesProduit(p!.id);
    const par = new Map(m!.metriques.map((x) => [x.nom, x]));

    // Encaissé = 0 : le produit existe, il n'a rien encaissé. C'est un FAIT.
    expect(par.get("collectedRevenue")!.valeur).toBe(0);

    // Coût humain = null : personne n'y est affecté. On ne SAIT pas ce qu'il coûte, ce qui
    // n'est pas la même chose que « il ne coûte rien ».
    expect(par.get("hrAllocatedCost")!.valeur).toBeNull();
    expect(par.get("hrAllocatedCost")!.pourquoi).toContain("aucune personne affectée");

    // La contribution en dépend, donc elle est null aussi — et non « encaissé moins zéro ».
    expect(par.get("productContribution")!.valeur).toBeNull();

    // Retard = null faute de cible. « Pas de cible » n'est PAS « pas de retard ».
    expect(par.get("regulatoryDelay")!.valeur).toBeNull();
    expect(par.get("regulatoryDelay")!.pourquoi).toBeTruthy();
  });

  it("l'encaissé ne compte que le RÉGLÉ ; l'impayé va aux créances", async () => {
    const p = await ensureProduct({ dci: `${TAG}argent`, dosage: "20", dosageUnit: "mg", form: "Gélule" });
    produits.push(p!.id);

    await prisma.sale.createMany({
      data: [
        { product: `${TAG}p`, client: `${TAG}c1`, quantity: 1, unitPrice: 1000, revenue: 1000, productId: p!.id, paymentStatus: "PAID" },
        { product: `${TAG}p`, client: `${TAG}c2`, quantity: 1, unitPrice: 2000, revenue: 2000, productId: p!.id, paymentStatus: "UNPAID" },
        // PARTIEL : ni encaissé, ni ignoré. Il compte en CRÉANCE pour son montant total, faute
        // de champ portant la part déjà reçue — et la définition le dit.
        { product: `${TAG}p`, client: `${TAG}c3`, quantity: 1, unitPrice: 3000, revenue: 3000, productId: p!.id, paymentStatus: "PARTIAL" },
      ],
    });

    const par = new Map((await metriquesProduit(p!.id))!.metriques.map((x) => [x.nom, x]));
    expect(par.get("collectedRevenue")!.valeur).toBe(1_000);
    expect(par.get("outstandingReceivables")!.valeur).toBe(5_000);
    expect(par.get("outstandingReceivables")!.definition).toContain("PARTIEL");
  });

  it("une affectation SANS quotité est exclue et le coût est déclaré SOUS-ESTIMÉ", async () => {
    const p = await ensureProduct({ dci: `${TAG}rh`, dosage: "5", dosageUnit: "mg", form: "Injectable" });
    produits.push(p!.id);
    // LA FICHE DE PAIE EST CRÉÉE ICI, et c'est délibéré. La première version de ce test
    // cherchait un employé PORTANT DÉJÀ un coût employeur et sortait sans rien vérifier s'il
    // n'en existait pas — ce qui était le cas. Le test passait au vert en ne testant RIEN.
    // Un test qui s'esquive en silence est pire qu'un test absent : il rassure.
    const employe = await prisma.employee.findFirst({ where: { fullName: `${TAG} porteur` }, select: { userId: true } })
      ?? await (async () => {
        const u = await prisma.user.create({
          data: {
            name: `${TAG} porteur`, email: `${TAG}@test.local`, role: "REGULATORY_ASSISTANT",
            // Compte de test, jamais connectable : aucun mot de passe ne correspond à ce jeton.
            passwordHash: `pas-de-connexion-${TAG}`,
          },
          select: { id: true },
        });
        utilisateurs.push(u.id);
        await prisma.employee.create({
          data: { fullName: `${TAG} porteur`, userId: u.id, baseSalary: 100_000, employerCost: 120_000 },
        });
        return { userId: u.id };
      })();

    const debut = new Date(Date.now() - 180 * 86_400_000);
    await prisma.productAssignment.create({
      data: { productId: p!.id, userId: employe.userId!, startedAt: debut, allocationPct: 50 },
    });
    // La MÊME personne, une seconde affectation sans quotité : elle ne doit PAS être répartie
    // au prorata des autres — cela inventerait une décision d'organisation.
    await prisma.productAssignment.create({
      data: { productId: p!.id, userId: employe.userId!, role: "PRODUCT_MANAGER", startedAt: debut, allocationPct: null },
    });

    const m = (await metriquesProduit(p!.id))!;
    const rh = m.metriques.find((x) => x.nom === "hrAllocatedCost")!;
    expect(rh.valeur).not.toBeNull();
    expect(rh.valeur!).toBeGreaterThan(0);
    // Le fait que le chiffre soit incomplet est DIT — un coût sous-estimé qui se présente comme
    // complet fait conclure qu'un produit est rentable alors qu'il ne l'est pas.
    expect(m.limites.some((l) => l.includes("SOUS-ESTIMÉ"))).toBe(true);
  });

  it("sur un marché, les cinq montants restent distincts et cohérents entre eux", async () => {
    const t = await prisma.pchTender.create({
      data: {
        reference: `${TAG}-AO`, status: "IN_PROGRESS",
        lines: { create: [{ designation: `${TAG} l1`, status: "WON", quantityUnits: 100, awardedUnitPriceDzd: 500 }] },
        orders: {
          create: [
            { reference: `${TAG}-1`, quantity: 40, value: 20_000, status: "PAID", paymentDate: new Date() },
            { reference: `${TAG}-2`, quantity: 30, value: 15_000, status: "DELIVERED" },
            { reference: `${TAG}-3`, quantity: 30, value: 15_000, status: "PENDING" },
          ],
        },
      },
      select: { id: true },
    });
    marches.push(t.id);

    const par = new Map((await metriquesMarche(t.id))!.metriques.map((x) => [x.nom, x]));
    expect(par.get("awardedRevenue")!.valeur).toBe(50_000);
    expect(par.get("orderedRevenue")!.valeur).toBe(50_000);
    expect(par.get("deliveredRevenue")!.valeur).toBe(35_000);
    expect(par.get("collectedRevenue")!.valeur).toBe(20_000);
    // La créance est exactement ce qui reste : commandé − encaissé, sans arrondi mystérieux.
    expect(par.get("outstandingReceivables")!.valeur).toBe(30_000);
    // Livré ≥ encaissé et commandé ≥ livré : l'ordre des étapes est une invariante, pas un hasard.
    expect(par.get("orderedRevenue")!.valeur!).toBeGreaterThanOrEqual(par.get("deliveredRevenue")!.valeur!);
    expect(par.get("deliveredRevenue")!.valeur!).toBeGreaterThanOrEqual(par.get("collectedRevenue")!.valeur!);
  });
});
