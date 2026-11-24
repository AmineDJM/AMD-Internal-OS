import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { lignesChargesFixesAPayer } from "@/lib/queries/action-center-charges-fixes";
import { natureDe } from "@/lib/espace/aujourdhui";
import { contexteDuCentre } from "@/lib/queries/centre-contexte";
import { updateBudgetCategory } from "@/lib/actions/budget-envelope-actions";
import { assurerNaturesMoyensGeneraux } from "@/lib/general-means/natures-store";
import { allowedGeneralMeansCategoryIds, generalMeansBudgetTargets } from "@/lib/general-means/budget-targets";
import { demanderPaiementChargeFixe, enregistrerChargeFixe, libererReserveImprevus } from "./actions-charges-fixes";
import { CODE_ENVELOPPE_ADMINISTRATION, REFUS_RESERVE, chargerChargesFixes, previsionTresorerieChargesFixes, prefillChargesFixesSociete } from "./api";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__chfixes__${Date.now().toString(36)}`;
const ANNEE = new Date().getUTCFullYear();

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (o: Record<string, string | File>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const facture = () => new File([`%PDF ${TAG} ${Math.random()}`], "facture.pdf", { type: "application/pdf" });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHARGES FIXES DES LOCAUX, DE LA SAISIE AU CENTRE DE PAIEMENT (Super Admin, 24/11/2026) — par les vraies actions.
 *
 * Un loyer saisi fait la ligne « Loyer » du budget de l'Administration de SA société ; son échéance apparaît dans
 * « Aujourd'hui » des Finances quinze jours avant ; la facture jointe, l'ordre `FIXED_CHARGE` naît au centre, justifié,
 * imputé, échéance fixe ; une facture « selon facture » au-delà de +10 % alerte le centre ; la réserve pour imprévus ne
 * se libère pas par les Finances ; les moyens généraux passent par société (et la migration y range l'existant).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Charges fixes → budget de l'Administration → paiement mensuel par les Finances", () => {
  let finance: CurrentUser, dg: CurrentUser, sa: CurrentUser;
  let socA = "", socB = "";

  beforeAll(async () => {
    const mk = (s: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [f, g, s] = await Promise.all([mk("fin", "FINANCE_BUDGET_MANAGER"), mk("dg", "GENERAL_MANAGER"), mk("sa", "SUPER_ADMIN")]);
    socA = (await prisma.company.create({ data: { name: `${TAG} Société A`, shortName: `${TAG}A` } })).id;
    socB = (await prisma.company.create({ data: { name: `${TAG} Société B`, shortName: `${TAG}B` } })).id;
    for (const u of [f, g]) await prisma.userCompanyAccess.createMany({ data: [{ userId: u.id, companyId: socA, canEdit: true }, { userId: u.id, companyId: socB, canEdit: true }] });
    finance = await actorFor(f.id, "FINANCE_BUDGET_MANAGER");
    dg = await actorFor(g.id, "GENERAL_MANAGER");
    sa = await actorFor(s.id, "SUPER_ADMIN");
  });

  afterAll(async () => {
    const societes = { in: [socA, socB].filter(Boolean) };
    const ordres = await prisma.expenseOrder.findMany({ where: { companyId: societes }, select: { id: true } });
    const ids = ordres.map((o) => o.id);
    await prisma.paymentPiece.deleteMany({ where: { request: { expenseOrderId: { in: ids } } } }).catch(() => {});
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { expenseOrderId: { in: ids } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ids } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "EXPENSE_ORDER", entityId: { in: ids } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.departmentBudgetExpense.deleteMany({ where: { department: { code: { startsWith: TAG } } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { OR: [{ companyId: societes }, { name: { startsWith: TAG } }] } }).catch(() => {});
    await prisma.chargeFixeSociete.deleteMany({ where: { companyId: societes } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societes } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const enveloppe = (companyId: string) => prisma.budgetEnvelope.findFirstOrThrow({
    where: { companyId, module: CODE_ENVELOPPE_ADMINISTRATION, periodStart: { lte: new Date(Date.UTC(ANNEE, 5, 30)) }, periodEnd: { gte: new Date(Date.UTC(ANNEE, 5, 30)) } },
    include: { categories: true },
  });
  const ligne = async (companyId: string, cle: string) => (await enveloppe(companyId)).categories.find((c) => c.cle === cle && c.parentId === null);

  let loyerId = "";

  it("la saisie d'un loyer fait la ligne « Loyer » du budget de l'Administration de LA BONNE société (12 × le montant)", async () => {
    ACTOR = finance;
    const r = await enregistrerChargeFixe(fd({
      companyId: socA, site: `${TAG} Siège`, nature: "LOYER", beneficiaire: `${TAG} SCI`, rib: "00799999000123456789",
      montant: "450000", periodicite: "MENSUELLE", jourEcheance: "5", dateDebut: `${ANNEE}-01-01`,
    }));
    expect(r.ok, r.error).toBe(true);
    loyerId = (r as { id: string }).id;
    const env = await enveloppe(socA);
    expect(env.managerRoles).toContain("FINANCE_BUDGET_MANAGER");
    expect(Number((await ligne(socA, "LOYER"))?.allocated)).toBe(12 * 450_000);
    // Les lignes de structure sont là : moyens généraux, dons et mécénat, réserve, emprunt (vide).
    for (const cle of ["MOYENS_GENERAUX", "DONS_MECENAT", "RESERVE_IMPREVUS", "REMBOURSEMENT_EMPRUNT"]) expect(await ligne(socA, cle), cle).toBeTruthy();
    // L'autre société n'a rien reçu.
    expect(await prisma.budgetEnvelope.count({ where: { companyId: socB, module: CODE_ENVELOPPE_ADMINISTRATION } })).toBe(0);
    expect(Number(env.totalAmount)).toBeGreaterThanOrEqual(12 * 450_000);
  });

  it("modifier le montant recalcule la ligne (et le changement est tracé)", async () => {
    ACTOR = finance;
    const r = await enregistrerChargeFixe(fd({
      id: loyerId, companyId: socA, site: `${TAG} Siège`, nature: "LOYER", beneficiaire: `${TAG} SCI`, rib: "00799999000123456789",
      montant: "480000", periodicite: "MENSUELLE", jourEcheance: "5", dateDebut: `${ANNEE}-01-01`,
    }));
    expect(r.ok, r.error).toBe(true);
    expect(Number((await ligne(socA, "LOYER"))?.allocated)).toBe(12 * 480_000);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: loyerId, summary: { contains: "→" } } });
    expect(audit?.summary).toContain("480");
    // Le pré-remplissage de la campagne et la prévision de trésorerie lisent la même charge.
    expect((await prefillChargesFixesSociete(socA, ANNEE + 1))[0]).toMatchObject({ key: "CHARGES_FIXES:LOYER", source: "AUTO_CHARGES_FIXES", propose: 12 * 480_000 });
    const prev = await previsionTresorerieChargesFixes([socA], new Date(Date.UTC(ANNEE, 0, 1)));
    expect(prev.every((m) => m.companyId === socA)).toBe(true);
    expect(prev).toHaveLength(12);
  });

  it("l'échéance apparaît dans « Aujourd'hui » des Finances (lot « charges fixes à payer »), pas chez le DG", async () => {
    const lignes = await lignesChargesFixesAPayer(finance);
    const siennes = lignes.filter((l) => l.objet.startsWith(`FIXED_CHARGE:${loyerId}:`));
    expect(siennes.length).toBeGreaterThan(0);
    expect(natureDe({ ...siennes[0], depuis: null })).toBe("charge-fixe");
    expect(siennes[0].href).toContain(`entite=${socA}`);
    expect(await lignesChargesFixesAPayer(dg)).toEqual([]);
  });

  let ordreLoyer = "";
  const periode = `${ANNEE}-03`;

  it("le paiement crée UN ordre FIXED_CHARGE, facture jointe, imputé, échéance fixe, au centre de paiement", async () => {
    ACTOR = dg;
    expect((await demanderPaiementChargeFixe(fd({ chargeId: loyerId, periode, montant: "480000", facture: facture() }))).ok).toBe(false);
    ACTOR = finance;
    expect((await demanderPaiementChargeFixe(fd({ chargeId: loyerId, periode, montant: "480000" }))).error).toMatch(/Joignez la facture/);
    const r = await demanderPaiementChargeFixe(fd({ chargeId: loyerId, periode, montant: "480000", facture: facture() }));
    expect(r.ok, r.error).toBe(true);
    const ech = await prisma.echeanceChargeFixe.findUniqueOrThrow({ where: { chargeId_periode: { chargeId: loyerId, periode } } });
    const o = await prisma.expenseOrder.findUniqueOrThrow({ where: { id: ech.expenseOrderId as string } });
    ordreLoyer = o.id;
    expect(o).toMatchObject({ sourceType: "FIXED_CHARGE", sourceId: ech.id, companyId: socA, category: "LOYER", deadlineNature: "FIXED", centralStatus: "AWAITING", requiresInvoice: true });
    expect(o.budgetCategoryId).toBe((await ligne(socA, "LOYER"))?.id);
    expect(await prisma.document.count({ where: { entityType: "EXPENSE_ORDER", entityId: o.id, category: "INVOICE" } })).toBe(1);
    // L'état de l'échéance se lit sur l'ordre ; on ne la redemande pas tant qu'il vit.
    const vue = (await chargerChargesFixes([socA], finance)).get(socA)!;
    expect(vue.echeances.find((e) => e.periode === periode)?.etat ?? "AU_CENTRE").toBe("AU_CENTRE");
    expect((await demanderPaiementChargeFixe(fd({ chargeId: loyerId, periode, montant: "480000", facture: facture() }))).error).toMatch(/déjà demandé/);
    // Elle ne reste pas dans « Aujourd'hui ».
    expect((await lignesChargesFixesAPayer(finance)).some((l) => l.objet === `FIXED_CHARGE:${loyerId}:${periode}`)).toBe(false);
  });

  it("au centre : une facture « selon facture » au-delà de +10 % de l'estimation porte l'alerte", async () => {
    ACTOR = finance;
    const r = await enregistrerChargeFixe(fd({
      companyId: socA, site: `${TAG} Siège`, nature: "ELECTRICITE", beneficiaire: `${TAG} Sonelgaz`, modeMontant: "SELON_FACTURE",
      montant: "100000", periodicite: "TRIMESTRIELLE", moisEcheance: "1", jourEcheance: "20", dateDebut: `${ANNEE}-01-01`,
    }));
    expect(r.ok, r.error).toBe(true);
    const elecId = (r as { id: string }).id;
    const p = await demanderPaiementChargeFixe(fd({ chargeId: elecId, periode: `${ANNEE}-04`, montant: "125000", facture: facture() }));
    expect(p.ok, p.error).toBe(true);
    const ech = await prisma.echeanceChargeFixe.findUniqueOrThrow({ where: { chargeId_periode: { chargeId: elecId, periode: `${ANNEE}-04` } } });
    const [fiche] = await contexteDuCentre([ech.expenseOrderId as string], sa, socA);
    expect(fiche.origine).toBe("Charges fixes · Électricité");
    expect(fiche.alertes.map((a) => a.titre)).toContain("Facture au-dessus de l'estimation");
    // Le loyer à son montant fixe : aucune alerte d'écart.
    const [loyer] = await contexteDuCentre([ordreLoyer], sa, socA);
    expect(loyer.alertes.map((a) => a.titre)).not.toContain("Montant au-dessus du montant fixe");
  });

  it("la réserve pour imprévus : budgétée par les Finances, libérée par le DG seulement", async () => {
    const reserve = (await ligne(socA, "RESERVE_IMPREVUS"))!;
    ACTOR = finance;
    // Les Finances la budgètent (monter)…
    expect((await updateBudgetCategory(fd({ id: reserve.id, name: reserve.name, allocated: "300000" }))).ok).toBe(true);
    // … mais ni la baisser ni la libérer.
    expect((await updateBudgetCategory(fd({ id: reserve.id, name: reserve.name, allocated: "100000" }))).error).toBe(REFUS_RESERVE);
    const dons = (await ligne(socA, "DONS_MECENAT"))!;
    const env = await enveloppe(socA);
    expect((await libererReserveImprevus(fd({ envelopeId: env.id, cibleId: dons.id, montant: "50000", motif: "séisme" }))).error).toBe(REFUS_RESERVE);
    expect(Number((await ligne(socA, "RESERVE_IMPREVUS"))?.allocated)).toBe(300_000);
    // Le DG la libère.
    ACTOR = dg;
    const r = await libererReserveImprevus(fd({ envelopeId: env.id, cibleId: dons.id, montant: "50000", motif: "aide aux sinistrés" }));
    expect(r.ok, r.error).toBe(true);
    expect(Number((await ligne(socA, "RESERVE_IMPREVUS"))?.allocated)).toBe(250_000);
    expect(Number((await ligne(socA, "DONS_MECENAT"))?.allocated)).toBe(50_000);
  });

  it("les moyens généraux sont PAR SOCIÉTÉ, dans le budget de l'Administration — sans les autres lignes", async () => {
    const mg = await assurerNaturesMoyensGeneraux(socB);
    expect(mg).toBeTruthy();
    const natures = await prisma.budgetCategoryLine.findMany({ where: { parentId: mg as string } });
    expect(natures.some((n) => n.cle?.startsWith("MG_"))).toBe(true);
    const cibles = await generalMeansBudgetTargets(socB);
    expect(cibles.some((c) => c.label.includes("Moyens généraux"))).toBe(true);
    expect(cibles.some((c) => /Loyer|Réserve|Dons/.test(c.label))).toBe(false);
    // Une nature de la société A n'est pas une case permise pour la société B.
    await assurerNaturesMoyensGeneraux(socA);
    const permisesB = await allowedGeneralMeansCategoryIds(socB);
    const natureA = await prisma.budgetCategoryLine.findFirstOrThrow({ where: { envelope: { companyId: socA, module: CODE_ENVELOPPE_ADMINISTRATION }, cle: { startsWith: "MG_" } } });
    expect(permisesB.has(natureA.id)).toBe(false);
  });

  it("la migration range l'ancienne enveloppe « Moyens généraux » par société, sans perte", async () => {
    // Une enveloppe « moyens généraux » à l'ancienne (un an plus tôt), une catégorie, une dépense d'un département de la
    // société B, une dépense d'un département SANS société.
    const annee = ANNEE - 3;
    const ancienne = await prisma.budgetEnvelope.create({
      data: { name: `${TAG} Moyens généraux`, module: "GENERAL_MEANS", modules: ["GENERAL_MEANS"], companyId: socB, periodStart: new Date(Date.UTC(annee, 0, 1)), periodEnd: new Date(Date.UTC(annee, 11, 31)), totalAmount: 90_000 },
    });
    const cat = await prisma.budgetCategoryLine.create({ data: { envelopeId: ancienne.id, name: "Fournitures", cle: "MG_FOURNITURES", allocated: 40_000, module: "GENERAL_MEANS" } });
    const depB = await prisma.department.create({ data: { name: `${TAG} Admin B`, code: `${TAG}B`, companyId: socB } });
    const depSans = await prisma.department.create({ data: { name: `${TAG} Sans`, code: `${TAG}S` } });
    const e1 = await prisma.departmentBudgetExpense.create({ data: { departmentId: depB.id, year: annee, label: "Ramettes", amount: 3_000, budgetCategoryId: cat.id } });
    const e2 = await prisma.departmentBudgetExpense.create({ data: { departmentId: depSans.id, year: annee, label: "Stylos", amount: 500, budgetCategoryId: cat.id } });

    const sql = readFileSync("prisma/migrations/20270249000000_charges_fixes_administration/migration.sql", "utf8");
    const bloc = sql.slice(sql.indexOf("DO $$\nDECLARE"));
    await prisma.$executeRawUnsafe(bloc);
    await prisma.$executeRawUnsafe(bloc); // idempotente : le second passage ne trouve plus rien à basculer

    const apres = await prisma.departmentBudgetExpense.findUniqueOrThrow({ where: { id: e1.id }, include: { budgetCategory: { include: { parent: true, envelope: true } } } });
    expect(apres.budgetCategory?.cle).toBe("MG_FOURNITURES");
    expect(apres.budgetCategory?.parent?.cle).toBe("MOYENS_GENERAUX");
    expect(apres.budgetCategory?.envelope).toMatchObject({ companyId: socB, module: CODE_ENVELOPPE_ADMINISTRATION });
    // La dépense sans société reste sur l'ancienne enveloppe, qui garde ses montants mais perd la marque.
    expect((await prisma.departmentBudgetExpense.findUniqueOrThrow({ where: { id: e2.id } })).budgetCategoryId).toBe(cat.id);
    const relue = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { id: ancienne.id }, include: { categories: true } });
    expect(relue.modules).not.toContain("GENERAL_MEANS");
    expect(relue.module).toBeNull();
    expect(Number(relue.categories[0].allocated)).toBe(40_000);
    expect(await prisma.budgetEnvelope.count({ where: { companyId: socB, module: CODE_ENVELOPPE_ADMINISTRATION, periodStart: new Date(Date.UTC(annee, 0, 1)) } })).toBe(1);
  });
});
