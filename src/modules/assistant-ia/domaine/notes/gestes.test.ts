import { describe, expect, it } from "vitest";
import type { BlocNote } from "./blocs";
import { appliquerSurBlocs, inverseDe, lireGeste, resoudreLigne, resoudrePosition, resumeGeste, type GesteNote } from "./gestes";
import { borner, doitGarderVersion, estLigneSensible, joursRestants, lignesPourModele } from "./regles";

const b = (id: string, texte: string, type: BlocNote["type"] = "tache", niveau = 0, fait = false): BlocNote =>
  ({ id, type, texte, niveau, ...(type === "tache" ? { fait } : {}) });

const PAGE = [
  b("t1", "Cette semaine", "titre"),
  b("l1", "Valider le budget du congrès d'Oran"),
  b("l2", "Envoyer le dossier daclatasvir à l'ANPP", "tache", 0, true),
  b("t2", "Idées", "titre"),
  b("l3", "Kakémonos pour le symposium", "puce"),
  b("l4", "Revoir les tarifs de l'agence", "puce"),
];

describe("gestes — désigner une ligne", () => {
  it("par identifiant, par texte entier, par morceau (accents et casse ignorés)", () => {
    expect(resoudreLigne(PAGE, "l3")).toEqual({ ok: true, id: "l3" });
    expect(resoudreLigne(PAGE, "valider le budget du congres d'oran")).toEqual({ ok: true, id: "l1" });
    expect(resoudreLigne(PAGE, "kakemonos")).toEqual({ ok: true, id: "l3" });
  });

  it("plusieurs candidates : AMBIGU avec la liste ; aucune : INTROUVABLE — jamais deviné", () => {
    const r = resoudreLigne(PAGE, "le");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statut).toBe("AMBIGU");
      expect(r.candidats.length).toBeGreaterThan(1);
    }
    expect(resoudreLigne(PAGE, "rien de tel")).toMatchObject({ ok: false, statut: "INTROUVABLE" });
  });

  it("sous un titre : à la fin de SA section ; après une ligne ; en tête ; à la fin par défaut", () => {
    expect(resoudrePosition(PAGE, { sous: "Cette semaine" })).toMatchObject({ ok: true, apres: "l2", niveau: 0, sous: "Cette semaine" });
    expect(resoudrePosition(PAGE, { sous: "idees" })).toMatchObject({ ok: true, apres: "l4" });
    expect(resoudrePosition(PAGE, { apres: "l1" })).toMatchObject({ ok: true, apres: "l1" });
    expect(resoudrePosition(PAGE, { enTete: true })).toMatchObject({ ok: true, apres: null });
    expect(resoudrePosition(PAGE, {})).toMatchObject({ ok: true, apres: "l4" });
    expect(resoudrePosition(PAGE, { sous: "Congrès" })).toMatchObject({ ok: false, quoi: "titre" });
  });
});

describe("gestes — appliquer, puis annuler exactement", () => {
  const cas: GesteNote[] = [
    { geste: "ajouter_note", pageId: "p", bloc: b("n1", "Relancer l'imprimeur"), apres: "l2" },
    { geste: "modifier_note", pageId: "p", id: "l1", texte: "Valider le budget (révisé)", ancien: "Valider le budget du congrès d'Oran" },
    { geste: "cocher_note", pageId: "p", id: "l1", fait: true },
    { geste: "deplacer_note", pageId: "p", id: "l4", apres: "t2", avant: "l3" },
    { geste: "supprimer_note", pageId: "p", id: "l3", bloc: PAGE[4], apres: "t2" },
  ];

  for (const g of cas) {
    it(`${g.geste} : appliqué, puis son inverse rend la page d'origine`, () => {
      const a = appliquerSurBlocs(PAGE, g);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.blocs).not.toEqual(PAGE);
      const inv = appliquerSurBlocs(a.blocs, inverseDe(PAGE, g));
      expect(inv.ok && inv.blocs).toEqual(PAGE);
    });
  }

  it("une ligne disparue depuis la proposition : refus motivé, rien d'appliqué", () => {
    const sans = PAGE.filter((x) => x.id !== "l1");
    expect(appliquerSurBlocs(sans, { geste: "cocher_note", pageId: "p", id: "l1", fait: true })).toMatchObject({ ok: false });
    expect(appliquerSurBlocs(PAGE, { geste: "ajouter_note", pageId: "p", bloc: b("l1", "x"), apres: null })).toMatchObject({ ok: false });
  });

  it("l'inverse d'une page créée la retire ; d'un renommage, rend l'ancien titre", () => {
    expect(inverseDe(PAGE, { geste: "creer_page", pageId: "p2", titre: "Congrès" })).toEqual({ geste: "retirer_page", pageId: "p2" });
    expect(inverseDe(PAGE, { geste: "renommer_page", pageId: "p", titre: "Semaine 44", ancien: "Mes notes" }))
      .toEqual({ geste: "renommer_page", pageId: "p", titre: "Mes notes", ancien: "Semaine 44" });
  });
});

