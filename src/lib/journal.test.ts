import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attendu, FENETRE_SILENCE_MS, incidentsRecents, journal, journaliser, messageErreur, releverCompteurs,
  reinitialiserJournal, remplacerEcrivain, restituerCompteurs, sansBloquer, type LigneJournal,
} from "./journal";

let lignes: LigneJournal[] = [];
let restaurer: () => void = () => undefined;

beforeEach(() => {
  reinitialiserJournal();
  lignes = [];
  restaurer = remplacerEcrivain((l) => lignes.push(l));
});
afterEach(() => restaurer());

describe("le journal unique — une ligne JSON, un événement nommé", () => {
  it("écrit niveau, événement, contexte et erreur tronquée", () => {
    journal.erreur("tresorerie.soldes", { compte: "c1" }, new Error("délai de pool"));
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ niveau: "erreur", evenement: "tresorerie.soldes", compte: "c1", erreur: "Error: délai de pool" });
    expect(typeof lignes[0].ts).toBe("string");
    expect(messageErreur("x".repeat(900)).length).toBe(500);
  });

  it("anti-avalanche : la même erreur se tait dans la fenêtre, et la ligne suivante dit combien", () => {
    for (let i = 0; i < 10; i++) journal.erreur("centre-adpro.visas", {}, new Error("ECONNREFUSED"));
    expect(lignes).toHaveLength(1);
    // Un message DIFFÉRENT est une autre panne : il s'écrit, avec le nombre de répétitions tues.
    journal.erreur("centre-adpro.visas", {}, new Error("P2022 colonne absente"));
    expect(lignes).toHaveLength(2);
    expect(lignes[1].repetitions).toBe(9);
    expect(FENETRE_SILENCE_MS).toBeGreaterThan(0);
  });

  it("chaque ERREUR est comptée (même tue) ; les avertissements et infos ne le sont pas", () => {
    for (let i = 0; i < 6; i++) journal.erreur("a", {}, new Error("x"));
    journal.avertissement("b", {}, new Error("y"));
    journal.info("c");
    const lot = releverCompteurs();
    expect(lot.map((c) => [c.evenement, c.compte])).toEqual([["a", 6]]);
    expect(releverCompteurs()).toEqual([]); // relever VIDE
    expect(incidentsRecents()).toEqual([{ evenement: "a", compte: 6 }]);
  });

  it("un lot non versé est restitué et s'additionne au suivant", () => {
    journal.erreur("a", {}, "x");
    const lot = releverCompteurs();
    journal.erreur("a", {}, "x");
    restituerCompteurs(lot);
    expect(releverCompteurs()[0].compte).toBe(2);
  });

  it("la fenêtre glissante de la sonde oublie les erreurs anciennes", () => {
    journal.erreur("a", {}, "x");
    expect(incidentsRecents(1_000, Date.now() + 5_000)).toEqual([]);
  });

  it("une clé de comptage distingue ce que l'événement seul confond", () => {
    journaliser("erreur", "tache.echec", { tache: "t1" }, "x", { cle: "tache.echec:t1" });
    journaliser("erreur", "tache.echec", { tache: "t2" }, "x", { cle: "tache.echec:t2" });
    expect(lignes).toHaveLength(2);
    expect(releverCompteurs().map((c) => c.evenement).sort()).toEqual(["tache.echec:t1", "tache.echec:t2"]);
  });

  it("un écrivain qui lève ne fait jamais tomber l'appelant", () => {
    restaurer();
    restaurer = remplacerEcrivain(() => { throw new Error("flux fermé"); });
    expect(() => journal.erreur("a", {}, "x")).not.toThrow();
  });
});

describe("les `catch` nommés", () => {
  it("sansBloquer : rend le repli, journalise et compte sous le nom donné", async () => {
    const r = await Promise.reject(new Error("base")).catch(sansBloquer("ecran.liste", [] as number[]));
    expect(r).toEqual([]);
    expect(lignes[0]).toMatchObject({ niveau: "erreur", evenement: "ecran.liste" });
    expect(releverCompteurs()[0]).toMatchObject({ evenement: "ecran.liste", compte: 1 });
  });

  it("sansBloquer sans repli rend undefined", async () => {
    expect(await Promise.reject(new Error("x")).catch(sansBloquer("push"))).toBeUndefined();
  });

  it("attendu : rend le repli sans rien écrire ni compter — ce n'est pas une panne", async () => {
    expect(await Promise.reject(new Error("ENOENT")).catch(attendu("fichier facultatif", null))).toBeNull();
    expect(lignes).toEqual([]);
    expect(releverCompteurs()).toEqual([]);
  });

  it("une promesse qui réussit ignore le repli", async () => {
    expect(await Promise.resolve([1]).catch(sansBloquer("x", []))).toEqual([1]);
  });
});
