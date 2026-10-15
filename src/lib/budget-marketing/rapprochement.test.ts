import { describe, expect, it } from "vitest";
import {
  attendueCouverte, certitudeDe, cleFournisseur, comparerMontants, doublonsProbables, dzd, extraireReferences, finaliser,
  indiceHorsAdPro, memeFournisseur, proposerPourDepense, proposerPourPiece, rapprocherDepenses, sansLesDecidees, typeDePiece,
  type DemandeCible, type DepenseARapprocher, type ElementDoublon, type PieceARapprocher, type Proposition,
} from "./rapprochement";
import { horsPostesAdPro, TITRE_DEJA_IMPUTE_HORS_POSTES } from "./depenses-autres";

/**
 * LE MOTEUR DU RAPPROCHEMENT — fixtures SYNTHÉTIQUES (aucune donnée de production) : montants, sommes, fournisseurs,
 * dates, références, la règle « certaine » et son unicité, « pas Ad & Pro », pièces → pièces attendues, doublons.
 */

const demande = (o: Partial<DemandeCible> & Pick<DemandeCible, "rowId" | "libelle" | "montant">): DemandeCible => ({
  cle: `SPONSORING:${o.rowId}`, type: "SPONSORING", date: null, historique: true, fournisseurs: [], references: [], postes: [],
  attendues: [], manquantes: [], piecesDeja: [], entites: [`SPONSORING:${o.rowId}`], ...o,
});
const depense = (o: Partial<DepenseARapprocher> & Pick<DepenseARapprocher, "source" | "montant" | "libelle">): DepenseARapprocher => ({
  nature: "ECRITURE", aImputer: false, reference: o.source.replace(/^TX:/, ""), date: "2026-07-15T10:00:00.000Z", fournisseur: null, indices: [], lu: [], ...o,
});

describe("normalisations", () => {
  it("fournisseurs : formes juridiques et casse mises à part ; un nom contenu dans l'autre est le même", () => {
    expect(cleFournisseur("EPRINT SARL")).toBe("eprint");
    expect(memeFournisseur("Lotus Media SARL", "lotus media")).toBe("MEME");
    expect(memeFournisseur("Hôtel Madaure", "Madaure")).toBe("MEME");
    expect(memeFournisseur("Traiteur El Bahia Oran", "Bahia Events")).toBe("PROCHE");
    expect(memeFournisseur("Sofitel", "Sheraton")).toBeNull();
    expect(memeFournisseur(null, "X")).toBeNull();
  });
  it("références de la plateforme et numéros de pièce, zéros de tête retirés", () => {
    const r = extraireReferences("Règlement SPO-2026-007, facture N° 226-00572 (BC n° BC/2026/014)");
    expect(r).toContain("SPO-2026-7");
    expect(r).toContain("NUM:226-572");
    expect(r).toContain("BC-2026-14");
    expect(extraireReferences("Facture Sofitel")).toEqual([]);
  });
  it("montants : au centime, à 1 DZD, proches (≤ 1 %)", () => {
    expect(comparerMontants(53_550, 53_550)).toBe("EXACT");
    expect(comparerMontants(92_000.01, 92_000)).toBe("A_1_DZD");
    expect(comparerMontants(510_400, 511_000)).toBe("PROCHE");
    expect(comparerMontants(100, 200)).toBeNull();
    expect(dzd(92_000.01)).toBe("92 000,01");
    expect(dzd(53_550)).toBe("53 550");
  });
});

