import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getBudgetOverview } from "@/lib/queries/budget";
import { depensesPostesMarketing } from "@/lib/queries/budget-marketing-depenses";
import {
  annulerDepensePoste, changerBudgetDepensePoste, consommerDepensePoste, imputerDepensePoste,
} from "@/lib/actions/budget-depense-poste-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `__depmkt${Date.now().toString(36)}__`;
const TAG = RUN;

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | File>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], nom, { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LA DÉPENSE D'UN POSTE, PAR LES VRAIS POINTS D'ENTRÉE (maquette validée, 10/2026).
 *
 * BC signés → À imputer ; imputer → Engagée ; changer de budget (le poste, son ordre, son écriture suivent) ;
 * consommer (avec ou sans facture) → un ordre au centre de paiement ; un second envoi refusé, même simultané ;
 * annuler ; annuler refusé après consommation. Les totaux de la vue d'ensemble suivent à chaque pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Budget Marketing — la dépense d'un poste Ad & Pro, de l'imputation au paiement", () => {
  let pmId = "", finId = "", envId = "", catA = "", catB = "", eventId = "";
  const postes: Record<"p1" | "p2" | "p3", string> = { p1: "", p2: "", p3: "" };
  let bcNonSigne = "";
  const docs: string[] = [];
  const ecritures: string[] = [];

  const commePm = async () => { ACTOR = await actorFor(pmId, "PRODUCT_MANAGER"); };
  const ligne = async (id: string) => {
    const ov = await getBudgetOverview(ACTOR as SessionUser, envId, null, null, { portee: "MARKETING" });
    const { donnees } = await depensesPostesMarketing(ACTOR as SessionUser, ov!);
    return { ligne: donnees.lignes.find((l) => l.id === id) ?? null, ov: ov!, donnees };
  };
  const engageDe = (ov: NonNullable<Awaited<ReturnType<typeof getBudgetOverview>>>, cat: string) => ov.categories.find((c) => c.id === cat)?.committed ?? 0;

  async function nouveauPoste(label: string, bcs: { ref: string; montant: number; signe: boolean }[]): Promise<string> {
    const p = await prisma.adProItem.create({
      data: { label: `${TAG}${label}`, eventId, kind: "STAND", status: "APPROVED", amountGranted: 6_000_000, supplier: "Expo Events DZ" },
    });
    for (const b of bcs) {
      const d = await prisma.legalDocument.create({
        data: { title: `${TAG}${b.ref}`, kind: "PURCHASE_ORDER", reference: `${TAG}${b.ref}`, amount: b.montant, counterparty: "Expo Events DZ", signedAt: b.signe ? new Date() : null },
      });
      docs.push(d.id);
      if (!b.signe) bcNonSigne = d.id;
      await prisma.adProItemPiece.create({ data: { itemId: p.id, legalDocumentId: d.id, nature: "BON_DE_COMMANDE" } });
    }
    return p.id;
  }

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    pmId = (await mk("pm", "PRODUCT_MANAGER")).id;
    finId = (await mk("fin", "FINANCE_BUDGET_MANAGER")).id;
    const annee = new Date().getUTCFullYear();
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN} Budget Marketing`, domaine: "MARKETING", periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31, 23, 59)), totalAmount: 48_000_000 },
    });
    envId = env.id;
    catA = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Sponsoring`, allocated: 20_000_000 } })).id;
    catB = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événements`, allocated: 20_000_000 } })).id;
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journées de cardiologie` } })).id;
    postes.p1 = await nouveauPoste("Stand 18 m²", [{ ref: "BC1", montant: 4_200_000, signe: true }, { ref: "BC2", montant: 180_000, signe: false }]);
    postes.p2 = await nouveauPoste("Impression", [{ ref: "BC3", montant: 950_000, signe: true }]);
    postes.p3 = await nouveauPoste("Dîner-débat", [{ ref: "BC4", montant: 680_000, signe: true }]);
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(postes).filter(Boolean);
    const pieces = await prisma.adProItemPiece.findMany({ where: { itemId: { in: ids } }, select: { legalDocumentId: true } }).catch(() => []);
    const tousDocs = [...new Set([...docs, ...pieces.map((p) => p.legalDocumentId)])];
    await prisma.document.deleteMany({ where: { entityId: { in: tousDocs } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: ids } } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: ids } }, data: { expenseOrderId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: tousDocs } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: eventId }, select: { id: true } }).catch(() => []);
    const dossiers = await prisma.paymentRequest.findMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } }, select: { id: true } }).catch(() => []);
    await prisma.paymentRequestEvent.deleteMany({ where: { requestId: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: dossiers.map((d) => d.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.financeTransaction.deleteMany({ where: { id: { in: ecritures } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: tousDocs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...ids, eventId, envId] } }, { actorId: { in: [pmId, finId] } }] } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [pmId, finId] } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [pmId, finId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("BC pas tous signés : hors de l'écran ; tous signés : « À imputer », sans peser sur le budget", async () => {
    await commePm();
    expect((await ligne(postes.p1)).ligne).toBeNull();
    await prisma.legalDocument.update({ where: { id: bcNonSigne }, data: { signedAt: new Date() } });
    const { ligne: l, ov } = await ligne(postes.p1);
    expect(l).toMatchObject({ etat: "A_IMPUTER", montantEngage: 4_380_000, categorieId: null });
    expect(l!.bcs.map((b) => b.reference)).toEqual([`${TAG}BC1`, `${TAG}BC2`]);
    expect(ov.totals.committed).toBe(0);
  });

  it("imputer : la Direction Marketing seule ; la dépense devient ENGAGÉE pour la somme de ses BC signés", async () => {
    ACTOR = await actorFor(finId, "FINANCE_BUDGET_MANAGER");
    const refuse = await imputerDepensePoste(form({ id: postes.p1, categorieId: catA }));
    expect(refuse.ok).toBe(false);

    await commePm();
    const r = await imputerDepensePoste(form({ id: postes.p1, categorieId: catA }));
    expect(r.ok, r.error).toBe(true);
    const { ligne: l, ov, donnees } = await ligne(postes.p1);
    expect(l).toMatchObject({ etat: "ENGAGEE", categorieId: catA });
    expect(engageDe(ov, catA)).toBe(4_380_000);
    expect(donnees.tuiles).toMatchObject({ engage: 4_380_000, consomme: 0, disponible: 48_000_000 - 4_380_000 });
    // Une seconde imputation n'en est pas une : on change de budget.
    expect((await imputerDepensePoste(form({ id: postes.p1, categorieId: catB }))).ok).toBe(false);
  });

  it("changer de budget : à tout moment, tracé ancien → nouveau, et les totaux suivent", async () => {
    await commePm();
    const r = await changerBudgetDepensePoste(form({ id: postes.p1, categorieId: catB }));
    expect(r.ok, r.error).toBe(true);
    const { ov } = await ligne(postes.p1);
    expect(engageDe(ov, catA)).toBe(0);
    expect(engageDe(ov, catB)).toBe(4_380_000);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: postes.p1, field: "depense-imputation", oldValue: catA, newValue: catB } });
    expect(trace?.summary).toMatch(/→/);
    expect((await changerBudgetDepensePoste(form({ id: postes.p1, categorieId: catB }))).ok).toBe(false);
  });

  it("consommer sans facture : un ordre naît au centre de paiement ; la différence est rendue au budget", async () => {
    await commePm();
    expect((await consommerDepensePoste(form({ id: postes.p1, montant: "5000000" }))).ok, "pas plus que l'engagé").toBe(false);
    const r = await consommerDepensePoste(form({ id: postes.p1, montant: "4000000" }));
    expect(r.ok, r.error).toBe(true);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: postes.p1 } });
    const ordre = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: poste.expenseOrderId! } });
    expect(ordre).toMatchObject({ status: "PENDING", centralStatus: "AWAITING", budgetCategoryId: catB, requiresInvoice: true });
    expect(Number(ordre.amount)).toBe(4_000_000);
    expect(poste.orderStage).toBe("ISSUED");
    const { ligne: l, ov, donnees } = await ligne(postes.p1);
    expect(l).toMatchObject({ etat: "CONSOMMEE", lieu: "CENTRE_PAIEMENT", consomme: 4_000_000, facture: null });
    expect(engageDe(ov, catB)).toBe(4_000_000);
    expect(ov.totals.enCircuit).toBe(4_000_000);
    expect(donnees.tuiles).toMatchObject({ engage: 0, consomme: 4_000_000, disponible: 44_000_000 });
  });

  it("un second « Consommer » est refusé : un seul ordre", async () => {
    await commePm();
    const r = await consommerDepensePoste(form({ id: postes.p1, montant: "100" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/déjà consommée/);
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId, label: { contains: "Stand" } } })).toBe(1);
  });

  it("annuler est refusé une fois la dépense consommée", async () => {
    await commePm();
    const r = await annulerDepensePoste(form({ id: postes.p1 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ne s'annule plus/);
  });

  it("changer de budget après paiement : l'ordre et l'écriture réglée suivent le poste", async () => {
    await commePm();
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: postes.p1 } });
    await prisma.expenseOrder.update({ where: { id: poste.expenseOrderId! }, data: { centralStatus: "APPROVED" } });
    expect((await ligne(postes.p1)).ligne?.lieu).toBe("FINANCES");
    const tx = await prisma.financeTransaction.create({
      data: { reference: `${TAG}FIN`, direction: "OUT", category: "EVENEMENT", label: `${TAG}règlement`, amount: 4_000_000, status: "SETTLED", budgetCategoryId: catB },
    });
    ecritures.push(tx.id);
    await prisma.expenseOrder.update({ where: { id: poste.expenseOrderId! }, data: { status: "PAID", transactionId: tx.id, paidDate: new Date() } });
    expect((await ligne(postes.p1)).ligne).toMatchObject({ etat: "PAYEE", paye: 4_000_000 });

    const r = await changerBudgetDepensePoste(form({ id: postes.p1, categorieId: catA }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.expenseOrder.findUniqueOrThrow({ where: { id: poste.expenseOrderId! } })).budgetCategoryId).toBe(catA);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: tx.id } })).budgetCategoryId).toBe(catA);
    const { ov, donnees } = await ligne(postes.p1);
    expect(ov.categories.find((c) => c.id === catA)?.consumed).toBe(4_000_000);
    expect(ov.categories.find((c) => c.id === catB)?.consumed ?? 0).toBe(0);
    expect(donnees.tuiles).toMatchObject({ consomme: 4_000_000, paye: 4_000_000 });
  });

  it("annuler une dépense engagée : l'engagement est libéré, le motif gardé", async () => {
    await commePm();
    expect((await imputerDepensePoste(form({ id: postes.p2, categorieId: catA }))).ok).toBe(true);
    expect(engageDe((await ligne(postes.p2)).ov, catA)).toBe(950_000);
    const r = await annulerDepensePoste(form({ id: postes.p2, motif: "Événement reporté" }));
    expect(r.ok, r.error).toBe(true);
    const { ligne: l, ov } = await ligne(postes.p2);
    expect(l).toMatchObject({ etat: "ANNULEE", motif: "Événement reporté" });
    expect(engageDe(ov, catA)).toBe(0);
    expect((await annulerDepensePoste(form({ id: postes.p2 }))).ok).toBe(false);
    expect((await consommerDepensePoste(form({ id: postes.p2, montant: "10" }))).ok).toBe(false);
  });

  it("consommer avec facture, deux envois simultanés : un seul passe, la facture est sur l'ordre", async () => {
    await commePm();
    expect((await imputerDepensePoste(form({ id: postes.p3, categorieId: catB }))).ok).toBe(true);
    const envoi = () => consommerDepensePoste(form({ id: postes.p3, montant: "680000", facture: pdf(`${TAG}FA-0912.pdf`) }));
    const [a, b] = await Promise.all([envoi(), envoi()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: postes.p3 } });
    expect(await prisma.expenseOrder.count({ where: { sourceId: eventId, label: { contains: "Dîner" } } })).toBe(1);
    const facture = await prisma.legalDocument.findFirstOrThrow({ where: { kind: "INVOICE", expenseOrderId: poste.expenseOrderId!, status: { not: "CANCELLED" } } });
    docs.push(facture.id);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE" } })).toBe(1);
    const { ligne: l } = await ligne(postes.p3);
    expect(l).toMatchObject({ etat: "CONSOMMEE", consomme: 680_000 });
    expect(l?.facture?.nom).toMatch(/FA-0912/);
  });
});
