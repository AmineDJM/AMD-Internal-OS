import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { getDepartmentSubtreeIds } from "@/lib/departments";
import { CATEGORIES_BV, lignesBv, natureDuLibelle, type DossierBv, type OrdreBv } from "@/lib/budget-regulatory/bv";
import { projeter12Mois, type DomaineCampagne, type LignePrefill } from "./regles";
import { categoriesGouvernees, consommationIntegree, contextesDesCategories } from "@/lib/queries/budget-integration";

/**
 * « PRÉ-REMPLIR DEPUIS L'ANNÉE EN COURS » — jamais une page blanche (maquette validée).
 *
 * Chaque ligne part du RÉALISÉ de l'année en cours projeté sur 12 mois ; les lignes AUTOMATIQUES se calculent :
 *   • masse salariale depuis la Paie — en TOTAL seulement (la règle de `hr/confidentialite.ts` : le détail par personne ne
 *     sort pas ; un groupe de moins de trois salariés ne se chiffre pas pour qui ne voit pas les salaires, son total
 *     dirait le salaire de chacun) ;
 *   • recrutements prévus (module Recrutement : demandes validées en cours × fourchette de salaire) ;
 *   • BV 25 % / 75 % des dossiers réglementaires attendus (`budget-regulatory/bv.ts`) ;
 *   • Ad & Pro par BU, d'après la tendance des six derniers mois.
 * Ne lève jamais pour une source vide : une source sans donnée ne fait simplement pas de ligne.
 */

const EN_COURS_REG = ["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_BV_PAYMENT", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "BLOCKED"] as const;
const STAGES_RECRUTEMENT_OUVERTS = ["HR_REVIEW", "SOURCING", "ONBOARDING"] as const;
const LIBELLE_NATURE_DEPT: Record<string, string> = {
  OPERATING: "Fonctionnement (moyens généraux)",
  ACTIVITY: "Activité du département",
  TRAINING: "Formation",
};

const cle = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface EntreePrefill {
  departmentId: string;
  domaine: DomaineCampagne;
  /** L'année BUDGÉTÉE (2027) — le réalisé lu est celui de l'année précédente. */
  annee: number;
  companyId: string | null;
  voitLesSalaires: boolean;
  maintenant?: Date;
}

