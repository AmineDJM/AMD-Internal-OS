import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR,
  getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  ajusterImpotCampagne, enregistrerRecetteCampagne, reglerParametresImpotsCampagne, reglerTvaLigneDepense, supprimerRecetteCampagne,
} from "@/lib/actions/budget-campagne-recettes-actions";
import { changerStatutCampagne, enregistrerLigneProposition, preremplirProposition } from "@/lib/actions/budget-campagne-actions";
import { ouvrirEnveloppeDeLaProposition } from "@/lib/budget-campagne/enveloppes";
import { vueRecettesPour, vueSynthesePour } from "@/lib/budget-campagne/recettes-requetes";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const RUN = `__recettes__${Date.now().toString(36)}`;
const YEAR = 2036;

const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE PRÉVOIT LES RECETTES ET LES DÉPENSES (Super Admin, 24/11/2026) — par les vrais points d'entrée :
 * le DG saisit une recette ; le directeur des opérations est refusé sur les recettes et les impôts mais saisit ses
 * dépenses ; chacun ne lit que les recettes de SA société ; la synthèse (résultat, IBS, TVA) est au Super Admin / DG ;
 * la clôture fige les recettes, devenues la référence de l'exercice.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("campagne budgétaire — recettes, impôts et résultat prévisionnel", () => {
  const u: Record<string, string> = {};
  let socA = "", socB = "", depOps = "", depB = "", campagne = "", propOps = "", propB = "", produit = "";

  beforeAll(async () => {
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${RUN} ${k}`, email: `${RUN}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([mk("sa", "SUPER_ADMIN"), mk("dg", "GENERAL_MANAGER"), mk("ops", "OPERATIONS_DIRECTOR"), mk("dirB", "OPERATIONS_DIRECTOR"), mk("autre", "MEDICAL_DELEGATE")]);
    socA = (await prisma.company.create({ data: { name: `${RUN} Adventum`, shortName: `${RUN}A` } })).id;
    socB = (await prisma.company.create({ data: { name: `${RUN} Pharmagène`, shortName: `${RUN}B` } })).id;
    const empOps = await prisma.employee.create({ data: { fullName: `${RUN} Ops`, companyId: socA, userId: u.ops } });
    const empB = await prisma.employee.create({ data: { fullName: `${RUN} DirB`, companyId: socB, userId: u.dirB } });
    depOps = (await prisma.department.create({ data: { name: `${RUN} Opérations`, code: `${RUN}OPS`, companyId: socA, headId: empOps.id } })).id;
    depB = (await prisma.department.create({ data: { name: `${RUN} Opérations B`, code: `${RUN}OPSB`, companyId: socB, headId: empB.id } })).id;
    const c = await prisma.budgetCampaign.create({
      data: {
        year: YEAR, title: `${RUN} Campagne`, opensAt: new Date(), submitDeadline: new Date(Date.now() + 9e8), validationDeadline: new Date(Date.now() + 2e9),
        status: "OPEN", validatorIds: [u.dg, u.sa],
        proposals: { create: [{ departmentId: depOps, poleLabel: `${RUN} Opérations`, domaine: "OPERATIONS" }, { departmentId: depB, poleLabel: `${RUN} Opérations B`, domaine: "OPERATIONS" }] },
      },
      include: { proposals: true },
    });
    campagne = c.id;
    propOps = c.proposals.find((p) => p.departmentId === depOps)!.id;
    propB = c.proposals.find((p) => p.departmentId === depB)!.id;
    produit = (await prisma.product.create({ data: { code: `${RUN}P1`, canonicalName: `${RUN} Nivolumab 100 mg`, dci: "nivolumab", identityKey: `${RUN}nivo`, companyId: socA } })).id;
    await prisma.productPrice.create({ data: { productId: produit, kind: "PRIX_HOPITAL", amountDzd: 1000, validFrom: new Date("2030-01-01") } });
  }, 60_000);

  afterAll(async () => {
    await prisma.budgetCampaign.deleteMany({ where: { title: { startsWith: RUN } } }).catch(() => {});
    await prisma.productPrice.deleteMany({ where: { productId: produit } }).catch(() => {});
    await prisma.product.deleteMany({ where: { identityKey: { startsWith: RUN } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { code: { startsWith: RUN } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: RUN } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: Object.values(u) } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: RUN } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
  }, 60_000);

  it("le DG saisit une recette : quantité × prix hôpital du produit, BU et clé de rapprochement", async () => {
    ACTOR = await acteur(u.dg, "GENERAL_MANAGER");
    const r = await enregistrerRecetteCampagne(fd({ campaignId: campagne, companyId: socA, mois: "1", productId: produit, quantite: "100" }));
    expect(r).toMatchObject({ ok: true });
    const l = await prisma.budgetCampaignRevenue.findFirstOrThrow({ where: { campaignId: campagne, companyId: socA } });
    expect(Number(l.amount)).toBe(100_000);
    expect(Number(l.unitPrice)).toBe(1000);
    expect(l.priceSource).toBe("PRIX_HOPITAL");
    expect(l.client).toBe("PCH");
    expect(l.matchKey).toBe(`${socA}|${YEAR}-01|P:${produit}|pch`);
    // La même clé remplace, ne double pas.
    await enregistrerRecetteCampagne(fd({ campaignId: campagne, companyId: socA, mois: "1", productId: produit, quantite: "120" }));
    expect(await prisma.budgetCampaignRevenue.count({ where: { campaignId: campagne, companyId: socA } })).toBe(1);
    // Toute l'année, montant direct : douze lignes, au centime près.
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect(await enregistrerRecetteCampagne(fd({ campaignId: campagne, companyId: socB, mois: "ANNEE", label: "Divers", montant: "120000", tvaPct: "0" }))).toMatchObject({ ok: true });
    const b = await prisma.budgetCampaignRevenue.findMany({ where: { campaignId: campagne, companyId: socB } });
    expect(b).toHaveLength(12);
    expect(b.reduce((a, x) => a + Number(x.amount), 0)).toBe(120_000);
  });

  it("le directeur des opérations est refusé sur les recettes et les impôts, mais saisit ses dépenses", async () => {
    ACTOR = await acteur(u.ops, "OPERATIONS_DIRECTOR");
    const refus = await enregistrerRecetteCampagne(fd({ campaignId: campagne, companyId: socA, mois: "2", label: "x", montant: "1" }));
    expect(refus.ok).toBe(false);
    expect(refus.error).toMatch(/Super Admin et la Direction générale/);
    expect((await ajusterImpotCampagne(fd({ campaignId: campagne, companyId: socA, cle: "AUTRES_TAXES", mois: "1", montant: "5" }))).ok).toBe(false);
    expect((await reglerParametresImpotsCampagne(fd({ campaignId: campagne, ibsTauxDefaut: "0" }))).ok).toBe(false);
    const l = await prisma.budgetCampaignRevenue.findFirstOrThrow({ where: { campaignId: campagne, companyId: socA } });
    expect((await supprimerRecetteCampagne(fd({ id: l.id }))).ok).toBe(false);
    // Ses dépenses, comme avant : 1 200 000 / an.
    expect(await enregistrerLigneProposition(fd({ proposalId: propOps, label: "Missions terrain", propose: "1200000" }))).toMatchObject({ ok: true });
    ACTOR = await acteur(u.dirB, "OPERATIONS_DIRECTOR");
    expect(await enregistrerLigneProposition(fd({ proposalId: propB, label: "Locaux", propose: "12000" }))).toMatchObject({ ok: true });
  });

  it("cloisonnement : chaque directeur lit les recettes de SA société seule ; un tiers rien ; la synthèse leur est fermée", async () => {
    const vOps = await vueRecettesPour(await acteur(u.ops, "OPERATIONS_DIRECTOR"), campagne);
    expect(vOps.kind).toBe("ok");
    if (vOps.kind === "ok") {
      expect(vOps.droits.saisit).toBe(false);
      expect(vOps.catalogue).toBeNull();
      expect(vOps.societes.map((s) => s.id)).toEqual([socA]);
      expect(new Set(vOps.lignes.map((l) => l.companyId))).toEqual(new Set([socA]));
    }
    const vB = await vueRecettesPour(await acteur(u.dirB, "OPERATIONS_DIRECTOR"), campagne);
    expect(vB.kind === "ok" && vB.lignes.every((l) => l.companyId === socB) && vB.lignes.length === 12).toBe(true);
    expect((await vueRecettesPour(await acteur(u.autre, "MEDICAL_DELEGATE"), campagne)).kind).toBe("interdit");
    expect((await vueSynthesePour(await acteur(u.ops, "OPERATIONS_DIRECTOR"), campagne)).kind).toBe("interdit");
    // Le DG, lui, voit les deux sociétés et saisit.
    const vDg = await vueRecettesPour(await acteur(u.dg, "GENERAL_MANAGER"), campagne);
    expect(vDg.kind === "ok" && vDg.droits.saisit && [socA, socB].every((id) => vDg.societes.some((s) => s.id === id))).toBe(true);
  });

  it("synthèse par société : ventes HT − achats HT = résultat avant impôt ; − IBS = net ; TVA à reverser hors résultat", async () => {
    const dg = await acteur(u.dg, "GENERAL_MANAGER");
    ACTOR = dg;
    // Le DG règle la TVA d'un achat (les missions : 0 %) ; celui de B garde le défaut (19 %, contenu dans le TTC).
    const ligneOps = await prisma.budgetProposalLine.findFirstOrThrow({ where: { proposalId: propOps } });
    expect(await reglerTvaLigneDepense(fd({ lineId: ligneOps.id, tvaPct: "0" }))).toMatchObject({ ok: true });
    const v = await vueSynthesePour(dg, campagne);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    const a = v.previsions.find((p) => p.companyId === socA)!;
    const b = v.previsions.find((p) => p.companyId === socB)!;
    expect(a.recettesHT[0]).toBe(120_000);
    expect(a.depenses[0]).toBe(100_000);
    expect(a.resultatAvantImpot[0]).toBe(20_000);
    expect(a.totaux.resultatAvantImpot).toBe(120_000 - 1_200_000);
    expect(a.totaux.ibs).toBe(0); // une perte ne paie pas d'IBS
    // B : 12 000 TTC à 19 % contiennent 1 915,97 de TVA déductible ; l'achat compte HT dans le résultat.
    expect(b.tvaDeductible[0]).toBe(159.66);
    expect(b.totaux.resultatAvantImpot).toBe(109_915.97);
    expect(b.totaux.ibs).toBe(28_578.15); // 26 % préréglé
    expect(b.totaux.resultatNet).toBe(109_915.97 - 28_578.15);
    // TVA nette de A en janvier : 19 % de 120 000 collectés, rien à déduire — 22 800 à reverser, hors résultat.
    expect(a.impots.TVA_NETTE[0]!.calcule).toBe(22_800);
    expect(a.tvaAReverser[0]).toBe(22_800);
    expect(Object.keys(a.impots)).toEqual(["TVA_NETTE", "IBS"]);

    // Le DG règle un taux propre pour B et ajuste la TVA de janvier de A (écart tracé).
    expect(await reglerParametresImpotsCampagne(fd({ campaignId: campagne, ibsSociete: socB, ibsTaux: "19" }))).toMatchObject({ ok: true });
    expect((await reglerParametresImpotsCampagne(fd({ campaignId: campagne, tvaRecettes: "7" }))).error).toMatch(/0, 9 ou 19/);
    expect(await ajusterImpotCampagne(fd({ campaignId: campagne, companyId: socA, cle: "TVA_NETTE", mois: "1", montant: "20000", motif: "régularisation" }))).toMatchObject({ ok: true });
    expect((await ajusterImpotCampagne(fd({ campaignId: campagne, companyId: socA, cle: "CNAS", mois: "1", montant: "1" }))).ok).toBe(false);
    const t = await prisma.budgetCampaignTaxLine.findFirstOrThrow({ where: { campaignId: campagne, companyId: socA, key: "TVA_NETTE", month: 1 } });
    expect(Number(t.computedAmount)).toBe(22_800);
    expect(Number(t.amount)).toBe(20_000);
    const v2 = await vueSynthesePour(dg, campagne);
    if (v2.kind !== "ok") throw new Error("synthèse fermée");
    expect(v2.previsions.find((p) => p.companyId === socB)!.totaux.ibs).toBe(20_884.03);
    expect(v2.previsions.find((p) => p.companyId === socA)!.impots.TVA_NETTE[0]).toEqual({ calcule: 22_800, retenu: 20_000, ajuste: true });
  });

  it("la masse salariale inclut l'IRG et la CNAS des fiches, affichés à part, et boucle sur le coût employeur", async () => {
    await prisma.employee.updateMany({
      where: { userId: u.ops },
      data: { departmentId: depOps, netToPay: 76_000, retIrg: 15_000, retSS9: 9_000, retSS35: 35_000, employerCost: 126_000 },
    });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect(await preremplirProposition(fd({ proposalId: propOps }))).toMatchObject({ ok: true });
    const lignes = await prisma.budgetProposalLine.findMany({ where: { proposalId: propOps, source: "AUTO_PAIE" }, orderBy: { key: "asc" } });
    expect(lignes.map((l) => [l.key, l.categoryKey, Number(l.propose)])).toEqual([
      ["PAIE", "MASSE_SALARIALE_FDV", 912_000], ["PAIE_CNAS", "MS_CNAS", 420_000], ["PAIE_IRG", "MS_IRG", 180_000],
    ]);
    const v = await vueSynthesePour(await acteur(u.dg, "GENERAL_MANAGER"), campagne);
    if (v.kind !== "ok") throw new Error("synthèse fermée");
    const a = v.previsions.find((p) => p.companyId === socA)!;
    expect(a.masseSalariale).toEqual({ netEtPrimes: 912_000, irg: 180_000, cnas: 420_000, total: 1_512_000 });
    expect(a.controleMasseSalariale).toMatchObject({ coutEmployeur: 1_512_000, boucle: true });
  });

  it("le budget de l'Administration : dons et mécénat, réserve pour imprévus, emprunt ; enveloppe tenue par les Finances", async () => {
    const depAdm = (await prisma.department.create({ data: { name: `${RUN} Administration`, code: `${RUN}ADM`, companyId: socA } })).id;
    const prop = await prisma.budgetProposal.create({ data: { campaignId: campagne, departmentId: depAdm, poleLabel: `${RUN} Administration` } });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect(await preremplirProposition(fd({ proposalId: prop.id }))).toMatchObject({ ok: true });
    const lignes = await prisma.budgetProposalLine.findMany({ where: { proposalId: prop.id }, orderBy: { sortOrder: "asc" } });
    expect(lignes.map((l) => l.categoryKey)).toEqual(["DONS_MECENAT", "RESERVE_IMPREVUS", "REMBOURSEMENT_EMPRUNT"]);
    await prisma.budgetProposalLine.updateMany({ where: { proposalId: prop.id, key: "RESERVE_IMPREVUS" }, data: { propose: 500_000 } });
    await prisma.budgetProposal.update({ where: { id: prop.id }, data: { status: "ACCEPTE" } });
    expect((await ouvrirEnveloppeDeLaProposition(prop.id, u.sa)).ok).toBe(true);
    const env = await prisma.budgetEnvelope.findFirstOrThrow({ where: { id: (await prisma.budgetProposal.findUniqueOrThrow({ where: { id: prop.id } })).envelopeId! }, include: { categories: true } });
    expect(env.managerRoles).toContain("FINANCE_BUDGET_MANAGER");
    expect(env.companyId).toBe(socA);
    // Seule la ligne budgétée ouvre sa catégorie, avec sa clé reconnue (une ligne vide n'en ouvre pas).
    expect(env.categories.map((c) => c.cle)).toEqual(["RESERVE_IMPREVUS"]);
    await prisma.budgetProposal.update({ where: { id: prop.id }, data: { envelopeId: null } });
    await prisma.budgetEnvelope.delete({ where: { id: env.id } });
  });

  it("à la clôture, les recettes se figent : elles sont la référence de l'exercice", async () => {
    await prisma.budgetProposal.updateMany({ where: { campaignId: campagne }, data: { status: "REFUSE" } });
    await prisma.budgetCampaign.update({ where: { id: campagne }, data: { status: "ARBITRAGE" } });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect(await changerStatutCampagne(fd({ id: campagne, statut: "CLOSED" }))).toMatchObject({ ok: true });
    expect((await prisma.budgetCampaign.findUniqueOrThrow({ where: { id: campagne } })).recettesFigeesLe).not.toBeNull();
    ACTOR = await acteur(u.dg, "GENERAL_MANAGER");
    const r = await enregistrerRecetteCampagne(fd({ campaignId: campagne, companyId: socA, mois: "3", label: "x", montant: "1" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/référence de l'exercice/);
  });
});
