import { describe, it, expect } from "vitest";
import { ATTRIBUT_PAR_CLE, NATURES_PIECE, type Attribut, type FaitExtrait, type NaturePiece, type RoleSujet } from "./types";
import { deciderFait, faitFoi, motsDuNom, NATURES_OFFICIELLES, resoudreSujet, SEUIL_CONFIRMATION_D_OFFICE, type CandidatFiche, type ValeurActuelle } from "./decision";

const attr = (cle: string): Attribut => {
  const a = ATTRIBUT_PAR_CLE.get(cle);
  if (!a) throw new Error(cle);
  return a;
};

const fait = (o: Partial<FaitExtrait> & { attribut: string }): FaitExtrait => {
  const a = attr(o.attribut);
  return {
    sujetRef: "s1", sujetType: a.sujet, role: "TITULAIRE",
    valeur: "x", valeurNormalisee: "x", confiance: 0.95,
    preuve: { page: 1, extrait: "…" }, sensible: a.sensible, ...o,
  };
};

const confirmee = (valeurNormalisee: string, source = "saisie", confirmeLe = "2026-01-01"): ValeurActuelle => ({ valeurNormalisee, source, confirmeLe });
const enAttente = (valeurNormalisee: string, source = "piece:p0"): ValeurActuelle => ({ valeurNormalisee, source, confirmeLe: null });

describe("NATURES_OFFICIELLES — quelles pièces font foi de quoi", () => {
  it("un RC fait foi pour un NIF ; une carte de visite pour rien", () => {
    expect(faitFoi("REGISTRE_COMMERCE", "organisation.nif", "TITULAIRE")).toBe(true);
    expect(faitFoi("CARTE_VISITE", "organisation.telephone", "TITULAIRE")).toBe(false);
    expect(faitFoi("CARTE_VISITE", "personne.email", "TITULAIRE")).toBe(false);
  });

  it("un passeport fait foi du nom et de la naissance, pas d'un téléphone", () => {
    expect(faitFoi("PASSEPORT", "personne.nom", "TITULAIRE")).toBe(true);
    expect(faitFoi("PASSEPORT", "personne.naissance", "TITULAIRE")).toBe(true);
    expect(faitFoi("PASSEPORT", "personne.telephone", "TITULAIRE")).toBe(false);
  });

  it("le rôle compte : une facture fait foi pour son émetteur, pas pour le destinataire", () => {
    expect(faitFoi("FACTURE", "organisation.adresse", "EMETTEUR")).toBe(true);
    expect(faitFoi("FACTURE", "organisation.adresse", "DESTINATAIRE")).toBe(false);
  });

  it("les pièces déclaratives ou recopiées ne font foi de rien", () => {
    for (const n of ["CARTE_VISITE", "CV", "DEVIS", "BON_DE_COMMANDE", "BILLET_TRANSPORT", "RESERVATION_HOTEL", "INVITATION", "PROGRAMME_CONGRES", "COURRIER", "AUTRE"] as NaturePiece[]) {
      expect(NATURES_OFFICIELLES[n]).toBeUndefined();
    }
  });

  it("la table ne cite que des natures et des attributs du catalogue, et l'attribut convient au sujet", () => {
    for (const [nature, foi] of Object.entries(NATURES_OFFICIELLES)) {
      expect(NATURES_PIECE).toContain(nature);
      expect(foi!.roles.length).toBeGreaterThan(0);
      for (const cle of foi!.attributs) expect(ATTRIBUT_PAR_CLE.has(cle), `${nature} → ${cle}`).toBe(true);
    }
  });
});

