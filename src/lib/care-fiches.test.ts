import { describe, expect, it } from "vitest";
import {
  casesDeLaCategorie, depassementEnveloppe, deviseDuDevis, deviseDuPoste, estimations, etapesDuBillet, etatBilletterie, fichePrete,
  hotelPrerempli, lireDetailsTrajets, lireHeure, lireMontant, lirePosteSaisi, manquesPourReserverFiche, montantPosteGroupe,
  peutTeleverserBillet, prochainGesteFiche, pucesAutresPostes, resumeDesFiches, tauxDeLaDemande, versDzd, TAUX_USD_DZD_DEFAUT,
  type BeneficiaryRow, type CellRow, type QuoteRow,
} from "./care-fiches";

const cell = (o: Partial<CellRow> & { id: string }): CellRow => ({
  kind: "SERVICE", serviceKind: "OTHER", label: "Poste", notes: null, status: "REQUESTED", amountDzd: null, amount: null, currency: "DZD",
  expenseOrderId: null, promoMaterialId: null, documentId: null, promoMaterial: null, dateStart: null, dateEnd: null, trajet: null,
  transport: null, fromCity: null, toCity: null, segments: [], hotelName: null, city: null, roomType: null,
  issuedDocumentId: null, bookingRef: null, legDetails: [], timeStart: null, address: null, ...o,
});
const personne = (id: string, cells: CellRow[], status: BeneficiaryRow["status"] = "PROPOSED"): BeneficiaryRow => ({
  id, name: `Dr ${id} Exemple`, subtitle: "", fromDirectory: true, requesterOpinion: "NONE", requesterNote: null, status, decisionNote: null, cells,
});
const devis = (o: Partial<QuoteRow> & { id: string; amountDzd: number; cellIds: string[] }): QuoteRow => ({
  supplier: "Agence", reference: null, amount: null, currency: "DZD", serviceKind: null, status: "PENDING", note: null,
  cellLabels: [], retained: false, bcRequested: false, documentId: null, ...o,
});
const billetComplet = (id: string) => cell({ id, serviceKind: "TICKET", label: "Billetterie", trajet: "ALLER_RETOUR", transport: "AVION", fromCity: "Alger", toCity: "Paris", dateStart: "2026-11-26", dateEnd: "2026-11-29" });
const hotelComplet = (id: string) => cell({ id, serviceKind: "HOTEL", label: "Hôtellerie", hotelName: "Hôtel du Palais", city: "Paris", dateStart: "2026-11-26", dateEnd: "2026-11-29" });
const passeport = (id: string, status: CellRow["status"] = "PROVIDED") => cell({ id, kind: "DOCUMENT", serviceKind: null, label: "Passeport", status });

describe("la devise — le dollar à l'international, sauf la billetterie", () => {
  it("chaque poste a sa devise de saisie", () => {
    expect(deviseDuPoste("INTERNATIONAL", "TICKET")).toBe("DZD");
    expect(deviseDuPoste("INTERNATIONAL", "HOTEL")).toBe("USD");
    expect(deviseDuPoste("INTERNATIONAL", "CATERING")).toBe("USD");
    expect(deviseDuPoste("NATIONAL", "HOTEL")).toBe("DZD");
  });

  it("le taux est FIGÉ sur la demande : 240 par défaut, celui de la demande s'il est posé, aucun au national", () => {
    expect(TAUX_USD_DZD_DEFAUT).toBe(240);
    expect(tauxDeLaDemande("INTERNATIONAL", null)).toBe(240);
    expect(tauxDeLaDemande("INTERNATIONAL", 250)).toBe(250);
    expect(tauxDeLaDemande("NATIONAL", 250)).toBeNull();
  });

  it("USD → DZD au taux de la demande ; un montant en dollars sans taux n'est jamais deviné", () => {
    expect(versDzd(100, "USD", 240)).toBe(24000);
    expect(versDzd(12.5, "USD", 240)).toBe(3000);
    expect(versDzd(38000, "DZD", null)).toBe(38000);
    expect(versDzd(100, "USD", null)).toBeNull();
    expect(versDzd(null, "USD", 240)).toBeNull();
  });

  it("un devis est dans UNE devise : billets et autres postes mêlés à l'international se refusent", () => {
    expect(deviseDuDevis("INTERNATIONAL", ["TICKET", "TICKET"])).toEqual({ ok: true, devise: "DZD" });
    expect(deviseDuDevis("INTERNATIONAL", ["HOTEL", "CATERING"])).toEqual({ ok: true, devise: "USD" });
    expect(deviseDuDevis("INTERNATIONAL", ["TICKET", "HOTEL"]).ok).toBe(false);
    expect(deviseDuDevis("NATIONAL", ["TICKET", "HOTEL"])).toEqual({ ok: true, devise: "DZD" });
  });

  it("un montant se lit avec espaces et virgule ; illisible ou négatif se refuse", () => {
    expect(lireMontant("38 000")).toEqual({ ok: true, montant: 38000 });
    expect(lireMontant("1 250,50")).toEqual({ ok: true, montant: 1250.5 });
    expect(lireMontant("")).toEqual({ ok: true, montant: null });
    expect(lireMontant("-5").ok).toBe(false);
    expect(lireMontant("douze").ok).toBe(false);
  });
});

