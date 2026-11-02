import { describe, expect, it } from "vitest";
import {
  comparerOrganisations, comparerPersonnes, estNomCourant, proposerDoublonsOrganisations, proposerDoublonsPersonnes, regrouper,
  type FicheOrganisation, type FichePersonne,
} from "./doublons";

/**
 * Table de cas RÉELS anonymisés : les formes (titres, graphies, numéros, NIF mal saisis, sociétés sœurs)
 * viennent des annuaires de l'ERP ; les personnes et les sociétés sont inventées.
 */

const p = (ref: string, nom: string, o: Partial<FichePersonne> = {}): FichePersonne => ({ ref, nom, ...o });
const o = (ref: string, nom: string, x: Partial<FicheOrganisation> = {}): FicheOrganisation => ({ ref, nom, ...x });

describe("comparerPersonnes — la table des cas", () => {
  const cas: { titre: string; a: FichePersonne; b: FichePersonne; niveau: "CERTAIN" | "PROBABLE" | "POSSIBLE" | null; raison?: RegExp; reserve?: RegExp }[] = [
    {
      titre: "même e-mail personnel, graphies différentes du nom",
      a: p("MedicalDoctor:1", "Dr BENALI Ahmed", { emails: ["Ahmed.Benali@gmail.com"] }),
      b: p("AdProVoyageur:1", "Ahmed Ben Ali", { emails: ["ahmedbenali+congres@gmail.com"] }),
      niveau: "CERTAIN", raison: /même e-mail personnel/,
    },
    {
      titre: "même e-mail mais noms sans rapport : boîte partagée → PROBABLE",
      a: p("MedicalDoctor:2", "Pr Karim Haddad", { emails: ["k.haddad@chu-oran.dz"] }),
      b: p("CareBeneficiary:2", "Nadia Slimani", { emails: ["k.haddad@chu-oran.dz"] }),
      niveau: "PROBABLE", reserve: /boîte partagée/,
    },
    {
      titre: "boîte générique (secretariat@) : ne compte pas",
      a: p("MedicalDoctor:3", "Dr Yacine Zerrouki", { emails: ["secretariat@clinique-elnour.dz"] }),
      b: p("MedicalDoctor:4", "Dr Lamia Ferhat", { emails: ["secretariat@clinique-elnour.dz"] }),
      niveau: null, reserve: /boîte générique/,
    },
    {
      titre: "même mobile, même nom (ordre inversé) → PROBABLE",
      a: p("Employee:1", "Raihana Cherif", { telephones: ["0555 12 34 56"] }),
      b: p("User:1", "CHERIF Raihana", { telephones: ["+213555123456"] }),
      niveau: "PROBABLE", raison: /même mobile/,
    },
    {
      titre: "même mobile, noms différents → POSSIBLE (famille, numéro réattribué)",
      a: p("AdProVoyageur:2", "Sofiane Mebarki", { telephones: ["0661 00 11 22"] }),
      b: p("AdProVoyageur:3", "Meriem Toumi", { telephones: ["0661001122"] }),
      niveau: "POSSIBLE", reserve: /famille/,
    },
    {
      titre: "même fixe, même nom → PROBABLE ; même fixe, noms différents → rien",
      a: p("MedicalDoctor:5", "Dr Nabil Zerrouki", { telephones: ["021 23 45 67"] }),
      b: p("DirectoryEntry:5", "Nabil Zerrouki", { telephones: ["(021) 23-45-67"] }),
      niveau: "PROBABLE", raison: /fixe/,
    },
    {
      titre: "même fixe, noms différents → rien (le standard d'un service)",
      a: p("MedicalDoctor:6", "Dr Nabil Zerrouki", { telephones: ["021 23 45 67"] }),
      b: p("MedicalDoctor:7", "Dr Samia Kadri", { telephones: ["021 23 45 67"] }),
      niveau: null,
    },
    {
      titre: "même nom et même date de naissance → PROBABLE",
      a: p("Employee:2", "Ould Ali Fatma Zohra", { naissance: "1987-03-14" }),
      b: p("AdProVoyageur:4", "Fatma Zohra OULD-ALI", { naissance: "14/03/1987" }),
      niveau: "PROBABLE", raison: /date de naissance/,
    },
    {
      titre: "même nom, dates de naissance différentes → écarté",
      a: p("Employee:3", "Ould Ali Fatma Zohra", { naissance: "1987-03-14" }),
      b: p("Employee:4", "Fatma Zohra Ould Ali", { naissance: "1962-11-02" }),
      niveau: null, reserve: /pas la même personne/,
    },
    {
      titre: "même nom dans le même établissement → PROBABLE",
      a: p("MedicalDoctor:8", "Pr Abdelkader Zerrouki", { etablissement: "CHU Mustapha Pacha" }),
      b: p("CareBeneficiary:8", "Abd El Kader ZERROUKI", { etablissement: "C.H.U Mustapha-Pacha" }),
      niveau: "PROBABLE", raison: /même établissement/,
    },
    {
      titre: "même nom à la graphie près, même établissement → POSSIBLE",
      a: p("MedicalDoctor:9", "Dr Abdulkader Zerrouki", { etablissementId: "inst-1" }),
      b: p("CareBeneficiary:9", "Abdelkader Zerouki", { etablissementId: "inst-1" }),
      niveau: "POSSIBLE",
    },
    {
      titre: "même nom phonétique, même wilaya → POSSIBLE",
      a: p("MedicalDoctor:10", "Dr Youcef Tighilt", { wilaya: "16 - Alger" }),
      b: p("MedicalDoctor:11", "Youssef TIGHILT", { wilaya: "Alger" }),
      niveau: "POSSIBLE", raison: /même wilaya \(alger\)/,
    },
    {
      titre: "même nom rare, rien d'autre → POSSIBLE",
      a: p("AdProHebergement:1", "Zerrouki Nesrine"),
      b: p("AdProVoyageur:5", "Nesrine Zerrouki"),
      niveau: "POSSIBLE", raison: /rien d'autre/,
    },
    {
      titre: "même nom rare, wilayas différentes → rien",
      a: p("MedicalDoctor:12", "Dr Nesrine Zerrouki", { wilaya: "Oran" }),
      b: p("MedicalDoctor:13", "Dr Nesrine Zerrouki", { wilaya: "Annaba" }),
      niveau: null,
    },
    {
      titre: "homonyme courant par le nom seul → rien",
      a: p("AdProVoyageur:6", "Mohamed Benali"),
      b: p("AdProVoyageur:7", "Mohammed Ben Ali"),
      niveau: null,
    },
    {
      titre: "homonyme courant, même wilaya → rien",
      a: p("MedicalDoctor:14", "Dr Mohamed Benali", { wilaya: "Oran" }),
      b: p("MedicalDoctor:15", "Mohamed Benali", { wilaya: "31" }),
      niveau: null, reserve: /nom très courant/,
    },
    {
      titre: "homonyme courant, même établissement → POSSIBLE (abaissé d'un cran)",
      a: p("MedicalDoctor:16", "Dr Mohamed Benali", { etablissement: "EHS Canastel" }),
      b: p("CareBeneficiary:16", "Mohamed Benali", { etablissement: "EHS CANASTEL" }),
      niveau: "POSSIBLE", reserve: /nom très courant/,
    },
    {
      titre: "homonyme courant, même mobile → PROBABLE (le mobile compte, pas le nom)",
      a: p("MedicalDoctor:17", "Dr Mohamed Benali", { telephones: ["0770 11 22 33"] }),
      b: p("AdProVoyageur:17", "Mohamed Benali", { telephones: ["0770112233"] }),
      niveau: "PROBABLE",
    },
    {
      titre: "même NIN → CERTAIN, même avec des noms écrits autrement",
      a: p("Employee:5", "Benyahia Imane", { nin: "1099 8765 4321 0001 23" }),
      b: p("Employee:6", "Imène Ben Yahia", { nin: "109987654321000123" }),
      niveau: "CERTAIN", raison: /même NIN/,
    },
    {
      titre: "NIN différents → écarté, quel que soit le reste",
      a: p("Employee:7", "Imane Benyahia", { nin: "109987654321000123", telephones: ["0555 98 76 54"] }),
      b: p("Employee:8", "Imane Benyahia", { nin: "209987654321000999", telephones: ["0555 98 76 54"] }),
      niveau: null, reserve: /deux personnes distinctes/,
    },
    {
      titre: "lien existant dans l'ERP → CERTAIN",
      a: p("Employee:9", "Samir Kadri", { liens: ["User:9"] }),
      b: p("User:9", "S. Kadri"),
      niveau: "CERTAIN", raison: /déjà reliées/,
    },
    {
      titre: "nom de famille seul + même mobile → PROBABLE",
      a: p("MedicalDoctor:18", "Dr Benchikh", { telephones: ["0550 44 55 66"] }),
      b: p("AdProVoyageur:18", "Walid Benchikh", { telephones: ["0550445566"] }),
      niveau: "PROBABLE",
    },
    {
      titre: "noms différents, rien en commun → rien",
      a: p("MedicalDoctor:19", "Dr Karim Haddad", { wilaya: "Oran" }),
      b: p("MedicalDoctor:20", "Dr Karima Haddad", { wilaya: "Oran" }),
      niveau: null,
    },
    {
      titre: "même e-mail, dates de naissance différentes → PROBABLE au plus (pas CERTAIN)",
      a: p("Employee:10", "Lamia Ferhat", { emails: ["lamia.ferhat@adventum.dz"], naissance: "1990-01-01" }),
      b: p("User:10", "Lamia Ferhat", { emails: ["lamia.ferhat@adventum.dz"], naissance: "1991-01-01" }),
      niveau: "POSSIBLE", reserve: /dates de naissance différentes/,
    },
  ];

  it.each(cas)("$titre", ({ a, b, niveau, raison, reserve }) => {
    const r = comparerPersonnes(a, b);
    expect(r.niveau).toBe(niveau);
    if (raison) expect(r.raisons.join(" · ")).toMatch(raison);
    if (reserve) expect(r.reserves.join(" · ")).toMatch(reserve);
    // Symétrique : l'ordre des fiches ne change rien.
    expect(comparerPersonnes(b, a).niveau).toBe(niveau);
  });

  it("jamais CERTAIN sans identifiant fort, même avec mobile + nom + naissance + établissement", () => {
    const a = p("x", "Nesrine Zerrouki", { telephones: ["0555 11 22 33"], naissance: "1980-05-05", etablissement: "CHU Oran" });
    const b = p("y", "Nesrine Zerrouki", { telephones: ["0555112233"], naissance: "1980-05-05", etablissement: "CHU Oran" });
    const r = comparerPersonnes(a, b);
    expect(r.niveau).toBe("PROBABLE");
    expect(r.raisons.length).toBeGreaterThanOrEqual(3);
    // Plus d'indices = un score plus haut dans le même niveau.
    expect(r.score).toBeGreaterThan(comparerPersonnes(p("x", "Nesrine Zerrouki", { naissance: "1980-05-05" }), p("y", "Nesrine Zerrouki", { naissance: "1980-05-05" })).score);
  });

  it("un numéro partagé (le standard) ne compte pas", () => {
    const r = comparerPersonnes(
      p("a", "Nabil Zerrouki", { telephones: ["0555 00 00 01"] }),
      p("b", "Nabil Zerroukii", { telephones: ["0555000001"] }),
      { telephonesPartages: new Set(["+213555000001"]) },
    );
    expect(r.reserves.join(" ")).toMatch(/standard/);
    expect(r.raisons.join(" ")).not.toMatch(/mobile/);
  });
});

