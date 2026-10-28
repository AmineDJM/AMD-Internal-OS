import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { saveFile, deleteFileByKey } from "@/lib/storage";
import { repriseRattrapagePieces } from "./rattrapage-pieces";

/**
 * LE RATTRAPAGE DES PIÈCES EXISTANTES — un document déjà en base entre en file comme un dépôt ; rejouer
 * le même lot ne crée rien ; interrupteur fermé, rien n'est écrit et c'est dit.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }

const TAG = `__rattrapage__${Date.now().toString(36)}`;

describe.skipIf(!dbOk)("reprise « rattrapage des pièces existantes »", () => {
  let actifAvant = false;
  let documentId = "";
  let empreinte = "";
  const key = `OTHER/${TAG}/devis.pdf`;

  beforeAll(async () => {
    actifAvant = (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { enrichissementActif: true } }))?.enrichissementActif ?? false;
    const octets = Buffer.concat([Buffer.from("%PDF-1.4 "), crypto.randomBytes(32)]);
    ({ sha256: empreinte } = await saveFile(key, octets));
    documentId = (await prisma.document.create({
      data: { name: "devis.pdf", category: "QUOTE", entityType: "AD_PRO_ITEM", entityId: `${TAG}poste`, fileKey: key, mimeType: "application/pdf", sizeBytes: octets.length, confidentiality: "INTERNAL" },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await prisma.appSetting.update({ where: { id: "global" }, data: { enrichissementActif: actifAvant } }).catch(() => undefined);
    await prisma.tacheEnrichissement.deleteMany({ where: { empreinte } });
    await prisma.businessEvent.deleteMany({ where: { correlationId: `piece:${empreinte}` } });
    await prisma.document.deleteMany({ where: { id: documentId } });
    await deleteFileByKey(key).catch(() => undefined);
  });

  // Le curseur juste avant le document du banc : le lot commence par lui.
  const lot = () => repriseRattrapagePieces.executer({ taille: 1, apresId: documentId.slice(0, -1) });

  it("interrupteur fermé : rien n'est écrit, et c'est dit", async () => {
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", enrichissementActif: false }, update: { enrichissementActif: false } });
    const r = await lot();
    expect(r.erreurs.join(" ")).toMatch(/fermé/);
    expect(await prisma.tacheEnrichissement.count({ where: { empreinte } })).toBe(0);
  });

  it("ouvert : le document entre en file (fiche + document) ; rejoué, rien de plus", async () => {
    await prisma.appSetting.update({ where: { id: "global" }, data: { enrichissementActif: true } });
    const premier = await lot();
    expect(premier).toMatchObject({ lues: 1, creees: 1 });
    expect(premier.suite).toBe(documentId);
    const taches = await prisma.tacheEnrichissement.findMany({ where: { empreinte }, select: { rattachementType: true, source: true } });
    expect(taches.map((t) => t.rattachementType).sort()).toEqual(["AD_PRO_ITEM", "DOCUMENT"]);
    expect(taches.every((t) => t.source === "ADPRO")).toBe(true);

    const second = await lot();
    expect(second).toMatchObject({ lues: 1, creees: 0, liees: 1 });
    expect(await prisma.tacheEnrichissement.count({ where: { empreinte } })).toBe(2);
    expect(await prisma.businessEvent.count({ where: { correlationId: `piece:${empreinte}` } })).toBe(1);
  });
});
