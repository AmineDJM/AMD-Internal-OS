import { describe, expect, it } from "vitest";
import {
  champsDemandes, contientTolerant, filtrer, lirePeriode, normaliserDate, normaliserFiltre, problemesDeDeclaration, projeter, racine, trier,
  type DeclarationVue, type FiltreNormalise,
} from "./vues";
import { anomaliesClasseur, colonneNonAdditive, observerFeuille, observerHtml, occurrences } from "./observation";
import { assainirHtml, blocsDuHtml, CHARTE_ADVENTUM } from "./html";

/**
 * LOT I3 (décision 0065) — les règles PURES des primitives : normaliser ce qui est dit naturellement, filtrer, observer,
 * assainir. Les cas viennent des mesures de l'audit (AU2) : « octobre 2026 » refusé par un outil, « infectieux » qui ne
 * trouvait pas « Infectiologie », la ligne « Total » qui additionnait des téléphones, la balise `<script>`.
 */

const NOV = new Date("2026-11-03T10:00:00Z");
const VUE: DeclarationVue = {
  nom: "produits", description: "test", ecran: "/produits", droit: "Produits",
  champs: [
    { nom: "nom", type: "texte", description: "", source: { modele: "Product", champ: "canonicalName" } },
    { nom: "etape", type: "choix", description: "", source: { regle: "etapeCycle" }, alias: ["cycle"], valeurs: { COMMERCIALISE: ["commercialisé", "sur le marché"], ETUDE: ["étude"] } },
    { nom: "aires", type: "liste", description: "", source: { modele: "RegulatoryProduct", champ: "therapeuticSegments" } },
    { nom: "echeance", type: "date", description: "", source: { modele: "Task", champ: "dueDate" } },
    { nom: "prix", type: "nombre", description: "", source: { modele: "Product", champ: "prix" } },
    { nom: "actif", type: "booleen", description: "", source: { modele: "Product", champ: "isActive" } },
    { nom: "lien", type: "lien", description: "", source: { regle: "lien" } },
  ],
  parDefaut: ["nom", "etape"],
};
const n = (f: { champ: string; op?: string; valeur?: unknown }) => {
  const r = normaliserFiltre(VUE, f, NOV);
  if ("erreur" in r) throw new Error(r.erreur);
  return r as FiltreNormalise;
};

