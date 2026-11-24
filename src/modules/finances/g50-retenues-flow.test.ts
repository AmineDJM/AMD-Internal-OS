import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR, getUser: async () => ACTEUR, requireModule: async () => ACTEUR,
}));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { enregistrerCalendrierFiscal, envoyerImpotAuCentre } from "./actions-impots";
import { decidePayment } from "./actions-centre";
import { settleExpenseOrder } from "./actions-depenses";
import { paieDuMois } from "./infra/impots";
import { periodeCourante } from "./domaine/impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA G50 REVERSE LES RETENUES À LA SOURCE DU MOIS — sans les compter deux fois (contrôle final, 24/11/2026).
 *
 * Une retenue sur des honoraires est CONSOMMÉE au règlement de la dépense, sur la ligne de cette dépense
 * (`constaterRetenueAuReglement`). La G50 du mois la PROPOSE (« Retenues à la source à reverser »), sa part part au centre
 * dans un ordre À PART, réglé SANS ligne budgétaire ; payé, il marque les retenues « reversées ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__g50ras__";
const fd = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string) => new File(["%PDF-1.4 banc g50 retenues"], nom, { type: "application/pdf" });
const session = async (id: string, role: string): Promise<SessionUser> =>
  ({ id, name: `${TAG}${role}`, email: `${TAG}${id}@t.dz`, role, secondaryRole: null, access: await getAccess(id, role as never), mustChangePassword: false }) as unknown as SessionUser;

