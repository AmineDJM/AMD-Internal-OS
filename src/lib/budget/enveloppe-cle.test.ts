import { describe, expect, it } from "vitest";
import { choisirEnveloppe, directionDe, estCodeDirection, memeDirection, nomAvecSociete, texteCle, type CleEnveloppe } from "./enveloppe-cle";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
let n = 0;
const env = (o: Partial<{ companyId: string | null; domaine: string; module: string | null; modules: string[]; periodStart: Date; isActive: boolean; createdAt: Date; businessUnitId: string | null }> = {}) => ({
  id: `e${++n}`, companyId: "A", domaine: "GENERAL", module: null, modules: [], periodStart: d("2026-01-01"), isActive: true,
  createdAt: d("2026-02-01"), businessUnitId: null, productId: null, ...o,
});

describe("la clé d'une enveloppe — (société, direction, année), jamais le nom", () => {
  it("la direction : le domaine d'un pôle, sinon le code ou le premier module, sinon aucune (libre)", () => {
    expect(directionDe({ domaine: "OPERATIONS", module: null, modules: [] })).toBe("OPERATIONS");
    expect(directionDe({ domaine: "GENERAL", module: "ADMINISTRATION", modules: [] })).toBe("ADMINISTRATION");
    expect(directionDe({ domaine: "GENERAL", module: null, modules: ["SPONSORING", "EVENTS"] })).toBe("SPONSORING");
    expect(directionDe({ domaine: "GENERAL", module: null, modules: [] })).toBeNull();
  });

  it("les codes de direction se reconnaissent (ils se gardent quand on édite les modules)", () => {
    for (const c of ["ADMINISTRATION", "IMPOTS_TAXES", "INFORMATIQUE", "DEPARTEMENT:dep1"]) expect(estCodeDirection(c), c).toBe(true);
    for (const c of ["SPONSORING", null, ""]) expect(estCodeDirection(c), String(c)).toBe(false);
  });

  it("même direction : l'année du début, le domaine ou le code, le périmètre seulement s'il est dit", () => {
    const cle: CleEnveloppe = { companyId: "A", annee: 2026, direction: "ADMINISTRATION" };
    expect(memeDirection(env({ module: "ADMINISTRATION" }), cle)).toBe(true);
    expect(memeDirection(env({ module: "ADMINISTRATION", periodStart: d("2027-01-01") }), cle)).toBe(false);
    expect(memeDirection(env({ module: null, modules: ["ADMINISTRATION"] }), cle)).toBe(true);
    expect(memeDirection(env({ domaine: "OPERATIONS", module: "ADMINISTRATION" }), cle)).toBe(false);
    const ops: CleEnveloppe = { companyId: "A", annee: 2026, direction: "OPERATIONS" };
    expect(memeDirection(env({ domaine: "OPERATIONS", businessUnitId: "bu1" }), ops)).toBe(true);
    expect(memeDirection(env({ domaine: "OPERATIONS", businessUnitId: "bu1" }), { ...ops, businessUnitId: null })).toBe(false);
    expect(memeDirection(env({ module: "ADMINISTRATION" }), { ...cle, direction: null })).toBe(false); // libre : jamais dédoublonnée
  });

  it("choisit la société d'abord, puis le groupe ; l'active, puis la plus ancienne", () => {
    const cle: CleEnveloppe = { companyId: "A", annee: 2026, direction: "ADMINISTRATION" };
    const groupe = env({ companyId: null, module: "ADMINISTRATION" });
    const ancienne = env({ module: "ADMINISTRATION", createdAt: d("2026-01-02") });
    const recente = env({ module: "ADMINISTRATION", createdAt: d("2026-06-01") });
    const inactive = env({ module: "ADMINISTRATION", createdAt: d("2025-12-01"), isActive: false });
    expect(choisirEnveloppe([groupe, recente, inactive, ancienne], cle)?.id).toBe(ancienne.id);
    expect(choisirEnveloppe([groupe, env({ companyId: "B", module: "ADMINISTRATION" })], cle)?.id).toBe(groupe.id);
    expect(choisirEnveloppe([env({ companyId: "B", module: "ADMINISTRATION" })], cle)).toBeNull();
  });

  it("LA RÈGLE DU DOUBLON : une clé sans société adopte l'UNIQUE enveloppe de société — jamais quand il y en a deux", () => {
    const cle: CleEnveloppe = { companyId: null, annee: 2026, direction: "OPERATIONS" };
    const adv = env({ companyId: "A", domaine: "OPERATIONS" });
    expect(choisirEnveloppe([adv], cle)?.id).toBe(adv.id);
    expect(choisirEnveloppe([adv, env({ companyId: "B", domaine: "OPERATIONS" })], cle)).toBeNull();
    const groupe = env({ companyId: null, domaine: "OPERATIONS" });
    expect(choisirEnveloppe([adv, groupe], cle)?.id).toBe(groupe.id);
  });

  it("le texte de la clé (verrou, messages) et le nom avec sa société", () => {
    expect(texteCle({ companyId: null, annee: 2026, direction: "OPERATIONS" })).toBe("groupe:OPERATIONS:2026");
    expect(texteCle({ companyId: "A", annee: 2026, direction: "MARKETING", businessUnitId: null, productId: "p" })).toBe("A:MARKETING:2026:-:p");
    expect(nomAvecSociete("Informatique 2026", "Pharmagène")).toBe("Informatique 2026 · Pharmagène");
    expect(nomAvecSociete("Informatique 2026", null)).toBe("Informatique 2026");
  });
});
