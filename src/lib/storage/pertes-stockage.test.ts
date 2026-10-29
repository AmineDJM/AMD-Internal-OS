import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PERTES DU STOCKAGE (audit du 04/10, section A) — un banc par perte, par les VRAIS points
 * d'entrée, sur la base réelle.
 *
 *   1. une écriture qui échoue ne crée PAS de fiche « téléversée » (ni document, ni pièce jointe) ;
 *   2. la purge des orphelins lit TOUS les détenteurs (colonnes du schéma ET JSON) et épargne un
 *      blob qui vient d'être pris ;
 *   3. copier un fichier du Drive compte un détenteur de plus : supprimer la copie puis l'original
 *      ne rend pas l'autre illisible ;
 *   4. dépôt et suppression simultanés du même contenu : aucune erreur brute, aucun dépôt perdu ;
 *   7. sponsoring : une pièce refusée ne crée PAS la demande (pas de doublon au second essai) ;
 *   8. tâche : une pièce non enregistrée est DITE (réponse + cloche) ;
 *  13. une relance réseau du même dépôt ne crée pas de « v2 » ; un fichier vide est dit.
 * L'acteur est un National Sales SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

// Panne d'écriture à la demande : le reste du stockage est le vrai.
let CASSER = false;
vi.mock("@/lib/drive-storage", async (orig) => {
  const vrai = await orig<typeof import("@/lib/drive-storage")>();
  return {
    ...vrai,
    putBlob: async (b: Buffer) => { if (CASSER) throw new Error("bucket plein"); return vrai.putBlob(b); },
  };
});

// Limite de taille à la demande (le réglage réel est une ligne GLOBALE : on ne l'écrit pas, §118.132).
let LIMITE_MO: number | null = null;
vi.mock("@/lib/settings", async (orig) => {
  const vrai = await orig<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), ...(LIMITE_MO !== null ? { maxUploadMb: LIMITE_MO } : {}) }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createSponsoring } from "@/modules/ad-pro/actions-sponsoring";
import { putBlob, releaseBlob, getBlob, purgeOrphanBlobs, retainBlob } from "@/lib/drive-storage";
import { saveFile, readFileByKey, deleteFileByKey } from "@/lib/storage";
import { COLONNES_BLOB, COLONNES_JSON } from "./blob-refs";
import { persistUploadedDocument } from "@/lib/documents";
import { attachFiles } from "@/lib/attach-files";
import { copyNodes, deleteNode } from "@/lib/actions/drive-actions";
import { createTask } from "@/lib/actions/task-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pertes__${Date.now()}`;
let userId = "";
const blobsCrees: string[] = [];

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access, mustChangePassword: false };
}
const fichier = (nom: string, contenu: string) => new File([new TextEncoder().encode(contenu)], nom, { type: "text/plain" });
const vieillir = (id: string) => prisma.$executeRaw`UPDATE "FileBlob" SET "touchedAt" = now() - interval '2 hours' WHERE id = ${id}`;

