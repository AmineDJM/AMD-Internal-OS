import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lire = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
/** La source SANS ses commentaires : un cliquet qui lit sa propre prose ne mesure rien (§118.79d). */
const code = (f: string) => lire(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE PAIEMENT DIT SES DEUX ISSUES — et rien ne promet les deux qu'il a retirées
 * (audit 360°, R03 ; décision de la Direction du 02/09/2026).
 *
 * L'écran promettait « une révision du montant ou une argumentation », la documentation de l'action
 * annonçait quatre issues, et la boîte de décision offrait « Demander un complément » — trois
 * promesses d'un geste que l'action refuse (« Décision invalide »). Une prose qui promet ce que le
 * code n'a pas fait chercher ce qui n'existe pas (§118.116, §118.83). Ce banc tient les TROIS
 * endroits, et l'action : si la Direction rétablit la révision, il faudra le dire partout à la fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("Centre de paiement — deux issues, partout où on les nomme", () => {
  it("l'en-tête de l'écran ne promet plus « révision du montant ou argumentation »", () => {
    const page = code("src/app/(app)/centre-de-paiement/page.tsx");
    expect(page).not.toMatch(/demander une révision du montant ou une argumentation/i);
    expect(page).toMatch(/AUTORISE ou REFUSE/);
  });

  it("l'action n'accepte que les deux décisions — et ne garde aucune branche morte du montant proposé", () => {
    const action = code("src/modules/finances/actions-centre.ts");
    const garde = action.match(/function isDecision\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
    expect(garde, "la garde des décisions doit exister").not.toBeNull();
    expect(garde![1]).toMatch(/"APPROVE"/);
    expect(garde![1]).toMatch(/"REFUSE"/);
    expect(garde![1]).not.toMatch(/REQUEST_/);
    expect(action, "le montant « proposé » appartenait à la révision retirée").not.toMatch(/proposedAmount/);
  });

  it("la boîte de décision ne propose plus « Demander un complément » sur un paiement", () => {
    const boite = code("src/platform/in-process/inbox/compose.ts");
    expect(boite).not.toMatch(/decision:\s*"REQUEST_INFO"/);
    expect(boite).not.toMatch(/decision:\s*"REQUEST_CHANGES"/);
  });

  it("la fiche d'une demande de paiement dit où en est son autorisation, et le motif d'un refus (audit 360°, R20)", () => {
    const fiche = code("src/app/(app)/validations/paiements/[id]/page.tsx");
    expect(fiche, "l'état se lit sur l'ordre").toMatch(/centralStatus:\s*true/);
    expect(fiche).toMatch(/CENTRAL_STATUS_LABEL\[etatCentre\]/);
    expect(fiche, "le motif de la dernière décision est rendu").toMatch(/\{motifCentre\}/);
  });
});

