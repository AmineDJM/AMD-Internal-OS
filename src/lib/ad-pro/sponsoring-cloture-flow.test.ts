import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createSponsoring, cloturerSponsoring, rouvrirSponsoring } from "@/lib/actions/sponsoring-actions";
import {
  addAdProItem, decideAdProItem, setAdProItemBudget, updateAdProItem, demanderPaiementPoste,
  deleteAdProItem, submitAdProItem, repartirPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { transferAdProRequest } from "@/lib/actions/ad-pro-transfer-actions";
import { validateDeclarationByDirection } from "@/lib/actions/medical-info-actions";
import { advanceWorkflowInstance, ensureInstance, montantADeclarer } from "@/lib/workflow/engine";
import { createExpenseOrder } from "@/lib/expense-orders";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { getWorkflowForEntity } from "@/lib/queries/workflow";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__spoclot__";

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

/** Un formulaire de création COMPLET, tel que l'écran l'envoie. */
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
 * LE SPONSORING, DE LA DEMANDE À LA CLÔTURE — par les VRAIS points d'entrée (§118.151).
 *
 * « Quand quelqu'un crée une demande, on lui demande un sponsoring demandé par le médecin et un
 * sponsoring suggéré par le délégué ; ce sponsoring s'ajoute automatiquement dans un poste, direct
 * ou indirect. Une fois validé, la Direction Marketing pré-valide ou refuse la tenue. Si elle
 * pré-valide, on passe aux postes — devis, BC, factures. Une fois l'événement complété, elle
 * valide tout, met chaque poste dans un budget, valide et clôture » (Direction, 09/2026).
 *
 * Chaque geste passe par l'action de l'écran ou par le moteur, jamais par une écriture en base :
 * un banc qui poserait l'état à la main confirmerait la règle et ne dirait rien de ce qu'une
 * personne obtient en cliquant (§118.14, §118.49). Deux raccourcis de DÉCOR seulement, nommés à
 * leur place : l'autorisation du centre de paiement, et l'état d'une déclaration déjà instruite —
 * ni l'un ni l'autre n'est ce que ce banc mesure.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Sponsoring — pré-validation de la tenue, postes, validation finale et clôture", () => {
  let demandeurId = "", dmId = "", dm2Id = "", dgId = "", dirId = "", saId = "";
  let catId = "";
  let spoId = "", postAutoId = "", standId = "", heritId = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [dem, dm, dm2, dg, dir, sa] = await Promise.all([
      mk("dem", "DIRECTION_ASSISTANT"), mk("dm", "PRODUCT_MANAGER"), mk("dm2", "PRODUCT_MANAGER"),
      mk("dg", "GENERAL_MANAGER"), mk("dir", "DIRECTION"), mk("sa", "SUPER_ADMIN"),
    ]);
    demandeurId = dem.id; dmId = dm.id; dm2Id = dm2.id; dgId = dg.id; dirId = dir.id; saId = sa.id;
    // LE DROIT DE CRÉER, et lui seul : sans lui l'action refuse avant de lire un champ, et le banc
    // mesurerait la porte au lieu de la procédure.
    await prisma.userAccess.create({ data: { userId: dem.id, module: "SPONSORING", canView: true, canCreate: true } });
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${TAG}Ad&Pro`, modules: ["SPONSORING"], periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"), totalAmount: 1_000_000,
        categories: { create: [{ name: `${TAG}Sponsoring`, module: "SPONSORING", allocated: 1_000_000 }] },
      },
      include: { categories: true },
    });
    catId = env.categories[0].id;
  });

  afterAll(async () => {
    const demandes = await prisma.sponsoringRequest.findMany({ where: { institution: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    const ids = demandes.map((d) => d.id);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    // Les factures déposées sur les postes (§118.204) désignent leur ordre : elles partent d'abord.
    const factures = (await prisma.legalDocument.findMany({ where: { sourceId: { in: ids } }, select: { id: true } }).catch(() => [])).map((f) => f.id);
    await prisma.adProItemPiece.deleteMany({ where: { legalDocumentId: { in: factures } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: factures } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: factures } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { label: { contains: TAG } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    // Un transfert SABOTÉ créerait un congrès : le banc ne laisse rien derrière lui (§118.91).
    const congres = await prisma.congressNational.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } }).catch(() => []);
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: congres.map((c) => c.id) } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  /** Conduit le circuit jusqu'à l'étape `slug` — la porte du DG se franchit seule sous le seuil. */
  async function jusqua(id: string, slug: string) {
    for (let tour = 0; tour < 4; tour += 1) {
      const inst = await ensureInstance("SPONSORING", id);
      if (!inst || inst.currentSlug === slug || inst.status !== "IN_PROGRESS") return inst;
      if (inst.currentSlug === "dg") {
        const r = await advanceWorkflowInstance({ viewer: { id: dgId, role: "GENERAL_MANAGER", name: `${TAG}dg` }, entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK DG" });
        expect(r.ok, r.ok === false ? r.error : "").toBe(true);
      } else break;
    }
    return ensureInstance("SPONSORING", id);
  }

  it("CRÉATION : la demande naît avec son poste — le sponsoring direct, chiffré à ce que suggère le délégué", async () => {
    ACTOR = await actorFor(demandeurId, "DIRECTION_ASSISTANT");
    const r = await createSponsoring(undefined, formulaire(`${TAG}Association cardio`, "DIRECT"));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    spoId = r.ok ? r.id! : "";
    const postes = await prisma.adProItem.findMany({ where: { sponsoringId: spoId } });
    expect(postes).toHaveLength(1);
    expect(postes[0]).toMatchObject({ kind: "ASSOCIATION_SUPPORT", status: "DRAFT", addedAfterDecision: false });
    expect(Number(postes[0].amountEstimated)).toBe(90_000);
    postAutoId = postes[0].id;
  });

  it("PRÉ-VALIDATION : la Direction Marketing décide la TENUE — aucun montant accordé, aucun ordre global", async () => {
    const inst = await jusqua(spoId, "marketing");
    expect(inst?.currentSlug, "la prémisse : l'étape de la Direction Marketing est atteinte").toBe("marketing");

    const r = await advanceWorkflowInstance({
      viewer: { id: dmId, role: "PRODUCT_MANAGER", name: `${TAG}dm` },
      entityType: "SPONSORING", entityId: spoId, action: "APPROVE", note: "Tenue pré-validée",
    });
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);

    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } });
    expect(spo.status).toBe("PRE_VALIDATED");
    expect(spo.amountGranted, "une tenue pré-validée n'a PAS de montant accordé — il se fixe à la clôture").toBeNull();
    expect(spo.validatedBy, "ni de validation signée").toBeNull();
    expect(spo.finalById).toBe(dmId);
    expect(spo.finalDecision).toBe("Tenue pré-validée");

    const fin = await prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "SPONSORING", entityId: spoId } } });
    expect(fin.status, "le CIRCUIT est terminé : la tenue est décidée").toBe("APPROVED");

    // AUCUN ORDRE GLOBAL : ce sont les postes qui portent la dépense.
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } })).toBe(0);
    // Le demandeur lit ce qui l'attend — les postes — et non « pris en charge ».
    const notes = await prisma.notification.findMany({ where: { userId: demandeurId }, select: { title: true } });
    expect(notes.map((n) => n.title).join(" | ")).toMatch(/tenue pré-validée : les postes se préparent/);
    expect(notes.map((n) => n.title).join(" | ")).not.toMatch(/pris en charge/);
    // Le PANNEAU du circuit dit l'étape suivante réelle — les postes —, pas « information médicale /
    // Finances », qui était la suite d'un accord à montant global.
    const vue = await getWorkflowForEntity(await actorFor(dmId, "PRODUCT_MANAGER"), "SPONSORING", spoId, demandeurId);
    expect(vue?.outcome?.tenue).toBe("PRE_VALIDEE");
  });

  it("la DÉCLARATION d'une tenue pré-validée porte l'estimation de ses postes, pas un montant inventé", async () => {
    // La branche du moteur qui l'appelle n'existe que lorsqu'un pharmacien est actif ; on éprouve
    // la fonction elle-même sur la base réelle, et un cliquet exige son point d'appel (§118.49).
    expect(await montantADeclarer("SPONSORING", spoId, 0)).toBe(90_000);
    expect(await montantADeclarer("SPONSORING", spoId, 55_000), "un montant FIXÉ par le circuit l'emporte").toBe(55_000);
  });

  it("POSTES : ajoutés après la pré-validation, ils ne sont PAS « tardifs » — c'est l'étape même", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const r = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Stand`, kind: "STAND", amountEstimated: "50000" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    standId = r.ok ? r.id! : "";
    const stand = await prisma.adProItem.findUniqueOrThrow({ where: { id: standId } });
    expect(stand.addedAfterDecision, "un poste ajouté à une tenue pré-validée n'est pas un dépassement").toBe(false);
  });

  it("TRANSFERT : une tenue pré-validée ne change plus de module — ses postes resteraient accrochés à une demande close", async () => {
    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await transferAdProRequest(undefined, fd({ from: "SPONSORING", to: "CONGRESS_NATIONAL", sourceId: spoId }));
    expect(r.ok).toBe(false);
    const e = r.ok === false ? r.error ?? "" : "";
    expect(e).toMatch(/pré-validée/);
    expect(e, "le refus nomme la sortie qui existe : refuser les postes, puis clôturer").toMatch(/clôturez-la/);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } })).status).toBe("PRE_VALIDATED");
    // Le lien CAUSAL, pas un compte global : un congrès créé par un autre banc au même instant
    // ne doit pas faire tomber celui-ci (§118.92).
    expect(await prisma.congressNational.count({ where: { name: { startsWith: TAG } } })).toBe(0);
  });

  it("TRANSFERT, ancien circuit : un poste qui ENGAGE déjà la dépense ferme aussi le transfert", async () => {
    // DÉCOR, nommé : une demande de l'ancien circuit et un BC DEMANDÉ sur son poste. Ce banc mesure
    // la garde du transfert, pas la chaîne du bon de commande.
    const old = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}OLD2`, institution: `${TAG}Ancien circuit engagé`, type: "Congrès", status: "APPROVED", amountGranted: 5000, requesterId: demandeurId },
    });
    await prisma.adProItem.create({
      data: { sponsoringId: old.id, kind: "STAND", label: `${TAG}Stand engagé`, status: "APPROVED", amountGranted: 5000, orderStage: "REQUESTED" },
    });
    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await transferAdProRequest(undefined, fd({ from: "SPONSORING", to: "CONGRESS_NATIONAL", sourceId: old.id }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toMatch(/1 poste\(s\) de cette demande engagent déjà la dépense/);
    expect(await prisma.congressNational.count({ where: { name: { startsWith: TAG } } })).toBe(0);
  });

  it("CLÔTURE trop tôt : refusée, et le refus NOMME chaque poste encore à décider", async () => {
    // Chaque cas NOMME son acteur : hérité du cas précédent, il changerait avec l'ordre des cas —
    // c'est ce qu'a montré l'ajout du cas de transfert, joué par la Direction juste avant.
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const r = await cloturerSponsoring(fd({ id: spoId }));
    expect(r.ok).toBe(false);
    const e = r.ok === false ? r.error ?? "" : "";
    expect(e).toMatch(/2 postes encore à décider/);
    expect(e).toContain(`${TAG}Stand`);
  });

  it("chaque poste se valide en DEUX TEMPS — la Direction des opérations, puis la Direction Marketing qui choisit le budget", async () => {
    // §118.204 : soumis par le demandeur, validé par la Direction des opérations, accordé par la
    // Direction Marketing AVEC son budget. L'accord sans budget n'existe plus.
    ACTOR = await actorFor(demandeurId, "DIRECTION_ASSISTANT");
    for (const id of [postAutoId, standId]) expect((await submitAdProItem(undefined, fd({ id }))).ok).toBe(true);
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const tropTot = await decideAdProItem(undefined, fd({ id: postAutoId, decision: "APPROVED", amountGranted: "80000", budgetCategoryId: catId }));
    expect(tropTot.ok === false ? tropTot.error : "accordé", "la Direction Marketing avant les opérations").toMatch(/attend d'abord la validation de la Direction des opérations/);
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await decideAdProItem(undefined, fd({ id: postAutoId, decision: "APPROVED" }))).ok).toBe(true);
    expect((await decideAdProItem(undefined, fd({ id: standId, decision: "APPROVED" }))).ok).toBe(true);
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const sansBudget = await decideAdProItem(undefined, fd({ id: postAutoId, decision: "APPROVED", amountGranted: "80000" }));
    expect(sansBudget.ok === false ? sansBudget.error : "accordé").toMatch(/Choisissez le budget/);
    expect((await decideAdProItem(undefined, fd({ id: postAutoId, decision: "APPROVED", amountGranted: "80000", budgetCategoryId: catId }))).ok).toBe(true);
    expect((await decideAdProItem(undefined, fd({ id: standId, decision: "REJECTED", note: "Pas de stand cette année" }))).ok).toBe(true);
    // L'ESTIMATION suit les décisions : le montant ACCORDÉ remplace l'estimé, et un poste REFUSÉ ne
    // pèse plus rien. 80 000 et non 90 000 (l'estimé d'origine) ni 130 000 (le stand refusé compté) —
    // sans ce cas, le filtre des refusés ne serait exercé nulle part.
    expect(await montantADeclarer("SPONSORING", spoId, 0)).toBe(80_000);
  });

  it("un poste accordé SANS budget (d'avant la validation en deux temps) bloque encore la clôture", async () => {
    // DÉCOR, nommé : un poste accordé avant §118.204, sans budget — la migration ne touche pas aux
    // postes accordés, et l'écran les garde à « Choisir le budget ». C'est cet état hérité qu'on éprouve.
    heritId = (await prisma.adProItem.create({ data: {
      sponsoringId: spoId, kind: "PRINTING", label: `${TAG}Affiches d'avant`, status: "APPROVED", amountEstimated: 20_000, amountGranted: 20_000, position: 9,
    } })).id;
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const r = await cloturerSponsoring(fd({ id: spoId }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toMatch(/sans budget/);
  });

  it("l'AUTEUR de la demande ne clôture pas — même quand tout est prêt", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    expect((await setAdProItemBudget(undefined, fd({ id: heritId, budgetCategoryId: catId }))).ok).toBe(true);
    ACTOR = await actorFor(demandeurId, "DIRECTION_ASSISTANT");
    const r = await cloturerSponsoring(fd({ id: spoId }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toMatch(/Direction Marketing/);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } })).status).toBe("PRE_VALIDATED");
  });

  it("VALIDER ET CLÔTURER : la somme des postes ACCORDÉS devient le montant accordé", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const r = await cloturerSponsoring(fd({ id: spoId, note: "Événement tenu, tout réglé" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } });
    expect(spo.status).toBe("CLOSED");
    expect(Number(spo.amountGranted), "80 000 + 20 000 accordés, le stand refusé ne pèse rien").toBe(100_000);
    expect(spo.closedAt).not.toBeNull();
    expect(spo.closedById).toBe(dmId);
    expect(spo.closingNote).toBe("Événement tenu, tout réglé");
    expect(spo.validatedBy).toBe(`${TAG}dm`);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: spoId, action: "VALIDATE" }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toMatch(/Validation finale et clôture/);
    // Deux clics ne clôturent qu'une fois.
    expect((await cloturerSponsoring(fd({ id: spoId }))).ok).toBe(false);
    const vue = await getWorkflowForEntity(await actorFor(dmId, "PRODUCT_MANAGER"), "SPONSORING", spoId, demandeurId);
    expect(vue?.outcome?.tenue).toBe("CLOTUREE");
    expect(vue?.outcome?.grantedAmount).toBe(100_000);
  });

  it("CLÔTURÉE : les postes sont ARRÊTÉS — et le refus nomme le geste qui rouvre", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const ajout = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Traiteur`, kind: "CATERING", amountEstimated: "10000" }));
    expect(ajout.ok).toBe(false);
    expect(ajout.ok === false ? ajout.error : "").toMatch(/clôturée[\s\S]*Rouvrir/);
    expect((await decideAdProItem(undefined, fd({ id: standId, decision: "APPROVED" }))).ok, "une décision ne se réécrit pas").toBe(false);
    expect((await setAdProItemBudget(undefined, fd({ id: postAutoId, budgetCategoryId: "" }))).ok, "un budget ne se retire pas").toBe(false);
    expect((await updateAdProItem(undefined, fd({ id: postAutoId, amountEstimated: "1" }))).ok, "un montant ne se rechiffre pas").toBe(false);
    // SUPPRIMER et SOUMETTRE : le refus doit être CELUI de la clôture. Sans le motif, un refus
    // venu d'une autre garde (« un poste accordé ne se soumet pas ») rendrait ces deux lignes
    // vraies pour la mauvaise raison (§118.111).
    for (const [nom, r] of [
      ["supprimer", await deleteAdProItem(undefined, fd({ id: standId }))],
      ["soumettre", await submitAdProItem(undefined, fd({ id: standId }))],
    ] as const) {
      expect(r.ok, `${nom} un poste d'une demande clôturée`).toBe(false);
      expect(r.ok === false ? r.error : "", nom).toMatch(/clôturée/);
    }
    // Ce qui DÉCRIT la dépense se corrige encore : le fournisseur sert au BC qui peut rester à émettre.
    const desc = await updateAdProItem(undefined, fd({ id: postAutoId, supplier: `${TAG}Association cardio` }));
    expect(desc.ok, desc.ok === false ? desc.error : "").toBe(true);
    expect(await prisma.adProItem.count({ where: { sponsoringId: spoId } })).toBe(3);
  });

  it("l'EXÉCUTION continue après la clôture — et régler un POSTE ne fait jamais « payer » la demande", async () => {
    // Un poste accordé dont le paiement n'était pas demandé : la clôture ne doit pas le laisser en plan.
    // SPONSORING DIRECT (§118.204) : pas de BC — la facture du demandeur suffit à demander le paiement.
    ACTOR = await actorFor(demandeurId, "DIRECTION_ASSISTANT");
    const f = fd({ id: postAutoId, montant: "80000", reference: `${TAG}FA-1`, argumentation: "Écart connu et accepté (banc).", confirme: "1" });
    f.append("attachment", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "facture.pdf", { type: "application/pdf" }));
    const em = await demanderPaiementPoste(undefined, f);
    expect(em.ok, em.ok === false ? em.error : "").toBe(true);
    const orderId = em.ok ? em.id! : "";
    // DÉCOR : l'autorisation du centre de paiement n'est pas ce que ce banc mesure. La facture, elle,
    // n'est PAS dispensée : celle que le demandeur a déposée doit suffire à la règle du règlement.
    await prisma.expenseOrder.update({ where: { id: orderId }, data: { centralStatus: "APPROVED" } });
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const regle = await settleExpenseOrder(fd({ id: orderId, budgetCategoryId: catId }));
    expect(regle.ok, regle.ok === false ? regle.error : "").toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PAID");
    expect(
      (await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } })).status,
      "le règlement d'un poste passait la demande entière à « payée » — elle repasserait de clôturée à payée",
    ).toBe("CLOSED");
  });

  it("la DÉCLARATION validée (validation finale) n'émet pas d'ordre GLOBAL : les postes portent la dépense", async () => {
    const decl = await createMedicalInfoDeclaration({
      sourceType: "SPONSORING", sourceId: spoId, label: `${TAG}Sponsoring`, beneficiary: `${TAG}Association cardio`,
      amount: 90_000, requesterId: demandeurId,
    });
    // DÉCOR : l'instruction du pharmacien n'est pas ce que ce banc mesure.
    await prisma.medicalInfoDeclaration.update({ where: { id: decl.id }, data: { status: "AWAITING_DIRECTION" } });
    const avant = await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } });
    // La validation finale revient au Directeur des Opérations (Direction, 10/2026) ; le Super Admin, souverain, la donne aussi.
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await validateDeclarationByDirection(fd({ id: decl.id }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(await prisma.expenseOrder.count({ where: { sourceType: "SPONSORING", sourceId: spoId } }), "un ordre global en plus paierait la dépense deux fois").toBe(avant);
    expect((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: decl.id } })).expenseOrderId).toBeNull();
  });

  it("ROUVRIR : motif obligatoire ; rouverte, la demande retrouve ses postes et perd son montant clôturé", async () => {
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    expect((await rouvrirSponsoring(fd({ id: spoId }))).ok, "sans motif, pas de réouverture").toBe(false);
    ACTOR = await actorFor(dm2Id, "PRODUCT_MANAGER");
    const r = await rouvrirSponsoring(fd({ id: spoId, reason: "Facture du traiteur arrivée" }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const spo = await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } });
    expect(spo.status).toBe("PRE_VALIDATED");
    expect(spo.amountGranted).toBeNull();
    expect(spo.closedAt).toBeNull();
    const ajout = await addAdProItem(undefined, fd({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Traiteur`, kind: "CATERING", amountEstimated: "10000" }));
    expect(ajout.ok, ajout.ok === false ? ajout.error : "").toBe(true);
  });

  it("DEUX CLICS SIMULTANÉS ne clôturent qu'une fois — l'écriture est conditionnelle au statut qu'elle lit", async () => {
    // Le cas séquentiel (« deux clics ») est refusé par le BILAN, qui lit « déjà clôturée » : il ne
    // dit rien de la garde d'écriture. Seuls deux appels qui lisent tous deux « pré-validée »
    // l'exercent — sans elle, les deux écriraient, et la demande serait clôturée deux fois, avec
    // deux notifications et deux lignes d'audit. Correcte, la garde ne peut pas rendre ce cas
    // rouge quel que soit l'entrelacement ; sabotée, elle le rend rouge dès que les deux lectures
    // précèdent la première écriture, ce qui est le cas ordinaire.
    const traiteur = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: spoId, label: `${TAG}Traiteur` } });
    // Le traiteur se SOUMET puis se refuse au premier temps (§118.204) — la vraie voie, pas un refus
    // posé sur un brouillon.
    ACTOR = await actorFor(demandeurId, "DIRECTION_ASSISTANT");
    expect((await submitAdProItem(undefined, fd({ id: traiteur.id }))).ok).toBe(true);
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await decideAdProItem(undefined, fd({ id: traiteur.id, decision: "REJECTED", note: "Hors budget" }))).ok).toBe(true);
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const avant = await prisma.auditLog.count({ where: { entityId: spoId, action: "VALIDATE" } });
    const [a, b] = await Promise.all([cloturerSponsoring(fd({ id: spoId })), cloturerSponsoring(fd({ id: spoId }))]);
    expect([a.ok, b.ok].filter(Boolean), "exactement UNE clôture").toHaveLength(1);
    const perdant = a.ok ? b : a;
    expect(perdant.ok === false ? perdant.error : "").toMatch(/déjà clôturée|changé entre-temps/);
    expect(await prisma.auditLog.count({ where: { entityId: spoId, action: "VALIDATE" } }) - avant, "une seule ligne d'audit").toBe(1);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: spoId } })).status).toBe("CLOSED");
  });

  it("une demande de la Direction Marketing ELLE-MÊME : la Direction pré-valide, et c'est elle qui clôture", async () => {
    // La route d'une demande de la Direction Marketing s'arrête à la Direction des opérations
    // (§118.142) : c'est elle qui décide la tenue, donc elle qui clôture. Ni l'auteur, ni un
    // collègue de la même direction.
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const cree = await createSponsoring(undefined, formulaire(`${TAG}Société de pneumologie`, "INDIRECT"));
    expect(cree.ok, cree.ok === false ? cree.error : "").toBe(true);
    const id = cree.ok ? cree.id! : "";
    const inst = await jusqua(id, "final");
    expect(inst?.currentSlug, "la prémisse : la route s'arrête chez la Direction des opérations").toBe("final");
    expect(inst?.finalSlug).toBe("final");
    const av = await advanceWorkflowInstance({ viewer: { id: dirId, role: "DIRECTION", name: `${TAG}dir` }, entityType: "SPONSORING", entityId: id, action: "APPROVE", note: "OK" });
    expect(av.ok, av.ok === false ? av.error : "").toBe(true);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id } })).status).toBe("PRE_VALIDATED");

    const poste = await prisma.adProItem.findFirstOrThrow({ where: { sponsoringId: id } });
    expect(poste.kind).toBe("INDIRECT_SUPPORT");
    // UN SPONSORING INDIRECT NE S'ACCORDE PAS D'UN SEUL TENANT (§118.175) : il se répartit d'abord
    // par nature, et chaque nature se décide, se commande et se paie à part.
    ACTOR = await actorFor(dirId, "DIRECTION");
    const tenant = await decideAdProItem(undefined, fd({ id: poste.id, decision: "APPROVED" }));
    expect(tenant.ok, "un sponsoring indirect non réparti ne s'accorde pas").toBe(false);
    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    const rep = await repartirPoste(undefined, fd({
      id: poste.id,
      repartition: JSON.stringify([
        { kind: "PRINTING", montant: 40000, precision: "Affiches", payeA: "" },
        { kind: "ACCOMMODATION", montant: 50000, precision: "", payeA: "" },
      ]),
    }));
    expect(rep.ok, rep.ok === false ? rep.error : "").toBe(true);
    const natures = await prisma.adProItem.findMany({ where: { sponsoringId: id }, orderBy: { position: "asc" } });
    expect(natures.map((n) => n.kind)).toEqual(["PRINTING", "ACCOMMODATION"]);
    // DEUX TEMPS, ET C'EST LA DIRECTION DES OPÉRATIONS QUI TIENT LE SECOND (§118.204) : la demande vient
    // de la Direction Marketing, qui n'arbitre pas sa propre demande.
    for (const n of natures) expect((await submitAdProItem(undefined, fd({ id: n.id }))).ok).toBe(true);
    ACTOR = await actorFor(dm2Id, "PRODUCT_MANAGER");
    const collegueMkt = await decideAdProItem(undefined, fd({ id: natures[0].id, decision: "APPROVED" }));
    expect(collegueMkt.ok, "la Direction Marketing ne valide aucun temps d'une demande de la Direction Marketing").toBe(false);
    ACTOR = await actorFor(dirId, "DIRECTION");
    for (const n of natures) {
      expect((await decideAdProItem(undefined, fd({ id: n.id, decision: "APPROVED" }))).ok).toBe(true);
      expect((await decideAdProItem(undefined, fd({ id: n.id, decision: "APPROVED", budgetCategoryId: catId }))).ok).toBe(true);
    }

    ACTOR = await actorFor(dmId, "PRODUCT_MANAGER");
    expect((await cloturerSponsoring(fd({ id }))).ok, "l'auteur ne se clôture pas").toBe(false);
    ACTOR = await actorFor(dm2Id, "PRODUCT_MANAGER");
    const collegue = await cloturerSponsoring(fd({ id }));
    expect(collegue.ok, "un collègue de la même direction n'a pas pré-validé cette tenue").toBe(false);
    expect(collegue.ok === false ? collegue.error : "").toMatch(/la Direction \(la demande vient de la Direction Marketing/);
    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await cloturerSponsoring(fd({ id }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(Number((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id } })).amountGranted), "la somme des natures accordées : 40 000 + 50 000").toBe(90_000);
  });

  it("l'ANCIEN circuit reste intact : un accord à montant global se solde toujours par son règlement", async () => {
    // L'autre moitié de la garde de règlement : sans ce cas, une garde qui ne solderait plus
    // RIEN passerait pour correcte (§118.17).
    const old = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}OLD`, institution: `${TAG}Ancien circuit`, type: "Congrès", status: "APPROVED", amountGranted: 5000, requesterId: demandeurId },
    });
    const order = await createExpenseOrder({
      label: `${TAG}ordre global`, amount: 5000, category: "EVENEMENT", beneficiary: `${TAG}Ancien circuit`,
      sourceType: "SPONSORING", sourceId: old.id, requestedById: demandeurId, budgetCategoryId: catId,
    });
    await prisma.expenseOrder.update({ where: { id: order.id }, data: { centralStatus: "APPROVED", requiresInvoice: false } });
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await settleExpenseOrder(fd({ id: order.id, budgetCategoryId: catId }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect((await prisma.sponsoringRequest.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("PAID");
  });
});
