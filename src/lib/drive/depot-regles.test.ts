import { describe, it, expect } from "vitest";
import {
  lireChoixDoublon, nomLibre, extensionDiffere, nomApresNouvelleVersion, questionDoublon, avertissementExtension,
  refusDepotPhrase, limiteAnnonceeMo, phraseLimite, decisionRafraichir, estIOS,
} from "./depot-regles";
import { refusSansStockageObjet } from "@/lib/storage/phrases-stockage";
import { extensionDuMime } from "./mime-nom";

/** Audit Drive du 24/11, section C — les règles pures du dépôt côté personne. */
describe("doublon au dépôt (C2)", () => {
  it("le choix se lit strictement : toute autre valeur = pas de choix (comportement d'avant)", () => {
    expect(lireChoixDoublon("version")).toBe("version");
    expect(lireChoixDoublon("garder")).toBe("garder");
    expect(lireChoixDoublon("écraser")).toBeNull();
    expect(lireChoixDoublon(null)).toBeNull();
  });

  it("« Garder les deux » numérote à la Windows, sans heurter un nom déjà pris (casse ignorée)", () => {
    expect(nomLibre("contrat.pdf", [])).toBe("contrat.pdf");
    expect(nomLibre("contrat.pdf", ["Contrat.PDF"])).toBe("contrat (2).pdf");
    expect(nomLibre("contrat.pdf", ["contrat.pdf", "contrat (2).pdf"])).toBe("contrat (3).pdf");
    expect(nomLibre("LISEZMOI", ["LISEZMOI"])).toBe("LISEZMOI (2)");
  });

  it("la question nomme le fichier, ou compte quand il y en a plusieurs", () => {
    expect(questionDoublon(["contrat.pdf"])).toBe("« contrat.pdf » existe déjà ici.");
    expect(questionDoublon(["a.pdf", "b.pdf", "c.pdf", "d.pdf"])).toMatch(/^4 fichiers existent déjà ici .*…\)\.$/);
  });
});

describe("nouvelle version d'un autre type (C3)", () => {
  it("le fichier garde son nom et prend l'extension du contenu déposé", () => {
    expect(extensionDiffere("x.pdf", "Budget.xlsx")).toBe(true);
    expect(extensionDiffere("x.PDF", "y.pdf")).toBe(false);
    expect(nomApresNouvelleVersion("x.pdf", "Budget.xlsx")).toBe("x.xlsx");
    expect(nomApresNouvelleVersion("x.pdf", "autre.pdf")).toBe("x.pdf");
    // Un dépôt sans extension ne dit rien de son type : le nom ne bouge pas.
    expect(extensionDiffere("x.pdf", "scan")).toBe(false);
    expect(nomApresNouvelleVersion("x.pdf", "scan")).toBe("x.pdf");
    expect(nomApresNouvelleVersion("Note", "note.docx")).toBe("Note.docx");
    expect(avertissementExtension("x.pdf", "b.xlsx")).toContain("« x.xlsx »");
  });

  it("une ancienne version retrouve son extension par son type", () => {
    expect(extensionDuMime("application/pdf")).toBe("pdf");
    expect(extensionDuMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx");
    expect(extensionDuMime("application/x-inconnu")).toBeNull();
  });
});

describe("refus avec remède (C10) et phrase de stockage (C5)", () => {
  it("le refus de dépôt dit à qui demander — jamais « Non autorisé. » seul", () => {
    expect(refusDepotPhrase("Amina B.")).toBe("Vous ne pouvez pas déposer ici. Demandez l'accès à Amina B..");
    expect(refusDepotPhrase(null)).toMatch(/^Vous ne pouvez pas déposer ici\. Demandez l'accès au responsable/);
  });

  it("l'employé lit une phrase simple ; la marche technique (variables, Render) n'est servie qu'au Super Admin", () => {
    const simple = refusSansStockageObjet(300 * 1024 * 1024, 100);
    expect(simple).toMatch(/300 Mo.*100 Mo/);
    expect(simple).not.toMatch(/S3_|Render|redéploy/);
    expect(simple).toMatch(/Compressez-le|Super Admin/);
    expect(refusSansStockageObjet(300 * 1024 * 1024, 100, true)).toMatch(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  });
});

describe("limite annoncée (C9)", () => {
  const base = { maxUploadMb: 50, maxDriveUploadMb: 200, stockageObjet: false, maxSansStockageObjetMo: 100 };
  it("sans stockage objet, le plafond d'écriture en base l'emporte", () => {
    expect(limiteAnnonceeMo(base, "drive")).toBe(100);
    expect(limiteAnnonceeMo(base, "documents")).toBe(50);
    expect(phraseLimite(base, "drive")).toBe("max 100 Mo par fichier");
  });
  it("avec stockage objet : le réglage du Drive, 10 Go pour les Documents — jamais un « 10 Go » en dur ailleurs", () => {
    expect(limiteAnnonceeMo({ ...base, stockageObjet: true }, "drive")).toBe(200);
    expect(phraseLimite({ ...base, stockageObjet: true }, "documents")).toBe("max 10,0 Go par fichier");
    expect(phraseLimite(null, "drive")).toBeNull();
  });
});

describe("rafraîchissement par fichier (C4)", () => {
  it("le premier fichier rafraîchit tout de suite, les suivants au plus une fois par intervalle, sans doublon de rappel", () => {
    expect(decisionRafraichir({ dernier: null, programme: false }, 1000)).toEqual({ action: "maintenant" });
    expect(decisionRafraichir({ dernier: 1000, programme: false }, 1500, 1500)).toEqual({ action: "plus-tard", dans: 1000 });
    expect(decisionRafraichir({ dernier: 1000, programme: true }, 1600, 1500)).toEqual({ action: "rien" });
    expect(decisionRafraichir({ dernier: 1000, programme: false }, 2600, 1500)).toEqual({ action: "maintenant" });
  });
});

describe("iOS (C15)", () => {
  it("iPhone et iPad (même déguisé en Mac) : pas de choix de dossier", () => {
    expect(estIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", "iPhone", 5)).toBe(true);
    expect(estIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 5)).toBe(true);
    expect(estIOS("Mozilla/5.0 (Macintosh)", "MacIntel", 0)).toBe(false);
    expect(estIOS("Mozilla/5.0 (Windows NT 10.0)", "Win32", 0)).toBe(false);
  });
});
