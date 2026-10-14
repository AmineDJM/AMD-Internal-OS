import { describe, expect, it } from "vitest";
import { grouperLesPieces, groupeDuFichier } from "./pieces";
import { estTraceSysteme, separerLeFil, TETES_DE_TRACE } from "./fil-demande";

describe("grouperLesPieces — trois sources, une liste Devis → BC → Facture → Justificatifs", () => {
  const f = (id: string, category: string) => ({ id, category });
  it("chaque élément va dans la case de sa nature, et garde sa source", () => {
    const g = grouperLesPieces({
      registre: { QUOTE: [{ id: "q1" }], PURCHASE_ORDER: [{ id: "bc1" }], INVOICE: [{ id: "fa1" }], ENGAGEMENT: [{ id: "conv1" }] },
      fichiersDemande: [f("d-devis", "QUOTE"), f("d-fact", "INVOICE"), f("d-lettre", "REQUEST_LETTER"), f("d-conv", "CONVENTION")],
      fichiersDossier: [f("p-bc", "PURCHASE_ORDER"), f("p-photo", "PHOTO")],
    });
    expect(g.map((x) => x.cle)).toEqual(["DEVIS", "BC", "FACTURE", "JUSTIFICATIFS"]);
    const ids = (cle: string) => g.find((x) => x.cle === cle)!.elements.map((e) => (e.source === "REGISTRE" ? `R:${e.piece.id}` : `${e.origine}:${e.fichier.id}`));
    expect(ids("DEVIS")).toEqual(["R:q1", "DEMANDE:d-devis"]);
    expect(ids("BC")).toEqual(["R:bc1", "DOSSIER:p-bc"]);
    expect(ids("FACTURE")).toEqual(["R:fa1", "DEMANDE:d-fact"]);
    expect(ids("JUSTIFICATIFS")).toEqual(["R:conv1", "DEMANDE:d-lettre", "DEMANDE:d-conv", "DOSSIER:p-photo"]);
  });
  it("les quatre cases existent même vides, et une catégorie inconnue va aux justificatifs", () => {
    const g = grouperLesPieces({ registre: {}, fichiersDemande: [] });
    expect(g.map((x) => [x.cle, x.elements.length])).toEqual([["DEVIS", 0], ["BC", 0], ["FACTURE", 0], ["JUSTIFICATIFS", 0]]);
    expect(groupeDuFichier("CTD_FULL")).toBe("JUSTIFICATIFS");
    expect(groupeDuFichier(null)).toBe("JUSTIFICATIFS");
  });
});

describe("Discussion / Historique — les traces du système ne sont pas des messages", () => {
  const c = (id: string, body: string, authorId: string | null = "u1", createdAt = "2026-10-08T10:00:00.000Z") => ({ id, body, authorId, createdAt });
  it("chaque écrivain de trace connu est reconnu par sa tête de phrase (et un commentaire sans auteur aussi)", () => {
    // Les phrases EXACTES écrites aujourd'hui au fil d'une demande.
    for (const body of [
      "Demande rouverte — la facture était fausse",
      "Demande bloquée — fournisseur injoignable",
      "Demande corrigée par son demandeur : échéance, description.",
      "Demande annulée par le secrétariat : doublon",
      "Demande annulée par son demandeur : plus besoin",
      "Correction de la retranscription demandée par le demandeur : prix faux",
      "Statut : En cours",
    ]) expect(estTraceSysteme(c("x", body)), body).toBe(true);
    expect(estTraceSysteme(c("x", "Bonjour, où en est la réservation ?", null))).toBe(true);
    expect(TETES_DE_TRACE.length).toBeGreaterThanOrEqual(6);
  });
  it("un message humain reste à la discussion, même s'il parle d'une demande", () => {
    for (const body of ["Le Pr Martin arrive le 20 au soir.", "Validé.", "La demande peut-elle être rouverte ?"]) {
      expect(estTraceSysteme(c("x", body)), body).toBe(false);
    }
  });
  it("separerLeFil : discussion humaine d'un côté ; traces + journal, dans l'ordre du temps, de l'autre", () => {
    const { discussion, historique } = separerLeFil(
      [c("c1", "Merci de prévoir un hôtel proche du CIC.", "u1", "2026-10-07T09:12:00.000Z"), c("c2", "Demande rouverte — erreur de date", "u2", "2026-10-09T08:00:00.000Z")],
      [{ id: "a1", le: "2026-10-07T09:10:00.000Z", texte: "Demande créée", par: "Nadia R." }, { id: "a2", le: "2026-10-10T16:05:00.000Z", texte: "BC signé", par: "Comptabilité" }],
    );
    expect(discussion.map((x) => x.id)).toEqual(["c1"]);
    expect(historique.map((h) => h.id)).toEqual(["j:a1", "c:c2", "j:a2"]);
    expect(historique[1].source).toBe("TRACE");
  });
});
