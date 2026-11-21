import { describe, it, expect } from "vitest";
import { enSuppleance } from "./suppleance";
import { avertissementSuppleance, titreSignataire } from "./partage";
import { CHASSE_SCEAU, LARGEUR_TEXTE_SCEAU, lignesDuSceau } from "./incruster";

/**
 * LA SUPPLÉANCE DU SUPER ADMIN (21/11/2026) — il signe depuis son compte, et le BC le dit : jamais « Direction Marketing »
 * ou « Finances » sous le nom de quelqu'un qui ne l'est pas.
 */
describe("enSuppleance — qui signe à une place qui n'est pas la sienne", () => {
  it("le Super Admin seul est en suppléance aux deux places", () => {
    expect(enSuppleance("DIRECTION_MARKETING", { role: "SUPER_ADMIN" })).toBe(true);
    expect(enSuppleance("FINANCES", { role: "SUPER_ADMIN", secondaryRole: null })).toBe(true);
  });

  it("la Direction Marketing et les Finances signent à leur place — jamais « en suppléance »", () => {
    expect(enSuppleance("DIRECTION_MARKETING", { role: "PRODUCT_MANAGER", secondaryRole: "MEDICAL_PROMOTION_MANAGER" })).toBe(false);
    expect(enSuppleance("FINANCES", { role: "FINANCE_BUDGET_MANAGER" })).toBe(false);
  });

  it("un Super Admin qui porte aussi la fonction de la place la tient (rôle secondaire compris)", () => {
    expect(enSuppleance("DIRECTION_MARKETING", { role: "SUPER_ADMIN", secondaryRole: "PRODUCT_MANAGER" })).toBe(false);
    expect(enSuppleance("DIRECTION_MARKETING", { role: "PRODUCT_MANAGER", secondaryRole: "SUPER_ADMIN" })).toBe(false);
  });

  it("une personne qui n'est pas Super Admin n'est jamais dite « en suppléance » ; un compte inconnu non plus", () => {
    expect(enSuppleance("DIRECTION_MARKETING", { role: "MEDICAL_DELEGATE" })).toBe(false);
    expect(enSuppleance("FINANCES", null)).toBe(false);
  });
});

describe("ce que la signature dit de qui signe", () => {
  it("la place, ou le Super Admin en suppléance de la place", () => {
    expect(titreSignataire("DIRECTION_MARKETING", false)).toBe("Direction Marketing");
    expect(titreSignataire("FINANCES", false)).toBe("Finances");
    expect(titreSignataire("DIRECTION_MARKETING", true)).toBe("Super Admin, en suppléance de la Direction Marketing");
    expect(titreSignataire("FINANCES", true)).toBe("Super Admin, en suppléance des Finances");
  });

  it("le formulaire prévient AVANT : votre nom, votre signature, et la mention", () => {
    const a = avertissementSuppleance("FINANCES");
    expect(a).toMatch(/VOTRE nom, votre signature et votre cachet/);
    expect(a).toMatch(/« Super Admin, en suppléance des Finances »/);
  });
});

describe("le sceau du PDF écrit chaque ligne EN ENTIER (la fin sortait du sceau)", () => {
  const url = "https://amd-internal-os-k3uc.onrender.com/verifier-bc/Ab3dEf6hIj9kLm2nOp5qRs8t";
  const mention = ["Signé électroniquement par Djalil El Azzi", titreSignataire("DIRECTION_MARKETING", true), "le 21/11/2026 19:45"].join("\n");

  it("la mention arrive en trois lignes, l'adresse de vérification suit, rien n'est coupé", () => {
    const l = lignesDuSceau(mention, url);
    expect(l.map((x) => x.texte)).toEqual([
      "Signé électroniquement par Djalil El Azzi",
      "Super Admin, en suppléance de la Direction Marketing",
      "le 21/11/2026 19:45",
      `Vérifier : ${url}`,
    ]);
  });

  it("chaque ligne tient dans la largeur du sceau à sa taille", () => {
    for (const { texte, taille } of lignesDuSceau(mention, url)) {
      expect(texte.length * taille * CHASSE_SCEAU, texte).toBeLessThanOrEqual(LARGEUR_TEXTE_SCEAU);
      expect(taille).toBeGreaterThanOrEqual(10);
    }
  });

  it("une mention d'une seule ligne (ancien appel) reste lue", () => {
    expect(lignesDuSceau("Signé électroniquement par Assia — Direction Marketing", url)).toHaveLength(2);
  });
});
