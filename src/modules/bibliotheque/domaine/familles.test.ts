import { describe, expect, it } from "vitest";
import { cleAcces, famillesDe, lienDe, lireCle, NOMS_FAMILLES } from "./familles";

describe("Les clés d'accès", () => {
  it("se lisent comme elles s'écrivent", () => {
    expect(lireCle(cleAcces("DRIVE_NODE", "abc"))).toEqual({ famille: "DRIVE_NODE", id: "abc" });
  });
  it("une famille inconnue, ou une clé mal formée, n'ouvre rien", () => {
    expect(lireCle("INCONNU:abc")).toBeNull();
    expect(lireCle("DRIVE_NODE:")).toBeNull();
    expect(lireCle("sans-deux-points")).toBeNull();
    expect(lienDe("INCONNU:abc")).toBeNull();
  });
  it("refuse un identifiant vide ou ambigu", () => {
    expect(() => cleAcces("DOCUMENT", "")).toThrow();
    expect(() => cleAcces("DOCUMENT", "a:b")).toThrow();
  });
  it("projette les familles d'une liste, triées et sans doublon", () => {
    expect(famillesDe(["DOCUMENT:1", "DRIVE_NODE:2", "DOCUMENT:3", "XX:4"])).toEqual(["DOCUMENT", "DRIVE_NODE"]);
  });
  it("chaque famille a un lien d'ouverture", () => {
    for (const f of NOMS_FAMILLES) expect(lienDe(cleAcces(f, "x1"))).toMatch(/^\//);
  });
});
