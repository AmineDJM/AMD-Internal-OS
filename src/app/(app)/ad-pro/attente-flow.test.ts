import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { advanceWorkflow } from "@/lib/actions/workflow-actions";
import { createAdProOtherRequest } from "@/modules/ad-pro/actions-autres";
import { adProState, type AdProRequest } from "@/modules/ad-pro/partage";
import { lignesAvecAttente } from "./attente";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__adprolist__";
const RUN = `${TAG}${Date.now().toString(36)}`;

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU AD & PRO DIT CHEZ QUI EN EST CHAQUE DEMANDE — sur un vrai circuit, par les vrais points d'entrée.
 *
 * La demande d'un délégué entre chez son National Sales : pour lui, elle est « À vous » ; pour le délégué, elle est
 * « chez National Sales » ; pour le Super Admin, qui passe partout, elle n'est pas marquée — il n'en est pas le
 * destinataire. Renvoyée pour correction, elle passe « À vous » chez le délégué. Close, elle n'attend plus personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — le tableau : chez qui, depuis quand, à vous (lecture d'affichage)", () => {
  const ROLES = { kam: "MEDICAL_DELEGATE", ns: "NATIONAL_SALES", sa: "SUPER_ADMIN" } as const;
  type Qui = keyof typeof ROLES;
  const u = {} as Record<Qui, string>;

  async function acteur(qui: Qui): Promise<CurrentUser> {
    const id = u[qui];
    const access = await getAccess(id, ROLES[qui] as SessionUser["role"]);
    const x = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: x.name, email: x.email, role: ROLES[qui] as SessionUser["role"], access, mustChangePassword: false };
  }
  const ligneDe = async (id: string): Promise<AdProRequest> => {
    const d = await prisma.adProOtherRequest.findUniqueOrThrow({ where: { id } });
    return {
      id, kind: "OTHER", reference: d.reference, title: d.title, beneficiary: null, amount: null, status: d.status,
      state: adProState(d.status), requester: "Délégué", createdAt: d.createdAt.toISOString(), href: `/ad-pro/autres/${id}`,
    };
  };
  const vue = async (qui: Qui, id: string) => (await lignesAvecAttente(await acteur(qui), [await ligneDe(id)]))[0]!;

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as Qui[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({
      data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" },
    })));
    cles.forEach((k, i) => { u[k] = comptes[i]!.id; });
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const autres = (await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: RUN } }, select: { id: true } }).catch(() => [])).map((r) => r.id);
    const instances = (await prisma.workflowInstance.findMany({ where: { entityType: "AD_PRO_OTHER", entityId: { in: autres } }, select: { id: true } }).catch(() => [])).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: instances } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: instances } } }).catch(() => {});
    for (const id of autres) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: autres } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { id: { in: autres } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  let id = "";

  it("en circuit : « À vous » chez celui qui tient l'étape, « chez … » pour le demandeur, rien de marqué pour le Super Admin", async () => {
    ACTOR = await acteur("kam");
    const r = await createAdProOtherRequest(undefined, fd({ title: `${RUN} Abonnement revue`, description: "Abonnement", amount: "300000" }));
    expect(r.ok, r.error ?? "").toBe(true);
    id = r.id!;

    const ns = await vue("ns", id);
    expect(ns.aVous).toBe(true);
    expect(ns.chezQui).toBe("vous");
    expect(ns.etape).toBeTruthy();
    expect(ns.depuis, "depuis l'entrée dans l'étape").toBeTruthy();

    const kam = await vue("kam", id);
    expect(kam.aVous).toBe(false);
    expect(kam.chezQui, "le rôle qui tient l'étape, en clair").toBe("National Sales");
    expect(kam.depuis).toBe(ns.depuis);

    const sa = await vue("sa", id);
    expect(sa.aVous, "le Super Admin passe partout, mais l'étape ne lui est pas adressée").toBe(false);
    expect(sa.chezQui).toBe("National Sales");
  });

  it("renvoyée pour correction : la main passe au demandeur", async () => {
    ACTOR = await acteur("ns");
    const r = await advanceWorkflow(fd({ entityType: "AD_PRO_OTHER", entityId: id, action: "RETURN", note: "Joindre le devis." }));
    expect(r.ok, r.error ?? "").toBe(true);

    const kam = await vue("kam", id);
    expect(kam.state).toBe("RETURNED");
    expect(kam.aVous).toBe(true);
    expect(kam.chezQui).toBe("vous");
    const ns = await vue("ns", id);
    expect(ns.aVous).toBe(false);
    expect(ns.chezQui).toBe("le demandeur");
  });

  it("une demande close n'attend plus personne : ni « chez qui », ni « depuis », ni échéance", async () => {
    const close = { ...(await ligneDe(id)), status: "DONE", state: "DONE" as const };
    const [l] = await lignesAvecAttente(await acteur("kam"), [close]);
    expect(l).toMatchObject({ chezQui: null, aVous: false, depuis: null, echeance: null, id });
  });
});
