import { describe, it, expect } from "vitest";
import {
  circuitOf, circuitOfKind, circuitOfDeclaration, usesPaymentSlips, usesDeclareDecision,
  splitByCircuit, isDeclarationKind, EVENT_SOURCES, PROMO_SOURCES,
  CIRCUIT_LABEL, DECLARATION_KIND_LABEL, DECLARATION_KINDS,
  OPENABLE_DECLARATION_KINDS, isOpenableDeclarationKind,
} from "./circuits";

describe("deux circuits, et la nature décide", () => {
  it("LE MATÉRIEL PROMOTIONNEL EST LE SEUL À VERSER", () => {
    // C'est tout le chantier : le bon de versement s'appliquait à tout, y compris aux dossiers
    // qui n'en doivent aucun — et l'on sortait chacun d'eux par la porte « sans versement ».
    expect(circuitOf("PROMO_MATERIAL")).toBe("PROMO");
    expect(usesPaymentSlips("PROMO_MATERIAL")).toBe(true);
    for (const s of EVENT_SOURCES) {
      expect(circuitOf(s), s).toBe("EVENT");
      expect(usesPaymentSlips(s), s).toBe(false);
      expect(usesDeclareDecision(s), s).toBe(true);
    }
  });

  it("les quatre natures d'événement sont NOMMÉES — prise en charge nationale, internationale, événement, sponsoring", () => {
    expect([...EVENT_SOURCES].sort()).toEqual(
      ["CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "SPONSORING"],
    );
    expect(PROMO_SOURCES).toEqual(["PROMO_MATERIAL"]);
  });

  it("UNE NATURE INCONNUE VA VERS LA DÉCISION, PAS VERS LA DÉPENSE", () => {
    // Le doute doit mener vers le circuit qui demande à un humain, jamais vers celui qui engage
    // de l'argent : un type ajouté demain ne doit pas réclamer une taxe de lui-même.
    expect(circuitOf("QUELQUE_CHOSE_DE_NEUF")).toBe("EVENT");
    expect(usesPaymentSlips("QUELQUE_CHOSE_DE_NEUF")).toBe(false);
  });
});

describe("ce que le PRIM ouvre lui-même", () => {
  it("la nature choisie décide du circuit", () => {
    expect(circuitOfKind("MIP")).toBe("EVENT");
    expect(circuitOfKind("AD_VISA")).toBe("PROMO");
    expect(circuitOfKind("PAYMENT_SLIP")).toBe("PROMO");
  });

  it("LA NATURE CHOISIE L'EMPORTE SUR LA SOURCE", () => {
    // Un dossier ouvert par le pharmacien n'a pas d'événement derrière lui : sa « source » ne
    // décrit rien du chemin. Ce qu'il a choisi, si.
    expect(circuitOfDeclaration({ sourceType: "MEDICAL_INFO_DECLARATION", declarationKind: "AD_VISA" })).toBe("PROMO");
    expect(circuitOfDeclaration({ sourceType: "MEDICAL_INFO_DECLARATION", declarationKind: "MIP" })).toBe("EVENT");
  });

  it("sans nature choisie, la source décide — et il n'existe aucun geste pour la contredire", () => {
    expect(circuitOfDeclaration({ sourceType: "SPONSORING", declarationKind: null })).toBe("EVENT");
    expect(circuitOfDeclaration({ sourceType: "PROMO_MATERIAL" })).toBe("PROMO");
    // Une valeur aberrante en base ne détourne pas le circuit : elle est ignorée.
    expect(circuitOfDeclaration({ sourceType: "PROMO_MATERIAL", declarationKind: "N'IMPORTE QUOI" })).toBe("PROMO");
  });

  it("les trois natures proposées sont reconnues, et rien d'autre", () => {
    for (const k of DECLARATION_KINDS) expect(isDeclarationKind(k)).toBe(true);
    expect(isDeclarationKind("BV")).toBe(false);
    expect(isDeclarationKind(null)).toBe(false);
    expect(DECLARATION_KIND_LABEL.MIP).toMatch(/ANPP/);
  });
});

describe("splitByCircuit — la liste se lit en deux familles", () => {
  const rows = [
    { id: "a", sourceType: "SPONSORING" },
    { id: "b", sourceType: "PROMO_MATERIAL" },
    { id: "c", sourceType: "CONGRESS_INTERNATIONAL" },
    { id: "d", sourceType: "MEDICAL_INFO_DECLARATION", declarationKind: "PAYMENT_SLIP" },
  ];

  it("range chaque dossier dans SA famille", () => {
    const out = splitByCircuit(rows);
    expect(out.EVENT.map((r) => r.id)).toEqual(["a", "c"]);
    expect(out.PROMO.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("PRÉSERVE L'ORDRE reçu — la liste est déjà triée quand elle arrive", () => {
    const out = splitByCircuit([...rows].reverse());
    expect(out.EVENT.map((r) => r.id)).toEqual(["c", "a"]);
  });

  it("rend toujours les deux familles, même vides : un onglet absent fait chercher la panne", () => {
    const out = splitByCircuit([]);
    expect(out.EVENT).toEqual([]);
    expect(out.PROMO).toEqual([]);
    expect(CIRCUIT_LABEL.EVENT).toMatch(/prises en charge/i);
    expect(CIRCUIT_LABEL.PROMO).toMatch(/matériel/i);
  });
});

describe("ce que le PRIM peut OUVRIR — deux natures, plus trois", () => {
  it("UN DOSSIER S'OUVRE EN MIP OU EN DEMANDE DE VISA, et rien d'autre", () => {
    // « Bon de versement » était une confusion de niveau : ce n'est pas ce qu'on ouvre, c'est
    // une ÉTAPE du circuit du matériel. Le proposer faisait choisir entre un dossier et l'une
    // de ses propres pièces.
    expect(OPENABLE_DECLARATION_KINDS).toEqual(["MIP", "AD_VISA"]);
    expect(isOpenableDeclarationKind("PAYMENT_SLIP")).toBe(false);
    expect(isOpenableDeclarationKind("AD_VISA")).toBe(true);
  });

  it("MAIS LA NATURE RESTE RECONNUE EN LECTURE — un dossier historique garde SON circuit", () => {
    // La retirer des natures connues ferait retomber un dossier repris sur le circuit par
    // défaut (ÉVÉNEMENT), c'est-à-dire lui faire perdre ses bons de versement en route.
    expect(isDeclarationKind("PAYMENT_SLIP")).toBe(true);
    expect(DECLARATION_KINDS).toContain("PAYMENT_SLIP");
  });

  it("et le reclassement en visa ne change PAS de circuit — c'est ce qui le rend sûr", () => {
    const avant = { sourceType: "MEDICAL_INFO_DECLARATION", declarationKind: "PAYMENT_SLIP" };
    const apres = { sourceType: "MEDICAL_INFO_DECLARATION", declarationKind: "AD_VISA" };
    expect(splitByCircuit([avant]).PROMO).toHaveLength(1);
    expect(splitByCircuit([apres]).PROMO).toHaveLength(1);
  });
});
