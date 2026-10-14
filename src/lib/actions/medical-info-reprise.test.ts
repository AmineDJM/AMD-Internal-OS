import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { circuitStateOf } from "@/lib/medical-info/circuit-state";
import { declareStage } from "@/lib/medical-info/declare-decision";
import { requestDeclareDecision } from "./medical-info-actions";
import { decideValidation, deleteMyValidationRequest } from "./validation-actions";
import { canViewDeclaration, getDeclaration } from "@/lib/queries/medical-info";
import { canAccessEntity } from "@/lib/entity-access";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INFORMATION MÉDICALE NE MEURT PLUS AU PREMIER « MODIFICATION » (§118.185 — audit 360°, I9).
 *
 * Deux impasses. (1) Un validateur clique « Modification » : la règle disait « une demande à revoir
 * ne se redemande pas, elle se corrige dans son propre circuit » — or une demande de validation n'a
 * aucun geste de reprise côté demandeur, et le message promettait « reprenez-la là-bas ». Le dossier
 * restait à revoir pour toujours. Une validation RETIRÉE laissait, elle, son identifiant sur le
 * dossier : « en validation » à vie. (2) Les Finances, notifiées « quittance à remettre », tombaient
 * sur une fiche qui leur répondait « introuvable ».
 *
 * Joué par les vraies actions : la décision du validateur, la resoumission, le retrait.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__mireprise${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], access, mustChangePassword: false };
}
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

