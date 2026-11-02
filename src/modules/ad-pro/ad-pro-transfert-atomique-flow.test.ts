import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN TRANSFERT EST UN SEUL FAIT (audit 27/10/2026, ADPRO-09).
 *
 * Le transfert créait la demande cible, déplaçait les pièces, PUIS fermait la source — sans
 * transaction ni écriture conditionnelle. La file en mémoire (`enSerie`, ADPRO-05) ne tient que dans
 * un processus : deux instances de l'application (ou un échec entre deux écritures) laissaient deux
 * demandes cibles pour une source, ou une cible créée avec la source restée ouverte.
 *
 * Désormais la source est PRISE d'abord, conditionnellement (« encore ouverte »), et la cible, les
 * pièces et la note de fermeture s'écrivent dans la même transaction. Le banc retire la file en
 * mémoire (deux processus) et fait se rejoindre les deux transferts au même point du geste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
// DEUX PROCESSUS : la file en mémoire n'existe pas de l'un à l'autre. LE RENDEZ-VOUS : chaque transfert
// attend l'autre (au plus 1,5 s) au moment de numéroter sa cible — si l'un ne l'atteint pas (il attend la
// prise de l'autre), le premier repart seul.
let RDV = false;
let arrives = 0;
let liberer: () => void = () => {};
const tousLa = new Promise<void>((r) => { liberer = r; });
vi.mock("@/lib/refs", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/refs")>();
  return {
    ...reel,
    enSerie: <T>(_cle: string, fn: () => Promise<T>) => fn(),
    referenceDeSerie: async (...a: Parameters<typeof reel.referenceDeSerie>) => {
      if (RDV) {
        arrives++;
        if (arrives >= 2) liberer();
        await Promise.race([tousLa, new Promise((r) => setTimeout(r, 1500))]);
      }
      return reel.referenceDeSerie(...a);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { transferAdProRequest } from "./actions-transfert";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__transat${Date.now()}__`;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("ADPRO-09 — deux transferts simultanés de la même demande, sans file commune", () => {
  let saId = "", kamId = "", sourceId = "";

  beforeAll(async () => {
    saId = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } })).id;
    kamId = (await prisma.user.create({ data: { name: `${TAG}kam`, email: `${TAG}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    sourceId = (await prisma.congressNational.create({ data: { name: `${TAG} Congrès`, requesterId: kamId, requestStatus: "AWAITING_PRELIMINARY" } })).id;
    ACTOR = { id: saId, name: "SA", email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", secondaryRole: null, access: await getAccess(saId, "SUPER_ADMIN"), mustChangePassword: false } as unknown as CurrentUser;
  }, 60_000);

  afterAll(async () => {
    const cibles = (await prisma.sponsoringRequest.findMany({ where: { requesterId: kamId }, select: { id: true } })).map((c) => c.id);
    const inst = (await prisma.workflowInstance.findMany({ where: { entityId: { in: [sourceId, ...cibles] } }, select: { id: true } })).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: inst } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: inst } } }).catch(() => {});
    for (const id of [sourceId, ...cibles]) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: cibles } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: sourceId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [saId, kamId] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: saId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [saId, kamId] } } }).catch(() => {});
  }, 60_000);

  it("une seule demande cible ; l'autre transfert est refusé, la source close une fois", async () => {
    RDV = true;
    const geste = () => transferAdProRequest(undefined, fd({ from: "CONGRESS_NATIONAL", to: "SPONSORING", sourceId }));
    const [a, b] = await Promise.all([geste(), geste()]);
    RDV = false;
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect(await prisma.sponsoringRequest.count({ where: { requesterId: kamId } }), "une seule cible").toBe(1);
    expect((await prisma.congressNational.findUniqueOrThrow({ where: { id: sourceId } })).requestStatus).toBe("CANCELLED");
  });
});
