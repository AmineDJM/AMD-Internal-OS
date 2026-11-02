import { describe, it, expect } from "vitest";
import { sourceDeLaCle } from "@/lib/actions/parc";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ETIQUETTE_BROUILLON, brouillonNeuf, brouillonPerime, lignesEffectives, lireBrouillon, peutValiderLeBrouillon, signatureDesLignes, totalHtDesLignes,
} from "@/lib/bons-de-commande/brouillon";
import { formaterNumero } from "@/lib/artifact/factory/commercial";

/** L'aperçu du BC à valider par le demandeur (Direction, 10/2026) : le brouillon n'a aucun numéro, et seul le demandeur valide. */
const lignes = [
  { designation: "Déjeuner Lunch Box", unite: "NJ", quantite: 100, prixUnitaire: 3000 },
  { designation: "Pause café", unite: "NJ", quantite: 100, prixUnitaire: 1000 },
];

describe("le brouillon du bon de commande", () => {
  it("naît sans rien de corrigé et ne porte AUCUN numéro (le numéro n'est attribué qu'à la validation)", () => {
    const b = brouillonNeuf({ itemId: "p1", par: "u1", parNom: "Kam", maintenant: new Date("2026-10-08T10:00:00Z") });
    expect(b).toMatchObject({ itemId: "p1", par: "u1", lignes: null, objet: null, livraison: null, tiers: null });
    expect(Object.keys(b)).not.toContain("numero");
    expect(ETIQUETTE_BROUILLON).toBe("Brouillon — à vérifier par le demandeur");
  });

  it("se relit depuis son JSON ; un JSON illisible n'est PAS un brouillon", () => {
    const b = { ...brouillonNeuf({ itemId: "p1", par: "u1", parNom: null }), objet: "Traiteur", livraison: { adresse: "Park Mall Center", date: "2026-10-20", delai: null }, modePaiement: "VIREMENT" };
    expect(lireBrouillon(JSON.parse(JSON.stringify(b)))).toMatchObject({ objet: "Traiteur", livraison: { adresse: "Park Mall Center", date: "2026-10-20" }, modePaiement: "VIREMENT" });
    for (const mauvais of [null, undefined, "x", [], {}, { itemId: "p1" }]) expect(lireBrouillon(mauvais)).toBeNull();
    expect(lireBrouillon({ ...b, modePaiement: "BITCOIN" })?.modePaiement).toBeNull();
  });

  it("les lignes corrigées remplacent celles du devis ; sans correction, ce sont celles du devis", () => {
    const b = brouillonNeuf({ itemId: "p1", par: "u1", parNom: null });
    expect(lignesEffectives(b, lignes)).toEqual(lignes);
    expect(lignesEffectives({ ...b, lignes: [{ designation: "Pause café", quantite: 80, prixUnitaire: 1000 }] }, lignes)).toHaveLength(1);
    expect(totalHtDesLignes(lignes)).toBe(400_000);
  });

  it("des lignes corrigées sont PÉRIMÉES quand les lignes validées du devis ont bougé depuis", () => {
    const corrige = { ...brouillonNeuf({ itemId: "p1", par: "u1", parNom: null }), lignes: [lignes[0]], signature: signatureDesLignes(lignes) };
    expect(brouillonPerime(corrige, lignes)).toBe(false);
    expect(brouillonPerime(corrige, [...lignes, { designation: "Boissons", quantite: 1, prixUnitaire: 10 }])).toBe(true);
    // Sans correction, le brouillon suit le devis : il ne se périme pas.
    expect(brouillonPerime(brouillonNeuf({ itemId: "p1", par: "u1", parNom: null }), [lignes[0]])).toBe(false);
  });

  it("seul le demandeur de la demande, ou le Super Admin, valide — pas l'assistante qui a préparé, pas la Direction", () => {
    expect(peutValiderLeBrouillon({ userId: "u1", role: "MEDICAL_DELEGATE", demandeurId: "u1" })).toBe(true);
    expect(peutValiderLeBrouillon({ userId: "u2", role: "DIRECTION_ASSISTANT", demandeurId: "u1" })).toBe(false);
    expect(peutValiderLeBrouillon({ userId: "u3", role: "DIRECTION", demandeurId: "u1" })).toBe(false);
    expect(peutValiderLeBrouillon({ userId: "u4", role: "SUPER_ADMIN", demandeurId: "u1" })).toBe(true);
    expect(peutValiderLeBrouillon({ userId: "u5", role: "MEDICAL_DELEGATE", demandeurId: null })).toBe(false);
  });
});

describe("la numérotation NNN/DG/AAAA — prochain BC 037/DG/2026", () => {
  it("le motif {n:3}/DG/{aaaa} rend 037/DG/2026, sur trois chiffres, et 2027 repart à 001", () => {
    expect(formaterNumero("BC", 2026, 37, "{n:3}/DG/{aaaa}")).toBe("037/DG/2026");
    expect(formaterNumero("BC", 2026, 38, "{n:3}/DG/{aaaa}")).toBe("038/DG/2026");
    expect(formaterNumero("BC", 2027, 1, "{n:3}/DG/{aaaa}")).toBe("001/DG/2027");
  });

  it("le départ est une DONNÉE (migration), jamais une constante du code : 37 en 2026, un compteur levé à 36, rien qui recule", () => {
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20270117130500_bc_numerotation/migration.sql"), "utf8");
    expect(sql.charCodeAt(0), "pas de BOM").not.toBe(0xfeff);
    expect(sql).toMatch(/jsonb_build_object\('2026', 37\)/);
    expect(sql).toMatch(/'PURCHASE_ORDER', 2026, 36/);
    expect(sql).toMatch(/GREATEST\("DocumentSequence"\."last", 36\)/);
    expect(sql, "idempotent : on ne reprend pas un départ déjà plus haut").toMatch(/::numeric < 37/);
    const code = readFileSync(join(process.cwd(), "src/modules/ad-pro/infra/bc-devis.ts"), "utf8");
    expect(code, "aucun 37 écrit en dur dans le code de génération").not.toMatch(/\b37\b/);
  });

  it("le numéro n'est attribué qu'à la validation : générer (l'aperçu) n'appelle jamais l'émission", () => {
    const src = sourceDeLaCle("ad-pro-item-actions");
    const corps = src.slice(src.indexOf("async function traiterLeBCDuPoste"));
    const apercu = corps.slice(0, corps.indexOf("LA MARCHE DU POSTE"));
    expect(apercu).toContain('mode === "APERCU"');
    expect(apercu).not.toContain("genererLesBCsDuPoste(");
    expect(corps.indexOf("genererLesBCsDuPoste(")).toBeGreaterThan(corps.indexOf("LA MARCHE DU POSTE"));
  });
});
