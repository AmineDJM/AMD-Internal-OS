import { describe, expect, it } from "vitest";
import {
  AVERTISSEMENT_COFFRE, ENTREES_MAX_PARCOURUES, OCTETS_MAX_DEPOT, PIECES_PAR_ENVOI_MAX, RAISON_DOUBLON, RAISON_VIDE, avertissementPiece,
  estFichierSysteme, familleIcone, idsDriveCites, modifiable, parcourirDepot, phraseLecturePartielle, phraseRefus, planifierDepot,
  retirerPieces, tailleLisible, texteDemandeModification, type EntreeDepot, type FichierDepot,
} from "./depot";
import { OCTETS_MAX_LECTURE, PIECES_LUES_MAX } from "./regles";

/**
 * LE GLISSER-DÉPOSER DE L'ASSISTANT IA (décision 0015) — les règles pures : le parcours récursif d'un
 * dossier (chemins relatifs, fichiers système ignorés, bornes), les limites d'un envoi, le retrait
 * des puces, les pièces renvoyées par l'assistant.
 */

const fichier = (name: string, size = 10, type = ""): EntreeDepot => ({
  isFile: true, isDirectory: false, name, fichier: async () => ({ name, size, type }),
});
const dossier = (name: string, enfants: EntreeDepot[]): EntreeDepot => ({
  isFile: false, isDirectory: true, name, lister: async () => enfants,
});

describe("parcours d'un dossier déposé", () => {
  it("garde le chemin relatif, parcourt récursivement, trie et ignore les fichiers système", async () => {
    const r = await parcourirDepot<FichierDepot>([
      dossier("Congrès Oran", [
        fichier(".DS_Store"),
        dossier("devis", [fichier("imprimeur.pdf", 1200), fichier("Thumbs.db"), fichier("~$traiteur.docx")]),
        fichier("programme.docx", 3000),
        dossier("__MACOSX", [fichier("._programme.docx")]),
      ]),
      fichier("note.txt", 5),
    ]);
    expect(r.trouves.map((t) => t.chemin)).toEqual(["Congrès Oran/devis/imprimeur.pdf", "Congrès Oran/programme.docx", "note.txt"]);
    expect(r.ignores).toBe(4);
    expect(r.tronque).toBe(false);
    expect(r.trouves[0]!.fichier.size).toBe(1200);
  });

  it("borne la profondeur et le nombre d'entrées, et le dit", async () => {
    let profond: EntreeDepot = fichier("fond.txt");
    for (let i = 0; i < 20; i++) profond = dossier(`n${i}`, [profond]);
    const r = await parcourirDepot([profond]);
    expect(r.trouves).toHaveLength(0);
    expect(r.tronque).toBe(true);

    const enorme = dossier("gros", Array.from({ length: ENTREES_MAX_PARCOURUES + 50 }, (_, i) => fichier(`f${String(i).padStart(4, "0")}.txt`)));
    const r2 = await parcourirDepot([enorme]);
    expect(r2.trouves.length).toBe(ENTREES_MAX_PARCOURUES - 1);
    expect(r2.tronque).toBe(true);
  });

  it("une entrée illisible est sautée, pas fatale", async () => {
    const casse: EntreeDepot = { isFile: true, isDirectory: false, name: "casse.pdf", fichier: async () => { throw new Error("x"); } };
    const muet: EntreeDepot = { isFile: false, isDirectory: true, name: "muet", lister: async () => { throw new Error("y"); } };
    const r = await parcourirDepot([casse, muet, fichier("ok.pdf")]);
    expect(r.trouves.map((t) => t.chemin)).toEqual(["ok.pdf"]);
  });

  it("reconnaît les fichiers et dossiers système ou cachés", () => {
    expect(estFichierSysteme(".DS_Store")).toBe(true);
    expect(estFichierSysteme("a/Thumbs.db")).toBe(true);
    expect(estFichierSysteme("a/desktop.ini")).toBe(true);
    expect(estFichierSysteme("a/.git/config")).toBe(true);
    expect(estFichierSysteme("a/.cache/x.pdf")).toBe(true);
    expect(estFichierSysteme("Congrès/devis.pdf")).toBe(false);
    expect(estFichierSysteme("")).toBe(true);
  });
});

