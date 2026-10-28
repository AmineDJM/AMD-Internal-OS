import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
/**
 * LE SEUIL DES BONS DE COMMANDE EST UN RÉGLAGE GLOBAL (§118.132) : le banc l'INJECTE dans son propre
 * processus, la base partagée garde le sien.
 */
let SEUIL = 500_000;
/**
 * LE SEUIL DE LA PORTE DU DG SUR LE TOTAL D'UNE DEMANDE (27/10/2026) est un réglage global lui aussi :
 * injecté de même. Par défaut HORS D'ATTEINTE — ce banc mesure la chaîne d'un poste, et le congrès de
 * Sétif accumule des postes de cas en cas. Le cas « LA PORTE DU DG » le descend, sur sa propre demande.
 */
const SEUIL_DG_HORS_ATTEINTE = 1_000_000_000_000;
let SEUIL_DG = SEUIL_DG_HORS_ATTEINTE;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: SEUIL, adProDgThreshold: SEUIL_DG }) };
});
/**
 * LES ASSISTANTES DE DIRECTION ACTIVES SONT UN FAIT GLOBAL : les bancs voisins en créent et en
 * effacent en même temps. Le choix automatique « la seule assistante active » ne se juge donc que sur
 * un voisinage FERMÉ — la VRAIE lecture (`assistantesDeDirection`), restreinte aux comptes de ce banc.
 * `null` : la lecture telle quelle.
 */
