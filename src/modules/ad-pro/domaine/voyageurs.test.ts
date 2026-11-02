import { describe, it, expect } from "vitest";
import {
  lireVoyageur, lireEtapes, separerNom, nomComplet, manquesPourReserver, ligneVoyageur, changementsVoyageur, porteDesVoyageurs, NATURES_A_VOYAGEURS,
  prochainGesteVoyageur, depassementDevisRetenus,
  type SaisieVoyageur, type VoyageurLu,
} from "./voyageurs";

/**
 * LES VOYAGEURS D'UNE BILLETTERIE (§118.175) — « donner de la flexibilité si on modifie les dates
 * ultérieurement ou quand on n'a pas les infos à l'avance ».
 */
const saisie = (s: Partial<SaisieVoyageur> = {}): SaisieVoyageur => ({
  nom: "Dr Amel Haddad", villeDepart: null, villeArrivee: null, dateDepart: null, dateRetour: null, notes: null, ...s,
});
const lu = (v: Partial<VoyageurLu> = {}): VoyageurLu => ({
  nom: "Dr Amel Haddad", prenom: null, segments: [], villeDepart: "Alger", villeArrivee: "Paris", dateDepart: new Date("2026-11-12T00:00:00Z"), dateRetour: null, notes: null, trajet: "ALLER_RETOUR", transport: null, ...v,
});

