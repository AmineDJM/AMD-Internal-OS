import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LA ROUTE QUI SERT LE FICHIER AU DOCUMENT SERVER NE L'EXÉCUTE JAMAIS DANS L'ERP (audit sécurité 27/10, SECURITE-ACCES-01).
 *
 * Le jeton de lecture est remis au NAVIGATEUR dans la configuration de l'éditeur (`document.url`). Le type
 * enregistré est celui que le navigateur de l'auteur a déclaré au dépôt. Servi en ligne, un `rapport.docx`
 * déposé comme `text/html` s'ouvrait donc comme une page de l'ERP — avec la session de qui suivait le lien.
 * La route sert désormais toujours en pièce jointe, et un type actif part sous bac à sable.
 */

process.env.ONLYOFFICE_URL = "https://office.test";
process.env.ONLYOFFICE_JWT_SECRET = "secret-de-test-onlyoffice";

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveFile } from "@/lib/storage";
import { makeDocReadToken } from "@/lib/onlyoffice";
import { GET } from "./route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__oofile__${Date.now()}`;
let userId = "";
let docId = "";
const cle = `TEST/${TAG}/rapport`;

suite("OnlyOffice /file — un type actif déclaré au dépôt ne s'exécute pas", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}u`, email: `${TAG}u@t.dz`, passwordHash: "x", role: "VIEWER" } });
    userId = u.id;
    await saveFile(cle, Buffer.from("<script>alert(document.cookie)</script>"));
    docId = (await prisma.document.create({
      data: { name: "rapport.docx", entityType: "TASK", entityId: TAG, fileKey: cle, sizeBytes: 40, mimeType: "text/html", uploadedById: u.id },
    })).id;
  }, 60_000);

  afterAll(async () => {
    const stored = await prisma.storedFile.findMany({ where: { key: cle }, select: { blobId: true } });
    await prisma.document.deleteMany({ where: { id: docId } }).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { key: cle } }).catch(() => undefined);
    await prisma.fileBlob.deleteMany({ where: { id: { in: stored.map((s) => s.blobId) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  it("sert en pièce jointe, sous bac à sable, jamais en page HTML de l'ERP", async () => {
    const token = makeDocReadToken(docId, userId);
    const r = await GET(new NextRequest(`http://localhost/api/onlyoffice/file?token=${encodeURIComponent(token)}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition") ?? "").toMatch(/^attachment/);
    expect(r.headers.get("Content-Security-Policy") ?? "").toContain("sandbox");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
