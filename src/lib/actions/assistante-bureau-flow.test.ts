import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getRequestList } from "@/lib/queries/admin-requests";
import { clauseDemandesSecretariatVisibles } from "@/lib/queries/visibilite-listes";
import { getActionCenter } from "@/lib/queries/action-center";
import { createRequest, decideApproval } from "./admin-request-actions";
import { peutLirePasseportDuSujet } from "@/modules/ad-pro/api";
import { canAccessEntity } from "@/lib/entity-access";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BUREAU DE L'ASSISTANTE DE DIRECTION — ce qui lui arrive, et ce qu'elle peut ouvrir
 * (§118.185 — audit 360°, I10).
 *
 * Trois impasses : le bureau ne chargeait que les 200 demandes les plus récentes, terminées
 * comprises (une demande ouverte ancienne disparaissait de toutes les vues) ; une demande sans
 * responsable — la valeur par défaut du formulaire — n'était signalée à personne ; le passeport
 * annoncé dans le sujet de réservation lui était refusé au téléchargement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__bureauasst${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}

suite("le bureau de l'assistante : tout ce qui est ouvert, ce que personne n'a pris, et le passeport", () => {
  let asstId = "", demandeurId = "", etrangerId = "", companyId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__bureauasst" } }, select: { id: true } })).map((u) => u.id);
    await prisma.document.deleteMany({ where: { name: { startsWith: "__bureauasst" } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: "__bureauasst" } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { title: { startsWith: "__bureauasst" } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: "__bureauasst" } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { OR: [{ title: { startsWith: "__bureauasst" } }, { requesterId: { in: comptes } }] } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    companyId = (await prisma.company.findFirst({ where: { isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } }))!.id;
    for (const [cle, role] of [["asst", "DIRECTION_ASSISTANT"], ["demandeur", "SALES_USER"], ["etranger", "SALES_USER"]] as const) {
      const u = await prisma.user.create({ data: { name: `${TAG} ${cle}`, email: `${TAG}${cle}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
      await prisma.employee.create({ data: { fullName: `${TAG} ${cle}`, userId: u.id, isActive: true, companyId } });
      if (cle === "asst") asstId = u.id; else if (cle === "demandeur") demandeurId = u.id; else etrangerId = u.id;
    }
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("UNE DEMANDE OUVERTE ANCIENNE reste dans le bureau, même derrière 205 demandes terminées plus récentes", async () => {
    // Le défaut : `take: 200` sur les plus récentes, terminées comprises. On en crée 205, plus
    // récentes que la demande ouverte : l'ancienne lecture la coupait à coup sûr.
    const ancienne = await prisma.administrativeRequest.create({
      data: { reference: `${TAG}OLD`, title: `${TAG} ancienne ouverte`, type: "OTHER", status: "NEW", requesterId: demandeurId, companyId, createdAt: new Date("2001-01-01") },
      select: { id: true },
    });
    await prisma.administrativeRequest.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        reference: `${TAG}D${i}`, title: `${TAG} terminée ${i}`, type: "OTHER" as const, status: "DONE" as const, requesterId: demandeurId, companyId,
      })),
    });
    const asst = await actorFor(asstId);
    const liste = await getRequestList(asst, {});
    expect(liste.rows.some((r) => r.id === ancienne.id), "la demande ouverte ancienne est chargée").toBe(true);
    // Les totaux sont RÉELS : l'écran dit ce qu'il montre et ce qu'il tait.
    expect(liste.terminees).toBeGreaterThanOrEqual(205);
    expect(liste.terminesMontrees).toBeLessThanOrEqual(100);
    // Le total des ouvertes est un COMPTE de la base, pas la longueur de ce qui a été chargé.
    const compte = await prisma.administrativeRequest.count({
      where: { AND: [await clauseDemandesSecretariatVisibles(asst), { status: { notIn: ["DONE", "CANCELLED"] } }] },
    });
    expect(liste.ouvertes).toBe(compte);
    expect(liste.coupe).toBe(compte > liste.rows.filter((r) => r.status !== "DONE" && r.status !== "CANCELLED").length);
  });

  it("UNE DEMANDE SANS RESPONSABLE est signalée au secrétariat, et apparaît « à prendre en charge » dans son espace", async () => {
    ACTOR = await actorFor(demandeurId);
    const fd = new FormData();
    fd.set("type", "OTHER");
    fd.set("title", `${TAG} sans responsable`);
    const r = await createRequest(undefined, fd);
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const id = r.ok ? r.id! : "";
    const avis = await prisma.notification.findMany({ where: { userId: asstId, link: `/demandes/${id}` }, select: { title: true } });
    expect(avis.map((a) => a.title)).toContain("Nouvelle demande au secrétariat");
    const centre = await getActionCenter(await actorFor(asstId));
    expect(centre.items.some((i) => i.href === `/demandes/${id}` && /à prendre en charge/.test(i.subtitle ?? "")), "listée dans son espace").toBe(true);
    // Le témoin : un demandeur ordinaire ne voit pas les demandes libres des autres dans SON espace.
    const autre = await getActionCenter(await actorFor(etrangerId));
    expect(autre.items.some((i) => i.href === `/demandes/${id}`)).toBe(false);
  });

  it("UNE DEMANDE VALIDÉE SANS RESPONSABLE revient au secrétariat — le N+1 dit oui, le bureau l'apprend", async () => {
    const req = await prisma.administrativeRequest.create({
      data: { reference: `${TAG}VAL`, title: `${TAG} achat à valider`, type: "OTHER", status: "AWAITING_VALIDATION", requesterId: demandeurId, companyId, validatorId: etrangerId },
      select: { id: true },
    });
    const ap = await prisma.adminApproval.create({ data: { requestId: req.id, requestedById: demandeurId, validatorId: etrangerId, status: "PENDING" }, select: { id: true } });
    ACTOR = await actorFor(etrangerId);
    const fd = new FormData();
    fd.set("approvalId", ap.id);
    fd.set("decision", "APPROVED");
    const r = await decideApproval(fd);
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const avis = await prisma.notification.findMany({ where: { userId: asstId, link: `/demandes/${req.id}` }, select: { title: true } });
    expect(avis.map((a) => a.title)).toContain("Demande validée — à traiter");
  });

  it("LE PASSEPORT d'un voyageur s'ouvre aux personnes du SUJET de réservation — et pas les autres pièces du poste", async () => {
    const ev = await prisma.event.create({ data: { name: `${TAG} congrès`, requesterId: demandeurId, startDate: new Date("2031-11-02") }, select: { id: true } });
    const sujet = await prisma.dossier.create({ data: { reference: `${TAG}DOS`, title: `${TAG} réservation`, participantIds: [asstId] }, select: { id: true } });
    const poste = await prisma.adProItem.create({ data: { eventId: ev.id, kind: "TICKETING", label: `${TAG} billets`, reservationDossierId: sujet.id }, select: { id: true } });
    const v = await prisma.adProVoyageur.create({ data: { itemId: poste.id, nom: `${TAG} Dr Benali` }, select: { id: true } });
    const doc = (stepKey: string | null, nom: string) => ({ entityType: "AD_PRO_ITEM", entityId: poste.id, stepKey, nom });
    const passeport = doc(v.id, "passeport");
    const devis = doc(null, "devis");
    const autrePoste = { ...doc(v.id, "ailleurs"), entityId: "__inexistant__" };
    // Prémisse : l'assistante n'a pas l'opération — sans la porte du sujet, elle serait refusée.
    expect(await canAccessEntity(await actorFor(asstId), "AD_PRO_ITEM", poste.id, "VIEW")).toBe(false);
    expect(await peutLirePasseportDuSujet(asstId, passeport)).toBe(true);
    expect(await peutLirePasseportDuSujet(asstId, devis), "une pièce sans voyageur n'est pas un passeport").toBe(false);
    expect(await peutLirePasseportDuSujet(asstId, autrePoste), "un voyageur d'un AUTRE poste ne compte pas").toBe(false);
    // La pièce du MÊME poste qui désigne le voyageur d'un autre poste : le sujet s'ouvre bien à
    // l'assistante, et c'est la seule vérification « ce voyageur est de CE poste » qui doit refuser.
    const autre = await prisma.adProItem.create({ data: { eventId: ev.id, kind: "TICKETING", label: `${TAG} autres billets` }, select: { id: true } });
    const vAilleurs = await prisma.adProVoyageur.create({ data: { itemId: autre.id, nom: `${TAG} Dr Ailleurs` }, select: { id: true } });
    expect(await peutLirePasseportDuSujet(asstId, doc(vAilleurs.id, "mauvais voyageur")), "le voyageur d'un autre poste, sur ce poste").toBe(false);
    expect(await peutLirePasseportDuSujet(etrangerId, passeport), "hors du sujet, rien").toBe(false);
  });

  it("LE POINT D'APPEL : le téléchargement d'une pièce lit cette porte, après celle de l'enregistrement", () => {
    // La règle est sortie de la route pour être partagée avec la recherche de la bibliothèque (J1).
    const route = readFileSync("src/app/api/documents/[id]/route.ts", "utf8");
    expect(route).toMatch(/await peutOuvrirDocument\(user, doc\)/);
    const regle = readFileSync("src/lib/entity-access/ouverture-pieces.ts", "utf8");
    expect(regle).toMatch(/await canAccessEntity\(user, doc\.entityType, doc\.entityId, "VIEW"\)\)\s*\|\|\s*\(await peutLirePasseportDuSujet\(user\.id, doc\)\)/);
  });
});