describe("I3 — la normalisation des entrées naturelles (le serveur, pas le modèle)", () => {
  it("« octobre 2026 » → 2026-10 ; « 3 novembre 2026 », « 03/11/2026 », « aujourd'hui », « octobre » (l'année en cours)", () => {
    expect(normaliserDate("octobre 2026", NOV)).toBe("2026-10");
    expect(normaliserDate("Oct. 2026", NOV)).toBe("2026-10");
    expect(normaliserDate("10/2026", NOV)).toBe("2026-10");
    expect(normaliserDate("3 novembre 2026", NOV)).toBe("2026-11-03");
    expect(normaliserDate("1er décembre", NOV)).toBe("2026-12-01");
    expect(normaliserDate("03/11/2026", NOV)).toBe("2026-11-03");
    expect(normaliserDate("aujourd'hui", NOV)).toBe("2026-11-03");
    expect(normaliserDate("octobre", NOV)).toBe("2026-10");
    expect(normaliserDate("le mois dernier", NOV)).toBe("2026-10");
    expect(lirePeriode("n'importe quoi", NOV)).toBeNull();
  });

  it("un choix se dit par son code, son libellé, un mot naturel, au pluriel, sans accents ; un champ par son alias", () => {
    expect(n({ champ: "etape", valeur: "commercialisé" }).valeur).toBe("COMMERCIALISE");
    expect(n({ champ: "Cycle", valeur: "COMMERCIALISES" }).valeur).toBe("COMMERCIALISE");
    expect(n({ champ: "etape", valeur: "sur le marche" }).valeur).toBe("COMMERCIALISE");
    const e = normaliserFiltre(VUE, { champ: "etape", valeur: "brevet" }, NOV);
    expect("erreur" in e && e.erreur).toMatch(/valeurs : COMMERCIALISE \(commercialisé\), ETUDE/);
    expect("erreur" in normaliserFiltre(VUE, { champ: "salaire", valeur: 1 }, NOV)).toBe(true);
  });

  it("opérateurs dits autrement (« superieur », « dans », « egal ») ; nombres « 1 200,50 » ; oui / non", () => {
    expect(n({ champ: "prix", op: "superieur", valeur: "1 200,50" })).toMatchObject({ op: ">", valeur: 1200.5 });
    expect(n({ champ: "etape", op: "dans", valeur: "commercialisé, étude" }).valeur).toEqual(["COMMERCIALISE", "ETUDE"]);
    expect(n({ champ: "actif", op: "egal", valeur: "oui" }).valeur).toBe(true);
  });

  it("« infectieux » trouve « Infectiologie & Réanimation » et « Anti-infectieux » (racines) ; pas « Cardiologie »", () => {
    expect(racine("infectieux")).toBe("infect");
    expect(contientTolerant("Infectiologie & Réanimation", "infectieux")).toBe(true);
    expect(contientTolerant("Anti-infectieux", "infectiologie")).toBe(true);
    expect(contientTolerant("Cardiologie", "infectieux")).toBe(false);
  });

  it("filtrer, trier, projeter : une liste se filtre par un de ses éléments ; une date au mois ; les vides en dernier", () => {
    const lignes = [
      { nom: "Amoxil", etape: "COMMERCIALISE", aires: ["Infectiologie"], echeance: "2026-10-14", prix: 900, actif: true, lien: "/produits/1" },
      { nom: "Posaconazole", etape: "ENREGISTREMENT", aires: ["Infectiologie & Réanimation"], echeance: "2026-11-02", prix: null, actif: true, lien: "/produits/2" },
      { nom: "Xarelto", etape: "COMMERCIALISE", aires: ["Hématologie"], echeance: null, prix: 2000, actif: true, lien: "/produits/3" },
    ];
    const vendusInfect = filtrer(lignes, [n({ champ: "etape", valeur: "commercialisé" }), n({ champ: "aires", op: "contient", valeur: "infectieux" })]);
    expect(vendusInfect.map((l) => l.nom)).toEqual(["Amoxil"]);
    expect(filtrer(lignes, [n({ champ: "echeance", valeur: "octobre 2026" })]).map((l) => l.nom)).toEqual(["Amoxil"]);
    expect(filtrer(lignes, [n({ champ: "echeance", op: "<", valeur: "novembre 2026" })]).map((l) => l.nom)).toEqual(["Amoxil"]);
    expect(trier(lignes, VUE.champs[4]!, "desc").map((l) => l.nom)).toEqual(["Xarelto", "Amoxil", "Posaconazole"]);
    const d = champsDemandes(VUE, ["nom"]);
    expect("champs" in d && d.champs.map((c) => c.nom)).toEqual(["nom", "lien"]); // le lien suit toujours
    expect(projeter(lignes.slice(0, 1), "champs" in d ? d.champs : [])).toEqual([{ nom: "Amoxil", lien: "/produits/1" }]);
  });

  it("une déclaration qui porte une colonne du coffre, ou un champ au nom de rémunération, est refusée", () => {
    expect(problemesDeDeclaration(VUE, () => false)).toEqual([]);
    const fautive: DeclarationVue = { ...VUE, champs: [...VUE.champs, { nom: "rib", type: "texte", description: "", source: { modele: "Employee", champ: "iban" } }, { nom: "salaireBrut", type: "nombre", description: "", source: { regle: "x" } }] };
    const p = problemesDeDeclaration(fautive, (m, c) => m === "Employee" && c === "iban");
    expect(p.join("\n")).toMatch(/rib : colonne du coffre \(Employee\.iban\)/);
    expect(p.join("\n")).toMatch(/salaireBrut : donnée du coffre/);
  });
});

