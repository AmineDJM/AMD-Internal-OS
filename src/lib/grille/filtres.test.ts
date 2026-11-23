import { describe, it, expect } from "vitest";
import {
  VIDE, plier, jeton, comparer, filtrerEtTrier, valeursDistinctes, filtreDesCoches, avecFiltre, triSuivant, libelleCompte,
  type EtatFeuille,
} from "./filtres";

interface P { nom: string; wilaya: string; specialite: string; patients: string }
const LIGNES: P[] = [
  { nom: "Benali", wilaya: "Alger", specialite: "Cardiologie", patients: "10" },
  { nom: "Haddad", wilaya: "Oran", specialite: "Cardiologie", patients: "9" },
  { nom: "Zerrouki", wilaya: "Alger", specialite: "", patients: "" },
  { nom: "Amrani", wilaya: "Médéa", specialite: "Pédiatrie", patients: "100" },
  { nom: "benali", wilaya: "  ", specialite: "Pédiatrie", patients: "2" },
];
const acces = (l: P, cle: string) => String(l[cle as keyof P] ?? "");
const bottes = LIGNES.map((l) => plier(Object.values(l).join(" ")));
const etat = (e: Partial<EtatFeuille> = {}): EtatFeuille => ({ recherche: "", filtres: {}, tri: null, ...e });
const noms = (ls: P[]) => ls.map((l) => l.nom);

describe("Les filtres d'une feuille — le filtre automatique d'Excel", () => {
  it("sans filtre ni recherche ni tri, la feuille montre tout, dans l'ordre du serveur", () => {
    expect(noms(filtrerEtTrier(LIGNES, etat(), acces, bottes))).toEqual(["Benali", "Haddad", "Zerrouki", "Amrani", "benali"]);
  });

  it("un filtre de colonne ne garde que les valeurs cochées ; deux filtres se cumulent (ET)", () => {
    expect(noms(filtrerEtTrier(LIGNES, etat({ filtres: { wilaya: ["Alger"] } }), acces, bottes))).toEqual(["Benali", "Zerrouki"]);
    expect(noms(filtrerEtTrier(LIGNES, etat({ filtres: { wilaya: ["Alger", "Oran"], specialite: ["Cardiologie"] } }), acces, bottes)))
      .toEqual(["Benali", "Haddad"]);
  });

  it("« (Vides) » attrape les cellules vides ET celles faites d'espaces ; une liste vide ne laisse rien passer", () => {
    expect(noms(filtrerEtTrier(LIGNES, etat({ filtres: { wilaya: [VIDE] } }), acces, bottes))).toEqual(["benali"]);
    expect(noms(filtrerEtTrier(LIGNES, etat({ filtres: { specialite: [VIDE, "Pédiatrie"] } }), acces, bottes))).toEqual(["Zerrouki", "Amrani", "benali"]);
    expect(filtrerEtTrier(LIGNES, etat({ filtres: { wilaya: [] } }), acces, bottes)).toEqual([]);
  });

  it("la recherche globale exige tous les mots, accents et majuscules mis à part", () => {
    expect(noms(filtrerEtTrier(LIGNES, etat({ recherche: "MEDEA" }), acces, bottes))).toEqual(["Amrani"]);
    expect(noms(filtrerEtTrier(LIGNES, etat({ recherche: "cardio  alger" }), acces, bottes))).toEqual(["Benali"]);
    expect(noms(filtrerEtTrier(LIGNES, etat({ recherche: "   " }), acces, bottes))).toHaveLength(5);
  });

  it("le tri compare comme un humain (9 avant 10), ignore la casse, et range les vides en bas dans les deux sens", () => {
    const asc = filtrerEtTrier(LIGNES, etat({ tri: { cle: "patients", sens: "asc" } }), acces, bottes);
    expect(asc.map((l) => l.patients)).toEqual(["2", "9", "10", "100", ""]);
    const desc = filtrerEtTrier(LIGNES, etat({ tri: { cle: "patients", sens: "desc" } }), acces, bottes);
    expect(desc.map((l) => l.patients)).toEqual(["100", "10", "9", "2", ""]);
    // Stable : « Benali » et « benali » sont égaux pour le tri — l'ordre du serveur demeure.
    expect(noms(filtrerEtTrier(LIGNES, etat({ tri: { cle: "nom", sens: "asc" } }), acces, bottes)))
      .toEqual(["Amrani", "Benali", "benali", "Haddad", "Zerrouki"]);
    expect(comparer("", "a", "desc")).toBeGreaterThan(0);
  });

  it("la liste d'une colonne compte ses valeurs, « (Vides) » en dernier, et ne propose que ce que les AUTRES filtres laissent", () => {
    expect(valeursDistinctes(LIGNES, "wilaya", acces)).toEqual([
      { valeur: "Alger", nombre: 2 }, { valeur: "Médéa", nombre: 1 }, { valeur: "Oran", nombre: 1 }, { valeur: VIDE, nombre: 1 },
    ]);
    // Avec « Cardiologie » posé, la liste des wilayas ne propose plus que celles qui restent…
    const e = etat({ filtres: { specialite: ["Cardiologie"], wilaya: ["Alger"] } });
    const sansWilaya = filtrerEtTrier(LIGNES, e, acces, bottes, "wilaya");
    expect(valeursDistinctes(sansWilaya, "wilaya", acces).map((v) => v.valeur)).toEqual(["Alger", "Oran"]);
  });

  it("tout coché = pas de filtre ; le filtre d'une colonne se pose et se retire sans toucher aux autres", () => {
    expect(filtreDesCoches(["a", "b"], new Set(["a", "b"]))).toBeNull();
    expect(filtreDesCoches(["a", "b", VIDE], new Set([VIDE, "b"]))).toEqual(["b", VIDE]);
    const f = avecFiltre({ wilaya: ["Alger"] }, "specialite", ["Cardiologie"]);
    expect(f).toEqual({ wilaya: ["Alger"], specialite: ["Cardiologie"] });
    expect(avecFiltre(f, "wilaya", null)).toEqual({ specialite: ["Cardiologie"] });
  });

  it("un clic sur l'en-tête trie A→Z, puis Z→A, puis rend l'ordre d'origine ; une autre colonne repart de A→Z", () => {
    expect(triSuivant(null, "nom")).toEqual({ cle: "nom", sens: "asc" });
    expect(triSuivant({ cle: "nom", sens: "asc" }, "nom")).toEqual({ cle: "nom", sens: "desc" });
    expect(triSuivant({ cle: "nom", sens: "desc" }, "nom")).toBeNull();
    expect(triSuivant({ cle: "nom", sens: "desc" }, "wilaya")).toEqual({ cle: "wilaya", sens: "asc" });
  });

  it("le compte dit le total, et ce qui reste dès qu'un filtre réduit la vue", () => {
    const s = (x: string) => x.replace(/\s/g, " ");
    expect(s(libelleCompte(1234, 1234, false))).toBe("1 234 lignes");
    expect(s(libelleCompte(1234, 56, true))).toBe("1 234 lignes (56 filtrées)");
    expect(libelleCompte(1, 1, true)).toBe("1 ligne (1 filtrée)");
    expect(jeton("  ")).toBe(VIDE);
    expect(jeton(" Oran ")).toBe("Oran");
  });
});
