import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { chargerCles, clesDepuisMaitresse, ErreurCleCoffre } from "./cle";
import { chiffrer, dechiffrer, empreinte, ErreurDechiffrement } from "./chiffrement";

const cleA = clesDepuisMaitresse(crypto.randomBytes(32));
const cleB = clesDepuisMaitresse(crypto.randomBytes(32));
const RIB = "00799999000123456714";

describe("Chiffrement du coffre", () => {
  it("aller-retour : la valeur relue est la valeur déposée", () => {
    const c = chiffrer(cleA, "RIB", "d1", RIB);
    expect(dechiffrer(cleA, "RIB", "d1", c)).toBe(RIB);
  });

  it("la valeur en clair n'apparaît JAMAIS dans le chiffré, sous aucune forme courante", () => {
    for (const clair of [RIB, "185000.00", "109990001234567890", "AB1234567"]) {
      const c = chiffrer(cleA, "SALAIRE", "d1", clair);
      const formes = [clair, clair.slice(-4), Buffer.from(clair).toString("base64"), Buffer.from(clair).toString("base64url"), Buffer.from(clair).toString("hex")];
      for (const f of formes) expect(c.includes(f), `« ${f} » trouvé dans ${c}`).toBe(false);
      expect(Buffer.from(c.split(".")[2], "base64url").includes(Buffer.from(clair))).toBe(false);
    }
  });

  it("deux chiffrements de la même valeur diffèrent (IV aléatoire)", () => {
    expect(chiffrer(cleA, "RIB", "d1", RIB)).not.toBe(chiffrer(cleA, "RIB", "d1", RIB));
  });

  it("deux clés différentes ne se lisent pas", () => {
    const c = chiffrer(cleA, "RIB", "d1", RIB);
    expect(() => dechiffrer(cleB, "RIB", "d1", c)).toThrow(ErreurDechiffrement);
    // Même en forçant l'identifiant de clé, l'authentification GCM échoue.
    const force = c.replace(`.${cleA.id}.`, `.${cleB.id}.`);
    expect(() => dechiffrer(cleB, "RIB", "d1", force)).toThrow(/altéré/);
  });

  it("un chiffré relu sous une autre nature ou une autre donnée est refusé (AAD)", () => {
    const c = chiffrer(cleA, "RIB", "d1", RIB);
    expect(() => dechiffrer(cleA, "SALAIRE", "d1", c)).toThrow(ErreurDechiffrement);
    expect(() => dechiffrer(cleA, "RIB", "d2", c)).toThrow(ErreurDechiffrement);
  });

  it("un chiffré altéré ou tronqué est refusé", () => {
    const c = chiffrer(cleA, "RIB", "d1", RIB);
    const [v, id, charge] = c.split(".");
    const octets = Buffer.from(charge, "base64url");
    octets[octets.length - 1] ^= 1;
    expect(() => dechiffrer(cleA, "RIB", "d1", `${v}.${id}.${octets.toString("base64url")}`)).toThrow(ErreurDechiffrement);
    expect(() => dechiffrer(cleA, "RIB", "d1", `${v}.${id}.AAAA`)).toThrow(/tronqué/);
    expect(() => dechiffrer(cleA, "RIB", "d1", "n'importe quoi")).toThrow(/mal formé/);
  });
});

describe("Empreinte de recherche", () => {
  it("est stable pour une même clé et une même valeur", () => {
    expect(empreinte(cleA, "RIB", RIB)).toBe(empreinte(cleA, "RIB", RIB));
    expect(empreinte(cleA, "RIB", RIB)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("dépend de la clé, de la nature et de la valeur", () => {
    expect(empreinte(cleA, "RIB", RIB)).not.toBe(empreinte(cleB, "RIB", RIB));
    expect(empreinte(cleA, "RIB", RIB)).not.toBe(empreinte(cleA, "IBAN", RIB));
    expect(empreinte(cleA, "RIB", RIB)).not.toBe(empreinte(cleA, "RIB", RIB.slice(0, -1) + "5"));
  });
  it("ne contient pas la valeur, et diffère d'un simple SHA-256", () => {
    const e = empreinte(cleA, "RIB", RIB);
    expect(e.includes(RIB)).toBe(false);
    expect(e).not.toBe(crypto.createHash("sha256").update(RIB).digest("hex"));
  });
  it("les sous-clés de chiffrement et d'empreinte sont distinctes", () => {
    expect(cleA.chiffrement.equals(cleA.empreinte)).toBe(false);
  });
});

describe("Clé COFFRE_KEY", () => {
  const hex = crypto.randomBytes(32).toString("hex");

  it("en production, refuse explicitement une clé absente", () => {
    expect(() => chargerCles({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(ErreurCleCoffre);
    expect(() => chargerCles({ NODE_ENV: "production", COFFRE_KEY: " " } as NodeJS.ProcessEnv)).toThrow(/COFFRE_KEY manque/);
  });

  it("refuse une clé mal formée dans tous les environnements", () => {
    expect(() => chargerCles({ NODE_ENV: "test", COFFRE_KEY: "trop-courte" } as NodeJS.ProcessEnv)).toThrow(/32 octets/);
    expect(() => chargerCles({ NODE_ENV: "production", COFFRE_KEY: "abcd" } as NodeJS.ProcessEnv)).toThrow(ErreurCleCoffre);
  });

  it("refuse la clé du Drive", () => {
    expect(() => chargerCles({ NODE_ENV: "production", COFFRE_KEY: hex, DRIVE_ENCRYPTION_KEY: hex } as NodeJS.ProcessEnv)).toThrow(/DRIVE_ENCRYPTION_KEY/);
    const b64 = Buffer.from(hex, "hex").toString("base64");
    expect(() => chargerCles({ NODE_ENV: "production", COFFRE_KEY: b64, DRIVE_ENCRYPTION_KEY: hex } as NodeJS.ProcessEnv)).toThrow(/DRIVE_ENCRYPTION_KEY/);
  });

  it("accepte l'hexadécimal et le base64 de la même clé (même identifiant)", () => {
    const b64 = Buffer.from(hex, "hex").toString("base64");
    const a = chargerCles({ NODE_ENV: "production", COFFRE_KEY: hex } as NodeJS.ProcessEnv);
    const b = chargerCles({ NODE_ENV: "production", COFFRE_KEY: b64 } as NodeJS.ProcessEnv);
    expect(a.id).toBe(b.id);
    expect(a.developpement).toBe(false);
  });

  it("en test, sans clé : clé de développement, silencieuse, stable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = chargerCles({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const b = chargerCles({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(a.developpement).toBe(true);
    expect(a.id).toBe(b.id);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("en développement, sans clé : avertit une fois", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chargerCles({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    chargerCles({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ce qui est chiffré avec la clé de développement ne se lit pas avec une vraie clé", () => {
    const dev = chargerCles({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const prod = chargerCles({ NODE_ENV: "production", COFFRE_KEY: hex } as NodeJS.ProcessEnv);
    const c = chiffrer(dev, "NIN", "d1", "109990001234567890");
    expect(() => dechiffrer(prod, "NIN", "d1", c)).toThrow(/autre clé/);
  });
});
