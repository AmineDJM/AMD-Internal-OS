import { describe, it, expect } from "vitest";
import { parsePage, parseFilterValue, parseFilters, parseSort, serialize, listResult, MAX_LIMIT, DEFAULT_LIMIT } from "./query";
import { ENTITIES } from "./registry/entities";
import { Prisma } from "@prisma/client";

const def = ENTITIES[0];

describe("pagination", () => {
  it("borne le lot — une réponse non bornée finit par ne pas arriver du tout", () => {
    expect(parsePage(new URLSearchParams("limit=99999")).limit).toBe(MAX_LIMIT);
    expect(parsePage(new URLSearchParams("limit=0")).limit).toBe(1);
    expect(parsePage(new URLSearchParams("")).limit).toBe(DEFAULT_LIMIT);
    expect(parsePage(new URLSearchParams("offset=-5")).offset).toBe(0);
  });

  it("dit s'il reste des pages, pour que l'agent sache qu'il n'a pas tout", () => {
    expect(listResult([1, 2], 10, { limit: 2, offset: 0 }).page.hasMore).toBe(true);
    expect(listResult([1, 2], 2, { limit: 2, offset: 0 }).page.hasMore).toBe(false);
  });
});

describe("filtres", () => {
  it("comprend les opérateurs utiles à un agent", () => {
    expect(parseFilterValue("in:A,B")).toEqual({ in: ["A", "B"] });
    expect(parseFilterValue("gte:2026-01-01")).toEqual({ gte: new Date("2026-01-01") });
    expect(parseFilterValue("contains:parac")).toEqual({ contains: "parac", mode: "insensitive" });
    expect(parseFilterValue("null")).toBeNull();
    expect(parseFilterValue("true")).toBe(true);
    expect(parseFilterValue("42")).toBe(42);
  });

  it("REFUSE un champ inconnu au lieu de l'ignorer — sinon l'agent prend une partie pour le tout", () => {
    const allowed = new Set(["status"]);
    expect(() => parseFilters(new URLSearchParams("nawak=1"), allowed, new Set())).toThrow(/n'existe pas/);
    expect(parseFilters(new URLSearchParams("status=SUBMITTED"), allowed, new Set())).toEqual({ status: "SUBMITTED" });
  });

  it("ignore les paramètres réservés à la pagination", () => {
    expect(parseFilters(new URLSearchParams("limit=10&q=x"), new Set(), new Set(["limit", "q"]))).toEqual({});
  });

  it("refuse un tri sur un champ inexistant", () => {
    expect(() => parseSort("nawak:asc", def, new Set(["reference"]))).toThrow(/n'existe pas/);
    expect(parseSort("reference:asc", def, new Set(["reference"]))).toEqual({ reference: "asc" });
  });
});

describe("sérialisation", () => {
  it("rend un Decimal en NOMBRE — comparer un montant à un objet mène à des conclusions fausses", () => {
    expect(serialize(new Prisma.Decimal("12400.50"))).toBe(12400.5);
  });

  it("rend les dates en ISO et n'invente rien pour null", () => {
    expect(serialize(new Date("2026-08-13T10:00:00Z"))).toBe("2026-08-13T10:00:00.000Z");
    expect(serialize(null)).toBeNull();
  });

  it("n'expose jamais d'octets bruts dans une réponse JSON", () => {
    expect(serialize({ blob: Buffer.from("x"), name: "a" })).toEqual({ name: "a" });
  });

  it("traverse les objets et les tableaux imbriqués", () => {
    expect(serialize({ a: [{ d: new Date(0) }] })).toEqual({ a: [{ d: "1970-01-01T00:00:00.000Z" }] });
  });

  it("ne rend JAMAIS un secret, une identité civile, une banque ou une paie — à toute profondeur (audit W10)", () => {
    const employe = {
      id: "e1", fullName: "Ali B.", iban: "DZ5800799999000123456789", nationalId: "1099", cnasNumber: "77",
      baseSalary: new Prisma.Decimal("150000"), grossSalary: 1, netToPay: 1, employerCost: 1,
      user: { id: "u1", name: "Ali", passwordHash: "$2a$10$x", mustChangePassword: false },
      department: { members: [{ id: "u2", passwordHash: "$2a$", accessTokenEnc: "x", rib: "007" }] },
    };
    const out = JSON.stringify(serialize(employe));
    for (const fuite of ["DZ58", "1099", "150000", "$2a$", "passwordHash", "iban", "rib", "accessTokenEnc", "netToPay"]) expect(out).not.toContain(fuite);
    expect(serialize(employe)).toMatchObject({ id: "e1", fullName: "Ali B.", user: { id: "u1", name: "Ali", mustChangePassword: false } });
  });
});
