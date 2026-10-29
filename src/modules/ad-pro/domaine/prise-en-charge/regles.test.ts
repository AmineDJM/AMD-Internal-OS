import { describe, it, expect } from "vitest";
import {
  beneficiaryName, beneficiarySubtitle, defaultCells, careProgress, piecesDuProfessionnel, piecesADemander,
  quoteConflicts, quoteSummary, financeReadiness, type QuoteLike,
} from "./regles";

/**
 * Ces fonctions décident de ce qu'on demande à chaque personne, de ce qu'on paie et de quand
 * la demande part aux Finances. Une erreur ici ne plante rien : elle fait payer deux fois un
 * hôtel, ou laisse partir quelqu'un sans son visa.
 */

describe("beneficiaryName — l'annuaire ou le profil libre", () => {
  it("préfère le nom de l'annuaire quand la personne en vient", () => {
    expect(beneficiaryName({ doctorId: "d1", doctorName: "Pr. Benali", firstName: "X", lastName: "Y" })).toBe("Pr. Benali");
  });

  it("compose le nom d'un profil libre", () => {
    expect(beneficiaryName({ firstName: "Amina", lastName: "Kebir" })).toBe("Amina Kebir");
  });

  it("se contente d'un nom de famille", () => {
    expect(beneficiaryName({ lastName: "Kebir" })).toBe("Kebir");
  });

  it("ne rend JAMAIS une chaîne vide — une ligne sans nom serait introuvable", () => {
    expect(beneficiaryName({})).toBe("Personne sans nom");
    expect(beneficiaryName({ firstName: "  ", lastName: "  " })).toBe("Personne sans nom");
  });

  it("retombe sur le profil libre si l'annuaire ne rend pas de nom", () => {
    expect(beneficiaryName({ doctorId: "d1", doctorName: null, lastName: "Kebir" })).toBe("Kebir");
  });

  it("situe la personne par son poste et son établissement", () => {
    expect(beneficiarySubtitle({ jobTitle: "Chef de service", institution: "CHU Mustapha" })).toBe("Chef de service · CHU Mustapha");
    expect(beneficiarySubtitle({})).toBe("");
  });
});

describe("defaultCells — les pièces attendues, décision du 04/10/2026", () => {
  it("international : passeport, visa, informations de voyage", () => {
    const d = defaultCells("INTERNATIONAL");
    expect(d.map((c) => c.label)).toEqual(["Passeport", "Visa", "Informations de voyage"]);
    expect(d.every((c) => c.kind === "DOCUMENT" && c.serviceKind === null)).toBe(true);
  });

  it("national : le passeport, et lui seul", () => {
    expect(defaultCells("NATIONAL").map((c) => c.label)).toEqual(["Passeport"]);
  });
});

describe("piecesDuProfessionnel — demandée, reçue, manquante", () => {
  const cell = (id: string, label: string, status: "REQUESTED" | "PROVIDED" | "SETTLED" | "WAIVED", kind: "DOCUMENT" | "SERVICE" = "DOCUMENT") =>
    ({ id, kind, label, status, documentId: status === "PROVIDED" ? `doc-${id}` : null });

  it("une pièce sans case est MANQUANTE ; une case d'avant (« Copie du passeport ») tient le passeport", () => {
    const l = piecesDuProfessionnel("INTERNATIONAL", [cell("a", "Copie du passeport", "PROVIDED"), cell("b", "Visa", "REQUESTED")]);
    expect(l.map((p) => [p.label, p.etat])).toEqual([["Passeport", "RECUE"], ["Visa", "DEMANDEE"], ["Informations de voyage", "MANQUANTE"]]);
    expect(l[0].documentId).toBe("doc-a");
    expect(l[2].cellId).toBeNull();
  });

  it("« Frais de visa » est un ACHAT : il ne tient pas le visa", () => {
    const l = piecesDuProfessionnel("INTERNATIONAL", [cell("s", "Frais de visa", "REQUESTED", "SERVICE")]);
    expect(l.find((p) => p.label === "Visa")?.etat).toBe("MANQUANTE");
  });

  it("une pièce demandée à la main hors liste reste visible, et SETTLED/WAIVED se lisent reçue/sans objet", () => {
    const l = piecesDuProfessionnel("NATIONAL", [cell("p", "Passeport", "SETTLED"), cell("c", "CV", "WAIVED")]);
    expect(l.map((p) => [p.label, p.etat])).toEqual([["Passeport", "RECUE"], ["CV", "SANS_OBJET"]]);
  });

  it("piecesADemander ne redemande ni une pièce reçue ni une pièce sans objet", () => {
    expect(piecesADemander("INTERNATIONAL", [{ kind: "DOCUMENT", label: "Passeport" }, { kind: "DOCUMENT", label: "visa (copie)" }]).map((p) => p.label))
      .toEqual(["Informations de voyage"]);
    expect(piecesADemander("NATIONAL", [])).toHaveLength(1);
  });
});