describe("dépenses → demandes", () => {
  const webinaire = demande({
    rowId: "w", libelle: "SPO-2026-003 — Webinaire infectiologie", montant: 53_550, date: "2026-07-31T12:00:00.000Z",
    references: ["SPO-2026-3"], postes: [{ id: "pw", libelle: "Appui au webinaire", montant: 53_550, fournisseur: "Lotus Media", date: "2026-07-31T12:00:00.000Z" }],
  });
  const congres = demande({
    rowId: "c", libelle: "Journées de pneumologie", montant: 501_000, date: "2026-03-31T12:00:00.000Z",
    postes: [{ id: "pc", libelle: "Restauration", montant: 501_000, fournisseur: "Traiteur Atlas", date: "2026-03-31T12:00:00.000Z" }],
  });

  it("la facture lue par Luna fait le montant exact : même montant, fournisseur, mois — justification lisible", () => {
    const d = depense({
      source: "TX:1", reference: "FIN-X-1", libelle: "Paiement webinaire", montant: 53_350, date: "2026-07-20T10:00:00.000Z",
      lu: [{ nom: "facture.pdf", fournisseur: "LOTUS MEDIA SARL", montant: 53_550, date: "2026-07-08", numero: null, nature: "FACTURE", references: [], motsCles: ["webinaire"] }],
    });
    const [p] = proposerPourDepense(d, [webinaire, congres]);
    expect(p.demandeRowId).toBe("w");
    expect(p.posteId).toBe("pw");
    expect(p.criteres).toEqual(expect.arrayContaining(["MONTANT_EXACT", "FOURNISSEUR", "MOIS", "LIBELLE"]));
    expect(p.justification).toMatch(/même montant 53 550 DZD/);
    expect(p.justification).toMatch(/Lotus Media/);
    expect(p.justification).toMatch(/juillet 2026/);
    // Sans référence concordante, jamais « certaine ».
    expect(p.certitude).toBe("PROBABLE");
  });

  it("« certaine » = montant au centime + même fournisseur + référence concordante, et une seule cible", () => {
    const d = depense({ source: "TX:2", reference: "FIN-X-2", libelle: "Règlement SPO-2026-003", montant: 53_550, fournisseur: "Lotus media" });
    const [p] = proposerPourDepense(d, [webinaire, congres]);
    expect(p.certitude).toBe("CERTAINE");
    expect(certitudeDe(["MONTANT_1_DZD", "FOURNISSEUR", "REFERENCE"], 90)).toBe("PROBABLE");
    // Deux cibles qui remplissent la règle : plus « certaine ».
    const jumeau = demande({ ...webinaire, rowId: "w2" });
    const props = rapprocherDepenses([d], [webinaire, jumeau]).get("TX:2") ?? [];
    expect(props.length).toBe(2);
    expect(props.every((x) => x.certitude === "PROBABLE")).toBe(true);
  });

  it("à 1 DZD près (92 000,01) ; une dépense sans rien de commun n'est proposée nulle part", () => {
    const madaure = demande({ rowId: "m", libelle: "Réunion d'experts Constantine", montant: 92_000, fournisseurs: ["Hôtel Madaure"], date: "2026-05-31T12:00:00.000Z" });
    const [p] = proposerPourDepense(depense({ source: "TX:3", libelle: "Hôtel Madaure", fournisseur: "Madaure", montant: 92_000.01, date: "2026-05-20T10:00:00.000Z" }), [madaure]);
    expect(p.criteres).toEqual(expect.arrayContaining(["MONTANT_1_DZD", "FOURNISSEUR", "MOIS"]));
    expect(proposerPourDepense(depense({ source: "TX:4", libelle: "Achat divers", montant: 12_345 }), [madaure, webinaire])).toEqual([]);
  });

  it("la SOMME de plusieurs écritures = un poste (même fournisseur), chaque écriture le dit", () => {
    const deps = [
      depense({ source: "TX:a", reference: "FIN-A", libelle: "Traiteur acompte", fournisseur: "Traiteur Atlas", montant: 300_000, date: "2026-03-10T10:00:00.000Z" }),
      depense({ source: "TX:b", reference: "FIN-B", libelle: "Traiteur solde", fournisseur: "Traiteur Atlas", montant: 201_000, date: "2026-04-02T10:00:00.000Z" }),
      depense({ source: "TX:z", reference: "FIN-Z", libelle: "Autre chose", montant: 201_000, date: "2025-01-02T10:00:00.000Z" }),
    ];
    const props = rapprocherDepenses(deps, [congres, webinaire]);
    const a = props.get("TX:a")?.[0] as Proposition;
    expect(a.criteres).toContain("SOMME");
    expect(a.posteId).toBe("pc");
    expect(a.avec).toEqual(["TX:b"]);
    expect(a.justification).toMatch(/2 dépenses \(FIN-A \+ FIN-B\) font ensemble 501 000 DZD/);
    expect(props.get("TX:b")?.[0].criteres).toContain("SOMME");
    // Une écriture sans lien avec la cible n'entre pas dans une somme.
    expect(props.get("TX:z")).toBeUndefined();
  });

  it("« pas Ad & Pro » : location de voiture, frais de la Direction Générale — une suggestion, jamais une imputation", () => {
    expect(indiceHorsAdPro({ libelle: "Location voiture Zerdani", fournisseur: null, indices: [] })).toEqual({ raison: "location ou frais de véhicule", enveloppe: "Operations & Sales" });
    expect(indiceHorsAdPro({ libelle: "Sheraton séjour DG SD Pharma", fournisseur: "Sheraton", indices: [] })?.enveloppe).toBe("Operations & Sales");
    expect(indiceHorsAdPro({ libelle: "Hôtel Madaure chambres KWALITY", fournisseur: null, indices: [] })).toBeNull();
  });

  it("une décision retire ce qu'elle tranche", () => {
    const p = (rowId: string): Proposition => ({ source: "TX:1", demandeRowId: rowId, demandeCle: "", demandeLibelle: rowId, posteId: null, posteLibelle: null, pieceCle: null, pieceLibelle: null, score: 50, certitude: "POSSIBLE", criteres: [], justification: "", avec: [] });
    expect(sansLesDecidees([p("a"), p("b")], [{ source: "TX:1", decision: "REFUSEE", demandeRowId: "a", posteId: null }], "DEPENSE").map((x) => x.demandeRowId)).toEqual(["b"]);
    expect(sansLesDecidees([p("a"), p("b")], [{ source: "TX:1", decision: "PAS_ADPRO", demandeRowId: null, posteId: null }], "DEPENSE")).toEqual([]);
    expect(sansLesDecidees([{ ...p("a"), source: "DOC:1" }, { ...p("b"), source: "DOC:1" }], [{ source: "DOC:1", decision: "ACCEPTEE", demandeRowId: "a", posteId: null }], "PIECE").map((x) => x.demandeRowId)).toEqual(["b"]);
  });
});

