import { describe, expect, it } from "vitest";
import { parseCsvLine, detectSeparator, findHeaderRow, tableFromGrid, parseCsv, chunksFromTables, tablesToText, parseWorkbook, MAX_SHEET_ROWS } from "./sheet";

/**
 * §6 — UN TABLEAU SE LIT COMME UN TABLEAU.
 *
 * Ce qui est éprouvé ici n'est pas « ça découpe » mais « ça ne découpe pas MAL » : un prix
 * français coupé en deux par une virgule, une ligne de titre prise pour un en-tête, ou une
 * colonne vide retirée qui décale toutes les valeurs d'un cran — trois erreurs qui produisent
 * des données fausses ayant l'air de données justes.
 */

describe("découpage d'une ligne", () => {
  it("respecte les guillemets et le séparateur qu'ils protègent", () => {
    expect(parseCsvLine('Dupont;"Alger, Centre";16')).toEqual(["Dupont", "Alger, Centre", "16"]);
  });

  it("comprend le guillemet échappé", () => {
    expect(parseCsvLine('a;"il a dit ""oui""";c')).toEqual(["a", 'il a dit "oui"', "c"]);
  });

  it("garde les cellules vides à leur place", () => {
    // Les retirer décalerait toute la ligne et associerait chaque valeur à la mauvaise colonne.
    expect(parseCsvLine("a;;c")).toEqual(["a", "", "c"]);
  });
});

describe("détection du séparateur", () => {
  it("préfère le point-virgule, séparateur des tableurs francophones", () => {
    expect(detectSeparator("nom;prix\nKeytruda;4,50")).toBe(";");
  });

  it("ne coupe JAMAIS un prix français sur sa virgule décimale", () => {
    // Deviner la virgule ici transformerait « 4,50 » en deux colonnes : un prix faux se lit
    // comme un prix, ce qui est pire que pas de prix du tout.
    const table = parseCsv("nom;prix\nKeytruda;4,50\nAutre;12,00");
    expect(table!.rows[0]).toEqual({ nom: "Keytruda", prix: "4,50" });
  });

  it("reconnaît la virgule quand elle sépare réellement", () => {
    expect(detectSeparator("nom,prix,unite\na,1,mg\nb,2,mg")).toBe(",");
  });

  it("reconnaît la tabulation", () => {
    expect(detectSeparator("nom\tprix\na\t1")).toBe("\t");
  });
});

describe("recherche de l'en-tête", () => {
  it("saute un titre et une ligne vide avant de trouver les colonnes", () => {
    const grid = [
      ["Rapport mensuel — mars 2026", "", ""],
      ["", "", ""],
      ["Produit", "Quantité", "Prix"],
      ["Keytruda", "12", "4500"],
    ];
    expect(findHeaderRow(grid)).toBe(2);
  });

  it("refuse une ligne majoritairement numérique — ce sont des données", () => {
    expect(findHeaderRow([["12", "45", "78"], ["Produit", "Quantité", "Prix"]])).toBe(1);
  });

  it("refuse une ligne aux libellés répétés", () => {
    expect(findHeaderRow([["col", "col", "autre"], ["Produit", "Quantité", "Prix"]])).toBe(1);
  });

  it("rend -1 quand rien ne ressemble à un tableau", () => {
    expect(findHeaderRow([["une phrase très longue qui raconte quelque chose et dépasse largement quatre-vingts caractères de long"]])).toBe(-1);
  });
});

describe("grille vers tableau nommé", () => {
  it("associe chaque valeur à SA colonne", () => {
    const t = tableFromGrid("Tarifs", [
      ["Produit", "Prix", "Devise"],
      ["Keytruda", "4500", "DZD"],
    ]);
    expect(t!.rows[0]).toEqual({ Produit: "Keytruda", Prix: "4500", Devise: "DZD" });
  });

  it("nomme les colonnes anonymes au lieu de les supprimer", () => {
    // Supprimer la colonne sans nom décalerait « DZD » sous « Prix ».
    const t = tableFromGrid("F", [["Produit", "", "Devise"], ["Keytruda", "4500", "DZD"]]);
    expect(t!.headers).toEqual(["Produit", "col2", "Devise"]);
    expect(t!.rows[0].Devise).toBe("DZD");
  });

  it("ignore les lignes entièrement vides sans les compter", () => {
    const t = tableFromGrid("F", [["A", "B"], ["1", "2"], ["", ""], ["3", "4"]]);
    expect(t!.totalRows).toBe(2);
  });

  it("rend null quand il n'y a que l'en-tête", () => {
    expect(tableFromGrid("F", [["A", "B"]])).toBeNull();
  });
});

describe("ce que la couche indexe", () => {
  const table = parseCsv("Produit;Prix;Devise\nKeytruda;4500;DZD\nOpdivo;3800;DZD", "Tarifs")!;

  it("chaque ligne redevient une association colonne/valeur", () => {
    const [chunk] = chunksFromTables([table]);
    expect(chunk.text).toContain("Produit: Keytruda");
    expect(chunk.text).toContain("Prix: 4500");
  });

  it("le morceau est CITABLE — il porte le nom de sa feuille", () => {
    const [chunk] = chunksFromTables([table]);
    expect(chunk.label).toBe("Feuille Tarifs");
    expect(chunk.locator).toBe("Tarifs");
    expect(chunk.kind).toBe("table");
  });

  it("le texte annonce ses colonnes — un nom de colonne est de l'information", () => {
    // Sans cela, chercher « devise » ne trouverait pas un fichier dont aucune CELLULE ne
    // contient ce mot mais dont une colonne s'appelle ainsi.
    expect(tablesToText([table])).toContain("colonnes : Produit, Prix, Devise");
  });
});

describe("classeur XLSX — on n'analyse que ce qui sert (audit performance PERF-07)", () => {
  it("une feuille plus longue que le plafond : les premières lignes gardées, le total RÉEL compté", async () => {
    const XLSX = await import("xlsx");
    const lignes = [["Titre du rapport"], [], ["Produit", "Wilaya", "Qté"]];
    for (let i = 0; i < MAX_SHEET_ROWS + 500; i += 1) lignes.push([`P${i}`, `W${i % 58}`, String(i)]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lignes), "Ventes");
    const [t] = await parseWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(t.headers).toEqual(["Produit", "Wilaya", "Qté"]);
    expect(t.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(t.rows[0]).toEqual({ Produit: "P0", Wilaya: "W0", "Qté": "0" });
    expect(t.totalRows).toBe(MAX_SHEET_ROWS + 500);
  });

  it("une feuille courte : lue en entier, total exact", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["A", "B"], ["1", "x"], ["2", "y"]]), "F");
    const [t] = await parseWorkbook(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    expect(t.totalRows).toBe(2);
  });
});
