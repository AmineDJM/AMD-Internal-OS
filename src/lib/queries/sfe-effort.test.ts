import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Hors requête, `cookies()` lève : la sélection d'en-tête vaut « toutes les entités ouvertes ».
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { chargerEffortVentes } from "@/lib/queries/sfe-effort";
import type { RepScope } from "@/lib/sfe";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHIFFRE D'AFFAIRES DU PILOTAGE SE LIT À LA MAILLE D'UNE BU OU DE LA DIRECTION
 * (§118.184 — audit 360°, S14).
 *
 * Mesuré par l'audit : `/planning/pilotage` lisait les ventes du mois SANS FILTRE — un délégué, qui n'a
 * du module que la lecture et la portée « lui-même », voyait le chiffre d'affaires de tous les produits
 * de toutes les sociétés. Joué sur de vraies lignes : deux sociétés, deux produits dont un seul est au
 * portefeuille de la gamme supervisée, et un lecteur rattaché à UNE société (sans vue globale).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = "__sfeeff__";
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("effort × ventes — qui lit le chiffre d'affaires", () => {
  let A = "", B = "", lecteur = "", rep = "", bu = "", p1 = "", p2 = "";
  const debut = new Date("2026-09-01T00:00:00Z");
  const fin = new Date("2026-10-01T00:00:00Z");

  async function nettoyer() {
    const prods = await prisma.product.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
    const ids = prods.map((x) => x.id);
    await prisma.medicalVisitProduct.deleteMany({ where: { productId: { in: ids } } }).catch(() => {});
    await prisma.medicalVisit.deleteMany({ where: { objective: TAG } }).catch(() => {});
    await prisma.sale.deleteMany({ where: { client: TAG } }).catch(() => {});
    await prisma.promoProduct.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    [A, B] = (await Promise.all(["Alpha", "Beta"].map((n) => prisma.company.create({ data: { name: `${TAG}${n}` } })))).map((c) => c.id);
    lecteur = (await prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lecteur@t.dz`, role: "VIEWER", passwordHash: "x" } })).id;
    await prisma.employee.create({ data: { fullName: `${TAG}lecteur`, companyId: A, userId: lecteur } });
    rep = (await prisma.user.create({ data: { name: `${TAG}rep`, email: `${TAG}rep@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    bu = (await prisma.businessUnit.create({ data: { name: `${TAG}Oncologie` } })).id;
    const prod = (k: string) => prisma.product.create({ data: { code: `${TAG}${k}`, canonicalName: `${TAG}${k}`, dci: `${TAG}${k}`, identityKey: `${TAG}${k}` } });
    p1 = (await prod("P1")).id;
    p2 = (await prod("P2")).id;
    await prisma.promoProduct.create({ data: { name: `${TAG}P1`, businessUnitId: bu, productId: p1 } });
    const vente = (productId: string, companyId: string, revenue: number) =>
      prisma.sale.create({ data: { product: TAG, client: TAG, productId, companyId, revenue, date: new Date("2026-09-15T10:00:00Z") } });
    await vente(p1, A, 1000);
    await vente(p1, B, 5000);
    await vente(p2, A, 700);
    const visite = await prisma.medicalVisit.create({ data: { date: new Date("2026-09-10T09:00:00Z"), status: "COMPLETED", delegateId: rep, objective: TAG } });
    await prisma.medicalVisitProduct.create({ data: { visitId: visite.id, productId: p1 } });
  });

  afterAll(async () => { await nettoyer(); });

  const portee = (mode: RepScope["mode"], buIds: string[] = []): RepScope =>
    ({ mode, canConfigure: mode === "all", isSupervisor: mode === "team", buIds, repIds: mode === "all" ? null : [rep] }) as RepScope;
  const ca = (lignes: { productId: string; revenue: number }[], id: string) => lignes.find((l) => l.productId === id)?.revenue;

  it("LE DÉLÉGUÉ ne lit aucun chiffre d'affaires — le tableau n'a pas d'effet à lui montrer", async () => {
    expect(await chargerEffortVentes(lecteur, portee("self"), [rep], debut, fin)).toEqual({ lisible: false, lignes: [] });
  });

  it("LA DIRECTION lit tous les produits — mais seulement dans les sociétés qu'elle voit", async () => {
    const r = await chargerEffortVentes(lecteur, portee("all"), [rep], debut, fin);
    expect(r.lisible).toBe(true);
    expect(ca(r.lignes, p1)).toBe(1000); // et non 6 000 : la vente de Beta n'est pas lue
    expect(ca(r.lignes, p2)).toBe(700);
  });

  it("LE SUPERVISEUR lit les produits de SES gammes, pas les autres", async () => {
    const r = await chargerEffortVentes(lecteur, portee("team", [bu]), [rep], debut, fin);
    expect(ca(r.lignes, p1)).toBe(1000);
    expect(ca(r.lignes, p2)).toBeUndefined();
  });

  it("POINT D'APPEL : la page lit le chargeur, ne relit plus les ventes elle-même, et masque le tableau quand rien n'est lisible", () => {
    const page = readFileSync("src/app/(app)/planning/page.tsx", "utf8");
    expect(page).toMatch(/await chargerEffortVentes\(user\.id, scope, repIds,/);
    expect(page).not.toMatch(/prisma\.sale\./);
    expect(page).toMatch(/\{ventesLisibles && effort\.length > 0 && \(/);
  });
});