describe("deciderFait — table de vérité des règles de la Direction", () => {
  // Attribut synthétique ni sensible ni identifiant : on fait varier tout le reste.
  const synth = (autoConfirmable: boolean, multiple: boolean): Attribut => ({
    ...attr("organisation.adresse"), autoConfirmable, multiple,
  });
  type Etat = "vide" | "identique-confirmee" | "differente-confirmee" | "differente-en-attente" | "identique-en-attente";
  const etats: Record<Etat, ValeurActuelle[]> = {
    "vide": [],
    "identique-confirmee": [confirmee("x")],
    "differente-confirmee": [confirmee("y")],
    "differente-en-attente": [enAttente("y")],
    "identique-en-attente": [enAttente("x")],
  };

  const attendu = (auto: boolean, multiple: boolean, officielle: boolean, confiant: boolean, etat: Etat) => {
    if (etat === "identique-confirmee") return "IGNORER";
    const office = auto && officielle && confiant;
    if (multiple) return office ? "CONFIRMER_D_OFFICE" : "A_CONFIRMER";
    if (etat === "differente-confirmee") return "CONFLIT";
    if (etat === "differente-en-attente") return "A_CONFIRMER";
    return office ? "CONFIRMER_D_OFFICE" : "A_CONFIRMER";
  };

  const bools = [true, false];
  for (const auto of bools) for (const multiple of bools) for (const officielle of bools) for (const confiant of bools) {
    for (const etat of Object.keys(etats) as Etat[]) {
      const exp = attendu(auto, multiple, officielle, confiant, etat);
      it(`auto=${auto} multiple=${multiple} officielle=${officielle} confiance≥0,9=${confiant} ${etat} → ${exp}`, () => {
        const d = deciderFait(
          fait({ attribut: "organisation.adresse", role: "EMETTEUR", confiance: confiant ? 0.9 : 0.89 }),
          { nature: officielle ? "FACTURE" : "DEVIS", attribut: synth(auto, multiple), valeursActuelles: etats[etat] },
        );
        expect(d.decision).toBe(exp);
        expect(d.raison.length).toBeGreaterThan(10);
      });
    }
  }

  it("le seuil est 0,9 inclus", () => {
    expect(SEUIL_CONFIRMATION_D_OFFICE).toBe(0.9);
    const ctx = { nature: "REGISTRE_COMMERCE" as const, attribut: attr("organisation.adresse"), valeursActuelles: [] };
    expect(deciderFait(fait({ attribut: "organisation.adresse", confiance: 0.9 }), ctx).decision).toBe("CONFIRMER_D_OFFICE");
    expect(deciderFait(fait({ attribut: "organisation.adresse", confiance: 0.8999 }), ctx).decision).toBe("A_CONFIRMER");
    expect(deciderFait(fait({ attribut: "organisation.adresse", confiance: Number.NaN }), ctx).decision).toBe("A_CONFIRMER");
  });

  it("la raison d'un « à confirmer » dit ce qui a manqué", () => {
    const d = deciderFait(fait({ attribut: "organisation.telephone", role: "EMETTEUR", confiance: 0.5 }), { nature: "CARTE_VISITE", attribut: attr("organisation.telephone"), valeursActuelles: [] });
    expect(d.decision).toBe("A_CONFIRMER");
    expect(d.raison).toMatch(/CARTE_VISITE ne fait pas foi/);
    expect(d.raison).toMatch(/confiance 0,50 < 0,90/);
  });
});

describe("deciderFait — données sensibles et identifiants : jamais d'office", () => {
  const sensibles = ["personne.passeport.numero", "personne.passeport.expiration", "personne.cni.numero", "personne.nin", "personne.salaire", "personne.rib", "organisation.rib"];

  it.each(sensibles)("%s → COFFRE, même lu sur sa pièce officielle à confiance 1, même déjà connu", (cle) => {
    const nature: NaturePiece = cle.endsWith("rib") ? "RIB" : cle === "personne.salaire" ? "BULLETIN_PAIE" : cle === "personne.passeport.numero" || cle === "personne.passeport.expiration" ? "PASSEPORT" : "CNI";
    for (const valeursActuelles of [[], [confirmee("x")], [confirmee("y")]]) {
      const d = deciderFait(fait({ attribut: cle, confiance: 1 }), { nature, attribut: attr(cle), valeursActuelles });
      expect(d.decision).toBe("COFFRE");
      expect(d.raison).toMatch(/coffre/);
    }
  });

  it("un fait marqué sensible par l'extracteur va au coffre même si l'attribut ne l'est pas", () => {
    const d = deciderFait(fait({ attribut: "personne.adresse", sensible: true }), { nature: "CONTRAT", attribut: attr("personne.adresse"), valeursActuelles: [] });
    expect(d.decision).toBe("COFFRE");
  });

  for (const cle of ["organisation.nif", "organisation.nis", "organisation.rc", "organisation.ai"]) {
    it(`${cle} : jamais d'office, même sur un RC à confiance 1 ; conflit s'il diffère ; ignoré s'il est identique`, () => {
      const ctx = (valeursActuelles: ValeurActuelle[]) => ({ nature: "REGISTRE_COMMERCE" as const, attribut: attr(cle), valeursActuelles });
      const f = fait({ attribut: cle, valeurNormalisee: "000116001234567", confiance: 1 });
      expect(deciderFait(f, ctx([])).decision).toBe("A_CONFIRMER");
      expect(deciderFait(f, ctx([])).raison).toMatch(/identifiant/);
      expect(deciderFait(f, ctx([enAttente("999")])).decision).toBe("A_CONFIRMER");
      expect(deciderFait(f, ctx([confirmee("000116001234567")])).decision).toBe("IGNORER");
      const c = deciderFait(f, ctx([confirmee("999", "saisie manuelle")]));
      expect(c).toMatchObject({ decision: "CONFLIT", valeurActuelle: "999" });
      expect(c.raison).toMatch(/saisie manuelle/);
    });
  }

  it("l'agrément (multiple, non identifiant fort) n'est jamais d'office non plus : non auto-confirmable", () => {
    const d = deciderFait(fait({ attribut: "organisation.agrement", confiance: 1 }), { nature: "REGISTRE_COMMERCE", attribut: attr("organisation.agrement"), valeursActuelles: [confirmee("y")] });
    expect(d.decision).toBe("A_CONFIRMER");
  });
});

