import { describe, it, expect } from "vitest";
import {
  MAX_ATTACHMENTS, driveRefLabel, driveRefHref, recipientsToGrant, shareWarning,
  folderZipName, rootFolderName,
  DOSSIER_MESSAGERIE, nomDossierConversation, nomLotMessagerie, piecesDuLot, libelleLot,
  estImageAffichable, ouverturePiece, urlContenuPiece, redirectionReferenceDrive, imagesDuMessage,
  type PieceOuvrable,
} from "./messaging-attachments";

describe("driveRefLabel — dire que ce n'est pas une copie", () => {
  it("marque un fichier comme venant du Drive", () => {
    expect(driveRefLabel("Contrat cadre.docx", false)).toBe("Contrat cadre.docx — Drive");
  });

  it("annonce un dossier comme un dossier", () => {
    expect(driveRefLabel("Contrats 2026", true)).toBe("Dossier « Contrats 2026 » — Drive");
  });
});

describe("driveRefHref — où mène le clic", () => {
  it("ouvre un fichier", () => {
    expect(driveRefHref("n1", false)).toBe("/drive/n1");
  });

  it("navigue dans un dossier", () => {
    expect(driveRefHref("n1", true)).toBe("/drive?folder=n1");
  });
});

describe("recipientsToGrant — qui reçoit un accès", () => {
  it("accorde aux autres membres de la conversation", () => {
    expect(recipientsToGrant(["a", "b", "c"], { senderId: "a" }).sort()).toEqual(["b", "c"]);
  });

  it("n'accorde jamais rien à l'expéditeur — il a déjà accès", () => {
    expect(recipientsToGrant(["a"], { senderId: "a" })).toEqual([]);
  });

  it("saute le propriétaire du nœud", () => {
    expect(recipientsToGrant(["a", "b", "c"], { senderId: "a", ownerId: "b" })).toEqual(["c"]);
  });

  it("saute qui a DÉJÀ un partage — un VIEW par-dessus un EDIT serait une régression de droit", () => {
    expect(recipientsToGrant(["a", "b", "c"], { senderId: "a", alreadyShared: ["b"] })).toEqual(["c"]);
  });

  it("dédoublonne une liste de membres qui répéterait quelqu'un", () => {
    expect(recipientsToGrant(["b", "b", "c"], { senderId: "a" }).sort()).toEqual(["b", "c"]);
  });

  it("ignore les identifiants vides", () => {
    expect(recipientsToGrant(["", "b"], { senderId: "a" })).toEqual(["b"]);
  });

  it("rend une liste vide quand il n'y a personne d'autre", () => {
    expect(recipientsToGrant([], { senderId: "a" })).toEqual([]);
  });
});

describe("shareWarning — ce qu'on lit AVANT d'envoyer", () => {
  it("accorde le singulier", () => {
    expect(shareWarning(1)).toContain("Le destinataire recevra un accès en lecture");
  });

  it("compte les destinataires au pluriel", () => {
    expect(shareWarning(4)).toContain("Les 4 destinataires");
  });

  it("dit clairement qu'il n'y a rien à ouvrir", () => {
    expect(shareWarning(0)).toBe("Aucun accès supplémentaire ne sera accordé.");
  });
});

describe("folderZipName", () => {
  it("nomme l'archive comme le dossier", () => {
    expect(folderZipName("Contrats 2026")).toBe("Contrats 2026.zip");
  });

  it("remplace les caractères qu'un système de fichiers refuse", () => {
    expect(folderZipName("Contrats/2026:final")).toBe("Contrats-2026-final.zip");
  });

  it("n'empile pas deux extensions", () => {
    expect(folderZipName("Archive.zip")).toBe("Archive.zip");
  });

  it("retombe sur un nom neutre plutôt que sur « .zip » seul", () => {
    expect(folderZipName("   ")).toBe("Dossier.zip");
    expect(folderZipName("///")).toBe("Dossier.zip");
  });
});

