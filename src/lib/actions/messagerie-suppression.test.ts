import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { mapMessage, messageInclude, type MessageRow } from "@/lib/queries/messaging";
import { deleteMessage } from "./messaging-actions";
import { superAdminDelete, restoreDeletedRecord } from "./admin-delete-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__msgdel__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UN MESSAGE, UN GROUPE, UNE NOTIFICATION — par les VRAIES portes.
 *
 * On n'injecte aucun état intermédiaire : on appelle `deleteMessage` et `superAdminDelete`,
 * c'est-à-dire exactement ce que déclenchent le bouton de la conversation et celui de
 * l'administration. Un banc qui écrirait `deletedAt` lui-même ne dirait rien du chemin
 * emprunté par l'écran (§118.14).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Messagerie & notifications — la suppression du Super Admin", () => {
  let adminId = "", membreId = "", autreId = "";
  let groupeId = "", directId = "", messageId = "", notifId = "";

  beforeAll(async () => {
    const mkUser = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [admin, membre, autre] = await Promise.all([
      mkUser("admin", "SUPER_ADMIN"),
      mkUser("membre", "MEDICAL_DELEGATE"),
      mkUser("autre", "MEDICAL_DELEGATE"),
    ]);
    adminId = admin.id; membreId = membre.id; autreId = autre.id;

    // Un GROUPE dont le Super Admin n'est PAS membre : c'est le cas qui comptait.
    const groupe = await prisma.conversation.create({
      data: {
        type: "GROUP", title: `${TAG}Comité produit`, createdById: membreId,
        members: { create: [{ userId: membreId, role: "OWNER" }, { userId: autreId, role: "MEMBER" }] },
      },
    });
    groupeId = groupe.id;
    const msg = await prisma.message.create({
      data: { conversationId: groupeId, senderId: membreId, body: `${TAG} message à modérer` },
    });
    messageId = msg.id;

    // Un TÊTE-À-TÊTE, que le registre doit REFUSER de supprimer.
    const direct = await prisma.conversation.create({
      data: {
        type: "DIRECT", createdById: membreId,
        members: { create: [{ userId: membreId, role: "MEMBER" }, { userId: autreId, role: "MEMBER" }] },
      },
    });
    directId = direct.id;

    const notif = await prisma.notification.create({
      data: { userId: membreId, title: `${TAG}Échéance dossier`, body: "à supprimer", link: "/regulatory" },
    });
    notifId = notif.id;
  });

  afterAll(async () => {
    await prisma.deletedRecord.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { summary: { contains: TAG } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: { in: [groupeId, directId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un membre ordinaire ne retire pas le message d'un collègue", async () => {
    ACTOR = await actorFor(autreId, "MEDICAL_DELEGATE");
    const fd = new FormData(); fd.set("id", messageId);
    const r = await deleteMessage(fd);
    expect(r.ok).toBe(false);
    const apres = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { deletedAt: true } });
    expect(apres.deletedAt).toBeNull();
  });

  it("le Super Admin retire un message d'un groupe dont il n'est PAS membre, et le corps cesse d'être servi", async () => {
    // La prémisse se VÉRIFIE : sans elle, le cas passerait au vert pour la mauvaise raison
    // (§118.104) — il faut qu'il n'ait ni appartenance ni paternité.
    const appartenance = await prisma.conversationMember.findFirst({ where: { userId: adminId, conversationId: groupeId } });
    expect(appartenance).toBeNull();
    const msgAvant = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { senderId: true } });
    expect(msgAvant.senderId).not.toBe(adminId);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("id", messageId);
    expect((await deleteMessage(fd)).ok).toBe(true);

    // On juge par le VRAI lecteur : ce que l'écran d'un membre reçoit, pas la colonne en base.
    const row = (await prisma.message.findUniqueOrThrow({
      where: { id: messageId }, include: messageInclude(membreId),
    })) as unknown as MessageRow;
    const dto = mapMessage(row, membreId);
    expect(dto.deleted).toBe(true);
    expect(dto.body).toBe("");
    expect(dto.body).not.toContain("modérer");
  });

  it("qui a QUITTÉ la conversation ne retire plus ses anciens messages", async () => {
    // Le comportement d'ORIGINE, préservé volontairement : l'élargir serait une décision de
    // permission (§118.86). Mon commentaire l'affirmait ; sans ce cas, un sabotage qui retire la
    // porte d'appartenance passait au vert — un commentaire qui affirme un comportement sans
    // l'avoir exercé est une dette, pas une documentation (§118.116).
    const sien = await prisma.message.create({
      data: { conversationId: groupeId, senderId: autreId, body: `${TAG} son propre message` },
    });
    const adhesion = await prisma.conversationMember.findFirstOrThrow({
      where: { userId: autreId, conversationId: groupeId },
    });
    await prisma.conversationMember.update({ where: { id: adhesion.id }, data: { leftAt: new Date() } });

    ACTOR = await actorFor(autreId, "MEDICAL_DELEGATE");
    const fd = new FormData(); fd.set("id", sien.id);
    expect((await deleteMessage(fd)).ok).toBe(false);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: sien.id }, select: { deletedAt: true } })).deletedAt).toBeNull();

    // Revenu dans la conversation, il retire son message : c'est bien l'APPARTENANCE qui
    // décidait, pas la paternité — sans cette seconde moitié, la garde serait désarmée en
    // ayant l'air armée (§118.17).
    await prisma.conversationMember.update({ where: { id: adhesion.id }, data: { leftAt: null } });
    expect((await deleteMessage(fd)).ok).toBe(true);
    await prisma.message.delete({ where: { id: sien.id } });
  });

  it("un tête-à-tête est REFUSÉ, avec sa raison — et rien n'est supprimé", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("kind", "CONVERSATION"); fd.set("id", directId);
    const r = await superAdminDelete(fd);
    expect(r.ok).toBe(false);
    // Le refus NOMME la nature et le geste qui reste — pas « introuvable », pas « des éléments
    // liés bloquent » : ces deux phrases auraient été fausses (§118.30).
    expect(r.error).toContain("conversation directe");
    expect(r.error).toMatch(/groupes et (les )?canaux/);
    expect(r.error).not.toContain("introuvable");
    expect(r.error).not.toContain("éléments liés");
    // Et il n'écrit RIEN : ni suppression, ni entrée de corbeille.
    expect(await prisma.conversation.count({ where: { id: directId } })).toBe(1);
    expect(await prisma.conversationMember.count({ where: { conversationId: directId } })).toBe(2);
    expect(await prisma.deletedRecord.count({ where: { kind: "CONVERSATION", sourceId: directId } })).toBe(0);
  });

  it("un GROUPE se supprime, et la restauration rend ce que la réserve annonce : un groupe vide", async () => {
    expect(await prisma.conversationMember.count({ where: { conversationId: groupeId } })).toBe(2);
    expect(await prisma.message.count({ where: { conversationId: groupeId } })).toBe(1);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("kind", "CONVERSATION"); fd.set("id", groupeId);
    const r = await superAdminDelete(fd);
    expect(r.ok).toBe(true);
    expect(r.redirect).toBe("/admin/messagerie");

    expect(await prisma.conversation.count({ where: { id: groupeId } })).toBe(0);
    expect(await prisma.conversationMember.count({ where: { conversationId: groupeId } })).toBe(0);
    expect(await prisma.message.count({ where: { conversationId: groupeId } })).toBe(0);

    // Le geste est AUDITÉ, avec le nom lisible du groupe.
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: adminId, action: "DELETE", summary: { contains: `${TAG}Comité produit` } },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.module).toBe("Messagerie");

    // L'instantané décrit ce qu'il y AVAIT : c'est ce qu'une personne lit dans la corbeille.
    const rec = await prisma.deletedRecord.findFirstOrThrow({
      where: { kind: "CONVERSATION", sourceId: groupeId }, orderBy: { deletedAt: "desc" },
    });
    expect(rec.name).toContain("2 membre(s)");
    expect(rec.name).toContain("1 message(s)");

    // LA RÉSERVE EST VRAIE, et c'est le cas qui la rend nécessaire : restaurer rend le groupe,
    // JAMAIS ses membres ni son historique. Si ce cas passait avec 2 membres, la phrase de la
    // confirmation serait un mensonge (§104.16).
    const fdR = new FormData(); fdR.set("id", rec.id);
    expect((await restoreDeletedRecord(fdR)).ok).toBe(true);
    expect(await prisma.conversation.count({ where: { id: groupeId } })).toBe(1);
    expect(await prisma.conversationMember.count({ where: { conversationId: groupeId } })).toBe(0);
    expect(await prisma.message.count({ where: { conversationId: groupeId } })).toBe(0);
  });

  it("une notification supprimée disparaît de la liste de son destinataire, et revient à l'identique", async () => {
    // La clause est celle de la page `/notifications` : on juge ce que la personne VOIT.
    const sien = () => prisma.notification.findMany({ where: { userId: membreId }, select: { id: true } });
    expect((await sien()).map((n) => n.id)).toContain(notifId);

    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData(); fd.set("kind", "NOTIFICATION"); fd.set("id", notifId);
    expect((await superAdminDelete(fd)).ok).toBe(true);
    expect((await sien()).map((n) => n.id)).not.toContain(notifId);

    const rec = await prisma.deletedRecord.findFirstOrThrow({
      where: { kind: "NOTIFICATION", sourceId: notifId }, orderBy: { deletedAt: "desc" },
    });
    expect(rec.name).toContain(`${TAG}Échéance dossier`);
    expect(rec.name).toContain(`${TAG}membre`); // le DESTINATAIRE est nommé : c'est ce qui la distingue

    const fdR = new FormData(); fdR.set("id", rec.id);
    expect((await restoreDeletedRecord(fdR)).ok).toBe(true);
    const revenue = await prisma.notification.findUniqueOrThrow({ where: { id: notifId } });
    expect(revenue.userId).toBe(membreId);
    expect(revenue.title).toBe(`${TAG}Échéance dossier`);
    expect(revenue.link).toBe("/regulatory");
  });

  it("un non-Super-Admin ne supprime ni groupe ni notification", async () => {
    ACTOR = await actorFor(membreId, "MEDICAL_DELEGATE");
    for (const kind of ["CONVERSATION", "NOTIFICATION"]) {
      const fd = new FormData(); fd.set("kind", kind); fd.set("id", kind === "CONVERSATION" ? groupeId : notifId);
      const r = await superAdminDelete(fd);
      expect(r.ok, `${kind} devrait être refusé à un délégué`).toBe(false);
      expect(r.error).toContain("Super Admin");
    }
    expect(await prisma.conversation.count({ where: { id: groupeId } })).toBe(1);
    expect(await prisma.notification.count({ where: { id: notifId } })).toBe(1);
  });
});