describe("deciderFait — conflits", () => {
  it("adresse de société unique ? non : multiple — une nouvelle adresse s'ajoute sans conflit", () => {
    const d = deciderFait(fait({ attribut: "organisation.adresse", role: "EMETTEUR", valeurNormalisee: "12 rue b" }), {
      nature: "FACTURE", attribut: attr("organisation.adresse"), valeursActuelles: [confirmee("3 rue a")],
    });
    expect(d.decision).toBe("CONFIRMER_D_OFFICE");
    expect(d.raison).toMatch(/nouvelle valeur/);
  });

  it("site web (unique) différent : CONFLIT contre la valeur confirmée la plus récente, même sur pièce officielle", () => {
    const d = deciderFait(fait({ attribut: "organisation.siteWeb", role: "EMETTEUR", valeur: "https://b.dz", valeurNormalisee: "b.dz", confiance: 1 }), {
      nature: "FACTURE", attribut: attr("organisation.siteWeb"),
      valeursActuelles: [confirmee("ancien.dz", "import", "2024-01-01"), confirmee("a.dz", "saisie", "2026-03-01")],
    });
    expect(d).toMatchObject({ decision: "CONFLIT", valeurActuelle: "a.dz" });
    expect(d.raison).toMatch(/https:\/\/b\.dz/);
  });

  it("adresse de personne (unique) lue sur un contrat : d'office si rien n'est connu, conflit sinon", () => {
    const f = fait({ attribut: "personne.adresse", role: "PARTIE", valeurNormalisee: "5 rue c" });
    const ctx = (v: ValeurActuelle[]) => ({ nature: "CONTRAT" as const, attribut: attr("personne.adresse"), valeursActuelles: v });
    expect(deciderFait(f, ctx([])).decision).toBe("CONFIRMER_D_OFFICE");
    expect(deciderFait(f, ctx([confirmee("1 rue d")])).decision).toBe("CONFLIT");
    expect(deciderFait(f, ctx([enAttente("1 rue d")])).decision).toBe("A_CONFIRMER");
    expect(deciderFait(f, ctx([enAttente("5 rue c")])).decision).toBe("CONFIRMER_D_OFFICE");
  });

  it("la comparaison ignore les espaces autour", () => {
    const d = deciderFait(fait({ attribut: "organisation.siteWeb", valeurNormalisee: " a.dz " }), { nature: "AUTRE", attribut: attr("organisation.siteWeb"), valeursActuelles: [confirmee("a.dz")] });
    expect(d.decision).toBe("IGNORER");
  });
});

