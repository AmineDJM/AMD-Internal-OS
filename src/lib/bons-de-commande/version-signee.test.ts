import { describe, expect, it } from "vitest";
import { devisNonRetenus, libelleNonRetenu, notificationBrouillonPret, refusDepotVersionSignee } from "./version-signee";
import { brouillonNeuf, brouillonExcelPerime, empreinteDuBrouillonExcel, lireBrouillon, type BrouillonExcel } from "./brouillon";
import type { LigneCommerciale } from "@/lib/artifact/factory/commercial";

/**
 * ═════════════════════════════════════════════════════════════════
 * LE BROUILLON EXCEL ET LA VERSION SIGNÉE DU BC D'UN POSTE — les règles PURES (Direction, 11/2026).
 * ═════════════════════════════════════════════════════════════════
 */

const ligne = (designation: string, quantite: number, prixUnitaire: number): LigneCommerciale => ({
  designation, section: false, unite: "nuitée", details: [], quantite, prixUnitaire, remise: null, tva: null, reference: null,
});

const TVA9 = { tvaRate: 9, extraTaxRate: null };

const WORD: BrouillonExcel = {
  documentId: "doc1", numero: "214/DG/2026", entreeRegistre: "ref1", signature: empreinteDuBrouillonExcel([ligne("Chambre single", 54, 14_500)], TVA9),
  totalTtc: 853_470, le: "2026-11-04T09:00:00.000Z", par: "u1",
};

describe("déposer la version signée — ce qui l'empêche, et dans quel ordre", () => {
  const ok = { orderStage: "DIRECTION_OK", expenseOrderId: null, excel: WORD, perime: false };

  it("visé par le centre (ou sous le seuil), brouillon à jour : le dépôt est ouvert", () => {
    expect(refusDepotVersionSignee(ok)).toBeNull();
  });

  it("le paiement déjà demandé ferme tout, avant même le brouillon", () => {
    expect(refusDepotVersionSignee({ ...ok, expenseOrderId: "eo1" })).toMatch(/paiement de ce poste est déjà demandé/);
    expect(refusDepotVersionSignee({ ...ok, orderStage: "ISSUED", excel: null })).toMatch(/paiement/);
  });

  it("sans brouillon, ou avec un brouillon périmé, le refus dit quoi faire", () => {
    expect(refusDepotVersionSignee({ ...ok, excel: null })).toMatch(/validez d'abord ses lignes/);
    expect(refusDepotVersionSignee({ ...ok, perime: true })).toMatch(/214\/DG\/2026/);
  });

  it("le centre de validation Ad & Pro n'a pas encore visé : on attend son visa ; refusé : on ne dépose pas", () => {
    expect(refusDepotVersionSignee({ ...ok, orderStage: "REQUESTED" })).toMatch(/attend le visa du centre/);
    expect(refusDepotVersionSignee({ ...ok, orderStage: "REFUSED" })).toMatch(/a refusé/);
    expect(refusDepotVersionSignee({ ...ok, orderStage: "NONE" })).toMatch(/pas encore lancé/);
  });
});

describe("les devis non retenus", () => {
  it("seuls les devis qui comptent et n'ont AUCUNE ligne validée pour ce poste", () => {
    expect(devisNonRetenus([
      { pieceId: "meridien", nbValidees: 0, annule: false },
      { pieceId: "sheraton", nbValidees: 0, annule: false },
      { pieceId: "salle", nbValidees: 2, annule: false },   // un autre BC du même poste : il a servi
      { pieceId: "retire", nbValidees: 0, annule: true },   // annulé : il ne compte plus, il n'est pas « non retenu »
    ])).toEqual(["meridien", "sheraton"]);
  });

  it("le libellé dit la date et qui a validé l'offre retenue", () => {
    expect(libelleNonRetenu("2026-11-04T10:00:00.000Z", "Karim H.")).toBe("Non retenu le 04/11/2026 — offre retenue validée par Karim H.");
    expect(libelleNonRetenu(new Date("2026-11-04T10:00:00.000Z"), null)).toBe("Non retenu le 04/11/2026");
  });
});

describe("le brouillon Excel", () => {
  it("se relit depuis le JSON gardé, et un brouillon d'avant n'en a pas", () => {
    const brut = { ...brouillonNeuf({ itemId: "p1", par: "u1", parNom: "Amina K." }), excel: WORD };
    expect(lireBrouillon(JSON.parse(JSON.stringify(brut)))?.excel).toEqual(WORD);
    expect(lireBrouillon(JSON.parse(JSON.stringify(brouillonNeuf({ itemId: "p1", par: "u1", parNom: null }))))?.excel).toBeNull();
    // Un brouillon Excel mal formé (numéro absent) ne s'invente pas.
    expect(lireBrouillon({ ...brut, excel: { ...WORD, numero: "" } })?.excel).toBeNull();
  });

  it("est PÉRIMÉ quand il n'imprime plus ce que le devis valide : lignes, TVA, taxe", () => {
    expect(brouillonExcelPerime(WORD, [ligne("Chambre single", 54, 14_500)], TVA9)).toBe(false);
    expect(brouillonExcelPerime(WORD, [ligne("Chambre single", 54, 14_500), ligne("Salle de réunion", 3, 60_000)], TVA9)).toBe(true);
    expect(brouillonExcelPerime(WORD, [ligne("Chambre single", 50, 14_500)], TVA9)).toBe(true);
    expect(brouillonExcelPerime(WORD, [ligne("Chambre single", 54, 14_500)], { tvaRate: 19, extraTaxRate: null }), "la TVA corrigée").toBe(true);
    expect(brouillonExcelPerime(WORD, [ligne("Chambre single", 54, 14_500)], { tvaRate: 9, extraTaxRate: 2 }), "une taxe ajoutée").toBe(true);
  });

  it("la notification nomme le numéro, le fournisseur et ce qu'il reste à faire", () => {
    const n = notificationBrouillonPret({ numero: "214/DG/2026", fournisseur: "Hôtel Royal Oran", poste: "Hébergement", ref: "Congrès SAC 2026", misAJour: false });
    expect(n.title).toBe("Brouillon du bon de commande prêt");
    expect(n.body).toMatch(/214\/DG\/2026 \(Hôtel Royal Oran\)/);
    expect(n.body).toMatch(/déposez la version finale/);
    expect(notificationBrouillonPret({ numero: "214/DG/2026", fournisseur: null, poste: "Hébergement", ref: "X", misAJour: true }).title).toMatch(/mis à jour/);
  });
});