describe("les postes de groupe — unitaire × personnes, exclusions une à une", () => {
  const gens = [
    { id: "a", status: "APPROVED" as const }, { id: "b", status: "PROPOSED" as const },
    { id: "c", status: "REJECTED" as const }, { id: "d", status: "PROPOSED" as const },
  ];
  it("« repas 100 USD par personne » × les personnes vivantes non exclues", () => {
    const repas = { unitAmountDzd: versDzd(100, "USD", 240), excludedBeneficiaryIds: ["d"], status: "REQUESTED" as const };
    // a et b : c est écartée, d est exclue.
    expect(montantPosteGroupe(repas, gens)).toBe(48000);
  });
  it("sans unitaire, pas de montant ; sans objet, zéro", () => {
    expect(montantPosteGroupe({ unitAmountDzd: null, excludedBeneficiaryIds: [], status: "REQUESTED" }, gens)).toBeNull();
    expect(montantPosteGroupe({ unitAmountDzd: 1000, excludedBeneficiaryIds: [], status: "WAIVED" }, gens)).toBe(0);
  });
});

describe("l'estimé — devis qui comptent + montants saisis + postes de groupe", () => {
  it("MODE INDIVIDUEL : chaque fiche porte ses montants ; une personne écartée sort du total", () => {
    const personnes = [
      personne("a", [cell({ id: "a1", amountDzd: 300000 }), cell({ id: "a2", amountDzd: 50000 })]),
      personne("b", [cell({ id: "b1", amountDzd: 200000 }), cell({ id: "b2", amountDzd: 9999, status: "WAIVED" })]),
      personne("c", [cell({ id: "c1", amountDzd: 70000 })], "REJECTED"),
    ];
    const e = estimations({ personnes, devis: [] });
    expect(e.total).toBe(550000);
    expect(e.parPersonne.get("a")).toBe(350000);
    expect(e.parPersonne.get("b")).toBe(200000);
    expect(e.saisis).toBe(550000);
  });

  it("MODE DE GROUPE : UN devis de billetterie couvre trois fiches — compté une fois, partagé à parts égales", () => {
    const personnes = ["a", "b", "c"].map((id) => personne(id, [billetComplet(`${id}-t`)]));
    const cases = casesDeLaCategorie(personnes, "TICKET");
    expect(cases).toEqual(["a-t", "b-t", "c-t"]);
    const e = estimations({ personnes, devis: [devis({ id: "q", amountDzd: 900000, cellIds: cases, retained: true })] });
    expect(e.total).toBe(900000);
    expect(e.devis).toBe(900000);
    expect(e.parPersonne.get("b")).toBe(300000);
    expect(e.parCase.get("c-t")).toBe(300000);
  });

  it("un devis reçu mais pas retenu ne compte pas ; le montant saisi reste l'estimé", () => {
    const personnes = [personne("a", [cell({ id: "a1", amountDzd: 100000 })])];
    expect(estimations({ personnes, devis: [devis({ id: "q", amountDzd: 120000, cellIds: ["a1"] })] }).total).toBe(100000);
    expect(estimations({ personnes, devis: [devis({ id: "q", amountDzd: 120000, cellIds: ["a1"], retained: true })] }).total).toBe(120000);
  });

  it("un devis retenu entièrement couvert par un devis ACCEPTÉ ne compte pas deux fois", () => {
    const personnes = [personne("a", [cell({ id: "a1" })])];
    const e = estimations({
      personnes,
      devis: [devis({ id: "ok", amountDzd: 80000, cellIds: ["a1"], status: "ACCEPTED" }), devis({ id: "r", amountDzd: 90000, cellIds: ["a1"], retained: true })],
    });
    expect(e.total).toBe(80000);
  });

  it("les postes de groupe s'ajoutent au total et à la part de chaque personne concernée", () => {
    const personnes = [personne("a", []), personne("b", [])];
    const e = estimations({ personnes, devis: [], groupe: [{ unitAmountDzd: 24000, excludedBeneficiaryIds: ["b"], status: "REQUESTED" }] });
    expect(e.total).toBe(24000);
    expect(e.groupe).toBe(24000);
    expect(e.parPersonne.get("a")).toBe(24000);
    expect(e.parPersonne.get("b")).toBe(0);
  });

  it("le dépassement de l'enveloppe se DIT, sans rien bloquer ; rien à dire sous l'enveloppe ou sans enveloppe", () => {
    expect(depassementEnveloppe(2_600_000, 2_500_000)).toMatch(/dépasse l'enveloppe accordée .* de 100\s000 DZD/);
    expect(depassementEnveloppe(2_184_000, 2_500_000)).toBeNull();
    expect(depassementEnveloppe(2_184_000, null)).toBeNull();
  });
});

describe("la fiche — prête pour réserver, et son prochain geste", () => {
  it("INTERNATIONAL : le passeport est exigé ; NATIONAL : la pièce d'identité reste facultative", () => {
    const cells = [billetComplet("t"), hotelComplet("h")];
    expect(fichePrete("INTERNATIONAL", "Dr A Exemple", cells, false)).toBe(false);
    expect(manquesPourReserverFiche("INTERNATIONAL", "Dr A Exemple", cells, false)).toEqual(["passeport"]);
    expect(fichePrete("INTERNATIONAL", "Dr A Exemple", cells, true)).toBe(true);
    expect(fichePrete("NATIONAL", "Dr A Exemple", cells, false)).toBe(true);
  });

  it("« sans billet » : seul l'hôtel compte ; sans billet NI hôtel, rien à réserver", () => {
    const sansBillet = [cell({ ...billetComplet("t"), status: "WAIVED" }), hotelComplet("h")];
    expect(fichePrete("INTERNATIONAL", "Dr A Exemple", sansBillet, false)).toBe(true);
    const rien = [cell({ ...billetComplet("t"), status: "WAIVED" }), cell({ ...hotelComplet("h"), status: "WAIVED" })];
    expect(fichePrete("NATIONAL", "Dr A Exemple", rien, true)).toBe(false);
  });

  it("un hôtel sans dates n'est pas prêt", () => {
    expect(manquesPourReserverFiche("NATIONAL", "Dr A Exemple", [cell({ id: "h", serviceKind: "HOTEL", city: "Oran" })], true)).toEqual(["dates de l'hôtel"]);
  });

  it("le prochain geste suit l'ordre : passeport, compléter, devis, retenir, BC", () => {
    const nom = "Dr A Exemple";
    expect(prochainGesteFiche("INTERNATIONAL", nom, [billetComplet("t"), hotelComplet("h")], false, [], true)).toBe("PASSEPORT");
    expect(prochainGesteFiche("INTERNATIONAL", nom, [cell({ id: "t", serviceKind: "TICKET" }), hotelComplet("h")], true, [], true)).toBe("COMPLETER");
    const complet = [billetComplet("t"), hotelComplet("h")];
    expect(prochainGesteFiche("INTERNATIONAL", nom, complet, true, [], true)).toBe("DEVIS");
    const recu = [{ id: "q", status: "PENDING" as const, amountDzd: 1, cellIds: ["t", "h"], retained: false }];
    expect(prochainGesteFiche("INTERNATIONAL", nom, complet, true, recu, true)).toBe("RETENIR");
    const retenu = [{ ...recu[0]!, retained: true }];
    expect(prochainGesteFiche("INTERNATIONAL", nom, complet, true, retenu, true)).toBe("BC");
    expect(prochainGesteFiche("INTERNATIONAL", nom, complet, true, [{ ...retenu[0]!, bcRequested: true }], true)).toBeNull();
    expect(prochainGesteFiche("INTERNATIONAL", nom, complet, false, [], false)).toBeNull();
  });

  it("l'état de la billetterie se lit en mots de tableau", () => {
    const nom = "Dr A Exemple";
    expect(etatBilletterie("INTERNATIONAL", nom, [billetComplet("t")], false, []).libelle).toMatch(/passeport manquant/);
    expect(etatBilletterie("INTERNATIONAL", nom, [cell({ ...billetComplet("t"), status: "WAIVED" })], false, []).libelle).toBe("sans billet");
    const deux = [devis({ id: "1", amountDzd: 1, cellIds: ["t"] }), devis({ id: "2", amountDzd: 2, cellIds: ["t"] })];
    expect(etatBilletterie("INTERNATIONAL", nom, [billetComplet("t")], true, deux).libelle).toBe("2 devis à choisir");
    expect(etatBilletterie("INTERNATIONAL", nom, [billetComplet("t")], true, [{ ...deux[0]!, retained: true }]).libelle).toBe("devis retenu");
  });

  it("les autres postes se résument en puces, répétitions comptées", () => {
    const cells = [billetComplet("t"), hotelComplet("h"), cell({ id: "1", label: "Déjeuner" }), cell({ id: "2", label: "Déjeuner" }), cell({ id: "3", label: "Dîner" }), cell({ id: "4", label: "Hôtellerie supplémentaire", serviceKind: "HOTEL" })];
    expect(pucesAutresPostes(cells)).toEqual(["Déjeuner ×2", "Dîner", "Hôtellerie supplémentaire"]);
  });

  it("le résumé de la demande compte billets, nuits, autres postes et fiches prêtes", () => {
    const r = resumeDesFiches("INTERNATIONAL", [
      personne("a", [billetComplet("t"), hotelComplet("h"), passeport("p"), cell({ id: "x", label: "Dîner", amountDzd: 24000 })], "APPROVED"),
      personne("b", [billetComplet("t2"), cell({ ...hotelComplet("h2"), status: "WAIVED" })]),
    ], [], []);
    expect([r.vivantes, r.accordees, r.pretes, r.billets, r.nuits, r.autres]).toEqual([2, 1, 1, 2, 3, 1]);
    expect(r.estimations.total).toBe(24000);
  });
});

describe("la saisie d'un poste — les règles du sponsoring, et l'heure des autres postes", () => {
  it("un retour avant l'aller se refuse ; un aller simple ne garde pas de retour", () => {
    expect(lirePosteSaisi("TICKET", "Dr A", { trajet: "ALLER_RETOUR", dateStart: "2026-11-29", dateEnd: "2026-11-26" }).ok).toBe(false);
    const simple = lirePosteSaisi("TICKET", "Dr A", { trajet: "ALLER_SIMPLE", dateStart: "2026-11-26", dateEnd: "2026-11-29", fromCity: "Alger", toCity: "Paris" });
    expect(simple.ok && simple.poste.dateEnd).toBeNull();
  });

  it("un hôtel : le départ ne précède pas l'arrivée", () => {
    expect(lirePosteSaisi("HOTEL", "Dr A", { dateStart: "2026-11-29", dateEnd: "2026-11-26" }).ok).toBe(false);
    const h = lirePosteSaisi("HOTEL", "Dr A", { hotelName: "Palais", city: "Paris", dateStart: "2026-11-26", dateEnd: "2026-11-29", roomType: "Single", amount: "450" });
    expect(h.ok && [h.poste.hotelName, h.poste.roomType, h.poste.amount]).toEqual(["Palais", "Single", 450]);
  });

  it("un autre poste : date, HEURE et lieu ; une heure illisible se refuse", () => {
    const r = lirePosteSaisi("CATERING", "Dr A", { label: "Dîner", dateStart: "2026-11-27", timeStart: "20:30", address: "Le Grand Véfour, Paris", amount: "175" });
    expect(r.ok && [r.poste.timeStart, r.poste.address, r.poste.amount]).toEqual(["20:30", "Le Grand Véfour, Paris", 175]);
    expect(lirePosteSaisi("CATERING", "Dr A", { timeStart: "25:00" }).ok).toBe(false);
    expect(lireHeure("9h05")).toEqual({ ok: true, heure: "09:05" });
  });

  it("l'hôtel reprend la ville de l'événement et les dates du billet", () => {
    expect(hotelPrerempli({ city: "Paris" }, billetComplet("t"))).toEqual({ city: "Paris", dateStart: "2026-11-26", dateEnd: "2026-11-29" });
    expect(hotelPrerempli({ city: "Paris" }, cell({ ...billetComplet("t"), trajet: "ALLER_SIMPLE" })).dateEnd).toBeNull();
    expect(hotelPrerempli({ city: "Paris" }, null)).toEqual({ city: "Paris", dateStart: null, dateEnd: null });
  });
});

describe("le billet émis — trajets, horaires, et qui le dépose", () => {
  it("les trajets d'un aller-retour : l'aller puis le retour à l'envers", () => {
    expect(etapesDuBillet(billetComplet("t"))).toEqual([
      { de: "Alger", vers: "Paris", date: "2026-11-26" }, { de: "Paris", vers: "Alger", date: "2026-11-29" },
    ]);
    expect(etapesDuBillet(cell({ ...billetComplet("t"), trajet: "ALLER_SIMPLE" }))).toHaveLength(1);
  });

  it("les détails s'alignent sur les trajets ; une heure illisible nomme le trajet", () => {
    const ok = lireDetailsTrajets(JSON.stringify([{ numero: "AH 1006", heureDepart: "08:15", heureArrivee: "11:40", reference: "X7KQ2P" }]), 2);
    expect(ok.ok && ok.details).toEqual([
      { numero: "AH 1006", heureDepart: "08:15", heureArrivee: "11:40", reference: "X7KQ2P" },
      { numero: null, heureDepart: null, heureArrivee: null, reference: null },
    ]);
    const ko = lireDetailsTrajets([{}, { heureDepart: "8h99" }], 2);
    expect(ko.ok === false && ko.error).toBe("Trajet 2 : heure illisible (HH:MM).");
  });

  it("l'assistante de direction, le demandeur, la Direction Marketing, le Super Admin — et personne d'autre", () => {
    const d = { requesterId: "dem" };
    expect(peutTeleverserBillet({ id: "x", roles: ["DIRECTION_ASSISTANT"], vueGlobale: false }, d)).toBe(true);
    expect(peutTeleverserBillet({ id: "dem", roles: ["MEDICAL_DELEGATE"], vueGlobale: false }, d)).toBe(true);
    expect(peutTeleverserBillet({ id: "x", roles: ["PRODUCT_MANAGER"], vueGlobale: false }, d)).toBe(true);
    expect(peutTeleverserBillet({ id: "x", roles: ["SUPER_ADMIN"], vueGlobale: false }, d)).toBe(true);
    expect(peutTeleverserBillet({ id: "x", roles: ["MEDICAL_DELEGATE"], vueGlobale: false }, d)).toBe(false);
  });
});
