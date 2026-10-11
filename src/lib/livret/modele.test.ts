import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  A_CONFIRMER, civiliteDuGrade, delegation, livretGeneral, livretIndividuel, nomDuLivret, nomImprime, nuits, planning, plageDates,
  versPoste, volsDe, type CaseLue, type EntreeLivret, type PersonneLivret,
} from "./modele";
import { peutLirePiecePriseEnCharge, natureDuLivret, cleLivret } from "@/lib/care-pieces-acces";

const vide: Omit<CaseLue, "id" | "kind" | "serviceKind" | "label" | "status"> = {
  dateStart: null, dateEnd: null, trajet: null, transport: null, fromCity: null, toCity: null, segments: [], hotelName: null, city: null,
  roomType: null, bookingRef: null, legDetails: [], timeStart: null, address: null, issuedDocumentId: null,
};
/** Une case telle que l'écran la lit — AVEC ses montants et sa pièce : le livret doit les laisser à la porte. */
const cas = (o: Partial<CaseLue> & { id: string; serviceKind: string | null; label: string }) => ({
  kind: "SERVICE", status: "REQUESTED", ...vide, ...o,
  amountDzd: 987654, amount: 4321, currency: "USD", documentId: "doc-passeport-secret", expenseOrderId: "OD-77",
});

const billet = cas({
  id: "b1", serviceKind: "TICKET", label: "Billetterie", trajet: "ALLER_RETOUR", transport: "AVION", fromCity: "Alger", toCity: "Paris",
  dateStart: "2026-11-26", dateEnd: "2026-11-29", bookingRef: "Q7K2LM", issuedDocumentId: "doc-billet",
  legDetails: [{ numero: "AH 1006", heureDepart: "08:40", heureArrivee: "11:55", reference: null }, { numero: "AH 1007", heureDepart: "17:30", heureArrivee: "18:45", reference: null }],
});
const hotel = cas({ id: "h1", serviceKind: "HOTEL", label: "Hôtellerie", hotelName: "Hôtel du Palais", city: "Paris", dateStart: "2026-11-26", dateEnd: "2026-11-29", roomType: "Single", bookingRef: "HPC-1" });
const diner = cas({ id: "r1", serviceKind: "CATERING", label: "Dîner", dateStart: "2026-11-27", timeStart: "20:30", address: "17 rue de Beaujolais" });
const passeport = cas({ id: "p1", serviceKind: null, label: "Passeport" });

const personne = (id: string, nom: string, postes: ReturnType<typeof cas>[], o: Partial<PersonneLivret> = {}): PersonneLivret => ({
  id, nom, civilite: "PR", fonction: "Professeur", service: "Hématologie", etablissement: "CHU Mustapha", statut: "APPROVED",
  postes: postes.map((c) => versPoste({ ...c, kind: c.serviceKind ? "SERVICE" : "DOCUMENT" })), ...o,
});

const entree = (personnes: PersonneLivret[]): EntreeLivret => ({
  evenement: { nom: "Congrès SFLS 2026", ville: "Paris", pays: "France", lieu: null, debut: "2026-11-26", fin: "2026-11-29", international: true },
  personnes,
  groupe: [
    { id: "g1", serviceKind: "CATERING", label: "Déjeuner du groupe", date: "2026-11-28", timeStart: "13:00", address: "Brasserie Lorraine", exclus: [], status: "REQUESTED" },
    { id: "g2", serviceKind: "TRANSPORT", label: "Transfert vers l'aéroport", date: "2026-11-29", timeStart: "14:30", address: null, exclus: ["n2"], status: "REQUESTED" },
    { id: "g3", serviceKind: "CATERING", label: "Annulé", date: "2026-11-28", timeStart: "20:00", address: null, exclus: [], status: "WAIVED" },
  ],
  equipe: [{ nom: "Sonia Hamidi", fonction: "Chef de produit", telephone: null, du: "2026-11-26", au: "2026-11-29", billetReference: "ZX9", trajets: [], hotelNom: null, hotelConfirmation: null }],
  demandeur: { nom: "Karim Délégué", fonction: "Délégué médical", telephone: "0555 00 00 00" },
  assistante: null,
  edition: "2026-10-14",
});

