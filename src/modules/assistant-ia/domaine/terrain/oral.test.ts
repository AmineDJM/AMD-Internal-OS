import { describe, expect, it } from "vitest";
import { designesParNom, lireCommandeOrale, lireNombreDit, nombreOral, resumeOralBlocs } from "./oral";
import { estNonExplicite, estOuiExplicite, texteOral } from "./voix-orale";
import { consignesVoix } from "./voix";

/**
 * LA VOIX ENTIÈREMENT ORALE (lot K9, décision 0039) — les règles pures que le SERVEUR applique sans le modèle.
 */
describe("l'accord oral — français parlé et darja (règle K4 étendue par K9)", () => {
  it.each([
    "oui", "ok fais-le", "vas-y", "Go !", "oui c'est bon", "d'accord, lance", "c'est bon, envoie", "parfait", "pas de souci, vas-y",
    "ih dirha", "wakha", "yallah", "safi dirha", "ايه ديرها", "واخا", "okay go",
  ])("« %s » vaut accord", (t) => expect(estOuiExplicite(t)).toBe(true));

  it.each([
    "non", "attends", "oui mais mets 5 000", "non vas-y pas", "c'est quoi déjà le montant ?", "ok mais change le titre", "lala",
    "machi daba", "mazal", "laisse tomber", "ماشي", "", "euh", "je sais pas",
  ])("« %s » n'est PAS un accord", (t) => expect(estOuiExplicite(t)).toBe(false));

  it("le refus, darja comprise", () => {
    for (const t of ["non", "laisse tomber", "lala", "ماشي", "non, annule"]) expect(estNonExplicite(t), t).toBe(true);
    for (const t of ["oui", "vas-y", "non mais mets plutôt vendredi"]) expect(estNonExplicite(t), t).toBe(false);
  });

  it("une carte renforcée : la VOIX relit l'élément clé — aucun mot imposé à la personne", () => {
    const q = texteOral({ titre: "Ordre de dépense", champs: [{ label: "Montant", value: "450 000 DZD" }], facultatifs: [], manquants: [], elementCle: "450000" }, "QUESTION");
    expect(q).toContain("RELIS clairement « 450000 »");
    expect(q).toContain("un simple oui suffit");
    expect(q).not.toMatch(/PRONON/);
  });
});

describe("les commandes orales", () => {
  const sans = { carteEnAttente: false };
  const avec = { carteEnAttente: true };
  it("face à une carte : « attends » la fait attendre ; « annule » est laissé au refus de la carte (K4)", () => {
    expect(lireCommandeOrale("oui mais attends", avec)).toBe("attendre");
    expect(lireCommandeOrale("une minute", avec)).toBe("attendre");
    expect(lireCommandeOrale("annule", avec)).toBeNull();
    expect(lireCommandeOrale("ok fais-le", avec)).toBeNull();
  });
  it("annuler la dernière action, les missions, stop, plus court", () => {
    expect(lireCommandeOrale("annule", sans)).toBe("annuler_derniere");
    expect(lireCommandeOrale("annule ce que tu viens de faire", sans)).toBe("annuler_derniere");
    expect(lireCommandeOrale("mets la mission en pause", sans)).toBe("pause_mission");
    expect(lireCommandeOrale("bloque la mission du congrès", sans)).toBe("pause_mission");
    expect(lireCommandeOrale("reprends la mission", sans)).toBe("reprendre_mission");
    expect(lireCommandeOrale("arrête la sous-mission", sans)).toBe("arreter_mission");
    expect(lireCommandeOrale("stop", sans)).toBe("stop");
    expect(lireCommandeOrale("tais-toi", sans)).toBe("stop");
    expect(lireCommandeOrale("plus court s'il te plaît", sans)).toBe("plus_court");
    expect(lireCommandeOrale("quel est le chiffre d'affaires d'Oran ?", sans)).toBeNull();
    // Passage réel (K9) : une DEMANDE qui contient « en bref » n'est pas la commande « plus court ».
    expect(lireCommandeOrale("Explique-moi en bref ce qu'est une AMM pour un médicament en Algérie", sans)).toBeNull();
    expect(lireCommandeOrale("résume-moi le dossier Benali", sans)).toBeNull();
    expect(lireCommandeOrale("en bref", sans)).toBe("plus_court");
    // « annule la tâche Stand » vise une fiche de l'ERP : ni une mission, ni « la dernière action ».
    expect(lireCommandeOrale("annule la tâche Stand", sans)).toBeNull();
  });
  it("la mission désignée par son nom ; seule, sans avoir à la nommer", () => {
    const m = [{ titre: "Veille congrès Oran" }, { titre: "Relance fournisseurs" }];
    expect(designesParNom(m, "mets la mission fournisseurs en pause")).toEqual([m[1]]);
    expect(designesParNom(m, "mets la mission en pause")).toEqual(m);
    expect(designesParNom([m[0]], "arrête")).toEqual([m[0]]);
  });
});

describe("les chiffres à l'oral", () => {
  it("arrondis comme on les dit", () => {
    expect(nombreOral(1_234_567)).toBe("environ 1,2 million");
    expect(nombreOral(3_000_000)).toBe("3 millions");
    expect(nombreOral(45_678)).toBe("environ 46 mille");
    expect(nombreOral(4_380)).toBe("environ 4 400");
    expect(nombreOral(350)).toBe("350");
    expect(nombreOral(2_500_000_000)).toBe("2,5 milliards");
  });
  it("lus d'une transcription", () => {
    expect(lireNombreDit("12 500")).toBe(12_500);
    expect(lireNombreDit("mets 50 mille")).toBe(50_000);
    expect(lireNombreDit("1,5 million")).toBe(1_500_000);
    expect(lireNombreDit("rien")).toBeNull();
  });
});

describe("les blocs dits en une phrase", () => {
  it("tableau, graphique, analyse, visuel : une phrase chacun ; jamais « à l'écran »", () => {
    const dit = resumeOralBlocs([
      { kind: "table", title: "Ventes par wilaya", columns: [], rows: [], total: 48 },
      { kind: "viz", title: "CA par région", type: "barres", donnees: { categories: ["Alger", "Oran", "Constantine"], series: [{ label: "CA", valeurs: [900_000, 1_240_000, 300_000] }] } },
      { kind: "analyse", title: "Marge", total: 120, journal: { resultats: [{ libelle: "Marge totale", valeur: "1 234 567" }] } },
      { kind: "visuel", title: "Affiche", nature: "image", etat: "pret" },
    ]);
    expect(dit).toContain("Un tableau « Ventes par wilaya » de 48 lignes.");
    expect(dit).toContain("Un graphique « CA par région » — le plus haut : Oran, environ 1,2 million.");
    expect(dit).toContain("Une analyse « Marge » sur 120 lignes. Marge totale : environ 1,2 million.");
    expect(dit).toContain("Et 1 autre.");
    expect(dit).toContain("Le détail est dans la conversation.");
    expect(dit).not.toMatch(/écran/);
    expect(resumeOralBlocs([{ kind: "record", title: "Fiche" }])).toBe("");
  });
});

describe("les consignes de la voix (inversées par K9)", () => {
  it("plus de « confirmez à l'écran » ni de « jamais un oui oral » ; l'attente engage la personne", () => {
    const c = consignesVoix(true);
    expect(c).not.toMatch(/confirmez-la à l'écran|n'accepte jamais un « oui » oral/);
    expect(c).toContain("NE VOIT PAS son écran");
    expect(c).toContain("je te préviens dès que c'est prêt");
    expect(c).toContain("DÉLÈGUE-LE");
    expect(c).toContain("Tu confirmes ?");
  });
});
