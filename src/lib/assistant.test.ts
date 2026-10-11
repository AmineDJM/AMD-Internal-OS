import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import {
  runAssistant, executeReadTool, buildProposal, performAction,
  type ProposedAction,
} from "@/lib/assistant";

const MARK = "[SMOKE-ASSISTANT]";

async function asUser(name: string): Promise<CurrentUser> {
  const u = await prisma.user.findFirstOrThrow({ where: { name }, select: { id: true, name: true, email: true, role: true } });
  const access = await getAccess(u.id, u.role as UserRole);
  return { id: u.id, name: u.name, email: u.email, role: u.role, access, mustChangePassword: false };
}

let bob: CurrentUser; // HEAD_OF_SALES — pas d'accès Médical
let carla: CurrentUser; // MEDICAL_DELEGATE

// Ces smokes s'appuient sur des comptes de démonstration ("Bob Hadj", "Carla
// Meziane"). En leur absence (base fraîche / CI sans jeu de démo), on saute
// proprement le fichier plutôt que d'échouer au beforeAll.
let fixturesPresent = false;
try { fixturesPresent = (await prisma.user.count({ where: { name: { in: ["Bob Hadj", "Carla Meziane"] } } })) === 2; } catch { fixturesPresent = false; }
const d = fixturesPresent ? describe : describe.skip;

beforeAll(async () => {
  if (!fixturesPresent) return;
  bob = await asUser("Bob Hadj");
  carla = await asUser("Carla Meziane");
});

afterAll(async () => {
  await prisma.task.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.administrativeRequest.deleteMany({ where: { title: { startsWith: MARK } } });
  await prisma.congressNational.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.congressInternational.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.message.deleteMany({ where: { body: { startsWith: MARK } } });
  if (bob && carla) {
    const conv = await prisma.conversation.findFirst({
      where: { type: "DIRECT", AND: [{ members: { some: { userId: bob.id } } }, { members: { some: { userId: carla.id } } }] },
      select: { id: true },
    });
    if (conv) await prisma.conversation.delete({ where: { id: conv.id } }); // cascade membres/messages
  }
  await prisma.notification.deleteMany({ where: { body: { startsWith: MARK } } });
  await prisma.auditLog.deleteMany({ where: { module: "Assistant IA" } });
  await prisma.$disconnect();
});

d("Assistant — dégradation sans clé IA", () => {
  it("runAssistant renvoie configured:false sans ANTHROPIC_API_KEY", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await runAssistant(bob, [{ role: "user", content: "Bonjour" }]);
    expect(r.configured).toBe(false);
    expect(r.ok).toBe(false);
  });
});

d("Outils de lecture — RBAC", () => {
  it("my_overview liste les modules accessibles + compteurs", async () => {
    const out = await executeReadTool("my_overview", {}, bob);
    const data = JSON.parse(out);
    expect(Array.isArray(data.modulesAccessibles)).toBe(true);
    expect(data.modulesAccessibles).toContain("Ventes");
    expect(typeof data.tachesOuvertes).toBe("number");
  });

  it("search_doctors refuse l'accès à un rôle sans module Médical", async () => {
    const out = await executeReadTool("search_doctors", { query: "" }, bob);
    expect(out).toContain("Accès non autorisé");
  });

  it("search_doctors est autorisé pour un délégué (scopé, sans erreur)", async () => {
    const out = await executeReadTool("search_doctors", { query: "" }, carla);
    expect(out).not.toContain("Accès non autorisé");
  });

  it("search_people retrouve un collègue par son nom", async () => {
    const out = await executeReadTool("search_people", { query: "Carla" }, bob);
    expect(out).toContain("Carla");
  });
});

