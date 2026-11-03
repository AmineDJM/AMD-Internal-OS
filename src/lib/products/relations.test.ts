import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { ensureProduct } from "./resolve";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RELATIONS DU PRODUIT — ce que la BASE garantit, pas ce que le code promet.
 *
 * La migration documente deux règles de suppression opposées, et la différence est un choix
 * métier, pas une préférence technique :
 *
 *   • une VENTE ne disparaît JAMAIS avec un produit — c'est une pièce comptable ;
 *   • une ligne de LIAISON (affectation, imputation) n'a aucun sens sans ses deux bouts.
 *
 * Une règle de suppression écrite en commentaire et fausse en base est pire qu'absente : on
 * s'appuie dessus sans le vérifier. Ce fichier l'exécute.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `ZZREL${Date.now()}`;
const produits: string[] = [];
const ventes: string[] = [];
/** La personne qui porte le produit est À CE BANC (un compte emprunté peut partir avec son banc, et l'affectation avec lui). */
const comptes = comptesDeBanc("__prodrel_");

suite("les relations du produit canonique", () => {
  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { id: { in: ventes } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: produits } } }).catch(() => {});
    await comptes.retirer();
  });

  it("supprimer un produit N'EFFACE PAS la vente — elle perd sa clé, pas sa valeur", async () => {
    const p = await ensureProduct({ dci: `${TAG}vente`, dosage: "50", dosageUnit: "mg", form: "Comprimé" });
    const vente = await prisma.sale.create({
      data: {
        product: `${TAG} désignation libre`, client: `${TAG} client`,
        quantity: 10, unitPrice: 100, revenue: 1000, productId: p!.id,
      },
      select: { id: true },
    });
    ventes.push(vente.id);

    await prisma.product.delete({ where: { id: p!.id } });

    const apres = await prisma.sale.findUnique({
      where: { id: vente.id },
      select: { id: true, productId: true, revenue: true, product: true },
    });
    // La vente SURVIT, avec son chiffre d'affaires et sa désignation d'origine.
    expect(apres).not.toBeNull();
    expect(apres!.productId).toBeNull();
    expect(Number(apres!.revenue)).toBe(1000);
    expect(apres!.product).toBe(`${TAG} désignation libre`);
  });

  it("supprimer un produit EMPORTE ses lignes de liaison — une imputation orpheline ne veut rien dire", async () => {
    const p = await ensureProduct({ dci: `${TAG}liaison`, dosage: "5", dosageUnit: "mg", form: "Gélule" });
    const user = await comptes.creer("liaison");

    const aff = await prisma.productAssignment.create({
      data: { productId: p!.id, userId: user.id, role: "DELEGATE", allocationPct: 40 },
      select: { id: true },
    });

    await prisma.product.delete({ where: { id: p!.id } });

    expect(await prisma.productAssignment.findUnique({ where: { id: aff.id } })).toBeNull();
  });

  it("la même personne peut RE-porter un produit plus tard — la date fait partie de l'unicité", async () => {
    const p = await ensureProduct({ dci: `${TAG}reprise`, dosage: "1", dosageUnit: "g", form: "Injectable" });
    produits.push(p!.id);
    const user = await comptes.creer("reprise");

    const hier = new Date("2024-01-01");
    const aujourdhui = new Date("2026-01-01");
    await prisma.productAssignment.create({
      data: { productId: p!.id, userId: user.id, startedAt: hier, endedAt: new Date("2024-12-31") },
    });
    // Sans la date dans la clé d'unicité, cette seconde affectation serait refusée — et on ne
    // pourrait pas rendre un produit à quelqu'un qui l'a déjà porté.
    await prisma.productAssignment.create({
      data: { productId: p!.id, userId: user.id, startedAt: aujourdhui },
    });

    const n = await prisma.productAssignment.count({ where: { productId: p!.id } });
    expect(n).toBe(2);
  });

  it("un produit se lit avec toutes ses traversées en UNE requête", async () => {
    const p = await ensureProduct({ dci: `${TAG}lecture`, dosage: "20", dosageUnit: "mg", form: "Comprimé" });
    produits.push(p!.id);

    // C'est la forme dont Product 360 a besoin : le produit et ses bouts, sans N+1.
    const lu = await prisma.product.findUnique({
      where: { id: p!.id },
      include: {
        regulatoryProfiles: true, promoProfiles: true, bdProfiles: true,
        tenderLines: true, sales: true, visitLinks: true,
        adProAllocations: true, assignments: true, aliases: true,
      },
    });
    expect(lu).not.toBeNull();
    expect(lu!.sales).toEqual([]);
    expect(lu!.tenderLines).toEqual([]);
  });
});