export async function calculerPrefill(e: EntreePrefill): Promise<LignePrefill[]> {
  const maintenant = e.maintenant ?? new Date();
  const ref = e.annee - 1;
  const debut = new Date(Date.UTC(ref, 0, 1));
  const fin = new Date(Date.UTC(ref, 11, 31, 23, 59, 59));
  const projete = (m: number) => projeter12Mois(m, ref, maintenant);
  const sousArbre = await getDepartmentSubtreeIds(e.departmentId);
  const lignes: LignePrefill[] = [];

  // ── A. Le réalisé par catégorie des enveloppes du pôle (hors catégories reconnues, que les lignes automatiques portent).
  if (e.domaine !== "GENERAL") {
    const enveloppes = await prisma.budgetEnvelope.findMany({
      where: { domaine: e.domaine, periodStart: { lte: fin }, periodEnd: { gte: debut }, ...(e.companyId ? { companyId: e.companyId } : {}) },
      select: { categories: { select: { id: true, name: true, parentId: true, cle: true } } },
    });
    const cats = enveloppes.flatMap((x) => x.categories);
    const parent = new Map(cats.map((c) => [c.id, c.parentId]));
    const tete = (id: string): string => { let cur = id; for (let i = 0; i < 10; i++) { const p = parent.get(cur); if (!p) return cur; cur = p; } return cur; };
    const ids = cats.map((c) => c.id);
    if (ids.length) {
      const [tx, lignesBudget, dept] = await Promise.all([
        prisma.financeTransaction.groupBy({ by: ["budgetCategoryId"], where: { direction: "OUT", status: "SETTLED", budgetCategoryId: { in: ids }, date: { gte: debut, lte: fin } }, _sum: { amount: true } }),
        prisma.budgetExpenseLine.groupBy({ by: ["categoryId"], where: { categoryId: { in: ids }, date: { gte: debut, lte: fin } }, _sum: { amount: true } }),
        prisma.departmentBudgetExpense.groupBy({ by: ["budgetCategoryId"], where: { budgetCategoryId: { in: ids }, date: { gte: debut, lte: fin } }, _sum: { amount: true } }),
      ]);
      const parTete = new Map<string, number>();
      const ajoute = (id: string | null, m: unknown) => { if (!id) return; const t = tete(id); parTete.set(t, (parTete.get(t) ?? 0) + toNumber(m)); };
      // L'INTÉGRATION DES DÉPENSES RÉELLES (Ad & Pro 2026) : le réalisé d'une enveloppe dont un lot est validé se lit par
      // la règle du lot — postes historiques, ce qui est né après, jamais deux fois (`budget/integration-regle.ts`).
      const ctxs = await contextesDesCategories(ids);
      const gouvernees = categoriesGouvernees(ctxs, ids);
      for (const r of tx) if (!gouvernees.has(r.budgetCategoryId ?? "")) ajoute(r.budgetCategoryId, r._sum.amount);
      for (const r of lignesBudget) if (!gouvernees.has(r.categoryId)) ajoute(r.categoryId, r._sum.amount);
      if (ctxs.length) {
        const integ = await consommationIntegree(ctxs, ids, debut, fin, { statuts: ["SETTLED"] });
        for (const e of integ.ecritures) ajoute(e.budgetCategoryId, e.amount);
        for (const l of integ.lignes) ajoute(l.categoryId, l.amount);
        for (const [cat, m] of integ.historiqueParCategorie) ajoute(cat, m);
      }
      for (const r of dept) ajoute(r.budgetCategoryId, r._sum.amount);
      const parNom = new Map<string, { label: string; montant: number }>();
      for (const c of cats.filter((x) => x.parentId === null && !x.cle)) {
        const k = cle(c.name);
        const cur = parNom.get(k) ?? { label: c.name, montant: 0 };
        cur.montant += parTete.get(c.id) ?? 0;
        parNom.set(k, cur);
      }
      for (const [k, v] of parNom) {
        const r = projete(v.montant);
        lignes.push({ key: `CAT:${k}`, label: v.label, categoryKey: null, source: "REALISE_2026", realise2026: r, propose: r });
      }
    }
  }

  // ── B. Les dépenses du département non rangées dans une enveloppe, par nature (la masse salariale vient de la Paie).
  const depenses = await prisma.departmentBudgetExpense.groupBy({
    by: ["kind"],
    where: { departmentId: { in: sousArbre }, year: ref, budgetCategoryId: null, kind: { not: "HR" } },
    _sum: { amount: true },
  });
  for (const d of depenses) {
    const r = projete(toNumber(d._sum.amount));
    if (r > 0) lignes.push({ key: `DEPT:${d.kind}`, label: LIBELLE_NATURE_DEPT[d.kind] ?? d.kind, categoryKey: null, source: "REALISE_2026", realise2026: r, propose: r });
  }

  // ── C. La masse salariale, depuis la Paie — en total.
  const employes = await prisma.employee.findMany({
    where: { departmentId: { in: sousArbre }, isActive: true },
    select: { id: true, employerCost: true, grossSalary: true, baseSalary: true },
  });
  if (employes.length > 0) {
    const cleMs = e.domaine === "OPERATIONS" ? "MASSE_SALARIALE_FDV" : "MASSE_SALARIALE";
    if (employes.length < 3 && !e.voitLesSalaires) {
      lignes.push({
        key: "PAIE", label: "Masse salariale", categoryKey: cleMs, source: "AUTO_PAIE", realise2026: 0, propose: 0,
        justification: "Moins de trois salariés : le total dirait le salaire de chacun — montant à saisir par les RH.",
      });
    } else {
      const paies = await prisma.payrollEntry.findMany({
        where: { employeeId: { in: employes.map((x) => x.id) }, year: ref },
        select: { month: true, employerCost: true, gross: true },
      });
      const parMois = new Map<number, number>();
      for (const p of paies) parMois.set(p.month, (parMois.get(p.month) ?? 0) + toNumber(p.employerCost ?? p.gross));
      const totalAnnee = [...parMois.values()].reduce((a, m) => a + m, 0);
      const dernierMois = [...parMois.keys()].sort((a, b) => b - a)[0];
      const mensuelFiche = employes.reduce((a, x) => a + toNumber(x.employerCost ?? x.grossSalary ?? x.baseSalary), 0);
      const mensuel = dernierMois ? parMois.get(dernierMois) ?? 0 : mensuelFiche;
      const realise = parMois.size > 0 ? Math.round((totalAnnee * 12) / Math.max(1, parMois.size)) : 0;
      lignes.push({
        key: "PAIE", label: "Masse salariale", categoryKey: cleMs, source: "AUTO_PAIE",
        realise2026: realise, propose: Math.round(mensuel * 12),
        justification: `${employes.length} salarié(s) — ${dernierMois ? "dernière paie connue" : "coût des fiches"} × 12.`,
      });
    }
  }

  // ── D. Les recrutements prévus (demandes validées, encore ouvertes) × fourchette de salaire.
  const recrutements = await prisma.recruitmentRequest.findMany({
    where: { departmentId: { in: sousArbre }, stage: { in: [...STAGES_RECRUTEMENT_OUVERTS] } },
    select: { position: true, headcount: true, salaryMin: true, salaryMax: true, startDate: true },
  });
  if (recrutements.length > 0) {
    let total = 0;
    let sansFourchette = 0;
    for (const r of recrutements) {
      const min = r.salaryMin === null ? null : toNumber(r.salaryMin);
      const max = r.salaryMax === null ? null : toNumber(r.salaryMax);
      const mensuel = min !== null && max !== null ? (min + max) / 2 : max ?? min;
      if (mensuel === null) { sansFourchette++; continue; }
      const debutPoste = r.startDate && r.startDate.getUTCFullYear() === e.annee ? r.startDate.getUTCMonth() : 0;
      total += mensuel * Math.max(1, r.headcount) * (12 - debutPoste);
    }
    const postes = recrutements.reduce((a, r) => a + Math.max(1, r.headcount), 0);
    lignes.push({
      key: "RECRUTEMENT", label: `Recrutements prévus (${postes} poste${postes > 1 ? "s" : ""})`, categoryKey: null, source: "AUTO_RECRUTEMENT",
      realise2026: 0, propose: Math.round(total),
      justification: [recrutements.map((r) => r.position).join(", "), sansFourchette ? `${sansFourchette} poste(s) sans fourchette — montant à compléter` : ""].filter(Boolean).join(" — "),
    });
  }

  // ── E. Les BV des dossiers réglementaires.
  if (e.domaine === "REGULATORY") lignes.push(...(await prefillBv(e, debut, fin, projete)));

  // ── F. Ad & Pro par BU, d'après la tendance.
  if (e.domaine === "MARKETING") lignes.push(...(await prefillAdPro(debut, fin, maintenant, projete)));

  return lignes;
}

