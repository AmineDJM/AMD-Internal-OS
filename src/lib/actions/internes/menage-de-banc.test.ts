import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { saveFile } from "@/lib/storage";
import { putBlob } from "@/lib/drive-storage";
import { retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "./menage-de-banc";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MÉNAGE DE BANC RETIRE LE CONTENU — et seulement celui que le banc était le dernier à tenir.
 *
 * Un `deleteMany` de documents ou de nœuds Drive laissait la clé de stockage, la pièce du registre et le blob : la base
 * de tests grossissait de plus d'un millier de blobs par passage (voir l'en-tête de `menage-de-banc.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__menage__${Date.now().toString(36)}`;
/** Un contenu à soi : une empreinte qu'aucun autre banc ne dépose (le stockage est dédoublonné par empreinte). */
const contenu = () => Buffer.from(`${TAG}-${crypto.randomUUID()}`);
const document = (fileKey: string) => prisma.document.create({
  data: { name: `${TAG}.pdf`, entityType: "TASK", entityId: TAG, fileKey, mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
  select: { id: true },
});
const blobExiste = async (id: string) => (await prisma.fileBlob.count({ where: { id } })) === 1;

suite("le ménage de banc rend le stockage", () => {
  afterAll(async () => {
    await prisma.document.deleteMany({ where: { entityId: TAG } }).catch(() => {});
    await prisma.storedFile.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  });

  it("un document retiré emporte sa clé de stockage et son blob", async () => {
    const cle = `${TAG}/seul.pdf`;
    const { blobId } = await saveFile(cle, contenu());
    await document(cle);
    expect(await retirerDocumentsEtContenu({ where: { entityId: TAG, fileKey: cle } })).toEqual({ count: 1 });
    expect(await prisma.storedFile.count({ where: { key: cle } }), "la clé de stockage est restée").toBe(0);
    expect(await blobExiste(blobId), "le blob est resté").toBe(false);
  });

  it("une clé qu'un AUTRE document tient encore reste, avec son blob", async () => {
    const cle = `${TAG}/partagee.pdf`;
    const { blobId } = await saveFile(cle, contenu());
    const a = await document(cle);
    await document(cle);
    expect(await retirerDocumentsEtContenu({ where: { id: a.id } })).toEqual({ count: 1 });
    expect(await prisma.storedFile.count({ where: { key: cle } })).toBe(1);
    expect(await blobExiste(blobId)).toBe(true);
  });

  it("un dossier Drive retiré emporte son sous-arbre et les blobs de ses versions ; un blob qu'un autre nœud tient reste", async () => {
    const dossier = await prisma.driveNode.create({ data: { name: `${TAG} dossier`, type: "FOLDER" }, select: { id: true } });
    const fichier = async (parentId: string | null, b: { blobId: string; size: number }, n: string) => {
      const f = await prisma.driveNode.create({ data: { name: `${TAG} ${n}`, type: "FILE", parentId }, select: { id: true } });
      await prisma.fileVersion.create({ data: { nodeId: f.id, blobId: b.blobId, version: 1, size: b.size } });
      return f.id;
    };
    const seul = await putBlob(contenu());
    const partage = await putBlob(contenu());
    await fichier(dossier.id, seul, "a");
    await fichier(dossier.id, partage, "b");
    const ailleurs = await fichier(null, partage, "ailleurs");
    expect(await retirerNoeudsDriveEtContenu({ where: { id: dossier.id } })).toEqual({ count: 1 });
    expect(await prisma.driveNode.count({ where: { name: { startsWith: `${TAG} ` }, NOT: { id: ailleurs } } }), "le sous-arbre est resté").toBe(0);
    expect(await blobExiste(seul.blobId), "le blob du seul fichier du dossier est resté").toBe(false);
    expect(await blobExiste(partage.blobId), "un blob qu'un nœud hors du dossier tient doit rester").toBe(true);
    await retirerNoeudsDriveEtContenu({ where: { id: ailleurs } });
    expect(await blobExiste(partage.blobId)).toBe(false);
  });
});
