import { describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import JSZip from "jszip";
import { crc32, ecrireZip, enFluxWeb, ErreurZipLimite, LIMITE_ZIP_OCTETS, zipUneEntree, type EntreeZip } from "./zip-ecriture";
import { listerZip, lireEntreeZip, sourceTampon } from "@/lib/storage/zip-lecteur";

/**
 * L'ÉCRIVAIN DE ZIP EN FLUX. Trois lecteurs INDÉPENDANTS le jugent — JSZip (avec contrôle des CRC),
 * notre lecteur par plages, et le `zipfile` de Python : un écrivain jugé par son propre lecteur
 * ne prouverait que sa cohérence avec lui-même.
 */

const collecter = async (it: AsyncIterable<Buffer>): Promise<Buffer> => { const m: Buffer[] = []; for await (const b of it) m.push(b); return Buffer.concat(m); };
const texte = (n: number, graine = "") => Buffer.from(Array.from({ length: n }, (_, i) => `ligne ${graine} ${i} lot L${i % 977} résultat ${(Math.sin(i) * 100).toFixed(3)}`).join("\n"));

/**
 * Le premier interpréteur qui RÉPOND. Sous Windows, `python3` est souvent l'alias du Microsoft Store,
 * qui échoue sans rien exécuter : on passe alors à `python` puis au lanceur `py -3`. Aucun ne répond →
 * on retombe sur `python3`, et le test échoue comme avant — le troisième lecteur n'est jamais sauté.
 */
const PYTHON: [string, string[]] = (() => {
  const candidats: [string, string[]][] = [["python3", []], ["python", []], ["py", ["-3"]]];
  for (const [bin, pre] of candidats) {
    try {
      if (execFileSync(bin, [...pre, "-c", "import sys; print(sys.version_info[0])"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "3") return [bin, pre];
    } catch { /* candidat suivant */ }
  }
  return ["python3", []];
})();

function testerAvecPython(archive: Buffer): string {
  const f = path.join(os.tmpdir(), `amd-zip-${crypto.randomBytes(6).toString("hex")}.zip`);
  fs.writeFileSync(f, archive);
  try {
    return execFileSync(PYTHON[0], [...PYTHON[1], "-c","import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); r=z.testzip(); print('OK' if r is None else 'MAUVAIS:'+r, len(z.namelist()))", f]).toString().trim();
  } finally { fs.rmSync(f, { force: true }); }
}

describe("crc32", () => {
  it("retombe sur la valeur connue de « 123456789 » (0xCBF43926), en un bloc comme en deux", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
  });
});

describe("ecrireZip — qualité maximale (stocké) : chaque fichier, octet pour octet", () => {
  it("les trois lecteurs relisent les mêmes octets, noms accentués et dossiers compris", async () => {
    const entrees: EntreeZip[] = [
      { chemin: "Module 1/lettre.txt", contenu: texte(2000, "a") },
      { chemin: "Module 3/données-é.csv", contenu: texte(5000, "b") },
      { chemin: "vide.bin", contenu: Buffer.alloc(0) },
      { chemin: "photo.jpg", contenu: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(50_000)]) },
    ];
    const zip = await collecter(ecrireZip(entrees, "stocke"));
    // 1. JSZip, avec contrôle de CRC
    const js = await JSZip.loadAsync(zip, { checkCRC32: true });
    for (const e of entrees) expect(Buffer.from(await js.files[e.chemin].async("nodebuffer")).equals(e.contenu as Buffer), e.chemin).toBe(true);
    // 2. notre lecteur par plages
    const src = sourceTampon(zip);
    const { entrees: lues } = await listerZip(src);
    expect(lues.map((l) => l.chemin).sort()).toEqual(entrees.map((e) => e.chemin).sort());
    for (const l of lues.filter((x) => !x.dossier)) {
      expect(l.methode, l.chemin).toBe(0); // STOCKÉ : aucune compression en qualité maximale
      expect((await lireEntreeZip(src, l)).equals(entrees.find((e) => e.chemin === l.chemin)!.contenu as Buffer), l.chemin).toBe(true);
    }
    // 3. Python
    expect(testerAvecPython(zip)).toBe("OK 4");
    // Stocké : la taille de l'archive est la somme des fichiers + des en-têtes (jamais moins).
    const somme = entrees.reduce((s, e) => s + (e.contenu as Buffer).length, 0);
    expect(zip.length).toBeGreaterThan(somme);
    expect(zip.length).toBeLessThan(somme + 1000);
  });
});

