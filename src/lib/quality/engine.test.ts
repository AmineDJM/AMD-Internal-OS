import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { prisma } from "@/lib/prisma";
import { balayerQualite } from "./engine";
import { REGLES, REGLES_SANS_DETECTEUR, DETECTEURS_SANS_REGLE, detecter } from "./rules";
import { corrigerConstat, ignorerConstat } from "./decide";
import { lireConstats, compterConstats } from "./read";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DU MOTEUR — des anomalies PLANTÉES dans la vraie base, une par règle au moins, et des
 * lignes témoins PROPRES à côté. Le mandat exige ≥ 95 % de détection des anomalies critiques et
 * des faux positifs maîtrisés : ici on exige 100 % des critiques et hautes plantées, 0 constat
 * sur les témoins, l'idempotence (revu = une occurrence de plus, pas une ligne de plus), la
 * correction AUTO journalisée, et la fermeture d'un défaut disparu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const P = "__dq__";
const ids: Record<string, string> = {};
const now = new Date();
const jours = (n: number) => new Date(now.getTime() + n * 86_400_000);

async function nettoyer() {
  await prisma.dataQualityFinding.deleteMany({ where: { OR: [{ titre: { contains: P } }, { detail: { contains: P } }, { entiteId: { in: Object.values(ids) } }] } });
  await prisma.task.deleteMany({ where: { title: { startsWith: P } } });
  await prisma.legalDocument.deleteMany({ where: { title: { startsWith: P } } });
  await prisma.financeTransaction.deleteMany({ where: { reference: { startsWith: P } } });
  await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: P } } });
  await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: P } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.employee.deleteMany({ where: { fullName: { startsWith: P } } });
  await prisma.department.deleteMany({ where: { name: { startsWith: P } } }).catch(() => undefined);
  // Insensible à la casse : le compte « __DQ__Majuscules » du cas e-mail normalisable doit partir aussi.
  await prisma.user.deleteMany({ where: { OR: [{ email: { startsWith: "__dq__", mode: "insensitive" } }, { name: { startsWith: P } }] } });
  await prisma.auditLog.deleteMany({ where: { summary: { contains: P } } }).catch(() => undefined);
}

