import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * K10c — AD & PRO ET JURIDIQUE, RÉVERSIBLES : chaque action EXÉCUTÉE (la vraie, au clic de l'écran), puis ANNULÉE
 * (le bouton « Annuler »), contre la base locale — état d'avant, journal, audit ; la CASCADE (un ordre payé depuis
 * bloque tout, rien n'est écrit) ; le rétablissement (l'annulation est elle-même un geste).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));
// Les seuils globaux (BC, porte du DG) INJECTÉS dans ce processus : la base partagée garde son réglage (§118.132).
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 500_000, adProDgThreshold: 1_000_000_000_000 }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { annulerGeste, type CompteRenduAnnulation } from "@/lib/effets/annulation";
import { retablirGeste } from "@/lib/effets/retablissement";
import { addAdProItem, submitAdProItem, deleteAdProItem } from "@/modules/ad-pro/actions-postes";
import { decideAdProItem, annulerOrdrePoste } from "@/modules/ad-pro/actions-postes-decision";
import { demanderPaiementPoste } from "@/modules/ad-pro/actions-postes-paiement";
import { createLegalDocument, updateLegalDocument, cancelLegalDocument, sendLegalInvoiceToSettlement } from "@/lib/actions/legal-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zk10cadj${Date.now()}`;
let moi: CurrentUser;
let kamId = "", pmId = "", saId = "", eventId = "", catId = "", partieId = "";
const postes: string[] = [];
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), `${nom}-${Date.now()}-${Math.random()}`], nom, { type: "application/pdf" });
const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false } as unknown as CurrentUser;
}
const comme = async (qui: "kam" | "pm" | "sa") => {
  ACTOR = qui === "kam" ? await acteur(kamId, "MEDICAL_DELEGATE") : qui === "pm" ? await acteur(pmId, "PRODUCT_MANAGER") : await acteur(saId, "SUPER_ADMIN");
  moi = ACTOR;
};

/** Le geste que l'action vient d'inscrire — `annulable.gesteId` rendu à l'écran. */
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await annulerGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
const retablir = async (gesteId: string): Promise<CompteRenduAnnulation> => {
  const r = await retablirGeste(gesteId, moi);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};
/**
 * Tout ce qui est en base est défait ou compensé : seuls les effets SORTIS (la notification poussée, déjà affichée)
 * restent « impossibles » — et le compte rendu le dit, avec le rectificatif à faire.
 */
const toutDefaitEnBase = async (gesteId: string, c: CompteRenduAnnulation) => {
  const externes = new Set((await prisma.assistantEffet.findMany({ where: { gesteId, type: "EXTERNE" }, select: { id: true } })).map((e) => e.id));
  const restes = c.details.filter((d) => d.issue === "IMPOSSIBLE" && !externes.has(d.effetId));
  expect(restes, JSON.stringify(restes)).toEqual([]);
  for (const d of c.details.filter((x) => externes.has(x.effetId) && x.issue === "IMPOSSIBLE")) expect(d.aLaPlace ?? "").toMatch(/rectificatif/);
};
/** L'annulation est au journal (qui, quand) et à l'audit. */
const traceeDe = async (gesteId: string) => {
  const g = await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: gesteId } });
  expect(g.annuleParId).toBe(moi.id);
  expect(g.annuleLe).toBeTruthy();
  expect(await prisma.auditLog.count({ where: { entityId: gesteId, summary: { contains: "Annulation" } } })).toBe(1);
};

