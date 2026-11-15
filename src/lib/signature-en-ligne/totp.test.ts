import { describe, it, expect } from "vitest";
import { base32, depuisBase32, codeDuPas, verifierCode, genererSecret, pasDe, adresseOtpauth } from "./totp";

// RFC 6238, annexe B : clé ASCII « 12345678901234567890 », HMAC-SHA1, 8 chiffres.
const CLE_RFC = Buffer.from("12345678901234567890", "ascii");

describe("TOTP — RFC 6238", () => {
  it("rejoue les vecteurs officiels (SHA1, 8 chiffres)", () => {
    expect(codeDuPas(CLE_RFC, pasDe(59_000), 8)).toBe("94287082");
    expect(codeDuPas(CLE_RFC, pasDe(1_111_111_109_000), 8)).toBe("07081804");
    expect(codeDuPas(CLE_RFC, pasDe(1_234_567_890_000), 8)).toBe("89005924");
    expect(codeDuPas(CLE_RFC, pasDe(2_000_000_000_000), 8)).toBe("69279037");
  });
  it("base32 aller-retour", () => {
    const s = base32(CLE_RFC);
    expect(s).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(depuisBase32(s).equals(CLE_RFC)).toBe(true);
    expect(depuisBase32(genererSecret())).toHaveLength(20);
  });
});

describe("TOTP — vérification d'un code saisi", () => {
  const secret = base32(CLE_RFC);
  const t = 1_234_567_890_000;
  const code = codeDuPas(CLE_RFC, pasDe(t));
  it("accepte le code du pas courant et rend son pas", () => {
    expect(verifierCode(secret, code, t, 0)).toBe(pasDe(t));
    expect(verifierCode(secret, code.slice(0, 3) + " " + code.slice(3), t, 0)).toBe(pasDe(t));
  });
  it("tolère un pas d'écart d'horloge, pas deux", () => {
    expect(verifierCode(secret, code, t + 30_000, 0)).toBe(pasDe(t));
    expect(verifierCode(secret, code, t + 90_000, 0)).toBeNull();
  });
  it("ne sert pas deux fois le même code", () => {
    expect(verifierCode(secret, code, t, pasDe(t))).toBeNull();
  });
  it("refuse ce qui n'est pas six chiffres", () => {
    expect(verifierCode(secret, "12345", t, 0)).toBeNull();
    expect(verifierCode(secret, "abcdef", t, 0)).toBeNull();
  });
  it("l'adresse otpauth porte le secret et l'émetteur", () => {
    expect(adresseOtpauth("ABC", "Assia")).toBe("otpauth://totp/AMD%20Internal%20OS%3AAssia?secret=ABC&issuer=AMD%20Internal%20OS&algorithm=SHA1&digits=6&period=30");
  });
});
