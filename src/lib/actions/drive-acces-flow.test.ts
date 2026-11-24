import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import type { CurrentUser } from "@/lib/session";

process.env.ONLYOFFICE_URL = "https://office.test";
process.env.ONLYOFFICE_JWT_SECRET = "secret-de-test-drive-acces";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR,
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { resolveDriveAccess } from "@/lib/drive";
import { getDriveListing } from "@/lib/queries/drive";
import { putBlob } from "@/lib/drive-storage";
import { saveFile } from "@/lib/storage";
import { createFolder, moveNode } from "@/lib/actions/drive-actions";
import { sendMessage } from "@/lib/actions/messaging-actions";
import { makeFileReadToken } from "@/lib/onlyoffice";
import { mirrorDocumentsToDrive, retirerCopiesDrive } from "@/lib/drive/document-mirror";
import { ensureDrivePath, putDriveFile } from "@/lib/drive/mirror";
import { importFolderPath } from "@/lib/drive/mirror-path";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { GET as fichierOnlyoffice } from "@/app/api/onlyoffice/file/route";

/**
 * L'AUDIT DU DRIVE DU 24/11 (section B — accès), par les vrais points d'entrée :
 *   F2 aucune copie d'une pièce sensible ; la copie suit la pièce à la corbeille ; la purge des copies déjà faites ;
 *   F3 joindre exige de pouvoir modifier ; aucun partage nominatif ; le droit tombe avec le message ;
 *   F4 /api/onlyoffice/file relit le droit du porteur, compte actif, version figée ;
 *   F5 un dossier créé chez autrui appartient au propriétaire ; on ne sort pas un élément de son arbre ;
 *   F9 une pièce CONFIDENTIELLE ne s'ouvre pas au simple lecteur de l'objet ;
 *   F11 un nœud à la corbeille n'existe que pour son propriétaire.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__drvacces${Date.now().toString(36)}_`;

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, access: await getAccess(id, u.role), mustChangePassword: false };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const lire = (token: string) => fichierOnlyoffice(new NextRequest(`http://localhost/api/onlyoffice/file?token=${encodeURIComponent(token)}`));

suite("Drive — accès (audit du 24/11, F2 F3 F4 F5 F9 F11)", () => {
  let proprio = "", editeur = "", lecteur = "", inactif = "";
  let dossier = "", fichier = "", conv = "";
  const ids = () => [proprio, editeur, lecteur, inactif];

  beforeAll(async () => {
    const mk = async (n: string, isActive = true) => (await prisma.user.create({
      data: { email: `${TAG}${n}@t.dz`, name: `${TAG}${n}`, role: "MEDICAL_DELEGATE", passwordHash: "x", isActive }, select: { id: true },
    })).id;
    proprio = await mk("proprio"); editeur = await mk("editeur"); lecteur = await mk("lecteur"); inactif = await mk("inactif", false);
    dossier = (await prisma.driveNode.create({ data: { name: `${TAG}Dossier`, type: "FOLDER", ownerId: proprio }, select: { id: true } })).id;
    const v1 = await putBlob(Buffer.from(`${TAG} version 1`));
    const v2 = await putBlob(Buffer.from(`${TAG} version 2`));
    fichier = (await prisma.driveNode.create({
      data: {
        name: `${TAG}note.docx`, type: "FILE", parentId: dossier, ownerId: proprio, mimeType: "application/octet-stream",
        versions: { create: [{ blobId: v1.blobId, version: 1, size: v1.size }, { blobId: v2.blobId, version: 2, size: v2.size }] },
      },
      select: { id: true },
    })).id;
    await prisma.driveShare.createMany({ data: [
      { nodeId: dossier, userId: editeur, access: "EDIT" },
      { nodeId: dossier, userId: lecteur, access: "VIEW" },
      { nodeId: dossier, userId: inactif, access: "VIEW" },
    ] });
    conv = (await prisma.conversation.create({
      data: { type: "GROUP", title: `${TAG}Fil`, createdById: proprio, members: { create: [{ userId: proprio, role: "OWNER" }, { userId: lecteur }, { userId: editeur }] } },
      select: { id: true },
    })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { id: conv } }).catch(() => {});
    await prisma.driveShare.deleteMany({ where: { userId: { in: ids() } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids() } } }).catch(() => {});
    await prisma.driveNode.updateMany({ where: { ownerId: { in: ids() } }, data: { parentId: null } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids() } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { uploadedById: { in: ids() } } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("F3 — un simple lecteur ne joint pas le fichier ; le propriétaire, si, sans poser de partage nominatif", async () => {
    ACTOR = await acteur(lecteur);
    const refus = await sendMessage(fd({ conversationId: conv, body: "voici", driveRefs: JSON.stringify([fichier]) }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toContain("seul son propriétaire ou un éditeur");

    ACTOR = await acteur(proprio);
    const avant = await prisma.driveShare.count({ where: { nodeId: fichier } });
    const envoi = await sendMessage(fd({ conversationId: conv, body: "la note", driveRefs: JSON.stringify([fichier]) }));
    expect(envoi.ok).toBe(true);
    expect(await prisma.driveShare.count({ where: { nodeId: fichier } })).toBe(avant);

    // Le droit dérivé tombe avec le message : un membre sans autre droit ne lit plus.
    const membreSansDroit = editeur;
    await prisma.driveShare.deleteMany({ where: { nodeId: dossier, userId: membreSansDroit } });
    const editeurSession = await acteur(membreSansDroit);
    expect(await resolveDriveAccess(editeurSession, fichier)).toBe("VIEW");
    // Ce qu'on a reçu se retrouve à la racine de « Mes fichiers », comme un partage.
    expect((await getDriveListing(editeurSession, null, false))?.nodes.map((n) => n.id)).toContain(fichier);
    await prisma.message.update({ where: { id: envoi.message!.id }, data: { deletedAt: new Date() } });
    expect(await resolveDriveAccess(editeurSession, fichier)).toBe("NONE");
    expect((await getDriveListing(editeurSession, null, false))?.nodes.map((n) => n.id)).not.toContain(fichier);
    await prisma.driveShare.create({ data: { nodeId: dossier, userId: editeur, access: "EDIT" } });
  });

  it("F5 — un dossier créé chez autrui appartient au propriétaire ; l'éditeur range dans son arbre, ne l'en sort pas", async () => {
    ACTOR = await acteur(editeur);
    const cree = await createFolder(undefined, fd({ name: `${TAG}Sous`, parentId: dossier }));
    expect(cree.ok).toBe(true);
    const sous = await prisma.driveNode.findUniqueOrThrow({ where: { id: cree.id! }, select: { ownerId: true } });
    expect(sous.ownerId).toBe(proprio);

    const sortie = await moveNode(fd({ id: fichier, targetId: "" }));
    expect(sortie.ok).toBe(false);
    expect(sortie.error).toContain("Seul le propriétaire");
    expect((await moveNode(fd({ id: fichier, targetId: cree.id! }))).ok).toBe(true);
    ACTOR = await acteur(proprio);
    expect((await moveNode(fd({ id: fichier, targetId: dossier }))).ok).toBe(true);
  });

  it("F4 — le fichier servi au Document Server : version figée, droit relu, compte actif", async () => {
    const v1 = await lire(makeFileReadToken(fichier, proprio, undefined, 1));
    expect(v1.status).toBe(200);
    expect(Buffer.from(await v1.arrayBuffer()).toString()).toBe(`${TAG} version 1`);
    const derniere = await lire(makeFileReadToken(fichier, proprio));
    expect(Buffer.from(await derniere.arrayBuffer()).toString()).toBe(`${TAG} version 2`);

    expect((await lire(makeFileReadToken(fichier, lecteur, undefined, 2))).status).toBe(200);
    expect((await lire(makeFileReadToken(fichier, inactif, undefined, 2))).status).toBe(404);
    const jeton = makeFileReadToken(fichier, lecteur, undefined, 2);
    await prisma.driveShare.deleteMany({ where: { nodeId: dossier, userId: lecteur } });
    expect((await lire(jeton)).status).toBe(404); // droit retiré après l'émission du jeton
    await prisma.driveShare.create({ data: { nodeId: dossier, userId: lecteur, access: "VIEW" } });
  });

  it("F11 — à la corbeille, le nœud n'existe plus que pour son propriétaire (ni partage, ni éditeur Office)", async () => {
    await prisma.driveNode.update({ where: { id: fichier }, data: { isTrashed: true } });
    expect(await resolveDriveAccess(await acteur(lecteur), fichier)).toBe("NONE");
    expect(await resolveDriveAccess(await acteur(editeur), fichier)).toBe("NONE");
    expect(await resolveDriveAccess(await acteur(proprio), fichier)).toBe("EDIT");
    expect((await lire(makeFileReadToken(fichier, lecteur, undefined, 2))).status).toBe(404);
    await prisma.driveNode.update({ where: { id: fichier }, data: { isTrashed: false } });
  });

  it("F9 — une pièce CONFIDENTIELLE ne s'ouvre pas au simple lecteur de l'objet ; au déposant, si", async () => {
    const tache = await prisma.task.create({ data: { title: `${TAG}Tâche`, createdById: proprio, readerIds: [lecteur] } as never, select: { id: true } });
    const doc = (confidentiality: "INTERNAL" | "CONFIDENTIAL") => prisma.document.create({
      data: { name: `${TAG}${confidentiality}.pdf`, entityType: "TASK", entityId: tache.id, confidentiality, uploadedById: proprio },
      select: { id: true, entityType: true, entityId: true, stepKey: true },
    });
    const interne = await doc("INTERNAL");
    const confidentiel = await doc("CONFIDENTIAL");
    const l = await acteur(lecteur);
    expect(await peutOuvrirDocument(l, interne)).toBe(true);
    expect(await peutOuvrirDocument(l, confidentiel)).toBe(false);
    expect(await peutOuvrirDocument(await acteur(proprio), confidentiel)).toBe(true);
  });

  it("F2 — aucune copie d'une pièce sensible ; la copie d'une pièce interne suit la pièce à la corbeille", async () => {
    const octets = Buffer.from(`${TAG} devis interne`);
    const sensible = Buffer.from(`${TAG} cas de pharmacovigilance`);
    await mirrorDocumentsToDrive({ ownerId: proprio, entityType: "PHARMACOVIGILANCE_CASE", entityId: TAG, confidentiality: "CONFIDENTIAL", files: [{ name: "cas.pdf", data: sensible }] });
    await mirrorDocumentsToDrive({ ownerId: proprio, entityType: "SPONSORING", entityId: TAG, confidentiality: "RESTRICTED", files: [{ name: "restreint.pdf", data: sensible }] });
    expect(await prisma.driveNode.count({ where: { ownerId: proprio, name: { in: ["cas.pdf", "restreint.pdf"] } } })).toBe(0);

    const cle = `TEST/${TAG}/devis`;
    await saveFile(cle, octets);
    const piece = await prisma.document.create({
      data: { name: "devis.pdf", entityType: "SPONSORING", entityId: TAG, fileKey: cle, confidentiality: "INTERNAL", uploadedById: proprio },
    });
    await mirrorDocumentsToDrive({ ownerId: proprio, entityType: "SPONSORING", entityId: TAG, confidentiality: "INTERNAL", files: [{ name: "devis.pdf", data: octets }] });
    const copie = await prisma.driveNode.findFirstOrThrow({ where: { ownerId: proprio, name: "devis.pdf", type: "FILE" }, select: { id: true } });
    expect(await retirerCopiesDrive(piece)).toBe(1);
    expect((await prisma.driveNode.findUniqueOrThrow({ where: { id: copie.id } })).isTrashed).toBe(true);
  });

  it("F2 — la migration met à la corbeille les copies déjà faites d'une pièce sensible, une seule fois", async () => {
    const octets = Buffer.from(`${TAG} pièce pv déjà copiée`);
    const cle = `TEST/${TAG}/pv`;
    await saveFile(cle, octets);
    await prisma.document.create({
      data: { name: "pv.pdf", entityType: "PHARMACOVIGILANCE_CASE", entityId: TAG, fileKey: cle, confidentiality: "CONFIDENTIAL", uploadedById: proprio },
    });
    // La copie telle que l'ancien miroir la faisait, et un fichier ordinaire au même contenu hors du miroir.
    const boite = (await ensureDrivePath(importFolderPath("PHARMACOVIGILANCE_CASE", null, TAG), proprio))!;
    await putDriveFile({ parentId: boite, name: "pv.pdf", data: octets, ownerId: proprio });
    await putDriveFile({ parentId: dossier, name: "pv-classé.pdf", data: octets, ownerId: proprio });
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20270247200000_drive_copies_confidentielles/migration.sql"), "utf8");
    await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe(sql);

    const copie = await prisma.driveNode.findFirstOrThrow({ where: { ownerId: proprio, name: "pv.pdf" }, select: { id: true, isTrashed: true } });
    expect(copie.isTrashed).toBe(true);
    expect((await prisma.driveNode.findFirstOrThrow({ where: { ownerId: proprio, name: "pv-classé.pdf" } })).isTrashed).toBe(false);
    expect(await prisma.auditLog.count({ where: { entityId: copie.id, module: "Drive", field: "isTrashed" } })).toBe(1);
  });
});