describe("pièces → demandes", () => {
  const attendues = [{ cle: "convention", libelle: "Convention ou lettre de sponsoring" }, { cle: "facture", libelle: "Facture" }, { cle: "virement", libelle: "Preuve de virement" }];
  const sai = demande({
    rowId: "s", libelle: "SPO-2026-003 — Webinaire infectiologie", montant: 53_550, date: "2026-07-31T12:00:00.000Z", references: ["SPO-2026-3"],
    fournisseurs: ["Lotus Media"], attendues, manquantes: ["facture", "virement"], entites: ["SPONSORING:s", "AD_PRO_ITEM:pw"],
    postes: [{ id: "pw", libelle: "Appui au webinaire", montant: 53_550, fournisseur: "Lotus Media", date: "2026-07-31T12:00:00.000Z" }],
  });
  const piece = (o: Partial<PieceARapprocher> & Pick<PieceARapprocher, "source" | "nom">): PieceARapprocher => ({ ou: "Legal", href: null, entite: null, meta: {}, lu: null, ...o });

  it("le type de la pièce et la pièce attendue qu'elle couvre (une manquante d'abord)", () => {
    expect(typeDePiece({ nom: "scan_0042.pdf", kind: "INVOICE" })).toBe("FACTURE");
    expect(typeDePiece({ nom: "Facture pro forma Genius.pdf" })).toBe("PROFORMA");
    expect(typeDePiece({ nom: "Bordereau de versement ANPP.pdf" })).toBe("QUITTANCE");
    expect(typeDePiece({ nom: "convention_SAI.docx" })).toBe("CONVENTION");
    expect(attendueCouverte("FACTURE", attendues, ["facture"])?.cle).toBe("facture");
    expect(attendueCouverte("VIREMENT", attendues, [])?.cle).toBe("virement");
    expect(attendueCouverte("BILLET", attendues, [])).toBeNull();
  });

  it("une facture lue par Luna : montant, fournisseur, référence → « certaine », vers « Facture » (manquante)", () => {
    const [p] = proposerPourPiece(piece({
      source: "DOC:f", nom: "facture-lotus.pdf",
      lu: { fournisseur: "Lotus Media", montant: 53_550, date: "2026-07-08", numero: "FA-77", nature: "FACTURE", references: ["SPO-2026-3"], motsCles: ["webinaire"] },
    }), [sai]);
    expect(p.certitude).toBe("CERTAINE");
    expect(p.pieceCle).toBe("facture");
    expect(p.justification).toMatch(/facture → « Facture » \(manquante\)/);
  });

  it("une pièce déjà sur un poste de la demande se propose ; déjà rattachée, jamais ; sans aucun signal, pas comparée", () => {
    const surPoste = piece({ source: "DOC:p", nom: "virement_juillet.pdf", entite: "AD_PRO_ITEM:pw" });
    const [p] = proposerPourPiece(surPoste, [sai]);
    expect(p.criteres).toContain("SUR_LA_DEMANDE");
    expect(p.pieceCle).toBe("virement");
    expect(proposerPourPiece(surPoste, [{ ...sai, piecesDeja: ["DOC:p"] }])).toEqual([]);
    expect(proposerPourPiece(piece({ source: "DOC:x", nom: "webinaire juillet.pdf" }), [sai])).toEqual([]);
  });

  it("l'unicité « certaine » tient aussi pour les pièces : deux pièces certaines pour une même pièce attendue → probables", () => {
    const lu = { fournisseur: "Lotus Media", montant: 53_550, date: "2026-07-08", numero: null, nature: "FACTURE", references: ["SPO-2026-3"], motsCles: [] };
    const props = finaliser([...proposerPourPiece(piece({ source: "DOC:1", nom: "facture.pdf", lu }), [sai]), ...proposerPourPiece(piece({ source: "DOC:2", nom: "facture (copie).pdf", lu }), [sai])]);
    expect(props.map((x) => x.certitude)).toEqual(["PROBABLE", "PROBABLE"]);
  });
});

