import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

/**
 * PARCOURIR UN ZIP D'UNE FICHE, ET LE TÉLÉCHARGER — par les VRAIES routes, sur la base réelle.
 *   • ZIP en base : liste (même forme que le Drive), une entrée, jamais l'archive servie en entier ;
 *   • ZIP DANS LE BUCKET (déposé en direct) : lu PAR PLAGES — la plage demandée est plus petite que
 *     l'archive — et le téléchargement est une REDIRECTION vers une adresse signée, pas un flux
 *     tenu en mémoire ;
 *   • droits : qui ne peut pas voir la fiche n'ouvre ni la liste ni une entrée ;
 *   • un fichier HTML d'une archive est servi en TEXTE (il s'exécuterait dans notre origine).
 */

// Le stockage objet n'est « branché » que le temps d'une signature : posé plus tôt, les dépôts ordinaires
// de ce banc tenteraient d'écrire dans un vrai bucket.
const ENV = { S3_ENDPOINT: "https://compte.r2.cloudflarestorage.com", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ getCurrentUser: async () => ACTEUR, getCurrentUserPourEcrire: async () => ACTEUR }));

const BUCKET = new Map<string, Buffer>();
const PLAGES: { cle: string; debut: number; longueur: number }[] = [];
vi.mock("@/lib/storage/object-storage", async (orig) => {
  const reel = await orig<typeof import("@/lib/storage/object-storage")>();
  return {
    ...reel,
    getObjectRange: async (cle: string, debut: number, longueur: number) => {
      PLAGES.push({ cle, debut, longueur });
      return (BUCKET.get(cle) ?? Buffer.alloc(0)).subarray(debut, debut + longueur);
    },
  };
});

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { saveFile } from "@/lib/storage";
import { GET as zipGET } from "./[id]/zip/route";
import { GET as docGET } from "./[id]/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__zipdoc__${Date.now()}`;
const ids: string[] = [];
let moi: SessionUser;
let etranger: SessionUser;
let produit = "";
let docBase = "";
let docDirect = "";
let docTexte = "";
let cleDirecte = "";

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const appel = (id: string) => ({ params: Promise.resolve({ id }) });

