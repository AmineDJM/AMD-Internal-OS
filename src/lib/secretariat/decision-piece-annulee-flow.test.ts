import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { createRequest, startRequestProcessing, annulerDemandeAuSecretariat, deleteRequests } from "@/lib/actions/admin-request-actions";
import { decideValidation } from "@/lib/actions/validation-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__piecannul__";

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
 * LA BARRIÈRE (§118.164e) : la transaction du banc tient une ligne (`FOR UPDATE`), lance la décision, attend
 * qu'une session soit bloquée PAR ELLE (`pg_blocking_pids` : ni une autre suite, ni un autre fichier ne peuvent
 * ouvrir la barrière à sa place — la ligne tenue est celle du banc), joue le geste concurrent par son VRAI point
 * d'entrée, puis relâche. Deux points de rendez-vous, deux clés étrangères que la décision traverse APRÈS avoir
 * écrit son accord :
 *   • la SOCIÉTÉ de la demande — l'ordre de dépense la vise (`ExpenseOrder.companyId`) : la décision a relu la
 *     demande (vivante) et attend à l'INSERT de l'ordre ;
 *   • le COMPTE du validateur — le journal de la décision le vise (`AuditLog.actorId`) : la décision a écrit
 *     son accord et n'a encore rien relu de la demande.
 */
