import { describe, expect, it } from "vitest";
import { bilanCtd, classerPiece, SECTIONS_CTD, type PieceAClasser } from "./ctd";

/**
 * LE CLASSEMENT CTD D'UN DOSSIER DÉPOSÉ (J11, décision 0030) — sur un dossier de 300 fichiers tel qu'un fabricant les
 * envoie : numéros de section dans les dossiers, ou des noms seuls, ou un texte lu, en français et en anglais.
 */

/** [chemin (sans la racine), section attendue, extrait lu éventuel] — les gabarits d'un dossier d'enregistrement. */
const GABARITS: [string, string | null, string?][] = [
  ["Module 1/1.0 Lettre de demande.pdf", "1.0"],
  ["Module 1/Formulaire de demande ANPP signé.pdf", "1.2"],
  ["Module 1/RCP Amlodipine 5 mg.docx", "1.3.1"],
  ["Module 1/Notice patient.docx", "1.3.2"],
  ["Module 1/Maquettes/etui 30 cp.pdf", "1.3.3"],
  ["Module 1/Certificats/GMP certificate site Pune.pdf", "1.5"],
  ["Module 1/Certificats/CPP pays d'origine.pdf", "1.5"],
  ["Module 1/Procuration Adventum.pdf", "1.7"],
  ["Module 2/2.3 QOS.docx", "2.3"],
  ["Module 2/Clinical overview.pdf", "2.5"],
  ["Module 3/3.2.S Drug substance/3.2.S.1 General information.pdf", "3.2.S.1"],
  ["Module 3/3.2.S Drug substance/3.2.S.2 Manufacture.pdf", "3.2.S.2"],
  ["Module 3/3.2.S Drug substance/3.2.S.3 Characterisation.pdf", "3.2.S.3"],
  ["Module 3/3.2.S Drug substance/3.2.S.4/3.2.S.4.1 Specification.pdf", "3.2.S.4"],
  ["Module 3/3.2.S Drug substance/3.2.S.7 Stability.pdf", "3.2.S.7"],
  ["Module 3/3.2.P/32P1 composition.pdf", "3.2.P.1"],
  ["Module 3/3.2.P/3.2.P.2 Pharmaceutical development.pdf", "3.2.P.2"],
  ["Module 3/3.2.P/3.2.P.3 Batch formula.pdf", "3.2.P.3"],
  ["Module 3/3.2.P/3.2.P.4 Excipients - lactose.pdf", "3.2.P.4"],
  ["Module 3/3.2.P/3.2.P.5/3.2.P.5.4 Batch analyses.pdf", "3.2.P.5"],
  ["Module 3/3.2.P/3.2.P.7 Container closure.pdf", "3.2.P.7"],
  ["Module 3/3.2.P/3.2.P.8 Stability.pdf", "3.2.P.8"],
  // Des noms SANS numéro : les mots décident.
  ["Qualité/Etude de stabilité produit fini 25°C 60%.pdf", "3.2.P.8"],
  ["Qualité/Certificat d'analyse principe actif lot 2214.pdf", "3.2.S.4"],
  ["Qualité/Validation du procédé de fabrication comprimés.pdf", "3.2.P.3"],
  ["Qualité/Profil de dissolution comparative.xlsx", "3.2.P.2"],
  ["Qualité/Blister PVC-Alu spécifications.pdf", "3.2.P.7"],
  ["Clinique/Bioequivalence study report.pdf", "5.3.1"],
  ["Clinique/Rapport BE cmax auc.pdf", "5.3.1"],
  ["Non clinique/Toxicologie revue.pdf", "4.2"],
  ["Divers/bibliographie.pdf", "5.4"],
  // Un nom muet, mais le texte lu par la Bibliothèque parle.
  ["Scans/scan_0042.pdf", "3.2.P.8", "Stability study of the finished product — long term conditions 30°C/75% RH, zone IVb, shelf life 24 months"],
  ["Scans/scan_0043.jpg", "1.5", "Certificate of GMP compliance of a manufacturer — Bonnes pratiques de fabrication"],
  // Un dosage n'est pas une section ; un nom muet sans texte reste non classé.
  ["Divers/Amlodipine 2.5 mg photo.jpg", null],
  ["Divers/IMG_2231.jpg", null],
];

/** 300 fichiers : chaque gabarit décliné (lots, versions, pages), l'ordre d'un vrai dossier. */
function dossier300(): { piece: PieceAClasser; attendu: string | null }[] {
  const out: { piece: PieceAClasser; attendu: string | null }[] = [];
  for (let i = 0; out.length < 300; i++) {
    const [chemin, attendu, extrait] = GABARITS[i % GABARITS.length]!;
    const tour = Math.floor(i / GABARITS.length);
    const decline = tour ? chemin.replace(/(\.[a-z]+)$/i, ` (${tour + 1})$1`) : chemin;
    out.push({ piece: { chemin: decline, extrait: extrait ?? null }, attendu });
  }
  return out;
}

describe("le classement CTD d'un dossier déposé", () => {
  it("un numéro écrit dans le chemin désigne la section — le plus profond gagne", () => {
    expect(classerPiece({ chemin: "CTD/Module 3/3.2.P/3.2.P.5/3.2.P.5.1 Spec.pdf" }).section).toBe("3.2.P.5");
    expect(classerPiece({ chemin: "m1/1.3.1 SmPC.docx" }).section).toBe("1.3.1");
    expect(classerPiece({ chemin: "Dossier/32s4 coa.pdf" }).section).toBe("3.2.S.4");
  });

  it("sans numéro, les mots tranchent — substance active et produit fini départagés", () => {
    expect(classerPiece({ chemin: "Stabilité substance active.pdf" }).section).toBe("3.2.S.7");
    expect(classerPiece({ chemin: "Stabilité produit fini.pdf" }).section).toBe("3.2.P.8");
  });

  it("un dosage n'est pas une section ; un nom muet sans texte reste NON CLASSÉ (jamais au hasard)", () => {
    expect(classerPiece({ chemin: "Amlodipine 2.5 mg.pdf" }).section).toBeNull();
    expect(classerPiece({ chemin: "IMG_0001.jpg" }).section).toBeNull();
  });

  it("300 fichiers : ≥ 95 % bien rangés, les muets dits non classés, en une passe de quelques millisecondes", () => {
    const corpus = dossier300();
    const t0 = performance.now();
    const b = bilanCtd(corpus.map((c) => c.piece));
    const ms = performance.now() - t0;
    const justes = corpus.filter((c) => classerPiece(c.piece).section === c.attendu).length;
    expect(justes / corpus.length).toBeGreaterThanOrEqual(0.95);
    expect(b.nonClassees.length).toBeGreaterThan(0);
    expect(Object.keys(b.parModule).sort()).toEqual(["Module 1", "Module 2", "Module 3", "Module 4", "Module 5"]);
    expect(ms).toBeLessThan(500);
  });

  it("les pièces qui MANQUENT : une section attendue sans aucune pièce est nommée", () => {
    const sansStabilite = dossier300().filter((c) => c.attendu !== "3.2.P.8").map((c) => c.piece);
    const b = bilanCtd(sansStabilite);
    expect(b.manquantes.map((m) => m.code)).toContain("3.2.P.8");
    expect(b.manquantes.map((m) => m.code)).not.toContain("3.2.P.5");
    // Les sections attendues sont celles d'un générique — et chacune a un libellé.
    expect(SECTIONS_CTD.filter((s) => s.attendue).every((s) => s.libelle.length > 3)).toBe(true);
  });
});
