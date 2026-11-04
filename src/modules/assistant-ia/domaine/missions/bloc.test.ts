import { describe, expect, it } from "vitest";
import { blocDeMission, contenuDeMission, etapesBornees, ETAPES_MAX, gestesDeMission, type DetailMission, type EtapeDetaillee } from "./bloc";
import { projeterMission } from "../observation/projecteurs";

const T0 = Date.parse("2026-11-03T10:00:00Z");
const il = (min: number) => new Date(T0 - min * 60_000).toISOString();

const OBJECTIF = "Consolider le suivi des dossiers AMD dans un classeur unique.";
/** L'OBSERVATION de la mission (contrat I1) — c'est d'elle que la carte tient identité, état, lien et diagnostic. */
const obs = (etat: string) => projeterMission({ id: "mis_1", titre: "Classeur de suivi AMD", etat, libelle: etat === "EN_COURS" ? "En cours" : etat, etapes: { faites: 1, total: 3 }, majLe: il(2), diagnostic: "en cours : Synthèse" }, new Date(T0));
const detail: DetailMission = {
  etapes: [
    { id: "lire", label: "Lire les dossiers AMD", etat: "fait", detail: "42 dossiers lus", fin: il(30) },
    { id: "synthese", label: "Synthèse", etat: "en-cours", debut: il(5) },
    { id: "classeur", label: "Classeur Excel", etat: "a-faire" },
  ],
  jalons: [{ ordre: 1, titre: "Inventaire", resultat: "les 42 dossiers listés", etat: "fait" }],
  livrables: [{ titre: "Suivi AMD", fichier: "suivi-amd.xlsx", statut: "VERIFIED", contenu: "3 feuilles, 42 lignes" }],
  derniereActivite: { at: il(5), texte: "Étape « Synthèse » commencée" },
};

describe("P1 ter — une mission LISIBLE : son contenu, borné", () => {
  it("le contenu dit l'objectif, les étapes avec leur résultat, les jalons, les livrables et la dernière action", () => {
    const c = contenuDeMission(OBJECTIF, detail) as Record<string, unknown>;
    expect(c.objectif).toContain("classeur unique");
    expect(JSON.stringify(c.etapes)).toContain("42 dossiers lus");
    expect(JSON.stringify(c.jalons)).toContain("les 42 dossiers listés");
    expect(JSON.stringify(c.livrables)).toContain("suivi-amd.xlsx");
    expect(String(c.derniere_action)).toContain("Synthèse");
  });
  it("sans détail lisible : on le DIT (la mission reste ouverte par son lien) — jamais un silence", () => {
    const c = contenuDeMission(OBJECTIF, null) as Record<string, unknown>;
    expect(String(c.contenu)).toContain("lien");
  });
  it("au plus ETAPES_MAX étapes : l'échec et l'étape en cours d'abord, le reste COMPTÉ, dans l'ordre du plan", () => {
    const etapes: EtapeDetaillee[] = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, label: `Étape ${i}`, etat: i < 12 ? "fait" : i === 12 ? "echec" : i === 13 ? "en-cours" : "a-faire" }));
    const { montrees, resume } = etapesBornees(etapes);
    expect(montrees).toHaveLength(ETAPES_MAX);
    expect(montrees.map((e) => e.id)).toContain("e12");
    expect(montrees.map((e) => e.id)).toContain("e13");
    expect(montrees.map((e) => Number(e.id.slice(1)))).toEqual([...montrees.map((e) => Number(e.id.slice(1)))].sort((a, b) => a - b));
    expect(resume).toMatch(/12 autres étapes non montrées/);
  });
});

describe("P1 ter — la CARTE cliquable d'une mission", () => {
  it("« Ouvrir » mène à /missions/<id> ; les gestes suivent l'état (réversibles, par la phrase)", () => {
    expect(gestesDeMission({ id: "mis_1", titre: "X", etat: "EN_COURS" }).map((a) => a.libelle)).toEqual(["Ouvrir", "Pause", "Arrêter"]);
    expect(gestesDeMission({ id: "mis_1", titre: "X", etat: "EN_PAUSE" }).map((a) => a.libelle)).toEqual(["Ouvrir", "Reprendre", "Arrêter"]);
    expect(gestesDeMission({ id: "mis_1", titre: "X", etat: "ARRETE" }).map((a) => a.libelle)).toEqual(["Ouvrir", "Reprendre"]);
    expect(gestesDeMission({ id: "mis_1", titre: "X", etat: "TERMINE" }).map((a) => a.libelle)).toEqual(["Ouvrir"]);
    expect(gestesDeMission({ id: "mis_1", titre: "X", etat: "EN_COURS" })[0]).toMatchObject({ href: "/missions/mis_1" });
  });
  it("le bloc porte les étapes, les jalons, le diagnostic et les livrables", () => {
    const b = blocDeMission(obs("EN_COURS"), detail);
    expect(b.kind).toBe("mission");
    expect(b.etapes.map((e) => e.etat)).toEqual(["fait", "en-cours", "a-faire"]);
    expect(b.jalons?.[0]?.resultat).toBe("les 42 dossiers listés");
    expect(b.subtitle).toContain("en cours : Synthèse");
    expect(b.subtitle).toContain("suivi-amd.xlsx");
  });
});

describe("P1 ter — la carte tient de l'OBSERVATION son lien et ses gestes (contrat I1, pas de chemin à part)", () => {
  it("« Ouvrir » suit le lien observé ; les gestes suivent l'état observé", () => {
    const enCours = blocDeMission(obs("EN_COURS"), detail);
    expect(enCours.actions?.[0]).toMatchObject({ libelle: "Ouvrir", href: "/missions/mis_1" });
    expect(enCours.actions?.map((a) => a.libelle)).toEqual(["Ouvrir", "Pause", "Arrêter"]);
    expect(blocDeMission(obs("EN_PAUSE"), detail).actions?.map((a) => a.libelle)).toEqual(["Ouvrir", "Reprendre", "Arrêter"]);
    expect(blocDeMission(obs("TERMINE"), null).actions?.map((a) => a.libelle)).toEqual(["Ouvrir"]);
  });
});
