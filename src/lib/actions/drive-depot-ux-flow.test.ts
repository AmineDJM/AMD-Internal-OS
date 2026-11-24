import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { trashNodes, restoreNodes, restaurerVersionDrive, doublonsAuDepot } from "@/lib/actions/drive-actions";
import { enregistrerFichierDrive, refusDepotDrive } from "@/lib/drive/depot";
import { getDriveListing, compterDansLaCorbeille } from "@/lib/queries/drive";
import { POST as claim } from "@/app/api/drive/upload/claim/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drvux${Date.now()}__`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x);
  return f;
};
const blob = async () => putBlob(randomBytes(96));

/**
 * AUDIT DRIVE DU 24/11, SECTION C — ce que la personne voit d'un dépôt et d'une suppression, par les vrais points d'entrée :
 *   • C1 : UNE corbeille « ce que j'ai supprimé » (perso + catégories), avec « Supprimé de », lien masqué si inaccessible ;
 *   • C2 : « existe déjà ici » → nouvelle version, ou garder les deux (« (2) ») ;
 *   • C3 : restaurer une version = une NOUVELLE version au même contenu, l'historique intact ;
 *   • C10 : un refus de dépôt dit à qui demander ;
 *   • C16 : le dépôt instantané (claim) passe par les mêmes gardes et la même création.
 */
