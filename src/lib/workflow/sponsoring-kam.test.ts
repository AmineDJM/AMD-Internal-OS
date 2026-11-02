import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { advanceWorkflowInstance, ensureInstance } from "./engine";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__spokam__";
const viewer = (id: string, role: UserRole) => ({ id, role, secondaryRole: null, name: role });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SPONSORING D'UN DÉLÉGUÉ (le KAM) : National Sales PUIS Directeur des opérations, puis la
 * Direction Marketing qui PRÉVALIDE — et c'est désormais la route de TOUTES ses natures
 * (décision de la Direction, 27/10/2026 : « pareil pour les prises en charge, les événements et
 * les autres »). La porte du DG n'est plus sur la route : le DG valide le total des postes, à la fin.
 *
 * Par le VRAI moteur : le parcours se fige à la naissance de l'instance (`ensureInstance`), et
 * chaque pas passe par `advanceWorkflowInstance`, avec les rôles qui agissent réellement. Un test
 * de la fonction pure seule dirait que la règle est écrite, pas que le moteur la lit (§118.49).
 *
 * LE TÉMOIN est un congrès national du MÊME délégué : il suit la MÊME route. Sans lui, une règle
 * restée propre au sponsoring (celle du 28/09) passerait pour la bonne (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("le sponsoring d'un délégué traverse le National Sales PUIS le Directeur des opérations, puis la prévalidation", () => {
  let kamId = "", nsId = "", odId = "", dmId = "", dgId = "", spoId = "", congresId = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const spos = (await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((s) => s.id);
    const congres = (await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const entites = [...spos, ...congres];
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: entites } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: entites } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: entites } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: entites } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: spos } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: congres } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    const mk = async (s: string, role: UserRole) =>
      (await prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } })).id;
    kamId = await mk("kam", "MEDICAL_DELEGATE");
    nsId = await mk("ns", "NATIONAL_SALES");
    odId = await mk("od", "OPERATIONS_DIRECTOR");
    dmId = await mk("dm", "PRODUCT_MANAGER");
    dgId = await mk("dg", "GENERAL_MANAGER");
    spoId = (await prisma.sponsoringRequest.create({
      data: {
        reference: `${TAG}SPO`, institution: `${TAG} CHU`, type: "Journée scientifique",
        // Le statut de départ d'un délégué (`adProInit`).
        requesterId: kamId, status: "AWAITING_PRELIMINARY", amountRequested: 30_000, amountProposed: 30_000,
      },
    })).id;
    congresId = (await prisma.congressNational.create({
      data: { name: `${TAG}Congrès`, requesterId: kamId, requestStatus: "AWAITING_PRELIMINARY", estimatedBudget: 30_000 },
    })).id;
  }, 60_000);

  afterAll(nettoyer);

  it("le parcours FIGÉ du sponsoring ne saute que la porte du DG : le National Sales et le Directeur des opérations sont sur la route", async () => {
    // Ce qui le ferait tomber : la règle du 22/09 (`final` dans le tamis) — ou la porte du DG
    // laissée sur la route, devant un DG qui ne valide plus la demande mais le total de ses postes.
    const inst = await ensureInstance("SPONSORING", spoId);
    expect(inst?.currentSlug, "un délégué entre par son superviseur national").toBe("preliminary");
    expect(inst?.skippedSlugs, "seule la porte du DG est hors route").toEqual(["dg"]);
    expect(inst?.finalSlug, "Direction Marketing est la dernière étape : aucune borne avant elle").toBeNull();
  });

  it("TÉMOIN : le congrès du MÊME délégué suit la MÊME route depuis le 27/10/2026", async () => {
    // Ce qui le ferait tomber : garder la règle du 22/09 pour les congrès — le Directeur des
    // opérations sauté, alors que la Direction a étendu la route du sponsoring à toutes les natures.
    const inst = await ensureInstance("CONGRESS_NATIONAL", congresId);
    expect(inst?.currentSlug).toBe("preliminary");
    expect(inst?.skippedSlugs).toEqual(["dg"]);
  });

  it("de bout en bout : National Sales → Directeur des opérations → Direction Marketing, qui pré-valide la TENUE", async () => {
    const pre = await advanceWorkflowInstance({ viewer: viewer(nsId, "NATIONAL_SALES"), entityType: "SPONSORING", entityId: spoId, action: "APPROVE", note: "OK National Sales" });
    expect(pre.ok, pre.ok ? "" : pre.error).toBe(true);
    const apresNs = await ensureInstance("SPONSORING", spoId);
    expect(apresNs?.currentSlug, "après le National Sales : le Directeur des opérations, sans passer par le DG").toBe("final");

    // LE DG N'A RIEN À FAIRE ICI : son étape n'est pas sur la route, et celle où la demande se
    // trouve n'est pas la sienne.
    const dg = await advanceWorkflowInstance({ viewer: viewer(dgId, "GENERAL_MANAGER"), entityType: "SPONSORING", entityId: spoId, action: "APPROVE", note: "OK DG" });
    expect(dg.ok, "le DG ne valide plus la demande").toBe(false);

    const od = await advanceWorkflowInstance({ viewer: viewer(odId, "OPERATIONS_DIRECTOR"), entityType: "SPONSORING", entityId: spoId, action: "APPROVE", note: "OK Directeur des opérations" });
    expect(od.ok, od.ok ? "" : od.error).toBe(true);
    const apresOd = await ensureInstance("SPONSORING", spoId);
    expect(apresOd?.currentSlug, "puis la Direction Marketing, qui pré-valide ou refuse la tenue").toBe("marketing");
    expect(apresOd?.status).toBe("IN_PROGRESS");

    const dm = await advanceWorkflowInstance({ viewer: viewer(dmId, "PRODUCT_MANAGER"), entityType: "SPONSORING", entityId: spoId, action: "APPROVE", note: "Tenue pré-validée" });
    expect(dm.ok, dm.ok ? "" : dm.error).toBe(true);
    const fin = await ensureInstance("SPONSORING", spoId);
    expect(fin?.status, "la prévalidation CLÔTURE le circuit").toBe("APPROVED");
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } });
    expect(spo.status, "la tenue est PRÉ-VALIDÉE : l'argent se décide ensuite, poste par poste").toBe("PRE_VALIDATED");
    expect(await prisma.expenseOrder.count({ where: { sourceId: spoId } }), "aucun ordre global : les postes portent la dépense").toBe(0);

    // LA TRACE : les trois décisions sont écrites à leur nom, et rien n'est tracé sur la porte du DG.
    const approuvees = await prisma.workflowStepEvent.findMany({
      where: { instanceId: fin!.id, action: "APPROVE" }, select: { stepSlug: true }, orderBy: { createdAt: "asc" },
    });
    expect(approuvees.map((e) => e.stepSlug)).toEqual(["preliminary", "final", "marketing"]);
    expect(await prisma.workflowStepEvent.count({ where: { instanceId: fin!.id, stepSlug: "dg" } }), "hors route ≠ franchie").toBe(0);
    const avis = await prisma.notification.findFirst({ where: { userId: kamId, title: { contains: "prévalidée : les postes se préparent" } } });
    expect(avis, "le délégué lit ce qui l'attend — les postes, pas un financement").not.toBeNull();
  });
});
