import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { ensureProduct } from "@/lib/products/resolve";
import { voisinage, voisinageMarche, voisinagePersonne, voisinageProduit } from "./graph";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRAVERSÉE — ce qui la distingue d'une recherche.
 *
 * Une recherche textuelle rend ce qui RESSEMBLE ; une traversée rend ce qui EST RATTACHÉ. La
 * différence ne se voit pas sur un cas qui marche : elle se voit sur les deux cas limites que
 * ces tests figent —
 *
 *   • un voisin qui EXISTE mais n'est pas rattaché ne remonte PAS (et le graphe le dit) ;
 *   • une arête vide n'est pas rendue du tout, plutôt que rendue à zéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `ZZGRF${Date.now()}`;
const produits: string[] = [];
const marches: string[] = [];
/**
 * La personne est À CE BANC. Empruntée, c'était souvent un compte chargé d'affectations (les exemples rendus sont bornés :
 * celle du banc pouvait ne pas y figurer), ou celui d'un voisin qui le retire en cours de route.
 */
const comptes = comptesDeBanc("__graphe_");

suite("le graphe d'entreprise", () => {
  afterAll(async () => {
    await prisma.sale.deleteMany({ where: { client: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { id: { in: marches } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: produits } } }).catch(() => {});
    await comptes.retirer();
  });

  it("rend les arêtes RÉELLES, et n'invente rien", async () => {
    const p = await ensureProduct({ dci: `${TAG}graf`, dosage: "10", dosageUnit: "mg", form: "Comprimé" });
    produits.push(p!.id);

    // DEUX ventes : l'une RATTACHÉE au produit, l'autre portant le MÊME libellé texte sans
    // rattachement. C'est tout l'enjeu : une recherche textuelle les remonterait toutes les
    // deux, la traversée n'en voit qu'une — la vraie.
    await prisma.sale.create({
      data: { product: `${TAG}graf`, client: `${TAG}rattachee`, quantity: 1, unitPrice: 100, revenue: 100, productId: p!.id },
    });
    await prisma.sale.create({
      data: { product: `${TAG}graf`, client: `${TAG}orpheline`, quantity: 1, unitPrice: 999, revenue: 999 },
    });

    const v = await voisinageProduit(p!.id);
    const ventes = v!.aretes.find((a) => a.relation === "vente")!;
    expect(ventes.nombre).toBe(1);
    expect(ventes.exemples[0].libelle).toContain(`${TAG}rattachee`);
    // La vente orpheline n'est PAS là — et l'absence est expliquée plutôt que subie.
    expect(JSON.stringify(v!.aretes)).not.toContain("orpheline");
    expect(v!.horsGraphe.join(" ")).toMatch(/libellé libre|rattach/i);
  });

  it("une arête VIDE n'est pas rendue à zéro — elle n'est pas rendue", async () => {
    const p = await ensureProduct({ dci: `${TAG}seul`, dosage: "5", dosageUnit: "mg", form: "Gélule" });
    produits.push(p!.id);

    const v = await voisinageProduit(p!.id);
    expect(v!.aretes).toEqual([]);
    expect(v!.totalVoisins).toBe(0);
    // Un tableau de neuf zéros n'apprend rien et occupe le contexte du modèle pour rien.
    expect(JSON.stringify(v)).not.toContain('"nombre":0');
  });

  it("le marché rend sa chaîne, et COMPTE ce qui n'est pas rapproché", async () => {
    const p = await ensureProduct({ dci: `${TAG}mrc`, dosage: "1", dosageUnit: "g", form: "Injectable" });
    produits.push(p!.id);

    const t = await prisma.pchTender.create({
      data: {
        reference: `${TAG}-AO`, status: "IN_PROGRESS",
        lines: {
          create: [
            { designation: `${TAG} rattachée`, status: "WON", quantityUnits: 10, productId: p!.id },
            { designation: `${TAG} orpheline`, status: "PENDING", quantityUnits: 10 },
          ],
        },
        orders: { create: [{ reference: `${TAG}-B`, quantity: 5, value: 500, status: "PENDING" }] },
      },
      select: { id: true },
    });
    marches.push(t.id);

    const v = await voisinageMarche(t.id);
    expect(v!.aretes.find((a) => a.relation === "ligne")!.nombre).toBe(2);
    expect(v!.aretes.find((a) => a.relation === "produit canonique rattaché")!.nombre).toBe(1);
    // Le manque est CHIFFRÉ : « 1 ligne sans produit canonique ». Sans cela, on croirait le
    // marché entièrement traversable depuis les produits.
    expect(v!.horsGraphe.join(" ")).toContain("1 ligne(s) sans produit canonique");
  });

  it("une personne : « porte » et « a porté » ne se confondent pas", async () => {
    const p = await ensureProduct({ dci: `${TAG}pers`, dosage: "2", dosageUnit: "mg", form: "Comprimé" });
    produits.push(p!.id);
    const u = await comptes.creer("porteur");

    await prisma.productAssignment.create({
      data: {
        productId: p!.id, userId: u.id, role: "DELEGATE",
        startedAt: new Date("2024-01-01"), endedAt: new Date("2024-12-31"),
      },
    });

    const v = await voisinagePersonne(u.id);
    const porte = v!.aretes.find((a) => a.relation === "porte le produit")!;
    const ligne = porte.exemples.find((e) => e.libelle.includes(p!.code))!;
    // Relancer quelqu'un sur un produit qu'il ne porte PLUS est une erreur visible en réunion.
    expect(ligne.libelle).toContain("terminée");
  });

  it("un point d'entrée unique, et `null` sur une ancre inconnue", async () => {
    expect(await voisinage("PRODUCT", "nexistepas")).toBeNull();
    expect(await voisinage("PCH_TENDER", "nexistepas")).toBeNull();
    expect(await voisinage("USER", "nexistepas")).toBeNull();
  });
});
