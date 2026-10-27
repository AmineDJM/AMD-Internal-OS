import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { resolveDriveAccess } from "@/lib/drive";
import { getDriveListing } from "@/lib/queries/drive";

/**
 * UNE PIÈCE DU DRIVE JOINTE À UN MESSAGE S'OUVRE POUR CHAQUE MEMBRE DU FIL — y compris celui qui
 * y entre APRÈS l'envoi (ajouté à un groupe, canal rejoint). Avant (Direction, 27/10) : la lecture
 * n'était accordée qu'aux membres présents à l'envoi ; le nouveau venu voyait la pièce et recevait
 * un refus. Quitter le fil, ou retirer le message, referme la porte ; un non-membre reste dehors.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__drmsg_${Date.now().toString(36)}_`;
let expediteur: SessionUser;
let present: SessionUser;
let nouveau: SessionUser;
let etranger: SessionUser;
let convId: string;
let messageId: string;
let lotId: string;
let fichierId: string;
let dossierEspaceId: string;
let fichierEspaceId: string;
let espaceId: string;

async function compte(nom: string): Promise<SessionUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, role: u.role, secondaryRole: access.secondaryRole, access };
}

suite("Drive — pièce jointe à un message : la lecture suit l'appartenance au fil", () => {
  beforeAll(async () => {
    expediteur = await compte("expediteur");
    present = await compte("present");
    nouveau = await compte("nouveau");
    etranger = await compte("etranger");

    // Le lot de l'envoi, dans le Drive PERSONNEL de l'expéditeur : Messagerie / Fil / Envoi du…
    const racine = await prisma.driveNode.create({ data: { name: `${TAG}Messagerie`, type: "FOLDER", ownerId: expediteur.id } });
    const lot = await prisma.driveNode.create({ data: { name: `${TAG}Envoi`, type: "FOLDER", parentId: racine.id, ownerId: expediteur.id } });
    lotId = lot.id;
    fichierId = (await prisma.driveNode.create({ data: { name: `${TAG}note.docx`, type: "FILE", parentId: lot.id, ownerId: expediteur.id } })).id;

    // Une catégorie que le destinataire ne voit pas.
    espaceId = (await prisma.driveSpace.create({ data: { name: `${TAG}Promotion`, accessUserIds: [expediteur.id] } })).id;
    dossierEspaceId = (await prisma.driveNode.create({ data: { name: `${TAG}Liasse`, type: "FOLDER", spaceId: espaceId, ownerId: expediteur.id } })).id;
    fichierEspaceId = (await prisma.driveNode.create({ data: { name: `${TAG}fiche.pdf`, type: "FILE", parentId: dossierEspaceId, spaceId: espaceId, ownerId: expediteur.id } })).id;

    convId = (await prisma.conversation.create({
      data: { type: "GROUP", title: `${TAG}Groupe`, createdById: expediteur.id, members: { create: [{ userId: expediteur.id, role: "OWNER" }, { userId: present.id }] } },
    })).id;
    messageId = (await prisma.message.create({
      data: {
        conversationId: convId, senderId: expediteur.id, kind: "FILE", body: "",
        attachments: { create: [
          { driveNodeId: lotId, isFolder: true, name: "Envoi", mime: "inode/directory", size: 0 },
          { driveNodeId: dossierEspaceId, isFolder: true, name: "Liasse", mime: "inode/directory", size: 0 },
        ] },
      },
    })).id;
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { id: convId } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.driveSpace.deleteMany({ where: { id: espaceId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un membre présent lit le fichier du lot partagé — un non-membre, non", async () => {
    expect(await resolveDriveAccess(present, fichierId)).toBe("VIEW");
    expect(await resolveDriveAccess(etranger, fichierId)).toBe("NONE");
  });

  it("ajouté APRÈS l'envoi : il ouvre la pièce (c'était le refus signalé)", async () => {
    expect(await resolveDriveAccess(nouveau, fichierId)).toBe("NONE");
    await prisma.conversationMember.create({ data: { conversationId: convId, userId: nouveau.id } });
    expect(await resolveDriveAccess(nouveau, fichierId)).toBe("VIEW");
    expect(await resolveDriveAccess(nouveau, lotId)).toBe("VIEW");
  });

  it("le dossier d'une catégorie qu'on ne voit pas s'ouvre dans « Drive », fil d'Ariane sans les parents privés", async () => {
    expect(await resolveDriveAccess(present, fichierEspaceId)).toBe("VIEW");
    const liste = await getDriveListing(present, dossierEspaceId, false, null);
    expect(liste?.nodes.map((n) => n.id)).toEqual([fichierEspaceId]);
    const lot = await getDriveListing(present, lotId, false, null);
    expect(lot?.breadcrumb.map((c) => c.id)).toEqual([lotId]); // pas « Messagerie » de l'expéditeur
    // Par l'onglet d'une catégorie qu'il ne voit pas : toujours non.
    expect(await getDriveListing(present, dossierEspaceId, false, espaceId)).toBeNull();
  });

  it("quitter le fil, ou retirer le message, referme la porte", async () => {
    await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: convId, userId: nouveau.id } }, data: { leftAt: new Date() } });
    expect(await resolveDriveAccess(nouveau, fichierId)).toBe("NONE");
    await prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
    expect(await resolveDriveAccess(present, fichierId)).toBe("NONE");
  });
});
