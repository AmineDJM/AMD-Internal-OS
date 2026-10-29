import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { totauxValides, refusDepassement, refusTauxDuDevis, type EnteteDevisPoste, type LigneDevisPoste } from "./devis-poste";

/**
 * « Les 76 000 DZD de TVA n'étaient pas écrits sur le document : l'IA ne doit pas deviner, juste retranscrire »
 * (Direction, 06/10). Un devis de 400 000 HT sans TVA imprimée ne devient JAMAIS un TTC de 476 000.
 */
const ligne = (id: string, q: number, pu: number): LigneDevisPoste => ({
  id, position: 0, reference: id, unit: null, quantity: q, unitPrice: pu, lue: 1, aVerifier: null, validatedItemId: "poste", bcId: null,
});
const lignes = [ligne("dejeuner", 100, 3000), ligne("pause", 100, 1000)];
const sansTva: EnteteDevisPoste = { tvaRate: null, extraTaxLabel: null, extraTaxRate: null, announcedTotal: null };
const avecTva: EnteteDevisPoste = { ...sansTva, tvaRate: 19 };

describe("la TVA se retranscrit, elle ne se devine pas", () => {
  it("sans TVA imprimée : 400 000 HT restent 400 000 — aucune taxe n'est ajoutée", () => {
    const t = totauxValides(sansTva, lignes, "poste");
    expect(t.ht).toBe(400_000);
    expect(t.tva).toBe(0);
    expect(t.ttc).toBe(400_000);
  });

  it("avec 19 % IMPRIMÉS : 476 000 TTC, comme le papier", () => {
    const t = totauxValides(avecTva, lignes, "poste");
    expect(t.ttc).toBe(476_000);
  });

  it("le dépassement d'un devis sans TVA dit que le devis n'en indique aucune (et n'invente pas de TTC)", () => {
    const r = refusDepassement(500_000, 400_000, 500_000, false)!;
    expect(r).toMatch(/500\s000,00 DZD \(aucune TVA indiquée sur le devis\)/);
    expect(r).not.toMatch(/TTC/);
    expect(refusDepassement(400_000, 400_000, 400_000, false), "400 000 pour 400 000 accordés : rien à refuser").toBeNull();
  });

  it("pas de TVA imprimée = pas de TVA : le BC se génère (aucun refus) ; un taux imprimé inexistant reste refusé", () => {
    expect(refusTauxDuDevis(null)).toBeNull();
    expect(refusTauxDuDevis(19)).toBeNull();
    expect(refusTauxDuDevis(0)).toBeNull();
    expect(refusTauxDuDevis(7)).toMatch(/n'existe pas en Algérie/);
  });
});

describe("plus aucun 19 inventé — points d'appel", () => {
  const lire = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("la lecture d'un devis de poste n'écrit pas 19 quand la TVA n'est pas lue", () => {
    const src = lire("src/lib/pieces-lues/devis-poste-lecture.ts");
    expect(src).not.toMatch(/\?\? 19/);
    expect(src).toContain("p.tvaRate != null ? new Prisma.Decimal(p.tvaRate) : null");
  });

  it("ni la vue d'un devis de poste, ni le matériel promotionnel (action, formulaire, facture) ne se replient sur 19", () => {
    for (const f of [
      "src/modules/ad-pro/infra/requetes/devis-poste.ts", "src/lib/actions/promo-devis-actions.ts",
      "src/lib/actions/promo-execution-actions.ts", "src/app/(app)/promo-material/[id]/quotes-card.tsx",
    ]) expect(lire(f), f).not.toMatch(/\?\? 19\b/);
  });

  it("le schéma ne porte plus de TVA par défaut sur les devis", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(schema).not.toMatch(/tvaRate\s+Decimal\??\s+@default\(19\)/);
  });

  it("la migration retire le défaut et n'efface aucune TVA existante", () => {
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20270113110000_tva_jamais_devinee/migration.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).toContain('ALTER TABLE "AdProDevis" ALTER COLUMN "tvaRate" DROP DEFAULT');
    expect(sql).toContain('ALTER TABLE "PromoQuote" ALTER COLUMN "tvaRate" DROP DEFAULT');
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP TABLE\b|\bDROP COLUMN\b/i);
  });
});
