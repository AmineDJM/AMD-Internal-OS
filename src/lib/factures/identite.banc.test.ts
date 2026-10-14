import { describe, expect, it } from "vitest";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { lireStructureModele } from "@/lib/pieces-lues/structure";
import {
  cleNumero, comparerFactures, groupesDeDoublons, identiteDepuisLecture, identiteDepuisSaisie, natureDeLaPiece,
  type IdentiteFacture,
} from "@/lib/factures/identite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE LUNA — « il doit être parfaitement capable et entraîné » (Direction, 14/10/2026).
 *
 * Des cas RÉELS et piégeux, rejoués à chaque modification : pour chaque pièce, le TEXTE du papier (natif ou OCR, avec
 * ses défauts) et la SORTIE SIMULÉE DE LUNA (piégeuse au besoin : numéro inventé, TVA hallucinée, colonnes confondues).
 * Tout le reste est le code de production : le repérage (`repererEntetes`), la relecture stricte du modèle
 * (`lireStructureModele`), l'identité et ses garde-fous (`identiteDepuisLecture`), la comparaison (`comparerFactures`).
 * Aucun fournisseur d'IA n'est appelé.
 *
 * L'OBJECTIF EST ZÉRO FAUX CERTAIN — le dernier cas compare toutes les paires de pièces DIFFÉRENTES du banc.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La société du groupe — le CLIENT de chaque pièce, jamais son émetteur. */
const GROUPE = { nifs: ["000016098765432"], rcs: ["16/00-7654321B18"] };

const HOTEL = { nom: "SPA HOTEL EL DJAZAIR", nif: "001916012345678", rc: "16/00-1234567B21" };
const IMPRIMERIE = { nom: "SARL IMPRIMERIE DU SAHEL", nif: "002316098712345", rc: "23/00-7654321B19" };

function papier(o: {
  titre: string; numero?: string | null; date?: string; emetteur?: typeof HOTEL; ht: string; tva?: string; ttc?: string; net?: string; lignes?: string[];
  numeroIllisible?: boolean;
}): string {
  const e = o.emetteur ?? HOTEL;
  return [
    `Raison sociale : ${e.nom}`,
    "Adresse : 1 rue Didouche Mourad, Alger",
    `NIF : ${e.nif}`,
    `RC : ${e.rc}`,
    o.numero ? `${o.titre} N° ${o.numero}` : o.numeroIllisible ? `${o.titre} N° ~#@!` : o.titre,
    o.date ? `Alger, le ${o.date}` : "",
    "Client : ADVENTUM PHARMA — NIF : 000016098765432",
    "Désignation   Qté   P.U HT   Montant HT",
    ...(o.lignes ?? ["Hébergement congrès   10   10 000,00   100 000,00"]),
    `Total HT   ${o.ht}`,
    ...(o.tva ? [`TVA 19 %   ${o.tva}`] : []),
    ...(o.ttc ? [`Total TTC   ${o.ttc}`] : []),
    ...(o.net ? [`Net à payer : ${o.net} DA`] : []),
  ].filter(Boolean).join("\n");
}

const lm = (designation: string, quantite: string, prixUnitaire: string, tva = "") =>
  ({ designation, reference: "", unite: "", quantite, prixUnitaire, remise: "", tva, montantHt: "" });

function modele(o: {
  type?: string; numero?: string; date?: string; emetteur?: Partial<typeof HOTEL> | null; tvaDefaut?: string; ht?: string; tva?: string; ttc?: string;
  lignes?: ReturnType<typeof lm>[];
}) {
  const e = o.emetteur === null ? { nom: "", nif: "", rc: "" } : { ...HOTEL, ...(o.emetteur ?? {}) };
  return {
    type: o.type ?? "FACTURE", numero: o.numero ?? "", date: o.date ?? "", devise: "DA", modePaiement: "",
    fournisseur: { nom: e.nom ?? "", nif: e.nif ?? "", rc: e.rc ?? "", nis: "", ai: "", adresse: "" },
    tvaDefaut: o.tvaDefaut ?? "", remiseGlobale: "", taxes: [], lignes: o.lignes ?? [lm("Hébergement congrès", "10", "10 000,00", o.tvaDefaut ?? "")],
    totaux: { ht: o.ht ?? "", tva: o.tva ?? "", taxes: "", timbre: "", ttc: o.ttc ?? "" },
  };
}

