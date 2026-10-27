import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanDomains } from "./domains";
import { scanBoundary } from "./boundary-scan";
import { cibleInterne } from "./imports";

/**
 * UN `./` NE CONTOURNE PAS UN CLIQUET.
 *
 * Mesuré le 27/10/2026 : `src/lib/rbac.ts`, au SOCLE, importait quatre fichiers de domaines
 * (`./hr/stand-in-resolve`, `./regulatory/pipeline-access`, `./regulatory/assignment`,
 * `./budget/domaines`) sans que l'invariant « le socle fuit : 0 » ne bouge, parce que les
 * scanners ne lisaient que les imports en `@/`. On rejoue ici les trois formes sur un arbre jouet.
 */
const racine = fs.mkdtempSync(path.join(os.tmpdir(), "imports-relatifs-"));
const ecrire = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(racine, f)), { recursive: true });
  fs.writeFileSync(path.join(racine, f), s);
};
ecrire("src/lib/hr/conges.ts", "export const x = 1;\n");
ecrire("src/lib/finance/budget.ts", "export const y = 2;\n");
// Le socle qui importe un domaine en relatif.
ecrire("src/lib/rbac.ts", 'import { x } from "./hr/conges";\nexport const z = x;\n');
// Un domaine qui en fouille un autre en relatif.
ecrire("src/lib/finance/paie.ts", 'import { x } from "../hr/conges";\nexport const w = x;\n');
// Adam qui traverse vers l'ERP en relatif.
ecrire("src/lib/assistant/outil.ts", 'import { y } from "../finance/budget";\nexport const v = y;\n');

afterAll(() => fs.rmSync(racine, { recursive: true, force: true }));

describe("les cliquets lisent aussi les imports relatifs", () => {
  it("cibleInterne normalise `@/` et `./` vers le même chemin", () => {
    expect(cibleInterne("../rbac", "src/lib/hr/conges.ts")).toBe("src/lib/rbac");
    expect(cibleInterne("@/lib/rbac", "src/lib/hr/conges.ts")).toBe("src/lib/rbac");
    expect(cibleInterne("react", "src/lib/hr/conges.ts")).toBeNull();
  });

  it("le socle qui importe un domaine en relatif est une fuite", () => {
    const r = scanDomains(racine);
    expect(r.socleLeaks.map((v) => `${v.from} → ${v.to}`)).toEqual(["src/lib/rbac.ts → src/lib/hr/conges"]);
  });

  it("un domaine qui en importe un autre en relatif est une traversée", () => {
    const r = scanDomains(racine);
    expect(r.crossings.map((v) => `${v.from} → ${v.to}`)).toContain("src/lib/finance/paie.ts → src/lib/hr/conges");
  });

  it("Adam qui importe l'ERP en relatif franchit la frontière", () => {
    const r = scanBoundary(racine);
    expect(r.violations.map((v) => `${v.from} → ${v.to}`)).toEqual(["src/lib/assistant/outil.ts → src/lib/finance/budget"]);
  });
});
