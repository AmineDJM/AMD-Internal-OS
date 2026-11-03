import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { recordEvent, timelineOf } from "./ledger";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CAS YACINE, BOUT EN BOUT — avec la vraie base.
 *
 * Le test PUR (`src/lib/tasks/evidence.test.ts`) gèle la décision. Celui-ci gèle le CIRCUIT :
 * un fait est inscrit → les tâches ouvertes sont relues → la preuve atterrit dans la ligne, et
 * la tâche N'EST PAS close. Les deux sont nécessaires : une décision juste branchée nulle part
 * ne corrige rien, et c'est exactement l'état d'où l'on part.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ledger__${Date.now()}`;
let userId = "";

suite("le registre d'événements et la preuve des tâches", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}yacine`, email: `${TAG}y@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" },
    });
    userId = u.id;
  });

  afterAll(async () => {
    await prisma.businessEvent.deleteMany({ where: { actorId: userId } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("un dépôt de contrat INSCRIT la preuve sur la tâche — sans la clore", async () => {
    const t = await prisma.task.create({
      data: {
        title: `${TAG} Déposer le contrat de la nouvelle consultante médicale dans Ad&Pro > Consulting`,
        assignedToId: userId,
        status: "TODO",
        dueDate: new Date(Date.now() - 5 * 86_400_000), // échéance dépassée : la tâche du récit
      },
    });

    await recordEvent({
      type: "CONTRACT_SIGNED",
      sourceDomain: "ADPRO_CONSULTING",
      actorId: userId,
      entityType: "CONSULTING_CONTRACT",
      entityId: "contrat-consultante",
      payload: { reference: "CONS-2026-001" },
    });

    const apres = await prisma.task.findUnique({
      where: { id: t.id },
      select: { status: true, evidenceAt: true, evidenceEntityId: true, evidenceActorId: true, evidenceNote: true },
    });

    // La preuve est là…
    expect(apres?.evidenceAt).not.toBeNull();
    expect(apres?.evidenceEntityId).toBe("contrat-consultante");
    expect(apres?.evidenceActorId).toBe(userId);
    // …et la tâche reste OUVERTE. Une déduction de texte ne clôt rien : c'est la ligne qui
    // empêche ce mécanisme d'effacer une vraie tâche sur un homonyme.
    expect(apres?.status).toBe("TODO");
  });

  it("une tâche qui ATTEND explicitement cet événement est close automatiquement", async () => {
    const t = await prisma.task.create({
      data: {
        title: `${TAG} Contrat consultante — attente déclarée`,
        assignedToId: userId,
        status: "TODO",
        expectedEvent: "CONTRACT_SIGNED",
        relatedEntityType: "CONSULTING_CONTRACT",
        relatedEntityId: "contrat-declare",
      },
    });

    await recordEvent({
      type: "CONTRACT_SIGNED",
      sourceDomain: "ADPRO_CONSULTING",
      actorId: userId,
      entityType: "CONSULTING_CONTRACT",
      entityId: "contrat-declare",
    });

    const apres = await prisma.task.findUnique({
      where: { id: t.id },
      select: { status: true, completedAt: true, evidenceAt: true },
    });
    expect(apres?.status).toBe("DONE");
    expect(apres?.completedAt).not.toBeNull();
    expect(apres?.evidenceAt).not.toBeNull();
  });

  it("une tâche SANS rapport n'est pas touchée", async () => {
    const t = await prisma.task.create({
      data: { title: `${TAG} Rappeler Karim`, assignedToId: userId, status: "TODO" },
    });
    await recordEvent({
      type: "CONTRACT_SIGNED", sourceDomain: "ADPRO_CONSULTING", actorId: userId,
      entityType: "CONSULTING_CONTRACT", entityId: "autre-contrat",
    });
    const apres = await prisma.task.findUnique({ where: { id: t.id }, select: { status: true, evidenceAt: true } });
    expect(apres?.status).toBe("TODO");
    expect(apres?.evidenceAt).toBeNull();
  });

  it("la PREMIÈRE preuve fait foi — un second dépôt ne la réécrit pas", async () => {
    const t = await prisma.task.create({
      data: {
        title: `${TAG} Déposer le contrat dans Ad&Pro > Consulting (première preuve)`,
        assignedToId: userId, status: "TODO",
      },
    });
    await recordEvent({
      type: "CONTRACT_SIGNED", sourceDomain: "ADPRO_CONSULTING", actorId: userId,
      entityType: "CONSULTING_CONTRACT", entityId: "premier",
    });
    const un = await prisma.task.findUnique({ where: { id: t.id }, select: { evidenceEntityId: true, evidenceAt: true } });

    await recordEvent({
      type: "CONTRACT_SIGNED", sourceDomain: "ADPRO_CONSULTING", actorId: userId,
      entityType: "CONSULTING_CONTRACT", entityId: "second",
    });
    const deux = await prisma.task.findUnique({ where: { id: t.id }, select: { evidenceEntityId: true, evidenceAt: true } });

    // « Déposé le 22/08 » est un fait ; il ne se met pas à jour.
    expect(deux?.evidenceEntityId).toBe("premier");
    expect(deux?.evidenceAt?.getTime()).toBe(un?.evidenceAt?.getTime());
  });

  it("la frise d'une entité remonte ses faits, y compris par référence secondaire", async () => {
    await recordEvent({
      type: "PAYMENT_RECEIVED", sourceDomain: "FINANCES", actorId: userId,
      entityType: "FINANCE_TRANSACTION", entityId: "paiement-1",
      relatedRefs: ["CONSULTING_CONTRACT:contrat-frise"],
    });
    const frise = await timelineOf("CONSULTING_CONTRACT", "contrat-frise");
    expect(frise.some((e) => e.type === "PAYMENT_RECEIVED")).toBe(true);
  });

  it("une inscription impossible ne fait PAS échouer l'écriture métier qu'elle observe", async () => {
    // `entityType` invalide → Prisma refuse. `recordEvent` doit rendre `null`, pas lever :
    // un registre qui fait tomber le dépôt de contrat qu'il observe est une régression.
    const id = await recordEvent({
      type: "X", sourceDomain: "Y",
      entityType: "PAS_UN_TYPE" as never,
    });
    expect(id).toBeNull();
  });
});
