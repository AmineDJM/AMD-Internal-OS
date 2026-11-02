import { describe, expect, it } from "vitest";
import { devisNonRetenus, libelleNonRetenu } from "./devis-non-retenus";
import {
  changementsDuBrouillon, changementsLus, notificationBcAVerifier, peutModifierLeBcDuPoste, REFUS_MODIFICATION_BC_POSTE,
} from "./versions-brouillon";
import { brouillonCorrige, brouillonNeuf } from "./brouillon";
import { bcDePosteAvantSignature } from "@/lib/lecteurs/legal";
import type { LigneCommerciale } from "@/lib/artifact/factory/commercial";

/**
 * ═════════════════════════════════════════════════════════════════
 * LE BC D'UN DEVIS DE POSTE — modifié dans l'application, suivi, signé, puis dans Legal (Direction, 11/2026) : les règles PURES.
 * ═════════════════════════════════════════════════════════════════
 */

const ligne = (designation: string, quantite: number, prixUnitaire: number): LigneCommerciale => ({
  designation, section: false, unite: "nuitée", details: [], quantite, prixUnitaire, remise: null, tva: null, reference: null,
});
const DEVIS = [ligne("Chambre single", 54, 14_500)];

describe("qui modifie et valide le BC d'un devis de poste", () => {
  it("la personne qui a AJOUTÉ le devis, ou le Super Admin — personne d'autre", () => {
    expect(peutModifierLeBcDuPoste({ userId: "amina", role: "DIRECTION_ASSISTANT", deposeParId: "amina" })).toBe(true);
    expect(peutModifierLeBcDuPoste({ userId: "karim", role: "PRODUCT_MANAGER", deposeParId: "amina" }), "le valideur du devis").toBe(false);
    expect(peutModifierLeBcDuPoste({ userId: "x", role: "SUPER_ADMIN", deposeParId: "amina" })).toBe(true);
    expect(peutModifierLeBcDuPoste({ userId: "x", role: "DIRECTION", secondaryRole: "SUPER_ADMIN", deposeParId: "amina" })).toBe(true);
    expect(peutModifierLeBcDuPoste({ userId: "amina", role: "DIRECTION_ASSISTANT", deposeParId: null }), "pièce d'avant la trace du déposant").toBe(false);
    expect(REFUS_MODIFICATION_BC_POSTE).toMatch(/personne qui a ajouté ce devis/);
  });

  it("la notification dit le devis, le fournisseur et ce qu'il reste à faire", () => {
    const n = notificationBcAVerifier({ devis: "DV-2026-1187", fournisseur: "Hôtel Royal Oran", poste: "Hébergement", ref: "Congrès SAC 2026" });
    expect(n.title).toBe("Bon de commande à vérifier");
    expect(n.body).toMatch(/DV-2026-1187 \(Hôtel Royal Oran\)/);
    expect(n.body).toMatch(/modifiez-le au besoin dans la plateforme, puis validez-le/);
  });
});

describe("ce qui a changé entre deux enregistrements — avant → après", () => {
  const b0 = brouillonNeuf({ itemId: "p1", par: "amina", parNom: "Amina K." });

  it("rien n'a changé : rien à inscrire", () => {
    expect(changementsDuBrouillon(b0, b0, DEVIS)).toEqual([]);
  });

  it("une ligne corrigée, un champ de la bande : chacun dit sa valeur d'avant et sa valeur d'après", () => {
    const b1 = brouillonCorrige(b0, { lignes: [ligne("Chambre single", 54, 13_900)], objet: "Hébergement SAC 2026", modePaiement: "VIREMENT" }, { lignesDuDevis: DEVIS, par: "amina" });
    const c = changementsDuBrouillon(b0, b1, DEVIS);
    expect(c).toContainEqual({ champ: "Ligne 1", avant: "Chambre single — 54 nuitée × 14 500", apres: "Chambre single — 54 nuitée × 13 900" });
    expect(c).toContainEqual({ champ: "Objet", avant: "—", apres: "Hébergement SAC 2026" });
    expect(c.find((x) => x.champ === "Mode de paiement")?.apres).toBe("VIREMENT");
  });

  it("une ligne ajoutée puis retirée se lit comme telle", () => {
    const b1 = brouillonCorrige(b0, { lignes: [...DEVIS, ligne("Salle de réunion", 3, 60_000)] }, { lignesDuDevis: DEVIS, par: "amina" });
    expect(changementsDuBrouillon(b0, b1, DEVIS)).toEqual([{ champ: "Ligne 2", avant: "—", apres: "Salle de réunion — 3 nuitée × 60 000" }]);
    expect(changementsDuBrouillon(b1, b0, DEVIS)).toEqual([{ champ: "Ligne 2", avant: "Salle de réunion — 3 nuitée × 60 000", apres: "—" }]);
  });

  it("le fournisseur corrigé se dit par son nom, jamais en objet brut", () => {
    const b1 = brouillonCorrige(b0, { tiers: { nom: "Hôtel Royal Oran SPA" } }, { lignesDuDevis: DEVIS, par: "amina" });
    expect(changementsDuBrouillon(b0, b1, DEVIS)).toEqual([{ champ: "Fournisseur", avant: "—", apres: "Hôtel Royal Oran SPA" }]);
  });

  it("relit ce qui est gardé en base, et écarte ce qui n'a pas la forme", () => {
    expect(changementsLus([{ champ: "Objet", avant: "—", apres: "X" }, { champ: 3 }, "x"])).toEqual([{ champ: "Objet", avant: "—", apres: "X" }]);
    expect(changementsLus(null)).toEqual([]);
  });
});

describe("le BC d'un poste n'entre dans Legal qu'une fois signé", () => {
  it("un BC de poste non signé est « avant signature » ; signé, ou né ailleurs, il ne l'est pas", () => {
    expect(bcDePosteAvantSignature({ kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", signedAt: null })).toBe(true);
    expect(bcDePosteAvantSignature({ kind: "PURCHASE_ORDER", sourceType: "AD_PRO_ITEM", signedAt: new Date() })).toBe(false);
    expect(bcDePosteAvantSignature({ kind: "PURCHASE_ORDER", sourceType: null, signedAt: null }), "un BC de Legal").toBe(false);
    expect(bcDePosteAvantSignature({ kind: "QUOTE", sourceType: "AD_PRO_ITEM", signedAt: null })).toBe(false);
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
