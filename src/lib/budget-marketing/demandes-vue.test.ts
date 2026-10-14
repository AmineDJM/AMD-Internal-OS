import { describe, expect, it } from "vitest";
import {
  comptesDesPuces, filtresDemandesDepuis, montantsDansLaCategorie, passeFiltres, regrouperParDemande, requeteDemandes,
  statutDeLaDemande, tuilesDemandes, FILTRES_DEMANDES_DEFAUT, type PosteVue,
} from "./demandes-vue";

const poste = (o: Partial<PosteVue> & Pick<PosteVue, "id" | "cleDemande">): PosteVue => ({
  demande: "Demande", nature: "Sponsoring", href: null, lieu: null, demandeur: "Amira", date: "2026-03-10T00:00:00.000Z",
  poste: "Poste", categorieId: "spons", categorie: "Sponsoring", statutCle: "APPROVED", statut: "Accordé",
  accorde: 0, engage: 0, regle: 0, historique: null, ...o,
});

// ASARI : un sponsoring ET l'honoraire de son symposium — deux postes, une demande (lignes 24 + 25 du fichier).
const POSTES: PosteVue[] = [
  poste({ id: "p1", cleDemande: "SPONSORING:asari", demande: "ASARI + symposium", poste: "Sponsoring", categorieId: "spons", categorie: "Sponsoring", statutCle: "HISTORIQUE", accorde: 2_000_000, regle: 2_000_000, historique: { ligne: 25 }, date: "2026-10-31T00:00:00.000Z" }),
  poste({ id: "p2", cleDemande: "SPONSORING:asari", demande: "ASARI + symposium", poste: "Symposium : honoraires", categorieId: "sym", categorie: "Événements › Symposium", statutCle: "HISTORIQUE", accorde: 195_475, regle: 195_475, historique: { ligne: 24 }, date: "2026-10-31T00:00:00.000Z" }),
  poste({ id: "p3", cleDemande: "EVENT:taghit", demande: "Réunion d'experts Taghit", nature: "Événement", lieu: "Taghit", poste: "Organisation", categorieId: "reu", categorie: "Événements › Réunions", accorde: 1_643_792, engage: 1_643_792 }),
  poste({ id: "p4", cleDemande: "SPONSORING:oran", demande: "6ème conférence d'Oran", poste: "Sponsoring", accorde: 2_157_018.5 }),
  poste({ id: "p5", cleDemande: "TRAINING:arv", demande: "Formation ARV", nature: "Formation", poste: "Formation", categorieId: "form", categorie: "Formation", statutCle: "PENDING", statut: "Soumis", accorde: 350_000 }),
];
const LOT = {
  "SPONSORING:asari": { mode: "CREEE" as const, lignes: [24, 25], attendues: 4, manquantes: 3, demandeurAffiche: "Direction Marketing" },
};
const CATS = [{ id: "spons", parentId: null }, { id: "evt", parentId: null }, { id: "sym", parentId: "evt" }, { id: "reu", parentId: "evt" }, { id: "form", parentId: null }];
const idsEvt = new Set(["evt", "sym", "reu"]);

