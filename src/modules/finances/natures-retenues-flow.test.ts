import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR }));
// Le stockage n'est pas le sujet : le faux rend un `documentId` réel, retrouvé au nettoyage par son nom.
vi.mock("@/lib/documents", () => ({
  persistUploadedDocument: async () => {
    const doc = await (await import("@/lib/prisma")).prisma.document.create({
      data: { name: "__natures__piece.pdf", entityType: "PAYMENT_REQUEST", entityId: "x", fileKey: "k", mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL" },
    });
    return { ok: true, documentId: doc.id };
  },
}));

import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import { adventumCompanyId } from "@/lib/company";
import { createPaymentRequest, submitPaymentRequest } from "./actions-demandes";
import { choisirNatureDemande, reglerTauxRetenue } from "./actions-natures";
import { decidePayment } from "./actions-centre";
import { settleExpenseOrder } from "./actions-depenses";
import { libelleNatureDepense, NATURE_NON_PRECISEE, REFUS_SANS_NATURE, moisDeLaRetenue } from "./partage";
import { marquerRetenuesReversees, retenuesDuMoisAReverser } from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA NATURE OBLIGATOIRE ET LA RETENUE À LA SOURCE, PAR LES VRAIES ACTIONS (Super Admin, 24/11/2026).
 *
 *   1. une demande sans nature est refusée, et rien n'est créé ;
 *   2. la nature pré-choisit la ligne budgétaire et la rubrique de l'ordre ;
 *   3. des honoraires de médecin : l'ordre paie le NET, la retenue est enregistrée (prévue, puis à reverser au règlement,
 *      sur le mois du paiement) et consomme la MÊME ligne — la dépense coûte le brut ;
 *   4. une demande d'avant la règle reste lisible (« nature non précisée ») et se transmet une fois sa nature choisie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;
const TAG = `__natures__${Date.now().toString(36)}`;

const fd = (x: Record<string, string>, facture = false) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(x)) f.set(k, v);
  if (facture) {
    // UNE FACTURE DISTINCTE PAR DEMANDE : le même fichier deux fois serait la même facture, refusée.
    f.append("files", new File([`${TAG} ${Math.random()}`], "facture.pdf", { type: "application/pdf" }));
    f.set("kind_0", "INVOICE");
  }
  return f;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error ?? "?");

