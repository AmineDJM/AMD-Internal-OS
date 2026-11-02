import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POLLING DE LA MESSAGERIE NE LIT QU'UN MESSAGE PAR CONVERSATION (audit performance, PERF-01).
 *
 * `/api/messaging/sync` est la route la plus sollicitée de l'ERP : chaque onglet ouvert l'appelle
 * toutes les 12 s. Elle construisait l'aperçu « dernier message » par un `include` imbriqué
 * `messages: { take: 1, orderBy: … }`. Prisma 5 n'applique PAS ce `take` en SQL quand le parent
 * est une liste : il émet `SELECT … FROM "Message" WHERE "conversationId" IN (…) ORDER BY …`
 * SANS `LIMIT`, rapatrie tout l'historique (corps compris) et coupe en mémoire — puis interroge
 * les pièces jointes de CHAQUE message rapatrié. Mesuré en base locale : 40 conversations × 500
 * messages → 20 000 lignes et ~190 ms, toutes les 12 s, par onglet, et croissant à vie.
 *
 * Ce banc tient la correction par le SQL réellement émis (client Prisma journalisé à la place
 * du singleton) : aucune lecture de "Message" sans `LIMIT`, et l'aperçu reste juste (dernier
 * message NON supprimé, expéditeur, pièce jointe).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const requetes: string[] = [];
const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
(client as unknown as { $on: (e: "query", cb: (e: Prisma.QueryEvent) => void) => void }).$on("query", (e) => {
  requetes.push(e.query);
});
vi.mock("@/lib/prisma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prisma")>()),
  prisma: client,
}));

const { getConversationSummaries, getSync, derniersMessagesParConversation } = await import("@/lib/queries/messaging");

let dbOk = false;
try { await client.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__perfsync__";

suite("getConversationSummaries — un message par conversation, jamais l'historique", () => {
  let moi = "";
  let autre = "";
  let convA = "";
  let convB = "";

  beforeAll(async () => {
    await client.user.deleteMany({ where: { email: { startsWith: TAG } } });
    moi = (await client.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x" } })).id;
    autre = (await client.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x" } })).id;
    const base = Date.now() - 10 * 60_000;
    convA = (await client.conversation.create({
      data: { type: "GROUP", title: `${TAG}A`, createdById: moi, members: { create: [{ userId: moi }, { userId: autre }] } },
    })).id;
    convB = (await client.conversation.create({
      data: { type: "GROUP", title: `${TAG}B`, createdById: moi, members: { create: [{ userId: moi }, { userId: autre }] } },
    })).id;
    // A : un historique, puis un dernier message SUPPRIMÉ — l'aperçu doit montrer l'avant-dernier.
    await client.message.createMany({
      data: Array.from({ length: 60 }, (_, k) => ({
        conversationId: convA, senderId: k % 2 ? moi : autre, body: `ancien ${k}`, createdAt: new Date(base + k * 1000),
      })),
    });
    await client.message.create({ data: { conversationId: convA, senderId: autre, body: "le vrai dernier", createdAt: new Date(base + 120_000) } });
    await client.message.create({ data: { conversationId: convA, senderId: autre, body: "supprimé", createdAt: new Date(base + 180_000), deletedAt: new Date() } });
    // B : un dernier message de moi, avec une pièce jointe et un corps vide.
    const m = await client.message.create({ data: { conversationId: convB, senderId: moi, body: "", createdAt: new Date(base + 240_000) } });
    await client.messageAttachment.create({ data: { messageId: m.id, name: "a.pdf", mime: "application/pdf", size: 1 } });
  });

  afterAll(async () => {
    await client.conversation.deleteMany({ where: { id: { in: [convA, convB].filter(Boolean) } } });
    await client.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await client.$disconnect();
  });

  it("aucune lecture de la table Message sans LIMIT", async () => {
    requetes.length = 0;
    await getConversationSummaries(moi);
    const lecturesDeMessages = requetes.filter((q) => /FROM\s+"(public"\.")?Message"/.test(q) && !/COUNT\(/i.test(q));
    expect(lecturesDeMessages.length).toBeGreaterThan(0);
    const sansLimite = lecturesDeMessages.filter((q) => !/\bLIMIT\b/i.test(q));
    expect(sansLimite, `lecture non bornée :\n${sansLimite.join("\n")}`).toEqual([]);
  });

  it("l'aperçu reste juste : dernier message NON supprimé, expéditeur, pièce jointe, tri", async () => {
    const liste = await getConversationSummaries(moi);
    const a = liste.find((c) => c.id === convA)!;
    const b = liste.find((c) => c.id === convB)!;
    expect(a.lastMessagePreview).toBe("le vrai dernier");
    expect(a.lastSenderName).toBe(`${TAG}autre`);
    expect(a.lastSenderIsSelf).toBe(false);
    expect(b.lastMessagePreview).toBe("📎 Pièce jointe");
    expect(b.lastSenderIsSelf).toBe(true);
    // B est plus récent que A : il passe devant.
    expect(liste.findIndex((c) => c.id === convB)).toBeLessThan(liste.findIndex((c) => c.id === convA));
    // Non-lus : les 31 messages « autre » non supprimés de A (aucune lecture enregistrée).
    expect(a.unread).toBe(31);
    expect((await getSync(moi)).totalUnread).toBe(31);
  });

  it("les N derniers (Adam « Conversations consultées », PERF-08) : bornés en SQL, du plus récent au plus ancien", async () => {
    requetes.length = 0;
    const derniers = await derniersMessagesParConversation([convA, convB], 3);
    expect(requetes.every((q) => /\bLIMIT\b/i.test(q))).toBe(true);
    expect(derniers.get(convA)!.map((m) => m.body)).toEqual(["le vrai dernier", "ancien 59", "ancien 58"]);
    expect(derniers.get(convB)!.map((m) => m.hasAttachment)).toEqual([true]);
  });
});
