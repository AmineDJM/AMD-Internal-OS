import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'OUVERTURE D'UN CIRCUIT NE CACHE PLUS UNE PANNE (audit 27/10/2026, ADPRO-11).
 *
 * `ensureInstance` enveloppait la création ET toute la suite (journal, prévalidation d'office,
 * franchissements) dans un `catch {}` qui relisait l'instance par la demande. Une panne réelle
 * (base indisponible, contrainte violée) devenait « Impossible d'initialiser le circuit » sans trace,
 * ou rendait l'instance posée par un autre geste comme si c'était la sienne.
 *
 * Désormais : seule la COURSE (P2002 — un autre geste a créé l'instance au même instant) rend
 * l'instance existante ; toute autre erreur de création remonte.
 * La panne est injectée par un mandataire sur le seul `workflowInstance.create`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let PANNE = false;
vi.mock("@/lib/prisma", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/prisma")>();
  const instances = new Proxy({}, {
    get: (_t, k: string) => (...a: unknown[]) => {
      if (k === "create" && PANNE) throw new Error("panne simulée de la base");
      return (reel.prisma.workflowInstance as unknown as Record<string, (...x: unknown[]) => unknown>)[k](...a);
    },
  });
  const prisma = new Proxy(reel.prisma, { get: (t, k) => (k === "workflowInstance" ? instances : (t as unknown as Record<string | symbol, unknown>)[k]) });
  return { ...reel, prisma };
});

import { prisma } from "@/lib/prisma";
import { ensureInstance } from "@/lib/workflow/engine";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__ouvcirc${Date.now()}__`;

suite("ensureInstance : la course rend l'existante, la panne remonte", () => {
  const spos: string[] = [];
  const sponsoring = async () => {
    const s = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}${spos.length}`, institution: `${TAG} Hôpital`, type: "Congrès" } });
    spos.push(s.id);
    return s.id;
  };
  afterAll(async () => {
    PANNE = false;
    const ids = (await prisma.workflowInstance.findMany({ where: { entityId: { in: spos } }, select: { id: true } })).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: ids } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
  });

  it("une panne à la création n'est plus avalée : elle remonte, sans instance fantôme", async () => {
    const id = await sponsoring();
    PANNE = true;
    try {
      await expect(ensureInstance("SPONSORING", id)).rejects.toThrow(/panne simulée/);
    } finally {
      PANNE = false;
    }
    expect(await prisma.workflowInstance.count({ where: { entityType: "SPONSORING", entityId: id } })).toBe(0);
  });

  it("deux ouvertures simultanées rendent LA MÊME instance (la course, elle, reste rattrapée)", async () => {
    const id = await sponsoring();
    const [a, b] = await Promise.all([ensureInstance("SPONSORING", id), ensureInstance("SPONSORING", id)]);
    expect(a?.id).toBeTruthy();
    expect(a?.id).toBe(b?.id);
  });
});