async function zip(): Promise<Buffer> {
  const z = new JSZip();
  z.file("Module 1/lettre.txt", "bonjour ".repeat(200));
  z.file("Module 3/3.2.P/données.xml", "<a/>");
  z.file("page.html", "<script>alert(1)</script>");
  z.file("gros.bin", Buffer.alloc(2 * 1024 * 1024, 5)); // jamais lu quand on ouvre une autre entrée
  return z.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

suite("Documents — parcourir un ZIP et le télécharger", () => {
  beforeAll(async () => {
    const [u, e] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG}etr`, email: `${TAG}etr@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    ids.push(u.id, e.id);
    moi = { id: u.id, name: u.name, email: u.email, role: "REGULATORY_ASSISTANT", secondaryRole: null, access: await getAccess(u.id, "REGULATORY_ASSISTANT") } as SessionUser;
    etranger = { id: e.id, name: e.name, email: e.email, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(e.id, "MEDICAL_DELEGATE") } as SessionUser;
    produit = (await prisma.regulatoryProduct.create({ data: { dci: `${TAG}-dci`, reference: `${TAG}-REF`, assistantId: u.id } })).id;
    const archive = await zip();

    // 1. ZIP stocké EN BASE (chemin ordinaire).
    const keyBase = `REGULATORY_PRODUCT/${produit}/${TAG}-base`;
    await saveFile(keyBase, archive);
    docBase = (await prisma.document.create({ data: { name: `${TAG}-base.zip`, entityType: "REGULATORY_PRODUCT", entityId: produit, fileKey: keyBase, sizeBytes: archive.length, mimeType: "application/zip", uploadedById: u.id } })).id;

    // 2. ZIP DANS LE BUCKET (déposé en direct) : blob dont l'IV est vide.
    cleDirecte = `direct/${u.id}/${TAG}`;
    BUCKET.set(cleDirecte, archive);
    const blob = await prisma.fileBlob.create({ data: { sha256: `direct:${cleDirecte}`, size: archive.length, iv: Buffer.alloc(0), data: null, storageKey: cleDirecte, refCount: 1 } });
    const keyDirect = `REGULATORY_PRODUCT/${produit}/${TAG}-direct`;
    await prisma.storedFile.create({ data: { key: keyDirect, blobId: blob.id, size: archive.length } });
    docDirect = (await prisma.document.create({ data: { name: `${TAG}-direct.zip`, entityType: "REGULATORY_PRODUCT", entityId: produit, fileKey: keyDirect, sizeBytes: archive.length, mimeType: "application/zip", uploadedById: u.id } })).id;

    // 3. Un document qui n'est pas un ZIP.
    const keyTexte = `REGULATORY_PRODUCT/${produit}/${TAG}-texte`;
    await saveFile(keyTexte, Buffer.from("texte"));
    docTexte = (await prisma.document.create({ data: { name: `${TAG}-note.txt`, entityType: "REGULATORY_PRODUCT", entityId: produit, fileKey: keyTexte, sizeBytes: 5, uploadedById: u.id } })).id;
  }, 60_000);

  afterAll(async () => {
    const docs = await prisma.document.findMany({ where: { entityId: produit }, select: { id: true, fileKey: true } });
    const stored = await prisma.storedFile.findMany({ where: { key: { in: docs.map((d) => d.fileKey!).filter(Boolean) } }, select: { blobId: true } });
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
    await prisma.storedFile.deleteMany({ where: { key: { in: docs.map((d) => d.fileKey!).filter(Boolean) } } });
    await prisma.fileBlob.deleteMany({ where: { id: { in: stored.map((s) => s.blobId) } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produit } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  it("liste un ZIP stocké en base (forme du Drive) et en sert une entrée", async () => {
    ACTEUR = moi;
    const liste = await (await zipGET(req(`/api/documents/${docBase}/zip`), appel(docBase))).json();
    expect(liste.ok).toBe(true);
    expect(liste.count).toBe(4);
    expect(liste.entries.map((e: { path: string }) => e.path).sort()).toEqual(["Module 1/lettre.txt", "Module 3/3.2.P/données.xml", "gros.bin", "page.html"]);
    const r = await zipGET(req(`/api/documents/${docBase}/zip?path=${encodeURIComponent("Module 3/3.2.P/données.xml")}`), appel(docBase));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<a/>");
  });

  it("lit un ZIP du bucket PAR PLAGES : le gros fichier de l'archive n'est jamais lu", async () => {
    ACTEUR = moi;
    PLAGES.length = 0;
    const taille = (await prisma.storedFile.findFirstOrThrow({ where: { key: { contains: `${TAG}-direct` } } })).size;
    const liste = await (await zipGET(req(`/api/documents/${docDirect}/zip`), appel(docDirect))).json();
    expect(liste.count).toBe(4);
    const r = await zipGET(req(`/api/documents/${docDirect}/zip?path=${encodeURIComponent("Module 1/lettre.txt")}`), appel(docDirect));
    expect((await r.text())).toBe("bonjour ".repeat(200));
    expect(PLAGES.length).toBeGreaterThan(0);
    expect(PLAGES.every((p) => p.cle === cleDirecte)).toBe(true);
    expect(Math.max(...PLAGES.map((p) => p.longueur))).toBeLessThan(taille / 2); // jamais l'archive entière
  });

  it("télécharge un document du bucket par REDIRECTION vers une adresse signée — rien n'est tenu en mémoire", async () => {
    ACTEUR = moi;
    for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
    let r: Response;
    try { r = await docGET(req(`/api/documents/${docDirect}?dl=1`), appel(docDirect)); }
    finally { for (const k of Object.keys(ENV)) delete process.env[k]; }
    expect(r.status).toBe(302);
    const lieu = r.headers.get("location") ?? "";
    expect(lieu).toContain(encodeURIComponent(cleDirecte).replace(/%2F/g, "/"));
    expect(lieu).toContain("X-Amz-Signature=");
    expect(lieu).toContain("response-content-disposition");
    // Un document ordinaire (en base) reste servi par l'application.
    const ordinaire = await docGET(req(`/api/documents/${docBase}`), appel(docBase));
    expect(ordinaire.status).toBe(200);
  });

  it("refuse la liste et une entrée à qui ne voit pas la fiche — et ne révèle rien", async () => {
    ACTEUR = etranger;
    const liste = await zipGET(req(`/api/documents/${docBase}/zip`), appel(docBase));
    expect(liste.status).toBe(403);
    const entree = await zipGET(req(`/api/documents/${docBase}/zip?path=page.html`), appel(docBase));
    expect(entree.status).toBe(403);
    ACTEUR = null;
    expect((await zipGET(req(`/api/documents/${docBase}/zip`), appel(docBase))).status).toBe(401);
  });

  it("sert un fichier HTML de l'archive en TEXTE (jamais exécutable) et refuse un chemin inventé ou un non-ZIP", async () => {
    ACTEUR = moi;
    const html = await zipGET(req(`/api/documents/${docBase}/zip?path=page.html`), appel(docBase));
    expect(html.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await zipGET(req(`/api/documents/${docBase}/zip?path=${encodeURIComponent("../../etc/passwd")}`), appel(docBase))).status).toBe(404);
    expect((await zipGET(req(`/api/documents/${docTexte}/zip`), appel(docTexte))).status).toBe(400);
  });
});
