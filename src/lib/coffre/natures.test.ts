import { describe, expect, it } from "vitest";
import { cleRib, derniersCaracteres, masque, normaliser, NATURES_COFFRE } from "./natures";

/** Construit un IBAN valide à partir d'un pays et d'un BBAN (calcul mod-97 standard). */
function iban(pays: string, bban: string): string {
  const chiffres = (bban + pays + "00").replace(/[A-Z]/g, (l) => String(l.charCodeAt(0) - 55));
  let r = 0;
  for (const c of chiffres) r = (r * 10 + Number(c)) % 97;
  return `${pays}${String(98 - r).padStart(2, "0")}${bban}`;
}

describe("IBAN", () => {
  it("accepte un IBAN de référence ISO (exemple officiel GB82 WEST…) en le compactant", () => {
    expect(normaliser("IBAN", "gb82 west 1234 5698 7654 32")).toEqual({ ok: true, valeur: "GB82WEST12345698765432" });
  });
  it("accepte un IBAN algérien calculé (mod-97 = 1)", () => {
    const v = iban("DZ", "00400174401234567890");
    expect(normaliser("IBAN", v.replace(/(.{4})/g, "$1 "))).toEqual({ ok: true, valeur: v });
  });
  it("refuse une faute de frappe (un chiffre changé)", () => {
    const r = normaliser("IBAN", "GB82WEST12345698765433");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erreur).toMatch(/clé de contrôle/);
  });
  it("refuse une forme impossible", () => {
    expect(normaliser("IBAN", "1234").ok).toBe(false);
    expect(normaliser("IBAN", "DZXX0040017440").ok).toBe(false);
  });
});

describe("RIB algérien", () => {
  const base = "007999990001234567";
  const rib = base + cleRib(base);

  it("la clé RIB rend les 20 chiffres divisibles par 97", () => {
    expect(BigInt(rib) % 97n).toBe(0n);
    expect(Number(cleRib(base))).toBeGreaterThanOrEqual(1);
    expect(Number(cleRib(base))).toBeLessThanOrEqual(97);
  });
  it("accepte le RIB groupé par espaces ou tirets", () => {
    const groupe = `${rib.slice(0, 3)} ${rib.slice(3, 8)}-${rib.slice(8, 18)} ${rib.slice(18)}`;
    expect(normaliser("RIB", groupe)).toEqual({ ok: true, valeur: rib });
  });
  it("refuse une mauvaise clé", () => {
    const faux = base + String((Number(cleRib(base)) % 97) + 1).padStart(2, "0");
    expect(normaliser("RIB", faux).ok).toBe(false);
  });
  it("refuse une clé 00 et une longueur autre que 20", () => {
    expect(normaliser("RIB", "0".repeat(20)).ok).toBe(false);
    expect(normaliser("RIB", rib.slice(1)).ok).toBe(false);
  });
});

describe("NIN et pièces", () => {
  it("NIN : 18 chiffres, espaces retirés", () => {
    expect(normaliser("NIN", "1099 9000 1234 5678 90")).toEqual({ ok: true, valeur: "109990001234567890" });
    expect(normaliser("NIN", "12345678901234567").ok).toBe(false);
    expect(normaliser("NIN", "10999000123456789A").ok).toBe(false);
  });
  it("passeport et CNI : majuscules, alphanumérique", () => {
    expect(normaliser("PASSEPORT_NUMERO", "ab 123 4567")).toEqual({ ok: true, valeur: "AB1234567" });
    expect(normaliser("PASSEPORT_NUMERO", "12").ok).toBe(false);
    expect(normaliser("CNI_NUMERO", "123-456-789")).toEqual({ ok: true, valeur: "123456789" });
  });
  it("expiration : ISO ou JJ/MM/AAAA, jour réel", () => {
    expect(normaliser("PASSEPORT_EXPIRATION", "15/05/2031")).toEqual({ ok: true, valeur: "2031-05-15" });
    expect(normaliser("PASSEPORT_EXPIRATION", "2031-05-15")).toEqual({ ok: true, valeur: "2031-05-15" });
    expect(normaliser("PASSEPORT_EXPIRATION", "31/02/2031").ok).toBe(false);
    expect(normaliser("PASSEPORT_EXPIRATION", "mai 2031").ok).toBe(false);
  });
});

describe("Salaire", () => {
  it.each([
    ["185 000", "185000.00"],
    ["185 000,50 DA", "185000.50"],
    ["185.000,5 DZD", "185000.50"],
    ["185000.5", "185000.50"],
    ["1.250.000", "1250000.00"],
    ["185,000", "185000.00"],
  ])("« %s » → %s", (brut, attendu) => {
    expect(normaliser("SALAIRE", brut)).toEqual({ ok: true, valeur: attendu });
  });
  it("refuse un montant nul, négatif ou textuel", () => {
    expect(normaliser("SALAIRE", "0").ok).toBe(false);
    expect(normaliser("SALAIRE", "-5000").ok).toBe(false);
    expect(normaliser("SALAIRE", "beaucoup").ok).toBe(false);
  });
});

describe("Masque d'affichage", () => {
  it("montre les quatre derniers caractères", () => {
    expect(derniersCaracteres("IBAN", "GB82WEST12345698765432")).toBe("5432");
    expect(masque("IBAN", "5432")).toBe("•••• 5432");
    expect(masque("NIN", derniersCaracteres("NIN", "109990001234567890"))).toBe("•••• 7890");
  });
  it("l'expiration montre l'année (les quatre derniers de JJ/MM/AAAA)", () => {
    expect(masque("PASSEPORT_EXPIRATION", derniersCaracteres("PASSEPORT_EXPIRATION", "2031-05-15"))).toBe("••/••/2031");
  });
  it("le salaire ne montre rien", () => {
    expect(derniersCaracteres("SALAIRE", "185000.00")).toBeNull();
    expect(masque("SALAIRE", null)).not.toMatch(/\d/);
  });
  it("une valeur vide est refusée pour chaque nature", () => {
    for (const n of NATURES_COFFRE) expect(normaliser(n, "  ").ok).toBe(false);
  });
});
