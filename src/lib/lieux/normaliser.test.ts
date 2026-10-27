import { describe, expect, it } from "vitest";
import {
  WILAYAS_69,
  normaliserCommune,
  normaliserLieu,
  normaliserWilaya,
  replier,
  type CommuneRef,
} from "./normaliser";

const code = (t: unknown, o?: Parameters<typeof normaliserWilaya>[1]) => normaliserWilaya(t, o).code;
const raison = (t: unknown) => {
  const r = normaliserWilaya(t);
  return r.code === null ? r.raison : `code ${r.code}`;
};

describe("référentiel embarqué", () => {
  it("compte 69 wilayas, codes 01 à 69 sans trou", () => {
    expect(WILAYAS_69).toHaveLength(69);
    expect(WILAYAS_69.map((w) => w.code)).toEqual(Array.from({ length: 69 }, (_, i) => String(i + 1).padStart(2, "0")));
  });

  it("donne une wilaya mère aux seules wilayas 59 à 69 (décret 26-206)", () => {
    expect(WILAYAS_69.filter((w) => w.mere).map((w) => `${w.code}<${w.mere}`)).toEqual([
      "59<03", "60<05", "61<07", "62<12", "63<13", "64<14", "65<17", "66<17", "67<26", "68<28", "69<32",
    ]);
  });

  it("reconnaît chaque wilaya par son propre nom et par son numéro", () => {
    for (const w of WILAYAS_69) {
      expect(code(w.nom)).toBe(w.code);
      expect(code(w.code)).toBe(w.code);
      expect(code(w.nom.toUpperCase())).toBe(w.code);
    }
  });
});

describe("replier", () => {
  it("retire accents, casse et ponctuation", () => {
    expect(replier("  Béjaïa ")).toBe("bejaia");
    expect(replier("M'Sila")).toBe("msila");
    expect(replier("W16")).toBe("w 16");
    expect(replier("Bordj-Bou-Arréridj")).toBe("bordj bou arreridj");
  });

  it("replie l'arabe : harakat, alif hamza, tâ marbûta, chiffres arabes", () => {
    expect(replier("الأغْوَاط")).toBe(replier("الاغواط"));
    expect(replier("باتنة")).toBe(replier("باتنه"));
    expect(replier("١٦")).toBe("16");
  });

  it("replie les formes de présentation (texte copié d'un PDF)", () => {
    // « ﺍﻟﺠﺰﺍﺋﺮ » en formes de présentation, tel qu'un PDF officiel le rend.
    expect(code("ﺍﻟﺠﺰﺍﺋﺮ")).toBe("16");
  });
});

describe("normaliserWilaya — noms et variantes", () => {
  it.each([
    ["Alger", "16"], ["ALGER", "16"], ["alger centre", "16"], ["Algiers", "16"], ["El Djazaïr", "16"],
    ["El Djazair", "16"], ["الجزائر", "16"], ["الجزائر العاصمة", "16"],
    ["Bejaia", "06"], ["Bougie", "06"], ["بجاية", "06"],
    ["Bordj Bou Arreridj", "34"], ["BBA", "34"], ["bordj-bou-arréridj", "34"],
    ["Sidi Bel Abbes", "22"], ["SBA", "22"], ["Sidi Belabbes", "22"],
    ["msila", "28"], ["M'SILA", "28"], ["M Sila", "28"], ["El Mghaier", "57"], ["Ain Temouchent", "46"], ["Aïn Defla", "44"],
    ["Tamanghasset", "11"], ["El Asnam", "02"], ["Oued Souf", "39"], ["El Golea", "58"],
    ["El M'Ghaier", "57"], ["Ain Salah", "53"], ["وهران", "31"], ["قسنطينة", "25"],
  ])("« %s » → %s", (t, c) => {
    expect(code(t)).toBe(c);
  });

  it("dit par quel signal il a reconnu", () => {
    expect(normaliserWilaya("Oran")).toMatchObject({ code: "31", nom: "Oran", via: "nom" });
    expect(normaliserWilaya("Algiers")).toMatchObject({ code: "16", via: "variante" });
    expect(normaliserWilaya("وهران")).toMatchObject({ code: "31", via: "arabe" });
    expect(normaliserWilaya("W.16")).toMatchObject({ code: "16", via: "numero" });
    expect(normaliserWilaya("16000")).toMatchObject({ code: "16", via: "code_postal" });
  });

  it("préfère la forme la plus longue (« Bordj Bou Arréridj », pas « Bordj Badji Mokhtar »)", () => {
    expect(code("Bordj Badji Mokhtar")).toBe("50");
    expect(code("Bordj Bou Arréridj")).toBe("34");
  });

  it("lit le nom dans une adresse", () => {
    expect(code("12 rue Didouche Mourad, Alger")).toBe("16");
    expect(code("Cité 500 logements, Batna")).toBe("05");
    expect(code("Wilaya de Blida")).toBe("09");
    expect(code("Constantine ville")).toBe("25");
    expect(code("Oran, Algérie")).toBe("31");
  });

  it("ne lit pas un nom à l'intérieur d'un mot", () => {
    expect(raison("Algérie")).toBe("inconnu");
    expect(raison("Oranie")).toBe("inconnu");
    expect(raison("Batnaoui")).toBe("inconnu");
  });
});

