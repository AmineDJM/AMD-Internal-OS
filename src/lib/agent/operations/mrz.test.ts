import { describe, expect, it } from "vitest";
import { casse, chiffreDeControle, lireMrz } from "@/lib/agent/operations/mrz";

/** La zone MRZ, lue ICI — le spécimen de l'OACI (Doc 9303), puis le même vu par un OCR imparfait. */
const SPECIMEN = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10";

describe("MRZ d'un passeport (TD3)", () => {
  it("chiffres de contrôle de l'OACI", () => {
    expect(chiffreDeControle("L898902C3")).toBe(6);
    expect(chiffreDeControle("740812")).toBe(2);
    expect(chiffreDeControle("120415")).toBe(9);
  });

  it("le spécimen se lit, contrôles justes", () => {
    const p = lireMrz(`REPUBLIQUE\n${SPECIMEN}\n`);
    expect(p).toMatchObject({ nom: "ERIKSSON", prenoms: "ANNA MARIA", numero: "L898902C3", pays: "UTO", nationalite: "UTO", naissance: "1974-08-12", sexe: "F", expiration: "2012-04-15", controlesFaux: [] });
  });

  it("un OCR imparfait (espaces, « O » pour « 0 », chevrons « « ») se lit encore", () => {
    const bruite = "P<UTOERIKSSON««ANNA<MARIA <<<<<<<<<<<<<<<<<<<\nL898902C36UTO74O8122F12O4159ZE184226B<<<<<1O";
    expect(lireMrz(bruite)).toMatchObject({ nom: "ERIKSSON", naissance: "1974-08-12", controlesFaux: [] });
  });

  it("un chiffre faux n'est pas corrigé : il est DIT", () => {
    const faux = SPECIMEN.replace("7408122", "7408132");
    expect(lireMrz(faux)?.controlesFaux).toContain("date de naissance");
  });

  it("pas de zone MRZ → rien", () => {
    expect(lireMrz("Programme du congrès\nJour 1 : ouverture")).toBeNull();
  });

  it("la casse de la fiche", () => {
    expect(casse("MOHAMED AMINE")).toBe("Mohamed Amine");
    expect(casse("BEN-ALI")).toBe("Ben-Ali");
  });
});
