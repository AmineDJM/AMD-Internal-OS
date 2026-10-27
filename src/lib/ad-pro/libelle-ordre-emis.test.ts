import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ITEM_ORDER_STAGE_LABELS, LIBELLE_ORDRE_EMIS } from "@/lib/ad-pro-items";

/**
 * `ISSUED` EST POSÉ À LA DEMANDE DE PAIEMENT, PAS À L'ÉMISSION DU BC (Direction, 27/10 — point 10).
 *
 * Le libellé « Bon de commande émis » disait faux : l'étape naît quand l'ordre de dépense est créé. Elle se lit
 * désormais « Paiement demandé (ordre émis) » ; l'émission du BC, elle, se lit sur la pièce (numéro, signature).
 */
describe("le libellé de l'étape ISSUED d'un poste", () => {
  it("dit « Paiement demandé (ordre émis) », plus « Bon de commande émis »", () => {
    expect(LIBELLE_ORDRE_EMIS).toBe("Paiement demandé (ordre émis)");
    expect(ITEM_ORDER_STAGE_LABELS.ISSUED.label).toBe(LIBELLE_ORDRE_EMIS);
    expect(Object.values(ITEM_ORDER_STAGE_LABELS).map((l) => l.label)).not.toContain("Bon de commande émis");
  });

  it("la colonne « BC » de la carte des postes lit le même libellé (et plus « Émis » tout court)", () => {
    const src = readFileSync("src/components/ad-pro/items-panel.tsx", "utf8");
    expect(src).toMatch(/ISSUED:\s*LIBELLE_ORDRE_EMIS/);
    expect(src).not.toMatch(/ISSUED:\s*"Émis"/);
    // L'émission du BC reste lisible : quand la pièce existe, la colonne affiche son numéro et son étape (signé…).
    expect(src).toMatch(/<LignePiece piece=\{bc\} \/>/);
  });
});
