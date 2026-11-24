import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FINANCES › IMPÔTS & COTISATIONS (24/11/2026), RÉVERSIBLES : chaque geste EXÉCUTÉ au clic de l'écran (journal des effets,
 * `annulable.gesteId`), puis ANNULÉ (le bouton « Annuler »), contre la base locale — calendrier, brouillon, envoi au centre
 * (l'ordre émis se retire), retrait, reprise d'un refus, quittance, paiement ponctuel.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { annulerGeste } from "@/lib/effets/annulation";
import {
  corrigerImpotRefuse, enregistrerBrouillonImpot, enregistrerCalendrierFiscal, envoyerImpotAuCentre, envoyerPaiementPonctuel,
  joindreQuittanceImpot, retirerImpotDuCentre,
} from "@/modules/finances/actions-impots";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `zimprev${Date.now().toString(36)}`;
let FIN: CurrentUser;
let SOC = "";
/** Les ordres émis par le banc — une annulation en retire certains de la base, leurs fichiers restent à ranger. */
const ORDRES_VUS = new Set<string>();
const fd = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File(["%PDF-1.4 banc reversibilite impots"], nom, { type: "application/pdf" });
const gesteDe = (r: unknown): string => {
  const g = (r as { annulable?: { gesteId?: string } }).annulable?.gesteId;
  expect(g, JSON.stringify(r)).toBeTruthy();
  return g!;
};
const annuler = async (gesteId: string) => {
  const r = await annulerGeste(gesteId, FIN);
  if ("refus" in r) throw new Error(r.refus);
  return r;
};

suite("Impôts & cotisations : exécuter, puis annuler", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} Karim`, email: `${TAG}@t.dz`, passwordHash: "x", role: "FINANCE_BUDGET_MANAGER" } });
    FIN = { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
    SOC = (await prisma.company.create({ data: { name: `${TAG} Société` } })).id;
    ACTOR = FIN;
  });

  afterAll(async () => {
    ACTOR = null;
    const lignes = (await prisma.echeanceFiscale.findMany({ where: { companyId: SOC }, select: { id: true } })).map((l) => l.id);
    const ordres = [...new Set([...ORDRES_VUS, ...(await prisma.expenseOrder.findMany({ where: { OR: [{ companyId: SOC }, { sourceId: { in: lignes } }] }, select: { id: true } })).map((o) => o.id)])];
    const cles = (await prisma.document.findMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ordres } }, select: { fileKey: true } })).map((d) => d.fileKey).filter((k): k is string => Boolean(k));
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ordres } } }).catch(() => undefined);
    // Les fichiers des ordres — ceux qu'une annulation a détachés de leur fiche compris — et leur blob s'il ne sert plus.
    const fichiers = await prisma.storedFile.findMany({ where: { OR: [{ key: { in: cles } }, ...ordres.map((o) => ({ key: { startsWith: `EXPENSE_ORDER/${o}/` } }))] }, select: { key: true, blobId: true } });
    await prisma.storedFile.deleteMany({ where: { key: { in: fichiers.map((f) => f.key) } } }).catch(() => undefined);
    for (const blobId of new Set(fichiers.map((f) => f.blobId))) {
      if ((await prisma.storedFile.count({ where: { blobId } })) === 0) await prisma.fileBlob.deleteMany({ where: { id: blobId } }).catch(() => undefined);
    }
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => undefined);
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => undefined);
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => undefined);
    await prisma.echeanceFiscale.deleteMany({ where: { companyId: SOC } }).catch(() => undefined);
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => undefined);
    await prisma.obligationFiscale.deleteMany({ where: { companyId: SOC } }).catch(() => undefined);
    await prisma.budgetEnvelope.deleteMany({ where: { companyId: SOC } }).catch(() => undefined);
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: FIN.id } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { actorId: FIN.id } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { id: FIN.id } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: SOC } }).catch(() => undefined);
  });

  const nouvelleLigne = (nature: string) => prisma.echeanceFiscale.create({
    data: { companyId: SOC, organisme: "CASNOS", nature: `${nature} ${TAG}`, composition: "MONTANT", periodeLibelle: "année 2026", periode: null },
  });
  const envoyer = async (id: string) => {
    const r = await envoyerImpotAuCentre(fd({ id, saisies: JSON.stringify({ montant: "96 000" }), justificatif: pdf("Avis.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const ordre = (await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id } })).expenseOrderId!;
    ORDRES_VUS.add(ordre);
    return ordre;
  };

  it("enregistrerCalendrierFiscal → annulé : l'obligation et la ligne de la période disparaissent", async () => {
    const lignes = JSON.stringify([{ companyId: SOC, organisme: "CNAS", nature: `Cotisations ${TAG}`, composition: "CNAS", periodicite: "MENSUELLE", jour: "30", rappel: true }]);
    const r = await enregistrerCalendrierFiscal(fd({ lignes, retirees: "[]" }));
    expect(r.ok, r.error).toBe(true);
    expect(await prisma.echeanceFiscale.count({ where: { companyId: SOC, nature: `Cotisations ${TAG}` } })).toBe(1);
    await annuler(gesteDe(r));
    expect(await prisma.obligationFiscale.count({ where: { companyId: SOC } })).toBe(0);
    expect(await prisma.echeanceFiscale.count({ where: { companyId: SOC, nature: `Cotisations ${TAG}` } })).toBe(0);
  });

  it("enregistrerBrouillonImpot → annulé : les saisies d'avant reviennent", async () => {
    const l = await nouvelleLigne("Brouillon");
    const r = await enregistrerBrouillonImpot(fd({ id: l.id, saisies: JSON.stringify({ montant: "12" }) }));
    expect(r.ok, r.error).toBe(true);
    await annuler(gesteDe(r));
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).saisies).toBeNull();
  });

  it("envoyerImpotAuCentre → annulé : l'ordre émis se retire, la ligne revient « À préparer »", async () => {
    const l = await nouvelleLigne("Envoi");
    const r = await envoyerImpotAuCentre(fd({ id: l.id, saisies: JSON.stringify({ montant: "96 000" }), justificatif: pdf("Avis-CASNOS.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const ordre = (await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).expenseOrderId!;
    ORDRES_VUS.add(ordre);
    await annuler(gesteDe(r));
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).expenseOrderId).toBeNull();
    const reste = await prisma.expenseOrder.findUnique({ where: { id: ordre }, select: { status: true } });
    expect(reste === null || reste.status === "CANCELLED").toBe(true);
  });

  it("retirerImpotDuCentre → annulé : l'ordre attend de nouveau le centre, la ligne s'y rattache", async () => {
    const l = await nouvelleLigne("Retrait");
    const ordre = await envoyer(l.id);
    const r = await retirerImpotDuCentre(fd({ id: l.id }));
    expect(r.ok, r.error).toBe(true);
    await annuler(gesteDe(r));
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre } })).status).toBe("PENDING");
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).expenseOrderId).toBe(ordre);
  });

  it("corrigerImpotRefuse → annulé : la ligne se rattache à l'ordre refusé", async () => {
    const l = await nouvelleLigne("Refus");
    const ordre = await envoyer(l.id);
    // La décision appartient au centre (`decidePayment`) ; le banc pose son résultat.
    await prisma.expenseOrder.update({ where: { id: ordre }, data: { centralStatus: "REFUSED" } });
    const r = await corrigerImpotRefuse(fd({ id: l.id }));
    expect(r.ok, r.error).toBe(true);
    await annuler(gesteDe(r));
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).expenseOrderId).toBe(ordre);
  });

  it("joindreQuittanceImpot → annulé : la quittance quitte la ligne", async () => {
    const l = await nouvelleLigne("Quittance");
    const ordre = await envoyer(l.id);
    // Le règlement appartient à Banque & paiements (`settleExpenseOrder`) ; le banc pose son résultat.
    await prisma.expenseOrder.update({ where: { id: ordre }, data: { centralStatus: "APPROVED", status: "PAID", paidDate: new Date() } });
    const r = await joindreQuittanceImpot(fd({ id: l.id, quittance: pdf("Quittance.pdf"), numero: "Q-1" }));
    expect(r.ok, r.error).toBe(true);
    await annuler(gesteDe(r));
    expect((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: l.id } })).quittanceId).toBeNull();
  });

  it("envoyerPaiementPonctuel → annulé : la ligne et son ordre se retirent", async () => {
    const r = await envoyerPaiementPonctuel(fd({ organisme: "Recette des impôts", companyId: SOC, nature: `Pénalité ${TAG}`, periode: "2026", montant: "5 000", justificatif: pdf("Avis.pdf") }));
    expect(r.ok, r.error).toBe(true);
    ORDRES_VUS.add((await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: r.id! } })).expenseOrderId!);
    await annuler(gesteDe(r));
    expect(await prisma.echeanceFiscale.count({ where: { id: r.id! } })).toBe(0);
  });
});
