import { describe, expect, it } from "vitest";
import {
  lireFiche, ficheStockee, ficheInitiale, comparerFiches, changements, etapeParticipation, aQuiLeTour, etatParticipation,
  estArbitre, coteDe, refusProposition, refusDecision, natureNouvelleVersion, peutDemanderOmParticipation, datesConvenues,
  reservationsAdventum, lignesReservation, peutDeposerReservation, peutChoisirBudgetMission, deviseFrais, tauxMission,
  lireLigneFrais, totalFrais, manquesCloture, refusModifFrais, refusDecisionN1NoteFrais, phaseMission, moisNoteFrais,
  resumeBilletEmis, etatNoteFraisMission, versionLite, type FicheParticipation, type VersionLite,
} from "./participation";

const CHAMPS = {
  presenceDu: "2026-11-26", presenceAu: "2026-11-29",
  transportMode: "AVION", transportDepart: "Oran", transportArrivee: "Paris", transportAller: "2026-11-26", transportRetour: "2026-11-29",
  transportReservation: "ADVENTUM", transportPrecisions: "",
  hebergementChoix: "MOI", hebergementHotel: "Ibis Porte Maillot", hebergementNuits: "3", hebergementEstimation: "420",
  commentaire: "",
};
const lue = (c: Record<string, unknown> = {}): FicheParticipation => {
  const r = lireFiche({ ...CHAMPS, ...c });
  if (!r.ok) throw new Error(r.error);
  return r.fiche;
};

