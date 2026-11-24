import { describe, it, expect, afterAll } from "vitest";
import JSZip from "jszip";
import { createHash, randomBytes } from "crypto";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_ZIP_LIMITS, inspectZip, inspectZipFile, PLAFOND_ENTREE_OCTETS, unsafePath } from "./zip-inspector";

async function makeZip(files: Record<string, Buffer | string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: "nodebuffer" });
}

const _tmpDirs: string[] = [];
/** Écrit un ZIP dans un fichier temporaire (pour tester le chemin STREAMING sur disque). */
async function makeZipFile(files: Record<string, Buffer | string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zip-inspect-test-"));
  _tmpDirs.push(dir);
  const path = join(dir, "archive.zip");
  await writeFile(path, await makeZip(files));
  return path;
}

/** Fait MENTIR la PREMIÈRE entrée de l'archive : sa taille décompressée annoncée (local + central) devient `n`. */
function mentirSurLaTaille(zip: Buffer, n: number): Buffer {
  const b = Buffer.from(zip);
  let local = false, central = false;
  for (let i = 0; i + 30 < b.length; i++) {
    if (!local && b.readUInt32LE(i) === 0x04034b50) { b.writeUInt32LE(n, i + 22); local = true; }
    if (!central && b.readUInt32LE(i) === 0x02014b50) { b.writeUInt32LE(n, i + 24); central = true; }
  }
  return b;
}

describe("F10 — une entrée se décompresse EN FLUX, au compteur RÉEL, 256 Mo au plus", () => {
  it("le plafond par entrée ne dépasse jamais 256 Mo (ni par défaut, ni par variable)", () => {
    expect(PLAFOND_ENTREE_OCTETS).toBe(256 * 1024 * 1024);
    expect(DEFAULT_ZIP_LIMITS.maxFileUncompressed).toBeLessThanOrEqual(PLAFOND_ENTREE_OCTETS);
  });
  it("une entrée qui ANNONCE 10 octets et en contient 2 Mo est coupée au plafond (inspectZip, en mémoire)", async () => {
    const z = new JSZip();
    z.file("menteur.bin", Buffer.alloc(2 * 1024 * 1024, 0x41));
    z.file("sain.pdf", Buffer.from("ok"));
    const buf = mentirSurLaTaille(await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), 10);
    const res = await inspectZip(buf, { maxFileUncompressed: 100 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.entries.find((e) => e.filename === "menteur.bin")?.securityStatus).toBe("BLOCKED_OVERSIZE");
    expect(res.entries.find((e) => e.filename === "sain.pdf")?.securityStatus).toBe("SAFE");
  });
  it("le compteur réel borne aussi le VOLUME TOTAL, malgré les tailles annoncées", async () => {
    const z = new JSZip();
    z.file("a.bin", Buffer.alloc(300 * 1024, 0x42));
    const buf = mentirSurLaTaille(await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), 10);
    const res = await inspectZip(buf, { maxTotalUncompressed: 100 * 1024, maxRatio: 1e9 });
    expect(res.rejection?.code).toBe("TOTAL_TOO_LARGE");
  });
});

