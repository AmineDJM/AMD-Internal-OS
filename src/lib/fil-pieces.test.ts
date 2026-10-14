import { describe, expect, it } from "vitest";
import { ajouterAuChoix, clePieceMessage, messageDeLaPiece, messageRecevable, piecesParMessage, PREFIXE_PIECE_MESSAGE } from "@/lib/fil-pieces";
import { etatApresRetrait, fichiersDeLaCase, phraseDepot, principalApresDepot } from "@/lib/care-pieces";
import { prefixeFiche, prefixesRecus, refusDeFiche, FICHES_MAX } from "@/lib/ad-pro/fiches-saisie";

describe("Pièces jointes d'un message de fil — la clé", () => {
  it("la clé se lit dans les deux sens, et rien d'autre n'est pris pour une pièce de fil", () => {
    const cle = clePieceMessage("c123");
    expect(cle.startsWith(PREFIXE_PIECE_MESSAGE)).toBe(true);
    expect(messageDeLaPiece(cle)).toBe("c123");
    expect(messageDeLaPiece(null)).toBeNull();
    expect(messageDeLaPiece("ID_DOCUMENT")).toBeNull();
    expect(messageDeLaPiece("voyageur-1")).toBeNull();
    expect(messageDeLaPiece(PREFIXE_PIECE_MESSAGE), "un préfixe seul ne désigne aucun message").toBeNull();
  });

  it("les pièces se regroupent par message, dans leur ordre, les autres documents à l'écart", () => {
    const docs = [
      { id: "d1", stepKey: clePieceMessage("a") },
      { id: "d2", stepKey: "etape-anpp" },
      { id: "d3", stepKey: clePieceMessage("b") },
      { id: "d4", stepKey: clePieceMessage("a") },
      { id: "d5", stepKey: null },
    ];
    const g = piecesParMessage(docs);
    expect([...g.keys()]).toEqual(["a", "b"]);
    expect(g.get("a")!.map((d) => d.id)).toEqual(["d1", "d4"]);
  });

  it("un message se publie s'il dit quelque chose OU porte une pièce", () => {
    expect(messageRecevable("Bonjour", 0)).toBe(true);
    expect(messageRecevable("   ", 0)).toBe(false);
    expect(messageRecevable(null, 0)).toBe(false);
    expect(messageRecevable("", 2), "la pièce EST le propos").toBe(true);
  });
});

describe("Choisir plusieurs fichiers avant l'envoi", () => {
  const f = (name: string, size: number, lastModified = 1) => ({ name, size, lastModified });

  it("plusieurs fichiers d'un geste, puis d'autres : la sélection s'accumule, sans doublon", () => {
    const r1 = ajouterAuChoix([], [f("recto.jpg", 10), f("verso.jpg", 12)], 25);
    expect(r1.fichiers.map((x) => x.name)).toEqual(["recto.jpg", "verso.jpg"]);
    const r2 = ajouterAuChoix(r1.fichiers, [f("recto.jpg", 10), f("visa.pdf", 30)], 25);
    expect(r2.fichiers.map((x) => x.name), "le recto choisi deux fois ne part qu'une fois").toEqual(["recto.jpg", "verso.jpg", "visa.pdf"]);
    expect(r2.refus).toEqual([]);
  });

  it("ce que le serveur refuserait est DIT avant l'envoi, avec sa phrase ; le reste passe", () => {
    const r = ajouterAuChoix([], [f("outil.exe", 10), f("vide.pdf", 0), f("gros.pdf", 30 * 1024 * 1024), f("ok.pdf", 100)], 25);
    expect(r.fichiers.map((x) => x.name)).toEqual(["ok.pdf"]);
    expect(r.refus.map((x) => x.nom)).toEqual(["outil.exe", "vide.pdf", "gros.pdf"]);
    expect(r.refus[0]!.raison).toMatch(/non autorisé \(\.exe\)/);
    expect(r.refus[2]!.raison).toMatch(/maximum de 25 Mo/);
  });

  it("limites non lues : rien n'est refusé pour la taille ici — le serveur reste la garde", () => {
    const r = ajouterAuChoix([], [f("gros.pdf", 900 * 1024 * 1024)], null);
    expect(r.fichiers).toHaveLength(1);
  });
});

describe("Les fichiers d'une pièce de prise en charge", () => {
  it("les fichiers d'une case : ceux qu'elle désigne, et son principal rangé ailleurs", () => {
    const docs = [{ id: "a", stepKey: "cell1" }, { id: "b", stepKey: "cell2" }, { id: "c", stepKey: null }, { id: "d", stepKey: "cell1" }];
    expect(fichiersDeLaCase({ id: "cell1", documentId: "c" }, docs).map((d) => d.id)).toEqual(["a", "c", "d"]);
    expect(fichiersDeLaCase({ id: "cell3", documentId: null }, docs)).toEqual([]);
  });

  it("retirer un fichier : la pièce reste reçue tant qu'il en reste ; le principal suit", () => {
    expect(etatApresRetrait({ documentId: "a" }, "b", ["a", "c"])).toEqual({ status: "PROVIDED", documentId: "a" });
    expect(etatApresRetrait({ documentId: "a" }, "a", ["b", "c"]), "le principal retiré : le plus ancien restant").toEqual({ status: "PROVIDED", documentId: "b" });
    expect(etatApresRetrait({ documentId: "a" }, "a", []), "le dernier retiré : la pièce est de nouveau attendue").toEqual({ status: "REQUESTED", documentId: null });
  });

  it("déposer : le principal reste le sien s'il existe ; sinon le premier déposé", () => {
    expect(principalApresDepot("old", true, ["n1", "n2"])).toBe("old");
    expect(principalApresDepot("old", false, ["n1", "n2"])).toBe("n1");
    expect(principalApresDepot(null, false, ["n1"])).toBe("n1");
    expect(phraseDepot("Passeport", 1)).toBe("Passeport reçue.");
    expect(phraseDepot("Passeport", 3)).toBe("Passeport : 3 fichiers joints.");
  });
});

describe("Les fiches saisies avec le poste — les préfixes", () => {
  it("un préfixe par fiche ; les préfixes reçus sont filtrés, dédoublonnés, bornés", () => {
    expect(prefixeFiche(0)).toBe("fiche0_");
    expect(prefixesRecus(["fiche0_", "fiche3_", "fiche0_", "nom", "fiche_", "../x", 4])).toEqual(["fiche0_", "fiche3_"]);
    expect(prefixesRecus(Array.from({ length: FICHES_MAX + 1 }, (_, i) => prefixeFiche(i)))).toBeNull();
  });

  it("le refus nomme la fiche et dit que rien n'a été créé", () => {
    expect(refusDeFiche(2, "Haddad", "Il manque le nom.")).toBe("Fiche 2 (Haddad) : Il manque le nom. Le poste n'a pas été créé.");
  });
});
