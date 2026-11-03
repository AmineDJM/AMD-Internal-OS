import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  createThread, appendExchange, listThreads, getThreadMessages, deleteThread,
  saveMemory, getMemory, recentMessages, forgetEverything, personalContext,
} from "./assistant-memory";

/**
 * CLOISONNEMENT DE LA MÉMOIRE DE L'ASSISTANT.
 *
 * L'exigence : l'assistant d'une personne ne doit JAMAIS pouvoir atteindre celui d'une
 * autre — même en connaissant l'identifiant exact de son fil de conversation.
 * Ces tests tentent explicitement la fuite et vérifient qu'elle est impossible.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__mem__${Date.now()}`;
let dirUser = "", pmUser = "";
let dirThread = "";

suite("Mémoire assistant — cloisonnement strict entre personnes", () => {
  beforeAll(async () => {
    const mk = (s: string) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: "SALES_USER" } });
    const [d, p] = await Promise.all([mk("dir"), mk("pm")]);
    dirUser = d.id; pmUser = p.id;

    dirThread = await createThread(dirUser, "Prépare la revue budgétaire de mars");
    await appendExchange(dirUser, dirThread, "Prépare la revue budgétaire de mars", "Voici la synthèse de mars…");
  });

  afterAll(async () => {
    await prisma.assistantMessage.deleteMany({ where: { userId: { in: [dirUser, pmUser] } } }).catch(() => {});
    await prisma.assistantThread.deleteMany({ where: { userId: { in: [dirUser, pmUser] } } }).catch(() => {});
    await prisma.assistantMemory.deleteMany({ where: { userId: { in: [dirUser, pmUser] } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("chacun ne voit QUE ses propres fils", async () => {
    const mine = await listThreads(dirUser);
    expect(mine.map((t) => t.id)).toContain(dirThread);
    const theirs = await listThreads(pmUser);
    expect(theirs.map((t) => t.id)).not.toContain(dirThread);
    expect(theirs).toHaveLength(0);
  });

  it("connaître l'IDENTIFIANT du fil d'un autre ne suffit PAS à le lire", async () => {
    // La Direction Marketing possède l'id exact du fil du directeur : la lecture doit échouer.
    expect(await getThreadMessages(pmUser, dirThread)).toBeNull();
    // Le propriétaire, lui, le lit normalement.
    const mine = await getThreadMessages(dirUser, dirThread);
    expect(mine).not.toBeNull();
    expect(mine!.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("on ne peut pas ÉCRIRE dans le fil d'un autre", async () => {
    const ok = await appendExchange(pmUser, dirThread, "injection", "réponse");
    expect(ok).toBe(false);
    // Le fil du directeur est intact (toujours 2 messages).
    const mine = await getThreadMessages(dirUser, dirThread);
    expect(mine).toHaveLength(2);
  });

  it("on ne peut pas SUPPRIMER le fil d'un autre", async () => {
    expect(await deleteThread(pmUser, dirThread)).toBe(false);
    expect(await getThreadMessages(dirUser, dirThread)).not.toBeNull();
  });

  it("les messages récents ne remontent que les siens", async () => {
    const t2 = await createThread(pmUser, "Ma question à moi");
    await appendExchange(pmUser, t2, "Ma question à moi", "Ma réponse à moi");

    const dirMsgs = await recentMessages(dirUser);
    expect(dirMsgs.some((m) => m.content.includes("Ma question à moi"))).toBe(false);

    const pmMsgs = await recentMessages(pmUser);
    expect(pmMsgs.some((m) => m.content.includes("revue budgétaire"))).toBe(false);
    expect(pmMsgs.some((m) => m.content.includes("Ma question à moi"))).toBe(true);
  });

  it("la mémoire distillée est propre à chacun", async () => {
    await saveMemory(dirUser, "Suit de près les budgets Ad & Pro.", 4);
    expect(await getMemory(dirUser)).toContain("Ad & Pro");
    expect(await getMemory(pmUser)).toBeNull();
  });

  it("le contexte personnel porte l'identité de la personne, et le rappel de confidentialité", async () => {
    const ctx = await personalContext(dirUser);
    expect(ctx).toContain(`${TAG}dir`);
    expect(ctx).toContain("STRICTEMENT PERSONNELLES");
    // Il ne contient jamais l'autre personne.
    expect(ctx).not.toContain(`${TAG}pm`);
  });

  it("droit à l'oubli : tout effacer ne touche que la personne concernée", async () => {
    await forgetEverything(dirUser);
    expect(await listThreads(dirUser)).toHaveLength(0);
    expect(await getMemory(dirUser)).toBeNull();
    // La Direction Marketing conserve les siens.
    expect((await listThreads(pmUser)).length).toBeGreaterThan(0);
  });
});
