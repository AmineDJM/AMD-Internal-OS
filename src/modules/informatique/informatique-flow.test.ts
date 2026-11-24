import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTEUR, requireModule: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, MODULES_INFORMATIQUE, type SessionUser } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { assurerDepartementInformatique, imputerCoutIaDuMois, tacheRappelsAbonnements, vueCoutIa, CLE_LIGNE_IA, CLE_LIGNE_ABONNEMENTS } from "@/modules/informatique/api";
import { creerAbonnement, resilierAbonnement } from "./actions-abonnements";
import { creerMateriel, modifierMateriel } from "./actions-parc";
import { imputerCoutIa } from "./actions-cout-ia";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__informatique__";
/** Un mois ancien, sans autre appel de modèle dans la base partagée de la suite : le banc y est seul. */
const MOIS = "2019-03";
const DANS_LE_MOIS = (jour: number) => new Date(Date.UTC(2019, 2, jour, 10));

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPARTEMENT INFORMATIQUE, SUR UNE VRAIE BASE (Super Admin, 24/11/2026).
 *
 *  - le coût de l'IA d'un mois est imputé au budget Informatique de la BONNE société (fiche de la personne), en
 *    consommation (ligne de dépense budgétaire sur « Intelligence artificielle »), avec le détail de qui consomme ;
 *  - rejoué, il ne double rien ; un appel de plus ou un autre taux met à jour LA MÊME ligne ;
 *  - les trois clés s'ouvrent au responsable du département Informatique (pas à l'adjoint, pas à un autre), et un blocage
 *    de la console prime ;
 *  - un abonnement et un matériel s'enregistrent dans la société de la personne, jamais dans une autre ; le rappel
 *    d'échéance part une fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("département Informatique — budget, coût de l'IA, registres, droits", () => {
  const ids = { a: "", b: "", deptA: "", deptB: "", admin: "", chef: "", adjoint: "", autre: "", empChef: "", empAdjoint: "", empAutre: "" };
  const envs: string[] = [];

  async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
    const access = await getAccess(id, role);
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    return { id, name: u.name, email: u.email, role, access, mustChangePassword: false } as CurrentUser;
  }

  beforeAll(async () => {
    ids.a = (await prisma.company.create({ data: { name: `${TAG}Société A` } })).id;
    ids.b = (await prisma.company.create({ data: { name: `${TAG}Société B` } })).id;
    ids.deptA = (await assurerDepartementInformatique(ids.a)).id;
    ids.deptB = (await prisma.department.create({ data: { name: `${TAG}Regulatory B`, code: `${TAG}REGB`, companyId: ids.b } })).id;
    const compte = (nom: string, role: SessionUser["role"]) => prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, role, passwordHash: "x" } });
    ids.admin = (await compte("admin", "SUPER_ADMIN")).id;
    ids.chef = (await compte("chef", "SALES_USER")).id;
    ids.adjoint = (await compte("adjoint", "SALES_USER")).id;
    ids.autre = (await compte("autre", "SALES_USER")).id;
    ids.empChef = (await prisma.employee.create({ data: { fullName: `${TAG}Chef informatique`, companyId: ids.a, departmentId: ids.deptA, userId: ids.chef } })).id;
    ids.empAdjoint = (await prisma.employee.create({ data: { fullName: `${TAG}Adjoint`, companyId: ids.a, departmentId: ids.deptA, userId: ids.adjoint } })).id;
    // L'« autre » n'a pas de société sur sa fiche : c'est son département (société B) qui la donne.
    ids.empAutre = (await prisma.employee.create({ data: { fullName: `${TAG}Autre`, departmentId: ids.deptB, userId: ids.autre } })).id;
    await prisma.department.update({ where: { id: ids.deptA }, data: { headId: ids.empChef, deputyId: ids.empAdjoint } });
    const appel = (userId: string | null, feature: string | null, costUsd: string | null, jour: number) => ({
      at: DANS_LE_MOIS(jour), userId, feature, costUsd, role: "fil", provider: "openai", model: `${TAG}modele`, inputTokens: 10, outputTokens: 5,
    });
    await prisma.modelCallLog.createMany({ data: [
      appel(ids.chef, "assistant_ia", "1.000000", 2),
      appel(ids.chef, "brain", "0.500000", 3),
      appel(ids.autre, "assistant_ia", "2.250000", 4),
      appel(ids.autre, "assistant_ia", null, 5),
      appel(null, "briefing", "0.400000", 6),
    ] });
  });

  afterAll(async () => {
    const imps = await prisma.imputationCoutIa.findMany({ where: { companyId: { in: [ids.a, ids.b] } }, select: { expenseLineId: true } });
    await prisma.budgetExpenseLine.deleteMany({ where: { id: { in: imps.flatMap((i) => (i.expenseLineId ? [i.expenseLineId] : [])) } } }).catch(() => {});
    await prisma.imputationCoutIa.deleteMany({ where: { companyId: { in: [ids.a, ids.b] } } }).catch(() => {});
    const envIds = (await prisma.budgetEnvelope.findMany({ where: { companyId: { in: [ids.a, ids.b] } }, select: { id: true } })).map((e) => e.id);
    await prisma.budgetExpenseLine.deleteMany({ where: { category: { envelopeId: { in: envIds } } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: { in: envIds } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: { in: [...envIds, ...envs] } } }).catch(() => {});
    await prisma.modelCallLog.deleteMany({ where: { model: `${TAG}modele` } }).catch(() => {});
    const abos = await prisma.abonnementInformatique.findMany({ where: { companyId: { in: [ids.a, ids.b] } }, select: { id: true } });
    await prisma.document.deleteMany({ where: { entityType: "IT_SUBSCRIPTION", entityId: { in: abos.map((x) => x.id) } } }).catch(() => {});
    await prisma.abonnementInformatique.deleteMany({ where: { companyId: { in: [ids.a, ids.b] } } }).catch(() => {});
    await prisma.materielInformatique.deleteMany({ where: { companyId: { in: [ids.a, ids.b] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [ids.chef, ids.admin] } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: [ids.chef, ids.adjoint, ids.autre, ids.admin] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [ids.chef, ids.adjoint, ids.autre, ids.admin] } } }).catch(() => {});
    await prisma.department.updateMany({ where: { id: ids.deptA }, data: { headId: null, deputyId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.department.deleteMany({ where: { companyId: { in: [ids.a, ids.b] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [ids.a, ids.b] } } }).catch(() => {});
  });

  it("chaque société a SON département Informatique, une seule fois", async () => {
    expect((await assurerDepartementInformatique(ids.a)).id).toBe(ids.deptA);
    const [x, y] = await Promise.all([assurerDepartementInformatique(ids.b), assurerDepartementInformatique(ids.b)]);
    expect(x.id).toBe(y.id);
    expect(await prisma.department.count({ where: { companyId: ids.b, cle: "INFORMATIQUE" } })).toBe(1);
  });

  it("les trois clés : au responsable du département Informatique — ni à l'adjoint, ni à un autre ; le blocage prime", async () => {
    const chef = await acteur(ids.chef, "SALES_USER");
    for (const m of MODULES_INFORMATIQUE) {
      expect(userCan(chef, m, "VIEW"), m).toBe(true);
      expect(userCan(chef, m, "UPDATE"), m).toBe(true);
      expect(userCan(chef, m, "VALIDATE"), m).toBe(false);
    }
    for (const [id] of [[ids.adjoint], [ids.autre]]) {
      const u = await acteur(id, "SALES_USER");
      for (const m of MODULES_INFORMATIQUE) expect(userCan(u, m, "VIEW"), `${id} ${m}`).toBe(false);
    }
    const admin = await acteur(ids.admin, "SUPER_ADMIN");
    for (const m of MODULES_INFORMATIQUE) expect(userCan(admin, m, "UPDATE")).toBe(true);
    await prisma.userAccess.create({ data: { userId: ids.chef, module: "INFORMATIQUE_PARC", canView: false, canCreate: false, canUpdate: false, canDelete: false, canValidate: false, canExport: false, canUpload: false } });
    expect(userCan(await acteur(ids.chef, "SALES_USER"), "INFORMATIQUE_PARC", "VIEW")).toBe(false);
    await prisma.userAccess.deleteMany({ where: { userId: ids.chef, module: "INFORMATIQUE_PARC" } });
  });

  it("le coût de l'IA du mois consomme le budget Informatique de la BONNE société, avec le détail de qui consomme", async () => {
    const r = await imputerCoutIaDuMois({ mois: MOIS, taux: 135, acteurId: ids.admin, societes: [ids.a, ids.b] });
    expect(r.societes.map((s) => [s.companyId, s.geste, s.montantDzd]).sort()).toEqual([[ids.a, "CREER", 202.5], [ids.b, "CREER", 303.75]].sort());
    expect(r.nonRattache.appels).toBeGreaterThanOrEqual(1);

    const impA = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.a, mois: MOIS } } });
    const ligneA = await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: impA.expenseLineId! }, include: { category: { include: { envelope: true } } } });
    expect(Number(ligneA.amount)).toBe(202.5);
    expect(ligneA.category.cle).toBe(CLE_LIGNE_IA);
    expect(ligneA.category.envelope.companyId).toBe(ids.a);
    expect(ligneA.category.envelope.name).toBe("Informatique 2019");
    expect(Number(ligneA.category.envelope.totalAmount)).toBe(0);
    expect(ligneA.category.envelope.accessUserIds).toContain(ids.chef);
    const lignes = await prisma.budgetCategoryLine.findMany({ where: { envelopeId: ligneA.category.envelopeId } });
    expect(lignes.map((l) => [l.cle, Number(l.allocated)]).sort()).toEqual([["ABONNEMENTS_LICENCES", 0], ["IA_CONSOMMATION", 0], ["MATERIEL_INFORMATIQUE", 0]]);
    // Aucun ordre de paiement : la consommation est une ligne purement budgétaire.
    expect(await prisma.expenseOrder.count({ where: { companyId: { in: [ids.a, ids.b] } } })).toBe(0);

    const detail = impA.detail as { parFonction: { libelle: string; coutUsd: number }[]; parDepartement: { cle: string; libelle: string }[] };
    expect(detail.parFonction.map((f) => [f.libelle, f.coutUsd])).toEqual([["Assistant IA", 1], ["Adventum Brain", 0.5]]);
    expect(detail.parDepartement.map((d) => d.cle)).toEqual([ids.deptA]);
    const impB = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.b, mois: MOIS } } });
    expect(impB.sansTarif).toBe(1);
    expect((impB.detail as { parDepartement: { libelle: string }[] }).parDepartement[0].libelle).toBe(`${TAG}Regulatory B`);
  });

  it("rejouée : rien de plus ; un appel de plus, puis un autre taux : LA MÊME ligne est mise à jour", async () => {
    const avant = await prisma.budgetExpenseLine.count({ where: { category: { envelope: { companyId: { in: [ids.a, ids.b] } } } } });
    const r = await imputerCoutIaDuMois({ mois: MOIS, taux: 135, acteurId: ids.admin, societes: [ids.a, ids.b] });
    expect(r.societes.every((s) => s.geste === "INCHANGEE")).toBe(true);
    const impA = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.a, mois: MOIS } } });

    await prisma.modelCallLog.create({ data: { at: DANS_LE_MOIS(20), userId: ids.chef, feature: "assistant_ia", costUsd: "1.000000", role: "fil", provider: "openai", model: `${TAG}modele`, inputTokens: 1, outputTokens: 1 } });
    const r2 = await imputerCoutIaDuMois({ mois: MOIS, taux: 135, acteurId: ids.admin, societes: [ids.a, ids.b] });
    expect(r2.societes.find((s) => s.companyId === ids.a)!.geste).toBe("METTRE_A_JOUR");
    expect(r2.societes.find((s) => s.companyId === ids.b)!.geste).toBe("INCHANGEE");
    const r3 = await imputerCoutIaDuMois({ mois: MOIS, taux: 140, acteurId: ids.admin, societes: [ids.a] });
    expect(r3.societes.map((s) => [s.companyId, s.geste, s.montantDzd])).toEqual([[ids.a, "METTRE_A_JOUR", 350]]);

    const apres = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.a, mois: MOIS } } });
    expect(apres.expenseLineId).toBe(impA.expenseLineId);
    expect(Number((await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: apres.expenseLineId! } })).amount)).toBe(350);
    expect(await prisma.budgetExpenseLine.count({ where: { category: { envelope: { companyId: { in: [ids.a, ids.b] } } } } })).toBe(avant);
    expect(await prisma.imputationCoutIa.count({ where: { companyId: { in: [ids.a, ids.b] }, mois: MOIS } })).toBe(2);
  });

  it("la facture du fournisseur payée sur la ligne IA SOLDE le mesuré : une seule consommation", async () => {
    const impA = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.a, mois: MOIS } } });
    // La facture réglée par le circuit normal, classée sur la ligne « Intelligence artificielle » : 380 DZD (mesuré : 350).
    const tx = await prisma.financeTransaction.create({ data: {
      companyId: ids.a, date: DANS_LE_MOIS(25), direction: "OUT", amount: 380, status: "SETTLED", budgetCategoryId: impA.categoryId,
      reference: `${TAG}FIN-1`, label: `${TAG}facture fournisseur IA`, category: "FOURNISSEUR",
    } as never });
    try {
      const r = await imputerCoutIaDuMois({ mois: MOIS, taux: 140, acteurId: ids.admin, societes: [ids.a] });
      expect(r.societes.map((s) => [s.geste, s.montantDzd])).toEqual([["METTRE_A_JOUR", 0]]);
      const apres = await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.a, mois: MOIS } } });
      expect(apres.expenseLineId).toBe(impA.expenseLineId);
      expect(Number((await prisma.budgetExpenseLine.findUniqueOrThrow({ where: { id: apres.expenseLineId! } })).amount)).toBe(0);
      expect(apres.detail).toMatchObject({ mesureDzd: 350, factureDzd: 380 });
      const vue = await vueCoutIa(ids.chef, DANS_LE_MOIS(28));
      expect(vue.societes[0].mois.find((m) => m.mois === MOIS)?.consomme).toBe(380);
      // Rejouée : rien ne bouge.
      expect((await imputerCoutIaDuMois({ mois: MOIS, taux: 140, acteurId: ids.admin, societes: [ids.a] })).societes[0].geste).toBe("INCHANGEE");
    } finally {
      await prisma.financeTransaction.delete({ where: { id: tx.id } });
    }
    // La facture retirée : le mesuré consomme de nouveau.
    const r = await imputerCoutIaDuMois({ mois: MOIS, taux: 140, acteurId: ids.admin, societes: [ids.a] });
    expect(r.societes.map((s) => [s.geste, s.montantDzd])).toEqual([["METTRE_A_JOUR", 350]]);
  });

  it("le geste d'imputation : taux exigé, mois à venir refusé, sociétés de la personne seulement", async () => {
    ACTEUR = await acteur(ids.chef, "SALES_USER");
    const fd = (mois: string, taux: string) => { const f = new FormData(); f.set("mois", mois); f.set("taux", taux); return f; };
    expect((await imputerCoutIa(fd(MOIS, ""))).error).toMatch(/taux/);
    expect((await imputerCoutIa(fd("2099-01", "135"))).error).toMatch(/pas encore commencé/);
    const r = await imputerCoutIa(fd(MOIS, "140"));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/déjà imputé/);
    // Le chef ne touche pas à la société B : son imputation garde le taux de 135.
    expect(Number((await prisma.imputationCoutIa.findUniqueOrThrow({ where: { companyId_mois: { companyId: ids.b, mois: MOIS } } })).tauxUsdDzd)).toBe(135);
    ACTEUR = await acteur(ids.autre, "SALES_USER");
    expect((await imputerCoutIa(fd(MOIS, "140"))).ok).toBe(false);
  });

  it("l'écran rapproche consommé / budget / reste pour SA société", async () => {
    const vue = await vueCoutIa(ids.chef, DANS_LE_MOIS(28));
    expect(vue.societes.map((s) => s.companyId)).toEqual([ids.a]);
    const a = vue.societes[0];
    expect(a.enveloppe?.nom).toBe("Informatique 2019");
    expect(a.mois.find((m) => m.mois === MOIS)).toMatchObject({ consomme: 350, cumul: 350, reste: null });
    expect(vue.apercu.parSociete.map((p) => p.companyId)).toEqual([ids.a]);
  });

  it("un abonnement s'enregistre dans la société de la personne, sur la ligne « Abonnements & licences » ; jamais ailleurs", async () => {
    ACTEUR = await acteur(ids.chef, "SALES_USER");
    const env = await prisma.budgetEnvelope.findFirstOrThrow({ where: { companyId: ids.a, categories: { some: { cle: CLE_LIGNE_IA } } } });
    const ligne = await prisma.budgetCategoryLine.findFirstOrThrow({ where: { envelopeId: env.id, cle: CLE_LIGNE_ABONNEMENTS } });
    const f = new FormData();
    for (const [k, v] of Object.entries({ companyId: ids.a, fournisseur: "OpenAI", objet: "API", montant: "200", devise: "USD", periodicite: "MENSUEL", echeance: "2099-01-01", budgetCategoryId: ligne.id })) f.set(k, v);
    const r = await creerAbonnement(f);
    expect(r.ok, r.error).toBe(true);
    const abo = await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: r.id! } });
    expect([abo.fournisseur, Number(abo.montant), abo.devise, abo.budgetCategoryId, abo.statut]).toEqual(["OpenAI", 200, "USD", ligne.id, "ACTIF"]);

    f.set("companyId", ids.b);
    expect((await creerAbonnement(f)).error).toMatch(/ne vous est pas ouverte/);
    const g = new FormData(); g.set("id", abo.id);
    expect((await resilierAbonnement(g)).ok).toBe(true);
    expect((await resilierAbonnement(g)).message).toMatch(/déjà résilié/);
    ACTEUR = await acteur(ids.autre, "SALES_USER");
    expect((await creerAbonnement(f)).error).toMatch(/Non autorisé/);
  });

  it("le rappel de renouvellement part une fois, au responsable Informatique de la société", async () => {
    const maintenant = new Date();
    const echeance = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate() + 10));
    const abo = await prisma.abonnementInformatique.create({ data: { companyId: ids.a, fournisseur: "Anthropic", objet: "API", montant: 100, devise: "USD", echeance, rappelJours: 30, createdById: ids.admin } });
    const avant = await prisma.notification.count({ where: { userId: ids.chef } });
    await tacheRappelsAbonnements(maintenant, true);
    await tacheRappelsAbonnements(maintenant, true);
    const avis = await prisma.notification.findMany({ where: { userId: ids.chef, link: { contains: abo.id } } });
    expect(avis).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId: ids.chef } })).toBe(avant + 1);
    expect((await prisma.abonnementInformatique.findUniqueOrThrow({ where: { id: abo.id } })).rappelEnvoyePour?.getTime()).toBe(echeance.getTime());
  });

  it("un matériel s'enregistre, s'affecte à une personne de SA société, et se corrige", async () => {
    ACTEUR = await acteur(ids.chef, "SALES_USER");
    const f = new FormData();
    for (const [k, v] of Object.entries({ companyId: ids.a, type: "PORTABLE", reference: "Dell Latitude 5440", employeeId: ids.empAdjoint, dateAchat: "2026-01-15", finGarantie: "2029-01-15" })) f.set(k, v);
    const r = await creerMateriel(f);
    expect(r.ok, r.error).toBe(true);
    f.set("employeeId", ids.empAutre);
    f.set("departmentId", ids.deptB);
    expect((await creerMateriel(f)).error).toMatch(/autre société/);
    f.set("finGarantie", "2020-01-01"); f.set("employeeId", ""); f.set("departmentId", "");
    expect((await creerMateriel(f)).error).toMatch(/précède/);
    const g = new FormData(); g.set("id", r.id!); g.set("etat", "EN_REPARATION");
    expect((await modifierMateriel(g)).ok).toBe(true);
    const m = await prisma.materielInformatique.findUniqueOrThrow({ where: { id: r.id! } });
    expect([m.type, m.etat, m.employeeId, m.companyId]).toEqual(["PORTABLE", "EN_REPARATION", ids.empAdjoint, ids.a]);
  });
});