describe("moteur de qualité des données — banc d'anomalies plantées", () => {
  beforeAll(async () => {
    await nettoyer();
    const inactif = await prisma.user.create({ data: { name: `${P} Compte parti`, email: "__dq__parti@test.dz", passwordHash: "x", role: "VIEWER", isActive: true } });
    const actifDept = await prisma.user.create({ data: { name: `${P} Compte actif`, email: "__DQ__Majuscules@Test.DZ", passwordHash: "x", role: "VIEWER", isActive: true } });
    const desactive = await prisma.user.create({ data: { name: `${P} Désactivé`, email: "__dq__off@test.dz", passwordHash: "x", role: "VIEWER", isActive: false } });
    ids.userParti = inactif.id; ids.userMaj = actifDept.id; ids.userOff = desactive.id;

    const e1 = await prisma.employee.create({ data: { fullName: `${P} Amine Doublon`, email: "dup@dq.test", isActive: true, baseSalary: 100000, hireDate: jours(-400) } });
    const e2 = await prisma.employee.create({ data: { fullName: `${P} Doublon Amine`, email: "DUP@dq.test", isActive: true, baseSalary: 100000, hireDate: jours(-300) } });
    const e3 = await prisma.employee.create({ data: { fullName: `${P} Parti`, email: "parti@dq.test", isActive: false, baseSalary: 100000, userId: inactif.id } });
    const e4 = await prisma.employee.create({ data: { fullName: `${P} Dates`, email: "dates@dq.test", isActive: true, baseSalary: 100000, contractStart: jours(-10), contractEnd: jours(-100), hireDate: jours(-500) } });
    const e5 = await prisma.employee.create({ data: { fullName: `${P} Sans rien`, isActive: true, baseSalary: 100000 } });
    const e6 = await prisma.employee.create({ data: { fullName: `${P} Mail cassé`, email: "pas-un-mail", isActive: true, baseSalary: 100000, hireDate: jours(-100) } });
    // Le témoin est PROPRE au sens des règles : e-mail, département, date d'embauche, dates cohérentes.
    const dept = (await prisma.department.findFirst({ select: { id: true } })) ?? (await prisma.department.create({ data: { name: `${P} Département témoin`, code: "DQT" }, select: { id: true } }));
    const temoin = await prisma.employee.create({ data: { fullName: `${P} Témoin Propre`, email: "temoin.propre@dq.test", isActive: true, baseSalary: 100000, hireDate: jours(-200), contractStart: jours(-200), contractEnd: jours(200), departmentId: dept.id } });
    Object.assign(ids, { e1: e1.id, e2: e2.id, e3: e3.id, e4: e4.id, e5: e5.id, e6: e6.id, temoin: temoin.id });

    const s1 = await prisma.supplier.create({ data: { name: `${P} Hetero Labs SARL`, active: true, contactEmail: "a@hetero.test" } });
    const s2 = await prisma.supplier.create({ data: { name: `${P} HÉTÉRO LABS`, active: true, contactEmail: null } });
    Object.assign(ids, { s1: s1.id, s2: s2.id });

    const anyCompany = await prisma.company.findFirst({ select: { id: true } });
    // Les deux molécules sont SYNTHÉTIQUES, exprès : le banc de résolution d'entités (`fabric/entites.test.ts`) exige
    // qu'aucun autre jeu de données ne porte ses molécules (« Sofosbuvir + Velpatasvir » y vit), et les deux
    // bancs tournent en parallèle sur la même base — un doublon se juge sur la DCI TRIÉE, n'importe quels deux noms font l'affaire.
    const p1 = await prisma.regulatoryProduct.create({ data: { reference: `${P}-P1`, dci: "Alphavirine + Betavirine", dosage: "400", dosageUnit: "mg", pharmaceuticalForm: "Comprimé", packaging: "B/28", status: "SUBMITTED", companyId: anyCompany?.id ?? null, responsibleId: desactive.id, updatedAt: jours(-200) } as never });
    const p2 = await prisma.regulatoryProduct.create({ data: { reference: `${P}-P2`, dci: "Betavirine + Alphavirine", dosage: "400", dosageUnit: "MG", pharmaceuticalForm: "comprimé", packaging: "b/28", status: "IN_PREPARATION", companyId: anyCompany?.id ?? null, targetSubmissionDate: jours(60), targetDate: jours(30) } as never });
    Object.assign(ids, { p1: p1.id, p2: p2.id });
    // `updatedAt` est géré par Prisma : on force l'ancienneté par SQL pour le cas « périmé ».
    await prisma.$executeRawUnsafe(`UPDATE "RegulatoryProduct" SET "updatedAt" = $1 WHERE id = $2`, jours(-200), p1.id);

    const bc = await prisma.legalDocument.create({ data: { title: `${P} BC Hetero`, reference: `${P}-BC-1`, kind: "PURCHASE_ORDER", counterparty: "Hetero Labs", amount: 100000, status: "ACTIVE", startDate: jours(-60) } });
    const f1 = await prisma.legalDocument.create({ data: { title: `${P} Facture Hetero 1`, reference: `${P}-F-1`, kind: "INVOICE", counterparty: "Hetero Labs", amount: 125000, status: "ACTIVE", chainFromId: bc.id, startDate: jours(-30) } });
    const f2 = await prisma.legalDocument.create({ data: { title: `${P} Facture Hetero 2`, reference: `${P}-F-2`, kind: "INVOICE", counterparty: "HETERO LABS", amount: 125000, status: "ACTIVE", startDate: jours(-20) } });
    const c1 = await prisma.legalDocument.create({ data: { title: `${P} Contrat échu`, reference: `${P}-C-1`, kind: "CONTRACT", counterparty: "Kwality", amount: 50000, status: "ACTIVE", startDate: jours(-400), endDate: jours(-30) } });
    const c2 = await prisma.legalDocument.create({ data: { title: `${P} Contrat inversé`, reference: `${P}-C-2`, kind: "CONTRACT", counterparty: "Kwality", amount: 50000, status: "ACTIVE", startDate: jours(100), endDate: jours(10) } });
    const f3 = await prisma.legalDocument.create({ data: { title: `${P} Facture sans montant`, reference: `${P}-F-3`, kind: "INVOICE", counterparty: null, amount: null, status: "ACTIVE" } });
    const ctemoin = await prisma.legalDocument.create({ data: { title: `${P} Contrat témoin`, reference: `${P}-C-T`, kind: "CONTRACT", counterparty: "Kwality", amount: 50000, status: "ACTIVE", startDate: jours(-100), endDate: jours(300) } });
    Object.assign(ids, { bc: bc.id, f1: f1.id, f2: f2.id, c1: c1.id, c2: c2.id, f3: f3.id, ctemoin: ctemoin.id });

    const t1 = await prisma.task.create({ data: { title: `${P} Tâche en retard`, status: "TODO", priority: "MEDIUM", dueDate: jours(-90) } });
    const t2 = await prisma.task.create({ data: { title: `${P} Tâche du parti`, status: "IN_PROGRESS", priority: "MEDIUM", assignedToId: desactive.id } });
    Object.assign(ids, { t1: t1.id, t2: t2.id });

    const base = { direction: "OUT" as const, category: "FOURNISSEUR" as const, method: "BANK_TRANSFER" as const, account: "BNA", status: "SETTLED" as const, date: jours(-5) };
    for (let i = 0; i < 9; i += 1) await prisma.financeTransaction.create({ data: { ...base, reference: `${P}-TX-${i}`, label: `${P} écriture ${i}`, amount: 10000 + i * 100 } });
    const txNeg = await prisma.financeTransaction.create({ data: { ...base, reference: `${P}-TX-NEG`, label: `${P} négative`, amount: -500 } });
    const txAb = await prisma.financeTransaction.create({ data: { ...base, reference: `${P}-TX-AB`, label: `${P} aberrante`, amount: 900000 } });
    const txPaye = await prisma.financeTransaction.create({ data: { ...base, reference: `${P}-TX-PAYE`, label: `${P} règlement`, amount: 70000 } });
    const o1 = await prisma.expenseOrder.create({ data: { reference: `${P}-OD-1`, label: `${P} ordre payé sans écriture`, amount: 30000, category: "FOURNISSEUR", status: "PAID", paidDate: null, transactionId: null } });
    const o2 = await prisma.expenseOrder.create({ data: { reference: `${P}-OD-2`, label: `${P} ordre payé autre montant`, amount: 50000, category: "FOURNISSEUR", status: "PAID", paidDate: jours(-3), transactionId: txPaye.id } });
    Object.assign(ids, { txNeg: txNeg.id, txAb: txAb.id, o1: o1.id, o2: o2.id });
  });

  afterAll(async () => { await nettoyer(); await prisma.$disconnect(); });

  it("chaque règle du catalogue a son détecteur, et réciproquement", () => {
    expect(REGLES_SANS_DETECTEUR).toEqual([]);
    expect(DETECTEURS_SANS_REGLE).toEqual([]);
    expect(REGLES.length).toBeGreaterThanOrEqual(20);
  });

  it("détecte 100 % des anomalies plantées critiques et hautes, et rien sur les témoins", async () => {
    const r = await balayerQualite({ appliquerAuto: false, journaliser: false });
    expect(r.erreurs, JSON.stringify(r.regles.filter((x) => x.erreur))).toBe(0);
    const ouverts = await prisma.dataQualityFinding.findMany({ where: { status: "OPEN" }, select: { regle: true, entiteId: true, titre: true, criticite: true, resolution: true, correction: true } });
    const trouve = (regle: string, entiteId: string) => ouverts.some((o) => o.regle === regle && o.entiteId === entiteId);
    const attendus: [string, string][] = [
      ["doublon_email_salaries", ids.e1], ["doublon_email_salaries", ids.e2],
      ["doublon_nom_salaries", ids.e1],
      ["doublon_fournisseurs", ids.s1], ["doublon_fournisseurs", ids.s2],
      ["doublon_produits_regulatory", ids.p1], ["doublon_produits_regulatory", ids.p2],
      ["doublon_factures", ids.f2],
      ["email_normalisable", ids.e2], ["email_normalisable", ids.userMaj],
      ["email_invalide", ids.e6],
      ["champ_manquant_salarie", ids.e5],
      ["champ_manquant_fournisseur", ids.s2],
      ["champ_manquant_legal", ids.f3],
      ["dossier_sans_responsable", ids.p2],
      ["perime_dossier_regulatory", ids.p1],
      ["perime_tache", ids.t1],
      ["contrat_actif_echu", ids.c1],
      ["paiement_statut_impossible", ids.o1],
      ["affectation_cassee", ids.t2], ["affectation_cassee", ids.p1],
      ["date_incoherente", ids.c2], ["date_incoherente", ids.e4], ["date_incoherente", ids.p2],
      ["montant_contradictoire", ids.f1], ["montant_contradictoire", ids.o2],
      ["valeur_aberrante", ids.txNeg], ["valeur_aberrante", ids.txAb],
      ["compte_actif_salarie_parti", ids.userParti],
    ];
    const manques = attendus.filter(([regle, id]) => !trouve(regle, id));
    const taux = 1 - manques.length / attendus.length;
    console.log(`   · détection ${attendus.length - manques.length}/${attendus.length} (${Math.round(taux * 100)} %) en ${r.ms} ms · ${r.constats} constats, ${r.nouveaux} nouveaux`);
    expect(manques, `anomalies plantées NON détectées : ${manques.map(([a, b]) => `${a}:${b}`).join(", ")}`).toEqual([]);
    consignerMesure("anomalies_critiques", { n: attendus.length, ok: attendus.length - manques.length }, "lib/quality/engine.test.ts");
    // Les témoins propres ne déclenchent rien.
    const surTemoins = ouverts.filter((o) => o.entiteId === ids.temoin || o.entiteId === ids.ctemoin);
    expect(surTemoins, `faux positifs sur les témoins : ${surTemoins.map((o) => `${o.regle} — ${o.titre}`).join(" | ")}`).toEqual([]);
    // La classification : le doublon de factures est critique et humain ; le contrat échu est proposé avec sa correction.
    expect(ouverts.find((o) => o.regle === "doublon_factures" && o.entiteId === ids.f2)?.criticite).toBe("CRITIQUE");
    expect(ouverts.find((o) => o.regle === "doublon_factures" && o.entiteId === ids.f2)?.resolution).toBe("HUMAIN");
    const echu = ouverts.find((o) => o.regle === "contrat_actif_echu" && o.entiteId === ids.c1);
    expect(echu?.resolution).toBe("PROPOSE");
    expect((echu?.correction as { apres?: string } | null)?.apres).toBe("EXPIRED");
    expect(ouverts.find((o) => o.regle === "email_normalisable" && o.entiteId === ids.e2)?.resolution).toBe("AUTO");
  });

  it("revu, un défaut compte une occurrence de plus — jamais une ligne de plus", async () => {
    const avant = await prisma.dataQualityFinding.count({ where: { entiteId: { in: Object.values(ids) } } });
    await balayerQualite({ appliquerAuto: false, journaliser: false });
    const apres = await prisma.dataQualityFinding.count({ where: { entiteId: { in: Object.values(ids) } } });
    expect(apres).toBe(avant);
    const f = await prisma.dataQualityFinding.findFirst({ where: { regle: "doublon_factures", entiteId: ids.f2 } });
    expect(f?.occurrences).toBeGreaterThanOrEqual(2);
  });

  it("la correction AUTO s'applique, se journalise, et le constat passe FIXED", async () => {
    await balayerQualite({ regles: ["email_normalisable"], appliquerAuto: true, journaliser: false });
    const e2 = await prisma.employee.findUnique({ where: { id: ids.e2 }, select: { email: true } });
    expect(e2?.email).toBe("dup@dq.test");
    const u = await prisma.user.findUnique({ where: { id: ids.userMaj }, select: { email: true } });
    expect(u?.email).toBe("__dq__majuscules@test.dz");
    const f = await prisma.dataQualityFinding.findFirst({ where: { regle: "email_normalisable", entiteId: ids.e2 } });
    expect(f?.status).toBe("FIXED");
    expect(f?.resolvedBy).toBe("auto");
    expect((f?.fixLog as { avant?: string; apres?: string })?.avant).toBe("DUP@dq.test");
    const audit = await prisma.auditLog.findFirst({ where: { entityId: ids.e2, field: "email", newValue: "dup@dq.test" } });
    expect(audit, "l'audit porte l'avant et l'après").not.toBeNull();
  });

  it("une correction PROPOSÉE s'applique d'un clic sous les droits ; écarter exige un motif et tient au balayage suivant", async () => {
    // SON PROPRE Super Admin (effacé par `nettoyer`, préfixe `__dq__`) : une base fraîche (CI) n'en a aucun.
    const admin = (await prisma.user.create({
      data: { name: `${P} Super Admin`, email: "__dq__admin@test.dz", passwordHash: "x", role: "SUPER_ADMIN", isActive: true },
    })) as unknown as CurrentUser | null;
    expect(admin, "un Super Admin existe en base de test").not.toBeNull();
    const user = { ...admin!, access: (admin as unknown as { access?: unknown })?.access } as CurrentUser;
    const echu = await prisma.dataQualityFinding.findFirst({ where: { regle: "contrat_actif_echu", entiteId: ids.c1, status: "OPEN" } });
    expect(echu).not.toBeNull();
    const r = await corrigerConstat(user, echu!.id);
    expect(r.ok, r.message).toBe(true);
    expect((await prisma.legalDocument.findUnique({ where: { id: ids.c1 } }))?.status).toBe("EXPIRED");
    expect((await prisma.dataQualityFinding.findUnique({ where: { id: echu!.id } }))?.status).toBe("FIXED");

    const dup = await prisma.dataQualityFinding.findFirst({ where: { regle: "doublon_nom_salaries", entiteId: ids.e1, status: "OPEN" } });
    expect(dup).not.toBeNull();
    expect((await ignorerConstat(user, dup!.id, "")).ok).toBe(false);
    expect((await ignorerConstat(user, dup!.id, "homonymes : deux personnes distinctes")).ok).toBe(true);
    await balayerQualite({ regles: ["doublon_nom_salaries"], appliquerAuto: false, journaliser: false });
    const apres = await prisma.dataQualityFinding.findUnique({ where: { id: dup!.id } });
    expect(apres?.status).toBe("DISMISSED");
    expect(apres?.motif).toMatch(/homonymes/);
  });

  it("un défaut disparu se ferme seul ; un compte sans droit ne voit rien", async () => {
    await prisma.task.update({ where: { id: ids.t1 }, data: { status: "DONE", completedAt: new Date() } });
    await balayerQualite({ regles: ["perime_tache"], appliquerAuto: false, journaliser: false });
    const f = await prisma.dataQualityFinding.findFirst({ where: { regle: "perime_tache", entiteId: ids.t1 } });
    expect(f?.status).toBe("RESOLVED");
    expect(f?.resolvedBy).toBe("disparu");
    const sansDroit = { id: ids.userOff, role: "VIEWER", access: { modules: new Map() } } as unknown as Parameters<typeof lireConstats>[0];
    expect(await lireConstats(sansDroit)).toEqual([]);
    expect((await compterConstats(sansDroit)).ouverts).toBe(0);
    const direct = await detecter("doublon_fournisseurs");
    expect(direct.some((c) => c.entiteId === ids.s1)).toBe(true);
  });
});
