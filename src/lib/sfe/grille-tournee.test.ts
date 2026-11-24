import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cleCellule, deplacerCellule, etatCellule, gesteCellule, grilleModifiable, jourIso, lireCellule, planDejaValide,
  praticiensParJour, retirerCellule, semaineInitiale, semainesDuPlan, tonEtatCellule,
} from "./grille-tournee";

/**
 * LA GRILLE DU PLAN DE TOURNÉE (Direction, 06/10) — jours en colonnes, professionnels de santé dans les cellules.
 * Les règles sont pures : on les teste sur leurs seules entrées, puis on vérifie que l'écran passe par elles et par
 * la porte UNIQUE du rapport de visite.
 */

// Octobre 2026 : le 4 est un dimanche — la semaine ouvrée va du dimanche au jeudi.
const JOURS = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-11", "2026-10-12", "2026-10-13"];
const INFO: Record<string, { name: string; wilaya: string | null; institution: string | null }> = {
  a: { name: "Dr Achour", wilaya: "Alger", institution: "CHU Mustapha" },
  b: { name: "Dr Benali", wilaya: "Alger", institution: "CHU Beni Messous" },
  c: { name: "Dr Chaouch", wilaya: "Blida", institution: null },
  d: { name: "Dr Amrani", wilaya: "Alger", institution: "CHU Mustapha" },
};
const infoDe = (id: string) => INFO[id] ?? { name: id, wilaya: null, institution: null };

describe("la clé d'une cellule — la forme que l'action relit", () => {
  it("se lit et se relit ; l'illisible est nul, jamais deviné", () => {
    expect(cleCellule("2026-10-05", "doc1")).toBe("2026-10-05|doc1");
    expect(lireCellule("2026-10-05|doc1")).toEqual({ jour: "2026-10-05", doctorId: "doc1" });
    expect(lireCellule("05/10/2026|doc1")).toBeNull();
    expect(lireCellule("2026-10-05|")).toBeNull();
    expect(lireCellule("n'importe quoi")).toBeNull();
  });
  it("le jour est LOCAL", () => {
    expect(jourIso(new Date(2026, 9, 6, 23, 30))).toBe("2026-10-06");
  });
});

