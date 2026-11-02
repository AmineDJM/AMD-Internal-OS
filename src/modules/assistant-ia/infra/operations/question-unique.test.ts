import { describe, expect, it } from "vitest";
import { questionDejaPosee } from "./index";
import { lireCalendrier } from "./routines";

/**
 * P1 (décision 0047) — banc d'audit Q1 : « Quel est le nom du ou des médecins concernés ? » posée TROIS fois (AP-01…05) ;
 * « à quelle heure ? » trois fois pour un rappel ponctuel (TA-05). La même question ne se pose pas deux fois ; un passage
 * unique sans heure prend 9 h (dit sur la carte).
 */
describe("P1 — jamais deux fois la même question", () => {
  it("le même champ, le même geste, la même personne : au tour SUIVANT, BLOQUÉE ; dans le même tour, une reprise n'est pas une question reposée", () => {
    const t1 = new Set<string>(), t2 = new Set<string>();
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t1)).toBe(false);
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t1)).toBe(false); // même tour
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le nom du médecin", t2)).toBe(true); // tour suivant
    expect(questionDejaPosee("u1", "preparer_sponsoring", "le montant", t2)).toBe(false);
    expect(questionDejaPosee("u2", "preparer_sponsoring", "le nom du médecin", new Set())).toBe(false);
    // Après 15 minutes, la question peut se reposer (un autre moment, une autre demande).
    const t = Date.now();
    expect(questionDejaPosee("u3", "x", "y", new Set(), t)).toBe(false);
    expect(questionDejaPosee("u3", "x", "y", new Set(), t + 16 * 60_000)).toBe(false);
  });

  it("un rappel UNIQUE sans heure prend 9 h ; une routine récurrente sans heure la demande toujours", () => {
    const dans = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const une = lireCalendrier({ frequence: "une fois", date: dans });
    expect("ok" in une && une.calendrier.heure).toBe(9);
    const hebdo = lireCalendrier({ frequence: "hebdomadaire", jours: ["dimanche"] });
    expect("manque" in hebdo && hebdo.manque.join(" ")).toMatch(/heure/);
  });
});
