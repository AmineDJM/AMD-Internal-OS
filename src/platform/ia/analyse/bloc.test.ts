import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { appliquerEtapes } from "./pipeline";
import { composerAnalyse, formatDe } from "./bloc";
import { formuleDe } from "./journal";
import { enClair, filtrerLignes, totauxDe, trierLignes, versCsv } from "./affichage";
import { lireTableur } from "./tableur";
import { octetsClasseurAnalyse, specClasseurAnalyse } from "./classeur";
import { lireBlocAnalyse } from "./lecture";

/** K1 (décision 0031) — le composeur, la lecture typée des tableurs, le classeur : chaque chiffre vient du code. */

const ventes = [
  { societe: "Adventum", mois: "2026-01", montant: 1_200_000, statut: "PAYE" },
  { societe: "Adventum", mois: "2026-02", montant: 800_000, statut: "PAYE" },
  { societe: "Kwality", mois: "2026-01", montant: 450_500.5, statut: "EN_ATTENTE" },
  { societe: "Kwality", mois: "2026-02", montant: 300_000, statut: "PAYE" },
  { societe: "Pharmagene", mois: "2026-02", montant: 99_499.5, statut: "PAYE" },
];

describe("composerAnalyse — des lignes calculées au bloc", () => {
  const etapes = [{ op: "regrouper", par: ["societe"], mesures: [{ colonne: "montant", agregat: "sum" }, { agregat: "count", alias: "n" }] }, { op: "trier", colonne: "sum_montant", sens: "desc" }];
  const r = appliquerEtapes(ventes, etapes);
  const { bloc, resume } = composerAnalyse({ titre: "Ventes par société", source: "lecture test", sources: ["lecture test"], lignes: r.lignes, entree: ventes, moteur: "test", pipeline: { etapes, ...r, erreurs: r.erreurs } });

  it("les formats suivent le pipeline : somme(montant) en DZD, un compte en entier", () => {
    expect(bloc.colonnes.map((c) => [c.cle, c.format])).toEqual([["societe", "texte"], ["sum_montant", "dzd"], ["n", "entier"]]);
    expect(bloc.colonnes[1].libelle).toBe("Somme montant");
  });

  it("les cellules sont des NOMBRES, les totaux sont la somme exacte de toutes les lignes", () => {
    expect(bloc.lignes[0]).toEqual(["Adventum", 2_000_000, 2]);
    expect(bloc.totaux).toEqual([null, 2_850_000, 5]);
    expect(resume.totaux).toEqual({ sum_montant: enClair(2_850_000, "dzd"), n: "5" });
  });

  it("le modèle reçoit les chiffres DÉJÀ formatés, et le journal dit les formules", () => {
    expect(resume.apercu[1].sum_montant).toBe(enClair(750_500.5, "dzd"));
    expect(bloc.journal.etapes.map((e) => e.formule)).toEqual(["par societe : somme(montant) → sum_montant ; nombre de lignes → n", "tri décroissant sur sum_montant"]);
    expect(bloc.journal.etapes[0]).toMatchObject({ avant: 5, apres: 3 });
  });

  it("un graphique est choisi (barres, axe à zéro) et construit depuis les lignes", () => {
    expect(bloc.graphiques).toHaveLength(1);
    expect(bloc.graphiques[0].type).toBe("barres");
    expect(bloc.graphiques[0].unite).toBe("DZD");
    expect(bloc.graphiques[0].donnees.series?.[0].valeurs).toEqual([2_000_000, 750_500.5, 99_499.5]);
  });

  it("une forme TROMPEUSE demandée est remplacée, et la note le dit", () => {
    const parMois = appliquerEtapes(ventes, [{ op: "regrouper", par: ["societe", "mois"], mesures: [{ colonne: "montant", agregat: "sum" }] }]).lignes;
    const huit = Array.from({ length: 8 }, (_, i) => ({ produit: `P${i + 1}`, ventes: (i + 1) * 100 }));
    const a = composerAnalyse({ titre: "Parts", source: "s", sources: [], lignes: huit, moteur: "t", graphiques: [{ type: "secteurs" }] });
    expect(a.bloc.graphiques[0].type).toBe("barres");
    expect(a.bloc.graphiques[0].note).toMatch(/tromperait/);
    const groupe = composerAnalyse({ titre: "Groupées", source: "s", sources: [], lignes: parMois, moteur: "t", graphiques: [{ type: "barres_groupees", x: "societe", y: ["sum_montant"], serie: "mois" }] });
    expect(groupe.bloc.graphiques[0].type).toBe("barres");
    expect(groupe.bloc.graphiques[0].donnees.series?.map((s) => s.label)).toEqual(["2026-01", "2026-02"]);
    const heat = composerAnalyse({ titre: "Carte", source: "s", sources: [], lignes: parMois, moteur: "t", graphiques: [{ type: "heatmap", x: "societe", y: ["sum_montant"], serie: "mois" }] });
    expect(heat.bloc.graphiques[0].type).toBe("heatmap");
  });

  it("une série mensuelle : `valeur` hérite du format de la mesure, la croissance est en %", () => {
    const e = [{ op: "serie", colonneDate: "mois", mesure: { colonne: "montant", agregat: "sum" }, pas: "mois" }, { op: "croissance", colonne: "valeur" }];
    const lignes = ventes.map((v) => ({ ...v, mois: `${v.mois}-01` }));
    const rr = appliquerEtapes(lignes, e);
    const a = composerAnalyse({ titre: "Évolution", source: "s", sources: [], lignes: rr.lignes, entree: lignes, moteur: "t", pipeline: { etapes: e, ...rr } });
    expect(Object.fromEntries(a.bloc.colonnes.map((c) => [c.cle, c.format]))).toEqual({ periode: "texte", valeur: "dzd", n: "entier", croissance_valeur: "pourcent" });
    // (1 199 499,5 − 1 650 500,5) ÷ 1 650 500,5 = −27,32 %, arrondi au dixième.
    expect(a.bloc.lignes[1][3]).toBe(-27.3);
    expect(a.bloc.totaux?.[3]).toBeNull();
  });

  it("une seule unité par axe, même quand le modèle demande deux mesures (CA en DZD et nombre de ventes)", () => {
    const lignes = [{ periode: "2026-01", valeur: 1_650_500.5, n: 3 }, { periode: "2026-02", valeur: 1_199_499.5, n: 2 }, { periode: "2026-03", valeur: 900_000, n: 1 }];
    const a = composerAnalyse({ titre: "CA", source: "s", sources: [], lignes, moteur: "t", formats: { valeur: "dzd" }, graphiques: [{ type: "courbe", x: "periode", y: ["valeur", "n"] }] });
    expect(a.bloc.graphiques[0].donnees.series?.map((x) => x.label)).toEqual(["valeur"]);
  });

  it("formatDe : un taux est un pourcentage, un texte reste un texte, une date ISO une date", () => {
    expect(formatDe("taux_consommation", [12.5, 40])).toBe("pourcent");
    expect(formatDe("statut", ["PAYE", "EN_ATTENTE"])).toBe("texte");
    expect(formatDe("echeance", ["2026-02-01", "2026-03-04"])).toBe("date");
  });
});

