import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
/**
 * LE SEUIL DES BONS DE COMMANDE EST UN RÉGLAGE GLOBAL (une ligne `AppSetting`). Le poser pour de vrai
 * changerait ce que voient les suites qui tournent en parallèle sur la même base (§118.132) : le banc
 * l'INJECTE dans son propre processus, et la base partagée garde son réglage.
 */
let SEUIL = 500_000;
/**
 * LA PORTE DU DG SUR LE TOTAL DE LA DEMANDE (27/10/2026) lit un autre réglage global, injecté de même et
 * mis HORS D'ATTEINTE : l'événement de ce banc accumule des postes de 600 000 de cas en cas, et ce banc
 * mesure la révision d'un poste, pas la porte (`porte-dg-flow.test.ts` et `postes-chaine-flow.test.ts` la tiennent).
 */
const SEUIL_DG = 1_000_000_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: SEUIL, adProDgThreshold: SEUIL_DG }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { siegeAuCentreAdPro } from "@/lib/ad-pro/centre";
import {
  addAdProItem, submitAdProItem, decideAdProItem, updateAdProItem, requestAdProItemOrder,
  approveAdProItemOrder, demanderPaiementPoste, deleteAdProItem, demanderPieceSecretariat,
  retirerDemandeBC, modifierDemandeBC, annulerOrdrePoste, demanderRevisionPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { submitDocumentRequest, decideDocumentRequest } from "@/lib/actions/document-request-actions";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { persistUploadedDocument } from "@/lib/documents";
import { restoreDeletedRecord, superAdminDelete } from "@/lib/actions/admin-delete-actions";
import type { Prisma } from "@prisma/client";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__posterev__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉVISER UN POSTE AD & PRO APRÈS COUP — par les VRAIS points d'entrée (§118.187, audit R05/R06/R10–R12).
 *
 * « La Direction accorde 100 000, le centre vise le BC, puis le montant passe à 900 000 et le prestataire
 * change — et les Finances émettent 900 000 au nouveau fournisseur sous le visa donné pour l'ancien. Une
 * demande de BC ne se retire ni ne se modifie, un ordre émis ne se réémet pas, un poste retiré disparaît
 * avec son historique, une décision ne se revoit pas. »
 *
 * Les acteurs n'ont PAS la vue globale (§118.104) : le délégué décrit et demande, la Direction Marketing
 * tranche et émet, le Directeur Général siège au centre. Chacun est NOMMÉ dans son cas (§118.151f).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — réviser un poste : visa, demande de BC, ordre, décision, retrait", () => {
  let kamId = "", pmId = "", gmId = "", saId = "", astId = "", finId = "", eventId = "", catId = "";
  const postes: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    // 27/10/2026 : la Direction Marketing accepte seule les postes (un seul temps) ; l'assistante établit le
    // BC ; un gestionnaire budgétaire des Finances le SIGNE (pas un Super Admin, §118.104).
    const [kam, pm, gm, sa, ast, fin] = await Promise.all([
      mk("kam", "MEDICAL_DELEGATE"), mk("pm", "PRODUCT_MANAGER"), mk("gm", "GENERAL_MANAGER"), mk("sa", "SUPER_ADMIN"), mk("ast", "DIRECTION_ASSISTANT"),
      mk("fin", "FINANCE_BUDGET_MANAGER"),
    ]);
    kamId = kam.id; pmId = pm.id; gmId = gm.id; saId = sa.id; astId = ast.id; finId = fin.id;
    // UN ÉVÉNEMENT PRÉVALIDÉ (requestStatus APPROVED, aucun montant écrit) : depuis le 27/10/2026, un
    // événement né hors circuit n'a ni poste ni paiement.
    eventId = (await prisma.event.create({
      data: { name: `${TAG}Journée cardiologie`, requesterId: kamId, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date("2026-12-04") },
      select: { id: true },
    })).id;
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN}Enveloppe`, modules: ["EVENTS"], totalAmount: 10_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Imprimerie`, allocated: 5_000_000 }, select: { id: true } })).id;
  });

  afterAll(async () => {
    const comptes = [kamId, pmId, gmId, saId, astId, finId].filter(Boolean);
    const tousPostes = await prisma.adProItem.findMany({ where: { OR: [{ eventId }, { id: { in: postes } }] }, select: { id: true } }).catch(() => []);
    const idsPostes = [...new Set([...postes, ...tousPostes.map((p) => p.id)])];
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    const demandes = await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: idsPostes } }, select: { id: true } }).catch(() => []);
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    const pieces = await prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: idsPostes } }, select: { legalDocumentId: true } }).catch(() => []);
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: idsPostes } } }).catch(() => {});
    // Les pièces du registre : BC nés des demandes de pièce, factures déposées sur les postes.
    const liees = await prisma.adProItemPiece.findMany({ where: { itemId: { in: idsPostes } }, select: { legalDocumentId: true } }).catch(() => []);
    const docs = [...new Set([...pieces.map((p) => p.legalDocumentId), ...liees.map((l) => l.legalDocumentId)].filter((x): x is string => Boolean(x)))];
    const factures = await prisma.legalDocument.findMany({ where: { sourceId: eventId }, select: { id: true } }).catch(() => []);
    const tousDocs = [...new Set([...docs, ...factures.map((f) => f.id)])];
    await prisma.adProItemPiece.deleteMany({ where: { legalDocumentId: { in: tousDocs } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: tousDocs } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: tousDocs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: tousDocs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: tousDocs } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: idsPostes } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: eventId }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: idsPostes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: idsPostes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [eventId, ...idsPostes] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  const comme = async (qui: "kam" | "pm" | "gm" | "sa" | "ast" | "fin") => {
    ACTOR = qui === "kam" ? await acteur(kamId, "MEDICAL_DELEGATE")
      : qui === "pm" ? await acteur(pmId, "PRODUCT_MANAGER")
        : qui === "gm" ? await acteur(gmId, "GENERAL_MANAGER")
          : qui === "ast" ? await acteur(astId, "DIRECTION_ASSISTANT")
            : qui === "fin" ? await acteur(finId, "FINANCE_BUDGET_MANAGER")
              : await acteur(saId, "SUPER_ADMIN");
  };
  const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), `${nom}-${Date.now()}-${Math.random()}`], nom, { type: "application/pdf" });
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

  /**
   * Un poste ACCORDÉ et imputé, par les gestes de l'écran (règle du 27/10/2026) : décrit, soumis, puis
   * accepté par la Direction Marketing — un seul temps — qui fixe le montant et choisit le budget.
   */
  async function posteAccorde(label: string, montant: number, fournisseur = "Imprimerie Alpha", kind = "PRINTING"): Promise<string> {
    await comme("kam");
    const a = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind, label: `${TAG}${label}`, amountEstimated: String(montant), supplier: fournisseur }));
    ok(a);
    const id = a.id!;
    postes.push(id);
    ok(await submitAdProItem(undefined, fd({ id })));
    await comme("pm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
    return id;
  }
  async function demanderBC(id: string, note = "Réf. devis DV-12, 2 000 brochures.") {
    await comme("kam");
    return requestAdProItemOrder(undefined, fd({ id, note, assistantId: astId }));
  }
  /**
   * LE BC ÉTABLI PAR LA VRAIE CHAÎNE (§118.204) : l'assistante dépose la pièce sur SA demande de pièce,
   * le demandeur l'accepte, et `classerDansLegal` la range au registre puis la RATTACHE au poste.
   * Rend l'identifiant de la pièce Legal — lu sur le lien du poste, jamais deviné.
   */
  async function bcEtabli(id: string): Promise<string> {
    const dr = await prisma.documentRequest.findFirstOrThrow({
      where: { entityType: "AD_PRO_ITEM", entityId: id, kind: "PURCHASE_ORDER", status: { in: ["PENDING", "DECLINED"] } },
      orderBy: { createdAt: "desc" }, select: { id: true },
    });
    const depot = await persistUploadedDocument(astId, {
      entityType: "DOCUMENT_REQUEST", entityId: dr.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: pdf(`${TAG}bc.pdf`), maxUploadMb: 20,
    });
    expect(depot.ok, depot.error).toBe(true);
    await comme("ast");
    ok(await submitDocumentRequest(fd({ id: dr.id })));
    await comme("kam");
    ok(await decideDocumentRequest(fd({ id: dr.id, accept: "1" })));
    const lien = await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: id, nature: "BON_DE_COMMANDE" }, orderBy: { createdAt: "desc" }, select: { legalDocumentId: true } });
    return lien.legalDocumentId;
  }
  /** …puis SIGNÉ par les Finances : la seule porte qui ouvre le paiement d'un poste à BC. */
  async function bcSigne(id: string): Promise<string> {
    const doc = await bcEtabli(id);
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: doc }))));
    return doc;
  }
  /** La facture déposée par le demandeur, qui demande le paiement (`demanderPaiementPoste`). */
  async function payer(id: string, montant = "600000") {
    await comme("kam");
    const f = fd({ id, montant, reference: `${TAG}FA`, argumentation: "Écart connu et accepté (banc).", confirme: "1" });
    f.append("attachment", pdf(`${TAG}facture.pdf`));
    return demanderPaiementPoste(undefined, f);
  }
  async function viser(id: string, extra: Record<string, string> = {}) {
    await comme("gm");
    return approveAdProItemOrder(undefined, fd({ id, decision: "APPROVE", ...extra }));
  }
  const etat = (id: string) => prisma.adProItem.findUniqueOrThrow({
    where: { id },
    select: {
      status: true, orderStage: true, orderDirectionAt: true, orderVisaAmount: true, orderVisaSupplier: true,
      expenseOrderId: true, amountGranted: true, orderNote: true, orderDecisionNote: true,
    },
  });
  /** La demande de pièce « bon de commande » envoyée à l'assistante (§118.204) — le « BC à établir ». */
  const travauxBc = (id: string) => prisma.documentRequest.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: id, kind: "PURCHASE_ORDER" },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, note: true },
  });

  /** Deux gestes forcés à se croiser : les écritures du poste attendent, les lectures passent (§118.164e). */
  async function sousBarriere<T>(lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "AdProItem" IN SHARE MODE`);
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ANY(${["%AdProItem%"]}::text[])`;
        if (n >= attendus) break;
        if (Date.now() - debut > 10_000) throw new Error(`les gestes n'ont pas atteint la barrière (${n} en attente sur ${attendus})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  /**
   * UN GESTE ARRÊTÉ ENTRE SA LECTURE ET SON ÉCRITURE, pendant qu'un autre écrit (§118.164e) : la
   * transaction qui tient le verrou attend que le geste soit bloqué, ÉCRIT elle-même le changement
   * concurrent (le détenteur d'un verrou SHARE peut écrire), puis relâche. Le geste écrit ensuite sur
   * une ligne qui a bougé depuis sa lecture — c'est sa condition qui doit le voir. Déterministe :
   * aucun ordonnancement n'est espéré.
   */
  async function pendantLaLecture<T>(lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "AdProItem" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ANY(${["%AdProItem%"]}::text[])`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  it("PRÉMISSES : le délégué décrit sans trancher ; la Direction Marketing tranche sans vue globale ; le DG siège au centre", async () => {
    const kam = await acteur(kamId, "MEDICAL_DELEGATE");
    expect(userCan(kam, "EVENTS", "UPDATE")).toBe(true);
    expect(hasGlobalView(kam) || userCan(kam, "EVENTS", "VALIDATE") || userCan(kam, "FINANCES", "UPDATE"), "sinon ses refus viendraient d'ailleurs").toBe(false);
    const pm = await acteur(pmId, "PRODUCT_MANAGER");
    expect(userCan(pm, "EVENTS", "VALIDATE")).toBe(true);
    expect(hasGlobalView(pm), "une garde éprouvée avec la vue globale ne peut pas tomber (§118.104)").toBe(false);
    expect(siegeAuCentreAdPro(await acteur(gmId, "GENERAL_MANAGER"))).toBe(true);
    expect(siegeAuCentreAdPro(pm)).toBe(false);
  });

  it("VISÉ puis BAISSÉ : rien ne rouvre ; RELEVÉ au-delà de ce que le centre a vu : le visa rouvre, et le centre le sait", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Brochures", 600_000);
    ok(await demanderBC(id));
    expect((await etat(id)).orderStage, "au-dessus du seuil : au centre").toBe("REQUESTED");
    ok(await viser(id, { montantVu: "600000", prestataireVu: "Imprimerie Alpha" }));
    const vise = await etat(id);
    expect(vise.orderStage).toBe("DIRECTION_OK");
    expect(Number(vise.orderVisaAmount), "l'empreinte : ce que le centre a vu").toBe(600_000);
    expect(vise.orderVisaSupplier).toBe("Imprimerie Alpha");

    await comme("pm");
    const baisse = await updateAdProItem(undefined, fd({ id, amountGranted: "550000" }));
    ok(baisse);
    expect(baisse.message, "baisser est un geste qui réduit : rien à dire").toBeUndefined();
    expect((await etat(id)).orderStage).toBe("DIRECTION_OK");

    const t0 = new Date();
    const hausse = await updateAdProItem(undefined, fd({ id, amountGranted: "900000" }));
    ok(hausse);
    // L'EMPREINTE fait foi, pas la valeur d'avant (550 000) : 600 000 est ce que le centre a vu.
    expect(hausse.message).toMatch(/visa du bon de commande est rouvert : Montant relevé de 600\s000 DZD à 900\s000 DZD/);
    const rouvert = await etat(id);
    expect(rouvert.orderStage).toBe("REQUESTED");
    expect(rouvert.orderDirectionAt).toBeNull();
    expect(rouvert.orderVisaAmount).toBeNull();
    const pourLeCentre = await prisma.notification.count({ where: { userId: gmId, title: "Bon de commande à revoir", createdAt: { gte: t0 } } });
    expect(pourLeCentre, "le siège du centre est prévenu").toBe(1);
    // Les Finances avaient reçu « à émettre » : sans ce message, l'ordre partirait sous l'ancien visa.
    // (Le Super Admin est à la fois au centre et aux Finances : il reçoit les deux.)
    const pourLesFinances = await prisma.notification.count({ where: { userId: saId, title: "Bon de commande renvoyé au centre — ne pas l'émettre", createdAt: { gte: t0 } } });
    expect(pourLesFinances, "les Finances sont prévenues de ne pas émettre").toBe(1);
  });

  it("LE PRESTATAIRE CHANGÉ après le visa rouvre aussi — c'est à lui que l'argent part", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Kakémonos", 700_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    await comme("kam");
    const r = await updateAdProItem(undefined, fd({ id, supplier: "Imprimerie Beta" }));
    ok(r);
    expect(r.message).toMatch(/Prestataire changé après la validation du centre : « Imprimerie Alpha » → « Imprimerie Beta »/);
    expect((await etat(id)).orderStage).toBe("REQUESTED");
    // La même chose écrite autrement n'est pas un autre prestataire : après un nouveau visa, rien ne bouge.
    ok(await viser(id));
    await comme("kam");
    const pareil = await updateAdProItem(undefined, fd({ id, supplier: "  IMPRIMERIE beta " }));
    ok(pareil);
    expect((await etat(id)).orderStage).toBe("DIRECTION_OK");
  });

  it("EN ATTENTE au centre, passé SOUS le seuil : la validation n'a plus d'objet — le BC part aux Finances", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Affiches", 600_000);
    ok(await demanderBC(id));
    await comme("pm");
    const r = await updateAdProItem(undefined, fd({ id, amountGranted: "300000" }));
    ok(r);
    const e = await etat(id);
    expect(e.orderStage).toBe("DIRECTION_OK");
    expect(e.orderDirectionAt, "aucun centre ne l'a visé : il est passé sous le seuil").toBeNull();
    expect(e.orderVisaAmount, "aucun centre n'a rien vu : aucune empreinte — la règle ne la lirait pas (§118.45)").toBeNull();
    // Porté ensuite AU-DESSUS : aucun centre ne l'avait vu — il rouvre.
    const remonte = await updateAdProItem(undefined, fd({ id, amountGranted: "650000" }));
    ok(remonte);
    expect(remonte.message).toMatch(/au-dessus du seuil de validation des bons de commande \(500\s000 DZD\)/);
    expect((await etat(id)).orderStage).toBe("REQUESTED");
  });

  it("LE DERNIER REMPART : un montant changé par un chemin que rien n'a surveillé — la demande de paiement refuse et rouvre le visa", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Catalogues", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    await bcSigne(id);
    // Décor : un écrivain qui ne passe pas par l'action (une correction en base, un import) relève le montant.
    await prisma.adProItem.update({ where: { id }, data: { amountGranted: 950_000 } });
    const r = await payer(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Paiement refusé — Le visa du bon de commande est rouvert : Montant relevé de 600\s000 DZD à 950\s000 DZD/);
    const e = await etat(id);
    expect(e.orderStage).toBe("REQUESTED");
    expect(e.expenseOrderId, "aucun ordre n'est parti").toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId, label: { contains: "Catalogues" } } })).toBe(0);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "FACTURE" } }), "et aucune facture n'est rattachée").toBe(0);
  });

  it("UNE DEMANDE DE PAIEMENT EN COURS (la prise posée, l'ordre pas encore rattaché) : un second clic ne crée pas un second ordre", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Prise", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    await bcSigne(id);
    // Décor : la prise d'une première demande de paiement est posée, son ordre n'est pas (encore)
    // rattaché — le cas d'un ordre né sans pouvoir être rattaché, où la prise RESTE exprès. Sans le
    // refus, ce second clic relirait « émis, sans ordre » et la prise conditionnelle (sur l'étape lue)
    // le laisserait passer.
    await prisma.adProItem.update({ where: { id }, data: { orderStage: "ISSUED" } });
    const r = await payer(id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/demande de paiement est déjà en cours/);
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId, label: { contains: "Prise" } } })).toBe(0);
  });

  it("CE QUE LE CENTRE A LU : un montant ou un prestataire changé pendant la lecture ne se vise pas", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Stand", 800_000);
    ok(await demanderBC(id));
    const lu = await viser(id, { montantVu: "750000" });
    expect(lu.ok).toBe(false);
    expect(lu.error).toMatch(/a changé pendant que vous lisiez \(750\s000 → 800\s000 DZD\)/);
    const prest = await viser(id, { montantVu: "800000", prestataireVu: "Autre imprimerie" });
    expect(prest.ok).toBe(false);
    expect(prest.error).toMatch(/prestataire de ce poste a changé pendant que vous lisiez/);
    expect((await etat(id)).orderStage).toBe("REQUESTED");
    // UN REFUS SANS MOTIF EST UNE IMPASSE : le demandeur ne saurait pas quoi corriger.
    const sansMotif = await approveAdProItemOrder(undefined, fd({ id, decision: "REFUSE" }));
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.error).toMatch(/Indiquez le motif du refus/);
    expect((await etat(id)).orderStage).toBe("REQUESTED");
    const t0 = new Date();
    ok(await approveAdProItemOrder(undefined, fd({ id, decision: "REFUSE", note: "Devis non conforme." })));
    const refuse = await etat(id);
    expect(refuse.orderStage).toBe("REFUSED");
    expect(refuse.orderDecisionNote).toBe("Devis non conforme.");
    expect(await prisma.notification.count({ where: { userId: kamId, title: "Bon de commande refusé par le centre Ad & Pro", createdAt: { gte: t0 } } })).toBe(1);
  });

  it("ÉCRITURES CONDITIONNELLES : ce qui change entre la lecture et l'écriture l'emporte — visa, retrait, décision", async () => {
    SEUIL = 500_000;
    // 1. Le MONTANT relevé pendant que le centre lit : le visa ne s'applique pas — il aurait visé 900 000
    //    en croyant viser 600 000.
    const montant = await posteAccorde("Course montant", 600_000);
    ok(await demanderBC(montant));
    const gm = await acteur(gmId, "GENERAL_MANAGER");
    ACTOR = gm;
    const v1 = await pendantLaLecture(
      () => approveAdProItemOrder(undefined, fd({ id: montant, decision: "APPROVE" })),
      (tx) => tx.adProItem.update({ where: { id: montant }, data: { amountGranted: 900_000 } }),
    );
    expect(v1.ok, JSON.stringify(v1)).toBe(false);
    expect(v1.error).toMatch(/vient de changer/);
    const e1 = await etat(montant);
    expect(e1.orderStage).toBe("REQUESTED");
    expect(e1.orderVisaAmount).toBeNull();
    // 2. Le PRESTATAIRE changé pendant que le centre lit : de même — c'est à lui que l'argent part.
    const prest = await posteAccorde("Course prestataire", 600_000);
    ok(await demanderBC(prest));
    ACTOR = gm;
    const v2 = await pendantLaLecture(
      () => approveAdProItemOrder(undefined, fd({ id: prest, decision: "APPROVE" })),
      (tx) => tx.adProItem.update({ where: { id: prest }, data: { supplier: "Imprimerie Gamma" } }),
    );
    expect(v2.ok, JSON.stringify(v2)).toBe(false);
    expect((await etat(prest)).orderStage).toBe("REQUESTED");
    // 3. Une émission prend le poste pendant qu'on RETIRE la demande de BC : le retrait ne défait pas la prise.
    const retrait = await posteAccorde("Course retrait", 600_000);
    ok(await demanderBC(retrait));
    ok(await viser(retrait));
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const v3 = await pendantLaLecture(
      () => retirerDemandeBC(undefined, fd({ id: retrait, motif: "Devis caduc." })),
      (tx) => tx.adProItem.update({ where: { id: retrait }, data: { orderStage: "ISSUED" } }),
    );
    expect(v3.ok, JSON.stringify(v3)).toBe(false);
    expect(v3.error).toMatch(/vient de changer/);
    expect((await etat(retrait)).orderStage, "l'émission prise n'est pas défaite").toBe("ISSUED");
    // 4. Une émission prend le poste pendant que la Direction le REFUSE : la décision ne passe pas sur un
    //    poste dont l'ordre est en train de naître.
    const decision = await posteAccorde("Course décision", 600_000);
    ok(await demanderBC(decision));
    ok(await viser(decision));
    ACTOR = await acteur(pmId, "PRODUCT_MANAGER");
    const v4 = await pendantLaLecture(
      () => decideAdProItem(undefined, fd({ id: decision, decision: "REJECTED", note: "Hors budget." })),
      (tx) => tx.adProItem.update({ where: { id: decision }, data: { orderStage: "ISSUED" } }),
    );
    expect(v4.ok, JSON.stringify(v4)).toBe(false);
    expect(v4.error).toMatch(/vient de changer/);
    expect((await etat(decision)).status).toBe("APPROVED");
  });

  it("DEUX DEMANDES DE PAIEMENT SIMULTANÉES : un seul ordre de dépense, une seule facture", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Goodies", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    await bcSigne(id);
    ACTOR = await acteur(kamId, "MEDICAL_DELEGATE");
    const unePaie = () => {
      const f = fd({ id, montant: "600000", argumentation: "Écart connu et accepté (banc).", confirme: "1" });
      f.append("attachment", pdf(`${TAG}facture.pdf`));
      return demanderPaiementPoste(undefined, f);
    };
    const [a, b] = await sousBarriere(() => [unePaie(), unePaie()]);
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    const perdant = a.ok ? b : a;
    expect(perdant.error).toMatch(/vient de changer|déjà en cours|déjà été demandé/);
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId, label: { contains: "Goodies" } } }), "deux ordres pour le même poste").toBe(1);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "FACTURE" } }), "le perdant n'a rien déposé").toBe(1);
  });

  it("DEUX DEMANDES DE BC SIMULTANÉES : une seule passe, un seul « BC à établir »", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Banderoles", 600_000);
    const kam = await acteur(kamId, "MEDICAL_DELEGATE");
    ACTOR = kam;
    const [a, b] = await sousBarriere(() => [
      requestAdProItemOrder(undefined, fd({ id, note: "Premier envoi", assistantId: astId })),
      requestAdProItemOrder(undefined, fd({ id, note: "Second envoi", assistantId: astId })),
    ]);
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect((await travauxBc(id)).filter((d) => d.status !== "CANCELLED")).toHaveLength(1);
  });

  it("RETIRER LA DEMANDE DE BC : motif exigé, le « BC à établir » se ferme avec — et l'assistante le lit", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Flyers", 600_000);
    ok(await demanderBC(id));
    const [travail] = await travauxBc(id);
    expect(travail.status).toBe("PENDING");
    await comme("kam");
    const t0 = new Date();
    const sans = await retirerDemandeBC(undefined, fd({ id }));
    expect(sans.ok).toBe(false);
    expect(sans.error).toMatch(/Dites pourquoi/);
    ok(await retirerDemandeBC(undefined, fd({ id, motif: "Le devis est caduc." })));
    const e = await etat(id);
    expect(e.orderStage).toBe("NONE");
    expect(e.orderVisaAmount).toBeNull();
    const [apres] = await travauxBc(id);
    expect(apres.status, "l'assistante ne cherche plus un BC qui n'existe plus").toBe("CANCELLED");
    // Elle l'APPREND, motif compris — par le lien causal (sa demande de pièce), pas un compte de titres.
    const avis = await prisma.notification.findFirstOrThrow({ where: { userId: astId, link: `/pieces/${apres.id}`, createdAt: { gte: t0 } }, select: { title: true, body: true } });
    expect(avis.title).toBe("Demande de pièce annulée");
    expect(avis.body).toMatch(/la demande de bon de commande du poste .* a été annulée — Le devis est caduc\./);
    // Et une nouvelle demande repart : un poste n'est pas figé par un retrait.
    ok(await demanderBC(id, "Nouveau devis DV-31."));
    expect((await etat(id)).orderStage).toBe("REQUESTED");
    expect((await travauxBc(id)).filter((d) => d.status === "PENDING"), "une demande NEUVE, la close reste close").toHaveLength(1);
  });

  it("ANNULER LA DEMANDE DE BC — geste unique (constat 36) : le BC établi NON signé part au registre avec la demande", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Plaquettes", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    // Le BC établi par la VRAIE chaîne : déposé par l'assistante, accepté par le demandeur (§118.204).
    const pieceId = await bcEtabli(id);
    // Tant que le BC vit, revoir la décision et rendre le poste restent refusés — et le refus nomme le geste.
    await comme("pm");
    const revoir = await decideAdProItem(undefined, fd({ id, decision: "REVISION", note: "À revoir" }));
    expect(revoir.ok).toBe(false);
    expect(revoir.error).toMatch(/Annuler la demande de BC/);
    await comme("kam");
    expect((await demanderRevisionPoste(undefined, fd({ id, motif: "x" }))).ok).toBe(false);
    // Le motif est exigé — APRÈS l'état : ici rien ne refuse, on demande pourquoi.
    const sans = await retirerDemandeBC(undefined, fd({ id }));
    expect(sans.ok).toBe(false);
    expect(sans.error).toMatch(/Dites pourquoi/);
    // QUI TRANCHE annule : le demandeur (le délégué) est prévenu, c'est sa demande qui s'arrête.
    await comme("pm");
    const t0 = new Date();
    const r = await retirerDemandeBC(undefined, fd({ id, motif: "Le prestataire a changé." }));
    ok(r);
    expect(r.message ?? "").toMatch(/non signé, est annulé au registre/);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: pieceId }, select: { status: true, cancelReason: true, cancelledAt: true } });
    expect(doc.status, "le BC part avec la demande").toBe("CANCELLED");
    expect(doc.cancelReason ?? "").toMatch(/Le prestataire a changé\./);
    expect(doc.cancelledAt).not.toBeNull();
    expect((await etat(id)).orderStage, "le poste revient sans demande de BC").toBe("NONE");
    expect(await prisma.notification.count({ where: { userId: kamId, title: "Demande de bon de commande annulée", createdAt: { gte: t0 } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: pieceId, createdAt: { gte: t0 }, summary: { contains: "annulé avec la demande" } } })).toBe(1);
    // Rien ne retient plus le poste : une nouvelle demande de BC repart.
    ok(await demanderBC(id, "Nouveau prestataire, devis DV-77."));
    expect((await etat(id)).orderStage).toBe("REQUESTED");
  });

  it("ANNULER LA DEMANDE DE BC : un BC SIGNÉ par les Finances refuse — AVANT le motif, en le nommant, et rien n'est touché", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Kakémonos", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    const pieceId = await bcSigne(id);
    await comme("kam");
    const r = await retirerDemandeBC(undefined, fd({ id }));
    expect(r.ok).toBe(false);
    expect(r.error, "l'état refuse avant qu'on demande pourquoi").toMatch(/est signé par les Finances/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: pieceId }, select: { status: true } })).status).not.toBe("CANCELLED");
    expect((await etat(id)).orderStage).toBe("DIRECTION_OK");
  });

  it("ANNULER LA DEMANDE DE BC pendant que les Finances SIGNENT : la signature gagne, rien n'est annulé (course forcée)", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Course signature", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    const pieceId = await bcEtabli(id);
    await comme("kam");
    let geste!: Promise<Awaited<ReturnType<typeof retirerDemandeBC>>>;
    await prisma.$transaction(async (tx) => {
      // Les écritures sur CE BC attendent, ses lectures passent : l'annulation lit un BC NON signé, puis bute
      // sur le verrou ; le détenteur signe le BC (il peut écrire), puis relâche.
      //
      // Un verrou de LIGNE, et une barrière qui ne compte que les connexions bloquées PAR CETTE TRANSACTION :
      // l'ancien verrou de table bloquait aussi les écritures des autres fichiers de la suite, et la première
      // d'entre elles suffisait à franchir la barrière avant que le geste y soit — sous charge, la signature
      // passait alors AVANT la lecture, et le geste répondait « est signé » au lieu de « vient de changer ».
      await tx.$queryRaw`SELECT id FROM "LegalDocument" WHERE id = ${pieceId} FOR SHARE`;
      geste = retirerDemandeBC(undefined, fd({ id, motif: "Course." }));
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((res) => setTimeout(res, 25));
      }
      await tx.legalDocument.update({ where: { id: pieceId }, data: { signedAt: new Date(), signedById: finId } });
    }, { timeout: 20_000 });
    const r = await geste;
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toMatch(/vient de changer/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: pieceId }, select: { status: true } })).status, "le BC signé reste").not.toBe("CANCELLED");
    expect((await etat(id)).orderStage, "tout ou rien : le poste garde sa demande").toBe("DIRECTION_OK");
  });

  it("MODIFIER LA DEMANDE DE BC : le message change, et le « BC à établir » de l'assistante avec lui", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Badges", 600_000);
    ok(await demanderBC(id, "Réf. ancienne."));
    await comme("kam");
    expect((await modifierDemandeBC(undefined, fd({ id }))).ok, "un message vide n'est pas une correction").toBe(false);
    ok(await modifierDemandeBC(undefined, fd({ id, note: "Réf. corrigée DV-44, 500 badges." })));
    expect((await etat(id)).orderNote).toBe("Réf. corrigée DV-44, 500 badges.");
    const [travail] = await travauxBc(id);
    expect(travail.note ?? "").toMatch(/^Réf\. corrigée DV-44, 500 badges\./);
    expect((await travauxBc(id)).length, "la demande ouverte est mise à jour, pas doublée").toBe(1);
  });

  it("ANNULER L'ORDRE ÉMIS puis RÉÉMETTRE — le délégué ne peut pas ; un ordre réglé ne s'annule pas", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Sacs", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    await bcSigne(id);
    const em = await payer(id);
    ok(em);
    const premier = em.id!;
    // LE DEMANDEUR annule sa demande de paiement tant qu'elle n'est pas réglée (04/10) : son droit passe,
    // c'est le motif manquant qui l'arrête ici.
    await comme("kam");
    const sansMotif = await annulerOrdrePoste(undefined, fd({ id }));
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.error).toMatch(/Dites pourquoi/);
    await comme("pm");
    expect((await annulerOrdrePoste(undefined, fd({ id }))).ok, "motif exigé").toBe(false);
    ok(await annulerOrdrePoste(undefined, fd({ id, motif: "Mauvais RIB." })));
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: premier }, select: { status: true } })).status).toBe("CANCELLED");
    const e = await etat(id);
    expect(e.expenseOrderId).toBeNull();
    expect(e.orderStage, "le visa du centre tient : le paiement se redemande").toBe("DIRECTION_OK");
    const re = await payer(id);
    ok(re);
    expect(re.id).not.toBe(premier);
    await prisma.expenseOrder.update({ where: { id: re.id! }, data: { status: "PAID" } });
    await comme("pm");
    const regle = await annulerOrdrePoste(undefined, fd({ id, motif: "Trop tard" }));
    expect(regle.ok).toBe(false);
    expect(regle.error).toMatch(/déjà réglé/);
  });

  it("DEMANDER UNE RÉVISION : le poste accordé repart à la Direction — sa demande de BC se retire avec lui", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Hôtel", 600_000);
    ok(await demanderBC(id));
    await comme("kam");
    expect((await demanderRevisionPoste(undefined, fd({ id }))).ok, "motif exigé").toBe(false);
    const r = await demanderRevisionPoste(undefined, fd({ id, motif: "Le devis réel est plus élevé.", amountEstimated: "720000" }));
    ok(r);
    const e = await etat(id);
    expect(e.status).toBe("PENDING");
    expect(e.amountGranted, "l'accord d'hier n'engage plus").toBeNull();
    expect(e.orderStage).toBe("NONE");
    expect((await travauxBc(id))[0].status).toBe("CANCELLED");
    const derniere = await prisma.adProItemDecision.findFirstOrThrow({ where: { itemId: id }, orderBy: { at: "desc" }, select: { decision: true, note: true } });
    expect(derniere.decision).toBe("PENDING");
    expect(derniere.note ?? "").toMatch(/Le devis réel est plus élevé/);
    // Hors d'un accord, la révision ne se demande pas : le poste se modifie et se resoumet — et le refus le
    // dit (l'écriture conditionnelle refuserait aussi, mais avec une phrase qui ne nomme pas le remède).
    const horsAccord = await demanderRevisionPoste(undefined, fd({ id, motif: "encore" }));
    expect(horsAccord.ok).toBe(false);
    expect(horsAccord.error).toMatch(/Seul un poste accordé se rend à la Direction/);
  });

  it("REVOIR LA DÉCISION : un accord qui part en refus retire la demande de BC et clôt les demandes au secrétariat — motif exigé", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Traiteur", 600_000);
    ok(await demanderBC(id));
    await comme("kam");
    ok(await demanderPieceSecretariat(undefined, fd({ id, nature: "DEVIS", note: "Devis traiteur 80 couverts." })));
    await comme("pm");
    const sans = await decideAdProItem(undefined, fd({ id, decision: "REJECTED" }));
    expect(sans.ok).toBe(false);
    expect(sans.error).toMatch(/Indiquez le motif/);
    const r = await decideAdProItem(undefined, fd({ id, decision: "REJECTED", note: "Hors budget de l'année." }));
    ok(r);
    const e = await etat(id);
    expect(e.status).toBe("REJECTED");
    expect(e.orderStage).toBe("NONE");
    const ouvertes = await prisma.administrativeRequest.count({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id, status: { notIn: ["DONE", "CANCELLED"] } } });
    expect(ouvertes, "ni le devis ni le BC à établir ne restent ouverts pour une dépense refusée").toBe(0);
    // Revu à nouveau, en accord, plus cher : la décision se reprend — l'historique garde les trois.
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "650000" })));
    expect((await etat(id)).status).toBe("APPROVED");
    expect(await prisma.adProItemDecision.count({ where: { itemId: id } })).toBeGreaterThanOrEqual(3);
  });

  it("RETIRER LE POSTE : l'ordre non réglé s'annule, le poste part à la CORBEILLE avec ses décisions, et revient", async () => {
    SEUIL = 500_000;
    // Un SPONSORING DIRECT (§118.204) : payé sur proforma / lettre de demande (Direction, 05/10), sans BC — le seul poste dont l'ordre peut
    // exister sans BC signé, donc le seul qui se retire avec un ordre en attente (un BC signé bloque).
    const id = await posteAccorde("Navettes", 600_000, "Association Alpha", "ASSOCIATION_SUPPORT");
    const em = await payer(id);
    ok(em);
    await comme("pm");
    const decisionsAvant = await prisma.adProItemDecision.count({ where: { itemId: id } });
    const r = await deleteAdProItem(undefined, fd({ id }));
    ok(r);
    expect(r.message ?? "").toMatch(/restaurable depuis la corbeille/);
    expect(await prisma.adProItem.count({ where: { id } }), "parti").toBe(0);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: em.id! }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await prisma.adProItemPiece.count({ where: { itemId: id } }), "le lien vers la facture part avec le poste").toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: id, kind: "AD_PRO_ITEM" }, select: { id: true } });
    await comme("sa");
    ok(await restoreDeletedRecord(fd({ id: rec.id })));
    const revenu = await etat(id);
    expect(revenu.status, "il revient tel qu'il était").toBe("APPROVED");
    expect(revenu.expenseOrderId, "sans l'ordre annulé : sinon « émis » pour toujours, impossible à réémettre").toBeNull();
    expect(revenu.orderStage, "sans BC demandé, il revient sans étape de BC").toBe("NONE");
    expect(await prisma.adProItemDecision.count({ where: { itemId: id } }), "l'historique revient avec lui").toBe(decisionsAvant);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "DEVIS" } }), "sa proforma / lettre revient sur lui").toBe(1);
  });

  /**
   * DÉFAUT RÉPARÉ (audit du 04/10, constat 20 — nommé en §118.204) : un sponsoring direct dont le paiement
   * est demandé ET qui porte une demande au secrétariat ouverte ne se retirait plus — « la demande dépend
   * d'une de ses propres branches ». Mesuré : la SEULE dépendance de la tête vers le lot était
   * `AdProItem.adminRequestId` → la demande au secrétariat que le couple `linkedEntityType` emporte (la
   * « seconde boucle » supposée n'existait pas). Colonne facultative : le lot DIFFÈRE ce lien — la tête
   * renaît sans lui, la demande renaît, puis le lien est rétabli (`liensTete`, `lot.ts`).
   */
  it("RETIRER un poste payé qui a une demande au secrétariat ouverte : elle part avec lui, l'assistante l'apprend, tout revient", async () => {
    SEUIL = 500_000;
    // Un SPONSORING DIRECT (§118.204) : payé sur proforma / lettre de demande (Direction, 05/10), sans BC — le seul poste dont l'ordre peut
    // exister sans BC signé, donc le seul qui se retire avec un ordre en attente (un BC signé bloque).
    const id = await posteAccorde("Navettes", 600_000, "Association Alpha", "ASSOCIATION_SUPPORT");
    await comme("kam");
    ok(await demanderPieceSecretariat(undefined, fd({ id, nature: "DEVIS", note: "Pro forma de l'association." })));
    const em = await payer(id);
    ok(em);
    await comme("pm");
    const decisionsAvant = await prisma.adProItemDecision.count({ where: { itemId: id } });
    const demandesDe = () => prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id }, select: { id: true, status: true } });
    const [travail] = await demandesDe();
    expect(travail?.status, "PRÉMISSE : une demande au secrétariat ouverte travaille pour ce poste").toBe("NEW");
    const t0 = new Date();
    const r = await deleteAdProItem(undefined, fd({ id }));
    ok(r);
    expect(r.message ?? "").toMatch(/restaurable depuis la corbeille/);
    expect(r.message ?? "").toMatch(/1 demande au secrétariat est partie avec lui/);
    expect(await prisma.adProItem.count({ where: { id } }), "parti").toBe(0);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: em.id! }, select: { status: true } })).status).toBe("CANCELLED");
    // LA DEMANDE AU SECRÉTARIAT PART AVEC LE POSTE (le lot l'emporte) — et l'assistante l'apprend.
    expect(await demandesDe(), "elle a quitté la liste de l'assistante").toHaveLength(0);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id } }), "le lien vers la facture part avec le poste").toBe(0);
    expect(await prisma.notification.count({ where: { userId: astId, title: "Demande au secrétariat retirée avec son poste", createdAt: { gte: t0 } } })).toBe(1);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: id, kind: "AD_PRO_ITEM" }, select: { id: true } });
    await comme("sa");
    ok(await restoreDeletedRecord(fd({ id: rec.id })));
    const revenu = await etat(id);
    expect(revenu.status, "il revient tel qu'il était").toBe("APPROVED");
    expect(revenu.expenseOrderId, "sans l'ordre annulé : sinon « émis » pour toujours, impossible à réémettre").toBeNull();
    expect(revenu.orderStage, "sans BC demandé, il revient sans étape de BC").toBe("NONE");
    expect(await prisma.adProItemDecision.count({ where: { itemId: id } }), "l'historique revient avec lui").toBe(decisionsAvant);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "DEVIS" } }), "sa proforma / lettre revient sur lui").toBe(1);
    // Et la demande revient TELLE QU'ELLE ÉTAIT : la clore d'abord ferait revenir un poste dont la demande
    // vit encore, annulée.
    const [revenue] = await demandesDe();
    expect(revenue?.id).toBe(travail.id);
    expect(revenue?.status).toBe("NEW");
  });

  it("UN ORDRE RÉGLÉ : le poste ne se retire pas, et rien n'est touché", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Réglé", 600_000, "Association Alpha", "ASSOCIATION_SUPPORT");
    const em = await payer(id);
    ok(em);
    // Décor : le centre de paiement a réglé l'ordre — un écrivain étranger à ce banc.
    await prisma.expenseOrder.update({ where: { id: em.id! }, data: { status: "PAID" } });
    await comme("pm");
    const r = await deleteAdProItem(undefined, fd({ id }));
    expect(r.ok).toBe(false);
    expect(await prisma.adProItem.count({ where: { id } })).toBe(1);
    expect((await etat(id)).expenseOrderId).toBe(em.id);
    // LA CORBEILLE DU SUPER ADMIN ne passe pas à côté : le lot suit l'ordre du poste, et un ordre réglé le bloque.
    await comme("sa");
    const corbeille = await superAdminDelete(fd({ kind: "AD_PRO_ITEM", id }));
    expect(corbeille.ok).toBe(false);
    expect(corbeille.error).toMatch(/a été réglé/);
    expect(await prisma.adProItem.count({ where: { id } })).toBe(1);
  });

  it("UNE PIÈCE SIGNÉE PAR LES FINANCES : le poste ne se retire pas — et son ordre n'est pas annulé pour rien", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Signé", 600_000);
    ok(await demanderBC(id));
    ok(await viser(id));
    // Le BC établi pour ce poste, SIGNÉ par les Finances (§118.149), puis la facture qui en demande le
    // paiement — la vraie chaîne de §118.204.
    await bcSigne(id);
    const em = await payer(id);
    ok(em);
    await comme("pm");
    const r = await deleteAdProItem(undefined, fd({ id }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/signée par les Finances/);
    expect(await prisma.adProItem.count({ where: { id } })).toBe(1);
    // L'AVANT-REFUS est lu AVANT l'annulation : sans lui, l'ordre partait annulé et le poste restait.
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: em.id! }, select: { status: true } })).status).toBe("PENDING");
    expect((await etat(id)).expenseOrderId).toBe(em.id);
  });

  it("LA CORBEILLE DU SUPER ADMIN emporte l'ordre NON RÉGLÉ du poste, et le rend avec lui — rien ne reste payable pour un poste disparu", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Corbeille", 600_000, "Association Alpha", "ASSOCIATION_SUPPORT");
    const em = await payer(id);
    ok(em);
    await comme("sa");
    ok(await superAdminDelete(fd({ kind: "AD_PRO_ITEM", id })));
    expect(await prisma.adProItem.count({ where: { id } })).toBe(0);
    expect(await prisma.expenseOrder.count({ where: { id: em.id! } }), "avant : l'ordre restait payable au centre de paiement").toBe(0);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id } }), "le lien vers sa facture part aussi").toBe(0);
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: id, kind: "AD_PRO_ITEM" }, select: { id: true } });
    ok(await restoreDeletedRecord(fd({ id: rec.id })));
    const revenu = await etat(id);
    expect(revenu.expenseOrderId, "l'ordre revient avec son poste").toBe(em.id);
    expect(revenu.orderStage).toBe("ISSUED");
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: em.id! }, select: { status: true } })).status).toBe("PENDING");
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "DEVIS" } }), "et sa proforma / lettre avec lui").toBe(1);
  });

  it("UNE DEMANDE REFUSÉE ne fait plus partir ses postes — mais les refuser reste possible", async () => {
    SEUIL = 500_000;
    const refusee = await prisma.event.create({
      data: { name: `${TAG}Refusé`, requesterId: kamId, status: "AWAITING_VALIDATION", requestStatus: "REJECTED", startDate: new Date("2026-12-05") },
      select: { id: true },
    });
    try {
      const poste = await prisma.adProItem.create({ data: { eventId: refusee.id, kind: "PRINTING", label: `${TAG}Sur refusée`, amountEstimated: 100_000, createdById: kamId }, select: { id: true } });
      postes.push(poste.id);
      await comme("kam");
      const soumis = await submitAdProItem(undefined, fd({ id: poste.id }));
      expect(soumis.ok).toBe(false);
      expect(soumis.error).toMatch(/refusée ou annulée : ses postes ne partent plus/);
      await comme("pm");
      const accorde = await decideAdProItem(undefined, fd({ id: poste.id, decision: "APPROVED" }));
      expect(accorde.ok).toBe(false);
      ok(await decideAdProItem(undefined, fd({ id: poste.id, decision: "REJECTED", note: "La demande est refusée." })));
      // Un poste DÉJÀ accordé avant le refus de la demande ne fait pas partir son bon de commande.
      const accordeAvant = await prisma.adProItem.create({
        data: { eventId: refusee.id, kind: "PRINTING", label: `${TAG}Accordé avant`, amountEstimated: 100_000, amountGranted: 100_000, status: "APPROVED", budgetCategoryId: catId, createdById: kamId },
        select: { id: true },
      });
      postes.push(accordeAvant.id);
      await comme("kam");
      const bc = await requestAdProItemOrder(undefined, fd({ id: accordeAvant.id, note: "x" }));
      expect(bc.ok).toBe(false);
      expect(bc.error).toMatch(/refusée ou annulée : ses postes ne partent plus/);
    } finally {
      await prisma.adProItemDecision.deleteMany({ where: { item: { eventId: refusee.id } } }).catch(() => {});
      await prisma.adProItem.deleteMany({ where: { eventId: refusee.id } }).catch(() => {});
      await prisma.event.delete({ where: { id: refusee.id } }).catch(() => {});
    }
  });
});
