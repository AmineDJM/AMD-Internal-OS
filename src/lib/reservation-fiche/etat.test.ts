import { describe, expect, it } from "vitest";
import {
  diffEmpreintes, empreinteBillet, empreinteHotel, etatApres, etatFiche, etatLu, etatRepris, etatsSource, fichesAEnvoyer,
  gestePossible, lireEmpreinte, manquesHebergement, prochaineRelance, refusGeste, refusRelance, resumeEnvois, sousEtat,
  tuilesFiches, versEnvoiVue, DELAI_RELANCE_MS, type EtatDemande, type FicheBilletLue,
} from "./etat";

const billet: FicheBilletLue = {
  nom: "Salem Smail", trajet: "aller-retour", villeDepart: "Alger", villeArrivee: "Constantine",
  dateDepart: "2026-10-23", dateRetour: "2026-10-25", etapes: [], transport: "avion", notes: null,
};
const H = 3600_000;

describe("Fiches de voyage — machine d'états", () => {
  it("une fiche jamais envoyée part ; une fiche chez l'assistante ne repart pas, elle se relance", () => {
    expect(gestePossible("ENVOYER", null)).toBe(true);
    for (const e of ["ENVOYEE", "PRISE", "DEVIS_RECU"] as EtatDemande[]) {
      expect(gestePossible("ENVOYER", e)).toBe(false);
      expect(refusGeste("ENVOYER", e)).toMatch(/déjà chez l'assistante/);
      expect(gestePossible("RELANCER", e)).toBe(true);
    }
    expect(refusGeste("ENVOYER", "RESERVEE")).toMatch(/déjà réservée/);
  });

  it("renvoyer après un manque, une modification ou un retrait — la fiche revient à celle qui l'avait prise", () => {
    for (const e of ["MANQUE_SIGNALE", "MODIFIEE_APRES_ENVOI", "RETIREE"] as EtatDemande[]) expect(gestePossible("ENVOYER", e)).toBe(true);
    expect(etatApres("ENVOYER", null)).toBe("ENVOYEE");
    expect(etatApres("ENVOYER", { priseParId: "assia" })).toBe("PRISE");
    expect(etatApres("ENVOYER", { priseParId: null })).toBe("ENVOYEE");
  });

  it("prendre : seulement « à prendre » ; une fiche déjà prise le dit", () => {
    expect(etatsSource("PRENDRE")).toEqual(["ENVOYEE"]);
    expect(refusGeste("PRENDRE", "PRISE")).toMatch(/déjà prise/);
    expect(refusGeste("PRENDRE", "RETIREE")).toMatch(/n'est plus à prendre/);
  });

  it("une fiche réservée ne se retire plus ; le dépôt d'une seconde pièce reste possible", () => {
    expect(refusGeste("RETIRER", "RESERVEE")).toMatch(/ne se retire plus/);
    expect(gestePossible("DEPOSER", "RESERVEE")).toBe(true);
    expect(gestePossible("DEPOSER", "MANQUE_SIGNALE")).toBe(false);
    expect(gestePossible("SIGNALER_MANQUE", "RESERVEE")).toBe(false);
  });

  it("une modification annulée rend la fiche à son état d'avant", () => {
    expect(etatRepris({ priseParId: null, devisRecuLe: null })).toBe("ENVOYEE");
    expect(etatRepris({ priseParId: "a", devisRecuLe: null })).toBe("PRISE");
    expect(etatRepris({ priseParId: "a", devisRecuLe: new Date() })).toBe("DEVIS_RECU");
  });
});

describe("Fiches de voyage — empreinte et ce qui a changé", () => {
  it("une date changée après l'envoi se lit champ par champ", () => {
    const avant = empreinteBillet(billet);
    const apres = empreinteBillet({ ...billet, dateDepart: "2026-10-24" });
    expect(diffEmpreintes(avant, apres)).toEqual([{ champ: "Aller", avant: "23/10/2026", apres: "24/10/2026" }]);
    expect(diffEmpreintes(avant, empreinteBillet({ ...billet }))).toEqual([]);
  });

  it("passer en plusieurs destinations : les étapes apparaissent, l'aller-retour disparaît", () => {
    const avant = empreinteBillet(billet);
    const apres = empreinteBillet({ ...billet, trajet: "plusieurs destinations", etapes: [{ de: "Ouargla", vers: "Alger", date: "2026-10-22" }, { de: "Alger", vers: "Constantine", date: null }] });
    const champs = diffEmpreintes(avant, apres).map((c) => c.champ);
    expect(champs).toContain("Trajet");
    expect(champs).toContain("Étape 1");
    expect(champs).toContain("Aller");
  });

  it("l'empreinte d'un hôtel et sa relecture depuis le JSON stocké", () => {
    const e = empreinteHotel({ nom: "Nora Fennich", hotel: null, ville: "Constantine", dateArrivee: "2026-10-23", dateDepart: "2026-10-25", typeChambre: "Single", notes: null });
    expect(e["Hôtel"]).toBe("—");
    expect(lireEmpreinte(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(lireEmpreinte(null)).toBeNull();
    expect(lireEmpreinte([1, 2])).toBeNull();
  });

  it("ce qui manque à une fiche hôtellerie : l'hôtel ou la ville, et les deux dates", () => {
    expect(manquesHebergement({ hotel: null, ville: null, dateArrivee: null, dateDepart: "2026-10-25" })).toEqual(["hôtel ou ville", "dates de l'hôtel"]);
    expect(manquesHebergement({ hotel: null, ville: "Oran", dateArrivee: "2026-11-05", dateDepart: "2026-11-08" })).toEqual([]);
  });

  it("lecture de repli : une fiche chez l'assistante dont les champs ont bougé est « modifiée après l'envoi »", () => {
    const envoyee = empreinteBillet(billet);
    const actuelle = empreinteBillet({ ...billet, dateRetour: "2026-10-26" });
    expect(etatLu({ etat: "PRISE", empreinte: envoyee }, actuelle)).toBe("MODIFIEE_APRES_ENVOI");
    expect(etatLu({ etat: "PRISE", empreinte: envoyee }, envoyee)).toBe("PRISE");
    // Reprise d'un envoi en bloc d'avant : pas d'empreinte, on ne déduit rien.
    expect(etatLu({ etat: "ENVOYEE", empreinte: null }, actuelle)).toBe("ENVOYEE");
    // Une fiche réservée n'est plus comparée.
    expect(etatLu({ etat: "RESERVEE", empreinte: envoyee }, actuelle)).toBe("RESERVEE");
  });

  it("l'état affiché : brouillon, prête, ou celui de la demande (une fiche retirée redevient prête)", () => {
    const e = empreinteBillet(billet);
    expect(etatFiche(null, ["passeport"], e)).toBe("BROUILLON");
    expect(etatFiche(null, [], e)).toBe("PRETE");
    expect(etatFiche({ etat: "RETIREE", empreinte: e }, [], e)).toBe("PRETE");
    expect(etatFiche({ etat: "ENVOYEE", empreinte: e }, [], e)).toBe("ENVOYEE");
  });
});

describe("Fiches de voyage — la relance, une fois par 24 h", () => {
  const envoyeeLe = new Date("2026-10-12T09:14:00Z");
  it("trop tôt après l'envoi : refusée, avec l'attente en heures", () => {
    const r = refusRelance({ etat: "ENVOYEE", envoyeeLe, derniereRelanceLe: null }, new Date(envoyeeLe.getTime() + 5 * H));
    expect(r).toMatch(/dans 19 h/);
  });
  it("24 h après l'envoi : possible ; 24 h après la dernière relance : de nouveau possible", () => {
    expect(refusRelance({ etat: "ENVOYEE", envoyeeLe, derniereRelanceLe: null }, new Date(envoyeeLe.getTime() + DELAI_RELANCE_MS))).toBeNull();
    const relance = new Date(envoyeeLe.getTime() + 30 * H);
    expect(prochaineRelance({ envoyeeLe, derniereRelanceLe: relance }).getTime()).toBe(relance.getTime() + DELAI_RELANCE_MS);
    expect(refusRelance({ etat: "PRISE", envoyeeLe, derniereRelanceLe: relance }, new Date(relance.getTime() + 2 * H))).toMatch(/dans 22 h/);
  });
  it("on ne relance pas une fiche qui n'est plus chez l'assistante", () => {
    expect(refusRelance({ etat: "MANQUE_SIGNALE", envoyeeLe, derniereRelanceLe: null }, new Date(envoyeeLe.getTime() + 48 * H))).toMatch(/chez l'assistante/);
  });
});

describe("Fiches de voyage — phrases et comptes", () => {
  const maintenant = new Date("2026-10-14T09:00:00Z");
  it("le sous-état : « depuis 2 j · relancée 1 fois »", () => {
    expect(sousEtat({ etat: "ENVOYEE", envoyeeLe: new Date("2026-10-12T08:00:00Z"), relances: 1 }, "ENVOYEE", maintenant)).toBe("depuis 2 j · relancée 1 fois");
    expect(sousEtat({ etat: "PRISE", envoyeeLe: maintenant, relances: 0 }, "PRISE", maintenant)).toBe("envoyée à l'instant");
    expect(sousEtat({ etat: "MANQUE_SIGNALE", envoyeeLe: maintenant, relances: 0, manqueMotif: "dates" }, "MANQUE_SIGNALE", maintenant)).toBe("il manque : dates");
  });

  it("le bandeau du poste, et les fiches que « Envoyer les fiches prêtes » emporte", () => {
    expect(resumeEnvois(["ENVOYEE", "PRISE", "RESERVEE", "BROUILLON", "PRETE", "MODIFIEE_APRES_ENVOI", "MANQUE_SIGNALE"]))
      .toEqual({ chezElle: 2, reservees: 1, aCompleter: 2, aRenvoyer: 1, pretes: 1 });
    const lot = fichesAEnvoyer([
      { id: "a", etat: "PRETE" as const, manques: [] }, { id: "b", etat: "BROUILLON" as const, manques: ["passeport"] },
      { id: "c", etat: "MODIFIEE_APRES_ENVOI" as const, manques: [] }, { id: "d", etat: "ENVOYEE" as const, manques: [] },
    ]);
    expect(lot.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("les tuiles de l'assistante", () => {
    expect(tuilesFiches([
      { etat: "ENVOYEE", relances: 1 }, { etat: "ENVOYEE", relances: 0 }, { etat: "PRISE", relances: 2 },
      { etat: "MODIFIEE_APRES_ENVOI", relances: 0 }, { etat: "RESERVEE", relances: 3 },
    ])).toEqual({ aPrendre: 2, enCours: 2, relancees: 2 });
  });

  it("la vue d'une fiche : modifiée après l'envoi, avec ce qui a changé et la relance bloquée", () => {
    const envoyee = empreinteBillet(billet);
    const v = versEnvoiVue({
      source: "VOYAGEUR", ficheId: "v1", nature: "BILLET", manques: [], empreinte: empreinteBillet({ ...billet, dateDepart: "2026-10-24" }),
      demande: { id: "d1", etat: "PRISE", empreinte: envoyee, envoyeeLe: maintenant, relances: 0, derniereRelanceLe: null, priseParId: "u", reserveeLe: null, manqueMotif: null, referenceReservation: null },
      priseParNom: "Assia Abdelaziz", pieces: [],
    }, maintenant);
    expect(v.etat).toBe("MODIFIEE_APRES_ENVOI");
    expect(v.changements).toHaveLength(1);
    expect(v.refusRelance).toBeNull(); // pas chez elle : la relance ne s'offre pas, c'est le renvoi qui s'offre
    expect(v.motifRetraitRequis).toBe(true);
    const chezElle = versEnvoiVue({
      source: "VOYAGEUR", ficheId: "v1", nature: "BILLET", manques: [], empreinte: envoyee,
      demande: { id: "d1", etat: "PRISE", empreinte: envoyee, envoyeeLe: maintenant, relances: 0, derniereRelanceLe: null, priseParId: "u", reserveeLe: null, manqueMotif: null, referenceReservation: null },
      priseParNom: "Assia Abdelaziz", pieces: [],
    }, maintenant);
    expect(chezElle.libelle).toBe("Prise par Assia");
    expect(chezElle.refusRelance).toMatch(/24 h/);
  });
});