suite("G50 — les retenues à la source du mois, reversées sans double compte", () => {
  const u: Record<string, string> = {};
  let fbm: SessionUser, cpt: SessionUser, dg: SessionUser;
  let soc = "";
  const periode = periodeCourante("MENSUELLE", new Date())!;
  const retenues: string[] = [];

  beforeAll(async () => {
    await nettoyer();
    for (const [k, role] of [["fbm", "FINANCE_BUDGET_MANAGER"], ["cpt", "FINANCE_BUDGET_MANAGER"], ["dg", "GENERAL_MANAGER"]] as const) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, passwordHash: "x", role }, select: { id: true } })).id;
    }
    soc = (await prisma.company.create({ data: { name: `${TAG}Société`, shortName: `${TAG}S` } })).id;
    for (const k of ["fbm", "cpt"]) await prisma.userCompanyAccess.create({ data: { userId: u[k]!, companyId: soc, canEdit: true } });
    // Deux honoraires réglés ce mois-ci : leurs retenues sont « à reverser » et ont DÉJÀ consommé la ligne de la dépense.
    for (const [i, montant] of [[1, 15_000], [2, 4_500]] as const) {
      retenues.push((await prisma.retenueSource.create({
        data: {
          companyId: soc, expenseOrderId: `${TAG}ordre-honoraires-${i}`, natureDepense: "HONORAIRES_MEDECIN", regime: "HONORAIRES", beneficiaire: `${TAG}Dr ${i}`,
          brut: montant * 10, taux: 10, montant, net: montant * 9, statut: "A_REVERSER", mois: periode.cle, payeeLe: new Date(),
        },
        select: { id: true },
      })).id);
    }
    fbm = await session(u.fbm!, "FINANCE_BUDGET_MANAGER");
    cpt = await session(u.cpt!, "FINANCE_BUDGET_MANAGER");
    dg = await session(u.dg!, "GENERAL_MANAGER");
  }, 60_000);

  afterAll(nettoyer);

  async function nettoyer() {
    const societes = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const lignes = (await prisma.echeanceFiscale.findMany({ where: { companyId: { in: societes } }, select: { id: true } })).map((l) => l.id);
    const ordres = await prisma.expenseOrder.findMany({ where: { OR: [{ companyId: { in: societes } }, { sourceId: { in: lignes } }] }, select: { id: true, transactionId: true } });
    const ids = ordres.map((o) => o.id);
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ids } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    const dossiers = (await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { sourceId: { in: ids } } }).catch(() => {});
    await prisma.echeanceFiscale.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ordres.map((o) => o.transactionId).filter((t): t is string => Boolean(t)) } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.retenueSource.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await prisma.obligationFiscale.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    const envs = (await prisma.budgetEnvelope.findMany({ where: { companyId: { in: societes } }, select: { id: true } })).map((e) => e.id);
    await prisma.budgetExpenseLine.deleteMany({ where: { category: { envelopeId: { in: envs } } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envs } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...lignes, ...ids] } }, { actor: { email: { startsWith: TAG } } }] } }).catch(() => {});
    await prisma.treasuryAccount.deleteMany({ where: { companyId: { in: societes } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } });
    await prisma.company.deleteMany({ where: { id: { in: societes } } }).catch(() => {});
  }

  it("la G50 du mois PROPOSE les retenues à reverser, avec leur liste", async () => {
    const paie = await paieDuMois(soc, periode.cle);
    expect(paie.propositions.retenues).toBe(19_500);
    expect(paie.retenues.map((r) => r.id).sort()).toEqual([...retenues].sort());
  });

  it("envoyée : la part des retenues est un ordre À PART, sans ligne budgétaire ; payé, il les marque « reversées » sans rien reconsommer", async () => {
    ACTEUR = fbm;
    const calendrier = JSON.stringify([
      { companyId: soc, organisme: "Recette des impôts", nature: "G50 — TVA et IRG salaires", composition: "G50", periodicite: "MENSUELLE", jour: "20", rappel: true, confirme: true },
    ]);
    const c = await enregistrerCalendrierFiscal(fd({ lignes: calendrier, retirees: "[]" }));
    expect(c.ok, c.error).toBe(true);
    const g50 = await prisma.echeanceFiscale.findFirstOrThrow({ where: { companyId: soc } });
    // TVA 5 000 + retenues proposées 19 500 ; aucun IRG ce mois-ci.
    const saisies = JSON.stringify({ irg: "0", tvaC: "25 000", tvaD: "20 000" });
    const r = await envoyerImpotAuCentre(fd({ id: g50.id, saisies, justificatif: pdf("G50.pdf") }));
    expect(r.ok, r.error).toBe(true);
    const ligne = await prisma.echeanceFiscale.findUniqueOrThrow({ where: { id: g50.id } });
    expect(Number(ligne.montant)).toBe(24_500);
    const ordres = await prisma.expenseOrder.findMany({ where: { id: { in: ligne.ordresIds } } });
    expect(ordres).toHaveLength(2);
    const ras = ordres.find((o) => Number(o.amount) === 19_500)!;
    const tva = ordres.find((o) => Number(o.amount) === 5_000)!;
    expect(ras.budgetCategoryId).toBeNull();
    expect(tva.budgetCategoryId).not.toBeNull();
    // Les deux ordres ont leur pièce : ils sont entrés au centre.
    expect(ordres.map((o) => o.centralStatus)).toEqual(["AWAITING", "AWAITING"]);
    const ligneRas = (ligne.decomposition as { cle: string; ordreId?: string; retenuesIds?: string[] }[]).find((d) => d.cle === "ras")!;
    expect(ligneRas.ordreId).toBe(ras.id);
    expect([...ligneRas.retenuesIds!].sort()).toEqual([...retenues].sort());

    ACTEUR = dg;
    const d = await decidePayment(fd({ id: ras.id, decision: "APPROVE" }));
    expect(d.ok, d.error).toBe(true);
    const lignesBudgetAvant = await prisma.budgetExpenseLine.count();
    ACTEUR = cpt;
    const s = await settleExpenseOrder(fd({ id: ras.id }));
    expect(s.ok, s.error).toBe(true);

    const regle = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ras.id } });
    expect(regle.status).toBe("PAID");
    // AUCUN DOUBLE COMPTE : l'écriture n'est imputée à aucune ligne, et aucune consommation budgétaire n'est née.
    const ecriture = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: regle.transactionId! } });
    expect([Number(ecriture.amount), ecriture.budgetCategoryId]).toEqual([19_500, null]);
    expect(await prisma.budgetExpenseLine.count()).toBe(lignesBudgetAvant);
    const apres = await prisma.retenueSource.findMany({ where: { id: { in: retenues } } });
    expect(apres.map((x) => [x.statut, x.reverseeParOrdreId])).toEqual([["REVERSEE", ras.id], ["REVERSEE", ras.id]]);
    // Reversées, elles ne sont plus proposées.
    expect((await paieDuMois(soc, periode.cle)).propositions.retenues ?? null).toBeNull();
  });
});
