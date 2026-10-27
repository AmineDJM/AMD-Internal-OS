import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/**
 * LE SEUIL DU DG EST UN RÉGLAGE GLOBAL : le banc l'INJECTE dans son propre processus — la base partagée garde le
 * sien, et ce banc ne dépend pas de sa valeur du jour (§118.132).
 */
const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import {
  createAdProOtherRequest, decideAdProOtherRequest, resoumettreAdProOtherRequest, closeAdProOtherRequest,
} from "@/lib/actions/ad-pro-other-actions";
import { advanceWorkflow, faireAppelAdPro } from "@/lib/actions/workflow-actions";
import { addAdProItem, submitAdProItem, decideAdProItem, requestAdProItemOrder } from "@/lib/actions/ad-pro-item-actions";
import { lirePorteDg, statuerSurLeTotal, totauxEnAttenteDuDg } from "@/lib/ad-pro/porte-dg";
import { ensureInstance } from "@/lib/workflow/engine";
import { statutAutreDepuisCircuit, ecritureAutreDepuisCircuit } from "@/lib/workflow/autre-statut";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__autrecircuit__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const DEBUT = new Date(Date.now() - 1_000);

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TRADUCTION DU MOTEUR — pure : ce que le moteur écrit, et ce que la demande « autre » en garde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("demande « autre » — la traduction des écritures du moteur (pure)", () => {
  it("tout statut « en circuit » devient « en cours de validation » ; l'accord, le refus, le renvoi ont chacun le leur", () => {
    for (const s of ["AWAITING_PRELIMINARY", "PRELIMINARY_APPROVED", "AWAITING_FINAL", "APPEAL_PENDING", "AWAITING_FINAL_APPEAL", "AWAITING_DECISION"]) {
      expect(statutAutreDepuisCircuit(s), s).toBe("AWAITING_DECISION");
    }
    for (const s of ["APPROVED", "VALIDATED", "PRE_VALIDATED"]) expect(statutAutreDepuisCircuit(s), s).toBe("APPROVED");
    for (const s of ["REJECTED", "REFUSED"]) expect(statutAutreDepuisCircuit(s), s).toBe("REFUSED");
    expect(statutAutreDepuisCircuit("RETURNED")).toBe("RETURNED");
    for (const s of ["DRAFT", "DONE", "CANCELLED"] as const) expect(statutAutreDepuisCircuit(s)).toBe(s);
    expect(statutAutreDepuisCircuit(null)).toBeNull();
  });

  it("la décision passe dans ses colonnes ; ce que la demande n'a pas est abandonné", () => {
    const quand = new Date("2026-10-27T10:00:00Z");
    // La branche terminale du moteur (natures non-sponsoring) : `requestStatus` + `status: VALIDATED`.
    expect(ecritureAutreDepuisCircuit({
      updatedById: "u1", requestStatus: "APPROVED", status: "VALIDATED", finalById: "dm", finalAt: quand, finalNote: "OK", finalAmount: 5,
      productManagerId: "x", expenseOrderId: "o",
    })).toEqual({ status: "APPROVED", decidedById: "dm", decidedAt: quand, decisionNote: "OK", updatedById: "u1" });
    // Le refus définitif : le motif vient de `rejectionReason`.
    expect(ecritureAutreDepuisCircuit({ requestStatus: "REJECTED", rejectionReason: "Hors stratégie", finalById: "dm", finalAt: quand, updatedById: "dm" }))
      .toEqual({ status: "REFUSED", decidedById: "dm", decidedAt: quand, decisionNote: "Hors stratégie", updatedById: "dm" });
    // Une étape intermédiaire : seul le statut (et l'auteur) — le référent et le budget proposé tombent.
    expect(ecritureAutreDepuisCircuit({ updatedById: "ns", status: "PRELIMINARY_APPROVED", productManagerId: "pm", preliminaryAt: quand }))
      .toEqual({ status: "AWAITING_DECISION", updatedById: "ns" });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DEMANDE « AUTRE » SUIT LE CIRCUIT COMMUN — par les VRAIS points d'entrée (Direction, 27/10/2026, #17).
 *
 * « Les demandes autres suivent le même circuit » : la route du créateur jusqu'à la prévalidation de la
 * Direction Marketing (sans montant), aucun poste avant, des postes acceptés par la Direction Marketing,
 * le DG sur le TOTAL au-dessus du seuil, et le refus qui se conteste par l'appel. Chaque acteur est NOMMÉ
 * dans son cas (§118.151f) ; les juges comptent par LIEN CAUSAL — la notification mène à CETTE demande —,
 * jamais par un compte global de la base partagée (§118.92).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — la demande « autre » suit le circuit commun (27/10/2026)", () => {
  const ROLES = {
    kam: "MEDICAL_DELEGATE", ns: "NATIONAL_SALES", ops: "OPERATIONS_DIRECTOR", dm: "PRODUCT_MANAGER",
    gm: "GENERAL_MANAGER", dir: "DIRECTION",
  } as const;
  type Qui = keyof typeof ROLES;
  const u = {} as Record<Qui, string>;
  let catId = "";

  async function acteur(qui: Qui): Promise<CurrentUser> {
    const id = u[qui];
    const access = await getAccess(id, ROLES[qui] as SessionUser["role"]);
    const x = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: x.name, email: x.email, role: ROLES[qui] as SessionUser["role"], access, mustChangePassword: false };
  }
  const comme = async (qui: Qui) => { ACTOR = await acteur(qui); return ACTOR; };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
  const demande = (id: string) => prisma.adProOtherRequest.findUniqueOrThrow({ where: { id } });
  const instance = (id: string) => prisma.workflowInstance.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "AD_PRO_OTHER", entityId: id } } });
  const creer = async (qui: Qui, titre: string, montant = 300_000): Promise<string> => {
    await comme(qui);
    const r = await createAdProOtherRequest(undefined, fd({ title: `${RUN} ${titre}`, description: `Description — ${titre}`, amount: String(montant) }));
    ok(r);
    return r.id!;
  };
  const agir = async (qui: Qui, id: string, action: "APPROVE" | "REJECT" | "RETURN", note?: string) => {
    await comme(qui);
    return advanceWorkflow(fd({ entityType: "AD_PRO_OTHER", entityId: id, action, ...(note ? { note } : {}) }));
  };
  /** Les notifications reçues par `qui` qui mènent à CETTE demande. */
  const recues = (qui: Qui, id: string) =>
    prisma.notification.findMany({ where: { userId: u[qui], link: { contains: id }, createdAt: { gte: DEBUT } }, select: { title: true, type: true } });

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as Qui[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({
      data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" },
    })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    // LE DÉLÉGUÉ n'a pas le module « autres demandes » par sa matrice : le Super Admin le lui ouvre par un accès
    // personnalisé (la console). C'est ce qui rend sa route — National Sales d'abord — observable.
    await prisma.userAccess.create({
      data: { userId: u.kam, module: "AD_PRO_OTHER", canView: true, canCreate: true, canUpdate: true, canUpload: true, scope: "ALL" },
    });
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN}Enveloppe`, modules: ["AD_PRO_OTHER"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Autres`, allocated: 50_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const autres = (await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: RUN } }, select: { id: true } }).catch(() => [])).map((r) => r.id);
    const postes = (await prisma.adProItem.findMany({ where: { otherRequestId: { in: autres } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: autres } } }).catch(() => {});
    const instances = (await prisma.workflowInstance.findMany({ where: { entityType: "AD_PRO_OTHER", entityId: { in: autres } }, select: { id: true } }).catch(() => [])).map((i) => i.id);
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: { in: instances } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: instances } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { sourceType: "AD_PRO_OTHER", sourceId: { in: autres } } }).catch(() => {});
    // Les notifications de rôle partent à tous les porteurs de la base partagée : retirées par leur lien, bornées à ce run.
    for (const id of autres) await prisma.notification.deleteMany({ where: { link: { contains: id }, createdAt: { gte: DEBUT } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: autres } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...autres, ...postes] } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { id: { in: autres } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  let parKam = "";

  it("LA ROUTE DU DÉLÉGUÉ : National Sales → Directeur des opérations → Direction Marketing, qui PRÉVALIDE sans montant", async () => {
    parKam = await creer("kam", "Abonnement revue");
    let inst = await instance(parKam);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug, "il entre chez son National Sales").toBe("preliminary");
    expect(inst.skippedSlugs, "le DG n'est pas sur la route").toContain("dg");
    expect((await demande(parKam)).status).toBe("AWAITING_DECISION");
    // TOUS LES ACTEURS PRÉVENUS À LA CRÉATION (décision #1) : à vous d'agir pour l'étape, pour information ensuite.
    expect((await recues("ns", parKam)).some((n) => n.type === "VALIDATION_REQUIRED"), "le National Sales : à vous d'agir").toBe(true);
    for (const qui of ["ops", "dm"] as const) {
      expect((await recues(qui, parKam)).some((n) => n.type === "GENERIC" && /pour information/.test(n.title)), `${qui} : pour information`).toBe(true);
    }
    // Plus de visa du centre à la création (le DG valide le total des postes, pas le montant demandé).
    expect(await prisma.adProGateVisa.count({ where: { entityType: "AD_PRO_OTHER", entityId: parKam } })).toBe(0);

    // Hors de son étape, personne n'avance la demande.
    expect((await agir("dm", parKam, "APPROVE")).ok, "la Direction Marketing n'agit pas avant son tour").toBe(false);

    ok(await agir("ns", parKam, "APPROVE"));
    inst = await instance(parKam);
    expect(inst.currentSlug, "puis le Directeur des opérations").toBe("final");
    expect((await demande(parKam)).status).toBe("AWAITING_DECISION");
    expect((await recues("ops", parKam)).some((n) => n.type === "VALIDATION_REQUIRED"), "le Directeur des opérations : à vous d'agir").toBe(true);

    ok(await agir("ops", parKam, "APPROVE"));
    expect((await instance(parKam)).currentSlug, "puis la Direction Marketing").toBe("marketing");

    ok(await agir("dm", parKam, "APPROVE", "Prévalidée : abonnement utile."));
    inst = await instance(parKam);
    expect(inst.status).toBe("APPROVED");
    expect(inst.currentSlug).toBeNull();
    const d = await demande(parKam);
    expect(d.status, "« prévalidée »").toBe("APPROVED");
    expect(d.decidedById).toBe(u.dm);
    expect(d.decisionNote).toBe("Prévalidée : abonnement utile.");
    expect(Number(d.amount), "le montant DEMANDÉ ne bouge pas : aucun argent n'est accordé ici").toBe(300_000);
    expect(inst.amount, "aucun montant de travail n'est fixé par la prévalidation").toBeNull();
    expect(await prisma.expenseOrder.count({ where: { sourceType: "AD_PRO_OTHER", sourceId: parKam } }), "aucun ordre global").toBe(0);
    expect((await recues("kam", parKam)).some((n) => /prévalidée/.test(n.title)), "le demandeur l'apprend").toBe(true);
  }, 90_000);

  it("AUCUN POSTE AVANT LA PRÉVALIDATION ; après, un poste s'ajoute et la Direction Marketing l'accepte", async () => {
    const enCours = await creer("kam", "Location projecteur");
    await comme("kam");
    const avant = await addAdProItem(undefined, fd({ parent: "AD_PRO_OTHER", parentId: enCours, kind: "SERVICE", label: `${TAG}Projecteur`, amountEstimated: "50000" }));
    expect(avant.ok === false ? avant.error : "ajouté").toMatch(/^Les postes s'ajoutent après la prévalidation de la Direction Marketing/);
    expect(await prisma.adProItem.count({ where: { otherRequestId: enCours } })).toBe(0);

    // Prévalidée : le demandeur ajoute, soumet ; la Direction Marketing accepte (montant + budget) — un seul accord.
    const a = await addAdProItem(undefined, fd({ parent: "AD_PRO_OTHER", parentId: parKam, kind: "SERVICE", label: `${TAG}Abonnement`, amountEstimated: "400000", supplier: "Éditions Alpha" }));
    ok(a);
    ok(await submitAdProItem(undefined, fd({ id: a.id! })));
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: "400000", budgetCategoryId: catId })));
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: a.id! } });
    expect(poste.status).toBe("APPROVED");
    expect(Number(poste.amountGranted)).toBe(400_000);
    expect(poste.budgetCategoryId).toBe(catId);
    expect(poste.addedAfterDecision, "une demande prévalidée sans montant : ses postes ne sont pas « tardifs »").toBe(false);
  }, 90_000);

  it("LE DG SUR LE TOTAL : au-dessus du seuil, ni bon de commande — jusqu'à ce que le DG valide le total", async () => {
    await comme("kam");
    const b = await addAdProItem(undefined, fd({ parent: "AD_PRO_OTHER", parentId: parKam, kind: "PRINTING", label: `${TAG}Tirés à part`, amountEstimated: "700000", supplier: "Imprimerie Beta" }));
    ok(b);
    const p = await lirePorteDg("AD_PRO_OTHER", parKam);
    expect(p.total, "400 000 accordés + 700 000 estimés").toBe(1_100_000);
    expect(p.etat).toBe("EN_ATTENTE");
    expect((await totauxEnAttenteDuDg()).some((t) => t.entityType === "AD_PRO_OTHER" && t.entityId === parKam), "le centre de validation le liste").toBe(true);
    // Le DG est prévenu — une fois, par un lien vers la ligne de CETTE demande au centre.
    expect(await prisma.notification.count({
      where: { userId: u.gm, title: "Ad & Pro — total à valider (Directeur Général)", link: { contains: parKam }, createdAt: { gte: DEBUT } },
    })).toBe(1);

    const premier = (await prisma.adProItem.findFirstOrThrow({ where: { otherRequestId: parKam, status: "APPROVED" } })).id;
    await comme("kam");
    const bc = await requestAdProItemOrder(undefined, fd({ id: premier, note: "x" }));
    expect(bc.ok === false ? bc.error : "demandé").toBe(p.refus);

    ok(await statuerSurLeTotal({ user: { id: u.gm, name: `${TAG}gm`, role: "GENERAL_MANAGER" }, parent: "AD_PRO_OTHER", parentId: parKam, decision: "VALIDEE", totalVu: 1_100_000, note: null }));
    expect((await lirePorteDg("AD_PRO_OTHER", parKam)).etat).toBe("VALIDEE");
    // Au journal du circuit de la demande, à côté de ses étapes.
    const journal = await prisma.workflowStepEvent.findFirst({ where: { instance: { entityType: "AD_PRO_OTHER", entityId: parKam }, stepSlug: "dg-total" } });
    expect(journal?.action).toBe("APPROVE");
  }, 90_000);

  it("LA DIRECTION MARKETING : sa demande est prévalidée D'OFFICE, et le journal le dit", async () => {
    const id = await creer("dm", "Traduction d'une étude");
    const inst = await instance(id);
    expect(inst.status).toBe("APPROVED");
    expect((await demande(id)).status).toBe("APPROVED");
    const ligne = await prisma.workflowStepEvent.findFirst({ where: { instanceId: inst.id, action: "APPROVE" } });
    expect(ligne?.note).toMatch(/^Prévalidée d'office/);
    expect(ligne?.actorId).toBe(u.dm);
  }, 60_000);

  it("REFUS DÉFINITIF puis APPEL : la Direction Marketing refuse, le demandeur fait appel, l'étape réexamine", async () => {
    // La Direction (rang 3) entre directement chez la Direction Marketing.
    const id = await creer("dir", "Partenariat régional");
    expect((await instance(id)).currentSlug).toBe("marketing");
    const sansMotif = await agir("dm", id, "REJECT");
    expect(sansMotif.ok).toBe(false);
    ok(await agir("dm", id, "REJECT", "Hors stratégie de la gamme."));
    expect((await instance(id)).status).toBe("REJECTED");
    let d = await demande(id);
    expect(d.status).toBe("REFUSED");
    expect(d.decisionNote).toBe("Hors stratégie de la gamme.");
    expect(d.decidedById).toBe(u.dm);

    // Le geste d'avant ne contourne pas le circuit : une demande refusée ne se « valide » plus d'un clic.
    await comme("dm");
    expect((await decideAdProOtherRequest(fd({ id, approve: "1" }))).ok).toBe(false);
    // Ni la resoumission : on conteste un refus par l'appel.
    await comme("dir");
    expect((await resoumettreAdProOtherRequest(fd({ id, note: "Corrigée." }))).error).toMatch(/Faire appel/);

    // L'APPEL : seul le demandeur (ou la vue globale), motif exigé.
    await comme("kam");
    expect((await faireAppelAdPro(fd({ entityType: "AD_PRO_OTHER", entityId: id, motif: "Moi aussi." }))).ok).toBe(false);
    await comme("dir");
    ok(await faireAppelAdPro(fd({ entityType: "AD_PRO_OTHER", entityId: id, motif: "Le partenariat couvre trois gammes." })));
    const inst = await instance(id);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug, "l'étape qui a tranché réexamine").toBe("marketing");
    d = await demande(id);
    expect(d.status).toBe("AWAITING_DECISION");
    expect(d.decisionNote, "la décision d'hier quitte la ligne (elle reste au journal)").toBeNull();

    // Réexaminée — par le geste d'avant, désormais ROUTÉ vers le circuit.
    await comme("dm");
    ok(await decideAdProOtherRequest(fd({ id, approve: "1", note: "Accordé en appel." })));
    expect((await instance(id)).status).toBe("APPROVED");
    expect((await demande(id)).status).toBe("APPROVED");
  }, 90_000);

  it("RENVOI POUR CORRECTION : « à corriger » chez le demandeur, corrigée et resoumise, elle revient à l'étape", async () => {
    // Le National Sales entre chez le Directeur des opérations.
    const id = await creer("ns", "Kit de formation", 200_000);
    expect((await instance(id)).currentSlug).toBe("final");
    ok(await agir("ops", id, "RETURN", "Joindre le devis et réduire le montant."));
    expect((await instance(id)).status).toBe("RETURNED");
    expect((await demande(id)).status, "« à corriger »").toBe("RETURNED");

    await comme("ns");
    expect((await resoumettreAdProOtherRequest(fd({ id }))).error, "ce qui a changé est exigé").toMatch(/^Dites ce qui a changé/);
    const r = await resoumettreAdProOtherRequest(fd({ id, note: "Devis joint, montant revu.", amount: "150000" }));
    ok(r);
    expect(r.message).toMatch(/Validation \(Directeur des opérations\)/);
    const inst = await instance(id);
    expect(inst.status).toBe("IN_PROGRESS");
    expect(inst.currentSlug).toBe("final");
    const d = await demande(id);
    expect(d.status).toBe("AWAITING_DECISION");
    expect(Number(d.amount)).toBe(150_000);

    // ANNULÉE en cours de circuit : le circuit se ferme.
    ok(await closeAdProOtherRequest(fd({ id, cancel: "1", note: "Projet reporté." })));
    expect((await instance(id)).status).toBe("CANCELLED");
    expect((await demande(id)).status).toBe("CANCELLED");
  }, 90_000);

  it("UNE DEMANDE NÉE AVANT LA RÈGLE s'ouvre à l'étape de la route de son créateur ; terminée, elle est tranchée", async () => {
    const vieille = async (requesterId: string, status: "AWAITING_DECISION" | "DONE", suffixe: string) => (await prisma.adProOtherRequest.create({
      data: { reference: `${RUN}${suffixe}`.slice(0, 60), title: `${RUN} ancienne ${suffixe}`, status, requesterId },
      select: { id: true },
    })).id;
    const duKam = await vieille(u.kam, "AWAITING_DECISION", "K");
    const duNs = await vieille(u.ns, "AWAITING_DECISION", "N");
    const terminee = await vieille(u.ns, "DONE", "T");
    expect((await ensureInstance("AD_PRO_OTHER", duKam))?.currentSlug).toBe("preliminary");
    expect((await ensureInstance("AD_PRO_OTHER", duNs))?.currentSlug).toBe("final");
    const t = await ensureInstance("AD_PRO_OTHER", terminee);
    expect(t?.status).toBe("APPROVED");
    expect(t?.currentSlug).toBeNull();
  }, 60_000);
});
