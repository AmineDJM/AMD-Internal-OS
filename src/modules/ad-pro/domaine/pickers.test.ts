import { describe, it, expect } from "vitest";
import {
  AVAILABLE_PRODUCT_STATUSES, isAvailableProduct, productLabel, availableProductOptions,
  doctorOptionLabel, doctorOptions, joinMulti, splitMulti, readMultiField, MULTI_SEP, specialtyOptions,
  nomsHorsAnnuaire, lireMedecinsDemande, repartirMedecins,
} from "./pickers";

const prod = (o: Partial<Parameters<typeof productLabel>[0]> & { dci: string }) => ({
  id: o.id ?? Math.random().toString(36).slice(2),
  brandName: o.brandName ?? null,
  dci: o.dci,
  status: o.status ?? "DECISION_OBTAINED",
});

describe("les produits proposables", () => {
  it("SEULS CEUX DONT LE TRAITEMENT EST TERMINÉ — promouvoir un dossier en cours est une faute", () => {
    expect(AVAILABLE_PRODUCT_STATUSES).toEqual(["DECISION_OBTAINED", "CLOSED"]);
    expect(isAvailableProduct("DECISION_OBTAINED")).toBe(true);
    expect(isAvailableProduct("CLOSED")).toBe(true);
    for (const s of ["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "BLOCKED"]) {
      expect(isAvailableProduct(s), s).toBe(false);
    }
    expect(isAvailableProduct(null)).toBe(false);
  });

  it("le menu ÉCARTE les dossiers en cours", () => {
    const opts = availableProductOptions([
      prod({ brandName: "Cardiomax", dci: "Amlodipine" }),
      prod({ brandName: "Futurex", dci: "Molécule X", status: "IN_PREPARATION" }),
    ]);
    expect(opts.map((o) => o.value)).toEqual(["Cardiomax (Amlodipine)"]);
  });

  it("LE NOM COMMERCIAL D'ABORD, la DCI entre parenthèses", () => {
    expect(productLabel(prod({ brandName: "Cardiomax", dci: "Amlodipine" }))).toBe("Cardiomax (Amlodipine)");
  });

  it("sans nom commercial, la DCI tient seule — mieux qu'un identifiant", () => {
    expect(productLabel(prod({ brandName: null, dci: "Amlodipine" }))).toBe("Amlodipine");
    expect(productLabel(prod({ brandName: "   ", dci: "Amlodipine" }))).toBe("Amlodipine");
  });

  it("ne répète pas la molécule quand la marque porte le même nom", () => {
    expect(productLabel(prod({ brandName: "Amlodipine", dci: "amlodipine" }))).toBe("Amlodipine");
  });

  it("dédoublonne et trie — deux dossiers peuvent aboutir au même libellé", () => {
    const opts = availableProductOptions([
      prod({ brandName: "Zeta", dci: "Z" }),
      prod({ brandName: "Alpha", dci: "A" }),
      prod({ brandName: "Zeta", dci: "Z" }),
    ]);
    expect(opts.map((o) => o.value)).toEqual(["Alpha (A)", "Zeta (Z)"]);
  });
});

describe("les médecins de l'annuaire", () => {
  it("LE MENU LÈVE LE DOUTE — spécialité et ville à côté du nom", () => {
    // Deux « Dr Benali » existent : le nom seul fait choisir au hasard.
    expect(doctorOptionLabel({ id: "1", name: "Dr Benali", specialty: "Cardiologie", city: "Alger" }))
      .toBe("Dr Benali — Cardiologie · Alger");
    expect(doctorOptionLabel({ id: "2", name: "Dr Saïdi" })).toBe("Dr Saïdi");
  });

  it("mais c'est le NOM SEUL qui est écrit sur la demande — c'est lui qu'on lit ensuite", () => {
    const opts = doctorOptions([{ id: "1", name: "Dr Benali", specialty: "Cardiologie", city: "Alger" }]);
    expect(opts[0].value).toBe("Dr Benali");
    expect(opts[0].label).toContain("Cardiologie");
  });

  it("écarte les fiches sans nom, dédoublonne, et trie", () => {
    const opts = doctorOptions([
      { id: "1", name: "Dr Zerrouki" }, { id: "2", name: "  " },
      { id: "3", name: "Dr Amrani" }, { id: "4", name: "Dr Zerrouki" },
    ]);
    expect(opts.map((o) => o.value)).toEqual(["Dr Amrani", "Dr Zerrouki"]);
  });
});

describe("plusieurs valeurs dans un champ qui en attendait une", () => {
  it("JOINT AVEC UN SÉPARATEUR LISIBLE, absent des noms propres", () => {
    // Une virgule aurait coupé « Benali, Ahmed » ; un point-virgule aurait eu l'air d'un export.
    expect(joinMulti(["Cardiomax", "Neurostat"])).toBe(`Cardiomax${MULTI_SEP}Neurostat`);
    expect(MULTI_SEP).toBe(" · ");
  });

  it("dédoublonne, ignore les vides, et rend null quand il n'y a rien", () => {
    expect(joinMulti(["A", "A", "  ", "B"])).toBe(`A${MULTI_SEP}B`);
    expect(joinMulti([])).toBeNull();
    expect(joinMulti(["", "   "])).toBeNull();
  });

  it("se relit à l'identique — c'est ce qui recoche les cases à la réouverture", () => {
    const v = joinMulti(["Cardiomax", "Neurostat"]);
    expect(splitMulti(v)).toEqual(["Cardiomax", "Neurostat"]);
    expect(splitMulti(null)).toEqual([]);
    expect(splitMulti("  ")).toEqual([]);
  });

  it("une valeur ancienne, tapée à la main, se relit comme une seule entrée", () => {
    expect(splitMulti("Cardiomax 10mg")).toEqual(["Cardiomax 10mg"]);
  });
});

describe("ce que le formulaire envoie", () => {
  it("LA LISTE COCHÉE L'EMPORTE", () => {
    expect(readMultiField(["Cardiomax"], "vieille saisie")).toBe("Cardiomax");
  });

  it("MAIS UNE SAISIE LIBRE PASSE ENCORE — refuser bloquerait la demande pour un défaut de référentiel", () => {
    expect(readMultiField([], "Produit hors catalogue")).toBe("Produit hors catalogue");
    expect(readMultiField([], null)).toBeNull();
    expect(readMultiField([], "   ")).toBeNull();
  });
});

describe("La spécialité en menu déroulant — référentiel + réalité des fiches", () => {
  it("le RÉFÉRENTIEL fait autorité sur la casse, et les libellés hérités complètent", () => {
    // Ce qui le ferait tomber : ne lire que le référentiel. Une spécialité portée par quarante
    // médecins non rattachés serait alors introuvable dans le menu, et une demande légitime
    // refusée pour une ligne de table manquante — le référentiel décidant qui peut demander quoi.
    const o = specialtyOptions([{ name: "Cardiologie" }], ["cardiologie", "Infectiologie", " Oncologie "]);
    expect(o.map((x) => x.value)).toEqual(["Cardiologie", "Infectiologie", "Oncologie"]);
  });

  it("« Cardio » et « Cardiologie » restent DEUX entrées — on ne rapproche pas à la place de la Promotion médicale", () => {
    // La dédoublonnage porte sur la casse et les espaces, exactement la variation que le champ
    // libre a produite. Rapprocher deux libellés DIFFÉRENTS serait choisir la spécialité d'un
    // praticien à la place du service qui entretient l'annuaire.
    const o = specialtyOptions([], ["Cardio", "Cardiologie"]);
    expect(o.map((x) => x.value)).toEqual(["Cardio", "Cardiologie"]);
  });

  it("rien à proposer rend une liste VIDE — c'est l'appelant qui décide du repli", () => {
    expect(specialtyOptions([], [])).toEqual([]);
    expect(specialtyOptions([], [null, undefined, "  "])).toEqual([]);
  });
});

describe("le médecin absent de l'annuaire (§118.175)", () => {
  it("les noms saisis à la main s'AJOUTENT aux médecins cochés, sans doublon", () => {
    // « Si le médecin n'est pas présent dans l'annuaire, on coche « non présent » et on l'écrit
    // manuellement » — la saisie ne REMPLACE pas les cases cochées. Ce qui le ferait tomber :
    // `readMultiField(coches, horsAnnuaire)`, où la saisie n'est qu'un repli et disparaît dès
    // qu'une case est cochée.
    expect(lireMedecinsDemande(["Dr Amel Haddad"], "Dr Yacine Ouali\nDr Amel Haddad", null))
      .toBe(`Dr Amel Haddad${MULTI_SEP}Dr Yacine Ouali`);
    // Saisie seule : elle suffit, aucune case n'est exigée.
    expect(lireMedecinsDemande([], "Dr Yacine Ouali", null)).toBe("Dr Yacine Ouali");
  });

  it("un nom par ligne, et le séparateur des colonnes est accepté — aucun nom propre ne le contient", () => {
    expect(nomsHorsAnnuaire("Dr A\r\n  Dr B  \n\nDr C · Dr D; Dr E")).toEqual(["Dr A", "Dr B", "Dr C", "Dr D", "Dr E"]);
    // Une virgule N'EST PAS un séparateur : « Benali, Ahmed » est un seul praticien.
    expect(nomsHorsAnnuaire("Benali, Ahmed")).toEqual(["Benali, Ahmed"]);
    expect(nomsHorsAnnuaire("   ")).toEqual([]);
    expect(nomsHorsAnnuaire(null)).toEqual([]);
  });

  it("rien coché, rien saisi : le repli libre d'avant passe encore, et sinon la colonne reste VIDE", () => {
    expect(lireMedecinsDemande([], "", "Dr saisi sans annuaire")).toBe("Dr saisi sans annuaire");
    expect(lireMedecinsDemande([], null, null)).toBeNull();
  });

  it("ROUVRIR SANS PERDRE : ce qui est dans l'annuaire se recoche, le reste revient dans la saisie", () => {
    // Le défaut que ce partage ferme : un nom écrit à la main n'a aucune case où se recocher ; sans
    // lui, le premier enregistrement de la fiche l'effaçait, en silence (§118.152c).
    const options = [{ value: "Dr Amel Haddad" }, { value: "Dr Karim Bensalem" }];
    const r = repartirMedecins(`Dr Amel Haddad${MULTI_SEP}Dr Yacine Ouali${MULTI_SEP}Dr Nadia Kaci`, options);
    expect(r.coches).toEqual(["Dr Amel Haddad"]);
    expect(r.horsAnnuaire).toBe("Dr Yacine Ouali\nDr Nadia Kaci");
    // L'aller-retour est EXACT : relire ce que l'écran renvoie rend la même colonne.
    expect(lireMedecinsDemande(r.coches, r.horsAnnuaire, null)).toBe(`Dr Amel Haddad${MULTI_SEP}Dr Yacine Ouali${MULTI_SEP}Dr Nadia Kaci`);
    expect(repartirMedecins(null, options)).toEqual({ coches: [], horsAnnuaire: "" });
  });
});
