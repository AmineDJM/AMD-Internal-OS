import { describe, expect, it } from "vitest";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { identiteEmetteurDuTexte, IDENTITE_VIDE } from "@/lib/pieces-lues/emetteur";
import { candidatsFournisseur, identiteLue, type ContactAnnuaire, type ResultatFournisseur } from "@/lib/pieces-lues/fournisseur";
import { finDeDuree, phraseDeLecture, preremplirDocumentLegal, type EntreePrerempli } from "@/lib/pieces-lues/prerempli-document-legal";
import type { SyntheseLegale } from "@/lib/pieces-lues/synthese-legale";

const NIF_GROUPE = "000216001122334";
const NIF_EL_NOUR = "000916012345678";
const GROUPE = { nifs: [NIF_GROUPE], rcs: ["16/00-1111111B10"] };

const FACTURE = [
  "IMPRIMERIE EL NOUR SARL",
  `NIF : ${NIF_EL_NOUR}`,
  "RC : 16/00-0123456B09",
  "FACTURE N° F-2026/0318",
  "Alger, le 14/10/2026",
  "Client : Adventum Pharma",
  "Réf. votre bon de commande : BC N° BC-2026-0112",
  "Dépliant A4 3 volets — Dolizan   5 000   60,00   300 000,00",
  "Total HT : 300 000,00",
  "TVA 19 % : 57 000,00",
  "Total TTC : 357 000,00",
].join("\n");

const AUCUNE: ResultatFournisseur = { statut: "AUCUN", retenu: null, candidats: [], phrase: "", aCreer: { nom: null, nifs: [], rcs: [] } };

function entree(texte: string, sur: Partial<EntreePrerempli> = {}): EntreePrerempli {
  const entetes = repererEntetes(texte);
  return {
    entetes,
    synthese: null,
    emetteur: identiteEmetteurDuTexte(texte),
    fournisseur: AUCUNE,
    groupe: GROUPE,
    bcSuivi: null,
    natureImposee: null,
    ...sur,
  };
}

const synthese = (sur: Partial<SyntheseLegale> = {}): SyntheseLegale => ({
  nature: { valeur: "CONTRACT", extrait: "CONTRAT DE PRESTATION DE SERVICES" },
  titre: "Contrat de maintenance des climatiseurs — ClimTech SARL",
  dateDebut: { valeur: "2026-11-01", extrait: "prend effet le 1er novembre 2026" },
  dateFin: null,
  duree: { valeur: { nombre: 12, unite: "MOIS" }, extrait: "conclu pour une durée de douze (12) mois" },
  contrepartie: { nom: "ClimTech SARL", nif: "001616098765432", rc: null, adresse: "Alger" },
  resume: "Maintenance préventive et curative des climatiseurs du siège.",
  aSurveiller: "Reconduction tacite ; préavis de 2 mois.",
  suspects: [],
  ...sur,
});

describe("finDeDuree — la fin d'une durée lue", () => {
  it("une période en mois ou en années finit la veille de son anniversaire ; un délai en jours tombe le jour dit", () => {
    expect(finDeDuree("2026-11-01", 12, "MOIS")).toBe("2027-10-31");
    expect(finDeDuree("2026-03-01", 2, "AN")).toBe("2028-02-29");
    expect(finDeDuree("2026-10-14", 30, "JOUR")).toBe("2026-11-13");
  });
  it("un 31 janvier plus un mois s'arrête au dernier jour de février, la veille comprise", () => {
    expect(finDeDuree("2027-01-31", 1, "MOIS")).toBe("2027-02-27");
  });
  it("une date illisible ou une durée nulle ne donnent rien", () => {
    expect(finDeDuree("01/11/2026", 12, "MOIS")).toBeNull();
    expect(finDeDuree("2026-11-01", 0, "MOIS")).toBeNull();
  });
});