describe("careProgress — où en est UNE personne", () => {
  it("compte ce qui est réglé et nomme ce qui manque", () => {
    const p = careProgress([
      { kind: "DOCUMENT", status: "SETTLED", label: "Passeport" },
      { kind: "SERVICE", status: "REQUESTED", label: "Hôtel" },
      { kind: "SERVICE", status: "PROVIDED", label: "Billet" },
    ]);
    expect(p.total).toBe(3);
    expect(p.settled).toBe(1);
    expect(p.missing).toEqual(["Hôtel", "Billet"]);
    expect(p.complete).toBe(false);
  });

  it("une case « sans objet » ne pèse pas — on garde la trace sans faire croire à un manque", () => {
    const p = careProgress([
      { kind: "DOCUMENT", status: "SETTLED", label: "Passeport" },
      { kind: "SERVICE", status: "WAIVED", label: "Visa" },
    ]);
    expect(p.total).toBe(1);
    expect(p.complete).toBe(true);
    expect(p.missing).toEqual([]);
  });

  it("une personne sans aucune case n'est PAS complète — son dossier n'a pas commencé", () => {
    expect(careProgress([]).complete).toBe(false);
  });

  it("additionne le coût des cases chiffrées", () => {
    const p = careProgress([
      { kind: "SERVICE", status: "SETTLED", label: "Hôtel", amountDzd: 45_000 },
      { kind: "SERVICE", status: "SETTLED", label: "Billet", amountDzd: 120_000 },
      { kind: "DOCUMENT", status: "SETTLED", label: "Passeport" },
    ]);
    expect(p.costDzd).toBe(165_000);
  });
});

describe("quoteConflicts — ne jamais payer deux fois la même chose", () => {
  const q = (id: string, status: QuoteLike["status"], cellIds: string[]): QuoteLike => ({ id, status, amountDzd: 1000, cellIds });

  it("refuse une case déjà couverte par un devis ACCEPTÉ", () => {
    const conflicts = quoteConflicts(q("q2", "PENDING", ["c1", "c9"]), [q("q1", "ACCEPTED", ["c1"])]);
    expect(conflicts).toEqual([{ cellId: "c1", acceptedQuoteId: "q1" }]);
  });

  it("un devis REFUSÉ ne bloque rien — c'est tout l'intérêt de pouvoir en refuser un", () => {
    expect(quoteConflicts(q("q2", "PENDING", ["c1"]), [q("q1", "REJECTED", ["c1"])])).toEqual([]);
  });

  it("un devis EN ATTENTE ne bloque pas non plus : on compare des offres concurrentes", () => {
    expect(quoteConflicts(q("q2", "PENDING", ["c1"]), [q("q1", "PENDING", ["c1"])])).toEqual([]);
  });

  it("ne se bloque pas lui-même quand il est déjà accepté", () => {
    expect(quoteConflicts(q("q1", "ACCEPTED", ["c1"]), [q("q1", "ACCEPTED", ["c1"])])).toEqual([]);
  });

  it("un devis de groupe signale TOUTES les cases en conflit", () => {
    const conflicts = quoteConflicts(q("q3", "PENDING", ["c1", "c2", "c3"]), [q("q1", "ACCEPTED", ["c1"]), q("q2", "ACCEPTED", ["c3"])]);
    expect(conflicts.map((c) => c.cellId).sort()).toEqual(["c1", "c3"]);
  });
});

describe("quoteSummary", () => {
  it("sépare ce qui est engagé de ce qui est encore négocié", () => {
    const s = quoteSummary([
      { id: "a", status: "ACCEPTED", amountDzd: 100_000, cellIds: [] },
      { id: "b", status: "PENDING", amountDzd: 50_000, cellIds: [] },
      { id: "c", status: "REJECTED", amountDzd: 900_000, cellIds: [] },
    ]);
    expect(s.acceptedDzd).toBe(100_000);
    expect(s.pendingDzd).toBe(50_000);
    expect(s.rejected).toBe(1);
  });
});

describe("financeReadiness — les trois raisons de ne pas envoyer aux Finances", () => {
  const done = careProgress([{ kind: "DOCUMENT", status: "SETTLED", label: "Passeport" }]);
  const todo = careProgress([{ kind: "SERVICE", status: "REQUESTED", label: "Hôtel" }]);

  it("prêt quand une personne est accordée, complète, et aucun devis en suspens", () => {
    const r = financeReadiness([{ status: "APPROVED", name: "Amina", progress: done }], [{ id: "q", status: "ACCEPTED", amountDzd: 1, cellIds: [] }]);
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("refuse une demande où personne n'a été accordé", () => {
    const r = financeReadiness([{ status: "REJECTED", name: "Amina", progress: done }], []);
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toContain("Aucune personne");
  });

  it("refuse tant qu'un devis attend une décision — le montant serait faux", () => {
    const r = financeReadiness([{ status: "APPROVED", name: "Amina", progress: done }], [{ id: "q", status: "PENDING", amountDzd: 1, cellIds: [] }]);
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes("devis"))).toBe(true);
  });

  it("nomme la personne ET ce qui lui manque — pour qu'on sache quoi relancer", () => {
    const r = financeReadiness([{ status: "APPROVED", name: "Amina Kebir", progress: todo }], []);
    expect(r.ready).toBe(false);
    expect(r.blockers.some((b) => b.includes("Amina Kebir") && b.includes("Hôtel"))).toBe(true);
  });

  it("une personne écartée ne bloque pas, même si son dossier est vide", () => {
    const r = financeReadiness(
      [
        { status: "APPROVED", name: "Amina", progress: done },
        { status: "REJECTED", name: "Karim", progress: careProgress([]) },
      ],
      [],
    );
    expect(r.ready).toBe(true);
  });

  it("une personne accordée sans aucune case est signalée explicitement", () => {
    const r = financeReadiness([{ status: "APPROVED", name: "Amina", progress: careProgress([]) }], []);
    expect(r.blockers[0]).toContain("aucun élément demandé");
  });
});
