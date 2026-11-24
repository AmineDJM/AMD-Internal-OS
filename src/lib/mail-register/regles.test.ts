import { describe, it, expect } from "vitest";
import { correctionSuivie, dossierAccepteLePli, origineInvalide } from "./regles";
import { diffMailEntry } from "./trace";
import { correctionDepuisApi, getOperation, validateParams } from "@/lib/api/registry/operations";
import { faitDepuisAudit } from "@/lib/events/from-audit";

describe("correctionSuivie — une correction FUSIONNE", () => {
  it("un champ absent n'apparaît pas : il ne sera ni écrit, ni journalisé", () => {
    const c = correctionSuivie({ title: "  Relance CNAS " });
    expect(c).toEqual({ title: "Relance CNAS" });
    // Le journal ne compare que ce dont la correction parle : l'expéditeur absent n'est pas « effacé ».
    expect(diffMailEntry({ title: "Relance", sender: "CNAS" }, c).map((x) => x.field)).toEqual(["title"]);
  });

  it("un champ PRÉSENT et vide est un effacement voulu — écrit `null`", () => {
    expect(correctionSuivie({ sender: "", carrier: "  ", receivedAt: null })).toEqual({ sender: null, carrier: null, receivedAt: null });
  });

  it("le sens ne s'efface pas : `null` vaut « inchangé »", () => {
    expect(correctionSuivie({ direction: undefined })).toEqual({});
    expect(correctionSuivie({ direction: "INCOMING" })).toEqual({ direction: "INCOMING" });
  });
});

describe("dossierAccepteLePli — un dossier d'une entité ne range que ses plis", () => {
  it("dossier commun : tout pli", () => expect(dossierAccepteLePli(null, "A")).toBe(true));
  it("pli sans entité : tout dossier", () => expect(dossierAccepteLePli("A", null)).toBe(true));
  it("même entité : oui ; autre entité : non", () => {
    expect(dossierAccepteLePli("A", "A")).toBe(true);
    expect(dossierAccepteLePli("A", "B")).toBe(false);
  });
});

describe("origineInvalide — un champ caché inventé donne une phrase, pas une erreur Prisma", () => {
  it("accepte l'absence et un type connu avec son identifiant", () => {
    expect(origineInvalide(null, null)).toBeNull();
    expect(origineInvalide("PCH_TENDER", "t1")).toBeNull();
  });
  it("refuse un type inconnu, ou un type sans identifiant", () => {
    expect(origineInvalide("N_IMPORTE_QUOI", "x")).toContain("pas reconnu");
    expect(origineInvalide("PCH_TENDER", null)).toContain("pas précisé");
  });
});

describe("API v1 — absent n'est pas vide", () => {
  const update = getOperation("mail.update")!;

  it("validateParams ne rend QUE les paramètres présents ; un vide vaut `null`", () => {
    const r = validateParams(update, { id: "m1", reference: "CH-12", carrier: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual({ id: "m1", reference: "CH-12", carrier: null });
  });

  it("l'objet n'est plus exigé pour corriger un autre champ", () => {
    expect(validateParams(update, { id: "m1", notes: "x" }).ok).toBe(true);
  });

  it("correctionDepuisApi ne transmet que ce qui est envoyé — et ne retourne pas le pli", () => {
    expect(correctionDepuisApi({ id: "m1", reference: "CH-12" })).toEqual({ reference: "CH-12" });
    expect(correctionDepuisApi({ id: "m1", direction: null })).toEqual({});
    const d = new Date("2026-11-02T00:00:00Z");
    expect(correctionDepuisApi({ receivedAt: d, acknowledgedAt: null })).toEqual({ receivedAt: d, acknowledgedAt: null });
  });

  it("un nom libre d'expéditeur détache le contact d'annuaire, qui ne lui correspondrait plus", () => {
    expect(correctionDepuisApi({ sender: "CNAS" })).toEqual({ sender: "CNAS", senderContactId: null });
  });
});

describe("un dossier de classement n'émet pas « courrier enregistré »", () => {
  it("la ligne d'audit d'un dossier, sans type d'entité, n'est pas un fait", () => {
    expect(faitDepuisAudit({ action: "CREATE", module: "Courriers", entityType: null, entityId: "f1", summary: "Dossier de classement « X » créé" })).toBeNull();
    // Témoin : un vrai courrier, lui, en est un.
    expect(faitDepuisAudit({ action: "CREATE", module: "Courriers", entityType: "MAIL_ENTRY", entityId: "m1" })?.type).toBe("MAIL_REGISTERED");
  });
});
