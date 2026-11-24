import { describe, it, expect } from "vitest";
import {
  canonicalPair, isLinkType, linkHref, linkRank, LINK_TYPES, LINK_TYPE_LABELS,
  otherSide, pairAllowed, pairReason, targetsFor, validateLink,
} from "./graph";

describe("le flux d'une affaire — les paires autorisées, et celles qui font un détour", () => {
  it("la chaîne se relie maillon à maillon : AO → contrat → BC → facture", () => {
    expect(pairAllowed("PCH_TENDER", "LEGAL_DOCUMENT")).toBe(true);
    expect(pairAllowed("LEGAL_DOCUMENT", "PCH_ORDER")).toBe(true);
    expect(pairAllowed("PCH_ORDER", "INVOICE")).toBe(true);
  });

  it("deux pièces légales se tiennent — une assurance et le contrat qu'elle couvre", () => {
    expect(pairAllowed("LEGAL_DOCUMENT", "LEGAL_DOCUMENT")).toBe(true);
    expect(pairReason("LEGAL_DOCUMENT", "LEGAL_DOCUMENT")).toMatch(/assurance/i);
  });

  it("le COURRIER parle de tout — c'est la seule nature sans contrainte de flux", () => {
    for (const t of ["PCH_TENDER", "LEGAL_DOCUMENT", "PCH_ORDER", "INVOICE", "REGULATORY_PRODUCT"] as const) {
      expect(pairAllowed("MAIL_ENTRY", t), `courrier ↔ ${t}`).toBe(true);
    }
  });

  it("LE RACCOURCI FACTURE → MARCHÉ EST REFUSÉ, et le refus nomme le chemin", () => {
    // Le piège exact : relier au marché fait gagner trois secondes et détruit la réponse à
    // « quelle facture pour quel bon ? ».
    const r = validateLink({ type: "INVOICE", id: "f1" }, { type: "PCH_TENDER", id: "t1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/bon de commande/i);
      expect(r.error).toMatch(/s'en déduit/i);
    }
  });

  it("le BC ne se relie pas à son marché : il y appartient DÉJÀ", () => {
    const r = validateLink({ type: "PCH_ORDER", id: "o1" }, { type: "PCH_TENDER", id: "t1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/appartient déjà/i);
  });

  it("une facture ne pend pas au contrat non plus — elle passe par le bon", () => {
    const r = validateLink({ type: "INVOICE", id: "f1" }, { type: "LEGAL_DOCUMENT", id: "c1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bon de commande/i);
  });

  it("une paire hors flux est refusée en NOMMANT les deux natures", () => {
    const r = validateLink({ type: "REGULATORY_PRODUCT", id: "r1" }, { type: "INVOICE", id: "f1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/dossier regulatory/i);
      expect(r.error).toMatch(/facture/i);
    }
  });

  it("un objet ne se relie pas à lui-même, et un type inconnu est refusé", () => {
    const soi = validateLink({ type: "LEGAL_DOCUMENT", id: "x" }, { type: "LEGAL_DOCUMENT", id: "x" });
    expect(soi.ok).toBe(false);
    const inconnu = validateLink({ type: "EMPLOYEE", id: "e" }, { type: "INVOICE", id: "f" });
    expect(inconnu.ok).toBe(false);
    if (!inconnu.ok) expect(inconnu.error).toMatch(/ne participe pas/i);
  });

  it("deux pièces légales DISTINCTES passent — le refus ne visait que l'identité", () => {
    expect(validateLink({ type: "LEGAL_DOCUMENT", id: "a" }, { type: "LEGAL_DOCUMENT", id: "b" }).ok).toBe(true);
  });

  it("targetsFor donne ce à quoi CETTE nature se relie, dans l'ordre du flux", () => {
    expect(targetsFor("INVOICE")).toEqual(["PCH_ORDER", "MAIL_ENTRY"]);
    expect(targetsFor("LEGAL_DOCUMENT")).toEqual(["PCH_TENDER", "LEGAL_DOCUMENT", "PCH_ORDER", "MAIL_ENTRY"]);
    expect(targetsFor("MAIL_ENTRY")).toEqual(["PCH_TENDER", "LEGAL_DOCUMENT", "PCH_ORDER", "INVOICE", "REGULATORY_PRODUCT"]);
  });

  it("chaque nature porte un libellé, et le rang suit le flux", () => {
    for (const t of LINK_TYPES) expect(LINK_TYPE_LABELS[t].length).toBeGreaterThan(0);
    expect(linkRank("PCH_TENDER")).toBeLessThan(linkRank("LEGAL_DOCUMENT"));
    expect(linkRank("LEGAL_DOCUMENT")).toBeLessThan(linkRank("PCH_ORDER"));
    expect(linkRank("PCH_ORDER")).toBeLessThan(linkRank("INVOICE"));
    expect(isLinkType("INVOICE")).toBe(true);
    expect(isLinkType("EMPLOYEE")).toBe(false);
  });
});

describe("la paire est CANONIQUE — un seul enregistrement, lisible des deux côtés", () => {
  it("relier A à B et B à A produit EXACTEMENT le même enregistrement", () => {
    const ab = canonicalPair({ type: "PCH_ORDER", id: "o1" }, { type: "INVOICE", id: "f1" });
    const ba = canonicalPair({ type: "INVOICE", id: "f1" }, { type: "PCH_ORDER", id: "o1" });
    expect(ab).toEqual(ba);
    // Le rang du flux décide : le bon avant la facture.
    expect(ab.fromType).toBe("PCH_ORDER");
    expect(ab.toType).toBe("INVOICE");
  });

  it("à nature ÉGALE, l'identifiant tranche — sinon deux lignes pour un même fait", () => {
    const ab = canonicalPair({ type: "LEGAL_DOCUMENT", id: "b" }, { type: "LEGAL_DOCUMENT", id: "a" });
    const ba = canonicalPair({ type: "LEGAL_DOCUMENT", id: "a" }, { type: "LEGAL_DOCUMENT", id: "b" });
    expect(ab).toEqual(ba);
    expect(ab.fromId).toBe("a");
  });

  it("un lien MÈNE quelque part — et rend null plutôt qu'une URL inventée", () => {
    expect(linkHref("PCH_TENDER", "t1")).toBe("/pch/t1");
    expect(linkHref("LEGAL_DOCUMENT", "d1")).toBe("/legal/d1");
    expect(linkHref("MAIL_ENTRY", "m1")).toBe("/courriers?courrier=m1");
    expect(linkHref("REGULATORY_PRODUCT", "r1")).toBe("/regulatory/r1");
    // Le bon de commande se lit dans la fiche de SON marché : sans ce marché, pas de lien.
    expect(linkHref("PCH_ORDER", "o1", { orderTenderId: "t9" })).toBe("/pch/t9");
    expect(linkHref("PCH_ORDER", "o1")).toBeNull();
  });

  it("l'écran lit toujours L'AUTRE BOUT, quel que soit le côté d'où l'on regarde", () => {
    const lien = { fromType: "PCH_ORDER", fromId: "o1", toType: "INVOICE", toId: "f1", fromLabel: "BC 12", toLabel: "F-194" };
    expect(otherSide(lien, { type: "PCH_ORDER", id: "o1" })).toEqual({ type: "INVOICE", id: "f1", label: "F-194" });
    expect(otherSide(lien, { type: "INVOICE", id: "f1" })).toEqual({ type: "PCH_ORDER", id: "o1", label: "BC 12" });
  });
});