let ASSISTANTES: string[] | null = null;
vi.mock("@/lib/ad-pro/pieces-poste", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/ad-pro/pieces-poste")>();
  return {
    ...vrai,
    assistantesDeDirection: async () => {
      const toutes = await vrai.assistantesDeDirection();
      return ASSISTANTES ? toutes.filter((a) => ASSISTANTES!.includes(a.id)) : toutes;
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity, accesAuxPiecesLegal } from "@/lib/entity-access";
import {
  addAdProItem, submitAdProItem, decideAdProItem, requestAdProItemOrder, approveAdProItemOrder,
  ajouterDevisPoste, retirerDevisDuPoste, demanderPaiementPoste,
} from "@/lib/actions/ad-pro-item-actions";
import { submitDocumentRequest, decideDocumentRequest } from "@/lib/actions/document-request-actions";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { fileBonsDeCommande } from "@/lib/queries/bons-de-commande";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { ordreAFacture } from "@/modules/finances/api";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { signauxFinance } from "@/platform/in-process/intelligence";
import { getActionCenter } from "@/lib/queries/action-center";
import { statuerSurLeTotal, lirePorteDg } from "@/lib/ad-pro/porte-dg";
import { persistUploadedDocument } from "@/lib/documents";
import type { Prisma } from "@prisma/client";
import { TITRE_BC_A_ETABLIR } from "@/lib/ad-pro/pieces-secretariat";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__posteschaine__";
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
// UN FICHIER DISTINCT PAR DÉPÔT (Direction, 14/10) : le même fichier déposé comme deux factures serait la même facture, refusée.
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), `${nom}-${Date.now()}-${Math.random()}`], nom, { type: "application/pdf" });
const avecFichier = (champs: Record<string, string>, nom = `${TAG}piece.pdf`) => {
  const f = fd(champs);
  f.append("attachment", pdf(nom));
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHAÎNE D'UN POSTE AD & PRO — par les VRAIS points d'entrée (§118.204, règle du 27/10/2026).
 *
 * Depuis le 27/10/2026 : « celui qui accepte un poste, c'est la Direction Marketing » — UN SEUL temps
 * (montant ET budget), les postes ne s'ajoutent qu'après la PRÉVALIDATION de la demande, et au-dessus
 * du seuil le DG valide le TOTAL de la demande avant tout bon de commande ou paiement. La suite, elle,
 * ne change pas (Direction, 04/10) : « À l'émission du bon de commande, la demande va chez l'assistante de
 * direction ; quand elle l'uploade, ça revient ici. Dans les postes, la pro forma ou le devis, puis le
 * bon de commande, puis la facture — obligatoirement facture pour demander un paiement. Un sponsoring
 * direct n'a pas de bon de commande » (Direction, 04/10).
 *
 * Aucun acteur n'a la vue globale (§118.104) — les prémisses le vérifient. Chaque acteur est NOMMÉ
 * dans son cas (§118.151f). Les juges comptent par LIEN CAUSAL — la pièce de CE poste, l'ordre de CE
 * poste —, jamais un compte global de la base partagée (§118.92).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — la chaîne d'un poste : un seul temps, BC par l'assistante, facture, paiement", () => {
  const u: Record<"kam" | "kam2" | "ops" | "dm" | "dm2" | "gm" | "fin" | "ast1" | "ast2", string> = {
    kam: "", kam2: "", ops: "", dm: "", dm2: "", gm: "", fin: "", ast1: "", ast2: "",
  };
  // `dm2` : une SECONDE personne de la Direction Marketing — celle qui accepte les postes d'une demande de `dm`.
  const ROLES = {
    kam: "MEDICAL_DELEGATE", kam2: "MEDICAL_DELEGATE", ops: "DIRECTION", dm: "PRODUCT_MANAGER", dm2: "PRODUCT_MANAGER",
    gm: "GENERAL_MANAGER", fin: "FINANCE_BUDGET_MANAGER", ast1: "DIRECTION_ASSISTANT", ast2: "DIRECTION_ASSISTANT",
  } as const;
  let congres = "", congres2 = "", evtDm = "", evtOps = "", spo = "", catId = "";
  // Les demandes NON prévalidées et celle de la porte du DG — chacune la sienne (§118.151f).
  let congresEnCircuit = "", evtSansCircuit = "", congresDg = "";
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) =>
      prisma.user.create({ data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    // PRÉVALIDÉES (27/10/2026) : congrès et événements par `requestStatus: APPROVED` (aucun montant écrit), le
    // sponsoring par PRE_VALIDATED — sans quoi aucun poste ne s'y ajoute.
    const [c1, c2, e1, e2, s1] = await Promise.all([
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Sétif`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Tlemcen`, requesterId: u.kam2, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.event.create({ data: { name: `${RUN} Journée Marketing`, requesterId: u.dm, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date("2026-12-04") }, select: { id: true } }),
      prisma.event.create({ data: { name: `${RUN} Journée Opérations`, requesterId: u.ops, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date("2026-12-05") }, select: { id: true } }),
      prisma.sponsoringRequest.create({
        data: { reference: `${RUN.slice(-14)}-SPO`, institution: `${RUN} Association cardio`, type: "Congrès", requesterId: u.kam, status: "PRE_VALIDATED" },
        select: { id: true },
      }),
    ]);
    congres = c1.id; congres2 = c2.id; evtDm = e1.id; evtOps = e2.id; spo = s1.id;
    const [c3, e3, c4] = await Promise.all([
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Béjaïa`, requesterId: u.kam, requestStatus: "AWAITING_FINAL" }, select: { id: true } }),
      // Un événement « organisé » (VALIDATED) mais né HORS circuit : un statut d'organisation ne vaut pas prévalidation.
      prisma.event.create({ data: { name: `${RUN} Journée hors circuit`, requesterId: u.kam, status: "VALIDATED", startDate: new Date("2026-12-06") }, select: { id: true } }),
      prisma.congressNational.create({ data: { name: `${RUN} Congrès d'Annaba`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } }),
    ]);
    congresEnCircuit = c3.id; evtSansCircuit = e3.id; congresDg = c4.id;
    const env = await prisma.budgetEnvelope.create({
      data: {
        name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL", "EVENTS", "SPONSORING"], totalAmount: 50_000_000,
        periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31"),
      },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Imprimerie`, allocated: 50_000_000 }, select: { id: true } })).id;
  });

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const parents = [congres, congres2, evtDm, evtOps, spo, congresEnCircuit, evtSansCircuit, congresDg].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({
      where: { OR: [{ congressNationalId: { in: parents } }, { eventId: { in: parents } }, { sponsoringId: { in: parents } }] },
      select: { id: true },
    }).catch(() => [])).map((p) => p.id);
    const demandes = await prisma.documentRequest.findMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } }, select: { id: true, legalDocumentId: true } }).catch(() => []);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    const docs = [...new Set([...demandes.map((d) => d.legalDocumentId), ...liens.map((l) => l.legalDocumentId)].filter((x): x is string => Boolean(x)))];
    await prisma.document.deleteMany({ where: { entityId: { in: [...docs, ...demandes.map((d) => d.id), ...postes] } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    const aDemandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: postes } }, select: { id: true } }).catch(() => [])).map((r) => r.id);
    await prisma.comment.deleteMany({ where: { entityType: "ADMIN_REQUEST", entityId: { in: aDemandes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: aDemandes } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: aDemandes } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { id: { in: demandes.map((d) => d.id) } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: docs } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: docs } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...docs, ...parents, ...postes] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: parents } }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: parents } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    for (const id of parents) await prisma.notification.deleteMany({ where: { link: { contains: id } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: [congres, congres2, congresEnCircuit, congresDg] } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: [evtDm, evtOps, evtSansCircuit] } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spo } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  type Parent = "CONGRESS_NATIONAL" | "EVENT" | "SPONSORING";
  /** Un poste AJOUTÉ par l'écran, par celui qui le décrit. */
  async function nouveauPoste(qui: keyof typeof ROLES, parent: Parent, parentId: string, label: string, montant: number, kind = "PRINTING", fournisseur = "Imprimerie Alpha") {
    await comme(qui);
    const a = await addAdProItem(undefined, fd({ parent, parentId, kind, label: `${TAG}${label}`, amountEstimated: String(montant), supplier: fournisseur }));
    ok(a);
    return a.id!;
  }
  /** Le poste soumis, accepté par la Direction Marketing (un seul temps) AVEC son budget. */
  async function posteAccorde(label: string, montant: number, opts: { parent?: Parent; parentId?: string; kind?: string; demandeur?: keyof typeof ROLES } = {}) {
    const demandeur = opts.demandeur ?? "kam";
    const id = await nouveauPoste(demandeur, opts.parent ?? "CONGRESS_NATIONAL", opts.parentId ?? congres, label, montant, opts.kind);
    await comme(demandeur);
    ok(await submitAdProItem(undefined, fd({ id })));
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
    return id;
  }
  const poste = (id: string) => prisma.adProItem.findUniqueOrThrow({ where: { id } });
  const demandeBC = (id: string) => prisma.documentRequest.findFirst({
    where: { entityType: "AD_PRO_ITEM", entityId: id, kind: "PURCHASE_ORDER" }, orderBy: { createdAt: "desc" },
  });
  /** L'assistante dépose la pièce sur SA demande, le demandeur l'accepte — la pièce Legal REVIENT au poste. */
  async function bcEtabli(id: string, assistante: "ast1" | "ast2" = "ast1"): Promise<string> {
    const dr = await demandeBC(id);
    expect(dr, "une demande de pièce a été envoyée").not.toBeNull();
    const depot = await persistUploadedDocument(u[assistante], {
      entityType: "DOCUMENT_REQUEST", entityId: dr!.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: pdf(`${TAG}bc.pdf`), maxUploadMb: 20,
    });
    expect(depot.ok, depot.error).toBe(true);
    await comme(assistante);
    ok(await submitDocumentRequest(fd({ id: dr!.id })));
    await comme("kam");
    ok(await decideDocumentRequest(fd({ id: dr!.id, accept: "1" })));
    const lien = await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: id, nature: "BON_DE_COMMANDE" }, orderBy: { createdAt: "desc" } });
    return lien.legalDocumentId;
  }
  async function bcSigne(id: string): Promise<string> {
    const doc = await bcEtabli(id);
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: doc }))));
    return doc;
  }
  async function payer(id: string, montant: string, qui: keyof typeof ROLES = "kam", avecPiece = true) {
    await comme(qui);
    const champs = { id, montant, reference: `${TAG}FA`, argumentation: "Écart connu et accepté (banc).", confirme: "1" };
    return demanderPaiementPoste(undefined, avecPiece ? avecFichier(champs, `${TAG}facture.pdf`) : fd(champs));
  }
  const file = async (qui: keyof typeof ROLES) => (await getActionCenter(await acteur(u[qui], ROLES[qui]) as unknown as SessionUser)).items;

  /** Deux gestes forcés à se croiser : les écritures du poste attendent, les lectures passent (§118.164e). */
  async function sousBarriere<T>(lancer: () => Promise<T>[], attendus = 2): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

  it("PRÉMISSES : personne n'a la vue globale ; le KAM n'a pas Legal ; chacun voit la demande qu'il tranche", async () => {
    // EXPRÈS : la Direction des opérations (rôle `DIRECTION`) a la vue globale par son rôle — elle ne tranche
    // plus aucun poste (27/10/2026), et c'est ce que ce banc vérifie d'elle. Les gardes de LECTURE et de DROIT
    // sont éprouvées avec les autres acteurs, qui ne l'ont pas (§118.104).
    expect(hasGlobalView(await acteur(u.ops, "DIRECTION"))).toBe(true);
    for (const k of (Object.keys(ROLES) as (keyof typeof ROLES)[]).filter((x) => x !== "ops")) {
      expect(hasGlobalView(await acteur(u[k], ROLES[k])), `${k} : une garde éprouvée avec la vue globale ne peut pas tomber`).toBe(false);
    }
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    expect(userCan(kam, "LEGAL", "VIEW"), "le KAM n'a AUCUN droit sur Legal").toBe(false);
    expect(await canAccessEntity(kam, "CONGRESS_NATIONAL", congres, "VIEW")).toBe(true);
    expect(await canAccessEntity(await acteur(u.kam2, "MEDICAL_DELEGATE"), "CONGRESS_NATIONAL", congres, "VIEW"), "un autre délégué ne voit pas ce congrès").toBe(false);
    for (const k of ["ops", "dm"] as const) {
      expect(await canAccessEntity(await acteur(u[k], ROLES[k]), "CONGRESS_NATIONAL", congres, "VIEW"), `${k} voit le congrès qu'il tranche`).toBe(true);
    }
  });

  // ── AVANT LA PRÉVALIDATION ──────────────────────────────────────────────────────────────

  it("AVANT LA PRÉVALIDATION : aucun poste ne s'ajoute ni ne se soumet — congrès encore dans le circuit, événement né hors circuit", async () => {
    const PHRASE = /^Les postes s'ajoutent après la prévalidation de la Direction Marketing : la demande doit d'abord passer son N\+1, le Directeur des opérations puis la Direction Marketing\./;
    await comme("kam");
    for (const [parent, parentId] of [["CONGRESS_NATIONAL", congresEnCircuit], ["EVENT", evtSansCircuit]] as const) {
      const a = await addAdProItem(undefined, fd({ parent, parentId, kind: "PRINTING", label: `${TAG}Trop tôt`, amountEstimated: "50000" }));
      expect(a.ok === false ? a.error : "ajouté", parent).toMatch(PHRASE);
    }
    // Un brouillon né d'avant (DÉCOR, nommé : un poste d'avant la règle) ne se soumet pas non plus.
    const herite = await prisma.adProItem.create({
      data: { congressNationalId: congresEnCircuit, kind: "PRINTING", label: `${TAG}Brouillon d'avant`, amountEstimated: 50_000, createdById: u.kam, updatedById: u.kam },
    });
    const s = await submitAdProItem(undefined, fd({ id: herite.id }));
    expect(s.ok === false ? s.error : "soumis").toMatch(PHRASE);
    expect((await poste(herite.id)).status, "rien n'est écrit").toBe("DRAFT");
    expect(await prisma.adProItem.count({ where: { OR: [{ congressNationalId: congresEnCircuit }, { eventId: evtSansCircuit }] } })).toBe(1);
  });

  // ── LA VALIDATION : UN SEUL TEMPS, LA DIRECTION MARKETING ────────────────────────────────

  it("UN SEUL TEMPS : soumis, le poste va DROIT à la Direction Marketing — la Direction des opérations ne le tranche pas ; l'accord sans budget est refusé", async () => {
    const id = await nouveauPoste("kam", "CONGRESS_NATIONAL", congres, "Affiches", 120_000);
    await comme("kam");
    const s = await submitAdProItem(undefined, fd({ id }));
    ok(s);
    expect(s.message).toBe("Poste soumis — en attente de la Direction Marketing (montant et budget).");
    const soumis = await poste(id);
    expect(soumis.status).toBe("PENDING");
    expect(soumis.opsDecidedAt, "l'ancien premier temps est franchi d'office à la soumission").not.toBeNull();
    expect(soumis.opsDecidedById, "personne ne l'a tranché : c'est la règle qui le franchit").toBeNull();
    expect(soumis.opsDecisionNote ?? "").toMatch(/^Demande prévalidée/);
    const cle = `poste-${id}`;
    expect((await file("dm")).some((i) => i.key === cle), "la Direction Marketing voit le poste à décider").toBe(true);
    expect((await file("ops")).some((i) => i.key === cle), "la Direction des opérations n'a rien à faire").toBe(false);

    // La Direction des opérations ne tranche plus un poste — ni accord, ni refus.
    await comme("ops");
    for (const decision of ["APPROVED", "REJECTED"]) {
      const r = await decideAdProItem(undefined, fd({ id, decision, note: "x", amountGranted: "120000", budgetCategoryId: catId }));
      expect(r.ok === false ? r.error : "tranché", decision).toBe("Ce poste attend la décision de la Direction Marketing (montant et budget).");
    }
    expect((await poste(id)).status, "rien n'est écrit sur un refus").toBe("PENDING");

    await comme("dm");
    const sansBudget = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "110000" }));
    expect(sansBudget.ok === false ? sansBudget.error : "accordé").toMatch(/Choisissez le budget/);
    expect((await poste(id)).status).toBe("PENDING");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "110000", budgetCategoryId: catId })));
    const accorde = await poste(id);
    expect(accorde.status).toBe("APPROVED");
    expect(Number(accorde.amountGranted)).toBe(110_000);
    expect(accorde.budgetCategoryId, "le budget est fixé AVEC l'accord").toBe(catId);
    expect((await file("dm")).some((i) => i.key === cle), "décidé : il quitte la file").toBe(false);
  });

  it("UNE DEMANDE DE LA DIRECTION MARKETING : sa déposante n'accepte pas ses postes — une AUTRE personne de la Direction Marketing, oui ; la Direction des opérations, jamais", async () => {
    const id = await nouveauPoste("dm", "EVENT", evtDm, "Salle", 300_000, "VENUE");
    await comme("dm");
    ok(await submitAdProItem(undefined, fd({ id })));
    const cle = `poste-${id}`;
    // On n'accepte pas les postes de sa propre demande — par la PERSONNE (audit Ad & Pro, 14/10).
    const soiMeme = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "280000", budgetCategoryId: catId }));
    expect(soiMeme.ok === false ? soiMeme.error : "accordé", "la Direction Marketing n'accepte pas les postes de sa propre demande")
      .toBe("Ce poste attend la décision de la Direction Marketing (montant et budget).");
    expect((await file("dm")).some((i) => i.key === cle), "pas dans la file de sa déposante").toBe(false);
    // L'ancienne règle donnait ce poste à la Direction des opérations : plus maintenant.
    await comme("ops");
    expect((await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "280000", budgetCategoryId: catId }))).ok,
      "la Direction des opérations ne tranche plus les postes d'une demande de la Direction Marketing").toBe(false);
    expect((await file("ops")).some((i) => i.key === cle)).toBe(false);
    expect((await poste(id)).status).toBe("PENDING");
    // Le TÉMOIN : une autre personne de la Direction Marketing l'a dans sa file, et l'accepte.
    expect((await file("dm2")).some((i) => i.key === cle), "dans la file d'une AUTRE personne de la Direction Marketing").toBe(true);
    await comme("dm2");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "280000", budgetCategoryId: catId })));
    const p = await poste(id);
    expect(p.status).toBe("APPROVED");
    expect(Number(p.amountGranted)).toBe(280_000);
    expect(p.decidedById, "c'est la seconde personne de la Direction Marketing qui a tranché").toBe(u.dm2);
  });

  it("UNE DEMANDE DE LA DIRECTION DES OPÉRATIONS : même chemin — soumise, droit à la Direction Marketing, tracé", async () => {
    const id = await nouveauPoste("ops", "EVENT", evtOps, "Traiteur", 90_000, "CATERING");
    await comme("ops");
    const s = await submitAdProItem(undefined, fd({ id }));
    ok(s);
    expect(s.message).toMatch(/en attente de la Direction Marketing/);
    const p = await poste(id);
    expect(p.opsDecidedAt, "franchi d'office").not.toBeNull();
    expect(p.opsDecisionNote ?? "").toMatch(/^Demande prévalidée/);
    // La Direction des opérations ne tranche pas le poste de sa propre demande — ni d'aucune autre.
    const encore = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(encore.ok, "la Direction des opérations ne tranche pas un poste").toBe(false);
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", budgetCategoryId: catId })));
    expect((await poste(id)).status).toBe("APPROVED");
  });

  it("UN POSTE RESTÉ EN ATTENTE DU « PREMIER TEMPS » sous l'ancienne règle passe directement à la Direction Marketing", async () => {
    // DÉCOR, nommé : un poste soumis avant le 27/10/2026, jamais vu par la Direction des opérations.
    const herite = await prisma.adProItem.create({
      data: {
        congressNationalId: congres, kind: "PRINTING", label: `${TAG}Soumis d'avant`, amountEstimated: 70_000, status: "PENDING",
        submittedAt: new Date(), opsDecidedAt: null, supplier: "Imprimerie Alpha", createdById: u.kam, updatedById: u.kam,
      },
    });
    expect((await file("dm")).some((i) => i.key === `poste-${herite.id}`), "dans la file de la Direction Marketing").toBe(true);
    expect((await file("ops")).some((i) => i.key === `poste-${herite.id}`), "plus dans celle des opérations").toBe(false);
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id: herite.id, decision: "APPROVED", amountGranted: "70000", budgetCategoryId: catId })));
    expect((await poste(herite.id)).status).toBe("APPROVED");
  });

  /**
   * DÉFAUT RÉPARÉ (§118.204, `decideAdProItem`) : sur un poste qui n'est pas `PENDING`,
   * `tempsEnAttente` rend `null` et l'action le traitait comme « revoir une décision prise » — la
   * Direction Marketing seule. Un BROUILLON jamais soumis s'accordait donc directement.
   */
  it("un BROUILLON ne s'accorde pas : jamais soumis, il n'est chez personne", async () => {
    const id = await nouveauPoste("kam", "CONGRESS_NATIONAL", congres, "Brouillon accordé", 80_000);
    await comme("dm");
    const r = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(r.ok, "la Direction Marketing accorde un poste que personne n'a soumis").toBe(false);
    expect((await poste(id)).status).toBe("DRAFT");
  });

  /** UN REFUS DE LA DIRECTION MARKETING se revoit par ELLE (un seul temps) — jamais par la Direction des opérations. */
  it("un poste REFUSÉ par la Direction Marketing se revoit par elle — la Direction des opérations ne le ré-accorde pas", async () => {
    const id = await nouveauPoste("kam", "CONGRESS_NATIONAL", congres, "Refus marketing", 80_000);
    await comme("kam");
    ok(await submitAdProItem(undefined, fd({ id })));
    await comme("dm");
    const sansMotif = await decideAdProItem(undefined, fd({ id, decision: "REJECTED" }));
    expect(sansMotif.ok === false ? sansMotif.error : "refusé").toMatch(/Indiquez le motif/);
    ok(await decideAdProItem(undefined, fd({ id, decision: "REJECTED", note: "Hors priorités." })));
    expect((await poste(id)).status).toBe("REJECTED");
    await comme("ops");
    const r = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(r.ok === false ? r.error : "accordé", "la Direction des opérations passe outre le refus").toBe("Seule la Direction Marketing (montant et budget) revoit la décision d'un poste.");
    expect((await poste(id)).status).toBe("REJECTED");
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: "80000", budgetCategoryId: catId })));
    expect((await poste(id)).status, "la Direction Marketing revoit sa propre décision").toBe("APPROVED");
  });

  // ── LE BON DE COMMANDE, PAR L'ASSISTANTE ─────────────────────────────────────────────────

  it("DEMANDER LE BC : UNE seule assistante active → choisie d'office ; DEUX → le choix est exigé ; AUCUNE → refusé, rien n'est écrit", async () => {
    const a = await posteAccorde("BC une", 100_000);
    const b = await posteAccorde("BC deux", 100_000);
    const c = await posteAccorde("BC aucune", 100_000);
    try {
      ASSISTANTES = [u.ast1, u.ast2];
      await comme("kam");
      const sansChoix = await requestAdProItemOrder(undefined, fd({ id: b, note: "x" }));
      expect(sansChoix.ok === false ? sansChoix.error : "demandé").toBe("Choisissez l'assistante de direction qui établira le bon de commande.");
      expect((await poste(b)).orderStage, "un refus ne laisse pas un poste « demandé » sans assistante").toBe("NONE");
      expect(await demandeBC(b)).toBeNull();
      const etrangere = await requestAdProItemOrder(undefined, fd({ id: b, note: "x", assistantId: u.ops }));
      expect(etrangere.ok === false ? etrangere.error : "demandé").toMatch(/n'est pas une assistante de direction active/);
      ok(await requestAdProItemOrder(undefined, fd({ id: b, note: "Réf. DV-2", assistantId: u.ast2 })));
      expect((await demandeBC(b))?.askedToId).toBe(u.ast2);

      ASSISTANTES = [u.ast1];
      ok(await requestAdProItemOrder(undefined, fd({ id: a, note: "Réf. DV-1" })));
      const dr = await demandeBC(a);
      expect(dr?.askedToId, "la seule assistante active, sans qu'on ait à la nommer").toBe(u.ast1);
      expect(dr?.askedById).toBe(u.kam);
      expect(dr?.status).toBe("PENDING");
      expect(dr?.note ?? "").toMatch(/^Réf\. DV-1/);
      expect((await poste(a)).bcAssistantId).toBe(u.ast1);
      // Prévenue — par le lien causal (sa demande de pièce).
      expect(await prisma.notification.count({ where: { userId: u.ast1, link: `/pieces/${dr!.id}` } })).toBe(1);

      ASSISTANTES = [];
      const aucune = await requestAdProItemOrder(undefined, fd({ id: c, note: "x" }));
      expect(aucune.ok === false ? aucune.error : "demandé").toMatch(/^Aucune assistante de direction active/);
      expect((await poste(c)).orderStage).toBe("NONE");
    } finally {
      ASSISTANTES = null;
    }
  });

  it("UN SPONSORING DIRECT n'a pas de bon de commande — le refus nomme la proforma / lettre, pas la facture", async () => {
    const id = await posteAccorde("Aide directe sans BC", 200_000, { parent: "SPONSORING", parentId: spo, kind: "ASSOCIATION_SUPPORT" });
    await comme("kam");
    const r = await requestAdProItemOrder(undefined, fd({ id, note: "x", assistantId: u.ast1 }));
    expect(r.ok === false ? r.error : "demandé").toMatch(/sponsoring direct n'a pas de bon de commande : joignez la proforma \/ lettre de demande de sponsoring/);
    expect(r.ok === false ? r.error : "", "la facture n'est plus exigée").toMatch(/la facture n'est pas exigée/);
    expect(await demandeBC(id)).toBeNull();
  });

  it("UNE DEMANDE D'AVANT (poste visé, sans demande de pièce) se RENVOIE par le même geste — sans toucher au visa", async () => {
    // DÉCOR, nommé : un poste dont le BC avait été demandé au secrétariat avant §118.204, et visé.
    const id = await posteAccorde("Avant la règle", 600_000);
    await prisma.adProItem.update({ where: { id }, data: { orderStage: "DIRECTION_OK", orderRequestedAt: new Date(), orderRequestedById: u.kam, orderVisaAmount: 600_000, orderVisaSupplier: "Imprimerie Alpha", orderDirectionAt: new Date(), orderDirectionById: u.gm } });
    // L'ANCIENNE DEMANDE AU BUREAU DU SECRÉTARIAT (constat 21) — telle que l'écrivait le circuit d'avant.
    const ancienne = await prisma.administrativeRequest.create({
      data: {
        reference: `${RUN.slice(-12)}-BCA`, type: "OTHER", title: `${TITRE_BC_A_ETABLIR} — ${TAG}Avant la règle`, priority: "HIGH",
        status: "IN_PROGRESS", requesterId: u.kam, linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id,
      },
      select: { id: true },
    });
    // Témoin : une demande au secrétariat d'une AUTRE nature (un devis) du même poste reste ouverte.
    const devis = await prisma.administrativeRequest.create({
      data: {
        reference: `${RUN.slice(-12)}-DEV`, type: "QUOTE", title: `${TAG}Devis — Avant la règle`, priority: "HIGH",
        status: "NEW", requesterId: u.kam, linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id,
      },
      select: { id: true },
    });
    await comme("kam");
    const r = await requestAdProItemOrder(undefined, fd({ id, assistantId: u.ast1 }));
    ok(r);
    expect(r.message ?? "").toMatch(/ancienne demande « Bon de commande à établir » au secrétariat est close/);
    expect((await demandeBC(id))?.askedToId).toBe(u.ast1);
    const a = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: ancienne.id }, select: { status: true } });
    expect(a.status, "l'ancienne demande se clôt : la demande de pièce la remplace").toBe("CANCELLED");
    expect(await prisma.comment.count({ where: { entityType: "ADMIN_REQUEST", entityId: ancienne.id, body: { contains: "au profit de la demande de pièce" } } }), "la trace dit par quoi elle est remplacée").toBe(1);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: devis.id }, select: { status: true } })).status, "le devis n'est pas un BC : il reste").toBe("NEW");
    const p = await poste(id);
    expect(p.orderStage, "le visa tient").toBe("DIRECTION_OK");
    expect(Number(p.orderVisaAmount)).toBe(600_000);
    // Et pas deux demandes pour la même pièce.
    const encore = await requestAdProItemOrder(undefined, fd({ id, assistantId: u.ast2 }));
    expect(encore.ok === false ? encore.error : "demandé").toMatch(/déjà chez/);
  });

  it("LE BC DÉPOSÉ ET ACCEPTÉ revient SUR le poste, au montant et au prestataire accordés, et arrive dans la file de signature des Finances après le visa", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Brochures", 600_000);
    // Un devis UNIQUE d'abord : le BC qui naît s'y chaîne (« fait suite à »).
    await comme("kam");
    const devis = await ajouterDevisPoste(undefined, avecFichier({ id, montant: "600000", reference: `${TAG}DV-9` }));
    ok(devis);
    await comme("kam");
    ok(await requestAdProItemOrder(undefined, fd({ id, note: "2 000 brochures", assistantId: u.ast1 })));
    expect((await poste(id)).orderStage, "au-dessus du seuil : au centre").toBe("REQUESTED");
    // Seule l'assistante désignée dépose.
    const dr = (await demandeBC(id))!;
    await comme("ast2");
    expect((await submitDocumentRequest(fd({ id: dr.id }))).ok, "une autre assistante ne dépose pas").toBe(false);

    const bc = await bcEtabli(id);
    const piece = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc } });
    expect(piece.kind).toBe("PURCHASE_ORDER");
    expect(Number(piece.amount), "le montant ACCORDÉ, recopié — rien de deviné").toBe(600_000);
    expect(piece.counterparty).toBe("Imprimerie Alpha");
    expect(piece.chainFromId, "il fait suite au devis du poste").toBe(devis.id);
    expect(await prisma.legalDocumentReader.count({ where: { documentId: bc } }), "PAS restreint : les Finances doivent pouvoir le signer").toBe(0);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: bc } }), "le fichier a déménagé sur la pièce").toBe(1);
    // Une fois un BC né du devis, le devis ne se retire plus du poste : la chaîne ne se défait pas d'ici.
    await comme("kam");
    const retrait = await retirerDevisDuPoste(undefined, fd({ id, pieceId: devis.id! }));
    expect(retrait.ok === false ? retrait.error : "retiré").toMatch(/découle de ce devis/);

    // Au-dessus du seuil, le centre doit viser AVANT que le BC soit à signer.
    expect((await etatDuBC(bc))?.etape).toBe("A_VALIDER");
    const fin = await acteur(u.fin, "FINANCE_BUDGET_MANAGER");
    const avant = await fileBonsDeCommande(fin);
    expect(avant?.aSigner.some((l) => l.id === bc), "pas à signer avant le visa").toBe(false);
    await comme("gm");
    ok(await approveAdProItemOrder(undefined, fd({ id, decision: "APPROVE", montantVu: "600000", prestataireVu: "Imprimerie Alpha" })));
    expect((await etatDuBC(bc))?.etape).toBe("A_SIGNER");
    const apres = await fileBonsDeCommande(fin);
    expect(apres, "les Finances ont une file").not.toBeNull();
    if (!apres!.tronquee) expect(apres!.aSigner.some((l) => l.id === bc), "le BC est dans la file de signature des Finances").toBe(true);
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: bc }))));
    expect((await etatDuBC(bc))?.etape).toBe("SIGNE");
  });

  // ── LA PORTE DU DG SUR LE TOTAL DE LA DEMANDE (27/10/2026) ─────────────────────────────────

  it("LA PORTE DU DG : total au-dessus du seuil ⇒ ni BC ni paiement tant que le DG ne l'a pas validé ; une rallonge la referme", async () => {
    SEUIL_DG = 500_000;
    try {
      // Les montants s'écrivent à la française (espace fine insécable) : les phrases se lisent avec `\s`.
      const a = await posteAccorde("Stand Annaba", 600_000, { parentId: congresDg });
      expect((await lirePorteDg("CONGRESS_NATIONAL", congresDg)).etat, "600 000 > 500 000 : la porte est fermée").toBe("EN_ATTENTE");
      await comme("kam");
      const bcFerme = await requestAdProItemOrder(undefined, fd({ id: a, note: "x", assistantId: u.ast1 }));
      expect(bcFerme.ok === false ? bcFerme.error : "demandé").toMatch(/^Total de 600\s000 DZD au-dessus du seuil de 500\s000 DZD : la validation du Directeur Général est requise/);
      expect(bcFerme.ok === false ? bcFerme.error : "").toMatch(/Aucun bon de commande, engagement ni paiement n'est possible d'ici là\.$/);
      expect((await poste(a)).orderStage, "un refus ne prend pas la marche").toBe("NONE");
      expect(await demandeBC(a), "aucune demande partie chez l'assistante").toBeNull();
      const payeFerme = await payer(a, "600000");
      expect(payeFerme.ok === false ? payeFerme.error : "payé").toMatch(/validation du Directeur Général est requise/);
      // LE DG A ÉTÉ PRÉVENU — une fois, par le lien de la demande.
      expect(await prisma.notification.count({ where: { userId: u.gm, title: { contains: "total à valider" }, link: { contains: congresDg } } })).toBe(1);

      // Ni le demandeur ni la Direction Marketing ne statuent sur le total.
      for (const k of ["kam", "dm"] as const) {
        const r = await statuerSurLeTotal({ user: { id: u[k], role: ROLES[k] }, parent: "CONGRESS_NATIONAL", parentId: congresDg, decision: "VALIDEE", totalVu: 600_000, note: null });
        expect(r.ok === false ? r.error : "validé", k).toMatch(/^Seul le Directeur Général/);
      }
      const gm = { id: u.gm, name: `${TAG}gm`, role: ROLES.gm };
      ok(await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congresDg, decision: "VALIDEE", totalVu: 600_000, note: null }));
      expect((await lirePorteDg("CONGRESS_NATIONAL", congresDg)).etat).toBe("VALIDEE");
      await comme("kam");
      ok(await requestAdProItemOrder(undefined, fd({ id: a, note: "Stand 18 m²", assistantId: u.ast1 })));
      expect((await demandeBC(a))?.askedToId).toBe(u.ast1);

      // UNE RALLONGE ROUVRE LA PORTE : un second poste porte le total à 700 000, au-delà des 600 000 validés.
      const b = await posteAccorde("Hôtesses Annaba", 100_000, { parentId: congresDg });
      const porte = await lirePorteDg("CONGRESS_NATIONAL", congresDg);
      expect(porte.etat).toBe("EN_ATTENTE");
      expect(porte.phrase ?? "").toMatch(/au-delà des 600\s000 DZD validés par le Directeur Général/);
      await comme("kam");
      const bcB = await requestAdProItemOrder(undefined, fd({ id: b, note: "x", assistantId: u.ast1 }));
      expect(bcB.ok === false ? bcB.error : "demandé").toMatch(/de nouveau requise/);
      // Le DG statue sur le total LU : un total qu'il n'a pas vu ne se valide pas.
      const perime = await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congresDg, decision: "VALIDEE", totalVu: 600_000, note: null });
      expect(perime.ok === false ? perime.error : "validé").toMatch(/^Le total vient de changer/);
      ok(await statuerSurLeTotal({ user: gm, parent: "CONGRESS_NATIONAL", parentId: congresDg, decision: "VALIDEE", totalVu: 700_000, note: null }));
      await comme("kam");
      ok(await requestAdProItemOrder(undefined, fd({ id: b, note: "x", assistantId: u.ast1 })));
    } finally {
      SEUIL_DG = SEUIL_DG_HORS_ATTEINTE;
    }
  });

  // ── LES DEVIS ─────────────────────────────────────────────────────────────────────────────

  it("UN DEVIS COMMUN À DEUX POSTES : une pièce au registre, deux liens — et jamais d'une autre demande", async () => {
    const p1 = await nouveauPoste("kam", "CONGRESS_NATIONAL", congres, "Hôtellerie", 300_000, "ACCOMMODATION");
    const p2 = await nouveauPoste("kam", "CONGRESS_NATIONAL", congres, "Dîner", 150_000, "DINNER");
    const ailleurs = await nouveauPoste("kam2", "CONGRESS_NATIONAL", congres2, "Hôtellerie autre", 300_000, "ACCOMMODATION");
    await comme("kam");
    const sansPiece = await ajouterDevisPoste(undefined, fd({ id: p1, autresPostes: p2, montant: "450000" }));
    expect(sansPiece.ok === false ? sansPiece.error : "déposé").toMatch(/Joignez le devis/);
    const melange = new FormData();
    melange.set("id", p1); melange.append("autresPostes", ailleurs); melange.append("attachment", pdf(`${TAG}devis.pdf`));
    const croise = await ajouterDevisPoste(undefined, melange);
    expect(croise.ok, "un devis ne couvre pas le poste d'une autre demande").toBe(false);

    const f = new FormData();
    f.set("id", p1); f.append("autresPostes", p2); f.set("montant", "450000"); f.set("proforma", "on"); f.append("attachment", pdf(`${TAG}devis.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    ok(r);
    expect(r.message).toMatch(/commun à 2 postes/);
    const liens = await prisma.adProItemPiece.findMany({ where: { legalDocumentId: r.id! }, select: { itemId: true, nature: true } });
    expect(liens.map((l) => l.itemId).sort()).toEqual([p1, p2].sort());
    expect(liens.every((l) => l.nature === "DEVIS")).toBe(true);
    const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } });
    expect(doc.kind).toBe("QUOTE");
    expect(doc.title).toMatch(/^Facture pro forma/);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } })).toBe(1);

    // RETIRER : le lien part ; tant que la pièce couvre un autre poste, elle vit ; sinon elle s'annule.
    ok(await retirerDevisDuPoste(undefined, fd({ id: p1, pieceId: r.id! })));
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).status, "elle couvre encore le dîner").not.toBe("CANCELLED");
    const fin = await retirerDevisDuPoste(undefined, fd({ id: p2, pieceId: r.id! }));
    ok(fin);
    expect(fin.message).toMatch(/annulé/);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).status).toBe("CANCELLED");
    expect(await prisma.adProItemPiece.count({ where: { legalDocumentId: r.id! } })).toBe(0);
    const pasLa = await retirerDevisDuPoste(undefined, fd({ id: p1, pieceId: r.id! }));
    expect(pasLa.ok === false ? pasLa.error : "retiré").toMatch(/n'est pas rattaché/);
  });

  // ── LE PAIEMENT, SUR FACTURE ─────────────────────────────────────────────────────────────

  it("DEMANDER LE PAIEMENT : refusé sans BC, avant la signature, sans facture, au-delà de l'accordé — accepté ensuite, au centre, facture rattachée et vue par la règle", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Kakémonos", 200_000);
    const sansBC = await payer(id, "200000");
    expect(sansBC.ok === false ? sansBC.error : "payé").toMatch(/pas encore établi/);
    await comme("kam");
    ok(await requestAdProItemOrder(undefined, fd({ id, note: "x", assistantId: u.ast1 })));
    const bc = await bcEtabli(id);
    expect((await etatDuBC(bc))?.etape, "sous le seuil : directement à signer").toBe("A_SIGNER");
    const avantSignature = await payer(id, "200000");
    expect(avantSignature.ok === false ? avantSignature.error : "payé").toMatch(/pas encore signé par les Finances/);
    await comme("fin");
    ok(await signerBonDeCommande(avecCopieSignee(fd({ id: bc }))));

    const sansFacture = await payer(id, "200000", "kam", false);
    expect(sansFacture.ok === false ? sansFacture.error : "payé").toMatch(/Joignez la facture/);
    const trop = await payer(id, "200001");
    expect(trop.ok === false ? trop.error : "payé").toMatch(/dépasse le montant accordé/);
    await comme("kam");
    const sansMontant = await demanderPaiementPoste(undefined, avecFichier({ id }));
    expect(sansMontant.ok === false ? sansMontant.error : "payé").toMatch(/Indiquez le montant de la facture/);
    expect((await poste(id)).expenseOrderId, "aucun refus n'a laissé d'ordre").toBeNull();
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "FACTURE" } }), "ni de facture").toBe(0);

    const r = await payer(id, "190000");
    ok(r);
    const p = await poste(id);
    expect(p.expenseOrderId).toBe(r.id);
    expect(p.orderStage).toBe("ISSUED");
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } });
    expect(Number(ordre.amount)).toBe(190_000);
    expect(ordre.centralStatus, "au centre de paiement, jamais payable d'office").toBe("AWAITING");
    expect(ordre.budgetCategoryId, "imputé au budget choisi par la Direction Marketing").toBe(catId);
    const lien = await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: id, nature: "FACTURE" } });
    const facture = await prisma.legalDocument.findUniqueOrThrow({ where: { id: lien.legalDocumentId } });
    expect(facture.kind).toBe("INVOICE");
    expect(facture.direction).toBe("OUT");
    expect(facture.sourceType).toBe("CONGRESS_NATIONAL");
    expect(facture.sourceId).toBe(congres);
    expect(facture.chainFromId, "la facture fait suite au BC signé").toBe(bc);
    expect(facture.expenseOrderId).toBe(r.id);
    expect(Number(facture.amount)).toBe(190_000);
    // LA RÈGLE « FACTURE OBLIGATOIRE » (lot D) voit cette facture : le règlement ne la redemandera pas.
    expect(await ordreAFacture({ id: ordre.id, sourceType: ordre.sourceType, sourceId: ordre.sourceId })).toBe(true);
    const encore = await payer(id, "1000");
    expect(encore.ok === false ? encore.error : "payé").toMatch(/déjà été demandé/);
  });

  /**
   * SPONSORING DIRECT : LA PIÈCE EXIGÉE EST LA PROFORMA / LETTRE DE DEMANDE, PAS LA FACTURE (Direction, 05/10).
   * L'ordre naît avec `requiresInvoice: false` — c'est lui que lisent le règlement, la colonne « Facture »
   * des Finances et le signal « justificatif manquant » : une seule valeur, trois lecteurs qui suivent.
   */
  it("UN SPONSORING DIRECT se paie sur PROFORMA / LETTRE, SANS bon de commande ni facture exigée", async () => {
    const id = await posteAccorde("Aide à l'association", 250_000, { parent: "SPONSORING", parentId: spo, kind: "ASSOCIATION_SUPPORT" });
    await comme("kam");
    const sans = await payer(id, "250000", "kam", false);
    expect(sans.ok === false ? sans.error : "payé", "sans pièce, le refus nomme la proforma / lettre").toMatch(/Joignez la proforma \/ lettre de demande de sponsoring/);
    expect(await prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { orderStage: true } }).then((p) => p.orderStage), "un refus ne prend rien").not.toBe("ISSUED");
    const r = await payer(id, "250000");
    ok(r);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "BON_DE_COMMANDE" } }), "aucun BC").toBe(0);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "FACTURE" } }), "aucune facture créée : elle n'est pas exigée").toBe(0);
    const lien = await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: id, nature: "DEVIS" } });
    const proforma = await prisma.legalDocument.findUniqueOrThrow({ where: { id: lien.legalDocumentId } });
    expect(proforma.kind, "la proforma est un DEVIS au registre").toBe("QUOTE");
    expect(proforma.title).toMatch(/^Proforma \/ lettre de demande de sponsoring/);
    expect(proforma.sourceType).toBe("SPONSORING");
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } });
    expect(ordre.centralStatus).toBe("AWAITING");
    expect(ordre.requiresInvoice, "LA valeur que lisent le règlement, la colonne et le signal").toBe(false);
    expect(await ordreAFacture({ id: ordre.id, sourceType: ordre.sourceType, sourceId: ordre.sourceId }), "PRÉMISSE : aucune facture n'existe").toBe(false);
  });

  /**
   * LES TROIS LECTEURS DE LA RÈGLE « FACTURE OBLIGATOIRE » SUIVENT UN SEUL DRAPEAU (§118.61, Direction 05/10).
   * Le règlement, la colonne « Facture » des Finances et le signal « justificatif manquant » lisent
   * `ExpenseOrder.requiresInvoice` : le poser à faux à la naissance de l'ordre d'un sponsoring direct suffit
   * à les faire suivre. Le TÉMOIN est le même ordre, drapeau remis à vrai — l'ancienne règle : le
   * règlement refuse, le signal sort. Sans lui, trois lecteurs qui ne liraient plus rien passeraient.
   */
  it("SPONSORING DIRECT : le règlement et le signal « justificatif manquant » suivent `requiresInvoice` — témoin : l'ancienne règle les rallume", async () => {
    const id = await posteAccorde("Aide directe, trois lecteurs", 150_000, { parent: "SPONSORING", parentId: spo, kind: "ASSOCIATION_SUPPORT" });
    const r = await payer(id, "150000");
    ok(r);
    await prisma.expenseOrder.update({ where: { id: r.id! }, data: { centralStatus: "APPROVED" } });
    const finances = await acteur(u.fin, ROLES.fin);
    const signal = async () => (await signauxFinance(finances, { horizonJours: 30 })).signaux.find((x) => x.code === "justificatif_manquant" && x.entite?.id === r.id);
    expect(await signal(), "aucun signal : la facture n'est pas exigée").toBeUndefined();

    // Le TÉMOIN : l'ancienne règle sur le même ordre.
    await prisma.expenseOrder.update({ where: { id: r.id! }, data: { requiresInvoice: true } });
    expect(await signal(), "PRÉMISSE — drapeau levé, le signal sort").toBeDefined();
    await comme("fin");
    const refus = await settleExpenseOrder(fd({ id: r.id! }));
    expect(refus.ok === false ? refus.error : "réglé", "PRÉMISSE — drapeau levé, le règlement refuse la facture manquante").toMatch(/facture/i);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } })).status).toBe("PENDING");

    // La règle du jour : drapeau baissé, le règlement passe sans facture.
    await prisma.expenseOrder.update({ where: { id: r.id! }, data: { requiresInvoice: false } });
    const regle = await settleExpenseOrder(fd({ id: r.id! }));
    expect(regle.ok, regle.ok === false ? regle.error : "").toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } })).status).toBe("PAID");
  });

  it("UN SPONSORING DIRECT dont la proforma est DÉJÀ sur le poste se paie sans rien joindre — et la facture facultative se chaîne à elle", async () => {
    const id = await posteAccorde("Aide à l'association 2", 250_000, { parent: "SPONSORING", parentId: spo, kind: "ASSOCIATION_SUPPORT" });
    await comme("kam");
    const pro = await ajouterDevisPoste(undefined, avecFichier({ id, montant: "250000", proforma: "on" }));
    ok(pro);
    const f = fd({ id, montant: "250000", reference: `${TAG}FA` });
    f.append("facture", pdf(`${TAG}facture-facultative.pdf`));
    const r = await demanderPaiementPoste(undefined, f);
    ok(r);
    const lien = await prisma.adProItemPiece.findFirstOrThrow({ where: { itemId: id, nature: "FACTURE" } });
    const facture = await prisma.legalDocument.findUniqueOrThrow({ where: { id: lien.legalDocumentId } });
    expect(facture.chainFromId, "la facture facultative suit la proforma, seule pièce amont").toBe(pro.id);
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } });
    expect(ordre.requiresInvoice, "facultative, même quand elle est là").toBe(false);
  });

  it("UNE PROFORMA ANNULÉE ne compte pas : le sponsoring direct redemande la pièce", async () => {
    const id = await posteAccorde("Aide à l'association 3", 250_000, { parent: "SPONSORING", parentId: spo, kind: "ASSOCIATION_SUPPORT" });
    await comme("kam");
    const pro = await ajouterDevisPoste(undefined, avecFichier({ id, montant: "250000", proforma: "on" }));
    ok(pro);
    await prisma.legalDocument.update({ where: { id: pro.id! }, data: { status: "CANCELLED" } });
    const sans = await payer(id, "250000", "kam", false);
    expect(sans.ok === false ? sans.error : "payé", "la proforma annulée n'est pas une pièce").toMatch(/Joignez la proforma \/ lettre de demande de sponsoring/);
    // Le TÉMOIN : rétablie, la même demande passe sans rien joindre.
    await prisma.legalDocument.update({ where: { id: pro.id! }, data: { status: "ACTIVE" } });
    ok(await payer(id, "250000", "kam", false));
  });

  it("UN SPONSORING INDIRECT GARDE LA RÈGLE D'AVANT — facture obligatoire, `requiresInvoice` vrai", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Indirect facture", 100_000);
    await comme("kam");
    ok(await requestAdProItemOrder(undefined, fd({ id, note: "x", assistantId: u.ast1 })));
    await bcSigne(id);
    const sans = await payer(id, "100000", "kam", false);
    expect(sans.ok === false ? sans.error : "payé").toMatch(/Joignez la facture : elle est obligatoire/);
    const r = await payer(id, "100000");
    ok(r);
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } });
    expect(ordre.requiresInvoice).toBe(true);
    expect(await ordreAFacture({ id: ordre.id, sourceType: ordre.sourceType, sourceId: ordre.sourceId })).toBe(true);
  });

  it("DEUX DEMANDES DE PAIEMENT SIMULTANÉES : un seul ordre, une seule facture", async () => {
    SEUIL = 500_000;
    const id = await posteAccorde("Goodies", 100_000);
    await comme("kam");
    ok(await requestAdProItemOrder(undefined, fd({ id, note: "x", assistantId: u.ast1 })));
    await bcSigne(id);
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const unePaie = () => demanderPaiementPoste(undefined, avecFichier({ id, montant: "100000", argumentation: "Écart connu et accepté (banc).", confirme: "1" }, `${TAG}facture.pdf`));
    // La facture se dépose AVANT la prise du poste (toutes les pièces jointes sont gardées — audit Ad & Pro, H-04) : le
    // second geste peut donc s'arrêter plus tôt, sur « a déjà sa facture », sans atteindre la barrière. On attend le
    // premier sur le verrou, puis on lâche : l'issue est la même — un seul ordre, une seule facture.
    const [a, b] = await sousBarriere(() => [unePaie(), unePaie()], 1);
    expect([a.ok, b.ok].filter(Boolean), JSON.stringify([a, b])).toHaveLength(1);
    expect(await prisma.expenseOrder.count({ where: { sourceId: congres, label: { contains: "Goodies" } } })).toBe(1);
    expect(await prisma.adProItemPiece.count({ where: { itemId: id, nature: "FACTURE" } })).toBe(1);
  });

  // ── QUI LIT LES PIÈCES D'UN POSTE ───────────────────────────────────────────────────────

  it("LE KAM SANS LEGAL lit les pièces de SON poste ; un autre délégué, non — la porte est celle de la fiche", async () => {
    const id = await posteAccorde("Lecture", 100_000);
    await comme("kam");
    const devis = await ajouterDevisPoste(undefined, avecFichier({ id, montant: "100000" }));
    ok(devis);
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    const kam2 = await acteur(u.kam2, "MEDICAL_DELEGATE");
    expect(userCan(kam2, "LEGAL", "VIEW"), "prémisse : le second délégué n'a pas Legal non plus").toBe(false);
    const lus = await accesAuxPiecesLegal(kam, [devis.id!], ["VIEW"]);
    expect(lus.get("VIEW")?.has(devis.id!), "le demandeur lit le devis qu'il a déposé sur son poste").toBe(true);
    const autre = await accesAuxPiecesLegal(kam2, [devis.id!], ["VIEW"]);
    expect(autre.get("VIEW")?.has(devis.id!), "un délégué qui ne voit pas la demande ne lit pas sa pièce").toBe(false);
  });
});
