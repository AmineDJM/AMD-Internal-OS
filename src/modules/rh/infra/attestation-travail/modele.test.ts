import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  remplirAttestationDeTravail, dateLongueFr, dateCourteFr, dateDepuisTexte, isoAlger, civiliteDe, accords, phraseNaissance,
  fusionnerPrefill, champsAChercherDansLeContrat, lireContratDeterministe, lireReponseLuna, refusAttestation, nomAttestation,
  societeImprimee, champPersonnalise, MOTIF_LIEU_NAISSANCE, MOTIF_CIVILITE, MARQUEURS_ATTESTATION, type ChampsAttestation,
} from "./modele";

const MODELE = readFileSync(join(process.cwd(), "src/modules/rh/infra/attestation-travail/modele-attestation-de-travail.docx"));
const champs: ChampsAttestation = {
  reference: "041/DG/2026", civilite: "Monsieur", salarie: "KACI Yacine", dateNaissance: "2001-03-12", lieuNaissance: "Blida",
  societe: "SARL ADVENTUM PHARMA", societeSignature: "ADVENTUM PHARMA", poste: "Délégué médical", dateEmbauche: "2025-07-01",
  signataireCivilite: "Monsieur", signataire: "SAIDI Karim", signataireFonction: "Directeur Financier et Administratif",
  lieuSignature: "Alger", dateSignature: "2026-06-03",
};
const texteDe = async (docx: Buffer) => {
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
};

describe("l'attestation de travail — les règles pures", () => {
  it("les dates à la française : « 24 janvier 2004 », « 03 juin 2026 », « 01/07/2025 »", () => {
    expect(dateLongueFr("2004-01-24")).toBe("24 janvier 2004");
    expect(dateLongueFr("2026-06-03")).toBe("03 juin 2026");
    expect(dateLongueFr("2025-08-15")).toBe("15 août 2025");
    expect(dateCourteFr("2025-07-01")).toBe("01/07/2025");
    expect(dateLongueFr("pas une date")).toBe("pas une date");
    expect(dateLongueFr("2026-02-30")).toBe("2026-02-30"); // n'existe pas : rendue telle quelle, jamais « corrigée »
  });
  it("une date lue dans un texte : chiffres, mois en toutes lettres, « 1er »", () => {
    expect(dateDepuisTexte("24/01/2004")).toBe("2004-01-24");
    expect(dateDepuisTexte("24.01.2004")).toBe("2004-01-24");
    expect(dateDepuisTexte("24 janvier 2004")).toBe("2004-01-24");
    expect(dateDepuisTexte("1er juillet 2025")).toBe("2025-07-01");
    expect(dateDepuisTexte("15 aout 2025")).toBe("2025-08-15");
    expect(dateDepuisTexte("31/02/2025")).toBeNull();
    expect(dateDepuisTexte("bientôt")).toBeNull();
  });
  it("aujourd'hui À ALGER (UTC+1) : 23 h 30 UTC le 13 est déjà le 14", () => {
    expect(isoAlger(new Date("2026-10-13T23:30:00Z"))).toBe("2026-10-14");
    expect(isoAlger(new Date("2026-10-14T10:00:00Z"))).toBe("2026-10-14");
    expect(isoAlger(new Date("2004-01-24T00:00:00Z"))).toBe("2004-01-24"); // une date de naissance stockée à minuit UTC
    expect(isoAlger(null)).toBe("");
  });
  it("la civilité Monsieur / Madame et ses accords", () => {
    expect(civiliteDe("M.")).toBe("Monsieur");
    expect(civiliteDe("Mme")).toBe("Madame");
    expect(civiliteDe("Mlle")).toBe("Madame");
    expect(civiliteDe("F")).toBe("Madame");
    expect(civiliteDe("Dr")).toBeNull();
    expect(accords("Madame")).toEqual({ ne: "née", employe: "employée", interesse: "l'intéressée", soussigne: "soussignée" });
    expect(accords("Monsieur").ne).toBe("né");
    expect(accords("").employe).toBe("employé"); // le masculin du modèle quand rien n'est dit
    expect(phraseNaissance({ civilite: "Madame", dateNaissance: "1990-03-05", lieuNaissance: "Oran" })).toBe(", née le 05 mars 1990 à Oran");
    expect(phraseNaissance({ civilite: "Monsieur", dateNaissance: "", lieuNaissance: "Oran" })).toBe(", né à Oran");
    expect(phraseNaissance({ civilite: "Monsieur", dateNaissance: "", lieuNaissance: "" })).toBe("");
  });
  it("la société : la forme dans le texte, le nom seul après « Pour »", () => {
    expect(societeImprimee({ legalName: "ADVENTUM PHARMA", legalForm: "SARL" })).toEqual({ societe: "SARL ADVENTUM PHARMA", societeSignature: "ADVENTUM PHARMA" });
    expect(societeImprimee({ legalName: "SARL ADVENTUM PHARMA", legalForm: "SARL" })).toEqual({ societe: "SARL ADVENTUM PHARMA", societeSignature: "ADVENTUM PHARMA" });
    expect(societeImprimee({ legalName: null, legalForm: null, name: "Pharmagene" })).toEqual({ societe: "Pharmagene", societeSignature: "Pharmagene" });
  });
  it("un champ personnalisé de la fiche (lieu de naissance, civilité)", () => {
    expect(champPersonnalise({ lieu_de_naissance: "Tizi Ouzou" }, MOTIF_LIEU_NAISSANCE)).toBe("Tizi Ouzou");
    expect(champPersonnalise({ Civilité: "Mme" }, MOTIF_CIVILITE)).toBe("Mme");
    expect(champPersonnalise({ autre: "x" }, MOTIF_LIEU_NAISSANCE)).toBeNull();
    expect(champPersonnalise(null, MOTIF_CIVILITE)).toBeNull();
  });
});

