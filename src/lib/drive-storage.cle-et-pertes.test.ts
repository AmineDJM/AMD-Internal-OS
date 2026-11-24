import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDIT DU DRIVE DU 24/11 — NON-RÉGRESSION DES PERTES (section A, points 2, 6, 7, 9).
 *
 * Les cas A, B, E, F reproduisaient une perte (`zz-audit-drive-pertes`, hors dépôt) ; ils sont ici
 * à l'endroit : PLUS de perte. S'y ajoutent les courses voisines (double suppression, double
 * destruction, tranches en échec, déplacements croisés) et le cas du nœud sans propriétaire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob, getBlob, releaseBlob, retainBlob } from "@/lib/drive-storage";
import { saveFile, deleteFileByKey } from "@/lib/storage";
import { deleteNode, moveNode } from "@/lib/actions/drive-actions";
import { destroyDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { getDriveListing } from "@/lib/queries/drive";
import { ErreurCleDrive, identifiantCle, jugerEmpreinte, lireTrousseau } from "@/lib/storage/cle-drive";
import { verifierCleDrive, verifierCleDriveAuDemarrage, type MagasinEmpreinte } from "@/lib/storage/cle-drive-empreinte";

const hex = (secret: string) => crypto.createHash("sha256").update(secret).digest("hex");
const CLE_A = hex("cle-a"), CLE_B = hex("cle-b");

/** Une référence d'empreinte en mémoire : la ligne réelle des réglages est GLOBALE, on ne l'écrit pas (§118.132). */
function magasin(initiale: string | null = null): MagasinEmpreinte & { valeur: string | null } {
  const m = {
    valeur: initiale,
    lire: async () => m.valeur,
    poser: async (id: string) => { if (m.valeur === null) m.valeur = id; },
    avancer: async (de: string, vers: string) => { if (m.valeur === de) m.valeur = vers; },
  };
  return m;
}

describe("Clé des fichiers — règles pures (A2)", () => {
  it("une clé définie mais mal formée (63 hex, collée tronquée) est une ERREUR, plus un repli silencieux", () => {
    expect(() => lireTrousseau({ NODE_ENV: "test", DRIVE_ENCRYPTION_KEY: "a".repeat(63) } as NodeJS.ProcessEnv)).toThrow(ErreurCleDrive);
    expect(() => lireTrousseau({ NODE_ENV: "test", DRIVE_ENCRYPTION_KEY: "a".repeat(63) } as NodeJS.ProcessEnv)).toThrow(/DRIVE_ENCRYPTION_KEY invalide/);
    expect(() => lireTrousseau({ NODE_ENV: "test", DRIVE_ENCRYPTION_KEY: CLE_A, DRIVE_ENCRYPTION_KEYS: "abc" } as NodeJS.ProcessEnv)).toThrow(/DRIVE_ENCRYPTION_KEYS/);
    expect(lireTrousseau({ NODE_ENV: "test", DRIVE_ENCRYPTION_KEY: Buffer.from(CLE_A, "hex").toString("base64") } as NodeJS.ProcessEnv).active.id)
      .toBe(identifiantCle(Buffer.from(CLE_A, "hex")));
  });

  it("en production, DRIVE_ENCRYPTION_KEY est obligatoire : aucun repli sur le secret d'authentification", () => {
    expect(() => lireTrousseau({ NODE_ENV: "production", NEXTAUTH_SECRET: "x" } as NodeJS.ProcessEnv)).toThrow(/manquante/);
    const t = lireTrousseau({ NODE_ENV: "production", DRIVE_ENCRYPTION_KEY: CLE_B, DRIVE_ENCRYPTION_KEYS: `${CLE_A}, ${CLE_B}` } as NodeJS.ProcessEnv);
    expect(t.source).toBe("DRIVE_ENCRYPTION_KEY");
    expect(t.anciennes.map((c) => c.id)).toEqual([identifiantCle(Buffer.from(CLE_A, "hex"))]); // l'active n'est pas dupliquée
  });

  it("empreinte : posée par le premier service, divergente pour une autre clé, avancée lors d'une rotation voulue", async () => {
    const m = magasin();
    const envA = { NODE_ENV: "production", DRIVE_ENCRYPTION_KEY: CLE_A } as NodeJS.ProcessEnv;
    const envB = { NODE_ENV: "production", DRIVE_ENCRYPTION_KEY: CLE_B } as NodeJS.ProcessEnv;
    expect((await verifierCleDrive({ magasin: m, ecrire: true, env: envA })).etat).toBe("ok");
    expect(m.valeur).toBe(lireTrousseau(envA).active.id);
    const b = await verifierCleDrive({ magasin: m, ecrire: true, env: envB });
    expect(b.etat).toBe("divergente");
    expect(b.message).toMatch(/DRIVE_ENCRYPTION_KEY/);
    expect(m.valeur).toBe(lireTrousseau(envA).active.id); // la référence n'a pas bougé
    expect((await verifierCleDrive({ magasin: m, ecrire: true, env: { ...envB, DRIVE_ENCRYPTION_KEYS: CLE_A } })).etat).toBe("ok");
    expect(m.valeur).toBe(lireTrousseau(envB).active.id); // rotation : la référence avance
    expect(jugerEmpreinte(null, lireTrousseau(envA))).toBe("a-poser");
    expect((await verifierCleDrive({ magasin: m, env: { NODE_ENV: "production" } as NodeJS.ProcessEnv })).etat).toBe("absente");
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drvcle__${Date.now()}`;
const ENV0 = { N: process.env.NEXTAUTH_SECRET, A: process.env.AUTH_SECRET, D: process.env.DRIVE_ENCRYPTION_KEY, K: process.env.DRIVE_ENCRYPTION_KEYS, C: process.env.REG_BLOB_CHUNK_MB };
const remettre = () => {
  for (const [k, v] of [["NEXTAUTH_SECRET", ENV0.N], ["AUTH_SECRET", ENV0.A], ["DRIVE_ENCRYPTION_KEY", ENV0.D], ["DRIVE_ENCRYPTION_KEYS", ENV0.K], ["REG_BLOB_CHUNK_MB", ENV0.C]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
const unique = (nom: string) => Buffer.from(`${TAG}-${nom}-${crypto.randomBytes(8).toString("hex")}`);
const refCount = async (id: string) => (await prisma.fileBlob.findUnique({ where: { id }, select: { refCount: true } }))?.refCount ?? null;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("Drive — plus de perte (clé, références, tranches, déplacements)", () => {
  let userId = "";
  const blobs = new Set<string>();
  const garder = (id: string) => { blobs.add(id); return id; };

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}u`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    userId = u.id;
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(u.id, "SUPER_ADMIN"), mustChangePassword: false };
  }, 60_000);

  afterAll(async () => {
    remettre();
    await prisma.deletedRecord.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.driveNode.updateMany({ where: { name: { startsWith: TAG } }, data: { parentId: null } }).catch(() => undefined);
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.storedFile.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => undefined);
    for (const id of blobs) await prisma.fileBlob.deleteMany({ where: { id } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }, 60_000);

  it("A. un blob d'une autre clé n'est JAMAIS resservi au redépôt ; le trousseau le rend lisible", async () => {
    delete process.env.DRIVE_ENCRYPTION_KEY;
    process.env.NEXTAUTH_SECRET = "secret-service-web";
    const contenu = unique("contrat");
    const a = await putBlob(contenu); garder(a.blobId);
    expect((await getBlob(a.blobId))?.equals(contenu)).toBe(true);
    // un autre service, configuré avec un autre secret → une autre clé
    delete process.env.NEXTAUTH_SECRET; process.env.AUTH_SECRET = "secret-auth-partage";
    await expect(getBlob(a.blobId)).rejects.toThrow(/DRIVE_ENCRYPTION_KEYS/); // dit le remède, pas l'erreur GCM brute
    const b = await putBlob(contenu); garder(b.blobId); // redépôt « pour réparer »
    expect(b.blobId).not.toBe(a.blobId);
    expect((await getBlob(b.blobId))?.equals(contenu)).toBe(true);
    process.env.DRIVE_ENCRYPTION_KEYS = hex("secret-service-web"); // l'ancienne clé au trousseau
    expect((await getBlob(a.blobId))?.equals(contenu)).toBe(true);
    remettre();
  });

  it("B. une DRIVE_ENCRYPTION_KEY mal formée fait échouer l'écriture — rien n'est chiffré avec une clé de repli", async () => {
    process.env.DRIVE_ENCRYPTION_KEY = "a".repeat(63);
    const contenu = unique("cle");
    await expect(putBlob(contenu)).rejects.toThrow(/DRIVE_ENCRYPTION_KEY invalide/);
    expect(await prisma.fileBlob.count({ where: { sha256: crypto.createHash("sha256").update(contenu).digest("hex") } })).toBe(0);
    remettre();
  });

  it("un blob d'avant (sans keyId) se relit avec la clé active, prend son keyId, et n'est pas réemployé avant", async () => {
    const contenu = unique("ancien");
    const a = await putBlob(contenu); garder(a.blobId);
    await prisma.fileBlob.update({ where: { id: a.blobId }, data: { keyId: null } });
    const b = await putBlob(contenu); garder(b.blobId);
    expect(b.blobId).not.toBe(a.blobId); // clé inconnue : pas de réemploi
    expect((await getBlob(a.blobId))?.equals(contenu)).toBe(true); // toujours lisible

    const seul = unique("ancien-seul");
    const c = await putBlob(seul); garder(c.blobId);
    await prisma.fileBlob.update({ where: { id: c.blobId }, data: { keyId: null } });
    expect((await getBlob(c.blobId))?.equals(seul)).toBe(true);
    expect((await prisma.fileBlob.findUniqueOrThrow({ where: { id: c.blobId } })).keyId).toBe(lireTrousseau().active.id);
  });

  it("en production, un service à la clé divergente REFUSE d'écrire ; rétabli, il écrit de nouveau", async () => {
    const actif = lireTrousseau().active.id;
    expect((await verifierCleDriveAuDemarrage({ magasin: magasin("0123456789abcdef"), production: true })).etat).toBe("divergente");
    await expect(putBlob(unique("refus"))).rejects.toThrow(/refuse d'enregistrer/);
    expect((await verifierCleDriveAuDemarrage({ magasin: magasin(actif), production: true })).etat).toBe("ok");
    garder((await putBlob(unique("retabli"))).blobId);
  });

  it("E. corbeille Super Admin + double suppression concurrente de la pièce jointe : le fichier reste", async () => {
    const contenu = unique("pv");
    const key = `${TAG}/TASK/y__pv.pdf`;
    const s = await saveFile(key, contenu); garder(s.blobId);
    const p = await putBlob(contenu);
    expect(p.blobId).toBe(s.blobId); // même contenu, même clé : dédupliqué, refCount 2
    const node = await prisma.driveNode.create({
      data: { name: `${TAG}-pv.pdf`, type: "FILE", ownerId: userId, createdById: userId, size: 1, isTrashed: true, versions: { create: { blobId: p.blobId, version: 1, size: 1, createdById: userId } } },
      select: { id: true },
    });
    expect((await deleteNode(fd({ id: node.id }))).ok).toBe(true); // → corbeille Super Admin (lot JSON)
    const rec = await prisma.deletedRecord.findFirst({ where: { sourceId: node.id }, select: { id: true } });
    await prisma.deletedRecord.update({ where: { id: rec!.id }, data: { name: `${TAG}-recE` } });
    await Promise.allSettled([deleteFileByKey(key), deleteFileByKey(key)]);
    expect(await refCount(s.blobId)).toBe(1);
    expect((await getBlob(s.blobId))?.equals(contenu)).toBe(true);
  });

  it("deux deleteFileByKey concurrents ne rendent qu'UNE référence", async () => {
    const key = `${TAG}/DOC/z__deux.pdf`;
    const s = await saveFile(key, unique("deux")); garder(s.blobId);
    expect(await retainBlob(s.blobId)).toBe(true); // un autre détenteur
    await Promise.all([deleteFileByKey(key), deleteFileByKey(key), deleteFileByKey(key)]);
    expect(await refCount(s.blobId)).toBe(1);
  });

  it("F. un blob que SEULE une entrée de corbeille (JSON) tient survit à releaseBlob ; sa destruction le libère", async () => {
    const b = await putBlob(unique("seul-json")); garder(b.blobId);
    const rec = await prisma.deletedRecord.create({ data: { kind: "DRIVE_NODE", label: "x", name: `${TAG}-recF`, sourceId: "x", payload: {}, lot: { lignes: [{ modele: "FileVersion", donnees: { blobId: b.blobId } }] } } });
    await releaseBlob(b.blobId);
    expect(await prisma.fileBlob.findUnique({ where: { id: b.blobId } })).not.toBeNull();
    expect((await destroyDeletedRecord(fd({ id: rec.id }))).ok).toBe(true); // close, l'entrée ne tient plus rien
    expect(await prisma.fileBlob.findUnique({ where: { id: b.blobId } })).toBeNull();
  });

  it("deux destructions simultanées d'une entrée de corbeille ne libèrent qu'une fois", async () => {
    const key = `${TAG}/DOC/w__double.pdf`;
    const s = await saveFile(key, unique("double")); garder(s.blobId);
    expect(await retainBlob(s.blobId)).toBe(true); // la référence que tient l'entrée de corbeille
    const rec = await prisma.deletedRecord.create({ data: { kind: "DRIVE_NODE", label: "x", name: `${TAG}-recD`, sourceId: "x", payload: {}, lot: { lignes: [{ modele: "FileVersion", donnees: { blobId: s.blobId } }] } } });
    const r = await Promise.all([destroyDeletedRecord(fd({ id: rec.id })), destroyDeletedRecord(fd({ id: rec.id }))]);
    expect(r.filter((x) => x.ok).length).toBe(1);
    expect(await refCount(s.blobId)).toBe(1); // la pièce jointe garde la sienne
  });

  it("un échec d'écriture des tranches n'efface pas le blob qu'un dépôt concurrent du même contenu a obtenu", async () => {
    process.env.REG_BLOB_CHUNK_MB = "1";
    const contenu = crypto.randomBytes(Math.floor(2.5 * 1024 * 1024)); // > 1 Mo, incompressible → tranches
    const vrai = prisma.fileBlobChunk.create.bind(prisma.fileBlobChunk);
    let second: Awaited<ReturnType<typeof putBlob>> | null = null;
    let premier = true;
    const espion = vi.spyOn(prisma.fileBlobChunk, "create").mockImplementation(((args: Parameters<typeof vrai>[0]) => {
      if (!premier) return vrai(args);
      premier = false;
      // pendant la première tranche du premier dépôt, un second dépôt du même contenu arrive… puis le disque cède
      return (async () => { second = await putBlob(contenu); throw new Error("panne d'écriture"); })();
    }) as never);
    try {
      await expect(putBlob(contenu)).rejects.toThrow(/panne d'écriture/);
    } finally {
      espion.mockRestore();
      remettre();
    }
    expect(second).not.toBeNull();
    garder(second!.blobId);
    expect((await getBlob(second!.blobId))?.equals(contenu)).toBe(true);
    expect(await prisma.fileBlob.count({ where: { sha256: { startsWith: "ecriture:" }, keyId: lireTrousseau().active.id, size: contenu.length } })).toBe(0);
  });

  it("déplacements croisés simultanés : jamais de cycle, un seul passe", async () => {
    const dossier = (n: string) => prisma.driveNode.create({ data: { name: `${TAG}-${n}`, type: "FOLDER", ownerId: userId, createdById: userId }, select: { id: true } }).then((x) => x.id);
    const a = await dossier("A"), b = await dossier("B");
    const r = await Promise.all([moveNode(fd({ id: a, targetId: b })), moveNode(fd({ id: b, targetId: a }))]);
    expect(r.filter((x) => x.ok).length).toBe(1);
    for (const depart of [a, b]) {
      let cur: string | null = depart; const vus = new Set<string>();
      while (cur) {
        expect(vus.has(cur)).toBe(false);
        vus.add(cur);
        cur = (await prisma.driveNode.findUniqueOrThrow({ where: { id: cur }, select: { parentId: true } })).parentId;
      }
    }
  });

  it("un élément personnel sans propriétaire, à la corbeille, figure dans celle du Super Admin", async () => {
    const n = await prisma.driveNode.create({ data: { name: `${TAG}-orphelin.pdf`, type: "FILE", ownerId: null, createdById: userId, isTrashed: true }, select: { id: true } });
    const listing = await getDriveListing(ACTOR!, null, true);
    expect(listing?.nodes.some((x) => x.id === n.id)).toBe(true);
  });
});
