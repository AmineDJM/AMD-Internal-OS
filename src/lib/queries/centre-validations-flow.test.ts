import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
// Comme `session.ts` : la personne d'un geste en cours (fixée au clic par `actionReversible`) passe avant la variable.
vi.mock("@/lib/session", () => {
  const acteurCourant = async () => (await import("@/lib/effets/geste")).utilisateurDuGeste() ?? ACTOR;
  return { requireUser: acteurCourant, requireUserAuNomDeLaVue: acteurCourant, getCurrentUser: async () => ACTOR };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createDirectValidation } from "@/lib/validation";
import { decideValidation, commenterValidation } from "@/lib/actions/validation-actions";
import { requestBV } from "@/lib/actions/regulatory-actions";
import { fileDuCentre, decisionsRecentes } from "./centre-validations";
import { questionPosee } from "@/lib/validations/centre-affichage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CENTRE DE VALIDATIONS, UN SEUL ÉCRAN — ce que la file et la fiche montrent, par les VRAIS points d'entrée
 * (`createDirectValidation`, `requestBV`, `decideValidation`, `commenterValidation`).
 *
 * La file est celle d'hier (`getPendingValidations`), réduite à ce qui est décidable maintenant ; chaque ligne porte la
 * chaîne déjà validée, le validateur suivant, le fil, la société de l'objet et — pour un BV — le budget avant → après lu
 * sous la visibilité de la personne. « Déjà décidés » rend mes décisions. Aucun geste n'est réécrit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__ctrvalid${Date.now().toString(36)}__`;

async function acteur(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access: await getAccess(id, u.role), mustChangePassword: false } as unknown as CurrentUser;
}
const session = async (id: string) => (await acteur(id)) as unknown as SessionUser;
const form = (champs: Record<string, string>, files: Record<string, File> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  for (const [k, v] of Object.entries(files)) f.append(k, v);
  return f;
};
const pdf = (name: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49])], name, { type: "application/pdf" });