suite("Nature de la dépense et retenue à la source — la chaîne réelle", () => {
  const u: Record<string, { id: string; role: UserRole }> = {};
  const envIds: string[] = [];
  let ligneLoyer = "", ligneMedecins = "", societe: string | null = null;
  const comme = async (k: string) => {
    const { id, role } = u[k];
    ACTEUR = { id, name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, access: await getAccess(id, role), mustChangePassword: false };
  };
  const demande = (titre: string, nature: string | null, montant: number, envoi = true) => {
    const champs: Record<string, string> = { title: `${TAG}${titre}`, payee: "Dr Benali", amount: String(montant), submit: envoi ? "1" : "0", paymentMethodStated: "on" };
    if (nature) champs.natureDepense = nature;
    return createPaymentRequest(undefined, fd(champs, true));
  };
  const ordreDe = async (demandeId: string) => {
    const d = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: demandeId }, select: { expenseOrderId: true } });
    return prisma.expenseOrder.findUniqueOrThrow({ where: { id: d.expenseOrderId! } });
  };

  beforeAll(async () => {
    for (const [k, role] of [["dem", "PRODUCT_MANAGER"], ["pdg", "GENERAL_MANAGER"], ["cpt", "FINANCE_BUDGET_MANAGER"], ["sa", "SUPER_ADMIN"]] as const) {
      u[k] = { id: (await prisma.user.create({ data: { name: `${TAG}${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id, role };
    }
    societe = await adventumCompanyId();
    const an = new Date().getFullYear();
    const env = await prisma.budgetEnvelope.create({ data: { name: `${TAG}Administration`, companyId: societe, periodStart: new Date(`${an}-01-01`), periodEnd: new Date(`${an}-12-31T23:59:59Z`), totalAmount: 10_000_000 } });
    envIds.push(env.id);
    ligneLoyer = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Loyer`, cle: "LOYER", allocated: 5_000_000 } })).id;
    ligneMedecins = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Honoraires médecins`, cle: "HONORAIRES_MEDECINS", allocated: 5_000_000 } })).id;
  }, 60_000);

  afterAll(async () => {
    ACTEUR = null;
    const demandes = (await prisma.paymentRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true, expenseOrderId: true } }));
    const ordres = demandes.map((d) => d.expenseOrderId).filter((x): x is string => Boolean(x));
    const txs = (await prisma.expenseOrder.findMany({ where: { id: { in: ordres } }, select: { transactionId: true } })).map((o) => o.transactionId).filter((x): x is string => Boolean(x));
    const dossiers = (await prisma.paymentRequest.findMany({ where: { OR: [{ id: { in: demandes.map((d) => d.id) } }, { expenseOrderId: { in: ordres } }] }, select: { id: true } })).map((d) => d.id);
    await prisma.retenueSource.deleteMany({ where: { expenseOrderId: { in: ordres } } }).catch(() => {});
    await prisma.paymentPiece.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers } } }).catch(() => {});
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: txs } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: envIds } } }).catch(() => {});
    await prisma.tauxRetenueSource.deleteMany({ where: { updatedById: u.sa?.id } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { name: "__natures__piece.pdf" } }).catch(() => {});
    const ids = Object.values(u).map((x) => x.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  it("une demande sans nature est refusée — brouillon compris — et rien n'est créé", async () => {
    await comme("dem");
    expect(err(await demande("sans nature", null, 50_000))).toBe(REFUS_SANS_NATURE);
    expect(err(await demande("sans nature brouillon", null, 50_000, false))).toBe(REFUS_SANS_NATURE);
    expect(err(await demande("nature de circuit", "CIRCUITS.PAIE", 50_000))).toMatch(/virement de la paie/);
    expect(await prisma.paymentRequest.count({ where: { title: { startsWith: `${TAG}sans nature` } } })).toBe(0);
    expect(await prisma.paymentRequest.count({ where: { title: `${TAG}nature de circuit` } })).toBe(0);
  });

  it("la nature pré-choisit la ligne budgétaire et la rubrique (fin du « FOURNISSEUR » forcé)", async () => {
    await comme("dem");
    const r = await demande("loyer", "LOCAUX.LOYER", 450_000);
    expect(err(r)).toBeNull();
    expect((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r.id! } })).natureDepense).toBe("LOCAUX.LOYER");
    const ordre = await ordreDe(r.id!);
    expect(ordre).toMatchObject({ category: "LOYER", budgetCategoryId: ligneLoyer, requiresInvoice: false });
    expect(Number(ordre.amount)).toBe(450_000);
    expect(await prisma.retenueSource.count({ where: { expenseOrderId: ordre.id } })).toBe(0);
  });

  it("seul le Super Admin règle un taux de retenue, et il reste « à confirmer » tant qu'il ne le confirme pas", async () => {
    await comme("cpt");
    expect(err(await reglerTauxRetenue(fd({ regime: "HONORAIRES_MEDECIN", taux: "15" })))).toMatch(/Super Admin/);
    await comme("sa");
    expect(err(await reglerTauxRetenue(fd({ regime: "HONORAIRES_MEDECIN", taux: "150" })))).toMatch(/entre 0 et 100/);
    const r = await reglerTauxRetenue(fd({ regime: "HONORAIRES_MEDECIN", taux: "15" }));
    expect(err(r)).toBeNull();
    expect(r.message).toMatch(/à confirmer par le cabinet/);
  });

  it("honoraires de médecin : l'ordre paie le net, la retenue est enregistrée puis consommée sur la MÊME ligne", async () => {
    await comme("dem");
    const r = await demande("honoraires", "HONORAIRES.MEDECIN", 100_000);
    expect(err(r)).toBeNull();
    const ordre = await ordreDe(r.id!);
    // L'ordre : le NET (100 000 − 15 %), sa rubrique, sa ligne, et la phrase brut / retenue / net.
    expect(Number(ordre.amount)).toBe(85_000);
    expect(ordre).toMatchObject({ category: "EVENEMENT", budgetCategoryId: ligneMedecins, requiresInvoice: false });
    expect(ordre.notes).toMatch(/Brut 100.000 DZD · retenue à la source .*15 % — taux à confirmer par le cabinet\) 15.000 DZD · net à verser 85.000 DZD/);
    const prevue = await prisma.retenueSource.findUniqueOrThrow({ where: { expenseOrderId: ordre.id } });
    expect(prevue).toMatchObject({ statut: "PREVUE", regime: "HONORAIRES_MEDECIN", natureDepense: "HONORAIRES.MEDECIN", paymentRequestId: r.id, mois: null });
    expect([Number(prevue.brut), Number(prevue.taux), Number(prevue.montant), Number(prevue.net)]).toEqual([100_000, 15, 15_000, 85_000]);
    // La demande garde le BRUT (la note d'honoraires) ; le fil dit la retenue.
    expect(Number((await prisma.paymentRequest.findUniqueOrThrow({ where: { id: r.id! } })).amount)).toBe(100_000);
    expect(await prisma.paymentRequestEvent.count({ where: { requestId: r.id!, message: { contains: "net à verser 85" } } })).toBe(1);

    // Le centre autorise, les Finances règlent.
    await comme("pdg");
    expect(err(await decidePayment(fd({ id: ordre.id, decision: "APPROVE" })))).toBeNull();
    await comme("cpt");
    const regle = await settleExpenseOrder(fd({ id: ordre.id }));
    expect(err(regle)).toBeNull();
    expect(regle.message).toMatch(/15.000 DZD à reverser/);

    const paye = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ordre.id } });
    expect(paye.status).toBe("PAID");
    const ecriture = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: paye.transactionId! } });
    expect(Number(ecriture.amount)).toBe(85_000); // la banque verse le net
    expect(ecriture.budgetCategoryId).toBe(ligneMedecins);

    const due = await prisma.retenueSource.findUniqueOrThrow({ where: { expenseOrderId: ordre.id } });
    const mois = moisDeLaRetenue(paye.paidDate!);
    expect(due).toMatchObject({ statut: "A_REVERSER", mois, budgetCategoryId: ligneMedecins });
    const ligne = await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: due.budgetExpenseLineId! } });
    expect(ligne.categoryId).toBe(ligneMedecins);
    expect(Number(ligne.amount)).toBe(15_000);

    // La dépense coûte le BRUT sur sa ligne : l'écriture (net) + la ligne purement budgétaire (retenue).
    const [tx, lignes] = await Promise.all([
      prisma.financeTransaction.aggregate({ where: { budgetCategoryId: ligneMedecins, direction: "OUT", status: "SETTLED" }, _sum: { amount: true } }),
      prisma.budgetExpenseLine.aggregate({ where: { categoryId: ligneMedecins }, _sum: { amount: true } }),
    ]);
    expect(Number(tx._sum.amount) + Number(lignes._sum.amount)).toBe(100_000);

    // « Retenues du mois à reverser » de la société — ce que Impôts & cotisations affichera.
    const aReverser = await retenuesDuMoisAReverser({ companyId: paye.companyId, mois });
    expect(aReverser.lignes.map((l) => l.ordreId)).toContain(ordre.id);
    expect(aReverser.total).toBeGreaterThanOrEqual(15_000);

    // La déclaration qui la porte est payée : reversée, une seule fois.
    expect(await marquerRetenuesReversees({ ids: [due.id], ordreId: "ordre-g50", date: new Date() })).toBe(1);
    expect(await marquerRetenuesReversees({ ids: [due.id], ordreId: "ordre-g50", date: new Date() })).toBe(0);
    expect((await retenuesDuMoisAReverser({ companyId: paye.companyId, mois })).lignes.map((l) => l.ordreId)).not.toContain(ordre.id);
  });

  it("une demande d'avant la règle reste lisible, et ne se transmet qu'une fois sa nature choisie", async () => {
    await comme("dem");
    // Le brouillon d'avant la règle : écrit tel qu'il existe en base, sans nature.
    const ancienne = await prisma.paymentRequest.create({
      data: { reference: `${TAG}-PAY`, title: `${TAG}ancienne`, amount: 20_000, payee: "SARL Atlas", status: "DRAFT", requesterId: u.dem.id, paymentMethodStated: true },
    });
    expect(ancienne.natureDepense).toBeNull();
    expect(libelleNatureDepense(ancienne.natureDepense)).toBe(NATURE_NON_PRECISEE);
    // Sa facture est là : seule la nature manque.
    await prisma.paymentPiece.create({ data: { requestId: ancienne.id, documentId: (await prisma.document.create({ data: { name: "__natures__piece.pdf", entityType: "PAYMENT_REQUEST", entityId: ancienne.id, fileKey: "k", mimeType: "application/pdf", sizeBytes: 1, category: "OTHER", confidentiality: "INTERNAL" } })).id, kind: "INVOICE", position: 0, createdById: u.dem.id } });
    expect(err(await submitPaymentRequest(fd({ id: ancienne.id })))).toBe(REFUS_SANS_NATURE);
    expect(err(await choisirNatureDemande(fd({ id: ancienne.id, natureDepense: "CIRCUITS.TVA" })))).toMatch(/Impôts & cotisations/);
    expect(err(await choisirNatureDemande(fd({ id: ancienne.id, natureDepense: "LOCAUX.NETTOYAGE" })))).toBeNull();
    expect(err(await submitPaymentRequest(fd({ id: ancienne.id })))).toBeNull();
    const ordre = await ordreDe(ancienne.id);
    expect(ordre.category).toBe("CHARGES");
    // L'ordre né, la nature ne se change plus ici.
    expect(err(await choisirNatureDemande(fd({ id: ancienne.id, natureDepense: "LOCAUX.LOYER" })))).toMatch(/déjà au centre/);
  });
});