describe("journal — chaque étape a sa formule lisible", () => {
  it("filtrer, série, anomalies", () => {
    expect(formuleDe({ op: "filtrer", filtres: [{ colonne: "statut", op: "=", valeur: "PAYE" }, { colonne: "montant", op: ">=", valeur: 1000 }] })).toBe("garder les lignes où statut = « PAYE » et montant ≥ « 1000 »");
    expect(formuleDe({ op: "serie", colonneDate: "date", mesure: { colonne: "montant", agregat: "sum" }, pas: "trimestre" })).toMatch(/^série trimestrielle de somme\(montant\) sur date/);
    expect(formuleDe({ op: "anomalies", colonne: "montant" })).toContain("MAD");
  });
});

describe("affichage — tri, filtre, totaux, CSV", () => {
  const colonnes = [{ cle: "s", libelle: "Société", format: "texte" as const }, { cle: "m", libelle: "Montant", format: "dzd" as const }];
  const lignes = [["Kwality", 750_500.5], ["Adventum", 2_000_000], ["Pharmagène", null]];
  it("trie les nombres comme des nombres, le vide à la fin", () => {
    expect(trierLignes(lignes, 1, "desc").map((r) => r[0])).toEqual(["Adventum", "Kwality", "Pharmagène"]);
    expect(trierLignes(lignes, 1, "asc").map((r) => r[0])).toEqual(["Kwality", "Adventum", "Pharmagène"]);
  });
  it("filtre sans accents, total des lignes visibles", () => {
    const f = filtrerLignes(lignes, colonnes, "pharmagene");
    expect(f).toHaveLength(1);
    expect(totauxDe(lignes, [false, true])).toEqual([null, 2_750_500.5]);
  });
  it("CSV au point-virgule, BOM, décimale à la virgule", () => {
    expect(versCsv(colonnes, lignes)).toBe("﻿Société;Montant\r\nKwality;750500,5\r\nAdventum;2000000\r\nPharmagène;\r\n");
  });
});

