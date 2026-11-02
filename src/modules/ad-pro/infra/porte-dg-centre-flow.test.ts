import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE LIT LES TOTAUX DU DG EN LOT (audit 27/10/2026, ADPRO-07).
 *
 * `totauxEnAttenteDuDg` relisait, POUR CHACUNE des 300 demandes signalées, la porte (trois requêtes)
 * et le demandeur (une) : jusqu'à ~1 500 allers-retours séquentiels à chaque ouverture du centre. Et
 * `signaleMontant` restait posé après la décision du DG : la liste à relire ne faisait que grossir.
 *
 * Le banc compte les appels à la base pendant la lecture : leur nombre ne dépend plus du nombre de
 * demandes. Le seuil est injecté (§118.132) ; le total reste LE calcul de `totalDeLaDemande`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});
let COMPTER = false;
let APPELS = 0;
vi.mock("@/lib/prisma", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/prisma")>();
  const brut = reel.prisma as unknown as Record<string | symbol, unknown>;
  const delegues = new Map<string, unknown>();
  const prisma = new Proxy(brut, {
    get: (t, k) => {
      const v = t[k];
      if (typeof k !== "string" || k.startsWith("$") || typeof v !== "object" || v === null) return v;
      if (!delegues.has(k)) {
        delegues.set(k, new Proxy({}, {
          get: (_d, m: string) => (...a: unknown[]) => {
            if (COMPTER) APPELS++;
            return (v as Record<string, (...x: unknown[]) => unknown>)[m](...a);
          },
        }));
      }
      return delegues.get(k);
    },
  });
  return { ...reel, prisma };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { totauxEnAttenteDuDg, totalDeLaDemande, statuerSurLeTotal } from "./porte-dg";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__dgcentre${Date.now()}__`;
const N = 8;

suite("ADPRO-07 — les totaux en attente du DG, en lot", () => {
  const events: string[] = [];
  let dgId = "";

  beforeAll(async () => {
    dgId = (await prisma.user.create({ data: { name: `${TAG}dg`, email: `${TAG}dg@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" } })).id;
    for (let i = 0; i < N; i++) {
      const e = await prisma.event.create({ data: { name: `${TAG} Symposium ${i}`, requesterId: dgId } });
      events.push(e.id);
      // Deux postes : l'un accordé (l'accordé prime), l'autre seulement estimé ; un refusé ne compte pas.
      await prisma.adProItem.createMany({
        data: [
          { eventId: e.id, label: `${TAG} salle`, amountEstimated: 900_000, amountGranted: 800_000 + i * 1000 },
          { eventId: e.id, label: `${TAG} traiteur`, amountEstimated: 400_000 },
          { eventId: e.id, label: `${TAG} refusé`, amountEstimated: 9_000_000, status: "REJECTED" },
        ],
      });
      await prisma.adProPorteDg.create({ data: { entityType: "EVENT", entityId: e.id, signaleMontant: 1_200_000 + i * 1000, signaleLe: new Date() } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.adProItem.deleteMany({ where: { eventId: { in: events } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: events } } }).catch(() => {});
    const inst = (await prisma.workflowInstance.findMany({ where: { entityId: { in: events } }, select: { id: true } }).catch(() => [])).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: inst } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: inst } } }).catch(() => {});
    for (const id of events) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: dgId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: events } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: dgId } }).catch(() => {});
  }, 60_000);

  it("les mêmes totaux que le calcul unitaire, en un nombre de requêtes qui ne dépend pas des demandes", async () => {
    COMPTER = true; APPELS = 0;
    const lus = await totauxEnAttenteDuDg();
    COMPTER = false;
    const nos = lus.filter((l) => events.includes(l.entityId));
    expect(nos).toHaveLength(N);
    for (const l of nos) {
      expect(l.total).toBe(await totalDeLaDemande("EVENT", l.entityId));
      expect(l.nom).toMatch(/^Événement — /);
      expect(l.requesterId).toBe(dgId);
    }
    // Avant : 1 + N × 3 au moins (porte, postes, demandeur) ; en lot : une poignée par type de demande.
    expect(APPELS, `${APPELS} requêtes pour ${lus.length} demandes`).toBeLessThanOrEqual(13);
  });

  it("le DG statue : le signalement est levé, la demande quitte la liste à relire", async () => {
    const id = events[0];
    const total = await totalDeLaDemande("EVENT", id);
    const r = await statuerSurLeTotal({ user: { id: dgId, name: "DG", role: "GENERAL_MANAGER" }, parent: "EVENT", parentId: id, decision: "VALIDEE", totalVu: total, note: null });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect((await prisma.adProPorteDg.findFirstOrThrow({ where: { entityId: id } })).signaleMontant).toBeNull();
  });
});