describe("les limites d'un envoi", () => {
  it("s'alignent sur la lecture : 40 Mo par fichier, 6 pièces lues, 10 jointes", () => {
    expect(OCTETS_MAX_DEPOT).toBe(OCTETS_MAX_LECTURE);
    expect(OCTETS_MAX_DEPOT).toBe(40 * 1024 * 1024);
    expect(PIECES_LUES_MAX).toBe(6);
    expect(PIECES_PAR_ENVOI_MAX).toBe(10);
  });

  it("refuse le vide, le trop gros, le doublon, puis tout ce qui dépasse le nombre au plus — chacun nommé", () => {
    const dejaLa = Array.from({ length: 7 }, (_, i) => ({ chemin: `d${i}.pdf`, taille: 100 }));
    const { acceptes, refus } = planifierDepot(dejaLa, [
      { chemin: "vide.txt", taille: 0 },
      { chemin: "film.mov", taille: OCTETS_MAX_DEPOT + 1 },
      { chemin: "d0.pdf", taille: 100 },
      { chemin: "a.pdf", taille: 1 },
      { chemin: "b.pdf", taille: 1 },
      { chemin: "c.pdf", taille: 1 },
      { chemin: "d.pdf", taille: 1 },
    ]);
    expect(acceptes.map((a) => a.chemin)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(refus.map((r) => r.chemin)).toEqual(["vide.txt", "film.mov", "d0.pdf", "d.pdf"]);
    expect(refus[0]!.raison).toBe(RAISON_VIDE);
    expect(refus[1]!.raison).toMatch(/40,0 Mo/);
    expect(refus[2]!.raison).toBe(RAISON_DOUBLON);
    expect(refus[3]!.raison).toMatch(/10 pièces au plus/);
    const phrase = phraseRefus(refus, 2, true)!;
    expect(phrase).toMatch(/4 fichiers non joints/);
    expect(phrase).toMatch(/« vide\.txt »/);
    expect(phrase).toMatch(/2 fichiers système ou cachés ignorés/);
    expect(phrase).toMatch(/parcours arrêté/);
    expect(phraseRefus([])).toBeNull();
  });

  it("le même nom dans deux dossiers n'est pas un doublon", () => {
    const { acceptes } = planifierDepot([], [{ chemin: "A/devis.pdf", taille: 5 }, { chemin: "B/devis.pdf", taille: 5 }]);
    expect(acceptes).toHaveLength(2);
  });

  it("au-delà de 6 pièces, l'écran dit d'avance que les suivantes sont jointes et rangées sans être lues", () => {
    expect(phraseLecturePartielle(6)).toBeNull();
    expect(phraseLecturePartielle(9)).toBe("9 pièces : les 6 premières seront lues par l'assistant ; les 3 autres seront jointes et rangées dans votre Drive, sans être lues.");
  });

  it("une pièce dont le nom annonce le coffre est signalée sur sa puce", () => {
    expect(avertissementPiece("RH/Passeport Amel.pdf")).toBe(AVERTISSEMENT_COFFRE);
    expect(avertissementPiece("RH/programme.pdf")).toBeNull();
  });
});

describe("le retrait des puces", () => {
  const p = [{ cle: "a" }, { cle: "b" }, { cle: "c" }];
  it("retire une, plusieurs, ou toutes — et rend celles retirées", () => {
    expect(retirerPieces(p, ["b"]).restantes.map((x) => x.cle)).toEqual(["a", "c"]);
    const deux = retirerPieces(p, new Set(["a", "c"]));
    expect(deux.restantes.map((x) => x.cle)).toEqual(["b"]);
    expect(deux.retirees.map((x) => x.cle)).toEqual(["a", "c"]);
    expect(retirerPieces(p, p.map((x) => x.cle)).restantes).toEqual([]);
    expect(retirerPieces(p, ["z"]).restantes).toHaveLength(3);
  });
});

describe("les pièces de la conversation", () => {
  const id1 = "c" + "a1".repeat(12);
  const id2 = "c" + "b2".repeat(12);
  it("trouve les fichiers du Drive cités par la réponse ou le résultat d'une action, sans doublon", () => {
    expect(idsDriveCites(`Voici [la lettre](/drive/${id1}).`, `/drive/${id1}`, null, `https://x/drive/${id2}?v=1`)).toEqual([id1, id2]);
    expect(idsDriveCites("/drive/abc", undefined)).toEqual([]);
  });

  it("une modification est proposée sur Word et PowerPoint, jamais d'écrasement", () => {
    expect(modifiable("Congrès/lettre.docx")).toBe("word");
    expect(modifiable("deck.pptx")).toBe("presentation");
    // J3 : l'Atelier modifie en place Word, PowerPoint, Excel et PDF ; un ancien format ne s'ouvre pas en place.
    expect(modifiable("budget.xlsx")).toBe("tableur");
    expect(modifiable("scan.pdf")).toBe("pdf");
    expect(modifiable("vieux.doc")).toBeNull();
    expect(texteDemandeModification("Congrès/lettre.docx")).toBe("Modifie « lettre.docx » directement dans l'Atelier (sur le fichier d'origine, en gardant sa mise en page) : ");
  });

  it("icônes et tailles", () => {
    expect(familleIcone("a.pdf")).toBe("pdf");
    expect(familleIcone("a.docx")).toBe("word");
    expect(familleIcone("a.xlsx")).toBe("tableur");
    expect(familleIcone("a.png")).toBe("image");
    expect(familleIcone("a.bin")).toBe("autre");
    expect(tailleLisible(12)).toBe("12 o");
    expect(tailleLisible(2048)).toBe("2 ko");
    expect(tailleLisible(3 * 1048576)).toBe("3,0 Mo");
  });
});
