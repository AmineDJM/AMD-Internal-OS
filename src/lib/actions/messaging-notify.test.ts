import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
// Le push part sur de vrais abonnements VAPID : hors sujet ici, et lent.
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => {} }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { signBlob } from "@/lib/messaging";
import { sendMessage } from "./messaging-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__msgnotif__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * RECEVOIR UN MESSAGE EST UNE NOTIFICATION.
 *
 * Avant, seule une mention en produisait une : on n'apprenait un message qu'en repassant par
 * l'écran Messages. Ces essais partent du VRAI point d'entrée (`sendMessage`) et vérifient les
 * trois réglages de la conversation, plus la règle qui empêche la cloche de devenir illisible.
 */
suite("Messagerie — chaque message reçu fait une notification", () => {
  let convId = "", senderId = "", allId = "", mentionsId = "", silentId = "";
  const link = () => `/messages?c=${convId}`;
  const notifsFor = (userId: string) =>
    prisma.notification.findMany({ where: { userId, link: link() }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    const mk = (s: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: "SALES_USER", passwordHash: "x" } });
    const [sender, tous, mentions, silencieux] = await Promise.all([
      mk("expediteur"), mk("tous"), mk("mentions"), mk("silencieux"),
    ]);
    senderId = sender.id; allId = tous.id; mentionsId = mentions.id; silentId = silencieux.id;

    const conv = await prisma.conversation.create({
      data: {
        type: "GROUP", title: `${TAG} canal`, createdById: senderId,
        members: {
          create: [
            { userId: senderId, role: "OWNER" },
            { userId: allId, notifyLevel: "ALL" },
            { userId: mentionsId, notifyLevel: "MENTIONS" },
            { userId: silentId, notifyLevel: "NONE" },
          ],
        },
      },
    });
    convId = conv.id;
  }, 30000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversationId: convId } }).catch(() => {});
    await prisma.conversationMember.deleteMany({ where: { conversationId: convId } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: convId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 30000);

  it("un message ordinaire prévient les membres en « Tous les messages », et personne d'autre", async () => {
    ACTOR = await actorFor(senderId, "SALES_USER");
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("body", "Le bon de commande est signé.");
    expect((await sendMessage(fd)).ok).toBe(true);

    const recu = await notifsFor(allId);
    expect(recu).toHaveLength(1);
    expect(recu[0].title).toBe(`Nouveau message de ${TAG}expediteur`);
    expect(recu[0].body).toBe("Le bon de commande est signé.");
    expect(recu[0].link).toBe(link());

    // « Mentions uniquement » n'est pas mentionné ; « Silencieux » ne reçoit jamais rien ;
    // et l'expéditeur ne se notifie pas lui-même.
    expect(await notifsFor(mentionsId)).toHaveLength(0);
    expect(await notifsFor(silentId)).toHaveLength(0);
    expect(await notifsFor(senderId)).toHaveLength(0);
  }, 30000);

  it("un second message NON LU ne rempile pas : une ligne par conversation", async () => {
    ACTOR = await actorFor(senderId, "SALES_USER");
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("body", "Et la facture arrive demain.");
    expect((await sendMessage(fd)).ok).toBe(true);
    expect(await notifsFor(allId)).toHaveLength(1);
  }, 30000);

  it("une fois la notification LUE, le message suivant en refait une", async () => {
    await prisma.notification.updateMany({ where: { userId: allId, link: link() }, data: { isRead: true } });
    ACTOR = await actorFor(senderId, "SALES_USER");
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("body", "Troisième message.");
    expect((await sendMessage(fd)).ok).toBe(true);
    const recu = await notifsFor(allId);
    expect(recu).toHaveLength(2);
    expect(recu.filter((n) => !n.isRead)).toHaveLength(1);
  }, 30000);

  it("une MENTION passe toujours — même en « Mentions uniquement », même derrière un non-lu", async () => {
    ACTOR = await actorFor(senderId, "SALES_USER");
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("body", "Question pour toi.");
    fd.set("mentions", [mentionsId, allId].join(","));
    expect((await sendMessage(fd)).ok).toBe(true);

    const mention = await notifsFor(mentionsId);
    expect(mention).toHaveLength(1);
    expect(mention[0].title).toBe(`${TAG}expediteur vous a mentionné`);
    // Celui qui avait déjà un non-lu reçoit quand même SA mention : elle le nomme.
    const tous = await notifsFor(allId);
    expect(tous).toHaveLength(3);
    expect(tous.at(-1)!.title).toBe(`${TAG}expediteur vous a mentionné`);
    // « Silencieux » veut dire silencieux, mention comprise.
    expect(await notifsFor(silentId)).toHaveLength(0);
  }, 30000);

  it("une pièce jointe sans texte se lit quand même dans la notification", async () => {
    await prisma.notification.updateMany({ where: { userId: allId, link: link() }, data: { isRead: true } });
    ACTOR = await actorFor(senderId, "SALES_USER");
    const blobId = `${TAG}blob`;
    const fd = new FormData();
    fd.set("conversationId", convId);
    fd.set("body", "");
    fd.set("attachments", JSON.stringify([
      { blobId, sig: signBlob(blobId), name: "devis.pdf", mime: "application/pdf", size: 10 },
    ]));
    expect((await sendMessage(fd)).ok).toBe(true);

    const recu = (await notifsFor(allId)).filter((n) => !n.isRead);
    expect(recu).toHaveLength(1);
    // Sans corps, « Nouveau message » sans rien d'autre ne dirait pas ce qui est arrivé.
    expect(recu[0].body).toBe("📎 Pièce jointe");
  }, 30000);
});