function lire(empreinte: string, texte: string, sortie: unknown): IdentiteFacture {
  return identiteDepuisLecture({ empreintes: [empreinte], texte, entetes: repererEntetes(texte), piece: lireStructureModele(sortie), groupe: GROUPE });
}

// ─────────────────────────────── Les pièces du banc ───────────────────────────────

/** La facture de l'hôtel, scannée une première fois (PDF natif). */
const FACTURE_HOTEL = lire("sha-hotel-1", papier({ titre: "FACTURE", numero: "FA-2026/0145", date: "05/09/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA-2026/0145", date: "05/09/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** LE MÊME PAPIER, RESCANNÉ : autre fichier, OCR bruité (espaces, zéro de tête, casse), même numéro. */
const FACTURE_HOTEL_RESCAN = lire("sha-hotel-2", papier({ titre: "Facture", numero: "FA 2026/145", date: "05/09/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA 2026/145", date: "05/09/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** UNE PHOTO FLOUE du même papier : le numéro ne se lit pas ; Luna en INVENTE un qui n'est pas imprimé. */
const FACTURE_HOTEL_FLOUE = lire("sha-hotel-3", papier({ titre: "FACTURE", numeroIllisible: true, date: "05/09/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA-2026/0146", date: "05/09/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** LA PRO FORMA de l'hôtel — même numéro que la facture finale (certains fournisseurs numérotent ainsi). */
const PRO_FORMA_HOTEL = lire("sha-hotel-pf", papier({ titre: "FACTURE PROFORMA", numero: "FA-2026/0145", date: "28/08/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA-2026/0145", date: "28/08/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** LA FACTURE FINALE qui CITE sa pro forma (« suivant facture proforma … ») : elle reste une facture. */
const FINALE_QUI_CITE = lire("sha-hotel-fin", [
  papier({ titre: "FACTURE", numero: "FA-2026/0201", date: "15/09/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  "Suivant facture proforma N° PF-2026/031",
].join("\n"), modele({ numero: "FA-2026/0201", date: "15/09/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** UN AVOIR de l'hôtel sur la facture 0145, même montant. */
const AVOIR_HOTEL = lire("sha-hotel-av", papier({ titre: "AVOIR", numero: "FA-2026/0145", date: "05/09/2026", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ type: "AVOIR", numero: "FA-2026/0145", date: "05/09/2026", tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** DEUX ACOMPTES de l'imprimerie, même montant, même date. */
const ACOMPTE_1 = lire("sha-imp-ac1", papier({ titre: "FACTURE D'ACOMPTE", numero: "AC-01", date: "01/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00", lignes: ["Acompte 30 % sur BC 032/DG/2026   1   50 000,00   50 000,00"] }),
  modele({ numero: "AC-01", date: "01/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00", lignes: [lm("Acompte 30 %", "1", "50 000,00")] }));
const ACOMPTE_2 = lire("sha-imp-ac2", papier({ titre: "FACTURE D'ACOMPTE", numero: "AC-02", date: "01/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00", lignes: ["Acompte 30 % sur BC 033/DG/2026   1   50 000,00   50 000,00"] }),
  modele({ numero: "AC-02", date: "01/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00", lignes: [lm("Acompte 30 %", "1", "50 000,00")] }));
/** Deux acomptes dont le numéro ne se lit pas — même fournisseur, même montant, même date. */
const ACOMPTE_SANS_N_1 = lire("sha-imp-ac3", papier({ titre: "FACTURE D'ACOMPTE", numeroIllisible: true, date: "02/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00" }),
  modele({ date: "02/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00" }));
const ACOMPTE_SANS_N_2 = lire("sha-imp-ac4", papier({ titre: "FACTURE D'ACOMPTE", numeroIllisible: true, date: "02/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00" }),
  modele({ date: "02/10/2026", emetteur: IMPRIMERIE, ht: "50 000,00", ttc: "50 000,00" }));

/** LE MÊME NUMÉRO chez un AUTRE fournisseur (chacun numérote depuis 1). */
const IMPRIMERIE_0145 = lire("sha-imp-0145", papier({ titre: "FACTURE", numero: "FA-2026/0145", date: "05/09/2026", emetteur: IMPRIMERIE, ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA-2026/0145", date: "05/09/2026", emetteur: IMPRIMERIE, tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** LE MÊME PAPIER, un caractère du NIF mal lu par l'OCR (8 → 3), nom identique. */
const HOTEL_NIF_FAUX = lire("sha-hotel-nif", papier({ titre: "FACTURE", numero: "FA-2026/0145", date: "05/09/2026", emetteur: { ...HOTEL, nif: "001916012345673" }, ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }),
  modele({ numero: "FA-2026/0145", date: "05/09/2026", emetteur: { nif: "001916012345673" }, tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** TVA HALLUCINÉE : le papier n'en porte aucune (seul un « Total HT ») ; Luna en ajoute une, et un TTC qui va avec. */
const TVA_HALLUCINEE = lire("sha-imp-tva", papier({ titre: "FACTURE", numero: "F-77", date: "10/10/2026", emetteur: IMPRIMERIE, ht: "100 000,00" }),
  modele({ numero: "F-77", date: "10/10/2026", emetteur: IMPRIMERIE, tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));

/** TTC PRIS POUR LE HT : le papier ne titre pas ses totaux lisiblement ; Luna range le TTC dans « HT » et recopie. */
const TTC_POUR_HT = lire("sha-imp-col", [
  "Raison sociale : SARL IMPRIMERIE DU SAHEL", `NIF : ${IMPRIMERIE.nif}`, "FACTURE N° F-78", "Alger, le 11/10/2026",
  "Désignation   Qté   P.U HT   Montant HT", "Dépliants   1000   100,00   100 000,00", "TVA 19 %   19 000,00", "Montant   119 000,00",
].join("\n"), modele({ numero: "F-78", date: "11/10/2026", emetteur: IMPRIMERIE, tvaDefaut: "19", ht: "119 000,00", tva: "19 000,00", ttc: "119 000,00", lignes: [lm("Dépliants", "1000", "100,00", "19")] }));

describe("Banc de Luna — l'identité d'une facture, lue sans rien inventer", () => {
  it("le numéro se normalise (espaces, séparateurs, zéros de tête, « N° ») sans confondre deux numéros", () => {
    expect(cleNumero("FA-2026/0145")).toBe(cleNumero("fa 2026 145"));
    expect(cleNumero("N° 001/FS/26")).toBe(cleNumero("1-FS-26"));
    expect(cleNumero("12/2026")).not.toBe(cleNumero("2026/12"));
    expect(cleNumero("~#@!")).toBeNull();
    expect(cleNumero("SANS NUMERO")).toBeNull();
  });

  it("la facture lue : numéro, fournisseur (NIF de l'émetteur, jamais celui du client), TTC du papier, nature, date", () => {
    expect(FACTURE_HOTEL.numeroCle).toBe(cleNumero("FA-2026/0145"));
    expect(FACTURE_HOTEL.numeroSource).toBe("LU");
    expect(FACTURE_HOTEL.fournisseur.nif).toBe(HOTEL.nif);
    expect(FACTURE_HOTEL.fournisseurSource).toBe("LU");
    expect(FACTURE_HOTEL.ttc).toBe(119_000);
    expect(FACTURE_HOTEL.nature).toBe("FACTURE");
    expect(FACTURE_HOTEL.date).toBe("2026-09-05");
  });

  it("MÊME PAPIER SCANNÉ DEUX FOIS (empreintes différentes, même n°) → CERTAIN", () => {
    expect(FACTURE_HOTEL.empreintes).not.toEqual(FACTURE_HOTEL_RESCAN.empreintes);
    const r = comparerFactures(FACTURE_HOTEL, FACTURE_HOTEL_RESCAN);
    expect(r.niveau).toBe("CERTAIN");
    expect(r.motif).toBe("MEME_NUMERO");
    expect(comparerFactures(FACTURE_HOTEL_RESCAN, FACTURE_HOTEL).niveau).toBe("CERTAIN");
  });

  it("LE MÊME FICHIER (même empreinte) → CERTAIN, quoi que dise la lecture", () => {
    const vide = identiteDepuisSaisie({ empreintes: ["sha-hotel-1"] });
    expect(comparerFactures(vide, FACTURE_HOTEL)).toMatchObject({ niveau: "CERTAIN", motif: "MEME_FICHIER" });
  });

  it("PHOTO FLOUE SANS N° : le numéro inventé par Luna est ÉCARTÉ (absent du papier) → PROBABLE au mieux", () => {
    expect(FACTURE_HOTEL_FLOUE.numeroCle).toBeNull();
    expect(FACTURE_HOTEL_FLOUE.reserves.join(" ")).toMatch(/absent du texte/);
    const r = comparerFactures(FACTURE_HOTEL_FLOUE, FACTURE_HOTEL);
    expect(r.niveau).toBe("PROBABLE");
    expect(r.motif).toBe("MEME_MONTANT_ET_DATE");
    // Un « numéro » que le modèle a pris dans un MONTANT (« 145 000,00 ») n'est pas imprimé comme un numéro.
    const piege = lire("sha-piege", papier({ titre: "FACTURE", numeroIllisible: true, date: "05/09/2026", ht: "145 000,00", ttc: "145 000,00" }),
      modele({ numero: "145", date: "05/09/2026", ht: "145 000,00", ttc: "145 000,00" }));
    expect(piege.numeroCle).toBeNull();
  });

  it("PRO FORMA PUIS FACTURE FINALE (même numéro) → AUCUN ; la finale qui CITE sa pro forma reste une facture", () => {
    expect(PRO_FORMA_HOTEL.nature).toBe("PRO_FORMA");
    expect(comparerFactures(PRO_FORMA_HOTEL, FACTURE_HOTEL).niveau).toBe("AUCUN");
    expect(FINALE_QUI_CITE.nature).toBe("FACTURE");
    expect(comparerFactures(PRO_FORMA_HOTEL, FINALE_QUI_CITE).niveau).toBe("AUCUN");
  });

  it("UN AVOIR (même numéro, même montant) n'est pas un doublon de la facture → AUCUN", () => {
    expect(AVOIR_HOTEL.nature).toBe("AVOIR");
    expect(comparerFactures(AVOIR_HOTEL, FACTURE_HOTEL).niveau).toBe("AUCUN");
  });

  it("DEUX ACOMPTES du même fournisseur, même montant, même date → AUCUN (avec ou sans numéro)", () => {
    expect(ACOMPTE_1.nature).toBe("ACOMPTE");
    expect(comparerFactures(ACOMPTE_1, ACOMPTE_2).niveau).toBe("AUCUN");
    expect(comparerFactures(ACOMPTE_SANS_N_1, ACOMPTE_SANS_N_2).niveau).toBe("AUCUN");
  });

  it("LE MÊME NUMÉRO CHEZ DEUX FOURNISSEURS → AUCUN", () => {
    expect(IMPRIMERIE_0145.numeroCle).toBe(FACTURE_HOTEL.numeroCle);
    expect(comparerFactures(IMPRIMERIE_0145, FACTURE_HOTEL)).toMatchObject({ niveau: "AUCUN" });
  });

  it("UN CARACTÈRE DU NIF MAL LU, nom identique, même n° → PROBABLE (jamais CERTAIN)", () => {
    const r = comparerFactures(HOTEL_NIF_FAUX, FACTURE_HOTEL);
    expect(r.niveau).toBe("PROBABLE");
    expect(r.raison).toMatch(/un caractère près/);
  });

  it("TVA HALLUCINÉE : la TVA que le papier ne porte pas n'entre pas dans le TTC — neutralisée par `tvaCorroboree`", () => {
    expect(TVA_HALLUCINEE.ttc).toBeNull();
    expect(TVA_HALLUCINEE.reserves.join(" ")).toMatch(/absente du papier/);
    // Le papier imprime « Net à payer » : c'est lui qui fait foi, pas le TTC inventé.
    const avecNet = lire("sha-imp-tva2", papier({ titre: "FACTURE", numero: "F-79", date: "10/10/2026", emetteur: IMPRIMERIE, ht: "100 000,00", net: "100 000,00" }),
      modele({ numero: "F-79", emetteur: IMPRIMERIE, tvaDefaut: "19", ht: "100 000,00", tva: "19 000,00", ttc: "119 000,00" }));
    expect(avecNet.ttc).toBe(100_000);
  });

  it("TTC PRIS POUR LE HT : un TTC égal au HT sous une TVA est écarté — aucun montant faux ne sert à comparer", () => {
    expect(TTC_POUR_HT.ttc).toBeNull();
    expect(TTC_POUR_HT.numeroCle).toBe(cleNumero("F-78"));
  });

  it("la nature se lit au TITRE : « acompte versé » sur une facture finale ne la change pas", () => {
    expect(natureDeLaPiece({ texte: "FACTURE N° 12\nAcompte versé : 50 000,00" })).toBe("FACTURE");
    expect(natureDeLaPiece({ texte: "SARL X\nFACTURE D'ACOMPTE N° 3" })).toBe("ACOMPTE");
    expect(natureDeLaPiece({ texte: "Pro-forma n° 9" })).toBe("PRO_FORMA");
    expect(natureDeLaPiece({ texte: "Avoir N° 4", typeRepere: null })).toBe("AVOIR");
    expect(natureDeLaPiece({ texte: "Bon de livraison" })).toBeNull();
  });

  it("une SAISIE (n° tapé à la main) ne fait jamais un CERTAIN par le numéro", () => {
    const saisie = identiteDepuisSaisie({ numero: "FA-2026/0145", fournisseur: HOTEL.nom, ttc: 119_000 });
    expect(comparerFactures(saisie, FACTURE_HOTEL).niveau).toBe("PROBABLE");
  });

  it("ZÉRO FAUX CERTAIN : aucune paire de pièces DIFFÉRENTES du banc n'est déclarée certaine", () => {
    // Les seules paires qui SONT la même pièce : la facture de l'hôtel, son rescan.
    const memePiece = new Set([FACTURE_HOTEL, FACTURE_HOTEL_RESCAN]);
    const toutes = [
      FACTURE_HOTEL, FACTURE_HOTEL_RESCAN, FACTURE_HOTEL_FLOUE, PRO_FORMA_HOTEL, FINALE_QUI_CITE, AVOIR_HOTEL,
      ACOMPTE_1, ACOMPTE_2, ACOMPTE_SANS_N_1, ACOMPTE_SANS_N_2, IMPRIMERIE_0145, HOTEL_NIF_FAUX, TVA_HALLUCINEE, TTC_POUR_HT,
    ];
    const fautifs: string[] = [];
    for (let i = 0; i < toutes.length; i++) {
      for (let j = i + 1; j < toutes.length; j++) {
        const a = toutes[i] as IdentiteFacture;
        const b = toutes[j] as IdentiteFacture;
        if (memePiece.has(a) && memePiece.has(b)) continue;
        if (comparerFactures(a, b).niveau === "CERTAIN") fautifs.push(`${a.empreintes[0]} ~ ${b.empreintes[0]}`);
      }
    }
    expect(fautifs).toEqual([]);
  });

  it("le recensement groupe les certains, puis les probables — sans compter deux fois la même facture vue à deux endroits", () => {
    const liste = [
      { cle: "R1", maison: "REGISTRE", instances: ["ORDRE:o1"], identite: FACTURE_HOTEL },
      { cle: "D1", maison: "DEMANDE", instances: ["ORDRE:o1"], identite: { ...FACTURE_HOTEL, empreintes: ["sha-hotel-1"] } },
      { cle: "D2", maison: "DEMANDE", instances: ["DEMANDE:x"], identite: FACTURE_HOTEL_RESCAN },
      { cle: "F1", maison: "FICHIER", instances: [], identite: FACTURE_HOTEL_FLOUE },
      { cle: "A1", maison: "REGISTRE", instances: [], identite: ACOMPTE_1 },
      { cle: "A2", maison: "REGISTRE", instances: [], identite: ACOMPTE_2 },
    ];
    const g = groupesDeDoublons(liste);
    const certains = g.filter((x) => x.niveau === "CERTAIN");
    expect(certains).toHaveLength(1);
    expect(certains[0]!.membres.map((m) => m.cle).sort()).toEqual(["D1", "D2", "R1"]);
    expect(g.filter((x) => x.niveau === "PROBABLE").flatMap((x) => x.membres.map((m) => m.cle))).toContain("F1");
    expect(g.flatMap((x) => x.membres.map((m) => m.cle))).not.toContain("A1");
  });
});
