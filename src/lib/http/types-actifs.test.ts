import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CSP_BAC_A_SABLE, dispositionPourBucket, entetesAntiExecution, estTypeActif, typeDeBase } from "./types-actifs";
import { repondreFichier } from "./telechargement";

/**
 * UN FICHIER DÉPOSÉ NE S'EXÉCUTE JAMAIS DANS LE DOMAINE DE L'ERP — la règle, la porte qui l'applique,
 * et le cliquet qui exige que toute route qui sert un fichier « en ligne » passe par elle.
 * Voir l'en-tête de `types-actifs.ts`.
 */

describe("types actifs — ce qu'un navigateur exécuterait", () => {
  it("reconnaît HTML, XHTML, SVG et tout XML, quels que soient la casse et les paramètres", () => {
    for (const t of ["text/html", "Text/HTML; charset=utf-8", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "application/atom+xml"]) {
      expect(estTypeActif(t), t).toBe(true);
    }
  });
  it("laisse passifs PDF, images bitmap, vidéo, Office, texte brut et l'inconnu", () => {
    for (const t of ["application/pdf", "image/png", "image/jpeg", "video/mp4", "text/plain", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream", "", null, undefined]) {
      expect(estTypeActif(t), String(t)).toBe(false);
    }
  });
  it("typeDeBase retire paramètres et casse", () => {
    expect(typeDeBase(" Image/SVG+XML ; foo=bar")).toBe("image/svg+xml");
  });
  it("un type actif reçoit le bac à sable et nosniff ; un type passif, rien", () => {
    expect(entetesAntiExecution("image/svg+xml")).toEqual({ "Content-Security-Policy": CSP_BAC_A_SABLE, "X-Content-Type-Options": "nosniff" });
    expect(CSP_BAC_A_SABLE).toMatch(/(^|;\s*)sandbox(\s*;|$)/);
    expect(CSP_BAC_A_SABLE).toContain("default-src 'none'");
    expect(entetesAntiExecution("application/pdf")).toEqual({});
  });
  it("vers le bucket (pas de CSP possible), un type actif se télécharge toujours", () => {
    expect(dispositionPourBucket("text/html", "inline")).toBe("attachment");
    expect(dispositionPourBucket("application/pdf", "inline")).toBe("inline");
    expect(dispositionPourBucket("image/png", "attachment")).toBe("attachment");
  });
});

describe("la porte du téléchargement applique la règle (`repondreFichier`)", () => {
  const servir = (mime: string, telecharger = false) => repondreFichier(
    { nom: "piece", mime, charger: async () => Buffer.from("<svg onload=alert(1)>") },
    { qualite: "max", telecharger },
  );
  it("un SVG servi en ligne porte le bac à sable", async () => {
    const r = await servir("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toBe(CSP_BAC_A_SABLE);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("un HTML téléchargé aussi (le bac à sable ne gêne pas un téléchargement)", async () => {
    const r = await servir("text/html", true);
    expect(r.headers.get("content-security-policy")).toBe(CSP_BAC_A_SABLE);
  });
  it("un PDF reste servi en ligne SANS bac à sable — la visionneuse du navigateur en dépend", async () => {
    const r = await servir("application/pdf");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("content-disposition")).toMatch(/^inline/);
  });
});

describe("cliquet — toute route qui sert un fichier « en ligne » passe par la règle", () => {
  // Les exceptions sont NOMMÉES, avec leur raison : un oubli ne s'y range pas en silence.
  const EXCEPTIONS: Record<string, string> = {
    "src/app/api/mail/ms/attachment/route.ts": "règle propre, plus stricte : liste blanche + bac à sable (pièces jointes Microsoft)",
    "src/app/api/medical/plan-de-tournee/[id]/pdf/route.ts": "PDF généré par l'ERP lui-même, jamais un fichier déposé",
  };
  const GARDES = /entetesAntiExecution\(|dispositionPourBucket\(|repondreFichier\(/;

  function fichiers(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? fichiers(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  }

  it("aucune route ne pose `inline` sans la garde des types actifs", () => {
    const racine = process.cwd();
    const candidats = [...fichiers(join(racine, "src/app/api")), ...fichiers(join(racine, "src/lib/storage"))]
      .map((p) => p.slice(racine.length + 1).split("\\").join("/"));
    expect(candidats.length, "le cliquet doit voir les routes").toBeGreaterThan(50);
    const fautifs = candidats.filter((f) => {
      if (EXCEPTIONS[f]) return false;
      const src = readFileSync(join(racine, f), "utf8");
      return /["'`]inline["'`]|\? "inline"|"inline" :/.test(src) && !GARDES.test(src);
    });
    expect(fautifs, "ces routes servent un fichier en ligne sans `entetesAntiExecution` / `dispositionPourBucket` / `repondreFichier`").toEqual([]);
  });

  it("les exceptions existent encore (une exception orpheline se retire)", () => {
    for (const f of Object.keys(EXCEPTIONS)) expect(() => statSync(join(process.cwd(), f)), f).not.toThrow();
  });
});
