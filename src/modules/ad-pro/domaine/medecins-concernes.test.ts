import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROLES_MEDECIN, TYPES_MEDECINS_CONCERNES, demandeAbandonnee, estRoleMedecin, estTypeMedecinsConcernes, montantAttribuable,
} from "./medecins-concernes";

describe("médecins concernés par une demande Ad & Pro", () => {
  it("reconnaît les six natures et les quatre rôles, rien d'autre", () => {
    for (const t of TYPES_MEDECINS_CONCERNES) expect(estTypeMedecinsConcernes(t)).toBe(true);
    for (const r of ROLES_MEDECIN) expect(estRoleMedecin(r)).toBe(true);
    expect(estTypeMedecinsConcernes("CONSULTING_CONTRACT")).toBe(false);
    expect(estRoleMedecin("CHEF")).toBe(false);
  });

  it("l'action écrit exactement les mêmes listes que le module pur (le contrat y lit des littéraux)", () => {
    const src = readFileSync(join(process.cwd(), "src/modules/ad-pro/actions-medecins.ts"), "utf8");
    const liste = (nom: string) => [...(src.match(new RegExp(`const ${nom}: readonly string\\[\\] = \\[([^\\]]*)\\]`))?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(liste("NATURES")).toEqual([...TYPES_MEDECINS_CONCERNES]);
    expect(liste("ROLES")).toEqual([...ROLES_MEDECIN]);
  });

  it("une demande refusée ou annulée ne compte pas", () => {
    expect(demandeAbandonnee("REFUSED")).toBe(true);
    expect(demandeAbandonnee("CANCELLED")).toBe(true);
    expect(demandeAbandonnee("APPROVED")).toBe(false);
  });

  it("le montant attribuable : celui du lien ; sinon tout l'accordé d'un sponsoring qui ne nomme que lui", () => {
    const spo = { nature: "SPONSORING" as const, montantAccorde: 300000, nbMedecins: 1 };
    expect(montantAttribuable({ montant: 50000 }, spo)).toBe(50000);
    expect(montantAttribuable({ montant: null }, spo)).toBe(300000);
    expect(montantAttribuable({ montant: null }, { ...spo, nbMedecins: 2 })).toBeNull();
    expect(montantAttribuable({ montant: null }, { nature: "EVENT", montantAccorde: 100, nbMedecins: 1 })).toBeNull();
  });
});