describe("le préremplissage — fiche RH, puis contrat, puis société, puis défaut", () => {
  it("la fiche l'emporte ; le contrat comble les trous, et chaque valeur dit d'où elle vient", () => {
    const fiche = { salarie: "KACI Yacine", poste: "Délégué médical", dateNaissance: "", lieuNaissance: "", dateEmbauche: "", civilite: "" as const };
    expect(champsAChercherDansLeContrat(fiche)).toEqual(["civilite", "dateNaissance", "lieuNaissance", "dateEmbauche"]);
    const { champs: c, provenance } = fusionnerPrefill({
      fiche,
      contrat: { civilite: "Monsieur", dateNaissance: "2001-03-12", lieuNaissance: "Blida", poste: "Commercial", dateEmbauche: "2025-07-01" },
      parLuna: ["lieuNaissance"],
      societe: { societe: "SARL ADVENTUM PHARMA", signataire: "SAIDI Karim" },
      defauts: { lieuSignature: "Alger", dateSignature: "2026-10-14", societe: "jamais utilisé" },
    });
    expect(c.poste).toBe("Délégué médical"); // la fiche, pas le contrat
    expect(provenance.poste).toBe("fiche");
    expect(c.dateNaissance).toBe("2001-03-12");
    expect(provenance.dateNaissance).toBe("contrat");
    expect(provenance.lieuNaissance).toBe("luna");
    expect(c.civilite).toBe("Monsieur");
    expect(c.societe).toBe("SARL ADVENTUM PHARMA");
    expect(provenance.societe).toBe("societe");
    expect(c.lieuSignature).toBe("Alger");
    expect(provenance.dateSignature).toBe("defaut");
    expect(c.signataireFonction).toBe("");
    expect(provenance.signataireFonction).toBe("vide");
    expect(c.reference).toBe("");
  });
  it("le contrat ne fournit que ses cinq champs : jamais le nom, la société ou le signataire", () => {
    const { provenance } = fusionnerPrefill({
      fiche: {}, contrat: { poste: "X" } as never, societe: {}, defauts: {},
    });
    expect(provenance.salarie).toBe("vide");
    expect(provenance.poste).toBe("contrat");
  });
});

describe("la lecture DÉTERMINISTE du contrat (IA coupée)", () => {
  const CONTRAT = `CONTRAT DE TRAVAIL À DURÉE INDÉTERMINÉE
Entre les soussignés : la SARL ADVENTUM PHARMA, représentée par Monsieur SAIDI Karim en qualité de Gérant, d'une part,
Et Madame KACI Lina, née le 05/03/1990 à Tizi Ouzou demeurant à Alger, d'autre part.
Article 2 : Madame KACI Lina est recrutée en qualité de Déléguée médicale.
Article 3 : Le présent contrat prend effet à compter du 1er juillet 2025.`;

  it("lit la naissance, la civilité (« née »), le poste (pas celui du gérant), la date d'effet", () => {
    expect(lireContratDeterministe(CONTRAT)).toEqual({
      dateNaissance: "1990-03-05", lieuNaissance: "Tizi Ouzou", civilite: "Madame", poste: "Déléguée médicale", dateEmbauche: "2025-07-01",
    });
  });
  it("les formes à libellé : « Date de naissance : », « Lieu de naissance : », « Poste : », « Date d'effet : »", () => {
    expect(lireContratDeterministe("Date de naissance : 24/01/2004\nLieu de naissance : Hammamet, Alger\nPoste : Directeur Marketing\nDate d'effet : 01/07/2025")).toEqual({
      dateNaissance: "2004-01-24", lieuNaissance: "Hammamet, Alger", poste: "Directeur Marketing", dateEmbauche: "2025-07-01",
    });
  });
  it("la qualité de l'EMPLOYEUR n'est jamais prise pour le poste, même tout près de celle du salarié", () => {
    expect(lireContratDeterministe("La société, représentée par M. SAIDI Karim en qualité de Directeur Général, recrute M. KACI Yacine en qualité de Commercial.").poste)
      .toBe("Commercial");
    expect(lireContratDeterministe("Représentée par M. SAIDI en qualité de Directeur Général.").poste).toBeUndefined();
  });
  it("ne devine rien : un texte muet ne rend rien", () => {
    expect(lireContratDeterministe("Bonjour, ceci n'est pas un contrat.")).toEqual({});
    expect(lireContratDeterministe("")).toEqual({});
  });
  it("la réponse de Luna est relue strictement", () => {
    expect(lireReponseLuna({ civilite: "Mme", dateNaissance: "1990-03-05", lieuNaissance: " Oran ", poste: "", dateEmbauche: "2025-02-30" }))
      .toEqual({ civilite: "Madame", dateNaissance: "1990-03-05", lieuNaissance: "Oran" });
    expect(lireReponseLuna({ dateEmbauche: "1er juillet 2025", poste: "x".repeat(200) })).toEqual({ dateEmbauche: "2025-07-01" });
    expect(lireReponseLuna("du texte")).toEqual({});
    expect(lireReponseLuna(null)).toEqual({});
  });
});

