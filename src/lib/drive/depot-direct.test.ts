import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GROS FICHIERS DU DRIVE, ENVOYÉS DIRECTEMENT AU BUCKET — par les VRAIES fonctions serveur, sur
 * la base réelle, avec un bucket SIMULÉ (aucun appel réseau).
 *
 *   • reprise : le même fichier relancé retrouve son envoi, seules les parties manquantes repartent ;
 *   • finalisation : incomplet → nommé et reprenable ; complet → un fichier au Drive, une seule
 *     fois même finalisé deux fois ; l'objet est désigné comme « déposé en direct » ;
 *   • droits : déposer dans le dossier d'un autre est refusé, à l'ouverture ET à la finalisation ;
 *   • sans stockage objet : refus qui NOMME les variables à poser, rien n'est écrit.
 * L'acteur est un délégué SANS vue globale.
 */

const ENV = { S3_ENDPOINT: "https://compte.r2.cloudflarestorage.com", S3_BUCKET: "test", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;

import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import type { ClientS3Direct } from "@/lib/storage/televersement-direct";
import type { PartieRecue } from "@/lib/storage/object-storage";
import { ouvrirDepotDirect, finaliserDepotDirect, abandonnerDepotDirect } from "./depot-direct";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__direct__${Date.now()}`;
const MO = 1024 * 1024;
let moi: SessionUser;
let autreDossier = "";
const ids: string[] = [];

/** Bucket simulé : ce qu'il a reçu, ce qu'il a recollé, ce qu'il a abandonné. */
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

suite("Drive — envoi direct au bucket", () => {
  beforeAll(async () => {
    const [u, autre] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
      prisma.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    ids.push(u.id, autre.id);
    moi = { id: u.id, name: u.name, email: u.email, role: "MEDICAL_DELEGATE", secondaryRole: null, access: await getAccess(u.id, "MEDICAL_DELEGATE") } as SessionUser;
    autreDossier = (await prisma.driveNode.create({ data: { name: `${TAG}-dossier-autre`, type: "FOLDER", ownerId: autre.id, createdById: autre.id } })).id;
  }, 60_000);

  afterAll(async () => {
    const nodes = await prisma.driveNode.findMany({ where: { name: { startsWith: TAG } }, select: { id: true, versions: { select: { blobId: true } } } });
    await retirerNoeudsDriveEtContenu({ where: { id: { in: nodes.map((n) => n.id) } } });
    await prisma.fileBlob.deleteMany({ where: { id: { in: nodes.flatMap((n) => n.versions.map((v) => v.blobId)) } } });
    await prisma.directUpload.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }, 60_000);

  const entree = (nom: string, taille: number, cible = {}) => ({ nom, taille, type: "application/zip", modifieLe: 1_700_000_000_000, cible });

  it("ouvre, REPREND (seules les parties manquantes repartent), refuse l'incomplet, finalise UNE fois", async () => {
    const { client, etat } = bucket();
    const total = 70 * MO;
    const a = await ouvrirDepotDirect(moi, entree(`${TAG}-ctd.zip`, total), client);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.repris).toBe(false);
    expect(a.plan.nbParties).toBe(3);
    expect(Object.keys(a.plan.urls)).toHaveLength(3);

    // Coupure après deux parties. Le même fichier, relancé : même envoi, une seule partie à envoyer.
    etat.recues = [{ numero: 1, etag: '"a"', taille: 32 * MO }, { numero: 2, etag: '"b"', taille: 32 * MO }];
    const b = await ouvrirDepotDirect(moi, entree(`${TAG}-ctd.zip`, total), client);
    expect(b.ok && b.repris && b.sessionId === a.sessionId).toBe(true);
    if (!b.ok) return;
    expect(Object.keys(b.plan.urls).map(Number)).toEqual([3]);

    // Finaliser trop tôt : nommé, reprenable, rien au Drive.
    const tot = await finaliserDepotDirect(moi, a.sessionId, client);
    expect(tot).toMatchObject({ ok: false, reprendre: true, manquantes: [3] });
    expect(await prisma.driveNode.count({ where: { name: `${TAG}-ctd.zip` } })).toBe(0);

    // Tout est là : un fichier au Drive, l'objet désigné comme déposé en direct.
    etat.recues.push({ numero: 3, etag: '"c"', taille: 6 * MO });
    etat.taille = total;
    const f = await finaliserDepotDirect(moi, a.sessionId, client);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: f.id }, select: { blob: { select: { iv: true, storageKey: true, size: true } } } });
    expect(v.blob.iv.length).toBe(0);
    expect(v.blob.storageKey).toMatch(new RegExp(`^direct/${moi.id}/`));
    expect(v.blob.size).toBe(total);
    // Rejouée (relance réseau) : le même fichier, pas un second.
    const g = await finaliserDepotDirect(moi, a.sessionId, client);
    expect(g).toEqual({ ok: true, id: f.id });
    expect(await prisma.driveNode.count({ where: { name: `${TAG}-ctd.zip` } })).toBe(1);
  });

  it("une taille finale fausse est refusée et l'envoi est abandonné — aucun fichier tronqué au Drive", async () => {
    const { client, etat } = bucket();
    const total = 10 * MO;
    const a = await ouvrirDepotDirect(moi, entree(`${TAG}-tronque.zip`, total), client);
    if (!a.ok) throw new Error(a.error);
    etat.recues = [{ numero: 1, etag: '"a"', taille: total }];
    etat.taille = total - 1;
    const f = await finaliserDepotDirect(moi, a.sessionId, client);
    expect(f.ok).toBe(false);
    expect(await prisma.driveNode.count({ where: { name: `${TAG}-tronque.zip` } })).toBe(0);
    expect((await prisma.directUpload.findUniqueOrThrow({ where: { id: a.sessionId } })).status).toBe("ABORTED");
  });

  it("déposer dans le dossier d'un autre est REFUSÉ dès l'ouverture", async () => {
    const r = await ouvrirDepotDirect(moi, entree(`${TAG}-intrus.zip`, 30 * MO, { parentId: autreDossier }), bucket().client);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("un zip de 6 Go est ACCEPTÉ à l'ouverture, un fichier de plus de 10 Go est refusé en le disant", async () => {
    const ok = await ouvrirDepotDirect(moi, entree(`${TAG}-gros.zip`, 6 * 1024 * MO), bucket().client);
    expect(ok).toMatchObject({ ok: true });
    const refus = await ouvrirDepotDirect(moi, entree(`${TAG}-enorme.zip`, 10 * 1024 * MO + 1), bucket().client);
    // Refusé par le plafond réglé (10 240 Mo par défaut) ou, à défaut, par la borne de 10 Go : jamais ouvert.
    expect(refus.ok).toBe(false);
    expect([400, 413]).toContain((refus as { status: number }).status);
    expect((refus as { error: string }).error).toMatch(/10 Go|10\s?240|Mo/);
  });

  it("« Annuler » libère les parties dans le bucket", async () => {
    const { client, etat } = bucket();
    const a = await ouvrirDepotDirect(moi, entree(`${TAG}-annule.zip`, 40 * MO), client);
    if (!a.ok) throw new Error(a.error);
    await abandonnerDepotDirect(moi, a.sessionId, client);
    expect(etat.abandonne).toBe(true);
    expect((await prisma.directUpload.findUniqueOrThrow({ where: { id: a.sessionId } })).status).toBe("ABORTED");
  });

  it("sans stockage objet : refus qui NOMME les variables à poser, rien n'est ouvert", async () => {
    const sauve = process.env.S3_ENDPOINT;
    delete process.env.S3_ENDPOINT;
    try {
      const r = await ouvrirDepotDirect(moi, entree(`${TAG}-sans.zip`, 3000 * MO), bucket().client);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
      expect(await prisma.directUpload.count({ where: { fileName: `${TAG}-sans.zip` } })).toBe(0);
    } finally { process.env.S3_ENDPOINT = sauve; }
  });
});