describe("rootFolderName — le seul indice du dossier choisi", () => {
  it("prend le premier segment du chemin relatif", () => {
    expect(rootFolderName(["Contrats/2026/bail.pdf", "Contrats/note.docx"])).toBe("Contrats");
  });

  it("saute un chemin vide plutôt que de rendre une chaîne vide", () => {
    expect(rootFolderName(["", "Contrats/note.docx"])).toBe("Contrats");
  });

  it("rend null quand rien n'est exploitable", () => {
    expect(rootFolderName([])).toBeNull();
    expect(rootFolderName(["", ""])).toBeNull();
  });
});

describe("MAX_ATTACHMENTS", () => {
  it("borne le nombre de pièces d'un message", () => {
    expect(MAX_ATTACHMENTS).toBe(10);
  });
});

describe("gros envois de la messagerie — par le chemin du Drive (Direction, 06/10)", () => {
  it("range les envois sous « Messagerie / <conversation> »", () => {
    expect(DOSSIER_MESSAGERIE).toBe("Messagerie");
    expect(nomDossierConversation("Équipe RA / 2026")).toBe("Équipe RA - 2026");
    expect(nomDossierConversation(null)).toBe("Conversation");
    expect(nomDossierConversation("  ///  ")).toBe("Conversation");
  });

  it("date le dossier d'un envoi à la seconde, à l'heure d'Alger", () => {
    // 23:30:05 UTC = 00:30:05 le lendemain à Alger (UTC+1) — et jamais « 24h ».
    expect(nomLotMessagerie(new Date("2026-10-06T23:30:05Z"))).toBe("Envoi du 2026-10-07 à 00h30m05");
  });

  it("joint les éléments un par un s'ils tiennent, sinon le dossier du lot", () => {
    expect(piecesDuLot(0, 10)).toBe("rien");
    expect(piecesDuLot(3, 10)).toBe("elements");
    expect(piecesDuLot(10, 10)).toBe("elements");
    expect(piecesDuLot(11, 10)).toBe("dossier");
    expect(piecesDuLot(2, 1)).toBe("dossier");
    expect(piecesDuLot(1, 0)).toBe("dossier");
  });

  it("n'autorise l'envoi du message qu'une fois le lot arrivé", () => {
    const base = { total: 4, recus: 2, echecs: 0, annules: 0, enCours: true };
    expect(libelleLot(base)).toEqual({ texte: "Envoi 2/4…", pret: false });
    expect(libelleLot({ ...base, recus: 4, enCours: false })).toEqual({ texte: "4 fichiers prêts", pret: true });
    expect(libelleLot({ ...base, recus: 3, echecs: 1, enCours: false })).toEqual({ texte: "3 fichiers prêts · 1 non envoyé", pret: true });
    expect(libelleLot({ ...base, recus: 0, echecs: 4, enCours: false }).pret).toBe(false);
    expect(libelleLot({ ...base, recus: 0, annules: 4, enCours: false }).texte).toBe("Envoi annulé");
  });
});

// ─────────────────────────── Ouvrir une pièce sans quitter la conversation ───────────────────────────

const piece = (p: Partial<PieceOuvrable> & { name: string }): PieceOuvrable => ({
  id: "a1", mime: "", driveNodeId: null, isFolder: false, ...p,
});