describe("livret de séjour — les règles", () => {
  it("les dates se disent en français, une absence se dit « à confirmer »", () => {
    expect(plageDates("2026-11-26", "2026-11-29")).toBe("du 26 au 29 novembre 2026");
    expect(plageDates("2026-11-30", "2026-12-02")).toBe("du 30 novembre au 2 décembre 2026");
    expect(plageDates("2026-11-26", null)).toBe("le 26 novembre 2026");
    expect(plageDates(null, null)).toBe(`dates ${A_CONFIRMER}`);
    expect(nuits("2026-11-26", "2026-11-29")).toBe(3);
    expect(nuits("2026-11-29", "2026-11-26")).toBeNull();
  });

  it("la civilité vient du grade de l'annuaire, jamais en double", () => {
    expect(civiliteDuGrade("PROFESSEUR")).toBe("PR");
    expect(civiliteDuGrade("MAITRE_ASSISTANT")).toBe("DR");
    expect(civiliteDuGrade("AUTRE", "Chef de service")).toBeNull();
    expect(civiliteDuGrade(null, "Professeur")).toBe("PR");
    expect(nomImprime({ nom: "Nadia Exemple", civilite: "PR" })).toBe("Pr Nadia Exemple");
    expect(nomImprime({ nom: "Dr Karim Démo", civilite: "DR" })).toBe("Dr Karim Démo");
    expect(nomDuLivret("Pr N/A", "Congrès: 2026")).toBe("Livret — Pr N A — Congrès 2026.pdf");
  });

  it("les vols suivent les trajets du billet, avec n°, heures et référence (PNR du billet à défaut)", () => {
    const v = volsDe(personne("n1", "Nadia", [billet]));
    expect(v.map((x) => [x.libelle, x.de, x.vers, x.date, x.numero, x.heureDepart, x.reference])).toEqual([
      ["Aller", "Alger", "Paris", "2026-11-26", "AH 1006", "08:40", "Q7K2LM"],
      ["Retour", "Paris", "Alger", "2026-11-29", "AH 1007", "17:30", "Q7K2LM"],
    ]);
  });

  it("un billet « sans objet » se dit, et ne va pas au planning", () => {
    const p = personne("n1", "Nadia", [{ ...billet, status: "WAIVED" }, hotel]);
    const l = livretIndividuel(p, entree([p]));
    const voyage = JSON.stringify(l.sections[0]);
    expect(voyage).toContain("Sans billet");
    expect(JSON.stringify(l.sections[2])).not.toContain("AH 1006");
  });

  it("le planning trie par jour puis par heure, l'événement et l'hôtel compris, sans inventer d'heure", () => {
    const p = personne("n1", "Nadia", [billet, hotel, diner]);
    const l = livretIndividuel(p, entree([p]));
    const jours = l.sections[2]!.blocs;
    expect(jours.map((j) => (j.t === "jour" ? j.numero : "?"))).toEqual(["26", "27", "28", "29"]);
    const j26 = jours[0]!;
    expect(j26.t === "jour" && j26.items.map((i) => i.heure)).toEqual(["—", "08:40", "—"]);
    expect(j26.t === "jour" && j26.items[0]!.texte).toContain("Ouverture");
    expect(j26.t === "jour" && j26.items[2]!.texte).toContain("Arrivée à Hôtel du Palais");
    const j29 = jours[3]!;
    // La chambre se libère le matin, puis le transfert du groupe (14:30), puis le vol (17:30) ; « Annulé » (sans objet) n'y est pas.
    expect(j29.t === "jour" && j29.items.map((i) => i.heure)).toEqual(["—", "—", "14:30", "17:30"]);
    expect(JSON.stringify(jours)).not.toContain("Annulé");
    expect(planning([])).toEqual([]);
  });

  it("un poste de groupe dont la personne est exclue ne la concerne pas", () => {
    const p = personne("n2", "Karim", [billet]);
    expect(JSON.stringify(livretIndividuel(p, entree([p])))).not.toContain("Transfert vers l'aéroport");
  });

  it("une donnée absente s'écrit « à confirmer »", () => {
    const p = personne("n1", "Nadia", [cas({ id: "b2", serviceKind: "TICKET", label: "Billetterie", fromCity: "Oran", toCity: "Paris", dateStart: "2026-11-25" }), cas({ id: "h2", serviceKind: "HOTEL", label: "Hôtellerie" })]);
    const l = livretIndividuel(p, entree([p]));
    const s = JSON.stringify(l.sections.slice(0, 2));
    expect(s).toContain(`"valeur":"${A_CONFIRMER}"`);
    expect(s).toContain(`arrivée ${A_CONFIRMER}`);
    expect(s).toContain(`nuits ${A_CONFIRMER}`);
  });

  it("CONFIDENTIALITÉ — aucun montant, aucun ordre de dépense, aucune pièce d'identité dans les livrets", () => {
    const p1 = personne("n1", "Nadia", [billet, hotel, diner, passeport]);
    const p2 = personne("n2", "Karim", [billet], { civilite: "DR" });
    for (const l of [livretIndividuel(p1, entree([p1, p2])), livretGeneral(entree([p1, p2]))]) {
      const s = JSON.stringify(l);
      for (const interdit of ["987654", "987 654", "4321", "4 321", "DZD", "USD", "OD-77", "doc-passeport-secret", "doc-billet", "amount", "montant", "devis"]) {
        expect(s, interdit).not.toContain(interdit);
      }
    }
    // `versPoste` ne recopie que les champs du livret.
    expect(Object.keys(versPoste(billet))).not.toContain("amountDzd");
  });

  it("le livret individuel : couverture, lettre adressée, quatre sections dans l'ordre", () => {
    const p = personne("n1", "Nadia Exemple", [billet, hotel, diner]);
    const l = livretIndividuel(p, entree([p]));
    expect(l.nomFichier).toBe("Livret — Pr Nadia Exemple — Congrès SFLS 2026.pdf");
    expect(l.couverture).toMatchObject({ surtitre: "Livret de séjour", pourNom: "Pr Nadia Exemple", lieu: "Paris, France · du 26 au 29 novembre 2026" });
    expect(l.lettre.destinataire).toEqual(["Pr Nadia Exemple", "Hématologie", "CHU Mustapha"]);
    expect(l.lettre.salutation).toBe("Professeur,");
    expect(l.lettre.paragraphes[0]).toBe("Nous avons l'honneur de vous inviter au Congrès SFLS 2026, qui se tiendra à Paris du 26 au 29 novembre 2026.");
    expect(l.sections.map((s) => s.titre)).toEqual(["Votre voyage", "Votre hébergement", "Votre programme", "Informations pratiques"]);
    expect(JSON.stringify(l.sections[3])).toContain("Sonia Hamidi");
    expect(JSON.stringify(l.sections[3])).toContain("+213 (0)20 339 430");
    expect(JSON.stringify(l.sections[3])).toContain("passeport");
    expect(l.dos).toBe(false);
  });

  it("le livret général : la délégation (proposés et accordés), les chambres, le programme commun, l'équipe, le dos", () => {
    const p1 = personne("n1", "Nadia", [billet, hotel]);
    const p2 = personne("n2", "Karim", [billet, { ...hotel, id: "h3", roomType: "Double" }], { civilite: "DR", statut: "PROPOSED" });
    const p3 = personne("n3", "Écarté", [billet], { statut: "REJECTED" });
    expect(delegation([p1, p2, p3]).map((p) => p.id)).toEqual(["n1", "n2"]);
    const l = livretGeneral(entree([p1, p2, p3]));
    expect(l.couverture.pourNom).toBe("2 professionnels de santé");
    expect(l.lettre.destinataire).toBeNull();
    expect(l.sections.map((s) => s.titre)).toEqual(["La délégation", "Hébergement", "Programme commun", "L'équipe Adventum"]);
    expect(l.sections[1]!.sousTitre).toBe("Hôtel du Palais");
    const prog = JSON.stringify(l.sections[2]);
    expect(prog).toContain("(2 participants)");
    expect(prog).toContain("Déjeuner du groupe");
    expect(JSON.stringify(l)).not.toContain("Écarté");
    expect(l.dos).toBe(true);
  });
});

