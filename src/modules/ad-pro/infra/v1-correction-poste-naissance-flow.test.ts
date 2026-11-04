import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { updateAdProRequest } from "../actions-edition";
import { montantDzd } from "@/lib/utils";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__v1naissance__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT V1 (Direction, 03/11/2026 : « si on veut changer, on peut modifier ») — trouvé par l'ÉCRAN.
 *
 * Le National Sales renvoie un sponsoring : « ramenez le montant suggéré à 750 000 DZD ». Le délégué corrige la
 * demande (« Modifier ») et la resoumet. La fiche affiche bien 750 000 — mais le POSTE né avec la demande, chiffré
 * à la suggestion d'origine, gardait 800 000 : c'est lui que la Direction Marketing accorde et que la porte du DG
 * additionne. La correction demandée par le circuit n'atteignait pas l'argent.
 *
 * Règle : le poste de naissance SUIT la correction tant qu'il est encore celui de la naissance — brouillon, non
 * accordé, chiffré exactement à l'ancienne suggestion. Un poste que quelqu'un a déjà rechiffré, réparti ou soumis
 * n'est jamais réécrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Lot V1 — corriger le montant suggéré d'un sponsoring corrige son poste de naissance", () => {
  let kam = "", spo = "", spoRechiffre = "";

  beforeAll(async () => {
    kam = (await prisma.user.create({ data: { name: `${TAG}kam`, email: `${RUN}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } })).id;
    const creer = (suffixe: string, estime: number) => prisma.sponsoringRequest.create({
      data: {
        reference: `${RUN}-${suffixe}`, type: "Congrès", institution: `${RUN} ${suffixe}`, requesterId: kam, createdById: kam,
        status: "RETURNED", nature: "DIRECT", amountRequested: 850_000.5, amountProposed: 800_000.25,
        items: { create: { kind: "ASSOCIATION_SUPPORT", label: `${TAG}poste ${suffixe}`, amountEstimated: estime, supplier: "Asso", position: 1,
          notes: `Sponsoring demandé par le médecin : ${montantDzd(850_000.5)} · suggéré par le délégué : ${montantDzd(800_000.25)}.` } },
      },
    });
    spo = (await creer("A", 800_000.25)).id;
    spoRechiffre = (await creer("B", 640_000)).id;
  }, 60_000);

  afterAll(async () => {
    const ids = [spo, spoRechiffre].filter(Boolean);
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [kam].filter(Boolean) } } }).catch(() => {});
  }, 60_000);

  it("le poste de naissance prend le nouveau montant suggéré (et sa note le dit)", async () => {
    ACTOR = await acteur(kam, "MEDICAL_DELEGATE");
    const r = await updateAdProRequest(fd({ kind: "SPONSORING", id: spo, amountProposed: "750000.75" }));
    expect(r.ok, r.error ?? "").toBe(true);
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spo } });
    expect(Number(poste.amountEstimated)).toBe(750_000.75);
    expect(poste.notes).toContain(montantDzd(750_000.75));
  });

  it("un poste déjà rechiffré par quelqu'un n'est pas réécrit", async () => {
    ACTOR = await acteur(kam, "MEDICAL_DELEGATE");
    const r = await updateAdProRequest(fd({ kind: "SPONSORING", id: spoRechiffre, amountProposed: "750000.75" }));
    expect(r.ok, r.error ?? "").toBe(true);
    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spoRechiffre } });
    expect(Number(poste.amountEstimated)).toBe(640_000);
  });
});
