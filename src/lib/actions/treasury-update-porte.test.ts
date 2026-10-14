import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { requestTreasuryUpdate } from "./finance-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__porteTresorerie__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * « DEMANDER L'ACTUALISATION DES SOLDES » — LE SUPER ADMIN, ET LUI SEUL.
 *
 * ── POURQUOI LA PORTE S'EST RESSERRÉE ───────────────────────────────────────────────────────
 *
 * Le geste ne modifie rien : il SONNE chez tous les responsables Finances pour qu'ils mettent la
 * trésorerie à jour. Ouvert à toute la direction, il devient une sonnerie fréquente — et une
 * sonnerie fréquente finit par n'être plus écoutée, y compris le jour où le solde est vraiment
 * douteux. La valeur du signal tient à sa rareté.
 *
 * ── POURQUOI CE TEST PORTE SUR L'ACTION, PAS SUR LE BOUTON ──────────────────────────────────
 *
 * Le bouton a disparu de l'écran pour les autres, et cela ne prouve rien : une action serveur
 * s'appelle depuis le navigateur sans passer par l'écran. C'est CETTE ligne-là qui refuse
 * (§118-7) — l'écran ne fait que ne pas proposer ce qui serait refusé.
 */
suite("La demande d'actualisation des soldes est réservée au Super Admin", () => {
  let adminId = "";
  let dgId = "";
  let deleId = "";

  beforeAll(async () => {
    const [a, d, m] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} admin`, email: `${TAG}a@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} dg`, email: `${TAG}d@t.dz`, role: "GENERAL_MANAGER", passwordHash: "x" }, select: { id: true } }),
      prisma.user.create({ data: { name: `${TAG} delegue`, email: `${TAG}m@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" }, select: { id: true } }),
    ]);
    adminId = a.id; dgId = d.id; deleId = m.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { title: { contains: "solde de trésorerie" } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminId, dgId, deleId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("LE SUPER ADMIN DEMANDE — et la demande part", async () => {
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    const fd = new FormData();
    fd.set("note", "Avant le conseil de lundi");
    const r = await requestTreasuryUpdate(fd);
    expect(r.ok, r.error).toBe(true);
  });

  it("LE DIRECTEUR GÉNÉRAL NE DEMANDE PLUS — une vision globale ne suffit plus", async () => {
    // C'est le cas qui a changé : il passait par `hasGlobalView`. Le refus vient du SERVEUR.
    ACTOR = await actorFor(dgId, "GENERAL_MANAGER");
    const r = await requestTreasuryUpdate(new FormData());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Super Admin/);
  });

  it("et un délégué encore moins", async () => {
    ACTOR = await actorFor(deleId, "MEDICAL_DELEGATE");
    expect((await requestTreasuryUpdate(new FormData())).ok).toBe(false);
  });

  it("LA DEMANDE MÈNE LÀ OÙ ELLE SE TRAITE — la Comptabilité, pas un écran supprimé", async () => {
    // Elle pointait vers `/finances`, le tableau de bord. Il n'existe plus : la notification doit
    // conduire à l'écran où les soldes se saisissent (« Soldes d'ouverture »).
    ACTOR = await actorFor(adminId, "SUPER_ADMIN");
    expect((await requestTreasuryUpdate(new FormData())).ok).toBe(true);
    const notif = await prisma.notification.findFirst({
      where: { title: { contains: "solde de trésorerie" } },
      orderBy: { createdAt: "desc" },
      select: { link: true },
    });
    expect(notif?.link).toBe("/finances/comptabilite");
  });
});
