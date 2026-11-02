import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lireLignesDAchat } from "@/lib/general-means/purchase-request";
import { PurchaseLines } from "./purchase-lines";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ARTICLES D'UNE DEMANDE D'ACHAT SE LISENT — par le N+1 qui valide et l'assistante qui achète
 * (§118.185 — audit 360°, I14).
 *
 * Les lignes vivent dans `fields.purchaseLines` ; la fiche n'affichait que les champs déclarés du
 * type, la carte de validation un titre coupé « (+2) ». Le banc tient le LECTEUR (ce qui ne se lit
 * pas à coup sûr est écarté, jamais deviné), le RENDU (les deux formes, le total indicatif) et les
 * POINTS D'APPEL — un composant juste que rien n'affiche est du code mort (§118.50).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FIELDS = {
  estimatedTotal: 5400,
  purchaseLines: [
    { articleId: "a1", label: "Cartouche HP 305", quantity: 3, unitPrice: 1200 },
    { articleId: null, label: "Lampe de bureau", quantity: 1, unitPrice: null },
    { articleId: "a2", label: "Ramette A4", quantity: 4, unitPrice: 450 },
    { articleId: "a3", label: "Agrafeuse", quantity: 1, unitPrice: null },
  ],
};

describe("lireLignesDAchat — ce qui se lit à coup sûr, rien d'autre", () => {
  it("lit les lignes, dans l'ordre, avec leurs quantités et leurs prix", () => {
    const l = lireLignesDAchat(FIELDS);
    expect(l.map((x) => x.label)).toEqual(["Cartouche HP 305", "Lampe de bureau", "Ramette A4", "Agrafeuse"]);
    expect(l[0]).toEqual({ articleId: "a1", label: "Cartouche HP 305", quantity: 3, unitPrice: 1200 });
    expect(l[1].unitPrice, "un prix inconnu reste inconnu").toBeNull();
  });

  it("écarte ce qui n'est pas une ligne, sans planter ni deviner", () => {
    expect(lireLignesDAchat(null)).toEqual([]);
    expect(lireLignesDAchat({})).toEqual([]);
    expect(lireLignesDAchat({ purchaseLines: "3 cartouches" }), "une chaîne n'est pas une liste").toEqual([]);
    const l = lireLignesDAchat({ purchaseLines: [null, 42, { label: "" }, { label: "Café", quantity: "2", unitPrice: "300" }] });
    expect(l).toEqual([{ articleId: null, label: "Café", quantity: 2, unitPrice: null }]);
  });
});

describe("PurchaseLines — la table de la fiche, la liste de la carte de validation", () => {
  it("la table montre CHAQUE article et le total indicatif des seuls prix connus", () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseLines, { lines: lireLignesDAchat(FIELDS) }));
    for (const libelle of ["Cartouche HP 305", "Lampe de bureau", "Ramette A4", "Agrafeuse"]) expect(html).toContain(libelle);
    expect(html).toContain("hors catalogue");
    expect(html).toMatch(/Total indicatif/);
    // 3 × 1 200 + 4 × 450 = 5 400 — les lignes sans prix n'y entrent pas.
    expect(html.replace(/\s|&nbsp;| | /g, "")).toContain("5400");
  });

  it("la carte de validation montre les quatre articles — pas trois puis « (+1) »", () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseLines, { lines: lireLignesDAchat(FIELDS), compact: true }));
    expect((html.match(/<li/g) ?? []).length, "quatre articles et la ligne du total").toBe(5);
    expect(html).not.toContain("(+");
  });

  it("aucun prix connu : jamais « 0 DZD », le total viendra de la facture", () => {
    const html = renderToStaticMarkup(React.createElement(PurchaseLines, { lines: [{ articleId: null, label: "Divers", quantity: 1, unitPrice: null }] }));
    expect(html).toContain("Aucun prix connu");
    expect(renderToStaticMarkup(React.createElement(PurchaseLines, { lines: [] }))).toBe("");
  });
});

describe("les points d'appel (§118.49)", () => {
  it("la fiche d'une demande et la carte de validation rendent les lignes ; la file lit leurs champs", () => {
    const fiche = readFileSync("src/app/(app)/demandes/[id]/page.tsx", "utf8");
    expect(fiche).toMatch(/req\.type === "PURCHASE" \? lireLignesDAchat\(fields\)/);
    expect(fiche).toMatch(/<PurchaseLines lines=\{lignesAchat\} \/>/);
    const carte = readFileSync("src/app/(app)/demandes/approvals/page.tsx", "utf8");
    expect(carte).toMatch(/<PurchaseLines lines=\{lireLignesDAchat\(a\.request\.fields\)\} compact \/>/);
    expect(readFileSync("src/lib/queries/admin-requests.ts", "utf8")).toMatch(/request: \{ select: \{[^}]*fields: true/);
  });
});
