import { describe, expect, it } from "vitest";
import { moduleDeLaCategorie, refusCategoriePourDemande, type CategoriePourControle, type DemandePourControle } from "@/lib/ad-pro/categorie-budgetaire";

/**
 * LA CATÉGORIE BUDGÉTAIRE CONVIENT À LA DEMANDE (point 9, 27/10) — nature, exercice, Business Unit.
 */

const enveloppe = (p: Partial<CategoriePourControle["enveloppe"]> = {}): CategoriePourControle["enveloppe"] => ({
  nom: "Ad & Pro 2026", isActive: true, modules: ["SPONSORING", "EVENTS", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER"],
  module: null, periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2026-12-31T00:00:00Z"), businessUnitId: null, ...p,
});
const categorie = (p: Partial<CategoriePourControle> = {}): CategoriePourControle => ({
  nom: "Événements", module: "EVENTS", businessUnitId: null, ancetres: [], enveloppe: enveloppe(), ...p,
});
const demande = (p: Partial<DemandePourControle> = {}): DemandePourControle => ({
  nature: "CONGRESS_NATIONAL", date: new Date("2026-10-27T10:00:00Z"), businessUnitId: null, ...p,
});

describe("la nature de la demande", () => {
  it("« Événements » sur une PEC nationale est REFUSÉE, et le refus dit quoi choisir", () => {
    const r = refusCategoriePourDemande(categorie(), demande());
    expect(r).toMatch(/réservée aux dépenses « Événements »/);
    expect(r).toMatch(/prise en charge nationale/);
    expect(r).toMatch(/Prises en charge nationales/);
  });

  it("chaque nature passe sur sa catégorie", () => {
    const cas: [DemandePourControle["nature"], string][] = [
      ["SPONSORING", "SPONSORING"], ["CONGRESS_NATIONAL", "CONGRESS_NATIONAL"], ["CONGRESS_INTERNATIONAL", "CONGRESS_INTERNATIONAL"],
      ["EVENT", "EVENTS"], ["AD_PRO_OTHER", "AD_PRO_OTHER"], ["PROMO_MATERIAL", "PROMO_MATERIAL"],
    ];
    for (const [nature, module] of cas) expect(refusCategoriePourDemande(categorie({ module }), demande({ nature })), nature).toBeNull();
  });

  it("une PEC internationale ne pèse pas sur la catégorie des PEC nationales", () => {
    expect(refusCategoriePourDemande(categorie({ nom: "Congrès nationaux", module: "CONGRESS_NATIONAL" }), demande({ nature: "CONGRESS_INTERNATIONAL" }))).not.toBeNull();
  });

  it("une sous-catégorie sans module hérite de la nature de sa parente", () => {
    const sous = categorie({ nom: "Table ronde", module: null, ancetres: [{ nom: "Événements", module: "EVENTS", businessUnitId: null }] });
    expect(moduleDeLaCategorie(sous)).toBe("EVENTS");
    expect(refusCategoriePourDemande(sous, demande({ nature: "EVENT" }))).toBeNull();
    expect(refusCategoriePourDemande(sous, demande({ nature: "SPONSORING" }))).not.toBeNull();
  });

  it("sans module sur la catégorie, les modules de l'enveloppe décident", () => {
    const libre = categorie({ nom: "Divers", module: null, enveloppe: enveloppe({ nom: "Regulatory", modules: ["REGULATORY"] }) });
    expect(refusCategoriePourDemande(libre, demande())).toMatch(/ne couvre pas les dépenses « Prises en charge nationales »/);
    expect(refusCategoriePourDemande(categorie({ module: null, enveloppe: enveloppe({ modules: ["CONGRESS_NATIONAL"] }) }), demande())).toBeNull();
    // Le module principal (déprécié) compte aussi.
    expect(refusCategoriePourDemande(categorie({ module: null, enveloppe: enveloppe({ modules: [], module: "EVENTS" }) }), demande())).not.toBeNull();
  });

  it("une catégorie et une enveloppe qui ne disent AUCUNE nature ne contredisent rien", () => {
    expect(refusCategoriePourDemande(categorie({ module: null, enveloppe: enveloppe({ modules: [] }) }), demande())).toBeNull();
  });
});

describe("l'exercice de la demande", () => {
  const cat = categorie({ module: "CONGRESS_NATIONAL" });
  it("une demande de 2027 ne pèse pas sur l'enveloppe 2026", () => {
    expect(refusCategoriePourDemande(cat, demande({ date: new Date("2027-01-03T09:00:00Z") }))).toMatch(/exercice du 01\/01\/2026 au 31\/12\/2026/);
  });
  it("les bornes comptent au jour près (le 31/12 à 18 h est dans l'exercice)", () => {
    expect(refusCategoriePourDemande(cat, demande({ date: new Date("2026-12-31T18:00:00Z") }))).toBeNull();
    expect(refusCategoriePourDemande(cat, demande({ date: new Date("2026-01-01T00:00:00Z") }))).toBeNull();
    expect(refusCategoriePourDemande(cat, demande({ date: new Date("2025-12-31T23:00:00Z") }))).not.toBeNull();
  });
  it("une enveloppe désactivée ne reçoit plus rien", () => {
    expect(refusCategoriePourDemande(categorie({ module: "CONGRESS_NATIONAL", enveloppe: enveloppe({ isActive: false }) }), demande())).toMatch(/désactivée/);
  });
});

describe("la Business Unit du demandeur, quand elle est connue", () => {
  const cat = (p: Partial<CategoriePourControle> = {}) => categorie({ module: "CONGRESS_NATIONAL", ...p });
  it("une enveloppe d'une autre gamme est refusée ; la sienne passe", () => {
    const env = enveloppe({ businessUnitId: "bu-onco" });
    expect(refusCategoriePourDemande(cat({ enveloppe: env }), demande({ businessUnitId: "bu-cardio" }))).toMatch(/autre Business Unit/);
    expect(refusCategoriePourDemande(cat({ enveloppe: env }), demande({ businessUnitId: "bu-onco" }))).toBeNull();
  });
  it("une (sous-)catégorie rattachée à une autre gamme est refusée, même dans une enveloppe commune", () => {
    expect(refusCategoriePourDemande(cat({ businessUnitId: "bu-onco" }), demande({ businessUnitId: "bu-cardio" }))).not.toBeNull();
    expect(refusCategoriePourDemande(cat({ module: null, ancetres: [{ nom: "PEC", module: "CONGRESS_NATIONAL", businessUnitId: "bu-onco" }] }), demande({ businessUnitId: "bu-cardio" }))).not.toBeNull();
  });
  it("sans BU connue, ou sur une enveloppe commune, rien n'est refusé pour la gamme", () => {
    expect(refusCategoriePourDemande(cat({ enveloppe: enveloppe({ businessUnitId: "bu-onco" }) }), demande({ businessUnitId: null }))).toBeNull();
    expect(refusCategoriePourDemande(cat(), demande({ businessUnitId: "bu-cardio" }))).toBeNull();
  });
});

describe("les points d'appel — partout où une catégorie est choisie pour une dépense Ad & Pro", () => {
  const appels: [fichier: string, n: number][] = [
    ["src/lib/actions/ad-pro-item-actions.ts", 2], // accorder un poste, changer son budget
    ["src/lib/actions/budget-depense-poste-actions.ts", 1], // imputer / changer le budget d'une dépense de poste
    ["src/lib/actions/congress-request-actions.ts", 1], // validation définitive d'une PEC (ancien parcours)
    ["src/lib/actions/promo-budget-actions.ts", 1], // imputer un matériel promotionnel
  ];
  for (const [fichier, n] of appels) {
    it(`${fichier} appelle la règle (${n}×)`, async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(fichier, "utf8");
      expect((src.match(/refusCategoriePourLaDemande\(/g) ?? []).length).toBe(n);
    });
  }
});