/** Un SPONSORING DIRECT accordé (payé sur proforma, sans BC) : le délégué décrit et soumet, la Direction Marketing accorde. */
async function posteAccorde(label: string, montant = 300_000): Promise<string> {
  await comme("kam");
  const a = await addAdProItem(undefined, fd({ parent: "EVENT", parentId: eventId, kind: "ASSOCIATION_SUPPORT", label: `${TAG}${label}`, amountEstimated: String(montant), supplier: "Association Alpha" }));
  ok(a);
  postes.push(a.id!);
  ok(await submitAdProItem(undefined, fd({ id: a.id! })));
  await comme("pm");
  ok(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
  return a.id!;
}
async function payer(id: string, montant = "300000") {
  await comme("kam");
  const f = fd({ id, montant, reference: `${TAG}FA${Math.random().toString(36).slice(2, 7)}`, argumentation: "Banc K10c.", confirme: "1" });
  f.append("attachment", pdf(`${TAG}facture.pdf`));
  return demanderPaiementPoste(undefined, f);
}
const etat = (id: string) => prisma.adProItem.findUniqueOrThrow({ where: { id }, select: { status: true, orderStage: true, expenseOrderId: true } });

suite("K10c — Ad & Pro et juridique : exécuter, annuler, rétablir", () => {
  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    const [kam, pm, sa] = await Promise.all([mk("kam", "MEDICAL_DELEGATE"), mk("pm", "PRODUCT_MANAGER"), mk("sa", "SUPER_ADMIN")]);
    kamId = kam.id; pmId = pm.id; saId = sa.id;
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journée`, requesterId: kamId, status: "VALIDATED", requestStatus: "APPROVED", startDate: new Date("2026-12-04") }, select: { id: true } })).id;
    const env = await prisma.budgetEnvelope.create({ data: { name: `${TAG}Enveloppe`, modules: ["EVENTS"], totalAmount: 10_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") }, select: { id: true } });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Sponsoring`, allocated: 5_000_000 }, select: { id: true } })).id;
    partieId = (await prisma.companyContact.create({ data: { name: `${TAG} Froid Industriel SPA`, kind: "Prestataire", createdById: saId }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const comptes = [kamId, pmId, saId].filter(Boolean);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: { in: comptes } } }).catch(() => undefined);
    const tous = [...new Set([...postes, ...(await prisma.adProItem.findMany({ where: { eventId }, select: { id: true } })).map((p) => p.id)])];
    const liees = await prisma.adProItemPiece.findMany({ where: { itemId: { in: tous } }, select: { legalDocumentId: true } }).catch(() => []);
    const docs = [...new Set([
      ...liees.map((l) => l.legalDocumentId),
      ...(await prisma.legalDocument.findMany({ where: { OR: [{ sourceId: eventId }, { title: { startsWith: TAG } }, { createdById: { in: comptes } }] }, select: { id: true } })).map((d) => d.id),
    ])];
    await prisma.adProItemPiece.deleteMany({ where: { OR: [{ itemId: { in: tous } }, { legalDocumentId: { in: docs } }] } }).catch(() => undefined);
    await prisma.document.deleteMany({ where: { entityId: { in: [...docs, ...tous] } } }).catch(() => undefined);
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: docs } } }).catch(() => undefined);
    await prisma.adProItem.updateMany({ where: { id: { in: tous } }, data: { expenseOrderId: null } }).catch(() => undefined);
    await prisma.legalDocument.updateMany({ where: { id: { in: docs } }, data: { expenseOrderId: null } }).catch(() => undefined);
    const ordres = (await prisma.expenseOrder.findMany({ where: { OR: [{ sourceId: { in: [eventId, ...docs, ...tous] } }, { label: { contains: TAG } }] }, select: { id: true } })).map((o) => o.id);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => undefined);
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => undefined);
    await prisma.deletedRecord.deleteMany({ where: { sourceId: { in: tous } } }).catch(() => undefined);
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: tous } } }).catch(() => undefined);
    await prisma.adProItem.deleteMany({ where: { id: { in: tous } } }).catch(() => undefined);
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => undefined);
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => undefined);
  }, 120_000);

  it("demanderPaiementPoste : l'ordre, son dossier et la facture sont retirés, le poste revient ; rétablir les remet", async () => {
    const id = await posteAccorde("Navettes");
    const avant = await etat(id);
    const r = await payer(id);
    ok(r);
    const g = gesteDe(r);
    const ordre = r.id!;
    expect((await etat(id)).expenseOrderId).toBe(ordre);
    // La proforma / lettre de demande (sponsoring direct) déposée par ce geste, rattachée au poste.
    const factures = (await prisma.adProItemPiece.findMany({ where: { itemId: id }, select: { legalDocumentId: true } })).map((p) => p.legalDocumentId);
    expect(factures.length).toBeGreaterThan(0);

    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    expect(await etat(id)).toEqual(avant);
    // L'ordre et son dossier compagnon, nés de ce geste : retirés (intacts) ou passés à ANNULÉ.
    const o = await prisma.expenseOrder.findUnique({ where: { id: ordre }, select: { status: true } });
    expect(o === null || o.status === "CANCELLED").toBe(true);
    for (const f of factures) {
      const d = await prisma.legalDocument.findUnique({ where: { id: f }, select: { status: true } });
      expect(d === null || d.status === "CANCELLED").toBe(true);
    }
    await traceeDe(g);

    await retablir(g);
    expect((await etat(id)).expenseOrderId).toBe(ordre);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).not.toBe("CANCELLED");
  });

  it("demanderPaiementPoste, CASCADE : l'ordre PAYÉ depuis bloque tout — rien n'est écrit, la liste dit pourquoi", async () => {
    const id = await posteAccorde("Traiteur");
    const r = await payer(id);
    ok(r);
    const g = gesteDe(r);
    await prisma.expenseOrder.update({ where: { id: r.id! }, data: { status: "PAID" } });
    const avant = await etat(id);
    const refus = await annulerGeste(g, moi);
    expect("refus" in refus ? refus.refus : "").toMatch(/Rien n'a été annulé/);
    expect("refus" in refus ? refus.bloquants?.length : 0).toBeGreaterThan(0);
    expect(await etat(id)).toEqual(avant);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: r.id! } })).status).toBe("PAID");
    expect((await prisma.assistantGesteJournal.findUniqueOrThrow({ where: { id: g } })).annuleLe).toBeNull();
  });

  it("annulerOrdrePoste : l'ordre, la facture et le poste reprennent leur statut d'avant ; rétablir ré-annule", async () => {
    const id = await posteAccorde("Bus");
    const em = await payer(id);
    ok(em);
    const ordre = em.id!;
    const factures = await prisma.legalDocument.findMany({ where: { id: { in: (await prisma.adProItemPiece.findMany({ where: { itemId: id }, select: { legalDocumentId: true } })).map((p) => p.legalDocumentId) } }, select: { id: true, status: true } });
    const avant = await etat(id);
    const ordreAvant = (await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status;
    await comme("pm");
    const r = await annulerOrdrePoste(undefined, fd({ id, motif: "Mauvais RIB." }));
    ok(r);
    const g = gesteDe(r);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe("CANCELLED");
    expect((await etat(id)).expenseOrderId).toBeNull();

    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    expect(await etat(id)).toEqual(avant);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe(ordreAvant);
    for (const f of factures) expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } })).status).toBe(f.status);
    await traceeDe(g);

    await retablir(g);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe("CANCELLED");
    expect((await etat(id)).expenseOrderId).toBeNull();
  });

  it("deleteAdProItem : le poste revient de la CORBEILLE (même identifiant), l'ordre reprend son statut ; rétablir le remet en corbeille", async () => {
    const id = await posteAccorde("Hôtel");
    const em = await payer(id);
    ok(em);
    const ordre = em.id!;
    const decisions = await prisma.adProItemDecision.count({ where: { itemId: id } });
    const avant = await etat(id);
    await comme("pm");
    const r = await deleteAdProItem(undefined, fd({ id }));
    ok(r);
    const g = gesteDe(r);
    expect(await prisma.adProItem.count({ where: { id } })).toBe(0);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe("CANCELLED");
    const rec = await prisma.deletedRecord.findFirstOrThrow({ where: { sourceId: id, kind: "AD_PRO_ITEM" } });

    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    expect(c.details.some((d) => /corbeille/.test(d.pourquoi))).toBe(true);
    expect(await etat(id)).toEqual(avant);
    expect(await prisma.adProItemDecision.count({ where: { itemId: id } })).toBe(decisions);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).toBeTruthy();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).not.toBe("CANCELLED");
    await traceeDe(g);

    // Rétablir : la suppression revient — le poste repart (l'entrée de corbeille redevient non restaurée).
    await retablir(g);
    expect(await prisma.adProItem.count({ where: { id } })).toBe(0);
    expect((await prisma.deletedRecord.findUniqueOrThrow({ where: { id: rec.id } })).restoredAt).toBeNull();
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe("CANCELLED");
  });

  it("createLegalDocument : la pièce créée est retirée ; rétablir la recrée (même identifiant)", async () => {
    await comme("sa");
    const r = await createLegalDocument(undefined, fd({ title: `${TAG} Maintenance`, kind: "INVOICE", reference: `F-${TAG}`, counterpartyIds: partieId, amount: "180000", direction: "OUT" }));
    ok(r);
    const g = gesteDe(r);
    expect(await prisma.legalDocument.count({ where: { id: r.id! } })).toBe(1);
    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    expect(await prisma.legalDocument.count({ where: { id: r.id! } })).toBe(0);
    await traceeDe(g);
    await retablir(g);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).title).toBe(`${TAG} Maintenance`);
  });

  it("updateLegalDocument : les champs reprennent leur valeur d'avant", async () => {
    await comme("sa");
    const d = await prisma.legalDocument.create({ data: { title: `${TAG} Bail`, kind: "CONTRACT", status: "ACTIVE", amount: 50_000, counterparty: "SARL Atlas", createdById: saId } });
    const r = await updateLegalDocument(fd({ id: d.id, title: `${TAG} Bail révisé`, kind: "CONTRACT", amount: "75000", notes: "Avenant n° 1", counterpartyIds: partieId }));
    ok(r);
    const g = gesteDe(r);
    expect(Number((await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.id } })).amount)).toBe(75_000);
    const c = await annuler(g);
    await toutDefaitEnBase(g, c);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: d.id } });
    expect([apres.title, Number(apres.amount), apres.notes, apres.counterparty]).toEqual([d.title, 50_000, d.notes, d.counterparty]);
    await traceeDe(g);
  });

  it("cancelLegalDocument puis sendLegalInvoiceToSettlement : l'envoi est retiré, puis l'annulation est défaite", async () => {
    await comme("sa");
    const f = await prisma.legalDocument.create({ data: { title: `${TAG} Facture`, kind: "INVOICE", status: "ACTIVE", amount: 70_000, counterparty: "SARL Atlas", direction: "OUT", createdById: saId } });

    // ENVOI AU RÈGLEMENT : l'ordre (et son dossier compagnon) naît ; annulé, il est retiré et la facture redevient sans ordre.
    const e = await sendLegalInvoiceToSettlement(fd({ id: f.id }));
    ok(e);
    const ge = gesteDe(e);
    const ordre = (await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } })).expenseOrderId!;
    expect(ordre).toBeTruthy();
    const ce = await annuler(ge);
    await toutDefaitEnBase(ge, ce);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } })).expenseOrderId).toBeNull();
    const o = await prisma.expenseOrder.findUnique({ where: { id: ordre }, select: { status: true } });
    expect(o === null || o.status === "CANCELLED").toBe(true);
    await traceeDe(ge);

    // ANNULATION DE LA PIÈCE : la facture reprend son statut.
    const a = await cancelLegalDocument(fd({ id: f.id, reason: "contestée" }));
    ok(a);
    const ga = gesteDe(a);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("CANCELLED");
    const ca = await annuler(ga);
    await toutDefaitEnBase(ga, ca);
    const lue = await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } });
    expect([lue.status, lue.cancelledAt, lue.cancelReason]).toEqual(["ACTIVE", null, null]);
    await traceeDe(ga);
    await retablir(ga);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("CANCELLED");
  });
});