async function prefillBv(e: EntreePrefill, debut: Date, fin: Date, projete: (m: number) => number): Promise<LignePrefill[]> {
  const deLaSociete = e.companyId ? { OR: [{ companyId: e.companyId }, { companyId: null }] } : {};
  const ordres = await prisma.expenseOrder.findMany({
    where: { sourceType: "REGULATORY_PRODUCT", status: { not: "CANCELLED" }, ...deLaSociete },
    select: { id: true, sourceId: true, label: true, amount: true, status: true, paidDate: true, createdAt: true, budgetCategoryId: true },
  });
  const dossiersRaw = await prisma.regulatoryProduct.findMany({
    where: { status: { in: [...EN_COURS_REG] }, ...deLaSociete },
    select: { id: true, reference: true, dci: true, brandName: true, status: true, workflow: true },
    take: 2000,
  });
  const realise = { "25": 0, "75": 0 };
  const connus25: number[] = [];
  for (const o of ordres) {
    const n = natureDuLibelle(o.label);
    if (!n || o.status !== "PAID") continue;
    if (n === "25") connus25.push(toNumber(o.amount));
    if (o.paidDate && o.paidDate >= debut && o.paidDate <= fin) realise[n] += toNumber(o.amount);
  }
  const dossiers: DossierBv[] = dossiersRaw.map((d) => ({ id: d.id, reference: d.reference, dci: d.dci, nom: d.brandName, status: d.status, workflow: (d.workflow as DossierBv["workflow"]) ?? null }));
  const ordresBv: OrdreBv[] = ordres.filter((o) => o.sourceId).map((o) => ({
    id: o.id, productId: o.sourceId as string, label: o.label, amount: toNumber(o.amount), status: o.status,
    paidDate: o.paidDate, createdAt: o.createdAt, budgetCategoryId: o.budgetCategoryId, transactionCategoryId: null,
  }));
  const parDossier = lignesBv({ dossiers, ordres: ordresBv, saisies: [], categories: { bv25: null, bv75: null } });
  const actifs = new Set(parDossier.map((l) => l.dossierId));
  const prevision75 = parDossier.reduce((a, l) => a + l.prevision75, 0);
  // BV 25 % À VENIR : les dossiers en cours sans aucun BV 25 % × le BV 25 % médian déjà payé.
  const tries = [...connus25].sort((a, b) => a - b);
  const median = tries.length ? tries[Math.floor(tries.length / 2)] : 0;
  const sans25 = dossiers.filter((d) => !actifs.has(d.id) || parDossier.find((l) => l.dossierId === d.id)?.bv25.statut === "A_VENIR").length;
  const [c25, c75] = CATEGORIES_BV;
  return [
    {
      key: "BV_25", label: c25.nom, categoryKey: c25.cle, source: "AUTO_BV", realise2026: projete(realise["25"]), propose: Math.round(sans25 * median),
      justification: median > 0 ? `${sans25} dossier(s) en cours sans BV 25 % × BV 25 % médian payé.` : `${sans25} dossier(s) en cours — aucun BV 25 % payé de référence : montant à saisir.`,
    },
    {
      key: "BV_75", label: c75.nom, categoryKey: c75.cle, source: "AUTO_BV", realise2026: projete(realise["75"]), propose: Math.round(prevision75),
      justification: "BV 75 % attendus : 3 × le BV 25 % des dossiers dont le 75 % n'est pas encore demandé.",
    },
  ];
}

