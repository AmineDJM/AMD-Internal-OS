import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { createRequest, startRequestProcessing, annulerDemandeAuSecretariat } from "@/lib/actions/admin-request-actions";
import { decideValidation } from "@/lib/actions/validation-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__annulcourse__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "");

/**
 * LA BARRIÈRE (§118.164e) : la transaction du banc tient la ligne de la demande (`FOR NO KEY UPDATE` — il ne
 * bloque QUE l'écriture d'une colonne, jamais une lecture ni une clé étrangère qui la vise), lance l'annulation,
 * attend qu'une session soit bloquée PAR ELLE (`pg_blocking_pids` : ni une autre suite, ni un autre fichier
 * ne peuvent ouvrir la barrière à sa place), joue le geste concurrent par son VRAI point d'entrée, puis relâche.
 * L'annulation a alors lu ses ordres et attend son écriture conditionnelle : exactement la fenêtre du défaut.
 */
async function pendantSonEcriture<T>(demandeId: string, lancer: () => Promise<T>, pendant: () => Promise<void>): Promise<T> {
  let geste!: Promise<T>;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "AdministrativeRequest" WHERE id = $1 FOR NO KEY UPDATE`, demandeId);
    geste = lancer();
    geste.catch(() => undefined);
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
      if (n >= 1) break;
      if (Date.now() - debut > 30_000) throw new Error("l'annulation n'a pas atteint son écriture conditionnelle");
      await new Promise((r) => setTimeout(r, 25));
    }
    await pendant();
  }, { timeout: 60_000 });
  return geste;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN ORDRE NÉ PENDANT L'ANNULATION NE SURVIT PAS À SA DEMANDE (vague « restes »).
 *
 * `annulerDemandeSecretariat` lisait les ordres de dépense AVANT son écriture conditionnelle de la demande :
 * une pièce validée à la même seconde émettait un ordre que cette lecture n'avait pas vu, et la demande partait
 * « annulée » avec un paiement encore payable au centre. Joué par les VRAIS points d'entrée — l'annulation par
 * l'assistante (`annulerDemandeAuSecretariat`), la décision du validateur (`decideValidation`) —, avec des
 * acteurs SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Annuler une demande au secrétariat — un ordre né pendant le geste est annulé avec elle", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { req: "MEDICAL_DELEGATE", asst: "DIRECTION_ASSISTANT", val: "FINANCE_BUDGET_MANAGER" };
  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!, roles[k]!); };
  const t0 = new Date();

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    const demandes = (await prisma.administrativeRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((x) => x.id);
    const ordres = (await prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: { in: demandes } }, select: { id: true } })).map((x) => x.id);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { createdAt: { gte: t0 }, body: { contains: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
  });
  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSES : l'assistante gère la demande et le validateur tranche, sans vue globale ni l'un ni l'autre", () => {
    expect(hasGlobalView(roles.asst!)).toBe(false);
    expect(hasGlobalView(roles.val!)).toBe(false);
  });

  it("TÉMOIN : une pièce validée PENDANT l'annulation émet un ordre — l'annulation le relit après son écriture et l'annule", async () => {
    await comme("req");
    const cree = await createRequest(undefined, form({ type: "OTHER", title: `${TAG} traiteur du congrès`, assignedToId: u.asst! }));
    expect(cree.ok, err(cree) ?? "").toBe(true);
    const id = cree.id!;
    await comme("asst");
    expect(err(await startRequestProcessing(form({ id })))).toBeNull();
    // La pièce jointe d'une demande, en attente d'avis, avec un montant : l'accorder émet un ordre de dépense.
    const v = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}V1`, module: "Bureau du secrétariat", title: `${TAG} facture du traiteur`,
        requesterId: u.req!, entityType: "ADMIN_REQUEST", entityId: id, documentId: `${TAG}doc`, amount: 48_000,
        steps: { create: [{ order: 1, validatorId: u.val! }] },
      },
      select: { steps: { select: { id: true } } },
    });
    const etape = v.steps[0]!.id;

    const assistante = await actorFor(u.asst!, roles.asst!);
    const validateur = await actorFor(u.val!, roles.val!);
    let ordreNe: { id: string; reference: string } | null = null;
    ACTOR = assistante;
    const r = await pendantSonEcriture(id,
      () => annulerDemandeAuSecretariat(form({ id, motif: "le congrès est reporté" })),
      async () => {
        // L'annulation a lu et attend : la demande n'est PAS encore annulée — c'est la fenêtre du défaut.
        expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("IN_PROGRESS");
        ACTOR = validateur;
        const d = await decideValidation(form({ stepId: etape, decision: "APPROVED" }));
        expect(d.ok, err(d) ?? "").toBe(true);
        ordreNe = await prisma.expenseOrder.findFirst({ where: { sourceType: "ADMIN_REQUEST", sourceId: id }, select: { id: true, reference: true } });
        // PRÉMISSE : l'ordre est NÉ pendant que l'annulation attendait, et il est payable.
        expect(ordreNe, "la pièce validée devait émettre un ordre").not.toBeNull();
        expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordreNe!.id }, select: { status: true } })).status).toBe("PENDING");
      });

    expect(r.ok, err(r) ?? "").toBe(true);
    const ordre = ordreNe as { id: string; reference: string } | null;
    expect(ordre).not.toBeNull();
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("CANCELLED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre!.id }, select: { status: true } })).status,
      "un paiement né pendant l'annulation ne reste pas payable pour une demande annulée").toBe("CANCELLED");
    // … et la phrase le DIT : ce qui a été annulé avec la demande se nomme.
    expect(r.ok && r.message).toContain(ordre!.reference);
  }, 90_000);
});