async function pendantQueBloque<T>(verrou: { table: "Company" | "User"; id: string }, lancer: () => Promise<T>, pendant: () => Promise<void>): Promise<T> {
  let geste!: Promise<T>;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe(`SELECT 1 FROM "${verrou.table}" WHERE id = $1 FOR UPDATE`, verrou.id);
    geste = lancer();
    geste.catch(() => undefined);
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
      if (n >= 1) break;
      if (Date.now() - debut > 30_000) throw new Error(`la décision n'a pas atteint la ligne tenue (${verrou.table})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await pendant();
  }, { timeout: 60_000 });
  return geste;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PIÈCE VALIDÉE N'ÉMET PAS DE PAIEMENT POUR UNE DEMANDE ANNULÉE (vague « restes 2 »).
 *
 * `decideValidation` émettait l'ordre de dépense d'une pièce approuvée sans relire la demande au
 * secrétariat. L'annulation (`annulerDemandeSecretariat`) relit ses ordres APRÈS son écriture : elle
 * rattrape un ordre né avant elle, jamais un ordre né après. La course jouée ici est celle-là : la
 * décision écrit APPROVED, l'annulation passe tout entière et ne trouve aucun ordre, puis l'ordre naît.
 * Joué par les VRAIS points d'entrée — la décision du validateur, l'annulation par l'assistante, la
 * suppression par l'assistante —, avec des acteurs SANS vue globale (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Une pièce validée pendant l'annulation de sa demande — le paiement ne survit pas à la demande", () => {
  const u: Record<string, string> = {};
  const roles: Record<string, SessionUser["role"]> = { req: "MEDICAL_DELEGATE", asst: "DIRECTION_ASSISTANT", val: "FINANCE_BUDGET_MANAGER" };
  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!, roles[k]!); };
  const t0 = new Date();
  let societe = "";
  let n = 0;

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
    await prisma.businessEvent.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  }

  /** Une demande au secrétariat, prise en charge, rattachée à la société du banc, et sa pièce en attente d'avis. */
  async function demandeAvecPiece(titre: string): Promise<{ id: string; etape: string; validation: string }> {
    n += 1;
    await comme("req");
    const cree = await createRequest(undefined, form({ type: "OTHER", title: `${TAG} ${titre}`, assignedToId: u.asst! }));
    expect(cree.ok, err(cree) ?? "").toBe(true);
    const id = cree.id!;
    await prisma.administrativeRequest.update({ where: { id }, data: { companyId: societe } });
    await comme("asst");
    expect(err(await startRequestProcessing(form({ id })))).toBeNull();
    const v = await prisma.validationRequest.create({
      data: {
        reference: `${TAG}V${n}`, module: "Bureau du secrétariat", title: `${TAG} facture — ${titre}`,
        requesterId: u.req!, entityType: "ADMIN_REQUEST", entityId: id, documentId: `${TAG}doc${n}`, amount: 48_000,
        steps: { create: [{ order: 1, validatorId: u.val! }] },
      },
      select: { id: true, steps: { select: { id: true } } },
    });
    return { id, etape: v.steps[0]!.id, validation: v.id };
  }
  const ordresDe = (id: string) => prisma.expenseOrder.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: id }, select: { id: true, reference: true, status: true } });
  const statutDe = async (id: string) => (await prisma.administrativeRequest.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  beforeAll(async () => {
    await nettoyer();
    societe = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } })).id;
    for (const [k, role] of Object.entries(roles)) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
  });
  afterAll(async () => { await nettoyer(); });

  it("PRÉMISSES : l'assistante gère la demande et le validateur tranche la pièce, sans vue globale ni l'un ni l'autre", () => {
    expect(hasGlobalView(roles.asst!)).toBe(false);
    expect(hasGlobalView(roles.val!)).toBe(false);
  });

  it("TÉMOIN : une pièce validée d'une demande vivante émet son paiement, qui part au centre", async () => {
    const d = await demandeAvecPiece("traiteur du séminaire");
    await comme("val");
    const r = await decideValidation(form({ stepId: d.etape, decision: "APPROVED" }));
    expect(r.ok, err(r) ?? "").toBe(true);
    const ordres = await ordresDe(d.id);
    expect(ordres.map((o) => o.status), "la pièce validée devait émettre UN ordre payable").toEqual(["PENDING"]);
  });

  it("L'ANNULATION PASSE ENTRE L'ACCORD ET LA NAISSANCE DE L'ORDRE : l'ordre né après est annulé par la décision elle-même", async () => {
    const d = await demandeAvecPiece("traiteur du congrès");
    const assistante = await actorFor(u.asst!, roles.asst!);
    ACTOR = await actorFor(u.val!, roles.val!);
    const decision = await pendantQueBloque({ table: "Company", id: societe },
      () => decideValidation(form({ stepId: d.etape, decision: "APPROVED" })),
      async () => {
        // PRÉMISSES : l'accord est ÉCRIT (la décision attend à l'INSERT de l'ordre, après avoir relu une demande
        // vivante) et aucun ordre n'existe encore — c'est exactement la fenêtre que l'annulation ne voit pas.
        expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: d.validation }, select: { status: true } })).status).toBe("APPROVED");
        expect(await ordresDe(d.id)).toHaveLength(0);
        ACTOR = assistante;
        const a = await annulerDemandeAuSecretariat(form({ id: d.id, motif: "le congrès est reporté" }));
        expect(a.ok, err(a) ?? "").toBe(true);
        // L'annulation n'a RIEN trouvé à annuler : sans la relecture de la décision, l'ordre resterait payable.
        expect(a.ok && a.message, "l'annulation ne pouvait pas voir un ordre encore à naître").not.toMatch(/paiement/);
        expect(await statutDe(d.id)).toBe("CANCELLED");
      });

    const ordres = await ordresDe(d.id);
    expect(ordres, "l'ordre est bien né, après l'annulation").toHaveLength(1);
    expect(ordres[0]!.status, "un paiement né après l'annulation ne reste pas payable pour une demande annulée").toBe("CANCELLED");
    expect(decision.ok, "une décision qui a vu son paiement annulé ne se dit pas réussie").toBe(false);
    expect(err(decision)).toMatch(/vient d'être annulée pendant votre décision/);
    expect(err(decision)).toContain(`${ordres[0]!.reference} qu'il émettait a été annulé`);
    expect(err(decision), "l'accord sur la pièce, lui, reste enregistré — et la phrase le dit").toMatch(/votre accord sur la pièce est enregistré/);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: d.validation }, select: { status: true } })).status).toBe("APPROVED");
  }, 90_000);

  it("L'ANNULATION PASSE APRÈS L'ACCORD, AVANT L'ÉMISSION : aucun ordre n'est émis — le centre n'est pas sollicité pour rien", async () => {
    const d = await demandeAvecPiece("hôtel des orateurs");
    const assistante = await actorFor(u.asst!, roles.asst!);
    ACTOR = await actorFor(u.val!, roles.val!);
    const decision = await pendantQueBloque({ table: "User", id: u.val! },
      () => decideValidation(form({ stepId: d.etape, decision: "APPROVED" })),
      async () => {
        // PRÉMISSE : l'accord est écrit, la décision attend à son journal — elle n'a encore rien relu de la demande.
        expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: d.validation }, select: { status: true } })).status).toBe("APPROVED");
        ACTOR = assistante;
        const a = await annulerDemandeAuSecretariat(form({ id: d.id, motif: "l'hôtel est pris en charge par l'organisateur" }));
        expect(a.ok, err(a) ?? "").toBe(true);
      });

    expect(await ordresDe(d.id), "une demande annulée ne reçoit pas d'ordre, même aussitôt annulé").toHaveLength(0);
    expect(decision.ok).toBe(false);
    expect(err(decision)).toMatch(/a été annulée ou supprimée : votre accord sur la pièce est enregistré, mais aucun paiement n'a été émis/);
  }, 90_000);

  it("UNE DEMANDE MISE À LA CORBEILLE par l'assistante : sa pièce validée ensuite n'émet aucun paiement", async () => {
    const d = await demandeAvecPiece("navette de l'aéroport");
    await comme("asst");
    const sup = await deleteRequests(form({ ids: d.id, reason: "doublon d'une autre demande" }));
    expect(sup.ok, err(sup) ?? "").toBe(true);
    // LA CORBEILLE RETIRE LA VALIDATION DE LA PIÈCE (audit du 14/10/2026) — avant, elle restait à trancher, et seule
    // la garde de la décision empêchait le paiement. Supprimer passe désormais par la porte de l'annulation.
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: d.validation }, select: { status: true } })).status).toBe("CANCELLED");
    await comme("val");
    const r = await decideValidation(form({ stepId: d.etape, decision: "APPROVED" }));
    expect(r.ok).toBe(false);
    expect(await ordresDe(d.id), "une demande supprimée ne reçoit pas de paiement").toHaveLength(0);
  });
});