describe("gestes — ce que la personne lit, ce que la base rend", () => {
  it("un résumé à l'infinitif, qui cite la ligne et la page", () => {
    expect(resumeGeste({ geste: "ajouter_note", pageId: "p", bloc: b("n", "Relancer l'imprimeur"), apres: "l2" }, "Mes notes", { sous: "Cette semaine" }))
      .toBe("Ajouter la case « Relancer l'imprimeur » sous « Cette semaine » — « Mes notes »");
    expect(resumeGeste({ geste: "cocher_note", pageId: "p", id: "l1", fait: true }, "Mes notes", { blocs: PAGE }))
      .toBe("Cocher « Valider le budget du congrès d'Oran » — « Mes notes »");
  });

  it("un geste illisible en base est écarté", () => {
    expect(lireGeste({ geste: "cocher_note", pageId: "p", id: "l1", fait: true })).not.toBeNull();
    expect(lireGeste({ geste: "cocher_note", pageId: "p" })).toBeNull();
    expect(lireGeste({ geste: "effacer_tout", pageId: "p" })).toBeNull();
    expect(lireGeste({ geste: "creer_page", pageId: "p", titre: "   " })).toBeNull();
  });
});

describe("règles — versions, corbeille, modèle", () => {
  const t0 = new Date("2026-10-30T10:00:00Z");
  it("une version au plus toutes les 5 minutes de frappe ; toujours avant une modification de l'IA", () => {
    expect(doitGarderVersion(null, t0, "PERSONNE")).toBe(true);
    expect(doitGarderVersion(new Date(t0.getTime() - 60_000), t0, "PERSONNE")).toBe(false);
    expect(doitGarderVersion(new Date(t0.getTime() - 6 * 60_000), t0, "PERSONNE")).toBe(true);
    expect(doitGarderVersion(new Date(t0.getTime() - 1_000), t0, "IA")).toBe(true);
  });

  it("la corbeille compte ses 30 jours", () => {
    expect(joursRestants(new Date(t0.getTime() - 18 * 86_400_000), t0)).toBe(12);
    expect(joursRestants(new Date(t0.getTime() - 40 * 86_400_000), t0)).toBe(0);
  });

  it("le modèle lit une ligne par bloc, avec sa référence ; borné ; les lignes de paie sont repérées", () => {
    const l = lignesPourModele([b("t1", "Cette semaine", "titre"), b("l2", "Fait", "tache", 1, true)]);
    expect(l).toEqual(["# Cette semaine  ⟨t1⟩", "  [x] Fait  ⟨l2⟩"]);
    expect(borner(["a".repeat(10), "b".repeat(10)], 15)).toEqual({ lignes: ["a".repeat(10)], tronque: true });
    expect(estLigneSensible("Prime de Karim : 40 000 DA")).toBe(true);
    expect(estLigneSensible("Budget du congrès : 2 000 000 DZD")).toBe(false);
  });
});