describe("estNomCourant", () => {
  it.each(["Mohamed Benali", "Mohammed Ben Ali", "Fatima Brahimi", "Ahmed Saidi", "Dr Amine Haddad"])("« %s » est courant", (n) => {
    expect(estNomCourant(n)).toBe(true);
  });
  it.each(["Nesrine Zerroukia", "Mohamed Ouchene", "Mohamed Amine", "Lynda Tighilt"])("« %s » ne l'est pas", (n) => {
    expect(estNomCourant(n)).toBe(false);
  });
});

describe("comparerOrganisations — la table des cas", () => {
  const groupe = { nifs: ["000116001234567"], rcs: ["16/00-0012345 B 15"] };
  const cas: { titre: string; a: FicheOrganisation; b: FicheOrganisation; niveau: "CERTAIN" | "PROBABLE" | "POSSIBLE" | null; raison?: RegExp; reserve?: RegExp }[] = [
    {
      titre: "même NIF écrit autrement → CERTAIN",
      a: o("Supplier:1", "Imprimerie du Centre SARL", { nif: "001 916 012 345 678" }),
      b: o("CompanyContact:1", "IMPRIMERIE DU CENTRE", { nif: "001916012345678" }),
      niveau: "CERTAIN", raison: /même NIF/,
    },
    {
      titre: "même RC → CERTAIN",
      a: o("CompanyContact:2", "Hôtel El Djazair", { rc: "16/00-1234567 B 21" }),
      b: o("CompanyContact:3", "SPA Hotel El-Djazair", { rc: "16/00-1234567B21" }),
      niveau: "CERTAIN",
    },
    {
      titre: "même NIF, RC différents → PROBABLE (erreur de saisie)",
      a: o("CompanyContact:4", "Prombati Hotel", { nif: "001916012345678", rc: "16/00-1234567 B 21" }),
      b: o("Supplier:4", "SPA Prombati Hotel", { nif: "001916012345678", rc: "31/00-7654321 B 09" }),
      niveau: "PROBABLE", reserve: /erreur de saisie/,
    },
    {
      titre: "même NIF, noms sans rapport → PROBABLE (identifiant recopié ?)",
      a: o("CompanyContact:5", "Transports Rapides de l'Est", { nif: "099916012345678" }),
      b: o("CompanyContact:6", "Clinique El Nour", { nif: "099916012345678" }),
      niveau: "PROBABLE", reserve: /recopié/,
    },
    {
      titre: "NIF du GROUPE recopié sur deux fournisseurs → ne compte pas",
      a: o("Supplier:7", "Imprimerie du Centre", { nif: "000116001234567" }),
      b: o("Supplier:8", "Traiteur Les Oliviers", { nif: "000116001234567" }),
      niveau: null, reserve: /société du groupe/,
    },
    {
      titre: "le NIF du groupe porté par la société du groupe elle-même ET par un contact → CERTAIN",
      a: o("Company:1", "Adventum Pharma", { nif: "000116001234567", estDuGroupe: true }),
      b: o("CompanyContact:31", "ADVENTUM PHARMA SPA", { nif: "000116001234567" }),
      niveau: "CERTAIN",
    },
    {
      titre: "sociétés d'un même groupe : NIF différents → écarté malgré le domaine commun",
      a: o("CompanyContact:9", "Saidal Médéa", { nif: "000126001111111", emails: ["contact@saidal.dz"] }),
      b: o("CompanyContact:10", "Saidal Constantine", { nif: "000125002222222", emails: ["achats@saidal.dz"] }),
      niveau: null, reserve: /entités juridiques distinctes/,
    },
    {
      titre: "même groupe sans NIF : même domaine → POSSIBLE, avec la réserve",
      a: o("CompanyContact:11", "Saidal Médéa", { emails: ["medea@saidal.dz"] }),
      b: o("CompanyContact:12", "Saidal Constantine", { emails: ["constantine@saidal.dz"] }),
      niveau: "POSSIBLE", reserve: /groupe/,
    },
    {
      titre: "même raison sociale (forme juridique mise à part), même wilaya → PROBABLE",
      a: o("Supplier:13", "Hetero Labs SARL", { wilaya: "Alger" }),
      b: o("CompanyContact:13", "HETERO LABS", { wilaya: "16" }),
      niveau: "PROBABLE",
    },
    {
      titre: "même raison sociale, wilayas différentes → POSSIBLE (agences ?)",
      a: o("MedicalInstitution:14", "Clinique El Nour", { wilaya: "Oran" }),
      b: o("MedicalInstitution:15", "Clinique El Nour", { wilaya: "Sétif" }),
      niveau: "POSSIBLE", reserve: /agences/,
    },
    {
      titre: "même nom, sans wilaya → POSSIBLE",
      a: o("MedicalInstitution:16", "Pharmacie Centrale"),
      b: o("MedicalInstitution:17", "Pharmacie Centrale"),
      niveau: "POSSIBLE",
    },
    {
      titre: "un nom fait de mots génériques seulement ne rapproche rien",
      a: o("MedicalInstitution:18", "Clinique Médicale", { wilaya: "Oran" }),
      b: o("MedicalInstitution:19", "Clinique Médicale", { wilaya: "Oran" }),
      niveau: null,
    },
    {
      titre: "« Distribution » ne distingue pas : même raison sociale, même wilaya → PROBABLE",
      a: o("CompanyContact:20", "Biopharm", { wilaya: "Alger" }),
      b: o("CompanyContact:21", "Biopharm Distribution", { wilaya: "Alger" }),
      niveau: "PROBABLE", raison: /même raison sociale/,
    },
    {
      titre: "un nom contient l'autre → POSSIBLE (même groupe ?)",
      a: o("CompanyContact:26", "Biopharm", { wilaya: "Alger" }),
      b: o("CompanyContact:27", "Biopharm Logistique", { wilaya: "Alger" }),
      niveau: "POSSIBLE", reserve: /même groupe/,
    },
    {
      titre: "même téléphone et même nom → PROBABLE",
      a: o("Supplier:22", "Imprimerie Nouvelle", { telephones: ["023 45 67 89"] }),
      b: o("CompanyContact:22", "Imprimerie Nouvelle SPA", { telephones: ["+213 23 45 67 89"] }),
      niveau: "PROBABLE",
    },
    {
      titre: "même e-mail contact@ : pour une organisation, il compte",
      a: o("Supplier:23", "Atlas Voyages", { emails: ["contact@atlasvoyages.dz"] }),
      b: o("CompanyContact:23", "Atlas Voyages & Tourisme", { emails: ["Contact@AtlasVoyages.dz"] }),
      niveau: "PROBABLE", raison: /même e-mail/,
    },
    {
      titre: "même nom propre, natures différentes (Clinique / Pharmacie) → rien",
      a: o("MedicalInstitution:28", "Clinique El Nour", { wilaya: "Oran" }),
      b: o("CompanyContact:28", "Pharmacie El Nour", { wilaya: "Oran" }),
      niveau: null,
    },
    {
      titre: "sigle écrit avec des points : « E.P.H » = « EPH »",
      a: o("MedicalInstitution:29", "E.P.H Ain Taya", { wilaya: "Alger" }),
      b: o("MedicalInstitution:30", "EPH AIN-TAYA", { wilaya: "16" }),
      niveau: "PROBABLE",
    },
    {
      titre: "noms différents, rien en commun → rien",
      a: o("Supplier:24", "Atlas Voyages", { wilaya: "Alger" }),
      b: o("Supplier:25", "Imprimerie du Centre", { wilaya: "Alger" }),
      niveau: null,
    },
  ];

  it.each(cas)("$titre", ({ a, b, niveau, raison, reserve }) => {
    const r = comparerOrganisations(a, b, { identifiantsGroupe: groupe });
    expect(r.niveau).toBe(niveau);
    if (raison) expect(r.raisons.join(" · ")).toMatch(raison);
    if (reserve) expect(r.reserves.join(" · ")).toMatch(reserve);
    expect(comparerOrganisations(b, a, { identifiantsGroupe: groupe }).niveau).toBe(niveau);
  });
});

