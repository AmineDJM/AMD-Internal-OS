import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { moveNode } from "@/lib/actions/drive-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__drivedeplace${Date.now()}__`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/**
 * DÉPLACER DANS LE DRIVE (audit du 27/10/2026, RH-DOCUMENTS-COMMS-06), par le vrai point d'entrée `moveNode` :
 *   • la destination est un DOSSIER hors corbeille — sous un fichier, l'élément disparaissait de toutes les listes ;
 *   • sortir un élément d'une catégorie exige d'en être gestionnaire — un simple partage EDIT la vidait.
 */
suite("Drive — moveNode : destination valide, sortie de catégorie gardée", () => {
  let ownerId = "", amiId = "", spaceId = "";
  let dossier = "", fichier = "", corbeille = "", element = "", pieceCategorie = "";

  beforeAll(async () => {
    const mk = (n: string) => prisma.user.create({ data: { email: `${TAG}${n}@t.dz`, name: `${TAG} ${n}`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } });
    ownerId = (await mk("owner")).id;
    amiId = (await mk("ami")).id;
    const n = (data: Record<string, unknown>) => prisma.driveNode.create({ data: { ownerId, createdById: ownerId, ...data } as never, select: { id: true } }).then((x) => x.id);
    dossier = await n({ name: `${TAG} D`, type: "FOLDER" });
    fichier = await n({ name: `${TAG} F.pdf`, type: "FILE", mimeType: "application/pdf" });
    corbeille = await n({ name: `${TAG} T`, type: "FOLDER", isTrashed: true });
    element = await n({ name: `${TAG} E.pdf`, type: "FILE", parentId: dossier, mimeType: "application/pdf" });
    const space = await prisma.driveSpace.create({ data: { name: `${TAG} RH`, managerUserIds: [ownerId], accessUserIds: [ownerId] } as never, select: { id: true } });
    spaceId = space.id;
    pieceCategorie = await n({ name: `${TAG} Contrat.pdf`, type: "FILE", spaceId, mimeType: "application/pdf" });
    await prisma.driveShare.create({ data: { nodeId: pieceCategorie, userId: amiId, access: "EDIT" } });
  });

  afterAll(async () => {
    await prisma.driveShare.deleteMany({ where: { node: { name: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.driveNode.updateMany({ where: { name: { startsWith: TAG } }, data: { parentId: null } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.driveSpace.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("refuse de ranger un élément sous un FICHIER ou sous un dossier à la corbeille", async () => {
    ACTOR = await actorFor(ownerId, "MEDICAL_DELEGATE");
    expect((await moveNode(fd({ id: element, targetId: fichier }))).ok).toBe(false);
    expect((await moveNode(fd({ id: element, targetId: corbeille }))).ok).toBe(false);
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: element } })).parentId).toBe(dossier);
  });

  it("un partage EDIT ne sort pas une pièce de sa catégorie ; le gestionnaire, si", async () => {
    ACTOR = await actorFor(amiId, "MEDICAL_DELEGATE");
    expect((await moveNode(fd({ id: pieceCategorie, targetId: "", spaceId: "" }))).ok).toBe(false);
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: pieceCategorie } })).spaceId).toBe(spaceId);

    ACTOR = await actorFor(ownerId, "MEDICAL_DELEGATE");
    expect((await moveNode(fd({ id: pieceCategorie, targetId: dossier }))).ok).toBe(true);
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: pieceCategorie } })).spaceId).toBeNull();
  });
});
