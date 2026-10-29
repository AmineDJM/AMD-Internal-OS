import { describe, it, expect } from "vitest";
import { entityHref, noHrefReason } from "./entity-href";
import { AD_PRO_ENTITY_TYPE } from "@/modules/ad-pro/partage";

describe("où s'ouvre un objet", () => {
  it("les origines RÉELLES des ordres de dépense s'ouvrent toutes", () => {
    // Le centre de paiement est devenu le guichet unique : il voit désormais ces huit origines,
    // et une seule savait s'ouvrir. Autoriser une sortie d'argent sans pouvoir ouvrir ce qui la
    // justifie est exactement ce que le centre existe pour empêcher.
    const origines = [
      "PAYMENT_REQUEST", "ADMIN_REQUEST", "SALARY_ADVANCE", "PROMO_MATERIAL",
      "REGULATORY_PRODUCT", "LEGAL_DOCUMENT", "EVENT", "MEDICAL_INFO_DECLARATION",
      "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "SPONSORING",
    ];
    for (const t of origines) {
      expect(entityHref(t, "abc"), t).toBeTruthy();
    }
  });

  it("chaque route porte l'identifiant quand l'objet a une fiche", () => {
    expect(entityHref("PAYMENT_REQUEST", "p1")).toBe("/validations/paiements/p1");
    expect(entityHref("MEDICAL_INFO_DECLARATION", "d1")).toBe("/information-medicale/d1");
    expect(entityHref("MAIL_ENTRY", "m1")).toBe("/courriers/m1");
    expect(entityHref("VALIDATION_REQUEST", "v1")).toBe("/validations/v1");
  });

  it("un objet SANS fiche propre renvoie vers son registre, pas vers une page inexistante", () => {
    // Mieux vaut la liste où l'objet se trouve qu'un lien qui rend 404.
    expect(entityHref("SALARY_ADVANCE", "a1")).toBe("/rh/paie");
    expect(entityHref("INVOICE", "i1")).toBe("/legal/i1");
  });

  it("un type INCONNU rend `null` — jamais un lien deviné", () => {
    // Un lien mort vaut moins qu'aucun lien : on clique, rien ne se passe, on recommence.
    expect(entityHref("QUELQUE_CHOSE", "x")).toBeNull();
    expect(entityHref(null, "x")).toBeNull();
    expect(entityHref("MAIL_ENTRY", null)).toBeNull();
    expect(entityHref("MAIL_ENTRY", "")).toBeNull();
  });

  it("LES SEPT NATURES du pôle Ad & Pro ont une adresse — pas six sur sept", () => {
    /*
     * `AD_PRO_OTHER` n'avait AUCUN cas alors que son écran existe depuis qu'elle existe : tout
     * lien vers une « autre demande » rendait `null`, et l'appelant affichait la phrase des
     * objets sans adresse. Un « je ne peux pas » écrit dans le CODE, sur une fiche qu'un clic
     * ouvre (§118.63) — six portes ouvertes à côté d'une fermée (§118.71).
     *
     * Ce cas boucle sur le registre CANONIQUE des natures : une huitième nature ajoutée demain
     * sans adresse fait tomber ce test en la nommant, au lieu de rendre `null` en silence.
     */
    for (const [kind, entite] of Object.entries(AD_PRO_ENTITY_TYPE)) {
      expect(entityHref(entite, "x1"), `la nature « ${kind} » (${entite}) doit avoir une adresse`).toBeTruthy();
    }
    expect(entityHref("AD_PRO_OTHER", "o1")).toBe("/ad-pro/autres/o1");
  });

  it("l'absence de lien s'EXPLIQUE, elle ne se subit pas", () => {
    expect(noHrefReason("SALARY_ADVANCE", "une avance sur salaire")).toContain("avance sur salaire");
    expect(noHrefReason(null)).toContain("cet objet");
  });
});
