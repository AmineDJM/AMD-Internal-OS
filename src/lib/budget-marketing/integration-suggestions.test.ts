import { describe, expect, it } from "vitest";
import { DEMANDES_2026 } from "./integration-2026";
import { apparierPostes, scorer, suggestions, SEUIL_PRESELECTION, type Candidate } from "./integration-suggestions";
import { controleDeLaPiece, etatDesPieces, stepKeyDePiece } from "./integration-vue";

/** TROUVER LA DEMANDE QUI EXISTE DÉJÀ — proposer, jamais rapprocher d'office (tests purs). */

const d = (cle: string) => DEMANDES_2026.find((x) => x.cle === cle)!;
const cand = (o: Partial<Candidate>): Candidate => ({ type: "SPONSORING", id: "x", reference: null, libelle: "", date: null, montant: null, postes: [], ...o });

describe("les suggestions", () => {
  it("la référence de la maquette (SPO-2026-003) met la demande en tête, cochée d'avance", () => {
    const webinaire = d("D-L19");
    const s = suggestions(webinaire, [
      cand({ id: "a", reference: "SPO-2026-003", libelle: "Société Algérienne d'Infectiologie — webinaire", date: "2026-07-06T00:00:00Z", montant: 5_335_000 }),
      cand({ id: "b", reference: "SPO-2026-010", libelle: "Journées de Batna", date: "2026-06-01T00:00:00Z" }),
    ]);
    expect(s[0].candidate.id).toBe("a");
    expect(s[0].score).toBeGreaterThanOrEqual(SEUIL_PRESELECTION);
    expect(s.some((x) => x.candidate.id === "b")).toBe(false);
  });

  it("le poste « billetterie » à 124 750 repère la prise en charge des pharmaciens", () => {
    const pharma = d("D-L32");
    const r = scorer(pharma, cand({
      type: "CONGRESS_NATIONAL", id: "cn", libelle: "Journées pharmaceutiques", date: "2026-10-10T00:00:00Z",
      postes: [{ id: "p1", libelle: "Prise en charge de la billetterie", montant: 12_475_000, fournisseur: "Genius Travel", historique: false }],
    }))!;
    expect(r.posteRepere).toBe("p1");
    expect(r.score).toBeGreaterThanOrEqual(SEUIL_PRESELECTION);
  });

  it("le nom, le mois et le montant font une suggestion ; une autre nature n'en fait pas", () => {
    const oran = d("D-L10");
    const ok = scorer(oran, cand({ libelle: "6ème conférence d'Oran — sponsoring", date: "2026-04-15T00:00:00Z", montant: 215_701_850 }))!;
    expect(ok.score).toBeGreaterThanOrEqual(40);
    expect(ok.raisons.join(" ")).toMatch(/nom/);
    expect(scorer(oran, cand({ type: "EVENT", libelle: "6ème conférence d'Oran" }))).toBeNull();
  });

  it("apparierPostes : un poste existant par poste prévu, jamais deux fois, jamais un poste déjà historique", () => {
    const prevus = [{ libelle: "Sponsoring", montant: 150_000_000 }, { libelle: "Symposium : honoraires orateur", montant: 19_547_500 }];
    const existants = [
      { id: "e1", libelle: "Appui à l'association", montant: 150_000_000, historique: false },
      { id: "e2", libelle: "Symposium : honoraires orateur", montant: null, historique: false },
      { id: "e3", libelle: "Sponsoring", montant: 150_000_000, historique: true },
    ];
    expect(apparierPostes(prevus, existants, null)).toEqual(["e1", "e2"]);
    // Une dépense d'un poste sur une demande d'un poste : c'est lui, même si l'accordé diffère (53 350 / 53 550).
    expect(apparierPostes([{ libelle: "Sponsoring", montant: 5_355_000 }], [{ id: "w", libelle: "Appui", montant: 5_335_000, historique: false }], null)).toEqual(["w"]);
    expect(apparierPostes([{ libelle: "X", montant: 1 }], [], null)).toEqual([null]);
  });
});

describe("les pièces attendues (non bloquantes)", () => {
  const attendues = [{ cle: "facture", libelle: "Facture" }, { cle: "virement", libelle: "Preuve de virement" }];
  it("une pièce est fournie par un dépôt OU un rattachement ; les autres restent « manquantes »", () => {
    const r = etatDesPieces(attendues, [{ id: "d1", nom: "facture.pdf", stepKey: stepKeyDePiece("facture") }, { id: "d2", nom: "autre.pdf", stepKey: null }], []);
    expect(r.manquantes.map((m) => m.cle)).toEqual(["virement"]);
    const r2 = etatDesPieces(attendues, [], [{ cle: "virement", documentId: "x", nom: "FIN-2026-119", le: "", parId: null, source: "" }]);
    expect(r2.pieces.find((p) => p.cle === "virement")?.fichiers[0].rattachee).toBe(true);
    expect(r2.manquantes.map((m) => m.cle)).toEqual(["facture"]);
  });
  it("le contrôle de Luna : montant à 1 DZD près, fournisseur", () => {
    expect(controleDeLaPiece({ ttc: 14_280, fournisseur: "EPRINT SARL" }, { montant: 14_280, fournisseur: "ePrint" }).ok).toBe(true);
    const ecart = controleDeLaPiece({ ttc: 53_350, fournisseur: null }, { montant: 53_550 });
    expect(ecart.ok).toBe(false);
    expect(ecart.ecarts[0]).toMatch(/53/);
    expect(controleDeLaPiece({ ttc: null, fournisseur: null }, { montant: 1 }).ok).toBe(true);
  });
});