describe("I3 — l'observation : ce que la personne verra, décrit par le code", () => {
  it("la ligne « Total » qui additionne les téléphones est une ANOMALIE ; un tableau sérialisé aussi ; aucun total = aucun", () => {
    const f = observerFeuille("Analyse", [
      ["Nom", "Téléphone", "Secteurs", "CA"],
      ["Pharmacie A", "041 22 33 44", "[\"Ouest — Oran\"]", 100],
      ["Pharmacie B", "041 55 66 77", "Ouest", 200],
      ["Total", "=SUM(B2:B3)", "", "=SUM(D2:D3)"],
    ]);
    expect(f).toMatchObject({ lignes: 2, totaux: [{ libelle: "Total", colonnes: ["Téléphone", "CA"] }], cellulesJson: 1 });
    const a = anomaliesClasseur([f]).join("\n");
    expect(a).toMatch(/additionne Téléphone/);
    expect(a).not.toMatch(/additionne .*CA/);
    expect(a).toMatch(/tableau sérialisé/);
    expect(anomaliesClasseur([observerFeuille("F", [["nom", "statut"], ["x", ""]])])).toEqual([]);
    expect(colonneNonAdditive("Numéro de téléphone")).toBe(true);
    expect(colonneNonAdditive("Montant")).toBe(false);
  });

  it("un remplacement se compte dans le texte réellement écrit", () => {
    expect(occurrences("Date : 14 octobre 2026 ; 14 octobre 2026", "14 octobre 2026")).toBe(2);
  });
    const b = observationDe({ type: "fichier", id: "1", lien: null }, "ECRIT", { a: [1, 2], b: 1 });
    const c = observationDe({ type: "fichier", id: "1", lien: null }, "ECRIT", { a: [1, 2], b: 2 });
    expect(a.empreinte).toBe(b.empreinte);
    expect(a.empreinte).not.toBe(c.empreinte);
    expect(occurrences("Date : 14 octobre 2026 ; 14 octobre 2026", "14 octobre 2026")).toBe(2);
  });
});

describe("I3 — le HTML libre, assaini (liste blanche) ; la charte par défaut, rien en « libre »", () => {
  it("script, iframe, onclick, url(), javascript: et position sont retirés ; les styles permis restent", () => {
    const r = assainirHtml(`<script>alert(1)</script><p onclick="x()" style="color:#c00;background:url(http://x);position:fixed">Bonjour <a href="javascript:alert(1)">lien</a> <a href="https://adventum.dz">site</a></p><iframe src="x"></iframe><img src=x onerror=y>`, "libre");
    expect(r.html).toBe(`<p style="color:#c00">Bonjour <a>lien</a> <a href="https://adventum.dz">site</a></p>`);
    expect(r.balisesRetirees.sort()).toEqual(["iframe", "img", "script"]);
  });

  it("professionnelle : en-têtes de tableau et titres à la charte quand rien n'est écrit ; « libre » : rien d'ajouté ; class=charte : là seulement", () => {
    const pro = assainirHtml("<h1>Planning</h1><table><tr><th>Jour</th></tr><tr><td>Lundi</td></tr></table>");
    expect(pro.html).toContain(`<th style="background-color:${CHARTE_ADVENTUM.accent}`);
    expect(observerHtml(pro.html)).toMatchObject({ tableaux: 1, titres: 1, couleurs: expect.arrayContaining([CHARTE_ADVENTUM.accent]) });
    const libre = assainirHtml("<h1>Planning</h1><table><tr><th>Jour</th></tr></table><p>simple</p>", "libre");
    expect(libre.html).toBe("<h1>Planning</h1><table><tr><th>Jour</th></tr></table><p>simple</p>");
    const moitie = assainirHtml("<table class=\"charte\"><tr><th class=\"charte\">Jour</th></tr></table><p>texte simple</p>", "libre");
    expect(observerHtml(moitie.html)).toMatchObject({ elementsStyles: { table: 1, th: 1 }, paragraphes: 1 });
    expect(moitie.html).toContain("<p>texte simple</p>");
  });

  it("les blocs : titres, paragraphes (gras, couleur), listes, tableaux — un tableau dans un div reste un tableau", () => {
    const b = blocsDuHtml(assainirHtml("<div><h2>Titre</h2><p>Un <strong>mot</strong> <span style=\"color:#087084\">coloré</span></p><ul><li>a</li><li>b</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div>libre", "libre").html);
    expect(b.map((x) => x.type)).toEqual(["titre", "paragraphe", "liste", "tableau", "paragraphe"]);
    const p = b[1] as Extract<typeof b[number], { type: "paragraphe" }>;
    expect(p.morceaux.find((m) => m.texte === "mot")?.gras).toBe(true);
    expect(p.morceaux.find((m) => m.texte === "coloré")?.couleur).toBe("#087084");
    const t = b[3] as Extract<typeof b[number], { type: "tableau" }>;
    expect(t.lignes[0]!.cellules.every((c) => c.entete)).toBe(true);
  });
});
