import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));
// L'ABSENCE DE TOUT DIRECTEUR ne se fabrique pas dans une base partagée (d'autres bancs en créent le temps
// de leur passage) : quand le banc le demande, la lecture des décideurs voit « aucun directeur » — la règle
// pure (`decideursInfoMed`) et la lecture réelle des Super Admins restent celles du produit.
let SANS_DIRECTEUR = false;
vi.mock("@/lib/medical-info", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/medical-info")>();
  const { decideursInfoMed } = await import("@/lib/medical-info/decideur");
  const { prisma: db } = await import("@/lib/prisma");
  return {
    ...reel,
    decideursInfoMedActifs: async (requesterId: string | null) => {
      if (!SANS_DIRECTEUR) return reel.decideursInfoMedActifs(requesterId);
      const sas = await db.user.findMany({ where: { role: "SUPER_ADMIN", isActive: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
      return decideursInfoMed({ directeurs: [], superAdmins: sas.map((u) => u.id), requesterId });
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canViewDeclaration, getDeclaration, dernierRefusFinal } from "@/lib/queries/medical-info";
import { OBJET_DECISION_INFO_MED } from "@/lib/medical-info/decideur";
import {
  requestDeclareDecision, requestSlipsValidation, validateDeclaration, validateDeclarationByDirection, refuseDeclarationByDirection,
} from "./medical-info-actions";
import { decideValidation } from "./validation-actions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LE PRIM FAIT VALIDER VA CHEZ LE DIRECTEUR DES OPÉRATIONS — et c'est lui qui tranche.
 *
 * « Dans Information médicale, quand le pharmacien responsable d'information médicale demande une
 * validation, elle doit automatiquement aller chez le directeur des opérations. C'est lui qui
 * valide, ou pas. » (Direction, 10/2026)
 *
 * Joué par les vraies actions, session simulée : la lecture « à déclarer ? », le dépôt des bons, la
 * validation finale. Ni la Direction des opérations (le service), ni le Directeur Général ne
 * tranchent ; le refus revient au pharmacien avec son motif ; deux validations finales simultanées
 * n'émettent qu'UN ordre ; sans directeur actif, le Super Admin reçoit — et le pharmacien le lit.
 *
 * D'autres bancs créent des Directeurs des Opérations le temps de leur passage : on vérifie que NOS
 * deux directeurs sont saisis, jamais qu'ils sont les seuls.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__midirops${Date.now()}__`;
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: null, access, mustChangePassword: false };
}

suite("Information médicale — le Directeur des Opérations tranche ce que le PRIM fait valider", () => {
  let primId = "", od1 = "", od2 = "", dirId = "", dgId = "", spoId = "";
  const decls: string[] = [];

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((u) => u.id);
    const ids = (await prisma.medicalInfoDeclaration.findMany({ where: { label: { startsWith: TAG } }, select: { id: true } })).map((d) => d.id);
    const demandes = (await prisma.validationRequest.findMany({ where: { OR: [{ entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } }, { requesterId: { in: comptes } }] }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: demandes } } }).catch(() => {});
    // NOS directeurs, actifs pendant le banc, ont aussi été saisis par les demandes d'information médicale
    // des bancs voisins (tous les directeurs actifs le sont) : leurs étapes partent avec eux.
    await prisma.user.updateMany({ where: { id: { in: comptes } }, data: { isActive: false } }).catch(() => {});
    await prisma.validationStep.deleteMany({ where: { validatorId: { in: comptes }, request: { objectType: OBJET_DECISION_INFO_MED } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.medicalInfoSlip.deleteMany({ where: { declarationId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [prim, a, b, dir, dg] = await Promise.all([
      mk("prim", "MEDICAL_INFO_PHARMACIST"), mk("od1", "OPERATIONS_DIRECTOR"), mk("od2", "OPERATIONS_DIRECTOR"),
      mk("dir", "DIRECTION"), mk("dg", "GENERAL_MANAGER"),
    ]);
    primId = prim.id; od1 = a.id; od2 = b.id; dirId = dir.id; dgId = dg.id;
    spoId = (await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO`, institution: `${TAG}Hôpital`, type: "Congrès", status: "APPROVED", amountGranted: 40000 },
    })).id;
  }, 120_000);
  afterAll(nettoyer, 120_000);

  async function dossier(kind: "EVENT" | "PROMO", extra: Record<string, unknown> = {}): Promise<string> {
    const d = await prisma.medicalInfoDeclaration.create({
      data: {
        reference: `DIM-2034-${Math.floor(Math.random() * 900000 + 100000)}`,
        // Une déclaration par source (clé unique) : une source inventée par dossier, sauf celui qui
        // mesure l'ordre de dépense, rattaché au vrai sponsoring du banc (`extra`).
        sourceType: kind === "EVENT" ? "EVENT" : "PROMO_MATERIAL",
        sourceId: `${TAG}src-${Math.random().toString(36).slice(2)}`,
        label: `${TAG}${kind}`, pharmacistId: primId, ...extra,
      },
    });
    decls.push(d.id);
    return d.id;
  }

  const etapes = (requestId: string) => prisma.validationStep.findMany({ where: { requestId } });

  it("la lecture « à déclarer ? » part chez les Directeurs des Opérations, tous notifiés — pas chez la chaîne d'avant", async () => {
    const id = await dossier("EVENT");
    ACTOR = await actorFor(primId);
    const r = await requestDeclareDecision(undefined, form({ id, intent: "DECLARE" }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/Directeur des Opérations/);
    const v = await prisma.validationRequest.findUniqueOrThrow({ where: { id: (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).declareValidationId! } });
    expect(v.objectType).toBe(OBJET_DECISION_INFO_MED);
    expect(v.mode, "tous saisis en même temps").toBe("PARALLEL");
    const valideurs = (await etapes(v.id)).map((e) => e.validatorId);
    expect(valideurs).toEqual(expect.arrayContaining([od1, od2]));
    expect(valideurs).not.toContain(dirId);
    expect(valideurs).not.toContain(dgId);
    const roles = await prisma.user.findMany({ where: { id: { in: valideurs } }, select: { role: true, secondaryRole: true } });
    expect(roles.every((u) => u.role === "OPERATIONS_DIRECTOR" || u.secondaryRole === "OPERATIONS_DIRECTOR"), "rien que des Directeurs des Opérations").toBe(true);
    for (const od of [od1, od2]) {
      expect(await prisma.notification.count({ where: { userId: od, body: { contains: v.reference } } }), "chacun est notifié").toBeGreaterThan(0);
    }
  });

  it("la Direction des opérations et le Directeur Général ne tranchent pas ; le premier directeur qui accorde décide pour tous", async () => {
    const id = decls[0];
    const vId = (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).declareValidationId!;
    const steps = await etapes(vId);
    const stepOd1 = steps.find((s) => s.validatorId === od1)!;
    for (const intrus of [dirId, dgId, primId]) {
      ACTOR = await actorFor(intrus);
      const r = await decideValidation(form({ stepId: stepOd1.id, decision: "APPROVED" }));
      expect(r.ok, `${intrus} ne tranche pas`).toBe(false);
    }
    ACTOR = await actorFor(od1);
    const ok = await decideValidation(form({ stepId: stepOd1.id, decision: "APPROVED" }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: vId } })).status, "un seul accord suffit").toBe("APPROVED");
    const apres = await etapes(vId);
    expect(apres.find((s) => s.validatorId === od2)?.status, "l'étape de l'autre directeur se clôt").toBe("SKIPPED");
    expect(apres.filter((s) => s.status === "PENDING")).toHaveLength(0);
  });

  it("le dépôt des bons va aussi au Directeur des Opérations ; un refus motivé revient au pharmacien", async () => {
    const id = await dossier("PROMO");
    await prisma.medicalInfoSlip.create({ data: { declarationId: id, label: `${TAG}affiches`, amount: 12000 } });
    ACTOR = await actorFor(primId);
    const r = await requestSlipsValidation(undefined, form({ id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const vId = (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).bvValidationId!;
    const step = (await etapes(vId)).find((s) => s.validatorId === od2)!;
    expect(step, "le second directeur est saisi aussi").toBeTruthy();
    ACTOR = await actorFor(od2);
    expect((await decideValidation(form({ stepId: step.id, decision: "REJECTED" }))).ok, "pas de refus sans motif").toBe(false);
    const refus = await decideValidation(form({ stepId: step.id, decision: "REJECTED", reason: "Montant des affiches à justifier." }));
    expect(refus.ok, refus.ok ? "" : refus.error).toBe(true);
    expect((await prisma.validationRequest.findUniqueOrThrow({ where: { id: vId } })).status).toBe("REJECTED");
    const notif = await prisma.notification.findFirst({ where: { userId: primId, body: { contains: "Montant des affiches à justifier." } } });
    expect(notif, "le motif revient au pharmacien").not.toBeNull();
  });

  it("validation finale : chez le Directeur des Opérations ; ni la Direction, ni le DG, ni le pharmacien ne la donnent", async () => {
    const id = await dossier("EVENT", { sourceType: "SPONSORING", sourceId: spoId, declareIntent: "SKIP", declareGrantedAt: new Date(), amount: 40000 });
    ACTOR = await actorFor(primId);
    const t0 = new Date();
    const r = await validateDeclaration(form({ id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toMatch(/Directeur des Opérations/);
    expect((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).status).toBe("AWAITING_DIRECTION");
    for (const od of [od1, od2]) {
      expect(await prisma.notification.count({ where: { userId: od, type: "VALIDATION_REQUIRED", link: `/information-medicale/${id}`, createdAt: { gte: t0 } } })).toBe(1);
    }
    expect(await prisma.notification.count({ where: { userId: dirId, link: `/information-medicale/${id}` } }), "la Direction n'est plus notifiée").toBe(0);

    // Il OUVRE le dossier (et ses pièces) sur lequel il tranche.
    const od = await actorFor(od1);
    expect(canViewDeclaration(od, (await getDeclaration(id))!)).toBe(true);

    for (const intrus of [dirId, dgId, primId]) {
      ACTOR = await actorFor(intrus);
      expect((await validateDeclarationByDirection(form({ id }))).ok, `${intrus} ne valide pas`).toBe(false);
      expect((await refuseDeclarationByDirection(form({ id, reason: "non" }))).ok, `${intrus} ne refuse pas`).toBe(false);
    }
    expect((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).status).toBe("AWAITING_DIRECTION");
  });

  it("le refus exige un motif, rend le dossier au pharmacien, et le motif lui parvient", async () => {
    const id = decls[decls.length - 1];
    ACTOR = await actorFor(od1);
    expect((await refuseDeclarationByDirection(form({ id }))).ok, "pas de refus sans motif").toBe(false);
    const r = await refuseDeclarationByDirection(form({ id, reason: "Joindre la convention signée." }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const d = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } });
    expect(d.status, "revenu à l'instruction du pharmacien").toBe("AWAITING_REVIEW");
    expect(d.pharmacistValidatedAt).toBeNull();
    expect(await prisma.notification.count({ where: { userId: primId, body: { contains: "Joindre la convention signée." } } })).toBe(1);
    expect((await dernierRefusFinal(id))?.motif).toBe("Joindre la convention signée.");
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } })).toBe(0);
  });

  it("DEUX VALIDATIONS FINALES SIMULTANÉES n'émettent qu'UN ordre de dépense", async () => {
    const id = decls[decls.length - 1];
    ACTOR = await actorFor(primId);
    expect((await validateDeclaration(form({ id }))).ok, "le pharmacien retransmet").toBe(true);
    const [a, b] = [await actorFor(od1), await actorFor(od2)];
    // Deux décideurs, deux appels lancés ensemble : chacun lit « en attente » avant l'écriture de l'autre.
    const appels = [a, b].map(async (acteur) => {
      ACTOR = acteur;
      return validateDeclarationByDirection(form({ id }));
    });
    const [r1, r2] = await Promise.all(appels);
    expect([r1.ok, r2.ok].filter(Boolean), "exactement UNE validation").toHaveLength(1);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } }), "un seul ordre").toBe(1);
    const d = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe("VALIDATED");
    expect([od1, od2]).toContain(d.validatedById);
    expect(d.expenseOrderId).toBeTruthy();
    // Un troisième clic, après coup, ne fait rien de plus.
    ACTOR = a;
    expect((await validateDeclarationByDirection(form({ id }))).ok).toBe(false);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } })).toBe(1);
  });

  it("SANS DIRECTEUR DES OPÉRATIONS ACTIF : le Super Admin reçoit, et la confirmation du pharmacien le dit", async () => {
    SANS_DIRECTEUR = true;
    try {
      const id = await dossier("EVENT");
      ACTOR = await actorFor(primId);
      const r = await requestDeclareDecision(undefined, form({ id, intent: "SKIP", note: "Hors champ." }));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      expect(r.message).toMatch(/Super Admin/);
      expect(r.message).toMatch(/aucun Directeur des Opérations/);
      const v = await prisma.validationRequest.findUniqueOrThrow({ where: { id: (await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id } })).declareValidationId! } });
      const valideurs = (await etapes(v.id)).map((e) => e.validatorId);
      expect(valideurs.length).toBeGreaterThan(0);
      const roles = await prisma.user.findMany({ where: { id: { in: valideurs } }, select: { role: true } });
      expect(roles.every((u) => u.role === "SUPER_ADMIN"), "repli : le Super Admin").toBe(true);
      expect(v.description ?? "").toMatch(/Aucun Directeur des Opérations actif/);

      const fin = await dossier("EVENT", { declareIntent: "SKIP", declareGrantedAt: new Date() });
      const t = await validateDeclaration(form({ id: fin }));
      expect(t.ok, t.ok ? "" : t.error).toBe(true);
      expect(t.message).toMatch(/Super Admin/);
    } finally {
      SANS_DIRECTEUR = false;
    }
  });
});
