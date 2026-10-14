import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { deleteFileByKey } from "@/lib/storage";
import { createPromoMaterial } from "./promo-material-actions";
import { validatePromoStep } from "./promo-circuit-actions";
import { enregistrerDevisPromo, redemanderDevisPromo, retirerDemandeDevisPromo, terminerRetranscriptionPromo, demanderDevisPromo } from "./promo-devis-actions";
import { annulerDemandeAuSecretariat, deleteOwnRequest } from "./admin-request-actions";
import type { ActionResult } from "./types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__pdretrait__${Date.now().toString(36)}`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, nom.length])], nom, { type: "application/pdf" });
const err = (r: ActionResult) => (r.ok ? "" : r.error ?? "");
function reussi(r: ActionResult, quoi: string): ActionResult {
  if (!r.ok) throw new Error(`${quoi} : ${r.error}`);
  return r;
}
const etape = async (id: string) => (await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true } })).circuitState;
const demandesDe = (id: string) => prisma.administrativeRequest.findMany({
  where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: id, type: "QUOTE" }, orderBy: { createdAt: "asc" },
  select: { id: true, status: true, deletedAt: true },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RETIRER LA DEMANDE DE DEVIS DU MATÉRIEL PROMOTIONNEL (audit du 04/10, constat 35) — par les VRAIS
 * points d'entrée, avec un demandeur et une assistante SANS vue globale (§118.104).
 *
 * Avant : la demande ne se retirait que depuis « Demandes », et le dossier restait « devis demandés »
 * pour toujours. Désormais elle se retire DEPUIS LE DOSSIER, et quelle que soit la porte qui la retire
 * (le dossier, le demandeur dans « Demandes », le secrétariat), le dossier revient à l'étape d'avant
 * quand plus aucune demande de devis ne vit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — retirer la demande de devis, le circuit recule", () => {
  const u: Record<string, string> = {};
  let companyId = "", fourA = "", catCarnet = "";

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([mk("ops", "DIRECTION"), mk("dir", "PRODUCT_MANAGER"), mk("cp", "MEDICAL_PROMOTION_MANAGER"), mk("asst", "DIRECTION_ASSISTANT")]);
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    const emp: Record<string, string> = {};
    const e = async (k: string, managerKey: string | null) => {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], managerId: managerKey ? emp[managerKey] : null, companyId } })).id;
    };
    await e("ops", null);
    await e("dir", "ops");
    await Promise.all([e("cp", "dir"), e("asst", null)]);
    fourA = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "ZI", city: "Alger", companyId: null }, select: { id: true } })).id;
    catCarnet = (await prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-CARNET`, nom: `${TAG} Carnet`, famille: "CONSOMMABLE" }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u);
    const pmIds = (await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    const demandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: pmIds } }, select: { id: true } })).map((d) => d.id);
    await prisma.comment.deleteMany({ where: { OR: [{ entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] } }).catch(() => {});
    await prisma.promoMaterial.updateMany({ where: { id: { in: pmIds } }, data: { adminRequestId: null } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    const docs = await prisma.document.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, select: { id: true, fileKey: true } }).catch(() => []);
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => {});
    for (const d of docs) if (d.fileKey) await deleteFileByKey(d.fileKey).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { link: { in: pmIds.map((id) => `/promo-material/${id}`) } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); return ACTOR; };

  /** Un dossier de cp à l'étape « devis demandés » — la demande part d'elle-même à la validation. */
  async function auxDevisDemandes(titre: string): Promise<string> {
    await comme("cp");
    const r = await createPromoMaterial(undefined, form({
      title: `${TAG} ${titre}`,
      lignes: JSON.stringify([{ catalogueId: catCarnet, quantite: "500", actions: ["IMPRESSION"], commentaire: "A5" }]),
    }));
    if (!r.ok) throw new Error(r.error);
    await comme("dir");
    reussi(await validatePromoStep(form({ id: r.id! })), "valider la demande");
    expect(await etape(r.id!), "PRÉMISSE : la demande de devis est partie").toBe("QUOTE_REQUESTED");
    return r.id!;
  }
  async function devisComplet(id: string): Promise<void> {
    await comme("asst");
    const art = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: id } })).id;
    const f = form({
      promoMaterialId: id, supplierId: fourA, reference: "D-1", tvaRate: "19", announcedTotal: "50000",
      ligneReference: ["Carnet A5"], ligneQuantite: ["500"], lignePrix: ["100"], ligneAction: ["IMPRESSION"], ligneArticle: [art],
    });
    f.set("scan", pdf(`${TAG}-devis.pdf`));
    reussi(await enregistrerDevisPromo(f), "retranscrire un devis");
  }

  it("PRÉMISSES : ni le demandeur ni l'assistante n'ont la vue globale", async () => {
    expect(hasGlobalView((await comme("cp")).role)).toBe(false);
    expect(hasGlobalView((await comme("asst")).role)).toBe(false);
  });

  it("DEPUIS LE DOSSIER : motif exigé, la demande se clôt avec sa trace, le dossier revient à « devis à demander » — et la demande repart", async () => {
    const id = await auxDevisDemandes("Depuis le dossier");
    const [demande] = await demandesDe(id);
    await comme("asst");
    expect(err(await retirerDemandeDevisPromo(form({ promoMaterialId: id, motif: "x" }))), "l'assistante ne retire pas la demande d'un autre").toMatch(/Seul le demandeur/);
    await comme("cp");
    expect(err(await retirerDemandeDevisPromo(form({ promoMaterialId: id }))), "le motif est exigé").toMatch(/Dites pourquoi/);
    expect(await etape(id), "un refus ne touche à rien").toBe("QUOTE_REQUESTED");
    const r = reussi(await retirerDemandeDevisPromo(form({ promoMaterialId: id, motif: "Le salon est annulé." })), "retirer");
    expect(r.message ?? "").toMatch(/revient à « devis à demander »/);
    expect(await etape(id), "le dossier ne reste plus « devis demandés »").toBe("QUOTE_TO_REQUEST");
    expect((await demandesDe(id))[0]!.status).toBe("CANCELLED");
    expect(await prisma.comment.count({ where: { entityType: "ADMIN_REQUEST", entityId: demande!.id, body: { contains: "Le salon est annulé." } } }), "la trace va à la demande").toBe(1);
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: id, body: { contains: "Demande de devis retirée" } } }), "et au fil du dossier").toBe(1);
    // Rien ne retient plus le dossier : la demande repart, par le geste de l'écran.
    reussi(await demanderDevisPromo(form({ promoMaterialId: id })), "redemander");
    expect(await etape(id)).toBe("QUOTE_REQUESTED");
  });

  it("EXÉCUTÉE : un devis déjà retranscrit refuse le retrait — AVANT le motif, en le nommant, et rien ne bouge", async () => {
    const id = await auxDevisDemandes("Déjà retranscrite");
    await devisComplet(id);
    await comme("cp");
    const r = await retirerDemandeDevisPromo(form({ promoMaterialId: id }));
    expect(err(r), "l'état refuse avant qu'on demande pourquoi").toMatch(/déjà retranscrit 1 devis/);
    expect(await etape(id)).toBe("QUOTE_REQUESTED");
    expect((await demandesDe(id)).every((d) => d.status !== "CANCELLED")).toBe(true);
    expect((await demandesDe(id)).length, "PRÉMISSE : la liste n'est pas vide").toBeGreaterThan(0);
  });

  it("UNE DEMANDE DE NOUVEAUX DEVIS retirée ramène au CHOIX DES LIGNES — les devis reçus restent", async () => {
    const id = await auxDevisDemandes("Redemande");
    await devisComplet(id);
    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer");
    await comme("cp");
    reussi(await redemanderDevisPromo(form({ promoMaterialId: id, note: "D'autres imprimeurs." })), "redemander");
    expect(await etape(id)).toBe("QUOTE_REQUESTED");
    reussi(await retirerDemandeDevisPromo(form({ promoMaterialId: id, motif: "Le premier devis suffit." })), "retirer la redemande");
    expect(await etape(id), "l'étape d'avant est le choix, pas « devis à demander »").toBe("REVIEW_REQUESTER");
    expect(await prisma.promoQuote.count({ where: { promoMaterialId: id } })).toBe(1);
  });

  it("DEPUIS « DEMANDES » : le demandeur qui retire sa demande, ou le secrétariat qui l'annule, fait aussi reculer le dossier", async () => {
    const a = await auxDevisDemandes("Par le demandeur");
    const [da] = await demandesDe(a);
    await comme("cp");
    reussi(await deleteOwnRequest(form({ id: da!.id, motif: "Plus besoin." })), "retirer depuis Demandes");
    expect(await etape(a)).toBe("QUOTE_TO_REQUEST");

    const b = await auxDevisDemandes("Par le secrétariat");
    const [db] = await demandesDe(b);
    await comme("asst");
    reussi(await annulerDemandeAuSecretariat(form({ id: db!.id, motif: "Doublon." })), "annuler au secrétariat");
    expect(await etape(b)).toBe("QUOTE_TO_REQUEST");
    expect(await prisma.notification.count({ where: { userId: u.cp!, title: "Demande de devis retirée", link: `/promo-material/${b}` } }), "le demandeur l'apprend : c'est son dossier qui recule").toBe(1);
  });

  it("COURSE FORCÉE : le dossier passe à une autre étape pendant le retrait — le retour conditionnel ne l'écrase pas", async () => {
    const id = await auxDevisDemandes("Course");
    await comme("cp");
    let geste!: Promise<ActionResult>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PromoMaterial" WHERE id = ${id} FOR UPDATE`;
      geste = retirerDemandeDevisPromo(form({ promoMaterialId: id, motif: "Course." }));
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
        if (n >= 1) break;
        if (Date.now() - debut > 15_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((res) => setTimeout(res, 25));
      }
      // Le détenteur fait avancer le dossier (une fin de retranscription jouée ailleurs).
      await tx.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_REQUESTER" } });
    }, { timeout: 30_000 });
    await geste;
    expect(await etape(id), "le dossier avancé n'est pas ramené en arrière").toBe("REVIEW_REQUESTER");
  });
});
