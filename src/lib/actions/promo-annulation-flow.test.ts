import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { statutDuDossier } from "@/lib/promo-material/statut";
import { cancelPromoMaterial } from "./promo-material-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__promoannul__";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ANNULER UN DOSSIER DE MATÉRIEL PROMOTIONNEL — et ne plus le faire passer pour un REFUS (audit
 * 360°, R17/R18, lot C4a).
 *
 * L'annulation partait sans motif et posait l'état terminal du circuit (« REFUSED ») : la fiche
 * affichait « Refusé », et le demandeur croyait que la Direction avait dit non. Elle dit désormais
 * pourquoi — APRÈS les refus structurels (§118.18) —, au fil et au demandeur ; le dossier affiche
 * « Annulé » ; deux annulations simultanées n'en écrivent qu'une.
 *
 * Le demandeur est la Direction Marketing, sans vue globale (§118.104) : c'est elle qui annule son
 * dossier, et c'est sur elle que la garde « demandeur » se juge.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — annuler avec un motif, « Annulé » et non « Refusé » (flux réel)", () => {
  let demandeurId = "", autreId = "";

  const dossier = (suffix: string, data: Partial<Prisma.PromoMaterialUncheckedCreateInput> = {}) =>
    prisma.promoMaterial.create({
      data: { reference: `${TAG}${suffix}`, title: `${TAG} ${suffix}`, requesterId: demandeurId, circuitVersion: 2, circuitState: "REVIEW_REQUEST", ...data },
      select: { id: true },
    }).then((d) => d.id);
  const lire = (id: string) => prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { status: true, circuitState: true, circuitVersion: true } });
  const fil = (id: string) =>
    prisma.comment.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: id }, select: { body: true } });

  async function attendreBloques(tx: Prisma.TransactionClient, motif: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${motif}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${motif}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    demandeurId = (await mk("demandeur", "PRODUCT_MANAGER")).id;
    autreId = (await mk("autre", "PRODUCT_MANAGER")).id;
  });

  afterAll(async () => {
    const ids = (await prisma.promoMaterial.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    await prisma.comment.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("PRÉMISSE : le demandeur n'a pas la vue globale — c'est en DEMANDEUR qu'il annule", async () => {
    expect(hasGlobalView((await actorFor(demandeurId, "PRODUCT_MANAGER")).role)).toBe(false);
  });

  it("L'ÉTAT D'ABORD : un dossier clos ou porté par un autre ne demande pas de motif ; un dossier annulable, si — et sans lui rien n'est écrit", async () => {
    ACTOR = await actorFor(demandeurId, "PRODUCT_MANAGER");
    const clos = await dossier("clos", { status: "CANCELLED", circuitState: "REFUSED" });
    expect((await cancelPromoMaterial(form({ id: clos }))).error, "§118.18").toBe("Dossier déjà clôturé.");
    const dAutrui = await dossier("autrui", { requesterId: autreId });
    expect((await cancelPromoMaterial(form({ id: dAutrui }))).error).toBe("Non autorisé.");

    const id = await dossier("sansmotif");
    expect((await cancelPromoMaterial(form({ id }))).error).toMatch(/Dites pourquoi ce dossier est annulé/);
    expect(await lire(id)).toMatchObject({ status: "PROSPECTION_REQUESTED", circuitState: "REVIEW_REQUEST" });
    expect(await fil(id)).toHaveLength(0);
  });

  it("ANNULÉ AVEC SON MOTIF : le circuit s'arrête, le motif va au fil — et le dossier affiche « Annulé », pas « Refusé »", async () => {
    ACTOR = await actorFor(demandeurId, "PRODUCT_MANAGER");
    const id = await dossier("annule");
    const r = await cancelPromoMaterial(form({ id, motif: "Le congrès est reporté à 2027." }));
    expect(r.ok, r.error).toBe(true);
    const d = await lire(id);
    expect(d).toMatchObject({ status: "CANCELLED", circuitState: "REFUSED" });
    expect((await fil(id)).map((l) => l.body)).toContain("Dossier annulé — Le congrès est reporté à 2027.");
    const affiche = statutDuDossier({ status: d.status, circuitState: d.circuitState, circuitVersion: d.circuitVersion, returnedAt: null });
    expect(affiche.libelle, "un dossier annulé par son demandeur n'a pas été refusé par la Direction").toBe("Annulé");
    // Le TÉMOIN : un dossier que le circuit a réellement refusé se lit toujours « Refusé ».
    const refuse = statutDuDossier({ status: "PROSPECTION_REQUESTED", circuitState: "REFUSED", circuitVersion: 2, returnedAt: null });
    expect(refuse.libelle).not.toBe("Annulé");
    expect(refuse.ton).toBe("danger");
  });

  it("DEUX ANNULATIONS à la même seconde : une seule s'écrit — un motif au fil, pas deux", async () => {
    const id = await dossier("double");
    const d = await actorFor(demandeurId, "PRODUCT_MANAGER");
    let pa!: ReturnType<typeof cancelPromoMaterial>, pb!: ReturnType<typeof cancelPromoMaterial>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoMaterial" IN SHARE MODE`);
      ACTOR = d; pa = cancelPromoMaterial(form({ id, motif: "Premier clic." }));
      ACTOR = d; pb = cancelPromoMaterial(form({ id, motif: "Second clic." }));
      await attendreBloques(tx, "PromoMaterial", 2);
    }, { timeout: 20_000 });
    const [a, b] = [await pa, await pb];
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((a.ok ? b : a).error).toMatch(/vient de changer d'état/);
    expect((await fil(id)).filter((l) => l.body.startsWith("Dossier annulé"))).toHaveLength(1);
  });
});