describe("normaliserWilaya — numéros et codes postaux", () => {
  it.each([
    ["16", "16"], ["6", "06"], ["06", "06"], ["W.16", "16"], ["W16", "16"], ["w 16", "16"],
    ["Wilaya n° 16", "16"], ["Wilaya 31", "31"], ["16 - Alger", "16"], ["Alger (16)", "16"],
    ["ولاية 16", "16"], ["١٦", "16"], ["68", "68"], ["59", "59"],
  ])("« %s » → %s", (t, c) => {
    expect(code(t)).toBe(c);
  });

  it("refuse un numéro hors de 01 à 69", () => {
    expect(raison("70")).toBe("numero_hors_liste");
    expect(raison("0")).toBe("numero_hors_liste");
    expect(raison("W.99")).toBe("numero_hors_liste");
  });

  it("ne prend pas un nombre quelconque pour un numéro de wilaya", () => {
    expect(raison("Cité 1000 logements")).toBe("inconnu");
    expect(raison("Lot 5 bis")).toBe("inconnu");
    expect(raison("Bâtiment 16 B")).toBe("inconnu");
  });

  it("lit un code postal seul ou accompagné de son nom", () => {
    expect(code("09000")).toBe("09");
    expect(code("Lot 5, 09000 Blida")).toBe("09");
    expect(code("31000 Oran")).toBe("31");
  });

  it("prévient qu'un code postal de wilaya mère peut désigner une de ses filles", () => {
    const r = normaliserWilaya("28000");
    expect(r).toMatchObject({ code: "28" });
    expect(r.code !== null && r.prudence).toMatch(/2026/);
    expect(normaliserWilaya("16000")).not.toHaveProperty("prudence");
  });

  it("accepte le code postal de la wilaya mère à côté d'une nouvelle wilaya", () => {
    expect(code("28200 Bou Saâda")).toBe("68");
  });
});

describe("normaliserWilaya — refus motivés", () => {
  it("vide", () => {
    expect(raison("")).toBe("vide");
    expect(raison("   ")).toBe("vide");
    expect(raison(null)).toBe("vide");
    expect(raison(undefined)).toBe("vide");
    expect(raison("—")).toBe("vide");
  });

  it("inconnu, avec le texte dans le détail", () => {
    const r = normaliserWilaya("Rouiba");
    expect(r).toMatchObject({ code: null, raison: "inconnu" });
    expect(r.code === null && r.detail).toContain("Rouiba");
    expect(raison("Centre")).toBe("inconnu");
    expect(raison("Algérie")).toBe("inconnu");
  });

  it("numéro contredit par le nom", () => {
    expect(raison("16 Oran")).toBe("contradiction");
    expect(raison("W.31 Alger")).toBe("contradiction");
  });

  it("code postal contredit par le nom", () => {
    expect(raison("16000 Oran")).toBe("contradiction");
  });

  it("deux wilayas dans le même texte", () => {
    const r = normaliserWilaya("Oran / Alger");
    expect(r).toMatchObject({ code: null, raison: "plusieurs_wilayas" });
    expect(r.code === null && r.detail).toMatch(/16 Alger/);
  });
});

