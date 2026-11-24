import { describe, expect, it } from "vitest";
import {
  autorisateursDeFormation, departementsDirigesPar, directeurDuDepartement, directeursDesOperationsDeLaSociete, estDirecteurDe,
  estDirectionDesOperations, type DepartementOrganigramme,
} from "./directeurs";

const dep = (o: Partial<DepartementOrganigramme> & { id: string }): DepartementOrganigramme =>
  ({ name: "Service", code: "SVC", companyId: "A", headUserId: null, ...o });

describe("le directeur = le responsable du département dans l'organigramme (24/11/2026)", () => {
  it("le responsable dirige ; personne d'autre — pas de sous-délégation à un adjoint", () => {
    const d = dep({ id: "d", headUserId: "chef" });
    expect(directeurDuDepartement(d)).toBe("chef");
    expect(estDirecteurDe("chef", d)).toBe(true);
    expect(estDirecteurDe("adjoint", d)).toBe(false);
    expect(estDirecteurDe("", dep({ id: "x" }))).toBe(false);
    expect(departementsDirigesPar("chef", [d, dep({ id: "e", headUserId: "autre" })]).map((x) => x.id)).toEqual(["d"]);
  });

  it("reconnaît la Direction des opérations par son nom ou son code", () => {
    expect(estDirectionDesOperations({ name: "Direction des Opérations", code: "X" })).toBe(true);
    expect(estDirectionDesOperations({ name: "Opérations", code: "X" })).toBe(true);
    expect(estDirectionDesOperations({ name: "Service", code: "DIR_OPS" })).toBe(true);
    expect(estDirectionDesOperations({ name: "Marketing", code: "MKT" })).toBe(false);
  });

  it("le Directeur des opérations d'une société : le sien d'abord, celui du groupe à défaut, jamais celui d'une autre société", () => {
    const deps = [
      dep({ id: "opsA", name: "Direction des opérations", companyId: "A", headUserId: "dirA" }),
      dep({ id: "opsB", name: "Direction des opérations", companyId: "B", headUserId: "dirB" }),
      dep({ id: "opsG", name: "Opérations", companyId: null, headUserId: "dirGroupe" }),
    ];
    expect(directeursDesOperationsDeLaSociete(deps, "A")).toEqual(["dirA"]);
    expect(directeursDesOperationsDeLaSociete(deps, "C")).toEqual(["dirGroupe"]);
    expect(directeursDesOperationsDeLaSociete(deps, null)).toEqual(["dirGroupe"]);
  });

  it("qui autorise une formation : l'organigramme, puis le rôle, puis le Super Admin — jamais le demandeur", () => {
    expect(autorisateursDeFormation({ parOrganigramme: ["dir"], parRole: ["role"], superAdmins: ["sa"], requesterId: null })).toEqual({ userIds: ["dir"], repli: false });
    expect(autorisateursDeFormation({ parOrganigramme: [], parRole: ["role"], superAdmins: ["sa"], requesterId: null })).toEqual({ userIds: ["role"], repli: false });
    expect(autorisateursDeFormation({ parOrganigramme: ["dir"], parRole: [], superAdmins: ["sa"], requesterId: "dir" })).toEqual({ userIds: ["sa"], repli: true });
  });
});