suite("Centre de validations — la file et la fiche de l'écran unique", () => {
  let demId = "", v1Id = "", v2Id = "", raId = "", membreId = "", aveugleId = "", societeId = "", produitId = "", envId = "";
  const demandes: string[] = [];
  const comptes = () => [demId, v1Id, v2Id, raId, membreId, aveugleId].filter(Boolean);

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n} Nom`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    demId = (await mk("dem", "MEDICAL_DELEGATE")).id;
    v1Id = (await mk("v1", "HEAD_OF_SALES")).id;
    v2Id = (await mk("v2", "FINANCE_BUDGET_MANAGER")).id;
    raId = (await mk("ra", "SUPER_ADMIN")).id;
    membreId = (await mk("membre", "COORDINATOR")).id;
    aveugleId = (await mk("aveugle", "COORDINATOR")).id;
    // DEUX PERSONNES À QUI LA CONSOLE OUVRE LE CENTRE ; seule la première lit l'enveloppe Regulatory.
    await prisma.userAccess.createMany({ data: [membreId, aveugleId].map((userId) => ({ userId, module: "VALIDATION_CENTRE" as const, canView: true })) });
    societeId = (await prisma.company.create({ data: { name: `${TAG}Société`, shortName: `${TAG}Soc` } })).id;
    produitId = (await prisma.regulatoryProduct.create({
      data: { dci: `${TAG}AMLODIPINE`, reference: `${TAG}REG`, companyId: societeId, workflow: { presub_ans: { status: "DONE", outcome: "FAVORABLE" } } },
    })).id;
    const an = new Date().getUTCFullYear();
    envId = (await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Regulatory`, domaine: "REGULATORY", companyId: societeId, totalAmount: 5_000_000, isActive: true, accessUserIds: [membreId],
        periodStart: new Date(Date.UTC(an, 0, 1)), periodEnd: new Date(Date.UTC(an + 1, 11, 31)),
        categories: { create: [{ name: "BV 25 %", cle: "BV_25", allocated: 1_000_000 }, { name: "BV 75 %", cle: "BV_75", allocated: 3_000_000 }] },
      },
    })).id;
  }, 120_000);

  afterAll(async () => {
    const bv = await prisma.validationRequest.findMany({ where: { entityId: produitId }, select: { id: true } });
    const ids = [...demandes, ...bv.map((v) => v.id)];
    await prisma.comment.deleteMany({ where: { entityType: "VALIDATION_REQUEST", entityId: { in: ids } } }).catch(() => undefined);
    await prisma.validationRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    const docs = await prisma.document.findMany({ where: { entityId: produitId }, select: { id: true } });
    await retirerDocumentsEtContenu({ where: { id: { in: docs.map((d) => d.id) } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes() } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes() } } }).catch(() => undefined);
    await prisma.regulatoryProduct.deleteMany({ where: { id: produitId } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: societeId } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: { in: comptes() } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }, 120_000);

  async function demande(titre: string, opts: { deadline?: Date } = {}) {
    const r = await createDirectValidation({
      requesterId: demId, title: `${TAG}${titre}`, description: "Deux imprimantes en panne", module: "Demandes de validations",
      validatorIds: [v1Id, v2Id], mode: "SEQUENTIAL", amount: 145_000, deadline: opts.deadline ?? null,
    });
    expect(r.ok, r.error).toBe(true);
    demandes.push(r.requestId!);
    return r.requestId!;
  }
  const lignesDe = async (userId: string, requestId: string) =>
    (await fileDuCentre(await session(userId), { seuilBC: 500_000 })).filter((l) => l.requestId === requestId);

  it("SÉQUENTIEL : seul le validateur dont c'est le tour voit la ligne ; elle nomme le suivant et porte le contexte", async () => {
    const id = await demande("imprimantes", { deadline: new Date(Date.now() - 2 * 86_400_000) });
    const [l] = await lignesDe(v1Id, id);
    expect(l, "la ligne est dans la file du premier validateur").toBeDefined();
    expect(l).toMatchObject({
      genre: "AUTRE", etiquette: "Demandes de validations", objet: `${TAG}imprimantes`, montant: 145_000,
      demandeur: `${TAG}dem Nom`, suivant: `${TAG}v2 Nom`, chaine: [], fil: [], bv: null, seuilBC: null, version: 1,
    });
    expect(await lignesDe(v2Id, id), "le second attend son tour : rien à décider pour lui").toEqual([]);
  });

  it("LA QUESTION part dans le fil de la demande ; la ligne la sait posée", async () => {
    const id = demandes[0]!;
    const [l] = await lignesDe(v1Id, id);
    ACTOR = await acteur(v1Id);
    expect((await commenterValidation(form({ requestId: id, body: "Un seul modèle réseau suffirait-il ?" }))).ok).toBe(true);
    const [apres] = await lignesDe(v1Id, id);
    expect(apres!.fil.map((m) => [m.texte, m.deMoi])).toEqual([["Un seul modèle réseau suffirait-il ?", true]]);
    expect(questionPosee(apres!.fil)).toBe(true);
    expect(l!.stepId).toBe(apres!.stepId);
  });

  it("ACCEPTER fait passer la ligne au suivant, avec « Déjà validé » ; « Déjà décidés » la rend au premier", async () => {
    const id = demandes[0]!;
    const [l] = await lignesDe(v1Id, id);
    ACTOR = await acteur(v1Id);
    const r = await decideValidation(form({ stepId: l!.stepId, decision: "APPROVED" }));
    expect(r.ok, r.error).toBe(true);
    expect(await lignesDe(v1Id, id), "décidée, elle sort de ma file").toEqual([]);
    const [chez2] = await lignesDe(v2Id, id);
    expect(chez2!.chaine).toHaveLength(1);
    expect(chez2!.chaine[0]!.etape).toBe(`Accepté par ${TAG}v1 Nom`);
    expect(chez2!.suivant, "le dernier du circuit n'a personne après lui").toBeNull();
    expect(chez2!.fil[0]!.deMoi, "la question de v1 n'est pas « la mienne » pour v2").toBe(false);
    const decides = (await decisionsRecentes(v1Id)).filter((d) => d.requestId === id);
    expect(decides).toMatchObject([{ status: "APPROVED", objet: `${TAG}imprimantes`, montant: 145_000 }]);
  });

  it("REFUSER avec motif : « Déjà décidés » garde le motif", async () => {
    const id = demandes[0]!;
    const [l] = await lignesDe(v2Id, id);
    ACTOR = await acteur(v2Id);
    expect((await decideValidation(form({ stepId: l!.stepId, decision: "REJECTED", reason: "Non prioritaire" }))).ok).toBe(true);
    expect((await decisionsRecentes(v2Id)).find((d) => d.requestId === id)).toMatchObject({ status: "REJECTED", motif: "Non prioritaire" });
  });

  it("UN BV : toute personne qui a accès au centre le voit ; le budget avant → après se lit sous SA visibilité", async () => {
    ACTOR = await acteur(raId);
    const r = await requestBV(form({ productId: produitId, stepKey: "bv25_req", amount: "120000" }, { files: pdf("proforma.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const bv = await prisma.validationRequest.findFirstOrThrow({ where: { entityId: produitId, objectType: "REGULATORY_BV_25" } });

    const [l] = await lignesDe(membreId, bv.id);
    expect(l).toMatchObject({ genre: "BV", etiquette: "BV 25 %", montant: 120_000, societe: `${TAG}Soc` });
    expect(l!.bv).toMatchObject({
      etat: "LU", part: "25", alloue: 1_000_000, consomme: 0, engage: 0, demande: 120_000,
      disponibleAvant: 1_000_000, disponibleApres: 880_000, prevision75: { montant: 360_000, disponible: 3_000_000 },
    });

    const [aveugle] = await lignesDe(aveugleId, bv.id);
    expect(aveugle, "la seconde personne du centre voit aussi le BV").toBeDefined();
    expect(aveugle!.bv, "l'enveloppe ne lui est pas ouverte : aucun chiffre").toMatchObject({ etat: "NON_VISIBLE", part: "25" });

    // ACCEPTER ENGAGE LE BUDGET (comportement inchangé) : la fiche suivante le lirait engagé.
    ACTOR = await acteur(membreId);
    expect((await decideValidation(form({ stepId: l!.stepId, decision: "APPROVED" }))).ok).toBe(true);
    expect(await lignesDe(aveugleId, bv.id), "une décision suffit : le BV quitte la file de tous").toEqual([]);
  });
});
