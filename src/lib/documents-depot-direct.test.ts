import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GROS DOCUMENTS (checklist Regulatory, pièces d'objets métier) ENVOYÉS DIRECTEMENT AU BUCKET — par
 * les VRAIES fonctions serveur, sur la base réelle, avec un bucket SIMULÉ (aucun appel réseau).
 *
 *   • la limite n'est plus celle du chemin « en mémoire » (≈ 250 Mo) : 3 Go passent à l'ouverture ;
 *   • l'arborescence d'un DOSSIER déposé se garde (`folder`) et deux « index.xml » de deux dossiers
 *     ne sont PAS deux versions du même fichier ;
 *   • finalisation : incomplet → reprenable ; complet → UN document, même finalisé deux fois ; le
 *     blob est désigné « déposé en direct » et la clé de fichier le retrouve ;
 *   • droits : relus à l'ouverture ET à la finalisation ; sans stockage objet, refus qui nomme les variables.
 * L'acteur est un assistant réglementaire SANS vue globale.
 */

const ENV = { S3_ENDPOINT: "https://compte.r2.cloudflarestorage.com", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { cleObjetDirect } from "@/lib/drive-storage";
import type { ClientS3Direct } from "@/lib/storage/televersement-direct";
import type { PartieRecue } from "@/lib/storage/object-storage";
import { ouvrirDepotDirectDocument, finaliserDepotDirectDocument, abandonnerDepotDirectDocument, type CibleDocument } from "./documents-depot-direct";
import { dossierSur, persistUploadedDocument } from "./documents";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__docdirect__${Date.now()}`;
const MO = 1024 * 1024;
const GO = 1024 * MO;
let moi: SessionUser;
let produit = "";
let produitEtranger = "";
const ids: string[] = [];

function bucket() {
  const etat = { recues: [] as PartieRecue[], recolle: false, abandonne: false, taille: null as number | null };
  const client: ClientS3Direct = {
    ouvrir: async () => "UP",
    parties: async () => (etat.recolle ? Promise.reject(new Error("NoSuchUpload")) : etat.recues),
    signerPartie: (_c, _u, n) => `https://bucket/p${n}`,
    recoller: async () => { etat.recolle = true; },
    abandonner: async () => { etat.abandonne = true; },
    taille: async () => etat.taille,
  };
  return { client, etat };
}

const cible = (extra: Partial<CibleDocument> = {}): CibleDocument => ({
  entityType: "REGULATORY_PRODUCT", entityId: produit, category: "CTD_FULL", confidentiality: "INTERNAL", stepKey: "ctd", folder: null,
  // Ce banc dépose la CTD initiale : le dépôt le DIT (§118.213) — sans la marque, il est refusé (cas dédié plus bas).
  ctd: true, ...extra,
});
const entree = (nom: string, taille: number, c = cible()) => ({ nom, taille, type: "application/zip", modifieLe: 1_700_000_000_000, cible: c });

/** Les parties qu'un bucket a reçues quand TOUT est arrivé : la dernière est plus courte. */
const toutRecu = (plan: { nbParties: number; taillePartie: number }, total: number): PartieRecue[] =>
  Array.from({ length: plan.nbParties }, (_, i) => ({
    numero: i + 1, etag: `"e${i}"`, taille: i < plan.nbParties - 1 ? plan.taillePartie : total - (plan.nbParties - 1) * plan.taillePartie,
  }));

/** Envoi COMPLET : le bucket a tout reçu. */
async function deposer(nom: string, taille: number, c = cible()) {
  const { client, etat } = bucket();
  const ouv = await ouvrirDepotDirectDocument(moi, entree(nom, taille, c), client);
  if (!ouv.ok) return { ouv, fin: null };
  etat.recues = toutRecu(ouv.plan, taille);
  etat.taille = taille;
  const fin = await finaliserDepotDirectDocument(moi, ouv.sessionId, client);
  return { ouv, fin };
}

