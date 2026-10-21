import { describe, expect, it } from "vitest";
import { validateAttachments } from "@/lib/attach-files";

describe("un champ fichier laissé vide n'est pas une pièce", () => {
  it("zéro octet SANS nom, ou nommé « undefined » par l'action serveur : rien à contrôler", async () => {
    expect(await validateAttachments([new File([], "")])).toBeNull();
    expect(await validateAttachments([new File([], "undefined")])).toBeNull();
    expect(await validateAttachments([])).toBeNull();
  });

  it("un fichier vide qui porte un VRAI nom reste refusé, et dit son nom", async () => {
    const r = await validateAttachments([new File([], "lettre.pdf")]);
    expect(r).toContain("« lettre.pdf » est vide (0 octet).");
  });
});

/**
 * TOUT TYPE, SAUF CE QUI S'EXÉCUTE — la règle des pièces jointes à la création d'une demande Ad & Pro
 * et d'une demande au bureau du secrétariat (Direction, 10/2026 : « on doit pouvoir joindre des Excel »).
 */
describe("les pièces jointes : tout document de bureau, jamais un programme", () => {
  const fichier = (nom: string) => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], nom);

  it("Excel sous toutes ses formes, et les autres documents de bureau, passent", async () => {
    const noms = ["participants.xlsx", "ancien.xls", "macros.xlsm", "export.csv", "devis.pdf", "lettre.docx", "photo.jpg", "dossier.zip", "mail.msg"];
    expect(await validateAttachments(noms.map(fichier))).toBeNull();
  });

  it("un programme ou un script est refusé, nommé — même glissé parmi des Excel", async () => {
    const r = await validateAttachments([fichier("tableau.xlsx"), fichier("outil.exe"), fichier("lancer.bat"), fichier("script.ps1")]);
    expect(r).not.toBeNull();
    for (const nom of ["outil.exe", "lancer.bat", "script.ps1"]) expect(r).toContain(`« ${nom} »`);
    expect(r).not.toContain("tableau.xlsx");
  });
});