suite("Drive — dépôt et corbeille côté personne (audit C)", () => {
  let aId = "", mId = "", bId = "", spaceId = "", spaceName = "";
  let A: CurrentUser, M: CurrentUser, B: CurrentUser;
  let persoId = "", categorieId = "", dossierA = "";

  beforeAll(async () => {
    const mk = (n: string) => prisma.user.create({ data: { email: `${TAG}${n}@test.dz`, name: `${TAG} ${n}`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } });
    [aId, mId, bId] = [(await mk("a")).id, (await mk("m")).id, (await mk("b")).id];
    [A, M, B] = await Promise.all([actorFor(aId, "MEDICAL_DELEGATE"), actorFor(mId, "MEDICAL_DELEGATE"), actorFor(bId, "MEDICAL_DELEGATE")]);
    spaceName = `${TAG} Catégorie`;
    spaceId = (await prisma.driveSpace.create({ data: { name: spaceName, managerUserIds: [mId], accessUserIds: [aId] } })).id;

    const b1 = await blob();
    persoId = (await enregistrerFichierDrive(A, { parentId: null }, { blobId: b1.blobId, size: b1.size, mimeType: "application/pdf", name: "perso.pdf" })).id;
    const b2 = await blob();
    categorieId = (await enregistrerFichierDrive(M, { spaceId }, { blobId: b2.blobId, size: b2.size, mimeType: "application/pdf", name: "note.pdf" })).id;
    await prisma.driveShare.create({ data: { nodeId: categorieId, userId: aId, access: "EDIT" } });
    dossierA = (await prisma.driveNode.create({ data: { name: `${TAG} Dossier`, type: "FOLDER", ownerId: aId, createdById: aId } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = [aId, mId, bId].filter(Boolean);
    const blobs = (await prisma.fileVersion.findMany({ where: { node: { ownerId: { in: ids } } }, select: { blobId: true } })).map((v) => v.blobId);
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } });
    await prisma.fileBlob.deleteMany({ where: { id: { in: blobs }, versions: { none: {} } } }).catch(() => {});
    if (spaceId) await prisma.driveSpace.deleteMany({ where: { id: spaceId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } });
  });

  it("C1 — une seule corbeille : ce que J'AI supprimé, perso ET catégorie, avec d'où ; lien masqué si je ne peux plus ouvrir", async () => {
    ACTOR = A;
    const r = await trashNodes(fd({ id: [persoId, categorieId] }));
    expect(r).toMatchObject({ ok: true, done: 2 });

    const mienne = await getDriveListing(A, null, true);
    const perso = mienne?.nodes.find((n) => n.id === persoId);
    const cat = mienne?.nodes.find((n) => n.id === categorieId);
    expect(perso).toMatchObject({ supprimeDe: "Mes fichiers", ouvrable: true });
    expect(cat).toMatchObject({ supprimeDe: spaceName, ouvrable: false });
    expect(await compterDansLaCorbeille(A, "note")).toBe(1);

    // La corbeille de la catégorie reste aux gestionnaires ; la mienne n'est pas celle du gestionnaire.
    expect(await getDriveListing(A, null, true, spaceId)).toBeNull();
    expect((await getDriveListing(M, null, true))?.nodes.some((n) => n.id === categorieId)).toBe(false);
    expect((await getDriveListing(M, null, true, spaceId))?.nodes.some((n) => n.id === categorieId)).toBe(true);

    // Restaurer groupé : chacun revient à sa place.
    expect(await restoreNodes(fd({ id: [persoId, categorieId] }))).toMatchObject({ ok: true, done: 2 });
    expect(await prisma.driveNode.count({ where: { id: { in: [persoId, categorieId] }, isTrashed: false } })).toBe(2);
    expect((await getDriveListing(A, null, true))?.nodes.some((n) => [persoId, categorieId].includes(n.id))).toBe(false);
  });

  it("C2 — « existe déjà ici » : la question est posée, « Nouvelle version » met à jour, « Garder les deux » numérote", async () => {
    ACTOR = A;
    const v1 = await blob();
    const id = (await enregistrerFichierDrive(A, { parentId: dossierA }, { blobId: v1.blobId, size: v1.size, mimeType: "application/pdf", name: "contrat.pdf" })).id;
    expect((await doublonsAuDepot(dossierA, null, ["Contrat.pdf", "autre.pdf"])).noms).toEqual(["contrat.pdf"]);

    const v2 = await blob();
    const version = await enregistrerFichierDrive(A, { parentId: dossierA, siExiste: "version" }, { blobId: v2.blobId, size: v2.size, mimeType: "application/pdf", name: "contrat.pdf" });
    expect(version.id).toBe(id);
    expect(await prisma.fileVersion.count({ where: { nodeId: id } })).toBe(2);

    const v3 = await blob();
    const deux = await enregistrerFichierDrive(A, { parentId: dossierA, siExiste: "garder" }, { blobId: v3.blobId, size: v3.size, mimeType: "application/pdf", name: "contrat.pdf" });
    expect(deux.id).not.toBe(id);
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: deux.id } })).name).toBe("contrat (2).pdf");

    // Une version d'un autre type prend son extension : plus d'aperçu PDF d'un classeur.
    const v4 = await blob();
    await enregistrerFichierDrive(A, { nodeId: deux.id }, { blobId: v4.blobId, size: v4.size, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "Budget.xlsx" });
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: deux.id } })).name).toBe("contrat (2).xlsx");
  });

  it("C3 — restaurer une version crée une NOUVELLE version au même contenu ; rien n'est écrasé", async () => {
    ACTOR = A;
    const node = await prisma.driveNode.findFirstOrThrow({ where: { parentId: dossierA, name: "contrat.pdf" } });
    const v1 = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id, version: 1 } });
    const avant = (await prisma.fileBlob.findUniqueOrThrow({ where: { id: v1.blobId } })).refCount;

    const r = await restaurerVersionDrive(fd({ nodeId: node.id, version: "1" }));
    expect(r.ok, r.error).toBe(true);
    const versions = await prisma.fileVersion.findMany({ where: { nodeId: node.id }, orderBy: { version: "asc" } });
    expect(versions).toHaveLength(3);
    expect(versions[2].blobId).toBe(v1.blobId);
    expect(versions[1].blobId).not.toBe(v1.blobId); // la v2 est toujours là
    expect((await prisma.fileBlob.findUniqueOrThrow({ where: { id: v1.blobId } })).refCount).toBe(avant + 1);

    // Sans droit de modifier : refusé, avec le remède.
    ACTOR = B;
    const refus = await restaurerVersionDrive(fd({ nodeId: node.id, version: "2" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/demandez à son propriétaire/);
  });

  it("C10 — un refus de dépôt dit à qui demander l'accès", async () => {
    const dossier = await refusDepotDrive(B, { parentId: dossierA });
    expect(dossier?.status).toBe(403);
    expect(dossier?.error).toBe(`Vous ne pouvez pas déposer ici. Demandez l'accès à ${TAG} a.`);
    expect((await refusDepotDrive(B, { spaceId }))?.error).toContain(`${TAG} m`);
    expect(await refusDepotDrive(A, { parentId: dossierA })).toBeNull();
  });

  it("C16 — le dépôt instantané : mêmes gardes (type, droit), même création (version au choix)", async () => {
    ACTOR = A;
    const node = await prisma.driveNode.findFirstOrThrow({ where: { parentId: dossierA, name: "contrat.pdf" } });
    const courante = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id }, orderBy: { version: "desc" }, include: { blob: { select: { sha256: true } } } });
    const appel = (corps: Record<string, unknown>) => claim(new NextRequest("http://t/api/drive/upload/claim", { method: "POST", body: JSON.stringify(corps) }));

    const exe = await appel({ sha256: courante.blob.sha256, name: "outil.exe", size: 10, parentId: dossierA });
    expect(exe.status).toBe(400);

    ACTOR = B;
    expect((await appel({ sha256: courante.blob.sha256, name: "contrat.pdf", size: 10, parentId: dossierA })).status).toBe(403);

    ACTOR = A;
    const ok = await appel({ sha256: courante.blob.sha256, name: "contrat.pdf", size: 10, parentId: dossierA, siExiste: "version" });
    const corps = await ok.json() as { known: boolean; id: string; version?: number };
    expect(corps).toMatchObject({ known: true, id: node.id });
    expect(corps.version).toBe(courante.version + 1);
  });
});
