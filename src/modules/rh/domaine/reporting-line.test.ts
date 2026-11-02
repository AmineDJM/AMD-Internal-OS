import { describe, it, expect } from "vitest";
import {
  resolveManager, directReportsOf, managementChainOf, managesAnyone,
  type EmployeeNode, type DepartmentNodeLite,
} from "./reporting-line";

const emp = (id: string, p: Partial<EmployeeNode> = {}): EmployeeNode => ({
  id, fullName: id.toUpperCase(), userId: `u-${id}`, managerId: null, departmentId: null, isActive: true, ...p,
});
const dept = (id: string, p: Partial<DepartmentNodeLite> = {}): DepartmentNodeLite => ({
  id, parentId: null, headId: null, deputyId: null, ...p,
});

describe("le N+1 — la cascade, dans l'ordre", () => {
  it("le manager EXPLICITE passe avant le département", () => {
    const employees = [emp("moi", { managerId: "chef", departmentId: "d1" }), emp("chef"), emp("resp")];
    const departments = [dept("d1", { headId: "resp" })];
    expect(resolveManager("moi", employees, departments)?.employeeId).toBe("chef");
  });

  it("à défaut, le RESPONSABLE du département", () => {
    const employees = [emp("moi", { departmentId: "d1" }), emp("resp")];
    expect(resolveManager("moi", employees, [dept("d1", { headId: "resp" })])?.source).toBe("DEPARTMENT_HEAD");
  });

  it("l'ADJOINT supplée un responsable absent — mais pas un responsable présent", () => {
    const employees = [emp("moi", { departmentId: "d1" }), emp("resp", { isActive: false }), emp("adj")];
    const d = [dept("d1", { headId: "resp", deputyId: "adj" })];
    expect(resolveManager("moi", employees, d)?.employeeId).toBe("adj");
    const actif = [emp("moi", { departmentId: "d1" }), emp("resp"), emp("adj")];
    expect(resolveManager("moi", actif, d)?.employeeId).toBe("resp");
  });

  it("on REMONTE au département parent quand le sien n'a personne", () => {
    const employees = [emp("moi", { departmentId: "enfant" }), emp("grandChef")];
    const departments = [dept("enfant", { parentId: "parent" }), dept("parent", { headId: "grandChef" })];
    expect(resolveManager("moi", employees, departments)?.source).toBe("PARENT_DEPARTMENT_HEAD");
  });

  it("un compte INACTIF ne fait pas un N+1 — la demande y disparaîtrait", () => {
    const employees = [emp("moi", { managerId: "parti", departmentId: "d1" }), emp("parti", { isActive: false }), emp("resp")];
    expect(resolveManager("moi", employees, [dept("d1", { headId: "resp" })])?.employeeId).toBe("resp");
  });

  it("on ne se valide JAMAIS soi-même : le chef d'un département escalade au parent", () => {
    // Et l'on saute l'adjoint : un adjoint supplée une absence, il n'arbitre pas son chef.
    const employees = [emp("moi", { departmentId: "d1" }), emp("adj"), emp("grandChef")];
    const departments = [dept("d1", { parentId: "d0", headId: "moi", deputyId: "adj" }), dept("d0", { headId: "grandChef" })];
    const m = resolveManager("moi", employees, departments);
    expect(m?.employeeId).toBe("grandChef");
    expect(m?.employeeId).not.toBe("adj");
  });

  it("sans département ni manager : personne", () => {
    expect(resolveManager("moi", [emp("moi")], [])).toBeNull();
    expect(resolveManager("inconnu", [emp("moi")], [])).toBeNull();
  });

  it("une hiérarchie qui BOUCLE ne fige pas le serveur", () => {
    const departments = [dept("a", { parentId: "b" }), dept("b", { parentId: "a" })];
    expect(resolveManager("moi", [emp("moi", { departmentId: "a" })], departments)).toBeNull();
  });
});

describe("mes N-1 — l'INVERSE exact de la même règle", () => {
  it("l'équipe est « ceux dont je suis le N+1 », jamais une liste parallèle", () => {
    // Le piège qu'on évite : `x` appartient à mon département MAIS son managerId désigne
    // quelqu'un d'autre. Une inversion naïve (« le département dont je suis chef ») le
    // compterait dans mon équipe, alors que sa demande de congé part chez l'autre.
    const employees = [
      emp("chef", { departmentId: "d1" }),
      emp("a", { departmentId: "d1" }),
      emp("x", { departmentId: "d1", managerId: "ailleurs" }),
      emp("ailleurs"),
    ];
    const departments = [dept("d1", { headId: "chef" })];
    const equipe = directReportsOf("chef", employees, departments).map((e) => e.id);
    expect(equipe).toEqual(["a"]);
    expect(resolveManager("x", employees, departments)?.employeeId).toBe("ailleurs");
  });

  it("attrape aussi celui que la cascade fait REMONTER jusqu'à moi", () => {
    // Le symétrique du piège : le chef du sous-département est inactif, l'employé remonte au
    // parent — il est bien dans mon équipe, et une inversion naïve l'aurait oublié.
    const employees = [
      emp("moi", { departmentId: "d0" }),
      emp("absent", { isActive: false, departmentId: "d1" }),
      emp("b", { departmentId: "d1" }),
    ];
    const departments = [dept("d1", { parentId: "d0", headId: "absent" }), dept("d0", { headId: "moi" })];
    expect(directReportsOf("moi", employees, departments).map((e) => e.id)).toEqual(["b"]);
  });

  it("je ne suis jamais dans ma propre équipe", () => {
    const employees = [emp("moi", { departmentId: "d1" }), emp("a", { departmentId: "d1" })];
    const departments = [dept("d1", { headId: "moi" })];
    expect(directReportsOf("moi", employees, departments).map((e) => e.id)).not.toContain("moi");
  });

  it("les employés PARTIS n'apparaissent pas — une équipe n'est pas un registre historique", () => {
    const employees = [emp("moi", { departmentId: "d1" }), emp("parti", { departmentId: "d1", isActive: false })];
    expect(directReportsOf("moi", employees, [dept("d1", { headId: "moi" })])).toEqual([]);
  });

  it("encadrer quelqu'un se déduit de la même liste", () => {
    const employees = [emp("moi", { departmentId: "d1" }), emp("a", { departmentId: "d1" })];
    const departments = [dept("d1", { headId: "moi" })];
    expect(managesAnyone("moi", employees, departments)).toBe(true);
    expect(managesAnyone("a", employees, departments)).toBe(false);
  });
});

describe("la chaîne hiérarchique", () => {
  it("remonte jusqu'au sommet", () => {
    const employees = [emp("moi", { managerId: "n1" }), emp("n1", { managerId: "n2" }), emp("n2")];
    expect(managementChainOf("moi", employees, []).map((m) => m.employeeId)).toEqual(["n1", "n2"]);
  });

  it("une boucle A→B→A s'arrête au lieu de tourner", () => {
    const employees = [emp("a", { managerId: "b" }), emp("b", { managerId: "a" })];
    expect(managementChainOf("a", employees, []).map((m) => m.employeeId)).toEqual(["b"]);
  });
});
