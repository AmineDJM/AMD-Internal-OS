import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob, getBlob } from "@/lib/drive-storage";
import { trashNode, restoreNode, deleteNode } from "@/lib/actions/drive-actions";
import { restoreDeletedRecord, destroyDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { corbeillePermise } from "@/lib/suppression/delegation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__drivecorbeille__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SUPPRESSION DU DRIVE RESTE TOUJOURS RÉCUPÉRABLE (Direction, 10/2026) — par les VRAIS points d'entrée.
 *
 * « Quand je supprime, il doit toujours être récupérable soit dans la corbeille du Drive, et aussi, quand il est
 * supprimé de la corbeille du Drive, il est toujours récupérable par la corbeille du Super Admin. »
 *
 * Ce que chaque cas fait tomber :
 *   • la corbeille du Drive rend l'élément à sa place ;
 *   • « Supprimer définitivement » depuis la corbeille du Drive N'EFFACE PLUS RIEN : un dossier, son fichier, ses
 *     versions, ses partages, ses commentaires passent dans la corbeille du Super Admin, et les OCTETS restent ;
 *   • le propriétaire (non Super Admin) ne voit ni ne restaure cette corbeille ;
 *   • le Super Admin restaure TOUT, de retour dans le Drive (hors corbeille), contenu lisible ;
 *   • seule la destruction réelle, chez le Super Admin, rend les octets.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Drive — corbeille du Drive, puis corbeille du Super Admin", () => {
  let saId = "", ownerId = "", amiId = "";
  let dossierId = "", fichierId = "", blobId = "";
  const contenu = randomBytes(64);

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { email: `${TAG}${n}@test.dz`, name: `${TAG} ${n}`, role, passwordHash: "x" }, select: { id: true } });
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    ownerId = (await mk("owner", "MEDICAL_DELEGATE")).id;
    amiId = (await mk("ami", "MEDICAL_DELEGATE")).id;

    const dossier = await prisma.driveNode.create({ data: { name: `${TAG} Dossier`, type: "FOLDER", ownerId, createdById: ownerId }, select: { id: true } });
    dossierId = dossier.id;
    const blob = await putBlob(contenu);
    blobId = blob.blobId;
    const fichier = await prisma.driveNode.create({
      data: { name: `${TAG} Plan.xlsx`, type: "FILE", parentId: dossierId, ownerId, createdById: ownerId, size: contenu.length, mimeType: "application/octet-stream" },
      select: { id: true },
    });
    fichierId = fichier.id;
    await prisma.fileVersion.create({ data: { nodeId: fichierId, blobId, version: 1, size: contenu.length, createdById: ownerId } });
    await prisma.driveShare.create({ data: { nodeId: fichierId, userId: amiId, access: "EDIT" } });
    await prisma.driveComment.create({ data: { nodeId: fichierId, authorId: amiId, body: `${TAG} remise à revoir` } });
  });

  afterAll(async () => {
    const ids = [saId, ownerId, amiId].filter(Boolean);
    await prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } });
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } });
    if (blobId) await prisma.fileBlob.deleteMany({ where: { id: blobId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("la corbeille du Drive rend l'élément à sa place", async () => {
    ACTOR = await actorFor(ownerId, "MEDICAL_DELEGATE");
    expect((await trashNode(fd({ id: dossierId }))).ok).toBe(true);
    expect(await prisma.driveNode.count({ where: { id: { in: [dossierId, fichierId] }, isTrashed: true } })).toBe(2);
    expect((await restoreNode(fd({ id: dossierId }))).ok).toBe(true);
    expect(await prisma.driveNode.count({ where: { id: { in: [dossierId, fichierId] }, isTrashed: false } })).toBe(2);
  });

  it("supprimer depuis la corbeille du Drive n'efface rien : tout passe dans la corbeille du Super Admin, octets compris", async () => {
    ACTOR = await actorFor(ownerId, "MEDICAL_DELEGATE");
    await trashNode(fd({ id: dossierId }));
    const r = await deleteNode(fd({ id: dossierId }));
    expect(r.ok, r.error).toBe(true);

    expect(await prisma.driveNode.count({ where: { id: { in: [dossierId, fichierId] } } })).toBe(0);
    const rec = await prisma.deletedRecord.findFirst({ where: { kind: "DRIVE_NODE", sourceId: dossierId, restoredAt: null, purgedAt: null } });
    expect(rec).not.toBeNull();
    const modeles = ((rec!.lot as { lignes: { modele: string }[] }).lignes).map((l) => l.modele);
    for (const m of ["DriveNode", "FileVersion", "DriveShare", "DriveComment"]) expect(modeles, m).toContain(m);
    // Les octets sont toujours là, et toujours tenus : rien n'a été libéré.
    const blob = await prisma.fileBlob.findUnique({ where: { id: blobId }, select: { refCount: true } });
    expect(blob?.refCount).toBe(1);
    expect((await getBlob(blobId))?.equals(contenu)).toBe(true);
  });

  it("le propriétaire, non Super Admin, ne voit ni ne restaure la corbeille du Super Admin", async () => {
    const owner = await actorFor(ownerId, "MEDICAL_DELEGATE");
    expect(corbeillePermise(owner, "DRIVE_NODE")).toBe(false);
    ACTOR = owner;
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DRIVE_NODE", sourceId: dossierId, restoredAt: null } });
    const r = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(r.ok).toBe(false);
    expect(await prisma.driveNode.count({ where: { id: dossierId } })).toBe(0);
  });

  it("le Super Admin restaure TOUT, de retour dans le Drive : dossier, fichier, version lisible, partage, commentaire", async () => {
    const sa = await actorFor(saId, "SUPER_ADMIN");
    expect(corbeillePermise(sa, "DRIVE_NODE")).toBe(true);
    ACTOR = sa;
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DRIVE_NODE", sourceId: dossierId, restoredAt: null } });
    const r = await restoreDeletedRecord(fd({ id: rec.id }));
    expect(r.ok, r.error).toBe(true);

    const nodes = await prisma.driveNode.findMany({ where: { id: { in: [dossierId, fichierId] } }, select: { id: true, isTrashed: true, parentId: true } });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => !n.isTrashed)).toBe(true);
    expect(nodes.find((n) => n.id === fichierId)?.parentId).toBe(dossierId);
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: fichierId } });
    expect((await getBlob(v.blobId))?.equals(contenu)).toBe(true);
    expect(await prisma.driveShare.count({ where: { nodeId: fichierId, userId: amiId, access: "EDIT" } })).toBe(1);
    expect(await prisma.driveComment.count({ where: { nodeId: fichierId } })).toBe(1);
  });

  it("seule la destruction réelle, chez le Super Admin, rend les octets", async () => {
    ACTOR = await actorFor(ownerId, "MEDICAL_DELEGATE");
    await trashNode(fd({ id: dossierId }));
    expect((await deleteNode(fd({ id: dossierId }))).ok).toBe(true);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { kind: "DRIVE_NODE", sourceId: dossierId, restoredAt: null, purgedAt: null } });

    // Le propriétaire ne détruit pas.
    expect((await destroyDeletedRecord(fd({ id: rec.id }))).ok).toBe(false);

    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    expect((await destroyDeletedRecord(fd({ id: rec.id }))).ok).toBe(true);
    // Plus aucun détenteur : le contenu est libéré.
    expect(await prisma.fileBlob.count({ where: { id: blobId } })).toBe(0);
  });
});