d("Construction d'action proposée (confirmation)", () => {
  it("create_task résout le destinataire par son nom", async () => {
    const p = (await buildProposal("create_task", { title: `${MARK} Préparer dossier`, assigneeName: "Carla" }, bob)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.kind).toBe("create_task");
    expect(p.payload.kind === "create_task" && p.payload.assigneeId).toBe(carla.id);
    expect(p.warnings.length).toBe(0);
  });

  /**
   * LE CAS MESURÉ LIVE : une étape de mission a résolu la personne, l'éventail a déployé
   * l'OBJET candidat sur `assigneeName`, et le lecteur a refusé « introuvable » une personne
   * dont il tenait le nom et l'adresse. Le point d'entrée de PRODUCTION est `buildProposal`
   * (§118.14) : c'est lui qu'on interroge, pas la fonction pure toute seule.
   */
  it("un candidat RÉSOLU (objet nom + adresse) est un destinataire, pas une énigme", async () => {
    const candidat = { nom: carla.name, adresse: carla.email, source: "compte ERP", detail: "MEDICAL_DELEGATE" };
    const p = (await buildProposal("create_task", { title: `${MARK} Objet résolu`, assigneeName: candidat }, bob)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.payload.kind === "create_task" && p.payload.assigneeId).toBe(carla.id);
    expect(p.warnings.length).toBe(0);
  });

  it("un éventail d'UN candidat désigne cette personne ; de PLUSIEURS, personne", async () => {
    const un = (await buildProposal("create_task", { title: `${MARK} Un`, assigneeName: [{ nom: carla.name, adresse: carla.email }] }, bob)) as ProposedAction;
    expect(un.payload.kind === "create_task" && un.payload.assigneeId).toBe(carla.id);

    const deux = (await buildProposal("create_task", {
      title: `${MARK} Deux`,
      assigneeName: [{ nom: carla.name, adresse: carla.email }, { nom: bob.name, adresse: bob.email }],
    }, bob)) as ProposedAction;
    // Choisir l'un des deux à la place d'un humain serait pire que refuser.
    expect(deux.payload.kind === "create_task" && deux.payload.assigneeId).toBeNull();
    expect(deux.warnings.some((w) => w.includes("illisible"))).toBe(true);
  });

  it("create_task signale un destinataire introuvable (jamais inventé)", async () => {
    const p = (await buildProposal("create_task", { title: `${MARK} X`, assigneeName: "Personne Inexistante ZZZ" }, bob)) as ProposedAction;
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.payload.kind === "create_task" && p.payload.assigneeId).toBeNull();
  });

  it("create_admin_request TRAVEL produit une carte avec un type", async () => {
    const p = (await buildProposal("create_admin_request", { type: "travel", title: `${MARK} Billet Pr Mouffok Alger→Rio`, description: "Du 2 au 5 janvier 2027", assigneeName: "Carla" }, bob)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.kind).toBe("create_admin_request");
    expect(p.fields.some((f) => f.label === "Type")).toBe(true);
    expect(p.payload.kind === "create_admin_request" && p.payload.assigneeId).toBe(carla.id);
  });

  it("create_admin_request rejette un type invalide", async () => {
    const p = await buildProposal("create_admin_request", { type: "FOO", title: "X" }, bob);
    expect("error" in p).toBe(true);
  });

  it("create_notification est refusé à un non Super Admin", async () => {
    const p = await buildProposal("create_notification", { audience: "ALL", title: `${MARK} Annonce` }, bob);
    expect("error" in p).toBe(true);
  });

  it("create_notification (Super Admin) propose une diffusion à tous", async () => {
    const sa: CurrentUser = { ...bob, role: "SUPER_ADMIN" };
    const p = (await buildProposal("create_notification", { audience: "ALL", title: `${MARK} Annonce`, body: "Test" }, sa)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.kind).toBe("create_notification");
    expect(p.payload.kind === "create_notification" && p.payload.audience).toBe("ALL");
  });
});

d("Exécution après confirmation — ré-autorisation + audit", () => {
  it("refuse l'exécution si l'utilisateur n'a pas le droit (jamais sur la confiance du client)", async () => {
    const stripped: CurrentUser = { ...bob, access: { modules: new Map(), rowGrants: new Map() } as EffectiveAccess };
    const r = await performAction(stripped, { kind: "create_task", title: `${MARK} interdit` });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/droit/i);
  });

  it("crée une tâche assignée à un collègue + journalise", async () => {
    const title = `${MARK} Relance PCH`;
    const r = await performAction(bob, { kind: "create_task", title, assigneeId: carla.id, priority: "HIGH" });
    expect(r.ok).toBe(true);
    const task = await prisma.task.findFirstOrThrow({ where: { title } });
    expect(task.assignedToId).toBe(carla.id);
    expect(task.createdById).toBe(bob.id);
    expect(task.priority).toBe("HIGH");
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "TASK", entityId: task.id, module: "Assistant IA" } });
    expect(audit).not.toBeNull();
  });

  it("retombe sur soi-même si le destinataire est invalide", async () => {
    const title = `${MARK} Tâche perso`;
    const r = await performAction(bob, { kind: "create_task", title, assigneeId: "id-bidon-inexistant" });
    expect(r.ok).toBe(true);
    const task = await prisma.task.findFirstOrThrow({ where: { title } });
    expect(task.assignedToId).toBe(bob.id);
  });

  it("crée une demande administrative TRAVEL avec référence REQ-AAAA-NNN", async () => {
    const title = `${MARK} Billet Pr Mouffok`;
    const r = await performAction(bob, { kind: "create_admin_request", type: "TRAVEL", title, description: "Alger → Rio, 2–5 janv. 2027", assigneeId: carla.id });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/REQ-\d{4}-\d{3}/);
    const req = await prisma.administrativeRequest.findFirstOrThrow({ where: { title } });
    expect(req.requesterId).toBe(bob.id);
    // La demande va DIRECTEMENT à l'assistante de direction (Direction, 10/2026) : un responsable porté par
    // une ancienne carte n'est plus écrit — celle qui commence le traitement en devient responsable.
    expect(req.assignedToId).toBeNull();
    expect(req.concernedUserId).toBeNull();
    expect(req.type).toBe("TRAVEL");
  });
});