suite("Documents — envoi direct au bucket", () => {
  beforeAll(async () => {
    const [u, autre] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
    ]);
    ids.push(u.id, autre.id);
    moi = { id: u.id, name: u.name, email: u.email, role: "REGULATORY_ASSISTANT", secondaryRole: null, access: await getAccess(u.id, "REGULATORY_ASSISTANT") } as SessionUser;
    produit = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-dci`, reference: `${TAG}-REF`, assistantId: u.id } })).id;
    produitEtranger = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-etr`, reference: `${TAG}-ETR`, isLocked: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const docs = await prisma.document.findMany({ where: { entityId: { in: [produit, produitEtranger] } }, select: { id: true, fileKey: true } });
    const stored = await prisma.storedFile.findMany({ where: { key: { in: docs.map((d) => d.fileKey!).filter(Boolean) } }, select: { blobId: true } });
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
    await prisma.storedFile.deleteMany({ where: { key: { in: docs.map((d) => d.fileKey!).filter(Boolean) } } });
    // Un dépôt Regulatory se range AUSSI dans le dossier Drive du produit (383a4ef5), EN ARRIÈRE-PLAN et sur le MÊME blob
    // (une `FileVersion`, clé étrangère RESTRICT) : le dossier du produit part d'abord — créé au nom de l'acteur du banc —,
    // et tant qu'un rangement encore en vol retient le blob, on laisse finir puis on recommence.
    const blobIds = stored.map((s) => s.blobId);
    for (let essai = 0; ; essai++) {
      await prisma.driveNode.deleteMany({ where: { OR: [{ ownerId: { in: ids } }, { versions: { some: { blobId: { in: blobIds } } } }] } });
      try {
        await prisma.fileBlob.deleteMany({ where: { id: { in: blobIds } } });
        break;
      } catch (e) {
        if (essai >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await prisma.directUpload.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: { in: [produit, produitEtranger] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  it("accepte 3 Go (la limite du chemin en mémoire ne s'applique plus) et inscrit UN document dont le blob est « direct »", async () => {
    const { ouv, fin } = await deposer(`${TAG}-ctd.zip`, 3 * GO);
    expect(ouv.ok).toBe(true);
    expect(fin?.ok).toBe(true);
    if (!fin?.ok) return;
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: fin.id } });
    expect(doc.sizeBytes).toBe(3 * GO); // Float : un entier 32 bits aurait refusé ce nombre
    expect(doc.stepKey).toBe("ctd");
    expect(doc.folder).toBeNull();
    const stocke = await prisma.storedFile.findUniqueOrThrow({ where: { key: doc.fileKey! } });
    expect(await cleObjetDirect(stocke.blobId)).toMatch(/^direct\//);
  });

  it("garde l'arborescence d'un dossier ; deux « index.xml » de deux dossiers ne sont PAS deux versions", async () => {
    const a = await deposer(`${TAG}-index.xml`, 5 * MO, cible({ folder: "CTD/Module 1" }));
    const b = await deposer(`${TAG}-index.xml`, 5 * MO, cible({ folder: "CTD/Module 2" }));
    const c = await deposer(`${TAG}-index.xml`, 6 * MO, cible({ folder: "CTD/Module 1" }));
    for (const r of [a, b, c]) expect(r.fin?.ok, JSON.stringify(r.fin)).toBe(true);
    const docs = await prisma.document.findMany({ where: { entityId: produit, name: `${TAG}-index.xml` }, orderBy: { createdAt: "asc" } });
    expect(docs.map((d) => [d.folder, d.version])).toEqual([["CTD/Module 1", 1], ["CTD/Module 2", 1], ["CTD/Module 1", 2]]);
  });

  it("finalise UNE fois : incomplet → reprenable ; complet deux fois → le même document", async () => {
    const { client, etat } = bucket();
    const ouv = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-reprise.zip`, 100 * MO), client);
    if (!ouv.ok) throw new Error(ouv.error);
    etat.taille = null;
    const incomplet = await finaliserDepotDirectDocument(moi, ouv.sessionId, client);
    expect(incomplet.ok).toBe(false);
    expect(await prisma.document.count({ where: { entityId: produit, name: `${TAG}-reprise.zip` } })).toBe(0);
    etat.recues = toutRecu(ouv.plan, 100 * MO);
    etat.taille = 100 * MO;
    const un = await finaliserDepotDirectDocument(moi, ouv.sessionId, client);
    const deux = await finaliserDepotDirectDocument(moi, ouv.sessionId, client);
    expect(un.ok && deux.ok && un.id === deux.id).toBe(true);
    expect(await prisma.document.count({ where: { entityId: produit, name: `${TAG}-reprise.zip` } })).toBe(1);
  });

  it("refuse, à l'ouverture, un dépôt sur une fiche qu'on ne peut pas alimenter — et le dit", async () => {
    const r = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-interdit.zip`, 100 * MO, cible({ entityId: produitEtranger })), bucket().client);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(await prisma.directUpload.count({ where: { userId: moi.id, fileName: `${TAG}-interdit.zip` } })).toBe(0);
  });

  it("un gros dépôt qui vise la CTD initiale (étape 1, « CTD complet ») sans le dire est refusé à l'ouverture, en nommant les gestes — et la marque ailleurs aussi", async () => {
    const sans = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-sans-marque.zip`, 100 * MO, cible({ ctd: false })), bucket().client);
    expect(sans.ok).toBe(false);
    if (!sans.ok) { expect(sans.status).toBe(400); expect(sans.error).toMatch(/Ajouter à la CTD/); }
    const ailleurs = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-ailleurs.zip`, 100 * MO, cible({ category: "OTHER" })), bucket().client);
    expect(ailleurs.ok).toBe(false);
    if (!ailleurs.ok) expect(ailleurs.error).toMatch(/étape 1/);
    // Une autre catégorie SANS marque reste un dépôt ordinaire.
    const ordinaire = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-ordinaire.zip`, 100 * MO, cible({ category: "OTHER", ctd: false })), bucket().client);
    expect(ordinaire.ok).toBe(true);
    if (ordinaire.ok) await abandonnerDepotDirectDocument(moi, ordinaire.sessionId, bucket().client);
    expect(await prisma.directUpload.count({ where: { userId: moi.id, fileName: { in: [`${TAG}-sans-marque.zip`, `${TAG}-ailleurs.zip`] } } })).toBe(0);
  });

  it("refuse un type interdit et un fichier au-delà de 10 Go, sans ouvrir d'envoi", async () => {
    const exe = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-virus.exe`, 5 * MO), bucket().client);
    expect(exe.ok).toBe(false);
    const enorme = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-enorme.zip`, 11 * GO), bucket().client);
    expect(enorme.ok).toBe(false);
    if (!enorme.ok) expect(enorme.error).toMatch(/10 Go/); // la limite est dite en Go, pas en 10240 Mo
    expect(await prisma.directUpload.count({ where: { userId: moi.id, fileName: { in: [`${TAG}-virus.exe`, `${TAG}-enorme.zip`] } } })).toBe(0);
  });

  it("abandon : les parties sont libérées et la finalisation ne passe plus", async () => {
    const { client, etat } = bucket();
    const ouv = await ouvrirDepotDirectDocument(moi, entree(`${TAG}-abandon.zip`, 100 * MO), client);
    if (!ouv.ok) throw new Error(ouv.error);
    await abandonnerDepotDirectDocument(moi, ouv.sessionId, client);
    expect(etat.abandonne).toBe(true);
    expect((await finaliserDepotDirectDocument(moi, ouv.sessionId, client)).ok).toBe(false);
  });

  it("le chemin ORDINAIRE (en mémoire) garde aussi le dossier, et versionne par nom ET dossier", async () => {
    const f = (octets: string) => new File([octets], `${TAG}-ordinaire.xml`, { type: "text/xml" });
    const base = { entityType: "REGULATORY_PRODUCT" as const, entityId: produit, category: "OTHER" as const, confidentiality: "INTERNAL" as const, stepKey: null };
    // Chemin ORDINAIRE : le stockage objet n'est pas « branché » (sinon l'écriture partirait vers un vrai bucket).
    const sauve = { ...ENV };
    for (const k of Object.keys(ENV)) delete process.env[k];
    let r1, r2, r3;
    try {
      r1 = await persistUploadedDocument(moi.id, { ...base, folder: "A/B", file: f("un") });
      r2 = await persistUploadedDocument(moi.id, { ...base, folder: "C", file: f("deux") });
      r3 = await persistUploadedDocument(moi.id, { ...base, folder: "A/B", file: f("trois") });
    } finally { for (const [k, v] of Object.entries(sauve)) process.env[k] = v; }
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, true]);
    const docs = await prisma.document.findMany({ where: { entityId: produit, name: `${TAG}-ordinaire.xml` }, orderBy: { createdAt: "asc" } });
    expect(docs.map((d) => [d.folder, d.version])).toEqual([["A/B", 1], ["C", 1], ["A/B", 2]]);
  });

  it("le dossier d'un chemin est nettoyé : jamais de « .. », jamais de chemin absolu", () => {
    expect(dossierSur("../../etc")).toBe("etc");
    expect(dossierSur("/CTD\\Module 3/./x/")).toBe("CTD/Module 3/x");
    expect(dossierSur("")).toBeNull();
    expect(dossierSur("a".repeat(900))?.length).toBe(500);
  });
});
