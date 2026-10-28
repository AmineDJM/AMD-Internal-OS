import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { inspectZipFile } from "@/lib/regulatory/intelligence/ingest/zip-inspector";

/** Décompose la FINALISATION : réassemblage, décompression, stockage des fichiers, archive originale. */
async function main() {
  const z = new JSZip();
  for (let i = 0; i < 60; i++) z.file(`m3/annexe-${i}.pdf`, randomBytes(1024 * 1024));
  const zip = await z.generateAsync({ type: "nodebuffer" });
  const dir = await mkdtemp(join(tmpdir(), "bench-"));
  const zipPath = join(dir, "a.zip");

  // 1) Écriture du fichier temporaire + SHA-256 (ce que fait le réassemblage, sans la lecture DB)
  let t = Date.now();
  await new Promise<void>((res, rej) => {
    const ws = createWriteStream(zipPath); const h = createHash("sha256");
    ws.on("error", rej); h.update(zip); ws.end(zip, () => res());
  });
  console.log(`spool disque + SHA-256 : ${((Date.now() - t) / 1000).toFixed(1)} s`);

  // 2) Décompression SEULE (rappel vide) — coût CPU pur
  t = Date.now();
  await inspectZipFile(zipPath, { onStorableEntry: async () => {} });
  console.log(`décompression seule    : ${((Date.now() - t) / 1000).toFixed(1)} s`);

  // 3) Décompression + stockage des 60 fichiers (chemin réel, parallélisé)
  const ids: string[] = [];
  t = Date.now();
  await inspectZipFile(zipPath, { onStorableEntry: async (_e, d) => { ids.push((await putBlob(d)).blobId); } });
  console.log(`+ stockage fichiers    : ${((Date.now() - t) / 1000).toFixed(1)} s  (séquentiel, rappel direct)`);

  // 4) Archive ORIGINALE en un seul blob de 60 Mo
  t = Date.now();
  const ob = await putBlob(await readFile(zipPath));
  console.log(`archive originale 60Mo : ${((Date.now() - t) / 1000).toFixed(1)} s  ← un seul gros blob`);

  for (const id of [...ids, ob.blobId]) await releaseBlob(id).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}
void main();
