import { describe, it, expect } from "vitest";
import {
  fileTypeLabel, explorerSize, extensionOf, sortRows, parseView, VIEW_TITLE, QUICK_ACCESS, MES_FICHIERS,
  type ExplorerRow,
} from "./explorer";

const row = (name: string, over: Partial<ExplorerRow> = {}): ExplorerRow => ({
  id: name, name, isFile: true, size: 1024, updatedAt: "2026-08-01T10:00:00.000Z", ...over,
});

describe("Le type se lit, il ne se décode pas", () => {
  it("nomme les types courants en français", () => {
    expect(fileTypeLabel("rapport.pdf", true)).toBe("Document PDF");
    expect(fileTypeLabel("budget.xlsx", true)).toBe("Feuille de calcul");
    expect(fileTypeLabel("dossier-ctd.zip", true)).toBe("Dossier compressé");
    expect(fileTypeLabel("photo.JPG", true)).toBe("Image");
    expect(fileTypeLabel("Archives", false)).toBe("Dossier de fichiers");
  });

  it("nomme l'extension quand le type est inconnu — plus utile que « Fichier »", () => {
    expect(fileTypeLabel("plan.dwg", true)).toBe("Fichier DWG");
    expect(fileTypeLabel("sans-extension", true)).toBe("Fichier");
  });

  it("ne prend pas un point de nom pour une extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("v1.2.final.pdf")).toBe("pdf");
  });

});

describe("La taille s'écrit comme un explorateur l'écrit", () => {
  it("arrondit au kilo-octet — « 312 o » n'apprend rien à personne", () => {
    expect(explorerSize(312, true)).toBe("1 Ko");
    expect(explorerSize(0, true)).toBe("0 Ko");
  });

  it("passe aux unités supérieures avec une décimale sous 10", () => {
    expect(explorerSize(1024 * 1024 * 2.5, true)).toBe("2.5 Mo");
    expect(explorerSize(1024 * 1024 * 42, true)).toBe("42 Mo");
    expect(explorerSize(1024 ** 3 * 1.2, true)).toBe("1.2 Go");
  });

  it("un dossier n'affiche pas de taille", () => {
    expect(explorerSize(0, false)).toBe("");
  });
});

describe("Le tri : les dossiers d'abord, toujours", () => {
  const rows = [
    row("zebre.pdf"),
    row("Archives", { isFile: false, size: 0 }),
    row("alpha.pdf"),
    row("Budgets", { isFile: false, size: 0 }),
  ];

  it("place les dossiers en tête, même en tri décroissant", () => {
    for (const dir of ["asc", "desc"] as const) {
      const sorted = sortRows(rows, "name", dir);
      expect(sorted.slice(0, 2).every((r) => !r.isFile), dir).toBe(true);
    }
  });

  it("trie dans l'ORDRE NATUREL : « Fichier 2 » avant « Fichier 10 »", () => {
    // L'ordre alphabétique brut place le 10 avant le 2 — ce qui n'a de sens pour personne.
    const nat = sortRows([row("Fichier 10.pdf"), row("Fichier 2.pdf")], "name", "asc");
    expect(nat.map((r) => r.name)).toEqual(["Fichier 2.pdf", "Fichier 10.pdf"]);
  });

  it("ignore les accents et la casse, comme un explorateur", () => {
    const sorted = sortRows([row("Élan.pdf"), row("edition.pdf")], "name", "asc");
    expect(sorted[0].name).toBe("edition.pdf");
  });

  it("trie par date, par taille et par type", () => {
    const set = [
      row("a.pdf", { size: 300, updatedAt: "2026-01-01T00:00:00.000Z" }),
      row("b.zip", { size: 100, updatedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(sortRows(set, "size", "asc").map((r) => r.name)).toEqual(["b.zip", "a.pdf"]);
    expect(sortRows(set, "updatedAt", "desc").map((r) => r.name)).toEqual(["b.zip", "a.pdf"]);
    // « Document PDF » avant « Dossier compressé » : c'est le TYPE qui ordonne, pas l'extension.
    expect(sortRows(set, "type", "asc").map((r) => r.name)).toEqual(["a.pdf", "b.zip"]);
  });

  it("ne modifie pas le tableau reçu", () => {
    const original = [row("b.pdf"), row("a.pdf")];
    sortRows(original, "name", "asc");
    expect(original.map((r) => r.name)).toEqual(["b.pdf", "a.pdf"]);
  });
});

describe("Les vues de l'explorateur", () => {
  it("reconnaît les accès rapides", () => {
    expect(parseView("recent", false)).toBe("recent");
  });

  it("l'espace personnel s'appelle « Mes fichiers » partout (audit Drive, C6)", () => {
    // Quatre noms pour un seul endroit (« Téléchargements », « Mes fichiers », « Racine (Drive) »,
    // « Drive ») : on cherchait son fichier au mauvais. L'ancienne vue-journal retombe sur la navigation.
    expect(parseView("downloads", false)).toBe("browse");
    expect(QUICK_ACCESS.map((e) => e.key)).toEqual(["recent", "root"]);
    expect(QUICK_ACCESS.find((e) => e.key === "root")).toMatchObject({ href: "/drive", label: MES_FICHIERS });
    expect(MES_FICHIERS).toBe("Mes fichiers");
    expect(VIEW_TITLE.browse).toBe(MES_FICHIERS);
  });

  it("la corbeille l'emporte sur tout", () => {
    expect(parseView("recent", true)).toBe("trash");
  });

  it("une vue inconnue retombe sur la navigation normale, sans erreur", () => {
    expect(parseView("n-importe-quoi", false)).toBe("browse");
    expect(parseView(undefined, false)).toBe("browse");
  });

  it("chaque vue a un titre", () => {
    expect(Object.values(VIEW_TITLE).every((t) => t.length > 0)).toBe(true);
  });
});
