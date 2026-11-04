import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { MissionBlock } from "./blocks/decision";
import { ActionRow } from "./primitives";

/**
 * P1 ter (décision 0066) — « elles ne sont pas cliquables » : la carte d'une mission porte « Ouvrir » en VRAI lien vers
 * `/missions/<id>` — même sans fournisseur de conversation (un lien n'envoie aucune phrase) — et jamais vers l'extérieur.
 */
type Mission = Extract<WorkspaceBlock, { kind: "mission" }>;
const carte: Mission = {
  kind: "mission", title: "Revue des stocks Nivolumab", subtitle: "En cours · 1/3 étapes · en cours : Repérer les ruptures",
  etapes: [
    { id: "e0", label: "Lire les stocks par dépôt", etat: "fait", detail: "6 dépôts lus" },
    { id: "e1", label: "Repérer les ruptures à venir", etat: "en-cours" },
    { id: "e2", label: "Rédiger la note de synthèse", etat: "a-faire" },
  ],
  actions: [
    { libelle: "Ouvrir", phrase: "Ouvre la mission « Revue des stocks Nivolumab » (m1)", href: "/missions/m1", icone: "voir" },
    { libelle: "Pause", phrase: "Mets en pause la mission « Revue des stocks Nivolumab » (m1)" },
  ],
};

describe("P1 ter — la carte d'une mission est cliquable", () => {
  it("rend les étapes et « Ouvrir » en lien vers /missions/<id>", () => {
    const html = renderToStaticMarkup(React.createElement(MissionBlock, { b: carte }));
    expect(html).toContain("Repérer les ruptures à venir");
    expect(html).toContain("6 dépôts lus");
    expect(html).toMatch(/<a[^>]+href="\/missions\/m1"[^>]*>.*Ouvrir/);
  });
  it("une adresse externe ou « //hôte » n'est jamais un lien", () => {
    const html = renderToStaticMarkup(React.createElement(ActionRow, { actions: [
      { libelle: "Piège", phrase: "x", href: "https://exemple.test" }, { libelle: "Piège 2", phrase: "y", href: "//exemple.test/a" },
    ] }));
    expect(html).not.toContain("exemple.test");
  });
});
