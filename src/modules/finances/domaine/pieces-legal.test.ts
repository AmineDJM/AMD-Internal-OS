import { describe, expect, it } from "vitest";
import {
  aRemplir, avertissementUsage, natureAInscrireAuLegal, natureDePieceDuLegal, natureDePieceLue, pieceQuiRemplit,
  refusReutilisation, titrePourLeRegistre,
} from "./pieces-legal";

/** LES PIÈCES D'UNE DEMANDE DE PAIEMENT — choisies dans Legal, ou déposées et lues (Direction, 04/11/2026). */
const libre = { demandes: [], envoyeAuReglement: false, regle: false };

describe("les pièces d'une demande de paiement", () => {
  it("la facture remplit, sinon le BC, sinon le devis, sinon le contrat — à égalité, la première", () => {
    const devis = { nature: "QUOTE", n: "devis" };
    const bc = { nature: "PURCHASE_ORDER", n: "bc" };
    const facture = { nature: "INVOICE", n: "facture" };
    const bl = { nature: "DELIVERY_NOTE", n: "bl" };
    expect(pieceQuiRemplit([devis, bc, facture, bl])?.n).toBe("facture");
    expect(pieceQuiRemplit([devis, bc])?.n).toBe("bc");
    expect(pieceQuiRemplit([bl, devis])?.n).toBe("devis");
    expect(pieceQuiRemplit([{ nature: "QUOTE", n: "a" }, { nature: "QUOTE", n: "b" }])?.n).toBe("a");
    expect(pieceQuiRemplit([bl])).toBeNull();
  });

  it("un champ touché par la personne n'est jamais réécrit ; un champ vide proposé ne s'écrit pas", () => {
    expect(aRemplir({ title: "Facture FA-12", payee: "Atlas", amount: "142800", dueDate: " " }, new Set(["payee"])))
      .toEqual({ title: "Facture FA-12", amount: "142800" });
  });

  it("les natures : Legal → pièce, lue → pièce, et ce qui entre au registre", () => {
    expect(natureDePieceDuLegal("INVOICE")).toBe("INVOICE");
    expect(natureDePieceDuLegal("CONTRACT")).toBe("CONTRACT");
    expect(natureDePieceDuLegal("INSURANCE")).toBe("OTHER");
    expect(natureDePieceLue("DELIVERY_NOTE")).toBe("DELIVERY_NOTE");
    expect(natureDePieceLue("INSURANCE")).toBeNull();
    expect(natureDePieceLue(undefined)).toBeNull();
    expect(natureAInscrireAuLegal("INVOICE")).toBe("INVOICE");
    expect(natureAInscrireAuLegal("QUOTE")).toBe("QUOTE");
    // Un BC n'entre pas au registre par ce chemin : y naître l'enverrait à un centre de validation.
    expect(natureAInscrireAuLegal("PURCHASE_ORDER")).toBeNull();
  });

  it("une facture ne se demande qu'une fois ; un BC ou un devis déjà utilisé est signalé, pas refusé", () => {
    const dejaDemandee = { ...libre, demandes: ["PAY-2026-014"] };
    expect(avertissementUsage(dejaDemandee)).toBe("Déjà dans la demande PAY-2026-014.");
    expect(refusReutilisation("INVOICE", "Facture FA-12", dejaDemandee))
      .toBe("La facture « Facture FA-12 » ne peut pas être demandée une seconde fois : déjà dans la demande PAY-2026-014.");
    expect(refusReutilisation("INVOICE", "F", { ...libre, envoyeAuReglement: true })).toMatch(/envoyée au règlement/);
    expect(refusReutilisation("INVOICE", "F", { ...libre, regle: true })).toMatch(/déjà réglée/);
    expect(refusReutilisation("PURCHASE_ORDER", "BC 12/DG/2026", dejaDemandee)).toBeNull();
    expect(refusReutilisation("INVOICE", "F", libre)).toBeNull();
    expect(avertissementUsage(libre)).toBeNull();
  });

  it("le titre d'une pièce déposée qui entre au registre", () => {
    expect(titrePourLeRegistre({ nature: "INVOICE", reference: "FA-2026-12", beneficiaire: "Atlas", nomFichier: "x.pdf" })).toBe("Facture FA-2026-12 — Atlas");
    expect(titrePourLeRegistre({ nature: "QUOTE", reference: null, beneficiaire: null, nomFichier: "devis stand.pdf" })).toBe("Devis — devis stand");
  });
});