describe("preremplirDocumentLegal — le formulaire Legal rempli depuis sa pièce", () => {
  it("une facture reçue, lue par les règles seules : nature, n°, date, montant, sens — chacun avec sa ligne", () => {
    const p = preremplirDocumentLegal(entree(FACTURE));
    expect(p.valeurs).toMatchObject({ kind: "INVOICE", reference: "F-2026/0318", startDate: "2026-10-14", amount: "357000", direction: "OUT" });
    expect(p.marques.amount).toMatchObject({ source: "REGLES" });
    expect(p.marques.amount!.preuve).toMatch(/357 000/);
    expect(p.marques.direction!.preuve).toMatch(/pas l'une de nos sociétés/);
    expect(p.sensExige).toBe(false);
    // Sans Luna : ni titre, ni notes — ils restent à saisir.
    expect(p.valeurs.title).toBeUndefined();
    expect(p.valeurs.notes).toBeUndefined();
  });

  it("une facture émise par l'une de nos sociétés est « émise »", () => {
    const p = preremplirDocumentLegal(entree(FACTURE.replace(NIF_EL_NOUR, NIF_GROUPE)));
    expect(p.valeurs.direction).toBe("IN");
  });

  it("une facture dont l'émetteur ne se lit pas : aucun sens par défaut, la personne choisit", () => {
    const p = preremplirDocumentLegal(entree("FACTURE N° 77\nTotal TTC : 12 000,00", { emetteur: IDENTITE_VIDE }));
    expect(p.valeurs.direction).toBeUndefined();
    expect(p.sensExige).toBe(true);
  });

  it("le sens ne concerne qu'une facture — un contrat n'en porte jamais", () => {
    const p = preremplirDocumentLegal(entree("CONTRAT DE PRESTATION", { synthese: synthese(), emetteur: IDENTITE_VIDE }));
    expect(p.valeurs.direction).toBeUndefined();
    expect(p.sensExige).toBe(false);
  });

  it("des totaux imprimés qui se contredisent : le montant reste vide, et le conflit est dit", () => {
    const p = preremplirDocumentLegal(entree(`${FACTURE}\nTotal TTC : 375 000,00`));
    expect(p.valeurs.amount).toBeUndefined();
    expect(p.montantConflit).toMatch(/se contredisent/);
  });

  it("un contrat lu par Luna : nature, titre, prise d'effet ; la fin est CALCULÉE depuis la durée, et le dit", () => {
    const p = preremplirDocumentLegal(entree("CONTRAT DE PRESTATION DE SERVICES", { synthese: synthese(), emetteur: IDENTITE_VIDE }));
    expect(p.valeurs).toMatchObject({ kind: "CONTRACT", startDate: "2026-11-01", endDate: "2027-10-31" });
    expect(p.marques.kind!.source).toBe("LUNA");
    expect(p.marques.endDate).toMatchObject({ source: "CALCUL" });
    expect(p.marques.endDate!.preuve).toBe("« conclu pour une durée de douze (12) mois » → 01/11/2026 + 12 mois = 31/10/2027.");
  });

  it("une fin IMPRIMÉE l'emporte sur le calcul — sauf si elle précède le début", () => {
    const imprimee = preremplirDocumentLegal(entree("CONTRAT", { synthese: synthese({ dateFin: { valeur: "2027-06-30", extrait: "jusqu'au 30/06/2027" } }), emetteur: IDENTITE_VIDE }));
    expect(imprimee.valeurs.endDate).toBe("2027-06-30");
    expect(imprimee.marques.endDate!.source).toBe("LUNA");
    const avant = preremplirDocumentLegal(entree("CONTRAT", { synthese: synthese({ dateFin: { valeur: "2025-01-01", extrait: "jusqu'au 01/01/2025" } }), emetteur: IDENTITE_VIDE }));
    expect(avant.valeurs.endDate).toBe("2027-10-31");
  });

  it("les notes : le résumé, puis « À surveiller » ; une rédaction suspecte n'est pas reprise", () => {
    const p = preremplirDocumentLegal(entree("CONTRAT", { synthese: synthese(), emetteur: IDENTITE_VIDE }));
    expect(p.valeurs.notes).toBe("Maintenance préventive et curative des climatiseurs du siège.\nÀ surveiller : Reconduction tacite ; préavis de 2 mois.");
    const suspecte = preremplirDocumentLegal(entree("CONTRAT", { synthese: synthese({ suspects: ["titre", "resume"] }), emetteur: IDENTITE_VIDE }));
    expect(suspecte.valeurs.title).toBeUndefined();
    expect(suspecte.valeurs.notes).toBe("À surveiller : Reconduction tacite ; préavis de 2 mois.");
  });

  it("la nature d'une pièce commerciale vient des règles : Luna ne la contredit pas", () => {
    const p = preremplirDocumentLegal(entree(FACTURE, { synthese: synthese({ nature: { valeur: "QUOTE", extrait: "devis" } }) }));
    expect(p.valeurs.kind).toBe("INVOICE");
    expect(p.marques.kind!.source).toBe("REGLES");
  });

  it("« Nouvelle facture » : la nature est donnée par le bouton — ni reprise, ni marquée", () => {
    const p = preremplirDocumentLegal(entree(FACTURE, { natureImposee: "INVOICE" }));
    expect(p.valeurs.kind).toBeUndefined();
    expect(p.valeurs.direction).toBe("OUT");
  });

  it("le BC désigné par la facture remplit « Fait suite à », avec la ligne qui le cite", () => {
    const p = preremplirDocumentLegal(entree(FACTURE, { bcSuivi: { id: "bc1", label: "BC-2026-0112 — Dépliants", numero: "BC-2026-0112" } }));
    expect(p.valeurs.chainFromId).toBe("bc1");
    expect(p.bcSuivi).toEqual({ value: "bc1", label: "BC-2026-0112 — Dépliants" });
    expect(p.marques.chainFromId!.preuve).toMatch(/un seul bon de commande/);
  });

  describe("la partie", () => {
    const annuaire: ContactAnnuaire[] = [
      { id: "c-nour", nom: "Imprimerie El Nour", nif: NIF_EL_NOUR, rc: null },
      { id: "c-autre", nom: "ClimTech Services", nif: null, rc: null },
    ];
    const lu = (texte: string) => identiteLue(null, repererEntetes(texte));

    it("même NIF qu'une fiche : elle est retenue, et marquée", () => {
      const p = preremplirDocumentLegal(entree(FACTURE, { fournisseur: candidatsFournisseur(lu(FACTURE), annuaire, GROUPE) }));
      expect(p.partie.retenue).toBe("c-nour");
      expect(p.marques.counterpartyIds!.preuve).toMatch(/NIF/);
    });

    it("un nom proche seulement : proposé, jamais choisi", () => {
      const f = candidatsFournisseur({ nom: "ClimTech Services", nifs: [], rcs: [] }, annuaire, GROUPE);
      const p = preremplirDocumentLegal(entree("CONTRAT", { fournisseur: f, synthese: synthese(), emetteur: IDENTITE_VIDE }));
      expect(p.partie.statut).toBe("PROBABLE");
      expect(p.partie.retenue).toBeNull();
      expect(p.marques.counterpartyIds).toBeUndefined();
    });

    it("inconnue : ce qui a été lu est proposé à la création — jamais l'une de nos sociétés", () => {
      const texte = FACTURE.replace(NIF_EL_NOUR, "000916099999999");
      const p = preremplirDocumentLegal(entree(texte, { fournisseur: candidatsFournisseur(lu(texte), annuaire, GROUPE) }));
      expect(p.partie.statut).toBe("AUCUN");
      expect(p.partie.aCreer).toMatchObject({ nif: "000916099999999" });
      const nous = preremplirDocumentLegal(entree(FACTURE.replace(NIF_EL_NOUR, NIF_GROUPE), { fournisseur: AUCUNE }));
      expect(nous.partie.aCreer?.nif).not.toBe(NIF_GROUPE);
    });
  });
});

describe("phraseDeLecture — la phrase en tête du formulaire", () => {
  it("« rien n'a quitté la plateforme » ne se dit que sans modèle", () => {
    expect(phraseDeLecture({ scan: true, parLuna: true, luna: "LUE" })).toBe("Lu par Luna (scan).");
    expect(phraseDeLecture({ scan: false, parLuna: false, luna: "LUE" })).toBe("Texte du fichier lu, complété par Luna.");
    expect(phraseDeLecture({ scan: true, parLuna: false, luna: "CONFIDENTIELLE" })).toMatch(/^Lecture locale — document confidentiel : rien n'a quitté la plateforme\. Scan lu par l'OCR du serveur/);
    expect(phraseDeLecture({ scan: false, parLuna: false, luna: "DESACTIVEE" })).toMatch(/Contrôle de l'IA/);
    expect(phraseDeLecture({ scan: false, parLuna: false, luna: "NON_CONFIGUREE" })).not.toMatch(/rien n'a quitté/);
  });
});