describe("pièces d'une prise en charge — la porte de l'assistante de direction et de l'équipe", () => {
  const f = { membreDuSujet: false, organise: false, equipe: false };
  it("le passeport s'ouvre au sujet de réservation, et à lui seul", () => {
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "PIECE_IDENTITE", membreDuSujet: true })).toBe(true);
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "PIECE_IDENTITE", organise: true, equipe: true })).toBe(false);
  });
  it("billets émis et vouchers : le sujet, ou qui les dépose (assistante, demandeur, Direction Marketing, Super Admin)", () => {
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "BILLET_EMIS", membreDuSujet: true })).toBe(true);
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "BILLET_EMIS", organise: true })).toBe(true);
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "BILLET_EMIS", equipe: true })).toBe(false);
  });
  it("le livret général s'ouvre aussi à l'équipe qui accompagne — pas le livret individuel", () => {
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "LIVRET_GENERAL", equipe: true })).toBe(true);
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "LIVRET_INDIVIDUEL", equipe: true })).toBe(false);
    expect(peutLirePiecePriseEnCharge({ ...f, nature: "AUTRE", membreDuSujet: true, organise: true, equipe: true })).toBe(false);
    expect(natureDuLivret(cleLivret(null))).toBe("LIVRET_GENERAL");
    expect(natureDuLivret(cleLivret("b1"))).toBe("LIVRET_INDIVIDUEL");
    expect(natureDuLivret("c1")).toBeNull();
  });
  it("la route de téléchargement passe bien par cette porte, après celle de la demande", () => {
    const route = readFileSync(join(process.cwd(), "src", "app", "api", "documents", "[id]", "route.ts"), "utf8");
    expect(route).toMatch(/\|\|\s*\(await peutLirePieceDePriseEnCharge\(user, doc\)\)/);
    const porte = readFileSync(join(process.cwd(), "src", "lib", "ad-pro", "passeport-acces.ts"), "utf8");
    expect(porte).toContain("issuedDocumentId: doc.id");
    expect(porte).toContain("careReservationDossierId");
  });
});
