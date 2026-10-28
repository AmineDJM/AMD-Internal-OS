import { describe, expect, it } from "vitest";
import { sourceDuSymbole } from "@/platform/source";
import { CSP_APERCU, SANDBOX_APERCU, documentApercuIsole } from "./apercu-isole";

describe("aperçu Office isolé (SA-12)", () => {
  it("le bac à sable n'autorise ni script ni origine partagée", () => {
    expect(SANDBOX_APERCU).not.toMatch(/allow-scripts|allow-same-origin|allow-popups|allow-top-navigation/);
  });

  it("la CSP ferme tout chargement externe ; seules les images incorporées et le style en ligne passent", () => {
    expect(CSP_APERCU).toContain("default-src 'none'");
    expect(CSP_APERCU).not.toMatch(/script-src|https?:/);
    const doc = documentApercuIsole(`<p><a href="javascript:alert(1)">piège</a></p>`);
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP_APERCU}">`);
    // Le HTML converti est confié au cadre tel quel : c'est le cadre, pas un filtre, qui le neutralise.
    expect(doc).toContain(`<a href="javascript:alert(1)">piège</a>`);
  });

  it("aucun aperçu Office n'injecte plus le HTML converti dans la page", () => {
    const src = sourceDuSymbole("DocxView");
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(src).toContain("sandbox={SANDBOX_APERCU}");
  });
});
