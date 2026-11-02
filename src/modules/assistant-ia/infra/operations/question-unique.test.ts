import { describe, expect, it } from "vitest";
import { questionDejaPosee } from "./index";
import { lireCalendrier } from "./routines";

/**
 * P1 (décision 0047) — banc d'audit Q1 : « Quel est le nom du ou des médecins concernés ? » posée TROIS fois (AP-01…05) ;
 * « à quelle heure ? » trois fois pour un rappel ponctuel (TA-05). La même question ne se pose pas deux fois ; un passage
 * unique sans heure prend 9 h (dit sur la carte).
 */
describe("P1 — jamais deux fois la même question", () => {
  it("le même champ, le même geste, la même personne : la seconde fois est BLOQUÉE ; un autre champ ou une autre personne, non", () => {
    const t = Date.now();
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t)).toBe(false);
    // Le modèle rappelle l'outil dans le MÊME tour : pas encore posée à la personne.
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t + 1000)).toBe(false);
    // Au tour suivant, sans la réponse : bloquée.
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t + 60_000)).toBe(true);
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le montant", t + 2000)).toBe(false);
    expect(questionDejaPosee("u2", "preparer_sponsoring", "le nom du médecin", t + 3000)).toBe(false);
    // Après 15 minutes, la question peut se reposer (un autre moment, une autre demande).
    expect(questionDejaPosee("u3", "x", "y", t)).toBe(false);
    expect(questionDejaPosee("u3", "x", "y", t + 16 * 60_000)).toBe(false);
  });

  it("un rappel UNIQUE sans heure prend 9 h ; une routine récurrente sans heure la demande toujours", () => {
    const dans = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const une = lireCalendrier({ frequence: "une fois", date: dans });
    expect("ok" in une && une.calendrier.heure).toBe(9);
    const hebdo = lireCalendrier({ frequence: "hebdomadaire", jours: ["dimanche"] });
    expect("manque" in hebdo && hebdo.manque.join(" ")).toMatch(/heure/);
  });
});
