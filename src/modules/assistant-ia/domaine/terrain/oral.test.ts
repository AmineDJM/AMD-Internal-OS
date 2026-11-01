import { describe, expect, it } from "vitest";
import {
  champSuivant, designesParNom, empreinteIntention, estAffirmatif, estRefus, facultatifsUtiles, lireCommandeOrale, lireDateDite,
  lireNombreDit, nombreOral, questionDuChamp, resumeOralBlocs, resumeOralCarte, valeurDite, type ChampOral,
} from "./oral";
import { consignesVoix } from "./voix";

/**
 * LA VOIX ENTIÈREMENT ORALE (lot K9, décision 0038) — les règles pures que le SERVEUR applique sans le modèle.
 */
describe("l'accord oral — français parlé et darja", () => {
  it.each([
    "oui", "ok fais-le", "vas-y", "Go !", "oui c'est bon", "d'accord, lance", "c'est bon, envoie", "parfait", "pas de souci, vas-y",
    "ih dirha", "wakha", "yallah", "safi dirha", "ايه ديرها", "واخا", "okay go",
  ])("« %s » vaut accord", (t) => expect(estAffirmatif(t)).toBe(true));

  it.each([
    "non", "attends", "oui mais mets 5 000", "non vas-y pas", "c'est quoi déjà le montant ?", "ok mais change le titre", "lala",
    "machi daba", "mazal", "laisse tomber", "ماشي", "", "euh", "je sais pas", "oui oui oui je pense que oui mais il faudrait voir avec Karim demain",
  ])("« %s » n'est PAS un accord", (t) => expect(estAffirmatif(t)).toBe(false));

  it("le refus", () => {
    for (const t of ["non", "laisse tomber", "non merci", "lala", "ماشي", "annule"]) expect(estRefus(t), t).toBe(true);
    for (const t of ["oui", "vas-y", "attends"]) expect(estRefus(t), t).toBe(false);
  });
});

describe("les commandes orales", () => {
  const sans = { carteEnAttente: false };
  const avec = { carteEnAttente: true };
  it("une carte attend : accord → confirmer, refus → refuser ; sinon rien de tel", () => {
    expect(lireCommandeOrale("ok fais-le", avec)).toBe("confirmer");
    expect(lireCommandeOrale("ih dirha", avec)).toBe("confirmer");
    expect(lireCommandeOrale("non laisse tomber", avec)).toBe("refuser");
    expect(lireCommandeOrale("annule", avec)).toBe("refuser");
    expect(lireCommandeOrale("ok fais-le", sans)).toBeNull();
    expect(lireCommandeOrale("oui mais mets 5 000", avec)).toBeNull();
    expect(lireCommandeOrale("oui mais attends", avec)).toBe("attendre");
    expect(lireCommandeOrale("une minute", avec)).toBe("attendre");
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

describe("les résumés oraux", () => {
  it("une carte en une phrase : titre, montant, bénéficiaire ; la relecture de la valeur critique", () => {
    const r = resumeOralCarte({
      title: "Ordre de dépense — congrès d'Oran",
      fields: [{ label: "Objet", value: "Stand" }, { label: "Montant", value: "450 000 DZD" }, { label: "Bénéficiaire", value: "Imprimerie El Bahia" }],
      confirmText: "450 000",
    });
    expect(r).toBe("Ordre de dépense — congrès d'Oran « Stand », montant 450 000 DZD, bénéficiaire Imprimerie El Bahia. Je relis : 450 000.");
    expect(resumeOralCarte({ title: "Créer la tâche « Stand »" })).toBe("Créer la tâche « Stand ».");
  });

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

describe("les champs, un par un", () => {
  const champs: ChampOral[] = [
    { nom: "title", libelle: "Titre", widget: "texte", obligatoire: true, valeurs: null },
    { nom: "dueDate", libelle: "Échéance", widget: "date", obligatoire: false, valeurs: null },
    { nom: "priority", libelle: "Priorité", widget: "choix", obligatoire: true, valeurs: ["LOW", "MEDIUM", "HIGH"] },
    { nom: "assignedToId", libelle: "Responsable", widget: "reference", obligatoire: false, valeurs: null },
    { nom: "urgent", libelle: "Urgent", widget: "case", obligatoire: true, valeurs: null },
    { nom: "notes", libelle: "Notes", widget: "zone", obligatoire: false, valeurs: null },
  ];
  it("le champ suivant : le premier obligatoire vide (jamais une case) ; puis deux facultatifs utiles", () => {
    expect(champSuivant(champs, {})?.nom).toBe("title");
    expect(champSuivant(champs, { title: "Stand" })?.nom).toBe("priority");
    expect(champSuivant(champs, { title: "Stand", priority: "HIGH" })).toBeNull();
    expect(facultatifsUtiles(champs, { title: "Stand", priority: "HIGH" }).map((c) => c.nom)).toEqual(["dueDate", "assignedToId"]);
    expect(questionDuChamp(champs[2])).toBe("Il manque priorité (LOW, MEDIUM, HIGH).");
  });
  it("une valeur dite remplit le champ ; une référence se cherche par nom ; une valeur hors liste est redemandée", () => {
    const maintenant = new Date(2026, 9, 31);
    expect(valeurDite(champs[0], "c'est Stand du congrès")).toEqual({ ok: true, valeur: "Stand du congrès" });
    expect(valeurDite(champs[1], "demain", maintenant)).toEqual({ ok: true, valeur: "2026-11-01" });
    expect(valeurDite(champs[1], "le 12 novembre", maintenant)).toEqual({ ok: true, valeur: "2026-11-12" });
    expect(valeurDite(champs[2], "high")).toEqual({ ok: true, valeur: "HIGH" });
    expect(valeurDite(champs[2], "bof")).toMatchObject({ ok: false });
    expect(valeurDite(champs[3], "Samia")).toEqual({ reference: "Samia" });
    expect(valeurDite(champs[4], "oui")).toEqual({ ok: true, valeur: true });
  });
  it("les dates dites", () => {
    const m = new Date(2026, 9, 31);
    expect(lireDateDite("après-demain", m)).toBe("2026-11-02");
    expect(lireDateDite("dans 10 jours", m)).toBe("2026-11-10");
    expect(lireDateDite("le 5/1", m)).toBe("2027-01-05");
    expect(lireDateDite("2026-12-24", m)).toBe("2026-12-24");
    expect(lireDateDite("un jour", m)).toBeNull();
  });
});

describe("l'empreinte d'une intention", () => {
  it("stable à l'ordre des clés, change dès qu'un champ change", () => {
    const a = empreinteIntention({ payload: { entree: { title: "A", n: 1 } }, title: "T" });
    expect(empreinteIntention({ title: "T", payload: { entree: { n: 1, title: "A" } } })).toBe(a);
    expect(empreinteIntention({ payload: { entree: { title: "B", n: 1 } }, title: "T" })).not.toBe(a);
  });
});

describe("les consignes de la voix (inversées par K9)", () => {
  it("plus de « confirmez à l'écran » ni de « jamais un oui oral » ; l'attente engage la personne", () => {
    const c = consignesVoix(true);
    expect(c).not.toMatch(/confirmez-la à l'écran|n'accepte jamais un « oui » oral/);
    expect(c).toContain("NE VOIT PAS son écran");
    expect(c).toContain("je te préviens dès que c'est prêt");
    expect(c).toContain("DÉLÈGUE-LE");
  });
});