async function prefillAdPro(debut: Date, fin: Date, maintenant: Date, projete: (m: number) => number): Promise<LignePrefill[]> {
  const depuis6 = new Date(maintenant.getTime() - 183 * 24 * 3600 * 1000);
  const items = await prisma.adProItem.findMany({
    where: { status: "APPROVED", decidedAt: { gte: depuis6 < debut ? depuis6 : debut } },
    select: {
      amountGranted: true, amountEstimated: true, decidedAt: true,
      sponsoring: { select: { businessUnitId: true } },
      congressNational: { select: { businessUnitId: true } },
      congressInternational: { select: { businessUnitId: true } },
      event: { select: { businessUnitId: true } },
    },
  });
  const bus = await prisma.businessUnit.findMany({ select: { id: true, name: true } });
  const nomBu = new Map(bus.map((b) => [b.id, b.name]));
  const agg = new Map<string, { annee: number; six: number }>();
  for (const it of items) {
    const bu = it.sponsoring?.businessUnitId ?? it.congressNational?.businessUnitId ?? it.congressInternational?.businessUnitId ?? it.event?.businessUnitId ?? "";
    const m = toNumber(it.amountGranted ?? it.amountEstimated ?? 0);
    const cur = agg.get(bu) ?? { annee: 0, six: 0 };
    if (it.decidedAt && it.decidedAt >= debut && it.decidedAt <= fin) cur.annee += m;
    if (it.decidedAt && it.decidedAt >= depuis6) cur.six += m;
    agg.set(bu, cur);
  }
  return [...agg.entries()]
    .filter(([, v]) => v.annee > 0 || v.six > 0)
    .map(([bu, v]) => {
      const realise = projete(v.annee);
      const tendance = Math.round(v.six * 2);
      return {
        key: `ADPRO:${bu || "sans-bu"}`, label: `Ad & Pro — ${bu ? nomBu.get(bu) ?? "BU retirée" : "sans BU"}`, categoryKey: null,
        source: "AUTO_ADPRO" as const, realise2026: realise, propose: tendance > 0 ? tendance : realise,
        justification: tendance > 0 ? "Tendance des six derniers mois × 2." : null,
      };
    });
}