describe("proposerDoublonsPersonnes — le lot", () => {
  const lot: FichePersonne[] = [
    p("MedicalDoctor:A", "Dr BENALI Ahmed", { emails: ["ahmed.benali@gmail.com"], wilaya: "Oran", telephones: ["0555 12 34 56"] }),
    p("AdProVoyageur:A1", "Ahmed Ben Ali", { emails: ["ahmedbenali@gmail.com"] }),
    p("AdProVoyageur:A2", "Ahmed Benali", { telephones: ["+213555123456"] }),
    p("CareBeneficiary:A", "Benali Ahmed", { etablissement: "CHU Oran" }),
    p("MedicalDoctor:B", "Dr Nesrine Zerrouki", { wilaya: "Alger", telephones: ["021 23 45 67"] }),
    p("MedicalDoctor:C", "Dr Samia Kadri", { wilaya: "Alger", telephones: ["021 23 45 67"] }),
    p("MedicalDoctor:D", "Dr Lynda Tighilt", { wilaya: "Alger", telephones: ["021 23 45 67"] }),
    p("Employee:E", "Raihana Cherif", { liens: ["User:E"] }),
    p("User:E", "CHERIF Raihana"),
  ];
  const r = proposerDoublonsPersonnes(lot);

  it("trie par niveau puis score, sans paire en double", () => {
    const rangs = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };
    for (let i = 1; i < r.propositions.length; i++) {
      expect(rangs[r.propositions[i - 1].niveau]).toBeGreaterThanOrEqual(rangs[r.propositions[i].niveau]);
    }
    const paires = r.propositions.map((x) => [x.a, x.b].sort().join("|"));
    expect(new Set(paires).size).toBe(paires.length);
  });

  it("trouve l'e-mail, le mobile et le lien", () => {
    const de = (x: string, y: string) => r.propositions.find((q) => [q.a, q.b].sort().join("|") === [x, y].sort().join("|"));
    expect(de("MedicalDoctor:A", "AdProVoyageur:A1")?.niveau).toBe("CERTAIN");
    expect(de("MedicalDoctor:A", "AdProVoyageur:A2")?.niveau).toBe("PROBABLE");
    expect(de("Employee:E", "User:E")?.niveau).toBe("CERTAIN");
  });

  it("le fixe porté par trois noms est un standard", () => {
    expect(r.contexte.telephonesPartages?.has("+21321234567")).toBe(true);
    expect(r.propositions.some((q) => q.a.startsWith("MedicalDoctor:B") || q.b.startsWith("MedicalDoctor:B"))).toBe(false);
  });

  it("regrouper estime les personnes réelles sans rien fusionner", () => {
    const refs = lot.map((f) => f.ref);
    const sur = regrouper(refs, r.propositions, "PROBABLE");
    const large = regrouper(refs, r.propositions, "POSSIBLE");
    expect(sur.flat().sort()).toEqual([...refs].sort());
    expect(sur[0]).toEqual(expect.arrayContaining(["MedicalDoctor:A", "AdProVoyageur:A1", "AdProVoyageur:A2"]));
    expect(large.length).toBeLessThanOrEqual(sur.length);
    // B, C, D restent trois personnes.
    expect(sur.filter((g) => g.some((x) => /MedicalDoctor:[BCD]/.test(x)))).toHaveLength(3);
  });

  it("un bloc trop peuplé est dit, pas comparé", () => {
    const foule = Array.from({ length: 310 }, (_, i) => p(`AdProVoyageur:f${i}`, "Mohamed Benali"));
    const res = proposerDoublonsPersonnes(foule);
    expect(res.blocsIgnores[0]).toMatchObject({ taille: 310 });
    expect(res.comparaisons).toBe(0);
  });
});

describe("proposerDoublonsOrganisations — le lot", () => {
  it("rapproche par NIF à travers les tables, écarte les sociétés sœurs", () => {
    const r = proposerDoublonsOrganisations([
      o("Supplier:1", "Imprimerie du Centre SARL", { nif: "001 916 012 345 678" }),
      o("CompanyContact:1", "IMPRIMERIE DU CENTRE", { nif: "001916012345678", wilaya: "Blida" }),
      o("CompanyContact:9", "Saidal Médéa", { nif: "000126001111111", emails: ["contact@saidal.dz"] }),
      o("CompanyContact:10", "Saidal Constantine", { nif: "000125002222222", emails: ["achats@saidal.dz"] }),
    ]);
    expect(r.propositions).toHaveLength(1);
    expect(r.propositions[0]).toMatchObject({ niveau: "CERTAIN", a: "Supplier:1", b: "CompanyContact:1" });
  });
});