describe("un voyageur de la billetterie", () => {
  it("seule la billetterie porte des voyageurs — l'étendre est une décision, écrite en une ligne", () => {
    expect([...NATURES_A_VOYAGEURS]).toEqual(["TICKETING"]);
    expect(porteDesVoyageurs("TICKETING")).toBe(true);
    // Sans ce cas, une règle qui répondrait « oui » à tout passerait : un stand n'a pas de voyageurs.
    expect(porteDesVoyageurs("STAND")).toBe(false);
    expect(porteDesVoyageurs("ACCOMMODATION")).toBe(false);
  });

  it("un NOM suffit à l'enregistrer — on prend en charge un médecin avant de savoir quand il part", () => {
    const r = lireVoyageur(saisie());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.voyageur).toMatchObject({ nom: "Dr Amel Haddad", dateDepart: null, dateRetour: null });
  });

  it("sans nom, il n'existe pas ; une date illisible ou impossible se dit — et tout est dit en une fois", () => {
    const r = lireVoyageur(saisie({ nom: "  ", dateDepart: "31/02/2026", dateRetour: "2026-02-31" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/nom de famille/);
    expect(r.error).toMatch(/date de départ lisible/);
    // « 2026-02-31 » a la bonne forme mais n'existe pas : l'écrire donnerait le 3 mars.
    expect(r.error).toMatch(/date de retour lisible/);
  });

  it("le retour ne précède pas le départ — mais le même jour est permis", () => {
    expect(lireVoyageur(saisie({ dateDepart: "2026-11-12", dateRetour: "2026-11-10" })).ok).toBe(false);
    expect(lireVoyageur(saisie({ dateDepart: "2026-11-12", dateRetour: "2026-11-12" })).ok).toBe(true);
  });

  it("ce qui manque pour RÉSERVER est nommé — et ne bloque pas l'enregistrement", () => {
    const v = { nom: "Dr Amel Haddad", villeDepart: "Alger", villeArrivee: null, dateDepart: null, dateRetour: null, passeport: false, notes: null };
    expect(manquesPourReserver(v)).toEqual(["date de départ", "trajet", "passeport"]);
    expect(manquesPourReserver({ ...v, villeArrivee: "Paris", dateDepart: new Date("2026-11-12T00:00:00Z"), passeport: true })).toEqual([]);
  });

  it("la ligne que l'assistante lit dit ce qu'on sait ET ce qui manque", () => {
    const l = ligneVoyageur({ nom: "Dr Amel Haddad", villeDepart: "Alger", villeArrivee: "Paris", dateDepart: new Date("2026-11-12T00:00:00Z"), dateRetour: null, passeport: false, notes: "Classe éco" });
    expect(l).toBe("• Dr Amel Haddad — Alger → Paris — aller 12/11/2026, retour à confirmer (manque : passeport) — Classe éco");
  });

  it("une date décalée se dit dans le sujet — et un enregistrement à l'identique ne dérange personne", () => {
    expect(changementsVoyageur(lu(), lu())).toEqual([]);
    expect(changementsVoyageur(lu(), lu({ dateDepart: new Date("2026-11-14T00:00:00Z"), dateRetour: new Date("2026-11-20T00:00:00Z") })))
      .toEqual(["aller : 12/11/2026 → 14/11/2026", "retour : à confirmer → 20/11/2026"]);
    expect(changementsVoyageur(lu(), lu({ villeArrivee: "Lyon" }))).toEqual(["trajet : Alger → Paris devient Alger → Lyon"]);
    expect(changementsVoyageur(lu({ notes: "Classe éco" }), lu())).toEqual(["précisions : retirées"]);
  });
});

describe("trajet, transport, devis par voyageur (§118.205)", () => {
  it("en ALLER SIMPLE la date de retour est vidée et jamais exigée — même illisible", () => {
    const r = lireVoyageur(saisie({ trajet: "ALLER_SIMPLE", dateDepart: "2026-11-12", dateRetour: "pas une date" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.voyageur).toMatchObject({ trajet: "ALLER_SIMPLE", dateRetour: null });
    // Témoin : en aller-retour, la même date illisible est refusée.
    expect(lireVoyageur(saisie({ trajet: "ALLER_RETOUR", dateRetour: "pas une date" })).ok).toBe(false);
  });

  it("un trajet ou un mode inconnus sont refusés, jamais devinés ; vides, ils valent aller-retour et « à préciser »", () => {
    const r = lireVoyageur(saisie({ trajet: "ALLER_TOUT_COURT", transport: "FUSEE" }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(/trajet reconnu/); expect(r.error).toMatch(/mode de transport reconnu/); }
    const v = lireVoyageur(saisie({ transport: "TRAIN" }));
    expect(v.ok && v.voyageur).toMatchObject({ trajet: "ALLER_RETOUR", transport: "TRAIN" });
    const vide = lireVoyageur(saisie());
    expect(vide.ok && vide.voyageur).toMatchObject({ trajet: "ALLER_RETOUR", transport: null });
  });

  it("la ligne de l'assistante dit l'aller simple et le mode ; un changement de trajet se dit", () => {
    const l = ligneVoyageur({ ...lu({ trajet: "ALLER_SIMPLE", transport: "BUS" }), passeport: true });
    expect(l).toMatch(/aller simple 12\/11\/2026/);
    expect(l).not.toMatch(/retour/);
    expect(l).toMatch(/— bus —/);
    expect(changementsVoyageur(lu(), lu({ trajet: "ALLER_SIMPLE", transport: "TAXI" }))).toEqual([
      "trajet : aller-retour → aller simple", "transport : — → taxi",
    ]);
    expect(manquesPourReserver({ ...lu({ transport: null }), passeport: true })).toContain("mode de transport");
  });

  it("UN seul geste visible, dans l'ordre : passeport, puis devis, puis valider ; rien une fois retenu", () => {
    expect(prochainGesteVoyageur({ passeport: false, devis: [] }, true)).toBe("PASSEPORT");
    expect(prochainGesteVoyageur({ passeport: true, devis: [] }, true)).toBe("DEVIS");
    // Un devis ANNULÉ au registre ne compte pas : on en redemande un.
    expect(prochainGesteVoyageur({ passeport: true, devis: [{ montant: 10, retenu: false, annule: true }] }, true)).toBe("DEVIS");
    expect(prochainGesteVoyageur({ passeport: true, devis: [{ montant: 10, retenu: false }] }, true)).toBe("VALIDER");
    expect(prochainGesteVoyageur({ passeport: true, devis: [{ montant: 10, retenu: true }, { montant: 9, retenu: false }] }, true)).toBeNull();
    expect(prochainGesteVoyageur({ passeport: false, devis: [] }, false)).toBeNull();
  });

  it("un dépassement du montant accordé se DIT, au centime ; égalité, inconnu ou montant manquant : rien", () => {
    expect(depassementDevisRetenus([60000, 50000.01], 110000)?.replace(/\s/g, " ")).toMatch(/110 000,01 DZD.*110 000 DZD.*\+0,01 DZD/);
    expect(depassementDevisRetenus([60000, 50000], 110000)).toBeNull();
    expect(depassementDevisRetenus([60000, null], 1)).toBeNull();
    expect(depassementDevisRetenus([60000], null)).toBeNull();
  });
});


describe("nom et prénom séparés, trajet à plusieurs destinations (Direction, 05/10)", () => {
  it("le nom se lit « Prénom NOM » ; un voyageur d'avant la séparation garde son nom complet", () => {
    expect(nomComplet({ prenom: "Amel", nom: "Haddad" })).toBe("Amel Haddad");
    expect(nomComplet({ prenom: null, nom: "Dr Amel Haddad" })).toBe("Dr Amel Haddad");
    expect(nomComplet({ prenom: "  ", nom: "Haddad" })).toBe("Haddad");
  });

  it("la coupe d'un nom complet est une PROPOSITION : le titre reste au prénom, un mot seul est un nom", () => {
    expect(separerNom("Amel Haddad")).toEqual({ prenom: "Amel", nom: "Haddad" });
    expect(separerNom("Dr Amel Haddad")).toEqual({ prenom: "Dr Amel", nom: "Haddad" });
    expect(separerNom("Pr. Karim Ait Ahmed")).toEqual({ prenom: "Pr. Karim", nom: "Ait Ahmed" });
    expect(separerNom("Haddad")).toEqual({ prenom: "", nom: "Haddad" });
    expect(separerNom("  ")).toEqual({ prenom: "", nom: "" });
    // Un titre suivi d'UN seul mot : ce mot est le nom, pas un prénom.
    expect(separerNom("Dr Haddad")).toEqual({ prenom: "Dr", nom: "Haddad" });
  });

  it("le prénom est facultatif à l'enregistrement, et se dit manquant pour réserver quand le nom ne tient qu'en un mot", () => {
    const r = lireVoyageur(saisie({ nom: "Haddad", prenom: " Amel " }));
    expect(r.ok && r.voyageur).toMatchObject({ nom: "Haddad", prenom: "Amel" });
    const base = { villeDepart: "Alger", villeArrivee: "Paris", dateDepart: new Date("2026-11-12T00:00:00Z"), dateRetour: null, passeport: true, notes: null };
    expect(manquesPourReserver({ ...base, nom: "Haddad", prenom: null })).toEqual(["prénom"]);
    expect(manquesPourReserver({ ...base, nom: "Haddad", prenom: "Amel" })).toEqual([]);
    // Un voyageur d'avant (nom complet dans `nom`) n'est pas accusé d'un prénom qu'il porte déjà.
    expect(manquesPourReserver({ ...base, nom: "Amel Haddad", prenom: null })).toEqual([]);
  });

  it("les étapes : une ligne vide est écartée, une date impossible se dit, l'ordre du temps est exigé", () => {
    const ok = lireEtapes([{ de: "Alger", vers: "Paris", date: "2026-11-12" }, { de: "", vers: "", date: "" }, { de: "Paris", vers: "Lyon", date: "2026-11-14" }]);
    expect(ok).toEqual({ ok: true, etapes: [
      { de: "Alger", vers: "Paris", date: "2026-11-12" }, { de: "Paris", vers: "Lyon", date: "2026-11-14" },
    ] });
    expect(lireEtapes([{ de: "Alger", vers: "Paris", date: "2026-02-31" }])).toMatchObject({ ok: false });
    const inverse = lireEtapes([{ de: "A", vers: "B", date: "2026-11-14" }, { de: "B", vers: "C", date: "2026-11-12" }]);
    expect(inverse.ok).toBe(false);
    if (!inverse.ok) expect(inverse.error).toMatch(/étape 2.*précède l'étape 1/);
    // Une étape sans date ne casse pas l'ordre des autres : on prend en charge avant de connaître toutes les dates.
    expect(lireEtapes([{ de: "A", vers: "B", date: "2026-11-14" }, { de: "B", vers: "C", date: null }, { de: "C", vers: "D", date: "2026-11-15" }]).ok).toBe(true);
    expect(lireEtapes("pas du json")).toMatchObject({ ok: false });
    expect(lireEtapes('{"de":"A"}')).toMatchObject({ ok: false });
    expect(lireEtapes("")).toEqual({ ok: true, etapes: [] });
  });

  it("douze étapes au plus — la limite se dit avec son chiffre", () => {
    const treize = Array.from({ length: 13 }, (_, i) => ({ de: `V${i}`, vers: `V${i + 1}`, date: null }));
    const r = lireEtapes(treize);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/12 étapes au plus \(13 saisies\)/);
    expect(lireEtapes(treize.slice(0, 12)).ok).toBe(true);
  });

  it("PLUSIEURS DESTINATIONS : les étapes font foi, départ et retour en sont dérivés pour les lecteurs d'avant", () => {
    const segments = [
      { de: "Alger", vers: "Paris", date: "2026-11-12" },
      { de: "Paris", vers: "Alger", date: "2026-11-15" },
      { de: "Alger", vers: "Dubaï", date: "2026-12-01" },
    ];
    const r = lireVoyageur(saisie({ trajet: "MULTI_DESTINATIONS", segments: JSON.stringify(segments), villeDepart: "Ignorée", dateRetour: "2030-01-01" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voyageur.segments).toEqual(segments);
    expect(r.voyageur).toMatchObject({ villeDepart: "Alger", villeArrivee: "Dubaï", trajet: "MULTI_DESTINATIONS" });
    expect(r.voyageur.dateDepart?.toISOString().slice(0, 10)).toBe("2026-11-12");
    // La date de retour saisie par un champ que ce trajet n'a pas est IGNORÉE : la dernière étape fait foi.
    expect(r.voyageur.dateRetour?.toISOString().slice(0, 10)).toBe("2026-12-01");
    // Une seule étape : pas de retour.
    const une = lireVoyageur(saisie({ trajet: "MULTI_DESTINATIONS", segments: [{ de: "Alger", vers: "Paris", date: "2026-11-12" }] }));
    expect(une.ok && une.voyageur.dateRetour).toBeNull();
  });

  it("hors plusieurs destinations, les étapes envoyées ne sont pas gardées", () => {
    const r = lireVoyageur(saisie({ trajet: "ALLER_RETOUR", segments: [{ de: "A", vers: "B", date: "2026-11-12" }], dateDepart: "2026-11-12" }));
    expect(r.ok && r.voyageur.segments).toEqual([]);
  });

  it("une étape illisible ou inversée refuse le voyageur — rien n'est corrigé en silence", () => {
    const r = lireVoyageur(saisie({ trajet: "MULTI_DESTINATIONS", segments: [{ de: "A", vers: "B", date: "2026-11-14" }, { de: "B", vers: "C", date: "2026-11-01" }] }));
    expect(r.ok).toBe(false);
  });

  it("ce qui manque pour réserver un trajet à étapes est nommé étape par étape (dates, villes)", () => {
    const base = { nom: "Haddad", prenom: "Amel", villeDepart: "Alger", villeArrivee: "Paris", dateDepart: null, dateRetour: null, passeport: true, notes: null, trajet: "MULTI_DESTINATIONS" as const };
    expect(manquesPourReserver({ ...base, segments: [] })).toEqual(["date de chaque étape", "villes de chaque étape"]);
    expect(manquesPourReserver({ ...base, segments: [{ de: "Alger", vers: "Paris", date: null }] })).toEqual(["date de chaque étape"]);
    expect(manquesPourReserver({ ...base, segments: [{ de: "Alger", vers: null, date: "2026-11-12" }] })).toEqual(["villes de chaque étape"]);
    expect(manquesPourReserver({ ...base, segments: [{ de: "Alger", vers: "Paris", date: "2026-11-12" }] })).toEqual([]);
  });

  it("la ligne de l'assistante liste les étapes dans l'ordre ; un changement d'étapes se dit", () => {
    const segments = [{ de: "Alger", vers: "Paris", date: "2026-11-12" }, { de: "Paris", vers: "Lyon", date: null }];
    const l = ligneVoyageur({ nom: "Haddad", prenom: "Amel", villeDepart: "Alger", villeArrivee: "Lyon", dateDepart: new Date("2026-11-12T00:00:00Z"), dateRetour: null, passeport: true, notes: null, trajet: "MULTI_DESTINATIONS", transport: "AVION", segments });
    expect(l).toContain("• Amel Haddad — plusieurs destinations — avion :");
    expect(l).toContain("1. Alger → Paris le 12/11/2026");
    expect(l).toContain("2. Paris → Lyon le à confirmer");
    const apres = lu({ prenom: "Amel", nom: "Haddad", trajet: "MULTI_DESTINATIONS", segments: [...segments, { de: "Lyon", vers: "Alger", date: "2026-11-20" }] });
    const avant = lu({ prenom: "Amel", nom: "Haddad", trajet: "MULTI_DESTINATIONS", segments });
    expect(changementsVoyageur(avant, apres).join(" ; ")).toMatch(/étapes :/);
    expect(changementsVoyageur(avant, avant)).toEqual([]);
  });
});