describe("ecrireZip — taille réduite (deflate 9) : jamais de gonflement", () => {
  it("le texte rétrécit, ce qui est déjà compressé ou aléatoire est STOCKÉ tel quel, et tout se relit", async () => {
    const csv = texte(20_000, "c");
    const aleatoire = Buffer.concat([Buffer.from("PAS-UN-FORMAT"), crypto.randomBytes(80_000)]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(80_000)]);
    const zip = await collecter(ecrireZip([
      { chemin: "a.csv", contenu: csv }, { chemin: "b.dat", contenu: aleatoire }, { chemin: "c.jpg", contenu: jpeg },
    ], "max"));
    const { entrees } = await listerZip(sourceTampon(zip));
    const par = Object.fromEntries(entrees.map((e) => [e.chemin, e]));
    expect(par["a.csv"].methode).toBe(8);
    expect(par["a.csv"].tailleCompressee).toBeLessThan(csv.length * 0.35);
    expect(par["b.dat"].methode, "aléatoire : le deflate gonflerait, on stocke").toBe(0);
    expect(par["b.dat"].tailleCompressee).toBe(aleatoire.length);
    expect(par["c.jpg"].methode, "déjà compressé : stocké").toBe(0);
    const js = await JSZip.loadAsync(zip, { checkCRC32: true });
    expect(Buffer.from(await js.files["a.csv"].async("nodebuffer")).equals(csv)).toBe(true);
    expect(Buffer.from(await js.files["b.dat"].async("nodebuffer")).equals(aleatoire)).toBe(true);
    expect(testerAvecPython(zip)).toBe("OK 3");
    // L'archive réduite est plus petite que l'archive maximale du même contenu.
    const max = await collecter(ecrireZip([{ chemin: "a.csv", contenu: csv }, { chemin: "b.dat", contenu: aleatoire }, { chemin: "c.jpg", contenu: jpeg }], "stocke"));
    expect(zip.length).toBeLessThan(max.length * 0.7);
  });

  it("`zipUneEntree` : une entrée, relue", async () => {
    const csv = texte(3000, "d");
    const z = await zipUneEntree("rapport.csv", csv);
    const js = await JSZip.loadAsync(z, { checkCRC32: true });
    expect(Buffer.from(await js.files["rapport.csv"].async("nodebuffer")).equals(csv)).toBe(true);
  });
});

describe("ecrireZip — entrées en flux (objet volumineux)", () => {
  it("une entrée annoncée de N octets, lue en flux, s'écrit avec son descripteur et se relit ; une taille fausse ABANDONNE l'archive", async () => {
    const gros = crypto.randomBytes(3_000_000);
    async function* morceaux(b: Buffer) { for (let o = 0; o < b.length; o += 64 * 1024) yield b.subarray(o, o + 64 * 1024); }
    const zip = await collecter(ecrireZip([
      { chemin: "avant.txt", contenu: texte(100, "e") },
      { chemin: "dossier/gros.bin", contenu: { flux: morceaux(gros), taille: gros.length } },
      { chemin: "apres.txt", contenu: texte(100, "f") },
    ], "stocke"));
    const js = await JSZip.loadAsync(zip, { checkCRC32: true });
    expect(Buffer.from(await js.files["dossier/gros.bin"].async("nodebuffer")).equals(gros)).toBe(true);
    expect(testerAvecPython(zip)).toBe("OK 3");
    await expect(collecter(ecrireZip([{ chemin: "x", contenu: { flux: morceaux(gros), taille: gros.length + 10 } }], "stocke"))).rejects.toThrow(/taille lue/);
  });
});

describe("ecrireZip — limites dites, jamais d'archive tronquée", () => {
  it("une entrée annoncée à 4 Go ou plus est REFUSÉE (pas de Zip64) ; la limite totale est un chiffre", async () => {
    await expect(collecter(ecrireZip([{ chemin: "x", contenu: { flux: (async function* () { /* jamais lu */ })(), taille: 4 * 1024 ** 3 } }], "stocke"))).rejects.toBeInstanceOf(ErreurZipLimite);
    expect(LIMITE_ZIP_OCTETS).toBeLessThan(4 * 1024 ** 3);
  });

  it("les chemins dangereux sont assainis (jamais de « .. » ni de chemin absolu)", async () => {
    const zip = await collecter(ecrireZip([{ chemin: "../../etc/passwd", contenu: Buffer.from("x") }, { chemin: "/abs/f.txt", contenu: Buffer.from("y") }], "stocke"));
    const { entrees } = await listerZip(sourceTampon(zip));
    expect(entrees.map((e) => e.chemin)).toEqual(["etc/passwd", "abs/f.txt"]);
  });
});

describe("mémoire bornée : une archive de plusieurs dizaines de Mo se produit entrée par entrée", () => {
  it("60 entrées de 2 Mo (≈ 120 Mo) : la mémoire vivante ne suit pas la taille de l'archive", async () => {
    const entrees = (async function* (): AsyncGenerator<EntreeZip> {
      for (let i = 0; i < 60; i++) yield { chemin: `f${i}.csv`, contenu: texte(40_000, `m${i}`) };
    })();
    global.gc?.();
    const base = process.memoryUsage().arrayBuffers;
    let pic = base; let total = 0;
    for await (const b of ecrireZip(entrees, "max")) { total += b.length; pic = Math.max(pic, process.memoryUsage().arrayBuffers); }
    // Les fichiers font ~2 Mo chacun ; l'archive réduite pèse bien moins que leur somme, et le pic reste de l'ordre d'une entrée.
    expect(total).toBeGreaterThan(1_000_000);
    expect(pic - base, `pic +${Math.round((pic - base) / 1048576)} Mo`).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);

  it("`enFluxWeb` propage une erreur de la source au lecteur (le téléchargement ÉCHOUE, il n'est pas tronqué en silence)", async () => {
    async function* casse(): AsyncGenerator<Buffer> { yield Buffer.from("début"); throw new Error("blob illisible"); }
    const lecteur = enFluxWeb(casse()).getReader();
    expect((await lecteur.read()).done).toBe(false);
    await expect(lecteur.read()).rejects.toThrow("blob illisible");
  });
});