describe("normaliserWilaya — anciennes et nouvelles wilayas (loi n° 26-06)", () => {
  it.each([
    ["Aflou", "59"], ["Barika", "60"], ["El Kantara", "61"], ["Bir El Ater", "62"], ["El Aricha", "63"],
    ["Ksar Chellala", "64"], ["Ain Oussera", "65"], ["Aïn Ouessara", "65"], ["Messaad", "66"],
    ["Ksar El Boukhari", "67"], ["Boghari", "67"], ["Bou Saada", "68"], ["Bousaada", "68"], ["بوسعادة", "68"],
    ["El Abiodh Sidi Cheikh", "69"], ["الأبيض سيدي الشيخ", "69"], ["عين وسارة", "65"],
  ])("« %s » → %s", (t, c) => {
    expect(code(t)).toBe(c);
  });

  it("signale qu'une nouvelle wilaya n'est pas encore en fonction et nomme sa mère", () => {
    const r = normaliserWilaya("Bou Saâda");
    expect(r).toMatchObject({ code: "68", mere: "28" });
    expect(r.code !== null && r.prudence).toMatch(/M'Sila/);
  });

  it("ramène une nouvelle wilaya à sa mère dans le découpage à 58", () => {
    expect(normaliserWilaya("Bou Saâda", { decoupage: "58" })).toMatchObject({ code: "28", nom: "M'Sila", rameneDe: "68" });
    expect(code("Aïn Oussera", { decoupage: "58" })).toBe("17");
    expect(code("Messaad", { decoupage: "58" })).toBe("17");
    expect(code("Alger", { decoupage: "58" })).toBe("16");
    expect(normaliserWilaya("Alger", { decoupage: "58" })).not.toHaveProperty("rameneDe");
  });

  it("« Bou Saâda, M'Sila » : la ville et sa wilaya mère ne sont pas deux wilayas", () => {
    expect(normaliserWilaya("Bou Saada, M'Sila")).toMatchObject({ code: "68", mere: "28" });
    expect(normaliserWilaya("Ksar El Boukhari (Médéa)")).toMatchObject({ code: "67" });
  });

  it("deux nouvelles wilayas sœurs restent deux wilayas", () => {
    expect(raison("Messaad Ain Oussera")).toBe("plusieurs_wilayas");
  });

  it("les wilayas de 2019 sont des wilayas pleines", () => {
    expect(normaliserWilaya("Touggourt")).toMatchObject({ code: "55", mere: null });
    expect(normaliserWilaya("Touggourt")).not.toHaveProperty("prudence");
  });
});

describe("normaliserCommune", () => {
  const COMMUNES: CommuneRef[] = [
    { code: "1601", nom: "Alger-Centre", wilayaCode: "16" },
    { code: "1644", nom: "Rouiba", nomAr: "الرويبة", wilayaCode: "16" },
    { code: "0901", nom: "Sidi Ameur", wilayaCode: "09" },
    { code: "6805", nom: "Sidi Ameur", wilayaCode: "68" },
  ];

  it("rattache un nom unique, casse et tirets indifférents", () => {
    expect(normaliserCommune("ROUIBA", COMMUNES)).toEqual({ code: "1644", nom: "Rouiba", wilayaCode: "16" });
    expect(normaliserCommune("alger centre", COMMUNES)).toMatchObject({ code: "1601" });
    expect(normaliserCommune("Commune de Rouiba", COMMUNES)).toMatchObject({ code: "1644" });
    expect(normaliserCommune("الرويبة", COMMUNES)).toMatchObject({ code: "1644" });
  });

  it("refuse de choisir entre homonymes, et dit où ils sont", () => {
    expect(normaliserCommune("Sidi Ameur", COMMUNES)).toMatchObject({ code: null, raison: "homonymes", wilayas: ["09", "68"] });
  });

  it("tranche les homonymes quand la wilaya est connue", () => {
    expect(normaliserCommune("Sidi Ameur", COMMUNES, { wilayaCode: "68" })).toMatchObject({ code: "6805" });
  });

  it("dit pourquoi il ne rattache pas", () => {
    expect(normaliserCommune("", COMMUNES)).toMatchObject({ code: null, raison: "vide" });
    expect(normaliserCommune("Rouiba", [])).toMatchObject({ code: null, raison: "referentiel_vide" });
    expect(normaliserCommune("Atlantis", COMMUNES)).toMatchObject({ code: null, raison: "inconnue" });
    expect(normaliserCommune("Rouiba", COMMUNES, { wilayaCode: "31" })).toMatchObject({ code: null, raison: "inconnue" });
  });
});

describe("normaliserLieu", () => {
  it("la colonne wilaya prime sur la ville", () => {
    expect(normaliserLieu({ wilaya: "16", ville: "Oran" }).wilaya).toMatchObject({ code: "16" });
  });

  it("une colonne wilaya vide ou illisible laisse parler la ville, puis la région", () => {
    expect(normaliserLieu({ wilaya: "", ville: "Blida" }).wilaya).toMatchObject({ code: "09" });
    expect(normaliserLieu({ wilaya: "???", ville: "Blida" }).wilaya).toMatchObject({ code: "09" });
    expect(normaliserLieu({ ville: "Rouiba", region: "Tizi Ouzou" }).wilaya).toMatchObject({ code: "15" });
  });

  it("une contradiction dans la colonne wilaya n'est pas couverte par la ville", () => {
    expect(normaliserLieu({ wilaya: "16 Oran", ville: "Blida" }).wilaya).toMatchObject({ code: null, raison: "contradiction" });
  });

  it("garde la raison la plus parlante quand rien n'est reconnu", () => {
    expect(normaliserLieu({}).wilaya).toMatchObject({ code: null, raison: "vide" });
    expect(normaliserLieu({ ville: "Rouiba" }).wilaya).toMatchObject({ code: null, raison: "inconnu" });
  });

  it("cherche la commune dans la wilaya trouvée", () => {
    const communes: CommuneRef[] = [
      { code: "0901", nom: "Sidi Ameur", wilayaCode: "09" },
      { code: "6805", nom: "Sidi Ameur", wilayaCode: "68" },
    ];
    expect(normaliserLieu({ wilaya: "Bou Saâda", ville: "Sidi Ameur" }, communes).commune).toMatchObject({ code: "6805" });
    expect(normaliserLieu({ ville: "Sidi Ameur" }, communes).commune).toMatchObject({ raison: "homonymes" });
    expect(normaliserLieu({ wilaya: "Alger" }).commune).toBeNull();
  });
});