describe("inspectZip — ingestion CTD sécurisée", () => {
  it("accepte une archive saine et calcule le SHA-256 exact", async () => {
    const content = Buffer.from("Rapport de stabilité — données");
    const buf = await makeZip({ "m3/3.2.p.8-stabilite.pdf": content, "m1/1.2-formulaire.docx": Buffer.from("form") });
    const res = await inspectZip(buf);
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(2);
    const stab = res.entries.find((e) => e.filename.startsWith("3.2.p.8"))!;
    expect(stab.securityStatus).toBe("SAFE");
    expect(stab.sha256).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("bloque le path traversal (vecteurs préservés par JSZip : absolu + backslash)", async () => {
    // NB : JSZip normalise `../a` → `a` à la génération/lecture ; on teste donc les
    // vecteurs qu'il PRÉSERVE et que notre garde doit intercepter (chemin absolu, backslash).
    const buf = await makeZip({ "/etc/passwd": Buffer.from("x"), "..\\..\\evil": Buffer.from("w"), "ok.pdf": Buffer.from("y") });
    const res = await inspectZip(buf);
    expect(res.ok).toBe(true);
    const blocked = res.entries.filter((e) => e.securityStatus === "BLOCKED_PATH");
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    // Le fichier sain reste SAFE et n'est pas emporté par le blocage.
    expect(res.entries.find((e) => e.filename === "ok.pdf")?.securityStatus).toBe("SAFE");
  });

  it("refuse les exécutables / scripts / macros (jamais matérialisés)", async () => {
    const buf = await makeZip({ "setup.exe": Buffer.from("MZ"), "macro.xlsm": Buffer.from("x"), "doc.pdf": Buffer.from("z") });
    const res = await inspectZip(buf);
    const exe = res.entries.find((e) => e.ext === "exe")!;
    const mac = res.entries.find((e) => e.ext === "xlsm")!;
    expect(exe.securityStatus).toBe("BLOCKED_EXECUTABLE");
    expect(mac.securityStatus).toBe("BLOCKED_EXECUTABLE");
    expect(exe.sha256).toBe("");
  });

  it("bloque une profondeur d'arborescence excessive", async () => {
    const buf = await makeZip({ "a/b/c/d/e/deep.pdf": Buffer.from("x") });
    const res = await inspectZip(buf, { maxDepth: 2 });
    expect(res.entries[0].securityStatus).toBe("BLOCKED_PATH");
  });

  it("rejette une archive avec trop de fichiers", async () => {
    const buf = await makeZip({ "a.pdf": "1", "b.pdf": "2", "c.pdf": "3", "d.pdf": "4" });
    const res = await inspectZip(buf, { maxEntries: 3 });
    expect(res.ok).toBe(false);
    expect(res.rejection?.code).toBe("TOO_MANY_FILES");
  });

  it("rejette une archive plus grande que la limite", async () => {
    const buf = await makeZip({ "a.pdf": Buffer.alloc(2000, 1) });
    const res = await inspectZip(buf, { maxArchiveBytes: 10 });
    expect(res.ok).toBe(false);
    expect(res.rejection?.code).toBe("ARCHIVE_TOO_LARGE");
  });

  it("rejette une archive vide", async () => {
    const buf = await makeZip({});
    const res = await inspectZip(buf);
    expect(res.ok).toBe(false);
    expect(res.rejection?.code).toBe("EMPTY");
  });

  it("rejette une ZIP bomb (volume total dépassé)", async () => {
    const buf = await makeZip({ "zeros.bin": Buffer.alloc(500 * 1024, 0) });
    const res = await inspectZip(buf, { maxTotalUncompressed: 100 * 1024 });
    expect(res.ok).toBe(false);
    expect(["TOTAL_TOO_LARGE", "RATIO_EXCEEDED"]).toContain(res.rejection?.code);
  });
});

describe("unsafePath — prédicat de sécurité pur (indépendant de JSZip)", () => {
  it("intercepte tous les vecteurs dangereux", () => {
    for (const p of [
      "../../etc/passwd",       // traversal relatif
      "a/b/../../../secret",    // traversal enfoui
      "/etc/passwd",            // absolu POSIX
      "..\\..\\windows\\system32", // backslash + traversal
      "dir\\file",              // backslash Windows
      "C:\\Users\\x",           // lecteur Windows
      "d:relatif",              // lecteur Windows (minuscule)
      "~/.ssh/id_rsa",          // home tilde
      "bon\0nul.pdf",           // octet nul
      "",                       // vide
    ]) {
      expect(unsafePath(p)).toBe(true);
    }
  });

  it("laisse passer les chemins CTD légitimes", () => {
    for (const p of [
      "m3/3.2.p.8-stabilite.pdf",
      "m1/1.2-formulaire.docx",
      "module 2/2.3 résumé qualité.pdf",
      "a.pdf",
    ]) {
      expect(unsafePath(p)).toBe(false);
    }
  });
});

describe("inspectZipFile — inspection EN FLUX (mémoire bornée), parité sécurité avec inspectZip", () => {
  afterAll(async () => {
    for (const d of _tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  });

  it("accepte une archive saine, calcule le SHA-256 exact et stocke chaque fichier UNE fois (flux)", async () => {
    const content = Buffer.from("Rapport de stabilité — données");
    const path = await makeZipFile({ "m3/3.2.p.8-stabilite.pdf": content, "m1/1.2-formulaire.docx": Buffer.from("form") });
    const stored: string[] = [];
    const res = await inspectZipFile(path, { onStorableEntry: async (e) => { stored.push(e.path); } });
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(2);
    const stab = res.entries.find((e) => e.filename.startsWith("3.2.p.8"))!;
    expect(stab.securityStatus).toBe("SAFE");
    expect(stab.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    // Le rappel de stockage inline est bien appelé pour chaque fichier sûr (une entrée à la fois).
    expect(stored.sort()).toEqual(["m1/1.2-formulaire.docx", "m3/3.2.p.8-stabilite.pdf"]);
  });

  it("bloque path traversal (absolu + backslash) SANS avorter l'archive, garde les fichiers sains", async () => {
    const path = await makeZipFile({ "/etc/passwd": Buffer.from("x"), "..\\..\\evil": Buffer.from("w"), "ok.pdf": Buffer.from("y") });
    const res = await inspectZipFile(path);
    expect(res.ok).toBe(true);
    expect(res.entries.filter((e) => e.securityStatus === "BLOCKED_PATH").length).toBeGreaterThanOrEqual(2);
    expect(res.entries.find((e) => e.filename === "ok.pdf")?.securityStatus).toBe("SAFE");
  });

  it("refuse les exécutables / macros et bloque la profondeur excessive", async () => {
    const exe = await makeZipFile({ "setup.exe": Buffer.from("MZ"), "macro.xlsm": Buffer.from("x"), "doc.pdf": Buffer.from("z") });
    const r1 = await inspectZipFile(exe);
    expect(r1.entries.find((e) => e.ext === "exe")?.securityStatus).toBe("BLOCKED_EXECUTABLE");
    expect(r1.entries.find((e) => e.ext === "xlsm")?.securityStatus).toBe("BLOCKED_EXECUTABLE");
    const deep = await makeZipFile({ "a/b/c/d/e/deep.pdf": Buffer.from("x") });
    expect((await inspectZipFile(deep, { maxDepth: 2 })).entries[0].securityStatus).toBe("BLOCKED_PATH");
  });

  it("rejette trop de fichiers, archive vide et ZIP bomb (volume/ratio)", async () => {
    const many = await makeZipFile({ "a.pdf": "1", "b.pdf": "2", "c.pdf": "3", "d.pdf": "4" });
    expect((await inspectZipFile(many, { maxEntries: 3 })).rejection?.code).toBe("TOO_MANY_FILES");
    const empty = await makeZipFile({});
    expect((await inspectZipFile(empty)).rejection?.code).toBe("EMPTY");
    const bomb = await makeZipFile({ "zeros.bin": Buffer.alloc(500 * 1024, 0) });
    expect(["TOTAL_TOO_LARGE", "RATIO_EXCEEDED"]).toContain((await inspectZipFile(bomb, { maxTotalUncompressed: 100 * 1024 })).rejection?.code);
  });

  it("marque BLOCKED_OVERSIZE un fichier au-delà du plafond par fichier (coupé en flux)", async () => {
    // Charge incompressible → le flux dépasse réellement le plafond avant d'être stocké.
    const path = await makeZipFile({ "big.bin": randomBytes(400 * 1024), "small.pdf": Buffer.from("ok") });
    const res = await inspectZipFile(path, { maxFileUncompressed: 100 * 1024 });
    expect(res.ok).toBe(true);
    expect(res.entries.find((e) => e.filename === "big.bin")?.securityStatus).toBe("BLOCKED_OVERSIZE");
    expect(res.entries.find((e) => e.filename === "small.pdf")?.securityStatus).toBe("SAFE");
  });

  it("un échec de STOCKAGE d'un fichier ne fait PAS tomber l'archive (marqué, les autres passent)", async () => {
    // Robustesse « niveau app mondiale » : un fichier qui pose problème est signalé avec sa raison,
    // les fichiers sains sont quand même ingérés (plus jamais « Échec de l'inspection de l'archive »).
    const path = await makeZipFile({ "ok1.pdf": "a", "boom.pdf": "b", "ok2.pdf": "c" });
    const res = await inspectZipFile(path, {
      onStorableEntry: async (e) => { if (e.filename === "boom.pdf") throw new Error("stockage indisponible"); },
    });
    expect(res.ok).toBe(true);
    expect(res.entries.find((e) => e.filename === "boom.pdf")?.securityStatus).toBe("CORRUPTED");
    expect(res.entries.find((e) => e.filename === "boom.pdf")?.note).toMatch(/stockage/i);
    expect(res.entries.find((e) => e.filename === "ok1.pdf")?.securityStatus).toBe("SAFE");
    expect(res.entries.find((e) => e.filename === "ok2.pdf")?.securityStatus).toBe("SAFE");
  });

  it("donne le MÊME manifeste que inspectZip (buffer) sur une archive réaliste — parité", async () => {
    const files = {
      "m1/1.0-lettre.txt": "DCI Amoxicilline",
      "m3/3.2.p.8-stab.xlsx": randomBytes(20 * 1024),
      "outils/run.exe": Buffer.from("MZ"),
      "/abs.pdf": Buffer.from("x"),
    };
    const buf = await makeZip(files);
    const path = await makeZipFile(files);
    const viaBuffer = await inspectZip(buf);
    const viaFile = await inspectZipFile(path);
    const norm = (r: typeof viaBuffer) =>
      r.entries.map((e) => ({ path: e.path, status: e.securityStatus, sha: e.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    expect(norm(viaFile)).toEqual(norm(viaBuffer));
  });
});