suite("stockage — aucune perte silencieuse", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}delegue`, email: `${TAG}@t.dz`, passwordHash: "x", role: "NATIONAL_SALES" } });
    userId = u.id;
    ACTOR = await acteur(u.id, "NATIONAL_SALES");
  }, 60_000);

  afterAll(async () => {
    CASSER = false;
    const docs = await prisma.document.findMany({ where: { name: { startsWith: TAG } }, select: { fileKey: true } });
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => undefined);
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.notification.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => undefined);
    const nodes = await prisma.driveNode.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, versions: { select: { blobId: true } } } });
    await prisma.driveNode.deleteMany({ where: { id: { in: nodes.map((n) => n.id) } } });
    await prisma.officeLetterhead.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.anppReserveBatch.deleteMany({ where: { sourceFilename: { startsWith: TAG } } });
    await prisma.companyDocumentProfile.deleteMany({ where: { company: { name: { startsWith: TAG } } } });
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.storedFile.deleteMany({ where: { key: { startsWith: TAG } } });
    for (const id of new Set([...blobsCrees, ...nodes.flatMap((n) => n.versions.map((v) => v.blobId))])) {
      await prisma.fileBlob.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────
  it("1. écriture en échec → AUCUNE fiche, et la phrase nomme le fichier (document)", async () => {
    CASSER = true;
    const r = await persistUploadedDocument(userId, {
      entityType: "TASK", entityId: `${TAG}-e1`, category: "OTHER", confidentiality: "INTERNAL", stepKey: null,
      file: fichier(`${TAG}-a.txt`, "contenu"), mirrorToDrive: false,
    });
    CASSER = false;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(new RegExp(`« ${TAG}-a\\.txt » n'a pas pu être enregistré \\(bucket plein\\)`));
    expect(await prisma.document.count({ where: { name: `${TAG}-a.txt` } })).toBe(0);
  });

  it("1. écriture en échec → AUCUNE pièce jointe fantôme, l'erreur est rendue ET dans la cloche", async () => {
    CASSER = true;
    const r = await attachFiles({ files: [fichier(`${TAG}-b.txt`, "b")], entityType: "TASK", entityId: `${TAG}-e2`, uploadedById: userId });
    CASSER = false;
    expect(r.saved).toBe(0);
    expect(r.error).toMatch(/n'a pas pu être enregistré/);
    expect(await prisma.document.count({ where: { name: `${TAG}-b.txt` } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId, title: "Pièce jointe non enregistrée" } })).toBeGreaterThan(0);
  });

  // ── 13 ─────────────────────────────────────────────────────────────────────────────────
  it("13. une relance du MÊME dépôt rend la même fiche — pas de v2 ; un contenu corrigé, si", async () => {
    const input = (contenu: string) => ({
      entityType: "TASK" as const, entityId: `${TAG}-e3`, category: "OTHER" as const, confidentiality: "INTERNAL" as const,
      stepKey: null, file: fichier(`${TAG}-c.txt`, contenu), mirrorToDrive: false,
    });
    const a = await persistUploadedDocument(userId, input("v1"));
    const b = await persistUploadedDocument(userId, input("v1"));
    expect(a.ok && b.ok).toBe(true);
    expect(b.documentId).toBe(a.documentId);
    expect(await prisma.document.count({ where: { name: `${TAG}-c.txt` } })).toBe(1);
    const c = await persistUploadedDocument(userId, input("v2 corrigée"));
    expect(c.documentId).not.toBe(a.documentId);
    expect(await prisma.document.count({ where: { name: `${TAG}-c.txt` } })).toBe(2);
  });

  it("13. un fichier vide d'un lot est DIT, pas écarté en silence ; toutes les erreurs du lot sont rendues", async () => {
    const r = await attachFiles({
      files: [new File([], `${TAG}-vide.txt`), fichier(`${TAG}-x.exe`, "MZ"), fichier(`${TAG}-ok.txt`, "ok")],
      entityType: "TASK", entityId: `${TAG}-e4`, uploadedById: userId,
    });
    expect(r.saved).toBe(0); // un refus arrête le lot AVANT toute écriture
    expect(r.error).toMatch(/vide\.txt » est vide/);
    expect(r.error).toMatch(/x\.exe » : Type de fichier non autorisé/);
  });

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────
  it("2. les détenteurs sont DÉRIVÉS du schéma : les onze tables oubliées y sont", () => {
    const tables = new Set(COLONNES_BLOB.map((c) => c.table));
    for (const t of ["FileVersion", "StoredFile", "DossierMessageAttachment", "EmployeeDocument", "MessageAttachment",
      "FieldReport", "FieldReportAttachment", "OfficeLetterhead", "RegulatoryDocument", "RegulatoryDossierVersion",
      "RegulatoryGeneratedDoc", "RegulatoryReserveCycle", "MeetingMessageAttachment", "FeedbackAttachment", "Meeting", "AnppReserveBatch"]) {
      expect(tables, `${t} doit compter parmi les détenteurs`).toContain(t);
    }
    expect(tables).not.toContain("FileBlobChunk"); // une tranche fait partie du blob, elle ne le tient pas
    expect(COLONNES_JSON.some((c) => c.table === "CompanyDocumentProfile" && c.colonne === "settings")).toBe(true);
  });

  it("2. la purge épargne un blob tenu par une table oubliée, par le JSON, ou pris il y a peu ; elle efface le vrai orphelin", async () => {
    const nouveau = async (s: string) => { const b = await putBlob(Buffer.from(`${TAG}-${s}-${Math.random()}`)); blobsCrees.push(b.blobId); return b.blobId; };
    const [papier, reserve, logo, recent, orphelin] = await Promise.all(["papier", "reserve", "logo", "recent", "orphelin"].map(nouveau));
    await prisma.officeLetterhead.create({ data: { name: `${TAG}-entete`, kind: "LETTERHEAD", blobId: papier, mime: "image/png", size: 1 } });
    await prisma.anppReserveBatch.create({ data: { sourceFilename: `${TAG}-res.pdf`, blobId: reserve, sha256: TAG, createdById: userId } });
    const co = await prisma.company.create({ data: { name: `${TAG}-co` } });
    await prisma.companyDocumentProfile.create({ data: { companyId: co.id, settings: { marque: { logo: { blobId: logo, nom: "logo" } } } } });
    for (const id of [papier, reserve, logo, orphelin]) await vieillir(id);

    const r = await purgeOrphanBlobs({ parmi: [papier, reserve, logo, recent, orphelin] });
    expect(r.count).toBe(1);
    const restants = (await prisma.fileBlob.findMany({ where: { id: { in: [papier, reserve, logo, recent, orphelin] } }, select: { id: true } })).map((b) => b.id);
    expect(restants.sort()).toEqual([papier, reserve, logo, recent].sort());
  });

  it("2. rendre une référence n'efface pas un blob qu'une autre colonne tient encore (compteur périmé)", async () => {
    const b = await putBlob(Buffer.from(`${TAG}-perime-${Math.random()}`));
    blobsCrees.push(b.blobId);
    await prisma.officeLetterhead.create({ data: { name: `${TAG}-entete2`, kind: "LETTERHEAD", blobId: b.blobId, mime: "image/png", size: 1 } });
    await releaseBlob(b.blobId); // compteur à 0 : l'ancien code effaçait les octets du papier en-tête
    expect(await getBlob(b.blobId)).not.toBeNull();
  });

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────
  it("3. copier puis supprimer la copie et… l'original reste lisible ; la copie compte une référence", async () => {
    const { blobId } = await putBlob(Buffer.from(`${TAG}-original-${Math.random()}`));
    blobsCrees.push(blobId);
    const orig = await prisma.driveNode.create({
      data: { name: `${TAG}-orig.txt`, type: "FILE", ownerId: userId, createdById: userId, size: 10, versions: { create: { blobId, version: 1, size: 10, createdById: userId } } },
      select: { id: true },
    });
    const fd = new FormData(); fd.append("id", orig.id);
    const c = await copyNodes(fd);
    expect(c.ok).toBe(true);
    expect((await prisma.fileBlob.findUniqueOrThrow({ where: { id: blobId } })).refCount).toBe(2);
    const copie = await prisma.driveNode.findFirstOrThrow({ where: { name: `${TAG}-orig.txt`, id: { not: orig.id } }, select: { id: true } });
    const d1 = new FormData(); d1.set("id", copie.id);
    expect((await deleteNode(d1)).ok).toBe(true);
    expect(await getBlob(blobId), "supprimer la copie a effacé les octets de l'original").not.toBeNull();
  });

  it("3. retenir un blob disparu échoue (la copie est refusée au lieu d'être créée vide)", async () => {
    expect(await retainBlob("inexistant")).toBe(false);
  });

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────
  it("4. suppression et dépôt SIMULTANÉS du même contenu : aucune erreur brute, chaque dépôt réussi se relit", async () => {
    const contenu = Buffer.from(`${TAG}-course-${Math.random()}`);
    let erreurs = 0, illisibles = 0;
    for (let tour = 0; tour < 15; tour++) {
      const avant = `${TAG}/course/${tour}/a`, apres = `${TAG}/course/${tour}/b`;
      await saveFile(avant, contenu);
      const res = await Promise.allSettled([deleteFileByKey(avant), saveFile(apres, contenu)]);
      erreurs += res.filter((x) => x.status === "rejected").length;
      try { await readFileByKey(apres); } catch { illisibles++; }
      await deleteFileByKey(apres);
    }
    expect(erreurs, "une erreur technique brute est sortie").toBe(0);
    expect(illisibles, "un dépôt « réussi » est illisible").toBe(0);
  }, 60_000);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────
  it("7. sponsoring : une pièce refusée (trop lourde) ne crée PAS la demande — pas de doublon au second essai", async () => {
    const institution = `${TAG}-assoc`;
    const fd = new FormData();
    for (const [k, v] of Object.entries({
      institution, doctorHorsAnnuaire: "Dr Test", product: "Produit test", city: "Alger", specialty: "Cardiologie",
      type: "CONGRESS", amountRequested: "100000", amountProposed: "80000", nature: "DIRECT", strategicImportance: "MEDIUM",
    })) fd.set(k, v);
    fd.append("files", new File([new Uint8Array(4096)], `${TAG}-demande.pdf`, { type: "application/pdf" }));
    LIMITE_MO = 0.001; // ≈ 1 Ko : la pièce de 4 Ko dépasse
    const r = await createSponsoring(undefined, fd);
    LIMITE_MO = null;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Fichier trop volumineux.*Aucune demande n'a été créée/);
    expect(await prisma.sponsoringRequest.count({ where: { institution } })).toBe(0);
  });

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────
  it("8. tâche : une pièce non enregistrée est DITE, la tâche n'est pas créée deux fois", async () => {
    const fd = new FormData();
    fd.set("title", `${TAG}-tache`);
    fd.append("files", fichier(`${TAG}-t.txt`, "t"));
    CASSER = true;
    const r = await createTask(undefined, fd);
    CASSER = false;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Tâche créée\. .*n'a pas pu être enregistré/);
    expect(await prisma.task.count({ where: { title: `${TAG}-tache` } })).toBe(1);
  });
});