describe("deciderFait — attributs multiples", () => {
  const tel = (role: RoleSujet, nature: NaturePiece, confiance: number, valeursActuelles: ValeurActuelle[]) =>
    deciderFait(fait({ attribut: "organisation.telephone", role, valeurNormalisee: "+213550000001", confiance }), { nature, attribut: attr("organisation.telephone"), valeursActuelles });

  it("un deuxième téléphone, lu sur la facture de l'émetteur : ajouté d'office", () => {
    expect(tel("EMETTEUR", "FACTURE", 0.95, [confirmee("+213550000000")]).decision).toBe("CONFIRMER_D_OFFICE");
  });
  it("le même téléphone déjà confirmé : ignoré", () => {
    expect(tel("EMETTEUR", "FACTURE", 0.95, [confirmee("+213550000001")]).decision).toBe("IGNORER");
  });
  it("lu sur une carte de visite : ajout à confirmer", () => {
    expect(tel("TITULAIRE", "CARTE_VISITE", 0.99, []).decision).toBe("A_CONFIRMER");
  });
  it("le téléphone du destinataire d'une facture : à confirmer", () => {
    expect(tel("DESTINATAIRE", "FACTURE", 0.99, []).decision).toBe("A_CONFIRMER");
  });
  it("fonction (multiple, non auto-confirmable) même sur bulletin de paie : à confirmer", () => {
    const d = deciderFait(fait({ attribut: "personne.fonction" }), { nature: "BULLETIN_PAIE", attribut: attr("personne.fonction"), valeursActuelles: [] });
    expect(d.decision).toBe("A_CONFIRMER");
    expect(d.raison).toMatch(/pas confirmable d'office/);
  });
});

describe("deciderFait — gardes", () => {
  it("valeur vide → IGNORER", () => {
    expect(deciderFait(fait({ attribut: "organisation.siteWeb", valeurNormalisee: "  " }), { nature: "FACTURE", attribut: attr("organisation.siteWeb"), valeursActuelles: [] }).decision).toBe("IGNORER");
  });
  it("attribut du fait ≠ attribut du contexte → IGNORER", () => {
    expect(deciderFait(fait({ attribut: "organisation.siteWeb" }), { nature: "FACTURE", attribut: attr("organisation.email"), valeursActuelles: [] }).decision).toBe("IGNORER");
  });
  it("sujet incohérent → IGNORER", () => {
    expect(deciderFait(fait({ attribut: "organisation.siteWeb", sujetType: "PERSONNE" }), { nature: "FACTURE", attribut: attr("organisation.siteWeb"), valeursActuelles: [] }).decision).toBe("IGNORER");
  });
});

describe("resoudreSujet — rattacher sans jamais deviner", () => {
  const org = (attribut: string, valeur: string, sujetRef = "emetteur"): FaitExtrait =>
    fait({ attribut, valeur, valeurNormalisee: valeur, sujetRef, role: "EMETTEUR" });
  const fiche = (id: string, libelle: string, identifiants: CandidatFiche["identifiants"] = [], type: CandidatFiche["type"] = "ORGANISATION"): CandidatFiche => ({ id, type, libelle, identifiants });

  it("NIF identique → RATTACHER", () => {
    const r = resoudreSujet([org("organisation.raisonSociale", "Imprimerie du Centre"), org("organisation.nif", "123")], [
      fiche("a", "Autre", [{ attribut: "organisation.nif", valeurNormalisee: "999" }]),
      fiche("b", "Imprimerie Centre SARL", [{ attribut: "organisation.nif", valeurNormalisee: "123" }]),
    ]);
    expect(r).toMatchObject({ resultat: "RATTACHER", ficheId: "b", identifiants: ["NIF"] });
  });

  it("RC identique, NIF absent de la fiche → RATTACHER", () => {
    const r = resoudreSujet([org("organisation.nif", "123"), org("organisation.rc", "16/00-1")], [fiche("b", "X", [{ attribut: "organisation.rc", valeurNormalisee: "16/00-1" }])]);
    expect(r).toMatchObject({ resultat: "RATTACHER", ficheId: "b" });
  });

  it("le même nom exact, sans identifiant commun → AMBIGU, jamais rattaché", () => {
    const r = resoudreSujet([org("organisation.raisonSociale", "Imprimerie du Centre")], [fiche("b", "IMPRIMERIE DU CENTRE SARL")]);
    expect(r.resultat).toBe("AMBIGU");
    if (r.resultat === "AMBIGU") expect(r.candidats).toEqual([{ id: "b", libelle: "IMPRIMERIE DU CENTRE SARL", motif: "nom semblable, aucun identifiant commun" }]);
  });

  it("un homonyme dont le NIF diffère est un autre sujet → NOUVELLE_FICHE", () => {
    const r = resoudreSujet([org("organisation.raisonSociale", "Imprimerie du Centre"), org("organisation.nif", "123")], [
      fiche("b", "Imprimerie du Centre", [{ attribut: "organisation.nif", valeurNormalisee: "999" }]),
    ]);
    expect(r.resultat).toBe("NOUVELLE_FICHE");
  });

  it("deux fiches portent le même NIF (doublon) → AMBIGU, pas de fusion d'office", () => {
    const r = resoudreSujet([org("organisation.nif", "123")], [
      fiche("a", "A", [{ attribut: "organisation.nif", valeurNormalisee: "123" }]),
      fiche("b", "B", [{ attribut: "organisation.nif", valeurNormalisee: "123" }]),
    ]);
    expect(r.resultat).toBe("AMBIGU");
    if (r.resultat === "AMBIGU") expect(r.candidats.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("NIF concorde mais RC contredit → AMBIGU", () => {
    const r = resoudreSujet([org("organisation.nif", "123"), org("organisation.rc", "R1")], [
      fiche("a", "A", [{ attribut: "organisation.nif", valeurNormalisee: "123" }, { attribut: "organisation.rc", valeurNormalisee: "R2" }]),
    ]);
    expect(r.resultat).toBe("AMBIGU");
    if (r.resultat === "AMBIGU") expect(r.candidats[0].motif).toMatch(/Registre du commerce différent/);
  });

  it("NIF désigne une fiche, RC une autre → AMBIGU avec les deux", () => {
    const r = resoudreSujet([org("organisation.nif", "123"), org("organisation.rc", "R1")], [
      fiche("a", "A", [{ attribut: "organisation.nif", valeurNormalisee: "123" }]),
      fiche("b", "B", [{ attribut: "organisation.rc", valeurNormalisee: "R1" }]),
    ]);
    expect(r.resultat).toBe("AMBIGU");
  });

  it("aucun candidat proche → NOUVELLE_FICHE", () => {
    expect(resoudreSujet([org("organisation.raisonSociale", "Pharmalab")], [fiche("b", "Imprimerie du Centre")]).resultat).toBe("NOUVELLE_FICHE");
  });

  it("ne compare qu'au même type de sujet", () => {
    const r = resoudreSujet([org("organisation.nif", "123")], [fiche("p", "Personne", [{ attribut: "organisation.nif", valeurNormalisee: "123" }], "PERSONNE")]);
    expect(r.resultat).toBe("NOUVELLE_FICHE");
  });

  describe("passeport : par empreinte fournie par l'appelant", () => {
    const empreinte = (cle: string, v: string) => `h(${cle}:${v})`;
    const titulaire = [
      fait({ attribut: "personne.nom", valeur: "BENALI", sujetRef: "titulaire" }),
      fait({ attribut: "personne.prenoms", valeur: "Karim", sujetRef: "titulaire" }),
      fait({ attribut: "personne.passeport.numero", valeur: "AB123", valeurNormalisee: "AB123", sujetRef: "titulaire" }),
    ];
    const benali = fiche("p1", "Dr Karim Benali", [{ attribut: "personne.passeport.numero", empreinte: "h(personne.passeport.numero:AB123)" }], "PERSONNE");

    it("empreinte identique → RATTACHER", () => {
      expect(resoudreSujet(titulaire, [benali], { empreinte })).toMatchObject({ resultat: "RATTACHER", ficheId: "p1" });
    });
    it("sans fonction d'empreinte, la valeur en clair ne sert pas : homonyme → AMBIGU, et c'est dit", () => {
      const r = resoudreSujet(titulaire, [benali]);
      expect(r.resultat).toBe("AMBIGU");
      expect(r.raison).toMatch(/aucune empreinte fournie/);
    });
    it("la valeur en clair d'une fiche n'est jamais comparée à un identifiant sensible", () => {
      const clair = fiche("p2", "Quelqu'un", [{ attribut: "personne.passeport.numero", valeurNormalisee: "AB123" }], "PERSONNE");
      expect(resoudreSujet(titulaire, [clair], { empreinte }).resultat).toBe("NOUVELLE_FICHE");
    });
    it("empreinte différente : autre personne, même homonyme → NOUVELLE_FICHE", () => {
      const autre = fiche("p3", "Karim Benali", [{ attribut: "personne.passeport.numero", empreinte: "h(autre)" }], "PERSONNE");
      expect(resoudreSujet(titulaire, [autre], { empreinte }).resultat).toBe("NOUVELLE_FICHE");
    });
    it("homonyme sans passeport connu → AMBIGU", () => {
      const r = resoudreSujet(titulaire, [fiche("p4", "M. Benali Karim", [], "PERSONNE")], { empreinte });
      expect(r.resultat).toBe("AMBIGU");
    });
  });

  it("refuse des faits de plusieurs sujets ou une liste vide", () => {
    expect(() => resoudreSujet([], [])).toThrow();
    expect(() => resoudreSujet([org("organisation.nif", "1", "a"), org("organisation.rc", "2", "b")], [])).toThrow();
  });

  it("motsDuNom replie accents, casse, titres et formes juridiques", () => {
    expect(motsDuNom("Dr Hélène BÉNALI")).toEqual(["helene", "benali"]);
    expect(motsDuNom("Ets. Imprimerie du Centre SARL")).toEqual(["imprimerie", "centre"]);
  });
});