describe("les semaines du plan", () => {
  it("groupe les jours ouvrés par semaine dimanche → jeudi, dans l'ordre", () => {
    const s = semainesDuPlan([...JOURS].reverse());
    expect(s).toEqual([
      { debut: "2026-10-04", jours: ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"] },
      { debut: "2026-10-11", jours: ["2026-10-11", "2026-10-12", "2026-10-13"] },
    ]);
  });
  it("ouvre la semaine d'aujourd'hui, sinon la première", () => {
    const s = semainesDuPlan(JOURS);
    expect(semaineInitiale(s, "2026-10-12")).toBe(1);
    expect(semaineInitiale(s, "2026-10-09")).toBe(0); // un vendredi ouvre SA semaine
    expect(semaineInitiale(s, "2026-10-17")).toBe(1); // un samedi aussi
    expect(semaineInitiale(s, "2026-12-01")).toBe(0);
    expect(semaineInitiale([], "2026-10-12")).toBe(0);
  });
});

describe("les praticiens de chaque jour", () => {
  it("tous les jours figurent, vides compris ; l'ordre est celui d'une tournée (wilaya, établissement, nom)", () => {
    const m = praticiensParJour(["2026-10-05|c", "2026-10-05|b", "2026-10-05|d", "2026-10-05|a"], JOURS, infoDe);
    expect([...m.keys()]).toEqual(JOURS);
    expect(m.get("2026-10-04")).toEqual([]);
    // Alger : CHU Beni Messous (Benali), puis CHU Mustapha (Achour, Amrani) ; Blida ensuite.
    expect(m.get("2026-10-05")).toEqual(["b", "a", "d", "c"]);
  });
  it("une paire posée hors des jours ouvrés reste visible ; l'illisible est ignoré", () => {
    const m = praticiensParJour(["2026-10-09|a", "garbage"], JOURS, infoDe);
    expect(m.get("2026-10-09")).toEqual(["a"]);
  });
});

describe("déplacer, retirer — et ce qui ne bouge pas", () => {
  const paires = new Set(["2026-10-05|a", "2026-10-06|b", "2026-10-07|a"]);
  const verrous = new Set(["2026-10-06|b"]);

  it("déplace vers un autre jour ouvré", () => {
    const r = deplacerCellule(paires, "2026-10-05|a", "2026-10-08", JOURS, verrous);
    expect(r.ok && [...r.paires].sort()).toEqual(["2026-10-06|b", "2026-10-07|a", "2026-10-08|a"]);
    // L'entrée n'est pas modifiée en place.
    expect(paires.has("2026-10-05|a")).toBe(true);
  });
  it("refuse : déjà prévu ce jour-là, jour non ouvré, visite verrouillée, cellule absente", () => {
    expect(deplacerCellule(paires, "2026-10-05|a", "2026-10-07", JOURS, verrous)).toMatchObject({ ok: false, raison: expect.stringContaining("déjà prévu") });
    expect(deplacerCellule(paires, "2026-10-05|a", "2026-10-09", JOURS, verrous)).toMatchObject({ ok: false, raison: expect.stringContaining("jour ouvré") });
    expect(deplacerCellule(paires, "2026-10-06|b", "2026-10-08", JOURS, verrous)).toMatchObject({ ok: false, raison: expect.stringContaining("verrouillée") });
    expect(deplacerCellule(paires, "2026-10-04|z", "2026-10-08", JOURS, verrous).ok).toBe(false);
  });
  it("déplacer sur son propre jour ne change rien", () => {
    const r = deplacerCellule(paires, "2026-10-05|a", "2026-10-05", JOURS, verrous);
    expect(r.ok && [...r.paires].sort()).toEqual([...paires].sort());
  });
  it("retire, sauf une visite verrouillée", () => {
    const r = retirerCellule(paires, "2026-10-05|a", verrous);
    expect(r.ok && r.paires.has("2026-10-05|a")).toBe(false);
    expect(retirerCellule(paires, "2026-10-06|b", verrous).ok).toBe(false);
    expect(retirerCellule(paires, "2026-10-04|z", verrous).ok).toBe(false);
  });
});

describe("qui modifie la grille — la règle de l'action", () => {
  it("ouverte (brouillon, rejeté, révision) ET écrivable ; jamais soumise ni validée", () => {
    for (const s of ["DRAFT", "REJECTED", "REVISION"] as const) {
      expect(grilleModifiable(s, true)).toBe(true);
      expect(grilleModifiable(s, false)).toBe(false);
    }
    for (const s of ["SUBMITTED", "ESCALATED", "APPROVED"] as const) expect(grilleModifiable(s, true)).toBe(false);
  });
  it("validé au moins une fois : validé, ou rouvert / resoumis après validation", () => {
    expect(planDejaValide("APPROVED", 0)).toBe(true);
    expect(planDejaValide("REVISION", 1)).toBe(true);
    expect(planDejaValide("SUBMITTED", 1)).toBe(true);
    expect(planDejaValide("SUBMITTED", 0)).toBe(false);
    expect(planDejaValide("DRAFT", 0)).toBe(false);
  });
});

describe("l'état d'une cellule et ce qu'un clic ouvre", () => {
  const J = "2026-10-06";
  it("non enregistrée, prévue avant validation, puis l'état de la visite", () => {
    expect(etatCellule({ etatEnregistre: null, planValide: true, jour: J, aujourdhui: J })).toBe("NON_ENREGISTREE");
    expect(etatCellule({ etatEnregistre: "A_FAIRE", planValide: false, jour: J, aujourdhui: J })).toBe("PREVUE");
    expect(etatCellule({ etatEnregistre: "PERDUE", planValide: false, jour: J, aujourdhui: J })).toBe("PREVUE");
    // Un fait se montre toujours, même avant validation.
    expect(etatCellule({ etatEnregistre: "FAITE", planValide: false, jour: J, aujourdhui: J })).toBe("FAITE");
    expect(etatCellule({ etatEnregistre: "A_FAIRE", planValide: true, jour: J, aujourdhui: J })).toBe("A_FAIRE");
    expect(etatCellule({ etatEnregistre: "A_FAIRE", planValide: true, jour: "2026-10-07", aujourdhui: J })).toBe("A_VENIR");
    expect(etatCellule({ etatEnregistre: "PERDUE", planValide: true, jour: "2026-10-01", aujourdhui: J })).toBe("PERDUE");
  });
  it("le ton dit l'état", () => {
    expect(tonEtatCellule("FAITE")).toBe("success");
    expect(tonEtatCellule("PERDUE")).toBe("warning");
    expect(tonEtatCellule("REPORTEE")).toBe("info");
    expect(tonEtatCellule("PREVUE")).toBe("neutral");
  });
  it("rapport sur une visite à faire, correction dans la fenêtre — sur un plan validé, pour le KAM seul", () => {
    const base = { heuresRestantes: 20, planValide: true, jeSuisLeKam: true };
    expect(gesteCellule({ ...base, etat: "A_FAIRE" })).toBe("RAPPORTER");
    expect(gesteCellule({ ...base, etat: "FAITE" })).toBe("CORRIGER");
    expect(gesteCellule({ ...base, etat: "FAITE", heuresRestantes: 0 })).toBe("AUCUN");
    expect(gesteCellule({ ...base, etat: "A_VENIR" })).toBe("AUCUN");
    expect(gesteCellule({ ...base, etat: "PERDUE" })).toBe("AUCUN");
    expect(gesteCellule({ ...base, etat: "ANNULEE" })).toBe("AUCUN");
    expect(gesteCellule({ ...base, etat: "A_FAIRE", planValide: false })).toBe("AUCUN");
    expect(gesteCellule({ ...base, etat: "A_FAIRE", jeSuisLeKam: false })).toBe("AUCUN");
  });
});

describe("l'écran — une seule porte vers le rapport d'une visite planifiée", () => {
  const sansCommentaires = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const planif = sansCommentaires(readFileSync("src/app/(app)/medical/plan-de-tournee/planificateur.tsx", "utf8"));
  const grille = sansCommentaires(readFileSync("src/app/(app)/medical/plan-de-tournee/grille.tsx", "utf8"));
  const journee = sansCommentaires(readFileSync("src/app/(app)/medical/ma-journee/emploi-du-temps.tsx", "utf8"));
  const feuille = sansCommentaires(readFileSync("src/app/(app)/medical/ma-journee/feuille-visite.tsx", "utf8"));
  const liste = sansCommentaires(readFileSync("src/app/(app)/medical/ma-journee/journee-delegue.tsx", "utf8"));
  const envoi = sansCommentaires(readFileSync("src/app/(app)/medical/ma-journee/envoi-visite.ts", "utf8"));
  const page = sansCommentaires(readFileSync("src/app/(app)/medical/ma-journee/page.tsx", "utf8"));

  it("la grille du plan ouvre les feuilles de « Ma journée », et aucune action de rapport en direct", () => {
    expect(planif).toMatch(/<FeuilleRapportVisite\b/);
    expect(planif).toMatch(/<FeuilleNonTenue /);
    for (const t of [planif, grille]) {
      expect(t).not.toMatch(/rapporterVisite|ajouterVisiteImprevue|direVisiteNonTenue|createFieldReport/);
    }
    // « Ma journée » et la grille passent par la MÊME feuille « Visite » — pas une copie à côté.
    expect(journee).toMatch(/<FeuilleVisite\b/);
    expect(liste).toMatch(/<FeuilleVisite\b/);
    expect(liste).toMatch(/<FeuilleNonTenue /);
    // UNE porte par action : l'emploi du temps (grille, onglets) rapporte par le geste suivi ; la liste du jour et la
    // file hors ligne, par le module d'envoi — le seul qui crée une visite hors plan.
    expect((journee.match(/executer\(rapporterVisite, fd\)/g) ?? []).length).toBe(1);
    expect((envoi.match(/rapporterVisite\(fd\)/g) ?? []).length).toBe(1);
    expect((envoi.match(/ajouterVisiteImprevue\(fd\)/g) ?? []).length).toBe(1);
    for (const t of [feuille, liste, page]) expect(t).not.toMatch(/rapporterVisite\(|ajouterVisiteImprevue\(/);
  });

  it("« Ma journée » n'appelle plus `logVisit` : un médecin planifié ouvre le rapport de SA visite (11/2026)", () => {
    for (const t of [journee, feuille, liste, envoi, page]) expect(t).not.toMatch(/logVisit/);
    // Les portes en double ont disparu de l'écran.
    for (const t of [journee, liste, page]) {
      expect(t).not.toContain("Faire un rapport terrain");
      expect(t).not.toContain("Visite chez un autre praticien");
      expect(t).not.toContain("Visite faite");
    }
    // L'ENTRÉE HORS PLAN est dans l'en-tête de la page (maquette du délégué, 24/11/2026) ; elle ouvre le même choix.
    expect(page).toContain("Visite hors plan");
    expect(liste).toMatch(/ouvrirHorsPlan/);
    expect(liste).toMatch(/cibleDuPraticien\(/);
    expect(liste).toMatch(/Commencer la visite/);
  });

  it("la structure de la grille passe par l'action unique `planifierVisites` et les règles pures", () => {
    expect(planif).toMatch(/run\(planifierVisites, fd\)/);
    expect(planif).toMatch(/grilleModifiable\(status, jePeuxDemanderRevision\)/);
    expect(planif).toMatch(/deplacerCellule\(/);
    expect(planif).toMatch(/retirerCellule\(/);
    expect(grille).toMatch(/etatCellule\(/);
    expect(grille).toMatch(/gesteCellule\(/);
    // LA GRILLE SERT À PLANIFIER (11/2026) : plus de « Faire un rapport » ni de « Pharmacovigilance » au-dessus ; le
    // signalement part de la cellule d'un praticien, prérempli (`lienSignalerPv`), et de la feuille de sa visite.
    expect(planif).not.toContain("Faire un rapport");
    expect(planif).not.toMatch(/lienSignalerPv\(\)/);
    expect(planif).toMatch(/lienPv=\{peutRapporter && peutSignalerPv \? lienSignalerPv : null\}/);
    expect(grille).toContain("Voir le rapport");
  });

  // 07/10 (maquette validée) : UN tableau à toutes les tailles — il défile dans son cadre au téléphone, la colonne des rangs
  // reste fixe. Plus de vue « un jour par écran » à part.
  it("responsive : le même tableau partout, qui défile dans son cadre, rangs fixes", () => {
    expect(grille).toMatch(/<table /);
    expect(grille).toMatch(/overflow-x-auto/);
    expect(grille).toMatch(/sticky left-0/);
    expect(grille).not.toMatch(/md:hidden/);
  });
});