describe("La fiche de participation", () => {
  it("se lit, et refuse ce qui est illisible en le nommant", () => {
    const f = lue();
    expect(f.transport.mode).toBe("AVION");
    expect(f.hebergement).toEqual({ choix: "MOI", hotel: "Ibis Porte Maillot", nuits: 3, estimation: 420 });
    expect(lireFiche({ ...CHAMPS, presenceAu: "2026-11-20" })).toMatchObject({ ok: false, error: expect.stringMatching(/précède/) });
    expect(lireFiche({ ...CHAMPS, transportRetour: "2026-11-20" })).toMatchObject({ ok: false, error: expect.stringMatching(/retour/) });
    expect(lireFiche({ ...CHAMPS, transportMode: "FUSEE" })).toMatchObject({ ok: false });
    expect(lireFiche({ ...CHAMPS, hebergementChoix: "" })).toMatchObject({ ok: false });
    expect(lireFiche({ ...CHAMPS, hebergementNuits: "2,5" })).toMatchObject({ ok: false });
  });

  it("« pas besoin » d'hôtel ne garde ni hôtel ni nuits ; l'estimation ne vaut que si je m'en occupe", () => {
    expect(lue({ hebergementChoix: "AUCUN" }).hebergement).toEqual({ choix: "AUCUN", hotel: null, nuits: null, estimation: null });
    expect(lue({ hebergementChoix: "ADVENTUM" }).hebergement.estimation).toBeNull();
  });

  it("se relit depuis la base telle qu'elle a été écrite", () => {
    const f = lue({ commentaire: "J'arrive la veille" });
    expect(ficheStockee(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(ficheStockee(null)).toBeNull();
    expect(ficheStockee({ n: 1 })).toBeNull();
  });

  it("la fiche de départ reprend les dates et la ville de l'événement", () => {
    const f = ficheInitiale({ debut: "2026-11-26", fin: "2026-11-29", ville: "Paris" });
    expect(f.presenceDu).toBe("2026-11-26");
    expect(f.transport.arrivee).toBe("Paris");
  });
});

describe("Ce qui change d'une version à l'autre", () => {
  it("surligne le morceau changé avec sa valeur d'avant, et rien sur la première version", () => {
    const v1 = lue();
    const v2 = lue({ hebergementChoix: "ADVENTUM", hebergementHotel: "" });
    const v3 = lue({ hebergementChoix: "ADVENTUM", hebergementHotel: "", transportAller: "2026-11-25", hebergementNuits: "4" });
    expect(changements(null, v1)).toEqual([]);
    expect(changements(v1, v2)).toEqual(expect.arrayContaining(["choix", "hotel", "estimation"]));
    expect(changements(v2, v3).sort()).toEqual(["dates", "nuits"]);
    const transport = comparerFiches(v2, v3, true).find((l) => l.cle === "transport")!;
    const dates = transport.segments.find((s) => s.cle === "dates")!;
    expect(dates).toMatchObject({ change: true, avant: "26/11 → 29/11", texte: "25/11 → 29/11" });
    const heb = comparerFiches(v1, v2, true).find((l) => l.cle === "hebergement")!;
    expect(heb.segments.find((s) => s.cle === "hotel")).toMatchObject({ change: true, texte: "", avant: "Ibis Porte Maillot" });
    expect(comparerFiches(null, v1, true).find((l) => l.cle === "hebergement")!.segments.some((s) => s.texte === "420 USD")).toBe(true);
  });
});

describe("La négociation — état, chez qui, qui a la main", () => {
  const base = { response: "INVITEE" as const, archivedAt: null, accordVersionId: null };
  const v = (o: Partial<VersionLite>): VersionLite => ({ numero: 1, cote: "PERSONNE", nature: "PROPOSITION", statut: "EN_ATTENTE", ...o });

  it("la balle passe de côté à chaque version ; un refus la rend à l'auteur ; l'accord clôt", () => {
    expect(etapeParticipation(base, null)).toBe("FICHE_A_REMPLIR");
    expect(etapeParticipation(base, v({}))).toBe("CHEZ_ADVENTUM");
    expect(etapeParticipation(base, v({ cote: "ADVENTUM", nature: "CONTRE_PROPOSITION" }))).toBe("CHEZ_PERSONNE");
    expect(etapeParticipation(base, v({ statut: "REFUSEE" }))).toBe("CHEZ_PERSONNE");
    expect(etapeParticipation(base, v({ cote: "ADVENTUM", statut: "REFUSEE" }))).toBe("CHEZ_ADVENTUM");
    expect(etapeParticipation({ ...base, accordVersionId: "x" }, v({ statut: "ACCEPTEE" }))).toBe("ACCORD");
    expect(etapeParticipation({ ...base, response: "DECLINEE" }, v({}))).toBe("DECLINEE");
    expect(etapeParticipation({ ...base, response: "CONFIRMEE" }, null)).toBe("CONFIRMEE_SANS_FICHE");
    expect(etapeParticipation({ ...base, archivedAt: new Date() }, null)).toBe("RETIREE");
    expect(versionLite({ numero: 2, cote: "ADVENTUM", nature: "CONTRE_PROPOSITION", statut: "??" })).toMatchObject({ statut: "EN_ATTENTE", cote: "ADVENTUM" });
    expect(aQuiLeTour("FICHE_A_REMPLIR")).toBe("PERSONNE");
    expect(aQuiLeTour("ACCORD")).toBeNull();
  });

  it("l'état se lit « état — chez qui », « chez vous » quand c'est son tour", () => {
    const noms = { personne: "Yacine Habes", organisateur: "Sonia Hamidi" };
    const contre = v({ numero: 3, nature: "CONTRE_PROPOSITION" });
    expect(etatParticipation("CHEZ_ADVENTUM", contre, "ADVENTUM", noms).texte).toBe("contre-proposition — chez vous");
    expect(etatParticipation("CHEZ_ADVENTUM", contre, "PERSONNE", noms).texte).toBe("contre-proposition — chez Sonia Hamidi");
    expect(etatParticipation("FICHE_A_REMPLIR", null, "ADVENTUM", noms, { depuis: "2026-10-01T00:00:00Z" }, Date.parse("2026-10-03T08:00:00Z")).texte)
      .toBe("fiche à remplir — chez Yacine Habes · 2 j");
    expect(etatParticipation("DECLINEE", null, null, noms, { declineReason: "séminaire interne" }).texte).toBe("déclinée — « séminaire interne »");
    expect(etatParticipation("ACCORD", null, null, noms).texte).toBe("accord trouvé");
  });

  it("tranchent côté Adventum : l'organisateur, la Direction Marketing, le Super Admin — pas un autre", () => {
    expect(estArbitre({ id: "o", roles: ["DELEGATE"] }, ["o", null])).toBe(true);
    expect(estArbitre({ id: "m", roles: ["PRODUCT_MANAGER"] }, ["o"])).toBe(true);
    expect(estArbitre({ id: "s", roles: ["SUPER_ADMIN"] }, [])).toBe(true);
    expect(estArbitre({ id: "x", roles: ["DELEGATE", "HR"] }, ["o"])).toBe(false);
    expect(coteDe("p", "p", true)).toBe("PERSONNE");
    expect(coteDe("o", "p", true)).toBe("ADVENTUM");
    expect(coteDe("x", "p", false)).toBeNull();
  });

  it("proposer : la personne ouvre, puis seul le côté qui a la balle ; l'accord se rouvre tant que l'OM est libre", () => {
    expect(refusProposition("FICHE_A_REMPLIR", "PERSONNE", true)).toBeNull();
    expect(refusProposition("FICHE_A_REMPLIR", "ADVENTUM", true)).toMatch(/remplit d'abord/);
    expect(refusProposition("CHEZ_ADVENTUM", "ADVENTUM", true)).toBeNull();
    expect(refusProposition("CHEZ_ADVENTUM", "PERSONNE", true)).toMatch(/pas votre tour/);
    expect(refusProposition("ACCORD", "PERSONNE", true)).toBeNull();
    expect(refusProposition("ACCORD", "ADVENTUM", false)).toMatch(/ordre de mission/);
    expect(refusProposition("DECLINEE", "PERSONNE", true)).toMatch(/déclinée/);
    expect(refusProposition("CHEZ_PERSONNE", null, true)).toMatch(/Seuls/);
    expect(natureNouvelleVersion(0)).toBe("PROPOSITION");
    expect(natureNouvelleVersion(2)).toBe("CONTRE_PROPOSITION");
  });

  it("accepter ou refuser : la version en attente, par qui a la balle ; un refus porte son motif", () => {
    const enAttente = v({});
    expect(refusDecision("CHEZ_ADVENTUM", enAttente, "ADVENTUM", "ACCEPTER", null)).toBeNull();
    expect(refusDecision("CHEZ_ADVENTUM", enAttente, "PERSONNE", "ACCEPTER", null)).toMatch(/pas votre tour/);
    expect(refusDecision("CHEZ_ADVENTUM", enAttente, "ADVENTUM", "REFUSER", " ")).toMatch(/pourquoi/);
    expect(refusDecision("CHEZ_PERSONNE", v({ statut: "REFUSEE" }), "PERSONNE", "ACCEPTER", null)).toMatch(/Aucune proposition/);
    expect(refusDecision("ACCORD", v({ statut: "ACCEPTEE" }), "PERSONNE", "ACCEPTER", null)).toMatch(/Aucune proposition/);
  });

  it("l'accord ouvre l'ordre de mission, aux dates du voyage convenu", () => {
    expect(peutDemanderOmParticipation("ACCORD")).toBe(true);
    expect(peutDemanderOmParticipation("CONFIRMEE_SANS_FICHE")).toBe(true);
    expect(peutDemanderOmParticipation("CHEZ_ADVENTUM")).toBe(false);
    expect(datesConvenues(lue({ transportAller: "2026-11-25" }))).toEqual({ depart: "2026-11-25", retour: "2026-11-29" });
    expect(datesConvenues(lue({ transportAller: "", transportRetour: "" }))).toEqual({ depart: "2026-11-26", retour: "2026-11-29" });
    expect(phaseMission("CHEZ_PERSONNE", false, false)).toBe("PARTICIPATION");
    expect(phaseMission("ACCORD", false, false)).toBe("ORDRE");
    expect(phaseMission("ACCORD", true, false)).toBe("MISSION");
    expect(phaseMission("ACCORD", true, true)).toBe("CLOTUREE");
  });
});

describe("La réservation et le budget", () => {
  it("ce qu'Adventum réserve part chez l'assistante ; un véhicule ne se « réserve » pas en billet", () => {
    expect(reservationsAdventum(lue())).toEqual({ billet: true, hotel: false });
    expect(reservationsAdventum(lue({ transportMode: "VEHICULE_SERVICE", hebergementChoix: "ADVENTUM" }))).toEqual({ billet: false, hotel: true });
    expect(lignesReservation("Amel", lue())[0]).toMatch(/Oran → Paris/);
  });

  it("déposent le billet : l'assistante de direction, l'organisateur, la Direction Marketing, le Super Admin", () => {
    expect(peutDeposerReservation({ id: "a", roles: ["DIRECTION_ASSISTANT"] }, [])).toBe(true);
    expect(peutDeposerReservation({ id: "o", roles: [] }, ["o"])).toBe(true);
    expect(peutDeposerReservation({ id: "x", roles: ["DELEGATE"] }, ["o"])).toBe(false);
    expect(resumeBilletEmis("X7Y2", [{ numero: "AH 1102", heureDepart: "18:40", heureArrivee: "21:15", reference: null }, { numero: null, heureDepart: null, heureArrivee: null, reference: null }]))
      .toBe("PNR X7Y2 · Aller AH 1102 18:40 → 21:15");
  });

  it("l'imputation se choisit par la Direction Marketing (ou le Super Admin), jamais d'office", () => {
    expect(peutChoisirBudgetMission(["PRODUCT_MANAGER"])).toBe(true);
    expect(peutChoisirBudgetMission(["SUPER_ADMIN"])).toBe(true);
    expect(peutChoisirBudgetMission(["DIRECTION_ASSISTANT", "DELEGATE"])).toBe(false);
  });
});

describe("Les notes de frais — USD à l'international, sauf le billet", () => {
  it("la devise découle de la nature et du périmètre ; le taux est celui, figé, de la demande", () => {
    expect(deviseFrais(true, "TAXI")).toBe("USD");
    expect(deviseFrais(true, "TRANSPORT")).toBe("DZD");
    expect(deviseFrais(false, "REPAS")).toBe("DZD");
    expect(tauxMission(true, null)).toBe(240);
    expect(tauxMission(true, 250)).toBe(250);
    expect(tauxMission(false, 250)).toBeNull();
  });

  it("une dépense se lit et se convertit en DZD au taux de la demande", () => {
    const r = lireLigneFrais({ date: "2026-11-25", nature: "TAXI", detail: "Aéroport → hôtel", montant: "45" }, true, 240);
    expect(r).toEqual({ ok: true, ligne: { date: "2026-11-25", nature: "TAXI", detail: "Aéroport → hôtel", montant: 45, devise: "USD", montantDzd: 10800 } });
    expect(lireLigneFrais({ date: "2026-11-25", nature: "TRANSPORT", montant: "32000" }, true, 240)).toMatchObject({ ok: true, ligne: { devise: "DZD", montantDzd: 32000 } });
    expect(lireLigneFrais({ date: "", nature: "TAXI", montant: "4" }, true, 240)).toMatchObject({ ok: false });
    expect(lireLigneFrais({ date: "2026-11-25", nature: "TAXI", montant: "0" }, true, 240)).toMatchObject({ ok: false });
  });

  it("le total additionne par devise et donne l'équivalent DZD", () => {
    expect(totalFrais([{ montant: 45, devise: "USD" }, { montant: 28, devise: "USD" }], 240)).toEqual({ usd: 73, dzd: 0, totalDzd: 17520 });
    expect(totalFrais([{ montant: 45, devise: "USD" }, { montant: 32000, devise: "DZD" }], 240)).toEqual({ usd: 45, dzd: 32000, totalDzd: 42800 });
    expect(totalFrais([{ montant: 10, devise: "USD" }], null).totalDzd).toBeNull();
    expect(moisNoteFrais("2026-11-29", "2026-12-03")).toBe("2026-11");
  });
});

describe("La clôture", () => {
  const prete = { cloturee: false, omEmis: true, terminee: true, rapport: { deroule: "Stand monté", medecins: null, retombees: null, suites: null }, lignes: [{ justificatif: true }] };

  it("exige l'OM émis, la mission terminée, le rapport et chaque justificatif ; sans dépense, elle se clôture", () => {
    expect(manquesCloture(prete)).toEqual([]);
    expect(manquesCloture({ ...prete, lignes: [] })).toEqual([]);
    expect(manquesCloture({ ...prete, omEmis: false })).toEqual([expect.stringMatching(/ordre de mission/)]);
    expect(manquesCloture({ ...prete, terminee: false })).toEqual([expect.stringMatching(/terminée/)]);
    expect(manquesCloture({ ...prete, rapport: { ...prete.rapport, deroule: " " } })).toEqual([expect.stringMatching(/rapport/)]);
    expect(manquesCloture({ ...prete, lignes: [{ justificatif: false }, { justificatif: false }] })).toEqual([expect.stringMatching(/2 manquants/)]);
    expect(manquesCloture({ ...prete, cloturee: true })).toEqual([expect.stringMatching(/déjà clôturée/)]);
  });

  it("les dépenses : la personne seule, après l'OM, avant la clôture", () => {
    expect(refusModifFrais({ cloturee: false, omEmis: true }, true)).toBeNull();
    expect(refusModifFrais({ cloturee: false, omEmis: true }, false)).toMatch(/Seule la personne/);
    expect(refusModifFrais({ cloturee: true, omEmis: true }, true)).toMatch(/clôturée/);
    expect(refusModifFrais({ cloturee: false, omEmis: false }, true)).toMatch(/ordre de mission/);
  });

  it("la note de frais se lit « état — chez qui » : le N+1, puis les RH", () => {
    expect(etatNoteFraisMission("PENDING", "PENDING").texte).toBe("note de frais — chez votre N+1");
    expect(etatNoteFraisMission("PENDING", "APPROVED").texte).toBe("note de frais — chez les RH");
    expect(etatNoteFraisMission("PENDING", null).texte).toBe("note de frais — chez les RH");
    expect(etatNoteFraisMission("REJECTED", "REJECTED", "doublon").texte).toBe("refusée par le N+1 — « doublon »");
    expect(etatNoteFraisMission("READY", "APPROVED").ton).toBe("success");
  });

  it("la note de frais de la mission passe par le N+1, qui motive un refus", () => {
    const nf = { type: "EXPENSE_REPORT", status: "PENDING", managerGate: "PENDING", missionAssignmentId: "a1" };
    expect(refusDecisionN1NoteFrais(nf, true, "VALIDER", null)).toBeNull();
    expect(refusDecisionN1NoteFrais(nf, false, "VALIDER", null)).toMatch(/Seul le N\+1/);
    expect(refusDecisionN1NoteFrais(nf, true, "REFUSER", "")).toMatch(/pourquoi/);
    expect(refusDecisionN1NoteFrais({ ...nf, missionAssignmentId: null }, true, "VALIDER", null)).toMatch(/pas une note de frais de mission/);
    expect(refusDecisionN1NoteFrais({ ...nf, managerGate: "APPROVED" }, true, "VALIDER", null)).toMatch(/n'attend plus/);
  });
});
