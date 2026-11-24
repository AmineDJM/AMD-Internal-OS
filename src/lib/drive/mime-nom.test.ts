import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mimeFromName, nomPourCle, typeDeDepot } from "./mime-nom";

/**
 * AUDIT DRIVE F1 / F6 — ce qu'un dépôt ENREGISTRE : le type (jamais une déclaration mal formée) et le nom
 * qui entre dans une clé de stockage (jamais un chemin).
 */

describe("typeDeDepot — le type déclaré par le navigateur n'est qu'une déclaration (F1)", () => {
  it("garde un type bien formé, en minuscules, sans ses paramètres", () => {
    expect(typeDeDepot("note.pdf", "application/pdf")).toBe("application/pdf");
    expect(typeDeDepot("vocal", "Audio/WebM;codecs=opus", "audio/webm")).toBe("audio/webm");
    expect(typeDeDepot("x.bin", "TEXT/HTML ;x")).toBe("text/html");
  });
  it("un type mal formé ou absent cède la place au type tiré du NOM", () => {
    expect(typeDeDepot("rapport.pdf", "text/plain,text/html")).toBe("application/pdf");
    expect(typeDeDepot("photo.PNG", "image/png text/html")).toBe("image/png");
    expect(typeDeDepot("page.html", "")).toBe("application/octet-stream");
    expect(typeDeDepot("x.docx", null)).toBe(mimeFromName("x.docx"));
  });
  it("le repli ne sert que si le nom ne dit rien", () => {
    expect(typeDeDepot("vocal", "", "audio/webm")).toBe("audio/webm");
    expect(typeDeDepot("vocal.mp3", "", "audio/webm")).toBe("audio/mpeg");
  });
});

describe("nomPourCle — un nom de fichier n'entre jamais dans une clé comme un chemin (F6)", () => {
  it("garde le dernier segment, `/` comme `\\`", () => {
    expect(nomPourCle("../../etc/passwd")).toBe("passwd");
    expect(nomPourCle("C:\\Users\\x\\facture.pdf")).toBe("facture.pdf");
  });
  it("retire les caractères de contrôle et les `..`", () => {
    expect(nomPourCle("fac\u0000ture\n.pdf")).toBe("facture.pdf");
    expect(nomPourCle("a..pdf")).toBe("a.pdf");
    expect(nomPourCle("..")).toBe("fichier");
    expect(nomPourCle("")).toBe("fichier");
    expect(nomPourCle("../")).toBe("fichier");
  });
  it("laisse intact un nom ordinaire (accents, espaces)", () => {
    expect(nomPourCle("Contrat signé 2026.pdf")).toBe("Contrat signé 2026.pdf");
  });
});

describe("cliquet — aucun dépôt n'enregistre le type du navigateur tel quel", () => {
  function fichiers(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? fichiers(p) : /\.ts$/.test(p) && !p.endsWith(".test.ts") ? [p] : [];
    });
  }
  it("`file.type ||` ne se lit côté serveur que pour la transcription (jamais enregistré)", () => {
    const racine = process.cwd();
    const fautifs = ["src/app/api", "src/lib", "src/modules"].flatMap((d) => fichiers(join(racine, d)))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => ({ f: f.slice(racine.length + 1), i: i + 1, l })))
      // Exceptions : la transcription (rien n'est enregistré) et un `new File(…)` repassé à un dépôt qui normalise lui-même.
      .filter(({ l }) => /\b(file|f|fichier)\.type\s*\|\|/.test(l) && !/transcribeAudio\(|new File\(/.test(l));
    expect(fautifs.map(({ f, i }) => `${f}:${i}`), "passer par `typeDeDepot(nom, type)` (lib/drive/mime-nom.ts)").toEqual([]);
  });
  it("aucune clé de stockage n'est bâtie avec un nom brut (`__${file.name}`)", () => {
    const racine = process.cwd();
    const fautifs = ["src/app/api", "src/lib", "src/modules"].flatMap((d) => fichiers(join(racine, d)))
      .filter((f) => /__\$\{(file\.name|f\.nom|name)\}/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(racine.length + 1))
      // L'enregistrement OnlyOffice d'un Document (lot « versions ») ; la lecture disque est confinée (`cheminDeRepli`).
      .filter((f) => f !== "src/app/api/onlyoffice/callback/route.ts");
    expect(fautifs, "passer par `nomPourCle` (lib/drive/mime-nom.ts)").toEqual([]);
  });
});
