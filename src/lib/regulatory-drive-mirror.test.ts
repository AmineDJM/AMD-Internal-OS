import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { mirrorToProductDrive, cleanPathSegments, mimeFromName, REG_DRIVE_ROOT } from "@/lib/regulatory-drive-mirror";

/**
 * Miroir Drive d'un dépôt Regulatory : l'ARBORESCENCE EXACTE (sous-dossiers imbriqués) est
 * recréée dans le Drive sous un dossier nommé d'après le produit ; re-déposer un même chemin
 * versionne au lieu de dupliquer ; le dossier produit est partagé (lecture) avec les parties prenantes.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__regmirror__";
let ownerId = "";
let stakeholderId = "";

suite("mirrorToProductDrive — arborescence, versionnage, partage", () => {
  beforeAll(async () => {
    ownerId = (await prisma.user.create({ data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "HEAD_OF_REGULATORY" } })).id;
    stakeholderId = (await prisma.user.create({ data: { name: `${TAG}s`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } })).id;
  });
  afterAll(async () => {
    await retirerNoeudsDriveEtContenu({ where: { OR: [{ ownerId }, { createdById: ownerId }] } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("recrée l'arborescence exacte sous un dossier nommé d'après le produit", async () => {
    const r = await mirrorToProductDrive({
      productName: "REF-1 — Amoxicilline",
      ownerId,
      entries: [
        { path: "Module 1/1.2/form.pdf", data: Buffer.from("A") },
        { path: "Module 1/cover.txt", data: Buffer.from("B") },
        { path: "Module 3/3.2.P/spec.txt", data: Buffer.from("C") },
      ],
      shareUserIds: [stakeholderId],
    });
    expect(r.created).toBe(3);

    const product = await prisma.driveNode.findUnique({ where: { id: r.productFolderId }, select: { name: true, type: true, parent: { select: { name: true } } } });
    expect(product?.type).toBe("FOLDER");
    expect(product?.name).toBe("REF-1 — Amoxicilline");
    expect(product?.parent?.name).toBe(REG_DRIVE_ROOT); // sous la racine « Regulatory — Dossiers produits »

    const m1 = await prisma.driveNode.findFirst({ where: { name: "Module 1", parentId: r.productFolderId, type: "FOLDER" }, select: { id: true } });
    expect(m1).toBeTruthy();
    const s12 = await prisma.driveNode.findFirst({ where: { name: "1.2", parentId: m1!.id, type: "FOLDER" }, select: { id: true } });
    expect(s12).toBeTruthy();
    const form = await prisma.driveNode.findFirst({ where: { name: "form.pdf", parentId: s12!.id, type: "FILE" }, select: { mimeType: true } });
    expect(form?.mimeType).toBe("application/pdf"); // MIME déduit du nom
    // « cover.txt » est bien DIRECTEMENT sous « Module 1 » (pas dans 1.2).
    expect(await prisma.driveNode.findFirst({ where: { name: "cover.txt", parentId: m1!.id, type: "FILE" }, select: { id: true } })).toBeTruthy();

    // Partage lecture du dossier produit avec la partie prenante (accès hérité par tout l'arbre).
    const share = await prisma.driveShare.findFirst({ where: { nodeId: r.productFolderId, userId: stakeholderId }, select: { access: true } });
    expect(share?.access).toBe("VIEW");
  });

  it("re-déposer le même chemin → nouvelle version, pas de doublon", async () => {
    await mirrorToProductDrive({ productName: "REF-2 — Test", ownerId, entries: [{ path: "a/x.txt", data: Buffer.from("1") }] });
    const r2 = await mirrorToProductDrive({ productName: "REF-2 — Test", ownerId, entries: [{ path: "a/x.txt", data: Buffer.from("2") }] });
    expect(r2.created).toBe(0);
    expect(r2.updated).toBe(1);

    const files = await prisma.driveNode.findMany({ where: { ownerId, name: "x.txt", type: "FILE" }, select: { id: true } });
    expect(files).toHaveLength(1); // un seul nœud
    expect(await prisma.fileVersion.count({ where: { nodeId: files[0].id } })).toBe(2); // deux versions
  });

  it("helpers purs : nettoyage de chemin + MIME par nom", () => {
    expect(cleanPathSegments("a\\b/../c/./d.txt")).toEqual(["a", "b", "c", "d.txt"]);
    expect(cleanPathSegments("/leading//double/")).toEqual(["leading", "double"]);
    expect(mimeFromName("Rapport.DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFromName("photo.png")).toBe("image/png");
    expect(mimeFromName("noext")).toBe("application/octet-stream");
  });
});