describe("tableur — lecture TYPÉE", () => {
  it("un xlsx : titre au-dessus du tableau sauté, nombres, dates, formules → valeur (et formules non calculées comptées)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Janvier");
    ws.addRow(["Rapport des ventes — janvier 2026"]);
    ws.addRow(["Produit", "Quantité", "Prix", "Total", "Date"]);
    ws.addRow(["Doliprane", 10, 120.5, { formula: "B3*C3", result: 1205 }, new Date(Date.UTC(2026, 0, 5))]);
    ws.addRow(["Augmentin", 4, 900, { formula: "B4*C4" }, new Date(Date.UTC(2026, 0, 9))]);
    wb.addWorksheet("Vide");
    const lu = await lireTableur(Buffer.from(await wb.xlsx.writeBuffer()), "ventes.xlsx");
    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(lu.feuilles).toHaveLength(1);
    const f = lu.feuilles[0];
    expect(f.ligneEntete).toBe(2);
    expect(f.lignes[0]).toEqual({ Produit: "Doliprane", "Quantité": 10, Prix: 120.5, Total: 1205, Date: "2026-01-05" });
    expect(f.formules).toBe(2);
    expect(f.formulesSansValeur).toBe(1);
    expect(f.colonnes.find((c) => c.nom === "Quantité")?.type).toBe("nombre");
  });

  it("un CSV français : « 12 345,50 » devient 12345.5, un code à zéro de tête reste un texte", async () => {
    const csv = "Code;Libellé;Montant;Date\n0012;Prime;12 345,50;03/02/2026\n0013;Frais;1.250,00;04/02/2026\n";
    const lu = await lireTableur(Buffer.from(csv, "utf8"), "frais.csv");
    expect(lu.ok && lu.feuilles[0].lignes[0]).toEqual({ Code: "0012", "Libellé": "Prime", Montant: 12345.5, Date: "2026-02-03" });
    expect(lu.ok && lu.feuilles[0].lignes[1].Montant).toBe(1250);
  });
});

describe("classeur — un Excel propre et vérifié", () => {
  const r = appliquerEtapes(ventes, [{ op: "regrouper", par: ["societe"], mesures: [{ colonne: "montant", agregat: "sum" }] }]);
  const { bloc } = composerAnalyse({ titre: "Ventes", source: "lecture", sources: ["lecture"], lignes: r.lignes, entree: ventes, moteur: "test", pipeline: { etapes: [{ op: "regrouper", par: ["societe"], mesures: [{ colonne: "montant", agregat: "sum" }] }], ...r } });

  it("la spécification : en-tête figé, filtre, formats DZD, totaux en formules, feuille Méthode", () => {
    const spec = specClasseurAnalyse(bloc);
    expect(spec.feuilles.map((f) => f.nom)).toEqual(["Analyse", "Graphique 1", "Méthode"]);
    expect(spec.feuilles[0]).toMatchObject({ figerEntete: true, filtre: true, totaux: { c2: "SUM" } });
    expect(spec.feuilles[0].colonnes[1].format).toBe('#,##0.00 "DZD"');
    expect(spec.feuilles[2].lignes.map((l) => l.rubrique)).toContain("Étape 1 — regrouper");
  });

  it("les octets : la formule du total est recalculée et VÉRIFIÉE (2 850 000), le filtre posé", async () => {
    const o = await octetsClasseurAnalyse(bloc, "Banc");
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(o.octets as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Analyse")!;
    const total = ws.getCell("B5").value as { formula: string; result: number };
    expect(total.formula).toBe("SUM(B2:B4)");
    expect(total.result).toBe(2_850_000);
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("relu depuis l'écran : borné, typé ; les totaux ne sont pas crus (le classeur les recalcule)", () => {
    const lu = lireBlocAnalyse({ ...bloc, totaux: [null, 999, null], lignes: [["X", 1], ["Y", "<script>"], ["Z", Infinity]] });
    expect(lu?.lignes).toEqual([["X", 1], ["Y", "<script>"], ["Z", null]]);
    expect(lu?.totaux).toEqual([null, 0]);
    expect(lireBlocAnalyse({ colonnes: [] })).toBeNull();
  });
});