describe("l'attestation de travail — le document de la Direction, rempli", () => {
  it("le modèle porte tous ses marqueurs et AUCUNE donnée de la personne de l'exemple", async () => {
    const t = await texteDe(MODELE);
    for (const m of MARQUEURS_ATTESTATION) expect(t).toContain(`{{${m}}}`);
    const zip = await JSZip.loadAsync(MODELE);
    for (const f of Object.keys(zip.files)) {
      if (zip.files[f].dir || f.endsWith(".png")) continue;
      expect(await zip.file(f)!.async("string"), f).not.toMatch(/DJOUAMAI|BOURAI|HAMMAMET|Wahab|Hocine/i);
    }
  });
  it("le texte généré reprend le modèle, accords compris", async () => {
    const t = await texteDe(await remplirAttestationDeTravail(MODELE, champs));
    expect(t).not.toMatch(/\{\{/);
    expect(t).toContain("Réf. : 041/DG/2026");
    expect(t).toContain("Attestation de travail");
    expect(t).toContain("Je soussigné, Monsieur SAIDI Karim agissant en qualité de Directeur Financier et Administratif certifie que :");
    expect(t).toContain("Monsieur KACI Yacine, né le 12 mars 2001 à Blida est employé au sein de SARL ADVENTUM PHARMA en qualité de Délégué médical depuis le 01/07/2025 à ce jour.");
    expect(t).toContain("à la demande de l'intéressé pour servir et valoir ce que de droit.");
    expect(t).toContain("Fait à Alger le, 03 juin 2026");
    expect(t).toContain("Pour ADVENTUM PHARMA");
  });
  it("au féminin, sans référence, sans naissance — et « & » échappé", async () => {
    const t = await texteDe(await remplirAttestationDeTravail(MODELE, {
      ...champs, reference: "", civilite: "Madame", salarie: "KACI Lina", dateNaissance: "", lieuNaissance: "", poste: "Chef de produit R&D",
      signataireCivilite: "Madame", signataire: "BELHADJ Sara",
    }));
    expect(t).not.toContain("Réf.");
    expect(t).toContain("Je soussignée, Madame BELHADJ Sara");
    expect(t).toContain("Madame KACI Lina est employée au sein de");
    expect(t).toContain("Chef de produit R&amp;D");
    expect(t).toContain("à la demande de l'intéressée");
  });
  it("en-tête, pied et logo du papier à en-tête voyagent intacts ; le paquet est un document (pas un modèle .dotx)", async () => {
    const z = await JSZip.loadAsync(await remplirAttestationDeTravail(MODELE, champs));
    for (const f of ["word/header1.xml", "word/footer1.xml", "word/media/image1.png", "word/media/image2.png", "word/styles.xml"]) expect(z.file(f), f).not.toBeNull();
    expect(await z.file("[Content_Types].xml")!.async("string")).toContain("wordprocessingml.document.main+xml");
  });
  it("le PDF remis au salarié se produit (le convertisseur de l'ordre de mission)", async () => {
    const { docxToPdf } = await import("@/lib/payslip/to-pdf");
    const pdf = await docxToPdf(await remplirAttestationDeTravail(MODELE, champs));
    expect(pdf.ok, pdf.ok ? "" : pdf.error).toBe(true);
    if (pdf.ok) expect(pdf.pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("ce qui manque, le nom du fichier", () => {
    expect(refusAttestation(champs)).toBeNull();
    expect(refusAttestation({ ...champs, signataire: " ", dateEmbauche: "", civilite: "" })).toBe(
      "Pour générer l'attestation, indiquez la civilité du salarié, la date d'embauche, le signataire.",
    );
    expect(refusAttestation({ ...champs, dateNaissance: "12/03/2001" })).toMatch(/une date de naissance valide/);
    expect(nomAttestation("041/DG/2026", "KACI Yacine")).toBe("Attestation de travail 041-DG-2026 — KACI Yacine");
    expect(nomAttestation("", "KACI Yacine", 2)).toBe("Attestation de travail — KACI Yacine (v2)");
  });
});