describe("estImageAffichable — ce que le navigateur sait montrer", () => {
  it("reconnaît les images par extension, quelle que soit la casse", () => {
    for (const nom of ["Capture PJ.png", "photo.JPG", "x.jpeg", "anim.gif", "y.webp", "logo.svg", "z.avif", "b.bmp"]) {
      expect(estImageAffichable(nom, ""), nom).toBe(true);
    }
  });

  it("reconnaît une image par son type MIME quand le nom n'a pas d'extension", () => {
    expect(estImageAffichable("Capture", "image/png")).toBe(true);
    expect(estImageAffichable("Capture", "image/svg+xml")).toBe(true);
  });

  it("l'extension prime : un .pdf déclaré image/* n'est pas une image", () => {
    expect(estImageAffichable("note.pdf", "image/png")).toBe(false);
  });

  it("écarte les images que <img> ne montre pas (TIFF, HEIC…)", () => {
    expect(estImageAffichable("scan.tiff", "image/tiff")).toBe(false);
    expect(estImageAffichable("IMG_0001.HEIC", "image/heic")).toBe(false);
    expect(estImageAffichable("IMG_0001", "image/heic")).toBe(false);
  });

  it("un document n'est pas une image", () => {
    expect(estImageAffichable("contrat.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(estImageAffichable("sans-nom", "")).toBe(false);
    expect(estImageAffichable("sans-nom", null)).toBe(false);
  });
});

describe("ouverturePiece — comment s'ouvre une pièce au clic", () => {
  it("une image → la visionneuse (téléversée OU référencée au Drive)", () => {
    expect(ouverturePiece(piece({ name: "Capture PJ.png" }))).toBe("image");
    expect(ouverturePiece(piece({ name: "Capture PJ.png", driveNodeId: "n1" }))).toBe("image");
  });

  it("PDF, bureautique, texte, vidéo → l'aperçu universel en surimpression", () => {
    for (const name of ["a.pdf", "b.docx", "c.xlsx", "d.pptx", "e.doc", "f.csv", "g.txt", "h.mp4"]) {
      expect(ouverturePiece(piece({ name })), name).toBe("apercu");
    }
  });

  it("une archive ou un binaire → téléchargement", () => {
    expect(ouverturePiece(piece({ name: "lot.zip" }))).toBe("telechargement");
    expect(ouverturePiece(piece({ name: "setup.exe", mime: "application/octet-stream" }))).toBe("telechargement");
  });

  it("un dossier se navigue, même nommé comme une image", () => {
    expect(ouverturePiece(piece({ name: "Photos.png", isFolder: true, driveNodeId: "n1" }))).toBe("dossier");
  });
});

describe("urlContenuPiece — toujours par la porte de la messagerie", () => {
  it("un fichier téléversé : la route de la pièce", () => {
    expect(urlContenuPiece({ id: "a1", driveNodeId: null })).toBe("/api/messaging/attachment/a1");
    expect(urlContenuPiece({ id: "a1", driveNodeId: null }, { telecharger: true })).toBe("/api/messaging/attachment/a1?dl=1");
  });

  it("une référence au Drive : la MÊME route (participation vérifiée), jamais l'adresse du Drive en dur", () => {
    const url = urlContenuPiece({ id: "a1", driveNodeId: "n1" });
    expect(url).toBe("/api/messaging/attachment/a1?contenu=1");
    expect(url).not.toContain("n1");
    expect(urlContenuPiece({ id: "a1", driveNodeId: "n1" }, { telecharger: true })).toBe("/api/messaging/attachment/a1?contenu=1&dl=1");
  });
});

describe("redirectionReferenceDrive — après la porte de la messagerie, celle du Drive", () => {
  it("sans « contenu » : la page du Drive, comme avant", () => {
    expect(redirectionReferenceDrive("n1", false)).toBe("/drive/n1");
    expect(redirectionReferenceDrive("n1", true, { contenu: true })).toBe("/drive?folder=n1");
  });

  it("avec « contenu » : les octets, par la route du Drive qui revérifie la lecture", () => {
    expect(redirectionReferenceDrive("n1", false, { contenu: true })).toBe("/api/drive/n1/raw");
    expect(redirectionReferenceDrive("n1", false, { contenu: true, telecharger: true })).toBe("/api/drive/n1/raw?dl=1");
  });
});

describe("imagesDuMessage — ce que ←/→ parcourent dans la visionneuse", () => {
  it("garde les images du message, dans l'ordre, sans les documents ni les dossiers", () => {
    const pieces = [
      piece({ id: "1", name: "a.png" }), piece({ id: "2", name: "b.pdf" }),
      piece({ id: "3", name: "c.jpg", driveNodeId: "n" }), piece({ id: "4", name: "d.png", isFolder: true, driveNodeId: "m" }),
    ];
    expect(imagesDuMessage(pieces).map((p) => p.id)).toEqual(["1", "3"]);
  });
});