suite("information médicale : reprise après « Modification », retrait, et remise par les Finances", () => {
  let primId = "", finId = "";
  const decls: string[] = [];

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__mireprise" } }, select: { id: true } })).map((u) => u.id);
    const ids = (await prisma.medicalInfoDeclaration.findMany({ where: { label: { startsWith: "__mireprise" } }, select: { id: true } })).map((d) => d.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoSlip.deleteMany({ where: { declarationId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    primId = (await prisma.user.create({ data: { name: `${TAG} prim`, email: `${TAG}prim@t.dz`, role: "MEDICAL_INFO_PHARMACIST", passwordHash: "x" } })).id;
    finId = (await prisma.user.create({ data: { name: `${TAG} fin`, email: `${TAG}fin@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" } })).id;
  }, 120_000);
  afterAll(nettoyer, 120_000);

  async function dossierEvenement(): Promise<string> {
    const d = await prisma.medicalInfoDeclaration.create({
      data: {
        reference: `DIM-2031-${Math.floor(Math.random() * 90000 + 10000)}`,
        sourceType: "SPONSORING", sourceId: `${TAG}src-${Math.random().toString(36).slice(2)}`,
        label: `${TAG} congrès`, pharmacistId: primId,
      },
    });
    decls.push(d.id);
    return d.id;
  }
  const etat = async (id: string) => circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } }));

  /** Le validateur de l'étape courante demande une modification — par la vraie action. */
  async function demanderModification(validationId: string) {
    const v = await prisma.validationRequest.findUniqueOrThrow({ where: { id: validationId }, include: { steps: { orderBy: { order: "asc" } } } });
    const step = v.steps.find((s) => s.order === v.currentOrder && s.status === "PENDING") ?? v.steps[0];
    ACTOR = await actorFor(step.validatorId);
    const r = await decideValidation(form({ stepId: step.id, decision: "CHANGES_REQUESTED", reason: "Précisez le motif." }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
  }

  it("« MODIFICATION » PUIS RESOUMISSION : la nouvelle demande part, la précédente est close — jamais deux vivantes", async () => {
    const id = await dossierEvenement();
    ACTOR = await actorFor(primId);
    const a = await requestDeclareDecision(undefined, form({ id, intent: "DECLARE" }));
    expect(a.ok, a.ok ? undefined : a.error).toBe(true);
    const v1 = (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).declareValidationId!;
    await demanderModification(v1);
    expect(declareStage((await etat(id)).declare), "prémisse : le dossier est à revoir").toBe("A_REVOIR");

    ACTOR = await actorFor(primId);
    const b = await requestDeclareDecision(undefined, form({ id, intent: "SKIP", note: "Hors champ de la déclaration." }));
    expect(b.ok, b.ok ? undefined : b.error).toBe(true);
    const apres = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } });
    expect(apres.declareValidationId).not.toBe(v1);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: v1 } })).status).toBe("CANCELLED");
    expect(await prisma.validationRequest.count({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: id, status: "PENDING" } })).toBe(1);
    expect(declareStage((await etat(id)).declare)).toBe("EN_VALIDATION");
  });

  it("…et la demande EN COURS ne se redemande pas : pas de seconde demande à côté d'une vivante", async () => {
    const id = decls[0];
    ACTOR = await actorFor(primId);
    const r = await requestDeclareDecision(undefined, form({ id, intent: "DECLARE" }));
    expect(r.ok).toBe(false);
    expect(await prisma.validationRequest.count({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: id, status: "PENDING" } })).toBe(1);
  });

  it("UNE VALIDATION RETIRÉE ne laisse pas le dossier « en validation » à vie : il se redemande", async () => {
    const id = await dossierEvenement();
    ACTOR = await actorFor(primId);
    expect((await requestDeclareDecision(undefined, form({ id, intent: "DECLARE" }))).ok).toBe(true);
    const v1 = (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).declareValidationId!;
    const retrait = await deleteMyValidationRequest(form({ id: v1 }));
    expect(retrait.ok, retrait.ok ? undefined : retrait.error).toBe(true);
    expect(declareStage((await etat(id)).declare)).toBe("A_DEMANDER");
    const r = await requestDeclareDecision(undefined, form({ id, intent: "DECLARE" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
  });

  it("LES FINANCES ouvrent la fiche dès qu'un bon est parti au paiement — et pas avant", async () => {
    const d = await prisma.medicalInfoDeclaration.create({
      data: {
        reference: `DIM-2031-${Math.floor(Math.random() * 90000 + 10000)}`,
        sourceType: "PROMO_MATERIAL", sourceId: `${TAG}pm-${Math.random().toString(36).slice(2)}`,
        label: `${TAG} matériel`, pharmacistId: primId,
      },
    });
    decls.push(d.id);
    const fin = await actorFor(finId);
    // Aucun bon demandé : la fiche reste fermée — l'ouverture porte sur le FAIT qui les concerne.
    await prisma.medicalInfoSlip.create({ data: { declarationId: d.id, label: `${TAG} affiches` } });
    expect(canViewDeclaration(fin, (await getDeclaration(d.id))!)).toBe(false);
    expect(await canAccessEntity(fin, "MEDICAL_INFO_DECLARATION", d.id, "VIEW")).toBe(false);
    // Le bon part au paiement (raccourci de DÉCOR : l'identifiant de la demande suffit à la règle).
    await prisma.medicalInfoSlip.updateMany({ where: { declarationId: d.id }, data: { requestId: `${TAG}pay` } });
    expect(canViewDeclaration(fin, (await getDeclaration(d.id))!)).toBe(true);
    expect(await canAccessEntity(fin, "MEDICAL_INFO_DECLARATION", d.id, "VIEW")).toBe(true);
    // Voir n'est pas instruire : elles ne joignent ni ne retirent de pièce du pharmacien.
    expect(await canAccessEntity(fin, "MEDICAL_INFO_DECLARATION", d.id, "DELETE")).toBe(false);
  });

  it("LA CARTE DES BONS est rendue aux Finances hors du bloc du pharmacien, avec la remise (point d'appel)", () => {
    const src = readFileSync("src/app/(app)/information-medicale/[id]/page.tsx", "utf8");
    expect(src).toMatch(/const carteFinances = !canManage && canDeliverSlips && etat\.circuit === "PROMO"/);
    expect(src).toMatch(/\{carteFinances && \(/);
    // Dans cette carte, le seul geste est la remise : ni édition, ni validation, ni « sans versement ».
    const carte = src.slice(src.indexOf("{carteFinances && ("), src.indexOf("{carteFinances && (") + 2000);
    expect(carte).toMatch(/canDeliver\n/);
    expect(carte).toMatch(/canEdit=\{false\}/);
    expect(carte).toMatch(/canSkip=\{false\}/);
  });
});
