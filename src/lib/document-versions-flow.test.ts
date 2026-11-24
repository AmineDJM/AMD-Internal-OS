import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { saveFile, readFileByKey } from "@/lib/storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { ajouterVersionDrive } from "@/lib/drive/versions";
import { enregistrerVersionDocument, listerVersionsDocument, cleDeVersionDocument } from "@/lib/document-versions";
import { sessionEditeur } from "@/lib/onlyoffice-session";
import { deleteDocument } from "@/lib/actions/document-actions";
import { restoreDeletedRecord, destroyDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { deleteDriveSpace } from "@/lib/actions/drive-space-actions";
import { permanentlyDeleteDriveNode } from "@/lib/actions/database-admin-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDIT DU DRIVE (24/11) — points A3, A4, A5, F8 : ce qui se perdait ne se perd plus.
 *
 *   C. deux enregistrements simultanés d'une nouvelle version → deux versions, pas de P2002 ;
 *   D. un document réécrit garde sa version précédente LISIBLE ;
 *   la clé d'édition ne bouge pas sur un enregistrement forcé (statut 6) ;
 *   deleteDocument → corbeille restaurable, refusé pour la pièce d'un paiement ou d'une étape terminée ;
 *   deleteDriveSpace → corbeille restaurable ; destruction sans corbeille → nom confirmé exigé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drvversions${Date.now()}`;
const ENV0 = { url: process.env.ONLYOFFICE_URL, secret: process.env.ONLYOFFICE_JWT_SECRET, app: process.env.APP_URL };
let userId = "";
const docs: string[] = [];
const espaces: string[] = [];
let demandeId = "";
let produitId = "";

async function documentAvec(contenu: string, extra: { entityType?: "PAYMENT_REQUEST" | "REGULATORY_PRODUCT"; entityId?: string; stepKey?: string } = {}) {
  const entityType = extra.entityType ?? "PAYMENT_REQUEST";
  const entityId = extra.entityId ?? demandeId;
  const key = `${entityType}/${entityId}/${TAG}-${Math.random()}__contrat.docx`;
  await saveFile(key, Buffer.from(contenu));
  const d = await prisma.document.create({
    data: { name: `${TAG}-contrat.docx`, entityType, entityId, stepKey: extra.stepKey ?? null, fileKey: key, sizeBytes: contenu.length, uploadedById: userId },
    select: { id: true },
  });
  docs.push(d.id);
  return d.id;
}

suite("Drive & documents — versions et suppressions réversibles (audit du 24/11)", () => {
  beforeAll(async () => {
    process.env.ONLYOFFICE_URL = "https://office.example.com";
    process.env.ONLYOFFICE_JWT_SECRET = "secret-de-test";
    process.env.APP_URL = "https://erp.example.com";
    const u = await prisma.user.create({ data: { name: `${TAG}u`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    userId = u.id;
    const access = await getAccess(u.id, "SUPER_ADMIN");
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access, mustChangePassword: false };
    demandeId = (await prisma.paymentRequest.create({ data: { reference: `${TAG}PAY`.slice(0, 40), title: `${TAG}`, amount: 1000, payee: "Fournisseur", requesterId: userId }, select: { id: true } })).id;
    produitId = (await prisma.regulatoryProduct.create({
      data: { reference: `${TAG}REG`, dci: "molecule", workflow: { ctd: { status: "DONE" } } },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of [["ONLYOFFICE_URL", ENV0.url], ["ONLYOFFICE_JWT_SECRET", ENV0.secret], ["APP_URL", ENV0.app]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const cles = [
      ...(await prisma.documentVersion.findMany({ where: { documentId: { in: docs } }, select: { fileKey: true } })).map((v) => v.fileKey),
      ...(await prisma.document.findMany({ where: { id: { in: docs } }, select: { fileKey: true } })).map((d) => d.fileKey ?? ""),
    ];
    // Les contenus écrits ici sont uniques (TAG + aléa) : leurs blobs partent avec le reste.
    const blobs = new Set<string>([
      ...(await prisma.storedFile.findMany({ where: { key: { in: cles } }, select: { blobId: true } })).map((x) => x.blobId),
      ...(await prisma.fileVersion.findMany({ where: { node: { name: { startsWith: TAG } } }, select: { blobId: true } })).map((x) => x.blobId),
    ]);
    await prisma.paymentPiece.deleteMany({ where: { requestId: demandeId } }).catch(() => undefined);
    await prisma.documentVersion.deleteMany({ where: { documentId: { in: docs } } }).catch(() => undefined);
    await prisma.document.deleteMany({ where: { id: { in: docs } } }).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { key: { in: cles } } }).catch(() => undefined);
    await prisma.deletedRecord.deleteMany({ where: { deletedById: userId } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.driveSpace.deleteMany({ where: { id: { in: espaces } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: demandeId } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.fileBlob.deleteMany({ where: { id: { in: [...blobs] } } }).catch(() => undefined);
  }, 60_000);

  async function fichierDrive(nom = `${TAG}-rapport.docx`, spaceId: string | null = null) {
    const v1 = await putBlob(Buffer.from(`${TAG}-v1-${Math.random()}`));
    return (await prisma.driveNode.create({
      data: { name: nom, type: "FILE", ownerId: userId, createdById: userId, size: 1, spaceId, versions: { create: { blobId: v1.blobId, version: 1, size: 1, createdById: userId } } },
      select: { id: true },
    })).id;
  }

  it("C. deux nouvelles versions déposées en même temps → deux versions, aucune P2002, aucun blob perdu", async () => {
    const nodeId = await fichierDrive();
    const xa = await putBlob(Buffer.from(`${TAG}-alice-${Math.random()}`));
    const xb = await putBlob(Buffer.from(`${TAG}-bob-${Math.random()}`));
    const res = await Promise.allSettled([
      enregistrerFichierDrive(ACTOR!, { nodeId }, { blobId: xa.blobId, size: 1, mimeType: "x", name: "a" }),
      enregistrerFichierDrive(ACTOR!, { nodeId }, { blobId: xb.blobId, size: 1, mimeType: "x", name: "b" }),
    ]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const versions = await prisma.fileVersion.findMany({ where: { nodeId }, orderBy: { version: "asc" }, select: { version: true, blobId: true } });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(new Set(versions.map((v) => v.blobId))).toEqual(new Set([versions[0].blobId, xa.blobId, xb.blobId]));
  });

  it("C'. deux rappels simultanés de l'éditeur (Document) → deux versions, la première reste lisible", async () => {
    const id = await documentAvec(`${TAG}-original`);
    const [a, b] = await Promise.all([
      enregistrerVersionDocument(id, Buffer.from(`${TAG}-alice`), userId),
      enregistrerVersionDocument(id, Buffer.from(`${TAG}-bob`), userId),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const lignes = await listerVersionsDocument(id);
    expect(lignes.map((l) => l.version)).toEqual([3, 2, 1]);
    expect((await readFileByKey((await cleDeVersionDocument(id, 1))!)).toString()).toBe(`${TAG}-original`);
  });

  it("D. après deux enregistrements, la v1 d'un document reste LISIBLE (plus d'écrasement de la clé)", async () => {
    const id = await documentAvec(`${TAG}-contrat-v1`);
    expect((await enregistrerVersionDocument(id, Buffer.from(`${TAG}-contrat-v2`), userId)).ok).toBe(true);
    expect((await enregistrerVersionDocument(id, Buffer.from(`${TAG}-contrat-v3`), userId)).ok).toBe(true);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id }, select: { version: true, fileKey: true } });
    expect(doc.version).toBe(3);
    expect((await readFileByKey(doc.fileKey!)).toString()).toBe(`${TAG}-contrat-v3`);
    expect((await readFileByKey((await cleDeVersionDocument(id, 1))!)).toString()).toBe(`${TAG}-contrat-v1`);
    expect((await readFileByKey((await cleDeVersionDocument(id, 2))!)).toString()).toBe(`${TAG}-contrat-v2`);
    // Comparer et échanger (éditeur de texte) : une version lue périmée ne s'écrit pas, et ne laisse rien derrière elle.
    expect(await enregistrerVersionDocument(id, Buffer.from(`${TAG}-perime`), userId, { versionLue: 2 })).toEqual({ ok: false, raison: "conflit" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id } })).version).toBe(3);
  });

  it("statut 6 puis nouvelle session : MÊME clé d'édition ; statut 2 : la clé change (Drive)", async () => {
    const nodeId = await fichierDrive();
    const cle = async () => {
      const s = await sessionEditeur(ACTOR!, { type: "drive", id: nodeId });
      if (!s.ok) throw new Error(s.reason);
      return (s.config.document as { key: string }).key;
    };
    const avant = await cle();
    const f = await putBlob(Buffer.from(`${TAG}-force-${Math.random()}`));
    await ajouterVersionDrive({ nodeId, blobId: f.blobId, size: 1, createdById: userId, forcesave: true });
    expect(await cle()).toBe(avant);
    const fin = await putBlob(Buffer.from(`${TAG}-final-${Math.random()}`));
    await ajouterVersionDrive({ nodeId, blobId: fin.blobId, size: 1, createdById: userId });
    expect(await cle()).not.toBe(avant);
  });

  it("statut 6 puis nouvelle session : MÊME clé d'édition (Document)", async () => {
    const id = await documentAvec(`${TAG}-office`);
    const cle = async () => {
      const s = await sessionEditeur(ACTOR!, { type: "document", id });
      if (!s.ok) throw new Error(s.reason);
      return (s.config.document as { key: string }).key;
    };
    const avant = await cle();
    await enregistrerVersionDocument(id, Buffer.from(`${TAG}-office-force-1`), userId, { forcesave: true });
    await enregistrerVersionDocument(id, Buffer.from(`${TAG}-office-force-22`), userId, { forcesave: true });
    expect(await cle()).toBe(avant);
    await enregistrerVersionDocument(id, Buffer.from(`${TAG}-office-final`), userId);
    expect(await cle()).not.toBe(avant);
  });

  it("deleteDocument → corbeille, restaurable avec ses versions", async () => {
    const id = await documentAvec(`${TAG}-a-restaurer-v1`);
    await enregistrerVersionDocument(id, Buffer.from(`${TAG}-a-restaurer-v2`), userId);
    const r = await deleteDocument(id);
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.document.findUnique({ where: { id } })).toBeNull();
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DOCUMENT", sourceId: id } });
    // Les octets restent au stockage tant que l'entrée est en corbeille.
    expect((await readFileByKey((await cleDeVersionDocument(id, 1))!)).toString()).toBe(`${TAG}-a-restaurer-v1`);
    const fd = new FormData(); fd.set("id", rec.id);
    const back = await restoreDeletedRecord(fd);
    expect(back.ok, back.error).toBe(true);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect((await readFileByKey(doc.fileKey!)).toString()).toBe(`${TAG}-a-restaurer-v2`);
    expect((await listerVersionsDocument(id)).map((l) => l.version)).toEqual([2, 1]);
  });

  it("la destruction réelle d'un document en corbeille rend ses versions", async () => {
    const id = await documentAvec(`${TAG}-a-detruire-v1`);
    await enregistrerVersionDocument(id, Buffer.from(`${TAG}-a-detruire-v2`), userId);
    const cleV1 = (await cleDeVersionDocument(id, 1))!;
    expect((await deleteDocument(id)).ok).toBe(true);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DOCUMENT", sourceId: id } });
    const fd = new FormData(); fd.set("id", rec.id);
    expect((await destroyDeletedRecord(fd)).ok).toBe(true);
    expect(await prisma.storedFile.findUnique({ where: { key: cleV1 } })).toBeNull();
    expect(await prisma.documentVersion.count({ where: { documentId: id } })).toBe(0);
  });

  it("deleteDocument REFUSE la pièce d'une demande de paiement — rien ne part", async () => {
    const id = await documentAvec(`${TAG}-facture`);
    await prisma.paymentPiece.create({ data: { requestId: demandeId, documentId: id, kind: "INVOICE" } });
    const r = await deleteDocument(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pièce de la demande de paiement .*déposez une nouvelle pièce/);
    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull();
  });

  it("deleteDocument REFUSE la pièce d'une étape Regulatory terminée", async () => {
    const id = await documentAvec(`${TAG}-ctd`, { entityType: "REGULATORY_PRODUCT", entityId: produitId, stepKey: "ctd" });
    const r = await deleteDocument(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà terminée.*Rouvrez/);
    expect(await prisma.document.findUnique({ where: { id } })).not.toBeNull();
  });

  it("deleteDriveSpace → corbeille : la catégorie et son contenu reviennent ensemble", async () => {
    const space = await prisma.driveSpace.create({ data: { name: `${TAG}-categorie`, createdById: userId }, select: { id: true } });
    espaces.push(space.id);
    const nodeId = await fichierDrive(`${TAG}-dans-categorie.docx`, space.id);
    const fd = new FormData(); fd.set("id", space.id);
    const r = await deleteDriveSpace(fd);
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.driveNode.findUnique({ where: { id: nodeId } })).toBeNull();
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DRIVE_SPACE", sourceId: space.id } });
    const fr = new FormData(); fr.set("id", rec.id);
    const back = await restoreDeletedRecord(fr);
    expect(back.ok, back.error).toBe(true);
    expect(await prisma.driveSpace.findUnique({ where: { id: space.id } })).not.toBeNull();
    expect(await prisma.fileVersion.count({ where: { nodeId } })).toBe(1);
  });

  it("permanentlyDeleteDriveNode exige le nom confirmé, et refuse le contenu d'une pièce de paiement", async () => {
    const nodeId = await fichierDrive(`${TAG}-a-detruire.docx`);
    const sans = new FormData(); sans.set("id", nodeId);
    expect((await permanentlyDeleteDriveNode(sans)).error).toMatch(/non confirmée/);
    // Le même contenu qu'une pièce de paiement (copie « Mes documents importés ») : refusé.
    const contenu = `${TAG}-piece-paiement-${Math.random()}`;
    const docId = await documentAvec(contenu);
    await prisma.paymentPiece.create({ data: { requestId: demandeId, documentId: docId, kind: "INVOICE" } });
    const b = await putBlob(Buffer.from(contenu));
    const copie = (await prisma.driveNode.create({
      data: { name: `${TAG}-copie.pdf`, type: "FILE", ownerId: userId, createdById: userId, size: 1, versions: { create: { blobId: b.blobId, version: 1, size: 1, createdById: userId } } },
      select: { id: true },
    })).id;
    const refus = new FormData(); refus.set("id", copie); refus.set("confirmation", `${TAG}-copie.pdf`);
    expect((await permanentlyDeleteDriveNode(refus)).error).toMatch(/demande de paiement/);
    const ok = new FormData(); ok.set("id", nodeId); ok.set("confirmation", `${TAG}-a-detruire.docx`);
    expect((await permanentlyDeleteDriveNode(ok)).ok).toBe(true);
    expect(await prisma.driveNode.findUnique({ where: { id: nodeId } })).toBeNull();
  });
});
