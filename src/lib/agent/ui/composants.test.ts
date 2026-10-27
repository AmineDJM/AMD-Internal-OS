import { describe, expect, it } from "vitest";
import { composantsEnBlocs, lireReponseModele, nombresDe } from "@/lib/agent/ui/composants";

const sortieDossiers = JSON.stringify([
  { reference: "REG-2026-014", produit: "Biocare 500 mg", statut: "En instruction", montant: 80000 },
  { reference: "REG-2026-021", produit: "Cardiosol", statut: "Déposé", montant: 125000 },
]);

describe("lireReponseModele — l'enveloppe { message, components }, lue avec indulgence", () => {
  it("un objet JSON nu, un bloc ```json, une phrase avant l'objet", () => {
    expect(lireReponseModele('{"message":"Bonjour","components":[]}')).toEqual({ message: "Bonjour", composants: [] });
    expect(lireReponseModele('```json\n{"message":"A","components":[{"type":"list"}]}\n```').composants).toHaveLength(1);
    expect(lireReponseModele('Voici : {"message":"B"}').message).toBe("B");
  });

  it("un texte libre reste un message — on ne jette jamais une réponse", () => {
    expect(lireReponseModele("Il est 15 h.")).toEqual({ message: "Il est 15 h.", composants: [] });
    expect(lireReponseModele('{"pas":"de message"}').message).toBe('{"pas":"de message"}');
  });
});

describe("nombresDe — les chiffres d'un texte, normalisés", () => {
  it("milliers espacés, décimales à la virgule", () => {
    expect(nombresDe("80 000 DZD, 2,5 % et 125000")).toEqual([80000, 2.5, 125000]);
  });
});

describe("composantsEnBlocs — un composant n'est dessiné que si ses données viennent des outils", () => {
  const avecOutils = { sorties: [sortieDossiers], question: "Mes dossiers en cours ?" };

  it("un tableau recopié des outils devient un bloc table, colonne de montants alignée", () => {
    const r = composantsEnBlocs({ message: "Deux dossiers.", composants: [{
      type: "table", title: "Dossiers", columns: ["Référence", "Statut", "Montant"],
      rows: [["REG-2026-014", "En instruction", "80 000"], ["REG-2026-021", "Déposé", "125 000"]],
    }] }, avecOutils);
    expect(r.retires).toEqual([]);
    expect(r.blocs[0]).toMatchObject({ kind: "table", title: "Dossiers" });
    const b = r.blocs[0]!;
    if (b.kind !== "table") return;
    expect(b.columns.map((c) => c.numeric)).toEqual([false, false, true]);
    expect(b.rows[1]!.cells).toEqual({ c0: "REG-2026-021", c1: "Déposé", c2: "125 000" });
  });

  it("un montant que les outils n'ont pas rendu retire le composant entier", () => {
    const r = composantsEnBlocs({ message: "x", composants: [{
      type: "table", columns: ["Référence", "Montant"], rows: [["REG-2026-014", "95 000"]],
    }] }, avecOutils);
    expect(r.blocs).toEqual([]);
    expect(r.retires).toEqual([{ type: "table", raison: "chiffre-non-source" }]);
    expect(r.message).toMatch(/Le tableau proposé n'a pas pu être rapproché des données lues : il n'est pas affiché/);
  });

  it("une ligne inventée (aucune cellule retrouvée) retire le tableau", () => {
    const r = composantsEnBlocs({ message: "x", composants: [{
      type: "table", columns: ["Référence", "Produit"], rows: [["REG-2026-014", "Biocare 500 mg"], ["Inventol", "Laboratoire fantôme"]],
    }] }, avecOutils);
    expect(r.retires).toEqual([{ type: "table", raison: "ligne-non-source" }]);
  });

  it("une cellule recomposée mot à mot depuis les outils reste prouvée", () => {
    const r = composantsEnBlocs({ message: "x", composants: [{
      type: "table", columns: ["Produit", "Statut"], rows: [["Biocare", "instruction en cours"]],
    }] }, avecOutils);
    expect(r.blocs).toHaveLength(1);
  });

  it("sans outil appelé, ni tableau ni graphique : aucune source", () => {
    const r = composantsEnBlocs({ message: "x", composants: [
      { type: "table", columns: ["A"], rows: [["b"]] },
      { type: "chart", labels: ["a"], series: [{ name: "s", values: [1] }] },
    ] }, { sorties: [], question: "?" });
    expect(r.retires.map((x) => x.raison)).toEqual(["sans-outil", "sans-outil"]);
    expect(r.message).toMatch(/n'ont pas pu être rapprochés des données lues : ils ne sont pas affichés/);
  });

  it("un graphique aux valeurs lues devient un bloc viz ; une valeur inventée le retire", () => {
    const ok = composantsEnBlocs({ message: "x", composants: [{ type: "chart", chartType: "barres", title: "Montants", labels: ["REG-2026-014", "REG-2026-021"], series: [{ name: "DZD", values: [80000, 125000] }] }] }, avecOutils);
    expect(ok.blocs[0]).toMatchObject({ kind: "viz", type: "barres" });
    const ko = composantsEnBlocs({ message: "x", composants: [{ type: "chart", labels: ["a"], series: [{ name: "s", values: [999999] }] }] }, avecOutils);
    expect(ko.retires).toEqual([{ type: "chart", raison: "chiffre-non-source" }]);
  });

  it("un circuit expliqué (steps) devient une frise ; une liste rejoint le texte", () => {
    const r = composantsEnBlocs({ message: "Le circuit :", composants: [
      { type: "steps", title: "Circuit sponsoring", steps: [{ label: "National Sales", detail: "préliminaire" }, { label: "Direction Marketing" }, "Direction"] },
      { type: "list", title: "À retenir", items: ["La Direction tranche", "Les Finances paient"] },
    ] }, { sorties: [], question: "Explique le circuit" });
    expect(r.blocs[0]).toMatchObject({ kind: "timeline", title: "Circuit sponsoring", steps: [{ label: "National Sales", detail: "préliminaire" }, { label: "Direction Marketing", detail: null }, { label: "Direction", detail: null }] });
    expect(r.message).toBe("Le circuit :\n\n**À retenir**\n- La Direction tranche\n- Les Finances paient");
  });

  it("fiche, alerte ; un type inconnu (code, form, html) est retiré", () => {
    const r = composantsEnBlocs({ message: "x", composants: [
      { type: "card", title: "REG-2026-014", content: "Biocare 500 mg", fields: [{ label: "Statut", value: "En instruction" }] },
      { type: "alert", level: "critique", title: "Échéance", content: "Le dossier attend une pièce." },
      { type: "code", content: "alert(1)" },
      { type: "html", content: "<script>" },
    ] }, avecOutils);
    expect(r.blocs.map((b) => b.kind)).toEqual(["record", "alerte"]);
    expect(r.blocs[1]).toMatchObject({ ton: "alerte" });
    expect(r.retires).toEqual([{ type: "code", raison: "inconnu" }, { type: "html", raison: "inconnu" }]);
  });

  it("un rang ou un compte (petit entier) n'est pas une donnée à prouver ; un chiffre de la question peut être repris", () => {
    const r = composantsEnBlocs({ message: "x", composants: [{ type: "alert", content: "Étape 2 sur 3 : budget de 450 000 DZD demandé." }] }, { sorties: [], question: "Prépare une demande de 450 000 DZD" });
    expect(r.blocs).toHaveLength(1);
  });
});
