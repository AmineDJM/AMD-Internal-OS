import { describe, it, expect } from "vitest";
import {
  canAttachToAdPro, canLinkOnAdPro, isOwnBusiness, attachHint,
  type AdProViewer, type AdProRecord,
} from "./attachments";

const viewer = (o: Partial<AdProViewer> = {}): AdProViewer => ({
  id: "u-moi", canUploadModule: false, canUpdateModule: false, canValidateModule: false,
  hasGlobalView: false, ...o,
});

const dossier: AdProRecord = { requesterId: "u-dem", productManagerId: "u-cp", assistantId: "u-ass" };

describe("joindre une pièce à un dossier Ad&Pro", () => {
  it("LE DROIT D'ENVOI DU MODULE OUVRE, comme avant", () => {
    expect(canAttachToAdPro(viewer({ canUploadModule: true }), dossier)).toBe(true);
  });

  it("LE DEMANDEUR JOINT SUR SON PROPRE DOSSIER", () => {
    expect(canAttachToAdPro(viewer({ id: "u-dem" }), dossier)).toBe(true);
  });

  it("QUI PEUT DÉCIDER DU DOSSIER PEUT Y JOINDRE SA FACTURE", () => {
    // C'est le défaut rapporté : la Direction validait le dossier et ne voyait aucun bouton
    // d'envoi, parce que le droit UPLOAD du module ne lui avait pas été coché. Elle envoyait donc
    // la facture par mail, et le dossier restait vide.
    expect(canAttachToAdPro(viewer({ canValidateModule: true }), dossier)).toBe(true);
    expect(canAttachToAdPro(viewer({ canUpdateModule: true }), dossier)).toBe(true);
    expect(canAttachToAdPro(viewer({ hasGlobalView: true }), dossier)).toBe(true);
  });

  it("LE DIRECTION MARKETING ET L'ASSISTANTE aussi — ils instruisent ce dossier-là", () => {
    expect(canAttachToAdPro(viewer({ id: "u-cp" }), dossier)).toBe(true);
    expect(canAttachToAdPro(viewer({ id: "u-ass" }), dossier)).toBe(true);
  });

  it("QUELQU'UN QUI NE FAIT QUE LIRE NE JOINT PAS — la règle n'ouvre rien de neuf", () => {
    expect(canAttachToAdPro(viewer(), dossier)).toBe(false);
  });

  it("un dossier sans partie prenante nommée ne s'ouvre à personne par défaut", () => {
    expect(canAttachToAdPro(viewer(), {})).toBe(false);
    // Et un identifiant absent ne « correspond » jamais : `null === null` ne doit pas ouvrir.
    expect(isOwnBusiness("", { requesterId: null, productManagerId: null })).toBe(false);
  });

  it("la règle ne NOMME aucun rôle : elle lit ce que la personne peut faire", () => {
    // Écrire « sauf MEDICAL_DELEGATE » ou « sauf DIRECTION_ASSISTANT » aurait tenu jusqu'à la
    // première nomination qu'on oublie d'ajouter à la liste.
    const a = canAttachToAdPro(viewer({ canUpdateModule: true }), dossier);
    const b = canAttachToAdPro(viewer({ canUpdateModule: true, id: "quelqun-dautre" }), {});
    expect(a).toBe(b);
  });
});

describe("rattacher une facture ou un engagement", () => {
  it("MÊME RÈGLE QUE JOINDRE — créer la pièce déjà rattachée est le seul moment où c'est gratuit", () => {
    for (const v of [viewer(), viewer({ canUploadModule: true }), viewer({ id: "u-cp" }), viewer({ hasGlobalView: true })]) {
      expect(canLinkOnAdPro(v, dossier)).toBe(canAttachToAdPro(v, dossier));
    }
  });
});

describe("ce qu'on dit à qui ne peut pas", () => {
  it("SE TAIT quand la personne peut joindre", () => {
    expect(attachHint(viewer({ canUploadModule: true }), dossier)).toBeNull();
  });

  it("NOMME LA PORTE MANQUANTE — sinon on recharge, on change de navigateur, on envoie un mail", () => {
    const msg = attachHint(viewer(), dossier);
    expect(msg).toMatch(/droit d'envoi/i);
    expect(msg).toMatch(/demandeur/i);
  });
});
