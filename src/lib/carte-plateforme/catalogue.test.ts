import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MODULES } from "@/lib/rbac";
import { CIRCUITS, DOMAINES, MODULES_PLATEFORME, circuitsDuModule, voisinsDuModule } from "./catalogue";
import { meilleurNiveau, niveauDe } from "./acces";

/**
 * LA CARTE NE DOIT PAS MENTIR — une description qui pointe vers un module inexistant, une clé RBAC
 * disparue ou une adresse 404 enseignerait faux à celui qui vient précisément y apprendre l'ERP.
 */

const APP = path.join(process.cwd(), "src", "app");

function pages(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pages(p, acc);
    else if (e.name === "page.tsx") acc.push(p);
  }
  return acc;
}

/** Les routes réelles, groupes `(x)` retirés, segments dynamiques devenus des motifs. */
const ROUTES = pages(APP).map((f) => {
  const segs = path.dirname(path.relative(APP, f)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s));
  const motif = segs.map((s) => (/^\[.+\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^/${motif}/?$`);
});

const IDS = new Set(MODULES_PLATEFORME.map((m) => m.id));

describe("carte de la plateforme — cohérence du catalogue", () => {
  it("chaque module a un id unique et un domaine connu", () => {
    expect(IDS.size).toBe(MODULES_PLATEFORME.length);
    const domaines = new Set(DOMAINES.map((d) => d.cle));
    expect(MODULES_PLATEFORME.filter((m) => !domaines.has(m.domaine)).map((m) => m.id)).toEqual([]);
    expect(CIRCUITS.filter((c) => !domaines.has(c.domaine)).map((c) => c.id)).toEqual([]);
  });

  it("chaque lien et chaque étape de circuit pointe vers un module du catalogue", () => {
    const morts: string[] = [];
    for (const m of MODULES_PLATEFORME) for (const l of m.liens) if (!IDS.has(l.vers)) morts.push(`${m.id} → ${l.vers}`);
    for (const c of CIRCUITS) for (const e of c.etapes) if (!IDS.has(e.module)) morts.push(`circuit ${c.id} → ${e.module}`);
    expect(morts).toEqual([]);
  });

  it("chaque clé RBAC citée existe dans MODULES (lib/rbac.ts)", () => {
    const connues = new Set<string>(MODULES);
    const inconnues = MODULES_PLATEFORME.flatMap((m) => m.rbac.filter((k) => !connues.has(k)).map((k) => `${m.id}: ${k}`));
    expect(inconnues).toEqual([]);
  });

  it("chaque route citée a sa page", () => {
    expect(ROUTES.length).toBeGreaterThan(100);
    const absentes = MODULES_PLATEFORME
      .filter((m) => m.route !== null && !ROUTES.some((r) => r.test(m.route!)))
      .map((m) => `${m.id}: ${m.route}`);
    expect(absentes).toEqual([]);
  });

  it("chaque circuit commence par un déclencheur et compte au moins trois étapes", () => {
    expect(CIRCUITS.filter((c) => !c.declencheur || c.etapes.length < 3).map((c) => c.id)).toEqual([]);
  });

  it("les relations sont calculées dans les deux sens", () => {
    // `admin` déclare le lien vers `validations` : `validations` doit voir `admin` en retour.
    expect(voisinsDuModule("admin")).toContain("validations");
    expect(voisinsDuModule("validations")).toContain("admin");
    expect(circuitsDuModule("centre-paiement").length).toBeGreaterThan(2);
  });

  it("le niveau d'accès se déduit des actions, jamais d'un libellé", () => {
    expect(niveauDe(["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD"])).toBe("gerer");
    expect(niveauDe(["VIEW", "EXPORT", "VALIDATE"])).toBe("valider");
    expect(niveauDe(["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"])).toBe("ecrire");
    expect(niveauDe(["VIEW", "EXPORT"])).toBe("lire");
    // Sans « Voir », aucun écran ne s'ouvre — même avec d'autres actions.
    expect(niveauDe(["CREATE"])).toBe("aucun");
    expect(niveauDe([])).toBe("aucun");
    expect(meilleurNiveau(["lire", "aucun", "ecrire"])).toBe("ecrire");
    expect(meilleurNiveau([])).toBe("aucun");
  });

  it("le catalogue reste PUR : aucun import (il est lu par un composant client)", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "lib", "carte-plateforme", "catalogue.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    // Découpé en `catalogue/` : la porte ne fait que réexporter ses morceaux, et chaque morceau
    // n'importe que ses frères (`./…`) — rien hors du dossier, donc rien de lourd pour le navigateur.
    expect(source.match(/from\s+"([^"]+)"/g)?.every((f) => f.includes('"./catalogue/'))).toBe(true);
    const dossier = path.join(process.cwd(), "src", "lib", "carte-plateforme", "catalogue");
    for (const f of fs.readdirSync(dossier)) {
      const morceau = fs.readFileSync(path.join(dossier, f), "utf8");
      expect(morceau, f).not.toMatch(/^\s*import\s[^;]*from\s+"(?!\.\/)/m);
    }
  });
});
