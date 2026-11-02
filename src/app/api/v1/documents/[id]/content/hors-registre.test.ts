import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * UNE PIÈCE DONT LE PORTEUR N'EST PAS AU REGISTRE NE S'OUVRE PAS POUR AUTANT (audit sécurité 27/10, SECURITE-ACCES-02).
 *
 * La route ne vérifiait la portée QUE si le type du porteur figurait au registre de l'API (`if (def)`).
 * Une quarantaine de types n'y sont pas — demandes RH (attestations, arrêts maladie), CV de candidats,
 * RIB des sociétés, pièces de validation… — et leurs fichiers partaient vers toute clé `erp.documents.read`,
 * quelle que soit la personne au nom de laquelle elle agit. La règle de l'écran (`canAccessEntity`) s'applique
 * désormais à toute pièce.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api/auth";
import { saveFile } from "@/lib/storage";
import { GET } from "./route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zdocapi${Date.now()}`;
const cle = `HR_REQUEST/${TAG}/arret`;
let userId = "";
let clientId = "";
let apiKey = "";
let docId = "";

suite("API v1 — contenu d'une pièce hors registre", () => {
  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { name: `${TAG}d`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } })).id;
    await saveFile(cle, Buffer.from("arrêt maladie d'un collègue"));
    docId = (await prisma.document.create({
      data: { name: "arret.pdf", entityType: "HR_REQUEST", entityId: `${TAG}-demande`, fileKey: cle, sizeBytes: 10, mimeType: "application/pdf", uploadedById: userId },
    })).id;
    const k = generateApiKey();
    apiKey = k.key;
    clientId = (await prisma.apiClient.create({ data: { name: TAG, keyHash: k.keyHash, keyPrefix: k.keyPrefix, scopes: ["erp.read", "erp.documents.read"], actAsUserId: userId } })).id;
  }, 60_000);

  afterAll(async () => {
    const stored = await prisma.storedFile.findMany({ where: { key: cle }, select: { blobId: true } });
    await prisma.apiCall.deleteMany({ where: { clientId } }).catch(() => undefined);
    await prisma.apiClient.deleteMany({ where: { id: clientId } }).catch(() => undefined);
    await prisma.document.deleteMany({ where: { id: docId } }).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { key: cle } }).catch(() => undefined);
    await prisma.fileBlob.deleteMany({ where: { id: { in: stored.map((s) => s.blobId) } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  it("une demande RH d'autrui : introuvable, pas téléchargée", async () => {
    const r = await GET(
      new NextRequest(`http://localhost/api/v1/documents/${docId}/content`, { headers: { authorization: `Bearer ${apiKey}` } }),
      { params: Promise.resolve({ id: docId }) },
    );
    expect(r.status).toBe(404);
  });
});
