import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
/** Seuil injecté dans ce processus (la base partagée garde le sien, §118.132). */
const SEUIL_DG = 100_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { lirePorteDg, statuerSurLeTotal, totalDeLaDemande } from "./porte-dg";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__v1portects__";
const RUN = `${TAG}${Date.now().toString(36)}`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V1 (Direction, 03/11/2026 : « les sommes des calculs sont bonnes ») — LE TOTAL DE LA PORTE DU DG
 * EN CENTIMES.
 *
 * Le défaut trouvé : le total d'une demande s'additionnait en flottants (100 000,10 + 200 000,20 =
 * 300 000,30000000005). Le DG validait ce total ; la base le gardait en Decimal(14,2) — 300 000,30 — et la
 * relecture comparait 300 000,30 ≥ 300 000,30000000005 : FAUX. La porte se refermait aussitôt validée,
 * « sa validation est de nouveau requise », et aucun BC ni paiement ne partait. Environ 4 % des montants à
 * centimes tombent dans ce cas.
 *
 * Calcul indépendant du banc : les centimes ENTIERS, additionnés en entiers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Lot V1 — la porte du DG relit le total qu'il a validé (centimes)", () => {
  let dg = "", kam = "", spo = "";

  beforeAll(async () => {
    dg = (await prisma.user.create({ data: { name: `${TAG}dg`, email: `${RUN}dg@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" } })).id;
    kam = (await prisma.user.create({ data: { name: `${TAG}kam`, email: `${RUN}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    spo = (await prisma.sponsoringRequest.create({
      data: {
        reference: `${RUN}-SPO`, type: "Congrès", institution: `${RUN} Société savante`, requesterId: kam, status: "PRE_VALIDATED",
        items: {
          create: [
            { kind: "PRINTING", label: `${TAG}Imprimerie`, amountEstimated: 100_000.1, position: 1 },
            { kind: "ACCOMMODATION", label: `${TAG}Hôtel`, amountEstimated: 200_000.2, position: 2 },
          ],
        },
      },
    })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.adProPorteDg.deleteMany({ where: { entityId: spo } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: spo } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: spo } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { link: { contains: spo } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: spo } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spo } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spo } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [dg, kam].filter(Boolean) } } }).catch(() => {});
  }, 60_000);

  it("le total se lit au centime près, comme le calcul indépendant en centimes entiers", async () => {
    const attenduCentimes = 10_000_010 + 20_000_020;
    expect(await totalDeLaDemande("SPONSORING", spo)).toBe(attenduCentimes / 100);
  });

  it("le DG valide 300 000,30 DZD : la porte est VALIDÉE à la relecture, pas refermée", async () => {
    const avant = await lirePorteDg("SPONSORING", spo);
    expect(avant.etat).toBe("EN_ATTENTE");
    const r = await statuerSurLeTotal({ user: { id: dg, name: `${TAG}dg`, role: "GENERAL_MANAGER" }, parent: "SPONSORING", parentId: spo, decision: "VALIDEE", totalVu: avant.total, note: null });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const apres = await lirePorteDg("SPONSORING", spo);
    expect(apres.etat, apres.phrase ?? "").toBe("VALIDEE");
    expect(apres.refus).toBeNull();
  });
});
