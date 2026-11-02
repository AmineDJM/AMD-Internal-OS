import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";
import {
  persistActionIntents, executeIntentGuarded, cancelActionIntent,
  recentActionIntentsContext, intentSummary,
} from "@/platform/ia/intentions/action-intents";

/**
 * GOLDEN RÉGRESSION — les deux pannes réelles de l'appel de production :
 *
 *   FAILURE A (mémoire) : « je t'avais déjà demandé quelque chose à Redouane sur les
 *   contrats ? » → « je ne retrouve aucune trace », quelques minutes après la préparation.
 *   → CHAQUE proposition persiste un intent ; action_history et le bloc ACTIONS RÉCENTES
 *     retrouvent la demande AVEC son état exact.
 *
 *   FAILURE B (état) : « Message envoyé à Khaled » puis « je ne peux pas confirmer l'envoi ».
 *   → machine d'état serveur UNIQUE : PROPOSÉE ≠ EXÉCUTÉE, réclamation atomique, reçu
 *     canonique, IDEMPOTENCE (un retry ne renvoie jamais deux messages).
 */

const exec = (id: string): CurrentUser => ({
  id, name: "PDG", email: `${id}@t.dz`, role: "DIRECTION",
  access: { modules: new Map(), rowGrants: new Map() } as unknown as EffectiveAccess,
  mustChangePassword: false,
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ai__${Date.now()}`;
let ceoId = "";

const seed = (title: string, fields: { label: string; value: string }[] = []) => ({
  kind: "send_message", module: "MESSAGING", title, fields, payload: { kind: "send_message", to: "x" },
});

suite("action intents — mémoire et cohérence canoniques (Redouane / Khaled)", () => {
  beforeAll(async () => {
    const ceo = await prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    ceoId = ceo.id;
  });
  afterAll(async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId: ceoId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("FAILURE A — la demande Redouane laisse une trace STRUCTURÉE, retrouvable avec son état exact", async () => {
    const [id] = await persistActionIntents(ceoId, [
      seed("Envoyer une notification à Redouane", [
        { label: "Destinataire", value: "Redouane" },
        { label: "Objet", value: "Rattacher les contrats des salariés à leurs fiches" },
      ]),
    ], "voice");
    expect(id).toBeTruthy();

    // « Je t'avais déjà demandé quelque chose à Redouane sur les contrats ? » → action_history.
    const tool = POWER_TOOLS.find((t) => t.def.name === "action_history")!;
    expect(tool.allowed(exec(ceoId))).toBe(true);
    const out = JSON.parse(await tool.run({ query: "Redouane contrats" }, exec(ceoId)));
    expect(out.actions.length).toBeGreaterThanOrEqual(1);
    expect(out.actions[0].resume).toContain("Redouane");
    expect(out.actions[0].statut).toContain("PROPOSÉE");
    expect(out.actions[0].statut).toContain("JAMAIS exécutée");

    // Et le bloc ACTIONS RÉCENTES injecté au contexte porte la même vérité.
    const ctx = await recentActionIntentsContext(ceoId);
    expect(ctx).toContain("Redouane");
    expect(ctx).toContain("PROPOSÉE");
    expect(ctx).toContain("état CANONIQUE serveur");
  });

  it("CONFIRMATION FORTE — le confirmText d'une proposition CRITIQUE est STOCKÉ sur l'intent (référence serveur)", async () => {
    const [id] = await persistActionIntents(ceoId, [{
      ...seed("SUPPRIMER définitivement « Campagne 2024 »"),
      level: "CRITICAL" as const,
      confirmText: "Campagne 2024",
    }], "text");
    expect(id).toBeTruthy();
    const row = await prisma.assistantActionIntent.findUnique({ where: { id: id! }, select: { level: true, confirmText: true } });
    expect(row?.level).toBe("CRITICAL");
    expect(row?.confirmText).toBe("Campagne 2024");
    // Une proposition SANS niveau ne stocke rien — pas de bruit sur les actions ordinaires.
    const [id2] = await persistActionIntents(ceoId, [seed("Message ordinaire")], "text");
    const row2 = await prisma.assistantActionIntent.findUnique({ where: { id: id2! }, select: { level: true, confirmText: true } });
    expect(row2?.level).toBeNull();
    expect(row2?.confirmText).toBeNull();
  });

  it("FAILURE B — PROPOSÉE ≠ EXÉCUTÉE : exécution réclamée atomiquement, reçu canonique, IDEMPOTENCE", async () => {
    const [id] = await persistActionIntents(ceoId, [seed("Envoyer un message à Khaled")], "text");
    let runs = 0;
    const run = async () => { runs += 1; return { ok: true, message: "Message envoyé à Khaled.", link: "/messages/1" }; };

    // Avant confirmation : l'état canonique dit PROPOSÉE — rien n'est parti.
    const before = await prisma.assistantActionIntent.findUnique({ where: { id: id! } });
    expect(before?.status).toBe("PROPOSED");

    // Confirmation → exécution UNE fois, reçu persisté.
    const r1 = await executeIntentGuarded(exec(ceoId), id!, run);
    expect(r1).toMatchObject({ ok: true, message: "Message envoyé à Khaled." });
    expect(runs).toBe(1);
    const after = await prisma.assistantActionIntent.findUnique({ where: { id: id! } });
    expect(after?.status).toBe("EXECUTED");
    expect(after?.resultMessage).toBe("Message envoyé à Khaled.");
    expect(Array.isArray(after?.events)).toBe(true);
    expect((after?.events as { status: string }[]).map((e) => e.status)).toEqual(["PROPOSED", "CONFIRMED", "EXECUTING", "EXECUTED"]);

    // RETRY / double-clic / reconnexion : le reçu d'origine revient, RIEN n'est relancé.
    const r2 = await executeIntentGuarded(exec(ceoId), id!, run);
    expect(r2?.alreadyExecuted).toBe(true);
    expect(r2?.ok).toBe(true);
    expect(runs).toBe(1);
  });

  it("deux confirmations CONCURRENTES → une seule exécution (réclamation atomique)", async () => {
    const [id] = await persistActionIntents(ceoId, [seed("Notification générale")], "text");
    let runs = 0;
    const run = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 120)); // laisser le concurrent tenter sa chance
      return { ok: true, message: "Diffusée." };
    };
    const [a, b] = await Promise.all([
      executeIntentGuarded(exec(ceoId), id!, run),
      executeIntentGuarded(exec(ceoId), id!, run),
    ]);
    expect(runs).toBe(1);
    // L'un a exécuté, l'autre a reçu « déjà en cours » ou le reçu — jamais une 2ᵉ exécution.
    const outcomes = [a, b].map((r) => (r?.ok ? "ok" : "refus"));
    expect(outcomes).toContain("ok");
  });

  it("annulation : PROPOSÉE → ANNULÉE, et l'exécution refuse — « jamais exécutée » reste vrai", async () => {
    const [id] = await persistActionIntents(ceoId, [seed("Relance à annuler")], "text");
    expect(await cancelActionIntent(ceoId, id!)).toBe(true);
    let runs = 0;
    const r = await executeIntentGuarded(exec(ceoId), id!, async () => { runs += 1; return { ok: true }; });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/annulée/i);
    expect(runs).toBe(0);
  });

  it("échec puis retry : FAILED se relance, puis EXÉCUTÉE — l'historique d'autorisation reste traçable", async () => {
    const [id] = await persistActionIntents(ceoId, [seed("Action fragile")], "text");
    const r1 = await executeIntentGuarded(exec(ceoId), id!, async () => ({ ok: false, error: "Réseau." }));
    expect(r1?.ok).toBe(false);
    expect((await prisma.assistantActionIntent.findUnique({ where: { id: id! } }))?.status).toBe("FAILED");
    const r2 = await executeIntentGuarded(exec(ceoId), id!, async () => ({ ok: true, message: "OK." }));
    expect(r2?.ok).toBe(true);
    expect((await prisma.assistantActionIntent.findUnique({ where: { id: id! } }))?.status).toBe("EXECUTED");
  });

  it("cloisonnement : l'intent d'un compte est INVISIBLE et INEXÉCUTABLE pour un autre", async () => {
    const other = await prisma.user.create({ data: { name: `${TAG}o`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "DIRECTION" } });
    const [id] = await persistActionIntents(ceoId, [seed("Action privée")], "text");
    const r = await executeIntentGuarded(exec(other.id), id!, async () => ({ ok: true }));
    expect(r).toBeNull(); // inconnu pour ce compte → aucun accès à l'intent d'autrui
    const tool = POWER_TOOLS.find((t) => t.def.name === "action_history")!;
    const out = await tool.run({ query: "privée" }, exec(other.id));
    expect(out).toMatch(/Aucune action/);
  });

  it("intentSummary : titre + champs clés — la matière de « déjà demandé ? »", () => {
    expect(intentSummary(seed("Envoyer une notification à Redouane", [
      { label: "Objet", value: "Contrats salariés" },
    ]))).toBe("Envoyer une notification à Redouane — Objet : Contrats salariés");
  });

  it("episodic_recall — « qu'est-ce qu'on a fait sur X ? » fédère actions, rappels, décisions, engagements", async () => {
    await Promise.all([
      prisma.assistantReminder.create({ data: { userId: ceoId, title: `${TAG} relancer Redouane sur les contrats`, dueAt: new Date(Date.now() + 86_400_000) } }),
      prisma.executiveDecision.create({ data: { ownerId: ceoId, title: `${TAG} centraliser les contrats salariés`, status: "DECIDED" } }),
      prisma.executiveCommitment.create({ data: { ownerId: ceoId, who: "Redouane", what: `${TAG} rattacher les contrats aux fiches`, status: "OPEN" } }),
    ]);
    const tool2 = POWER_TOOLS.find((t) => t.def.name === "episodic_recall")!;
    expect(tool2.allowed(exec(ceoId))).toBe(true);
    const out = JSON.parse(await tool2.run({ query: "contrats" }, exec(ceoId)));
    // Les QUATRE registres touchés par « contrats » répondent d'un coup — sans transcript.
    expect(JSON.stringify(out.actions ?? [])).toContain("Redouane"); // l'intent du test FAILURE A
    expect(JSON.stringify(out.rappels)).toContain("relancer Redouane");
    expect(JSON.stringify(out.decisions)).toContain("centraliser");
    expect(JSON.stringify(out.engagements)).toContain("rattacher les contrats");
    // Et l'absence honnête sur un sujet jamais abordé.
    const empty = await tool2.run({ query: "zeppelin-quantique" }, exec(ceoId));
    expect(empty).toMatch(/Aucune trace ÉPISODIQUE/);
    await prisma.assistantReminder.deleteMany({ where: { userId: ceoId } }).catch(() => {});
    await prisma.executiveDecision.deleteMany({ where: { ownerId: ceoId } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { ownerId: ceoId } }).catch(() => {});
  });
});