d("Assistant — prudence sur les dates passées", () => {
  it("signale une date de départ déjà passée", async () => {
    const p = (await buildProposal("create_admin_request", { type: "TRAVEL", title: `${MARK} Billet passé`, startDate: "2020-01-10", endDate: "2020-01-15" }, bob)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.warnings.join(" ")).toMatch(/passée/i);
  });
  it("ne signale pas une date future", async () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const p = (await buildProposal("create_admin_request", { type: "TRAVEL", title: `${MARK} Billet futur`, startDate: future }, bob)) as ProposedAction;
    expect(p.warnings.join(" ")).not.toMatch(/passée/i);
  });
});

d("Assistant — envoyer un message (MESSAGING)", () => {
  it("résout le destinataire par son nom", async () => {
    const p = (await buildProposal("send_message", { recipientName: "Carla", body: `${MARK} bonjour` }, bob)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.kind).toBe("send_message");
    expect(p.payload.kind === "send_message" && p.payload.recipientId).toBe(carla.id);
  });
  it("refuse si l'utilisateur n'a pas la messagerie", async () => {
    const stripped: CurrentUser = { ...bob, access: { modules: new Map(), rowGrants: new Map() } as EffectiveAccess };
    const r = await performAction(stripped, { kind: "send_message", recipientId: carla.id, recipientName: "Carla", body: `${MARK} x` });
    expect(r.ok).toBe(false);
  });
  it("crée une conversation directe + message après confirmation", async () => {
    const r = await performAction(bob, { kind: "send_message", recipientId: carla.id, recipientName: "Carla Meziane", body: `${MARK} message test` });
    expect(r.ok).toBe(true);
    const msg = await prisma.message.findFirst({ where: { body: { startsWith: MARK }, senderId: bob.id } });
    expect(msg).not.toBeNull();
    const conv = await prisma.conversation.findFirst({
      where: { type: "DIRECT", AND: [{ members: { some: { userId: bob.id } } }, { members: { some: { userId: carla.id } } }] },
      select: { id: true },
    });
    expect(conv).not.toBeNull();
  });
});

d("Assistant — résolution par fonction (titre de poste)", () => {
  it("assigne une demande administrative en retrouvant le collègue par sa FONCTION", async () => {
    // « Responsable Ventes » = titre de Bob → doit se résoudre sans son prénom.
    const p = (await buildProposal("create_admin_request", { type: "PURCHASE", title: `${MARK} Achat armoire`, assigneeName: "Responsable Ventes" }, carla)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.payload.kind === "create_admin_request" && p.payload.assigneeId).toBe(bob.id);
    expect(p.warnings.length).toBe(0);
  });
});

d("Assistant — demande de congrès (RBAC par module)", () => {
  it("refuse pour un rôle sans le module congrès", async () => {
    const p = await buildProposal("create_congress_request", { scope: "NATIONAL", name: `${MARK} Congrès` }, bob);
    expect("error" in p).toBe(true);
  });
  it("propose puis crée la demande pour un délégué", async () => {
    const p = (await buildProposal("create_congress_request", { scope: "NATIONAL", name: `${MARK} Congrès Alger`, city: "Alger" }, carla)) as ProposedAction;
    expect("error" in p).toBe(false);
    expect(p.kind).toBe("create_congress_request");
    const r = await performAction(carla, { kind: "create_congress_request", scope: "NATIONAL", name: `${MARK} Congrès Alger`, city: "Alger" });
    expect(r.ok).toBe(true);
    const cn = await prisma.congressNational.findFirst({ where: { name: { startsWith: MARK } } });
    expect(cn?.requesterId).toBe(carla.id);
    expect(cn?.requestStatus).toBe("AWAITING_PRELIMINARY");
  });
});