describe("une ligne par demande — ses postes dessous", () => {
  const ds = regrouperParDemande(POSTES, LOT);
  const asari = ds.find((d) => d.cle === "SPONSORING:asari")!;
  it("regroupe les postes d'une même demande et additionne ses montants", () => {
    expect(ds).toHaveLength(4);
    expect(asari.postes.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(asari.accorde).toBe(2_195_475);
    expect(asari.regle).toBe(2_195_475);
  });
  it("porte ce que le lot en dit : mode, lignes du fichier, pièces, « Demandé par »", () => {
    expect(asari).toMatchObject({ origine: "HISTORIQUE", mode: "CREEE", lignes: [24, 25], pieces: { attendues: 4, manquantes: 3 }, demandeur: "Direction Marketing", statut: "PAYEE" });
    const taghit = ds.find((d) => d.cle === "EVENT:taghit")!;
    expect(taghit).toMatchObject({ origine: "CIRCUIT", mode: null, pieces: null, demandeur: "Amira", lieu: "Taghit" });
  });
  it("trie par montant accordé décroissant", () => {
    expect(ds.map((d) => d.cle)).toEqual(["SPONSORING:asari", "SPONSORING:oran", "EVENT:taghit", "TRAINING:arv"]);
  });
  it("le statut se lit sur les postes : payée, engagée, accordée, en cours", () => {
    expect(statutDeLaDemande([{ statutCle: "HISTORIQUE", accorde: 10, engage: 0, regle: 10 }])).toBe("PAYEE");
    expect(statutDeLaDemande([{ statutCle: "APPROVED", accorde: 10, engage: 5, regle: 0 }])).toBe("ENGAGEE");
    expect(statutDeLaDemande([{ statutCle: "APPROVED", accorde: 10, engage: 0, regle: 4 }])).toBe("ENGAGEE");
    expect(statutDeLaDemande([{ statutCle: "APPROVED", accorde: 10, engage: 0, regle: 0 }])).toBe("ACCORDEE");
    expect(statutDeLaDemande([{ statutCle: "PENDING", accorde: 10, engage: 0, regle: 0 }])).toBe("EN_COURS");
  });
});

describe("les filtres — statut, catégorie (sous-catégories comprises), origine, recherche", () => {
  const ds = regrouperParDemande(POSTES, LOT);
  const f = (o: Partial<typeof FILTRES_DEMANDES_DEFAUT>) => ({ ...FILTRES_DEMANDES_DEFAUT, ...o });
  const cles = (filtres: typeof FILTRES_DEMANDES_DEFAUT, ids: Set<string> | null = null) => ds.filter((d) => passeFiltres(d, filtres, ids)).map((d) => d.cle);
  it("« Événements » comprend Symposium et Réunions : ASARI y entre par son symposium", () => {
    expect(cles(f({ cat: "evt" }), idsEvt)).toEqual(["SPONSORING:asari", "EVENT:taghit"]);
    expect(montantsDansLaCategorie(ds[0], idsEvt)).toEqual({ accorde: 195_475, engage: 0, regle: 195_475 });
  });
  it("pièces manquantes, origine, statut", () => {
    expect(cles(f({ statut: "MANQUANTES" }))).toEqual(["SPONSORING:asari"]);
    expect(cles(f({ origine: "CIRCUIT" }))).toEqual(["SPONSORING:oran", "EVENT:taghit", "TRAINING:arv"]);
    expect(cles(f({ statut: "ENGAGEE" }))).toEqual(["EVENT:taghit"]);
  });
  it("la recherche lit libellés, postes, imputations et lignes « L24 », sans accents ni casse", () => {
    expect(cles(f({ q: "symposium" }))).toEqual(["SPONSORING:asari"]);
    expect(cles(f({ q: "l24" }))).toEqual(["SPONSORING:asari"]);
    expect(cles(f({ q: "reunions taghit" }))).toEqual(["EVENT:taghit"]);
    expect(cles(f({ q: "introuvable" }))).toEqual([]);
  });
  it("chaque puce compte avec les AUTRES filtres appliqués", () => {
    const c = comptesDesPuces(ds, f({ origine: "HISTORIQUE", statut: "PAYEE" }), null);
    expect(c.statut).toMatchObject({ TOUT: 1, PAYEE: 1, MANQUANTES: 1, ENGAGEE: 0 });
    expect(c.origine).toMatchObject({ TOUT: 1, HISTORIQUE: 1, CIRCUIT: 0 });
  });
  it("les tuiles : demandes, accordé / réglé dans la catégorie, pièces jointes / attendues", () => {
    const vis = ds.filter((d) => passeFiltres(d, f({ cat: "evt" }), idsEvt));
    expect(tuilesDemandes(vis, idsEvt)).toEqual({ demandes: 2, accorde: 195_475 + 1_643_792, engage: 1_643_792, regle: 195_475, piecesAttendues: 4, piecesManquantes: 3 });
  });
});

describe("les filtres vivent dans l'adresse", () => {
  it("se lisent d'une adresse, une valeur inconnue retombant sur « toutes »", () => {
    expect(filtresDemandesDepuis({ statut: "manquantes", cat: "evt", origine: "historique", q: " asari " }, CATS)).toEqual({ statut: "MANQUANTES", cat: "evt", origine: "HISTORIQUE", q: "asari" });
    expect(filtresDemandesDepuis({ statut: "n'importe", cat: "inconnue", origine: "x" }, CATS)).toEqual(FILTRES_DEMANDES_DEFAUT);
  });
  it("s'écrivent sans les valeurs par défaut, et se relisent à l'identique", () => {
    expect(requeteDemandes(FILTRES_DEMANDES_DEFAUT)).toBe("");
    const filtres = { statut: "MANQUANTES" as const, cat: "evt", origine: "CIRCUIT" as const, q: "oran" };
    const q = requeteDemandes(filtres, { env: "e1" });
    expect(q).toBe("?env=e1&statut=manquantes&cat=evt&origine=circuit&q=oran");
    const sp = Object.fromEntries(new URLSearchParams(q.slice(1)));
    expect(filtresDemandesDepuis(sp, CATS)).toEqual(filtres);
  });
});