describe("les doublons probables (rien n'est supprimé)", () => {
  const el = (o: Partial<ElementDoublon> & Pick<ElementDoublon, "cle" | "montant" | "libelle">): ElementDoublon => ({
    nature: "ECRITURE", reference: o.cle, date: null, fournisseur: null, groupe: null, href: null, ...o,
  });
  it("même traiteur et même montant ; montants non ronds à 2 DZD ; même objet (visa / ANPP) ; somme de postes face au fichier", () => {
    const d = doublonsProbables([
      el({ cle: "TX:123", libelle: "Traiteur Oran", fournisseur: "Traiteur El Bahia", montant: 87_500 }),
      el({ cle: "TX:124", libelle: "Traiteur Oran dîner", fournisseur: "El Bahia traiteur", montant: 87_500 }),
      el({ cle: "LIGNE:rio", nature: "LIGNE", libelle: "MP Goodies RIO", montant: 35_819 }),
      el({ cle: "TX:116", libelle: "EPRINT impression", fournisseur: "EPRINT", montant: 35_817 }),
      el({ cle: "LIGNE:anpp", nature: "LIGNE", libelle: "Bordereaux de versement ANPP - 4 MP", montant: 240_000 }),
      el({ cle: "POSTE:visa", nature: "POSTE_HISTORIQUE", libelle: "Visa de publicité — DIM visa publicitaire", montant: 240_000, groupe: "MEDICAL_INFO_DECLARATION:v" }),
      el({ cle: "POSTE:b1", nature: "POSTE", libelle: "Hébergement — SPO-2026-007 EPH Batna", montant: 501_000, groupe: "SPONSORING:b" }),
      el({ cle: "POSTE:b2", nature: "POSTE", libelle: "Pause café — SPO-2026-007 EPH Batna", montant: 10_000, groupe: "SPONSORING:b" }),
      el({ cle: "POSTE:jb", nature: "POSTE_HISTORIQUE", libelle: "Journées de Batna", montant: 510_400, groupe: "EVENT:jb" }),
      el({ cle: "TX:sofitel", libelle: "Sofitel", montant: 427_200 }),
    ]);
    const motifs = new Map(d.map((x) => [x.elements.map((e) => e.cle).sort().join("|"), x.motif]));
    expect(motifs.get("TX:123|TX:124")).toBe("MEME_FOURNISSEUR");
    expect(motifs.get("LIGNE:rio|TX:116")).toBe("MONTANT_QUASI_EGAL");
    expect(motifs.get("LIGNE:anpp|POSTE:visa")).toBe("MEME_EVENEMENT");
    expect(motifs.get("POSTE:b1|POSTE:b2|POSTE:jb")).toBe("SOMME_DE_POSTES");
    // Deux postes d'une même demande ne sont pas des doublons l'un de l'autre ; Sofitel est seul.
    expect([...motifs.keys()].some((k) => k.includes("TX:sofitel"))).toBe(false);
    expect(d.find((x) => x.motif === "SOMME_DE_POSTES")?.raison).toMatch(/501 000 \+ 10 000 = 511 000 DZD\) face à 510 400 DZD/);
  });
  it("une même dépense répétée fait UN doublon de plusieurs éléments, pas une paire par combinaison", () => {
    const d = doublonsProbables([1, 2, 3].map((i) => el({ cle: `TX:r${i}`, libelle: "Impression flyers", fournisseur: "Imprimerie Alpha", montant: 150_000 })));
    expect(d).toHaveLength(1);
    expect(d[0].elements).toHaveLength(3);
    expect(d[0].raison).toMatch(/^3 éléments — même fournisseur/);
  });
  it("une paire déjà reconnue comme une seule dépense (rattachée) n'est pas signalée", () => {
    const d = doublonsProbables([
      el({ cle: "TX:1", libelle: "Webinaire SAI", montant: 53_550, fournisseur: "Lotus" }),
      el({ cle: "POSTE:p", nature: "POSTE_HISTORIQUE", libelle: "Webinaire SAI", montant: 53_550, fournisseur: "Lotus", groupe: "SPONSORING:s" }),
    ], new Set(["POSTE:p|TX:1"]));
    expect(d).toEqual([]);
  });
});

describe("l'onglet Dépenses : « Déjà imputé » ne répète pas le tableau des postes", () => {
  it("ni les postes Historique 2026, ni les écritures réglées par l'ordre d'un poste — seulement les dépenses hors postes", () => {
    const deja = [
      { id: "h1", kind: "HISTORIQUE" }, { id: "h2", kind: "HISTORIQUE" },
      { id: "tx-poste", kind: "FINANCE" }, { id: "tx-libre", kind: "FINANCE" },
      { id: "ligne", kind: "BUDGET" }, { id: "mg", kind: "GENERAL_MEANS" },
    ];
    expect(horsPostesAdPro(deja, new Set(["tx-poste"])).map((x) => x.id)).toEqual(["tx-libre", "ligne", "mg"]);
    expect(TITRE_DEJA_IMPUTE_HORS_POSTES).toMatch(/hors postes Ad & Pro/);
  });
});
