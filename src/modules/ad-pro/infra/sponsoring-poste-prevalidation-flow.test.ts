import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { montantDzd } from "@/lib/utils";
import { advanceWorkflowInstance, ensureInstance } from "@/lib/workflow/engine";
import { createSponsoring } from "../actions-sponsoring";
import { addAdProItem, submitAdProItem, updateAdProItem } from "../actions-postes";
import { decideAdProItem, repartirPoste } from "../actions-postes-decision";
import { naitrePosteDuSponsoring } from "./postes/naissance-sponsoring";
import { contextePostes, loadAdProItems } from "./requetes/postes";
import { faitsDuPoste, prochainPas, type RegardPoste } from "../domaine/poste-etapes";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__spoposteprev__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/** Le formulaire de création tel que l'écran l'envoie. */
function formulaire(institution: string, nature: "DIRECT" | "INDIRECT"): FormData {
  const f = new FormData();
  f.set("institution", institution);
  f.append("doctorIds", `${TAG}Dr Benali`);
  f.append("productIds", `${TAG}Nivolex`);
  f.set("city", "Alger");
  f.set("specialty", "Cardiologie");
  f.set("type", "Congrès");
  f.set("amountRequested", "120000");
  f.set("amountProposed", "90000");
  f.set("nature", nature);
  f.set("strategicImportance", "HIGH");
  f.append("files", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "demande.pdf", { type: "application/pdf" }));
  return f;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POSTE DU SPONSORING NAÎT À LA PRÉVALIDATION (recette 24/11/2026) — par les VRAIS points d'entrée.
 *
 * Décision de la Direction : le poste « Sponsoring direct (association) » / « Sponsoring indirect (prise en charge) »
 * n'existe pas tant que la chaîne n'est pas complète — N+1 (National Sales), Directeur des opérations, Direction
 * Marketing. Il naît alors EN ATTENTE de la Direction Marketing, qui le lit, l'ajuste et l'accorde, sans « Soumettre ».
 *
 * Chaque geste passe par l'action de l'écran ou par le moteur du circuit ; deux décors seulement, nommés à leur place :
 * le brouillon d'une demande d'avant la règle, et l'enveloppe budgétaire que l'accord exige.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Sponsoring — le poste naît à la prévalidation, en attente de la Direction Marketing", () => {
  let kamId = "", nsId = "", odId = "", dmId = "", buId = "", catId = "";
  let spoDirect = "", posteDirect = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" }, select: { id: true } });
    const [kam, ns, od, dm] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("ns", "NATIONAL_SALES"), mk("od", "OPERATIONS_DIRECTOR"), mk("dm", "PRODUCT_MANAGER")]);
    kamId = kam.id; nsId = ns.id; odId = od.id; dmId = dm.id;
    // LA GAMME DU KAM, tenue par son National Sales : c'est son N+1 sur le circuit.
    buId = (await prisma.businessUnit.create({ data: { name: `${RUN} BU`, isActive: true, supervisorId: nsId }, select: { id: true } })).id;
    await prisma.salesRepProfile.create({ data: { repId: kamId, businessUnitId: buId } });
    // DÉCOR : l'enveloppe que l'accord d'un poste exige (« la Direction Marketing sélectionne le budget »).
    const annee = new Date().getFullYear();
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Ad&Pro`, modules: ["SPONSORING"], periodStart: new Date(`${annee}-01-01`), periodEnd: new Date(`${annee}-12-31`), totalAmount: 1_000_000,
        categories: { create: [{ name: `${TAG}Sponsoring`, module: "SPONSORING", allocated: 1_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0].id;
  }, 60_000);

  afterAll(async () => {
    const ids = (await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } }).catch(() => [])).map((s) => s.id);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: { in: ids } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { entityType: "SPONSORING", entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    for (const id of ids) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.salesRepProfile.deleteMany({ where: { repId: kamId } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: RUN } } }).catch(() => {});
  }, 60_000);

  const postesDe = (id: string) => prisma.adProItem.findMany({ where: { sponsoringId: id }, orderBy: { position: "asc" } });

  /** La chaîne de prévalidation, pas à pas : après chaque pas AVANT le dernier, rien n'a bougé dans les postes. */
  async function prevalider(id: string) {
    const avant = await prisma.adProItem.count({ where: { sponsoringId: id } });
    for (const v of [
      { id: nsId, role: "NATIONAL_SALES" as const, name: `${TAG}ns` },
      { id: odId, role: "OPERATIONS_DIRECTOR" as const, name: `${TAG}od` },
      { id: dmId, role: "PRODUCT_MANAGER" as const, name: `${TAG}dm` },
    ]) {
      const av = await advanceWorkflowInstance({ viewer: v, entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK" });
      expect(av.ok, av.ok === false ? av.error : "").toBe(true);
      if (v.role !== "PRODUCT_MANAGER") {
        expect(await prisma.adProItem.count({ where: { sponsoringId: id } }), `après ${v.role} : aucun poste de plus`).toBe(avant);
        expect(await prisma.adProItem.count({ where: { sponsoringId: id, status: "PENDING" } }), `après ${v.role} : rien en attente`).toBe(0);
      }
    }
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id } })).status, "la prévalidation conclut PRE_VALIDATED").toBe("PRE_VALIDATED");
  }

  /** Le regard que l'écran calcule pour cette personne (`contextePostes`), et la ligne du chargeur de l'écran. */
  async function pasPour(id: string, role: SessionUser["role"], parentId: string, posteId: string) {
    const u = await actorFor(id, role);
    const ctx = await contextePostes(u, "SPONSORING", parentId);
    const regard: RegardPoste = { canEdit: true, canAllocate: role === "PRODUCT_MANAGER", canViserBC: false, canEmettre: false, fige: false, operationDecidee: true, validation: ctx.validation };
    const ligne = (await loadAdProItems("SPONSORING", parentId)).find((x) => x.id === posteId)!;
    return prochainPas(faitsDuPoste(ligne), regard);
  }

  it("CRÉATION : la demande naît SANS poste — personne ne voit de brouillon à soumettre", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Association cardio`, "DIRECT"));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    spoDirect = r.ok ? r.id! : "";
    expect(await postesDe(spoDirect)).toHaveLength(0);
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoDirect } });
    // Tout ce que le poste portera est écrit sur la demande.
    expect(spo).toMatchObject({ nature: "DIRECT", institution: `${TAG}Association cardio`, businessUnitId: buId });
    expect([Number(spo.amountRequested), Number(spo.amountProposed)]).toEqual([120_000, 90_000]);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: spoDirect, action: "CREATE" } });
    expect(audit?.summary).toMatch(/son poste naît à la prévalidation/);
    expect((await ensureInstance("SPONSORING", spoDirect))?.currentSlug, "un KAM entre par son N+1").toBe("preliminary");
    // Aucun poste ne s'ajoute à la main avant la prévalidation (décision #11, 27/10/2026).
    const ajout = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoDirect, label: `${TAG}Trop tôt`, kind: "STAND", amountEstimated: "1000" }));
    expect(ajout.ok === false ? ajout.error : "ajouté").toMatch(/^Les postes s'ajoutent après la prévalidation/);
  });

  it("PRÉVALIDATION COMPLÈTE (N+1 → Directeur des opérations → Direction Marketing) : UN poste naît, en attente", async () => {
    await prevalider(spoDirect);
    const postes = await postesDe(spoDirect);
    expect(postes, "exactement un poste").toHaveLength(1);
    const p = postes[0];
    posteDirect = p.id;
    expect(p).toMatchObject({
      kind: "ASSOCIATION_SUPPORT", status: "PENDING", label: `Sponsoring direct (association) — ${TAG}Association cardio`,
      supplier: `${TAG}Association cardio`, budgetKind: "INCLUDED", position: 1, principal: true, createdById: kamId, addedAfterDecision: false,
    });
    expect(Number(p.amountEstimated), "chiffré à ce que suggère le délégué").toBe(90_000);
    expect(p.notes).toBe(`Sponsoring demandé par le médecin : ${montantDzd(120_000)} · suggéré par le délégué : ${montantDzd(90_000)}.`);
    expect(p.submittedAt, "soumis à sa naissance").not.toBeNull();
    expect(p.opsDecidedAt, "le premier temps est franchi d'office, comme à une soumission").not.toBeNull();
    // La trace d'une soumission, et la Direction Marketing prévenue comme pour un poste soumis.
    expect((await prisma.adProItemDecision.findMany({ where: { itemId: p.id } })).map((d) => d.decision)).toEqual(["PENDING"]);
    expect(await prisma.notification.count({ where: { userId: dmId, title: "Poste à valider", link: { contains: spoDirect } } })).toBe(1);
    // Aucun ordre global à côté du poste.
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoDirect } })).toBe(0);
  });

  it("IDEMPOTENT : relancer la naissance ne crée rien", async () => {
    expect(await naitrePosteDuSponsoring(spoDirect, dmId)).toBe("DEJA_LA");
    expect(await postesDe(spoDirect)).toHaveLength(1);
  });

  it("L'ÉCRAN : la Direction Marketing a « Accorder » ; le délégué attend — personne n'a « Soumettre »", async () => {
    const dm = await pasPour(dmId, "PRODUCT_MANAGER", spoDirect, posteDirect);
    expect(dm.geste?.cle).toBe("DECIDER");
    const kam = await pasPour(kamId, "MEDICAL_DELEGATE", spoDirect, posteDirect);
    expect(kam.geste, "le délégué n'a aucun geste").toBeNull();
    expect(kam.attente).toMatch(/chez la Direction Marketing/);
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const sub = await submitAdProItem(undefined, fd({ id: posteDirect }));
    expect(sub.ok === false ? sub.error : "soumis").toMatch(/déjà en attente/);
  });

  it("LA DIRECTION MARKETING L'AJUSTE (libellé, précisions, montant estimé, bénéficiaire) puis l'ACCORDE", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const m = await updateAdProItem(undefined, fd({
      id: posteDirect, label: `${TAG}Sponsoring direct ajusté`, notes: "Ajusté par la Direction Marketing", amountEstimated: "85000", supplier: `${TAG}Association cardio (trésorerie)`,
    }));
    expect(m.ok, m.ok === false ? m.error : "").toBe(true);
    const ajuste = await prisma.adProItem.findUniqueOrThrow({ where: { id: posteDirect } });
    expect(ajuste).toMatchObject({ label: `${TAG}Sponsoring direct ajusté`, notes: "Ajusté par la Direction Marketing", supplier: `${TAG}Association cardio (trésorerie)`, status: "PENDING" });
    expect(Number(ajuste.amountEstimated)).toBe(85_000);
    const accord = await decideAdProItem(undefined, fd({ id: posteDirect, decision: "APPROVED", amountGranted: "80000", budgetCategoryId: catId }));
    expect(accord.ok, accord.ok === false ? accord.error : "").toBe(true);
    const accorde = await prisma.adProItem.findUniqueOrThrow({ where: { id: posteDirect } });
    expect(accorde.status).toBe("APPROVED");
    expect(Number(accorde.amountGranted)).toBe(80_000);
    expect(accorde.budgetCategoryId).toBe(catId);
  });

  it("UNE DEMANDE D'AVANT LA RÈGLE : son poste en BROUILLON passe en attente à la prévalidation — jamais dupliqué", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Association héritée`, "DIRECT"));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const id = r.ok ? r.id! : "";
    // DÉCOR, nommé : le brouillon qu'une demande créée avant le 24/11/2026 portait depuis sa naissance.
    const brouillon = await prisma.adProItem.create({
      data: { sponsoringId: id, kind: "ASSOCIATION_SUPPORT", label: `${TAG}Brouillon d'avant`, amountEstimated: 90_000, position: 1, createdById: kamId },
    });
    await prevalider(id);
    const postes = await postesDe(id);
    expect(postes.map((p) => p.id), "le brouillon est repris, rien n'est recréé").toEqual([brouillon.id]);
    expect(postes[0].status).toBe("PENDING");
    expect(postes[0].submittedAt).not.toBeNull();
    expect(postes[0].label, "ce que le brouillon disait est gardé").toBe(`${TAG}Brouillon d'avant`);
    expect(await naitrePosteDuSponsoring(id, dmId), "relancé : rien").toBe("DEJA_LA");
    expect(await prisma.adProItem.count({ where: { sponsoringId: id } })).toBe(1);
  });

  it("INDIRECT : il naît en attente, sans bénéficiaire ; la Direction Marketing le RÉPARTIT, et ses natures l'attendent avec lui", async () => {
    ACTOR = await actorFor(kamId, "MEDICAL_DELEGATE");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Société de pneumologie`, "INDIRECT"));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const id = r.ok ? r.id! : "";
    expect(await postesDe(id)).toHaveLength(0);
    await prevalider(id);
    const [poste, ...autres] = await postesDe(id);
    expect(autres).toHaveLength(0);
    expect(poste).toMatchObject({ kind: "INDIRECT_SUPPORT", status: "PENDING", supplier: null, label: `Sponsoring indirect (prise en charge) — ${TAG}Société de pneumologie` });

    // Il ne s'accorde pas d'un seul tenant — et l'écran ne le propose pas : il propose de répartir, à elle seule.
    expect((await pasPour(dmId, "PRODUCT_MANAGER", id, poste.id)).geste?.cle).toBe("REPARTIR");
    const kam = await pasPour(kamId, "MEDICAL_DELEGATE", id, poste.id);
    expect(kam.geste).toBeNull();
    expect(kam.attente).toMatch(/répartit ce sponsoring indirect/);
    const repartition = JSON.stringify([
      { kind: "PRINTING", montant: 40000, precision: "Affiches", payeA: "" },
      { kind: "ACCOMMODATION", montant: 50000, precision: "", payeA: "" },
    ]);
    // Le délégué ne change pas la forme d'un poste qui attend la Direction Marketing.
    const parLui = await repartirPoste(undefined, fd({ id: poste.id, repartition }));
    expect(parLui.ok === false ? parLui.error : "réparti").toMatch(/déjà soumis ou accordé/);

    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const tenant = await decideAdProItem(undefined, fd({ id: poste.id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(tenant.ok, "un sponsoring indirect non réparti ne s'accorde pas").toBe(false);
    const rep = await repartirPoste(undefined, fd({ id: poste.id, repartition }));
    expect(rep.ok, rep.ok === false ? rep.error : "").toBe(true);
    const natures = await postesDe(id);
    expect(natures.map((n) => n.kind)).toEqual(["PRINTING", "ACCOMMODATION"]);
    expect(natures.every((n) => n.status === "PENDING" && n.submittedAt != null), "les natures attendent la Direction Marketing, sans « Soumettre »").toBe(true);
    for (const n of natures) {
      const ok = await decideAdProItem(undefined, fd({ id: n.id, decision: "APPROVED", budgetCategoryId: catId }));
      expect(ok.ok, ok.ok === false ? ok.error : "").toBe(true);
    }
    expect(await naitrePosteDuSponsoring(id, dmId), "réparti, le poste ne renaît pas").toBe("DEJA_LA");
    expect(await prisma.adProItem.count({ where: { sponsoringId: id } })).toBe(2);
  });
});
