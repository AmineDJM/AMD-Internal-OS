import { describe, it, expect } from "vitest";
import { subtreeOf, flattenTree, totalUnder, depthOf } from "./team-tree";
import type { DepartmentNodeLite, EmployeeNode } from "./reporting-line";

const emp = (id: string, o: Partial<EmployeeNode> = {}): EmployeeNode => ({
  id, fullName: id.toUpperCase(), userId: `u-${id}`, managerId: null, departmentId: null, isActive: true, ...o,
});

const NO_DEPT: DepartmentNodeLite[] = [];

describe("l'arbre descend jusqu'en bas", () => {
  // dg → dir → chef → agent
  const chaine: EmployeeNode[] = [
    emp("dg"),
    emp("dir", { managerId: "dg" }),
    emp("chef", { managerId: "dir" }),
    emp("agent", { managerId: "chef" }),
  ];

  it("LE DEUXIÈME RANG N'EST PLUS INVISIBLE — c'est tout l'objet du chantier", () => {
    const arbre = subtreeOf("dg", chaine, NO_DEPT);
    expect(arbre.map((n) => n.employeeId)).toEqual(["dir"]);
    expect(totalUnder(arbre)).toBe(3);
    expect(depthOf(arbre)).toBe(3);
  });

  it("le RANG est celui qu'un humain compte : N-1 = 1, et non 0", () => {
    const plat = flattenTree(subtreeOf("dg", chaine, NO_DEPT));
    expect(plat.map((n) => [n.employeeId, n.depth])).toEqual([["dir", 1], ["chef", 2], ["agent", 3]]);
  });

  it("CHACUN PORTE SON N+1 — sans quoi l'écran ne dit pas par qui l'on passe", () => {
    const plat = flattenTree(subtreeOf("dg", chaine, NO_DEPT));
    expect(plat.find((n) => n.employeeId === "dir")!.managerEmployeeId).toBeNull(); // c'est moi
    expect(plat.find((n) => n.employeeId === "chef")!.managerEmployeeId).toBe("dir");
    expect(plat.find((n) => n.employeeId === "agent")!.managerEmployeeId).toBe("chef");
  });

  it("L'ORDRE À PLAT EST CELUI DE LA LECTURE : un chef, puis ses gens, puis le chef suivant", () => {
    // Sans cet ordre, la page devrait refaire la descente pour dessiner l'indentation — et
    // deux descentes finiraient par ne plus dire la même chose.
    const deuxBranches = [
      emp("dg"),
      emp("a", { managerId: "dg" }), emp("a1", { managerId: "a" }),
      emp("b", { managerId: "dg" }), emp("b1", { managerId: "b" }),
    ];
    expect(flattenTree(subtreeOf("dg", deuxBranches, NO_DEPT)).map((n) => n.employeeId))
      .toEqual(["a", "a1", "b", "b1"]);
  });

  it("un employé INACTIF ne fait pas partie de l'équipe, ni ses subordonnés par lui", () => {
    const avecParti = [
      emp("dg"),
      emp("parti", { managerId: "dg", isActive: false }),
      emp("orphelin", { managerId: "parti" }),
    ];
    // `resolveManager` refuse un N+1 inactif : l'orphelin n'a plus de chaîne vers dg, il ne
    // remonte donc pas dans son arbre. Le faire remonter inventerait un rattachement.
    expect(flattenTree(subtreeOf("dg", avecParti, NO_DEPT)).map((n) => n.employeeId)).toEqual([]);
  });
});

describe("les gardes — elles ne sont pas décoratives", () => {
  it("UNE HIÉRARCHIE QUI BOUCLE NE FIGE PAS LE SERVEUR", () => {
    // A dirige B, B dirige A : deux saisies plausibles un mardi matin. Sans l'ensemble des
    // personnes déjà placées, la descente ne s'arrête jamais et la page ne répond plus.
    const boucle = [emp("a", { managerId: "b" }), emp("b", { managerId: "a" })];
    const arbre = subtreeOf("a", boucle, NO_DEPT);
    expect(flattenTree(arbre).map((n) => n.employeeId)).toEqual(["b"]);
  });

  it("PERSONNE N'APPARAÎT DEUX FOIS, et surtout pas moi dans ma propre équipe", () => {
    const boucle = [
      emp("moi", { managerId: "x" }),
      emp("x", { managerId: "moi" }),
      emp("y", { managerId: "x" }),
    ];
    const plat = flattenTree(subtreeOf("moi", boucle, NO_DEPT));
    expect(plat.map((n) => n.employeeId).sort()).toEqual(["x", "y"]);
    expect(plat.filter((n) => n.employeeId === "moi")).toHaveLength(0);
  });

  it("la profondeur est bornée — une chaîne absurde s'arrête au lieu de tourner", () => {
    const longue = [emp("n0"), ...Array.from({ length: 30 }, (_, i) => emp(`n${i + 1}`, { managerId: `n${i}` }))];
    expect(depthOf(subtreeOf("n0", longue, NO_DEPT, 4))).toBe(4);
  });
});

describe("le département compte autant que le manager explicite", () => {
  // Un employé sans manager explicite remonte au responsable de son département : l'arbre doit
  // le voir, sinon « Mon Équipe » afficherait quelqu'un de moins que la file de validation.
  const departements: DepartmentNodeLite[] = [
    { id: "d1", parentId: null, headId: "chef", deputyId: null },
  ];
  const gens = [
    emp("chef", { departmentId: "d1" }),
    emp("agent", { departmentId: "d1" }),
  ];

  it("l'équipe d'un chef de département contient les gens de son département", () => {
    expect(flattenTree(subtreeOf("chef", gens, departements)).map((n) => n.employeeId)).toEqual(["agent"]);
  });

  it("…et le chef ne se compte JAMAIS lui-même, fût-il responsable de son propre service", () => {
    expect(flattenTree(subtreeOf("chef", gens, departements)).some((n) => n.employeeId === "chef")).toBe(false);
  });
});
