import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * AUDIT DRIVE (24/11/2026) — F1, F6, F7 par les VRAIS chemins de dépôt, sur la base réelle :
 *   • F1 : un type déclaré mal formé (`text/plain,text/html`) n'est jamais ENREGISTRÉ — le Drive (route de
 *     dépôt et envoi direct au bucket) garde le type tiré du nom ;
 *   • F7 : la réponse du dépôt ne dit plus ses étapes (« contenu déjà présent » = oracle d'existence) ;
 *   • F6 : une pièce de module dont l'écriture au coffre a échoué est marquée inexploitable (aucune clé) ;
 *     son nom n'entre dans la clé que nettoyé ; le repli disque de `readFileByKey` ne sort pas de `uploads`.
 */

let moi: CurrentUser;
let casserLeCoffre = false;

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/session")>()),
  getCurrentUserPourEcrire: async () => moi,
  getCurrentUser: async () => moi,
}));
vi.mock("@/lib/drive-storage", async (orig) => {
  const vrai = await orig<typeof import("@/lib/drive-storage")>();
  return { ...vrai, putBlob: (...a: Parameters<typeof vrai.putBlob>) => (casserLeCoffre ? Promise.reject(new Error("coffre indisponible")) : vrai.putBlob(...a)) };
});

const ENV_S3 = { S3_ENDPOINT: "https://compte.r2.cloudflarestorage.com", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { cheminDeRepli, deposerPieceDeModule, readFileByKey } from "@/lib/storage";
import { POST as deposerDrive } from "@/app/api/drive/upload/route";
import { ouvrirDepotDirect } from "./depot-direct";
import type { ClientS3Direct } from "@/lib/storage/televersement-direct";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drvsecu_${Date.now().toString(36)}_`;

describe("F6 — le repli disque ne sort jamais du dossier `uploads`", () => {
  it("confine la clé ; `..`, chemin absolu et octet nul rendent null", () => {
    expect(cheminDeRepli("DOC/x/a.pdf", "/srv/uploads")).toBe("/srv/uploads/DOC/x/a.pdf");
    expect(cheminDeRepli("../../etc/passwd", "/srv/uploads")).toBeNull();
    expect(cheminDeRepli("/etc/passwd", "/srv/uploads")).toBeNull();
    expect(cheminDeRepli("a/../../uploads2/x", "/srv/uploads")).toBeNull();
    expect(cheminDeRepli("a\0b", "/srv/uploads")).toBeNull();
    expect(cheminDeRepli("", "/srv/uploads")).toBeNull();
  });
});

suite("Audit Drive — dépôt : type, étapes, clé, écriture ratée", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
    const access = await getAccess(u.id, u.role);
    moi = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  }, 60_000);

  afterAll(async () => {
    casserLeCoffre = false;
    await retirerDocumentsEtContenu({ where: { uploadedById: moi?.id } }).catch(() => undefined);
    await retirerNoeudsDriveEtContenu({ where: { ownerId: moi?.id } }).catch(() => undefined);
    await prisma.directUpload.deleteMany({ where: { userId: moi?.id } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: moi?.id } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  }, 60_000);

  const deposer = async (nom: string, type: string, octets = "contenu de test") => {
    const form = new FormData();
    form.append("file", new File([octets], nom, { type }));
    return deposerDrive(new NextRequest("http://localhost/api/drive/upload", { method: "POST", body: form }));
  };

  it("F1 — `text/plain,text/html` déclaré sur un .pdf : le Drive enregistre application/pdf", async () => {
    const r = await deposer(`${TAG}rapport.pdf`, "text/plain,text/html", `%PDF-1.4 ${TAG}`);
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    const n = await prisma.driveNode.findUniqueOrThrow({ where: { id }, select: { mimeType: true, versions: { select: { mimeType: true } } } });
    expect(n.mimeType).toBe("application/pdf");
    expect(n.versions.map((v) => v.mimeType)).toEqual(["application/pdf"]);
  });

  it("F7 — la réponse ne dit plus ses étapes : un contenu déjà présent ne se devine pas", async () => {
    const octets = `même contenu ${TAG}`;
    await deposer(`${TAG}a.txt`, "text/plain", octets);
    const r = await deposer(`${TAG}b.txt`, "text/plain", octets);
    const corps = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(corps).sort()).toEqual(["id"]);
    expect(JSON.stringify(corps)).not.toMatch(/déjà présent|timing|phases/);
  });

  it("F1 — l'envoi direct au bucket enregistre et transmet le type tiré du nom, jamais la déclaration", async () => {
    const avant = Object.fromEntries(Object.keys(ENV_S3).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(ENV_S3)) process.env[k] = v;
    // Le bucket factice ne sert qu'ici : les autres dépôts du banc écrivent en base.
    onTestFinished(() => { for (const [k, v] of Object.entries(avant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const typesOuverts: string[] = [];
    const client: ClientS3Direct = {
      ouvrir: async (_cle, type) => { typesOuverts.push(type); return "UP"; },
      parties: async () => [], signerPartie: (_c, _u, n) => `https://bucket/p${n}`,
      recoller: async () => {}, abandonner: async () => {}, taille: async () => null,
    };
    const r = await ouvrirDepotDirect(moi, { nom: `${TAG}gros.pdf`, taille: 30 * 1024 * 1024, type: "text/plain,text/html", modifieLe: 1, cible: {} }, client);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typesOuverts).toEqual(["application/pdf"]);
    expect((await prisma.directUpload.findUniqueOrThrow({ where: { id: r.sessionId } })).mimeType).toBe("application/pdf");
  });

  it("F6 — pièce de module : nom nettoyé dans la clé ; écriture ratée → fiche INEXPLOITABLE (aucune clé)", async () => {
    const entityId = `${TAG}formation`;
    const base = { entityType: "TRAINING" as const, entityId, category: "OTHER" as const, confidentiality: "INTERNAL" as const, uploadedById: moi.id, journal: "banc" };

    const ok = await deposerPieceDeModule(new File(["x"], "../../evil\u0001.pdf", { type: "text/plain,text/html" }), base);
    const d1 = await prisma.document.findUniqueOrThrow({ where: { id: ok.id }, select: { fileKey: true, mimeType: true } });
    expect(d1.fileKey).toMatch(new RegExp(`^TRAINING/${entityId}/[0-9a-f-]{36}__evil\\.pdf$`));
    expect(d1.mimeType).toBe("application/pdf");
    expect((await readFileByKey(d1.fileKey!)).toString()).toBe("x");

    casserLeCoffre = true;
    try {
      const rate = await deposerPieceDeModule(new File(["y"], "justificatif.pdf", { type: "application/pdf" }), base);
      const d2 = await prisma.document.findUniqueOrThrow({ where: { id: rate.id }, select: { fileKey: true } });
      expect(d2.fileKey).toBeNull();
    } finally { casserLeCoffre = false; }
  });

  it("F6 — une clé qui remonterait l'arborescence ne lit rien sur le disque du serveur", async () => {
    await expect(readFileByKey("../package.json")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFileByKey("../../../../etc/hostname")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
