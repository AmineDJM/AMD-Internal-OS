import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { POWER_TOOLS } from "./power-tools";

/**
 * GOLDEN QUERIES — le banc DÉTERMINISTE des vraies questions du PDG.
 *
 * Le principe « fast + smart » tient si la COUCHE DÉTERMINISTE (read models, états exécutifs,
 * chronologies) livre déjà l'essentiel de la réponse : le modèle n'a plus qu'à raisonner, pas à
 * reconstruire le monde. Ce banc fige cette couche sur les questions réelles :
 *   « Où en est Pembro ? » / « Pourquoi est-il bloqué ? » / « Qui est responsable ? » /
 *   « Où est le paiement ? » — chaque outil doit rendre bloqueur, délais, prochaine étape et
 *   signaux D'UN SEUL APPEL, sans requête supplémentaire du modèle.
 *
 * La mesure QUALITÉ × LATENCE du système complet (modèle compris) ne peut pas tourner ici sans
 * clé ni environnement : le protocole est documenté dans docs/CHIEF_OF_STAFF_ARCHITECTURE.md
 * (« Benchmark qualité × latence ») et s'appuie sur AiUsageLog (ttftMs, turns, toolCalls).
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name: "PDG", email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__gq__${Date.now()}`;
let ceoId = "";
let validatorId = "";
let productId = "";
let payId = "";

const tool = (name: string) => POWER_TOOLS.find((t) => t.def.name === name)!;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

suite("golden queries — la couche déterministe répond d'un seul appel", () => {
  beforeAll(async () => {
    const [ceo, validator] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}ceo`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
      prisma.user.create({ data: { name: `${TAG} Nadia`, email: `${TAG}v@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } }),
    ]);
    ceoId = ceo.id;
    validatorId = validator.id;

    // « Pembro » : dossier prioritaire dont l'étape de dépôt attend un CPP depuis trop longtemps.
    const product = await prisma.regulatoryProduct.create({
      data: {
        reference: `${TAG}-REG`, dci: `${TAG} Pembrolizumab`, brandName: `${TAG} Pembro`,
        status: "IN_PREPARATION", priority: "HIGH",
        steps: {
          create: [
            { type: "PRE_SUBMISSION", order: 1, status: "DONE", actualDate: ago(90) },
            { type: "CTD_PREPARATION", order: 2, status: "DONE", actualDate: ago(40) },
            { type: "DOSSIER_SUBMISSION", order: 3, status: "IN_PROGRESS", plannedDate: ago(9), missingDocs: "CPP légalisé", responsible: "Nesrine" },
            { type: "COMMISSION_REVIEW", order: 4, status: "NOT_STARTED" },
          ],
        },
      },
    });
    productId = product.id;
    await prisma.auditLog.create({
      data: { entityType: "REGULATORY_PRODUCT", entityId: productId, action: "UPDATE", module: "Regulatory", summary: "Commentaire ajouté", actorId: ceoId, createdAt: ago(9) },
    });

    // « Le paiement Hikma » : approuvé par la première marche, la seconde attend Nadia depuis 12 j.
    const pay = await prisma.paymentRequest.create({
      data: { reference: `${TAG}-PAY`, title: `${TAG} achat Hikma`, amount: 900_000, payee: "Hikma", requesterId: ceoId, status: "SUBMITTED", dueDate: ago(3), createdAt: ago(20) },
    });
    payId = pay.id;
    await prisma.validationRequest.create({
      data: {
        reference: `${TAG}-VAL`, module: "Finances", title: `${TAG} validation paiement`,
        requesterId: ceoId, entityType: "PAYMENT_REQUEST", entityId: payId, createdAt: ago(19),
        steps: {
          create: [
            { order: 1, validatorId: ceoId, status: "APPROVED", decidedAt: ago(12) },
            { order: 2, validatorId, status: "PENDING" },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [productId, payId] } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("« Où en est Pembro ? / Pourquoi est-il bloqué ? / Qui est responsable ? » — UN appel de product_360", async () => {
    const exec = userWith({ REGULATORY: ["VIEW"] }, "DIRECTION", ceoId);
    const out = JSON.parse(await tool("product_360").run({ product: `${TAG} Pembro` }, exec));
    const s = out.syntheseExecutive;
    expect(s).toBeTruthy();
    // Le bloqueur, nommé — pas « étape 6 ».
    expect(String(s.bloqueur)).toContain("CPP légalisé");
    // Qui : la responsable de l'étape courante.
    expect(s.etapeCourante).toMatchObject({ etape: "Dépôt dossier", responsable: "Nesrine" });
    // Depuis quand : la fin de la dernière étape faite (40 j).
    expect(s.joursDansEtapeCourante).toBe(40);
    // La suite du circuit.
    expect(s.prochaineEtapeAttendue).toBe("Passage commission");
    // Les signaux : étape en retard + dossier HIGH qui n'avance pas.
    const joined = (s.signaux as string[]).join(" | ");
    expect(joined).toMatch(/en retard/);
    expect(joined).toMatch(/HIGH/);
  });

  it("« Où est le paiement Hikma ? / Qui le bloque ? » — UN appel d'inspect_record", async () => {
    const exec = userWith({ CHIEF_OF_STAFF: ["VIEW"] }, "DIRECTION", ceoId);
    const out = JSON.parse(await tool("inspect_record").run({ reference: `${TAG}-PAY` }, exec));
    const s = out.etatExecutif;
    expect(s).toBeTruthy();
    expect(String(s.bloqueur)).toContain("Nadia");
    expect(String(s.bloqueur)).toContain("12 j");
    expect(s.prochaineEtape).toContain("Nadia");
    expect((s.signaux as string[]).join(" | ")).toMatch(/échéance convenue dépassée/);
  });

  it("la synthèse exécutive arrive EN PREMIER dans la réponse de l'outil — la voix lit l'essentiel d'abord", async () => {
    const exec = userWith({ REGULATORY: ["VIEW"] }, "DIRECTION", ceoId);
    const raw = await tool("product_360").run({ product: `${TAG} Pembro` }, exec);
    expect(raw.indexOf("syntheseExecutive")).toBeLessThan(raw.indexOf("fiche"));
  });
});
