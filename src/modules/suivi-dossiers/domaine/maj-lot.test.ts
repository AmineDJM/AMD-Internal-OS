import { describe, expect, it } from "vitest";
import { lireDateTableau, lirePrioriteDossier, lireStatutDossier, normaliserReference, planDeMiseAJour, rapprocher, reperesColonnes, type DossierConnu } from "./maj-lot";

const D = (id: string, reference: string, title: string, o: Partial<DossierConnu> = {}): DossierConnu => ({ id, reference, title, status: "OPEN", dueDate: null, priority: "MEDIUM", modifiable: true, ...o });
const DS = [D("a", "DOS-2026-001", "Recherche prix hôtels Oran"), D("b", "DOS-2026-002", "Analyse IQVIA trimestre"), D("c", "DOS-2026-003", "Salon Alger stand"), D("d", "DOS-2026-004", "Salon Alger badge")];
const L = (numero: number, o: Partial<Parameters<typeof rapprocher>[0]>) => ({ numero, reference: null, titre: null, statut: null, echeance: null, priorite: null, ...o });

describe("mise à jour des dossiers depuis un tableau — règles pures", () => {
  it("les statuts écrits en français se lisent ; l'inconnu reste inconnu", () => {
    expect(lireStatutDossier("Terminé")).toBe("DONE");
    expect(lireStatutDossier("  EN COURS ")).toBe("IN_PROGRESS");
    expect(lireStatutDossier("bloqué")).toBe("ON_HOLD");
    expect(lireStatutDossier("à démarrer")).toBe("OPEN");
    expect(lireStatutDossier("Archivé")).toBe("ARCHIVED");
    expect(lireStatutDossier("presque")).toBeNull();
    expect(lirePrioriteDossier("urgent")).toBe("CRITICAL");
  });

  it("dates : JJ/MM/AAAA, ISO, numéro de série Excel ; une date impossible est refusée", () => {
    expect(lireDateTableau("15/12/2026")).toBe("2026-12-15");
    expect(lireDateTableau("2026-12-15")).toBe("2026-12-15");
    expect(lireDateTableau(46371)).toBe("2026-12-15");
    expect(lireDateTableau("31/02/2026")).toBeNull();
  });

  it("colonnes reconnues par l'en-tête, références normalisées", () => {
    expect(reperesColonnes(["N°", "Intitulé du dossier", "Statut", "Date limite"])).toEqual({ reference: 0, statut: 2, echeance: 3 });
    expect(reperesColonnes(["Référence", "Intitulé", "État", "Échéance", "Priorité"])).toEqual({ reference: 0, titre: 1, statut: 2, echeance: 3, priorite: 4 });
    expect(normaliserReference("dos 2026 7")).toBe("DOS-2026-007");
  });

  it("rapprochement : référence, intitulé exact, approché avec marge, ambigu, introuvable — jamais deviné", () => {
    expect(rapprocher(L(1, { reference: "DOS-2026-002" }), DS)).toMatchObject({ issue: "reference", dossier: { id: "b" } });
    expect(rapprocher(L(2, { titre: "recherche prix hotels oran" }), DS)).toMatchObject({ issue: "titre", dossier: { id: "a" } });
    expect(rapprocher(L(3, { titre: "Analyse IQVIA du trimestre" }), DS)).toMatchObject({ issue: "approche", dossier: { id: "b" } });
    expect(rapprocher(L(4, { titre: "Salon Alger" }), DS).issue).toBe("ambigu");
    expect(rapprocher(L(5, { titre: "Formation commerciale" }), DS).issue).toBe("introuvable");
    // Une référence inconnue ne se rabat JAMAIS sur l'intitulé.
    expect(rapprocher(L(6, { reference: "DOS-2019-001", titre: "Analyse IQVIA trimestre" }), DS).issue).toBe("introuvable");
  });

  it("le plan : changements, inchangés, lecture seule, erreurs, doublons", () => {
    const ds = [...DS, D("e", "DOS-2026-005", "Veille", { modifiable: false })];
    const p = planDeMiseAJour([
      L(2, { reference: "DOS-2026-001", statut: "terminé" }),
      L(3, { reference: "DOS-2026-002", statut: "ouvert" }),
      L(4, { reference: "DOS-2026-005", statut: "terminé" }),
      L(5, { reference: "DOS-2026-003", statut: "??" }),
      L(6, { titre: "Recherche prix hôtels Oran", statut: "en cours" }),
    ], ds);
    expect(p.changements.map((c) => [c.reference, c.apres.status])).toEqual([["DOS-2026-001", "DONE"]]);
    expect(p.inchanges.map((x) => x.reference)).toEqual(["DOS-2026-002"]);
    expect(p.lectureSeule.map((x) => x.reference)).toEqual(["DOS-2026-005"]);
    expect(p.erreurs).toHaveLength(1);
    expect(p.doublons.map((x) => x.numero)).toEqual([6]);
  });
});
